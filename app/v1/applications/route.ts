import { recordAudit } from '@/lib/audit';
import { currentFacts } from '@/lib/casegraph/facts';
import { reportGaps } from '@/lib/casegraph/gaps';
import { buildFillPlan, persistPlan } from '@/lib/casegraph/plan';
import { withTenant } from '@/lib/db';
import { application, household } from '@/lib/db/schema';
import { startRun } from '@/lib/eve/client';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { briefForAgent, conservativeDecisions, hintedDecisions } from '@/lib/planner/brief';
import { decideFields, estimateJevCostUsd, jevKey } from '@/lib/planner/jev';
import { allowedPurposeSet } from '@/lib/planner/run';
import { evaluateProbes, resolvePlaybookForProgram } from '@/lib/playbooks/registry';
import { observedControlSchema, proposeRepair, publishRepair } from '@/lib/playbooks/scribe';
import { inputTypeSchema, planWorkflows } from '@/lib/vocabulary';
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
    /**
     * Redacted page inventory. When Jev is configured, the cold path is told
     * which controls to map, ask, or leave before Eve surveys the site.
     */
    inventory: z
      .object({
        page: z.object({ domain: z.string().min(1).max(160) }).strict(),
        fields: z
          .array(
            z
              .object({
                fieldKey: z.string().min(1).max(180),
                type: z.string().max(40),
                label: z.string().max(240),
                question: z.string().max(240),
                required: z.boolean(),
                alreadyFilled: z.boolean(),
                purposeHint: z.string().max(100),
                options: z.array(z.string().max(120)).max(30),
              })
              .strict(),
          )
          .max(80),
        sources: z
          .array(
            z
              .object({
                purpose: z.string().min(1).max(100),
                label: z.string().max(200),
                kind: z.string().max(40),
                sensitive: z.boolean(),
              })
              .strict(),
          )
          .max(80),
      })
      .strict()
      .optional(),
    /**
     * Redacted controls from the page the caller already has open. With
     * `repair: true` on a cold start, the deterministic scribe may publish a
     * tenant playbook and return a warm plan instead of asking for a model.
     * A `value` property is rejected.
     */
    observed: z.array(observedControlSchema).max(80).optional(),
    repair: z.boolean().optional(),
    /** Questions the client still has to answer. Stored as gaps, then shareable. */
    questions: z
      .array(
        z
          .object({
            fieldKey: z.string().min(1).max(180),
            label: z.string().max(200).optional(),
            question: z.string().min(1).max(240),
            required: z.boolean().optional(),
            inputType: inputTypeSchema.optional(),
            options: z.array(z.string().max(120)).max(20).optional(),
          })
          .strict(),
      )
      .max(40)
      .optional(),
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

  let jevBrief = '';
  let jevSummary: { decided: number; deferred: number; apiCostUsd: number } | null = null;
  if (body.inventory && jevKey()) {
    try {
      const pass = await decideFields({
        page: body.inventory.page,
        fields: body.inventory.fields,
        sources: body.inventory.sources,
        allowedPurposes: allowedPurposeSet(),
      });
      if (pass) {
        const decisions = conservativeDecisions(
          hintedDecisions(
            pass.decisions,
            body.inventory.fields,
            body.inventory.sources,
            allowedPurposeSet(),
          ),
          body.inventory.fields,
          body.inventory.sources,
        );
        jevBrief = briefForAgent(decisions, body.inventory.fields);
        const deferred = decisions.filter((item) => item.action === 'uncertain').length;
        jevSummary = {
          decided: decisions.length - deferred,
          deferred,
          apiCostUsd: estimateJevCostUsd(pass.inputTokens),
        };
      }
    } catch {
      jevBrief = '';
    }
  }

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

    let activePlaybook = playbook;
    let activeVerdict = verdict;
    let repairSummary: ReturnType<typeof proposeRepair> | null = null;

    // A cold start can still avoid a model when the caller shows the page and
    // every previous field has one unambiguous control. The shared playbook
    // stays put; the override is this tenant's. This happens before the
    // application row is written so the audit records the path that ran.
    if (!verdict.passed && body.repair && body.observed && playbook) {
      const proposal = proposeRepair(playbook, body.observed);
      repairSummary = proposal;
      if (proposal.publishable) {
        const published = await publishRepair(
          tx,
          auth.tenantId,
          auth.principalId,
          playbook,
          proposal,
        );
        const probeResults = proposal.probes.map((selector) => ({
          selector,
          count: body.observed?.find((control) => control.selector === selector)?.count ?? 0,
        }));
        const repaired = evaluateProbes(published.row, probeResults);
        if (repaired.passed) {
          activePlaybook = published.row;
          activeVerdict = repaired;
        }
      }
    }

    const [row] = await tx
      .insert(application)
      .values({
        tenantId: auth.tenantId,
        householdId: body.householdId,
        programIds: workflow.programIds,
        workflowId: workflow.workflowId,
        name: workflow.name,
        status: 'ready_to_fill',
        playbookId: activePlaybook?.id ?? null,
        playbookVersion: activePlaybook?.version ?? null,
        executionMode: activeVerdict.executionMode,
        location: workflow.url,
        ownerPrincipal: auth.principalId,
      })
      .returning();

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'application_added',
      principalId: auth.principalId,
      applicationId: row.id,
      outcome: activeVerdict.executionMode,
    });

    if (body.questions?.length) {
      await reportGaps(tx, auth.tenantId, row.id, body.questions);
    }

    // --- Warm path: deterministic, no model ---------------------------------
    if (activeVerdict.passed && activePlaybook) {
      const facts = await currentFacts(tx, body.householdId);
      const plan = buildFillPlan(activePlaybook, facts);
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
          jev: jevSummary,
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
          next: repairSummary?.publishable
            ? 'The repair did not clear the freshness check. Retry with agentApiKey to start the agent.'
            : repairSummary
              ? 'The deterministic scribe refused to guess. Retry with agentApiKey, or send a clearer observation to POST /v1/programs/{slug}/playbook/repair.'
              : 'This site needs the agent. Retry with agentApiKey to start it, or with repair and an observation of the page.',
          repair: repairSummary
            ? {
                publishable: repairSummary.publishable,
                refused: repairSummary.refused,
                unresolved: repairSummary.unresolved.length,
                moved: repairSummary.moved.length,
                kept: repairSummary.kept.length,
              }
            : null,
          jev: jevSummary,
          brief: jevBrief || null,
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
        repairSummary && !repairSummary.publishable
          ? `The deterministic scribe already refused this observation: ${repairSummary.refused} Do not guess those fields.`
          : '',
        jevBrief,
      ]
        .filter(Boolean)
        .join('\n'),
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
        jev: jevSummary,
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
