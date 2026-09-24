import { linesFor, loadReadbackDesk } from '@/lib/demo/readback-desk';
import { type RepairQuery, queryCarriesValue } from '@/lib/demo/repair-query';
import type { ReadbackReason } from '@/lib/playbooks/readback';
import { redirect } from 'next/navigation';

/**
 * The fields a repaired map still has to read back.
 *
 * No household values. No publish action. The repair desk links here.
 */
const SECTIONS: { reason: ReadbackReason; heading: string }[] = [
  { reason: 'truncation', heading: 'Can be cut off' },
  { reason: 'mask', heading: 'Can mask a value' },
  { reason: 'unchecked write', heading: 'Write is not checked' },
];

export default async function ReadbackPage({
  searchParams,
}: {
  searchParams: Promise<RepairQuery>;
}) {
  const query = await searchParams;
  if (queryCarriesValue(query)) redirect('/work/repair/readback?notice=rejected');
  const desk = loadReadbackDesk(query);
  const repairHref = desk.form === 'ihss' ? '/work/repair?form=ihss' : '/work/repair';

  return (
    <main className="page">
      <div className="banner">
        <h1>{desk.title}</h1>
        <p>{desk.intro}</p>
      </div>

      <p>
        <a href="/work/repair/readback">WIC checklist</a>
        {' · '}
        <a href="/work/repair/readback?form=ihss">IHSS checklist</a>
        {' · '}
        <a href={repairHref}>Repair desk</a>
      </p>

      {desk.rejected ? <p className="problem">{desk.rejected}</p> : null}

      {desk.rejected ? null : (
        <>
          <p className="notice">A repaired map does not skip readback.</p>
          {SECTIONS.map((section) => {
            const items = linesFor(desk.lines, section.reason);
            return (
              <section key={section.reason}>
                <h2>{section.heading}</h2>
                {items.length === 0 ? <p>None on this form.</p> : null}
                {items.map((item) => (
                  <div className="question" key={item.fieldKey}>
                    <span className="label">{item.label}</span>
                    <div>{item.fieldKey}</div>
                    <div className="meta">{item.sentence}</div>
                  </div>
                ))}
              </section>
            );
          })}
          <p className="footnote">This page does not save a playbook version.</p>
        </>
      )}
    </main>
  );
}
