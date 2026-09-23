-- The submit gate trigger, brought to parity with evaluateSubmitGate().
--
-- 0001 checked two things: a confirmed review exists, and no required field is
-- empty. It did not check that filled values were read back, that required
-- questions were answered, or that there was anything in the packet at all. An
-- application with no fields satisfied every rule, and an HTTP run recorded one
-- as submitted.

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

  IF NOT EXISTS (
    SELECT 1 FROM "ApplicationField" f
    WHERE f."applicationId" = NEW.id
      AND f.value IS NOT NULL AND f.value <> ''
  ) THEN
    RAISE EXCEPTION
      'submit_gate: application % has no filled values to review', NEW.id
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

  IF EXISTS (
    SELECT 1 FROM "ApplicationField" f
    WHERE f."applicationId" = NEW.id
      AND f.value IS NOT NULL
      AND f."verifiedAt" IS NULL
  ) THEN
    RAISE EXCEPTION
      'submit_gate: application % has values that were never read back', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Gap" g
    WHERE g."applicationId" = NEW.id
      AND g.required
      AND g."answeredAt" IS NULL
  ) THEN
    RAISE EXCEPTION
      'submit_gate: application % has unanswered required questions', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;
