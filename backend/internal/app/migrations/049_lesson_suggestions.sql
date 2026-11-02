-- Canvas RSI, loop 3 (canvas_lessons.go): a lesson's suggestion for its node's reasoning effort is applied to the canvas
-- in the 经验 panel, as a plan the person takes there (undone as any plan is), and its state says so (applied); a node
-- put at low effort that then delivered what its outputs refused, or ran out of tool steps, is suggested medium again
-- (raise_effort). proposal_at is when a person last set a suggestion's state: an applied suggestion is offered again only
-- for a failure of a run admitted after it (one older, learnt from late by the sweeper, ran before the change). The
-- shape check is replaced as a whole, so running this again leaves the same constraint; every row 047 allowed, this
-- allows.
SET LOCAL lock_timeout = '10s';
ALTER TABLE canvas_lessons ADD COLUMN IF NOT EXISTS proposal_at timestamptz;
ALTER TABLE canvas_lessons DROP CONSTRAINT IF EXISTS canvas_lessons_shape_check;
ALTER TABLE canvas_lessons ADD CONSTRAINT canvas_lessons_shape_check CHECK (
  source IN ('rule', 'model', 'person')
  AND (node_id IS NULL OR canvas_id IS NOT NULL)
  AND seen >= 1 AND applied >= 0 AND succeeded >= 0 AND failed >= 0 AND succeeded + failed <= applied
  AND length(rule) BETWEEN 1 AND 1200 AND length(kind) <= 64 AND length(retired_reason) <= 64
  AND proposal IN ('', 'lower_effort', 'raise_effort', 'larger_context', 'other_model')
  AND proposal_state IN ('open', 'asked', 'dismissed', 'applied'));
