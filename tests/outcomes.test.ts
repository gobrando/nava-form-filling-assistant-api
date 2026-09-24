import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appClient,
  asNobody,
  asTenant,
  createApplication,
  createHousehold,
  createTenant,
  ownerClient,
} from './helpers/db';

/**
 * Outcome rows are tenant-scoped and append-only. A denial without a reason
 * code is a constraint failure, not a convention.
 */

const owner = ownerClient();
const app = appClient();

let tenantA: { id: string };
let tenantB: { id: string };
let applicationA: string;

beforeAll(async () => {
  tenantA = await createTenant(owner);
  tenantB = await createTenant(owner);
  const household = await createHousehold(owner, tenantA.id);
  applicationA = await createApplication(owner, tenantA.id, household);
}, 60_000);

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('application outcomes', () => {
  it('hides one tenant’s outcomes from another', async () => {
    await asTenant(app, tenantA.id, async (tx) => {
      await tx`
        insert into "ApplicationOutcome"
          ("tenantId", "applicationId", status, "recordedBy")
        values
          (${tenantA.id}, ${applicationA}, 'received', 'caseworker')
      `;
    });
    const hidden = await asTenant(app, tenantB.id, async (tx) => {
      return tx`select id from "ApplicationOutcome" where "applicationId" = ${applicationA}`;
    });
    expect(hidden).toHaveLength(0);
  });

  it('shows nothing when no tenant is set', async () => {
    const rows = await asNobody(app, async (tx) => {
      return tx`select id from "ApplicationOutcome"`;
    });
    expect(rows).toHaveLength(0);
  });

  it('refuses a denial that has no reason code', async () => {
    await expect(
      asTenant(app, tenantA.id, async (tx) => {
        await tx`
          insert into "ApplicationOutcome"
            ("tenantId", "applicationId", status, "recordedBy")
          values
            (${tenantA.id}, ${applicationA}, 'denied', 'caseworker')
        `;
      }),
    ).rejects.toThrow(/ApplicationOutcome_reason_when_needed/);
  });

  it('is append-only for the application role', async () => {
    const id = randomUUID();
    await asTenant(app, tenantA.id, async (tx) => {
      await tx`
        insert into "ApplicationOutcome"
          (id, "tenantId", "applicationId", status, "reasonCode", "recordedBy")
        values
          (${id}, ${tenantA.id}, ${applicationA}, 'pending_documents', 'missing_documents', 'caseworker')
      `;
    });
    await expect(
      asTenant(app, tenantA.id, async (tx) => {
        await tx`update "ApplicationOutcome" set "followUp" = 'bring id' where id = ${id}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
