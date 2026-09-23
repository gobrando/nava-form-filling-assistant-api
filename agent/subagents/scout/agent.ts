import { TIER_MODELS, VERTEX_CONTEXT_WINDOW_TOKENS } from '@/lib/ai/model-map';
import { claude } from '@/lib/ai/provider';
import { defineAgent } from 'eve';

/**
 * Surveys an unfamiliar or drifted site. Writes nothing.
 *
 * An Eve subagent inherits nothing from its parent — not the model, not the
 * instructions, not the tools — so each one is configured in full. That is
 * verbose but it is also the reason a subagent is worth using: `scout` gets a
 * context window containing a page survey and nothing else, so the
 * orchestrator's window is never filled with DOM dumps it will not reuse.
 */
export default defineAgent({
  description:
    'Surveys a benefits site and returns a field map: selectors, labels, control types, required flags, and exact option text. Read-only. Use before filling an unfamiliar site, or when a playbook probe failed.',
  model: claude(TIER_MODELS.cold),
  modelContextWindowTokens: VERTEX_CONTEXT_WINDOW_TOKENS,
  limits: {
    // A survey that has not converged in this much context is not converging.
    // The honest outcome is a partial map with the gaps named, which the
    // orchestrator can act on; an uncapped scout just spends the run's budget
    // rediscovering the same page.
    maxInputTokensPerSession: 2_000_000,
  },
});
