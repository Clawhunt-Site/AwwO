ALTER TABLE node_sessions DROP CONSTRAINT node_sessions_kind_check;
ALTER TABLE node_sessions ADD CONSTRAINT node_sessions_kind_check CHECK(kind IN ('node','planner','knowledge','computer'));
CREATE TABLE computer_sessions (
 tenant_id text NOT NULL, session_id text NOT NULL, actor_id text NOT NULL,
 operation_id text NOT NULL, request_hash text NOT NULL,
 PRIMARY KEY(tenant_id,session_id), UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES node_sessions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE computer_approvals (
 id text PRIMARY KEY, tenant_id text NOT NULL, run_id text NOT NULL, request_id text NOT NULL,
 title text NOT NULL, description text NOT NULL, kind text NOT NULL CHECK(kind IN ('approval','question')),
 arguments jsonb NOT NULL DEFAULT '{}', request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','allowed','denied','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,run_id,request_id)
);
CREATE TABLE computer_responses (
 tenant_id text NOT NULL REFERENCES tenants(id), operation_id text NOT NULL, run_id text NOT NULL,
 request_hash text NOT NULL, request_id text NOT NULL, status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
