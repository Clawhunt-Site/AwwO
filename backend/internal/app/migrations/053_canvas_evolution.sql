-- Canvas RSI, loop 4: a canvas that evolves by itself (canvas_evolution.go; the owner's «做出来», 2026-11-03). A canvas's
-- members may turn on, each off until then: auto apply (apply_at), under which a canvas run's failed nodes take their
-- lessons' suggested reasoning effort by themselves, and auto rerun (rerun_at), under which the run's unfinished nodes
-- run once more, with their new lessons. What either did is logged, one row each: an effort change, its revert (one
-- that did not help, or one a person took back), a change the canvas page could not make (skip), or a rerun, which
-- started a canvas run of its own. A change is claimed before the page makes it (the server says from what to what) and
-- done once the canvas as saved holds it (done_at); one never settled is let go as a skip. Both tables go with their
-- canvas; a person's account takes only its name from them. Every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS canvas_auto_evolution (
  tenant_id text NOT NULL,
  canvas_id text NOT NULL,
  apply_at timestamptz,
  apply_by text REFERENCES users(id) ON DELETE SET NULL,
  rerun_at timestamptz,
  rerun_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, canvas_id),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS canvas_evolution_log (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  canvas_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('effort', 'revert', 'skip', 'rerun')),
  -- Made by the canvas's own evolution (true), or by a person who took a change back (false).
  auto boolean NOT NULL DEFAULT true,
  node_id text NOT NULL DEFAULT '' CHECK (length(node_id) <= 200),
  lesson_id text,
  -- The canvas run whose end it answers.
  graph_id text NOT NULL,
  reverts_id text,
  rerun_graph_id text,
  -- The node's own reasoning effort before and after, as the server read and set them ('' for none).
  from_effort text NOT NULL DEFAULT '' CHECK (from_effort ~ '^([a-z][a-z0-9_-]{0,31})?$'),
  to_effort text NOT NULL DEFAULT '' CHECK (to_effort ~ '^([a-z][a-z0-9_-]{0,31})?$'),
  -- Why the page could not make a change (skip), in the words it showed; empty for one never settled.
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- When a change was settled: the canvas as saved held it (effort, revert), or it was let go (skip). Null while claimed.
  done_at timestamptz,
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, graph_id) REFERENCES graph_runs(tenant_id, id) ON DELETE CASCADE,
  CHECK ((kind = 'rerun') = (rerun_graph_id IS NOT NULL)),
  CHECK (kind <> 'revert' OR reverts_id IS NOT NULL),
  CHECK (kind = 'rerun' OR node_id <> ''),
  CHECK (auto OR kind IN ('revert', 'skip')),
  CHECK (kind IN ('effort', 'revert') OR done_at IS NOT NULL)
);
-- One rerun of a canvas run; one change of each kind for a node at each canvas run's end; one revert of a change. A
-- skip is a change let go, and a change let go may be claimed again (a person's revert), so skips are not held to one.
CREATE UNIQUE INDEX IF NOT EXISTS canvas_evolution_log_one_rerun ON canvas_evolution_log(tenant_id, graph_id) WHERE kind = 'rerun';
CREATE UNIQUE INDEX IF NOT EXISTS canvas_evolution_log_one_change ON canvas_evolution_log(tenant_id, graph_id, node_id, kind) WHERE kind IN ('effort', 'revert');
CREATE UNIQUE INDEX IF NOT EXISTS canvas_evolution_log_one_revert ON canvas_evolution_log(tenant_id, reverts_id) WHERE kind = 'revert';
CREATE INDEX IF NOT EXISTS canvas_evolution_log_canvas ON canvas_evolution_log(tenant_id, canvas_id, created_at DESC);
-- Each save of a canvas reads its claims under way, and its claims let go (skips with no reason), which a save may make
-- after all.
CREATE INDEX IF NOT EXISTS canvas_evolution_log_claimed ON canvas_evolution_log(tenant_id, canvas_id) WHERE kind IN ('effort', 'revert') AND done_at IS NULL;
CREATE INDEX IF NOT EXISTS canvas_evolution_log_let_go ON canvas_evolution_log(tenant_id, canvas_id) WHERE kind = 'skip' AND reason = '';
