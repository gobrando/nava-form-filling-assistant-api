import { readFileSync } from 'node:fs';
import { appendFacts, currentFacts } from '@/lib/casegraph/facts';
import { answerGaps, openGaps } from '@/lib/casegraph/gaps';
import { buildPacket, evaluateSubmitGate } from '@/lib/casegraph/packet';
import { buildFillPlan, persistPlan } from '@/lib/casegraph/plan';
import * as schema from '@/lib/db/schema';
import { SEED_PLAYBOOKS } from '@/lib/playbooks/data';
import { evaluateProbes } from '@/lib/playbooks/registry';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * One warm run end to end, against a local form fixture.
 *
 * The path under test is the whole warm loop: probe the page, plan the fill
 * from the facts ledger, persist the plan, report readbacks, discover that one
 * write did not land, answer the resulting gap, and only then pass the submit
 * gate.
 *
 * The fixture is a local HTML file rather than the live `ruhealth.org` form. A
 * test suite has no business depending on a county's production intake form,
 * and less business submitting to it. The fixture's selectors are the seeded
 * playbook's real selectors, so the probe evaluation and field map are genuine.
 *
 * `#edit-zip-code` has `maxlength="4"` on a five-digit ZIP, which reproduces the
 * silent failure this whole protocol exists to catch: the field accepts the
 * write, reports nothing wrong, and holds something different.
 */

const url = process.env.POSTGRES_TEST_URL;
if (!url) throw new Error('POSTGRES_TEST_URL is not set.');

const client = (await import('postgres')).default(url, { max: 1 });
const db = drizzle(client, { schema });

const FIXTURE = readFileSync('tests/fixtures/wic-form.html', 'utf8');
const CLINIC = '#edit-please-choose-the-wic-clinic-closest-to-you';

/**
 * Counts how many elements a playbook selector matches in the fixture, which is
 * what a browser reports back as a probe result. Only id selectors appear in
 * these playbooks, so an id scan is sufficient and avoids pulling in a DOM.
 */
function countMatches(selector: string): number {
  if (!selector.startsWith('#')) return 0;
  const id = selector.slice(1);
  const matches = FIXTURE.match(new RegExp(`id="${id}"`, 'g'));
  return matches?.length ?? 0;
}

/** The maxlength the fixture declares for a field, if any. */
function maxLengthOf(selector: string): number | null {
  const id = selector.slice(1);
  const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(FIXTURE)?.[0];
  const max = tag ? /maxlength="(\d+)"/.exec(tag)?.[1] : undefined;
  return max ? Number(max) : null;
}

let tenantId: string;
let householdId: string;
let applicationId: string;
let playbookId: string;

beforeAll(async () => {
  const [tenant] = await db
    .insert(schema.tenant)
    .values({ slug: `e2e-${Date.now()}`, name: 'E2E' })
    .returning();
  tenantId = tenant.id;

  const wic = SEED_PLAYBOOKS.find((entry) => entry.domain === 'www.ruhealth.org');
  if (!wic) throw new Error('The WIC playbook is missing from the seed data.');
  const [playbook] = await db
    .insert(schema.playbook)
    .values({ ...wic, tenantId })
    .returning();
  playbookId = playbook.id;

  const [household] = await db
    .insert(schema.household)
    .values({ tenantId, externalRef: 'e2e-household' })
    .returning();
  householdId = household.id;

  // The organization's record. Everything sourced `connector`, as a real run
  // would have it. A protected field from a connector is fine — only inference
  // is forbidden.
  await db.transaction(async (tx) => {
    await appendFacts(tx, tenantId, householdId, [
      { key: 'fullName', value: 'Jordan Sample', source: 'connector' },
      { key: 'phone', value: '555-010-0199', source: 'connector' },
      { key: 'email', value: 'jordan.sample@example.org', source: 'connector' },
      { key: 'postalCode', value: '92501', source: 'connector' },
      { key: 'primaryLanguage', value: 'English', source: 'connector' },
    ]);
  });

  const [application] = await db
    .insert(schema.application)
    .values({
      tenantId,
      householdId,
      programIds: ['wic'],
      workflowId: 'riverside-wic',
      name: 'WIC',
      playbookId,
      playbookVersion: playbook.version,
    })
    .returning();
  applicationId = application.id;
}, 60_000);

afterAll(async () => {
  await client.end();
});

describe('a warm run, end to end', () => {
  it('routes to the script path because every probe resolves exactly once', async () => {
    const [playbook] = await db
      .select()
      .from(schema.playbook)
      .where(eq(schema.playbook.id, playbookId));

    const probeResults = playbook.probes.map((selector) => ({
      selector,
      count: countMatches(selector),
    }));

    const verdict = evaluateProbes(playbook, probeResults);
    expect(verdict.passed).toBe(true);
    expect(verdict.executionMode).toBe('script');

    await db
      .update(schema.application)
      .set({ executionMode: 'script', status: 'ready_to_fill' })
      .where(eq(schema.application.id, applicationId));
  });

  it('plans every write from a fact, and turns the clinic select into a gap', async () => {
    await db.transaction(async (tx) => {
      const [playbook] = await tx
        .select()
        .from(schema.playbook)
        .where(eq(schema.playbook.id, playbookId));
      const facts = await currentFacts(tx, householdId);
      const plan = buildFillPlan(playbook, facts);

      // Every planned write traces to a fact. That is the invariant the packet
      // later reports as provenanceShare.
      expect(plan.writes.length).toBeGreaterThan(0);
      for (const write of plan.writes) expect(write.factId).toBeTruthy();

      // The clinic is the playbook's one unclassified control, so it becomes a
      // question rather than a guess.
      expect(plan.gaps.map((gap) => gap.fieldKey)).toContain(
        '#edit-please-choose-the-wic-clinic-closest-to-you',
      );

      await persistPlan(tx, tenantId, applicationId, plan);
    });

    const fields = await db
      .select()
      .from(schema.applicationField)
      .where(eq(schema.applicationField.applicationId, applicationId));
    expect(fields.length).toBeGreaterThan(0);
    // Nothing is verified yet. A plan is an intention.
    expect(fields.every((field) => field.verifiedAt === null)).toBe(true);
  });

  it('catches the ZIP code write that the page silently truncated', async () => {
    const fields = await db
      .select()
      .from(schema.applicationField)
      .where(eq(schema.applicationField.applicationId, applicationId));

    // What the browser reads back: the fixture's maxlength truncates the ZIP,
    // and the write reported success.
    const readbacks = fields
      .filter((field) => field.value !== null)
      .map((field) => {
        const max = maxLengthOf(field.fieldKey);
        const landed =
          max !== null && field.value !== null ? field.value.slice(0, max) : field.value;
        return { fieldKey: field.fieldKey, landedValue: landed };
      });

    const zip = readbacks.find((item) => item.fieldKey === '#edit-zip-code');
    expect(zip?.landedValue).toBe('9250');

    const mismatched: string[] = [];
    for (const readback of readbacks) {
      const field = fields.find((item) => item.fieldKey === readback.fieldKey);
      const matched = field?.value?.trim() === readback.landedValue?.trim();
      await db
        .update(schema.applicationField)
        .set({ verifiedAt: matched ? new Date() : null })
        .where(
          and(
            eq(schema.applicationField.applicationId, applicationId),
            eq(schema.applicationField.fieldKey, readback.fieldKey),
          ),
        );
      if (!matched) mismatched.push(readback.fieldKey);
    }

    // Exactly the one the fixture sabotaged. Without the readback this would
    // have reached the reviewer as a filled field holding a wrong ZIP code.
    expect(mismatched).toEqual(['#edit-zip-code']);

    await db.transaction(async (tx) => {
      const { reportGaps } = await import('@/lib/casegraph/gaps');
      await reportGaps(tx, tenantId, applicationId, [
        {
          fieldKey: '#edit-zip-code',
          label: 'ZIP code',
          purpose: 'postalCode',
          question: 'The ZIP code did not land on the page. What should it be?',
          required: true,
        },
      ]);
    });
  });

  it('refuses to submit while the gap is open', async () => {
    const gate = await db.transaction((tx) => evaluateSubmitGate(tx, applicationId));
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toContain('No reviewer has confirmed');
    expect(gate.blockers.some((blocker) => blocker.includes('never read back'))).toBe(true);
  });

  it('accepts caseworker answers as facts, including for an unclassified control', async () => {
    const gaps = await db.transaction((tx) => openGaps(tx, applicationId));
    const zipGap = gaps.find((gap) => gap.fieldKey === '#edit-zip-code');
    const clinicGap = gaps.find((gap) => gap.fieldKey === CLINIC);
    expect(zipGap).toBeDefined();
    expect(clinicGap).toBeDefined();

    const result = await db.transaction((tx) =>
      answerGaps(tx, { tenantId, applicationId, householdId }, [
        {
          gapId: (zipGap as { id: string }).id,
          value: '92501',
          source: 'caseworker',
          answeredBy: 'a-caseworker',
          note: 'Confirmed with the participant after the truncated write.',
        },
        {
          gapId: (clinicGap as { id: string }).id,
          value: 'Lake Elsinore WIC',
          source: 'participant',
          answeredBy: 'a-caseworker',
        },
      ]),
    );
    expect(result.invalid).toEqual([]);
    expect(result.answered.find((item) => item.gapId === clinicGap?.id)?.key).toBe(
      `control:${CLINIC}`,
    );

    // Answering never verifies. Both values are back on their fields, waiting
    // for someone to enter them and read them back.
    const fields = await db
      .select()
      .from(schema.applicationField)
      .where(eq(schema.applicationField.applicationId, applicationId));
    for (const key of ['#edit-zip-code', CLINIC]) {
      const field = fields.find((item) => item.fieldKey === key);
      expect(field?.factId).toBeTruthy();
      expect(field?.verifiedAt).toBeNull();
    }
    const gate = await db.transaction((tx) => evaluateSubmitGate(tx, applicationId));
    expect(gate.blockers.some((blocker) => blocker.includes('never read back'))).toBe(true);

    // The caseworker enters both by hand and the readbacks match.
    await db
      .update(schema.applicationField)
      .set({ verifiedAt: new Date() })
      .where(
        and(
          eq(schema.applicationField.applicationId, applicationId),
          inArray(schema.applicationField.fieldKey, ['#edit-zip-code', CLINIC]),
        ),
      );

    const remaining = await db.transaction((tx) => openGaps(tx, applicationId));
    expect(remaining).toEqual([]);
  });

  it('builds a packet in which every value has inspectable provenance', async () => {
    const packet = await db.transaction((tx) => buildPacket(tx, applicationId));

    expect(packet.summary.provenanceShare).toBe(1);
    expect(packet.summary.filledCount).toBe(packet.summary.verifiedCount);

    for (const field of packet.fields) {
      if (field.value === null) continue;
      expect(field.provenance).not.toBeNull();
      // Either it traces to a fact, or it was already on the page. There is no
      // third way to hold a value.
      expect(field.provenance?.factId ?? field.provenance?.source).toBeTruthy();
    }

    const zip = packet.fields.find((field) => field.fieldKey === '#edit-zip-code');
    expect(zip?.provenance?.source).toBe('caseworker');
    expect(zip?.provenance?.confirmedBy).toBe('a-caseworker');
  });

  it('masks the packet by default and reveals only on request', async () => {
    await db.transaction(async (tx) => {
      await appendFacts(tx, tenantId, householdId, [
        { key: 'ssn', value: '900-12-3456', source: 'connector' },
      ]);
      const facts = await currentFacts(tx, householdId);
      await tx.insert(schema.applicationField).values({
        tenantId,
        applicationId,
        ordinal: 500,
        fieldKey: '#ssn',
        label: 'Social Security Number',
        purpose: 'ssn',
        value: '900-12-3456',
        factId: facts.get('ssn')?.id as string,
        source: 'connector',
        sensitive: true,
        verifiedAt: new Date(),
      });
    });

    const masked = await db.transaction((tx) => buildPacket(tx, applicationId));
    const revealed = await db.transaction((tx) => buildPacket(tx, applicationId, { reveal: true }));

    expect(masked.fields.find((field) => field.purpose === 'ssn')?.value).toBe('•••-••-3456');
    expect(revealed.fields.find((field) => field.purpose === 'ssn')?.value).toBe('900-12-3456');
  });

  it('passes the gate only after a named reviewer confirms', async () => {
    let gate = await db.transaction((tx) => evaluateSubmitGate(tx, applicationId));
    expect(gate.allowed).toBe(false);
    expect(gate.blockers).toEqual(['No reviewer has confirmed this packet.']);

    await db.insert(schema.reviewEvent).values({
      tenantId,
      applicationId,
      reviewerPrincipal: 'a-reviewer',
      action: 'confirmed',
      attestation: 'Reviewed with the participant present.',
    });

    gate = await db.transaction((tx) => evaluateSubmitGate(tx, applicationId));
    expect(gate.allowed).toBe(true);
    expect(gate.reviewerPrincipal).toBe('a-reviewer');
  });

  it('records the submission a human performed, and refuses a second one', async () => {
    await db
      .update(schema.application)
      .set({ submittedAt: new Date() })
      .where(eq(schema.application.id, applicationId));

    const gate = await db.transaction((tx) => evaluateSubmitGate(tx, applicationId));
    expect(gate.allowed).toBe(false);
    expect(gate.blockers).toContain('This application is already recorded as submitted.');
  });
});
