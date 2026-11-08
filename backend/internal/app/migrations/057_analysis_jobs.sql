-- Video breakdowns (analyses.go): a canvas run's analyze node tells how one video was made, on the video analysis
-- worker (apps/video-analysis-worker), which runs rea-video offline. One row per attempt: the stored video it analyses
-- (artifact id, size, digest), its options, its outcome and the node's delivery (the summary, the public report and
-- the names of its files). The report, storyboard, shot sheets and subtitles are artifacts of the canvas, stored in
-- AWWO_MEDIA_DIR like generated media, so they go with the canvas and are swept with it.
--
-- The rows are also the daily allowance's ledger, so they outlive their canvas (canvas_id is a record, as
-- edit_jobs.canvas_id is): deleting a canvas does not give its analyses back. A deleted workspace removes them with it.
--
-- An analysis is deterministic and charges no provider: a job an earlier process left queued or running is analysed
-- again from its own row while its graph run still runs (attempts counts the starts), never resumed halfway.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canvas_id text NOT NULL,
  graph_id text NOT NULL,
  node_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
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
CREATE INDEX IF NOT EXISTS analysis_jobs_node ON analysis_jobs(tenant_id, graph_id, node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_jobs_day ON analysis_jobs(created_at);
