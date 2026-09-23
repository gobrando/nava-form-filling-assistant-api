import { buildPacket } from '@/lib/casegraph/packet';
import { withTenant } from '@/lib/db';
import { application, auditEvent, playbook } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight } from '@/lib/http';
import { asc, eq } from 'drizzle-orm';

/**
 * GET /v1/applications/{id}/metrics
 *
 * What a run cost and what it produced.
 *
 * `executionMode` is the number that matters. The unit of
 * cost is the turn, not the token, so a run's cost is attributable to whether
 * it executed a script or drove a model — and that in turn is attributable to a
 * playbook version. A cost regression after a site change becomes a specific
 * question ("which playbook went stale") instead of a general one.
 *
 * `provenanceShare` is the pilot's quality measure. The database will not store
 * a value without provenance, so this is 1 for any complete field and a number
 * below 1 means fields are unfilled, not untraceable.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;

  return withTenant(auth.tenantId, async (tx) => {
    const apps = await tx.select().from(application).where(eq(application.id, id)).limit(1);
    const app = apps[0];
    if (!app) return fail(404, 'Application not found.', { origin });

    const packet = await buildPacket(tx, id);

    const events = await tx
      .select({ type: auditEvent.type, at: auditEvent.at, outcome: auditEvent.outcome })
      .from(auditEvent)
      .where(eq(auditEvent.applicationId, id))
      .orderBy(asc(auditEvent.at));

    const playbookRows = app.playbookId
      ? await tx
          .select({ domain: playbook.domain, version: playbook.version, staleAt: playbook.staleAt })
          .from(playbook)
          .where(eq(playbook.id, app.playbookId))
          .limit(1)
      : [];

    const first = events[0]?.at ?? app.createdAt;
    const last = events.at(-1)?.at ?? app.updatedAt;

    return ok(
      {
        applicationId: app.id,
        programIds: app.programIds,
        status: app.status,

        cost: {
          executionMode: app.executionMode,
          // Zero on the warm path, and that is the headline: a fresh playbook
          // costs one deterministic pass.
          costUsd: Number(app.costUsd),
          toolCallCount: app.toolCallCount,
          modelTurnCount: app.modelTurnCount,
          wallClockMs: last.getTime() - first.getTime(),
        },

        quality: {
          fieldCount: packet.summary.fieldCount,
          filledCount: packet.summary.filledCount,
          verifiedCount: packet.summary.verifiedCount,
          // Filled but never read back. The silent-failure count.
          unverifiedCount: packet.summary.filledCount - packet.summary.verifiedCount,
          provenanceShare: packet.summary.provenanceShare,
          openGapCount: packet.summary.openGapCount,
          requiredUnfilledCount: packet.summary.requiredUnfilledCount,
        },

        intervention: {
          reason: app.interventionReason,
          checkpointKind: app.checkpointKind,
          // A gap is an intervention, and counting them is how "how often does
          // a human have to step in, and why" stops being anecdotal.
          humanAnswersRequired: packet.gaps.filter((item) => item.answered).length,
        },

        playbook: playbookRows[0]
          ? {
              domain: playbookRows[0].domain,
              version: playbookRows[0].version,
              stale: playbookRows[0].staleAt !== null,
            }
          : null,

        submittedAt: app.submittedAt,
        timeline: events,
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
