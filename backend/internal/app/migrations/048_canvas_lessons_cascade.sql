-- A canvas's lessons go with it (canvas_lessons.go). A lesson of a node of a canvas (canvas_id, migration 047) is that
-- canvas's alone: only its nodes are given it and only its 经验 panel lists it, so once the canvas is deleted it is a row
-- nothing reads again. 047 gave canvas_id no key, and a canvas deleted on its own (resources.go) left its lessons
-- behind; only a deleted workspace took them along. The key cascades as graph_runs' and memory_items' do, whatever
-- deletes the canvas; a lesson without a canvas (the whole workspace's) is not checked by it and goes with its
-- workspace, as 036 meant. The key is added NOT VALID first: from then until this migration commits, no other session
-- writes canvases or canvas_lessons (the key takes both tables' share row exclusive lock), so no lesson left behind can
-- appear after the delete below removes those there are, and VALIDATE then checks every row (run again, the key holds
-- them already). Every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'canvas_lessons'::regclass AND conname = 'canvas_lessons_tenant_id_canvas_id_fkey') THEN
    ALTER TABLE canvas_lessons ADD CONSTRAINT canvas_lessons_tenant_id_canvas_id_fkey
      FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE NOT VALID;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'canvas_lessons'::regclass AND conname = 'canvas_lessons_tenant_id_canvas_id_fkey'
      AND pg_get_constraintdef(oid) IN ('FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE',
        'FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE NOT VALID')) THEN
    RAISE EXCEPTION 'canvas_lessons_tenant_id_canvas_id_fkey is not the cascading key to canvases that 048 adds';
  END IF;
END $$;
DELETE FROM canvas_lessons l WHERE l.canvas_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM canvases c WHERE c.tenant_id = l.tenant_id AND c.id = l.canvas_id);
ALTER TABLE canvas_lessons VALIDATE CONSTRAINT canvas_lessons_tenant_id_canvas_id_fkey;
-- The key's cascade, and the canvas's 经验 panel, find a canvas's lessons of every status: canvas_lessons_canvas holds
-- only the active ones, so without this a canvas's deletion would read all its workspace's lessons.
CREATE INDEX IF NOT EXISTS canvas_lessons_canvas_all ON canvas_lessons(tenant_id, canvas_id);
