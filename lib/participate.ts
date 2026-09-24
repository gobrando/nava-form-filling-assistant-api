import { randomBytes } from 'node:crypto';
import { hashSecret } from '@/lib/auth';
import { currentFacts, maskValue } from '@/lib/casegraph/facts';
import { allGaps, answerGaps } from '@/lib/casegraph/gaps';
import { listOutcomes } from '@/lib/casegraph/outcomes';
import { type Tx, db, withTenant } from '@/lib/db';
import { application, participantShare, tenant } from '@/lib/db/schema';
import { labelFor } from '@/lib/vocabulary';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * The participant surface.
 *
 * A caseworker mints a link. The person the application is about opens it,
 * sees the facts already on file (sensitive ones masked), and answers the
 * questions the fill could not. The page has no submit control. Submission
 * stays a human act on the county site, after a caseworker review.
 */

const TOKEN_PATTERN = /^part_[A-Za-z0-9_-]{32,64}$/;
const SHARE_DEFAULT_HOURS = 24 * 7;
const SHARE_MAX_HOURS = 24 * 30;

const SOURCE_LABEL: Record<string, string> = {
  connector: 'From the case record',
  document: 'From a document',
  caseworker: 'Entered by a caseworker',
  participant: 'You told us',
  page: 'Already on the form',
  inferred: 'Estimated',
};

export type ParticipantQuestion = {
  id: string;
  question: string;
  inputType: string;
  options: string[] | null;
  required: boolean;
};

export type ParticipantView = {
  programName: string;
  organizationName: string;
  facts: { key: string; label: string; display: string; sourceLabel: string }[];
  questions: ParticipantQuestion[];
  outcome: { status: string; followUp: string | null; reasonCode: string | null } | null;
  expiresAt: string;
  /** The page never offers submission. This is a property so a test can hold it. */
  canSubmit: false;
};

export type ResolvedShare = {
  id: string;
  tenantId: string;
  applicationId: string;
  householdId: string;
  expiresAt: Date;
};

export function newShareToken(): string {
  return `part_${randomBytes(24).toString('base64url')}`;
}

export function isShareToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export async function createShare(
  tx: Tx,
  scope: { tenantId: string; applicationId: string; createdBy: string; expiresInHours?: number },
): Promise<{ token: string; expiresAt: Date } | { error: string }> {
  const hours = scope.expiresInHours ?? SHARE_DEFAULT_HOURS;
  if (!Number.isFinite(hours) || hours < 1 || hours > SHARE_MAX_HOURS) {
    return { error: `expiresInHours must be between 1 and ${SHARE_MAX_HOURS}.` };
  }
  const apps = await tx
    .select({ id: application.id, householdId: application.householdId })
    .from(application)
    .where(eq(application.id, scope.applicationId))
    .limit(1);
  const app = apps[0];
  if (!app) return { error: 'Application not found.' };

  const token = newShareToken();
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  await tx.insert(participantShare).values({
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    householdId: app.householdId,
    tokenHash: hashSecret(token),
    createdBy: scope.createdBy,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function resolveShare(token: string): Promise<ResolvedShare | null> {
  if (!isShareToken(token)) return null;
  const rows = await db
    .select({
      id: participantShare.id,
      tenantId: participantShare.tenantId,
      applicationId: participantShare.applicationId,
      householdId: participantShare.householdId,
      expiresAt: participantShare.expiresAt,
      revokedAt: participantShare.revokedAt,
    })
    .from(participantShare)
    .where(
      and(eq(participantShare.tokenHash, hashSecret(token)), isNull(participantShare.revokedAt)),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    applicationId: row.applicationId,
    householdId: row.householdId,
    expiresAt: row.expiresAt,
  };
}

export async function loadParticipantView(share: ResolvedShare): Promise<ParticipantView | null> {
  return withTenant(share.tenantId, async (tx) => {
    const apps = await tx
      .select({ name: application.name, householdId: application.householdId })
      .from(application)
      .where(eq(application.id, share.applicationId))
      .limit(1);
    const app = apps[0];
    if (!app) return null;
    const orgs = await tx
      .select({ name: tenant.name })
      .from(tenant)
      .where(eq(tenant.id, share.tenantId))
      .limit(1);

    const facts = await currentFacts(tx, app.householdId);
    const everyGap = await allGaps(tx, share.applicationId);
    const gaps = everyGap.filter((gap) => gap.answeredAt === null);
    const labelByKey = new Map(
      everyGap.map((gap) => [gap.purpose ?? `control:${gap.fieldKey}`, gap.label]),
    );
    const outcomes = await listOutcomes(tx, share.applicationId);
    const latest = outcomes.at(-1) ?? null;

    return {
      programName: app.name,
      organizationName: orgs[0]?.name ?? 'Your caseworker',
      facts: [...facts.values()].map((fact) => ({
        key: fact.key,
        label: labelByKey.get(fact.key) ?? labelFor(fact.key),
        display: maskValue(fact.key, fact.value),
        sourceLabel: SOURCE_LABEL[fact.source] ?? 'On file',
      })),
      questions: gaps.map((gap) => ({
        id: gap.id,
        question: gap.question,
        inputType: gap.inputType,
        options: gap.options,
        required: gap.required,
      })),
      outcome: latest
        ? { status: latest.status, followUp: latest.followUp, reasonCode: latest.reasonCode }
        : null,
      expiresAt: share.expiresAt.toISOString(),
      canSubmit: false,
    };
  });
}

export async function answerAsParticipant(
  share: ResolvedShare,
  answers: { gapId: string; value: string }[],
) {
  return withTenant(share.tenantId, (tx) =>
    answerGaps(
      tx,
      {
        tenantId: share.tenantId,
        applicationId: share.applicationId,
        householdId: share.householdId,
      },
      answers.map((answer) => ({
        gapId: answer.gapId,
        value: answer.value,
        source: 'participant' as const,
        answeredBy: 'participant',
        note: 'Answered on the participant page.',
      })),
    ),
  );
}

export function shareLifetimeMs(expiresAt: Date, now = Date.now()): number {
  return Math.max(0, expiresAt.getTime() - now);
}
