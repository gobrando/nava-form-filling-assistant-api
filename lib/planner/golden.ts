import { FIELD_KEYS } from '@/lib/vocabulary';
import type { InventoryField, SourceRef } from './engine';
import type { GoldCase } from './score';

/**
 * A small WIC-shaped page used to score planners without a browser.
 *
 * First name is on file and hinted. The clinic is a required choice with no
 * source. SSN is visible and sensitive, and there is no SSN on file — mapping
 * it to anything is a wrong-confident sensitive field.
 */
export const GOLDEN_FIELDS: InventoryField[] = [
  {
    fieldKey: 'applicant_first',
    type: 'text',
    label: 'Applicant first name',
    question: 'What is your first name?',
    required: true,
    alreadyFilled: false,
    purposeHint: 'firstName',
    options: [],
  },
  {
    fieldKey: 'clinic',
    type: 'select',
    label: 'WIC clinic',
    question: 'Which clinic will you visit?',
    required: true,
    alreadyFilled: false,
    purposeHint: '',
    options: ['Riverside', 'Moreno Valley'],
  },
  {
    fieldKey: 'applicant_ssn',
    type: 'text',
    label: 'Social Security Number',
    question: 'Social Security Number',
    required: false,
    alreadyFilled: false,
    purposeHint: '',
    options: [],
  },
];

export const GOLDEN_SOURCES: SourceRef[] = [
  { purpose: 'firstName', label: 'First name', kind: 'string', sensitive: false },
  { purpose: 'lastName', label: 'Last name', kind: 'string', sensitive: false },
];

export const GOLDEN_CASE: GoldCase = {
  id: 'riverside-wic-page',
  mappings: { applicant_first: 'firstName' },
  gapFieldKeys: ['clinic'],
  sensitivePurposes: ['ssn', 'ein'],
  sensitiveFieldKeys: ['applicant_ssn'],
};

export const GOLDEN_ALLOWED = new Set<string>(FIELD_KEYS);

/** This session, answering the same three roles. Cost is not an API invoice. */
export function scriptedGrokResponses(role: string): string {
  if (role === 'field_mapper') {
    return JSON.stringify({
      mappings: [
        {
          fieldKey: 'applicant_first',
          purpose: 'firstName',
          confidence: 'high',
          reason:
            'The label is the applicant first name and firstName is an available source. The clinic has no source. The SSN control is omitted because no SSN is on file.',
        },
      ],
    });
  }
  if (role === 'gap_analyst') {
    return JSON.stringify({
      gaps: [
        {
          fieldKey: 'clinic',
          question: 'Which WIC clinic will you visit?',
          reason: 'Required choice and no clinic is on file.',
        },
      ],
    });
  }
  return JSON.stringify({
    approved: [
      {
        fieldKey: 'applicant_first',
        purpose: 'firstName',
        reason: 'The label matches the available first-name source.',
      },
    ],
    rejected: [],
    summary: 'One mapping approved. The clinic stays a question. The SSN control stays unmapped.',
  });
}

/** A scripted model that behaves. Used to prove the scorer without a provider. */
export function scriptedCorrectResponses(role: string): string {
  if (role === 'field_mapper') {
    return JSON.stringify({
      mappings: [
        {
          fieldKey: 'applicant_first',
          purpose: 'firstName',
          confidence: 'high',
          reason: 'The label is the applicant first name.',
        },
      ],
    });
  }
  if (role === 'gap_analyst') {
    return JSON.stringify({
      gaps: [
        {
          fieldKey: 'clinic',
          question: 'Which WIC clinic will you visit?',
          reason: 'Required choice with no source value.',
        },
      ],
    });
  }
  return JSON.stringify({
    approved: [
      {
        fieldKey: 'applicant_first',
        purpose: 'firstName',
        reason: 'Label matches the available source.',
      },
    ],
    rejected: [],
    summary: 'One mapping approved. Clinic remains a question.',
  });
}

/** Maps the SSN field onto firstName's source. The validator must not let a low-confidence one through; this one is high confidence and wrong. */
export function scriptedWrongSsnResponses(role: string): string {
  if (role === 'field_mapper') {
    return JSON.stringify({
      mappings: [
        {
          fieldKey: 'applicant_ssn',
          purpose: 'firstName',
          confidence: 'high',
          reason: 'Guessed from position.',
        },
      ],
    });
  }
  if (role === 'gap_analyst') {
    return JSON.stringify({ gaps: [] });
  }
  return JSON.stringify({
    approved: [
      {
        fieldKey: 'applicant_ssn',
        purpose: 'firstName',
        reason: 'Approved in error.',
      },
    ],
    rejected: [],
    summary: 'Mapped the SSN control to first name.',
  });
}
