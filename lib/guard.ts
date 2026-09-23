import { type AuthContext, authenticate } from '@/lib/auth';
import { fail } from '@/lib/http';
import { GENERAL_LIMIT, GENERAL_WINDOW_MS, rateLimit } from '@/lib/ratelimit';

/**
 * The common preamble for a partner-facing endpoint: authenticate, rate-limit,
 * and fail generically.
 *
 * Connector endpoints do not use this — they accept an organization session
 * cookie as well as a Bearer key, and their record lookup has its own tighter
 * budget.
 */
export async function guard(
  request: Request,
): Promise<{ auth: AuthContext; response: null } | { auth: null; response: Response }> {
  const origin = request.headers.get('origin');

  const auth = await authenticate(request);
  if (!auth) {
    // Never distinguish unknown key from bad secret from revoked: the
    // difference is an oracle.
    return { auth: null, response: fail(401, 'Not authorized.', { origin }) };
  }

  const verdict = rateLimit(`api:${auth.tenantId}`, GENERAL_LIMIT, GENERAL_WINDOW_MS);
  if (!verdict.allowed) {
    const response = fail(429, 'Too many requests. Try again shortly.', { origin });
    response.headers.set('Retry-After', String(verdict.retryAfterSeconds));
    return { auth: null, response };
  }

  return { auth, response: null };
}
