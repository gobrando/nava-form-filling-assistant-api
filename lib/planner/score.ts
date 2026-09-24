/**
 * Kalen's five-model comparison, scored the way the product is judged:
 * cost per verified plan, and confidently-wrong fields — with a hard failure
 * when the wrong field is sensitive.
 *
 * Prices are standard list rates (not batch, not cache) as published in
 * September 2026. Anthropic: platform.claude.com pricing. OpenAI: the gpt-5.1
 * and gpt-5-mini model pages. A cache hit would be cheaper; this estimate
 * assumes none.
 */

export const COMPARISON_MODELS = [
  {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    inputPerMillion: 5,
    outputPerMillion: 25,
  },
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    inputPerMillion: 5,
    outputPerMillion: 25,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
  {
    id: 'gpt-5.1',
    provider: 'openai',
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    inputPerMillion: 0.25,
    outputPerMillion: 2,
  },
] as const;

export type ComparisonModelId = (typeof COMPARISON_MODELS)[number]['id'];
export type ComparisonProvider = (typeof COMPARISON_MODELS)[number]['provider'];

export function comparisonModel(id: string) {
  return COMPARISON_MODELS.find((model) => model.id === id) ?? null;
}

export function estimateCostUsd(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const model = comparisonModel(modelId);
  if (!model) return null;
  return (
    (usage.inputTokens * model.inputPerMillion + usage.outputTokens * model.outputPerMillion) /
    1_000_000
  );
}

export type GoldCase = {
  id: string;
  /** fieldKey -> purpose that should be approved. */
  mappings: Record<string, string>;
  /** Fields that must be asked, not filled. */
  gapFieldKeys: string[];
  sensitivePurposes: string[];
  /** Controls that hold an identifier. Mapping one to the wrong purpose counts. */
  sensitiveFieldKeys: string[];
};

export type Score = {
  correctMappings: number;
  wrongConfident: number;
  sensitiveWrong: number;
  missedGaps: number;
  extraGaps: number;
  reviewReady: boolean;
  costUsd: number | null;
};

/**
 * A mapping is wrong-confident when the plan approved a purpose that is not
 * the gold purpose. Sensitive purposes (SSN, EIN) count again on their own,
 * because that rate has a zero tolerance.
 */
export function scorePlan(
  gold: GoldCase,
  plan: { purposeOverrides: Record<string, string>; gaps: { fieldKey: string }[] },
  costUsd: number | null,
): Score {
  const sensitive = new Set(gold.sensitivePurposes);
  let correctMappings = 0;
  let wrongConfident = 0;
  let sensitiveWrong = 0;

  const sensitiveFields = new Set(gold.sensitiveFieldKeys);
  for (const [fieldKey, purpose] of Object.entries(plan.purposeOverrides)) {
    const expected = gold.mappings[fieldKey];
    if (expected === purpose) {
      correctMappings += 1;
      continue;
    }
    wrongConfident += 1;
    if (sensitive.has(purpose) || sensitive.has(expected ?? '') || sensitiveFields.has(fieldKey)) {
      sensitiveWrong += 1;
    }
  }

  const asked = new Set(plan.gaps.map((gap) => gap.fieldKey));
  let missedGaps = 0;
  for (const fieldKey of gold.gapFieldKeys) {
    const mappedToAvailable = plan.purposeOverrides[fieldKey] === gold.mappings[fieldKey];
    if (!asked.has(fieldKey) && !mappedToAvailable) missedGaps += 1;
  }
  let extraGaps = 0;
  for (const fieldKey of asked) {
    if (!gold.gapFieldKeys.includes(fieldKey) && gold.mappings[fieldKey]) extraGaps += 1;
  }

  const everyMappingPresent = Object.entries(gold.mappings).every(
    ([fieldKey, purpose]) => plan.purposeOverrides[fieldKey] === purpose,
  );

  return {
    correctMappings,
    wrongConfident,
    sensitiveWrong,
    missedGaps,
    extraGaps,
    reviewReady: everyMappingPresent && missedGaps === 0 && sensitiveWrong === 0,
    costUsd,
  };
}
