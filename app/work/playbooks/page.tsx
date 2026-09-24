import {
  type PlaybookHistoryProgram,
  type PlaybookHistoryView,
  loadPlaybookHistoryView,
} from '@/lib/demo/playbook-history';
import type { PlaybookVersionSummary } from '@/lib/playbooks/history';

/**
 * Versions of a program map for the caseworker desk.
 *
 * The packet stays on /work. This page is counts and field keys. When Postgres
 * is down it says so and still shows the fixture summary.
 */

export const dynamic = 'force-dynamic';

function publishedLine(version: PlaybookVersionSummary): string {
  const when = version.createdAt
    ? version.createdAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    : null;
  if (version.fromRepair) {
    return when
      ? `Repair published ${when}.`
      : 'This version came from a repair. No published time is recorded.';
  }
  return when
    ? `Published ${when}. Not from a repair.`
    : 'Not from a repair. No published time is recorded.';
}

function scopeLine(version: PlaybookVersionSummary): string {
  if (version.scope === 'shared') {
    return version.preferred
      ? 'Shared, and in use here. No override is published for this organization.'
      : 'Shared. This organization has an override, so this version is not the one in use.';
  }
  return version.preferred
    ? 'This organization. In use here. Another county does not inherit this override.'
    : 'This organization. An older version. Another county does not inherit it.';
}

function VersionCard({ version }: { version: PlaybookVersionSummary }) {
  const title =
    version.scope === 'shared'
      ? `Shared · version ${version.version}`
      : `This organization · version ${version.version}`;
  return (
    <div className="fact">
      <span className="label">
        {title}
        {version.preferred ? ' · In use' : ''}
      </span>
      <div>
        {version.fieldCount} {version.fieldCount === 1 ? 'field key' : 'field keys'}
      </div>
      <div className="meta">{scopeLine(version)}</div>
      <div className="meta">{publishedLine(version)}</div>
      <div className="meta">Version id {version.id}</div>
      <div className="meta">{version.fieldKeys.join(', ')}</div>
    </div>
  );
}

function ProgramSection({ program }: { program: PlaybookHistoryProgram }) {
  return (
    <section>
      <h2>{program.programName}</h2>
      {program.versions.map((version) => (
        <VersionCard key={version.id} version={version} />
      ))}
    </section>
  );
}

export function PlaybookHistoryPage({ view }: { view: PlaybookHistoryView }) {
  return (
    <main className="page">
      <div className="banner">
        <h1>Playbook versions{view.organizationName ? ` · ${view.organizationName}` : ''}</h1>
        <p>
          A shared version is the map every county starts from. A repair publishes a new version for
          this organization and does not edit the shared playbook. Another county does not inherit
          that override. Counts and field keys only.
        </p>
      </div>

      <p className="footnote">
        <a href="/work">IHSS packet</a>
      </p>

      {view.notice ? <p className="notice">{view.notice}</p> : null}

      {view.programs.length === 0 ? (
        <section>
          <h2>Nothing stored</h2>
          <p>No playbook versions are stored for this organization yet.</p>
        </section>
      ) : (
        view.programs.map((program) => <ProgramSection key={program.programId} program={program} />)
      )}
    </main>
  );
}

export default async function Page() {
  const view = await loadPlaybookHistoryView();
  return <PlaybookHistoryPage view={view} />;
}
