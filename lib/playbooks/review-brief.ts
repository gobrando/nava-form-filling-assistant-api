import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriftScore } from '@/lib/playbooks/drift-lab';

/**
 * One-page design-review brief over the drift scorecard.
 *
 * The counts come from `scoreDriftLab`. The dollars come from
 * `config/review-brief.json`. Neither number is a county rate.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MICRO = 1_000_000;

export const REVIEW_ASSUMPTIONS_PATH = 'config/review-brief.json';
export const REVIEW_REPORT_PATH = 'reports/repair-review.md';

export const FORMULA_LINES = [
  'fixtureShare = publishedFixtures / fixtureCount',
  'costPerColdRun = pricePerModelTurn * turnsPerColdRun',
  'blendedCostPerApplication = (1 - fixtureShare) * costPerColdRun',
  'warmPathModelCost = 0',
] as const;

const MODEL_JOB: Record<string, string> = {
  'briar-medicaid-snap-tie': 'tie',
  'quill-ssn-case-number': 'SSN versus case number',
  'fable-wic-dropped-phone': 'dropped phone',
  'saltmere-signature-date': 'signature date versus birth date',
};

export type ReviewAssumptions = {
  pricePerModelTurnUsd: string;
  turnsPerColdRun: number;
  publishedFixtures: number;
  fixtureCount: number;
  note: string;
};

export type ReviewScenario = {
  assumptions: ReviewAssumptions;
  refusedFixtures: number;
  costPerColdRunUsd: string;
  blendedCostPerApplicationUsd: string;
  warmPathModelCostUsd: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseReviewAssumptions(value: unknown): ReviewAssumptions {
  if (!isRecord(value)) throw new Error('Review assumptions must be a JSON object.');
  const allowed = new Set([
    'pricePerModelTurnUsd',
    'turnsPerColdRun',
    'publishedFixtures',
    'fixtureCount',
    'note',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown review assumption ${key}.`);
  }
  const price = value.pricePerModelTurnUsd;
  if (typeof price !== 'string' || !/^\d+(\.\d{1,6})?$/.test(price)) {
    throw new Error('pricePerModelTurnUsd must be a decimal string with at most 6 places.');
  }
  const turns = value.turnsPerColdRun;
  if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 0) {
    throw new Error('turnsPerColdRun must be a non-negative integer.');
  }
  const published = value.publishedFixtures;
  const total = value.fixtureCount;
  if (typeof published !== 'number' || !Number.isInteger(published) || published < 0) {
    throw new Error('publishedFixtures must be a non-negative integer.');
  }
  if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0) {
    throw new Error('fixtureCount must be a positive integer.');
  }
  if (published > total) throw new Error('publishedFixtures cannot exceed fixtureCount.');
  const note = value.note;
  if (typeof note !== 'string' || note.trim() === '') {
    throw new Error('note must say what the fixture share is and is not.');
  }
  return {
    pricePerModelTurnUsd: price,
    turnsPerColdRun: turns,
    publishedFixtures: published,
    fixtureCount: total,
    note,
  };
}

export function loadReviewAssumptions(root = ROOT): ReviewAssumptions {
  const raw: unknown = JSON.parse(readFileSync(join(root, REVIEW_ASSUMPTIONS_PATH), 'utf8'));
  return parseReviewAssumptions(raw);
}

function roundDivHalfUp(numerator: number, denominator: number): number {
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  if (remainder * 2 >= denominator) return quotient + 1;
  return quotient;
}

function usdToMicro(value: string): number {
  const [whole, frac = ''] = value.split('.');
  return Number(whole) * MICRO + Number(frac.padEnd(6, '0'));
}

function formatUsdFromMicro(micro: number): string {
  const negative = micro < 0;
  const abs = Math.abs(micro);
  const dollars = Math.floor(abs / MICRO);
  const tenThousandths = Math.floor((abs % MICRO) / 100);
  return `${negative ? '-' : ''}$${dollars}.${String(tenThousandths).padStart(4, '0')}`;
}

function roundMicroTo4(micro: number): number {
  const sign = micro < 0 ? -1 : 1;
  return sign * roundDivHalfUp(Math.abs(micro), 100) * 100;
}

export function computeReviewScenario(assumptions: ReviewAssumptions): ReviewScenario {
  const priceMicro = usdToMicro(assumptions.pricePerModelTurnUsd);
  const costMicro = priceMicro * assumptions.turnsPerColdRun;
  const refusedFixtures = assumptions.fixtureCount - assumptions.publishedFixtures;
  const blendedNumerator = costMicro * refusedFixtures;
  if (!Number.isSafeInteger(costMicro) || !Number.isSafeInteger(blendedNumerator)) {
    throw new Error('Cost scenario is too large to compute exactly.');
  }
  // One rounding, half up, to 0.0001 dollar. Do not round to the microdollar first.
  const blendedMicro = roundDivHalfUp(blendedNumerator, assumptions.fixtureCount * 100) * 100;
  return {
    assumptions,
    refusedFixtures,
    costPerColdRunUsd: formatUsdFromMicro(roundMicroTo4(costMicro)),
    blendedCostPerApplicationUsd: formatUsdFromMicro(blendedMicro),
    warmPathModelCostUsd: formatUsdFromMicro(0),
  };
}

function jobLabel(id: string): string {
  return MODEL_JOB[id] ?? 'unresolved field';
}

export function renderReviewBrief(scores: DriftScore[], assumptions: ReviewAssumptions): string {
  const scenario = computeReviewScenario(assumptions);
  const closed = scores.filter((score) => score.publishable);
  const refused = scores.filter((score) => !score.publishable);
  const configured = `${assumptions.publishedFixtures}/${assumptions.fixtureCount}`;
  const liveShare = `${closed.length}/${scores.length}`;
  const shareNote =
    configured === liveShare
      ? ''
      : `The live scorecard is ${liveShare}. The dollars below use the configured fixture share ${configured}. That share is still this lab, not a production rate.`;
  const moss = closed.find((score) => score.id === 'moss-wic-new-question');
  const greenQuestion =
    moss && moss.unmapped.length > 0
      ? '`moss-wic-new-question` republishes the known fields and leaves the new question blank.'
      : 'A published fixture can republish the known fields and leave a new question blank.';

  const closedLines =
    closed.length > 0
      ? closed.map((score) => `- **${score.id}.** ${score.reason}`)
      : ['- None of the fixtures published.'];
  const refusedLines =
    refused.length > 0
      ? refused.map((score) => {
          const refusal = score.refused ? ` Refusal: ${score.refused}` : '';
          return `- **${score.id}** (${jobLabel(score.id)}). ${score.reason}${refusal}`;
        })
      : ['- None of the fixtures were refused.'];

  return [
    '<!-- Generated by `pnpm review-brief`. Do not edit by hand. -->',
    '',
    '# Repair review brief',
    '',
    'One page for a design review. Counts in the first two sections come from `scoreDriftLab`, the same function `pnpm drift` writes into `reports/scribe-drift.md`. No model call, no database, and no household values.',
    '',
    '## What the deterministic scribe closes',
    '',
    `**${closed.length} of ${scores.length} fixtures publish. ${refused.length} are refused.** Those ${closed.length} of ${scores.length} are this lab's fixture set, not a production rate.`,
    '',
    'Every field the playbook already knew still had one unambiguous label. The warm path can take the repaired map. A warm path costs no model calls.',
    '',
    ...closedLines,
    '',
    "## What is still the model's job",
    '',
    'Publish is all or nothing. One unresolved field withholds the map. The model cold path has not been run. These refusals are that job, named by fixture.',
    '',
    ...refusedLines,
    '',
    '## Cost scenario',
    '',
    `Assumptions are in \`${REVIEW_ASSUMPTIONS_PATH}\`. Change one and run \`pnpm review-brief\` again. ${assumptions.note}`,
    '',
    '| Assumption | Value |',
    '| --- | --- |',
    `| Price per model turn | $${assumptions.pricePerModelTurnUsd} |`,
    `| Turns per cold run | ${assumptions.turnsPerColdRun} |`,
    `| Fixture share | ${configured} publish, this lab, not a production rate |`,
    '',
    ...(shareNote ? [shareNote, ''] : []),
    'Formula:',
    '',
    '```',
    ...FORMULA_LINES,
    '```',
    '',
    `\`fixtureShare\` is the share of this lab's fixtures the deterministic scribe publishes (${assumptions.publishedFixtures} of ${assumptions.fixtureCount}). \`1 - fixtureShare\` is the share that still needs a cold run (${scenario.refusedFixtures} of ${assumptions.fixtureCount}). Warm path model cost is zero. Dollars are that formula, rounded half up to four decimal places. There is no production volume in this arithmetic.`,
    '',
    '```',
    `fixtureShare = ${assumptions.publishedFixtures} / ${assumptions.fixtureCount}`,
    `costPerColdRun = ${assumptions.pricePerModelTurnUsd} * ${assumptions.turnsPerColdRun} = ${scenario.costPerColdRunUsd}`,
    `blendedCostPerApplication = (1 - ${assumptions.publishedFixtures}/${assumptions.fixtureCount}) * ${scenario.costPerColdRunUsd} = ${scenario.blendedCostPerApplicationUsd}`,
    `warmPathModelCost = ${scenario.warmPathModelCostUsd}`,
    '```',
    '',
    '## What not to conclude',
    '',
    `- **No production volume.** ${closed.length} of ${scores.length} on the scorecard, and the configured fixture share, are this lab. It is not a production rate. It is not a county rate.`,
    '- **Readback is still required.** A published map can still truncate a write. Repair does not check the value, because the scribe never sees one.',
    '- **The product does not submit.** Repair does not submit. A human submits.',
    `- **A green row can leave a new question unmapped.** ${greenQuestion} The warm path will not call the model to learn it.`,
    '- **Publish is all or nothing.** Placements inside a refused proposal are not a playbook version. The model cold path has not been run, so these dollars are not a measured invoice.',
    '',
  ].join('\n');
}
