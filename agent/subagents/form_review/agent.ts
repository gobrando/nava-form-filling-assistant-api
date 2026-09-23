import { TIER_MODELS, VERTEX_CONTEXT_WINDOW_TOKENS } from '@/lib/ai/model-map';
import { claude } from '@/lib/ai/provider';
import { defineAgent } from 'eve';

/**
 * Turns a finished run into a reviewer's briefing.
 *
 * The packet itself is built by SQL in `lib/casegraph/packet.ts`, not by a
 * model — a projection of stored rows should not be subject to inference. This
 * subagent writes the narrative around it: what to look at first, what is
 * stale, what was derived and from what.
 *
 * Haiku, because the judgment is already encoded in the data. If this agent is
 * reasoning hard, the packet is missing a field.
 */
export default defineAgent({
  description:
    'Reviews a completed application and writes the reviewer-facing summary: what is verified, what is stale, what was inferred and why, and what still needs a human answer. Read-only.',
  model: claude(TIER_MODELS.warm),
  modelContextWindowTokens: VERTEX_CONTEXT_WINDOW_TOKENS,
});
