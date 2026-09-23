import { withTenant } from '@/lib/db';
import { application } from '@/lib/db/schema';
import { ndjsonToSse, openStream } from '@/lib/eve/client';
import { guard } from '@/lib/guard';
import { fail, preflight } from '@/lib/http';
import { eq } from 'drizzle-orm';

/**
 * GET /v1/applications/{id}/events
 *
 * Server-Sent Events over Eve's NDJSON session stream. SSE rather than passing
 * NDJSON through because a partner consuming this from a browser gets
 * `EventSource` and its reconnection behavior for free.
 *
 * Only a cold run has a stream. A warm run is one deterministic pass with no
 * intermediate states worth watching, so this returns 409 with the reason
 * rather than an empty stream a client would wait on forever.
 *
 * The agent key is passed as a query parameter because `EventSource` cannot set
 * headers. It is single-use from the caller's perspective and travels only over
 * TLS; a partner that can set headers should prefer `Authorization`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const url = new URL(request.url);
  const agentApiKey =
    url.searchParams.get('agentApiKey') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null;

  const sessionId = await withTenant(auth.tenantId, async (tx) => {
    const rows = await tx
      .select({ eveSessionId: application.eveSessionId, executionMode: application.executionMode })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!sessionId) return fail(404, 'Application not found.', { origin });
  if (!sessionId.eveSessionId) {
    return fail(
      409,
      sessionId.executionMode === 'script'
        ? 'This run executed deterministically and has no event stream. Read the packet instead.'
        : 'This run has not been started on the agent.',
      { origin },
    );
  }
  if (!agentApiKey) return fail(400, 'An agent key is required to read the stream.', { origin });

  const upstream = await openStream(sessionId.eveSessionId, agentApiKey, request.signal);
  if (!upstream?.body) return fail(502, 'The agent runtime stream is unavailable.', { origin });

  // `continuationToken` is captured off the terminal event and stored, so a
  // later gap answer resumes this same session instead of starting a cold one.
  const onEvent = (event: { continuationToken?: string }) => {
    if (!event.continuationToken) return;
    void withTenant(auth.tenantId, async (tx) => {
      await tx
        .update(application)
        .set({ eveContinuationToken: event.continuationToken, updatedAt: new Date() })
        .where(eq(application.id, id));
    });
  };

  return new Response(ndjsonToSse(upstream.body, onEvent), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Without this a buffering proxy holds the stream until it completes,
      // which turns a live feed into a slow batch response.
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
