import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { completeJson, providerKey } from '@/lib/planner/complete';
import { decideFields, jevKey } from '@/lib/planner/jev';
import { allowedPurposeSet, runPlan } from '@/lib/planner/run';
import { comparisonModel } from '@/lib/planner/score';
import { z } from 'zod';

/**
 * POST /v1/plan
 *
 * The hosted half of the extension's planner. The extension redacts participant
 * values before calling. This schema refuses a `value` property so a caller
 * cannot slip one in. The response is the plan shape `analysisFromAgentPlan`
 * already consumes, and the extension validates it again before writing.
 */
const fieldSchema = z
  .object({
    fieldKey: z.string().min(1).max(180),
    type: z.string().max(40),
    label: z.string().max(240),
    question: z.string().max(240),
    required: z.boolean(),
    alreadyFilled: z.boolean(),
    purposeHint: z.string().max(100),
    options: z.array(z.string().max(120)).max(30),
  })
  .strict();

const sourceSchema = z
  .object({
    purpose: z.string().min(1).max(100),
    label: z.string().max(200),
    kind: z.string().max(40),
    sensitive: z.boolean(),
  })
  .strict();

const postSchema = z
  .object({
    model: z.string().min(1).max(80).optional(),
    page: z.object({ domain: z.string().min(1).max(160) }).strict(),
    fields: z.array(fieldSchema).max(80),
    sources: z.array(sourceSchema).max(80),
  })
  .strict();

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;
  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;

  const requested = parsed.data.model ?? 'claude-sonnet-4-6';
  const model = comparisonModel(requested);
  const planInput = {
    page: parsed.data.page,
    fields: parsed.data.fields,
    sources: parsed.data.sources,
    allowedPurposes: allowedPurposeSet(),
  };
  let jev = null;
  if (jevKey()) {
    try {
      const pass = await decideFields(planInput);
      if (pass)
        jev = { model: pass.model, decisions: pass.decisions, inputTokens: pass.inputTokens };
    } catch {
      jev = null;
    }
  }
  const deferred = jev?.decisions.some((decision) => decision.action === 'uncertain') ?? true;
  if ((!model || !providerKey(model.id)) && deferred) {
    return fail(
      503,
      `No credentials are configured for ${requested}. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for that provider.`,
      { origin },
    );
  }
  const priced = model ?? comparisonModel('claude-sonnet-4-6');
  if (!priced) return fail(503, 'No planner model is configured.', { origin });

  try {
    const plan = await runPlan(
      planInput,
      priced.id,
      (request) =>
        completeJson({ model: priced.id, system: request.system, prompt: request.prompt }),
      jev,
    );
    return ok({ plan }, { origin });
  } catch {
    return fail(502, 'The planner did not return a usable plan. No values were written.', {
      origin,
    });
  }
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
