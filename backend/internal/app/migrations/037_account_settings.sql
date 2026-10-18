-- Account settings (the 设置 centre). user_preferences keeps each account's own settings as one validated JSON object
-- (preferences.go: task notifications, personal instructions for the canvas planner, the default assistant model),
-- versioned like user_appearance so two tabs cannot overwrite each other unseen. account_deletion_requests records a
-- person's request to delete their account; an operator handles it by hand (the privacy clause), so a request only
-- records the wish and never deletes anything. Its user_id is cleared, not cascaded, when the account goes, so the
-- record of the request outlives the account it named. One pending request per account. Every statement can run
-- again unchanged.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_one_pending ON account_deletion_requests(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS account_deletion_requests_created ON account_deletion_requests(created_at, id);
