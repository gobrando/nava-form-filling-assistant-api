import { readFileSync } from 'node:fs';
import { scoreDriftLab } from '@/lib/playbooks/drift-lab';
import {
  FORMULA_LINES,
  type ReviewAssumptions,
  computeReviewScenario,
  loadReviewAssumptions,
  renderReviewBrief,
} from '@/lib/playbooks/review-brief';
import { describe, expect, it } from 'vitest';

/**
 * The design-review brief. Counts come from the drift scorecard. Dollars
 * come from the assumptions file, and a different assumption must change them.
 */

const scores = scoreDriftLab();
const assumptions = loadReviewAssumptions();
const brief = renderReviewBrief(scores, assumptions);

const base: ReviewAssumptions = {
  pricePerModelTurnUsd: '0.09',
  turnsPerColdRun: 10,
  publishedFixtures: 5,
  fixtureCount: 9,
  note: 'this lab, not a production rate',
};

describe('repair review brief', () => {
  it('carries the fixture counts, the SSN refusal, the formula, and the lab label', () => {
    const quill = scores.find((item) => item.id === 'quill-ssn-case-number');
    expect(scores).toHaveLength(9);
    expect(scores.filter((item) => item.publishable)).toHaveLength(5);
    expect(quill?.publishable).toBe(false);
    expect(quill?.refused).toMatch(/ssn/);
    expect(brief).toContain('5 of 9 fixtures publish. 4 are refused.');
    expect(brief).toContain('quill-ssn-case-number');
    expect(brief).toContain('SSN versus case number');
    expect(brief).toContain(quill?.refused ?? 'missing refusal');
    for (const line of FORMULA_LINES) expect(brief).toContain(line);
    expect(brief).toContain('not a production rate');
    expect(brief).toContain('Readback is still required');
    expect(brief).toContain('The product does not submit');
    expect(brief).toContain('A green row can leave a new question unmapped');
    expect(brief).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(brief).not.toContain('123-45-6789');
  });

  it('matches the file pnpm review-brief writes', () => {
    expect(readFileSync('reports/repair-review.md', 'utf8')).toBe(brief);
  });

  it('computes the default scenario from the formula', () => {
    const scenario = computeReviewScenario(base);
    expect(scenario.refusedFixtures).toBe(4);
    expect(scenario.costPerColdRunUsd).toBe('$0.9000');
    expect(scenario.blendedCostPerApplicationUsd).toBe('$0.4000');
    expect(scenario.warmPathModelCostUsd).toBe('$0.0000');
    expect(brief).toContain('$0.9000');
    expect(brief).toContain('$0.4000');
    expect(brief).toContain('$0.0000');
  });

  it('changes the computed dollars when an assumption changes', () => {
    const priced = computeReviewScenario({ ...base, pricePerModelTurnUsd: '0.18' });
    expect(priced.costPerColdRunUsd).toBe('$1.8000');
    expect(priced.blendedCostPerApplicationUsd).toBe('$0.8000');

    const shared = computeReviewScenario({ ...base, publishedFixtures: 8 });
    expect(shared.refusedFixtures).toBe(1);
    expect(shared.costPerColdRunUsd).toBe('$0.9000');
    expect(shared.blendedCostPerApplicationUsd).toBe('$0.1000');

    const turned = computeReviewScenario({ ...base, turnsPerColdRun: 20 });
    expect(turned.costPerColdRunUsd).toBe('$1.8000');
    expect(turned.blendedCostPerApplicationUsd).toBe('$0.8000');

    const repriced = renderReviewBrief(scores, { ...base, pricePerModelTurnUsd: '0.18' });
    expect(repriced).toContain('$1.8000');
    expect(repriced).toContain('$0.8000');
    expect(repriced).not.toContain('$0.4000');
    expect(repriced).toContain('5 of 9 fixtures publish');
    expect(repriced).toContain('not a production rate');
    expect(repriced).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });
});
