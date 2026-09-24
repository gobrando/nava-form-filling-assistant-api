import { readFileSync } from 'node:fs';
import RepairPage from '@/app/work/repair/page';
import {
  buildRepairDesk,
  fixtureCarriesFilledValue,
  loadRepairDesk,
  previousPlaybook,
  publishDemoRepair,
} from '@/lib/demo/repair-desk';
import { observeHtml } from '@/lib/playbooks/observe-html';
import { proposeRepair } from '@/lib/playbooks/scribe';
import { proxy } from '@/proxy';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * The repair desk renders the same proposal `proposeRepair` returns.
 * No model, and no database: a missing Postgres URL leaves the dry run in place.
 */

const wicHtml = readFileSync('tests/fixtures/wic-form-drifted.html', 'utf8');
const ihssHtml = readFileSync('tests/fixtures/ihss-form-drifted.html', 'utf8');

async function render(query: Record<string, string | undefined>) {
  const element = await RepairPage({ searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(element);
}

describe('the open form', () => {
  it('uses proposeRepair for the drifted WIC fixture', () => {
    const desk = loadRepairDesk({ form: 'wic' });
    const proposal = proposeRepair(previousPlaybook('wic'), observeHtml(wicHtml));
    expect(desk.proposal).toEqual(proposal);
    expect(desk.publishable).toBe(true);
    expect(desk.kept).toHaveLength(0);
    expect(desk.moved.map((item) => [item.label, item.from, item.to])).toEqual([
      ['Name', '#edit-name', '#applicant-name'],
      ['Phone', '#edit-phone', '#applicant-phone'],
      ['Email', '#edit-email', '#applicant-email'],
      ['ZIP code', '#edit-zip-code', '#applicant-zip'],
      [
        'Please choose the WIC clinic closest to you',
        '#edit-please-choose-the-wic-clinic-closest-to-you',
        '#wic-clinic',
      ],
      ['Preferred language', '#edit-preferred-language', '#applicant-language'],
    ]);
    expect(desk.refused).toHaveLength(0);
    expect(desk.modelRequired).toBe(false);
    expect(desk.modelFields).toEqual([]);
    expect(desk.unmapped.map((item) => item.label)).toEqual(['Case number']);
    expect(desk.proposal?.fieldMap.some((entry) => entry.fieldKey === '#case-number')).toBe(false);
  });

  it('calls out the ZIP truncation so a repaired playbook does not skip readback', () => {
    expect(wicHtml).toMatch(/id="applicant-zip"[^>]*maxlength="4"/);
    const desk = loadRepairDesk({});
    expect(desk.readback).toMatch(/only holds 4 characters/);
    expect(desk.readback).toMatch(/does not skip readback/);
    expect(desk.publishNote).toMatch(/read every entered value back/);
  });

  it('shows kept fields, moves, and the three refusals on the IHSS-sized form', () => {
    const observed = observeHtml(ihssHtml);
    const fields = observed.filter((control) => control.type !== 'submit');
    expect(fields).toHaveLength(26);
    const desk = loadRepairDesk({ form: 'ihss' });
    const proposal = proposeRepair(previousPlaybook('ihss'), observed);
    expect(desk.proposal).toEqual(proposal);
    expect(desk.publishable).toBe(false);
    expect(desk.kept.map((item) => item.label)).toEqual([
      'City',
      'County of residence',
      'Protective supervision',
    ]);
    expect(desk.moved.map((item) => [item.from, item.to, item.label])).toEqual([
      ['#firstNameTxt', '#applicant-first', 'Applicant first name'],
      ['#lastNameTxt', '#applicant-last', 'Applicant last name'],
      ['#birthDateTxt', '#applicant-dob', 'Date of birth'],
      ['#phoneTxt', '#applicant-phone', 'Phone number'],
      ['#streetTxt', '#applicant-street', 'Street address'],
      ['#zipTxt', '#applicant-zip', 'ZIP code'],
      ['#languageTxt', '#applicant-language', 'Primary language'],
      ['#emailTxt', '#applicant-email', 'Email address'],
      ['#lives_alone', '#lives-alone', 'Lives alone'],
      ['#weekly-care-hours', '#care-hours', 'Weekly care hours'],
      ['#provider-relationship', '#provider-relation', 'Provider relationship'],
      ['#incomeTxt', '#ssi-income', 'SSI income'],
    ]);
    expect(desk.refused.map((item) => [item.kind, item.sentence])).toEqual([
      [
        'tie',
        'Childcare did not move. More than one box is labeled “Childcare”, so this repair will not guess which one.',
      ],
      [
        'protected',
        'Social Security Number did not move onto “Case number.” That label does not name this protected field.',
      ],
      ['missing', 'Unemployment benefits did not move. No label on this page names it.'],
    ]);
    expect(desk.proposal?.fieldMap.some((entry) => entry.fieldKey === '#case-number')).toBe(false);
    expect(desk.readback).toBeNull();
    expect(desk.modelRequired).toBe(true);
    expect(desk.modelFields.map((item) => [item.label, item.sentence])).toEqual([
      [
        'Childcare',
        'tie. "Childcare" (#childcare-one, count 1) and "Childcare" (#childcare-two, count 1).',
      ],
      [
        'Social Security Number',
        'protected field would land on the wrong label. "Case number" (#case-number, count 1) and "Medi-Cal number" (#medi-cal-number, count 1) do not name it.',
      ],
      ['Unemployment benefits', 'label missing. No label on this page names it.'],
    ]);
  });
});

describe('values stay off the desk', () => {
  it('rejects a value on the query string and does not echo it', async () => {
    const secret = 'Jordan Sample 900-12-3456';
    const desk = loadRepairDesk({ form: 'wic', value: secret });
    expect(desk.proposal).toBeNull();
    expect(desk.rejected).toMatch(/included a value/);
    expect(desk.rejected).not.toContain('Jordan');
    expect(desk.rejected).not.toContain('900-12-3456');
    const shown = await render({ notice: 'rejected' });
    expect(shown).toContain('included a value');
    expect(shown).not.toContain('Jordan');
    expect(shown).not.toContain('Moved');

    await expect(render({ form: 'wic', value: secret })).rejects.toThrow();
    const request = new NextRequest(
      `http://127.0.0.1:3456/work/repair?value=${encodeURIComponent(secret)}`,
    );
    const response = proxy(request);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/work/repair?notice=rejected');
    expect(location).not.toContain('Jordan');
    expect(location).not.toContain('900-12-3456');
  });

  it('rejects a fixture that already has a filled-in value', () => {
    const poisoned = wicHtml.replace(
      'id="applicant-name"',
      'id="applicant-name" value="Jordan Sample"',
    );
    expect(fixtureCarriesFilledValue(wicHtml)).toBe(false);
    expect(fixtureCarriesFilledValue(ihssHtml)).toBe(false);
    expect(fixtureCarriesFilledValue(poisoned)).toBe(true);
    const desk = buildRepairDesk({ form: 'wic', html: poisoned });
    expect(desk.proposal).toBeNull();
    expect(desk.rejected).not.toContain('Jordan');
  });

  it('renders both forms without household values', async () => {
    const wic = await render({ form: 'wic' });
    const ihss = await render({ form: 'ihss' });
    for (const html of [wic, ihss]) {
      expect(html).not.toMatch(/900-12-3456|92501|jordan\.sample|Jordan Sample/i);
      expect(html).toContain('dry run');
      expect(html).toContain('publish set to true');
      expect(html).toContain('shared playbook');
    }
    expect(wic).toContain('#edit-zip-code');
    expect(wic).toContain('#applicant-zip');
    expect(wic).toContain('does not skip readback');
    expect(wic).toContain('Publish this repair for the demo organization');
    expect(wic).toContain('A model would still have to decide');
    expect(wic).toContain('The model is not required for the map.');
    expect(ihss).toContain('A model would still have to decide');
    expect(ihss).not.toContain('The model is not required for the map.');
    expect(ihss).toContain('#childcare-one');
    expect(ihss).toContain('#childcare-two');
    expect(ihss).toContain('protected field would land on the wrong label');
    expect(ihss).toContain('Do not infer protected fields.');
    expect(ihss).toContain('Do not submit.');
    expect(ihss).toContain('will not guess which one');
    expect(ihss).toContain('does not name this protected field');
    expect(ihss).toContain('No label on this page names it');
    expect(ihss).not.toContain('Publish this repair for the demo organization');
  });
});

describe('the IHSS packet', () => {
  it('points at the repair desk without taking over the packet view', () => {
    const page = readFileSync('app/work/page.tsx', 'utf8');
    expect(page).toContain('href="/work/repair"');
    expect(page).toMatch(/repaired\s+without\s+a model/);
    expect(page.match(/href="\/work\/repair"/g)).toHaveLength(1);
  });
});

describe('publishing stays a separate step', () => {
  it('does not open a database when the proposal is refused or Postgres is unset', async () => {
    const previous = process.env.POSTGRES_URL;
    process.env.POSTGRES_URL = '';
    try {
      expect(await publishDemoRepair('ihss')).toBe('refused');
      expect(await publishDemoRepair('wic')).toBe('needs-database');
      expect(await publishDemoRepair('other')).toBe('refused');
    } finally {
      if (previous) process.env.POSTGRES_URL = previous;
      else process.env.POSTGRES_URL = '';
    }
    const source = readFileSync('lib/demo/repair-desk.ts', 'utf8');
    expect(source).toMatch(/proposeRepair/);
    expect(source).toMatch(/publishRepair/);
    expect(source).not.toMatch(/POSTGRES_MIGRATION_URL/);
    expect(source).not.toMatch(/\.update\(\s*(schema\.)?playbook/);
  });

  it('tells the caseworker how to publish when the database is missing', () => {
    const desk = loadRepairDesk({ form: 'wic', notice: 'needs-database' });
    expect(desk.publishable).toBe(true);
    expect(desk.statusNote).toMatch(/demo database is not available/);
    expect(desk.statusNote).toMatch(/dry run/);
    expect(desk.publishNote).toMatch(/POST \/v1\/programs\/wic\/playbook\/repair/);
  });
});
