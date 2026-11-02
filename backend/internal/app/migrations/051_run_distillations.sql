-- Canvas RSI, memory distilled from runs (run_memory.go; the 2026-10-31 plan's 1.2). A canvas run worth learning from is
-- queued here when its lessons are written, within a day's limits (a workspace's and the deployment's), and the
-- distiller asks the platform's free model about it once: queued, then done (with the notes it proposed), skipped or
-- failed, with a code for why. The notes are proposed notes of the canvas (memory_items, origin run), which no run is
-- given until a member accepts one. A row goes with its canvas run. Every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS run_distillations (
  tenant_id text NOT NULL,
  graph_id text NOT NULL,
  canvas_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'done', 'skipped', 'failed')),
  notes integer NOT NULL DEFAULT 0 CHECK (notes >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason text NOT NULL DEFAULT '' CHECK (reason ~ '^[a-z0-9_]{0,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, graph_id),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES graph_runs(tenant_id, id) ON DELETE CASCADE
);
-- The distiller takes the oldest queued runs; the day's limits count a workspace's runs and the deployment's.
CREATE INDEX IF NOT EXISTS run_distillations_queued ON run_distillations(created_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS run_distillations_day ON run_distillations(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS run_distillations_recent ON run_distillations(created_at);
