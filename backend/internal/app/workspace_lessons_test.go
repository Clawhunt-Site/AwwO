package app

import (
	"context"
	"strings"
	"testing"
)

func TestWorkspaceLessonRuleIsAwwOsSentenceForNodesLikeIt(t *testing.T) {
	for kind := range lessonKinds {
		rule, own := workspaceLessonRule(kind, "missing_output"), lessonRule(kind, "missing_output")
		if (rule == "") != (own == "") {
			t.Errorf("%s: a node's lesson %q, the workspace's %q", kind, own, rule)
		}
		if rule != "" && !strings.HasPrefix(rule, "Earlier runs of nodes like this one in this workspace") {
			t.Errorf("%s: %q", kind, rule)
		}
	}
	if rule := workspaceLessonRule("delivery", "missing_output"); !strings.Contains(rule, deliveryWords["missing_output"]) || strings.Contains(rule, "%s") {
		t.Fatal(rule)
	}
	if rule := workspaceLessonRule("delivery", "no such reason"); rule != "" {
		t.Fatal(rule)
	}
	if workspaceLessonFingerprint("frontend", "delivery", "a") == workspaceLessonFingerprint("frontend", "delivery", "b") ||
		workspaceLessonFingerprint("frontend", "output_limit", "") == workspaceLessonFingerprint("backend", "output_limit", "") {
		t.Fatal("fingerprints collide")
	}
	if savedNodeTemplate([]byte(`{"nodes":[{"id":"a","templateId":"frontend"},{"id":"b"}]}`), "a") != "frontend" ||
		savedNodeTemplate([]byte(`{"nodes":[{"id":"a","templateId":"frontend"}]}`), "b") != "" || savedNodeTemplate([]byte(`not json`), "a") != "" {
		t.Fatal("the saved node's template")
	}
}

// A node's lesson that helped its runs goes, on a person's word, to every node of its template in the workspace: in
// AwwO's sentence for nodes like it, given to such a node on another canvas, never to a node of another template, and
// not to a node its own lesson of the kind already tells.
func TestPostgresALessonThatHelpedGoesToTheWorkspace(t *testing.T) {
	pi := newLessonPi(t, func(node string, call int) piReply {
		if node == "up" && call == 1 {
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT-" + node}
	})
	h := newHarness(t, pi.server.URL)
	h.a.cfg.GraphNodeRetries = 0
	c, tid, _ := h.register(t, "lessons-workspace@example.test")
	cid := retryCanvas(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	runGraph(t, h, c, base, "workspace-run-1", "failed")
	l := awaitLessons(t, h, tid, cid, "up", func(l []lessonRow) bool { return len(l) == 1 })[0]
	// Too early: it helped no run yet.
	h.request(t, c, "POST", "/tenants/"+tid+"/canvas-lessons/"+l.id+"/promote", map[string]any{}, 409)
	for i := 2; i <= 4; i++ {
		runGraph(t, h, c, base, "workspace-run-"+string(rune('0'+i)), "completed")
	}
	if l = nodeLessons(t, h, tid, cid, "up")[0]; l.succeeded != 3 || l.failed != 0 {
		t.Fatalf("the node's lesson: %+v", l)
	}
	promoted := h.request(t, c, "POST", "/tenants/"+tid+"/canvas-lessons/"+l.id+"/promote", map[string]any{}, 200)
	scope, _ := promoted["scope"].(map[string]any)
	if promoted["canvasId"] != nil || promoted["nodeId"] != nil || promoted["source"] != "person" || promoted["status"] != "active" || scope["templateId"] != "frontend" ||
		promoted["rule"] != workspaceLessonKinds["output_limit"] || promoted["given"] != true {
		t.Fatal("the workspace's lesson", promoted)
	}
	// Again: the same lesson, which names its source once.
	again := h.request(t, c, "POST", "/tenants/"+tid+"/canvas-lessons/"+l.id+"/promote", map[string]any{}, 200)
	if again["id"] != promoted["id"] || len(again["evidence"].([]any)) != 1 {
		t.Fatal("promoted twice", again)
	}
	// The canvas's view marks the node's lesson promoted and lists the workspace's.
	view := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid+"/lessons", nil, 200)["lessons"].([]any)
	var sawWorkspace, sawPromoted bool
	for _, raw := range view {
		item := raw.(map[string]any)
		sawWorkspace = sawWorkspace || (item["id"] == promoted["id"] && item["canvasId"] == nil)
		sawPromoted = sawPromoted || (item["id"] == l.id && item["promoted"] == true && item["nodeTemplate"] == "frontend")
	}
	if !sawWorkspace || !sawPromoted {
		t.Fatal("the canvas's view", view)
	}
	// Another canvas of the workspace: its frontend node is given the workspace's lesson, its other node is not.
	other := retryCanvas(t, h, c, tid)
	runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+other+"/graph-runs", "workspace-other-1", "completed")
	upPrompts, downPrompts := pi.prompts("up"), pi.prompts("down")
	if last := upPrompts[len(upPrompts)-1]; !strings.Contains(last, workspaceLessonKinds["output_limit"]) || strings.Contains(last, lessonKinds["output_limit"].rule) {
		t.Fatal("the other canvas's frontend node was not given the workspace's lesson alone", last)
	}
	if last := downPrompts[len(downPrompts)-1]; strings.Contains(last, lessonsHeading) {
		t.Fatal("a node of no template was given the workspace's lesson", last)
	}
	// The first canvas's node keeps its own lesson of the kind, and is not told twice.
	runGraph(t, h, c, base, "workspace-run-5", "completed")
	upPrompts = pi.prompts("up")
	if last := upPrompts[len(upPrompts)-1]; !strings.Contains(last, lessonKinds["output_limit"].rule) || strings.Contains(last, workspaceLessonKinds["output_limit"]) {
		t.Fatal("the node with its own lesson", last)
	}
	// The workspace's lesson counts the runs it was given.
	var applied, succeeded int
	if err := h.db.QueryRow(context.Background(), "SELECT applied,succeeded FROM canvas_lessons WHERE tenant_id=$1 AND id=$2", tid, promoted["id"]).Scan(&applied, &succeeded); err != nil ||
		applied != 1 || succeeded != 1 {
		t.Fatalf("the workspace's lesson's counts: %d %d %v", applied, succeeded, err)
	}
	// A node whose own lesson of the kind a person retired is given neither: they turned that advice down for it.
	h.request(t, c, "PATCH", "/tenants/"+tid+"/canvas-lessons/"+l.id, map[string]any{"status": "retired"}, 200)
	runGraph(t, h, c, base, "workspace-run-6", "completed")
	upPrompts = pi.prompts("up")
	if last := upPrompts[len(upPrompts)-1]; strings.Contains(last, lessonsHeading) {
		t.Fatal("the node whose own lesson was retired was given the workspace's", last)
	}
	// A node of another template is never given it, beside one of its template that is.
	if _, err := h.db.Exec(context.Background(), `UPDATE canvases SET document=jsonb_set(document,'{nodes}',(SELECT jsonb_agg(CASE WHEN n->>'id'='down'
		THEN n||'{"templateId":"backend"}'::jsonb ELSE n END ORDER BY o) FROM jsonb_array_elements(document->'nodes') WITH ORDINALITY AS x(n,o))) WHERE tenant_id=$1 AND id=$2`, tid, other); err != nil {
		t.Fatal(err)
	}
	runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+other+"/graph-runs", "workspace-other-2", "completed")
	upPrompts, downPrompts = pi.prompts("up"), pi.prompts("down")
	if last := upPrompts[len(upPrompts)-1]; !strings.Contains(last, workspaceLessonKinds["output_limit"]) {
		t.Fatal("the other canvas's frontend node lost the workspace's lesson", last)
	}
	if last := downPrompts[len(downPrompts)-1]; strings.Contains(last, lessonsHeading) {
		t.Fatal("a backend node was given the frontend nodes' lesson", last)
	}
	var template string
	if err := h.db.QueryRow(context.Background(), `SELECT n->>'templateId' FROM graph_runs g, jsonb_array_elements(g.document->'nodes') n
		WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND n->>'id'='down' ORDER BY g.created_at DESC LIMIT 1`, tid, other).Scan(&template); err != nil || template != "backend" {
		t.Fatalf("the run's down node is of template %q: %v", template, err)
	}
	// A lesson of the whole canvas of that kind, though retired, keeps the workspace's from the canvas's nodes as well.
	if _, err := h.db.Exec(context.Background(), `INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,fingerprint,rule,status)
		VALUES('canvas-wide',$1,$2,NULL,'output_limit','canvas-wide','Rule.','retired')`, tid, other); err != nil {
		t.Fatal(err)
	}
	runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+other+"/graph-runs", "workspace-other-3", "completed")
	upPrompts = pi.prompts("up")
	if last := upPrompts[len(upPrompts)-1]; strings.Contains(last, lessonsHeading) {
		t.Fatal("a node of a canvas with its own lesson of the kind was given the workspace's", last)
	}
	// Another workspace can neither promote nor read it.
	o, otherTenant, _ := h.register(t, "lessons-workspace-other@example.test")
	h.request(t, o, "POST", "/tenants/"+otherTenant+"/canvas-lessons/"+l.id+"/promote", map[string]any{}, 404)
}
