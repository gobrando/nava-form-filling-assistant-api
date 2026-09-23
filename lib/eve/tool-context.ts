import type { ToolContext } from 'eve/tools';
import type { z } from 'zod';

/**
 * Session-attribute extraction and input validation for Eve tools.
 *
 * Two notes on why tools look the way they do in this tree:
 *
 * 1. `inputSchema` is raw JSON Schema, not a Zod object. Eve's `defineTool`
 *    wants a Standard Schema with a `~standard.jsonSchema` property, which Zod
 *    provides from v4 onward. This project pins Zod 3.25 to match labs-asp, so
 *    the JSON-Schema overload is the working path and inputs are validated with
 *    Zod inside `execute`. Same guarantees, one extra line.
 *
 * 2. Tenant scope comes from the session's auth attributes, never from a tool
 *    argument. A model can be talked into passing a different id; it cannot
 *    talk its way into a different session. `withTenant` then makes Postgres
 *    enforce it.
 */

export type ToolScope = {
  tenantId: string;
  applicationId: string | null;
  householdId: string | null;
  principalId: string;
};

function attribute(ctx: ToolContext, name: string): string | null {
  const from: string | readonly string[] | undefined =
    ctx.session.auth.current?.attributes?.[name] ?? ctx.session.auth.initiator?.attributes?.[name];
  if (from === undefined) return null;
  return typeof from === 'string' ? from : (from[0] ?? null);
}

export function toolScope(ctx: ToolContext): ToolScope {
  const tenantId = attribute(ctx, 'tenantId');
  if (!tenantId) {
    // Fail loudly. A tool that runs without a tenant would be filtered to zero
    // rows by row-level security anyway, and "no facts found" is a far more
    // confusing symptom than this message.
    throw new Error('This session has no tenant. The agent channel must set tenantId.');
  }

  return {
    tenantId,
    applicationId: attribute(ctx, 'applicationId'),
    householdId: attribute(ctx, 'householdId'),
    principalId:
      ctx.session.auth.current?.principalId ??
      ctx.session.auth.initiator?.principalId ??
      'agent:unknown',
  };
}

export function requireApplication(scope: ToolScope): string {
  if (!scope.applicationId) {
    throw new Error(
      'This session has no application. Start the run through POST /v1/applications.',
    );
  }
  return scope.applicationId;
}

export function requireHousehold(scope: ToolScope): string {
  if (!scope.householdId) {
    throw new Error('This session has no household.');
  }
  return scope.householdId;
}

/** Validates a tool's raw input, turning a schema failure into a model-readable error. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid tool input: ${detail}`);
}
