/**
 * Live Apricot 360 reads.
 *
 * The protocol is the one labs-asp already runs against Bonterra's sandbox
 * (`client/lib/apricot-api.ts`): OAuth client credentials, a `sandbox` or `api`
 * path prefix, a cached bearer token, and one retry on 401. It is read-only on
 * purpose. Nava's integration has never written to Apricot and Apricot is the
 * organization's system of record; a write path is a separate decision for the
 * data owner, not something a connector grows by default.
 *
 * Credentials never live in the database. `Connection.secretRef` names where
 * to find them:
 *
 *   env:APRICOT_RIVERSIDE  ->  APRICOT_RIVERSIDE_BASE_URL
 *                              APRICOT_RIVERSIDE_CLIENT_ID
 *                              APRICOT_RIVERSIDE_CLIENT_SECRET
 *                              APRICOT_RIVERSIDE_ENVIRONMENT   (sandbox | api)
 *
 * On Cloud Run those env vars are Secret Manager references, so the secret is
 * still managed centrally; the prefix just keeps one tenant's credentials from
 * ever being used for another's connection.
 */

export type ApricotCredentials = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'api';
};

export type ApricotFormField = {
  id: number;
  label: string;
  field_type_id: number;
  is_required: number;
  active: number;
  reference_tag: string;
  field_options?: { value: string; sort_order: number }[];
};

export type ApricotLiveRecord = {
  meta?: { count: number };
  data: {
    id: number;
    type: string;
    attributes: { form_id: number; mod_time: string; [key: string]: unknown };
    links?: Record<string, unknown>;
  }[];
};

export class ConnectorCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorCredentialsError';
  }
}

export class ConnectorUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConnectorUpstreamError';
  }
}

const PREFIX_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const REQUEST_TIMEOUT_MS = 10_000;

export function resolveCredentials(
  secretRef: string,
  env: Record<string, string | undefined> = process.env,
): ApricotCredentials {
  const [scheme, prefix] = secretRef.split(':', 2);
  if (scheme !== 'env' || !prefix || !PREFIX_PATTERN.test(prefix)) {
    throw new ConnectorCredentialsError(
      `Unsupported secretRef. Use "env:<PREFIX>" with an upper-case prefix, e.g. "env:APRICOT_RIVERSIDE".`,
    );
  }
  const baseUrl = env[`${prefix}_BASE_URL`];
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  const environment = env[`${prefix}_ENVIRONMENT`] ?? 'sandbox';
  if (!baseUrl || !clientId || !clientSecret) {
    throw new ConnectorCredentialsError(
      `Credentials for ${prefix} are not configured. Set ${prefix}_BASE_URL, ${prefix}_CLIENT_ID, and ${prefix}_CLIENT_SECRET.`,
    );
  }
  if (environment !== 'sandbox' && environment !== 'api') {
    throw new ConnectorCredentialsError(`${prefix}_ENVIRONMENT must be "sandbox" or "api".`);
  }
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new ConnectorCredentialsError(`${prefix}_BASE_URL must use https.`);
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), clientId, clientSecret, environment };
}

// Keyed by the credential set, so two connections never share a token.
const tokens = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(credentials: ApricotCredentials): string {
  return `${credentials.baseUrl}|${credentials.environment}|${credentials.clientId}`;
}

export function clearTokenCache(): void {
  tokens.clear();
}

async function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function token(credentials: ApricotCredentials): Promise<string> {
  const key = cacheKey(credentials);
  const cached = tokens.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const response = await request(`${credentials.baseUrl}/${credentials.environment}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });
  if (!response.ok) {
    // The body is not echoed: an auth error page can carry the client id.
    throw new ConnectorUpstreamError(
      `Apricot authentication failed (${response.status}).`,
      response.status,
    );
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new ConnectorUpstreamError('Apricot returned no access token.', 502);
  }
  // A minute of margin so a token is never used in its last seconds.
  const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000;
  tokens.set(key, { token: body.access_token, expiresAt });
  return body.access_token;
}

async function get<T>(credentials: ApricotCredentials, path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const bearer = await token(credentials);
    const response = await request(`${credentials.baseUrl}/${credentials.environment}${path}`, {
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
    });
    if (response.status === 401 && attempt === 0) {
      tokens.delete(cacheKey(credentials));
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ConnectorUpstreamError(
        `Apricot request failed (${response.status}).`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
  throw new ConnectorUpstreamError('Apricot rejected a freshly issued token.', 401);
}

export async function fetchFormFields(
  credentials: ApricotCredentials,
  formId: string,
): Promise<ApricotFormField[]> {
  const body = await get<{ data: ApricotFormField[] }>(
    credentials,
    `/forms/${encodeURIComponent(formId)}/fields`,
  );
  return (body?.data ?? []).filter((field) => field.active !== 0);
}

export async function fetchRecord(
  credentials: ApricotCredentials,
  recordId: string,
): Promise<ApricotLiveRecord | null> {
  if (!/^\d{1,12}$/.test(recordId)) return null;
  const body = await get<ApricotLiveRecord>(credentials, `/records/${recordId}`);
  if (!body?.data?.length) return null;
  return body;
}
