import { loadParticipantView, resolveShare } from '@/lib/participate';

const OUTCOME_LABEL: Record<string, string> = {
  received: 'The county has received this application.',
  pending_documents: 'The county needs another document before it can decide.',
  approved: 'The county approved this application.',
  denied: 'The county denied this application.',
  benefit_received: 'The benefit has started.',
};

export default async function ParticipatePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ saved?: string; invalid?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const share = await resolveShare(token);
  const view = share ? await loadParticipantView(share) : null;

  if (!view || view.canSubmit !== false) {
    return (
      <main className="page">
        <div className="banner">
          <h1>This link is no longer available</h1>
          <p>Ask your caseworker to send a new one. Nothing was submitted.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="banner">
        <h1>{view.programName}</h1>
        <p>
          {view.organizationName} asked you to check a few things. This page does not submit your
          application. A caseworker reviews your answers with you first.
        </p>
      </div>

      {query.saved ? (
        <p className="saved">Saved. Your caseworker will review this with you.</p>
      ) : null}
      {query.invalid ? (
        <p className="problem">
          Those answers could not be saved. Check the questions and try again.
        </p>
      ) : null}

      {view.outcome ? (
        <p className="notice">
          {OUTCOME_LABEL[view.outcome.status] ?? 'There is an update on this application.'}
          {view.outcome.followUp ? ` ${view.outcome.followUp}` : ''}
        </p>
      ) : null}

      <section>
        <h2>What we already have</h2>
        {view.facts.length === 0 ? <p className="meta">Nothing is on file yet.</p> : null}
        {view.facts.map((fact) => (
          <div className="fact" key={fact.key}>
            <span className="label">{fact.label}</span>
            <div>{fact.display}</div>
            <div className="meta">{fact.sourceLabel}</div>
          </div>
        ))}
      </section>

      <section>
        <h2>Questions only you can answer</h2>
        {view.questions.length === 0 ? (
          <p>There are no open questions. Your caseworker has what they need to review.</p>
        ) : (
          <form method="POST" action={`/v1/participate/${token}`}>
            {view.questions.map((question) => (
              <label className="question" key={question.id} htmlFor={`gap_${question.id}`}>
                <span className="label">{question.question}</span>
                {question.required ? <span className="meta"> Required</span> : null}
                {question.options && question.options.length > 0 ? (
                  <select
                    id={`gap_${question.id}`}
                    name={`gap_${question.id}`}
                    defaultValue=""
                    required={question.required}
                  >
                    <option value="" disabled>
                      Choose one
                    </option>
                    {question.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`gap_${question.id}`}
                    type="text"
                    name={`gap_${question.id}`}
                    required={question.required}
                    autoComplete="off"
                  />
                )}
              </label>
            ))}
            <button type="submit">Save my answers</button>
          </form>
        )}
      </section>

      <p className="footnote">
        Saving answers does not send this application to the county. The link stops working on{' '}
        {new Date(view.expiresAt).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })}
        .
      </p>
    </main>
  );
}
