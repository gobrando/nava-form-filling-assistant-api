import { recordAudit } from '@/lib/audit';
import { appendFacts } from '@/lib/casegraph/facts';
import {
  AdapterUnavailableError,
  ConnectorCredentialsError,
  connectorMode,
  liveRecord,
  mapLiveRecord,
  resolveConnection,
} from '@/lib/connectors/registry';
import { withTenant } from '@/lib/db';
import { household, person } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, logFailure, ok, preflight, readJson, traceId } from '@/lib/http';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/households/import
 *
 * Pulls one record from the organization's live Apricot and turns it into a
 * household with connector-sourced facts. This is what makes a live connection
 * useful to a partner: they name a record, the API reads it, and every value
 * that lands on an application later traces back to that read.
 *
 * Only fields in the connection's reviewed mapping become facts. An unmapped
 * field is counted and dropped, so a field Apricot adds tomorrow cannot reach an
 * application until someone decides what it means.
 */
const postSchema = z
  .object({
    connectionId: z.string().min(1).max(200),
    recordId: z.string().regex(/^\d{1,12}$/),
    /** Defaults to `<connectionId>:<recordId>`. */
    externalRef: z.string().min(1).max(200).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const row = await withTenant(auth.tenantId, (tx) => resolveConnection(tx, body.connectionId));
  if (!row) return fail(404, 'Connector not found.', { origin });
  if (row.providerId !== 'apricot360') {
    return fail(501, new AdapterUnavailableError(row.providerId).message, { origin });
  }
  if (connectorMode(row) !== 'live') {
    return fail(
      409,
      'This connection is in local-demo mode; there is no live system to import from.',
      { origin },
    );
  }

  // The upstream read happens outside any transaction, so a slow Apricot never
  // holds a database connection open.
  let record: Awaited<ReturnType<typeof liveRecord>>;
  try {
    record = await liveRecord(row, body.recordId);
  } catch (error) {
    if (error instanceof ConnectorCredentialsError) return fail(503, error.message, { origin });
    const id = traceId();
    logFailure(id, 'connector import failed', {
      connectionId: row.connectionId,
      providerId: row.providerId,
    });
    return fail(502, 'The connector could not be read.', { origin, traceId: id });
  }

  return withTenant(auth.tenantId, async (tx) => {
    if (!record) {
      await recordAudit(tx, {
        tenantId: auth.tenantId,
        type: 'source_loaded',
        principalId: auth.principalId,
        connectionId: row.connectionId,
        recordId: body.recordId,
        outcome: 'not_found',
        details: { fieldCount: 0 },
      });
      return fail(404, 'Record not found.', { origin });
    }

    const { values, unmappedCount, observedAt } = mapLiveRecord(row, record);
    const externalRef = body.externalRef ?? `${row.connectionId}:${body.recordId}`;

    const [saved] = await tx
      .insert(household)
      .values({
        tenantId: auth.tenantId,
        externalRef,
        connectionId: row.connectionId,
        recordId: body.recordId,
      })
      .onConflictDoUpdate({
        target: [household.tenantId, household.externalRef],
        set: { connectionId: row.connectionId, recordId: body.recordId, updatedAt: new Date() },
      })
      .returning();

    const existing = await tx
      .select({ id: person.id })
      .from(person)
      .where(eq(person.householdId, saved.id))
      .limit(1);
    const applicantId =
      existing[0]?.id ??
      (
        await tx
          .insert(person)
          .values({ tenantId: auth.tenantId, householdId: saved.id, role: 'applicant' })
          .returning({ id: person.id })
      )[0].id;

    const result = await appendFacts(
      tx,
      auth.tenantId,
      saved.id,
      Object.entries(values).map(([key, value]) => ({
        key,
        value: value as never,
        source: 'connector' as const,
        sourceDetail: `Apricot 360 form ${row.sourceId}, record ${body.recordId}`,
        observedAt,
        personId: applicantId,
      })),
    );

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'source_loaded',
      principalId: auth.principalId,
      connectionId: row.connectionId,
      recordId: body.recordId,
      outcome: 'found',
      details: { fieldCount: result.written, blockedCount: unmappedCount },
    });

    return ok(
      {
        household: { id: saved.id, externalRef, connectionId: row.connectionId },
        factsWritten: result.written,
        unmappedFieldCount: unmappedCount,
        observedAt: observedAt.toISOString(),
        rejected: result.rejected,
      },
      { status: 201, origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
