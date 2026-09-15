-- Reasoning effort is a per-agent selector parallel to model: both are frozen into
-- the execution snapshot at admission and forwarded to the worker unchanged. The
-- empty string means "no explicit setting" -- the provider then applies its own
-- default -- and is what every existing agent keeps, so behaviour is unchanged
-- until a node explicitly chooses a level its model advertises.
--
-- Additive and idempotent: an older API binary keeps working against this schema
-- because the column has a default, and re-running the statement is a no-op.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS effort text NOT NULL DEFAULT '';
DO $$ BEGIN
 ALTER TABLE agents ADD CONSTRAINT agents_effort_shape CHECK (effort = '' OR effort ~ '^[a-z][a-z0-9_-]{0,31}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
