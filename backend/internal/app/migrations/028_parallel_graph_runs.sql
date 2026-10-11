-- A canvas may run several graphs at once, each executing its own nodes: running one component no longer holds the
-- whole canvas. Admission (createGraphRun) refuses a graph whose executing nodes overlap an active graph's, and a
-- collaboration graph still runs alone; each node session keeps at most one active run (runs_one_active_session).
DROP INDEX IF EXISTS graph_runs_one_active_canvas;
CREATE INDEX IF NOT EXISTS graph_runs_active_canvas ON graph_runs(tenant_id,canvas_id) WHERE status IN ('queued','running');
