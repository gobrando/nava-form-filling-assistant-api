import { recordAudit } from '@/lib/audit';
import { allGaps, answerGaps, openGaps } from '@/lib/casegraph/gaps';
import { factValueSchema } from '@/lib/casegraph/schemas';
import { withTenant } from '@/lib/db';
import { application } from '@/lib/db/schema';
import { continueRun } from '@/lib/eve/client';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { labelFor } from '@/lib/vocabulary';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * The BLOCKED translation, as an endpoint.
 *
 * GET  returns the open questions. POST answers them.
 *
 * The multi-application design has the orchestrator own all user I/O, and a
 * fill agent that needs data stops and returns a BLOCKED report for the
 * orchestrator to ask about. There is no user on an API. This endpoint is the
 * human — the partner's caseworker answers through it, and the run resumes on
 * the same Eve session using its continuation token, so the agent does not
 * re-read the form from a cold context.
 *
 * Every answer becomes a `Fact` sourced `caseworker` or `participant`, so an
 * answered gap has provenance exactly like a connector value does. That is what
 * keeps the protected fields honest: they are unfillable by inference and
 * fillable by a person, and the packet can tell which happened.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const includeAnswered = new URL(request.url).searchParams.get('all') === 'true';

  return withTenant(auth.tenantId, async (tx) => {
    const apps = await tx
      .select({ id: application.id })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    if (!apps[0]) return fail(404, 'Application not found.', { origin });

    const rows = includeAnswered ? await allGaps(tx, id) : await openGaps(tx, id);

    return ok(
      {
        gaps: rows.map((row) => ({
          id: row.id,
          fieldKey: row.fieldKey,
          label: row.label,
          purpose: row.purpose,
          question: row.question,
          // 'decision' means a human's judgment is the point, not that the
          // lookup failed. Protected fields and option choices land here.
          kind: row.kind,
          required: row.required,
          inputType: row.inputType,
          options: row.options,
          answered: row.answeredAt !== null,
        })),
      },
      { origin },
    );
  });
}

const postSchema = z
  .object({
    answers: z
      .array(
        z.object({
          gapId: z.string().uuid(),
          value: factValueSchema,
          /** Who said so. A gap answer without an answerer has no provenance. */
          source: z.enum(['caseworker', 'participant']),
          answeredBy: z.string().min(1).max(200),
          note: z.string().max(500).optional(),
        }),
      )
      .min(1)
      .max(100),
    /** Supply to resume a cold run in place rather than starting over. */
    agentApiKey: z.string().min(16).max(256).optional(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  return withTenant(auth.tenantId, async (tx) => {
    const apps = await tx
      .select({
        id: application.id,
        householdId: application.householdId,
        submittedAt: application.submittedAt,
        eveSessionId: application.eveSessionId,
        eveContinuationToken: application.eveContinuationToken,
      })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    const app = apps[0];
    if (!app) return fail(404, 'Application not found.', { origin });
    if (app.submittedAt) {
      return fail(409, 'This application is already recorded as submitted.', { origin });
    }

    const { answered, unknown, invalid, writes } = await answerGaps(
      tx,
      { tenantId: auth.tenantId, applicationId: id, householdId: app.householdId },
      body.answers,
    );

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'questions_required',
      principalId: auth.principalId,
      applicationId: id,
      outcome: answered.length > 0 ? 'answered' : 'rejected',
      details: { gapCount: answered.length, blockedCount: invalid.length },
    });

    const remaining = await openGaps(tx, id);

    // Resume the cold run in place. Without the continuation token this would
    // be a new session re-reading the whole form, which is the expensive thing
    // the token exists to avoid.
    let resumed = false;
    if (body.agentApiKey && app.eveSessionId && answered.length > 0) {
      const result = await continueRun({
        sessionId: app.eveSessionId,
        continuationToken: app.eveContinuationToken,
        apiKey: body.agentApiKey,
        applicationId: id,
        householdId: app.householdId,
        executionTier: 'cold',
        message: [
          'The following gaps have been answered and are now facts in the case graph:',
          ...answered.map((item) => `- ${labelFor(item.key)}`),
          '',
          'Call read_facts again and continue filling.',
        ].join('\n'),
      });
      resumed = result.ok;
    }

    await tx
      .update(application)
      .set({
        status: remaining.length === 0 ? 'ready_to_fill' : 'needs_attention',
        updatedAt: new Date(),
      })
      .where(eq(application.id, id));

    return ok(
      {
        answered: answered.length,
        unknown,
        invalid,
        openGapCount: remaining.length,
        resumed,
        writes,
        next:
          writes.length > 0
            ? `Enter these values on the page, then report readbacks to POST /v1/applications/${id}/fields.`
            : null,
      },
      { status: invalid.length > 0 ? 207 : 200, origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
