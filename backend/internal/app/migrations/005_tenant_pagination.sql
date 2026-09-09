ALTER TABLE memberships ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX memberships_page ON memberships(tenant_id,created_at DESC,user_id DESC);
CREATE INDEX canvases_page ON canvases(tenant_id,created_at DESC,id DESC);
CREATE INDEX agents_page ON agents(tenant_id,created_at DESC,id DESC) WHERE NOT internal;
CREATE INDEX node_sessions_page ON node_sessions(tenant_id,created_at DESC,id DESC) WHERE kind='node';
CREATE INDEX node_sessions_canvas_page ON node_sessions(tenant_id,canvas_id,created_at DESC,id DESC) WHERE kind='node';
CREATE INDEX runs_page ON runs(tenant_id,created_at DESC,id DESC);
CREATE INDEX runs_session_page ON runs(tenant_id,session_id,created_at DESC,id DESC);
