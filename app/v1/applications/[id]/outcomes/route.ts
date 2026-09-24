import { listOutcomes, recordOutcome } from '@/lib/casegraph/outcomes';
import { withTenant } from '@/lib/db';
import { application } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { outcomeReasonCodeSchema, outcomeStatusSchema } from '@/lib/vocabulary';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * GET  /v1/applications/{id}/outcomes — the history since submission.
 * POST /v1/applications/{id}/outcomes — append the next status.
 *
 * This does not talk to the county. A caseworker records what they learned:
 * the application was received, documents are missing, it was approved or
 * denied, or the benefit arrived.
 */
const postSchema = z
  .object({
    status: outcomeStatusSchema,
    reasonCode: outcomeReasonCodeSchema.optional(),
    followUp: z.string().max(280).optional(),
    recordedBy: z.string().min(1).max(200),
  })
  .strict();

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;
  const { id } = await params;

  return withTenant(auth.tenantId, async (tx) => {
    const apps = await tx
      .select({ id: application.id, submittedAt: application.submittedAt })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    const app = apps[0];
    if (!app) return fail(404, 'Application not found.', { origin });
    const history = await listOutcomes(tx, id);
    const current = history.at(-1)?.status ?? (app.submittedAt ? 'submitted' : null);
    return ok(
      {
        submittedAt: app.submittedAt?.toISOString() ?? null,
        current,
        outcomes: history.map(serialize),
      },
      { origin },
    );
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;
  const { id } = await params;
  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;

  return withTenant(auth.tenantId, async (tx) => {
    const result = await recordOutcome(
      tx,
      { tenantId: auth.tenantId, applicationId: id, principalId: auth.principalId },
      parsed.data,
    );
    if (!result.ok) return fail(result.status, result.error, { origin });
    return ok({ outcome: serialize(result.outcome) }, { origin, status: 201 });
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}

function serialize(row: {
  id: string;
  status: string;
  reasonCode: string | null;
  followUp: string | null;
  recordedBy: string;
  recordedAt: Date;
}) {
  return {
    id: row.id,
    status: row.status,
    reasonCode: row.reasonCode,
    followUp: row.followUp,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt.toISOString(),
  };
}
