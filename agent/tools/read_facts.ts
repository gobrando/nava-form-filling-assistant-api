import { currentFacts } from '@/lib/casegraph/facts';
import { withTenant } from '@/lib/db';
import { parseInput, requireHousehold, toolScope } from '@/lib/eve/tool-context';
import { DO_NOT_DERIVE, labelFor } from '@/lib/vocabulary';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * Replaces labs-asp's `update_working_memory`.
 *
 * There, household data lives in a synthetic working-memory message that is
 * rewritten in place, so the values are whatever the last write said and there
 * is no record of what came before. Here the household is a query against an
 * append-only ledger, which means the agent reads the same thing a reviewer
 * will read afterward.
 */
const inputSchema = z.object({
  keys: z.array(z.string()).max(100).optional(),
});

export default defineTool({
  description: [
    'Read the household facts for this run from the case graph.',
    '',
    'Call this once at the start of a run. Every value you enter into a form must',
    'come from here. If a field you need is not in the result, it is not known —',
    'call report_gap rather than deriving it from something else.',
    '',
    'Each fact carries its source and freshness. A stale fact may be entered, but',
    'say so in your summary so the reviewer knows to confirm it.',
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional filter. Omit to read every known fact.',
      },
    },
    additionalProperties: false,
  },

  execute: async (raw, ctx) => {
    const input = parseInput(inputSchema, raw);
    const scope = toolScope(ctx);
    const householdId = requireHousehold(scope);

    return withTenant(scope.tenantId, async (tx) => {
      const facts = await currentFacts(tx, householdId);
      const wanted = input.keys ? new Set(input.keys) : null;

      const rows = [...facts.values()]
        .filter((item) => !wanted || wanted.has(item.key))
        .map((item) => ({
          key: item.key,
          label: labelFor(item.key),
          value: item.value,
          source: item.source,
          sourceDetail: item.sourceDetail,
          freshness: item.freshness,
          confirmedBy: item.confirmedBy,
          observedAt: item.observedAt.toISOString(),
          // Surfaced per-fact rather than only in the instructions, because the
          // model is far more likely to honor a flag attached to the value it
          // is about to use than a list it read many turns ago.
          mayNotBeInferred: DO_NOT_DERIVE.has(item.key),
        }));

      return {
        householdId,
        factCount: rows.length,
        staleCount: rows.filter((row) => row.freshness !== 'fresh').length,
        facts: rows,
      };
    });
  },
});
