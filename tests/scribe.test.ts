import { readFileSync } from 'node:fs';
import { wicSeedPlaybook } from '@/lib/playbooks/data';
import { observeHtml } from '@/lib/playbooks/observe-html';
import { briefForDryRun, refusalBrief } from '@/lib/playbooks/refusal-brief';
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
  const extensionObserved = [
    { selector: '#applicant-name', label: 'Name', type: 'text', count: 1, required: true as const },
    {
      selector: '#contact-email',
      label: 'Email',
      type: 'radio',
      count: 1,
      question: 'Preferred contact method',
    },
  ];

  it('accepts the extension shape and repairs as it would without that metadata', () => {
    const parsed = observedControlSchema.array().safeParse(extensionObserved);
    expect(parsed.success).toBe(true);
    const previous = row({
      probes: ['#old-name', '#old-email', '#old-contact'],
      fieldMap: [
        { fieldKey: '#old-name', purpose: 'fullName', inputType: 'text', required: true },
        { fieldKey: '#old-email', purpose: 'email', inputType: 'text' },
        { fieldKey: '#old-contact', purpose: 'preferredContact', inputType: 'select' },
      ],
    });
    const stripped = extensionObserved.map(({ selector, label, type, count }) => ({
      selector,
      label,
      type,
      count,
    }));
    expect(proposeRepair(previous, extensionObserved)).toEqual(proposeRepair(previous, stripped));
  });

  it('rejects a value anywhere in an observation and does not echo it', () => {
    const secret = 'Jordan Sample';
    const cases = [
      {
        selector: '#applicant-name',
        label: 'Name',
        type: 'text',
        count: 1,
        value: secret,
      },
      {
        selector: '#contact-email',
        label: 'Email',
        type: 'radio',
        count: 1,
        question: 'Preferred contact method',
        note: { value: secret },
      },
    ];
    for (const input of cases) {
      const parsed = observedControlSchema.safeParse(input);
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      expect(detail).not.toContain(secret);
      expect(detail).not.toContain('Jordan');
      expect(JSON.stringify(parsed.error.issues)).not.toContain(secret);
    }
  });

  it('does not copy question text into a published field label', () => {
    const question = 'Preferred contact method';
    const proposal = proposeRepair(
      row({
        probes: ['#old-email'],
        fieldMap: [{ fieldKey: '#old-email', purpose: 'email', inputType: 'text' }],
      }),
      [
        {
          selector: '#contact-email',
          label: 'Email',
          type: 'email',
          count: 1,
          question,
          required: true,
        },
      ],
    );
    expect(proposal.publishable).toBe(true);
    expect(proposal.moved[0]?.reason).toContain('Email');
    expect(proposal.fieldMap).toEqual([
      expect.objectContaining({ fieldKey: '#contact-email', purpose: 'email', inputType: 'text' }),
    ]);
    expect(JSON.stringify(proposal.fieldMap)).not.toContain(question);
    expect(JSON.stringify(proposal)).not.toContain(question);
  });

  it('does not move a protected field or skip a tie because of question or required', () => {
    const protectedField = proposeRepair(
      row({
        probes: ['#ssn'],
        fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' }],
      }),
      [
        {
          selector: '#case-number',
          label: 'Case number',
          type: 'text',
          count: 1,
          required: true,
          question: 'Social Security Number',
        },
      ],
    );
    expect(protectedField.publishable).toBe(false);
    expect(protectedField.moved).toHaveLength(0);
    expect(protectedField.fieldMap).toHaveLength(0);

    const tie = proposeRepair(
      row({
        probes: ['#full', '#first'],
        fieldMap: [
          { fieldKey: '#full', purpose: 'fullName', inputType: 'text', required: true },
          { fieldKey: '#first', purpose: 'firstName', inputType: 'text' },
        ],
      }),
      [
        { selector: '#name-a', label: 'Name', type: 'text', count: 1, required: true },
        { selector: '#name-b', label: 'Name', type: 'text', count: 1, question: 'Full legal name' },
      ],
    );
    expect(tie.publishable).toBe(false);
    expect(tie.moved).toHaveLength(0);
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

  it('says the model is not required, and the dry run omits the brief', () => {
    expect(refusalBrief(proposal, observed)).toEqual({
      modelRequired: false,
      text: 'The model is not required for the map.',
    });
    expect(briefForDryRun(proposal, observed)).toBeNull();
    expect(JSON.stringify(refusalBrief(proposal, observed))).not.toMatch(/\d{3}-\d{2}-\d{4}/);
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

describe('a refusal brief', () => {
  const sample = '900-12-3456';

  it('names the SSN block and does not carry a value', () => {
    const observed = [{ selector: '#case-number', label: 'Case number', type: 'text', count: 1 }];
    const proposal = proposeRepair(
      row({
        probes: ['#ssn'],
        fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' }],
      }),
      observed,
    );
    const brief = briefForDryRun(proposal, observed);
    expect(proposal.publishable).toBe(false);
    expect(brief?.modelRequired).toBe(true);
    expect(brief?.unresolved).toEqual([
      expect.objectContaining({
        fieldKey: '#ssn',
        purpose: 'ssn',
        label: 'Social Security Number',
        reason: 'protected field would land on the wrong label',
        controls: [{ selector: '#case-number', label: 'Case number', count: 1 }],
      }),
    ]);
    expect(brief?.unmapped).toEqual([{ selector: '#case-number', label: 'Case number', count: 1 }]);
    expect(brief?.collisions).toEqual([]);
    expect(brief?.rules).toEqual([
      'Do not infer protected fields.',
      'Do not submit.',
      'Readback is still required for anything that does get filled.',
    ]);
    const text = brief?.text ?? '';
    expect(text).toContain('#ssn');
    expect(text).toContain('Case number');
    expect(text).toContain('#case-number');
    expect(text).toContain('protected field would land on the wrong label');
    expect(text).toContain('Do not infer protected fields.');
    expect(text).toContain('Do not submit.');
    expect(text).toContain('Readback is still required for anything that does get filled.');
    expect(JSON.stringify(brief)).not.toContain(sample);
    expect(JSON.stringify(brief)).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });

  it('rejects an observation that includes a value and does not echo it', () => {
    const observed = [
      { selector: '#case-number', label: 'Case number', type: 'text', count: 1, value: sample },
    ];
    const proposal = proposeRepair(
      row({
        probes: ['#ssn'],
        fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' }],
      }),
      [{ selector: '#case-number', label: 'Case number', type: 'text', count: 1 }],
    );
    expect(() => refusalBrief(proposal, observed)).toThrow(/included a value/);
    try {
      refusalBrief(proposal, observed);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(sample);
      expect((error as Error).message).not.toContain('900');
    }
  });

  it('names both labels and selectors on a tie', () => {
    const observed = [
      { selector: '#ssn-a', label: 'Social Security Number', type: 'text', count: 1 },
      { selector: '#ssn-b', label: 'Social Security Number', type: 'text', count: 1 },
    ];
    const proposal = proposeRepair(
      row({
        probes: ['#ssn'],
        fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text' }],
      }),
      observed,
    );
    const brief = refusalBrief(proposal, observed);
    expect(brief.modelRequired).toBe(true);
    if (!brief.modelRequired) return;
    expect(brief.unresolved.map((field) => field.reason)).toEqual(['tie']);
    expect(brief.unresolved[0]?.controls).toEqual([
      { selector: '#ssn-a', label: 'Social Security Number', count: 1 },
      { selector: '#ssn-b', label: 'Social Security Number', count: 1 },
    ]);
    expect(brief.collisions).toEqual([
      {
        label: 'Social Security Number',
        controls: [
          { selector: '#ssn-a', label: 'Social Security Number', count: 1 },
          { selector: '#ssn-b', label: 'Social Security Number', count: 1 },
        ],
      },
    ]);
    expect(brief.text).toContain('#ssn-a');
    expect(brief.text).toContain('#ssn-b');
    expect(brief.text).toContain('Social Security Number');
    expect(JSON.stringify(brief)).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });

  it('calls a name that is not unique a field that was dropped', () => {
    const observed = [{ selector: '#name', label: 'Name', type: 'text', count: 1 }];
    const proposal = proposeRepair(
      row({
        probes: ['#full'],
        fieldMap: [
          { fieldKey: '#full', purpose: 'fullName', inputType: 'text', required: true },
          { fieldKey: '#first', purpose: 'firstName', inputType: 'text' },
        ],
      }),
      observed,
    );
    const brief = refusalBrief(proposal, observed);
    expect(brief.modelRequired).toBe(true);
    if (!brief.modelRequired) return;
    expect(brief.unresolved.map((field) => [field.fieldKey, field.reason])).toEqual([
      ['#full', 'field dropped'],
      ['#first', 'field dropped'],
    ]);
    expect(brief.text).toContain('#name');
    expect(brief.text).toContain('field dropped');
  });
});
