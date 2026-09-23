import { recordAudit } from '@/lib/audit';
import { currentFacts } from '@/lib/casegraph/facts';
import { buildFillPlan, persistPlan } from '@/lib/casegraph/plan';
import { withTenant } from '@/lib/db';
import { application, household } from '@/lib/db/schema';
import { startRun } from '@/lib/eve/client';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { evaluateProbes, resolvePlaybookForProgram } from '@/lib/playbooks/registry';
import { planWorkflows } from '@/lib/vocabulary';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/applications
 *
 * Starts a run and picks its path.
 *
 * A playbook whose freshness probes all resolved means the work is a join
 * between a field map and the facts ledger, so it is computed here and returned
 * as a plan for the caller to execute — `executionMode: 'script'`, no model,
 * one pass. Anything else starts the Eve agent — `executionMode: 'model'`.
 *
 * The caller reports probe results because the caller is the one with the page
 * open. That is not a workaround: the Chrome extension holds the participant's
 * authenticated session on the county site, and the only honest way to know
 * whether a selector still resolves is to ask the browser that can see it.
 */
const postSchema = z
  .object({
    householdId: z.string().uuid(),
    programIds: z.array(z.string().min(1).max(100)).min(1).max(10),
    probeResults: z
      .array(z.object({ selector: z.string().min(1).max(500), count: z.number().int().min(0) }))
      .max(100)
      .optional(),
    /** Required to start a cold run: the agent channel needs a credential. */
    agentApiKey: z.string().min(16).max(256).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const workflows = planWorkflows(body.programIds);
  if (workflows.length === 0) return fail(400, 'No known programs were selected.', { origin });
  if (workflows.length > 1) {
    // Deliberately refused rather than silently fanned out. BenefitsCal serves
    // three programs from one application; two different sites are two runs,
    // and the caller should decide their order and their leases.
    return fail(
      400,
      'These programs are served by different sites. Start one application per site.',
      { origin },
    );
  }
  const workflow = workflows[0];

  return withTenant(auth.tenantId, async (tx) => {
    const found = await tx
      .select({ id: household.id })
      .from(household)
      .where(eq(household.id, body.householdId))
      .limit(1);
    if (!found[0]) return fail(404, 'Household not found.', { origin });

    const playbook = await resolvePlaybookForProgram(tx, auth.tenantId, workflow.programIds[0]);
    const verdict =
      playbook && body.probeResults
        ? evaluateProbes(playbook, body.probeResults)
        : {
            passed: false,
            missing: [],
            executionMode: 'model' as const,
            reason: playbook
              ? 'No probe results were reported, so freshness is unknown.'
              : 'No playbook for this site.',
          };

    const [row] = await tx
      .insert(application)
      .values({
        tenantId: auth.tenantId,
        householdId: body.householdId,
        programIds: workflow.programIds,
        workflowId: workflow.workflowId,
        name: workflow.name,
        status: 'ready_to_fill',
        playbookId: playbook?.id ?? null,
        playbookVersion: playbook?.version ?? null,
        executionMode: verdict.executionMode,
        location: workflow.url,
        ownerPrincipal: auth.principalId,
      })
      .returning();

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'application_added',
      principalId: auth.principalId,
      applicationId: row.id,
      outcome: verdict.executionMode,
    });

    // --- Warm path: deterministic, no model ---------------------------------
    if (verdict.passed && playbook) {
      const facts = await currentFacts(tx, body.householdId);
      const plan = buildFillPlan(playbook, facts);
      await persistPlan(tx, auth.tenantId, row.id, plan);

      await recordAudit(tx, {
        tenantId: auth.tenantId,
        type: 'fill_started',
        principalId: auth.principalId,
        applicationId: row.id,
        outcome: 'script',
        details: { fieldCount: plan.writes.length, gapCount: plan.gaps.length },
      });

      return ok(
        {
          application: {
            id: row.id,
            name: row.name,
            status: row.status,
            executionMode: 'script',
            url: workflow.url,
            allowedOrigins: workflow.allowedOrigins,
            allowedPathPrefixes: workflow.allowedPathPrefixes,
          },
          plan: {
            playbookId: plan.playbookId,
            playbookVersion: plan.playbookVersion,
            writes: plan.writes,
            staleUsed: plan.staleUsed,
          },
          gapCount: plan.gaps.length,
          // Said explicitly because the plan is an intention, not an outcome.
          next: 'Execute the plan, then report readbacks to POST /v1/applications/{id}/fields.',
        },
        { status: 201, origin },
      );
    }

    // --- Cold path: the agent ----------------------------------------------
    if (!body.agentApiKey) {
      // The run is recorded either way. Returning 202 with the reason lets the
      // caller retry with a key without losing the application row, which is
      // already linked to audit events.
      return ok(
        {
          application: {
            id: row.id,
            name: row.name,
            status: row.status,
            executionMode: 'model',
            url: workflow.url,
          },
          started: false,
          reason: verdict.reason,
          next: 'This site needs the agent. Retry with agentApiKey to start it.',
        },
        { status: 202, origin },
      );
    }

    const started = await startRun({
      message: [
        `Complete the ${workflow.name} application at ${workflow.url}.`,
        `Application id ${row.id}. Household id ${body.householdId}.`,
        verdict.reason,
        playbook
          ? `A playbook exists at version ${playbook.version} but is not fresh. Confirm its field map rather than rebuilding it, and note which selectors moved.`
          : 'There is no playbook for this site. Survey it, then have the scribe write one.',
      ].join('\n'),
      apiKey: body.agentApiKey,
      tenantId: auth.tenantId,
      applicationId: row.id,
      householdId: body.householdId,
      executionTier: 'cold',
    });

    if ('error' in started) {
      await tx
        .update(application)
        .set({ status: 'needs_attention', interventionReason: 'site_drift' })
        .where(eq(application.id, row.id));
      return fail(502, started.error, { origin });
    }

    await tx
      .update(application)
      .set({ eveSessionId: started.sessionId, updatedAt: new Date() })
      .where(eq(application.id, row.id));

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'fill_started',
      principalId: auth.principalId,
      applicationId: row.id,
      outcome: 'model',
    });

    return ok(
      {
        application: {
          id: row.id,
          name: row.name,
          status: row.status,
          executionMode: 'model',
          url: workflow.url,
        },
        started: true,
        sessionId: started.sessionId,
        reason: verdict.reason,
        next: `Follow GET /v1/applications/${row.id}/events.`,
      },
      { status: 202, origin },
    );
  });
}

/** GET /v1/applications — the work queue, most recently updated first. */
export async function GET(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  return withTenant(auth.tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: application.id,
        householdId: application.householdId,
        name: application.name,
        programIds: application.programIds,
        status: application.status,
        checkpointKind: application.checkpointKind,
        executionMode: application.executionMode,
        interventionReason: application.interventionReason,
        leaseHolder: application.leaseHolder,
        leaseExpiresAt: application.leaseExpiresAt,
        handoffToPrincipal: application.handoffToPrincipal,
        submittedAt: application.submittedAt,
        updatedAt: application.updatedAt,
      })
      .from(application)
      .orderBy(desc(application.updatedAt))
      .limit(100);

    return ok({ applications: rows }, { origin });
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
