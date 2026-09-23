import type { FactValue } from '@/lib/casegraph/schemas';
import type { Tx } from '@/lib/db';
import { fact } from '@/lib/db/schema';
import {
  DEFAULT_MAX_AGE_DAYS,
  type FactSource,
  type Freshness,
  SENSITIVE_FIELDS,
  isProtectedField,
} from '@/lib/vocabulary';
import { and, desc, eq } from 'drizzle-orm';

/**
 * Reading and writing the facts ledger.
 *
 * The ledger is append-only — `nava_api` holds no UPDATE or DELETE grant on
 * `Fact` — so "the current value" is a resolution, not a column. That is the
 * point: it makes "what did we believe, when, and on whose word" answerable
 * after the run, which is what labs-asp's ephemeral tool-output provenance
 * cannot do.
 */

export type ResolvedFact = {
  id: string;
  key: string;
  value: unknown;
  source: FactSource;
  sourceDetail: string | null;
  confidence: number | null;
  observedAt: Date;
  expiresAt: Date | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  consentScope: string | null;
  freshness: Freshness;
  sensitive: boolean;
};

function freshnessOf(observedAt: Date, expiresAt: Date | null, now: Date): Freshness {
  if (expiresAt) return expiresAt.getTime() > now.getTime() ? 'fresh' : 'stale';
  const ageMs = now.getTime() - observedAt.getTime();
  if (!Number.isFinite(ageMs)) return 'unknown';
  return ageMs > DEFAULT_MAX_AGE_DAYS * 86_400_000 ? 'stale' : 'fresh';
}

/**
 * The current fact for each key in a household.
 *
 * Rows arrive newest-first and the first sighting of a key wins, so a
 * superseding row shadows what it replaced without deleting it.
 */
export async function currentFacts(
  tx: Tx,
  householdId: string,
  now = new Date(),
): Promise<Map<string, ResolvedFact>> {
  const rows = await tx
    .select()
    .from(fact)
    .where(eq(fact.householdId, householdId))
    .orderBy(desc(fact.observedAt), desc(fact.createdAt));

  const resolved = new Map<string, ResolvedFact>();
  for (const row of rows) {
    if (resolved.has(row.key)) continue;
    resolved.set(row.key, {
      id: row.id,
      key: row.key,
      value: row.value,
      source: row.source,
      sourceDetail: row.sourceDetail,
      confidence: row.confidence === null ? null : Number(row.confidence),
      observedAt: row.observedAt,
      expiresAt: row.expiresAt,
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt,
      consentScope: row.consentScope,
      freshness: freshnessOf(row.observedAt, row.expiresAt, now),
      sensitive: SENSITIVE_FIELDS.has(row.key),
    });
  }
  return resolved;
}

/** Plain `key -> value` view, for adapters that want the provider wire shape. */
export function factValues(facts: Map<string, ResolvedFact>): Record<string, unknown> {
  return Object.fromEntries([...facts].map(([key, resolved]) => [key, resolved.value]));
}

export type FactInput = {
  key: string;
  value: FactValue;
  source: FactSource;
  sourceDetail?: string | null;
  confidence?: number | null;
  observedAt?: Date;
  expiresAt?: Date | null;
  consentScope?: string | null;
  confirmedBy?: string | null;
  personId?: string | null;
};

/**
 * Appends facts, superseding any current row for the same key.
 *
 * The protected-field rule is checked here so the caller gets a clear error,
 * and again by the `Fact_protected_not_inferred` CHECK constraint so a caller
 * that skips this function still cannot write one. Belt and braces, on purpose:
 * the constraint is the guarantee and this is the diagnostic.
 */
export async function appendFacts(
  tx: Tx,
  tenantId: string,
  householdId: string,
  inputs: FactInput[],
): Promise<{
  written: number;
  /** New fact id per key, so a caller can link a row to the fact it created. */
  ids: Map<string, string>;
  rejected: { key: string; reason: string }[];
}> {
  const rejected: { key: string; reason: string }[] = [];
  const accepted: FactInput[] = [];

  for (const input of inputs) {
    if (input.source === 'inferred' && isProtectedField(input.key)) {
      rejected.push({
        key: input.key,
        reason: 'This field may not be inferred. It must be answered directly.',
      });
      continue;
    }
    accepted.push(input);
  }

  if (accepted.length === 0) return { written: 0, ids: new Map(), rejected };

  const existing = await currentFacts(tx, householdId);

  const inserted = await tx
    .insert(fact)
    .values(
      accepted.map((input) => ({
        tenantId,
        householdId,
        personId: input.personId ?? null,
        key: input.key,
        value: input.value as never,
        source: input.source,
        sourceDetail: input.sourceDetail ?? null,
        confidence:
          input.confidence === undefined || input.confidence === null
            ? null
            : input.confidence.toFixed(3),
        observedAt: input.observedAt ?? new Date(),
        expiresAt: input.expiresAt ?? null,
        consentScope: input.consentScope ?? null,
        confirmedBy: input.confirmedBy ?? null,
        confirmedAt: input.confirmedBy ? new Date() : null,
        supersedesId: existing.get(input.key)?.id ?? null,
      })),
    )
    .returning({ id: fact.id, key: fact.key });

  return {
    written: inserted.length,
    ids: new Map(inserted.map((row) => [row.key, row.id])),
    rejected,
  };
}

/** Full history for one key, newest first. The reason the ledger exists. */
export async function factHistory(tx: Tx, householdId: string, key: string) {
  return tx
    .select()
    .from(fact)
    .where(and(eq(fact.householdId, householdId), eq(fact.key, key)))
    .orderBy(desc(fact.observedAt), desc(fact.createdAt));
}

/**
 * Masks a sensitive value for any human-readable projection.
 *
 * The extension masks SSN and EIN in its review and document-intake views. A
 * packet is read by a caseworker in a room with a participant, so the same rule
 * applies here.
 */
export function maskValue(key: string, value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!SENSITIVE_FIELDS.has(key) || text.length === 0) return text;
  const tail = text.replace(/\D/g, '').slice(-4);
  return tail ? `•••-••-${tail}` : '•••';
}
