package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Running one component never holds the rest of the canvas: a graph that executes other nodes is admitted and
// finishes while the first is still working; a graph that would execute a node already running is refused; a
// collaboration graph still runs alone; and preparing (initializing) a node waits only for work on that node.
func TestPostgresGraphParallelDisjointScopes(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		if strings.HasPrefix(b.Prompt, "【工作流节点】a") {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			completePi(w, "RESULT-A")
			return
		}
		completePi(w, "RESULT-OTHER")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, actor := h.register(t, "parallel-graphs@example.test")
	cid, _ := graphFixture(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"

	first := h.request(t, c, "POST", base, map[string]any{"operationId": "parallel-a-0001", "scope": []string{"a"}, "documentVersion": 1}, 202)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("first graph did not start")
	}
	// Another component of the same canvas runs and finishes while a is still working.
	second := h.request(t, c, "POST", base, map[string]any{"operationId": "parallel-b-0001", "scope": []string{"b"}, "documentVersion": 1}, 202)
	done := awaitGraph(t, h, c, base+"/"+second["id"].(string), "completed")
	for _, raw := range done["nodes"].([]any) {
		if node := raw.(map[string]any); node["nodeId"] == "b" && (node["state"] != "done" || node["output"] != "RESULT-OTHER") {
			t.Fatalf("parallel graph did not deliver b: %v", node)
		}
	}
	if status := h.request(t, c, "GET", base+"/"+first["id"].(string), nil, 200)["status"]; status != "running" && status != "queued" {
		t.Fatalf("first graph should still be running, got %v", status)
	}
	// A graph that would execute a again (alone, or as part of the whole canvas) waits for it.
	requireCode(t, h.request(t, c, "POST", base, map[string]any{"operationId": "parallel-a-0002", "scope": []string{"a"}}, 409), "graph_busy")
	requireCode(t, h.request(t, c, "POST", base, map[string]any{"operationId": "parallel-all-001"}, 409), "graph_busy")

	// Preparing b is allowed while a runs; preparing a (or the whole canvas) is not.
	canvas := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid, nil, 200)
	version := canvas["version"]
	requireCode(t, h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": version}, 409), "resource_in_use")
	requireCode(t, h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": version, "scope": []string{"a"}}, 409), "resource_in_use")
	h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": version, "scope": []string{"b"}}, 200)

	close(release)
	awaitGraph(t, h, c, base+"/"+first["id"].(string), "completed")

	// A collaboration graph runs alone: while one is active nothing else is admitted.
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status,collaboration) VALUES($1,$2,$3,$4,$1,'hash',1,'{}','[\"merge\"]','running','{\"rounds\":1}')", randomID(), tid, cid, actor); e != nil {
		t.Fatal(e)
	}
	current := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid, nil, 200)["version"]
	requireCode(t, h.request(t, c, "POST", base, map[string]any{"operationId": "parallel-b-0002", "scope": []string{"b"}, "documentVersion": current}, 409), "graph_busy")
}
