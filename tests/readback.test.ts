import { readFileSync } from 'node:fs';
import RepairPage from '@/app/work/repair/page';
import ReadbackPage from '@/app/work/repair/readback/page';
import { wicSeedPlaybook } from '@/lib/playbooks/data';
import { controlMaxLengths, observeHtml } from '@/lib/playbooks/observe-html';
import { readbackChecklist } from '@/lib/playbooks/readback';
import type { PlaybookRow } from '@/lib/playbooks/registry';
import { proposeRepair } from '@/lib/playbooks/scribe';
import { proxy } from '@/proxy';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * A repaired map still has to be read back.
 * No database and no model. The checklist carries keys, labels, and reasons.
 */

const wicHtml = readFileSync('tests/fixtures/wic-form-drifted.html', 'utf8');
const maskedHtml = readFileSync('tests/fixtures/masked-ssn.html', 'utf8');
const wicSeed = wicSeedPlaybook();

function wicRow(): PlaybookRow {
  return {
    id: 'playbook-1',
    tenantId: null,
    domain: 'www.ruhealth.org',
    programIds: [...wicSeed.programIds],
    version: wicSeed.version,
    name: wicSeed.name,
    probes: [...wicSeed.probes],
    fieldMap: wicSeed.fieldMap.map((entry) => ({ ...entry })),
    safeAdvanceRules: wicSeed.safeAdvanceRules.map((rule) => ({ ...rule })),
    autoAdvance: wicSeed.autoAdvance,
    note: wicSeed.note,
    staleAt: new Date(),
    staleReason: 'selectors moved',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function withLimits(html: string) {
  const limits = controlMaxLengths(html);
  return observeHtml(html).map((control) => {
    const maxlength = limits.get(control.selector);
    return maxlength === undefined ? control : { ...control, maxlength };
  });
}

async function renderReadback(query: Record<string, string | undefined>) {
  const element = await ReadbackPage({ searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(element);
}

async function renderRepair(query: Record<string, string | undefined>) {
  const element = await RepairPage({ searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(element);
}

describe('the drifted WIC checklist', () => {
  const proposal = proposeRepair(wicRow(), observeHtml(wicHtml));
  const list = readbackChecklist(proposal, withLimits(wicHtml));

  it('lists the ZIP as truncation and leaves the name off', () => {
    expect(wicHtml).toMatch(/id="applicant-zip"[^>]*maxlength="4"/);
    expect(list).toEqual([{ fieldKey: '#applicant-zip', label: 'ZIP code', reason: 'truncation' }]);
    expect(list.map((item) => item.fieldKey)).not.toContain('#applicant-name');
    expect(list.map((item) => item.label)).not.toContain('Name');
    expect(JSON.stringify(list)).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });
});

describe('a masked Social Security box', () => {
  it('lists the mask and the fixture has no real Social Security number', () => {
    expect(maskedHtml).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    expect(maskedHtml).not.toMatch(/\b\d{9}\b/);
    expect(maskedHtml).toMatch(/type="password"/);
    const list = readbackChecklist(
      [
        { fieldKey: '#applicant-ssn', purpose: 'ssn', inputType: 'text' },
        { fieldKey: '#applicant-name', purpose: 'fullName', inputType: 'text' },
      ],
      withLimits(maskedHtml),
    );
    expect(list).toEqual([
      { fieldKey: '#applicant-ssn', label: 'Social Security Number', reason: 'mask' },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });

  it('does not list an ordinary date picker', () => {
    const list = readbackChecklist(
      [{ fieldKey: '#applicant-dob', purpose: 'dateOfBirth', inputType: 'date' }],
      [{ selector: '#applicant-dob', label: 'Date of birth', type: 'date', count: 1 }],
    );
    expect(list).toEqual([]);
  });

  it('lists a mask that the field map already recorded', () => {
    const list = readbackChecklist(
      [
        {
          fieldKey: '#birth',
          purpose: 'dateOfBirth',
          inputType: 'text',
          mask: 'MM/DD/YYYY',
          method: 'keys',
        },
      ],
      [{ selector: '#birth', label: 'Date of birth', type: 'text', count: 1 }],
    );
    expect(list).toEqual([{ fieldKey: '#birth', label: 'Date of birth', reason: 'mask' }]);
  });
});

describe('an unchecked write', () => {
  it('lists a mapped field that does not resolve to one box', () => {
    const list = readbackChecklist(
      [{ fieldKey: '#zip', purpose: 'postalCode', inputType: 'text' }],
      [{ selector: '#zip', label: 'ZIP code', type: 'text', count: 2, maxlength: 10 }],
    );
    expect(list).toEqual([{ fieldKey: '#zip', label: 'ZIP code', reason: 'unchecked write' }]);
  });
});

describe('the readback page', () => {
  it('shows the WIC ZIP, skips the name, and does not offer publish', async () => {
    const html = await renderReadback({ form: 'wic' });
    expect(html).toContain('A repaired map does not skip readback.');
    expect(html).toContain('ZIP code');
    expect(html).toContain('#applicant-zip');
    expect(html).toContain('holds 4 characters');
    expect(html).toContain('Truncation.');
    expect(html).not.toContain('>Name<');
    expect(html).not.toContain('#applicant-name');
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toContain('Publish');
    expect(html).not.toContain('publish set to true');
    expect(html).not.toMatch(/900-12-3456|92501|jordan\.sample|Jordan Sample/i);
    expect(html).toContain('This page does not save a playbook version.');
  });

  it('points at the checklist from the repair desk in one sentence', async () => {
    const wic = await renderRepair({});
    const ihss = await renderRepair({ form: 'ihss' });
    expect(wic).toContain('A repaired map does not skip readback.');
    expect(wic).toContain('href="/work/repair/readback"');
    expect(wic).toContain('Open the readback checklist');
    expect(ihss).toContain('href="/work/repair/readback?form=ihss"');
  });

  it('rejects a value on the query string and does not echo it', async () => {
    const secret = 'Jordan Sample 900-12-3456';
    await expect(renderReadback({ form: 'wic', value: secret })).rejects.toThrow();
    const shown = await renderReadback({ notice: 'rejected' });
    expect(shown).toContain('included a value');
    expect(shown).not.toContain('Jordan');
    expect(shown).not.toContain('900-12-3456');
    expect(shown).not.toContain('ZIP code');

    const request = new NextRequest(
      `http://127.0.0.1:3456/work/repair/readback?value=${encodeURIComponent(secret)}`,
    );
    const response = proxy(request);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/work/repair/readback?notice=rejected');
    expect(location).not.toContain('Jordan');
    expect(location).not.toContain('900-12-3456');
    expect(readFileSync('proxy.ts', 'utf8')).toContain("'/work/repair/readback'");
  });
});
