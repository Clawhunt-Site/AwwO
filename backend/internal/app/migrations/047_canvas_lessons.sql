-- Canvas RSI, loop 3 (canvas_lessons.go; owner 2026-10-31: 每次画布跑出来之后都要沉淀……形成完整的RSI回路). After a canvas
-- run ends, what its nodes' failures teach is written down as lessons, and the next runs of those nodes are given them:
-- a lesson is scoped to one node of one canvas (canvas_id, node_id) or, without them, to the whole workspace; kind
-- names what it was learnt from (a failure code's class); a rule writes one lesson per scope and kind (fingerprint) and
-- counts each time its failure happens again (seen). Each settled node run that was given a lesson counts it as applied
-- and as succeeded or failed; a lesson that keeps failing is retired. A lesson may carry a suggestion for the canvas
-- itself (proposal), which the canvas assistant carries out when a person asks it to. graph_runs.lessons_at marks a
-- canvas run whose lessons were written, so none is learnt from twice; run_ratings keeps the thumbs a person gives a
-- node's result. canvas_lessons was empty and unused until now; every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS canvas_id text;
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS node_id text;
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT '';
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'rule';
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS fingerprint text;
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS seen integer NOT NULL DEFAULT 1;
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS failed integer NOT NULL DEFAULT 0;
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS last_applied_at timestamptz;
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS retired_reason text NOT NULL DEFAULT '';
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS proposal text NOT NULL DEFAULT '';
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS proposal_state text NOT NULL DEFAULT 'open';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'canvas_lessons'::regclass AND conname = 'canvas_lessons_shape_check') THEN
    ALTER TABLE canvas_lessons ADD CONSTRAINT canvas_lessons_shape_check CHECK (
      source IN ('rule', 'model', 'person')
      AND (node_id IS NULL OR canvas_id IS NOT NULL)
      AND seen >= 1 AND applied >= 0 AND succeeded >= 0 AND failed >= 0 AND succeeded + failed <= applied
      AND length(rule) BETWEEN 1 AND 1200 AND length(kind) <= 64 AND length(retired_reason) <= 64
      AND proposal IN ('', 'lower_effort', 'larger_context', 'other_model')
      AND proposal_state IN ('open', 'asked', 'dismissed'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS canvas_lessons_fingerprint ON canvas_lessons(tenant_id, fingerprint) WHERE fingerprint IS NOT NULL;
-- A node's active lessons are read at every admission of that node; a canvas's at every read of its RSI view.
CREATE INDEX IF NOT EXISTS canvas_lessons_canvas ON canvas_lessons(tenant_id, canvas_id, node_id) WHERE status = 'active';
ALTER TABLE graph_runs ADD COLUMN IF NOT EXISTS lessons_at timestamptz;
-- The sweeper learns from the canvas runs that ended in its window (14 days) without their lessons written. Those that
-- ended before it never will be: they are marked as they are, so the index below holds only runs still due.
UPDATE graph_runs SET lessons_at = updated_at
  WHERE lessons_at IS NULL AND status IN ('completed', 'failed', 'interrupted') AND updated_at < now() - interval '14 days';
-- The sweeper looks for ended canvas runs whose lessons were never written: only those rows are indexed.
CREATE INDEX IF NOT EXISTS graph_runs_lessons_due ON graph_runs(updated_at) WHERE lessons_at IS NULL AND status IN ('completed', 'failed', 'interrupted');
-- The canvas planner's own lessons (planner_lessons.go): each plan the plan gate refused records why, in one word of a
-- fixed list and nothing of the plan's text, with the model that planned it and its workspace (so it goes with it).
-- A reason that keeps coming back, in more than one workspace, is named to every planner as a mistake to avoid.
CREATE TABLE IF NOT EXISTS planner_refusals (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason ~ '^[a-z_]{1,32}(:[a-z_]{1,32})?$'),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS planner_refusals_recent ON planner_refusals(created_at);
-- A rating goes with its run (and so with its canvas), as the run's outputs do, and with the person who gave it.
CREATE TABLE IF NOT EXISTS run_ratings (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id, user_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE
);
