-- Daily allowances per paid model route (route_limits.go). NULL means no route limit, so every
-- workspace that exists today keeps exactly its current behaviour; only workspaces created with
-- AWWO_NEW_WORKSPACE_ROUTE_LIMITS, or edited by an administrator, carry limits. Adding a nullable
-- column is a metadata-only change; the short lock timeout makes a busy table fail the deploy
-- visibly instead of queueing every query behind this migration.
SET LOCAL lock_timeout = '10s';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS route_limits jsonb;
DO $$ BEGIN
  ALTER TABLE tenants ADD CONSTRAINT tenants_route_limits_object CHECK (route_limits IS NULL OR jsonb_typeof(route_limits) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The deployment-wide route ceilings count today's calls across workspaces.
CREATE INDEX IF NOT EXISTS model_invocations_created ON model_invocations(created_at);
