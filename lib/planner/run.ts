import { FIELD_KEYS, SENSITIVE_FIELDS } from '@/lib/vocabulary';
import {
  type InventoryField,
  type MappingProposal,
  PLANNER_ROLES,
  type PlanInput,
  type ProposedGap,
  SYSTEM_PROMPTS,
  type SourceRef,
  type ValidatedPlan,
  gapPrompt,
  mappingPrompt,
  reviewPrompt,
  validateGaps,
  validateReview,
} from './engine';
import { type JevDecision, estimateJevCostUsd } from './jev';
import { type ComparisonModelId, estimateCostUsd } from './score';

export type Completer = (request: {
  role: (typeof PLANNER_ROLES)[number];
  system: string;
  prompt: string;
}) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

export type PlanRun = ValidatedPlan & {
  metadata: {
    runtime: string;
    mode: 'gateway-multi-agent';
    model: ComparisonModelId;
    agents: typeof PLANNER_ROLES;
    proposedMappings: number;
    approvedMappings: number;
    rejectedMappings: number;
    trustedHintMappings: number;
    usage: {
      prompts: number;
      inputTokens: number;
      outputTokens: number;
      apiCostUsd: number | null;
    };
    jev: {
      model: string;
      decided: number;
      deferred: number;
      inputTokens: number;
      apiCostUsd: number;
    } | null;
    summary: string;
  };
};

type MappingBody = { mappings?: MappingProposal[] };

function parseJson(text: string, label: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  try {
    return JSON.parse(slice);
  } catch {
    throw new Error(`The ${label} agent returned an unreadable plan. No form values were changed.`);
  }
}

type JevContext = { model: string; decisions: JevDecision[]; inputTokens: number };

function settledPlan(
  input: PlanInput,
  decisions: JevDecision[],
): {
  mappings: MappingProposal[];
  gaps: ProposedGap[];
  deferred: InventoryField[];
} {
  const byKey = new Map(decisions.map((decision) => [decision.fieldKey, decision]));
  const mappings: MappingProposal[] = [];
  const gaps: ProposedGap[] = [];
  const deferred: InventoryField[] = [];
  for (const field of input.fields) {
    const hint = field.purposeHint;
    if (
      hint &&
      input.allowedPurposes.has(hint) &&
      input.sources.some((source) => source.purpose === hint)
    ) {
      mappings.push({
        fieldKey: field.fieldKey,
        purpose: hint,
        confidence: 'high',
        reason: 'The site adapter already named a source that is on file.',
      });
      continue;
    }
    const decision = byKey.get(field.fieldKey);
    if (!decision || decision.action === 'uncertain') {
      deferred.push(field);
      continue;
    }
    if (decision.action === 'map' && decision.purpose) {
      mappings.push({
        fieldKey: field.fieldKey,
        purpose: decision.purpose,
        confidence: 'high',
        reason: 'Jev matched this label to an available source.',
      });
    }
    if (decision.action === 'ask') {
      gaps.push({
        fieldKey: field.fieldKey,
        question: field.question || field.label,
        reason: 'Jev found no matching source for a control the client has to answer.',
      });
    }
  }
  return { mappings, gaps, deferred };
}

async function runGenerativePlan(
  input: PlanInput,
  model: ComparisonModelId,
  complete: Completer,
): Promise<PlanRun> {
  const [mappingResult, gapResult] = await Promise.all([
    complete({
      role: 'field_mapper',
      system: SYSTEM_PROMPTS.field_mapper,
      prompt: mappingPrompt(input),
    }),
    complete({
      role: 'gap_analyst',
      system: SYSTEM_PROMPTS.gap_analyst,
      prompt: gapPrompt(input),
    }),
  ]);
  const mapping = parseJson(mappingResult.text, 'field-mapping') as MappingBody;
  const gaps = parseJson(gapResult.text, 'gap-analysis') as { gaps?: ProposedGap[] };
  const reviewResult = await complete({
    role: 'form_reviewer',
    system: SYSTEM_PROMPTS.form_reviewer,
    prompt: reviewPrompt(input, { mappings: mapping.mappings ?? [] }, { gaps: gaps.gaps ?? [] }),
  });
  const review = parseJson(reviewResult.text, 'form-review') as {
    approved?: { fieldKey: string; purpose: string; reason: string }[];
    rejected?: { fieldKey: string; purpose: string; reason: string }[];
    summary?: string;
  };
  const validated = validateReview(
    input.fields,
    input.sources,
    { mappings: mapping.mappings ?? [] },
    review,
    input.allowedPurposes,
  );
  const validatedGaps = validateGaps(input.fields, input.sources, gaps, validated.purposeOverrides);
  const inputTokens = mappingResult.inputTokens + gapResult.inputTokens + reviewResult.inputTokens;
  const outputTokens =
    mappingResult.outputTokens + gapResult.outputTokens + reviewResult.outputTokens;
  return {
    ...validated,
    gaps: validatedGaps,
    metadata: {
      runtime: `gateway:${model}`,
      mode: 'gateway-multi-agent',
      model,
      agents: PLANNER_ROLES,
      proposedMappings: mapping.mappings?.length ?? 0,
      approvedMappings: validated.approved.length,
      rejectedMappings: validated.rejected.length,
      trustedHintMappings: validated.trustedHintMappings,
      usage: {
        prompts: 3,
        inputTokens,
        outputTokens,
        apiCostUsd: estimateCostUsd(model, { inputTokens, outputTokens }),
      },
      jev: null,
      summary: String(review.summary ?? '').slice(0, 400),
    },
  };
}

function finishJevPlan(
  input: PlanInput,
  model: ComparisonModelId,
  settled: { mappings: MappingProposal[]; gaps: ProposedGap[]; deferred: InventoryField[] },
  jev: JevContext,
  generative: PlanRun | null,
): PlanRun {
  const mappings = settled.mappings;
  const review = {
    approved: mappings.map((item) => ({
      fieldKey: item.fieldKey,
      purpose: item.purpose,
      reason: item.reason,
    })),
    rejected: [],
    summary:
      generative?.metadata.summary ??
      'Jev decided the missing fields. A larger model was not needed.',
  };
  const validated = validateReview(
    input.fields,
    input.sources,
    { mappings },
    review,
    input.allowedPurposes,
  );
  if (generative) {
    for (const [fieldKey, purpose] of Object.entries(generative.purposeOverrides)) {
      if (!validated.purposeOverrides[fieldKey]) validated.purposeOverrides[fieldKey] = purpose;
    }
    for (const item of generative.approved) {
      if (!validated.approved.some((existing) => existing.fieldKey === item.fieldKey)) {
        validated.approved.push(item);
      }
    }
    validated.rejected.push(...generative.rejected);
    validated.trustedHintMappings += generative.trustedHintMappings;
  }
  const gaps = validateGaps(
    input.fields,
    input.sources,
    { gaps: [...settled.gaps, ...(generative?.gaps ?? [])] },
    validated.purposeOverrides,
  );
  const generativeCost = generative?.metadata.usage.apiCostUsd;
  const jevCost = estimateJevCostUsd(jev.inputTokens);
  const apiCostUsd =
    generative && (generativeCost === null || generativeCost === undefined)
      ? null
      : jevCost + (generativeCost ?? 0);
  return {
    ...validated,
    gaps,
    metadata: {
      runtime: generative ? `jev+${model}` : `jev:${jev.model}`,
      mode: 'gateway-multi-agent',
      model,
      agents: PLANNER_ROLES,
      proposedMappings: mappings.length + (generative?.metadata.proposedMappings ?? 0),
      approvedMappings: validated.approved.length,
      rejectedMappings: validated.rejected.length,
      trustedHintMappings: validated.trustedHintMappings,
      usage: {
        prompts: generative?.metadata.usage.prompts ?? 0,
        inputTokens: jev.inputTokens + (generative?.metadata.usage.inputTokens ?? 0),
        outputTokens: generative?.metadata.usage.outputTokens ?? 0,
        apiCostUsd,
      },
      jev: {
        model: jev.model,
        decided: settled.mappings.length + settled.gaps.length,
        deferred: settled.deferred.length,
        inputTokens: jev.inputTokens,
        apiCostUsd: jevCost,
      },
      summary: review.summary,
    },
  };
}

/**
 * Plans one page. When Jev decisions are present, confident field choices skip
 * the generative mapper and gap analyst. Uncertain controls still go through
 * the three-role planner. The local validator runs either way.
 */
export async function runPlan(
  input: PlanInput,
  model: ComparisonModelId,
  complete: Completer,
  jev?: JevContext | null,
): Promise<PlanRun> {
  if (!jev) return runGenerativePlan(input, model, complete);
  const settled = settledPlan(input, jev.decisions);
  const generative =
    settled.deferred.length > 0
      ? await runGenerativePlan({ ...input, fields: settled.deferred }, model, complete)
      : null;
  return finishJevPlan(input, model, settled, jev, generative);
}

export function allowedPurposeSet(): Set<string> {
  return new Set(FIELD_KEYS);
}

export function sensitivePurpose(purpose: string): boolean {
  return SENSITIVE_FIELDS.has(purpose);
}

export type { InventoryField, SourceRef };
