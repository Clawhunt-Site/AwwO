-- People sharing a canvas (the owner's 2026-11-08 ask for Figma-style collaboration among people, its first phase): a
-- canvas can be shared from the canvas itself, and a person who joins lands on it.
--
-- An invitation (tenant_invites) may be bound to one email (email, ASCII in lower case): only an account whose email is
-- that one accepts it, matched without asking whether the address was verified (AWWO-LAW-030; ClawHunt marks most
-- accounts unverified), and any other account is refused with the invitation kept. A bound invitation's link is kept
-- under a hash of its own kind (invitations.go inviteTokenHash), so an API from before this migration finds none and
-- answers not found. An invitation may name the canvas it was sent from (canvas_id, a canvas of the same workspace),
-- which the person opens once they have joined; the canvas's deletion only clears it, the invitation stays.
--
-- A canvas records who made it (created_by): its maker, or a workspace owner or admin, deletes it. Canvases made before
-- this migration take their maker from the canvas.created audit row the API wrote when it made them; one with none (a
-- maker since deleted) has nobody recorded, and only an owner or admin deletes it.
--
-- AwwO 本地版 keys (relay_keys) and canvas agent tokens are made and held by a workspace's owners and admins only (the
-- owner's plan pays for what they do): the live ones a member or a reader holds are revoked here, as a downgrade revokes
-- them from now on (resources.go changeMember), and an agent's claims go with its token. Every statement can run again
-- unchanged, and a second run does only what is new since the first: it records the makers of canvases an older API
-- made meanwhile (which records none) and revokes keys and tokens members were let make meanwhile.
--
-- Locks, in the order the API's own writes take these tables (an account's row before the canvases it makes), each at
-- the strongest level the migration needs, taken once: a weaker lock taken first and raised later would deadlock with a
-- canvas save that read its row before the migration began and writes it after.
SET LOCAL lock_timeout = '10s';
-- The makers of the canvases made so far, read from the audit first: the scan of audit_events (no index on its action)
-- holds no lock on canvases, and the backfill below, under the canvases lock, is one join on its primary key.
DROP TABLE IF EXISTS pg_temp.canvas_makers_059;
CREATE TEMP TABLE canvas_makers_059 ON COMMIT DROP AS
  SELECT DISTINCT ON (e.tenant_id, e.resource_id) e.tenant_id, e.resource_id AS canvas_id, e.actor_id FROM audit_events e
  WHERE e.action = 'canvas.created' AND e.actor_id IS NOT NULL ORDER BY e.tenant_id, e.resource_id, e.id;
-- users: the canvases' maker key takes this lock on it (no account is added, changed or deleted until the migration ends).
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
-- canvases: its new column takes the strongest lock, before the invitations' key to it would take a weaker one.
ALTER TABLE canvases ADD COLUMN IF NOT EXISTS created_by text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'canvases'::regclass AND conname = 'canvases_created_by_fk') THEN
    ALTER TABLE canvases ADD CONSTRAINT canvases_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
UPDATE canvases c SET created_by = made.actor_id
  FROM canvas_makers_059 made
  WHERE c.created_by IS NULL AND made.tenant_id = c.tenant_id AND made.canvas_id = c.id
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = made.actor_id);
-- Deleting an account clears the canvases it made (ON DELETE SET NULL): this index keeps that from reading every canvas.
CREATE INDEX IF NOT EXISTS canvases_created_by_idx ON canvases(created_by) WHERE created_by IS NOT NULL;
ALTER TABLE tenant_invites ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE tenant_invites ADD COLUMN IF NOT EXISTS canvas_id text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_invites'::regclass AND conname = 'tenant_invites_email_shape') THEN
    ALTER TABLE tenant_invites ADD CONSTRAINT tenant_invites_email_shape
      CHECK (email IS NULL OR (email = lower(email) AND email = btrim(email) AND octet_length(email) = char_length(email)
        AND length(email) BETWEEN 3 AND 320 AND position('@' IN email) > 1)) NOT VALID;
  END IF;
  -- A canvas of the invitation's own workspace (AWWO-LAW-002); its deletion clears canvas_id alone (PostgreSQL 15 on).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_invites'::regclass AND conname = 'tenant_invites_canvas_fk') THEN
    ALTER TABLE tenant_invites ADD CONSTRAINT tenant_invites_canvas_fk FOREIGN KEY (tenant_id, canvas_id)
      REFERENCES canvases(tenant_id, id) ON DELETE SET NULL (canvas_id) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS tenant_invites_canvas_idx ON tenant_invites(tenant_id, canvas_id) WHERE canvas_id IS NOT NULL;
UPDATE relay_keys k SET revoked_at = clock_timestamp()
  WHERE k.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM memberships m
    WHERE m.tenant_id = k.tenant_id AND m.user_id = k.user_id AND m.role IN ('owner', 'admin'));
DELETE FROM canvas_claims c USING canvas_agent_tokens t
  WHERE c.tenant_id = t.tenant_id AND c.token_id = t.id AND t.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM memberships m
    WHERE m.tenant_id = t.tenant_id AND m.user_id = t.created_by AND m.role IN ('owner', 'admin'));
UPDATE canvas_agent_tokens t SET revoked_at = clock_timestamp()
  WHERE t.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM memberships m
    WHERE m.tenant_id = t.tenant_id AND m.user_id = t.created_by AND m.role IN ('owner', 'admin'));
