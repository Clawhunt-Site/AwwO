-- A durable at-most-once dispatch record. A lost response remains unknown and
-- is never retried automatically: an upstream bot may already be doing work.
CREATE TABLE openmaus_dispatches (
 tenant_id text NOT NULL REFERENCES tenants(id), operation_id text NOT NULL,
 request_hash text NOT NULL, actor_id text NOT NULL, bot_id text NOT NULL, task_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('sending','sent','unknown','rejected')),
 message text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,operation_id)
);
