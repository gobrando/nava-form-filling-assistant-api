import { recordAudit } from '@/lib/audit';
import { authenticateOrganization } from '@/lib/auth';
import {
  AdapterUnavailableError,
  ConnectorCredentialsError,
  connectorRecord,
  isKnownSourceId,
  resolveConnection,
} from '@/lib/connectors/registry';
import { withTenant } from '@/lib/db';
import { fail, logFailure, okRaw, preflight, traceId } from '@/lib/http';
import { RECORD_LOOKUP_LIMIT, RECORD_LOOKUP_WINDOW_MS, rateLimit } from '@/lib/ratelimit';

/**
 * GET /v1/connectors/{connectionId}/records/{recordId}?sourceId={sourceId}
 *
 * The one endpoint that returns participant data, so it carries the rate limit
 * and writes the audit event the contract requires: organization, user,
 * connection, record ID, outcome, timestamp — and no values.
 *
 * The response body is the provider's own record shape, unwrapped, matching
 * `mock-server.mjs`.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; recordId: string }> },
) {
  const origin = request.headers.get('origin');
  const auth = await authenticateOrganization(request);
  if (!auth) return fail(401, 'Not authorized.', { origin });

  const { connectionId, recordId } = await params;
  const url = new URL(request.url);
  const sourceId = url.searchParams.get('sourceId') ?? url.searchParams.get('formId');

  const verdict = rateLimit(
    `record:${auth.tenantId}:${auth.principalId}`,
    RECORD_LOOKUP_LIMIT,
    RECORD_LOOKUP_WINDOW_MS,
  );
  if (!verdict.allowed) {
    const response = fail(429, 'Too many lookups. Try again shortly.', { origin });
    response.headers.set('Retry-After', String(verdict.retryAfterSeconds));
    return response;
  }

  return withTenant(auth.tenantId, async (tx) => {
    const row = await resolveConnection(tx, connectionId);
    if (!row) return fail(404, 'Connector not found.', { origin });
    if (!isKnownSourceId(row, sourceId)) return fail(404, 'Source not found.', { origin });

    try {
      const record = await connectorRecord(tx, row, recordId);

      await recordAudit(tx, {
        tenantId: auth.tenantId,
        type: 'source_loaded',
        principalId: auth.principalId,
        connectionId: row.connectionId,
        recordId,
        outcome: record ? 'found' : 'not_found',
        details: { fieldCount: record ? Object.keys(record.data[0].attributes).length : 0 },
      });

      if (!record) return fail(404, 'Record not found.', { origin });
      return okRaw(record, { origin });
    } catch (error) {
      if (error instanceof AdapterUnavailableError) {
        return fail(501, error.message, { origin });
      }
      if (error instanceof ConnectorCredentialsError) {
        // Names an env var prefix at most, never a credential value.
        return fail(503, error.message, { origin });
      }
      const id = traceId();
      // The caught error may carry a provider response body, so it is never
      // logged — only the fact of failure and non-participant context.
      logFailure(id, 'connector record lookup failed', {
        connectionId,
        providerId: row.providerId,
      });
      return fail(502, 'The connector could not be read.', { origin, traceId: id });
    }
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
