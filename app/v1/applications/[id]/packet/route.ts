import { recordAudit } from '@/lib/audit';
import { buildPacket, evaluateSubmitGate } from '@/lib/casegraph/packet';
import { withTenant } from '@/lib/db';
import { application } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight } from '@/lib/http';
import { eq } from 'drizzle-orm';

/**
 * GET /v1/applications/{id}/packet
 *
 * The product: every field in form order with its value, control type, options,
 * whether the form requires it, whether the write was verified by readback, and
 * a provenance object pointing at the fact it came from.
 *
 * Values are masked unless `?reveal=true`. A packet gets read in a room with a
 * participant, and the extension masks SSN and EIN in its own review view for
 * the same reason. Asking to reveal is recorded in the audit trail.
 *
 * `summary.provenanceShare` is the pilot measure, computed rather than claimed.
 * The database will not store a value without provenance, so a number below 1
 * here means data is missing — not that provenance is missing.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const reveal = new URL(request.url).searchParams.get('reveal') === 'true';

  return withTenant(auth.tenantId, async (tx) => {
    const apps = await tx
      .select({
        id: application.id,
        name: application.name,
        programIds: application.programIds,
        status: application.status,
        executionMode: application.executionMode,
        interventionReason: application.interventionReason,
        playbookVersion: application.playbookVersion,
        submittedAt: application.submittedAt,
        updatedAt: application.updatedAt,
      })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    const app = apps[0];
    if (!app) return fail(404, 'Application not found.', { origin });

    const packet = await buildPacket(tx, id, { reveal });
    const gate = await evaluateSubmitGate(tx, id);

    if (reveal) {
      // A request for unmasked values is worth a record. The audit row carries
      // the field count and no values, per the details allowlist.
      await recordAudit(tx, {
        tenantId: auth.tenantId,
        type: 'review_reached',
        principalId: auth.principalId,
        applicationId: id,
        outcome: 'revealed',
        details: { fieldCount: packet.fields.length },
      });
    }

    return ok(
      {
        application: app,
        ...packet,
        gate: {
          readyForReview: gate.blockers.length === 0,
          blockers: gate.blockers,
          reviewerPrincipal: gate.reviewerPrincipal,
          attestedAt: gate.attestedAt,
        },
        next:
          gate.blockers.length === 0
            ? 'A reviewer confirms with POST /review, then records submission with POST /submit.'
            : 'Resolve the blockers, then have a reviewer confirm.',
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
