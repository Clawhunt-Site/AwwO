-- A workspace's learning settings (learning.go; the owner's option A for learning data, 2026-10-31), in a table of their
-- own rather than on tenants, which every write to a workspace locks. Both are off (NULL) until a person turns them on:
-- Help improve AwwO (consent_at), which only the owner turns on, lets the operator's learning export take copies of the
-- canvas runs the workspace makes from then on; memory suggestions (suggestions_at), which an admin turns on, let a
-- canvas run's record be read by the platform's default model for notes its canvas may keep (run_memory.go). The
-- consent is its giver's (consent_by): it holds only while they own the workspace, and it goes with their account, so a
-- workspace handed to another owner is not taken from on its old owner's word. Who changed either is in the audit log.
-- A row goes with its workspace. Every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS workspace_learning (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  consent_at timestamptz,
  consent_by text REFERENCES users(id) ON DELETE SET NULL,
  suggestions_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (consent_by IS NULL OR consent_at IS NOT NULL)
);
