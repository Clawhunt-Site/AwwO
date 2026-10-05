-- People who asked for more than their free allowance (upgrade_interest.go): one row per person and
-- workspace, everything they had used up when they asked ("daily" for the daily total, or a route) and
-- how many separate times. Deleting the person or the workspace removes the row. A new table only; the
-- short lock timeout makes a busy table fail the deploy visibly instead of queueing every query behind
-- the foreign keys.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS upgrade_interests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  routes text[] NOT NULL DEFAULT '{}' CHECK (routes <@ ARRAY['daily','gate','bedrock','media']::text[]),
  clicks integer NOT NULL DEFAULT 1 CHECK (clicks >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS upgrade_interests_created ON upgrade_interests(created_at, id);
