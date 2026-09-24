import { recordAudit } from '@/lib/audit';
import type { Tx } from '@/lib/db';
import { playbook } from '@/lib/db/schema';
import { isProtectedField, labelFor } from '@/lib/vocabulary';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { PlaybookRow } from './registry';

/**
 * The deterministic scribe.
 *
 * A failed freshness probe used to mean "call the model." Most site changes
 * are smaller than that: the same questions, new ids. This module places each
 * old field onto the control whose label still says the same thing, and it
 * publishes a new playbook version only when every field lands on exactly one
 * control.
 *
 * It does not see values. An observation is selectors, labels, and counts.
 * The extension may also send `required` and `question` (a fieldset legend,
 * only when it differs from the label). Those are metadata. They are not a
 * value, and they are not used to move a protected field or to break a tie.
 * A protected field (SSN, income, the rest of DO_NOT_DERIVE) moves only on a
 * distinctive word such as "social" or "security", never because a nearby
 * "case number" was the only thing left. A tie is a refusal. Guessing a
 * selector and then trusting it on every later run is the failure this
 * product exists to prevent.
 */

const observedControlFields = z
  .object({
    selector: z.string().min(1).max(500),
    label: z.string().max(240),
    question: z.string().max(240).optional(),
    type: z.string().max(40),
    required: z.boolean().optional(),
    count: z.number().int().min(0).max(50),
  })
  .strict();

/** A `value` key at any depth. The typed text is never copied into an error. */
function carriesValue(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  if (Array.isArray(input)) return input.some((item) => carriesValue(item));
  for (const [key, nested] of Object.entries(input)) {
    if (key === 'value' || carriesValue(nested)) return true;
  }
  return false;
}

export const observedControlSchema = z
  .unknown()
  .superRefine((input, ctx) => {
    if (!carriesValue(input)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An observation included a value.',
    });
  })
  .pipe(observedControlFields);

export type ObservedControl = z.infer<typeof observedControlSchema>;

export type Placement = {
  purpose: string | null;
  fromSelector: string;
  toSelector: string | null;
  disposition: 'kept' | 'moved' | 'unresolved';
  reason: string;
  inputType: string;
  required: boolean;
};

export type RepairProposal = {
  publishable: boolean;
  refused: string | null;
  kept: Placement[];
  moved: Placement[];
  unresolved: Placement[];
  unmapped: { selector: string; label: string; reason: string }[];
  probes: string[];
  fieldMap: PlaybookRow['fieldMap'];
};

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'your',
  'you',
  'what',
  'this',
  'that',
  'from',
  'please',
  'edit',
  'btn',
  'button',
  // Too common to identify a field. "Signature date" is not a date of birth,
  // and "area code" is not a ZIP.
  'date',
  'code',
  'number',
]);

/** Words that show up on too many controls to identify one by themselves. */
const WEAK = new Set(['name', 'status', 'type', 'line', 'address']);

/** Person or entity role. A "first" control is not a "full" control. */
const ROLES = new Set(['first', 'middle', 'last', 'full', 'business']);

/**
 * Words a county form uses that the canonical label does not.
 * "ZIP" and "postal" are the same purpose. "Case number" shares nothing here,
 * which is the point.
 */
const ALIASES: Record<string, readonly string[]> = {
  postalCode: ['zip', 'postal'],
  dateOfBirth: ['birth', 'dob', 'birthday'],
  ssn: ['ssn', 'social', 'security'],
  ein: ['ein', 'employer'],
  phone: ['phone', 'telephone', 'mobile'],
  email: ['email'],
  primaryLanguage: ['language'],
  fullName: ['full'],
  firstName: ['first'],
  lastName: ['last'],
  middleName: ['middle'],
  addressLine1: ['street'],
  addressLine2: ['apartment', 'unit'],
  householdSize: ['household'],
  immigrationStatus: ['immigration'],
  housingStatus: ['housing'],
  income: ['income', 'wages'],
  preferredContact: ['contact'],
  childcare: ['childcare', 'daycare'],
  unemployment: ['unemployment'],
};

const STRONG_WEIGHT = 10;

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP.has(word)),
  );
}

function entryWords(purpose: string | null, fieldKey: string) {
  const basis = purpose
    ? `${labelFor(purpose)} ${purpose.replace(/([a-z])([A-Z])/g, '$1 $2')} ${(ALIASES[purpose] ?? []).join(' ')}`
    : fieldKey.replace(/[#._-]+/g, ' ');
  const all = tokenize(basis);
  return {
    strong: new Set([...all].filter((word) => !WEAK.has(word))),
    weak: new Set([...all].filter((word) => WEAK.has(word))),
    roles: new Set([...all].filter((word) => ROLES.has(word))),
  };
}

function controlWords(control: ObservedControl) {
  // Label only. `question` is the fieldset legend, not a second name for the
  // control, so it cannot place a protected field or choose a side of a tie.
  const all = tokenize(control.label);
  return {
    all,
    roles: new Set([...all].filter((word) => ROLES.has(word))),
  };
}

function normalizeType(type: string): string {
  const value = type.toLowerCase();
  if (value === 'tel' || value === 'email' || value === 'password' || value === 'textarea') {
    return 'text';
  }
  if (value === 'select-one') return 'select';
  return value;
}

function typesCompatible(playbookType: string, observedType: string): boolean {
  const left = normalizeType(playbookType || 'text');
  const right = normalizeType(observedType || 'text');
  if (left === right) return true;
  const choice = new Set(['select', 'radio']);
  if (choice.has(left) && choice.has(right)) return true;
  const textish = new Set(['text', 'number']);
  return textish.has(left) && textish.has(right);
}

function isSubmitLike(control: ObservedControl): boolean {
  const text = `${control.selector} ${control.label}`.toLowerCase();
  return /submit|captcha|sign-?in|log-?in|password/.test(text);
}

function scorePair(
  entry: ReturnType<typeof entryWords>,
  control: ReturnType<typeof controlWords>,
  protectedField: boolean,
): number {
  for (const role of control.roles) {
    if (!entry.roles.has(role)) return 0;
  }
  let strong = 0;
  for (const word of entry.strong) {
    if (control.all.has(word)) strong += 1;
  }
  if (protectedField && strong === 0) return 0;
  let weak = 0;
  if (!protectedField) {
    for (const word of entry.weak) {
      if (control.all.has(word)) weak += 1;
    }
  }
  if (strong === 0 && weak === 0) return 0;
  return strong * STRONG_WEIGHT + weak;
}

/**
 * Places the previous field map onto a redacted observation.
 *
 * A selector that still resolves once is kept, including its mask and method.
 * Anything else needs one control that scores strictly higher than every
 * alternative for that field and for that control. Protected purposes never
 * win on a weak word like "number".
 */
export function proposeRepair(previous: PlaybookRow, observed: ObservedControl[]): RepairProposal {
  const usable = observed.filter((control) => control.count === 1 && !isSubmitLike(control));
  const bySelector = new Map(observed.map((control) => [control.selector, control]));
  const claimed = new Set<number>();
  const kept: Placement[] = [];
  const pending: { index: number; entry: PlaybookRow['fieldMap'][number] }[] = [];

  previous.fieldMap.forEach((entry, index) => {
    const found = bySelector.get(entry.fieldKey);
    const required =
      entry.required === true || (entry.purpose ? isProtectedField(entry.purpose) : false);
    if (
      found &&
      found.count === 1 &&
      !isSubmitLike(found) &&
      typesCompatible(entry.inputType, found.type)
    ) {
      const at = usable.indexOf(found);
      if (at >= 0) claimed.add(at);
      kept.push({
        purpose: entry.purpose,
        fromSelector: entry.fieldKey,
        toSelector: entry.fieldKey,
        disposition: 'kept',
        reason: 'The previous selector still resolves to one control.',
        inputType: entry.inputType,
        required,
      });
      return;
    }
    pending.push({ index, entry });
  });

  const pairs: { pendingIndex: number; controlIndex: number; score: number }[] = [];
  pending.forEach((item, pendingIndex) => {
    const words = entryWords(item.entry.purpose, item.entry.fieldKey);
    const protectedField = item.entry.purpose ? isProtectedField(item.entry.purpose) : false;
    usable.forEach((control, controlIndex) => {
      if (claimed.has(controlIndex)) return;
      if (!typesCompatible(item.entry.inputType, control.type)) return;
      const score = scorePair(words, controlWords(control), protectedField);
      if (score > 0) pairs.push({ pendingIndex, controlIndex, score });
    });
  });

  const moved: Placement[] = [];
  const movedFrom = new Set<number>();
  for (const pair of pairs) {
    const entryTies = pairs.filter(
      (other) => other.pendingIndex === pair.pendingIndex && other.score === pair.score,
    );
    const controlTies = pairs.filter(
      (other) => other.controlIndex === pair.controlIndex && other.score === pair.score,
    );
    const bestEntry = Math.max(
      ...pairs
        .filter((other) => other.pendingIndex === pair.pendingIndex)
        .map((other) => other.score),
    );
    const bestControl = Math.max(
      ...pairs
        .filter((other) => other.controlIndex === pair.controlIndex)
        .map((other) => other.score),
    );
    if (pair.score !== bestEntry || pair.score !== bestControl) continue;
    if (entryTies.length !== 1 || controlTies.length !== 1) continue;
    const item = pending[pair.pendingIndex];
    const control = usable[pair.controlIndex];
    movedFrom.add(pair.pendingIndex);
    claimed.add(pair.controlIndex);
    moved.push({
      purpose: item.entry.purpose,
      fromSelector: item.entry.fieldKey,
      toSelector: control.selector,
      disposition: 'moved',
      reason: `The label "${control.label}" is the only control that still names this field.`,
      inputType: item.entry.inputType,
      required:
        item.entry.required === true ||
        (item.entry.purpose ? isProtectedField(item.entry.purpose) : false),
    });
  }

  const unresolved: Placement[] = pending
    .filter((_, pendingIndex) => !movedFrom.has(pendingIndex))
    .map((item) => ({
      purpose: item.entry.purpose,
      fromSelector: item.entry.fieldKey,
      toSelector: null,
      disposition: 'unresolved' as const,
      reason: item.entry.purpose
        ? `No unique label match for ${item.entry.purpose}. Left unmapped rather than guessed.`
        : 'No unique label match for this unclassified control.',
      inputType: item.entry.inputType,
      required:
        item.entry.required === true ||
        (item.entry.purpose ? isProtectedField(item.entry.purpose) : false),
    }));

  const placedSelectors = new Set(
    [...kept, ...moved].map((placement) => placement.toSelector).filter((selector) => selector),
  );
  const unmapped = usable
    .filter((control) => !placedSelectors.has(control.selector))
    .map((control) => ({
      selector: control.selector,
      label: control.label,
      reason: 'On the page, and not claimed by the previous field map.',
    }));

  const placed = [...kept, ...moved].flatMap((placement) => {
    if (!placement.toSelector) return [];
    const entry = previous.fieldMap.find((item) => item.fieldKey === placement.fromSelector);
    return entry
      ? [
          {
            from: placement.fromSelector,
            to: placement.toSelector,
            required: placement.required,
            entry,
          },
        ]
      : [];
  });

  const oldProbes = new Set(previous.probes);
  const probeSelectors = [
    ...placed.filter((item) => oldProbes.has(item.from) || item.required).map((item) => item.to),
    ...previous.probes.filter((selector) => {
      const found = bySelector.get(selector);
      return found?.count === 1 && !placed.some((item) => item.from === selector);
    }),
  ];
  const probes = [...new Set(probeSelectors)];
  const fieldMap = placed.map((item) => ({ ...item.entry, fieldKey: item.to }));

  let refused: string | null = null;
  if (unresolved.length > 0) {
    const protectedNames = unresolved
      .map((item) => item.purpose)
      .filter((purpose): purpose is string => !!purpose && isProtectedField(purpose));
    const names = unresolved.map((item) => item.purpose ?? item.fromSelector).join(', ');
    refused =
      protectedNames.length > 0
        ? `Refused to guess ${protectedNames.join(', ')}. ${unresolved.length} field(s) had no unique label match (${names}).`
        : `${unresolved.length} field(s) had no unique label match (${names}).`;
  } else if (placed.length === 0) {
    refused = 'No field could be carried forward.';
  } else if (probes.length === 0) {
    refused = 'The repair produced no freshness probe.';
  }

  return {
    publishable: refused === null,
    refused,
    kept,
    moved,
    unresolved,
    unmapped,
    probes: refused === null ? probes : probes,
    fieldMap: refused === null ? fieldMap : fieldMap,
  };
}

function sameEntry(
  left: PlaybookRow['fieldMap'][number],
  right: PlaybookRow['fieldMap'][number],
): boolean {
  return (
    left.fieldKey === right.fieldKey &&
    left.purpose === right.purpose &&
    left.inputType === right.inputType &&
    left.required === right.required &&
    left.method === right.method &&
    left.mask === right.mask
  );
}

function samePlaybook(
  row: PlaybookRow,
  probes: string[],
  fieldMap: PlaybookRow['fieldMap'],
): boolean {
  if (row.probes.length !== probes.length || row.fieldMap.length !== fieldMap.length) return false;
  if (row.probes.some((probe, index) => probe !== probes[index])) return false;
  return row.fieldMap.every((entry, index) => sameEntry(entry, fieldMap[index]));
}

/**
 * Inserts a tenant override at the next version.
 *
 * The shared playbook is left as it was. Another tenant keeps using it, and
 * this tenant's resolution order prefers the override. A second publish of the
 * same map returns the row already on file.
 */
export async function publishRepair(
  tx: Tx,
  tenantId: string,
  principalId: string,
  previous: PlaybookRow,
  proposal: RepairProposal,
): Promise<{ row: PlaybookRow; alreadyCurrent: boolean }> {
  if (!proposal.publishable) {
    throw new Error(proposal.refused ?? 'This repair is not safe to publish.');
  }

  const visible = await tx
    .select()
    .from(playbook)
    .where(and(eq(playbook.domain, previous.domain), eq(playbook.tenantId, tenantId)))
    .orderBy(desc(playbook.version));

  const current = visible.find((row) => samePlaybook(row, proposal.probes, proposal.fieldMap));
  if (current) return { row: current, alreadyCurrent: true };

  const version = Math.max(previous.version, ...visible.map((row) => row.version), 0) + 1;
  const [row] = await tx
    .insert(playbook)
    .values({
      tenantId,
      domain: previous.domain,
      programIds: previous.programIds,
      version,
      name: previous.name,
      probes: proposal.probes,
      fieldMap: proposal.fieldMap,
      safeAdvanceRules: previous.safeAdvanceRules,
      autoAdvance: previous.autoAdvance,
      note: `Repaired from version ${previous.version} by the deterministic scribe. ${proposal.kept.length} selectors kept, ${proposal.moved.length} moved. No model.`,
      staleAt: null,
      staleReason: null,
    })
    .returning();

  await recordAudit(tx, {
    tenantId,
    type: 'playbook_repaired',
    principalId,
    outcome: 'script',
    details: {
      fieldCount: proposal.kept.length + proposal.moved.length,
      verifiedCount: proposal.kept.length,
      gapCount: proposal.unresolved.length,
      blockedCount: proposal.unresolved.filter(
        (item) => item.purpose && isProtectedField(item.purpose),
      ).length,
      pageCount: proposal.unmapped.length,
    },
  });

  return { row, alreadyCurrent: false };
}
