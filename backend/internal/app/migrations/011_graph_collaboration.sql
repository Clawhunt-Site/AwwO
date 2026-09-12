ALTER TABLE graph_runs ADD COLUMN collaboration jsonb;
ALTER TABLE graph_run_nodes ADD COLUMN collaboration_prompt text NOT NULL DEFAULT '';
CREATE TABLE graph_collaboration_turns (
 tenant_id text NOT NULL, graph_id text NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 37),
 node_id text NOT NULL, phase text NOT NULL CHECK(phase IN ('proposal','review','synthesis')),
 round integer NOT NULL CHECK(round BETWEEN 1 AND 3),
 state text NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','running','completed','failed','cancelled','interrupted')),
 run_id text, error text NOT NULL DEFAULT '',
 PRIMARY KEY(graph_id,ordinal), UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,graph_id) REFERENCES graph_runs(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(graph_id,node_id) REFERENCES graph_run_nodes(graph_id,node_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id)
);
