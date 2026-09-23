/**
 * What the agent's browser is allowed to do.
 *
 * The instructions already say "never submit" and "never leave the site". This
 * module is the same rule enforced in code, because a prompt is advice and a
 * model can be wrong, confused, or manipulated by the page it is reading. Every
 * command passes through `checkCommand` before it reaches the browser.
 *
 * It is an allowlist of commands, not a denylist: a command this module does not
 * recognize is refused. That matters because agent-browser grows new commands,
 * and a new one should have to be deliberately admitted rather than arrive
 * unreviewed.
 */

export type Verdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Labels on the control that ends an application. Clicking one is the human's
 * act, never the agent's. `Next` and `Continue` are deliberately absent: those
 * are the page-to-page controls the agent needs, and many sites render them as
 * `type=submit` buttons too, so the label is the only honest signal.
 */
const FINAL_ACTION =
  /\b(submit|sign|signature|certify|attest|e-?sign|send (my |the )?application|apply now|finish|complete (my |the )?application|i agree|confirm and send)\b/i;

export function isFinalAction(label: string | null | undefined): boolean {
  return Boolean(label && FINAL_ACTION.test(label));
}

const READ_ONLY = new Set([
  'snapshot',
  'screenshot',
  'get',
  'is',
  'wait',
  'scroll',
  'scrollintoview',
]);
const FIELD_WRITES = new Set(['fill', 'type', 'select', 'check', 'uncheck', 'hover', 'focus']);
const CLICKS = new Set(['click', 'dblclick']);

/** JavaScript that changes the page. `eval` is admitted only to read. */
const MUTATING_JS =
  /\b(click|submit|requestSubmit|dispatchEvent|\.value\s*=|checked\s*=|location|href\s*=|fetch|XMLHttpRequest|sendBeacon|window\.open|innerHTML|outerHTML|setAttribute|removeAttribute)\b/;

/** Keys that submit a single-page form from a text field. Tab moves focus instead. */
const SUBMITTING_KEYS = new Set(['enter', 'return', 'numpadenter']);

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isAllowedUrl(url: string, allowedOrigins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && allowedOrigins.includes(origin);
}

/**
 * `labelFor` resolves a ref (`@e8`) or selector to the control's accessible
 * name. It is supplied by the caller because only the caller has the page.
 */
export function checkCommand(
  command: readonly string[],
  context: { allowedOrigins: readonly string[]; labelFor: (target: string) => string | null },
): Verdict {
  const [verb, ...args] = command;
  if (!verb) return { allowed: false, reason: 'Empty command.' };

  if (verb === 'open') {
    const url = args[0];
    if (!url || !isAllowedUrl(url, context.allowedOrigins)) {
      return {
        allowed: false,
        reason: `Navigation is limited to this application's site (${context.allowedOrigins.join(', ')}).`,
      };
    }
    return { allowed: true };
  }

  if (READ_ONLY.has(verb) || FIELD_WRITES.has(verb)) return { allowed: true };

  if (CLICKS.has(verb)) {
    const target = args[0];
    if (!target) return { allowed: false, reason: 'click needs a target.' };
    const label = context.labelFor(target);
    if (label === null) {
      // Unknown means unchecked. Refusing is the only safe default, and a fresh
      // snapshot always resolves it.
      return {
        allowed: false,
        reason: `Cannot tell what ${target} is. Take a snapshot first so its label is known.`,
      };
    }
    if (isFinalAction(label)) return finalActionRefusal(label);
    return { allowed: true };
  }

  if (verb === 'find') {
    // find <locator> <value> <action> [text] [--name <name>]
    const action = args[2];
    if (action === 'click' || action === 'dblclick') {
      const nameIndex = args.indexOf('--name');
      const label = nameIndex >= 0 ? args[nameIndex + 1] : args[1];
      if (isFinalAction(label) || isFinalAction(args[1]))
        return finalActionRefusal(label ?? args[1]);
      return { allowed: true };
    }
    if (action && FIELD_WRITES.has(action)) return { allowed: true };
    return { allowed: false, reason: `find … ${action ?? '(none)'} is not permitted.` };
  }

  if (verb === 'press') {
    const key = (args[0] ?? '').toLowerCase();
    if (SUBMITTING_KEYS.has(key)) {
      return {
        allowed: false,
        reason: 'Enter can submit a form from a text field. Use Tab to move between fields.',
      };
    }
    return { allowed: true };
  }

  if (verb === 'eval') {
    const script = args.join(' ');
    if (MUTATING_JS.test(script)) {
      return {
        allowed: false,
        reason:
          'eval is for reading values only. Use fill, type, select, or click to change the page.',
      };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: `The ${verb} command is not available to this agent.` };
}

function finalActionRefusal(label: string | null | undefined): Verdict {
  return {
    allowed: false,
    reason: `"${label}" looks like the final submission control. Submitting is the caseworker's decision. Stop here, call check_submit_gate, and end your turn.`,
  };
}

/**
 * Local testing only: point the agent at the form fixture while it still
 * believes it is on the real site. Ignored in production so a deployed service
 * can never be redirected by configuration.
 *
 * BROWSER_ORIGIN_OVERRIDE="https://www.ruhealth.org=http://localhost:4300"
 */
export function originOverrides(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const map = new Map<string, string>();
  if (env.NODE_ENV === 'production' || !env.BROWSER_ORIGIN_OVERRIDE) return map;
  for (const pair of env.BROWSER_ORIGIN_OVERRIDE.split(',')) {
    const [from, to] = pair.split('=').map((part) => part.trim());
    const fromOrigin = from ? originOf(from) : null;
    const toOrigin = to ? originOf(to) : null;
    if (fromOrigin && toOrigin) map.set(fromOrigin, toOrigin);
  }
  return map;
}

export function rewriteUrl(url: string, overrides: Map<string, string>): string {
  const origin = originOf(url);
  const target = origin ? overrides.get(origin) : undefined;
  return target && origin ? target + url.slice(origin.length) : url;
}
