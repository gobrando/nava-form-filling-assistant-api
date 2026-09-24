import { loadWorkbench, resetDemo } from '@/lib/demo/workbench';

function displayValue(label: string, value: string | null) {
  if (!value) return 'Empty';
  if (/social security/i.test(label) || /^\d{3}-\d{2}-\d{4}$/.test(value)) {
    return `•••-••-${value.slice(-4)}`;
  }
  return value;
}
const SOURCE: Record<string, string> = {
  connector: 'From the case record',
  caseworker: 'Entered by a caseworker',
  participant: 'The client told us',
  document: 'From a document',
  page: 'Already on the form',
};

const OUTCOME: Record<string, string> = {
  received: 'County received it',
  pending_documents: 'County needs a document',
  approved: 'County approved it',
  denied: 'County denied it',
  benefit_received: 'Benefit started',
};

export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const query = await searchParams;
  let desk = await loadWorkbench();
  if (!desk || desk.programName !== 'IHSS') {
    await resetDemo();
    desk = await loadWorkbench();
  }
  if (!desk) {
    return (
      <main className="page">
        <div className="banner">
          <h1>The demo could not be prepared</h1>
          <p>The database did not return the fictional household.</p>
        </div>
      </main>
    );
  }

  const unverified = desk.fields.filter((item) => item.value && !item.verified);
  const requiredMissing = desk.missing.filter((item) => item.required);
  const optionalMissing = desk.missing.filter((item) => !item.required);
  const waitingOnClient = requiredMissing.length > 0;
  const onRecord = desk.fields.filter(
    (item) => item.value && item.source !== 'caseworker' && item.source !== 'participant',
  );
  const leftBlank = desk.fields.filter(
    (item) => !item.value || /social security|medi-cal/i.test(item.label),
  );
  const fromClient = desk.fields.filter((item) => item.source === 'participant');
  const canConfirm =
    !desk.submittedAt &&
    !waitingOnClient &&
    unverified.length === 0 &&
    desk.gate.blockers.length > 0 &&
    desk.gate.blockers.every((blocker) => blocker === 'No reviewer has confirmed this packet.');
  const canSubmit = desk.gate.allowed && !desk.submittedAt;

  return (
    <main className="page">
      <div className="banner">
        <h1>
          {desk.clientName} · {desk.programName}
        </h1>
        <p>
          {desk.organizationName}. Fields on the record are filled. You send the client a link for
          what the record does not have. Identifiers stay blank unless a person enters them. You
          still submit. This desk records that. It does not send the form to the county.
        </p>
      </div>

      <p className="footnote">
        When the county page moves a box and the label still matches, the map can be repaired
        without a model. <a href="/work/repair">Review that repair</a>.
      </p>

      <p className="notice">
        The last measured decision pass, on a 26-control page, cost $0.000310. This packet uses that
        split: nine fields from the record, questions for the client, and identifiers left blank.
      </p>

      {query.error ? <p className="problem">{query.error}</p> : null}

      <section>
        <h2>From the case record</h2>
        {onRecord.map((item) => (
          <div className="fact" key={item.label}>
            <span className="label">{item.label}</span>
            <div>{displayValue(item.label, item.value)}</div>
            <div className="meta">
              {item.source ? (SOURCE[item.source] ?? item.source) : 'No source'}
              {item.verified ? ' · Read back' : ' · Not read back yet'}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2>Left blank</h2>
        {leftBlank.map((item) => (
          <div className="fact" key={item.label}>
            <span className="label">{item.label}</span>
            <div>{displayValue(item.label, item.value)}</div>
            <div className="meta">
              {item.value
                ? 'Entered by a caseworker. The planner does not fill this.'
                : 'Blank. The planner does not fill an identifier.'}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2>Ask the client</h2>
        {requiredMissing.length === 0 && optionalMissing.length === 0 && fromClient.length === 0 ? (
          <p>Nothing is missing.</p>
        ) : null}
        {fromClient.map((item) => (
          <div className="fact" key={item.label}>
            <span className="label">{item.label}</span>
            <div>{displayValue(item.label, item.value)}</div>
            <div className="meta">
              The client told us{item.verified ? ' · Read back' : ' · Not read back yet'}
            </div>
          </div>
        ))}
        {requiredMissing.map((item) => (
          <div className="question" key={item.question}>
            <span className="label">{item.question}</span>
            <div className="meta">Required before you can finish</div>
          </div>
        ))}
        {optionalMissing.map((item) => (
          <div className="question" key={item.question}>
            <span className="label">{item.question}</span>
            <div className="meta">Optional. You can review without this.</div>
          </div>
        ))}
        {desk.participantUrl ? (
          <p>
            <a href={desk.participantUrl}>Open the client’s link</a>
          </p>
        ) : null}
      </section>

      <section>
        <h2>Your step</h2>
        {waitingOnClient ? <p>Wait for the client, then come back to this page.</p> : null}
        {unverified.length > 0 ? (
          <form method="POST" action="/v1/work/demo">
            <input type="hidden" name="action" value="verify" />
            <button type="submit">
              I entered the client’s answer on the form and read it back
            </button>
          </form>
        ) : null}
        {canConfirm ? (
          <form method="POST" action="/v1/work/demo">
            <input type="hidden" name="action" value="confirm" />
            <button type="submit">Confirm this packet</button>
          </form>
        ) : null}
        {canSubmit ? (
          <form method="POST" action="/v1/work/demo">
            <input type="hidden" name="action" value="submit" />
            <button type="submit">Record that I submitted this</button>
          </form>
        ) : null}
        {desk.submittedAt && desk.nextUpdate ? (
          <form method="POST" action="/v1/work/demo">
            <input type="hidden" name="action" value="outcome" />
            <button type="submit">Simulate the next county update ({desk.nextUpdate})</button>
          </form>
        ) : null}
        {desk.submittedAt && !desk.nextUpdate ? (
          <p>The simulated county path is finished. The benefit is recorded as started.</p>
        ) : null}
      </section>

      {desk.outcomes.length > 0 ? (
        <section>
          <h2>After submission</h2>
          {desk.outcomes.map((item) => (
            <div className="fact" key={item.recordedAt}>
              <span className="label">{OUTCOME[item.status] ?? item.status}</span>
              {item.followUp ? <div>{item.followUp}</div> : null}
              <div className="meta">{item.reasonCode ?? 'No reason code'}</div>
            </div>
          ))}
        </section>
      ) : null}

      <form method="POST" action="/v1/work/demo">
        <input type="hidden" name="action" value="reset" />
        <button className="secondary" type="submit">
          Start this demo over
        </button>
      </form>
    </main>
  );
}
