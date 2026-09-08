ALTER TABLE runs ADD COLUMN team_snapshot jsonb;
ALTER TABLE runs ADD COLUMN execution_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN actor_id text REFERENCES users(id);

CREATE TABLE run_turns (
 id text PRIMARY KEY, tenant_id text NOT NULL, run_id text NOT NULL,
 member_id text NOT NULL, member_name text NOT NULL, role text NOT NULL,
 round integer NOT NULL, ordinal integer NOT NULL, config jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
 prompt text NOT NULL, output text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(run_id,ordinal)
);
CREATE INDEX run_turns_replay ON run_turns(tenant_id,run_id,ordinal);
CREATE TABLE model_invocations (
 id text PRIMARY KEY, tenant_id text NOT NULL, run_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX model_invocations_quota ON model_invocations(tenant_id,created_at,status);
-- Preserve the existing daily quota usage across upgrade. Legacy accepted runs
-- each represent one model admission; no historical request is replayed.
INSERT INTO model_invocations(id,tenant_id,run_id,status,created_at,updated_at)
 SELECT id,tenant_id,id,CASE WHEN status IN ('queued','running') THEN 'interrupted' ELSE status END,created_at,updated_at FROM runs;

CREATE TABLE graph_runs (
 id text PRIMARY KEY, tenant_id text NOT NULL, canvas_id text NOT NULL,
 actor_id text NOT NULL REFERENCES users(id), operation_id text NOT NULL, request_hash text NOT NULL,
 document_version bigint NOT NULL, document jsonb NOT NULL, scope jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
 error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,canvas_id) REFERENCES canvases(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,canvas_id,operation_id), UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX graph_runs_one_active_canvas ON graph_runs(tenant_id,canvas_id) WHERE status IN ('queued','running');
CREATE TABLE graph_operation_cancellations (
 tenant_id text NOT NULL, canvas_id text NOT NULL, operation_id text NOT NULL,
 actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,canvas_id,operation_id),
 FOREIGN KEY(tenant_id,canvas_id) REFERENCES canvases(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE graph_run_nodes (
 tenant_id text NOT NULL, graph_id text NOT NULL, node_id text NOT NULL, ordinal integer NOT NULL,
 state text NOT NULL CHECK(state IN ('waiting','running','done','failed','blocked','cancelled','cached')),
 output text NOT NULL DEFAULT '', detail text NOT NULL DEFAULT '', run_id text, session_id text,
 execution_snapshot jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(graph_id,node_id),
 FOREIGN KEY(tenant_id,graph_id) REFERENCES graph_runs(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES node_sessions(tenant_id,id)
);
