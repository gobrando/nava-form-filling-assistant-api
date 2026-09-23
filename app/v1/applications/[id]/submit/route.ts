import { recordAudit } from '@/lib/audit';
import { evaluateSubmitGate } from '@/lib/casegraph/packet';
import { withTenant } from '@/lib/db';
import { application, reviewEvent } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, logFailure, ok, preflight, readJson, traceId } from '@/lib/http';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/applications/{id}/submit
 *
 * Records that a human submitted the application. It does not submit anything.
 *
 * This distinction is the point of the endpoint's existence. A benefits
 * application is a legal attestation by the participant about their own
 * household — income, household composition, immigration status are sworn to,
 * and a false statement has consequences for the participant and not for the
 * tool. Nobody has delegated that attestation and it is not delegable, so no
 * code path in this service activates a submit control.
 *
 * What this records is the start of the outcome loop: an application with a
 * known submission time can be followed to an approval or a denial, which is
 * the only way to learn whether a filled packet was a *correct* packet. That
 * record has to have a human in it, which is why the gate exists.
 *
 * Returns 409 with reasons unless a reviewer has confirmed and nothing required
 * is missing. `Application_submit_gate` enforces the same rule as a trigger; if
 * the two disagree the trigger wins and the request fails.
 */
const postSchema = z
  .object({
    /** The person who performed the submission on the site. */
    submittedBy: z.string().min(1).max(200),
    confirmationNumber: z.string().max(200).optional(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;

  return withTenant(auth.tenantId, async (tx) => {
    const apps = await tx
      .select({ id: application.id })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    if (!apps[0]) return fail(404, 'Application not found.', { origin });

    const gate = await evaluateSubmitGate(tx, id);
    if (!gate.allowed) {
      return fail(409, `This application is not ready to submit: ${gate.blockers.join(' ')}`, {
        origin,
      });
    }

    try {
      await tx
        .update(application)
        .set({ submittedAt: new Date(), status: 'ready_for_review', updatedAt: new Date() })
        .where(eq(application.id, id));
    } catch {
      // The trigger refused. Something changed between the gate check and the
      // write — a required field emptied, a confirmation removed. The caller
      // gets a 409, not a 500, because the request was simply no longer valid.
      const trace = traceId();
      logFailure(trace, 'submit gate rejected the write', { applicationId: id });
      return fail(409, 'This application is no longer ready to submit.', {
        origin,
        traceId: trace,
      });
    }

    await tx.insert(reviewEvent).values({
      tenantId: auth.tenantId,
      applicationId: id,
      reviewerPrincipal: parsed.data.submittedBy,
      action: 'submitted',
      // A county confirmation number is not participant data; it is the handle
      // the outcome loop follows.
      attestation: parsed.data.confirmationNumber ?? null,
    });

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'session_ended',
      principalId: auth.principalId,
      applicationId: id,
      outcome: 'submitted',
    });

    return ok(
      {
        submitted: true,
        submittedBy: parsed.data.submittedBy,
        attestedBy: gate.reviewerPrincipal,
        attestedAt: gate.attestedAt,
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
