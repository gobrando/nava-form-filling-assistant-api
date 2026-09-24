import {
  type PlaybookHistory,
  type PlaybookVersionSummary,
  fixturePlaybookHistory,
  listPlaybookHistory,
} from '@/lib/playbooks/history';
import { PROGRAMS } from '@/lib/vocabulary';

/**
 * The caseworker page for playbook versions.
 *
 * Postgres is optional. When it is missing, or the connection fails, the page
 * still renders the fixture summary so the layout can be reviewed. That
 * fixture is not a client record.
 */

export type PlaybookHistoryProgram = {
  programId: string;
  programName: string;
  versions: PlaybookVersionSummary[];
};

export type PlaybookHistoryView = {
  source: 'database' | 'fixture';
  notice: string | null;
  organizationName: string | null;
  programs: PlaybookHistoryProgram[];
};

const DEMO_SLUG = 'participant-demo';

export const FIXTURE_NOTICE =
  'Postgres is not available, so this list is a fixture. The counts and field keys come from the same summary the API returns. It is not a client record.';

export function fixturePlaybookHistoryView(): PlaybookHistoryView {
  const history = fixturePlaybookHistory();
  return {
    source: 'fixture',
    notice: FIXTURE_NOTICE,
    organizationName: null,
    programs: [{ programId: history.programId, programName: 'WIC', versions: history.versions }],
  };
}

export async function loadPlaybookHistoryView(): Promise<PlaybookHistoryView> {
  if (!process.env.POSTGRES_URL) return fixturePlaybookHistoryView();
  try {
    return await loadFromDatabase();
  } catch (error) {
    console.error(
      'Playbook history could not be read',
      error instanceof Error ? error.name : 'unknown',
    );
    return fixturePlaybookHistoryView();
  }
}

async function loadFromDatabase(): Promise<PlaybookHistoryView> {
  const { db, withTenant } = await import('@/lib/db');
  const { tenant } = await import('@/lib/db/schema');
  const { eq } = await import('drizzle-orm');

  const [org] = await db
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(eq(tenant.slug, DEMO_SLUG))
    .limit(1);

  const tenantId = org?.id ?? '00000000-0000-0000-0000-000000000000';
  const programs = await withTenant(tenantId, async (tx) => {
    const listed: PlaybookHistoryProgram[] = [];
    for (const program of PROGRAMS) {
      const history: PlaybookHistory = await listPlaybookHistory(tx, tenantId, program.id);
      if (history.versions.length === 0) continue;
      listed.push({
        programId: program.id,
        programName: program.name,
        versions: history.versions,
      });
    }
    return listed;
  });

  return {
    source: 'database',
    notice: null,
    organizationName: org?.name ?? null,
    programs,
  };
}
