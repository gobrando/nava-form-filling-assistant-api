import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { apiKey, tenant } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Tenant resolution.
 *
 * Machine-to-machine callers (partner products, and the extension's background
 * service worker) present `Authorization: Bearer nava_<keyId>_<secret>`. The
 * secret is never stored — only an HMAC of it, peppered with `API_KEY_PEPPER`,
 * so a database disclosure does not yield usable keys.
 *
 * The next step is GCP Identity Platform tenants with
 * per-tenant SAML/OIDC and discovery by email domain. That replaces this
 * function's body, not its signature: everything downstream depends only on
 * `AuthContext`, and `tenantId` is what drives row-level security.
 */

export type AuthContext = {
  tenantId: string;
  tenantSlug: string;
  /** Opaque, non-PII identifier for the acting principal. Safe to write to audit. */
  principalId: string;
  scopes: string[];
};

const KEY_PATTERN = /^nava_([A-Za-z0-9]{8,32})_([A-Za-z0-9_-]{16,128})$/;

export function hashSecret(secret: string): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) throw new Error('API_KEY_PEPPER is not set.');
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Returns the authenticated tenant, or `null`.
 *
 * Callers must translate `null` into a generic 401 — never into a message that
 * distinguishes "no such key" from "wrong secret" from "revoked", since that
 * distinction is an oracle.
 */
export async function authenticate(request: Request): Promise<AuthContext | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const match = KEY_PATTERN.exec(header.slice('Bearer '.length).trim());
  if (!match) return null;
  const [, keyId, secret] = match;

  const rows = await db
    .select({
      tenantId: apiKey.tenantId,
      secretHash: apiKey.secretHash,
      scopes: apiKey.scopes,
      revokedAt: apiKey.revokedAt,
      tenantSlug: tenant.slug,
      tenantDisabledAt: tenant.disabledAt,
    })
    .from(apiKey)
    .innerJoin(tenant, eq(tenant.id, apiKey.tenantId))
    .where(eq(apiKey.keyId, keyId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt || row.tenantDisabledAt) return null;
  if (!constantTimeEquals(row.secretHash, hashSecret(secret))) return null;

  return {
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    principalId: `key:${keyId}`,
    scopes: row.scopes ?? [],
  };
}

export function hasScope(auth: AuthContext, scope: string): boolean {
  return auth.scopes.includes(scope) || auth.scopes.includes('*');
}

// ---------------------------------------------------------------------------
// Organization sessions (the connector path)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'nava_org_session';

/**
 * The extension's `connectorRequest` sends `credentials: 'include'` and no
 * Authorization header — it authenticates as the signed-in organization using
 * browser session cookies, per the connector contract. So the connector
 * endpoints accept a session cookie as well as a Bearer key.
 *
 * This is a signed-cookie placeholder, deliberately minimal. The real
 * mechanism is GCP Identity Platform tenants, each holding its own SAML
 * or OIDC provider, with tenant discovery by email domain — Riverside on
 * Microsoft Entra, Orange County on something else. That replaces
 * `verifySessionCookie` below; `AuthContext` and every call site stay as they
 * are.
 */
export function signSessionCookie(tenantSlug: string, principalId: string): string {
  const payload = `${tenantSlug}:${principalId}:${Date.now()}`;
  const signature = createHmac('sha256', requirePepper()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

function requirePepper(): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) throw new Error('API_KEY_PEPPER is not set.');
  return pepper;
}

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function verifySessionCookie(value: string): { tenantSlug: string; principalId: string } | null {
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = createHmac('sha256', requirePepper()).update(payload).digest('base64url');
  if (!constantTimeEquals(expected, signature)) return null;

  const [tenantSlug, principalId, issuedAt] = payload.split(':');
  if (!tenantSlug || !principalId || !issuedAt) return null;
  if (Date.now() - Number(issuedAt) > SESSION_MAX_AGE_MS) return null;

  return { tenantSlug, principalId };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Resolves the acting organization for a connector request: session cookie
 * first (the extension), Bearer key second (machine callers and tests).
 */
export async function authenticateOrganization(request: Request): Promise<AuthContext | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) {
    const session = verifySessionCookie(cookie);
    if (session) {
      const rows = await db
        .select({ id: tenant.id, slug: tenant.slug, disabledAt: tenant.disabledAt })
        .from(tenant)
        .where(eq(tenant.slug, session.tenantSlug))
        .limit(1);
      const row = rows[0];
      if (row && !row.disabledAt) {
        return {
          tenantId: row.id,
          tenantSlug: row.slug,
          principalId: session.principalId,
          scopes: ['connector:read'],
        };
      }
    }
  }

  return authenticate(request);
}

export { SESSION_COOKIE };
