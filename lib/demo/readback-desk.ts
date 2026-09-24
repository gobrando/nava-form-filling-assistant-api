import { readFileSync } from 'node:fs';
import { type DeskForm, fixtureCarriesFilledValue, previousPlaybook } from '@/lib/demo/repair-desk';
import {
  VALUE_REJECTION as REJECTION,
  type RepairQuery,
  queryCarriesValue,
} from '@/lib/demo/repair-query';
import { controlMaxLengths, observeHtml } from '@/lib/playbooks/observe-html';
import {
  type ReadbackObligation,
  type ReadbackReason,
  readbackChecklist,
} from '@/lib/playbooks/readback';
import { proposeRepair } from '@/lib/playbooks/scribe';

/**
 * The caseworker view of the readback checklist.
 *
 * The list comes from `readbackChecklist`. A repaired map does not skip
 * readback, and this page does not publish. Selectors, labels, and the
 * reason only. A filled-in value rejects the page.
 */

export type ReadbackLine = ReadbackObligation & {
  sentence: string;
};

export type ReadbackDesk = {
  form: DeskForm;
  title: string;
  intro: string;
  rejected: string | null;
  lines: ReadbackLine[];
};

const FIXTURES: Record<DeskForm, string> = {
  wic: 'tests/fixtures/wic-form-drifted.html',
  ihss: 'tests/fixtures/ihss-form-drifted.html',
};

export function loadReadbackDesk(query: RepairQuery): ReadbackDesk {
  if (queryCarriesValue(query) || noticeValue(query.notice) === 'rejected') {
    return emptyDesk(REJECTION);
  }
  const form: DeskForm = query.form === 'ihss' ? 'ihss' : 'wic';
  const html = readFileSync(FIXTURES[form], 'utf8');
  return buildReadbackDesk({ form, html });
}

export function buildReadbackDesk(input: { form: DeskForm; html: string }): ReadbackDesk {
  if (fixtureCarriesFilledValue(input.html)) return emptyDesk(REJECTION);
  const observed = observeHtml(input.html);
  const limits = controlMaxLengths(input.html);
  const proposal = proposeRepair(previousPlaybook(input.form), observed);
  const lines = readbackChecklist(
    proposal,
    observed.map((control) => {
      const maxlength = limits.get(control.selector);
      return maxlength === undefined ? control : { ...control, maxlength };
    }),
  ).map((item) => ({
    ...item,
    sentence: sentenceFor(item, limits.get(item.fieldKey)),
  }));
  const programName = input.form === 'wic' ? 'WIC' : 'IHSS';
  return {
    form: input.form,
    title: `${programName} form · readback`,
    intro:
      'A repaired map does not skip readback. A write is not done until it is read back off the page. This list is the boxes that can cut a value short, mask it, or leave a write with no single box to check. It does not show what a household typed.',
    rejected: null,
    lines,
  };
}

export function sentenceFor(item: ReadbackObligation, maxlength: number | undefined): string {
  if (item.reason === 'truncation') {
    if (maxlength !== undefined && /zip/i.test(item.label)) {
      return `Truncation. The ${item.label} box holds ${maxlength} characters. A ZIP code is 5 digits. The page can cut it and still look successful. Read it back.`;
    }
    if (maxlength !== undefined) {
      return `Truncation. This box holds ${maxlength} characters, which is shorter than the field needs. The page can cut it and still look successful. Read it back.`;
    }
    return 'Truncation. This box can cut the value and still look successful. Read it back.';
  }
  if (item.reason === 'mask') {
    return 'Mask. This box hides or reformats what is written, so a write can look finished and be wrong. Read it back.';
  }
  return 'Unchecked write. This field does not resolve to one box, so the write cannot be checked. Read it back before it counts.';
}

export function linesFor(lines: ReadbackLine[], reason: ReadbackReason): ReadbackLine[] {
  return lines.filter((item) => item.reason === reason);
}

function noticeValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function emptyDesk(rejected: string): ReadbackDesk {
  return {
    form: 'wic',
    title: 'Readback checklist',
    intro: 'A repaired map does not skip readback. This page does not show household values.',
    rejected,
    lines: [],
  };
}
