import { withTenant } from '@/lib/db';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { createShare } from '@/lib/participate';
import { z } from 'zod';

/**
 * POST /v1/applications/{id}/share
 *
 * Mints a link the participant can open. The token is returned once. The
 * database stores only its hash.
 */
const postSchema = z
  .object({
    createdBy: z.string().min(1).max(200),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;
  const { id } = await params;
  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;

  const minted = await withTenant(auth.tenantId, (tx) =>
    createShare(tx, {
      tenantId: auth.tenantId,
      applicationId: id,
      createdBy: parsed.data.createdBy,
      expiresInHours: parsed.data.expiresInHours,
    }),
  );
  if ('error' in minted) {
    const status = minted.error === 'Application not found.' ? 404 : 400;
    return fail(status, minted.error, { origin });
  }

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  const url = host
    ? `${proto}://${host}/participate/${minted.token}`
    : `/participate/${minted.token}`;
  return ok({ url, expiresAt: minted.expiresAt.toISOString() }, { origin, status: 201 });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
