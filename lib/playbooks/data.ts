import type { playbook } from '@/lib/db/schema';
import type { InferInsertModel } from 'drizzle-orm';

/**
 * The seed playbooks.
 *
 * These are the `PLAYBOOKS` object from the extension's
 * `content/form-agent.js`, lifted out of the bundle. Probe selectors come from
 * there and from the `form-completion` skill's `playbooks/*.md` freshness
 * probes, which are the same selectors written two ways.
 *
 * Every probe must resolve on the live page. A miss means the site changed, the
 * playbook is stale, and the run falls back to the model — this is the routing
 * decision that keeps the warm path free of inference.
 *
 * `tenantId: null` marks these as shared control-plane knowledge. Site
 * structure is not participant data.
 */

export type PlaybookSeed = Omit<
  InferInsertModel<typeof playbook>,
  'id' | 'createdAt' | 'updatedAt' | 'tenantId'
>;

export const SEED_PLAYBOOKS: PlaybookSeed[] = [
  {
    domain: 'benefitscal.com',
    name: 'California benefits application',
    programIds: ['calfresh', 'medical', 'calworks'],
    version: 1,
    probes: ['#primarylang', '#addressLine1', '#zip5', '#birthDate_primary_input', '#ssn'],
    fieldMap: [
      { fieldKey: '#primarylang', purpose: 'primaryLanguage', inputType: 'select' },
      { fieldKey: '#addressLine1', purpose: 'addressLine1', inputType: 'text' },
      { fieldKey: '#zip5', purpose: 'postalCode', inputType: 'text' },
      {
        fieldKey: '#birthDate_primary_input',
        purpose: 'dateOfBirth',
        inputType: 'date',
        mask: 'MM/DD/YYYY',
        // A masked field rejects a bulk fill and reports success anyway. Keys
        // are the only write that lands. This is the silent-success failure
        // class the skill's Phase 4 readback exists to catch.
        method: 'keys',
      },
      { fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' },
    ],
    safeAdvanceRules: [
      { labels: ['start', 'start your information'], path: '/ApplyForBenefits/ABNAV' },
    ],
    autoAdvance: true,
    note: 'Automatic continuation is limited to exact Begin, Next, and Continue controls.',
  },
  {
    domain: 'riversideihss.org',
    name: 'Riverside County IHSS application',
    programIds: ['ihss'],
    version: 1,
    probes: ['#firstNameTxt', '#ssnTxt', '#btnSubmit'],
    fieldMap: [
      { fieldKey: '#firstNameTxt', purpose: 'firstName', inputType: 'text' },
      { fieldKey: '#ssnTxt', purpose: 'ssn', inputType: 'text', method: 'keys' },
    ],
    safeAdvanceRules: [],
    autoAdvance: true,
    note: 'Confirmed mask, gate, and submit-check behavior.',
  },
  {
    domain: 'www.ruhealth.org',
    name: 'Riverside University Health System WIC application',
    programIds: ['wic'],
    version: 1,
    probes: ['#edit-name', '#edit-please-choose-the-wic-clinic-closest-to-you', '#edit-submit'],
    fieldMap: [
      { fieldKey: '#edit-name', purpose: 'fullName', inputType: 'text', required: true },
      { fieldKey: '#edit-phone', purpose: 'phone', inputType: 'text' },
      { fieldKey: '#edit-email', purpose: 'email', inputType: 'text' },
      { fieldKey: '#edit-zip-code', purpose: 'postalCode', inputType: 'text' },
      {
        fieldKey: '#edit-please-choose-the-wic-clinic-closest-to-you',
        // Deduced from the home address rather than asked, per the
        // benefits-application skill's "Filling Fields" rule. Not protected,
        // so inference is allowed and recorded as such.
        purpose: null,
        inputType: 'select',
        required: true,
      },
      { fieldKey: '#edit-preferred-language', purpose: 'primaryLanguage', inputType: 'select' },
    ],
    safeAdvanceRules: [],
    // The WIC form is a single inline page behind a CAPTCHA, so there is
    // nothing to advance to and auto-advance would only race the bot check.
    autoAdvance: false,
    note: 'Single inline form with a CAPTCHA gate. The caseworker clears the gate and submits.',
  },
];

/** The seeded WIC playbook, with the fields the scribe rehearsal reads. */
export function wicSeedPlaybook() {
  const seed = SEED_PLAYBOOKS.find((item) => item.programIds?.includes('wic'));
  if (
    !seed?.programIds ||
    !seed.fieldMap ||
    !seed.probes ||
    !seed.domain ||
    !seed.name ||
    seed.version === undefined ||
    seed.autoAdvance === undefined
  ) {
    throw new Error('The WIC seed playbook is missing.');
  }
  return {
    domain: seed.domain,
    name: seed.name,
    programIds: seed.programIds,
    version: seed.version,
    probes: seed.probes,
    fieldMap: seed.fieldMap,
    safeAdvanceRules: seed.safeAdvanceRules ?? [],
    autoAdvance: seed.autoAdvance,
    note: seed.note ?? null,
  };
}
