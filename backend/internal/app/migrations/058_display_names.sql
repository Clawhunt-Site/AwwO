-- The name a person is shown by, wherever the canvas reads a name from the database (docs/awwo-canvas-live-collaboration.md,
-- Participants; found recording the 多人同屏 tutorial on 2026-11-07, where the agents were given a person's full account
-- name, addressed them by it and repeated it). A session signed in through ClawHunt shows its person by ClawHunt's
-- current name (auth.go: the provider's fields are display metadata), and the canvas's people list follows it; but its
-- live messages, claims, change log and agent tokens named a person by users.name, the account's own name: for an
-- account made before it was linked to ClawHunt the one given at sign-up, for one ClawHunt made the name it had then.
-- users.display_name keeps the name the person's sessions show them by: the sign-in writes it, and each request whose
-- session shows another rewrites it; those reads take it first. An account linked to ClawHunt that has none yet (linked
-- before this, or by an older API) is named by nothing, never by its own name, until the person's next request; one
-- never linked is named by its own. users.name stays as it was, and display_name goes with the account.
--
-- Every statement can run again unchanged. No row is written: the column comes empty and the check is NOT VALID (each
-- value is checked as it is written), so the users table is not scanned under the lock. Those reads ask for the
-- ClawHunt link of each person they name, by the index below (external_identities holds one row per linked account).
SET LOCAL lock_timeout = '10s';
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_length;
ALTER TABLE users ADD CONSTRAINT users_display_name_length CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200) NOT VALID;
CREATE INDEX IF NOT EXISTS external_identities_user ON external_identities(user_id);
