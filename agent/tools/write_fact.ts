import { appendFacts } from '@/lib/casegraph/facts';
import { factValueSchema } from '@/lib/casegraph/schemas';
import { withTenant } from '@/lib/db';
import { parseInput, requireHousehold, toolScope } from '@/lib/eve/tool-context';
import { FIELD_KEYS } from '@/lib/vocabulary';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * Writes a fact the run learned — a value read off the page, or one derived
 * from other facts.
 *
 * Only two sources are offered. `page` is an observation, and `inferred` is a
 * derivation that must carry its reasoning in `sourceDetail`. The agent cannot
 * claim a value came from a connector or a caseworker, because it did not talk
 * to either; asserting otherwise would launder a guess into the strongest
 * provenance tier the packet has.
 *
 * The protected keys are refused here and again by the
 * `Fact_protected_not_inferred` CHECK constraint.
 */
const inputSchema = z.object({
  facts: z
    .array(
      z.object({
        key: z.enum(FIELD_KEYS as [string, ...string[]]),
        value: factValueSchema,
        source: z.enum(['page', 'inferred']),
        reasoning: z.string().min(1).max(500),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export default defineTool({
  description: [
    'Write a fact the run learned, so it is available to later pages and to the',
    'reviewer.',
    '',
    'Use source "page" for a value that was already on the form. Use "inferred"',
    'for a value you derived — the county from the ZIP code, the clinic from the',
    'home address. Always explain the derivation in reasoning; it is shown to the',
    'reviewer beside the value.',
    '',
    'These keys cannot be inferred and the write will be refused:',
    'ssn, housingStatus, preferredContact, householdSize, immigrationStatus,',
    'income, childcare, unemployment, ein. Call report_gap for those.',
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: [...FIELD_KEYS] },
            value: {},
            source: { type: 'string', enum: ['page', 'inferred'] },
            reasoning: {
              type: 'string',
              description: 'How you know this. Shown to the reviewer.',
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['key', 'value', 'source', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
    required: ['facts'],
    additionalProperties: false,
  },

  execute: async (raw, ctx) => {
    const input = parseInput(inputSchema, raw);
    const scope = toolScope(ctx);
    const householdId = requireHousehold(scope);

    return withTenant(scope.tenantId, async (tx) => {
      const result = await appendFacts(
        tx,
        scope.tenantId,
        householdId,
        input.facts.map((item) => ({
          key: item.key,
          value: item.value,
          source: item.source,
          sourceDetail: item.reasoning,
          confidence: item.confidence ?? (item.source === 'inferred' ? 0.7 : 1),
        })),
      );

      return {
        written: result.written,
        rejected: result.rejected,
        ...(result.rejected.length > 0
          ? { note: 'Rejected keys may not be inferred. Call report_gap for them.' }
          : {}),
      };
    });
  },
});
