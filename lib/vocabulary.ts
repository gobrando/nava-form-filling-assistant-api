import { z } from 'zod';

/**
 * The shared vocabulary between this service and the Chrome extension.
 *
 * Every enum below is ported verbatim from the extension so that the two halves
 * describe the same state machine. The extension is the consumer, so where its
 * vocabulary conflicts with labs-asp's, the extension wins and labs-asp gets a
 * mapping (see `toLabsAspSource`).
 *
 * Sources:
 *   shared/form-engine.js       -> FIELD_LABELS, DO_NOT_DERIVE
 *   shared/work-queue-engine.js -> APPLICATION_STATUSES, CHECKPOINT_KINDS,
 *                                  AUDIT_EVENT_TYPES, RESUME_OUTCOMES,
 *                                  AUDIT_SCHEMA, lease bounds
 *   shared/program-catalog.js   -> PROGRAMS
 *   shared/connector-engine.js  -> PROVIDER_CATALOG, FRESHNESS
 *
 * Changing one of these is a breaking change for the extension. Do not edit an
 * enum here without shipping the matching extension release.
 */

// ---------------------------------------------------------------------------
// Canonical field vocabulary
// ---------------------------------------------------------------------------

/**
 * The canonical fact keys. These are the `reference_tag` values the connector
 * contract returns and the `purpose` values the extension's form engine
 * classifies fields into, so a `Fact.key` written here is consumable by
 * `form-engine.js` with no translation.
 */
export const FIELD_LABELS = {
  firstName: 'First name',
  middleName: 'Middle name',
  lastName: 'Last name',
  fullName: 'Full name',
  dateOfBirth: 'Date of birth',
  ssn: 'Social Security Number',
  email: 'Email',
  phone: 'Phone',
  addressLine1: 'Street address',
  addressLine2: 'Apartment or unit',
  city: 'City',
  state: 'State',
  county: 'County',
  postalCode: 'ZIP code',
  country: 'Country',
  gender: 'Gender',
  ethnicity: 'Ethnicity',
  primaryLanguage: 'Primary language',
  maritalStatus: 'Marital status',
  specialNeeds: 'Special needs',
  farmWorker: 'Farm worker',
  pregnant: 'Pregnancy',
  preferredContact: 'Preferred contact method',
  housingStatus: 'Housing status',
  householdSize: 'Household size',
  immigrationStatus: 'Immigration status',
  income: 'Income',
  childcare: 'Childcare',
  unemployment: 'Unemployment benefits',
  mailingDifferent: 'Mailing address',
  recordId: 'Record ID',
  businessName: 'Business legal name',
  dba: 'Doing business as',
  ein: 'Employer Identification Number',
  businessType: 'Business type',
  businessAddressLine1: 'Business street address',
  businessAddressLine2: 'Business suite or unit',
  businessCity: 'Business city',
  businessState: 'Business state',
  businessPostalCode: 'Business ZIP code',
  businessPhone: 'Business phone',
  businessEmail: 'Business email',
  incorporationDate: 'Formation date',
  stateOfFormation: 'State of formation',
  applyCalFresh: 'Apply for CalFresh',
  applyMediCal: 'Apply for Medi-Cal',
  applyCalWORKs: 'Apply for CalWORKs',
} as const satisfies Record<string, string>;

export type FieldKey = keyof typeof FIELD_LABELS;

export const FIELD_KEYS = Object.keys(FIELD_LABELS) as FieldKey[];

export function labelFor(key: string): string {
  return (FIELD_LABELS as Record<string, string>)[key] ?? key;
}

/**
 * Facts that may never be inferred.
 *
 * In the extension this is a `Set` consulted by `buildAnalysis` to force a
 * field into the gap list rather than deriving it. Here it additionally backs a
 * database CHECK constraint and a test, because the pilot's zero-tolerance
 * measure is the wrong-confident-field rate on protected facts, and prose in a
 * skill file cannot enforce that.
 */
export const DO_NOT_DERIVE = new Set<string>([
  'ssn',
  'housingStatus',
  'preferredContact',
  'householdSize',
  'immigrationStatus',
  'income',
  'childcare',
  'unemployment',
  'ein',
]);

export function isProtectedField(key: string): boolean {
  return DO_NOT_DERIVE.has(key);
}

/** Facts whose values must be masked in any human-readable projection. */
export const SENSITIVE_FIELDS = new Set<string>(['ssn', 'ein']);

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Canonical fact sources — the superset of both clients' vocabularies.
 *
 *   connector   organization's system of record, via an authorized adapter
 *   document    extracted from an uploaded document (OCR / parser)
 *   caseworker  typed by a caseworker this session
 *   participant supplied by the participant directly
 *   page        already present in the form; the assistant did not write it
 *   inferred    reasoned from another fact — forbidden for DO_NOT_DERIVE keys
 */
export const FACT_SOURCES = [
  'connector',
  'document',
  'caseworker',
  'participant',
  'page',
  'inferred',
] as const;

export const factSourceSchema = z.enum(FACT_SOURCES);
export type FactSource = z.infer<typeof factSourceSchema>;

/**
 * The extension's assignment sources. `changed` means the value came from the
 * record but was reformatted to fit the control (e.g. "California" -> "CA"), so
 * it maps to `connector` with the transform recorded in `sourceDetail`.
 */
export const EXTENSION_SOURCES = ['page', 'record', 'changed'] as const;
export type ExtensionSource = (typeof EXTENSION_SOURCES)[number];

export function fromExtensionSource(source: ExtensionSource): FactSource {
  switch (source) {
    case 'page':
      return 'page';
    case 'record':
    case 'changed':
      return 'connector';
  }
}

/** labs-asp's `formSummary` source enum. `missing` has no fact, so it is absent here. */
export type LabsAspSource = 'database' | 'caseworker' | 'inferred' | 'missing';

export function toLabsAspSource(source: FactSource): LabsAspSource {
  switch (source) {
    case 'connector':
    case 'document':
      return 'database';
    case 'caseworker':
    case 'participant':
    case 'page':
      return 'caseworker';
    case 'inferred':
      return 'inferred';
  }
}

// ---------------------------------------------------------------------------
// Work queue — ported from shared/work-queue-engine.js
// ---------------------------------------------------------------------------

export const APPLICATION_STATUSES = [
  'not_started',
  'ready_to_fill',
  'needs_attention',
  'no_form',
  'paused',
  'handoff_pending',
  'ready_for_review',
  'source_expired',
] as const;

export const applicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

export const CHECKPOINT_KINDS = [
  'tab_closed',
  'source_expired',
  'source_stale',
  'page_changed',
  'handoff',
  'voluntary_pause',
] as const;

export const checkpointKindSchema = z.enum(CHECKPOINT_KINDS);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

export const AUDIT_EVENT_TYPES = [
  'application_added',
  'source_loaded',
  'questions_required',
  'fill_started',
  'page_verified',
  'safe_advance',
  'checkpoint_reached',
  'resume_verified',
  'resume_rejected',
  'handoff_created',
  'handoff_accepted',
  'review_reached',
  'tab_closed',
  'source_reloaded',
  'session_ended',
  'audit_exported',
  'outcome_recorded',
] as const;

export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

export const RESUME_OUTCOMES = [
  'verified',
  'source_expired',
  'source_stale',
  'tab_closed',
  'location_changed',
  'page_changed',
  'handoff_pending',
] as const;

export const resumeOutcomeSchema = z.enum(RESUME_OUTCOMES);
export type ResumeOutcome = z.infer<typeof resumeOutcomeSchema>;

/** The wire format of `GET /v1/audit/export`, matching `exportAudit`. */
export const AUDIT_SCHEMA = 'nava.form-filling.audit.v1';

/** Lease bounds from `acquireLease`: clamped to [5s, 10min], default 2min. */
export const LEASE_MIN_MS = 5_000;
export const LEASE_MAX_MS = 10 * 60 * 1000;
export const LEASE_DEFAULT_MS = 2 * 60 * 1000;

/**
 * Detail keys the extension's `sanitizeDetails` allows through onto an audit
 * event. Anything not listed is dropped, which is how "no participant values in
 * the audit" is kept true by construction rather than by review.
 */
export const AUDIT_COUNT_KEYS = new Set<string>([
  'fieldCount',
  'gapCount',
  'verifiedCount',
  'blockedCount',
  'pageCount',
]);

/**
 * What happened after a human submitted. These are case statuses, not form
 * statuses: the application state machine above stops at review.
 */
export const OUTCOME_STATUSES = [
  'received',
  'pending_documents',
  'approved',
  'denied',
  'benefit_received',
] as const;

export const outcomeStatusSchema = z.enum(OUTCOME_STATUSES);
export type OutcomeStatus = z.infer<typeof outcomeStatusSchema>;

/**
 * Why an outcome needs a human explanation. A code, never a free-text dump of
 * the denial letter, so the audit trail can name the reason without storing
 * whatever a county pasted into it.
 */
export const OUTCOME_REASON_CODES = [
  'missing_documents',
  'ineligible_income',
  'ineligible_residency',
  'ineligible_household',
  'duplicate_application',
  'withdrawn',
  'identity_not_verified',
  'other',
] as const;

export const outcomeReasonCodeSchema = z.enum(OUTCOME_REASON_CODES);
export type OutcomeReasonCode = z.infer<typeof outcomeReasonCodeSchema>;

/** Legal moves. `submitted` is the start state, recorded by the submit gate. */
export const OUTCOME_TRANSITIONS: Record<'submitted' | OutcomeStatus, readonly OutcomeStatus[]> = {
  submitted: ['received', 'pending_documents', 'approved', 'denied'],
  received: ['pending_documents', 'approved', 'denied'],
  pending_documents: ['received', 'approved', 'denied'],
  approved: ['pending_documents', 'benefit_received'],
  denied: [],
  benefit_received: [],
};

export const AUDIT_ENUM_KEYS = {
  checkpointKind: new Set<string>(CHECKPOINT_KINDS),
  resumeOutcome: new Set<string>(RESUME_OUTCOMES),
  fromStatus: new Set<string>(APPLICATION_STATUSES),
  toStatus: new Set<string>(APPLICATION_STATUSES),
  outcomeStatus: new Set<string>(OUTCOME_STATUSES),
} as const;

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/**
 * `required` -> the form blocks submission without it.
 * `decision`  -> a choice only a human should make: a select, a grouped
 *                control, or any DO_NOT_DERIVE key.
 */
export const GAP_KINDS = ['required', 'decision'] as const;
export const gapKindSchema = z.enum(GAP_KINDS);
export type GapKind = z.infer<typeof gapKindSchema>;

export const INPUT_TYPES = ['text', 'select', 'radio', 'checkbox', 'date', 'number'] as const;
export const inputTypeSchema = z.enum(INPUT_TYPES);
export type InputType = z.infer<typeof inputTypeSchema>;

// ---------------------------------------------------------------------------
// Execution mode — the cost instrument
// ---------------------------------------------------------------------------

/**
 * `script` -> every freshness probe passed; deterministic replay, no model.
 * `model`  -> cold site or a failed probe; the Eve agent drove the run.
 * `hybrid` -> started as a script and fell back mid-run.
 *
 * Recorded per application so cost per verified packet is attributable to a
 * program and a playbook version. The unit of cost is the turn, not the token.
 */
export const EXECUTION_MODES = ['script', 'model', 'hybrid'] as const;
export const executionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

/** Why a run stopped short of a review-ready packet. */
export const INTERVENTION_REASONS = [
  'missing_data',
  'site_drift',
  'authentication',
  'captcha',
  'unsupported_control',
  'deliberate_review',
] as const;

export const interventionReasonSchema = z.enum(INTERVENTION_REASONS);
export type InterventionReason = z.infer<typeof interventionReasonSchema>;

// ---------------------------------------------------------------------------
// Programs — ported from shared/program-catalog.js
// ---------------------------------------------------------------------------

export type ProgramDefinition = {
  id: string;
  name: string;
  provider: string;
  workflowId: string;
  url: string;
  allowedOrigins: string[];
  allowedPathPrefixes: string[];
};

export const PROGRAMS: ProgramDefinition[] = [
  {
    id: 'calfresh',
    name: 'CalFresh',
    provider: 'BenefitsCal',
    workflowId: 'benefitscal',
    url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
    allowedOrigins: ['https://benefitscal.com'],
    allowedPathPrefixes: ['/ApplyForBenefits/'],
  },
  {
    id: 'medical',
    name: 'Medi-Cal',
    provider: 'BenefitsCal',
    workflowId: 'benefitscal',
    url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
    allowedOrigins: ['https://benefitscal.com'],
    allowedPathPrefixes: ['/ApplyForBenefits/'],
  },
  {
    id: 'wic',
    name: 'WIC',
    provider: 'Riverside University Health System',
    workflowId: 'riverside-wic',
    url: 'https://www.ruhealth.org/appointments/apply-4-wic-form',
    allowedOrigins: ['https://www.ruhealth.org', 'https://ruhealth.org'],
    allowedPathPrefixes: ['/appointments/apply-4-wic-form'],
  },
  {
    id: 'calworks',
    name: 'CalWORKs',
    provider: 'BenefitsCal',
    workflowId: 'benefitscal',
    url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
    allowedOrigins: ['https://benefitscal.com'],
    allowedPathPrefixes: ['/ApplyForBenefits/'],
  },
  {
    id: 'ihss',
    name: 'IHSS',
    provider: 'Riverside County',
    workflowId: 'riverside-ihss',
    url: 'https://riversideihss.org/IntakeApp',
    allowedOrigins: ['https://riversideihss.org'],
    allowedPathPrefixes: ['/IntakeApp'],
  },
];

export function programDefinition(id: string): ProgramDefinition | null {
  return PROGRAMS.find((program) => program.id === id) ?? null;
}

/**
 * BenefitsCal serves CalFresh, Medi-Cal, and CalWORKs from one application, so
 * selecting several of them is one run, not three. Mirrors `planWorkflows`.
 */
export function planWorkflows(selectedIds: string[]): {
  workflowId: string;
  programIds: string[];
  name: string;
  provider: string;
  url: string;
  allowedOrigins: string[];
  allowedPathPrefixes: string[];
}[] {
  const groups = new Map<string, ProgramDefinition[]>();
  for (const id of new Set(selectedIds)) {
    const program = programDefinition(id);
    if (!program) continue;
    const group = groups.get(program.workflowId) ?? [];
    group.push(program);
    groups.set(program.workflowId, group);
  }

  return [...groups.entries()].map(([workflowId, programs]) => ({
    workflowId,
    programIds: programs.map((program) => program.id),
    name:
      workflowId === 'benefitscal' && programs.length > 1
        ? `BenefitsCal — ${joinedNames(programs)}`
        : programs[0].name,
    provider: programs[0].provider,
    url: programs[0].url,
    allowedOrigins: [...new Set(programs.flatMap((program) => program.allowedOrigins))],
    allowedPathPrefixes: [...new Set(programs.flatMap((program) => program.allowedPathPrefixes))],
  }));
}

function joinedNames(programs: ProgramDefinition[]): string {
  const names = programs.map((program) => program.name);
  if (names.length < 2) return names[0] ?? 'Application';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

// ---------------------------------------------------------------------------
// Providers — ported from shared/connector-engine.js
// ---------------------------------------------------------------------------

export type ProviderDefinition = {
  id: string;
  name: string;
  category: string;
  sourceLabel: string;
  readiness: 'demo-tested' | 'adapter-required';
};

export const PROVIDER_CATALOG: ProviderDefinition[] = [
  {
    id: 'apricot360',
    name: 'Bonterra Apricot 360',
    category: 'Case management',
    sourceLabel: 'Apricot form ID',
    readiness: 'demo-tested',
  },
  {
    id: 'salesforce_nonprofit',
    name: 'Salesforce / Agentforce Nonprofit',
    category: 'CRM and case management',
    sourceLabel: 'Object or dataset key',
    readiness: 'adapter-required',
  },
  {
    id: 'bitfocus_clarity',
    name: 'Bitfocus Clarity Human Services',
    category: 'HMIS',
    sourceLabel: 'Client resource key',
    readiness: 'adapter-required',
  },
  {
    id: 'wellsky_community_services',
    name: 'WellSky Community Services / ServicePoint',
    category: 'HMIS',
    sourceLabel: 'Client resource key',
    readiness: 'adapter-required',
  },
  {
    id: 'eccovia_clienttrack',
    name: 'Eccovia ClientTrack',
    category: 'HMIS and case management',
    sourceLabel: 'Client resource key',
    readiness: 'adapter-required',
  },
  {
    id: 'caseworthy',
    name: 'CaseWorthy',
    category: 'HMIS and case management',
    sourceLabel: 'Form or resource key',
    readiness: 'adapter-required',
  },
  {
    id: 'foothold_awards',
    name: 'Foothold AWARDS',
    category: 'Human services and EHR',
    sourceLabel: 'Client resource key',
    readiness: 'adapter-required',
  },
  {
    id: 'bonterra_eto',
    name: 'Bonterra ETO',
    category: 'Impact and case management',
    sourceLabel: 'TouchPoint or resource key',
    readiness: 'adapter-required',
  },
];

export function providerDefinition(id: string): ProviderDefinition | null {
  return PROVIDER_CATALOG.find((provider) => provider.id === id) ?? null;
}

/** Freshness verdicts from `connector-engine.js`. */
export const FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export const freshnessSchema = z.enum(FRESHNESS);
export type Freshness = z.infer<typeof freshnessSchema>;

export const DEFAULT_MAX_AGE_DAYS = 30;
