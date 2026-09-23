import { currentFacts } from '@/lib/casegraph/facts';
import { withTenant } from '@/lib/db';
import { application, household, person } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight } from '@/lib/http';
import { desc, eq } from 'drizzle-orm';

/**
 * GET /v1/households/{id}
 *
 * A household summary: who is in it, how many facts are known and how many are
 * stale, and every application run against it. Values are not returned here —
 * that is `/facts` and `/packet`, both of which mask by default.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;

  return withTenant(auth.tenantId, async (tx) => {
    const rows = await tx.select().from(household).where(eq(household.id, id)).limit(1);
    const row = rows[0];
    if (!row) return fail(404, 'Household not found.', { origin });

    const [members, facts, applications] = await Promise.all([
      tx
        .select({ id: person.id, role: person.role, ordinal: person.ordinal })
        .from(person)
        .where(eq(person.householdId, id))
        .orderBy(person.ordinal),
      currentFacts(tx, id),
      tx
        .select({
          id: application.id,
          name: application.name,
          programIds: application.programIds,
          status: application.status,
          executionMode: application.executionMode,
          submittedAt: application.submittedAt,
          updatedAt: application.updatedAt,
        })
        .from(application)
        .where(eq(application.householdId, id))
        .orderBy(desc(application.updatedAt)),
    ]);

    const stale = [...facts.values()].filter((item) => item.freshness !== 'fresh').length;

    return ok(
      {
        household: {
          id: row.id,
          externalRef: row.externalRef,
          connectionId: row.connectionId,
          recordId: row.recordId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        members,
        factCount: facts.size,
        staleFactCount: stale,
        applications,
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
