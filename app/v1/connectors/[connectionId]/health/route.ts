import { authenticateOrganization } from '@/lib/auth';
import { connectorHealth, resolveConnection } from '@/lib/connectors/registry';
import { withTenant } from '@/lib/db';
import { fail, ok, preflight } from '@/lib/http';

/**
 * GET /v1/connectors/{connectionId}/health
 *
 * Contract: `connector-service/README.md`. The extension calls this when an
 * administrator saves a connection and again before a lookup, so it must stay
 * cheap and must not touch the provider.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const origin = request.headers.get('origin');
  const auth = await authenticateOrganization(request);
  if (!auth) return fail(401, 'Not authorized.', { origin });

  const { connectionId } = await params;

  return withTenant(auth.tenantId, async (tx) => {
    const row = await resolveConnection(tx, connectionId);
    // Row-level security already scoped this read to the tenant, so a
    // connection belonging to another organization is indistinguishable from
    // one that does not exist. That is the intended answer.
    if (!row) return fail(404, 'Connector not found.', { origin });
    return ok(connectorHealth(row), { origin });
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
