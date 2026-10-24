-- AwwO 本地版's connection to this site (relay.go): a key a member makes on 设置 → 本机版连接 for one workspace of
-- theirs, which a local install sends with each model call it has this site make for it (POST
-- /api/v1/relay/v1/chat/completions), so the call runs here, on this site's models, and counts as that workspace's. Only
-- the key's SHA-256 is kept (it is shown once). A key ends when its member revokes it or when it expires (90 days after
-- it was made: a sign-in here is checked with ClawHunt again and again, a key is not); a revoked key stays, as the calls
-- it made name it.
--
-- A relayed call is one of the ledger's model calls: its run_id is a logical id of its own (run_id names no row since
-- 013), and relay_key_id names its key, which is how the account's agents at once count the relayed calls running
-- (plans.go accountSlotsUsed). One nullable column without a default, so model_invocations is not rewritten; the short
-- lock timeout makes a busy deploy fail visibly instead of queueing every query behind it.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS relay_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  prefix text NOT NULL CHECK (prefix ~ '^awwo_rk_[A-Za-z0-9_-]{4}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS relay_keys_user ON relay_keys(user_id, created_at DESC);
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS relay_key_id text;
