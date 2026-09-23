import { randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, ownerClient } from './helpers/db';

/**
 * The live Apricot adapter, against a mock that speaks Apricot's wire format:
 * the OAuth client-credentials endpoint, `/forms/{id}/fields`, and
 * `/records/{id}`, under the `sandbox` prefix, exactly as labs-asp calls them.
 *
 * The import test calls the real route handler with a real API key, through
 * the application role, so authentication, RLS, the reviewed mapping, and the
 * facts ledger are all the production code paths.
 */

const FORM_ID = '99';
const PREFIX = 'APRICOT_TEST';

type Upstream = {
  tokenRequests: number;
  recordRequests: number;
  /** When set, the next record request is answered 401 once. */
  expireNextToken: boolean;
  issued: string[];
};
const upstream: Upstream = {
  tokenRequests: 0,
  recordRequests: 0,
  expireNextToken: false,
  issued: [],
};

const RECORDS: Record<string, { form_id: number; fields: Record<string, unknown> }> = {
  '1001': {
    form_id: 99,
    fields: {
      field_101: 'Jordan',
      field_103: 'Sample',
      field_112: '92501',
      field_127: '900-12-3456',
      // Present in Apricot, absent from the reviewed mapping.
      field_150: 'Unreviewed value',
      field_151: '',
    },
  },
  // Same organization, different form. Must never be served on form 99.
  '2002': { form_id: 55, fields: { field_101: 'Other' } },
};

let server: Server;
let baseUrl: string;

function startMock(): Promise<void> {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (request.method === 'POST' && url.pathname === '/sandbox/oauth/token') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (body.grant_type !== 'client_credentials' || body.client_secret !== 'test-secret') {
        return send(401, { error: 'invalid_client' });
      }
      upstream.tokenRequests++;
      const token = `token-${upstream.tokenRequests}`;
      upstream.issued.push(token);
      return send(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }

    const bearer = request.headers.authorization?.replace('Bearer ', '');
    if (!bearer || !upstream.issued.includes(bearer)) return send(401, { error: 'unauthorized' });

    const record = /^\/sandbox\/records\/(\d+)$/.exec(url.pathname);
    if (record) {
      upstream.recordRequests++;
      if (upstream.expireNextToken) {
        upstream.expireNextToken = false;
        upstream.issued = upstream.issued.filter((token) => token !== bearer);
        return send(401, { error: 'token expired' });
      }
      const found = RECORDS[record[1]];
      if (!found) return send(404, { error: 'not found' });
      return send(200, {
        meta: { count: 1 },
        data: [
          {
            id: Number(record[1]),
            type: 'records',
            attributes: {
              form_id: found.form_id,
              mod_time: '2026-09-01T12:00:00Z',
              ...found.fields,
            },
            links: {},
          },
        ],
      });
    }

    if (url.pathname === `/sandbox/forms/${FORM_ID}/fields`) {
      return send(200, {
        meta: { count: 3 },
        data: [
          {
            id: 101,
            label: 'First Name',
            field_type_id: 1,
            is_required: 1,
            active: 1,
            reference_tag: 'fname',
          },
          {
            id: 150,
            label: 'Case Notes',
            field_type_id: 2,
            is_required: 0,
            active: 1,
            reference_tag: 'notes',
          },
          {
            id: 160,
            label: 'Retired',
            field_type_id: 1,
            is_required: 0,
            active: 0,
            reference_tag: 'old',
          },
        ],
      });
    }

    send(404, { error: 'no route' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

let live: typeof import('@/lib/connectors/apricot-live');
let registry: typeof import('@/lib/connectors/registry');
let importRoute: typeof import('@/app/v1/households/import/route');
let apiKey: string;
let tenantId: string;
const CONNECTION_ID = `live-${Date.now()}`;

beforeAll(async () => {
  await startMock();
  process.env[`${PREFIX}_BASE_URL`] = baseUrl;
  process.env[`${PREFIX}_CLIENT_ID`] = 'test-client';
  process.env[`${PREFIX}_CLIENT_SECRET`] = 'test-secret';
  process.env.API_KEY_PEPPER ??= 'test-pepper-for-connector-live';

  const app = new URL(process.env.POSTGRES_TEST_URL as string);
  app.username = 'nava_api';
  app.password = 'nava_api_test';
  process.env.POSTGRES_URL = app.toString();

  live = await import('@/lib/connectors/apricot-live');
  registry = await import('@/lib/connectors/registry');
  importRoute = await import('@/app/v1/households/import/route');
  const { hashSecret } = await import('@/lib/auth');

  const owner = ownerClient();
  const tenant = await createTenant(owner);
  tenantId = tenant.id;
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  await owner`
    insert into "ApiKey" ("tenantId", "keyId", "secretHash", scopes, label)
    values (${tenant.id}, ${keyId}, ${hashSecret(secret)}, '{*}', 'connector-live test')
  `;
  await owner`
    insert into "Connection"
      ("tenantId", "connectionId", "providerId", "organizationName", "sourceId", "secretRef", mappings)
    values (${tenant.id}, ${CONNECTION_ID}, 'apricot360', 'Test Organization', ${FORM_ID},
      ${`env:${PREFIX}`},
      ${JSON.stringify({ '101': 'firstName', '103': 'lastName', '112': 'postalCode', '127': 'ssn' })}::jsonb)
  `;
  await owner.end();
  apiKey = `nava_${keyId}_${secret}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  live.clearTokenCache();
  upstream.tokenRequests = 0;
  upstream.recordRequests = 0;
  upstream.expireNextToken = false;
});

describe('credential resolution', () => {
  it('reads a prefixed credential set and defaults to the sandbox', () => {
    const credentials = live.resolveCredentials('env:APRICOT_X', {
      APRICOT_X_BASE_URL: 'https://example.org/',
      APRICOT_X_CLIENT_ID: 'id',
      APRICOT_X_CLIENT_SECRET: 'secret',
    });
    expect(credentials).toEqual({
      baseUrl: 'https://example.org',
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    });
  });

  it('refuses anything but an env reference', () => {
    expect(() => live.resolveCredentials('projects/x/secrets/y', {})).toThrow(/Unsupported/);
    expect(() => live.resolveCredentials('env:lower', {})).toThrow(/Unsupported/);
  });

  it('names the missing variables without revealing any value', () => {
    expect(() =>
      live.resolveCredentials('env:APRICOT_X', { APRICOT_X_CLIENT_SECRET: 'do-not-echo' }),
    ).toThrow(/APRICOT_X_BASE_URL/);
    try {
      live.resolveCredentials('env:APRICOT_X', { APRICOT_X_CLIENT_SECRET: 'do-not-echo' });
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo');
    }
  });

  it('refuses plain http to anything but localhost', () => {
    expect(() =>
      live.resolveCredentials('env:APRICOT_X', {
        APRICOT_X_BASE_URL: 'http://apricot.example.org',
        APRICOT_X_CLIENT_ID: 'id',
        APRICOT_X_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/https/);
  });
});

describe('the live client', () => {
  const credentials = () => live.resolveCredentials(`env:${PREFIX}`);

  it('authenticates once and reuses the token', async () => {
    await live.fetchRecord(credentials(), '1001');
    await live.fetchRecord(credentials(), '1001');
    expect(upstream.tokenRequests).toBe(1);
    expect(upstream.recordRequests).toBe(2);
  });

  it('re-authenticates once when a token is rejected', async () => {
    await live.fetchRecord(credentials(), '1001');
    upstream.expireNextToken = true;
    const record = await live.fetchRecord(credentials(), '1001');
    expect(record?.data[0].id).toBe(1001);
    expect(upstream.tokenRequests).toBe(2);
  });

  it('returns null for a record that does not exist or an id that is not numeric', async () => {
    expect(await live.fetchRecord(credentials(), '9999')).toBeNull();
    expect(await live.fetchRecord(credentials(), '../users')).toBeNull();
  });

  it('drops inactive form fields', async () => {
    const fields = await live.fetchFormFields(credentials(), FORM_ID);
    expect(fields.map((field) => field.id)).toEqual([101, 150]);
  });
});

describe('the registry in live mode', () => {
  async function connection() {
    const { withTenant } = await import('@/lib/db');
    return withTenant(tenantId, async (tx) =>
      registry.resolveConnection(tx, CONNECTION_ID),
    ) as Promise<NonNullable<Awaited<ReturnType<typeof registry.resolveConnection>>>>;
  }

  it('labels the schema with reviewed mappings only, never Apricot’s own tag', async () => {
    const row = await connection();
    expect(registry.connectorMode(row)).toBe('live');
    const schema = await registry.connectorSchema(row);
    expect(schema).toEqual([
      { id: 101, label: 'First Name', type: '1', reference_tag: 'firstName' },
      { id: 150, label: 'Case Notes', type: '2', reference_tag: '' },
    ]);
  });

  it('serves the raw record for its own form', async () => {
    const record = await registry.liveRecord(await connection(), '1001');
    expect(record?.data[0].attributes.field_101).toBe('Jordan');
  });

  it('refuses a record from a different form', async () => {
    expect(await registry.liveRecord(await connection(), '2002')).toBeNull();
  });
});

describe('POST /v1/households/import', () => {
  function post(body: unknown, key = apiKey) {
    return importRoute.POST(
      new Request('http://localhost/v1/households/import', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('requires a key', async () => {
    const response = await post({ connectionId: CONNECTION_ID, recordId: '1001' }, 'nope');
    expect(response.status).toBe(401);
  });

  it('imports mapped fields as connector facts and drops the rest', async () => {
    const response = await post({ connectionId: CONNECTION_ID, recordId: '1001' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data?.factsWritten ?? body.factsWritten).toBe(4);
    expect(body.data?.unmappedFieldCount ?? body.unmappedFieldCount).toBe(2);

    const householdId = body.data?.household?.id ?? body.household?.id;
    const owner = ownerClient();
    const facts = await owner`
      select key, source, "sourceDetail", "observedAt" from "Fact"
      where "householdId" = ${householdId} order by key
    `;
    const audit = await owner`
      select details from "AuditEvent"
      where "tenantId" = ${tenantId} and type = 'source_loaded' and outcome = 'found'
    `;
    await owner.end();

    expect(facts.map((fact) => fact.key)).toEqual(['firstName', 'lastName', 'postalCode', 'ssn']);
    for (const fact of facts) {
      expect(fact.source).toBe('connector');
      expect(fact.sourceDetail).toBe(`Apricot 360 form ${FORM_ID}, record 1001`);
      expect(new Date(fact.observedAt).toISOString()).toBe('2026-09-01T12:00:00.000Z');
    }
    // Counts only. The imported values never reach the audit trail.
    expect(JSON.stringify(audit)).not.toMatch(/Jordan|Sample|92501|900-12/);
  });

  it('is a 404 for a record on another form', async () => {
    const response = await post({ connectionId: CONNECTION_ID, recordId: '2002' });
    expect(response.status).toBe(404);
  });

  it('is a 503, not a crash, when the credentials are missing', async () => {
    const saved = process.env[`${PREFIX}_CLIENT_SECRET`];
    delete process.env[`${PREFIX}_CLIENT_SECRET`];
    try {
      const response = await post({ connectionId: CONNECTION_ID, recordId: '1001' });
      expect(response.status).toBe(503);
    } finally {
      process.env[`${PREFIX}_CLIENT_SECRET`] = saved;
    }
  });
});
