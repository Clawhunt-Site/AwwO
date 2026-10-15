-- Daily check-ins of a free-allowance promotion (checkin.go, promo.go): one per person and UTC day, and one per
-- workspace and day, with the bonus it gave stored on the row, so a later setting never changes a day already given.
-- Admission reads the workspace's row for today under the workspace lock (todayAllowance).
--
-- A generation records when it was sent to its provider (submitted_at, set just before the request) and whether the
-- provider refused it outright, creating no task (provider_refused): a free generation counts once it was sent, unless
-- it was refused, so a refusal gives its attempt back while a submission whose outcome is unknown keeps counting
-- (generationCounts). Both columns are nullable or have a constant default, so adding them rewrites no table; the
-- short lock timeout makes a busy table fail the deploy visibly instead of queueing every query behind it.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS workspace_checkins (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  bonus_daily integer NOT NULL CHECK (bonus_daily >= 0),
  bonus_media integer NOT NULL CHECK (bonus_media >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, day),
  UNIQUE (user_id, day)
);
ALTER TABLE media_generations ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE media_generations ADD COLUMN IF NOT EXISTS provider_refused boolean NOT NULL DEFAULT false;
