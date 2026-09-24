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
  if (!desk) {
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
  const waitingOnClient = desk.missing.length > 0;
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
        <h1>{desk.clientName} · WIC</h1>
        <p>
          {desk.organizationName}. You send the client a link for what you cannot fill. You still
          submit. This desk records that. It does not send the form to the county.
        </p>
      </div>

      {query.error ? <p className="problem">{query.error}</p> : null}

      <section>
        <h2>Still missing</h2>
        {waitingOnClient ? (
          desk.missing.map((item) => (
            <div className="question" key={item.question}>
              <span className="label">{item.question}</span>
              <div className="meta">
                {item.required ? 'Required before you can finish' : 'Optional'}
              </div>
            </div>
          ))
        ) : (
          <p>Nothing is missing. The client has answered, or there was nothing to ask.</p>
        )}
        {desk.participantUrl ? (
          <p>
            <a href={desk.participantUrl}>Open the client’s link</a>
          </p>
        ) : null}
      </section>

      <section>
        <h2>What would go on the form</h2>
        {desk.fields.map((item) => (
          <div className="fact" key={item.label}>
            <span className="label">{item.label}</span>
            <div>{displayValue(item.label, item.value)}</div>
            <div className="meta">
              {item.source ? (SOURCE[item.source] ?? item.source) : 'No source'}
              {item.value ? (item.verified ? ' · Read back' : ' · Not read back yet') : ''}
            </div>
          </div>
        ))}
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
