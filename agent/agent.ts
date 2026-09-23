import {
  DEFAULT_MODEL_ID,
  TIER_MODELS,
  VERTEX_CONTEXT_WINDOW_TOKENS,
  isExecutionTier,
} from '@/lib/ai/model-map';
import { claude } from '@/lib/ai/provider';
import { defineAgent, defineDynamic } from 'eve';

/**
 * The orchestrator.
 *
 * This is the cold path only. A warm run — one where a playbook resolved and
 * every freshness probe passed — never reaches a model at all; the route
 * handler replays the field map deterministically, which is the whole point of
 * serving playbooks. The agent exists for novel sites, drifted sites, and
 * playbook repair.
 *
 * The multi-application design puts the orchestrator in charge of all user
 * I/O and has a fill agent return a BLOCKED report when it needs an answer.
 * There is no user on an API, so BLOCKED becomes a row in `Gap` and the run
 * ends its turn. `POST /v1/applications/{id}/gaps` supplies the answers and
 * resumes this same session with its continuation token.
 *
 * Models are called directly on Vertex rather than through the AI Gateway,
 * matching labs-asp: the gateway tier on this account 403s haiku and opus, and
 * the direct path reuses credentials production has always used.
 */
export default defineAgent({
  model: defineDynamic({
    fallback: claude(DEFAULT_MODEL_ID),
    events: {
      // Step scope, not session scope. Eve rejects a live `LanguageModel` from
      // a session- or turn-scoped resolver — those must be serializable model
      // id strings, which would route through the gateway. Step scope is the
      // only place an authored provider instance survives to the model call.
      'step.started': (_event, ctx) => {
        const tier =
          ctx.session.auth.initiator?.attributes?.executionTier ??
          ctx.session.auth.current?.attributes?.executionTier ??
          null;

        const requested = Array.isArray(tier) ? tier[0] : tier;
        if (!isExecutionTier(requested)) return null;

        const modelId = TIER_MODELS[requested];
        if (modelId === DEFAULT_MODEL_ID) return null;

        return {
          model: claude(modelId),
          modelContextWindowTokens: VERTEX_CONTEXT_WINDOW_TOKENS,
        };
      },
    },
  }),
  modelContextWindowTokens: VERTEX_CONTEXT_WINDOW_TOKENS,
  compaction: {
    // Matches labs-asp. Compaction is Eve's job here, not the app's; there is
    // no `prepareStep` hook to port a custom compressor into.
    thresholdPercent: 0.75,
  },
});
