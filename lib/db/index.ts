import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Database access, with tenant isolation enforced by Postgres rather than by
 * remembering to write a WHERE clause.
 *
 * There are two patterns. The low-cost one is a single database with a
 * tenant_id column and Postgres row-level security enforcing the filter. The
 * strong one is a GCP project per tenant with separate IAM, billing, and
 * quotas, which government clients often expect. This is the
 * low-cost pattern, built so the upgrade is an infrastructure change and not a
 * query rewrite: every data read goes through `withTenant`, so moving to a
 * project per tenant changes the connection string, not the call sites.
 *
 * The application MUST connect as a least-privilege role that is neither
 * superuser nor the table owner. Both bypass row-level security silently, which
 * would turn every policy below into decoration. `tests/safety.test.ts` asserts
 * the running role is not exempt.
 */

const connectionString = process.env.POSTGRES_URL;
if (!connectionString && process.env.NODE_ENV === 'production') {
  throw new Error('POSTGRES_URL is required.');
}

const client = postgres(connectionString ?? '', { max: 10, prepare: false });

/**
 * Unscoped handle. Reaches only `Tenant` and `ApiKey`, the two credential
 * tables that must be readable before a tenant is known — they carry no
 * participant data and no row-level security. Do not use it for anything else;
 * use `withTenant`.
 */
export const db = drizzle(client, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` in a transaction scoped to one tenant.
 *
 * `set_config(..., true)` is transaction-local, so the setting cannot leak to
 * the next borrower of a pooled connection. Using `set_config` rather than
 * `SET LOCAL` also keeps the tenant id a bound parameter instead of
 * interpolated SQL.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export { schema };
