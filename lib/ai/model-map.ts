/**
 * Vertex model ids and the tiering policy.
 *
 * The cost argument, applied as routing: a warm run executing a fresh
 * playbook is checklist work and gets the cheapest model; a cold run is
 * discovery and judgment and gets a mid model; the scribe writes durable
 * knowledge files and gets a mid model too. Nothing here reaches for opus,
 * because nothing here is novel planning.
 *
 * Two hard-won constraints from labs-asp, both load-bearing:
 *
 * 1. `GOOGLE_VERTEX_LOCATION` should be `global`. A project without regional
 *    input-token quota for the opus base models gets a 429 from a regional
 *    endpoint even on a ten-token request.
 *
 * 2. `modelContextWindowTokens` must be set explicitly. A `vertexAnthropic(...)`
 *    instance reports its provider as `googleVertex.anthropic.messages`, which
 *    matches no AI Gateway catalog slug, so Eve's lookup misses and
 *    `compileAgentConfig` throws. 200K is Claude's default window on Vertex;
 *    the gateway advertises 1M but it is tier-gated, and this value drives the
 *    compaction trigger — too high delays compaction past the point where
 *    Vertex hard-errors on context length.
 */

export const VERTEX_CONTEXT_WINDOW_TOKENS = 200_000;

export const MODEL_MAP = {
  'claude-opus-4-8': 'claude-opus-4-8',
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5': 'claude-haiku-4-5',
} as const;

export type VertexModelId = keyof typeof MODEL_MAP;

export function isVertexModelId(value: unknown): value is VertexModelId {
  return typeof value === 'string' && value in MODEL_MAP;
}

export function toVertexModelId(value: unknown): VertexModelId | undefined {
  return isVertexModelId(value) ? value : undefined;
}

/**
 * The execution tier, carried as a session auth attribute and resolved on
 * `step.started`.
 *
 * `warm` means a playbook resolved and every freshness probe passed, so the
 * work is "read the field map and fill". `cold` means a novel or drifted site.
 */
export const EXECUTION_TIERS = ['warm', 'cold', 'scribe'] as const;
export type ExecutionTier = (typeof EXECUTION_TIERS)[number];

export function isExecutionTier(value: unknown): value is ExecutionTier {
  return typeof value === 'string' && (EXECUTION_TIERS as readonly string[]).includes(value);
}

export const TIER_MODELS: Record<ExecutionTier, VertexModelId> = {
  warm: 'claude-haiku-4-5',
  cold: 'claude-sonnet-4-6',
  scribe: 'claude-sonnet-4-6',
};

/**
 * The fallback when no tier is declared.
 *
 * Sonnet, not haiku: an unknown tier is more likely a cold run than a warm one,
 * and being wrong toward the cheaper model means a cold site gets driven by a
 * checklist model, which produces silent failures rather than an obvious cost
 * line.
 */
export const DEFAULT_MODEL_ID: VertexModelId = 'claude-sonnet-4-6';
