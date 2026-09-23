import { currentFacts } from '@/lib/casegraph/facts';
import { withTenant } from '@/lib/db';
import { applicationField } from '@/lib/db/schema';
import {
  parseInput,
  requireApplication,
  requireHousehold,
  toolScope,
} from '@/lib/eve/tool-context';
import { INPUT_TYPES, SENSITIVE_FIELDS } from '@/lib/vocabulary';
import { eq, sql } from 'drizzle-orm';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * Records what was entered, and where the value came from.
 *
 * This is where provenance stops being a string in a tool output and becomes a
 * row. The field links to the `Fact` it came from, or declares `source: 'page'`
 * to mean the value was already there and the assistant did not write it. The
 * `ApplicationField_provenance_required` CHECK constraint permits nothing else,
 * so a field cannot hold a value of unknown origin.
 *
 * `verified` must come from an actual readback. The extension's Phase 4 exists
 * because a masked input can reject a bulk fill and report success anyway —
 * writing and confirming are different acts, and only the second one counts.
 */
const inputSchema = z.object({
  fields: z
    .array(
      z.object({
        fieldKey: z.string().min(1).max(500),
        label: z.string().min(1).max(300),
        purpose: z.string().max(100).nullable().optional(),
        value: z.string().max(2000).nullable(),
        inputType: z.enum(INPUT_TYPES).optional(),
        options: z.array(z.string().max(300)).max(200).nullable().optional(),
        required: z.boolean().optional(),
        // 'page' means pre-existing. Any other source must resolve to a fact.
        source: z.enum(['fact', 'page']),
        verified: z.boolean(),
        note: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export default defineTool({
  description: [
    'Record fields you entered on the page, with where each value came from.',
    '',
    'Call this after verifying a page, not before. `verified` must mean you read',
    'the value back out of the control and it matched what you intended. A masked',
    'or scripted input can silently reject a write and still look successful.',
    '',
    'Set source to "fact" when the value came from read_facts — give the purpose',
    'so it can be linked to the fact it came from. Set source to "page" only when',
    'the value was already present and you did not write it.',
    '',
    'A value with source "fact" and no matching fact is rejected. That is',
    'deliberate: it is how an invented value is caught.',
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fieldKey: { type: 'string' },
            label: { type: 'string' },
            purpose: {
              type: ['string', 'null'],
              description: 'Canonical fact key. Required when source is "fact".',
            },
            value: { type: ['string', 'null'] },
            inputType: { type: 'string', enum: [...INPUT_TYPES] },
            options: { type: ['array', 'null'], items: { type: 'string' } },
            required: { type: 'boolean' },
            source: { type: 'string', enum: ['fact', 'page'] },
            verified: {
              type: 'boolean',
              description: 'True only if you read the value back and it matched.',
            },
            note: { type: 'string' },
          },
          required: ['fieldKey', 'label', 'value', 'source', 'verified'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  },

  execute: async (raw, ctx) => {
    const input = parseInput(inputSchema, raw);
    const scope = toolScope(ctx);
    const applicationId = requireApplication(scope);
    const householdId = requireHousehold(scope);

    return withTenant(scope.tenantId, async (tx) => {
      const facts = await currentFacts(tx, householdId);

      const existing = await tx
        .select({ ordinal: applicationField.ordinal })
        .from(applicationField)
        .where(eq(applicationField.applicationId, applicationId));
      let ordinal = existing.reduce((max, row) => Math.max(max, row.ordinal), -1) + 1;

      const rejected: { fieldKey: string; reason: string }[] = [];
      const rows: (typeof applicationField.$inferInsert)[] = [];

      for (const field of input.fields) {
        let factId: string | null = null;
        let factSource: string | null = null;

        if (field.value !== null && field.source === 'fact') {
          const resolved = field.purpose ? facts.get(field.purpose) : undefined;
          if (!resolved) {
            rejected.push({
              fieldKey: field.fieldKey,
              reason:
                'No fact backs this value. Either set purpose to the fact key it came from, or report it as a gap.',
            });
            continue;
          }
          factId = resolved.id;
          factSource = resolved.source;
        }

        rows.push({
          tenantId: scope.tenantId,
          applicationId,
          ordinal: ordinal++,
          fieldKey: field.fieldKey,
          label: field.label,
          purpose: field.purpose ?? null,
          value: field.value,
          inputType: field.inputType ?? 'text',
          options: field.options ?? null,
          required: field.required ?? false,
          sensitive: field.purpose ? SENSITIVE_FIELDS.has(field.purpose) : false,
          factId,
          source:
            field.value === null
              ? null
              : field.source === 'page'
                ? 'page'
                : (factSource as (typeof applicationField.$inferInsert)['source']),
          sourceDetail: field.note ?? null,
          verifiedAt: field.verified ? new Date() : null,
        });
      }

      if (rows.length > 0) {
        // `excluded` refers to each conflicting row's own proposed values. A
        // literal from `rows[0]` would apply the first field's value to every
        // field that conflicted, which is the kind of bug that writes one
        // participant's ZIP code into six controls.
        await tx
          .insert(applicationField)
          .values(rows)
          .onConflictDoUpdate({
            target: [applicationField.applicationId, applicationField.fieldKey],
            set: {
              value: sql`excluded."value"`,
              factId: sql`excluded."factId"`,
              source: sql`excluded."source"`,
              sourceDetail: sql`excluded."sourceDetail"`,
              verifiedAt: sql`excluded."verifiedAt"`,
            },
          });
      }

      return {
        recorded: rows.length,
        verified: rows.filter((row) => row.verifiedAt !== null).length,
        rejected,
      };
    });
  },
});
