import { readFileSync } from 'node:fs';
import { SEED_PLAYBOOKS } from '@/lib/playbooks/data';
import {
  type DriftScore,
  formatScorecard,
  renderReport,
  scoreDriftLab,
} from '@/lib/playbooks/drift-lab';
import { observeHtml } from '@/lib/playbooks/observe-html';
import type { PlaybookRow } from '@/lib/playbooks/registry';
import { proposeRepair } from '@/lib/playbooks/scribe';
import { describe, expect, it } from 'vitest';

/**
 * The drift scorecard.
 *
 * These locks are the product rules a loosened scribe would break: an SSN
 * placed on a case number, a tie published as if it were unique, a signature
 * date published as a date of birth.
 */

const scores = scoreDriftLab();

function score(id: string): DriftScore {
  const found = scores.find((item) => item.id === id);
  if (!found) throw new Error(`Missing drift fixture ${id}.`);
  return found;
}

describe('drift scorecard', () => {
  it('prints publishable, kept, moved, unresolved, and unmapped for every fixture', () => {
    const card = formatScorecard(scores);
    expect(card).toContain('5 of 9 fixtures publish. 4 are refused.');
    for (const item of scores) {
      expect(card).toContain(item.id);
      expect(card).toContain(`publishable: ${item.publishable ? 'yes' : 'no'}`);
      expect(card).toContain(`kept (${item.kept.length})`);
      expect(card).toContain(`moved (${item.moved.length})`);
      expect(card).toContain(`unresolved (${item.unresolved.length})`);
      expect(card).toContain(`unmapped (${item.unmapped.length})`);
      expect(card).toContain(item.reason);
    }
  });

  it('writes the report Brandon reads, including the limits of a green row', () => {
    const report = renderReport(scores);
    expect(readFileSync('reports/scribe-drift.md', 'utf8')).toBe(report);
    expect(report).toContain('pnpm drift');
    expect(report).toContain('read back');
    expect(report).toContain('all or nothing');
    expect(report).toContain('A person submits the application');
    expect(report).toContain('has not been run');
  });
});

describe('a WIC-like drift', () => {
  it('publishes the rehearsal page without claiming the case number', () => {
    const item = score('wic-form-drifted');
    expect(item.publishable).toBe(true);
    expect(item.proposal.fieldMap.map((entry) => entry.fieldKey)).toEqual([
      '#applicant-name',
      '#applicant-phone',
      '#applicant-email',
      '#applicant-zip',
      '#wic-clinic',
      '#applicant-language',
    ]);
    expect(item.unmapped.map((control) => control.selector)).toEqual(['#case-number']);
    expect(item.reason.startsWith('A model is not required')).toBe(true);
  });

  it('keeps a selector that still matches and moves the rest on the Saltmere page', () => {
    const item = score('wic-saltmere-county');
    expect(item.publishable).toBe(true);
    expect(item.kept.map((entry) => entry.toSelector)).toEqual(['#edit-email']);
    expect(item.proposal.fieldMap.map((entry) => entry.fieldKey)).toEqual([
      '#edit-email',
      '#saltmere-name',
      '#saltmere-phone',
      '#saltmere-zip',
      '#saltmere-clinic',
      '#saltmere-language',
    ]);
    expect(item.unmapped.map((control) => control.selector)).toEqual(['#case-number']);
  });
});

describe('SSN rules', () => {
  it('moves an SSN onto Social Security Number and leaves Case number unmapped', () => {
    const item = score('hearth-ssn-relabeled');
    expect(item.publishable).toBe(true);
    expect(item.moved).toEqual([
      expect.objectContaining({
        purpose: 'ssn',
        fromSelector: '#ssn',
        toSelector: '#applicant-ssn',
      }),
    ]);
    expect(item.proposal.fieldMap.find((entry) => entry.purpose === 'ssn')).toMatchObject({
      fieldKey: '#applicant-ssn',
      method: 'keys',
    });
    expect(item.proposal.fieldMap.some((entry) => entry.fieldKey === '#case-number')).toBe(false);
    expect(item.unmapped.map((control) => control.selector)).toEqual(['#case-number']);
    expect(item.reason.startsWith('A model is not required')).toBe(true);
  });

  it('refuses to publish when the only nearby SSN label is Case number', () => {
    const item = score('quill-ssn-case-number');
    expect(item.publishable).toBe(false);
    expect(item.moved).toHaveLength(0);
    expect(item.unresolved.map((entry) => entry.purpose)).toEqual(['ssn']);
    expect(item.proposal.refused).toMatch(/ssn/);
    expect(item.proposal.fieldMap.some((entry) => entry.fieldKey === '#case-number')).toBe(false);
    expect(item.proposal.fieldMap.some((entry) => entry.purpose === 'ssn')).toBe(false);
    expect(item.reason.startsWith('A model is required')).toBe(true);
  });

  it('does not place the Cedar Hollow SSN on the case number', () => {
    const item = score('ihss-cedar-hollow');
    expect(item.publishable).toBe(true);
    expect(item.moved).toEqual([
      expect.objectContaining({ purpose: 'firstName', toSelector: '#applicant-first-name' }),
      expect.objectContaining({ purpose: 'ssn', toSelector: '#applicant-ssn' }),
    ]);
    expect(item.proposal.fieldMap.find((entry) => entry.purpose === 'ssn')).toMatchObject({
      fieldKey: '#applicant-ssn',
      method: 'keys',
    });
    expect(item.unmapped.map((control) => control.selector)).toEqual([
      '#birth-date',
      '#signature-date',
      '#case-number',
    ]);
    expect(item.proposal.fieldMap.some((entry) => entry.fieldKey === '#signature-date')).toBe(
      false,
    );
    expect(item.proposal.fieldMap.some((entry) => entry.fieldKey === '#case-number')).toBe(false);
  });
});

describe('a tie', () => {
  it('refuses the Briar renewal when two controls share Street address', () => {
    const item = score('briar-medicaid-snap-tie');
    expect(item.publishable).toBe(false);
    expect(item.unresolved.map((entry) => entry.purpose)).toEqual(['addressLine1']);
    expect(item.moved.some((entry) => entry.purpose === 'addressLine1')).toBe(false);
    expect(item.proposal.fieldMap.some((entry) => entry.fieldKey === '#home-street')).toBe(false);
    expect(item.proposal.fieldMap.some((entry) => entry.fieldKey === '#mailing-street')).toBe(
      false,
    );
    expect(item.unmapped.map((control) => control.selector)).toEqual([
      '#home-street',
      '#mailing-street',
    ]);
    expect(item.reason.startsWith('A model is required')).toBe(true);
  });
});

describe('a signature date', () => {
  it('refuses to publish a signature date as the BenefitsCal date of birth', () => {
    const item = score('saltmere-signature-date');
    expect(item.publishable).toBe(false);
    expect(item.unresolved.map((entry) => entry.purpose)).toEqual(['dateOfBirth']);
    expect(item.moved.some((entry) => entry.toSelector === '#signed-on')).toBe(false);
    expect(item.proposal.fieldMap.some((entry) => entry.fieldKey === '#signed-on')).toBe(false);
    expect(item.unmapped.map((control) => control.selector)).toEqual(['#signed-on']);
    expect(item.reason.startsWith('A model is required')).toBe(true);
  });

  it('keeps the Cedar Hollow signature date off date of birth when that field is added to the IHSS map', () => {
    const seed = SEED_PLAYBOOKS.find((item) => item.programIds?.includes('ihss'));
    if (!seed?.fieldMap || !seed.probes || !seed.domain || !seed.name || !seed.programIds) {
      throw new Error('The IHSS seed playbook is missing.');
    }
    const previous: PlaybookRow = {
      id: 'drift-lab',
      tenantId: null,
      domain: seed.domain,
      programIds: [...seed.programIds],
      version: seed.version ?? 1,
      name: seed.name,
      probes: [...seed.probes, '#dobTxt'],
      fieldMap: [
        ...seed.fieldMap.map((entry) => ({ ...entry })),
        {
          fieldKey: '#dobTxt',
          purpose: 'dateOfBirth',
          inputType: 'date',
          mask: 'MM/DD/YYYY',
          method: 'keys',
        },
      ],
      safeAdvanceRules: seed.safeAdvanceRules ?? [],
      autoAdvance: seed.autoAdvance ?? false,
      note: seed.note ?? null,
      staleAt: new Date(),
      staleReason: 'selectors moved',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const observed = observeHtml(
      readFileSync('tests/fixtures/drift/ihss-cedar-hollow.html', 'utf8'),
    );
    const proposal = proposeRepair(previous, observed);
    expect(proposal.publishable).toBe(true);
    expect(proposal.moved.find((entry) => entry.purpose === 'dateOfBirth')?.toSelector).toBe(
      '#birth-date',
    );
    expect(proposal.fieldMap.find((entry) => entry.purpose === 'dateOfBirth')).toMatchObject({
      fieldKey: '#birth-date',
      method: 'keys',
      mask: 'MM/DD/YYYY',
    });
    expect(proposal.fieldMap.some((entry) => entry.fieldKey === '#signature-date')).toBe(false);
    expect(proposal.unmapped.map((control) => control.selector)).toContain('#signature-date');
  });
});

describe('a question the playbook does not know, and a field the page dropped', () => {
  it('republishes Moss County and leaves the new household question unmapped', () => {
    const item = score('moss-wic-new-question');
    expect(item.publishable).toBe(true);
    expect(item.moved).toHaveLength(0);
    expect(item.kept).toHaveLength(6);
    expect(item.unresolved).toHaveLength(0);
    expect(item.unmapped).toEqual([
      expect.objectContaining({
        selector: '#household-count',
        label: 'How many people are in your household?',
      }),
    ]);
    expect(item.reason).toMatch(/unmapped/);
  });

  it('refuses Fable County because the phone field is gone', () => {
    const item = score('fable-wic-dropped-phone');
    expect(item.publishable).toBe(false);
    expect(item.unresolved.map((entry) => entry.purpose)).toEqual(['phone']);
    expect(item.kept.map((entry) => entry.purpose)).toEqual([
      'fullName',
      'email',
      'postalCode',
      null,
      'primaryLanguage',
    ]);
    expect(item.reason.startsWith('A model is required')).toBe(true);
  });
});
