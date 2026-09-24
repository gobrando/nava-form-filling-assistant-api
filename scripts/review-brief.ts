import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreDriftLab } from '@/lib/playbooks/drift-lab';
import {
  FORMULA_LINES,
  REVIEW_REPORT_PATH,
  computeReviewScenario,
  loadReviewAssumptions,
  renderReviewBrief,
} from '@/lib/playbooks/review-brief';

/**
 * Writes reports/repair-review.md from the drift scorecard and
 * config/review-brief.json. No model, no database, no household values.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scores = scoreDriftLab(root);
const assumptions = loadReviewAssumptions(root);
const scenario = computeReviewScenario(assumptions);
const reportPath = join(root, REVIEW_REPORT_PATH);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, renderReviewBrief(scores, assumptions));

for (const line of FORMULA_LINES) console.log(line);
console.log(
  `fixtureShare = ${assumptions.publishedFixtures} / ${assumptions.fixtureCount} (this lab, not a production rate)`,
);
console.log(
  `costPerColdRun = ${assumptions.pricePerModelTurnUsd} * ${assumptions.turnsPerColdRun} = ${scenario.costPerColdRunUsd}`,
);
console.log(
  `blendedCostPerApplication = (1 - ${assumptions.publishedFixtures}/${assumptions.fixtureCount}) * ${scenario.costPerColdRunUsd} = ${scenario.blendedCostPerApplicationUsd}`,
);
console.log(`warmPathModelCost = ${scenario.warmPathModelCostUsd}`);
console.log(`Wrote ${reportPath}`);
