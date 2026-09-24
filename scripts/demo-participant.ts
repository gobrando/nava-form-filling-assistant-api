import { hashSecret } from '@/lib/auth';
import { newShareToken } from '@/lib/participate';
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { application, fact, gap, household, participantShare, tenant } from '../lib/db/schema';

/**
 * Builds one fictional household with an open question and prints a participant
 * link. Values are invented. Re-running replaces the previous demo link.
 */
config({ path: '.env.local' });

const url = process.env.POSTGRES_MIGRATION_URL ?? process.env.POSTGRES_URL;
if (!url) throw new Error('POSTGRES_URL is not set.');

const client = postgres(url, { max: 1 });
const db = drizzle(client);

const main = async () => {
  const [org] = await db
    .insert(tenant)
    .values({ slug: 'participant-demo', name: 'Demo Community Services' })
    .onConflictDoUpdate({ target: tenant.slug, set: { name: 'Demo Community Services' } })
    .returning({ id: tenant.id });

  await db
    .delete(household)
    .where(and(eq(household.tenantId, org.id), eq(household.externalRef, 'participant-demo')));
  const [home] = await db
    .insert(household)
    .values({ tenantId: org.id, externalRef: 'participant-demo' })
    .returning({ id: household.id });

  await db.insert(fact).values([
    {
      tenantId: org.id,
      householdId: home.id,
      key: 'firstName',
      value: 'Jordan',
      source: 'connector',
      sourceDetail: 'Apricot 360 form demo, record 900001',
    },
    {
      tenantId: org.id,
      householdId: home.id,
      key: 'lastName',
      value: 'Sample',
      source: 'connector',
      sourceDetail: 'Apricot 360 form demo, record 900001',
    },
    {
      tenantId: org.id,
      householdId: home.id,
      key: 'postalCode',
      value: '92501',
      source: 'connector',
      sourceDetail: 'Apricot 360 form demo, record 900001',
    },
    {
      tenantId: org.id,
      householdId: home.id,
      key: 'ssn',
      value: '900-12-3456',
      source: 'caseworker',
      sourceDetail: 'Confirmed in person. Invented test number.',
      confirmedBy: 'demo-caseworker',
    },
  ]);

  const [app] = await db
    .insert(application)
    .values({
      tenantId: org.id,
      householdId: home.id,
      programIds: ['wic'],
      workflowId: 'riverside-wic',
      name: 'WIC',
      status: 'needs_attention',
    })
    .returning({ id: application.id });

  await db.insert(gap).values({
    tenantId: org.id,
    applicationId: app.id,
    ordinal: 0,
    fieldKey: 'clinic',
    label: 'WIC clinic',
    question: 'Which clinic will you visit?',
    kind: 'decision',
    required: true,
    inputType: 'select',
    options: ['Riverside', 'Moreno Valley', 'Corona'],
  });

  const token = newShareToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(participantShare).values({
    tenantId: org.id,
    applicationId: app.id,
    householdId: home.id,
    tokenHash: hashSecret(token),
    createdBy: 'demo-caseworker',
    expiresAt,
  });

  console.log(`http://127.0.0.1:3000/participate/${token}`);
  await client.end();
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
