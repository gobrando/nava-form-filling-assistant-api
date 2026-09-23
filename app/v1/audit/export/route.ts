import { recordAudit } from '@/lib/audit';
import { withTenant } from '@/lib/db';
import { auditEvent } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight } from '@/lib/http';
import { AUDIT_SCHEMA } from '@/lib/vocabulary';
import { and, asc, gte, lte } from 'drizzle-orm';

/**
 * GET /v1/audit/export?from=&to=
 *
 * The durable audit export, in the extension's `nava.form-filling.audit.v1`
 * schema so an existing consumer of `exportAudit` reads this without change.
 *
 * Durability is the point. The extension's export covers one browser profile's
 * session history, which is the wrong unit — a county asking "who looked at
 * this participant's record" wants an answer across every caseworker and every
 * device, and it wants it after the browser that did the looking is gone.
 *
 * No event in this export can carry a participant value. `details` is
 * constrained by the `AuditEvent_details_allowlist` CHECK constraint to five
 * counts and four status enums, so the guarantee holds against any writer,
 * including one added later that forgets about it.
 */
export async function GET(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const url = new URL(request.url);
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');

  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 86_400_000);
  const to = toParam ? new Date(toParam) : new Date();

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return fail(400, 'from and to must be ISO-8601 timestamps.', { origin });
  }
  if (from > to) return fail(400, 'from must be before to.', { origin });

  return withTenant(auth.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(auditEvent)
      .where(and(gte(auditEvent.at, from), lte(auditEvent.at, to)))
      .orderBy(asc(auditEvent.at))
      .limit(10_000);

    // Exporting the audit is itself auditable. Without this, "who pulled the
    // access log" is the one question the access log cannot answer.
    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'audit_exported',
      principalId: auth.principalId,
      outcome: 'exported',
    });

    return ok(
      {
        schema: AUDIT_SCHEMA,
        tenant: auth.tenantSlug,
        exportedAt: new Date().toISOString(),
        range: { from: from.toISOString(), to: to.toISOString() },
        truncated: rows.length === 10_000,
        events: rows.map((row) => ({
          id: row.id,
          at: row.at.toISOString(),
          type: row.type,
          principalId: row.principalId,
          applicationId: row.applicationId,
          connectionId: row.connectionId,
          recordId: row.recordId,
          outcome: row.outcome,
          details: row.details,
        })),
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
