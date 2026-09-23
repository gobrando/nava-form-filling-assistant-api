import { withTenant } from '@/lib/db';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { acquireLease, releaseLease } from '@/lib/queue/lease';
import { LEASE_DEFAULT_MS, LEASE_MAX_MS, LEASE_MIN_MS } from '@/lib/vocabulary';
import { z } from 'zod';

/**
 * POST   /v1/applications/{id}/lease  acquire or renew
 * DELETE /v1/applications/{id}/lease  release
 *
 * The lease lives here rather than in the extension because two caseworkers in
 * two browsers cannot see each other's local state. A client-side lease is a
 * convention; this one is a row, and `SELECT ... FOR UPDATE` makes two
 * simultaneous acquisitions impossible rather than unlikely.
 *
 * The TTL is clamped to the extension's bounds so a client cannot hold an
 * application indefinitely by asking for a long enough lease. Renew instead.
 */
const postSchema = z
  .object({
    holder: z.string().min(1).max(200),
    ttlMs: z.number().int().min(LEASE_MIN_MS).max(LEASE_MAX_MS).optional(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;

  return withTenant(auth.tenantId, async (tx) => {
    const result = await acquireLease(
      tx,
      id,
      parsed.data.holder,
      parsed.data.ttlMs ?? LEASE_DEFAULT_MS,
    );

    if (!result.acquired) {
      // 409, not 403: the caller is permitted, the resource is busy. A partner
      // retrying on 409 is correct behavior; retrying on 403 is not.
      return fail(409, `${result.reason} Held by ${result.holder}.`, { origin });
    }

    return ok({ acquired: true, holder: result.holder, expiresAt: result.expiresAt }, { origin });
  });
}

const deleteSchema = z.object({ holder: z.string().min(1).max(200) }).strict();

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const parsed = await readJson(request, deleteSchema);
  if (parsed.error) return parsed.error;

  return withTenant(auth.tenantId, async (tx) => {
    const released = await releaseLease(tx, id, parsed.data.holder);
    if (!released) {
      return fail(409, 'This holder does not hold the lease.', { origin });
    }
    return ok({ released: true }, { origin });
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
