import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAudit } from '@/lib/audit';
import { hashSecret } from '@/lib/auth';
import {
  type OutcomeRow,
  listOutcomes,
  nextSimulatedUpdate,
  recordOutcome,
} from '@/lib/casegraph/outcomes';
import { type SubmitGateVerdict, buildPacket, evaluateSubmitGate } from '@/lib/casegraph/packet';
import { db, withTenant } from '@/lib/db';
import {
  application,
  applicationField,
  fact,
  gap,
  household,
  participantShare,
  reviewEvent,
  tenant,
} from '@/lib/db/schema';
import { newShareToken } from '@/lib/participate';
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * The local caseworker desk for one fictional IHSS application.
 *
 * The packet uses the same split as the measured decision pass: fields already
 * on the record are filled, the client is asked what the record does not have,
 * and identifier controls stay blank unless a person entered them. The client
 * link has no submit control. Recording a submission does not send the form.
 * County statuses after that are simulated, in the real outcome table.
 */

const SLUG = 'participant-demo';
const LINK_FILE = join(tmpdir(), 'nava-participant-demo-token');

export type Workbench = {
  organizationName: string;
  clientName: string;
  programName: string;
  applicationId: string;
  participantUrl: string;
  fields: {
    label: string;
    value: string | null;
    source: string | null;
    verified: boolean;
    required: boolean;
  }[];
  missing: { question: string; required: boolean }[];
  gate: SubmitGateVerdict;
  submittedAt: string | null;
  outcomes: {
    status: string;
    followUp: string | null;
    reasonCode: string | null;
    recordedAt: string;
  }[];
  nextUpdate: string | null;
};

config({ path: '.env.local' });

function ownerUrl(): string {
  const url = process.env.POSTGRES_MIGRATION_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL is not set.');
  return url;
}

async function withOwner<T>(fn: (database: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const client = postgres(ownerUrl(), { max: 1 });
  try {
    return await fn(drizzle(client));
  } finally {
    await client.end();
  }
}

export async function resetDemo(): Promise<void> {
  const token = newShareToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await withOwner(async (database) => {
    const [org] = await database
      .insert(tenant)
      .values({ slug: SLUG, name: 'Demo Community Services' })
      .onConflictDoUpdate({ target: tenant.slug, set: { name: 'Demo Community Services' } })
      .returning({ id: tenant.id });

    await database
      .delete(household)
      .where(and(eq(household.tenantId, org.id), eq(household.externalRef, SLUG)));

    const [home] = await database
      .insert(household)
      .values({ tenantId: org.id, externalRef: SLUG })
      .returning({ id: household.id });

    const factRows = [
      ['firstName', 'Jordan', 'connector'],
      ['lastName', 'Sample', 'connector'],
      ['dateOfBirth', '1990-04-12', 'connector'],
      ['phone', '951-555-0148', 'connector'],
      ['addressLine1', '100 Demo Street', 'connector'],
      ['city', 'Riverside', 'connector'],
      ['postalCode', '92501', 'connector'],
      ['primaryLanguage', 'English', 'connector'],
      ['email', 'jordan.sample@example.com', 'connector'],
      ['ssn', '900-12-3456', 'caseworker'],
    ] as const;
    const insertedFacts = await database
      .insert(fact)
      .values(
        factRows.map(([key, value, source]) => ({
          tenantId: org.id,
          householdId: home.id,
          key,
          value,
          source,
          sourceDetail: 'Fictional demo record 900001',
          confirmedBy: source === 'caseworker' ? 'demo-caseworker' : null,
        })),
      )
      .returning({ id: fact.id, key: fact.key });
    const factId = new Map(insertedFacts.map((row) => [row.key, row.id]));

    const [app] = await database
      .insert(application)
      .values({
        tenantId: org.id,
        householdId: home.id,
        programIds: ['ihss'],
        workflowId: 'riverside-ihss',
        name: 'IHSS',
        status: 'needs_attention',
      })
      .returning({ id: application.id });

    const recorded = [
      ['first', 'First name', 'firstName', 'Jordan'],
      ['last', 'Last name', 'lastName', 'Sample'],
      ['dob', 'Date of birth', 'dateOfBirth', '1990-04-12'],
      ['phone', 'Phone number', 'phone', '951-555-0148'],
      ['street', 'Street address', 'addressLine1', '100 Demo Street'],
      ['city', 'City', 'city', 'Riverside'],
      ['zip', 'ZIP code', 'postalCode', '92501'],
      ['language', 'Primary language', 'primaryLanguage', 'English'],
      ['email', 'Email address', 'email', 'jordan.sample@example.com'],
    ] as const;
    await database.insert(applicationField).values([
      ...recorded.map(([fieldKey, label, purpose, value], ordinal) =>
        field(org.id, app.id, ordinal, fieldKey, label, purpose, value, true, factId.get(purpose)),
      ),
      field(
        org.id,
        app.id,
        recorded.length,
        'ssn',
        'Social Security Number',
        'ssn',
        '900-12-3456',
        false,
        factId.get('ssn'),
      ),
      {
        tenantId: org.id,
        applicationId: app.id,
        ordinal: recorded.length + 1,
        fieldKey: 'cin',
        label: 'Medi-Cal number',
        purpose: null,
        value: null,
        inputType: 'text' as const,
        required: false,
        sensitive: true,
        factId: null,
        source: null,
        sourceDetail: null,
        verifiedAt: null,
      },
    ]);

    await database
      .insert(gap)
      .values([
        question(
          org.id,
          app.id,
          0,
          'county',
          'County of residence',
          'Which county do you live in?',
          true,
          'text',
        ),
        question(
          org.id,
          app.id,
          1,
          'lives_alone',
          'Lives alone',
          'Do you live alone?',
          true,
          'select',
          ['Yes', 'No'],
        ),
        question(
          org.id,
          app.id,
          2,
          'hours',
          'Weekly care hours',
          'How many hours of care do you need in a week?',
          true,
          'number',
        ),
        question(
          org.id,
          app.id,
          3,
          'supervision',
          'Protective supervision',
          'Do you need protective supervision?',
          true,
          'select',
          ['Yes', 'No'],
        ),
        question(
          org.id,
          app.id,
          4,
          'provider_relation',
          'Provider relationship',
          'How is the care provider related to you?',
          false,
          'select',
          ['Spouse', 'Adult child', 'Other relative', 'Not related'],
        ),
        question(org.id, app.id, 5, 'ssi', 'SSI income', 'Do you receive SSI?', false, 'select', [
          'Yes',
          'No',
        ]),
        question(
          org.id,
          app.id,
          6,
          'contact_method',
          'Preferred contact method',
          'How should we contact you?',
          false,
          'select',
          ['Phone', 'Email', 'Mail'],
        ),
      ]);

    await database.insert(participantShare).values({
      tenantId: org.id,
      applicationId: app.id,
      householdId: home.id,
      tokenHash: hashSecret(token),
      createdBy: 'demo-caseworker',
      expiresAt,
    });
  });
  writeFileSync(LINK_FILE, token, { mode: 0o600 });
}

function field(
  tenantId: string,
  applicationId: string,
  ordinal: number,
  fieldKey: string,
  label: string,
  purpose: string,
  value: string,
  required: boolean,
  factId: string | undefined,
) {
  return {
    tenantId,
    applicationId,
    ordinal,
    fieldKey,
    label,
    purpose,
    value,
    inputType: 'text' as const,
    required,
    sensitive: purpose === 'ssn',
    factId: factId ?? null,
    source: purpose === 'ssn' ? ('caseworker' as const) : ('connector' as const),
    sourceDetail: 'Fictional demo record 900001',
    verifiedAt: new Date(),
  };
}

function question(
  tenantId: string,
  applicationId: string,
  ordinal: number,
  fieldKey: string,
  label: string,
  text: string,
  required: boolean,
  inputType: 'text' | 'select' | 'number',
  options?: string[],
) {
  return {
    tenantId,
    applicationId,
    ordinal,
    fieldKey,
    label,
    purpose: null,
    question: text,
    kind: inputType === 'select' ? ('decision' as const) : ('required' as const),
    required,
    inputType,
    options: options ?? null,
  };
}

async function demoScope(): Promise<{ tenantId: string; applicationId: string } | null> {
  const orgs = await db
    .select({ id: tenant.id })
    .from(tenant)
    .where(eq(tenant.slug, SLUG))
    .limit(1);
  const org = orgs[0];
  if (!org) return null;
  return withTenant(org.id, async (tx) => {
    const homes = await tx
      .select({ id: household.id })
      .from(household)
      .where(eq(household.externalRef, SLUG))
      .limit(1);
    if (!homes[0]) return null;
    const rows = await tx
      .select({ id: application.id })
      .from(application)
      .where(eq(application.householdId, homes[0].id))
      .limit(1);
    if (!rows[0]) return null;
    return { tenantId: org.id, applicationId: rows[0].id };
  });
}

export async function loadWorkbench(): Promise<Workbench | null> {
  const scope = await demoScope();
  if (!scope) return null;
  let token = '';
  try {
    token = readFileSync(LINK_FILE, 'utf8').trim();
  } catch {
    token = '';
  }
  return withTenant(scope.tenantId, async (tx) => {
    const packet = await buildPacket(tx, scope.applicationId);
    const gate = await evaluateSubmitGate(tx, scope.applicationId);
    const outcomes = await listOutcomes(tx, scope.applicationId);
    const apps = await tx
      .select({
        submittedAt: application.submittedAt,
        organizationName: tenant.name,
        programName: application.name,
      })
      .from(application)
      .innerJoin(tenant, eq(tenant.id, application.tenantId))
      .where(eq(application.id, scope.applicationId))
      .limit(1);
    const current = outcomes.at(-1)?.status ?? (apps[0]?.submittedAt ? 'submitted' : null);
    const upcoming = current ? nextSimulatedUpdate(current) : null;
    return {
      organizationName: apps[0]?.organizationName ?? 'Demo Community Services',
      clientName: 'Jordan Sample',
      programName: apps[0]?.programName ?? '',
      applicationId: scope.applicationId,
      participantUrl: token ? `/participate/${token}` : '',
      fields: packet.fields.map((item) => ({
        label: item.label,
        value: item.value,
        source: item.provenance?.source ?? null,
        verified: item.verified,
        required: item.required,
      })),
      missing: packet.gaps
        .filter((item) => !item.answered)
        .map((item) => ({ question: item.question, required: item.required })),
      gate,
      submittedAt: apps[0]?.submittedAt?.toISOString() ?? null,
      outcomes: outcomes.map(serializeOutcome),
      nextUpdate: upcoming?.status ?? null,
    };
  });
}

export async function verifyReadback(): Promise<string | null> {
  const scope = await demoScope();
  if (!scope) return 'The demo application is missing. Start it over.';
  await withTenant(scope.tenantId, async (tx) => {
    await tx
      .update(applicationField)
      .set({ verifiedAt: new Date() })
      .where(
        and(
          eq(applicationField.applicationId, scope.applicationId),
          eq(applicationField.tenantId, scope.tenantId),
        ),
      );
  });
  return null;
}

export async function confirmPacket(): Promise<string | null> {
  const scope = await demoScope();
  if (!scope) return 'The demo application is missing. Start it over.';
  return withTenant(scope.tenantId, async (tx) => {
    const gate = await evaluateSubmitGate(tx, scope.applicationId);
    const blockers = gate.blockers.filter(
      (blocker) => blocker !== 'No reviewer has confirmed this packet.',
    );
    if (blockers.length > 0) return blockers.join(' ');
    await tx.insert(reviewEvent).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      reviewerPrincipal: 'demo-caseworker',
      action: 'confirmed',
      attestation: 'I reviewed the packet with the client.',
    });
    await recordAudit(tx, {
      tenantId: scope.tenantId,
      type: 'review_reached',
      principalId: 'demo-caseworker',
      applicationId: scope.applicationId,
      outcome: 'confirmed',
    });
    return null;
  });
}

export async function recordDemoSubmission(): Promise<string | null> {
  const scope = await demoScope();
  if (!scope) return 'The demo application is missing. Start it over.';
  return withTenant(scope.tenantId, async (tx) => {
    const gate = await evaluateSubmitGate(tx, scope.applicationId);
    if (!gate.allowed) return gate.blockers.join(' ');
    await tx
      .update(application)
      .set({ submittedAt: new Date(), updatedAt: new Date() })
      .where(eq(application.id, scope.applicationId));
    await tx.insert(reviewEvent).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      reviewerPrincipal: 'demo-caseworker',
      action: 'submitted',
      attestation: 'DEMO-900001',
    });
    await recordAudit(tx, {
      tenantId: scope.tenantId,
      type: 'session_ended',
      principalId: 'demo-caseworker',
      applicationId: scope.applicationId,
      outcome: 'submitted',
    });
    return null;
  });
}

export async function simulateNextOutcome(): Promise<string | null> {
  const scope = await demoScope();
  if (!scope) return 'The demo application is missing. Start it over.';
  return withTenant(scope.tenantId, async (tx) => {
    const apps = await tx
      .select({ submittedAt: application.submittedAt })
      .from(application)
      .where(eq(application.id, scope.applicationId))
      .limit(1);
    if (!apps[0]?.submittedAt) return 'Record the submission before simulating a county update.';
    const history = await listOutcomes(tx, scope.applicationId);
    const current = history.at(-1)?.status ?? 'submitted';
    const next = nextSimulatedUpdate(current);
    if (!next) return 'This application is already at the end of the simulated county path.';
    const result = await recordOutcome(
      tx,
      {
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        principalId: 'demo-caseworker',
      },
      next,
    );
    return result.ok ? null : result.error;
  });
}

function serializeOutcome(row: OutcomeRow) {
  return {
    status: row.status,
    followUp: row.followUp,
    reasonCode: row.reasonCode,
    recordedAt: row.recordedAt.toISOString(),
  };
}
