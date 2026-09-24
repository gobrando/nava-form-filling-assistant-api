import { labelFor } from '@/lib/vocabulary';
import { z } from 'zod';
import {
  type ObservedControl,
  type Placement,
  type RepairProposal,
  observedControlSchema,
} from './scribe';

/**
 * What the model scribe is allowed to see after the deterministic pass refuses.
 *
 * `proposeRepair` already decided the map is not safe to publish. This brief
 * names the fields it left open, in the same words the caseworker desk uses:
 * a tie, a protected field that would land on the wrong label, a missing
 * label, or a field that was dropped. It also names labels that collided and
 * controls that were left unmapped.
 *
 * Counts, field keys, and labels only. An observation that carries a value is
 * rejected, and the error does not repeat that value. The brief does not
 * publish, and it does not start a model.
 */

export const REFUSAL_RULES = [
  'Do not infer protected fields.',
  'Do not submit.',
  'Readback is still required for anything that does get filled.',
] as const;

const MODEL_NOT_REQUIRED = 'The model is not required for the map.';

const REASON = {
  tie: 'tie',
  protected: 'protected field would land on the wrong label',
  missing: 'label missing',
  dropped: 'field dropped',
} as const;

export type RefusalReason = (typeof REASON)[keyof typeof REASON];

export type RefusalControl = {
  selector: string;
  label: string;
  count: number;
};

export type UnresolvedBriefField = {
  fieldKey: string;
  purpose: string | null;
  label: string;
  reason: RefusalReason;
  detail: string;
  controls: RefusalControl[];
};

export type LabelCollision = {
  label: string;
  controls: RefusalControl[];
};

export type RefusalBrief = {
  modelRequired: true;
  text: string;
  unresolved: UnresolvedBriefField[];
  collisions: LabelCollision[];
  unmapped: RefusalControl[];
  rules: typeof REFUSAL_RULES;
};

export type RepairModelBrief = { modelRequired: false; text: string } | RefusalBrief;

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
  'date',
  'code',
  'number',
]);

/** Same aliases the desk uses when it explains a refusal the scribe already made. */
const ALIASES: Record<string, string> = {
  postalCode: 'zip postal',
  dateOfBirth: 'birth dob birthday',
  ssn: 'ssn social security',
  ein: 'ein employer',
  phone: 'phone telephone mobile',
  email: 'email',
  primaryLanguage: 'language',
  fullName: 'full',
  firstName: 'first',
  lastName: 'last',
  addressLine1: 'street',
  income: 'income wages',
  childcare: 'childcare daycare',
  unemployment: 'unemployment',
  preferredContact: 'contact',
};

const DECOY = /case number|medi-cal number|record id/i;

const observationSchema = z.array(observedControlSchema);

export function refusalBrief(proposal: RepairProposal, observed: unknown): RepairModelBrief {
  const parsed = observationSchema.safeParse(observed);
  if (!parsed.success) {
    throw new Error(
      'An observation included a value. The scribe only reads selectors, labels, types, and counts.',
    );
  }
  if (proposal.publishable) return { modelRequired: false, text: MODEL_NOT_REQUIRED };

  const controls = parsed.data;
  const unresolved = proposal.unresolved.map((placement) => explainField(placement, controls));
  const collisions = labelCollisions(controls);
  const unmapped = unmappedControls(proposal, controls);
  const brief: RefusalBrief = {
    modelRequired: true,
    text: '',
    unresolved,
    collisions,
    unmapped,
    rules: REFUSAL_RULES,
  };
  brief.text = briefText(proposal.refused, brief);
  return brief;
}

/**
 * The dry-run body includes a brief only when the map was refused.
 * A publishable proposal omits it: the model is not required for that map.
 */
export function briefForDryRun(proposal: RepairProposal, observed: unknown): RefusalBrief | null {
  const brief = refusalBrief(proposal, observed);
  return brief.modelRequired ? brief : null;
}

function explainField(placement: Placement, observed: ObservedControl[]): UnresolvedBriefField {
  const usable = observed.filter(
    (control) => control.count === 1 && control.label.trim() && !isSubmitLike(control),
  );
  const wanted = fieldWords(placement);
  const counts = new Map<string, number>();
  for (const control of usable) {
    const key = control.label.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const tieKey = [...counts.keys()].find((key) => {
    if ((counts.get(key) ?? 0) < 2) return false;
    const sample = usable.find((control) => control.label.trim().toLowerCase() === key);
    return sample ? words(sample.label).some((word) => wanted.has(word)) : false;
  });
  if (tieKey) {
    return field(placement, 'tie', controlsWithLabel(usable, tieKey), 'tie');
  }

  const named = usable.some((control) => words(control.label).some((word) => wanted.has(word)));
  const decoys = usable.filter((control) => DECOY.test(control.label));
  if (!named && (placement.purpose === 'ssn' || placement.purpose === 'ein') && decoys.length > 0) {
    return field(placement, 'protected', decoys.map(listed), 'decoy');
  }

  const stale = observed.find(
    (control) =>
      control.selector === placement.fromSelector && control.count !== 1 && !isSubmitLike(control),
  );
  if (stale) return field(placement, 'dropped', [listed(stale)], 'ambiguous');
  if (!named) return field(placement, 'missing', [], 'missing');

  const overlapped = usable.filter((control) =>
    words(control.label).some((word) => wanted.has(word)),
  );
  return field(placement, 'dropped', overlapped.map(listed), 'overlap');
}

function field(
  placement: Placement,
  kind: keyof typeof REASON,
  controls: RefusalControl[],
  wording: 'tie' | 'decoy' | 'ambiguous' | 'missing' | 'overlap',
): UnresolvedBriefField {
  const reason = REASON[kind];
  return {
    fieldKey: placement.fromSelector,
    purpose: placement.purpose,
    label: placement.purpose ? labelFor(placement.purpose) : humanize(placement.fromSelector),
    reason,
    detail: sentence(reason, controls, wording),
    controls,
  };
}

function sentence(
  reason: RefusalReason,
  controls: RefusalControl[],
  wording: 'tie' | 'decoy' | 'ambiguous' | 'missing' | 'overlap',
): string {
  if (wording === 'missing') return `${reason}. No label on this page names it.`;
  const named = describeAll(controls);
  if (wording === 'ambiguous') {
    return `${reason}. ${named} no longer resolves to one control.`;
  }
  if (wording === 'overlap') {
    const verb =
      controls.length === 1 ? 'does not name it by itself' : 'do not name it by themselves';
    return `${reason}. ${named} ${verb}.`;
  }
  if (wording === 'decoy') {
    const verb = controls.length === 1 ? 'does not name it' : 'do not name it';
    return `${reason}. ${named} ${verb}.`;
  }
  return `${reason}. ${named}.`;
}

function labelCollisions(observed: ObservedControl[]): LabelCollision[] {
  const groups = new Map<string, LabelCollision>();
  for (const control of observed) {
    if (control.count !== 1 || !control.label.trim() || isSubmitLike(control)) continue;
    const key = control.label.trim().toLowerCase();
    const group = groups.get(key) ?? { label: control.label.trim(), controls: [] };
    group.controls.push(listed(control));
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.controls.length > 1);
}

function unmappedControls(proposal: RepairProposal, observed: ObservedControl[]): RefusalControl[] {
  const bySelector = new Map(observed.map((control) => [control.selector, control]));
  return proposal.unmapped.map((control) => {
    const found = bySelector.get(control.selector);
    return {
      selector: control.selector,
      label: control.label.trim(),
      count: found?.count ?? 0,
    };
  });
}

function briefText(refused: string | null, brief: RefusalBrief): string {
  const lines = [
    'The deterministic scribe refused this map. A model would still have to decide the fields below. Do not override a refusal by guessing.',
    ...brief.rules,
  ];
  if (refused) lines.push(refused);
  lines.push('', 'Unresolved:');
  if (brief.unresolved.length === 0) lines.push('- None.');
  for (const field of brief.unresolved) {
    const key = field.purpose ? `${field.fieldKey}, ${field.purpose}` : field.fieldKey;
    lines.push(`- ${field.label} (${key}): ${field.detail}`);
  }
  lines.push('', 'Labels that collided:');
  if (brief.collisions.length === 0) lines.push('- None.');
  for (const collision of brief.collisions) {
    lines.push(`- "${collision.label}" on ${describeAll(collision.controls)}.`);
  }
  lines.push('', 'Left unmapped:');
  if (brief.unmapped.length === 0) lines.push('- None.');
  for (const control of brief.unmapped) {
    lines.push(`- ${describeControl(control)}.`);
  }
  return lines.join('\n');
}

function controlsWithLabel(controls: ObservedControl[], key: string): RefusalControl[] {
  return controls.filter((control) => control.label.trim().toLowerCase() === key).map(listed);
}

function listed(control: ObservedControl): RefusalControl {
  return {
    selector: control.selector,
    label: control.label.trim(),
    count: control.count,
  };
}

function describeControl(control: RefusalControl): string {
  const label = control.label.trim() || 'No label';
  return `"${label}" (${control.selector}, count ${control.count})`;
}

function describeAll(controls: RefusalControl[]): string {
  if (controls.length === 0) return 'nothing';
  if (controls.length === 1) return describeControl(controls[0] as RefusalControl);
  const rest = controls.slice(0, -1).map(describeControl);
  return `${rest.join(', ')} and ${describeControl(controls[controls.length - 1] as RefusalControl)}`;
}

function fieldWords(placement: Placement): Set<string> {
  const purpose = placement.purpose;
  const base = purpose
    ? `${labelFor(purpose)} ${purpose.replace(/([a-z])([A-Z])/g, '$1 $2')} ${ALIASES[purpose] ?? ''}`
    : placement.fromSelector.replace(/[#._-]+/g, ' ');
  return new Set(words(base));
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

function humanize(selector: string): string {
  const text = selector.replace(/^#/, '').replace(/[-_]+/g, ' ').trim();
  if (!text) return 'This field';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isSubmitLike(control: ObservedControl): boolean {
  const text = `${control.selector} ${control.label}`.toLowerCase();
  return /submit|captcha|sign-?in|log-?in|password/.test(text);
}
