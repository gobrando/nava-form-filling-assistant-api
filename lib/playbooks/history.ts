import type { Tx } from '@/lib/db';
import { playbook } from '@/lib/db/schema';
import { eq, isNull, or } from 'drizzle-orm';
import { wicSeedPlaybook } from './data';

/**
 * A caseworker's view of playbook versions.
 *
 * A null tenant is the shared map. A tenant row is an override that another
 * county does not inherit. The deterministic scribe publishes that override
 * and leaves the shared row alone; the note it writes is how a version is
 * recognized as a repair.
 *
 * The summary is counts and field keys. Notes, purposes, and anything else on
 * the row stay out of the payload, so a household value cannot ride along.
 */

const REPAIR_NOTE = /^Repaired from version \d+ by the deterministic scribe\./;

export type PlaybookVersionInput = {
  id: string;
  tenantId: string | null;
  version: number;
  programIds: readonly string[];
  createdAt?: Date | string | null;
  fieldMap: readonly { fieldKey: string }[];
  note?: string | null;
};

export type PlaybookVersionSummary = {
  id: string;
  version: number;
  scope: 'shared' | 'tenant';
  createdAt: string | null;
  fieldCount: number;
  fieldKeys: string[];
  fromRepair: boolean;
  preferred: boolean;
};

export type PlaybookHistory = {
  programId: string;
  versions: PlaybookVersionSummary[];
};

/** The tenant id used only by the fixture summary. It is not a database row. */
export const FIXTURE_TENANT_ID = 'fixture-demo-organization';

export function playbookCameFromRepair(note: string | null | undefined): boolean {
  return typeof note === 'string' && REPAIR_NOTE.test(note);
}

function createdAtIso(value: Date | string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function fieldKeysOf(fieldMap: PlaybookVersionInput['fieldMap']): string[] {
  const keys: string[] = [];
  for (const entry of fieldMap) {
    if (entry && typeof entry.fieldKey === 'string') keys.push(entry.fieldKey);
  }
  return keys;
}

/**
 * Versions this tenant can see for one program.
 *
 * Tenant rows sort ahead of shared rows, highest version first, which is the
 * same preference `resolvePlaybookForProgram` uses. The first of those is
 * `preferred`. Another tenant's rows are dropped even if the caller passes
 * them in.
 */
export function summarizePlaybookHistory(
  rows: readonly PlaybookVersionInput[],
  tenantId: string,
  programId: string,
): PlaybookHistory {
  const visible = rows.filter(
    (row) =>
      row.programIds.includes(programId) && (row.tenantId === null || row.tenantId === tenantId),
  );
  const ranked = [...visible].sort((left, right) => {
    const leftShared = left.tenantId === null ? 1 : 0;
    const rightShared = right.tenantId === null ? 1 : 0;
    if (leftShared !== rightShared) return leftShared - rightShared;
    if (left.version !== right.version) return right.version - left.version;
    return right.id.localeCompare(left.id);
  });
  const preferredId = ranked[0]?.id ?? null;

  return {
    programId,
    versions: ranked.map((row) => ({
      id: row.id,
      version: row.version,
      scope: row.tenantId === null ? 'shared' : 'tenant',
      createdAt: createdAtIso(row.createdAt),
      fieldCount: fieldKeysOf(row.fieldMap).length,
      fieldKeys: fieldKeysOf(row.fieldMap),
      fromRepair: playbookCameFromRepair(row.note),
      preferred: row.id === preferredId,
    })),
  };
}

/**
 * Shared versions and this tenant's overrides, then the same summary.
 *
 * The query names the caller's tenant as well as the row-level policy, so an
 * owner connection that bypasses the policy still does not return another
 * county.
 */
export async function listPlaybookHistory(
  tx: Tx,
  tenantId: string,
  programId: string,
): Promise<PlaybookHistory> {
  const rows = await tx
    .select({
      id: playbook.id,
      tenantId: playbook.tenantId,
      version: playbook.version,
      programIds: playbook.programIds,
      createdAt: playbook.createdAt,
      fieldMap: playbook.fieldMap,
      note: playbook.note,
    })
    .from(playbook)
    .where(or(eq(playbook.tenantId, tenantId), isNull(playbook.tenantId)));

  return summarizePlaybookHistory(rows, tenantId, programId);
}

/**
 * A reviewable summary when Postgres is down.
 *
 * The third row belongs to another county. The summary drops it. Nothing here
 * is a household.
 */
export function fixturePlaybookRows(): PlaybookVersionInput[] {
  const shared = wicSeedPlaybook();
  return [
    {
      id: 'fixture-shared-wic',
      tenantId: null,
      version: shared.version,
      programIds: [...shared.programIds],
      createdAt: '2026-01-15T16:00:00.000Z',
      fieldMap: shared.fieldMap.map((entry) => ({ fieldKey: entry.fieldKey })),
      note: shared.note,
    },
    {
      id: 'fixture-tenant-wic',
      tenantId: FIXTURE_TENANT_ID,
      version: shared.version + 1,
      programIds: [...shared.programIds],
      createdAt: '2026-03-04T15:04:00.000Z',
      fieldMap: [
        { fieldKey: '#applicant-name' },
        { fieldKey: '#applicant-phone' },
        { fieldKey: '#applicant-email' },
        { fieldKey: '#applicant-zip' },
        { fieldKey: '#wic-clinic' },
        { fieldKey: '#applicant-language' },
      ],
      note: `Repaired from version ${shared.version} by the deterministic scribe. 0 selectors kept, 6 moved. No model.`,
    },
    {
      id: 'fixture-other-county',
      tenantId: 'fixture-other-county',
      version: 4,
      programIds: [...shared.programIds],
      createdAt: '2026-03-05T12:00:00.000Z',
      fieldMap: [{ fieldKey: '#other-county-only' }],
      note: `Repaired from version ${shared.version} by the deterministic scribe. 0 selectors kept, 1 moved. No model.`,
    },
  ];
}

export function fixturePlaybookHistory(): PlaybookHistory {
  return summarizePlaybookHistory(fixturePlaybookRows(), FIXTURE_TENANT_ID, 'wic');
}
