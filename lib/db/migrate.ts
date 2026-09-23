import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

config({ path: '.env.local' });

/**
 * Runs migrations as the *owner* role, not as `nava_api`.
 *
 * 0001 creates the nava_api role, grants it least privilege, and enables
 * row-level security. It cannot be applied by a role that RLS would then
 * filter, so POSTGRES_MIGRATION_URL (owner) is used when set and POSTGRES_URL
 * is the fallback for local development where they are the same.
 */
const url = process.env.POSTGRES_MIGRATION_URL ?? process.env.POSTGRES_URL;
if (!url) throw new Error('POSTGRES_URL is not set.');

const main = async () => {
  const client = postgres(url, { max: 1 });
  const start = Date.now();
  await migrate(drizzle(client), { migrationsFolder: './lib/db/migrations' });
  console.log(`migrations applied in ${Date.now() - start}ms`);
  await client.end();
};

main().catch((error) => {
  console.error('migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
