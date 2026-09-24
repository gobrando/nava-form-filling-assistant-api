import { fail, ok } from '@/lib/http';
import { answerAsParticipant, loadParticipantView, resolveShare } from '@/lib/participate';
import { z } from 'zod';

/**
 * The participant's JSON view of one shared application.
 *
 * GET returns masked facts and open questions. POST saves answers as
 * participant-sourced facts. Neither path can submit.
 */
const postSchema = z
  .object({
    answers: z
      .array(
        z.object({
          gapId: z.string().uuid(),
          value: z.string().min(1).max(500),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = await resolveShare(token);
  if (!share) return fail(404, 'This link is no longer available.');
  const view = await loadParticipantView(share);
  if (!view) return fail(404, 'This link is no longer available.');
  return ok({ ...view, canSubmit: false });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = await resolveShare(token);
  if (!share) return fail(404, 'This link is no longer available.');

  const contentType = request.headers.get('content-type') ?? '';
  const answers = contentType.includes('application/json')
    ? await jsonAnswers(request)
    : await formAnswers(request);
  if (answers.error) {
    if (contentType.includes('application/json')) return answers.error;
    return Response.redirect(pageUrl(request, token, 'invalid'), 303);
  }

  const result = await answerAsParticipant(share, answers.data);
  if (contentType.includes('application/json')) {
    return ok({
      answered: result.answered,
      unknown: result.unknown,
      invalid: result.invalid,
      canSubmit: false,
    });
  }
  const flag = result.answered.length > 0 ? 'saved' : 'invalid';
  return Response.redirect(pageUrl(request, token, flag), 303);
}

async function jsonAnswers(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { data: null, error: fail(400, 'Request body must be JSON.') };
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return { data: null, error: fail(400, 'Invalid request.') };
  return { data: parsed.data.answers, error: null };
}

async function formAnswers(request: Request) {
  const form = await request.formData();
  const answers: { gapId: string; value: string }[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('gap_') || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    answers.push({ gapId: key.slice('gap_'.length), value: trimmed });
  }
  if (answers.length === 0) return { data: null, error: fail(400, 'No answers.') };
  return { data: answers, error: null };
}

function pageUrl(request: Request, token: string, flag: string): string {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '127.0.0.1:3000';
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}/participate/${token}?${flag}=1`;
}
