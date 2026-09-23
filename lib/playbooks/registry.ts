import type { Tx } from '@/lib/db';
import { playbook } from '@/lib/db/schema';
import type { ExecutionMode } from '@/lib/vocabulary';
import { and, desc, eq, isNull, or } from 'drizzle-orm';

/**
 * Playbook resolution and the warm/cold routing decision.
 *
 * When a site has not changed, a run should check freshness and then execute a
 * script: one tool call, no model in the loop. A model-driven WIC run takes
 * about twenty tool calls, each of which reads the DOM again.
 *
 * So a run resolves a playbook, the client evaluates its probes against the live
 * page, and the reported result picks the path: every probe resolving means
 * deterministic replay; any miss means the site changed and the model takes
 * over. That decision is recorded as `executionMode` on the application, which
 * is what makes cost attributable to a program and a playbook version.
 */

export type PlaybookRow = typeof playbook.$inferSelect;

/**
 * The best playbook for a program: a tenant's own override first, then shared
 * control-plane knowledge, highest version first.
 *
 * Row-level security already restricts the tenant column to the caller's tenant
 * or NULL, so this ordering is a preference, not a boundary.
 */
export async function resolvePlaybookForProgram(
  tx: Tx,
  tenantId: string,
  programId: string,
): Promise<PlaybookRow | null> {
  const rows = await tx
    .select()
    .from(playbook)
    .where(or(eq(playbook.tenantId, tenantId), isNull(playbook.tenantId)))
    .orderBy(desc(playbook.tenantId), desc(playbook.version));

  return rows.find((row) => row.programIds.includes(programId)) ?? null;
}

export async function resolvePlaybookForDomain(
  tx: Tx,
  tenantId: string,
  domain: string,
): Promise<PlaybookRow | null> {
  const rows = await tx
    .select()
    .from(playbook)
    .where(
      and(
        eq(playbook.domain, domain),
        or(eq(playbook.tenantId, tenantId), isNull(playbook.tenantId)),
      ),
    )
    .orderBy(desc(playbook.tenantId), desc(playbook.version));

  return rows[0] ?? null;
}

export type ProbeResult = { selector: string; count: number };

export type ProbeVerdict = {
  passed: boolean;
  missing: string[];
  executionMode: ExecutionMode;
  reason: string;
};

/**
 * Evaluates a probe report.
 *
 * The extension's playbooks and the skill's `playbooks/*.md` both express
 * freshness the same way: every probe selector must resolve to exactly one
 * element. A count of zero means the selector is gone. A count above one means
 * the selector is now ambiguous, which is just as unsafe to replay — writing to
 * the wrong one of two matching elements is the silent-success failure this
 * whole protocol exists to prevent.
 */
export function evaluateProbes(row: PlaybookRow, results: ProbeResult[]): ProbeVerdict {
  const byCount = new Map(results.map((result) => [result.selector, result.count]));
  const missing = row.probes.filter((selector) => byCount.get(selector) !== 1);

  if (row.staleAt) {
    return {
      passed: false,
      missing,
      executionMode: 'model',
      reason: `Playbook was marked stale: ${row.staleReason ?? 'unknown reason'}.`,
    };
  }

  if (missing.length > 0) {
    return {
      passed: false,
      missing,
      executionMode: 'model',
      reason: `${missing.length} of ${row.probes.length} freshness probes did not resolve to exactly one element. The site changed.`,
    };
  }

  return {
    passed: true,
    missing: [],
    executionMode: 'script',
    reason: 'All freshness probes resolved. Deterministic replay is safe.',
  };
}

/**
 * Marks a playbook stale so the next run skips the warm path.
 *
 * Repair is the scribe's job: it writes and repairs scripts, plans for new
 * sites, heals broken ones, and otherwise stays idle. Staleness is the signal that wakes it,
 * which is why this does not attempt a fix inline.
 */
export async function markStale(tx: Tx, playbookId: string, reason: string): Promise<void> {
  await tx
    .update(playbook)
    .set({ staleAt: new Date(), staleReason: reason.slice(0, 500), updatedAt: new Date() })
    .where(eq(playbook.id, playbookId));
}

/** The client-facing projection. Excludes internal staleness bookkeeping. */
export function publicPlaybook(row: PlaybookRow) {
  return {
    id: row.id,
    domain: row.domain,
    name: row.name,
    version: row.version,
    programIds: row.programIds,
    probes: row.probes,
    fieldMap: row.fieldMap,
    safeAdvanceRules: row.safeAdvanceRules,
    autoAdvance: row.autoAdvance,
    note: row.note,
    stale: row.staleAt !== null,
    staleReason: row.staleReason,
    shared: row.tenantId === null,
  };
}
