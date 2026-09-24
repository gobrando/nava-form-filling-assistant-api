import { labelFor } from '@/lib/vocabulary';
import type { PlaybookRow } from './registry';
import type { RepairProposal } from './scribe';

/**
 * Fields a repaired map still has to read back.
 *
 * A write is not done until the page is read. An ordinary text box is not on
 * this list. The list is the boxes that can look finished and be wrong: a
 * maxlength that cuts a ZIP, a mask that rejects a direct write, or a mapped
 * field that does not resolve to one control. No household values.
 */

export type ReadbackReason = 'truncation' | 'mask' | 'unchecked write';

export type ReadbackObligation = {
  fieldKey: string;
  label: string;
  reason: ReadbackReason;
};

export type ReadbackControl = {
  selector: string;
  label: string;
  type: string;
  count: number;
  maxlength?: number;
};

type FieldMapEntry = PlaybookRow['fieldMap'][number];

/**
 * How many characters the field needs before a shorter box is truncation.
 * A ZIP is 5. A mask pattern is as long as the pattern. A name has no
 * minimum here, so a name box is not listed for truncation.
 */
const EXPECTED_LENGTH: Record<string, number> = {
  postalCode: 5,
  businessPostalCode: 5,
  ssn: 9,
  ein: 9,
  phone: 10,
  businessPhone: 10,
  dateOfBirth: 10,
  incorporationDate: 10,
};

const MASK_TYPES = new Set(['password', 'date']);

export function readbackChecklist(
  source: RepairProposal | readonly FieldMapEntry[],
  controls: readonly ReadbackControl[],
): ReadbackObligation[] {
  const fieldMap = Array.isArray(source) ? source : source.fieldMap;
  const bySelector = new Map(controls.map((control) => [control.selector, control]));
  const obligations: ReadbackObligation[] = [];

  for (const entry of fieldMap) {
    const control = bySelector.get(entry.fieldKey);
    const reason = reasonFor(entry, control);
    if (!reason) continue;
    obligations.push({
      fieldKey: entry.fieldKey,
      label: labelOf(entry, control),
      reason,
    });
  }

  return obligations;
}

function reasonFor(
  entry: FieldMapEntry,
  control: ReadbackControl | undefined,
): ReadbackReason | null {
  if (!control || control.count !== 1) return 'unchecked write';
  if (truncates(entry, control)) return 'truncation';
  if (masks(entry, control)) return 'mask';
  return null;
}

function truncates(entry: FieldMapEntry, control: ReadbackControl): boolean {
  if (control.maxlength === undefined) return false;
  const expected = expectedLength(entry);
  if (expected === null) return false;
  return control.maxlength < expected;
}

function masks(entry: FieldMapEntry, control: ReadbackControl): boolean {
  if (entry.mask && entry.mask.trim().length > 0) return true;
  if (entry.method === 'keys') return true;
  if (entry.inputType === 'date') return true;
  return MASK_TYPES.has(control.type.toLowerCase());
}

function expectedLength(entry: FieldMapEntry): number | null {
  if (entry.mask && entry.mask.trim().length > 0) return entry.mask.trim().length;
  if (entry.inputType === 'date') return 10;
  if (entry.purpose && EXPECTED_LENGTH[entry.purpose] !== undefined) {
    return EXPECTED_LENGTH[entry.purpose];
  }
  return null;
}

function labelOf(entry: FieldMapEntry, control: ReadbackControl | undefined): string {
  const observed = control?.label.trim();
  if (observed) return observed;
  if (entry.purpose) return labelFor(entry.purpose);
  const text = entry.fieldKey.replace(/^#/, '').replace(/[-_]+/g, ' ').trim();
  if (!text) return 'This field';
  return text.charAt(0).toUpperCase() + text.slice(1);
}
