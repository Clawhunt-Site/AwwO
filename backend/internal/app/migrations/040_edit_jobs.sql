-- Edits (edits.go): a canvas run's edit node joins the clips, sounds and pictures wired into it by the timeline an
-- agent wrote, on the render worker, into one film. One row per attempt: the job's timeline and the stored files it
-- named (artifact ids, sizes, digests), its outcome, and the node's delivery (the awwo.media record of the film, with
-- its subtitles, stills and report). The film and its stills are artifacts of the canvas, stored in AWWO_MEDIA_DIR
-- like generated media, so they go with the canvas and are swept with it.
--
-- The rows are also the daily allowance's ledger, so they outlive their canvas (canvas_id is a record, like
-- render_jobs.canvas_id): deleting a canvas does not give its edits back. A deleted workspace removes them with it.
--
-- An edit is deterministic and charges no provider: a job an earlier process left queued or running is rendered
-- again from its own row while its graph run still runs (attempts counts the starts), never resumed halfway.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS edit_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canvas_id text NOT NULL,
  graph_id text NOT NULL,
  node_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  timeline jsonb NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  output text NOT NULL DEFAULT '',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS edit_jobs_node ON edit_jobs(tenant_id, graph_id, node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS edit_jobs_day ON edit_jobs(created_at);
