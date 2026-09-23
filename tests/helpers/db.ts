import { randomUUID } from 'node:crypto';
import * as schema from '@/lib/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Test database helpers.
 *
 * The safety invariants are database constraints, so asserting them requires a
 * database. `POSTGRES_TEST_URL` points at a throwaway instance — see the README
 * for the one-line Docker command.
 *
 * Two connections, on purpose:
 *
 *   `ownerDb` runs migrations and seeds fixtures. It owns the tables, so
 *   row-level security does not apply to it.
 *
 *   `appDb` connects as `nava_api`, which owns nothing and has NOBYPASSRLS.
 *   This is the connection the application uses, and it is the only one that
 *   proves a policy actually filters.
 *
 * Testing isolation through the owner connection would pass while proving
 * nothing, which is the specific way an RLS test rots.
 */

export const TEST_URL = process.env.POSTGRES_TEST_URL ?? null;

export function requireTestUrl(): string {
  if (!TEST_URL) {
    throw new Error(
      'POSTGRES_TEST_URL is not set. These tests assert database constraints and cannot be faked.',
    );
  }
  return TEST_URL;
}

export function ownerClient() {
  return postgres(requireTestUrl(), { max: 1 });
}

/** The same database, reached as the least-privilege application role. */
export function appClient() {
  const url = new URL(requireTestUrl());
  url.username = 'nava_api';
  url.password = 'nava_api_test';
  return postgres(url.toString(), { max: 2, prepare: false });
}

export async function migrateTestDb(): Promise<void> {
  const client = ownerClient();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: './lib/db/migrations' });
  // 0001 creates nava_api as NOLOGIN, which is correct in production where the
  // role is assumed rather than dialed into. A test needs to connect as it.
  await client.unsafe(`ALTER ROLE nava_api LOGIN PASSWORD 'nava_api_test'`);
  await client.end();
}

export type TestTenant = { id: string; slug: string };

export async function createTenant(
  client: ReturnType<typeof ownerClient>,
  slug = `t-${randomUUID().slice(0, 8)}`,
): Promise<TestTenant> {
  const db = drizzle(client, { schema });
  const [row] = await db
    .insert(schema.tenant)
    .values({ slug, name: slug })
    .returning({ id: schema.tenant.id, slug: schema.tenant.slug });
  return row;
}

export async function createHousehold(
  client: ReturnType<typeof ownerClient>,
  tenantId: string,
): Promise<string> {
  const db = drizzle(client, { schema });
  const [row] = await db
    .insert(schema.household)
    .values({ tenantId, externalRef: `h-${randomUUID().slice(0, 8)}` })
    .returning({ id: schema.household.id });
  return row.id;
}

export async function createApplication(
  client: ReturnType<typeof ownerClient>,
  tenantId: string,
  householdId: string,
): Promise<string> {
  const db = drizzle(client, { schema });
  const [row] = await db
    .insert(schema.application)
    .values({
      tenantId,
      householdId,
      programIds: ['wic'],
      workflowId: 'riverside-wic',
      name: 'WIC',
    })
    .returning({ id: schema.application.id });
  return row.id;
}

export async function createFact(
  client: ReturnType<typeof ownerClient>,
  tenantId: string,
  householdId: string,
  key = 'firstName',
  source: 'connector' | 'caseworker' | 'page' | 'inferred' = 'connector',
): Promise<string> {
  const db = drizzle(client, { schema });
  const [row] = await db
    .insert(schema.fact)
    .values({ tenantId, householdId, key, value: 'value', source })
    .returning({ id: schema.fact.id });
  return row.id;
}

/** Runs `fn` with app.tenant_id set, exactly as `withTenant` does in production. */
export async function asTenant<T>(
  client: ReturnType<typeof appClient>,
  tenantId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return client.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Runs `fn` with no tenant set, to prove unscoped access sees nothing. */
export async function asNobody<T>(
  client: ReturnType<typeof appClient>,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return client.begin(async (tx) => fn(tx)) as Promise<T>;
}
