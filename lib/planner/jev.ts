import type { InventoryField, PlanInput } from './engine';

/**
 * Typed decisions for the cheap part of planning.
 *
 * Kaylyn's IHSS runs got cheaper and cleaner when Jev, not the generative
 * model, decided which fields were missing. This asks that once, for every
 * control, against labels and source names only. Values never enter the state.
 * A sensitive control is left alone even if Jev names a source for it.
 * Anything below the confidence line is handed back to the generative planner.
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0';
export const JEV_CONFIDENT = 0.8;
/** TypeSafe list price, September 2026. Output tokens are not billed. */
export const JEV_INPUT_PER_MILLION = 0.042;

export type JevAction = 'map' | 'ask' | 'leave' | 'uncertain';

export type JevDecision = {
  fieldKey: string;
  action: JevAction;
  purpose: string | null;
  confidence: number;
};

export type JevPass = {
  model: string;
  decisions: JevDecision[];
  inputTokens: number;
  outputTokens: number;
};

type ChoiceAnswer = { type?: string; choice?: string; confidence?: number };

export function jevKey(): string | null {
  return process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim() || null;
}

export function estimateJevCostUsd(inputTokens: number): number {
  return (inputTokens * JEV_INPUT_PER_MILLION) / 1_000_000;
}

export function sensitiveControl(field: InventoryField): boolean {
  const text = `${field.label} ${field.question} ${field.fieldKey}`;
  return /social security|\bssn\b|taxpayer|employer identification|\bein\b|medi-cal number|\bcin\b/i.test(
    text,
  );
}

export function interpretDecisions(
  input: PlanInput,
  answers: Record<string, ChoiceAnswer>,
): JevDecision[] {
  const sources = new Set(
    input.sources.filter((source) => !source.sensitive).map((source) => source.purpose),
  );
  return input.fields.map((field, index) => {
    if (sensitiveControl(field)) {
      return { fieldKey: field.fieldKey, action: 'leave', purpose: null, confidence: 1 };
    }
    const answer = answers[`f${index}`];
    const choice = String(answer?.choice ?? '');
    const confidence = Number(answer?.confidence ?? 0);
    if (answer?.type !== 'choice' || confidence < JEV_CONFIDENT) {
      return { fieldKey: field.fieldKey, action: 'uncertain', purpose: null, confidence };
    }
    if (choice === 'ask' && (field.required || field.options.length > 0)) {
      return { fieldKey: field.fieldKey, action: 'ask', purpose: null, confidence };
    }
    if (choice === 'leave') {
      return { fieldKey: field.fieldKey, action: 'leave', purpose: null, confidence };
    }
    if (sources.has(choice) && input.allowedPurposes.has(choice)) {
      return { fieldKey: field.fieldKey, action: 'map', purpose: choice, confidence };
    }
    return { fieldKey: field.fieldKey, action: 'uncertain', purpose: null, confidence };
  });
}

export async function decideFields(input: PlanInput): Promise<JevPass | null> {
  const key = jevKey();
  if (!key || input.fields.length === 0) return null;
  const criteria: Record<string, string> = {
    ask: 'No source matches. The client has to answer this.',
    leave: 'Leave this control blank. Do not ask.',
  };
  for (const source of input.sources) {
    if (source.sensitive || !input.allowedPurposes.has(source.purpose)) continue;
    criteria[source.purpose] = source.label || source.purpose;
  }
  const questions: Record<string, unknown> = {};
  input.fields.forEach((field, index) => {
    const options = field.options.length ? field.options.join(', ') : 'none';
    questions[`f${index}`] = {
      type: 'choice',
      instructions: `This control is labeled "${field.label}". It is a ${field.type}, ${field.required ? 'required' : 'optional'}, with options: ${options}. Which source matches that label? Choose ask when the client must supply it. Choose leave for an identifier or anything that should stay blank.`,
      criteria,
    };
  });
  const state = {
    domain: input.page.domain,
    fields: input.fields.map((field) => ({
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options,
    })),
  };
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  if (!response.ok) {
    throw new Error(
      `Jev returned ${response.status}. The generative planner will decide this page.`,
    );
  }
  const body = (await response.json()) as {
    model?: string;
    answers?: Record<string, ChoiceAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    model: body.model || MODEL,
    decisions: interpretDecisions(input, body.answers ?? {}),
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}
