import { recordAudit } from '@/lib/audit';
import type { Tx } from '@/lib/db';
import { application, applicationOutcome } from '@/lib/db/schema';
import { OUTCOME_TRANSITIONS, type OutcomeReasonCode, type OutcomeStatus } from '@/lib/vocabulary';
import { and, asc, eq } from 'drizzle-orm';

/**
 * The post-submit outcome loop.
 *
 * Recording a submission starts it. Everything after that — the county
 * received it, documents are missing, it was approved, it was denied, the
 * benefit arrived — is a new row. The previous row stays, so "when did this
 * turn into a denial" is a query.
 */

const SSN_LIKE = /\b\d{3}-?\d{2}-?\d{4}\b/;

export type OutcomeInput = {
  status: OutcomeStatus;
  reasonCode?: OutcomeReasonCode | null;
  followUp?: string | null;
  recordedBy: string;
};

export type OutcomeRow = {
  id: string;
  status: OutcomeStatus;
  reasonCode: string | null;
  followUp: string | null;
  recordedBy: string;
  recordedAt: Date;
};

export type RecordOutcomeResult =
  | { ok: true; outcome: OutcomeRow }
  | { ok: false; status: 404 | 409; error: string };

export function nextSimulatedUpdate(
  current: 'submitted' | OutcomeStatus,
): OutcomeInput | null {
  switch (current) {
    case 'submitted':
      return { status: 'received', recordedBy: 'county-mailroom' };
    case 'received':
      return {
        status: 'pending_documents',
        reasonCode: 'missing_documents',
        followUp: 'Bring a photo ID and proof of a Riverside County address to the clinic.',
        recordedBy: 'county-mailroom',
      };
    case 'pending_documents':
      return {
        status: 'approved',
        followUp: 'The clinic will call to schedule the first appointment.',
        recordedBy: 'county-mailroom',
      };
    case 'approved':
      return { status: 'benefit_received', recordedBy: 'county-mailroom' };
    default:
      return null;
  }
}

export function allowedNext(current: 'submitted' | OutcomeStatus): readonly OutcomeStatus[] {
  return OUTCOME_TRANSITIONS[current];
}

export function validateOutcomeInput(input: OutcomeInput): string | null {
  const needsReason = input.status === 'denied' || input.status === 'pending_documents';
  if (needsReason && !input.reasonCode) {
    return 'This status needs a reason code.';
  }
  const followUp = input.followUp?.trim() ?? '';
  if (followUp.length > 280) return 'The follow-up note must be 280 characters or fewer.';
  if (followUp && SSN_LIKE.test(followUp)) {
    return 'The follow-up note looks like it contains an SSN. Say what document is needed, not the number.';
  }
  return null;
}

export async function listOutcomes(tx: Tx, applicationId: string): Promise<OutcomeRow[]> {
  const rows = await tx
    .select()
    .from(applicationOutcome)
    .where(eq(applicationOutcome.applicationId, applicationId))
    .orderBy(asc(applicationOutcome.recordedAt));
  return rows.map(toRow);
}

export async function recordOutcome(
  tx: Tx,
  scope: { tenantId: string; applicationId: string; principalId: string },
  input: OutcomeInput,
): Promise<RecordOutcomeResult> {
  const problem = validateOutcomeInput(input);
  if (problem) return { ok: false, status: 409, error: problem };

  const apps = await tx
    .select({ id: application.id, submittedAt: application.submittedAt })
    .from(application)
    .where(eq(application.id, scope.applicationId))
    .limit(1);
  const app = apps[0];
  if (!app) return { ok: false, status: 404, error: 'Application not found.' };
  if (!app.submittedAt) {
    return {
      ok: false,
      status: 409,
      error: 'Record a human submission before tracking what the county did with it.',
    };
  }

  const history = await listOutcomes(tx, scope.applicationId);
  const current = history.at(-1)?.status ?? 'submitted';
  const next = allowedNext(current);
  if (!next.includes(input.status)) {
    const options = next.length ? next.join(', ') : 'none; this outcome is final';
    return {
      ok: false,
      status: 409,
      error: `Cannot move from ${current} to ${input.status}. Allowed: ${options}.`,
    };
  }

  const followUp = input.followUp?.trim() ? input.followUp.trim() : null;
  const [inserted] = await tx
    .insert(applicationOutcome)
    .values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      status: input.status,
      reasonCode: input.reasonCode ?? null,
      followUp,
      recordedBy: input.recordedBy,
    })
    .returning();

  await tx
    .update(application)
    .set({ updatedAt: new Date() })
    .where(and(eq(application.id, scope.applicationId), eq(application.tenantId, scope.tenantId)));

  await recordAudit(tx, {
    tenantId: scope.tenantId,
    type: 'outcome_recorded',
    principalId: scope.principalId,
    applicationId: scope.applicationId,
    outcome: input.status,
    details: { outcomeStatus: input.status },
  });

  return { ok: true, outcome: toRow(inserted) };
}

function toRow(row: typeof applicationOutcome.$inferSelect): OutcomeRow {
  return {
    id: row.id,
    status: row.status,
    reasonCode: row.reasonCode,
    followUp: row.followUp,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt,
  };
}
