-- Canvas self-learning (learning.go, run_memory.go, learning_cycle.go; the owner's 2026-11-04 ask: 每个画布自己的内容需要
-- 做自己迭代生产……每三天从各个用户中进化迭代出对应内容). A workspace learns from its own canvas runs unless an admin turns
-- it off: ClawHunt's default model reads a run's record and keeps notes for its canvas (memory_items, origin run), on
-- probation (status proposed, which no run is given, nor by an API from before this migration) until a later run writes
-- one again (evidence), and every few days a learning cycle tidies them
-- (learning_cycles): it merges notes that say the same, moves the preferences and style rules several canvases share to
-- the whole workspace (origin evolution), archives notes no run used, and gives a node's lesson that kept helping to
-- every node of its template. People's notes are never read for it nor changed. Each change a cycle makes is logged (learning_changes) with
-- the ids and states it changed, never their text, so a person can take it back and nothing of a deleted canvas stays.
-- Every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
-- On unless an admin turned it off (learning_off_at, by learning_off_by); turned on again, a workspace learns only from
-- the runs begun after that (learning_on_at). 052's memory suggestions (suggestions_at) are no longer read; the column
-- stays for the API before this migration, which a rollback runs on this schema.
ALTER TABLE workspace_learning ADD COLUMN IF NOT EXISTS learning_off_at timestamptz;
ALTER TABLE workspace_learning ADD COLUMN IF NOT EXISTS learning_off_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workspace_learning ADD COLUMN IF NOT EXISTS learning_on_at timestamptz;
-- A note AwwO keeps counts the runs that bore it out on their own (evidence: ones not given it), and when one last did
-- (last_seen_at); an archived note says why (archived_reason) and, when another note took its place, which
-- (successor_id, a note of the same workspace): restated where it said what a person deleted or changed of a note of
-- their own, of which nothing is kept; prompt_version names the instructions the model that wrote it had.
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS evidence integer NOT NULL DEFAULT 1;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS archived_reason text NOT NULL DEFAULT '';
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS successor_id text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT '';
-- A note AwwO keeps that a person brought back from a cycle's change (kept_apart) is AwwO's still, and no cycle, nor a
-- run's replace, changes it again.
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS kept_apart boolean NOT NULL DEFAULT false;
-- A note a run wrote to take the place of another (replaces_id, a note of the same workspace) waits on probation while
-- that one stays in use, and archives it as superseded once borne out.
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS replaces_id text;
-- The hash of the text AwwO wrote of a note (written_hash, set when a run or a cycle writes it): its text is AwwO's while
-- it is the same, whichever API changed it since (one from before this migration changes it without saying so).
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS written_hash text NOT NULL DEFAULT '';
-- AwwO's notes come into use only once borne out by two runs: one of its own in use borne out by fewer (a build of this
-- change before it was released) waits on probation.
UPDATE memory_items SET status='proposed' WHERE status='active' AND origin IN ('run','evolution') AND created_by IS NULL AND updated_by IS NULL
  AND NOT pinned AND evidence<2;
-- 031's origin check, with the notes a learning cycle writes for the whole workspace (evolution).
ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_origin_check;
ALTER TABLE memory_items ADD CONSTRAINT memory_items_origin_check CHECK (origin IN ('user', 'run', 'assistant', 'evolution'));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'memory_items'::regclass AND conname = 'memory_items_learning_check') THEN
    ALTER TABLE memory_items ADD CONSTRAINT memory_items_learning_check CHECK (
      evidence >= 1
      AND archived_reason IN ('', 'merged', 'superseded', 'promoted', 'unused', 'outdated', 'restated', 'tidied', 'undone')
      AND (successor_id IS NULL OR length(successor_id) <= 64)
      AND (replaces_id IS NULL OR length(replaces_id) <= 64)
      AND written_hash ~ '^([0-9a-f]{64})?$'
      AND prompt_version ~ '^[0-9a-f]{0,32}$');
  END IF;
END $$;
-- One learning cycle of one workspace: running, then done or failed with a code for why; whether its model read the
-- workspace's notes (read_notes: only while the workspace learns), what it did (counts) and the instructions its model
-- had (prompt_version). A cycle goes with its workspace.
CREATE TABLE IF NOT EXISTS learning_cycles (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  reason text NOT NULL DEFAULT '' CHECK (reason ~ '^[a-z0-9_]{0,64}$'),
  read_notes boolean NOT NULL DEFAULT false,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_version text NOT NULL DEFAULT '' CHECK (prompt_version ~ '^[0-9a-f]{0,32}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((state = 'running') = (finished_at IS NULL))
);
-- The sweeper finds a workspace's last cycle; the 经验 panel lists its latest.
CREATE INDEX IF NOT EXISTS learning_cycles_recent ON learning_cycles(tenant_id, started_at DESC);
-- A workspace runs one cycle at a time.
CREATE UNIQUE INDEX IF NOT EXISTS learning_cycles_one_running ON learning_cycles(tenant_id) WHERE state = 'running';
-- One change a cycle made: a note moved to the whole workspace from several canvases (promote_note), notes of one scope
-- merged into one (merge_notes), a note archived (archive_note), or a node's lesson given to its template's nodes
-- (promote_lesson). item_id is the note or lesson it wrote or changed, sources the ones it came from; before holds the
-- ids, statuses and versions it changed, as they were, to take it back (undone_at, by undone_by) — never a note's text.
-- A change of one canvas's notes goes with that canvas (canvas_id); one for the whole workspace, with its cycle.
CREATE TABLE IF NOT EXISTS learning_changes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  cycle_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('promote_note', 'merge_notes', 'archive_note', 'promote_lesson')),
  canvas_id text,
  item_id text NOT NULL CHECK (length(item_id) <= 64),
  sources text[] NOT NULL DEFAULT '{}',
  before jsonb NOT NULL DEFAULT '{}'::jsonb,
  undone_at timestamptz,
  undone_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES learning_cycles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE,
  CHECK (undone_by IS NULL OR undone_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS learning_changes_cycle ON learning_changes(tenant_id, cycle_id);
-- A canvas's 经验 panel lists the changes of its notes; its deletion finds them.
CREATE INDEX IF NOT EXISTS learning_changes_canvas ON learning_changes(tenant_id, canvas_id) WHERE canvas_id IS NOT NULL;
-- The canvases a note of the whole workspace that a cycle wrote came from (its sources' canvases, and theirs), and
-- whether it holds a canvas's words (words): a row goes with its canvas and with its note. A note a cycle wrote that no
-- person has made theirs (memoryNoteLockedSQL) goes once none of the canvases whose words it holds is left
-- (deleteObject), so nothing a deleted canvas said outlives it there in its words.
CREATE TABLE IF NOT EXISTS memory_item_canvases (
  tenant_id text NOT NULL,
  item_id text NOT NULL,
  canvas_id text NOT NULL,
  words boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, item_id, canvas_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES memory_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE
);
-- A canvas's deletion finds the rows of its notes' canvases.
CREATE INDEX IF NOT EXISTS memory_item_canvases_canvas ON memory_item_canvases(tenant_id, canvas_id);
-- A note AwwO kept that a person deleted, or changed, leaves in its scope (a canvas, or the whole workspace with
-- canvas_id NULL) the hash of its text and of each of its terms (terms) and numbers (numbers), sentence by sentence and
-- clause by clause too (parts, in the order of their terms, not of the note), keyed with the deployment's credential
-- key, never its text, and its kind (a fact's or a decision's holds more of what is said of the same), so that no run or
-- cycle writes it there again, nor gives it there, in those words or most of them. A row goes with its canvas and with
-- its workspace; one of a note of the whole workspace that held canvases' words (canvas_words), in whatever scope, goes
-- with the last of those canvases (memory_item_dismissal_canvases), as the note would have.
CREATE TABLE IF NOT EXISTS memory_item_dismissals (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canvas_id text,
  content_hash text NOT NULL CHECK (length(content_hash) <= 128),
  terms text[] NOT NULL DEFAULT '{}' CHECK (cardinality(terms) <= 640),
  numbers text[] NOT NULL DEFAULT '{}' CHECK (cardinality(numbers) <= 640),
  parts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) <= 600),
  kind text NOT NULL DEFAULT '' CHECK (kind IN ('', 'preference', 'fact', 'decision', 'lesson', 'style')),
  canvas_words boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_item_dismissals_scope ON memory_item_dismissals(tenant_id, COALESCE(canvas_id, ''), content_hash);
-- A note is held to the newest of the dismissals where it would be given in other words (scopeDismissals): those of the
-- workspace's, or of one scope's.
CREATE INDEX IF NOT EXISTS memory_item_dismissals_recent ON memory_item_dismissals(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_item_dismissals_scope_recent ON memory_item_dismissals(tenant_id, COALESCE(canvas_id, ''), created_at DESC);
-- The canvases whose words a dismissed note of the whole workspace held, for its dismissal in scope (a canvas, or ''
-- the whole workspace): a row goes with its canvas, and with the canvas of its scope (deleteObject).
CREATE TABLE IF NOT EXISTS memory_item_dismissal_canvases (
  tenant_id text NOT NULL,
  scope text NOT NULL DEFAULT '',
  content_hash text NOT NULL CHECK (length(content_hash) <= 128),
  canvas_id text NOT NULL,
  PRIMARY KEY (tenant_id, scope, content_hash, canvas_id),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE
);
-- A canvas's deletion finds the rows of its words.
CREATE INDEX IF NOT EXISTS memory_item_dismissal_canvases_canvas ON memory_item_dismissal_canvases(tenant_id, canvas_id);
-- The notes a run, or a canvas run's node, was given (the id of each, the hash of its text, its title and its body, as
-- its snapshot holds them), kept apart from its snapshot, which holds its conversation's history too: a later canvas
-- run's notes are held to what its nodes were told, and through that history, read from here (givenNotes). NULL where an
-- API from before this migration admitted it (a node's notes are then read from its snapshot; a run's history then
-- tells nothing). No default: no row is rewritten.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS given_notes jsonb;
ALTER TABLE graph_run_nodes ADD COLUMN IF NOT EXISTS given_notes jsonb;
-- The day's limit counts the cycles begun in the last day, of every workspace, and the oldest go after 90 days.
CREATE INDEX IF NOT EXISTS learning_cycles_started ON learning_cycles(started_at);
-- The sweeper asks of each workspace whether a canvas run of it ended since its last cycle. graph_runs holds thousands of
-- rows (2026-11-04): the build takes well under a second, inside this migration's transaction.
CREATE INDEX IF NOT EXISTS graph_runs_tenant_updated ON graph_runs(tenant_id, updated_at);
