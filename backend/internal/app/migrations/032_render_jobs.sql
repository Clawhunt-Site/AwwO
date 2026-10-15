-- Motion renders (renders.go): a member asks the render worker to turn an HTML deliverable into a video by freezing
-- the page frame by frame. One row per request: its parameters, the digest and size of the page it rendered, and the
-- outcome. The page itself is not kept (it is the node's own output); the videos are artifacts of the canvas, stored
-- in AWWO_MEDIA_DIR like generated media, so they go with the canvas and are swept with it.
--
-- The rows are also the daily allowance's ledger, so they outlive their canvas (canvas_id is a record, like
-- artifacts.run_id, not a foreign key): deleting a canvas must not give its renders back. A canvas with a render
-- queued or running cannot be deleted (resources.go). A deleted workspace removes them with it.
--
-- operation_id makes a retried request return the same render. An API restart fails what was queued or running
-- (error_code interrupted) instead of rendering it twice.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS render_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canvas_id text NOT NULL,
  node_id text NOT NULL DEFAULT '',
  actor_id text,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  params jsonb NOT NULL,
  html_sha256 text NOT NULL,
  html_bytes integer NOT NULL CHECK (html_bytes > 0),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS render_jobs_canvas ON render_jobs(tenant_id, canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS render_jobs_day ON render_jobs(created_at);
