import { reportGaps } from '@/lib/casegraph/gaps';
import { withTenant } from '@/lib/db';
import { parseInput, requireApplication, toolScope } from '@/lib/eve/tool-context';
import { INPUT_TYPES } from '@/lib/vocabulary';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * The BLOCKED report, as a tool.
 *
 * In the multi-agent skill design, a fill agent that lacks a value stops and
 * returns a BLOCKED report, and the orchestrator asks the human. There is no human here, so this
 * writes the question down and the partner answers it over HTTP. Calling this
 * is a success, not a failure — it is the system declining to invent a value.
 */
const inputSchema = z.object({
  gaps: z
    .array(
      z.object({
        fieldKey: z.string().min(1).max(500),
        label: z.string().max(300).optional(),
        purpose: z.string().max(100).nullable().optional(),
        question: z.string().max(500).optional(),
        required: z.boolean().optional(),
        inputType: z.enum(INPUT_TYPES).optional(),
        options: z.array(z.string().max(300)).max(100).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export default defineTool({
  description: [
    'Report a field you cannot fill because the value is not in the case graph.',
    '',
    'Call this instead of guessing. It is the correct end to a run: the partner',
    'answers the questions through the API and the run resumes with the answers',
    'as facts.',
    '',
    'Always call this for these fields, which may never be inferred:',
    'ssn, housingStatus, preferredContact, householdSize, immigrationStatus,',
    'income, childcare, unemployment, ein.',
    '',
    'Include options for a select or radio so the answer can be validated against',
    'what the form actually accepts.',
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fieldKey: { type: 'string', description: 'The selector or name of the control.' },
            label: { type: 'string', description: 'The visible label on the page.' },
            purpose: {
              type: ['string', 'null'],
              description: 'Canonical fact key this control serves, if you could classify it.',
            },
            question: {
              type: 'string',
              description:
                'A question about the participant, not about the form. Omit for a generated one.',
            },
            required: {
              type: 'boolean',
              description: 'Does the form block submission without it?',
            },
            inputType: { type: 'string', enum: [...INPUT_TYPES] },
            options: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: 'Exact option labels, for a select or radio.',
            },
          },
          required: ['fieldKey'],
          additionalProperties: false,
        },
      },
    },
    required: ['gaps'],
    additionalProperties: false,
  },

  execute: async (raw, ctx) => {
    const input = parseInput(inputSchema, raw);
    const scope = toolScope(ctx);
    const applicationId = requireApplication(scope);

    return withTenant(scope.tenantId, async (tx) => {
      const result = await reportGaps(tx, scope.tenantId, applicationId, input.gaps);
      return {
        reported: result.created,
        // Said explicitly so the model does not read a successful gap report as
        // a failure and start trying to work around it.
        note: 'Gaps recorded. End your turn now. Do not attempt to derive these values.',
      };
    });
  },
});
