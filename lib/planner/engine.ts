/**
 * The same three planning roles the Chrome extension runs on Gemini Nano.
 *
 * The extension keeps actuation in the caseworker's tab, because that is the
 * only place with the county session. Planning can run here instead: the
 * extension sends a redacted field inventory and the names of available
 * sources, never the values, and this module returns the same plan shape
 * `NavaAgenticPlanner.plan` returns. The extension still re-validates before
 * any DOM write.
 */

export const PLANNER_ROLES = ['field_mapper', 'gap_analyst', 'form_reviewer'] as const;
export type PlannerRole = (typeof PLANNER_ROLES)[number];

export const SYSTEM_PROMPTS: Record<PlannerRole, string> = {
  field_mapper: `You are the field-mapping agent in Nava's form-completion system.
Map visible form controls to the supplied canonical source purposes. Work from labels,
questions, types, option text, and exact site hints. Never invent a source purpose.
Never use value shape to reinterpret an identifier. Keep different people and entities
separate. A case number is not a Social Security Number. When uncertain, omit the
mapping. Do not propose submit, signature, certification, CAPTCHA, login, payment, or
one-time-code actions. Return only schema-constrained data.`,
  gap_analyst: `You are the gap-analysis agent in Nava's form-completion system.
Identify visible required fields and decisions that have no safe source mapping. Ask for
the value in plain language. Do not guess eligibility, protected, identity, income,
household, immigration, housing, childcare, unemployment, contact-preference, SSN, or
EIN answers. Do not ask browser or selector questions. Return only schema-constrained
data.`,
  form_reviewer: `You are the independent form-review agent in Nava's form-completion
system. Review another agent's proposed field mappings against the visible field
inventory and the allowlisted source purposes. Approve only mappings supported by the
field's label, question, type, option text, or exact site hint. Reject ambiguity,
repeated-person leakage, identifier substitution, and any mapping to a source purpose
that is unavailable. Do not approve final actions or bot challenges. Return only
schema-constrained data.`,
};

export type InventoryField = {
  fieldKey: string;
  type: string;
  label: string;
  question: string;
  required: boolean;
  alreadyFilled: boolean;
  purposeHint: string;
  options: string[];
};

export type SourceRef = {
  purpose: string;
  label: string;
  kind: string;
  sensitive: boolean;
};

export type MappingProposal = {
  fieldKey: string;
  purpose: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

export type ProposedGap = {
  fieldKey: string;
  question: string;
  reason: string;
};

export type ReviewDecision = {
  fieldKey: string;
  purpose: string;
  reason: string;
};

export type PlanInput = {
  page: { domain: string };
  fields: InventoryField[];
  sources: SourceRef[];
  /** Canonical purposes a site adapter is allowed to hint. */
  allowedPurposes: ReadonlySet<string>;
};

export type ValidatedPlan = {
  purposeOverrides: Record<string, string>;
  approved: { fieldKey: string; purpose: string; reason: string; source?: string }[];
  rejected: ReviewDecision[];
  trustedHintMappings: number;
  gaps: ProposedGap[];
};

export function mappingPrompt(input: PlanInput): string {
  return JSON.stringify({
    task: 'Map each safely understood form field to one available source purpose. Omit uncertain mappings.',
    page: { domain: input.page.domain },
    availableSources: input.sources,
    fields: input.fields,
  });
}

export function gapPrompt(input: PlanInput): string {
  return JSON.stringify({
    task: 'Find required fields or explicit decisions that lack a safe available source. Ask plain-language questions only for those gaps.',
    page: { domain: input.page.domain },
    availableSourcePurposes: input.sources.map((source) => source.purpose),
    fields: input.fields,
  });
}

export function reviewPrompt(
  input: PlanInput,
  mapping: { mappings: MappingProposal[] },
  gaps: { gaps: ProposedGap[] },
): string {
  return JSON.stringify({
    task: 'Independently approve or reject every proposed mapping. Approved pairs must exactly reuse a proposed fieldKey and purpose.',
    page: { domain: input.page.domain },
    availableSources: input.sources,
    fields: input.fields,
    proposedMappings: mapping.mappings,
    proposedGaps: gaps.gaps,
  });
}

function compactText(value: unknown, limit = 280): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * The extension's local policy validator, ported so a hosted model cannot
 * approve a mapping the on-device runtime would have rejected.
 */
export function validateReview(
  fields: InventoryField[],
  sources: SourceRef[],
  mapping: { mappings?: MappingProposal[] },
  review: { approved?: ReviewDecision[]; rejected?: ReviewDecision[] },
  allowedPurposes: ReadonlySet<string>,
): Omit<ValidatedPlan, 'gaps'> {
  const fieldKeys = new Set(fields.map((field) => field.fieldKey));
  const sourceKeys = new Set(sources.map((source) => source.purpose));
  const proposed = new Map(
    (mapping.mappings ?? []).map((item) => [`${item.fieldKey}\u0000${item.purpose}`, item]),
  );
  const purposeOverrides: Record<string, string> = {};
  const approved: ValidatedPlan['approved'] = [];
  const rejected: ReviewDecision[] = [...(review.rejected ?? [])];

  for (const item of review.approved ?? []) {
    const fieldKey = String(item.fieldKey || '');
    const purpose = String(item.purpose || '');
    const pair = `${fieldKey}\u0000${purpose}`;
    const proposal = proposed.get(pair);
    if (
      !fieldKeys.has(fieldKey) ||
      !sourceKeys.has(purpose) ||
      !proposal ||
      proposal.confidence === 'low' ||
      purposeOverrides[fieldKey]
    ) {
      rejected.push({
        fieldKey,
        purpose,
        reason:
          'The local policy validator rejected an unknown, unavailable, unproposed, low-confidence, or duplicate mapping.',
      });
      continue;
    }
    purposeOverrides[fieldKey] = purpose;
    approved.push({ fieldKey, purpose, reason: compactText(item.reason) });
  }

  let trustedHintMappings = 0;
  for (const field of fields) {
    const fieldKey = String(field.fieldKey || '');
    const purpose = String(field.purposeHint || '');
    if (!fieldKey || !purpose || purposeOverrides[fieldKey] || !allowedPurposes.has(purpose)) {
      continue;
    }
    purposeOverrides[fieldKey] = purpose;
    trustedHintMappings += 1;
    approved.push({
      fieldKey,
      purpose,
      reason: sourceKeys.has(purpose)
        ? 'Approved by the versioned site adapter and limited to an available source purpose.'
        : 'Approved by the versioned site adapter so the missing source answer becomes an explicit gap.',
      source: 'site-adapter',
    });
  }

  return { purposeOverrides, approved, rejected, trustedHintMappings };
}

export function validateGaps(
  fields: InventoryField[],
  sources: SourceRef[],
  gaps: { gaps?: ProposedGap[] },
  purposeOverrides: Record<string, string>,
): ProposedGap[] {
  const available = new Set(sources.map((source) => source.purpose));
  return (gaps.gaps ?? [])
    .filter((gap) => {
      const field = fields.find((candidate) => candidate.fieldKey === gap.fieldKey);
      const mapped = field ? purposeOverrides[field.fieldKey] : undefined;
      return (
        field &&
        !field.alreadyFilled &&
        !(mapped && available.has(mapped)) &&
        (field.required || field.options.length > 0 || field.type === 'checkbox')
      );
    })
    .map((gap) => ({
      fieldKey: String(gap.fieldKey),
      question: compactText(gap.question),
      reason: compactText(gap.reason),
    }));
}
