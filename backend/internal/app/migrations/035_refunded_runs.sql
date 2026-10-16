-- Direct tasks (直接执行) that ended for the platform's sake (direct_task_refund.go): interrupted (an API or execution
-- service restart), dropped by the execution service, or failed by it. Their model calls are given back to the
-- workspace's daily total, a failed one's only when one of its calls failed on the platform's side. Kept apart from runs, whose rows go with their canvas, so a refund
-- lasts as the call ledger does when the canvas is deleted.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS refunded_runs (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('interrupted','dropped','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id)
);
