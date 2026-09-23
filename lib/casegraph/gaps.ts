import { appendFacts } from '@/lib/casegraph/facts';
import type { FactValue } from '@/lib/casegraph/schemas';
import type { Tx } from '@/lib/db';
import { applicationField, gap } from '@/lib/db/schema';
import {
  type GapKind,
  type InputType,
  SENSITIVE_FIELDS,
  isProtectedField,
  labelFor,
} from '@/lib/vocabulary';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

/**
 * Gaps: the BLOCKED translation.
 *
 * The multi-agent skill design has the orchestrator own all user I/O, and a
 * fill agent that needs data stops and returns a BLOCKED report for the
 * orchestrator to ask about. On an API there is nobody to ask, and this
 * is the single substitution that makes that multi-agent design work as a
 * product surface: BLOCKED becomes a row here, the run ends its turn, and the
 * partner answers through `POST /v1/applications/{id}/gaps`.
 *
 * A run that stops with gaps has succeeded. It asked a question it is not
 * allowed to answer itself.
 */

export type GapInput = {
  fieldKey: string;
  label?: string;
  purpose?: string | null;
  question?: string;
  required?: boolean;
  inputType?: InputType;
  options?: string[] | null;
};

/**
 * `decision` rather than `required` when a human's judgment is the point: a
 * protected field, or a control whose value is a choice among offered options
 * rather than a fact to be looked up.
 */
export function classifyGap(input: GapInput): GapKind {
  if (input.purpose && isProtectedField(input.purpose)) return 'decision';
  if (isProtectedField(input.fieldKey)) return 'decision';
  if (input.inputType === 'select' || input.inputType === 'radio') return 'decision';
  return 'required';
}

/**
 * The question shown to a caseworker.
 *
 * Phrased as a question about the participant, not about the form, because the
 * person answering is sitting with the participant and not looking at the page.
 */
export function defaultQuestion(input: GapInput): string {
  const label = input.label ?? (input.purpose ? labelFor(input.purpose) : input.fieldKey);
  if (input.purpose && isProtectedField(input.purpose)) {
    return `${label} must be confirmed directly and cannot be inferred. What is the correct value?`;
  }
  if (input.options?.length) {
    return `Which option applies for ${label}?`;
  }
  return `What is the ${label.charAt(0).toLowerCase()}${label.slice(1)}?`;
}

export async function reportGaps(
  tx: Tx,
  tenantId: string,
  applicationId: string,
  inputs: GapInput[],
): Promise<{ created: number }> {
  if (inputs.length === 0) return { created: 0 };

  const existing = await tx
    .select({ ordinal: gap.ordinal })
    .from(gap)
    .where(eq(gap.applicationId, applicationId));
  let ordinal = existing.reduce((max, row) => Math.max(max, row.ordinal), -1) + 1;

  const values = inputs.map((input) => ({
    tenantId,
    applicationId,
    ordinal: ordinal++,
    fieldKey: input.fieldKey,
    label: input.label ?? (input.purpose ? labelFor(input.purpose) : input.fieldKey),
    purpose: input.purpose ?? null,
    question: input.question ?? defaultQuestion(input),
    kind: classifyGap(input),
    required: input.required ?? false,
    inputType: input.inputType ?? 'text',
    options: input.options ?? null,
  }));

  // A gap re-reported on a later page is the same gap. Updating the question
  // rather than ignoring it lets a fill agent sharpen its wording once it has
  // seen the field in context. `excluded` is each conflicting row's own
  // proposed value, not the batch's first row.
  await tx
    .insert(gap)
    .values(values)
    .onConflictDoUpdate({
      target: [gap.applicationId, gap.fieldKey],
      set: {
        question: sql`excluded."question"`,
        required: sql`excluded."required"`,
        inputType: sql`excluded."inputType"`,
        options: sql`excluded."options"`,
      },
    });

  return { created: values.length };
}

export async function openGaps(tx: Tx, applicationId: string) {
  return tx
    .select()
    .from(gap)
    .where(and(eq(gap.applicationId, applicationId), isNull(gap.answeredAt)))
    .orderBy(asc(gap.ordinal));
}

export async function allGaps(tx: Tx, applicationId: string) {
  return tx
    .select()
    .from(gap)
    .where(eq(gap.applicationId, applicationId))
    .orderBy(asc(gap.ordinal));
}

export type GapAnswer = {
  gapId: string;
  value: FactValue;
  /** Who said so. A gap answer without an answerer has no provenance. */
  source: 'caseworker' | 'participant';
  answeredBy: string;
  note?: string;
};

export type AnswerResult = {
  answered: { gapId: string; key: string; label: string }[];
  unknown: string[];
  invalid: { gapId: string; reason: string }[];
  /** Values the caller now has to enter on the page and read back. */
  writes: { fieldKey: string; label: string; value: string }[];
};

/**
 * Turns answers into facts, closes the gaps, and puts each value back onto its
 * field unverified.
 *
 * Knowing a value is not the same as it being on the page, so an answered gap
 * never produces a verified field. The caller enters it and reports a readback
 * like any other write, and the submit gate holds until it does.
 */
export async function answerGaps(
  tx: Tx,
  scope: { tenantId: string; applicationId: string; householdId: string },
  answers: GapAnswer[],
): Promise<AnswerResult> {
  const pending = await allGaps(tx, scope.applicationId);
  const byId = new Map(pending.map((row) => [row.id, row]));
  const result: AnswerResult = { answered: [], unknown: [], invalid: [], writes: [] };

  const existing = await tx
    .select({ ordinal: applicationField.ordinal })
    .from(applicationField)
    .where(eq(applicationField.applicationId, scope.applicationId));
  let nextOrdinal = existing.reduce((max, field) => Math.max(max, field.ordinal), -1) + 1;

  for (const answer of answers) {
    const row = byId.get(answer.gapId);
    if (!row) {
      result.unknown.push(answer.gapId);
      continue;
    }

    // A select's answer has to be an option the form offers, otherwise the
    // write fails on the page after this has reported success.
    if (row.options?.length && typeof answer.value === 'string') {
      if (!row.options.includes(answer.value)) {
        result.invalid.push({
          gapId: answer.gapId,
          reason: `Value is not one of the options this control offers: ${row.options.join(', ')}.`,
        });
        continue;
      }
    }

    // An unclassified control (a clinic picker, say) still gets a fact, keyed
    // to the control itself, so the answer has provenance and the next
    // application on the same form for this household can reuse it.
    const key = row.purpose ?? `control:${row.fieldKey}`;
    const rendered = renderAnswer(answer.value);

    const appended = await appendFacts(tx, scope.tenantId, scope.householdId, [
      {
        key,
        value: answer.value,
        source: answer.source,
        sourceDetail: answer.note ?? `Answered by ${answer.answeredBy} in response to a gap.`,
        confidence: 1,
        confirmedBy: answer.answeredBy,
      },
    ]);
    if (appended.rejected.length > 0) {
      result.invalid.push({ gapId: answer.gapId, reason: appended.rejected[0].reason });
      continue;
    }
    const factId = appended.ids.get(key);
    if (!factId) {
      result.invalid.push({ gapId: answer.gapId, reason: 'The answer could not be stored.' });
      continue;
    }

    // `Gap_answer_has_fact` requires answeredAt and answeredFactId together.
    await tx
      .update(gap)
      .set({ answeredFactId: factId, answeredAt: new Date() })
      .where(and(eq(gap.applicationId, scope.applicationId), eq(gap.id, answer.gapId)));

    if (rendered !== null) {
      await tx
        .insert(applicationField)
        .values({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          ordinal: nextOrdinal++,
          fieldKey: row.fieldKey,
          label: row.label,
          purpose: key,
          value: rendered,
          inputType: row.inputType ?? 'text',
          options: row.options ?? null,
          required: row.required,
          sensitive: row.purpose ? SENSITIVE_FIELDS.has(row.purpose) : false,
          factId,
          source: answer.source,
          sourceDetail: answer.note ?? null,
          verifiedAt: null,
        })
        .onConflictDoUpdate({
          target: [applicationField.applicationId, applicationField.fieldKey],
          set: {
            value: rendered,
            factId,
            source: answer.source,
            sourceDetail: answer.note ?? null,
            verifiedAt: null,
          },
        });
      result.writes.push({ fieldKey: row.fieldKey, label: row.label, value: rendered });
    }

    result.answered.push({ gapId: answer.gapId, key, label: row.label });
  }

  return result;
}

function renderAnswer(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  const text = String(value);
  return text.length === 0 ? null : text;
}
