import type { ExecutionTier } from '@/lib/ai/model-map';

/**
 * A thin client for Eve's HTTP session API.
 *
 * The shape is from the spike (`docs/eve-spike-findings.md` in
 * ai-chatbot-develop):
 *
 *   POST /eve/v1/session              -> 202, `x-eve-session-id` header
 *   GET  /eve/v1/session/{id}/stream  -> NDJSON event stream
 *   POST /eve/v1/session/{id}/message -> continues a turn
 *
 * A turn's terminal event carries a `continuationToken`, and sending it back
 * continues the same conversation rather than starting a new one. That token is
 * what makes the gaps endpoint work: a run that stopped BLOCKED resumes in the
 * same session once the answers arrive, instead of re-reading the whole form
 * from a cold context.
 *
 * `POST /session` returns 202 immediately, so a run is started and the request
 * returns without waiting. Progress is read from the stream.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:2000';

function baseUrl(): string {
  return (process.env.EVE_SERVER_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

export type StartRunInput = {
  message: string;
  apiKey: string;
  tenantId: string;
  applicationId: string;
  householdId: string;
  executionTier: ExecutionTier;
};

export type StartRunResult = { sessionId: string } | { error: string };

/**
 * Tenant scope and execution tier travel as request headers because the agent
 * channel turns them into session auth attributes, which are the only values
 * carried to every tool call and every subagent step. Passing them in the
 * message body would make them prompt text — something a model can be argued
 * out of. As auth attributes they end up in a Postgres policy instead.
 */
export async function startRun(input: StartRunInput): Promise<StartRunResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/eve/v1/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
        'x-nava-execution-tier': input.executionTier,
        'x-nava-application-id': input.applicationId,
        'x-nava-household-id': input.householdId,
      },
      body: JSON.stringify({ message: input.message }),
    });
  } catch {
    return { error: 'The agent runtime is unreachable.' };
  }

  if (response.status !== 202 && !response.ok) {
    return { error: `The agent runtime rejected the run (${response.status}).` };
  }

  const sessionId = response.headers.get('x-eve-session-id');
  if (!sessionId) return { error: 'The agent runtime did not return a session id.' };

  return { sessionId };
}

export type ContinueRunInput = {
  sessionId: string;
  continuationToken: string | null;
  message: string;
  apiKey: string;
  executionTier: ExecutionTier;
  applicationId: string;
  householdId: string;
};

export async function continueRun(
  input: ContinueRunInput,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${baseUrl()}/eve/v1/session/${input.sessionId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
        'x-nava-execution-tier': input.executionTier,
        'x-nava-application-id': input.applicationId,
        'x-nava-household-id': input.householdId,
      },
      body: JSON.stringify({
        message: input.message,
        ...(input.continuationToken ? { continuationToken: input.continuationToken } : {}),
      }),
    });
    if (response.status !== 202 && !response.ok) {
      return { ok: false, error: `The agent runtime rejected the message (${response.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'The agent runtime is unreachable.' };
  }
}

/** Opens the NDJSON event stream for a session. */
export async function openStream(
  sessionId: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response | null> {
  try {
    const response = await fetch(`${baseUrl()}/eve/v1/session/${sessionId}/stream`, {
      headers: { Accept: 'application/x-ndjson', Authorization: `Bearer ${apiKey}` },
      signal,
    });
    return response.ok && response.body ? response : null;
  } catch {
    return null;
  }
}

export type EveEvent = { type?: string; continuationToken?: string } & Record<string, unknown>;

/**
 * Adapts Eve's NDJSON to Server-Sent Events.
 *
 * Mechanically the same translation ai-chatbot-develop's `stream-adapter.ts`
 * does: split on newlines, keep the trailing partial line in the buffer, and
 * re-emit each complete JSON object. SSE rather than NDJSON because a partner
 * consuming this from a browser gets `EventSource` for free, including
 * reconnection.
 */
export function ndjsonToSse(
  body: ReadableStream<Uint8Array>,
  onEvent?: (event: EveEvent) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();

      const emit = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: EveEvent;
        try {
          event = JSON.parse(trimmed) as EveEvent;
        } catch {
          // A malformed line is dropped rather than forwarded. Forwarding it
          // would break the consumer's parser for the rest of the stream.
          return;
        }
        onEvent?.(event);
        const name = typeof event.type === 'string' ? event.type : 'message';
        controller.enqueue(encoder.encode(`event: ${name}\ndata: ${trimmed}\n\n`));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // The last element is either empty or a partial line. Either way it
          // belongs back in the buffer, not in the output.
          buffer = lines.pop() ?? '';
          for (const line of lines) emit(line);
        }
        if (buffer) emit(buffer);
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}
