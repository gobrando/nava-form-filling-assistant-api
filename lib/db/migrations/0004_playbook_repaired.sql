-- The deterministic scribe records that it published a playbook override.
-- Counts only, same allowlist as every other audit event. Selectors are not
-- stored here: the playbook row is the artifact, and the trail says how many
-- fields moved.

ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'playbook_repaired';
