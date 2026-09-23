import { recordAudit } from '@/lib/audit';
import { evaluateSubmitGate } from '@/lib/casegraph/packet';
import { withTenant } from '@/lib/db';
import { application, reviewEvent } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/applications/{id}/review
 *
 * Records a human's review of the packet. A `confirmed` action is the
 * attestation the submit gate requires, and it names a person.
 *
 * `confirmed` is refused while blockers remain. A reviewer cannot attest to a
 * packet with an empty required field or an unverified write, because the
 * attestation is what the submit trigger checks and an attestation over
 * known-incomplete data is worth nothing.
 */
const postSchema = z
  .object({
    action: z.enum(['viewed', 'edited', 'confirmed']),
    reviewerPrincipal: z.string().min(1).max(200),
    fieldKey: z.string().max(500).optional(),
    attestation: z.string().max(1000).optional(),
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
      .select({ id: application.id, submittedAt: application.submittedAt })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    if (!apps[0]) return fail(404, 'Application not found.', { origin });
    if (apps[0].submittedAt) {
      return fail(409, 'This application is already recorded as submitted.', { origin });
    }

    if (body.action === 'confirmed') {
      const gate = await evaluateSubmitGate(tx, id);
      // The gate's own "no confirmation yet" blocker is the thing being fixed
      // by this request, so it does not count against it.
      const blockers = gate.blockers.filter(
        (blocker) => blocker !== 'No reviewer has confirmed this packet.',
      );
      if (blockers.length > 0) {
        return fail(409, `This packet cannot be confirmed yet: ${blockers.join(' ')}`, { origin });
      }
    }

    await tx.insert(reviewEvent).values({
      tenantId: auth.tenantId,
      applicationId: id,
      reviewerPrincipal: body.reviewerPrincipal,
      action: body.action,
      fieldKey: body.fieldKey ?? null,
      attestation: body.attestation ?? null,
    });

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'review_reached',
      principalId: auth.principalId,
      applicationId: id,
      outcome: body.action,
    });

    return ok(
      {
        action: body.action,
        recorded: true,
        next:
          body.action === 'confirmed'
            ? 'A human submits on the site, then records it with POST /submit.'
            : 'Confirm the packet when it is correct.',
      },
      { status: 201, origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
