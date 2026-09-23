import { randomBytes } from 'node:crypto';
import { hashSecret } from '@/lib/auth';
import { runCommand } from '@/lib/browser/cli';
import * as schema from '@/lib/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Proves the API works, over HTTP, end to end.
 *
 * This plays the partner — the role the Chrome extension plays in production:
 * it holds the browser, reports probe results and readbacks, and answers gaps.
 * Every assertion is made against a real HTTP response from the running
 * service, and every form interaction happens in a real Chromium against the
 * local WIC fixture.
 *
 *   pnpm dev            # the API, on :3000
 *   pnpm fixture        # the form, on :4300
 *   pnpm prove
 *
 * Two runs:
 *   A. The trap. The fixture's ZIP field silently truncates. The API must
 *      catch it on readback, turn it into a question, and keep the submit gate
 *      shut — even after a caseworker answers, because the page still cannot
 *      hold the value.
 *   B. The clean form. Every value lands, every gap is answered, a named
 *      reviewer confirms, and only then is a human submission recorded.
 *
 * Plus the invariants a partner would try to break: another tenant cannot see
 * this household, a protected field cannot be inferred, and the audit export
 * carries no participant values.
 */

const API = process.env.API_URL ?? 'http://localhost:3000';
const FIXTURE = process.env.FIXTURE_URL ?? 'http://localhost:4300';
const OWNER_URL = process.env.POSTGRES_MIGRATION_URL ?? process.env.POSTGRES_URL;
const BROWSER_SESSION = `prove-${Date.now()}`;

// Obviously synthetic. 555-0100 through 555-0199 are reserved for fiction.
const HOUSEHOLD = {
  fullName: 'Jordan Sample',
  phone: '555-010-0199',
  email: 'jordan.sample@example.org',
  postalCode: '92501',
  primaryLanguage: 'English',
};

let failures = 0;

function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) console.log(`  \u2713 ${label}`);
  else {
    failures++;
    console.log(`  \u2717 ${label}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 600)}`);
  }
}

async function mintKey(tenantSlug: string): Promise<{ key: string; tenantId: string }> {
  if (!OWNER_URL) throw new Error('Set POSTGRES_MIGRATION_URL (the owner role) to mint test keys.');
  const client = postgres(OWNER_URL, { max: 1 });
  const db = drizzle(client, { schema });
  const [tenant] = await db
    .insert(schema.tenant)
    .values({ slug: tenantSlug, name: tenantSlug })
    .returning();
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  await db.insert(schema.apiKey).values({
    tenantId: tenant.id,
    keyId,
    secretHash: hashSecret(secret),
    scopes: ['*'],
    label: 'prove',
  });
  await client.end();
  return { key: `nava_${keyId}_${secret}`, tenantId: tenant.id };
}

function api(key: string) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json?.data ?? json, raw: json };
  };
}

async function browser(command: string[]) {
  const result = await runCommand(command, { session: BROWSER_SESSION });
  if (!result.success) throw new Error(`browser ${command.join(' ')}: ${result.error}`);
  return result.data as any;
}

function scalar(data: any, field: string): any {
  if (data === null || typeof data !== 'object') return data;
  return data[field] ?? data.result ?? data.value ?? data.text;
}

async function fillAndRead(
  writes: { fieldKey: string; value: string; inputType?: string; method?: string }[],
) {
  const readbacks: { fieldKey: string; landedValue: string | null }[] = [];
  for (const write of writes) {
    if (write.inputType === 'select') await browser(['select', write.fieldKey, write.value]);
    else if (write.method === 'keys') await browser(['type', write.fieldKey, write.value]);
    else await browser(['fill', write.fieldKey, write.value]);
    const landed = scalar(await browser(['get', 'value', write.fieldKey]), 'value');
    readbacks.push({
      fieldKey: write.fieldKey,
      landedValue: landed === undefined ? null : String(landed),
    });
  }
  return readbacks;
}

async function runApplication(
  call: ReturnType<typeof api>,
  householdId: string,
  variant: 'trap' | 'clean',
) {
  const pageUrl = `${FIXTURE}/appointments/apply-4-wic-form${variant === 'clean' ? '?variant=clean' : ''}`;

  const playbook = await call('GET', '/v1/programs/wic/playbook');
  check(
    playbook.status === 200,
    'GET /v1/programs/wic/playbook returns the served playbook',
    playbook.raw,
  );
  const probes: string[] = playbook.body?.playbook?.probes ?? playbook.body?.probes ?? [];

  await browser(['open', pageUrl]);
  const probeResults = [];
  for (const selector of probes) {
    const count = Number(scalar(await browser(['get', 'count', selector]), 'count'));
    probeResults.push({ selector, count });
  }
  check(
    probeResults.length > 0 && probeResults.every((probe) => probe.count === 1),
    'every freshness probe resolves exactly once on the page',
    probeResults,
  );

  const started = await call('POST', '/v1/applications', {
    householdId,
    programIds: ['wic'],
    probeResults,
  });
  check(
    started.status === 201,
    'POST /v1/applications takes the warm path (201, no model)',
    started.raw,
  );
  check(
    started.body?.application?.executionMode === 'script',
    'executionMode is "script"',
    started.body?.application,
  );
  const applicationId: string = started.body?.application?.id;
  const writes = started.body?.plan?.writes ?? [];
  check(
    writes.every((write: any) => write.factId),
    'every planned write carries the fact it came from',
    writes,
  );

  const readbacks = await fillAndRead(writes);
  const verified = await call('POST', `/v1/applications/${applicationId}/fields`, { readbacks });
  const mismatched = (verified.body?.mismatched ?? []).map((item: any) => item.fieldKey);

  if (variant === 'trap') {
    check(
      mismatched.includes('#edit-zip-code'),
      'readback catches the ZIP the page silently truncated',
      verified.raw,
    );
  } else {
    check(mismatched.length === 0, 'every write landed and was verified on readback', verified.raw);
  }

  const gaps = await call('GET', `/v1/applications/${applicationId}/gaps`);
  const open = gaps.body?.gaps ?? [];
  const clinic = open.find((gap: any) => gap.fieldKey.includes('clinic'));
  check(Boolean(clinic), 'the clinic choice is a question, not a guess', open);

  const early = await call('POST', `/v1/applications/${applicationId}/submit`, {
    submittedBy: 'caseworker-a',
  });
  check(early.status === 409, 'POST /submit is refused (409) while questions are open', early.raw);

  const answers = [
    { gapId: clinic?.id, value: 'Riverside WIC', source: 'caseworker', answeredBy: 'caseworker-a' },
  ];
  const zipGap = open.find((gap: any) => gap.fieldKey === '#edit-zip-code');
  if (zipGap) {
    answers.push({
      gapId: zipGap.id,
      value: HOUSEHOLD.postalCode,
      source: 'caseworker',
      answeredBy: 'caseworker-a',
    });
  }
  const answered = await call('POST', `/v1/applications/${applicationId}/gaps`, { answers });
  check(
    answered.status === 200 && answered.body?.answered === answers.length,
    'POST /gaps stores each answer as a caseworker-sourced fact',
    answered.raw,
  );

  const answerWrites = (answered.body?.writes ?? []).map((write: any) => ({
    ...write,
    inputType: write.fieldKey.includes('clinic') ? 'select' : 'text',
  }));
  const second = await call('POST', `/v1/applications/${applicationId}/fields`, {
    readbacks: await fillAndRead(answerWrites),
  });

  if (variant === 'trap') {
    const stillMismatched = (second.body?.mismatched ?? []).map((item: any) => item.fieldKey);
    check(
      stillMismatched.includes('#edit-zip-code'),
      'the answered ZIP still does not land, and the API says so',
      second.raw,
    );
    const gate = await call('POST', `/v1/applications/${applicationId}/review`, {
      action: 'confirmed',
      reviewerPrincipal: 'reviewer-a',
      attestation: 'Reviewed with the participant.',
    });
    check(
      gate.status === 409,
      'a reviewer cannot confirm a packet with a value that never landed',
      gate.raw,
    );
    return applicationId;
  }

  check(
    (second.body?.mismatched ?? []).length === 0,
    'the answered clinic choice landed and was verified',
    second.raw,
  );

  const packet = await call('GET', `/v1/applications/${applicationId}/packet`);
  check(
    packet.body?.summary?.provenanceShare === 1,
    'packet: 100% of values have inspectable provenance',
    packet.body?.summary,
  );
  check(
    packet.body?.summary?.filledCount === packet.body?.summary?.verifiedCount,
    'packet: every filled value is verified',
    packet.body?.summary,
  );
  const clinicField = packet.body?.fields?.find((field: any) => field.fieldKey.includes('clinic'));
  check(
    clinicField?.provenance?.source === 'caseworker' &&
      clinicField?.provenance?.confirmedBy === 'caseworker-a',
    'packet: the clinic says who chose it',
    clinicField,
  );
  const nameField = packet.body?.fields?.find((field: any) => field.purpose === 'fullName');
  check(
    nameField?.provenance?.source === 'connector',
    'packet: the name says it came from the connector',
    nameField,
  );

  const confirmed = await call('POST', `/v1/applications/${applicationId}/review`, {
    action: 'confirmed',
    reviewerPrincipal: 'reviewer-a',
    attestation: 'Reviewed with the participant.',
  });
  check(confirmed.status === 201, 'a named reviewer confirms the packet', confirmed.raw);

  const submitted = await call('POST', `/v1/applications/${applicationId}/submit`, {
    submittedBy: 'caseworker-a',
    confirmationNumber: 'FIXTURE-0001',
  });
  check(
    submitted.status === 200 || submitted.status === 201,
    'POST /submit records the human submission',
    submitted.raw,
  );

  const again = await call('POST', `/v1/applications/${applicationId}/submit`, {
    submittedBy: 'caseworker-a',
  });
  check(again.status === 409, 'a second submission is refused', again.raw);

  const metrics = await call('GET', `/v1/applications/${applicationId}/metrics`);
  check(
    metrics.status === 200 && metrics.body?.cost?.executionMode === 'script',
    'GET /metrics reports a script run',
    metrics.body,
  );
  return applicationId;
}

async function main() {
  const health = await fetch(`${API}/v1/programs`).catch(() => null);
  if (!health) throw new Error(`The API is not running at ${API}. Start it with pnpm dev.`);
  const fixture = await fetch(`${FIXTURE}/`).catch(() => null);
  if (!fixture?.ok)
    throw new Error(`The fixture is not running at ${FIXTURE}. Start it with pnpm fixture.`);

  const stamp = Date.now().toString(36);
  const partner = await mintKey(`prove-${stamp}`);
  const other = await mintKey(`prove-other-${stamp}`);
  const call = api(partner.key);
  const intruder = api(other.key);

  console.log('\nAuthentication and the catalog');
  const unauthenticated = await fetch(`${API}/v1/programs`);
  check(unauthenticated.status === 401, 'a request without a key is refused (401)');
  const programs = await call('GET', '/v1/programs');
  check(
    programs.status === 200 && JSON.stringify(programs.body).includes('wic'),
    'GET /v1/programs lists WIC',
    programs.raw,
  );

  console.log('\nThe case graph');
  const created = await call('POST', '/v1/households', {
    externalRef: `prove-${stamp}`,
    facts: Object.entries(HOUSEHOLD).map(([key, value]) => ({
      key,
      value,
      source: 'connector',
      sourceDetail: 'proof script',
    })),
  });
  check(created.status === 201, 'POST /v1/households creates a household with facts', created.raw);
  const householdId: string = created.body?.household?.id ?? created.body?.id;

  const inferred = await call('POST', `/v1/households/${householdId}/facts`, {
    facts: [{ key: 'ssn', value: '000-12-3456', source: 'inferred' }],
  });
  check(
    inferred.status === 207 && (inferred.body?.rejected ?? []).length === 1,
    'an inferred SSN is refused',
    inferred.raw,
  );

  const peek = await intruder('GET', `/v1/households/${householdId}`);
  check(peek.status === 404, 'another tenant cannot see this household (404)', peek.raw);

  console.log('\nRun A: the form that silently truncates');
  await runApplication(call, householdId, 'trap');

  console.log('\nRun B: the form that accepts every value');
  await runApplication(call, householdId, 'clean');

  console.log('\nThe audit trail');
  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 60 * 1000).toISOString();
  const audit = await fetch(`${API}/v1/audit/export?from=${from}&to=${to}`, {
    headers: { authorization: `Bearer ${partner.key}` },
  });
  const auditText = await audit.text();
  check(
    audit.status === 200 && auditText.length > 50,
    'GET /v1/audit/export returns this run’s events',
  );
  const leaked = Object.values(HOUSEHOLD).filter((value) => auditText.includes(value));
  check(leaked.length === 0, 'the audit export contains no participant values', leaked);

  await runCommand(['close'], { session: BROWSER_SESSION });

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
  await runCommand(['close'], { session: BROWSER_SESSION }).catch(() => {});
  process.exit(1);
});
