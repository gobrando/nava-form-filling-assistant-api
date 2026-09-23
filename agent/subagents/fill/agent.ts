import { TIER_MODELS, VERTEX_CONTEXT_WINDOW_TOKENS, isExecutionTier } from '@/lib/ai/model-map';
import { claude } from '@/lib/ai/provider';
import { defineAgent, defineDynamic } from 'eve';

/**
 * Fills one application. One `fill` agent per application, never one driving
 * several — the multi-application design is explicit that a fill agent owns
 * a single application and its page.
 *
 * This is the one subagent that tiers its model, because it is the one whose
 * work changes character with playbook freshness. Confirming a mostly-correct
 * field map is checklist work; deriving one from a changed page is not.
 */
export default defineAgent({
  description:
    'Fills one benefits application from the household facts, verifies every write by reading it back, and returns BLOCKED with the missing fields when a value is not available. Never submits. Dispatch one per application.',
  model: defineDynamic({
    fallback: claude(TIER_MODELS.cold),
    events: {
      'step.started': (_event, ctx) => {
        const tier =
          ctx.session.auth.current?.attributes?.executionTier ??
          ctx.session.auth.initiator?.attributes?.executionTier ??
          null;
        const requested = Array.isArray(tier) ? tier[0] : tier;
        if (!isExecutionTier(requested) || requested === 'cold') return null;
        return {
          model: claude(TIER_MODELS[requested]),
          modelContextWindowTokens: VERTEX_CONTEXT_WINDOW_TOKENS,
        };
      },
    },
  }),
  modelContextWindowTokens: VERTEX_CONTEXT_WINDOW_TOKENS,
  compaction: { thresholdPercent: 0.75 },
});
