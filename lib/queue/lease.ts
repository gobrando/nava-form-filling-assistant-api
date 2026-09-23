import type { Tx } from '@/lib/db';
import { application } from '@/lib/db/schema';
import {
  type CheckpointKind,
  LEASE_DEFAULT_MS,
  LEASE_MAX_MS,
  LEASE_MIN_MS,
  type ResumeOutcome,
} from '@/lib/vocabulary';
import { eq } from 'drizzle-orm';

/**
 * Leases, handoff, and the resume decision — the server-side half of the
 * extension's work-queue engine.
 *
 * These exist client-side today in `shared/work-queue-engine.js`, which means
 * two caseworkers at the same organization can hold the same application
 * because neither browser can see the other. Moving the lease to the server is
 * the only way a handoff between two people is a real transfer rather than a
 * convention, and it is the reason this service exists as a durable backend
 * rather than as a proxy.
 */

export type LeaseResult =
  | { acquired: true; holder: string; expiresAt: Date }
  | { acquired: false; holder: string; expiresAt: Date | null; reason: string };

function clampTtl(ttlMs: number | undefined): number {
  if (!ttlMs || !Number.isFinite(ttlMs)) return LEASE_DEFAULT_MS;
  return Math.min(LEASE_MAX_MS, Math.max(LEASE_MIN_MS, Math.trunc(ttlMs)));
}

/**
 * Acquires or renews a lease.
 *
 * An expired lease is takeable. That is deliberate: a browser tab that was
 * closed mid-run leaves a lease behind with nobody to release it, and the
 * alternative is an application nobody can touch until an administrator
 * intervenes. The bounds are the extension's — clamped to five seconds through
 * ten minutes — so a client cannot lease an application indefinitely by asking
 * for a long enough TTL.
 *
 * The read and the write are in one transaction, so two simultaneous callers
 * cannot both observe the lease as free.
 */
export async function acquireLease(
  tx: Tx,
  applicationId: string,
  holder: string,
  ttlMs?: number,
): Promise<LeaseResult> {
  const rows = await tx
    .select({
      leaseHolder: application.leaseHolder,
      leaseExpiresAt: application.leaseExpiresAt,
      handoffToPrincipal: application.handoffToPrincipal,
    })
    .from(application)
    .where(eq(application.id, applicationId))
    .for('update')
    .limit(1);

  const row = rows[0];
  if (!row) return { acquired: false, holder, expiresAt: null, reason: 'Application not found.' };

  const now = Date.now();
  const heldBySomeoneElse =
    row.leaseHolder !== null &&
    row.leaseHolder !== holder &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() > now;

  if (heldBySomeoneElse) {
    return {
      acquired: false,
      holder: row.leaseHolder as string,
      expiresAt: row.leaseExpiresAt,
      reason: 'Another user holds this application.',
    };
  }

  // A pending handoff belongs to its recipient. Letting anyone else take the
  // lease would make the handoff advisory.
  if (row.handoffToPrincipal && row.handoffToPrincipal !== holder) {
    return {
      acquired: false,
      holder: row.handoffToPrincipal,
      expiresAt: row.leaseExpiresAt,
      reason: 'This application is handed off to someone else and awaiting their acceptance.',
    };
  }

  const expiresAt = new Date(now + clampTtl(ttlMs));
  await tx
    .update(application)
    .set({
      leaseHolder: holder,
      leaseAcquiredAt: row.leaseHolder === holder ? undefined : new Date(now),
      leaseExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(application.id, applicationId));

  return { acquired: true, holder, expiresAt };
}

export async function releaseLease(
  tx: Tx,
  applicationId: string,
  holder: string,
): Promise<boolean> {
  const rows = await tx
    .select({ leaseHolder: application.leaseHolder })
    .from(application)
    .where(eq(application.id, applicationId))
    .for('update')
    .limit(1);
  if (rows[0]?.leaseHolder !== holder) return false;

  await tx
    .update(application)
    .set({ leaseHolder: null, leaseExpiresAt: null, leaseAcquiredAt: null, updatedAt: new Date() })
    .where(eq(application.id, applicationId));
  return true;
}

export type ResumeContext = {
  /** Current page URL, so a navigation away can be detected. */
  location?: string | null;
  /** Hash of the page's control signature, for structural change. */
  pageSignatureHash?: string | null;
  /** Whether the caller still has the tab open. */
  tabOpen?: boolean;
  /** Freshness of the source record, as the caller sees it. */
  sourceFreshness?: 'fresh' | 'stale' | 'unknown' | 'expired';
};

export type ResumeDecision = {
  outcome: ResumeOutcome;
  canContinue: boolean;
  checkpointKind: CheckpointKind | null;
  reason: string;
};

/**
 * Decides whether a paused run may continue, in the extension's order of
 * precedence.
 *
 * The order is not arbitrary. Source expiry beats everything because continuing
 * with expired data writes stale values into a legal document. A pending handoff
 * beats a page check because whether this person may act at all precedes
 * whether the page is intact. A structural page change is last because it is
 * the most recoverable — the run re-surveys and continues.
 *
 * Anything other than `verified` stops the run. Resuming on a changed page is
 * exactly how a value lands in the wrong field.
 */
export function resumeDecision(
  row: {
    handoffToPrincipal: string | null;
    handoffAcceptedAt: Date | null;
    location: string | null;
    pageSignatureHash: string | null;
  },
  context: ResumeContext,
): ResumeDecision {
  if (context.sourceFreshness === 'expired') {
    return {
      outcome: 'source_expired',
      canContinue: false,
      checkpointKind: 'source_expired',
      reason: 'The source record is no longer available. Reload it before continuing.',
    };
  }

  if (context.sourceFreshness === 'stale') {
    return {
      outcome: 'source_stale',
      canContinue: false,
      checkpointKind: 'source_stale',
      reason: 'The source record has changed since it was loaded. Reload it before continuing.',
    };
  }

  if (row.handoffToPrincipal && !row.handoffAcceptedAt) {
    return {
      outcome: 'handoff_pending',
      canContinue: false,
      checkpointKind: 'handoff',
      reason: 'This application is awaiting handoff acceptance.',
    };
  }

  if (context.tabOpen === false) {
    return {
      outcome: 'tab_closed',
      canContinue: false,
      checkpointKind: 'tab_closed',
      reason: 'The application tab is closed. Reopen it to continue.',
    };
  }

  if (row.location && context.location && context.location !== row.location) {
    return {
      outcome: 'location_changed',
      canContinue: false,
      checkpointKind: 'page_changed',
      reason: 'The page navigated away from where the run paused.',
    };
  }

  if (
    row.pageSignatureHash &&
    context.pageSignatureHash &&
    context.pageSignatureHash !== row.pageSignatureHash
  ) {
    return {
      outcome: 'page_changed',
      canContinue: false,
      checkpointKind: 'page_changed',
      reason: 'The page structure changed while the run was paused. Survey it again.',
    };
  }

  return {
    outcome: 'verified',
    canContinue: true,
    checkpointKind: null,
    reason: 'The resume point is intact.',
  };
}
