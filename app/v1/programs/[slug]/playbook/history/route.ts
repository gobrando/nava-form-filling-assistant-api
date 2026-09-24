import { withTenant } from '@/lib/db';
import { guard } from '@/lib/guard';
import { fail, ok, preflight } from '@/lib/http';
import { listPlaybookHistory } from '@/lib/playbooks/history';
import { programDefinition } from '@/lib/vocabulary';

/**
 * GET /v1/programs/{slug}/playbook/history
 *
 * Shared versions and this tenant's overrides. Another tenant's rows are
 * absent. The body is counts and field keys, including whether a version was
 * published by the deterministic scribe.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { slug } = await params;
  const program = programDefinition(slug);
  if (!program) return fail(404, 'Program not found.', { origin });

  return withTenant(auth.tenantId, async (tx) => {
    const history = await listPlaybookHistory(tx, auth.tenantId, slug);
    return ok({ program, history }, { origin });
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
