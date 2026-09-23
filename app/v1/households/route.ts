import { appendFacts } from '@/lib/casegraph/facts';
import { factInputSchema } from '@/lib/casegraph/schemas';
import { withTenant } from '@/lib/db';
import { household, person } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/households
 *
 * Upserts a household by the *partner's own* identifier.
 *
 * `externalRef` is deliberately not an Apricot record ID. Gating a session on
 * one system's identifier stops caseworkers whose client is identified in a
 * different system (a Differential Response or DPSS ID, say) from starting.
 * `recordId` and `connectionId` are optional annotations here, never the key.
 */
const postSchema = z
  .object({
    externalRef: z.string().min(1).max(200),
    connectionId: z.string().min(1).max(200).optional(),
    recordId: z.string().min(1).max(200).optional(),
    facts: z.array(factInputSchema).max(500).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  return withTenant(auth.tenantId, async (tx) => {
    const [row] = await tx
      .insert(household)
      .values({
        tenantId: auth.tenantId,
        externalRef: body.externalRef,
        connectionId: body.connectionId ?? null,
        recordId: body.recordId ?? null,
      })
      .onConflictDoUpdate({
        target: [household.tenantId, household.externalRef],
        set: {
          connectionId: body.connectionId ?? null,
          recordId: body.recordId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Every household has exactly one applicant; members are added as needed.
    const existingApplicant = await tx
      .select({ id: person.id })
      .from(person)
      .where(eq(person.householdId, row.id))
      .limit(1);

    const applicantId =
      existingApplicant[0]?.id ??
      (
        await tx
          .insert(person)
          .values({ tenantId: auth.tenantId, householdId: row.id, role: 'applicant' })
          .returning({ id: person.id })
      )[0].id;

    const result = body.facts?.length
      ? await appendFacts(
          tx,
          auth.tenantId,
          row.id,
          body.facts.map((input) => ({ ...input, personId: applicantId })),
        )
      : { written: 0, rejected: [] };

    return ok(
      {
        household: {
          id: row.id,
          externalRef: row.externalRef,
          connectionId: row.connectionId,
          recordId: row.recordId,
        },
        factsWritten: result.written,
        // A rejection is always a protected field that may not be inferred.
        // Returning them tells the partner exactly what to ask a human for.
        rejected: result.rejected,
      },
      { status: 201, origin },
    );
  });
}

/** GET /v1/households — most recently updated first. */
export async function GET(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const limit = Math.min(
    100,
    Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 25)),
  );
  if (!Number.isFinite(limit)) return fail(400, 'limit must be a number.', { origin });

  return withTenant(auth.tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: household.id,
        externalRef: household.externalRef,
        connectionId: household.connectionId,
        recordId: household.recordId,
        updatedAt: household.updatedAt,
      })
      .from(household)
      .orderBy(desc(household.updatedAt))
      .limit(limit);

    return ok({ households: rows }, { origin });
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
