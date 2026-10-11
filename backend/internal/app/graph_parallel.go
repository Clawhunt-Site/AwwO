package app

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// graphAdmissionConflict reports whether a new graph executing `scope` would collide with a graph already queued or
// running on the canvas. Graphs that execute different nodes run side by side: running one component never holds
// the rest of the canvas. A collaboration graph (new or active) still runs alone, because its rounds read every
// selected node's latest output. The caller holds the canvas row lock, so concurrent admissions are serialized.
func graphAdmissionConflict(ctx context.Context, tx pgx.Tx, tid, cid string, scope []string, collaboration bool) (bool, error) {
	rows, e := tx.Query(ctx, "SELECT scope, collaboration IS NOT NULL FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND status IN ('queued','running')", tid, cid)
	if e != nil {
		return false, e
	}
	defer rows.Close()
	executing := make(map[string]bool, len(scope))
	for _, id := range scope {
		executing[id] = true
	}
	for rows.Next() {
		var raw []byte
		var activeCollaboration bool
		if e = rows.Scan(&raw, &activeCollaboration); e != nil {
			return false, e
		}
		if collaboration || activeCollaboration {
			return true, nil
		}
		var active []string
		if json.Unmarshal(raw, &active) != nil {
			// A scope this code cannot read is treated as the whole canvas.
			return true, nil
		}
		for _, id := range active {
			if executing[id] {
				return true, nil
			}
		}
	}
	return false, rows.Err()
}

// initializationConflict reports whether preparing `scope` (node ids) would touch work in progress: a run of one of
// those nodes' sessions, or an active graph that executes one of them (or any collaboration graph). Without a scope
// the whole canvas is prepared, and any active run on it conflicts, as before parallel runs.
func initializationConflict(ctx context.Context, tx pgx.Tx, tid, cid string, scope []string) (bool, error) {
	var busy bool
	if len(scope) == 0 {
		e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM node_sessions s JOIN runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.id WHERE s.tenant_id=$1 AND s.canvas_id=$2 AND r.status IN ('queued','running')) OR EXISTS(SELECT 1 FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND status IN ('queued','running'))", tid, cid).Scan(&busy)
		return busy, e
	}
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM node_sessions s JOIN runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.id WHERE s.tenant_id=$1 AND s.canvas_id=$2 AND s.node_id=ANY($3::text[]) AND r.status IN ('queued','running')) OR EXISTS(SELECT 1 FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.status IN ('queued','running') AND (g.collaboration IS NOT NULL OR g.scope ?| $3::text[]))", tid, cid, scope).Scan(&busy)
	return busy, e
}
