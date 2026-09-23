import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * agent-browser CLI transport, ported from the Eve prototype's
 * `lib/kernel/cli.ts`.
 *
 * agent-browser is a native binary driven as a subprocess that answers with a
 * JSON envelope. Commands are passed through as its own argv, so the model, the
 * skills, and this code share one vocabulary.
 *
 * Two backends, chosen by environment:
 * - default: agent-browser launches and owns a local Chromium. This is what
 *   runs against the form fixture, and it needs no account anywhere.
 * - `BROWSER_CDP_URL`: attach to an existing browser over CDP, which is how a
 *   Kernel remote browser (or any hosted Chromium) is driven in production.
 */

export interface CliResponse {
  success: boolean;
  data?: unknown;
  error?: string | null;
}

const CLI_BIN =
  process.env.AGENT_BROWSER_BIN ?? join(process.cwd(), 'node_modules', '.bin', 'agent-browser');

export const DEFAULT_TIMEOUT_MS = 120_000;

export function buildArgs(
  command: readonly string[],
  options: { session: string; cdpUrl?: string | null },
): string[] {
  if (command.length === 0) throw new Error('[agent-browser] command must not be empty');
  return [
    '--session',
    options.session,
    ...(options.cdpUrl ? ['--cdp', options.cdpUrl] : []),
    '--json',
    ...command,
  ];
}

/**
 * A non-zero exit is still a structured failure when stdout carries JSON (the
 * binary reports "element not found" that way). Non-JSON output means the
 * binary itself failed, and stderr is where that lands.
 */
export function parseResponse(stdout: string, stderr: string): CliResponse {
  const text = stdout.trim();
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return { success: true, data: parsed };
      if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
        return parsed as CliResponse;
      }
      return { success: true, data: parsed };
    } catch {
      // Not JSON; fall through to stderr.
    }
  }
  return {
    success: false,
    data: null,
    error: stderr.trim() || text || 'agent-browser produced no output',
  };
}

/** Never rejects on a browser-level failure; rejects only if the binary cannot run. */
export function runCommand(
  command: readonly string[],
  options: { session: string; timeoutMs?: number },
): Promise<CliResponse> {
  const args = buildArgs(command, {
    session: options.session,
    cdpUrl: process.env.BROWSER_CDP_URL,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      CLI_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`[agent-browser] binary not found at ${CLI_BIN}. Run pnpm install.`));
          return;
        }
        if (error && 'killed' in error && error.killed) {
          resolve({ success: false, data: null, error: `Command timed out after ${timeoutMs}ms` });
          return;
        }
        resolve(parseResponse(stdout, stderr));
      },
    );
  });
}
