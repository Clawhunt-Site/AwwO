-- The cloud relay (docs/awwo-cloud-relay.md): AwwO 本地版 calls the hosted site's Bedrock models on a person's
-- workspace, through the hosted API, with a token the person granted it from the hosted site.
--
-- local_links (hosted site): one row per connection a local edition asked for. It starts pending with a device code
-- (held by the local edition, kept here as its SHA-256) and a short user code (shown to the person); the person
-- approves it for one workspace from a signed-in session; the local edition then exchanges its device code once for a
-- token (kept here as its SHA-256), valid until expires_at unless revoked. request_ip is the address that asked for the
-- link, shown to the person while they decide and cleared once they have (the CHECK), so no address outlives a code by
-- more than the hour after it ends. Deleting the account deletes its links; removing a member or making them a reader
-- revokes their links to that workspace (resources.go), and a suspended workspace stops a link at its next call.
--
-- model_invocations.relay_link_id: the link a relayed call was made through. A relayed call is a model invocation of
-- its workspace like any other (its run_id is the logical reference relay-<link id>, which no run has); the column tells
-- them apart where a plan's agents at once are counted (plans.go accountSlotsUsed).
--
-- user_connections.relay (local edition): for an 「AwwO 线上」 connection, the link it holds (id, workspace, expiry)
-- and each relayed model's limits as the hosted site gave them. NULL for every other connection.
--
-- New tables and nullable columns without defaults only: nothing existing is rewritten. The short lock timeout makes a
-- busy deploy fail visibly instead of queueing every query behind it.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS local_links (
 id text PRIMARY KEY,
 device_hash text NOT NULL UNIQUE,
 user_code text NOT NULL CHECK (user_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
 device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 80),
 status text NOT NULL CHECK (status IN ('pending','approved','denied','issued','revoked')),
 user_id text REFERENCES users(id) ON DELETE CASCADE,
 tenant_id text REFERENCES tenants(id) ON DELETE CASCADE,
 token_hash text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 code_expires_at timestamptz NOT NULL,
 polled_at timestamptz,
 approved_at timestamptz,
 issued_at timestamptz,
 expires_at timestamptz,
 last_used_at timestamptz,
 revoked_at timestamptz,
 request_ip text CHECK (request_ip IS NULL OR (status = 'pending' AND length(request_ip) BETWEEN 1 AND 64)),
 CHECK (status IN ('pending','denied') OR (user_id IS NOT NULL AND tenant_id IS NOT NULL)),
 CHECK (token_hash IS NULL OR status IN ('issued','revoked')),
 CHECK (status <> 'issued' OR (token_hash IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS local_links_pending_code ON local_links(user_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS local_links_owner ON local_links(user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS local_links_code_expiry ON local_links(code_expires_at) WHERE status IN ('pending','approved','denied');
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS relay_link_id text;
ALTER TABLE user_connections ADD COLUMN IF NOT EXISTS relay jsonb CHECK (relay IS NULL OR jsonb_typeof(relay) = 'object');
