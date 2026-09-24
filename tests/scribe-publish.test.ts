import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { currentFacts } from '@/lib/casegraph/facts';
import { buildFillPlan } from '@/lib/casegraph/plan';
import * as schema from '@/lib/db/schema';
import { wicSeedPlaybook } from '@/lib/playbooks/data';
import { observeHtml } from '@/lib/playbooks/observe-html';
import { evaluateProbes, resolvePlaybookForProgram } from '@/lib/playbooks/registry';
import { proposeRepair, publishRepair } from '@/lib/playbooks/scribe';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHousehold, createTenant } from './helpers/db';

/**
 * Publishing a repair is a tenant override, and the next resolution uses it.
 *
 * The shared playbook is not edited. Another tenant does not see the override.
 * The audit row records counts, not the household.
 */

const url = process.env.POSTGRES_TEST_URL;
if (!url) throw new Error('POSTGRES_TEST_URL is not set.');

const owner = postgres(url, { max: 1 });
const appUrl = new URL(url);
appUrl.username = 'nava_api';
appUrl.password = 'nava_api_test';
const app = postgres(appUrl.toString(), { max: 1, prepare: false });
const ownerDb = drizzle(owner, { schema });
const appDb = drizzle(app, { schema });

const wic = wicSeedPlaybook();

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let previousId: string;

beforeAll(async () => {
  tenantA = await createTenant(owner);
  tenantB = await createTenant(owner);
  const [previous] = await ownerDb
    .insert(schema.playbook)
    .values({
      tenantId: tenantA.id,
      domain: `repair-${randomUUID().slice(0, 8)}.test`,
      programIds: ['wic'],
      version: 3,
      name: wic.name,
      probes: [...wic.probes],
      fieldMap: wic.fieldMap.map((entry) => ({ ...entry })),
      safeAdvanceRules: [],
      autoAdvance: false,
      staleAt: new Date(),
      staleReason: 'selectors moved',
    })
    .returning({ id: schema.playbook.id });
  previousId = previous.id;
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('publishing a repair', () => {
  it('makes the next run warm for this tenant only', async () => {
    const observed = observeHtml(readFileSync('tests/fixtures/wic-form-drifted.html', 'utf8'));
    const householdId = await createHousehold(owner, tenantA.id);
    await ownerDb.insert(schema.fact).values({
      tenantId: tenantA.id,
      householdId,
      key: 'fullName',
      value: 'Jordan Sample',
      source: 'caseworker',
    });

    const published = await appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantA.id}, true)`);
      const previous = await resolvePlaybookForProgram(tx, tenantA.id, 'wic');
      if (!previous || previous.id !== previousId) {
        throw new Error('The tenant playbook was not the one resolved.');
      }
      const proposal = proposeRepair(previous, observed);
      if (!proposal.publishable) throw new Error(proposal.refused ?? 'refused');
      const first = await publishRepair(tx, tenantA.id, 'key:test', previous, proposal);
      const second = await publishRepair(tx, tenantA.id, 'key:test', previous, proposal);
      const resolved = await resolvePlaybookForProgram(tx, tenantA.id, 'wic');
      const verdict = resolved
        ? evaluateProbes(
            resolved,
            proposal.probes.map((selector) => ({ selector, count: 1 })),
          )
        : null;
      const facts = await currentFacts(tx, householdId);
      const plan = resolved && verdict?.passed ? buildFillPlan(resolved, facts) : null;
      return { first, second, resolved, verdict, plan, proposal };
    });

    expect(published.first.alreadyCurrent).toBe(false);
    expect(published.second.alreadyCurrent).toBe(true);
    expect(published.second.row.id).toBe(published.first.row.id);
    expect(published.resolved?.id).toBe(published.first.row.id);
    expect(published.resolved?.version).toBe(4);
    expect(published.verdict?.passed).toBe(true);
    expect(published.verdict?.executionMode).toBe('script');
    expect(published.plan?.writes[0]).toMatchObject({
      fieldKey: '#applicant-name',
      purpose: 'fullName',
      value: 'Jordan Sample',
    });

    const shared = await ownerDb
      .select({ id: schema.playbook.id, version: schema.playbook.version })
      .from(schema.playbook)
      .where(eq(schema.playbook.id, previousId));
    expect(shared[0]?.version).toBe(3);

    const other = await appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantB.id}, true)`);
      return resolvePlaybookForProgram(tx, tenantB.id, 'wic');
    });
    expect(other?.id).not.toBe(published.first.row.id);

    const events = await ownerDb
      .select({
        type: schema.auditEvent.type,
        details: schema.auditEvent.details,
        outcome: schema.auditEvent.outcome,
      })
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.tenantId, tenantA.id));
    const repair = events.filter((event) => event.type === 'playbook_repaired');
    expect(repair).toHaveLength(1);
    expect(repair[0]?.outcome).toBe('script');
    expect(JSON.stringify(repair[0]?.details)).not.toMatch(/Jordan/);
    expect(repair[0]?.details).toMatchObject({ fieldCount: 6, verifiedCount: 0, gapCount: 0 });
  });
});
