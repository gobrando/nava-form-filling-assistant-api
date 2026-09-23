import { appendFacts, currentFacts, factHistory, maskValue } from '@/lib/casegraph/facts';
import { factInputSchema } from '@/lib/casegraph/schemas';
import { withTenant } from '@/lib/db';
import { household, person } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { labelFor } from '@/lib/vocabulary';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * The facts ledger.
 *
 * GET  /v1/households/{id}/facts            current value per key
 * GET  /v1/households/{id}/facts?key=ssn    full history for one key
 * POST /v1/households/{id}/facts            append, superseding
 *
 * Sensitive values are masked unless `?reveal=true` is passed, which is
 * recorded in the response so a caller cannot claim it did not ask.
 */

const postSchema = z.object({ facts: z.array(factInputSchema).min(1).max(500) }).strict();

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const reveal = url.searchParams.get('reveal') === 'true';

  return withTenant(auth.tenantId, async (tx) => {
    const found = await tx
      .select({ id: household.id })
      .from(household)
      .where(eq(household.id, id))
      .limit(1);
    if (!found[0]) return fail(404, 'Household not found.', { origin });

    if (key) {
      const rows = await factHistory(tx, id, key);
      return ok(
        {
          key,
          label: labelFor(key),
          masked: !reveal,
          history: rows.map((row) => ({
            id: row.id,
            value: reveal ? row.value : maskValue(row.key, row.value),
            source: row.source,
            sourceDetail: row.sourceDetail,
            confidence: row.confidence === null ? null : Number(row.confidence),
            observedAt: row.observedAt,
            expiresAt: row.expiresAt,
            confirmedBy: row.confirmedBy,
            supersedesId: row.supersedesId,
          })),
        },
        { origin },
      );
    }

    const facts = await currentFacts(tx, id);
    return ok(
      {
        masked: !reveal,
        facts: [...facts.values()].map((item) => ({
          key: item.key,
          label: labelFor(item.key),
          value: reveal ? item.value : maskValue(item.key, item.value),
          source: item.source,
          sourceDetail: item.sourceDetail,
          confidence: item.confidence,
          observedAt: item.observedAt,
          expiresAt: item.expiresAt,
          freshness: item.freshness,
          confirmedBy: item.confirmedBy,
          sensitive: item.sensitive,
        })),
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
    const found = await tx
      .select({ id: household.id })
      .from(household)
      .where(eq(household.id, id))
      .limit(1);
    if (!found[0]) return fail(404, 'Household not found.', { origin });

    const applicant = await tx
      .select({ id: person.id })
      .from(person)
      .where(eq(person.householdId, id))
      .limit(1);

    const result = await appendFacts(
      tx,
      auth.tenantId,
      id,
      parsed.data.facts.map((input) => ({ ...input, personId: applicant[0]?.id ?? null })),
    );

    await tx.update(household).set({ updatedAt: new Date() }).where(eq(household.id, id));

    // 207 when some facts were refused: the request partly succeeded, and a
    // partner that treats 200 as "all written" would otherwise be wrong.
    return ok(
      { factsWritten: result.written, rejected: result.rejected },
      { status: result.rejected.length > 0 ? 207 : 200, origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
