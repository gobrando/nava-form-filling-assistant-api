import { readFileSync } from 'node:fs';
import Page, { PlaybookHistoryPage } from '@/app/work/playbooks/page';
import {
  FIXTURE_NOTICE,
  fixturePlaybookHistoryView,
  loadPlaybookHistoryView,
} from '@/lib/demo/playbook-history';
import {
  FIXTURE_TENANT_ID,
  type PlaybookVersionInput,
  fixturePlaybookHistory,
  fixturePlaybookRows,
  summarizePlaybookHistory,
} from '@/lib/playbooks/history';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * Version summaries are counts and field keys.
 *
 * A shared row stays visible. A tenant override is the one in use. Another
 * tenant's override is absent. Household values never enter the payload.
 */

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const SECRET = 'Jordan Sample';
const SSN = '900-12-3456';

const shared: PlaybookVersionInput = {
  id: 'shared-wic',
  tenantId: null,
  version: 1,
  programIds: ['wic'],
  createdAt: new Date('2026-01-15T16:00:00.000Z'),
  fieldMap: [{ fieldKey: '#edit-name' }, { fieldKey: '#edit-phone' }],
  note: 'Shared control plane. Please repair this later.',
};

const older: PlaybookVersionInput = {
  id: 'tenant-old',
  tenantId: TENANT,
  version: 2,
  programIds: ['wic'],
  createdAt: '2026-02-01T12:00:00.000Z',
  fieldMap: [{ fieldKey: '#edit-name' }],
  note: 'Repaired from version 1 by the deterministic scribe. 1 selectors kept, 0 moved. No model.',
};

const newer: PlaybookVersionInput = {
  id: 'tenant-new',
  tenantId: TENANT,
  version: 4,
  programIds: ['wic'],
  createdAt: '2026-03-04T15:04:00.000Z',
  fieldMap: [{ fieldKey: '#applicant-name' }, { fieldKey: '#applicant-phone' }],
  note: 'Repaired from version 2 by the deterministic scribe. 0 selectors kept, 2 moved. No model.',
};

const otherCounty: PlaybookVersionInput = {
  id: 'other-county',
  tenantId: OTHER,
  version: 9,
  programIds: ['wic'],
  createdAt: '2026-03-05T12:00:00.000Z',
  fieldMap: [{ fieldKey: '#other-county-only' }],
  note: `Repaired from version 1 by the deterministic scribe. ${SECRET}`,
};

describe('playbook version summary', () => {
  it('keeps a shared row, with its time and field count, when nothing overrides it', () => {
    const summary = summarizePlaybookHistory([shared], TENANT, 'wic');
    expect(summary).toEqual({
      programId: 'wic',
      versions: [
        {
          id: 'shared-wic',
          version: 1,
          scope: 'shared',
          createdAt: '2026-01-15T16:00:00.000Z',
          fieldCount: 2,
          fieldKeys: ['#edit-name', '#edit-phone'],
          fromRepair: false,
          preferred: true,
        },
      ],
    });
  });

  it('prefers this tenant’s override and hides another tenant', () => {
    const summary = summarizePlaybookHistory([shared, older, newer, otherCounty], TENANT, 'wic');
    expect(
      summary.versions.map((version) => [version.id, version.scope, version.preferred]),
    ).toEqual([
      ['tenant-new', 'tenant', true],
      ['tenant-old', 'tenant', false],
      ['shared-wic', 'shared', false],
    ]);
    expect(summary.versions.find((version) => version.id === 'tenant-new')?.fromRepair).toBe(true);
    expect(summary.versions.find((version) => version.id === 'tenant-new')?.createdAt).toBe(
      '2026-03-04T15:04:00.000Z',
    );
    const payload = JSON.stringify(summary);
    expect(payload).not.toContain(OTHER);
    expect(payload).not.toContain('#other-county-only');
    expect(payload).not.toContain(SECRET);
  });

  it('omits a created time that was not stored', () => {
    const summary = summarizePlaybookHistory([{ ...shared, createdAt: null }], TENANT, 'wic');
    expect(summary.versions[0]?.createdAt).toBeNull();
  });

  it('does not copy values, notes, or purposes into the payload', () => {
    const poisoned = {
      id: 'repaired',
      tenantId: TENANT,
      version: 3,
      programIds: ['wic'],
      createdAt: '2026-03-04T15:04:00.000Z',
      note: `Repaired from version 1 by the deterministic scribe. ${SECRET} ${SSN}`,
      staleReason: SSN,
      probes: ['#ssn'],
      name: SECRET,
      fieldMap: [{ fieldKey: '#applicant-name', purpose: SECRET, value: SSN, inputType: 'text' }],
    };
    const summary = summarizePlaybookHistory([poisoned, otherCounty], TENANT, 'wic');
    const payload = JSON.stringify(summary);
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain(SSN);
    expect(payload).not.toContain('staleReason');
    expect(payload).not.toContain('purpose');
    expect(payload).not.toContain('#other-county-only');
    expect(summary.versions).toEqual([
      {
        id: 'repaired',
        version: 3,
        scope: 'tenant',
        createdAt: '2026-03-04T15:04:00.000Z',
        fieldCount: 1,
        fieldKeys: ['#applicant-name'],
        fromRepair: true,
        preferred: true,
      },
    ]);
  });

  it('drops the other county from the fixture summary', () => {
    const summary = fixturePlaybookHistory();
    const payload = JSON.stringify(summary);
    expect(fixturePlaybookRows().some((row) => row.id === 'fixture-other-county')).toBe(true);
    expect(payload).not.toContain('fixture-other-county');
    expect(payload).not.toContain('#other-county-only');
    expect(summary.versions.map((version) => version.id)).toEqual([
      'fixture-tenant-wic',
      'fixture-shared-wic',
    ]);
    expect(summary.versions[0]).toMatchObject({
      scope: 'tenant',
      preferred: true,
      fromRepair: true,
      fieldCount: 6,
    });
    expect(summary.versions[1]).toMatchObject({
      scope: 'shared',
      preferred: false,
      fromRepair: false,
    });
  });
});

describe('playbook history page', () => {
  it('links from the caseworker desk without rewriting the packet', () => {
    const source = readFileSync('app/work/page.tsx', 'utf8');
    expect(source).toContain('href="/work/playbooks"');
    expect(source).toContain('href="/work/repair"');
    expect(source).toContain('From the case record');
    expect(source).toContain('Left blank');
    expect(source).toContain('Ask the client');
  });

  it('explains that Postgres is unavailable and still renders the fixture', async () => {
    expect(process.env.POSTGRES_URL).toBeUndefined();
    const view = await loadPlaybookHistoryView();
    expect(view).toEqual(fixturePlaybookHistoryView());
    expect(view.notice).toBe(FIXTURE_NOTICE);
    expect(view.organizationName).toBeNull();
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Postgres is not available');
    expect(html).toContain('Another county does not inherit');
    expect(html).toContain('Repair published 2026-03-04 15:04:00 UTC');
    expect(html).toContain('#edit-name');
    expect(html).toContain('#applicant-name');
    expect(html).toContain('fixture-shared-wic');
    expect(html).toContain('fixture-tenant-wic');
    expect(html).not.toContain('#other-county-only');
    expect(html).not.toContain('fixture-other-county');
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(FIXTURE_TENANT_ID);
    expect(html).toContain('href="/work"');
    const again = renderToStaticMarkup(PlaybookHistoryPage({ view }));
    expect(again).toContain('6 field keys');
  });
});
