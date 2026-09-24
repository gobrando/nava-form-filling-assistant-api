import { type ComparisonModelId, comparisonModel } from './score';

/**
 * One JSON completion against the provider that owns the model.
 *
 * The comparison harness and `POST /v1/plan` both go through here. A missing
 * key is a skip, not a guessed answer.
 */

const TIMEOUT_MS = 30_000;

export type Completion = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

export function providerKey(modelId: ComparisonModelId): string | null {
  const model = comparisonModel(modelId);
  if (!model) return null;
  if (model.provider === 'anthropic') return process.env.ANTHROPIC_API_KEY?.trim() || null;
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export async function completeJson(args: {
  model: ComparisonModelId;
  system: string;
  prompt: string;
}): Promise<Completion> {
  const key = providerKey(args.model);
  const model = comparisonModel(args.model);
  if (!model || !key) {
    throw new Error(`No credentials configured for ${args.model}.`);
  }
  if (model.provider === 'anthropic') return anthropic(args, key);
  return openai(args, key);
}

async function anthropic(
  args: { model: string; system: string; prompt: string },
  key: string,
): Promise<Completion> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 2048,
      system: args.system,
      messages: [{ role: 'user', content: args.prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic returned ${response.status} for ${args.model}.`);
  }
  const body = (await response.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = body.content?.find((part) => part.type === 'text')?.text ?? '';
  return {
    text: extractJson(text),
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}

async function openai(
  args: { model: string; system: string; prompt: string },
  key: string,
): Promise<Completion> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: args.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: `${args.prompt}\n\nReturn only JSON.` },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status} for ${args.model}.`);
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: extractJson(body.choices?.[0]?.message?.content ?? ''),
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? trimmed).trim();
}
