import { TIER_MODELS, VERTEX_CONTEXT_WINDOW_TOKENS } from '@/lib/ai/model-map';
import { claude } from '@/lib/ai/provider';
import { defineAgent } from 'eve';

/**
 * Writes and repairs playbooks.
 *
 * It writes and repairs those scripts, plans for new sites, heals broken ones,
 * and otherwise stays idle. Idle is the normal state: the scribe is woken by a failed
 * freshness probe, not by every run.
 *
 * It is also the only part of a cold run that produces something durable. A
 * cold run that fills a form and does not repair the playbook has paid the
 * expensive price and bought nothing for the next run.
 */
export default defineAgent({
  description:
    'Writes or repairs a site playbook after a freshness probe failed: updates selectors, the field map, and the probe set so the next run can execute deterministically. Dispatch once per run, after filling.',
  model: claude(TIER_MODELS.scribe),
  modelContextWindowTokens: VERTEX_CONTEXT_WINDOW_TOKENS,
});
