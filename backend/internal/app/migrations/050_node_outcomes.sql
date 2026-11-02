-- Canvas RSI, the record (node_outcomes.go; the 2026-10-31 plan's 1.1): each node a canvas run ran leaves one row of
-- how it ran and ended, in AwwO's own words and numbers only — its role (template), what it delivers, the runtime, model
-- and reasoning effort, the platform's code for its end, its attempts, the lessons and skills it was given, and the
-- tokens, cost, credits and worker time its runs took — never a word of its prompt or output. A row goes with its
-- canvas run (and so with its canvas and workspace). graph_runs.outcomes_at marks a canvas run recorded, as lessons_at
-- marks one learnt from; ended canvas runs older than the 14 days the sweeper looks back are marked as they are, so the
-- sweeper records the rest once. Effort tuning counts these rows across workspaces. Every statement can run again
-- unchanged.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS node_outcomes (
  tenant_id text NOT NULL,
  canvas_id text NOT NULL,
  graph_id text NOT NULL,
  node_id text NOT NULL,
  run_id text,
  template text NOT NULL DEFAULT '' CHECK (length(template) <= 32),
  output_type text NOT NULL DEFAULT '' CHECK (length(output_type) <= 64),
  runtime text NOT NULL DEFAULT '' CHECK (length(runtime) <= 32),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
  effort text NOT NULL DEFAULT '' CHECK (effort ~ '^([a-z][a-z0-9_-]{0,31})?$'),
  state text NOT NULL CHECK (state IN ('done', 'failed')),
  code text NOT NULL DEFAULT '' CHECK (code ~ '^([a-z][a-z0-9_]{0,63})?$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lessons integer NOT NULL DEFAULT 0 CHECK (lessons >= 0),
  skills integer NOT NULL DEFAULT 0 CHECK (skills >= 0),
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  cache_write_tokens bigint,
  reasoning_tokens bigint,
  cost_microusd bigint,
  credits bigint,
  worker_ms bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, graph_id, node_id),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES graph_runs(tenant_id, id) ON DELETE CASCADE
);
-- Effort tuning reads the platform's last 14 days by template and model, and a node's own runs on its canvas.
CREATE INDEX IF NOT EXISTS node_outcomes_recent ON node_outcomes(created_at, template, model);
CREATE INDEX IF NOT EXISTS node_outcomes_node ON node_outcomes(tenant_id, canvas_id, node_id, created_at);
ALTER TABLE graph_runs ADD COLUMN IF NOT EXISTS outcomes_at timestamptz;
UPDATE graph_runs SET outcomes_at = updated_at
  WHERE outcomes_at IS NULL AND status IN ('completed', 'failed', 'interrupted') AND updated_at < now() - interval '14 days';
-- The sweeper looks for ended canvas runs not yet recorded: only those rows are indexed.
CREATE INDEX IF NOT EXISTS graph_runs_outcomes_due ON graph_runs(updated_at) WHERE outcomes_at IS NULL AND status IN ('completed', 'failed', 'interrupted');
