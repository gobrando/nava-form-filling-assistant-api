import { runCommand } from '@/lib/browser/cli';
import {
  checkCommand,
  isAllowedUrl,
  originOf,
  originOverrides,
  rewriteUrl,
} from '@/lib/browser/policy';
import { withTenant } from '@/lib/db';
import { application } from '@/lib/db/schema';
import { parseInput, requireApplication, toolScope } from '@/lib/eve/tool-context';
import { planWorkflows } from '@/lib/vocabulary';
import { eq } from 'drizzle-orm';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * The agent's hands.
 *
 * Same argv vocabulary as the Eve prototype's browser tool, so the skills port
 * unchanged. Every command is checked by `lib/browser/policy.ts` first: the
 * site is limited to the application's own origins, the final submission
 * control cannot be clicked, and Enter cannot be pressed. Those rules are also
 * in the instructions; here they do not depend on the model agreeing.
 */

const inputSchema = z.object({ command: z.array(z.string().max(5000)).min(1).max(20) });

type Ref = { name?: string; role?: string };

/** Last snapshot's refs per browser session, so a click on `@e8` can be labeled. */
const refsBySession = new Map<string, Record<string, Ref>>();

const MAX_OUTPUT_CHARS = 40_000;

function sessionName(eveSessionId: string): string {
  return `nava-${eveSessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`;
}

async function applicationSite(tenantId: string, applicationId: string) {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ programIds: application.programIds })
      .from(application)
      .where(eq(application.id, applicationId))
      .limit(1),
  );
  const workflow = rows[0] ? planWorkflows(rows[0].programIds)[0] : undefined;
  if (!workflow) throw new Error('This application has no known site.');

  const overrides = originOverrides();
  const allowedOrigins = [
    ...workflow.allowedOrigins,
    ...workflow.allowedOrigins.map((origin) => overrides.get(origin)).filter(Boolean),
  ] as string[];
  return { url: rewriteUrl(workflow.url, overrides), allowedOrigins, overrides };
}

async function resolveLabel(session: string, target: string): Promise<string | null> {
  if (target.startsWith('@')) {
    const ref = refsBySession.get(session)?.[target.slice(1)];
    if (ref?.name !== undefined) return ref.name;
  }
  // A selector, or a ref from before the last snapshot: ask the page.
  const [text, value] = await Promise.all([
    runCommand(['get', 'text', target], { session }),
    runCommand(['get', 'attr', target, 'value'], { session }),
  ]);
  if (!text.success && !value.success) return null;
  const parts = [text.data, value.data]
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part ?? '')))
    .filter((part) => part && part !== '""' && part !== 'null');
  return parts.join(' ').trim();
}

function remember(session: string, data: unknown) {
  const refs = (data as { refs?: Record<string, Ref> } | null)?.refs;
  if (refs) refsBySession.set(session, refs);
}

function render(data: unknown): string {
  if (data === undefined || data === null) return '';
  const snapshot = (data as { snapshot?: unknown }).snapshot;
  const text =
    typeof snapshot === 'string'
      ? snapshot
      : typeof data === 'string'
        ? data
        : JSON.stringify(data);
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated. Use a scoped snapshot (snapshot -s form) to see less.`
    : text;
}

export default defineTool({
  description: [
    'Run one agent-browser command against this application’s browser.',
    '',
    'Pass the command as an argv array, e.g. ["snapshot", "-i"], ["fill", "@e2", "Jordan"],',
    '["select", "@e6", "English"], ["get", "value", "@e5"]. Never quote or escape values.',
    '',
    'Workflow: open the application URL, snapshot, fill from facts, then read every',
    'written value back with ["get", "value", ref]. Re-snapshot after the page changes.',
    'Use ["type", ref, value] for masked fields (SSN, dates, phone).',
    '',
    'Refused by design: leaving the application’s site, clicking the final',
    'submit/sign/certify control, pressing Enter, and eval that changes the page.',
    'A refusal is not an error to work around. It means stop and report.',
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'array',
        items: { type: 'string' },
        description: 'agent-browser argv. One argument per element.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  execute: async (raw, ctx) => {
    const { command } = parseInput(inputSchema, raw);
    const scope = toolScope(ctx);
    const applicationId = requireApplication(scope);
    const site = await applicationSite(scope.tenantId, applicationId);
    const session = sessionName(ctx.session.id);

    const argv = [...command];
    if (argv[0] === 'open' && argv[1]) argv[1] = rewriteUrl(argv[1], site.overrides);

    let clickLabel: string | null = null;
    const clickTarget = argv[0] === 'click' || argv[0] === 'dblclick' ? argv[1] : undefined;
    if (clickTarget) clickLabel = await resolveLabel(session, clickTarget);

    const verdict = checkCommand(argv, {
      allowedOrigins: site.allowedOrigins,
      labelFor: (target) => (target === clickTarget ? clickLabel : null),
    });
    if (!verdict.allowed) {
      return { success: false, refused: true, output: null, error: verdict.reason };
    }

    const response = await runCommand(argv, { session });
    if (argv[0] === 'snapshot') remember(session, response.data);

    // A click or keypress can navigate. If it left the site, go back to the
    // application rather than let the next command run somewhere unvetted.
    if (response.success && ['click', 'dblclick', 'press', 'find'].includes(argv[0])) {
      const where = await runCommand(['get', 'url'], { session });
      const url =
        typeof where.data === 'string' ? where.data : (where.data as { url?: string })?.url;
      if (url && !isAllowedUrl(url, site.allowedOrigins)) {
        await runCommand(['open', site.url], { session });
        return {
          success: false,
          refused: true,
          output: null,
          error: `That action navigated off the application site (${originOf(url)}). Returned to ${site.url}.`,
        };
      }
    }

    return response.success
      ? { success: true, output: render(response.data), error: null }
      : { success: false, output: null, error: response.error ?? 'command failed' };
  },
});
