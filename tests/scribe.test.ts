import { readFileSync } from 'node:fs';
import { wicSeedPlaybook } from '@/lib/playbooks/data';
import { observeHtml } from '@/lib/playbooks/observe-html';
import type { PlaybookRow } from '@/lib/playbooks/registry';
import { observedControlSchema, proposeRepair } from '@/lib/playbooks/scribe';
import { describe, expect, it } from 'vitest';

/**
 * The deterministic scribe, with no database and no model.
 *
 * These cases are the ones a wrong repair would poison: an SSN placed on a
 * case number, a date of birth placed on a signature, two controls that both
 * look right. Each of those must stay unresolved. The drifted WIC fixture is
 * the case that should publish, because every old question is still labeled.
 */

function row(
  partial: Partial<PlaybookRow> & Pick<PlaybookRow, 'fieldMap' | 'probes'>,
): PlaybookRow {
  return {
    id: 'playbook-1',
    tenantId: null,
    domain: 'example.test',
    programIds: ['wic'],
    version: 1,
    name: 'Fixture',
    safeAdvanceRules: [],
    autoAdvance: false,
    note: null,
    staleAt: new Date(),
    staleReason: 'selectors moved',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

const wicSeed = wicSeedPlaybook();

describe('an observation', () => {
  it('rejects a value, because the scribe never sees what a person typed', () => {
    const parsed = observedControlSchema.safeParse({
      selector: '#applicant-name',
      label: 'Name',
      type: 'text',
      count: 1,
      value: 'Jordan Sample',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('a drifted WIC page', () => {
  const observed = observeHtml(readFileSync('tests/fixtures/wic-form-drifted.html', 'utf8'));
  const proposal = proposeRepair(
    row({
      domain: 'www.ruhealth.org',
      name: wicSeed.name,
      programIds: [...wicSeed.programIds],
      probes: [...wicSeed.probes],
      fieldMap: wicSeed.fieldMap.map((entry) => ({ ...entry })),
    }),
    observed,
  );

  it('publishes a map and does not keep the old ids', () => {
    expect(proposal.publishable).toBe(true);
    expect(proposal.refused).toBeNull();
    expect(proposal.fieldMap.map((entry) => entry.fieldKey)).toEqual([
      '#applicant-name',
      '#applicant-phone',
      '#applicant-email',
      '#applicant-zip',
      '#wic-clinic',
      '#applicant-language',
    ]);
  });

  it('keeps purposes, including the clinic that has no fact', () => {
    const clinic = proposal.fieldMap.find((entry) => entry.fieldKey === '#wic-clinic');
    expect(clinic?.purpose).toBeNull();
    expect(clinic?.required).toBe(true);
    expect(proposal.fieldMap.find((entry) => entry.fieldKey === '#applicant-zip')?.purpose).toBe(
      'postalCode',
    );
  });

  it('probes the controls that moved, not the case number and not the submit button', () => {
    expect(proposal.probes).toEqual(['#applicant-name', '#wic-clinic']);
    expect(proposal.unmapped.map((control) => control.selector)).toEqual(['#case-number']);
  });
});

describe('refusals', () => {
  it('does not put an SSN on a case number', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#ssn'],
        fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' }],
      }),
      [
        { selector: '#case-number', label: 'Case number', type: 'text', count: 1 },
        { selector: '#applicant-ssn', label: 'Social Security Number', type: 'text', count: 1 },
      ],
    );
    expect(proposal.publishable).toBe(true);
    expect(proposal.moved).toEqual([
      expect.objectContaining({ purpose: 'ssn', toSelector: '#applicant-ssn' }),
    ]);
    expect(proposal.fieldMap[0]).toMatchObject({ fieldKey: '#applicant-ssn', method: 'keys' });
    expect(proposal.unmapped.map((control) => control.selector)).toEqual(['#case-number']);
  });

  it('refuses an SSN when the only control is a case number', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#ssn'],
        fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' }],
      }),
      [{ selector: '#case-number', label: 'Case number', type: 'text', count: 1 }],
    );
    expect(proposal.publishable).toBe(false);
    expect(proposal.refused).toMatch(/ssn/);
    expect(proposal.moved).toHaveLength(0);
    expect(proposal.fieldMap).toHaveLength(0);
  });

  it('refuses when two controls both say Social Security Number', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#ssn'],
        fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text' }],
      }),
      [
        { selector: '#ssn-a', label: 'Social Security Number', type: 'text', count: 1 },
        { selector: '#ssn-b', label: 'Social Security Number', type: 'text', count: 1 },
      ],
    );
    expect(proposal.publishable).toBe(false);
    expect(proposal.unresolved.map((item) => item.purpose)).toEqual(['ssn']);
  });

  it('does not treat an area code as a ZIP', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#zip'],
        fieldMap: [{ fieldKey: '#zip', purpose: 'postalCode', inputType: 'text', required: true }],
      }),
      [{ selector: '#area', label: 'Area code', type: 'text', count: 1 }],
    );
    expect(proposal.publishable).toBe(false);
    expect(proposal.moved).toHaveLength(0);
  });

  it('does not treat a signature date as a date of birth', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#dob'],
        fieldMap: [{ fieldKey: '#dob', purpose: 'dateOfBirth', inputType: 'date' }],
      }),
      [{ selector: '#signed-on', label: 'Signature date', type: 'date', count: 1 }],
    );
    expect(proposal.publishable).toBe(false);
    expect(proposal.unresolved[0]?.toSelector).toBeNull();
  });

  it('does not map a full name onto a first name when both exist', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#full', '#first'],
        fieldMap: [
          { fieldKey: '#full', purpose: 'fullName', inputType: 'text', required: true },
          { fieldKey: '#first', purpose: 'firstName', inputType: 'text' },
        ],
      }),
      [
        { selector: '#legal-name', label: 'Full legal name', type: 'text', count: 1 },
        { selector: '#given-name', label: 'First name', type: 'text', count: 1 },
      ],
    );
    expect(proposal.publishable).toBe(true);
    expect(proposal.fieldMap).toEqual([
      expect.objectContaining({ fieldKey: '#legal-name', purpose: 'fullName' }),
      expect.objectContaining({ fieldKey: '#given-name', purpose: 'firstName' }),
    ]);
  });

  it('leaves both name fields unresolved when the page only says Name', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#full'],
        fieldMap: [
          { fieldKey: '#full', purpose: 'fullName', inputType: 'text', required: true },
          { fieldKey: '#first', purpose: 'firstName', inputType: 'text' },
        ],
      }),
      [{ selector: '#name', label: 'Name', type: 'text', count: 1 }],
    );
    expect(proposal.publishable).toBe(false);
    expect(proposal.moved).toHaveLength(0);
  });

  it('does not keep an ambiguous selector', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#zip'],
        fieldMap: [{ fieldKey: '#zip', purpose: 'postalCode', inputType: 'text', required: true }],
      }),
      [
        { selector: '#zip', label: 'ZIP code', type: 'text', count: 2 },
        { selector: '#postal', label: 'Postal code', type: 'text', count: 1 },
      ],
    );
    expect(proposal.publishable).toBe(true);
    expect(proposal.moved[0]?.toSelector).toBe('#postal');
  });

  it('keeps a selector that still resolves, including its mask', () => {
    const proposal = proposeRepair(
      row({
        probes: ['#birthDate_primary_input'],
        fieldMap: [
          {
            fieldKey: '#birthDate_primary_input',
            purpose: 'dateOfBirth',
            inputType: 'date',
            mask: 'MM/DD/YYYY',
            method: 'keys',
          },
        ],
      }),
      [
        {
          selector: '#birthDate_primary_input',
          label: 'Date of birth',
          type: 'date',
          count: 1,
        },
      ],
    );
    expect(proposal.kept).toHaveLength(1);
    expect(proposal.moved).toHaveLength(0);
    expect(proposal.fieldMap[0]).toMatchObject({ method: 'keys', mask: 'MM/DD/YYYY' });
  });
});
