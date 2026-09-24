import { readFileSync } from 'node:fs';
import {
  VALUE_REJECTION as REJECTION,
  type RepairQuery,
  queryCarriesValue,
} from '@/lib/demo/repair-query';
import { wicSeedPlaybook } from '@/lib/playbooks/data';
import { observeHtml } from '@/lib/playbooks/observe-html';
import type { PlaybookRow } from '@/lib/playbooks/registry';
import {
  type ObservedControl,
  type Placement,
  type RepairProposal,
  observedControlSchema,
  proposeRepair,
} from '@/lib/playbooks/scribe';
import { isProtectedField, labelFor } from '@/lib/vocabulary';

/**
 * The caseworker view of a dry-run repair.
 *
 * The scribe decides what can move. This module only reads a form the
 * caseworker already has open, asks `proposeRepair`, and turns that proposal
 * into sentences. An observation is selectors, labels, and counts. A filled-in
 * value, in the fixture or on the query string, rejects the page.
 *
 * Publishing is separate. The demo save goes through the app role and
 * `publishRepair`, which inserts a tenant row. The shared playbook is not
 * updated here.
 */

export type { RepairQuery } from '@/lib/demo/repair-query';

export type DeskForm = 'wic' | 'ihss';

export type RepairNotice = 'saved' | 'refused' | 'needs-database';

export type RepairLine = {
  label: string;
  sentence: string;
};

export type MovedLine = RepairLine & {
  from: string;
  to: string;
};

export type RefusedLine = RepairLine & {
  kind: 'tie' | 'protected' | 'missing' | 'other';
};

export type RepairDesk = {
  form: DeskForm;
  programName: string;
  title: string;
  intro: string;
  rejected: string | null;
  notice: RepairNotice | null;
  statusNote: string | null;
  readback: string | null;
  kept: RepairLine[];
  moved: MovedLine[];
  refused: RefusedLine[];
  unmapped: RepairLine[];
  publishable: boolean;
  publishNote: string;
  proposal: RepairProposal | null;
};

const DEMO_SLUG = 'participant-demo';

const REJECTION_NOTICE = 'rejected';

const FIXTURES: Record<DeskForm, string> = {
  wic: 'tests/fixtures/wic-form-drifted.html',
  ihss: 'tests/fixtures/ihss-form-drifted.html',
};

const STATUS_NOTE: Record<RepairNotice, string> = {
  saved:
    'Saved a new version for the demo organization. The shared playbook was left as it was. The form was not sent to the county.',
  refused:
    'Nothing was published. A field on this form would have been a guess, so the repair stopped.',
  'needs-database':
    'The demo database is not available, so nothing was published. The proposal on this page is still the dry run. Publish with the API call once the proposal says it can be published.',
};

/**
 * Words too common to decide that a label names a field. Used only to choose
 * a sentence for a refusal the scribe already made.
 */
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'your',
  'you',
  'what',
  'this',
  'that',
  'from',
  'please',
  'date',
  'code',
  'number',
]);

const ALIASES: Record<string, string> = {
  postalCode: 'zip postal',
  dateOfBirth: 'birth dob birthday',
  ssn: 'ssn social security',
  ein: 'ein employer',
  phone: 'phone telephone mobile',
  email: 'email',
  primaryLanguage: 'language',
  fullName: 'full',
  firstName: 'first',
  lastName: 'last',
  addressLine1: 'street',
  income: 'income wages',
  childcare: 'childcare daycare',
  unemployment: 'unemployment',
  preferredContact: 'contact',
};

export function loadRepairDesk(query: RepairQuery): RepairDesk {
  if (queryCarriesValue(query) || noticeValue(query.notice) === REJECTION_NOTICE) {
    return emptyDesk(REJECTION, null);
  }
  const notice = readNotice(query.notice);
  const form: DeskForm = query.form === 'ihss' ? 'ihss' : 'wic';
  const html = readFileSync(FIXTURES[form], 'utf8');
  return buildRepairDesk({ form, html, notice });
}

export function buildRepairDesk(input: {
  form: DeskForm;
  html: string;
  notice?: RepairNotice | null;
}): RepairDesk {
  const notice = input.notice ?? null;
  if (fixtureCarriesFilledValue(input.html)) return emptyDesk(REJECTION, notice);
  const observed = observeHtml(input.html);
  for (const control of observed) {
    const parsed = observedControlSchema.safeParse(control);
    if (!parsed.success || 'value' in control) return emptyDesk(REJECTION, notice);
  }
  const previous = previousPlaybook(input.form);
  const proposal = proposeRepair(previous, observed);
  return presentDesk(input.form, input.html, observed, proposal, notice);
}

export function previousPlaybook(form: DeskForm): PlaybookRow {
  if (form === 'wic') return wicPlaybook();
  return ihssPlaybook();
}

export function fixtureCarriesFilledValue(html: string): boolean {
  if (/<(?:input|textarea|select|button)\b[^>]*\bvalue\s*=\s*"[^"]+"/i.test(html)) return true;
  if (/<(?:input|textarea|select|button)\b[^>]*\bvalue\s*=\s*'[^']+'/i.test(html)) return true;
  if (/<textarea\b[^>]*>\s*\S/i.test(html)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(html)) return true;
  return false;
}

/**
 * Saves the open form's proposal for the demo organization.
 *
 * Refusals and a missing database return before any connection. The write uses
 * `POSTGRES_URL` (the app role) and `withTenant`. `publishRepair` inserts a
 * tenant version. This function then checks that shared rows for the domain
 * were not updated, and rolls the transaction back if they were.
 */
export async function publishDemoRepair(
  formName: string,
): Promise<'saved' | 'refused' | 'needs-database'> {
  if (formName !== 'wic' && formName !== 'ihss') return 'refused';
  const desk = loadRepairDesk({ form: formName });
  if (!desk.proposal?.publishable) return 'refused';
  if (!process.env.POSTGRES_URL) return 'needs-database';
  try {
    await writeTenantRepair(previousPlaybook(formName), desk.proposal);
    return 'saved';
  } catch (error) {
    console.error('Demo repair publish failed', error instanceof Error ? error.name : 'unknown');
    return 'needs-database';
  }
}

export function zipTruncationNote(html: string): string | null {
  const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const input of inputs) {
    const id = /(?:^|\s)id="([^"]+)"/i.exec(input)?.[1] ?? '';
    const name = /(?:^|\s)name="([^"]+)"/i.exec(input)?.[1] ?? '';
    const max = /maxlength="(\d+)"/i.exec(input);
    if (!max) continue;
    const limit = Number(max[1]);
    if (!Number.isFinite(limit) || limit >= 5) continue;
    if (!/zip|postal/i.test(`${id} ${name}`)) continue;
    return `The ZIP code box on this form only holds ${limit} characters. A ZIP code is 5 digits. Publishing a repaired map does not skip readback. If five digits are entered and only ${limit} land, that stays a question.`;
  }
  return null;
}

async function writeTenantRepair(previous: PlaybookRow, proposal: RepairProposal): Promise<void> {
  const { db, schema, withTenant } = await import('@/lib/db');
  const { publishRepair } = await import('@/lib/playbooks/scribe');
  const { and, eq, isNull } = await import('drizzle-orm');
  const existing = await db
    .select({ id: schema.tenant.id })
    .from(schema.tenant)
    .where(eq(schema.tenant.slug, DEMO_SLUG))
    .limit(1);
  let tenantId = existing[0]?.id;
  if (!tenantId) {
    const [created] = await db
      .insert(schema.tenant)
      .values({ slug: DEMO_SLUG, name: 'Demo Community Services' })
      .returning({ id: schema.tenant.id });
    tenantId = created?.id;
  }
  if (!tenantId) throw new Error('The demo organization is missing.');

  await withTenant(tenantId, async (tx) => {
    const sharedBefore = await tx
      .select({
        id: schema.playbook.id,
        version: schema.playbook.version,
        tenantId: schema.playbook.tenantId,
      })
      .from(schema.playbook)
      .where(and(eq(schema.playbook.domain, previous.domain), isNull(schema.playbook.tenantId)));
    const published = await publishRepair(tx, tenantId, 'demo-caseworker', previous, proposal);
    if (published.row.tenantId !== tenantId) {
      throw new Error('Refusing to keep a repair that is not scoped to the demo organization.');
    }
    const sharedAfter = await tx
      .select({
        id: schema.playbook.id,
        version: schema.playbook.version,
        tenantId: schema.playbook.tenantId,
      })
      .from(schema.playbook)
      .where(and(eq(schema.playbook.domain, previous.domain), isNull(schema.playbook.tenantId)));
    if (JSON.stringify(sharedBefore) !== JSON.stringify(sharedAfter)) {
      throw new Error('The shared playbook changed.');
    }
  });
}

function presentDesk(
  form: DeskForm,
  html: string,
  observed: ObservedControl[],
  proposal: RepairProposal,
  notice: RepairNotice | null,
): RepairDesk {
  const programName = form === 'wic' ? 'WIC' : 'IHSS';
  const bySelector = new Map(observed.map((control) => [control.selector, control]));
  return {
    form,
    programName,
    title: `${programName} form · repair`,
    intro:
      form === 'wic'
        ? 'This is the WIC form you already have open, after the ids changed. The questions are the same. This page starts as a dry run. It does not send the form to the county.'
        : 'This is an IHSS-sized form you already have open, after some ids changed. Where one label still names a box, the map can move without a model. Where it cannot, the field stays unresolved. This page is a dry run. It does not send the form to the county.',
    rejected: null,
    notice,
    statusNote: notice ? STATUS_NOTE[notice] : null,
    readback: zipTruncationNote(html),
    kept: proposal.kept.map((placement) => ({
      label: labelOf(placement, bySelector),
      sentence: `This box is still at ${placement.fromSelector}. The old map can keep it.`,
    })),
    moved: proposal.moved.flatMap((placement) => {
      if (!placement.toSelector) return [];
      return [
        {
          label: labelOf(placement, bySelector),
          from: placement.fromSelector,
          to: placement.toSelector,
          sentence: placement.reason.replaceAll('control', 'box'),
        },
      ];
    }),
    refused: proposal.unresolved.map((placement) => explainRefusal(placement, observed)),
    unmapped: proposal.unmapped.map((control) => {
      if (!control.label.trim()) {
        return {
          label: 'No label',
          sentence: `A box at ${control.selector} has no label. It was left off the map.`,
        };
      }
      return {
        label: control.label,
        sentence: `${control.label} (${control.selector}) is on the page and was not added to the map.`,
      };
    }),
    publishable: proposal.publishable,
    publishNote: publishNote(form, proposal),
    proposal,
  };
}

function publishNote(form: DeskForm, proposal: RepairProposal): string {
  const call = `POST /v1/programs/${form}/playbook/repair with the same selectors and labels, and publish set to true`;
  if (!proposal.publishable) {
    const count = proposal.unresolved.length;
    return `This repair cannot be published yet. ${count} ${count === 1 ? 'field' : 'fields'} would have been a guess. Nothing was saved. When a proposal says it can be published, publishing is a separate action: ${call}. That writes a new version for your organization. The shared playbook is left as it was, and the form is not sent.`;
  }
  const probes = proposal.probes.join(', ');
  return `This is a dry run. Nothing was saved. This proposal can be published. Publishing is a separate action: ${call}. That writes a new version for your organization. The shared playbook is left as it was, and the form is not sent. The next freshness check looks for ${probes}. A repaired map still has to read every entered value back off the page.`;
}

function explainRefusal(placement: Placement, observed: ObservedControl[]): RefusedLine {
  const name = placement.purpose ? labelFor(placement.purpose) : humanize(placement.fromSelector);
  const labels = observed
    .filter((control) => control.count === 1 && control.label.trim())
    .map((control) => control.label.trim());
  const counts = new Map<string, number>();
  for (const label of labels) {
    const key = label.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const wanted = fieldWords(placement);
  const tieLabel = labels.find((label) => {
    if ((counts.get(label.toLowerCase()) ?? 0) < 2) return false;
    return words(label).some((word) => wanted.has(word));
  });
  if (tieLabel) {
    return {
      kind: 'tie',
      label: name,
      sentence: `${name} did not move. More than one box is labeled “${tieLabel}”, so this repair will not guess which one.`,
    };
  }
  const named = labels.some((label) => words(label).some((word) => wanted.has(word)));
  if (
    !named &&
    placement.purpose &&
    isProtectedField(placement.purpose) &&
    (placement.purpose === 'ssn' || placement.purpose === 'ein')
  ) {
    const decoy = labels.find((label) => /case number|medi-cal number|record id/i.test(label));
    if (decoy) {
      return {
        kind: 'protected',
        label: name,
        sentence: `${name} did not move onto “${decoy}.” That label does not name this protected field.`,
      };
    }
  }
  if (!named) {
    return {
      kind: 'missing',
      label: name,
      sentence: `${name} did not move. No label on this page names it.`,
    };
  }
  return {
    kind: 'other',
    label: name,
    sentence: `${name} did not move. No single label named it, so it was left alone rather than guessed.`,
  };
}

function labelOf(placement: Placement, bySelector: Map<string, ObservedControl>): string {
  const selector = placement.toSelector ?? placement.fromSelector;
  const control = bySelector.get(selector);
  if (control?.label.trim()) return control.label.trim();
  if (placement.purpose) return labelFor(placement.purpose);
  return humanize(placement.fromSelector);
}

function fieldWords(placement: Placement): Set<string> {
  const purpose = placement.purpose;
  const base = purpose
    ? `${labelFor(purpose)} ${purpose.replace(/([a-z])([A-Z])/g, '$1 $2')} ${ALIASES[purpose] ?? ''}`
    : placement.fromSelector.replace(/[#._-]+/g, ' ');
  return new Set(words(base));
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

function humanize(selector: string): string {
  const text = selector.replace(/^#/, '').replace(/[-_]+/g, ' ').trim();
  if (!text) return 'This field';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function noticeValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function readNotice(raw: string | string[] | undefined): RepairNotice | null {
  const value = noticeValue(raw);
  if (value === 'saved' || value === 'refused' || value === 'needs-database') return value;
  return null;
}

function emptyDesk(rejected: string, notice: RepairNotice | null): RepairDesk {
  return {
    form: 'wic',
    programName: 'Repair',
    title: 'Repair desk',
    intro: 'Selectors and labels only. This page does not send a form to the county.',
    rejected,
    notice,
    statusNote: notice ? STATUS_NOTE[notice] : null,
    readback: null,
    kept: [],
    moved: [],
    refused: [],
    unmapped: [],
    publishable: false,
    publishNote: '',
    proposal: null,
  };
}

function playbookRow(
  partial: Partial<PlaybookRow> &
    Pick<PlaybookRow, 'domain' | 'name' | 'programIds' | 'fieldMap' | 'probes'>,
): PlaybookRow {
  return {
    id: 'desk-preview',
    tenantId: null,
    version: 1,
    safeAdvanceRules: [],
    autoAdvance: false,
    note: null,
    staleAt: new Date('2026-01-15T00:00:00Z'),
    staleReason: 'selectors moved',
    createdAt: new Date('2026-01-15T00:00:00Z'),
    updatedAt: new Date('2026-01-15T00:00:00Z'),
    ...partial,
  };
}

function wicPlaybook(): PlaybookRow {
  const seed = wicSeedPlaybook();
  return playbookRow({
    domain: seed.domain,
    name: seed.name,
    programIds: [...seed.programIds],
    version: seed.version,
    probes: [...seed.probes],
    fieldMap: seed.fieldMap.map((entry) => ({ ...entry })),
    safeAdvanceRules: seed.safeAdvanceRules.map((rule) => ({ ...rule })),
    autoAdvance: seed.autoAdvance,
    note: seed.note,
  });
}

/**
 * The map for the fictional IHSS-sized page, before the ids moved.
 *
 * The shared IHSS seed only records first name and Social Security number.
 * The caseworker desk is showing a 26-box page, so the dry run uses that
 * larger previous map. It is not written into the shared playbook.
 */
function ihssPlaybook(): PlaybookRow {
  return playbookRow({
    domain: 'riversideihss.org',
    name: 'Riverside County IHSS application',
    programIds: ['ihss'],
    probes: ['#firstNameTxt', '#ssnTxt', '#county'],
    fieldMap: [
      { fieldKey: '#city', purpose: 'city', inputType: 'text', required: true },
      { fieldKey: '#county', purpose: 'county', inputType: 'text', required: true },
      { fieldKey: '#supervision', purpose: null, inputType: 'select', required: true },
      { fieldKey: '#firstNameTxt', purpose: 'firstName', inputType: 'text', required: true },
      { fieldKey: '#lastNameTxt', purpose: 'lastName', inputType: 'text', required: true },
      { fieldKey: '#birthDateTxt', purpose: 'dateOfBirth', inputType: 'date', required: true },
      { fieldKey: '#phoneTxt', purpose: 'phone', inputType: 'text', required: true },
      { fieldKey: '#streetTxt', purpose: 'addressLine1', inputType: 'text', required: true },
      { fieldKey: '#zipTxt', purpose: 'postalCode', inputType: 'text', required: true },
      { fieldKey: '#languageTxt', purpose: 'primaryLanguage', inputType: 'select' },
      { fieldKey: '#emailTxt', purpose: 'email', inputType: 'text' },
      { fieldKey: '#lives_alone', purpose: null, inputType: 'select', required: true },
      { fieldKey: '#weekly-care-hours', purpose: null, inputType: 'number', required: true },
      { fieldKey: '#provider-relationship', purpose: null, inputType: 'select', required: true },
      { fieldKey: '#incomeTxt', purpose: 'income', inputType: 'select' },
      { fieldKey: '#childcareTxt', purpose: 'childcare', inputType: 'text' },
      { fieldKey: '#ssnTxt', purpose: 'ssn', inputType: 'text', method: 'keys', required: true },
      { fieldKey: '#unemploymentTxt', purpose: 'unemployment', inputType: 'text' },
    ],
  });
}
