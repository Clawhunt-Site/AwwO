-- A direct task's model call that a time limit on its way cut (computer_model_timeout: an edge's 504 or 524, a stream the
-- edge closed when silent, the provider's own time limit; computerPlatformTimeout). When its task ends for the platform's
-- sake (refunded_runs), that call alone is given back to the workspace's daily total, not the task's other calls
-- (direct_task_refund.go, owner 2026-10-18). Noted as the call settles. Kept apart from model_invocations, whose checks
-- stay as they are, and from runs, whose rows go with their canvas, so a refund lasts as the call ledger does.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS refunded_calls (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invocation_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('timeout')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, invocation_id)
);
