import { recordAudit } from '@/lib/audit';
import { withTenant } from '@/lib/db';
import { application } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { acquireLease } from '@/lib/queue/lease';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/applications/{id}/handoff
 *
 * Transfers an in-progress application from one person to another.
 *
 * A handoff is two steps on purpose. `create` hands it over and `accept` picks
 * it up, and between them nobody may lease it — so an application is never in
 * the state where the first person has moved on and the second does not know
 * they own it. In the extension this could only ever be advisory, because
 * neither browser could see the other's queue.
 *
 * Handing off at a checkpoint is the common case: a caseworker's shift ends
 * mid-application, or a question needs someone with different authority.
 */
const postSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      fromPrincipal: z.string().min(1).max(200),
      toPrincipal: z.string().min(1).max(200),
      note: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('accept'),
      toPrincipal: z.string().min(1).max(200),
    })
    .strict(),
]);

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
        leaseHolder: application.leaseHolder,
        handoffToPrincipal: application.handoffToPrincipal,
        submittedAt: application.submittedAt,
        status: application.status,
      })
      .from(application)
      .where(eq(application.id, id))
      .for('update')
      .limit(1);
    const app = rows[0];
    if (!app) return fail(404, 'Application not found.', { origin });
    if (app.submittedAt) {
      return fail(409, 'This application is already recorded as submitted.', { origin });
    }

    if (body.action === 'create') {
      if (body.fromPrincipal === body.toPrincipal) {
        return fail(400, 'An application cannot be handed off to its current owner.', { origin });
      }

      await tx
        .update(application)
        .set({
          status: 'handoff_pending',
          checkpointKind: 'handoff',
          checkpointLabel: body.note ?? null,
          checkpointAt: new Date(),
          handoffToPrincipal: body.toPrincipal,
          handoffCreatedAt: new Date(),
          handoffAcceptedAt: null,
          // The lease is dropped with the handoff. Holding it would let the
          // sender keep filling an application they have given away.
          leaseHolder: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(application.id, id));

      await recordAudit(tx, {
        tenantId: auth.tenantId,
        type: 'handoff_created',
        principalId: auth.principalId,
        applicationId: id,
        outcome: 'pending',
        details: { fromStatus: app.status, toStatus: 'handoff_pending' },
      });

      return ok({ handoff: { to: body.toPrincipal, status: 'pending' } }, { status: 201, origin });
    }

    if (!app.handoffToPrincipal) {
      return fail(409, 'There is no pending handoff on this application.', { origin });
    }
    if (app.handoffToPrincipal !== body.toPrincipal) {
      // Generic on purpose: naming the intended recipient would leak staffing
      // to a caller who is not part of the transfer.
      return fail(409, 'This handoff is addressed to someone else.', { origin });
    }

    await tx
      .update(application)
      .set({
        status: 'paused',
        handoffAcceptedAt: new Date(),
        ownerPrincipal: body.toPrincipal,
        updatedAt: new Date(),
      })
      .where(eq(application.id, id));

    // Accepting takes the lease in the same transaction, so there is no window
    // where the application is accepted but unowned.
    const lease = await acquireLease(tx, id, body.toPrincipal);

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'handoff_accepted',
      principalId: auth.principalId,
      applicationId: id,
      outcome: 'accepted',
      details: { fromStatus: 'handoff_pending', toStatus: 'paused' },
    });

    return ok(
      {
        handoff: { to: body.toPrincipal, status: 'accepted' },
        lease: lease.acquired ? { holder: lease.holder, expiresAt: lease.expiresAt } : null,
        next: `Check POST /v1/applications/${id}/resume before continuing.`,
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
