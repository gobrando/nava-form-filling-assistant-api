import type { Tx } from '@/lib/db';
import { auditEvent } from '@/lib/db/schema';
import { AUDIT_COUNT_KEYS, AUDIT_ENUM_KEYS, type AuditEventType } from '@/lib/vocabulary';

/**
 * The audit writer.
 *
 * The connector contract requires audit events carrying "organization, user,
 * connection, record ID, outcome, and timestamp — but no participant values".
 * `sanitizeDetails` is a port of the extension's function of the same name: an
 * allowlist, not a denylist, so a new caller cannot accidentally widen it.
 *
 * The database enforces the same allowlist with a CHECK constraint
 * (`AuditEvent_details_allowlist`), so this function is the convenience and the
 * constraint is the guarantee. If they ever disagree, the insert fails — which
 * is the correct direction to fail.
 */

export type AuditDetails = Record<string, unknown>;

export function sanitizeDetails(details: AuditDetails): Record<string, string | number> {
  const output: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(details)) {
    if (AUDIT_COUNT_KEYS.has(key)) {
      const count = Number(value);
      if (Number.isFinite(count)) output[key] = Math.max(0, Math.trunc(count));
      continue;
    }

    const allowedValues = AUDIT_ENUM_KEYS[key as keyof typeof AUDIT_ENUM_KEYS];
    if (allowedValues && typeof value === 'string' && allowedValues.has(value)) {
      output[key] = value;
    }
    // Anything else is dropped. A participant value has no key that reaches
    // this point, which is the whole design.
  }

  return output;
}

export async function recordAudit(
  tx: Tx,
  entry: {
    tenantId: string;
    type: AuditEventType;
    principalId: string;
    applicationId?: string | null;
    connectionId?: string | null;
    recordId?: string | null;
    outcome?: string | null;
    details?: AuditDetails;
  },
): Promise<void> {
  await tx.insert(auditEvent).values({
    tenantId: entry.tenantId,
    type: entry.type,
    principalId: entry.principalId,
    applicationId: entry.applicationId ?? null,
    connectionId: entry.connectionId ?? null,
    recordId: entry.recordId ?? null,
    outcome: entry.outcome ?? null,
    details: sanitizeDetails(entry.details ?? {}),
  });
}
