-- Capture the effective setup so later team/config changes create a new current
-- conversation while preserving the original Agent and historical sessions.
ALTER TABLE node_sessions ADD COLUMN setup_snapshot jsonb;
