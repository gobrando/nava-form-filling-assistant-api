import { FIELD_KEYS } from '@/lib/vocabulary';
import type { InventoryField, SourceRef } from './engine';

/**
 * A fictional IHSS-sized page.
 *
 * The labels are the kinds of questions an in-home supportive services
 * application asks. They are not copied from a county form. Sources cover the
 * identity block a case record usually has. Everything else is a client
 * question, and the identifier controls must stay blank.
 */
export const IHSS_FIELDS: InventoryField[] = [
  field(
    'applicant_first',
    'Applicant first name',
    'What is your first name?',
    'text',
    true,
    'firstName',
  ),
  field(
    'applicant_last',
    'Applicant last name',
    'What is your last name?',
    'text',
    true,
    'lastName',
  ),
  field(
    'applicant_dob',
    'Date of birth',
    'What is your date of birth?',
    'date',
    true,
    'dateOfBirth',
  ),
  field('phone', 'Phone number', 'What is your phone number?', 'text', true, 'phone'),
  field('street', 'Street address', 'What is your street address?', 'text', true, 'addressLine1'),
  field('city', 'City', 'What city do you live in?', 'text', true, 'city'),
  field('zip', 'ZIP code', 'What is your ZIP code?', 'text', true, 'postalCode'),
  field(
    'language',
    'Primary language',
    'What language do you prefer?',
    'text',
    true,
    'primaryLanguage',
  ),
  field('email', 'Email address', 'What is your email address?', 'text', false, 'email'),
  field('ssn', 'Social Security Number', 'Social Security Number', 'text', true),
  field('cin', 'Medi-Cal number', 'Medi-Cal number', 'text', false),
  field('county', 'County of residence', 'Which county do you live in?', 'text', true),
  field('lives_alone', 'Lives alone', 'Do you live alone?', 'select', true, '', ['Yes', 'No']),
  field(
    'representative',
    'Authorized representative',
    'Who may speak for you about this application?',
    'text',
    false,
  ),
  field(
    'hours',
    'Weekly care hours',
    'How many hours of care do you need in a week?',
    'number',
    true,
  ),
  field(
    'provider_relation',
    'Provider relationship',
    'How is the care provider related to you?',
    'select',
    true,
    '',
    ['Spouse', 'Adult child', 'Other relative', 'Not related'],
  ),
  field(
    'provider_in_home',
    'Provider lives in the home',
    'Does the care provider live with you?',
    'select',
    true,
    '',
    ['Yes', 'No'],
  ),
  field(
    'mailing_same',
    'Mailing address is the home address',
    'Should mail go to the home address?',
    'select',
    true,
    '',
    ['Yes', 'No'],
  ),
  field(
    'emergency_name',
    'Emergency contact name',
    'Who should we call in an emergency?',
    'text',
    true,
  ),
  field(
    'emergency_phone',
    'Emergency contact phone',
    "What is that person's phone number?",
    'text',
    true,
  ),
  field(
    'vision',
    'Blind or visually impaired',
    'Are you blind or visually impaired?',
    'select',
    true,
    '',
    ['Yes', 'No'],
  ),
  field(
    'supervision',
    'Protective supervision',
    'Do you need protective supervision?',
    'select',
    true,
    '',
    ['Yes', 'No'],
  ),
  field(
    'paramedical',
    'Paramedical services',
    'Do you need paramedical services?',
    'select',
    true,
    '',
    ['Yes', 'No'],
  ),
  field('ssi', 'SSI income', 'Do you receive SSI?', 'select', true, '', ['Yes', 'No']),
  field(
    'contact_method',
    'Preferred contact method',
    'How should we contact you?',
    'select',
    true,
    '',
    ['Phone', 'Email', 'Mail'],
  ),
  field('signature_date', 'Signature date', 'Date signed', 'date', true),
];

export const IHSS_SOURCES: SourceRef[] = [
  { purpose: 'firstName', label: 'First name', kind: 'string', sensitive: false },
  { purpose: 'lastName', label: 'Last name', kind: 'string', sensitive: false },
  { purpose: 'dateOfBirth', label: 'Date of birth', kind: 'date', sensitive: false },
  { purpose: 'phone', label: 'Phone', kind: 'string', sensitive: false },
  { purpose: 'addressLine1', label: 'Street address', kind: 'string', sensitive: false },
  { purpose: 'city', label: 'City', kind: 'string', sensitive: false },
  { purpose: 'postalCode', label: 'ZIP code', kind: 'string', sensitive: false },
  { purpose: 'primaryLanguage', label: 'Primary language', kind: 'string', sensitive: false },
  { purpose: 'email', label: 'Email', kind: 'string', sensitive: false },
];

export const IHSS_ALLOWED = new Set<string>(FIELD_KEYS);

function field(
  fieldKey: string,
  label: string,
  question: string,
  type: string,
  required: boolean,
  purposeHint = '',
  options: string[] = [],
): InventoryField {
  return { fieldKey, type, label, question, required, alreadyFilled: false, purposeHint, options };
}
