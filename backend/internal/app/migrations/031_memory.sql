-- Workspace memory (memory.go): short notes people save while they work (a preference, a fact, a decision, a lesson,
-- a style rule), for the whole workspace or for one canvas. At admission the notes relevant to a node's task are
-- frozen into its run snapshot and quoted to the model as untrusted background data, never as instructions.
--
-- canvas_id is NULL for a workspace note. The composite foreign key removes a canvas's notes with the canvas
-- (MATCH SIMPLE leaves workspace notes unchecked); a deleted workspace removes all of them. A note is a single row
-- whose edits bump its version (compare-and-set); deleting it erases it.
--
-- One new table and no change to existing ones; the short lock timeout makes a busy deploy fail visibly.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS memory_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canvas_id text,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (octet_length(body) <= 2048),
  kind text NOT NULL CHECK (kind IN ('preference','fact','decision','lesson','style')),
  status text NOT NULL CHECK (status IN ('active','proposed','archived')),
  origin text NOT NULL CHECK (origin IN ('user','run','assistant')),
  pinned boolean NOT NULL DEFAULT false,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  last_used_at timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memory_items_scope ON memory_items(tenant_id, canvas_id, status, updated_at DESC);
