import { withTenant } from '@/lib/db';
import { guard } from '@/lib/guard';
import { ok, preflight } from '@/lib/http';
import { resolvePlaybookForProgram } from '@/lib/playbooks/registry';
import { PROGRAMS, PROVIDER_CATALOG } from '@/lib/vocabulary';

/**
 * GET /v1/programs
 *
 * The program catalog, annotated with whether a playbook exists and whether it
 * is stale — which is what a partner needs to know before starting a run, since
 * a program with no playbook will take the expensive path.
 *
 * `workflowId` is the grouping that matters: BenefitsCal serves CalFresh,
 * Medi-Cal, and CalWORKs from one application, so selecting all three is one
 * run rather than three.
 */
export async function GET(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  return withTenant(auth.tenantId, async (tx) => {
    const programs = await Promise.all(
      PROGRAMS.map(async (program) => {
        const row = await resolvePlaybookForProgram(tx, auth.tenantId, program.id);
        return {
          ...program,
          playbook: row ? { id: row.id, version: row.version, stale: row.staleAt !== null } : null,
          // Without a playbook every page is a cold read, so the caller should
          // expect model-driven execution and its cost.
          expectedExecutionMode: row && !row.staleAt ? 'script' : 'model',
        };
      }),
    );

    return ok({ programs, providers: PROVIDER_CATALOG }, { origin });
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
