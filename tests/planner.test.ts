import { readFileSync } from 'node:fs';
import { allowedNext, validateOutcomeInput } from '@/lib/casegraph/outcomes';
import {
  GOLDEN_ALLOWED,
  GOLDEN_CASE,
  GOLDEN_FIELDS,
  GOLDEN_SOURCES,
  scriptedCorrectResponses,
  scriptedGrokResponses,
  scriptedWrongSsnResponses,
} from '@/lib/planner/golden';
import { interpretDecisions, sensitiveControl } from '@/lib/planner/jev';
import { runPlan } from '@/lib/planner/run';
import { COMPARISON_MODELS, estimateCostUsd, scorePlan } from '@/lib/planner/score';
import { describe, expect, it } from 'vitest';

describe('outcome transitions', () => {
  it('starts only after a human submission', () => {
    expect(allowedNext('submitted')).toEqual([
      'received',
      'pending_documents',
      'approved',
      'denied',
    ]);
  });

  it('treats a denial and a paid benefit as final', () => {
    expect(allowedNext('denied')).toEqual([]);
    expect(allowedNext('benefit_received')).toEqual([]);
  });

  it('refuses a document request with no reason, and an SSN in the note', () => {
    expect(validateOutcomeInput({ status: 'pending_documents', recordedBy: 'A' })).toMatch(
      /reason/,
    );
    expect(
      validateOutcomeInput({
        status: 'pending_documents',
        reasonCode: 'missing_documents',
        followUp: 'SSN on the letter is 900-12-3456',
        recordedBy: 'A',
      }),
    ).toMatch(/SSN/);
  });
});

describe('planner scoring', () => {
  const complete =
    (script: (role: string) => string) =>
    async (request: { role: string; system: string; prompt: string }) => ({
      text: script(request.role),
      inputTokens: 1000,
      outputTokens: 200,
    });

  it('scores a correct scripted plan as review-ready and not wrong-confident', async () => {
    const plan = await runPlan(
      {
        page: { domain: 'ruhealth.org' },
        fields: GOLDEN_FIELDS,
        sources: GOLDEN_SOURCES,
        allowedPurposes: GOLDEN_ALLOWED,
      },
      'claude-sonnet-4-6',
      complete(scriptedCorrectResponses),
    );
    const score = scorePlan(GOLDEN_CASE, plan, plan.metadata.usage.apiCostUsd);
    expect(score.wrongConfident).toBe(0);
    expect(score.sensitiveWrong).toBe(0);
    expect(score.missedGaps).toBe(0);
    expect(score.reviewReady).toBe(true);
    expect(score.costUsd).toBeGreaterThan(0);
  });

  it('counts an SSN control mapped to another purpose as a sensitive wrong field', async () => {
    const plan = await runPlan(
      {
        page: { domain: 'ruhealth.org' },
        fields: GOLDEN_FIELDS,
        sources: GOLDEN_SOURCES,
        allowedPurposes: GOLDEN_ALLOWED,
      },
      'claude-opus-4-8',
      complete(scriptedWrongSsnResponses),
    );
    const score = scorePlan(GOLDEN_CASE, plan, 1);
    expect(plan.purposeOverrides.applicant_ssn).toBe('firstName');
    expect(score.sensitiveWrong).toBeGreaterThan(0);
    expect(score.reviewReady).toBe(false);
  });

  it('scores the Grok 4.7 session plan as review-ready without touching the SSN', async () => {
    const plan = await runPlan(
      {
        page: { domain: 'ruhealth.org' },
        fields: GOLDEN_FIELDS,
        sources: GOLDEN_SOURCES,
        allowedPurposes: GOLDEN_ALLOWED,
      },
      'claude-sonnet-4-6',
      complete(scriptedGrokResponses),
    );
    const score = scorePlan(GOLDEN_CASE, plan, null);
    expect(plan.purposeOverrides.applicant_ssn).toBeUndefined();
    expect(score.sensitiveWrong).toBe(0);
    expect(score.reviewReady).toBe(true);
  });

  it('reads a plan when the model wraps JSON in a preamble', async () => {
    const plan = await runPlan(
      {
        page: { domain: 'ruhealth.org' },
        fields: GOLDEN_FIELDS,
        sources: GOLDEN_SOURCES,
        allowedPurposes: GOLDEN_ALLOWED,
      },
      'claude-opus-4-8',
      async (request) => ({
        text: `Here is the plan.\n${scriptedGrokResponses(request.role)}`,
        inputTokens: 10,
        outputTokens: 10,
      }),
    );
    expect(plan.purposeOverrides.applicant_first).toBe('firstName');
    expect(plan.purposeOverrides.applicant_ssn).toBeUndefined();
  });

  it('lets a confident Jev pass decide the page without calling a generative model', async () => {
    let calls = 0;
    const decisions = interpretDecisions(
      {
        page: { domain: 'ruhealth.org' },
        fields: GOLDEN_FIELDS,
        sources: GOLDEN_SOURCES,
        allowedPurposes: GOLDEN_ALLOWED,
      },
      {
        f0: { type: 'choice', choice: 'firstName', confidence: 0.96 },
        f1: { type: 'choice', choice: 'ask', confidence: 0.91 },
        f2: { type: 'choice', choice: 'firstName', confidence: 0.99 },
      },
    );
    expect(decisions.find((item) => item.fieldKey === 'applicant_ssn')?.action).toBe('leave');
    expect(sensitiveControl(GOLDEN_FIELDS[2])).toBe(true);
    const plan = await runPlan(
      {
        page: { domain: 'ruhealth.org' },
        fields: GOLDEN_FIELDS,
        sources: GOLDEN_SOURCES,
        allowedPurposes: GOLDEN_ALLOWED,
      },
      'claude-sonnet-4-6',
      async () => {
        calls += 1;
        throw new Error('The generative planner should not run.');
      },
      { model: 'jev-1.13.0', decisions, inputTokens: 900 },
    );
    expect(calls).toBe(0);
    expect(plan.purposeOverrides.applicant_first).toBe('firstName');
    expect(plan.purposeOverrides.applicant_ssn).toBeUndefined();
    expect(plan.gaps.map((gap) => gap.fieldKey)).toContain('clinic');
    expect(plan.metadata.runtime.startsWith('jev:')).toBe(true);
    expect(plan.metadata.usage.apiCostUsd).toBeGreaterThan(0);
    expect(plan.metadata.usage.apiCostUsd).toBeLessThan(0.01);
  });

  it('prices all five comparison models from published list rates', () => {
    expect(COMPARISON_MODELS).toHaveLength(5);
    expect(estimateCostUsd('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      3,
    );
    expect(estimateCostUsd('gpt-5-mini', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(2);
    expect(estimateCostUsd('unknown', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe('participant page', () => {
  it('saves answers and tells the person it does not submit', () => {
    const source = readFileSync('app/participate/[token]/page.tsx', 'utf8');
    expect(source).toContain('This page does not submit');
    expect(source).toContain('Save my answers');
    expect(source).not.toContain('Submit application');
    expect(source).toContain('view.canSubmit !== false');
  });
});
