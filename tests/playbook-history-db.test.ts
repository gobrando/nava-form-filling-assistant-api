import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tenant isolation for the history query, against Postgres when it is already
 * available. Unset POSTGRES_TEST_URL skips this file. Do not start a database
 * from here.
 */

const enabled = Boolean(process.env.POSTGRES_TEST_URL);
const SECRET = 'Jordan Sample';
const SSN = '900-12-3456';

describe.skipIf(!enabled)('playbook history in Postgres', () => {
  let close: (() => Promise<void>) | undefined;
  let readHistory: ((tenantId: string, programId: string) => Promise<unknown>) | undefined;
  let tenantA = '';
  let programId = '';

  beforeAll(async () => {
    const { appClient, createTenant, ownerClient } = await import('./helpers/db');
    const schema = await import('@/lib/db/schema');
    const { listPlaybookHistory } = await import('@/lib/playbooks/history');
    const { sql } = await import('drizzle-orm');
    const { drizzle } = await import('drizzle-orm/postgres-js');

    const owner = ownerClient();
    const app = appClient();
    const ownerDb = drizzle(owner, { schema });
    const appDb = drizzle(app, { schema });
    close = async () => {
      await app.end();
      await owner.end();
    };

    const a = await createTenant(owner);
    const b = await createTenant(owner);
    tenantA = a.id;
    programId = `history-${randomUUID().slice(0, 8)}`;
    const createdAt = new Date('2026-03-04T15:04:00.000Z');

    await ownerDb.insert(schema.playbook).values([
      {
        tenantId: null,
        domain: `${programId}.test`,
        programIds: [programId],
        version: 1,
        name: 'Shared history row',
        probes: [],
        fieldMap: [{ fieldKey: '#shared-field', purpose: SECRET, inputType: 'text' }],
        safeAdvanceRules: [],
        autoAdvance: false,
        note: 'Shared control plane.',
        staleReason: SSN,
        createdAt,
      },
      {
        tenantId: a.id,
        domain: `${programId}.test`,
        programIds: [programId],
        version: 2,
        name: 'Tenant history row',
        probes: [],
        fieldMap: [{ fieldKey: '#applicant-name', purpose: SECRET, inputType: 'text' }],
        safeAdvanceRules: [],
        autoAdvance: false,
        note: `Repaired from version 1 by the deterministic scribe. ${SECRET} ${SSN}`,
        staleReason: SSN,
        createdAt,
      },
      {
        tenantId: b.id,
        domain: `${programId}.test`,
        programIds: [programId],
        version: 9,
        name: 'Other county history row',
        probes: [],
        fieldMap: [{ fieldKey: '#other-county-only', purpose: SECRET, inputType: 'text' }],
        safeAdvanceRules: [],
        autoAdvance: false,
        note: `Repaired from version 1 by the deterministic scribe. ${SECRET}`,
        staleReason: SSN,
        createdAt,
      },
    ]);

    readHistory = (tenantId, id) =>
      appDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        return listPlaybookHistory(tx, tenantId, id);
      });
  });

  afterAll(async () => {
    await close?.();
  });

  it('returns this tenant and the shared row, and not the other county', async () => {
    const summary = await readHistory?.(tenantA, programId);
    const payload = JSON.stringify(summary);
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain(SSN);
    expect(payload).not.toContain('#other-county-only');
    expect(payload).not.toContain('purpose');
    expect(summary).toMatchObject({
      programId,
      versions: [
        {
          version: 2,
          scope: 'tenant',
          createdAt: '2026-03-04T15:04:00.000Z',
          fieldCount: 1,
          fieldKeys: ['#applicant-name'],
          fromRepair: true,
          preferred: true,
        },
        {
          version: 1,
          scope: 'shared',
          createdAt: '2026-03-04T15:04:00.000Z',
          fieldCount: 1,
          fieldKeys: ['#shared-field'],
          fromRepair: false,
          preferred: false,
        },
      ],
    });
  });
});
