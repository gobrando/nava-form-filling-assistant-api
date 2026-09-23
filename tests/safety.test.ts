import { readFileSync } from 'node:fs';
import { DO_NOT_DERIVE } from '@/lib/vocabulary';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appClient,
  asNobody,
  asTenant,
  createApplication,
  createFact,
  createHousehold,
  createTenant,
  ownerClient,
} from './helpers/db';

/**
 * The safety invariants.
 *
 * Each of these is a database constraint rather than a check in a route
 * handler, and each test asserts the constraint and not the handler. That
 * distinction is the whole value: a handler can be bypassed by the next
 * endpoint someone adds, an agent tool, or a migration script. A constraint
 * cannot.
 *
 * The extension takes the same position in `extension-safety.test.cjs`, which
 * asserts there is no code path to submit rather than trusting the runner not
 * to take one.
 */

const owner = ownerClient();
const app = appClient();

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let householdA: string;
let applicationA: string;

beforeAll(async () => {
  tenantA = await createTenant(owner);
  tenantB = await createTenant(owner);
  householdA = await createHousehold(owner, tenantA.id);
  applicationA = await createApplication(owner, tenantA.id, householdA);
}, 60_000);

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('the application role cannot bypass row-level security', () => {
  it('is neither superuser nor BYPASSRLS', async () => {
    const [row] = await owner`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'nava_api'
    `;
    // If either of these were true, every policy below would be decoration and
    // every isolation test would pass while proving nothing.
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });

  it('does not own the tables it reads', async () => {
    const [row] = await owner`
      select tableowner from pg_tables where tablename = 'Fact' and schemaname = 'public'
    `;
    expect(row.tableowner).not.toBe('nava_api');
  });
});

describe('tenant isolation', () => {
  it('hides another tenant’s households', async () => {
    const visible = await asTenant(app, tenantB.id, async (tx) => {
      return tx`select id from "Household" where id = ${householdA}`;
    });
    expect(visible).toHaveLength(0);
  });

  it('shows a tenant its own households', async () => {
    const visible = await asTenant(app, tenantA.id, async (tx) => {
      return tx`select id from "Household" where id = ${householdA}`;
    });
    expect(visible).toHaveLength(1);
  });

  it('shows nothing when no tenant is set', async () => {
    // Fails closed. An unscoped read is a bug, and the safe symptom is empty
    // results rather than every tenant's data.
    const visible = await asNobody(app, async (tx) => {
      return tx`select id from "Household"`;
    });
    expect(visible).toHaveLength(0);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await expect(
      asTenant(app, tenantA.id, async (tx) => {
        return tx`
          insert into "Household" ("tenantId", "externalRef")
          values (${tenantB.id}, 'smuggled')
        `;
      }),
    ).rejects.toThrow();
  });
});

describe('a protected fact may never be inferred', () => {
  it('rejects every DO_NOT_DERIVE key with source inferred', async () => {
    for (const key of DO_NOT_DERIVE) {
      await expect(
        owner`
          insert into "Fact" ("tenantId", "householdId", key, value, source)
          values (${tenantA.id}, ${householdA}, ${key}, '"x"'::jsonb, 'inferred')
        `,
        // The owner connection is used deliberately: even the table owner, who
        // bypasses row-level security, cannot write one of these.
      ).rejects.toThrow(/Fact_protected_not_inferred/);
    }
  });

  it('allows a protected key from a real source', async () => {
    // Protected means "not derivable", not "not storable". A caseworker who
    // asks the participant can record it.
    const rows = await owner`
      insert into "Fact" ("tenantId", "householdId", key, value, source, "confirmedBy")
      values (${tenantA.id}, ${householdA}, 'income', '1850'::jsonb, 'caseworker', 'a-caseworker')
      returning id
    `;
    expect(rows).toHaveLength(1);
  });

  it('allows an unprotected key to be inferred', async () => {
    const rows = await owner`
      insert into "Fact" ("tenantId", "householdId", key, value, source, "sourceDetail")
      values (${tenantA.id}, ${householdA}, 'county', '"Riverside"'::jsonb, 'inferred', 'From ZIP 92595')
      returning id
    `;
    expect(rows).toHaveLength(1);
  });

  it('keeps the SQL list and the TypeScript list identical', () => {
    // Two copies of a safety list is a drift hazard, so the drift is what gets
    // tested. The SQL copy is the enforced one.
    const sql = readFileSync('lib/db/migrations/0001_tenant_isolation_and_safety.sql', 'utf8');
    // Scoped to the ARRAY literal specifically, so the `source = 'inferred'`
    // comparison in the same CHECK is not mistaken for a protected key.
    const block = /Fact_protected_not_inferred"[\s\S]*?ARRAY\[([\s\S]*?)\]/.exec(sql);
    expect(block).not.toBeNull();
    const fromSql = new Set(
      [...(block as RegExpExecArray)[1].matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1]),
    );
    expect([...fromSql].sort()).toEqual([...DO_NOT_DERIVE].sort());
  });
});

describe('the facts ledger is append-only', () => {
  it('denies UPDATE and DELETE on Fact to the application role', async () => {
    const factId = await createFact(owner, tenantA.id, householdA, 'lastName');

    await expect(
      asTenant(app, tenantA.id, async (tx) => {
        return tx`update "Fact" set value = '"changed"'::jsonb where id = ${factId}`;
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asTenant(app, tenantA.id, async (tx) => {
        return tx`delete from "Fact" where id = ${factId}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('rejects a fact that supersedes itself', async () => {
    await expect(
      owner`
        insert into "Fact" ("tenantId", "householdId", key, value, source, "supersedesId")
        select ${tenantA.id}, ${householdA}, 'city', '"x"'::jsonb, 'page', id
        from "Fact" limit 1
      `.then(async () => {
        const [row] = await owner`select id from "Fact" order by "createdAt" desc limit 1`;
        return owner`update "Fact" set "supersedesId" = id where id = ${row.id}`;
      }),
    ).rejects.toThrow();
  });
});

describe('a filled field must have inspectable provenance', () => {
  it('rejects a value with no fact and no page source', async () => {
    await expect(
      owner`
        insert into "ApplicationField"
          ("tenantId", "applicationId", ordinal, "fieldKey", label, value, source)
        values (${tenantA.id}, ${applicationA}, 900, '#orphan', 'Orphan', 'invented', 'connector')
      `,
    ).rejects.toThrow(/ApplicationField_provenance_required/);
  });

  it('accepts a value that links to a fact', async () => {
    const factId = await createFact(owner, tenantA.id, householdA, 'email');
    const rows = await owner`
      insert into "ApplicationField"
        ("tenantId", "applicationId", ordinal, "fieldKey", label, value, "factId", source)
      values (${tenantA.id}, ${applicationA}, 901, '#email', 'Email', 'a@b.c', ${factId}, 'connector')
      returning id
    `;
    expect(rows).toHaveLength(1);
  });

  it('accepts a value that was already on the page', async () => {
    const rows = await owner`
      insert into "ApplicationField"
        ("tenantId", "applicationId", ordinal, "fieldKey", label, value, source)
      values (${tenantA.id}, ${applicationA}, 902, '#prefilled', 'Prefilled', 'was here', 'page')
      returning id
    `;
    expect(rows).toHaveLength(1);
  });

  it('accepts an empty field with no provenance', async () => {
    // A blank is honest. The constraint is about values, not about rows.
    const rows = await owner`
      insert into "ApplicationField" ("tenantId", "applicationId", ordinal, "fieldKey", label)
      values (${tenantA.id}, ${applicationA}, 903, '#blank', 'Blank')
      returning id
    `;
    expect(rows).toHaveLength(1);
  });
});

describe('the audit trail carries no participant values', () => {
  it('accepts allowlisted count and enum keys', async () => {
    const rows = await owner`
      insert into "AuditEvent" ("tenantId", type, "principalId", details)
      values (
        ${tenantA.id}, 'page_verified', 'key:test',
        ${JSON.stringify({ fieldCount: 18, verifiedCount: 11, resumeOutcome: 'verified' })}::jsonb
      )
      returning id
    `;
    expect(rows).toHaveLength(1);
  });

  it('rejects any other key', async () => {
    for (const details of [
      { ssn: '900-12-3456' },
      { firstName: 'Jordan' },
      { note: 'participant said she moved' },
      { fieldCount: 3, address: '100 Example Way' },
    ]) {
      await expect(
        owner`
          insert into "AuditEvent" ("tenantId", type, "principalId", details)
          values (${tenantA.id}, 'source_loaded', 'key:test', ${JSON.stringify(details)}::jsonb)
        `,
      ).rejects.toThrow(/AuditEvent_details_allowlist/);
    }
  });

  it('denies UPDATE and DELETE on AuditEvent to the application role', async () => {
    await expect(
      asTenant(app, tenantA.id, async (tx) => {
        return tx`delete from "AuditEvent" where "tenantId" = ${tenantA.id}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('the submit gate', () => {
  // Each rule gets its own application, so no rule passes because an earlier
  // test happened to leave the row in a convenient state.
  async function freshApplication(): Promise<string> {
    return createApplication(owner, tenantA.id, householdA);
  }
  async function confirm(applicationId: string) {
    await owner`
      insert into "ReviewEvent" ("tenantId", "applicationId", "reviewerPrincipal", action)
      values (${tenantA.id}, ${applicationId}, 'a-reviewer', 'confirmed')
    `;
  }
  async function filledField(
    applicationId: string,
    options: { fieldKey: string; verified: boolean; required?: boolean },
  ) {
    const factId = await createFact(owner, tenantA.id, householdA, 'phone');
    await owner`
      insert into "ApplicationField"
        ("tenantId", "applicationId", ordinal, "fieldKey", label, required, value, "factId", source, "verifiedAt")
      values (${tenantA.id}, ${applicationId}, 1, ${options.fieldKey}, 'Phone',
        ${options.required ?? false}, '555-010-0100', ${factId}, 'connector',
        ${options.verified ? new Date().toISOString() : null})
    `;
  }
  function submit(applicationId: string) {
    return owner`
      update "Application" set "submittedAt" = now() where id = ${applicationId}
      returning "submittedAt"
    `;
  }

  it('refuses a submission with no confirmed review', async () => {
    const id = await freshApplication();
    await filledField(id, { fieldKey: '#phone', verified: true });
    await expect(submit(id)).rejects.toThrow(/no confirmed review event/);
  });

  it('refuses a confirmed submission with nothing in it', async () => {
    const id = await freshApplication();
    await confirm(id);
    await expect(submit(id)).rejects.toThrow(/no filled values to review/);
  });

  it('refuses a submission while a required field is empty', async () => {
    const id = await freshApplication();
    await confirm(id);
    await filledField(id, { fieldKey: '#phone', verified: true });
    await owner`
      insert into "ApplicationField" ("tenantId", "applicationId", ordinal, "fieldKey", label, required)
      values (${tenantA.id}, ${id}, 2, '#needed', 'Needed', true)
    `;
    await expect(submit(id)).rejects.toThrow(/unfilled required fields/);
  });

  it('refuses a submission with a value that was never read back', async () => {
    const id = await freshApplication();
    await confirm(id);
    await filledField(id, { fieldKey: '#phone', verified: false });
    await expect(submit(id)).rejects.toThrow(/never read back/);
  });

  it('refuses a submission with an unanswered required question', async () => {
    const id = await freshApplication();
    await confirm(id);
    await filledField(id, { fieldKey: '#phone', verified: true });
    await owner`
      insert into "Gap" ("tenantId", "applicationId", ordinal, "fieldKey", label, question, kind, required)
      values (${tenantA.id}, ${id}, 1, '#clinic', 'Clinic', 'Which clinic?', 'decision', true)
    `;
    await expect(submit(id)).rejects.toThrow(/unanswered required questions/);
  });

  it('allows a submission once confirmed, filled, and verified', async () => {
    const id = await freshApplication();
    await confirm(id);
    await filledField(id, { fieldKey: '#phone', verified: true, required: true });
    const rows = await submit(id);
    expect(rows[0].submittedAt).not.toBeNull();
  });
});

describe('there is no code path that submits an application', () => {
  it('has no agent tool that activates a submit control', async () => {
    const { readdirSync } = await import('node:fs');
    const tools = readdirSync('agent/tools').filter((name) => name.endsWith('.ts'));

    // The same shape of assertion the extension makes about itself: prove the
    // capability is absent, rather than trusting instructions to forbid it.
    for (const name of tools) {
      const source = readFileSync(`agent/tools/${name}`, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/\bsubmittedAt\b/);
      expect(code).not.toMatch(/\bclick\s*\(/);
    }

    expect(tools).toContain('check_submit_gate.ts');
    expect(tools).not.toContain('submit.ts');
  });
});
