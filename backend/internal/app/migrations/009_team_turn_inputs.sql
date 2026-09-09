-- New turns persist the exact prepared provider input. NULL marks legacy rows:
-- their actual system instructions and history were never recorded.
ALTER TABLE run_turns ADD COLUMN system_prompt text;
ALTER TABLE run_turns ADD COLUMN messages jsonb;
ALTER TABLE run_turns ADD COLUMN context jsonb;
