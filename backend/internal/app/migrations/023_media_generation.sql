-- Image and video nodes run through a media provider (RunningHub) instead of a model worker.
-- Every addition is a nullable or constant-default column, a metadata-only change that never
-- rewrites a table; the short lock timeout makes a busy table fail the deploy visibly instead of
-- queueing every query behind this migration.
SET LOCAL lock_timeout = '10s';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'worker';
DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_engine_check CHECK (engine IN ('worker', 'media'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The provider task a media run waits on, so polling resumes after an API restart instead of
-- submitting (and paying for) the same generation again.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS media_task jsonb;
-- A generated file lives on disk: its path relative to AWWO_MEDIA_DIR and its media type. Rows
-- with a path keep an empty content column.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_type text;
-- Every admitted generation, tied only to its workspace. Daily limits count these rows: deleting a
-- canvas cascades its runs, and must not erase what the workspace has already spent.
CREATE TABLE IF NOT EXISTS media_generations (
  run_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_generations_tenant_time ON media_generations(tenant_id, created_at);
