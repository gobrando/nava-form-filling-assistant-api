import { publishDemoRepair } from '@/lib/demo/repair-desk';
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
 *
 * `publish-repair` writes a tenant playbook for the demo organization. It does
 * not edit the shared playbook, and it does not send a form.
 */
const ACTIONS = {
  reset: resetDemo,
  verify: verifyReadback,
  confirm: confirmPacket,
  submit: recordDemoSubmission,
  outcome: simulateNextOutcome,
} as const;

function redirectTo(request: Request, path: string) {
  const host = request.headers.get('host') ?? '127.0.0.1:3000';
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  return Response.redirect(`${proto}://${host}${path}`, 303);
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') return fail(404, 'Not found.');
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  if (action === 'publish-repair') {
    const which = String(form.get('form') ?? '');
    const result = await publishDemoRepair(which);
    const formName = which === 'ihss' ? 'ihss' : 'wic';
    return redirectTo(request, `/work/repair?form=${formName}&notice=${result}`);
  }
  const run = ACTIONS[action as keyof typeof ACTIONS];
  if (!run) return fail(400, 'Unknown action.');
  const problem = await run();
  const flag = problem ? `error=${encodeURIComponent(problem)}` : 'ok=1';
  return redirectTo(request, `/work?${flag}`);
}

export async function GET() {
  if (process.env.NODE_ENV === 'production') return fail(404, 'Not found.');
  const desk = await loadWorkbench();
  return Response.json({ ok: true, ready: desk !== null });
}
