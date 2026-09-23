import { randomBytes } from 'node:crypto';
import { hashSecret } from '@/lib/auth';
import { SEED_PLAYBOOKS } from '@/lib/playbooks/data';
import type { FactSource } from '@/lib/vocabulary';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { apiKey, connection, fact, household, person, playbook, tenant } from './schema';

config({ path: '.env.local' });

/**
 * Seeds a demo tenant with one fictional household, served by the connector
 * endpoints in the same shape as the extension's loopback mock
 * (`connector-service/mock-server.mjs`), so the extension can be pointed at this
 * service instead of the mock.
 *
 * All values are fictional. Every fact is sourced `connector`, because that is
 * what they would be in a real run.
 */

const url = process.env.POSTGRES_MIGRATION_URL ?? process.env.POSTGRES_URL;
if (!url) throw new Error('POSTGRES_URL is not set.');

/** Demo record 900001, keyed by canonical fact key. Every value is invented. */
const DEMO_FACTS: Record<string, unknown> = {
  firstName: 'Jordan',
  middleName: 'Q',
  lastName: 'Sample',
  dateOfBirth: '2000-01-02',
  email: 'jordan.sample@example.org',
  phone: '555-010-0199',
  addressLine1: '100 Example Way',
  addressLine2: 'Unit 1',
  city: 'Riverside',
  state: 'California',
  county: 'Riverside',
  postalCode: '92501',
  country: 'United States',
  primaryLanguage: 'English',
  gender: 'Female',
  ethnicity: 'Hispanic/Latino',
  maritalStatus: 'Single',
  specialNeeds: false,
  farmWorker: false,
  preferredContact: 'Email',
  housingStatus: 'Stable housing',
  householdSize: 3,
  immigrationStatus: 'U.S. citizen',
  income: 1850,
  childcare: true,
  unemployment: false,
  pregnant: false,
  ssn: '900-12-3456',
};

const main = async () => {
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  const [demoTenant] = await db
    .insert(tenant)
    .values({ slug: 'riverside-demo', name: 'Demo Community Services' })
    .onConflictDoUpdate({
      target: tenant.slug,
      set: { name: 'Demo Community Services' },
    })
    .returning();

  // Shared control-plane playbooks. tenantId stays null.
  for (const seed of SEED_PLAYBOOKS) {
    await db.insert(playbook).values({ ...seed, tenantId: null });
  }

  await db
    .insert(connection)
    .values({
      tenantId: demoTenant.id,
      // The connection ID the extension is configured with in the mock setup,
      // so an existing install needs only a URL change.
      connectionId: 'nava-demo',
      providerId: 'apricot360',
      organizationName: 'Demo Community Services',
      sourceId: '99',
      // No credentials. A real adapter resolves secretRef from Secret Manager.
      secretRef: null,
      mappings: Object.fromEntries(Object.keys(DEMO_FACTS).map((key) => [key, key])),
    })
    .onConflictDoNothing();

  const [demoHousehold] = await db
    .insert(household)
    .values({
      tenantId: demoTenant.id,
      // The partner's own reference, not an Apricot ID.
      externalRef: 'demo-household-1',
      connectionId: 'nava-demo',
      recordId: '900001',
    })
    .onConflictDoUpdate({
      target: [household.tenantId, household.externalRef],
      set: { recordId: '900001' },
    })
    .returning();

  const [applicant] = await db
    .insert(person)
    .values({ tenantId: demoTenant.id, householdId: demoHousehold.id, role: 'applicant' })
    .returning();

  const source: FactSource = 'connector';
  await db.insert(fact).values(
    Object.entries(DEMO_FACTS).map(([key, value]) => ({
      tenantId: demoTenant.id,
      householdId: demoHousehold.id,
      personId: applicant.id,
      key,
      value,
      source,
      sourceDetail: 'Bonterra Apricot 360 form 99, record 900001',
      confidence: '1.000',
      consentScope: 'benefits-application',
    })),
  );

  // Print the key once. Only its HMAC is stored.
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  await db.insert(apiKey).values({
    tenantId: demoTenant.id,
    keyId,
    secretHash: hashSecret(secret),
    scopes: ['*'],
    label: 'seed key',
  });

  console.log('\nSeeded tenant riverside-demo');
  console.log('  household externalRef  demo-household-1');
  console.log('  connectionId           nava-demo (sourceId 99, record 900001)');
  console.log(`  playbooks              ${SEED_PLAYBOOKS.length} shared`);
  console.log(`\n  API key (shown once):  nava_${keyId}_${secret}\n`);

  await client.end();
};

main().catch((error) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
