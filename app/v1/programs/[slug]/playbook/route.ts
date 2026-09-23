import { withTenant } from '@/lib/db';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import {
  evaluateProbes,
  markStale,
  publicPlaybook,
  resolvePlaybookForProgram,
} from '@/lib/playbooks/registry';
import { programDefinition } from '@/lib/vocabulary';
import { z } from 'zod';

/**
 * GET  /v1/programs/{slug}/playbook  fetch probes, field map, advance rules
 * POST /v1/programs/{slug}/playbook  report probe results, get the routing verdict
 *
 * These selectors are hardcoded in the extension bundle today (`PLAYBOOKS` in
 * `content/form-agent.js`), which means a BenefitsCal change needs a Chrome Web
 * Store release before a caseworker can run again. Serving them makes a site
 * change a data update.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { slug } = await params;
  const program = programDefinition(slug);
  if (!program) return fail(404, 'Program not found.', { origin });

  return withTenant(auth.tenantId, async (tx) => {
    const row = await resolvePlaybookForProgram(tx, auth.tenantId, slug);
    if (!row) {
      // Not an error. A cold site is a supported case; it is just expensive,
      // and the caller deserves to know that before it starts.
      return ok({ program, playbook: null, expectedExecutionMode: 'model' }, { origin });
    }

    return ok(
      {
        program,
        playbook: publicPlaybook(row),
        expectedExecutionMode: row.staleAt ? 'model' : 'script',
      },
      { origin },
    );
  });
}

const probeReportSchema = z
  .object({
    probeResults: z
      .array(z.object({ selector: z.string().min(1).max(500), count: z.number().int().min(0) }))
      .max(100),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { slug } = await params;
  if (!programDefinition(slug)) return fail(404, 'Program not found.', { origin });

  const parsed = await readJson(request, probeReportSchema);
  if (parsed.error) return parsed.error;

  return withTenant(auth.tenantId, async (tx) => {
    const row = await resolvePlaybookForProgram(tx, auth.tenantId, slug);
    if (!row) return fail(404, 'No playbook for this program.', { origin });

    const verdict = evaluateProbes(row, parsed.data.probeResults);

    // Marking stale is what wakes the scribe. Do it once, on the transition,
    // so a repeated failing report does not keep rewriting the reason.
    if (!verdict.passed && !row.staleAt) {
      await markStale(tx, row.id, verdict.reason);
    }

    return ok(
      {
        playbookId: row.id,
        version: row.version,
        passed: verdict.passed,
        missing: verdict.missing,
        executionMode: verdict.executionMode,
        reason: verdict.reason,
        scribeQueued: !verdict.passed,
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
