import { recordAudit } from '@/lib/audit';
import { withTenant } from '@/lib/db';
import { application } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { resumeDecision } from '@/lib/queue/lease';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/applications/{id}/resume
 *
 * Asks whether a paused run may continue, and records the answer.
 *
 * The caller describes what it can see — the current URL, a hash of the page's
 * control signature, whether its tab is still open, how fresh it believes the
 * source record to be — and gets back a verdict. Only `verified` permits
 * continuing.
 *
 * Refusing to resume on a changed page is not caution for its own sake. A run
 * resuming against a page whose structure moved is precisely how a value lands
 * in the wrong field, and that failure is silent: the write succeeds, the
 * packet looks complete, and the wrong number is in the wrong box.
 */
const postSchema = z
  .object({
    holder: z.string().min(1).max(200),
    location: z.string().max(2000).nullable().optional(),
    pageSignatureHash: z.string().max(128).nullable().optional(),
    tabOpen: z.boolean().optional(),
    sourceFreshness: z.enum(['fresh', 'stale', 'unknown', 'expired']).optional(),
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
    const rows = await tx
      .select({
        id: application.id,
        status: application.status,
        leaseHolder: application.leaseHolder,
        leaseExpiresAt: application.leaseExpiresAt,
        handoffToPrincipal: application.handoffToPrincipal,
        handoffAcceptedAt: application.handoffAcceptedAt,
        location: application.location,
        pageSignatureHash: application.pageSignatureHash,
        submittedAt: application.submittedAt,
      })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    const app = rows[0];
    if (!app) return fail(404, 'Application not found.', { origin });
    if (app.submittedAt) {
      return fail(409, 'This application is already recorded as submitted.', { origin });
    }

    // The lease is checked before the page, because whether this caller may act
    // at all precedes whether the page they are looking at is intact.
    const leaseHeld =
      app.leaseHolder === body.holder &&
      app.leaseExpiresAt !== null &&
      app.leaseExpiresAt.getTime() > Date.now();
    if (!leaseHeld) {
      return fail(409, 'This caller does not hold a current lease on the application.', { origin });
    }

    const decision = resumeDecision(app, {
      location: body.location ?? null,
      pageSignatureHash: body.pageSignatureHash ?? null,
      tabOpen: body.tabOpen,
      sourceFreshness: body.sourceFreshness,
    });

    await tx
      .update(application)
      .set(
        decision.canContinue
          ? {
              status: 'ready_to_fill',
              checkpointKind: null,
              checkpointLabel: null,
              // The verified resume point becomes the new baseline, so the next
              // pause compares against where the run actually is.
              location: body.location ?? app.location,
              pageSignatureHash: body.pageSignatureHash ?? app.pageSignatureHash,
              updatedAt: new Date(),
            }
          : {
              status: decision.outcome === 'source_expired' ? 'source_expired' : 'paused',
              checkpointKind: decision.checkpointKind,
              checkpointAt: new Date(),
              updatedAt: new Date(),
            },
      )
      .where(eq(application.id, id));

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: decision.canContinue ? 'resume_verified' : 'resume_rejected',
      principalId: auth.principalId,
      applicationId: id,
      outcome: decision.outcome,
      details: { resumeOutcome: decision.outcome, fromStatus: app.status },
    });

    return ok(
      {
        outcome: decision.outcome,
        canContinue: decision.canContinue,
        checkpointKind: decision.checkpointKind,
        reason: decision.reason,
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
