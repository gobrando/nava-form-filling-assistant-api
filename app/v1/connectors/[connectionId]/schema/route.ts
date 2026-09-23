import { authenticateOrganization } from '@/lib/auth';
import {
  AdapterUnavailableError,
  ConnectorCredentialsError,
  connectorSchema,
  isKnownSourceId,
  resolveConnection,
} from '@/lib/connectors/registry';
import { withTenant } from '@/lib/db';
import { fail, logFailure, ok, preflight, traceId } from '@/lib/http';

/**
 * GET /v1/connectors/{connectionId}/schema?sourceId={sourceId}
 *
 * Returns labeled fields so an administrator can review the mapping before any
 * record is read. `formId` is accepted as the legacy alias the fictional
 * Apricot adapter also took.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const origin = request.headers.get('origin');
  const auth = await authenticateOrganization(request);
  if (!auth) return fail(401, 'Not authorized.', { origin });

  const { connectionId } = await params;
  const url = new URL(request.url);
  const sourceId = url.searchParams.get('sourceId') ?? url.searchParams.get('formId');

  return withTenant(auth.tenantId, async (tx) => {
    const row = await resolveConnection(tx, connectionId);
    if (!row) return fail(404, 'Connector not found.', { origin });
    if (!isKnownSourceId(row, sourceId)) return fail(404, 'Source not found.', { origin });

    try {
      return ok({ fields: await connectorSchema(row) }, { origin });
    } catch (error) {
      if (error instanceof AdapterUnavailableError) {
        // Safe to return verbatim: it names a provider and a process, never a
        // participant or a credential.
        return fail(501, error.message, { origin });
      }
      if (error instanceof ConnectorCredentialsError) {
        // Names an env var prefix at most, never a credential value.
        return fail(503, error.message, { origin });
      }
      const id = traceId();
      logFailure(id, 'connector schema failed', {
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
