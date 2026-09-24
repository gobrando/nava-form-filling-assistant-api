import { readFileSync } from 'node:fs';
import { wicSeedPlaybook } from '@/lib/playbooks/data';
import { observeHtml } from '@/lib/playbooks/observe-html';
import { briefForDryRun, refusalBrief } from '@/lib/playbooks/refusal-brief';
import type { PlaybookRow } from '@/lib/playbooks/registry';
import { proposeRepair } from '@/lib/playbooks/scribe';

/**
 * Rehearses the deterministic scribe against the drifted WIC fixture.
 *
 * No database, no model, no browser. This is the cold-path decision the API
 * makes when a caller sends `repair: true`: either every old field has one
 * control, or the run still needs an agent. Exit status is the check.
 */

const seed = wicSeedPlaybook();

const previous = {
  id: 'seed',
  tenantId: null,
  domain: seed.domain,
  programIds: [...seed.programIds],
  version: seed.version,
  name: seed.name,
  probes: [...seed.probes],
  fieldMap: seed.fieldMap.map((entry) => ({ ...entry })),
  safeAdvanceRules: seed.safeAdvanceRules,
  autoAdvance: seed.autoAdvance,
  note: seed.note,
  staleAt: new Date(),
  staleReason: 'selectors moved',
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies PlaybookRow;

const observed = observeHtml(readFileSync('tests/fixtures/wic-form-drifted.html', 'utf8'));
const proposal = proposeRepair(previous, observed);

const failures: string[] = [];
if (!proposal.publishable) failures.push(`expected a publishable repair: ${proposal.refused}`);
const keys = proposal.fieldMap.map((entry) => entry.fieldKey);
if (keys.includes('#case-number')) failures.push('case number was claimed');
if (keys.some((key) => key.startsWith('#edit-')))
  failures.push(`old id survived: ${keys.join(' ')}`);
if (proposal.probes.includes('#submit-application')) failures.push('submit button became a probe');

const ssnTrap = proposeRepair(
  {
    ...previous,
    probes: ['#ssn'],
    fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' }],
  },
  [
    { selector: '#case-number', label: 'Case number', type: 'text', count: 1 },
    { selector: '#applicant-ssn', label: 'Social Security Number', type: 'text', count: 1 },
  ],
);
if (ssnTrap.fieldMap[0]?.fieldKey !== '#applicant-ssn') {
  failures.push('SSN was not placed on the Social Security control');
}
if (ssnTrap.fieldMap.some((entry) => entry.fieldKey === '#case-number')) {
  failures.push('SSN was placed on the case number');
}

const wicBrief = refusalBrief(proposal, observed);
if (wicBrief.modelRequired || wicBrief.text !== 'The model is not required for the map.') {
  failures.push('publishable WIC drift should not require a model');
}

const ssnRefusalObserved = [
  { selector: '#case-number', label: 'Case number', type: 'text', count: 1 },
];
const ssnRefusal = proposeRepair(
  {
    ...previous,
    probes: ['#ssn'],
    fieldMap: [{ fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' }],
  },
  ssnRefusalObserved,
);
const ssnBrief = briefForDryRun(ssnRefusal, ssnRefusalObserved);
if (!ssnBrief) {
  failures.push('SSN refusal did not produce a brief');
} else if (!ssnBrief.text.includes('protected field would land on the wrong label')) {
  failures.push('SSN brief did not name the block');
} else if (!ssnBrief.text.includes('#case-number') || !ssnBrief.text.includes('#ssn')) {
  failures.push('SSN brief did not name the field and the case number');
} else if (/\d{3}-\d{2}-\d{4}/.test(JSON.stringify(ssnBrief))) {
  failures.push('SSN brief contained a value');
}

console.log(
  JSON.stringify(
    {
      publishable: proposal.publishable,
      refused: proposal.refused,
      moved: proposal.moved.map((item) => ({
        purpose: item.purpose,
        from: item.fromSelector,
        to: item.toSelector,
      })),
      probes: proposal.probes,
      unmapped: proposal.unmapped.map((item) => item.selector),
      ssnTrap: ssnTrap.fieldMap.map((entry) => ({
        purpose: entry.purpose,
        fieldKey: entry.fieldKey,
      })),
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
