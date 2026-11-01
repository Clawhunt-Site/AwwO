package app

import (
	"context"
	"testing"
)

// A canvas that has run as a whole graph keeps graph_run_nodes and
// graph_collaboration_turns rows that point at its node sessions and runs
// through foreign keys without an ON DELETE action. Deleting such a canvas
// answered 500 "Could not complete the request": the cascade from canvases
// reached node_sessions and runs while those rows still referenced them.
func TestPostgresCanvasDeleteAfterGraphRun(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, uid := h.register(t, "graph-delete-owner@example.test")
	canvas, _, sid := h.fixture(t, owner, tid)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES('gd-run',$1,$2,'gd-run','hash','Draft the brief','completed')`, tid, sid)
	exec(`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES('gd-review',$1,$2,'gd-review','hash','Review the brief','completed')`, tid, sid)
	exec(`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES('gd-graph',$1,$2,$3,'gd-graph','hash',1,'{}','["node-a"]','completed')`, tid, canvas, uid)
	exec(`INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,session_id,run_id) VALUES($1,'gd-graph','node-a',0,'done',$2,'gd-run')`, tid, sid)
	exec(`INSERT INTO graph_collaboration_turns(tenant_id,graph_id,ordinal,node_id,phase,round,state,run_id) VALUES($1,'gd-graph',1,'node-a','review',1,'completed','gd-review')`, tid)
	// The lesson its runs taught its node (migration 048 keys it to the canvas), another canvas's, and the workspace's own.
	exec(`INSERT INTO canvases(id,tenant_id,name) VALUES('gd-other',$1,'Other canvas')`, tid)
	exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,fingerprint,rule,status) VALUES
		('gd-lesson',$1,$2,'node-a','output_limit','gd-lesson','Rule.','active'),('gd-other-lesson',$1,'gd-other','node-a','output_limit','gd-other-lesson','Rule.','active')`, tid, canvas)
	exec(`INSERT INTO canvas_lessons(id,tenant_id,kind,rule,status) VALUES('gd-workspace-lesson',$1,'output_limit','Rule.','active')`, tid)
	lessons := func() string {
		t.Helper()
		var ids string
		if err := h.db.QueryRow(ctx, `SELECT COALESCE(string_agg(id,',' ORDER BY id),'') FROM canvas_lessons WHERE tenant_id=$1`, tid).Scan(&ids); err != nil {
			t.Fatal(err)
		}
		return ids
	}

	path := "/tenants/" + tid + "/canvases/" + canvas
	// An active graph run still refuses the delete and removes nothing.
	exec(`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES('gd-active',$1,$2,$3,'gd-active','hash',1,'{}','["node-a"]','running')`, tid, canvas, uid)
	requireCode(t, h.request(t, owner, "DELETE", path, nil, 409), "resource_in_use")
	var kept int
	if err := h.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM graph_runs WHERE canvas_id=$1)+(SELECT count(*) FROM graph_run_nodes WHERE graph_id='gd-graph')+(SELECT count(*) FROM graph_collaboration_turns WHERE graph_id='gd-graph')`, canvas).Scan(&kept); err != nil || kept != 4 {
		t.Fatal("refused delete changed graph history", err, kept)
	}
	if got := lessons(); got != "gd-lesson,gd-other-lesson,gd-workspace-lesson" {
		t.Fatal("refused delete changed the lessons", got)
	}
	exec(`UPDATE graph_runs SET status='completed' WHERE id='gd-active'`)

	h.request(t, owner, "DELETE", path, nil, 204)
	h.request(t, owner, "GET", path, nil, 404)
	var graphs, nodes, turns, sessions, runs, audits int
	if err := h.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM graph_runs WHERE canvas_id=$1),
		(SELECT count(*) FROM graph_run_nodes WHERE graph_id IN ('gd-graph','gd-active')),
		(SELECT count(*) FROM graph_collaboration_turns WHERE graph_id='gd-graph'),
		(SELECT count(*) FROM node_sessions WHERE canvas_id=$1),
		(SELECT count(*) FROM runs WHERE id IN ('gd-run','gd-review')),
		(SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='canvas.deleted')`, canvas).Scan(&graphs, &nodes, &turns, &sessions, &runs, &audits); err != nil || graphs+nodes+turns+sessions+runs != 0 || audits != 1 {
		t.Fatal("canvas deletion contract", err, graphs, nodes, turns, sessions, runs, audits)
	}
	if got := lessons(); got != "gd-other-lesson,gd-workspace-lesson" {
		t.Fatal("the lessons a deleted canvas left, or took from elsewhere", got)
	}
}
