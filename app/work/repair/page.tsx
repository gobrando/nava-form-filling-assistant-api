import { type RepairQuery, loadRepairDesk } from '@/lib/demo/repair-desk';
import { queryCarriesValue } from '@/lib/demo/repair-query';
import { redirect } from 'next/navigation';

/**
 * Dry-run repair for the form a caseworker already has open.
 *
 * The proposal comes from `proposeRepair`. Publishing is a separate action.
 */
export default async function RepairPage({
  searchParams,
}: {
  searchParams: Promise<RepairQuery>;
}) {
  const query = await searchParams;
  if (queryCarriesValue(query)) redirect('/work/repair?notice=rejected');
  const desk = loadRepairDesk(query);
  const showPublishButton =
    desk.publishable && process.env.NODE_ENV !== 'production' && !desk.rejected;

  return (
    <main className="page">
      <div className="banner">
        <h1>{desk.title}</h1>
        <p>{desk.intro}</p>
      </div>

      <p>
        <a href="/work/repair">WIC form</a>
        {' · '}
        <a href="/work/repair?form=ihss">IHSS form</a>
        {' · '}
        <a href="/work">IHSS packet</a>
      </p>

      {desk.statusNote ? (
        <p className={desk.notice === 'saved' ? 'saved' : 'notice'}>{desk.statusNote}</p>
      ) : null}
      {desk.rejected ? <p className="problem">{desk.rejected}</p> : null}
      {desk.readback ? <p className="notice">{desk.readback}</p> : null}

      {desk.rejected ? null : (
        <>
          <section>
            <h2>Still in the same place</h2>
            {desk.kept.length === 0 ? (
              <p>Nothing stayed on its old selector. The labels below are what the map followed.</p>
            ) : (
              desk.kept.map((item) => (
                <div className="fact" key={item.label}>
                  <span className="label">{item.label}</span>
                  <div className="meta">{item.sentence}</div>
                </div>
              ))
            )}
          </section>

          <section>
            <h2>Moved</h2>
            {desk.moved.length === 0 ? <p>No field moved.</p> : null}
            {desk.moved.map((item) => (
              <div className="fact" key={`${item.from}-${item.to}`}>
                <span className="label">{item.label}</span>
                <div>
                  {item.from} → {item.to}
                </div>
                <div className="meta">{item.sentence}</div>
              </div>
            ))}
          </section>

          <section>
            <h2>Not repaired</h2>
            {desk.refused.length === 0 ? (
              <p>Nothing was refused. Every old field landed on one box.</p>
            ) : (
              desk.refused.map((item) => (
                <div className="question" key={item.label}>
                  <span className="label">{item.label}</span>
                  <div className="meta">{item.sentence}</div>
                </div>
              ))
            )}
          </section>

          <section>
            <h2>Left off the map</h2>
            {desk.unmapped.length === 0 ? (
              <p>Every labeled box on the page is already in the map.</p>
            ) : null}
            {desk.unmapped.map((item) => (
              <div className="fact" key={item.sentence}>
                <span className="label">{item.label}</span>
                <div className="meta">{item.sentence}</div>
              </div>
            ))}
          </section>

          <section>
            <h2>A model would still have to decide</h2>
            {desk.modelRequired ? (
              <>
                {desk.modelNote ? <p>{desk.modelNote}</p> : null}
                {desk.modelFields.map((item) => (
                  <div className="question" key={item.fieldKey}>
                    <span className="label">{item.label}</span>
                    <div className="meta">{item.sentence}</div>
                  </div>
                ))}
                <p>
                  Do not infer protected fields. Do not submit. Readback is still required for
                  anything that does get filled.
                </p>
              </>
            ) : (
              <p>The model is not required for the map.</p>
            )}
          </section>

          <section>
            <h2>Publishing</h2>
            <p>{desk.publishNote}</p>
            {showPublishButton ? (
              <form method="POST" action="/v1/work/demo">
                <input type="hidden" name="action" value="publish-repair" />
                <input type="hidden" name="form" value={desk.form} />
                <button type="submit">Publish this repair for the demo organization</button>
              </form>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}
