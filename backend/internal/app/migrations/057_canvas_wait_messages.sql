-- canvas_wait gives an agent the live messages someone else wrote after the position it goes on from, a message written
-- while it was busy between two waits too (docs/awwo-canvas-live-collaboration.md, Ports; found recording the 多人同屏
-- tutorial on 2026-11-07, where a message sent while an agent worked never reached that agent's next wait). A wait goes
-- on from the message its afterMessage names, else from the newest message its token has been given, which the token
-- keeps here: its time and its id, as values, since the message itself may go with the 200 a canvas keeps. Each wait
-- that gives messages moves it up to them (never back). A token starts after the newest message its canvas holds when it
-- is made ('epoch' and '' on a canvas without any); one made before this (both NULL) is set the same way at its first
-- read, as which of the earlier messages it saw is not known.
--
-- The tenant's row, which every write of a message locks first (canvasWriteRole), orders the writes, and each message is
-- stamped at least a microsecond after the newest of its canvas (canvasLiveSay): one committed later is never older, so
-- no later message falls behind a cursor, whatever the clock does.
--
-- Every statement can run again unchanged; canvas_agent_tokens is small (at most 10 live tokens a canvas).
SET LOCAL lock_timeout = '10s';
ALTER TABLE canvas_agent_tokens ADD COLUMN IF NOT EXISTS seen_message_at timestamptz;
ALTER TABLE canvas_agent_tokens ADD COLUMN IF NOT EXISTS seen_message_id text;
ALTER TABLE canvas_agent_tokens DROP CONSTRAINT IF EXISTS canvas_agent_tokens_seen_message;
ALTER TABLE canvas_agent_tokens ADD CONSTRAINT canvas_agent_tokens_seen_message CHECK ((seen_message_at IS NULL) = (seen_message_id IS NULL)
  AND (seen_message_id IS NULL OR length(seen_message_id) <= 64));
