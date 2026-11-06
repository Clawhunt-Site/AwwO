-- Live collaboration on one canvas (docs/awwo-canvas-live-collaboration.md; the owner's request of 2026-11-06 for many
-- agents and people working on one canvas at once, from the canvas page, MCP and the API).
--
-- canvas_changes is the canvas's change log: every write of a canvas document is one numbered change (its version)
-- holding the ops that turned the document before it into the one after it, so a page or an agent that holds a version
-- catches up by the changes after it. It keeps the latest changes of each canvas only (canvas_live.go prunes it); a
-- reader further behind reads the canvas again. Who made a change is a person (actor_id), a canvas agent token
-- (token_id) or the server itself; no name is kept: a person's is read from their account, an agent's from its token.
--
-- canvas_claims holds the nodes a participant has taken to work on, each until it expires; canvas_live_messages the
-- short lines the participants of a canvas write to each other; canvas_agent_tokens the secrets that let one agent into
-- one canvas (only their SHA-256 is kept; a revoked token stays, as the changes it made name it).
--
-- Every table goes with its canvas; a person's account takes their tokens, claims and messages with it, and leaves the
-- changes they made without their name. Every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS canvas_agent_tokens (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{16}$'),
  tenant_id text NOT NULL,
  canvas_id text NOT NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  prefix text NOT NULL CHECK (prefix ~ '^awwo_ct_[0-9a-f]{16}$'),
  scope text NOT NULL DEFAULT 'edit' CHECK (scope IN ('edit', 'read')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS canvas_agent_tokens_canvas ON canvas_agent_tokens(tenant_id, canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS canvas_agent_tokens_creator ON canvas_agent_tokens(created_by) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS canvas_changes (
  tenant_id text NOT NULL,
  canvas_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent', 'awwo')),
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  token_id text CHECK (token_id IS NULL OR token_id ~ '^[0-9a-f]{16}$'),
  -- The page or connection that sent it (a browser tab's id), so it knows its own change in the stream.
  client_id text NOT NULL DEFAULT '' CHECK (length(client_id) <= 80),
  -- The sender's own id for the change: sending it again is answered with the change, never applied twice. The
  -- request's hash tells a change sent again from another under the same id; results are each op's, as first answered.
  change_id text CHECK (change_id IS NULL OR length(change_id) BETWEEN 1 AND 80),
  request_hash text CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  results jsonb CHECK (results IS NULL OR jsonb_typeof(results) = 'array'),
  -- What made it, in a word the canvas shows: 'save' (an older page's whole document), 'setup' (node setup), 'edit',
  -- 'plan' (the canvas assistant), 'run' (a run's results), 'agent'.
  label text NOT NULL DEFAULT '' CHECK (label ~ '^[a-z]{0,16}$'),
  ops jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, canvas_id, version),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_changes_change_id ON canvas_changes(tenant_id, canvas_id, change_id) WHERE change_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS canvas_claims (
  tenant_id text NOT NULL,
  canvas_id text NOT NULL,
  node_id text NOT NULL CHECK (length(node_id) BETWEEN 1 AND 200),
  -- The participant holding it: a page (its client id) or a token (its id).
  participant_id text NOT NULL CHECK (length(participant_id) BETWEEN 1 AND 80),
  holder_kind text NOT NULL CHECK (holder_kind IN ('human', 'agent')),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id text,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 140),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK ((holder_kind = 'agent') = (token_id IS NOT NULL)),
  PRIMARY KEY (tenant_id, canvas_id, node_id),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, token_id) REFERENCES canvas_agent_tokens(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS canvas_live_messages (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  tenant_id text NOT NULL,
  canvas_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('human', 'agent')),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id text,
  node_id text NOT NULL DEFAULT '' CHECK (length(node_id) <= 200),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((author_kind = 'agent') = (token_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, token_id) REFERENCES canvas_agent_tokens(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS canvas_live_messages_canvas ON canvas_live_messages(tenant_id, canvas_id, created_at DESC, id DESC);
