CREATE TABLE users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
 password_hash text NOT NULL, platform_role text NOT NULL DEFAULT 'user' CHECK(platform_role IN ('user','admin')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenants (
 id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 max_concurrent_runs integer NOT NULL DEFAULT 2 CHECK(max_concurrent_runs BETWEEN 1 AND 100),
 max_runs_per_day integer NOT NULL DEFAULT 100 CHECK(max_runs_per_day BETWEEN 1 AND 100000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
 tenant_id text NOT NULL REFERENCES tenants(id), user_id text NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('reader','member','admin','owner')),
 PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE auth_sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE agents (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL,
 role text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', model text NOT NULL DEFAULT '',
 instructions text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE canvases (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL,
 document jsonb NOT NULL DEFAULT '{}', version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE node_sessions (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), canvas_id text NOT NULL, node_id text NOT NULL,
 agent_id text NOT NULL, title text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,canvas_id) REFERENCES canvases(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,agent_id) REFERENCES agents(tenant_id,id),
 UNIQUE(tenant_id,id)
);
CREATE INDEX node_sessions_canvas ON node_sessions(tenant_id,canvas_id);
CREATE TABLE runs (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), session_id text NOT NULL,
 operation_id text NOT NULL, request_hash text NOT NULL, prompt text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
 output text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,session_id) REFERENCES node_sessions(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,operation_id), UNIQUE(tenant_id,id)
);
CREATE INDEX runs_tenant_time ON runs(tenant_id,created_at DESC);
CREATE UNIQUE INDEX runs_one_active_session ON runs(session_id) WHERE status IN ('queued','running');
CREATE TABLE messages (
 id text PRIMARY KEY, tenant_id text NOT NULL, session_id text NOT NULL, run_id text,
 role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,session_id) REFERENCES node_sessions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX messages_session ON messages(tenant_id,session_id,created_at,id);
CREATE TABLE run_events (
 id bigserial PRIMARY KEY, tenant_id text NOT NULL, run_id text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX run_events_replay ON run_events(tenant_id,run_id,id);
CREATE TABLE audit_events (
 id bigserial PRIMARY KEY, actor_id text REFERENCES users(id), tenant_id text REFERENCES tenants(id),
 action text NOT NULL, resource_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
