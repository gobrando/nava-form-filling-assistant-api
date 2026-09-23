import { FIELD_KEYS, factSourceSchema } from '@/lib/vocabulary';
import { z } from 'zod';

/**
 * A fact value is a scalar, or a list of scalars for a multi-select.
 *
 * Every type in the connector schema is scalar — text, date, email, phone,
 * select, boolean, number, currency, sensitive — and the extension's checkbox
 * handling represents a multi-select as a list. Refusing nested objects keeps
 * the ledger's values shaped like answers to questions, which is what makes
 * masking and history diffs tractable.
 */
export const factValueSchema = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(500), z.number(), z.boolean()])).max(50),
]);

export type FactValue = z.infer<typeof factValueSchema>;

/**
 * `key` is constrained to the canonical vocabulary rather than accepting free
 * text. An unrecognized key would be silently unmappable by the extension's
 * form engine, so it is rejected at the door where the caller can see why.
 */
export const factInputSchema = z
  .object({
    key: z.enum(FIELD_KEYS as [string, ...string[]]),
    value: factValueSchema,
    source: factSourceSchema,
    sourceDetail: z.string().max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
    observedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
    consentScope: z.string().max(200).optional(),
    confirmedBy: z.string().max(200).optional(),
  })
  .strict();

export type FactInputBody = z.infer<typeof factInputSchema>;
