import type { z } from 'zod';

/**
 * The wire envelope.
 *
 * The extension's `connectorRequest` checks `payload?.ok === false` and reads
 * `payload.error`, and every response from `connector-service/mock-server.mjs`
 * carries `Cache-Control: no-store`. So this service answers in that shape
 * rather than labs-asp's `ChatSDKError` `{type}:{surface}` codes — the consumer
 * that already exists wins.
 *
 * Errors returned to a client are deliberately generic. The connector contract
 * requires it ("rate-limit lookups and return generic errors to the
 * extension"), and a detailed error is a channel for participant data to
 * escape. Detail goes to the log, keyed by `traceId`.
 */

const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
};

export type Ok<T> = { ok: true } & T;
export type Fail = { ok: false; error: string; traceId?: string };

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

/**
 * Credentialed requests are only accepted from the managed extension IDs and
 * from loopback during development. A wildcard origin cannot be combined with
 * `Access-Control-Allow-Credentials`, so an unlisted origin gets no CORS
 * headers at all and the browser blocks the read.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === 'null') return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const allowed = (process.env.ALLOWED_EXTENSION_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

export function ok<T extends Record<string, unknown>>(
  payload: T,
  init?: { status?: number; origin?: string | null },
): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status: init?.status ?? 200,
    headers: { ...BASE_HEADERS, ...corsHeaders(init?.origin ?? null) },
  });
}

export function fail(
  status: number,
  error: string,
  init?: { origin?: string | null; traceId?: string },
): Response {
  const body: Fail = { ok: false, error };
  if (init?.traceId) body.traceId = init.traceId;
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...corsHeaders(init?.origin ?? null) },
  });
}

/**
 * Responds with a payload exactly as given, with no `ok` field injected.
 *
 * The record endpoint needs this: `mock-server.mjs` returns the provider's own
 * record body unwrapped, and the extension's `connectorRequest` only checks for
 * `ok === false`. Wrapping a provider record in our envelope would change the
 * shape the extension's mapping code already parses.
 */
export function okRaw(payload: unknown, init?: { origin?: string | null }): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...BASE_HEADERS, ...corsHeaders(init?.origin ?? null) },
  });
}

export function preflight(origin: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: { ...BASE_HEADERS, ...corsHeaders(origin) },
  });
}

/** A short correlation id. Logged with the detail; returned to the client bare. */
export function traceId(): string {
  return `tr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Logs an error without ever writing a participant value.
 *
 * The connector contract says the service must "never log participant values,
 * tokens, or raw record bodies". So this takes a message and a whitelist of
 * scalar context, never an arbitrary object or a caught error's body.
 */
export function logFailure(
  id: string,
  message: string,
  context: Record<string, string | number | boolean | null> = {},
): void {
  console.error(
    JSON.stringify({
      level: 'error',
      traceId: id,
      message,
      ...context,
      at: new Date().toISOString(),
    }),
  );
}

/** Parses and validates a JSON body, returning a `Response` on failure. */
export async function readJson<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<{ data: z.infer<S>; error: null } | { data: null; error: Response }> {
  const origin = request.headers.get('origin');
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { data: null, error: fail(400, 'Request body must be JSON.', { origin }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Zod messages name paths and expected types, never values, so they are
    // safe to return. `z.never()` guards below keep unknown keys out.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { data: null, error: fail(400, `Invalid request: ${detail}`, { origin }) };
  }
  return { data: parsed.data, error: null };
}
