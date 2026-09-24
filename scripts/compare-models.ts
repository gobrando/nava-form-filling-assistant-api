import { providerKey } from '@/lib/planner/complete';
import {
  GOLDEN_ALLOWED,
  GOLDEN_CASE,
  GOLDEN_FIELDS,
  GOLDEN_SOURCES,
  scriptedCorrectResponses,
  scriptedGrokResponses,
  scriptedWrongSsnResponses,
} from '@/lib/planner/golden';
import { decideFields, jevKey } from '@/lib/planner/jev';
import { runPlan } from '@/lib/planner/run';
import { COMPARISON_MODELS, type ComparisonModelId, scorePlan } from '@/lib/planner/score';

/**
 * Scores Kalen's five models on one WIC-shaped page.
 *
 * Without provider keys this still runs: it scores a scripted correct plan and
 * a scripted plan that maps an SSN control onto the wrong purpose, and it marks
 * each live model as skipped. With ANTHROPIC_API_KEY and OPENAI_API_KEY it
 * calls the models. Pass --live to require that; otherwise a missing key is a
 * skip, not a failure.
 */

const live = process.argv.includes('--live');

type Row = {
  model: string;
  status: 'scored' | 'skipped' | 'failed';
  reviewReady: boolean | null;
  wrongConfident: number | null;
  sensitiveWrong: number | null;
  costUsd: number | null;
  note: string;
};

const input = {
  page: { domain: 'ruhealth.org' },
  fields: GOLDEN_FIELDS,
  sources: GOLDEN_SOURCES,
  allowedPurposes: GOLDEN_ALLOWED,
};

async function scoreModel(model: ComparisonModelId): Promise<Row> {
  if (!providerKey(model)) {
    return {
      model,
      status: 'skipped',
      reviewReady: null,
      wrongConfident: null,
      sensitiveWrong: null,
      costUsd: null,
      note: 'no provider key',
    };
  }
  const { completeJson } = await import('@/lib/planner/complete');
  try {
    const plan = await runPlan(input, model, (request) =>
      completeJson({ model, system: request.system, prompt: request.prompt }),
    );
    const score = scorePlan(GOLDEN_CASE, plan, plan.metadata.usage.apiCostUsd);
    return {
      model,
      status: 'scored',
      reviewReady: score.reviewReady,
      wrongConfident: score.wrongConfident,
      sensitiveWrong: score.sensitiveWrong,
      costUsd: score.costUsd,
      note: '',
    };
  } catch (error) {
    return {
      model,
      status: 'failed',
      reviewReady: null,
      wrongConfident: null,
      sensitiveWrong: null,
      costUsd: null,
      note: error instanceof Error ? error.message : 'planner failed',
    };
  }
}

async function scoreJev(): Promise<Row> {
  if (!jevKey()) {
    return {
      model: 'jev-1.13.0',
      status: 'skipped',
      reviewReady: null,
      wrongConfident: null,
      sensitiveWrong: null,
      costUsd: null,
      note: 'no TYPESAFE_API_KEY',
    };
  }
  try {
    const pass = await decideFields(input);
    if (!pass) throw new Error('Jev returned no decisions.');
    const plan = await runPlan(
      input,
      'claude-sonnet-4-6',
      async (request) => ({
        text: scriptedGrokResponses(request.role),
        inputTokens: 0,
        outputTokens: 0,
      }),
      { model: pass.model, decisions: pass.decisions, inputTokens: pass.inputTokens },
    );
    const score = scorePlan(GOLDEN_CASE, plan, plan.metadata.usage.apiCostUsd);
    const deferred = plan.metadata.jev?.deferred ?? 0;
    return {
      model: pass.model,
      status: 'scored',
      reviewReady: score.reviewReady,
      wrongConfident: score.wrongConfident,
      sensitiveWrong: score.sensitiveWrong,
      costUsd: score.costUsd,
      note:
        deferred > 0
          ? `${deferred} uncertain field(s) used the scripted fallback`
          : 'decided the page; no generative call',
    };
  } catch (error) {
    return {
      model: 'jev-1.13.0',
      status: 'failed',
      reviewReady: null,
      wrongConfident: null,
      sensitiveWrong: null,
      costUsd: null,
      note: error instanceof Error ? error.message : 'jev failed',
    };
  }
}

async function main() {
  const scripted = await runPlan(input, 'claude-sonnet-4-6', async (request) => ({
    text: scriptedCorrectResponses(request.role),
    inputTokens: 800,
    outputTokens: 120,
  }));
  const scriptedScore = scorePlan(GOLDEN_CASE, scripted, scripted.metadata.usage.apiCostUsd);
  const wrong = await runPlan(input, 'claude-opus-4-8', async (request) => ({
    text: scriptedWrongSsnResponses(request.role),
    inputTokens: 800,
    outputTokens: 120,
  }));
  const wrongScore = scorePlan(GOLDEN_CASE, wrong, wrong.metadata.usage.apiCostUsd);

  if (!scriptedScore.reviewReady || scriptedScore.sensitiveWrong !== 0) {
    console.error('The scripted correct plan did not score as review-ready.');
    process.exit(1);
  }
  if (wrongScore.sensitiveWrong < 1) {
    console.error('The scripted SSN mis-map was not counted as a sensitive wrong field.');
    process.exit(1);
  }

  const grok = await runPlan(input, 'claude-sonnet-4-6', async (request) => ({
    text: scriptedGrokResponses(request.role),
    inputTokens: 800,
    outputTokens: 120,
  }));
  // Same assumed token budget as the scripted row. Official grok-4.7 list price
  // is $2 / $6 per million input/output tokens under 200k (docs.x.ai, 2026-09-23).
  // This chat did not call the xAI API, so the figure is an estimate, not an invoice.
  const grokCost =
    (grok.metadata.usage.inputTokens * 2 + grok.metadata.usage.outputTokens * 6) / 1_000_000;
  const grokScore = scorePlan(GOLDEN_CASE, grok, grokCost);
  if (!grokScore.reviewReady || grokScore.sensitiveWrong !== 0) {
    console.error('The Grok 4.7 session plan did not score as review-ready.');
    process.exit(1);
  }

  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const models = only.length
    ? COMPARISON_MODELS.filter((model) => only.includes(model.id))
    : COMPARISON_MODELS;
  const rows: Row[] = [await scoreJev()];
  for (const model of models) {
    rows.push(await scoreModel(model.id));
  }

  console.log('\nFive-model comparison — Riverside WIC page (redacted inventory)\n');
  console.log(
    [
      'grok-4.7'.padEnd(22),
      'session'.padEnd(10),
      String(grokScore.reviewReady).padEnd(8),
      String(grokScore.wrongConfident).padEnd(8),
      String(grokScore.sensitiveWrong).padEnd(12),
      grokScore.costUsd === null ? '—' : `$${grokScore.costUsd.toFixed(4)}`,
      'list $2/$6, same assumed tokens, this session did not call the xAI API',
    ].join(' '),
  );
  const header = ['model', 'status', 'ready', 'wrong', 'sensitive', 'est cost'];
  console.log(header.join('  '));
  for (const row of rows) {
    const cells = [
      row.model.padEnd(22),
      row.status.padEnd(10),
      String(row.reviewReady ?? '—').padEnd(8),
      String(row.wrongConfident ?? '—').padEnd(8),
      String(row.sensitiveWrong ?? '—').padEnd(12),
      row.costUsd === null
        ? '—'
        : `$${row.costUsd < 0.001 ? row.costUsd.toFixed(6) : row.costUsd.toFixed(4)}`,
      row.note,
    ];
    console.log(cells.filter(Boolean).join(' '));
  }
  console.log(
    `\nScripted check: correct plan review-ready, estimated $${scriptedScore.costUsd?.toFixed(4)} on sonnet-4.6 list price. SSN mis-map sensitive-wrong=${wrongScore.sensitiveWrong}.`,
  );
  console.log(
    'List prices are standard September 2026 rates and ignore cache. The on-device Gemini Nano planner in the extension stays at $0 API cost and is not one of these five.',
  );

  const failed = rows.filter((row) => row.status === 'failed');
  const skipped = rows.filter((row) => row.status === 'skipped');
  if (failed.length) process.exit(1);
  if (live && skipped.length) {
    console.error(`--live was set and ${skipped.length} model(s) had no key.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
