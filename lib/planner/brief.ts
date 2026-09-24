import type { InventoryField, SourceRef } from './engine';
import type { JevDecision } from './jev';

/**
 * A site hint that names a source already on file is settled before Jev.
 *
 * The same shortcut the planner uses. An uncertain Jev answer does not
 * override a hint the adapter already checked.
 */
export function hintedDecisions(
  decisions: JevDecision[],
  fields: InventoryField[],
  sources: SourceRef[],
  allowedPurposes: Set<string>,
): JevDecision[] {
  const byKey = new Map(decisions.map((decision) => [decision.fieldKey, decision]));
  return fields.map((field) => {
    const hint = field.purposeHint;
    const source = sources.find((item) => item.purpose === hint);
    if (hint && source && !source.sensitive && allowedPurposes.has(hint)) {
      return { fieldKey: field.fieldKey, action: 'map', purpose: hint, confidence: 1 };
    }
    return (
      byKey.get(field.fieldKey) ?? {
        fieldKey: field.fieldKey,
        action: 'uncertain',
        purpose: null,
        confidence: 0,
      }
    );
  });
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'your',
  'what',
  'this',
  'date',
  'name',
  'code',
  'type',
  'line',
]);

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP.has(word)),
  );
}

/**
 * Drops a confident mapping whose label does not share a word with the source.
 *
 * Jev can be sure and still wrong. A signature date is not a date of birth.
 * Those controls go back to Eve as "inspect" rather than as a fill instruction.
 */
export function conservativeDecisions(
  decisions: JevDecision[],
  fields: InventoryField[],
  sources: SourceRef[],
): JevDecision[] {
  const byField = new Map(fields.map((field) => [field.fieldKey, field]));
  const byPurpose = new Map(sources.map((source) => [source.purpose, source]));
  return decisions.map((decision) => {
    if (decision.action !== 'map' || !decision.purpose) return decision;
    const field = byField.get(decision.fieldKey);
    const source = byPurpose.get(decision.purpose);
    if (!field || !source) return { ...decision, action: 'uncertain', purpose: null };
    if (field.purposeHint === decision.purpose) return decision;
    const overlap = [...words(field.label)].some((word) => words(source.label).has(word));
    if (overlap) return decision;
    return { ...decision, action: 'uncertain', purpose: null };
  });
}

/**
 * Text for the Eve cold path.
 *
 * It names controls and decisions only. Participant values are not an input,
 * so they cannot leak into the agent prompt from here.
 */
export function briefForAgent(decisions: JevDecision[], fields: InventoryField[]): string {
  const labels = new Map(fields.map((field) => [field.fieldKey, field.label || field.fieldKey]));
  const lines = ['Jev already classified these controls. Do not invent a value for any of them.'];
  for (const decision of decisions) {
    const label = labels.get(decision.fieldKey) ?? decision.fieldKey;
    if (decision.action === 'map' && decision.purpose) {
      lines.push(`Map "${label}" (${decision.fieldKey}) from the ${decision.purpose} source.`);
    } else if (decision.action === 'ask') {
      lines.push(`Ask the client about "${label}" (${decision.fieldKey}).`);
    } else if (decision.action === 'leave') {
      lines.push(`Leave "${label}" (${decision.fieldKey}) blank.`);
    } else {
      lines.push(`Inspect "${label}" (${decision.fieldKey}). The decision was not confident.`);
    }
  }
  return lines.join('\n');
}
