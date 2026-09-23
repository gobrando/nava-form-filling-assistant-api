import { currentFacts, factValues } from '@/lib/casegraph/facts';
import type { Tx } from '@/lib/db';
import { connection, household } from '@/lib/db/schema';
import { providerDefinition } from '@/lib/vocabulary';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type ApricotLiveRecord,
  ConnectorCredentialsError,
  ConnectorUpstreamError,
  fetchFormFields,
  fetchRecord,
  resolveCredentials,
} from './apricot-live';
import {
  APRICOT_DEMO_SCHEMA,
  APRICOT_DEMO_SOURCE_ID,
  type ApricotRecord,
  type ApricotSchemaField,
  toApricotRecord,
} from './apricot360';

/**
 * Connector dispatch.
 *
 * Apricot 360 runs in two modes. `local-demo` serves the seeded case graph in
 * Apricot's wire format. `live` reads the organization's real Apricot through
 * `apricot-live.ts`, using credentials named by `Connection.secretRef`. The
 * other eight providers in the catalog are `adapter-required` and fail loudly
 * rather than half-working.
 *
 * Turning a connection live is a configuration step, not a code change, and it
 * is gated on the organization that owns the data: it issues the API client,
 * and its data-processing agreement is what permits the read.
 */

export type ConnectionRow = typeof connection.$inferSelect;

export type ConnectorMode = 'local-demo' | 'live';

export async function resolveConnection(
  tx: Tx,
  connectionId: string,
): Promise<ConnectionRow | null> {
  const rows = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.connectionId, connectionId), isNull(connection.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export function connectorMode(row: ConnectionRow): ConnectorMode {
  return row.secretRef ? 'live' : 'local-demo';
}

export function connectorHealth(row: ConnectionRow): {
  provider: string;
  organizationName: string;
  mode: ConnectorMode;
} {
  return {
    provider: row.providerId,
    organizationName: row.organizationName,
    mode: connectorMode(row),
  };
}

/**
 * The labeled schema.
 *
 * The contract requires returning this "before any record is mapped" — the
 * extension will not fetch a record until an administrator has reviewed the
 * field mapping, which is what keeps a provider rename from silently writing
 * the wrong value into a benefits application.
 */
export async function connectorSchema(row: ConnectionRow): Promise<ApricotSchemaField[]> {
  if (row.providerId !== 'apricot360') throw new AdapterUnavailableError(row.providerId);
  if (connectorMode(row) === 'local-demo') return APRICOT_DEMO_SCHEMA;

  const fields = await fetchFormFields(liveCredentials(row), liveSourceId(row));
  // `reference_tag` is the reviewed canonical key when an administrator has
  // mapped the field, and empty otherwise. Apricot's own tag is not trusted as
  // a canonical key: a renamed tag would silently map a value to the wrong
  // application field.
  return fields.map((field) => ({
    id: field.id,
    label: field.label,
    type: String(field.field_type_id),
    reference_tag: row.mappings[String(field.id)] ?? '',
  }));
}

export async function connectorRecord(
  tx: Tx,
  row: ConnectionRow,
  recordId: string,
): Promise<ApricotRecord | ApricotLiveRecord | null> {
  if (row.providerId !== 'apricot360') throw new AdapterUnavailableError(row.providerId);
  if (connectorMode(row) === 'live') return liveRecord(row, recordId);

  const households = await tx
    .select({ id: household.id, updatedAt: household.updatedAt })
    .from(household)
    .where(and(eq(household.connectionId, row.connectionId), eq(household.recordId, recordId)))
    .limit(1);

  const found = households[0];
  if (!found) return null;

  const facts = await currentFacts(tx, found.id);
  if (facts.size === 0) return null;

  // The newest fact observation is the record's modification time, which is
  // what the extension's freshness policy compares against.
  const modifiedAt = [...facts.values()].reduce(
    (latest, item) => (item.observedAt > latest ? item.observedAt : latest),
    new Date(0),
  );

  return toApricotRecord(recordId, factValues(facts), modifiedAt);
}

export function isKnownSourceId(row: ConnectionRow, sourceId: string | null): boolean {
  // The contract allows `formId` as a legacy alias for `sourceId`; both are
  // normalized by the caller. A connection pinned to a source only serves that
  // source, so a mismatch is a 404 rather than a silent cross-form read.
  const expected = row.sourceId ?? APRICOT_DEMO_SOURCE_ID;
  return sourceId === expected;
}

export class AdapterUnavailableError extends Error {
  constructor(providerId: string) {
    const provider = providerDefinition(providerId);
    super(
      `No authorized adapter for ${provider?.name ?? providerId}. An adapter requires an organization grant, a security review, and a data-processing agreement.`,
    );
    this.name = 'AdapterUnavailableError';
  }
}

export { ConnectorCredentialsError, ConnectorUpstreamError };

function liveCredentials(row: ConnectionRow) {
  return resolveCredentials(row.secretRef as string);
}

function liveSourceId(row: ConnectionRow): string {
  if (!row.sourceId) {
    throw new ConnectorCredentialsError(
      'A live connection must be pinned to one Apricot form (sourceId).',
    );
  }
  return row.sourceId;
}

/**
 * The raw provider record, as the connector contract requires, but only when it
 * belongs to the form this connection is pinned to. A record id from another
 * form is a 404, never a cross-form read.
 */
export async function liveRecord(
  row: ConnectionRow,
  recordId: string,
): Promise<ApricotLiveRecord | null> {
  const record = await fetchRecord(liveCredentials(row), recordId);
  if (!record) return null;
  if (String(record.data[0].attributes.form_id) !== liveSourceId(row)) return null;
  return record;
}

/**
 * A live record's values, keyed by canonical fact key, through the reviewed
 * mapping only. An unmapped field is dropped, not guessed.
 */
export function mapLiveRecord(
  row: ConnectionRow,
  record: ApricotLiveRecord,
): { values: Record<string, unknown>; unmappedCount: number; observedAt: Date } {
  const attributes = record.data[0].attributes;
  const values: Record<string, unknown> = {};
  let unmappedCount = 0;
  for (const [attribute, value] of Object.entries(attributes)) {
    const match = /^field_(\d+)$/.exec(attribute);
    if (!match) continue;
    const key = row.mappings[match[1]];
    if (!key) {
      unmappedCount++;
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    values[key] = value;
  }
  const observedAt = new Date(attributes.mod_time);
  return {
    values,
    unmappedCount,
    observedAt: Number.isNaN(observedAt.getTime()) ? new Date() : observedAt,
  };
}
