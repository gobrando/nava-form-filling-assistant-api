import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PlaybookSeed, SEED_PLAYBOOKS } from '@/lib/playbooks/data';
import { observeHtml } from '@/lib/playbooks/observe-html';
import type { PlaybookRow } from '@/lib/playbooks/registry';
import { type Placement, type RepairProposal, proposeRepair } from '@/lib/playbooks/scribe';

/**
 * Scores fictional county pages with the deterministic scribe.
 *
 * Each fixture is observed the way a caller observes a live page, then
 * placed with `proposeRepair` onto the served playbook for that program.
 * No database and no model. A publishable row is a drift the warm path can
 * absorb. A refusal is work that still belongs to the model scribe.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export type DriftFixture = {
  id: string;
  file: string;
  /** Lookup key into the served seed playbooks. */
  programId: string;
  /** One line on what changed, for the report. */
  blurb: string;
};

export const DRIFT_FIXTURES: readonly DriftFixture[] = [
  {
    id: 'wic-form-drifted',
    file: 'tests/fixtures/wic-form-drifted.html',
    programId: 'wic',
    blurb:
      'The rehearsal page. Every WIC question is still labeled, the ids moved, and a case number was added.',
  },
  {
    id: 'wic-saltmere-county',
    file: 'tests/fixtures/drift/wic-saltmere-county.html',
    programId: 'wic',
    blurb:
      'Saltmere County WIC. Email kept its selector. The other ids moved. A case number sits beside them.',
  },
  {
    id: 'ihss-cedar-hollow',
    file: 'tests/fixtures/drift/ihss-cedar-hollow.html',
    programId: 'ihss',
    blurb:
      'Cedar Hollow County IHSS. First name and Social Security Number kept their labels under new ids. A signature date and a date of birth are also on the page.',
  },
  {
    id: 'briar-medicaid-snap-tie',
    file: 'tests/fixtures/drift/briar-medicaid-snap-tie.html',
    programId: 'calfresh',
    blurb:
      'Briar County Medicaid and SNAP renewal. Home and mailing address share one label, so the street field is a tie.',
  },
  {
    id: 'hearth-ssn-relabeled',
    file: 'tests/fixtures/drift/hearth-ssn-relabeled.html',
    programId: 'calfresh',
    blurb:
      'Hearth County benefits application. The SSN selector changed. The label is still Social Security Number, next to a case number.',
  },
  {
    id: 'quill-ssn-case-number',
    file: 'tests/fixtures/drift/quill-ssn-case-number.html',
    programId: 'calfresh',
    blurb:
      'Quill County benefits application. The SSN control is gone. The only nearby identifier is Case number.',
  },
  {
    id: 'moss-wic-new-question',
    file: 'tests/fixtures/drift/moss-wic-new-question.html',
    programId: 'wic',
    blurb:
      'Moss County WIC. The served selectors still match, and the page added a required household question.',
  },
  {
    id: 'fable-wic-dropped-phone',
    file: 'tests/fixtures/drift/fable-wic-dropped-phone.html',
    programId: 'wic',
    blurb: 'Fable County WIC. The phone field was removed and no remaining label names it.',
  },
  {
    id: 'saltmere-signature-date',
    file: 'tests/fixtures/drift/saltmere-signature-date.html',
    programId: 'medical',
    blurb:
      'Saltmere County medical renewal. The birth-date control is gone. The only date on the page is Signature date.',
  },
];

export type DriftScore = {
  id: string;
  file: string;
  programId: string;
  programs: string;
  playbookName: string;
  blurb: string;
  publishable: boolean;
  kept: Placement[];
  moved: Placement[];
  unresolved: Placement[];
  unmapped: RepairProposal['unmapped'];
  refused: string | null;
  reason: string;
  proposal: RepairProposal;
};

function seedFor(programId: string): PlaybookSeed {
  const seed = SEED_PLAYBOOKS.find((item) => item.programIds?.includes(programId));
  if (!seed?.domain || !seed.name || !seed.programIds || !seed.fieldMap || !seed.probes) {
    throw new Error(`No served playbook for ${programId}.`);
  }
  return seed;
}

function previousRow(seed: PlaybookSeed): PlaybookRow {
  return {
    id: 'drift-lab',
    tenantId: null,
    domain: seed.domain ?? '',
    programIds: [...(seed.programIds ?? [])],
    version: seed.version ?? 1,
    name: seed.name ?? '',
    probes: [...(seed.probes ?? [])],
    fieldMap: (seed.fieldMap ?? []).map((entry) => ({ ...entry })),
    safeAdvanceRules: seed.safeAdvanceRules ?? [],
    autoAdvance: seed.autoAdvance ?? false,
    note: seed.note ?? null,
    staleAt: new Date(),
    staleReason: 'selectors moved',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function reasonFor(id: string, proposal: RepairProposal): string {
  switch (id) {
    case 'wic-form-drifted':
      return proposal.publishable
        ? 'A model is not required: every previous WIC field still has one label, and the case number stays unmapped.'
        : `A model is required: ${proposal.refused ?? 'the WIC repair was refused.'}`;
    case 'wic-saltmere-county':
      return proposal.publishable
        ? 'A model is not required: the email selector still matches, the other WIC fields each have one label, and the case number stays unmapped.'
        : `A model is required: ${proposal.refused ?? 'the Saltmere WIC repair was refused.'}`;
    case 'ihss-cedar-hollow':
      return proposal.publishable
        ? 'A model is not required to move first name and Social Security Number. The signature date stays unmapped, and the served IHSS playbook has no date of birth for it to inherit.'
        : `A model is required: ${proposal.refused ?? 'the IHSS repair was refused.'}`;
    case 'briar-medicaid-snap-tie':
      return proposal.publishable
        ? 'A model is not required, which means a shared Street address label was treated as a unique match.'
        : 'A model is required: two controls share the label Street address, so the address field is a tie and publish is refused.';
    case 'hearth-ssn-relabeled':
      return proposal.publishable
        ? 'A model is not required: the Social Security Number label uniquely names the new selector, and the case number stays unmapped.'
        : `A model is required: ${proposal.refused ?? 'the Social Security Number could not be placed.'}`;
    case 'quill-ssn-case-number':
      return proposal.publishable
        ? 'A model is not required, which means the SSN was placed on Case number.'
        : 'A model is required: the Social Security Number selector is gone, Case number is the only nearby identifier, and the scribe refuses to guess.';
    case 'moss-wic-new-question':
      return proposal.publishable
        ? 'A model is not required to republish the known WIC fields. The new household question stays unmapped, so a green row leaves it blank.'
        : `A model is required: ${proposal.refused ?? 'the known WIC fields could not be republished.'}`;
    case 'fable-wic-dropped-phone':
      return proposal.publishable
        ? 'A model is not required, which means the missing phone field was dropped from the map and the rest was published.'
        : 'A model is required: the phone field is gone and has no remaining label, and one unresolved field blocks publish.';
    case 'saltmere-signature-date':
      return proposal.publishable
        ? 'A model is not required, which means the signature date was published as the date of birth.'
        : 'A model is required: the date-of-birth control is gone, the signature date does not name a birth date, and publish is refused.';
    default:
      throw new Error(`No scorecard sentence for ${id}.`);
  }
}

export function scoreDriftLab(root = ROOT): DriftScore[] {
  return DRIFT_FIXTURES.map((fixture) => {
    const seed = seedFor(fixture.programId);
    const html = readFileSync(join(root, fixture.file), 'utf8');
    const proposal = proposeRepair(previousRow(seed), observeHtml(html));
    return {
      id: fixture.id,
      file: fixture.file,
      programId: fixture.programId,
      programs: (seed.programIds ?? []).join(', '),
      playbookName: seed.name ?? fixture.programId,
      blurb: fixture.blurb,
      publishable: proposal.publishable,
      kept: proposal.kept,
      moved: proposal.moved,
      unresolved: proposal.unresolved,
      unmapped: proposal.unmapped,
      refused: proposal.refused,
      reason: reasonFor(fixture.id, proposal),
      proposal,
    };
  });
}

function placementName(item: Placement): string {
  return item.purpose ?? '(no purpose)';
}

function formatPlacements(items: Placement[], disposition: Placement['disposition']): string {
  if (items.length === 0) return '—';
  return items
    .map((item) => {
      if (disposition === 'moved') {
        return `${placementName(item)} ${item.fromSelector} → ${item.toSelector}`;
      }
      if (disposition === 'unresolved') return `${placementName(item)} (${item.fromSelector})`;
      return `${placementName(item)} ${item.toSelector}`;
    })
    .join(', ');
}

function formatUnmapped(items: RepairProposal['unmapped']): string {
  if (items.length === 0) return '—';
  return items.map((item) => `${item.selector}${item.label ? ` (${item.label})` : ''}`).join(', ');
}

export function formatScorecard(scores: DriftScore[]): string {
  const closed = scores.filter((score) => score.publishable).length;
  const lines = [
    'Scribe drift lab',
    'Deterministic proposeRepair. No API key. No database.',
    '',
    `${closed} of ${scores.length} fixtures publish. ${scores.length - closed} are refused.`,
    '',
  ];
  for (const score of scores) {
    lines.push(score.id);
    lines.push(`  file: ${score.file}`);
    lines.push(`  playbook: ${score.playbookName} (${score.programs})`);
    lines.push(`  publishable: ${score.publishable ? 'yes' : 'no'}`);
    lines.push(`  kept (${score.kept.length}): ${formatPlacements(score.kept, 'kept')}`);
    lines.push(`  moved (${score.moved.length}): ${formatPlacements(score.moved, 'moved')}`);
    lines.push(
      `  unresolved (${score.unresolved.length}): ${formatPlacements(score.unresolved, 'unresolved')}`,
    );
    lines.push(`  unmapped (${score.unmapped.length}): ${formatUnmapped(score.unmapped)}`);
    lines.push(`  ${score.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|');
}

export function renderReport(scores: DriftScore[]): string {
  const closed = scores.filter((score) => score.publishable);
  const refused = scores.filter((score) => !score.publishable);
  const table = [
    '| Fixture | Playbook | Publishable | Kept | Moved | Unresolved | Unmapped |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...scores.map(
      (score) =>
        `| ${markdownCell(score.id)} | ${markdownCell(score.programs)} | ${score.publishable ? 'yes' : 'no'} | ${score.kept.length} | ${score.moved.length} | ${score.unresolved.length} | ${score.unmapped.length} |`,
    ),
  ];

  const closedLines = closed.map((score) => `- **${score.id}.** ${score.reason}`);
  const refusedLines = refused.map(
    (score) =>
      `- **${score.id}.** ${score.reason}${score.refused ? ` Refusal: ${score.refused}` : ''}`,
  );
  const notes = scores.map(
    (score) => `### ${score.id}\n\n${score.blurb} \`${score.file}\`.\n\n${score.reason}`,
  );

  return [
    '<!-- Generated by `pnpm drift`. Do not edit by hand. -->',
    '',
    '# Scribe drift lab',
    '',
    'This is a local scorecard for the deterministic playbook scribe. It runs `proposeRepair` on fictional county pages and the served program playbook. It does not call a model, open a database, or submit a form.',
    '',
    'Brandon Canniff can run it from a checkout of this repo:',
    '',
    '```bash',
    'pnpm drift',
    '```',
    '',
    'That prints the scorecard below and rewrites this file. The fixtures live in `tests/fixtures/drift/`. The rehearsal page `tests/fixtures/wic-form-drifted.html` is included and left where `pnpm rehearse` reads it.',
    '',
    `**${closed.length} of ${scores.length} fixtures publish. ${refused.length} are refused.** A refusal is the case that still needs the model scribe. Eve, that model path, has not been run.`,
    '',
    '## Scorecard',
    '',
    ...table,
    '',
    '## What the deterministic scribe closes',
    '',
    'These pages changed, and every field the playbook already knew still had one unambiguous label. The warm path can take the repaired map. No model call is required to place those fields.',
    '',
    ...(closedLines.length > 0 ? closedLines : ['- None of the fixtures published.']),
    '',
    '## What still belongs to the model scribe',
    '',
    'Publish is all or nothing. One unresolved field withholds the map, including fields that did have a unique label. The refusals below are the job of the model scribe: a tie, a protected identifier with no distinctive label, a field the page dropped, and a signature date that must not inherit a birth date.',
    '',
    ...(refusedLines.length > 0 ? refusedLines : ['- None of the fixtures were refused.']),
    '',
    'Cedar Hollow stays on the publishable side for a narrower reason. The served IHSS playbook places first name and Social Security Number only, so a signature date on that page has no birth-date field to inherit and stays unmapped. The Saltmere medical renewal is the same trap against the BenefitsCal playbook, which does place date of birth.',
    '',
    '## What a green score does not prove',
    '',
    '- A published map still has to be read back. The Saltmere WIC ZIP has `maxlength="5"`, and the rehearsal WIC ZIP is shorter than that. A control can accept a write and hold a truncated value. Repair does not check the value, because the scribe never sees one.',
    '- A person submits the application. Submit controls are ignored. This lab does not file anything.',
    '- Publish is all or nothing. The placements inside a refused proposal are not a playbook version. One unresolved field blocks the rest.',
    '- A green row can leave a new required question blank. Moss County adds a household question the WIC playbook does not know. The known fields republish, and that question stays unmapped. The warm path will not fill it and will not call the model to learn it.',
    '- A green IHSS row does not mean date of birth was understood. Cedar Hollow shows a birth date and a signature date. Neither is in the served IHSS map, so neither is filled.',
    '',
    '## Fixtures',
    '',
    ...notes.flatMap((note) => [note, '']),
    '',
  ].join('\n');
}
