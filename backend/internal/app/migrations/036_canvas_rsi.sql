-- Canvas RSI: the canvas improves itself while it works, and records how. R-1 (graph_retry.go): a canvas node whose run
-- failed for a transient reason goes back to waiting and runs again once retry_at has passed; attempts counts those
-- retries and attempt_log keeps each failed attempt as {runId, code, endedAt, attempt}. canvas_experiences records
-- every retry (kind retry) and, later, repairs, rework and lessons, with the outcome the node finally reached;
-- canvas_lessons holds the rules distilled from them. Both are kept apart from graph_runs, whose rows go with their
-- canvas, so what a workspace learnt lasts as long as the workspace. Every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
ALTER TABLE graph_run_nodes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE graph_run_nodes ADD COLUMN IF NOT EXISTS retry_at timestamptz;
ALTER TABLE graph_run_nodes ADD COLUMN IF NOT EXISTS attempt_log jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS canvas_experiences (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canvas_id text NOT NULL,
  graph_id text NOT NULL,
  node_id text NOT NULL,
  run_id text,
  kind text NOT NULL CHECK (kind IN ('retry', 'repair', 'rework', 'lesson')),
  failure_code text NOT NULL DEFAULT '',
  node_role text NOT NULL DEFAULT '',
  output_type text NOT NULL DEFAULT '',
  runtime text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'succeeded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canvas_experiences_recent ON canvas_experiences(tenant_id, created_at DESC);
-- A node's open experiences are settled when the node settles; only open rows are indexed, so this stays small.
CREATE INDEX IF NOT EXISTS canvas_experiences_pending ON canvas_experiences(tenant_id, graph_id, node_id) WHERE outcome = 'pending';
CREATE TABLE IF NOT EXISTS canvas_lessons (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope jsonb NOT NULL DEFAULT '{}',
  rule text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'retired')),
  applied integer NOT NULL DEFAULT 0,
  succeeded integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canvas_lessons_status ON canvas_lessons(tenant_id, status);
