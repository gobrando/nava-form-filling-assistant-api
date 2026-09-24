import {
  confirmPacket,
  loadWorkbench,
  recordDemoSubmission,
  resetDemo,
  simulateNextOutcome,
  verifyReadback,
} from '@/lib/demo/workbench';
import { fail } from '@/lib/http';

/**
 * Local-only controls for the caseworker desk. Production caseworkers use the
 * authenticated /v1 routes. This exists so the demo can be clicked through.
 */
const ACTIONS = {
  reset: resetDemo,
  verify: verifyReadback,
  confirm: confirmPacket,
  submit: recordDemoSubmission,
  outcome: simulateNextOutcome,
} as const;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') return fail(404, 'Not found.');
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const run = ACTIONS[action as keyof typeof ACTIONS];
  if (!run) return fail(400, 'Unknown action.');
  const problem = await run();
  const flag = problem ? `error=${encodeURIComponent(problem)}` : 'ok=1';
  const host = request.headers.get('host') ?? '127.0.0.1:3000';
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  return Response.redirect(`${proto}://${host}/work?${flag}`, 303);
}

export async function GET() {
  if (process.env.NODE_ENV === 'production') return fail(404, 'Not found.');
  const desk = await loadWorkbench();
  return Response.json({ ok: true, ready: desk !== null });
}
