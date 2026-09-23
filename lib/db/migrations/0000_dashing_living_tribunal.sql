DO $$ BEGIN
 CREATE TYPE "public"."application_status" AS ENUM('not_started', 'ready_to_fill', 'needs_attention', 'no_form', 'paused', 'handoff_pending', 'ready_for_review', 'source_expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."audit_event_type" AS ENUM('application_added', 'source_loaded', 'questions_required', 'fill_started', 'page_verified', 'safe_advance', 'checkpoint_reached', 'resume_verified', 'resume_rejected', 'handoff_created', 'handoff_accepted', 'review_reached', 'tab_closed', 'source_reloaded', 'session_ended', 'audit_exported');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."checkpoint_kind" AS ENUM('tab_closed', 'source_expired', 'source_stale', 'page_changed', 'handoff', 'voluntary_pause');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."execution_mode" AS ENUM('script', 'model', 'hybrid');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."fact_source" AS ENUM('connector', 'document', 'caseworker', 'participant', 'page', 'inferred');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."gap_kind" AS ENUM('required', 'decision');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."input_type" AS ENUM('text', 'select', 'radio', 'checkbox', 'date', 'number');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."intervention_reason" AS ENUM('missing_data', 'site_drift', 'authentication', 'captcha', 'unsupported_control', 'deliberate_review');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."person_role" AS ENUM('applicant', 'member');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."review_action" AS ENUM('viewed', 'edited', 'confirmed', 'submitted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ApiKey" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"keyId" text NOT NULL,
	"secretHash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"label" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone,
	CONSTRAINT "ApiKey_keyId_unique" UNIQUE("keyId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"householdId" uuid NOT NULL,
	"programIds" text[] NOT NULL,
	"workflowId" text NOT NULL,
	"name" text NOT NULL,
	"status" "application_status" DEFAULT 'not_started' NOT NULL,
	"checkpointKind" "checkpoint_kind",
	"checkpointLabel" text,
	"checkpointAt" timestamp with time zone,
	"playbookId" uuid,
	"playbookVersion" integer,
	"executionMode" "execution_mode",
	"interventionReason" "intervention_reason",
	"eveSessionId" text,
	"eveContinuationToken" text,
	"location" text,
	"locationHash" text,
	"pageSignatureHash" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"completedPages" integer DEFAULT 0 NOT NULL,
	"ownerPrincipal" text,
	"leaseHolder" text,
	"leaseAcquiredAt" timestamp with time zone,
	"leaseExpiresAt" timestamp with time zone,
	"handoffToPrincipal" text,
	"handoffCreatedAt" timestamp with time zone,
	"handoffAcceptedAt" timestamp with time zone,
	"costUsd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"toolCallCount" integer DEFAULT 0 NOT NULL,
	"modelTurnCount" integer DEFAULT 0 NOT NULL,
	"submittedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ApplicationField" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"applicationId" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"fieldKey" text NOT NULL,
	"label" text NOT NULL,
	"purpose" text,
	"value" text,
	"inputType" "input_type" DEFAULT 'text' NOT NULL,
	"options" text[],
	"required" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"factId" uuid,
	"source" "fact_source",
	"sourceDetail" text,
	"verifiedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ApplicationField_applicationId_fieldKey_key" UNIQUE("applicationId","fieldKey")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "AuditEvent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenantId" uuid NOT NULL,
	"applicationId" uuid,
	"type" "audit_event_type" NOT NULL,
	"principalId" text NOT NULL,
	"connectionId" text,
	"recordId" text,
	"outcome" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"connectionId" text NOT NULL,
	"providerId" text NOT NULL,
	"organizationName" text NOT NULL,
	"sourceId" text,
	"secretRef" text,
	"mappingVersion" integer DEFAULT 1 NOT NULL,
	"maxAgeDays" integer DEFAULT 30 NOT NULL,
	"mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone,
	CONSTRAINT "Connection_tenantId_connectionId_key" UNIQUE("tenantId","connectionId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"householdId" uuid NOT NULL,
	"personId" uuid,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" "fact_source" NOT NULL,
	"sourceDetail" text,
	"confidence" numeric(4, 3),
	"observedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone,
	"consentScope" text,
	"confirmedBy" text,
	"confirmedAt" timestamp with time zone,
	"supersedesId" uuid,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Gap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"applicationId" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"fieldKey" text NOT NULL,
	"label" text NOT NULL,
	"purpose" text,
	"question" text NOT NULL,
	"kind" "gap_kind" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"inputType" "input_type" DEFAULT 'text' NOT NULL,
	"options" text[],
	"answeredFactId" uuid,
	"answeredAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Gap_applicationId_fieldKey_key" UNIQUE("applicationId","fieldKey")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Household" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"externalRef" text NOT NULL,
	"connectionId" text,
	"recordId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Household_tenantId_externalRef_key" UNIQUE("tenantId","externalRef")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"householdId" uuid NOT NULL,
	"role" "person_role" DEFAULT 'member' NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Playbook" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid,
	"domain" text NOT NULL,
	"programIds" text[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"probes" text[] DEFAULT '{}' NOT NULL,
	"fieldMap" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"safeAdvanceRules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"autoAdvance" boolean DEFAULT false NOT NULL,
	"note" text,
	"staleAt" timestamp with time zone,
	"staleReason" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ReviewEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" uuid NOT NULL,
	"applicationId" uuid NOT NULL,
	"reviewerPrincipal" text NOT NULL,
	"action" "review_action" NOT NULL,
	"fieldKey" text,
	"attestation" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"disabledAt" timestamp with time zone,
	CONSTRAINT "Tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Application" ADD CONSTRAINT "Application_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Application" ADD CONSTRAINT "Application_householdId_Household_id_fk" FOREIGN KEY ("householdId") REFERENCES "public"."Household"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ApplicationField" ADD CONSTRAINT "ApplicationField_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ApplicationField" ADD CONSTRAINT "ApplicationField_applicationId_Application_id_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."Application"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ApplicationField" ADD CONSTRAINT "ApplicationField_factId_Fact_id_fk" FOREIGN KEY ("factId") REFERENCES "public"."Fact"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_applicationId_Application_id_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."Application"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Connection" ADD CONSTRAINT "Connection_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Fact" ADD CONSTRAINT "Fact_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Fact" ADD CONSTRAINT "Fact_householdId_Household_id_fk" FOREIGN KEY ("householdId") REFERENCES "public"."Household"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Fact" ADD CONSTRAINT "Fact_personId_Person_id_fk" FOREIGN KEY ("personId") REFERENCES "public"."Person"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Gap" ADD CONSTRAINT "Gap_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Gap" ADD CONSTRAINT "Gap_applicationId_Application_id_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."Application"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Gap" ADD CONSTRAINT "Gap_answeredFactId_Fact_id_fk" FOREIGN KEY ("answeredFactId") REFERENCES "public"."Fact"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Household" ADD CONSTRAINT "Household_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Person" ADD CONSTRAINT "Person_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Person" ADD CONSTRAINT "Person_householdId_Household_id_fk" FOREIGN KEY ("householdId") REFERENCES "public"."Household"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ReviewEvent" ADD CONSTRAINT "ReviewEvent_tenantId_Tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ReviewEvent" ADD CONSTRAINT "ReviewEvent_applicationId_Application_id_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."Application"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Application_householdId_idx" ON "Application" USING btree ("householdId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Application_tenantId_status_idx" ON "Application" USING btree ("tenantId","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApplicationField_applicationId_ordinal_idx" ON "ApplicationField" USING btree ("applicationId","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_at_idx" ON "AuditEvent" USING btree ("tenantId","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "AuditEvent_applicationId_idx" ON "AuditEvent" USING btree ("applicationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Fact_householdId_key_idx" ON "Fact" USING btree ("householdId","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Fact_supersedesId_idx" ON "Fact" USING btree ("supersedesId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Gap_applicationId_ordinal_idx" ON "Gap" USING btree ("applicationId","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Person_householdId_idx" ON "Person" USING btree ("householdId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Playbook_domain_version_idx" ON "Playbook" USING btree ("domain","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ReviewEvent_applicationId_idx" ON "ReviewEvent" USING btree ("applicationId");