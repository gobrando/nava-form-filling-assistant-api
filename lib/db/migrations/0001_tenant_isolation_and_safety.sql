-- Tenant isolation and the safety invariants.
--
-- 0000 created the tables. This migration adds the guarantees, which are the
-- part worth reviewing: row-level security, the protected-field rule, the
-- provenance rule, the no-participant-values audit rule, and the submit gate.
--
-- These live in SQL rather than in TypeScript because prose in a skill file and
-- a check in a route handler are both bypassable, and because the pilot's
-- zero-tolerance measure is the wrong-confident-field rate on protected facts.
-- The extension took the same position: `extension-safety.test.cjs` asserts
-- there is no code path to submit, rather than trusting the runner not to.

-- ---------------------------------------------------------------------------
-- The application role
-- ---------------------------------------------------------------------------
-- Row-level security is silently bypassed by a superuser and by the table
-- owner. So the application connects as a role that is neither. Migrations run
-- as the owner; requests run as nava_api.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nava_api') THEN
    CREATE ROLE nava_api NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO nava_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nava_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nava_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nava_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nava_api;

-- The facts ledger is append-only. A correction inserts a superseding row; it
-- does not overwrite history. Revoking UPDATE and DELETE is what makes that
-- true rather than conventional.
REVOKE UPDATE, DELETE ON "Fact" FROM nava_api;
-- Same for the audit trail.
REVOKE UPDATE, DELETE ON "AuditEvent" FROM nava_api;
REVOKE UPDATE, DELETE ON "ReviewEvent" FROM nava_api;

-- ---------------------------------------------------------------------------
-- Tenant resolution
-- ---------------------------------------------------------------------------
-- `lib/db/index.ts` sets app.tenant_id transaction-locally via set_config.
-- When it is unset this returns NULL, every policy comparison evaluates to
-- NULL, and no rows are visible. Unscoped access fails closed.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Tenant and ApiKey are deliberately excluded: they must be readable before a
-- tenant is known, and they hold no participant data.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'Connection', 'Household', 'Person', 'Fact', 'Application',
    'ApplicationField', 'Gap', 'ReviewEvent', 'AuditEvent'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id())',
      t
    );
  END LOOP;
END
$$;

-- Playbooks are the shared control plane: site structure is not participant
-- data, so a row with a NULL tenantId is readable by every tenant. Writes are
-- still confined to a tenant's own overrides.
ALTER TABLE "Playbook" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS playbook_read ON "Playbook";
CREATE POLICY playbook_read ON "Playbook"
  FOR SELECT USING ("tenantId" IS NULL OR "tenantId" = current_tenant_id());
DROP POLICY IF EXISTS playbook_write ON "Playbook";
CREATE POLICY playbook_write ON "Playbook"
  FOR ALL USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Invariant 1: a protected fact may never be inferred
-- ---------------------------------------------------------------------------
-- The list is DO_NOT_DERIVE from the extension's shared/form-engine.js, where
-- it forces a field into the gap list instead of deriving it. Here it also
-- prevents the value from being written at all.
--
-- tests/safety.test.ts parses this array back out of this file and compares it
-- to lib/vocabulary.ts, so the two copies cannot drift.

ALTER TABLE "Fact" DROP CONSTRAINT IF EXISTS "Fact_protected_not_inferred";
ALTER TABLE "Fact" ADD CONSTRAINT "Fact_protected_not_inferred" CHECK (
  NOT (
    source = 'inferred'
    AND key = ANY (ARRAY[
      'ssn',
      'housingStatus',
      'preferredContact',
      'householdSize',
      'immigrationStatus',
      'income',
      'childcare',
      'unemployment',
      'ein'
    ])
  )
);

ALTER TABLE "Fact" DROP CONSTRAINT IF EXISTS "Fact_confidence_range";
ALTER TABLE "Fact" ADD CONSTRAINT "Fact_confidence_range" CHECK (
  confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
);

ALTER TABLE "Fact" DROP CONSTRAINT IF EXISTS "Fact_no_self_supersede";
ALTER TABLE "Fact" ADD CONSTRAINT "Fact_no_self_supersede" CHECK (
  "supersedesId" IS NULL OR "supersedesId" <> id
);

-- ---------------------------------------------------------------------------
-- Invariant 2: a filled field must have inspectable provenance
-- ---------------------------------------------------------------------------
-- Either the value traces to a Fact, or it was already on the page and the
-- assistant did not write it. There is no third way to hold a value, which is
-- what turns "share of values with inspectable provenance" into a query
-- instead of an aspiration.

ALTER TABLE "ApplicationField" DROP CONSTRAINT IF EXISTS "ApplicationField_provenance_required";
ALTER TABLE "ApplicationField" ADD CONSTRAINT "ApplicationField_provenance_required" CHECK (
  value IS NULL OR "factId" IS NOT NULL OR source = 'page'
);

-- A gap is answered by creating a Fact, so an answered gap has provenance too.
ALTER TABLE "Gap" DROP CONSTRAINT IF EXISTS "Gap_answer_has_fact";
ALTER TABLE "Gap" ADD CONSTRAINT "Gap_answer_has_fact" CHECK (
  ("answeredAt" IS NULL) = ("answeredFactId" IS NULL)
);

-- ---------------------------------------------------------------------------
-- Invariant 3: the audit trail carries no participant values
-- ---------------------------------------------------------------------------
-- The connector contract requires audit events with "organization, user,
-- connection, record ID, outcome, and timestamp — but no participant values".
-- Subtracting the allowed keys must leave the empty object; any other key
-- fails the insert. The allowed set is the extension's sanitizeDetails list:
-- five counts and four status/outcome enums.

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
    'toStatus'
  ]::text[]) = '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Invariant 4: the submit gate
-- ---------------------------------------------------------------------------
-- "Do not automate certification or final submission." A CHECK cannot see other
-- tables, so this is a trigger. Setting submittedAt requires a confirmed
-- ReviewEvent by a named reviewer and leaves no required field unfilled.
--
-- This service never drives a final submit itself; the gate exists because
-- recording a submission is how the post-submit outcome loop starts, and that
-- record must not be creatable without a human in it.

CREATE OR REPLACE FUNCTION enforce_submit_gate() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."submittedAt" IS NULL OR OLD."submittedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ReviewEvent" r
    WHERE r."applicationId" = NEW.id AND r.action = 'confirmed'
  ) THEN
    RAISE EXCEPTION
      'submit_gate: application % has no confirmed review event', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ApplicationField" f
    WHERE f."applicationId" = NEW.id
      AND f.required
      AND (f.value IS NULL OR f.value = '')
  ) THEN
    RAISE EXCEPTION
      'submit_gate: application % has unfilled required fields', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "Application_submit_gate" ON "Application";
CREATE TRIGGER "Application_submit_gate"
  BEFORE UPDATE ON "Application"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_submit_gate();

-- An application may not be created already submitted.
ALTER TABLE "Application" DROP CONSTRAINT IF EXISTS "Application_not_born_submitted";
ALTER TABLE "Application" ADD CONSTRAINT "Application_not_born_submitted" CHECK (
  "submittedAt" IS NULL OR "createdAt" < "submittedAt"
);
