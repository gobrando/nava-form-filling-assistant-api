import {
  APPLICATION_STATUSES,
  AUDIT_EVENT_TYPES,
  CHECKPOINT_KINDS,
  EXECUTION_MODES,
  FACT_SOURCES,
  GAP_KINDS,
  INPUT_TYPES,
  INTERVENTION_REASONS,
} from '@/lib/vocabulary';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The benefits case graph and work queue.
 *
 * Table names are PascalCase and columns camelCase, matching labs-asp's
 * `client/lib/db/schema.ts`. Every enum is derived from `lib/vocabulary.ts` so
 * the database cannot drift from the extension's state machine.
 *
 * CHECK constraints and row-level security live in
 * `lib/db/migrations/0000_init.sql`, not here — Drizzle 0.34 (the version
 * labs-asp pins) can express neither. The safety invariants are therefore
 * database-enforced but not visible in this file; `tests/safety.test.ts`
 * asserts each one against a live database so the split cannot silently rot.
 */

export const factSourceEnum = pgEnum('fact_source', FACT_SOURCES);
export const applicationStatusEnum = pgEnum('application_status', APPLICATION_STATUSES);
export const checkpointKindEnum = pgEnum('checkpoint_kind', CHECKPOINT_KINDS);
export const auditEventTypeEnum = pgEnum('audit_event_type', AUDIT_EVENT_TYPES);
export const executionModeEnum = pgEnum('execution_mode', EXECUTION_MODES);
export const interventionReasonEnum = pgEnum('intervention_reason', INTERVENTION_REASONS);
export const gapKindEnum = pgEnum('gap_kind', GAP_KINDS);
export const inputTypeEnum = pgEnum('input_type', INPUT_TYPES);
export const personRoleEnum = pgEnum('person_role', ['applicant', 'member']);
export const reviewActionEnum = pgEnum('review_action', [
  'viewed',
  'edited',
  'confirmed',
  'submitted',
]);

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const tenant = pgTable('Tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabledAt', { withTimezone: true }),
});

export const apiKey = pgTable('ApiKey', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenantId')
    .notNull()
    .references(() => tenant.id, { onDelete: 'cascade' }),
  /** Public half of the credential; the lookup key. Never secret. */
  keyId: text('keyId').notNull().unique(),
  /** HMAC-SHA256 of the secret half, peppered with API_KEY_PEPPER. */
  secretHash: text('secretHash').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  label: text('label'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
});

/**
 * An authorized link to one organization's system of record.
 *
 * `connectionId` is the opaque identifier the extension stores and sends. There
 * are deliberately no credential columns: the connector contract requires
 * provider secrets to stay in a server-side secret manager, so this row holds
 * only `secretRef`, a pointer for the adapter to resolve at call time.
 */
export const connection = pgTable(
  'Connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    connectionId: text('connectionId').notNull(),
    providerId: text('providerId').notNull(),
    organizationName: text('organizationName').notNull(),
    sourceId: text('sourceId'),
    /** Secret Manager resource name. Resolved by the adapter; never returned. */
    secretRef: text('secretRef'),
    mappingVersion: integer('mappingVersion').notNull().default(1),
    maxAgeDays: integer('maxAgeDays').notNull().default(30),
    /** Reviewed provider-field -> canonical-fact-key mapping. */
    mappings: jsonb('mappings').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revokedAt', { withTimezone: true }),
  },
  (table) => ({
    uniquePerTenant: unique('Connection_tenantId_connectionId_key').on(
      table.tenantId,
      table.connectionId,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Case graph
// ---------------------------------------------------------------------------

/**
 * A household, keyed by the partner's own identifier.
 *
 * `externalRef` is intentionally the partner's ID rather than an Apricot record
 * ID. Gating a session on one system's identifier stops caseworkers whose client
 * is identified elsewhere (a Differential Response or DPSS ID) from starting. `recordId` and
 * `connectionId` are optional annotations, not the key.
 */
export const household = pgTable(
  'Household',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    externalRef: text('externalRef').notNull(),
    connectionId: text('connectionId'),
    recordId: text('recordId'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniquePerTenant: unique('Household_tenantId_externalRef_key').on(
      table.tenantId,
      table.externalRef,
    ),
  }),
);

export const person = pgTable(
  'Person',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    householdId: uuid('householdId')
      .notNull()
      .references(() => household.id, { onDelete: 'cascade' }),
    role: personRoleEnum('role').notNull().default('member'),
    ordinal: integer('ordinal').notNull().default(0),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byHousehold: index('Person_householdId_idx').on(table.householdId),
  }),
);

/**
 * The facts ledger — append-only, never updated in place.
 *
 * A correction inserts a new row pointing at the old one through
 * `supersedesId`. This is what makes provenance inspectable after the fact: in
 * labs-asp, `source` is a string on an ephemeral tool call and the household
 * lives only in a synthetic working-memory message, so "what did we believe,
 * when, and on whose word" is unanswerable. Here it is a query.
 *
 * Database-enforced (see 0000_init.sql):
 *   - a DO_NOT_DERIVE key may never carry source 'inferred'
 *   - confidence, when present, is in [0, 1]
 */
export const fact = pgTable(
  'Fact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    householdId: uuid('householdId')
      .notNull()
      .references(() => household.id, { onDelete: 'cascade' }),
    personId: uuid('personId').references(() => person.id, { onDelete: 'cascade' }),
    /** A canonical key from `FIELD_LABELS`. */
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    source: factSourceEnum('source').notNull(),
    /** Human-readable justification: which message, which document, which transform. */
    sourceDetail: text('sourceDetail'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    observedAt: timestamp('observedAt', { withTimezone: true }).notNull().defaultNow(),
    /** After this, the fact is stale and must be reconfirmed before reuse. */
    expiresAt: timestamp('expiresAt', { withTimezone: true }),
    consentScope: text('consentScope'),
    confirmedBy: text('confirmedBy'),
    confirmedAt: timestamp('confirmedAt', { withTimezone: true }),
    supersedesId: uuid('supersedesId'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byHouseholdKey: index('Fact_householdId_key_idx').on(table.householdId, table.key),
    bySupersedes: index('Fact_supersedesId_idx').on(table.supersedesId),
  }),
);

// ---------------------------------------------------------------------------
// Applications and the work queue
// ---------------------------------------------------------------------------

export const application = pgTable(
  'Application',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    householdId: uuid('householdId')
      .notNull()
      .references(() => household.id, { onDelete: 'cascade' }),
    /** One run can cover several programs; BenefitsCal serves three. */
    programIds: text('programIds').array().notNull(),
    workflowId: text('workflowId').notNull(),
    name: text('name').notNull(),
    status: applicationStatusEnum('status').notNull().default('not_started'),

    checkpointKind: checkpointKindEnum('checkpointKind'),
    checkpointLabel: text('checkpointLabel'),
    checkpointAt: timestamp('checkpointAt', { withTimezone: true }),

    playbookId: uuid('playbookId'),
    playbookVersion: integer('playbookVersion'),
    executionMode: executionModeEnum('executionMode'),
    interventionReason: interventionReasonEnum('interventionReason'),

    /** Eve session handles for the cold path. Continuity across gap answers. */
    eveSessionId: text('eveSessionId'),
    eveContinuationToken: text('eveContinuationToken'),

    /** Resume point, mirroring the extension's `resumePoint`. */
    location: text('location'),
    locationHash: text('locationHash'),
    pageSignatureHash: text('pageSignatureHash'),

    progress: integer('progress').notNull().default(0),
    completedPages: integer('completedPages').notNull().default(0),

    ownerPrincipal: text('ownerPrincipal'),
    leaseHolder: text('leaseHolder'),
    leaseAcquiredAt: timestamp('leaseAcquiredAt', { withTimezone: true }),
    leaseExpiresAt: timestamp('leaseExpiresAt', { withTimezone: true }),
    handoffToPrincipal: text('handoffToPrincipal'),
    handoffCreatedAt: timestamp('handoffCreatedAt', { withTimezone: true }),
    handoffAcceptedAt: timestamp('handoffAcceptedAt', { withTimezone: true }),

    /** Cost instrumentation. The unit of cost is the turn, so count them. */
    costUsd: numeric('costUsd', { precision: 10, scale: 6 }).notNull().default('0'),
    toolCallCount: integer('toolCallCount').notNull().default(0),
    modelTurnCount: integer('modelTurnCount').notNull().default(0),

    submittedAt: timestamp('submittedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byHousehold: index('Application_householdId_idx').on(table.householdId),
    byTenantStatus: index('Application_tenantId_status_idx').on(table.tenantId, table.status),
  }),
);

/**
 * One row per field observed on the application, in form order.
 *
 * Database-enforced: a row carrying a value must either link to the `Fact` it
 * came from or declare `source = 'page'` (the value was already on the page and
 * the assistant did not write it). There is no third way to hold a value, which
 * is what makes the provenance share a real measure rather than an aspiration.
 */
export const applicationField = pgTable(
  'ApplicationField',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    applicationId: uuid('applicationId')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    /** DOM-level identifier from the page. */
    fieldKey: text('fieldKey').notNull(),
    label: text('label').notNull(),
    /** Canonical fact key this control serves, when one was classified. */
    purpose: text('purpose'),
    value: text('value'),
    inputType: inputTypeEnum('inputType').notNull().default('text'),
    options: text('options').array(),
    required: boolean('required').notNull().default(false),
    sensitive: boolean('sensitive').notNull().default(false),
    factId: uuid('factId').references(() => fact.id, { onDelete: 'restrict' }),
    source: factSourceEnum('source'),
    sourceDetail: text('sourceDetail'),
    /** Set by the Phase 4 readback. Null means the write was never confirmed. */
    verifiedAt: timestamp('verifiedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byApplication: index('ApplicationField_applicationId_ordinal_idx').on(
      table.applicationId,
      table.ordinal,
    ),
    uniquePerApplication: unique('ApplicationField_applicationId_fieldKey_key').on(
      table.applicationId,
      table.fieldKey,
    ),
  }),
);

/**
 * A BLOCKED report from a fill agent, or a field the form engine refused to
 * derive. This is the API's substitute for the human the orchestrator would
 * otherwise ask.
 */
export const gap = pgTable(
  'Gap',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    applicationId: uuid('applicationId')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    fieldKey: text('fieldKey').notNull(),
    label: text('label').notNull(),
    purpose: text('purpose'),
    question: text('question').notNull(),
    kind: gapKindEnum('kind').notNull(),
    required: boolean('required').notNull().default(false),
    inputType: inputTypeEnum('inputType').notNull().default('text'),
    options: text('options').array(),
    /** Set when answered. The answer is a Fact, so the answer has provenance too. */
    answeredFactId: uuid('answeredFactId').references(() => fact.id, { onDelete: 'restrict' }),
    answeredAt: timestamp('answeredAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byApplication: index('Gap_applicationId_ordinal_idx').on(table.applicationId, table.ordinal),
    uniquePerApplication: unique('Gap_applicationId_fieldKey_key').on(
      table.applicationId,
      table.fieldKey,
    ),
  }),
);

/** Human review actions. A `confirmed` row is what unlocks the submit gate. */
export const reviewEvent = pgTable(
  'ReviewEvent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    applicationId: uuid('applicationId')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    reviewerPrincipal: text('reviewerPrincipal').notNull(),
    action: reviewActionEnum('action').notNull(),
    fieldKey: text('fieldKey'),
    /** Free-text attestation from the reviewer. Not a participant value. */
    attestation: text('attestation'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byApplication: index('ReviewEvent_applicationId_idx').on(table.applicationId),
  }),
);

/**
 * Append-only audit trail, exported as `nava.form-filling.audit.v1`.
 *
 * The connector contract requires audit events carrying "organization, user,
 * connection, record ID, outcome, and timestamp — but no participant values".
 * `details` is therefore restricted by a CHECK constraint to the count and enum
 * keys the extension's `sanitizeDetails` allows; any other key fails the
 * insert. That is the difference between a rule and a guarantee.
 */
export const auditEvent = pgTable(
  'AuditEvent',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenantId')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    applicationId: uuid('applicationId').references(() => application.id, { onDelete: 'set null' }),
    type: auditEventTypeEnum('type').notNull(),
    principalId: text('principalId').notNull(),
    connectionId: text('connectionId'),
    recordId: text('recordId'),
    outcome: text('outcome'),
    details: jsonb('details').$type<Record<string, string | number>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byTenantAt: index('AuditEvent_tenantId_at_idx').on(table.tenantId, table.at),
    byApplication: index('AuditEvent_applicationId_idx').on(table.applicationId),
  }),
);

// ---------------------------------------------------------------------------
// Playbooks — the shared, PII-free control plane
// ---------------------------------------------------------------------------

/**
 * A site playbook: freshness probes, a field map, and safe-advance rules.
 *
 * These are hardcoded in the extension bundle today (`PLAYBOOKS` in
 * `content/form-agent.js`), which means a BenefitsCal change requires a Chrome
 * Web Store release. Serving them makes a site change a data update.
 *
 * `tenantId` is nullable on purpose: a null row is shared control-plane
 * knowledge, visible to every tenant. Site structure is not participant data.
 * A non-null row is a tenant's private override.
 */
export const playbook = pgTable(
  'Playbook',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenantId').references(() => tenant.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    programIds: text('programIds').array().notNull().default([]),
    version: integer('version').notNull().default(1),
    name: text('name').notNull(),
    /** Selectors that must all resolve. A miss means the site changed. */
    probes: text('probes').array().notNull().default([]),
    fieldMap: jsonb('fieldMap')
      .$type<
        {
          fieldKey: string;
          purpose: string | null;
          inputType: string;
          mask?: string;
          method?: string;
          /** The form blocks submission without it. Drives the submit gate. */
          required?: boolean;
        }[]
      >()
      .notNull()
      .default([]),
    safeAdvanceRules: jsonb('safeAdvanceRules')
      .$type<{ labels: string[]; path?: string }[]>()
      .notNull()
      .default([]),
    autoAdvance: boolean('autoAdvance').notNull().default(false),
    note: text('note'),
    /** Set by a failed probe. The scribe clears it after a repair. */
    staleAt: timestamp('staleAt', { withTimezone: true }),
    staleReason: text('staleReason'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byDomain: index('Playbook_domain_version_idx').on(table.domain, table.version),
  }),
);
