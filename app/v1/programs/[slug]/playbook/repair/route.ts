import { withTenant } from '@/lib/db';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { publicPlaybook, resolvePlaybookForProgram } from '@/lib/playbooks/registry';
import { observedControlSchema, proposeRepair, publishRepair } from '@/lib/playbooks/scribe';
import { programDefinition } from '@/lib/vocabulary';
import { z } from 'zod';

/**
 * POST /v1/programs/{slug}/playbook/repair
 *
 * The caller has the page open and reports what is on it: selectors, labels,
 * counts. No values. The deterministic scribe either publishes a tenant
 * playbook the next warm run can trust, or it refuses and names the fields it
 * would not guess.
 *
 * `publish: false` (the default) is a dry run. Publishing does not edit the
 * shared playbook, and it does not start a model.
 */

const bodySchema = z
  .object({
    observed: z.array(observedControlSchema).max(80),
    publish: z.boolean().optional(),
  })
  .strict();

function proposalBody(proposal: ReturnType<typeof proposeRepair>) {
  return {
    publishable: proposal.publishable,
    refused: proposal.refused,
    kept: proposal.kept,
    moved: proposal.moved,
    unresolved: proposal.unresolved,
    unmapped: proposal.unmapped,
    probes: proposal.probes,
    fieldMap: proposal.fieldMap,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { slug } = await params;
  if (!programDefinition(slug)) return fail(404, 'Program not found.', { origin });

  const parsed = await readJson(request, bodySchema);
  if (parsed.error) return parsed.error;

  return withTenant(auth.tenantId, async (tx) => {
    const previous = await resolvePlaybookForProgram(tx, auth.tenantId, slug);
    if (!previous) return fail(404, 'No playbook for this program.', { origin });

    const proposal = proposeRepair(previous, parsed.data.observed);
    if (!parsed.data.publish) {
      return ok({ proposal: proposalBody(proposal), published: null }, { origin });
    }
    if (!proposal.publishable) {
      return fail(409, proposal.refused ?? 'This repair is not safe to publish.', { origin });
    }

    const { row, alreadyCurrent } = await publishRepair(
      tx,
      auth.tenantId,
      auth.principalId,
      previous,
      proposal,
    );

    return ok(
      {
        proposal: proposalBody(proposal),
        published: publicPlaybook(row),
        alreadyCurrent,
      },
      { status: 201, origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
