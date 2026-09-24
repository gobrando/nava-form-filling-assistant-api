import { briefForAgent, conservativeDecisions, hintedDecisions } from '../lib/planner/brief';
import { IHSS_ALLOWED, IHSS_FIELDS, IHSS_SOURCES } from '../lib/planner/ihss';
import { decideFields, estimateJevCostUsd } from '../lib/planner/jev';
import { estimateCostUsd } from '../lib/planner/score';

/**
 * Planning cost for one fictional IHSS-sized page.
 *
 * This is the decision pass only. It is not a browser run and it is not
 * Kaylyn's IHSS bill ($5.39 without Eve, $2.40 with Eve, $1.50 with Eve and
 * Jev). Those numbers include the agent driving the real form.
 */
async function main() {
  const input = {
    page: { domain: 'riversideihss.org' },
    fields: IHSS_FIELDS,
    sources: IHSS_SOURCES,
    allowedPurposes: IHSS_ALLOWED,
  };
  const pass = await decideFields(input);
  if (!pass) {
    console.log('skipped  no TYPESAFE_API_KEY');
    process.exit(1);
  }
  const decisions = conservativeDecisions(
    hintedDecisions(pass.decisions, IHSS_FIELDS, IHSS_SOURCES, IHSS_ALLOWED),
    IHSS_FIELDS,
    IHSS_SOURCES,
  );
  const counts = { map: 0, ask: 0, leave: 0, uncertain: 0 };
  for (const decision of decisions) counts[decision.action] += 1;
  const jevCost = estimateJevCostUsd(pass.inputTokens);
  const sonnetIfSameTokens = estimateCostUsd('claude-sonnet-4-6', {
    inputTokens: pass.inputTokens * 3,
    outputTokens: 800 * 3,
  });
  const money = (value: number | null) =>
    value === null ? 'n/a' : value < 0.001 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;

  console.log(`IHSS-shaped page  ${IHSS_FIELDS.length} controls`);
  console.log(
    `Jev ${pass.model}  map ${counts.map}  ask ${counts.ask}  leave ${counts.leave}  inspect ${counts.uncertain}`,
  );
  console.log(
    `Jev planning cost ${money(jevCost)}  (${pass.inputTokens} input tokens, output not billed)`,
  );
  console.log(
    `Sonnet 4.6 planning estimate ${money(sonnetIfSameTokens)} if three roles each read that same inventory`,
  );
  console.log(briefForAgent(decisions, IHSS_FIELDS));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'IHSS comparison failed';
  console.error(message);
  process.exit(1);
});
