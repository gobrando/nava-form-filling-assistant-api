import { type ResolvedFact, currentFacts } from '@/lib/casegraph/facts';
import { type GapInput, reportGaps } from '@/lib/casegraph/gaps';
import type { Tx } from '@/lib/db';
import { applicationField } from '@/lib/db/schema';
import type { PlaybookRow } from '@/lib/playbooks/registry';
import { type InputType, SENSITIVE_FIELDS, isProtectedField, labelFor } from '@/lib/vocabulary';
import { sql } from 'drizzle-orm';

/**
 * The warm path: a fill plan computed from a fresh playbook and the facts
 * ledger, with no model involved.
 *
 * This is the deterministic half of the cost argument made concrete. When
 * every freshness probe passes, filling a form is a join between a field map
 * and a facts table — there is no judgment left to make, so paying a model to
 * re-derive the same mapping twenty times is waste. A WIC run that costs twenty
 * tool calls on the cold path costs one pass through this function on the warm
 * one.
 *
 * The plan is returned to the caller to execute, because the caller is the one
 * holding the browser: the Chrome extension has the participant's authenticated
 * session on the county site, and moving that session to a server would be both
 * harder and worse. The caller reports back what actually landed, and only then
 * is a field verified.
 */

export type PlannedWrite = {
  fieldKey: string;
  label: string;
  purpose: string | null;
  value: string;
  inputType: InputType;
  required: boolean;
  /** 'keys' for a masked control: a direct value assignment is silently rejected. */
  method: 'value' | 'keys';
  factId: string;
  provenance: { source: string; detail: string | null; freshness: string };
};

export type FillPlan = {
  playbookId: string;
  playbookVersion: number;
  writes: PlannedWrite[];
  gaps: GapInput[];
  staleUsed: string[];
};

function renderValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  const text = String(value);
  return text.length === 0 ? null : text;
}

/**
 * Builds the plan.
 *
 * A mapped field with no fact becomes a gap rather than a blank, so the caller
 * gets a question instead of silence. A protected field is never derived from a
 * near-miss key — it either has its own fact or it is a gap.
 */
export function buildFillPlan(row: PlaybookRow, facts: Map<string, ResolvedFact>): FillPlan {
  const writes: PlannedWrite[] = [];
  const gaps: GapInput[] = [];
  const staleUsed: string[] = [];

  for (const entry of row.fieldMap) {
    const inputType = (entry.inputType ?? 'text') as InputType;
    const label = entry.purpose ? labelFor(entry.purpose) : entry.fieldKey;

    if (!entry.purpose) {
      // An unclassified control is a decision, not a lookup. The playbook knows
      // the control exists but not what fact answers it; only a human does.
      gaps.push({
        fieldKey: entry.fieldKey,
        label,
        purpose: null,
        inputType,
        required: entry.required === true,
      });
      continue;
    }

    const resolved = facts.get(entry.purpose);
    const value = resolved ? renderValue(entry.purpose, resolved.value) : null;

    if (!resolved || value === null) {
      gaps.push({
        fieldKey: entry.fieldKey,
        label,
        purpose: entry.purpose,
        inputType,
        required: entry.required === true || isProtectedField(entry.purpose),
      });
      continue;
    }

    if (resolved.freshness !== 'fresh') staleUsed.push(entry.purpose);

    writes.push({
      fieldKey: entry.fieldKey,
      label,
      purpose: entry.purpose,
      value,
      inputType,
      required: entry.required === true,
      // The playbook's own annotation decides this. `#birthDate_primary_input`
      // and `#ssn` on BenefitsCal are confirmed masked fields where a direct
      // assignment reports success and lands nothing.
      method: entry.method === 'keys' || entry.mask ? 'keys' : 'value',
      factId: resolved.id,
      provenance: {
        source: resolved.source,
        detail: resolved.sourceDetail,
        freshness: resolved.freshness,
      },
    });
  }

  return {
    playbookId: row.id,
    playbookVersion: row.version,
    writes,
    gaps,
    staleUsed: [...new Set(staleUsed)],
  };
}

/**
 * Persists the plan as intended fields and open gaps.
 *
 * `verifiedAt` stays null. A plan is an intention, and until the caller reports
 * a readback nothing has been confirmed to land — the whole reason Phase 4
 * exists as a separate phase.
 */
export async function persistPlan(
  tx: Tx,
  tenantId: string,
  applicationId: string,
  plan: FillPlan,
): Promise<void> {
  if (plan.writes.length > 0) {
    let ordinal = 0;
    await tx
      .insert(applicationField)
      .values(
        plan.writes.map((write) => ({
          tenantId,
          applicationId,
          ordinal: ordinal++,
          fieldKey: write.fieldKey,
          label: write.label,
          purpose: write.purpose,
          value: write.value,
          inputType: write.inputType,
          required: write.required,
          sensitive: write.purpose ? SENSITIVE_FIELDS.has(write.purpose) : false,
          factId: write.factId,
          source: write.provenance.source as (typeof applicationField.$inferInsert)['source'],
          sourceDetail: write.provenance.detail,
          verifiedAt: null,
        })),
      )
      .onConflictDoUpdate({
        target: [applicationField.applicationId, applicationField.fieldKey],
        set: {
          value: sql`excluded."value"`,
          factId: sql`excluded."factId"`,
          source: sql`excluded."source"`,
          sourceDetail: sql`excluded."sourceDetail"`,
          // A replan supersedes an earlier verification: the value may have
          // changed, so the old readback no longer proves anything.
          verifiedAt: sql`NULL`,
        },
      });
  }

  await reportGaps(tx, tenantId, applicationId, plan.gaps);
}
