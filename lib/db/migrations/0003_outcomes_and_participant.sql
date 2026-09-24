-- Post-submit outcomes, and a token a participant can open without an API key.
--
-- Outcomes are append-only. A denial or a document request carries a reason
-- code, not the letter itself. The follow-up sentence is stored for the
-- participant page and is not an audit detail.
--
-- ParticipantShare is excluded from row-level security for the same reason
-- ApiKey is: the caller presents the token before a tenant is known. The row
-- holds a hash and identifiers, never a participant value.

ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'outcome_recorded';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outcome_status') THEN
    CREATE TYPE outcome_status AS ENUM (
      'received',
      'pending_documents',
      'approved',
      'denied',
      'benefit_received'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "ApplicationOutcome" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" uuid NOT NULL REFERENCES "Tenant"(id) ON DELETE CASCADE,
  "applicationId" uuid NOT NULL REFERENCES "Application"(id) ON DELETE CASCADE,
  status outcome_status NOT NULL,
  "reasonCode" text,
  "followUp" text,
  "recordedBy" text NOT NULL,
  "recordedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ApplicationOutcome_reason_when_needed" CHECK (
    status NOT IN ('denied', 'pending_documents') OR "reasonCode" IS NOT NULL
  ),
  CONSTRAINT "ApplicationOutcome_reason_known" CHECK (
    "reasonCode" IS NULL OR "reasonCode" IN (
      'missing_documents',
      'ineligible_income',
      'ineligible_residency',
      'ineligible_household',
      'duplicate_application',
      'withdrawn',
      'identity_not_verified',
      'other'
    )
  ),
  CONSTRAINT "ApplicationOutcome_follow_up_length" CHECK (
    "followUp" IS NULL OR char_length("followUp") <= 280
  )
);

CREATE INDEX IF NOT EXISTS "ApplicationOutcome_applicationId_recordedAt_idx"
  ON "ApplicationOutcome" ("applicationId", "recordedAt");

ALTER TABLE "ApplicationOutcome" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ApplicationOutcome";
CREATE POLICY tenant_isolation ON "ApplicationOutcome"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

REVOKE UPDATE, DELETE ON "ApplicationOutcome" FROM nava_api;

CREATE TABLE IF NOT EXISTS "ParticipantShare" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" uuid NOT NULL REFERENCES "Tenant"(id) ON DELETE CASCADE,
  "applicationId" uuid NOT NULL REFERENCES "Application"(id) ON DELETE CASCADE,
  "householdId" uuid NOT NULL REFERENCES "Household"(id) ON DELETE CASCADE,
  "tokenHash" text NOT NULL UNIQUE,
  "createdBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz
);

-- Keep the audit allowlist in step with AUDIT_ENUM_KEYS. outcomeStatus is a
-- case status, not a participant value.
ALTER TABLE "AuditEvent" DROP CONSTRAINT IF EXISTS "AuditEvent_details_allowlist";
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_details_allowlist" CHECK (
  (details - ARRAY[
    'fieldCount',
    'gapCount',
    'verifiedCount',
    'blockedCount',
    'pageCount',
    'checkpointKind',
    'resumeOutcome',
    'fromStatus',
    'toStatus',
    'outcomeStatus'
  ]::text[]) = '{}'::jsonb
);
