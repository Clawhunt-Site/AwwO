ALTER TABLE node_sessions ADD COLUMN kind text NOT NULL DEFAULT 'node' CHECK(kind IN ('node','planner'));
CREATE UNIQUE INDEX node_sessions_one_planner ON node_sessions(tenant_id,canvas_id) WHERE kind='planner';
ALTER TABLE agents ADD COLUMN internal boolean NOT NULL DEFAULT false;
