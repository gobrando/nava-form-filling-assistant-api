import { migrateTestDb } from './helpers/db';

/**
 * Migrates once before any test file runs. Each database-backed file used to
 * migrate for itself, and running them in parallel raced on the same role and
 * catalog rows ("tuple concurrently updated").
 */
export default async function setup() {
  if (process.env.POSTGRES_TEST_URL) await migrateTestDb();
}
