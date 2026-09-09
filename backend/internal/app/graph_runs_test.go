package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGraphValidationAndContractTransport(t *testing.T) {
	d := graphDocument{Nodes: []graphNode{{ID: "a", Kind: "form"}, {ID: "b", Kind: "session", Binding: &struct {
		CompanyID string `json:"companyId"`
		AgentID   string `json:"agentId"`
	}{AgentID: "agent"}, Contract: &graphContract{Version: 1, Inputs: []graphField{{ID: "input", Type: "text", Required: true}}, Outputs: []graphField{{ID: "answer", Type: "number", Required: true}}}}}, Edges: []graphEdge{{ID: "edge", FromNode: "a", FromPort: "data", ToNode: "b", ToPort: "in:input", DataType: "text"}}}
	raw, _ := json.Marshal(d)
	if _, _, e := parseGraph(raw, nil); e != nil {
		t.Fatal(e)
	}
	prompt, e := graphPrompt(d.Nodes[1], d, map[string]string{"a": "EXACT-UPSTREAM"})
	if e != nil || !strings.Contains(prompt, "EXACT-UPSTREAM") {
		t.Fatalf("prompt %s %v", prompt, e)
	}
	d.Nodes[1].Contract.Outputs[0].Value = "STALE-SAVED-OUTPUT"
	prompt, e = graphPrompt(d.Nodes[1], d, map[string]string{"a": "EXACT-UPSTREAM"})
	if e != nil || strings.Contains(prompt, "STALE-SAVED-OUTPUT") {
		t.Fatal("stored output leaked into requested schema", prompt, e)
	}
	if _, e = graphOutput(d.Nodes[1], `{"answer":"42"}`); e == nil {
		t.Fatal("accepted string number")
	}
	v, e := graphOutput(d.Nodes[1], "```json\n{\"answer\":42}\n```")
	if e != nil || v["answer"] != "42" {
		t.Fatal(v, e)
	}
	d.Edges = append(d.Edges, graphEdge{ID: "duplicate-input", FromNode: "a", FromPort: "data", ToNode: "b", ToPort: "in:input", DataType: "text"})
	raw, _ = json.Marshal(d)
	if _, _, e = parseGraph(raw, nil); e == nil {
		t.Fatal("accepted multiply wired field")
	}
	d.Edges = d.Edges[:1]
	d.Edges[0].DataType = "number"
	raw, _ = json.Marshal(d)
	if _, _, e = parseGraph(raw, nil); e == nil {
		t.Fatal("accepted incompatible edge")
	}
}

// Seed a committed child whose graph projection has not yet been refreshed. No
// executor is registered: tests can deterministically hit the completion/Stop gap.
func seedUnprojectedGraph(t *testing.T, h *harness, tid, cid, actor string, doc map[string]any, statuses map[string]string) (string, map[string]string) {
	t.Helper()
	ctx := context.Background()
	gid := randomID()
	raw, _ := json.Marshal(doc)
	if _, e := h.db.Exec(ctx, "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES($1,$2,$3,$4,$1,'hash',1,$5,'[\"a\",\"b\",\"merge\"]','running')", gid, tid, cid, actor, raw); e != nil {
		t.Fatal(e)
	}
	ids := map[string]string{}
	for i, value := range doc["nodes"].([]any) {
		n := value.(map[string]any)
		nid, sid := n["id"].(string), randomID()
		aid := n["binding"].(map[string]string)["agentId"]
		if _, e := h.db.Exec(ctx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title) VALUES($1,$2,$3,$4,$5,$4)", sid, tid, cid, nid, aid); e != nil {
			t.Fatal(e)
		}
		state, rid := "waiting", ""
		if status := statuses[nid]; status != "" {
			state, rid = "running", randomID()
			if _, e := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output) VALUES($1,$2,$3,$1,'hash','accepted',$4,$5)", rid, tid, sid, status, "SAVED-"+nid); e != nil {
				t.Fatal(e)
			}
			ids[nid] = rid
		}
		if _, e := h.db.Exec(ctx, "INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,session_id,run_id) VALUES($1,$2,$3,$4,$5,$6,NULLIF($7,''))", tid, gid, nid, i, state, sid, rid); e != nil {
			t.Fatal(e)
		}
	}
	return gid, ids
}

func TestPostgresGraphCancellationPreservesCommittedAndPartialOutputs(t *testing.T) {
	for _, operation := range []bool{false, true} {
		for _, scenario := range []string{"partial", "completed", "invalid-contract"} {
			t.Run(fmt.Sprintf("operation=%t/%s", operation, scenario), func(t *testing.T) {
				h := newHarness(t, "http://127.0.0.1:1")
				c, tid, actor := h.register(t, "cancel-projection@example.test")
				cid, doc := graphFixture(t, h, c, tid)
				statuses := map[string]string{"a": "completed", "b": "completed", "merge": "completed"}
				want := "completed"
				if scenario == "partial" {
					statuses["b"], statuses["merge"], want = "running", "", "cancelled"
				}
				if scenario == "invalid-contract" {
					doc["nodes"].([]any)[0].(map[string]any)["contract"] = graphContract{Version: 1, Outputs: []graphField{{ID: "number", Type: "number", Required: true}}}
					want = "failed"
				}
				gid, _ := seedUnprojectedGraph(t, h, tid, cid, actor, doc, statuses)
				base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
				path := base + "/" + gid + "/cancel"
				if operation {
					path = base + "/operations/" + gid + "/cancel"
				}
				h.request(t, c, "POST", path, map[string]any{}, 200)
				done := awaitGraph(t, h, c, base+"/"+gid, want)
				for _, raw := range done["nodes"].([]any) {
					n := raw.(map[string]any)
					nid := n["nodeId"].(string)
					if statuses[nid] != "" && n["output"] != "SAVED-"+nid {
						t.Fatalf("child output lost: %v", n)
					}
					if statuses[nid] == "completed" && !(scenario == "invalid-contract" && nid == "a") && n["state"] != "done" {
						t.Fatalf("completed child cancelled: %v", n)
					}
				}
			})
		}
	}
}

func TestPostgresGraphSettlesOrphanWithoutProviderReplay(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "UNEXPECTED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, actor := h.register(t, "orphan@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	gid, ids := seedUnprojectedGraph(t, h, tid, cid, actor, doc, map[string]string{"a": "running", "b": "completed"})
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status) VALUES($1,$2,$1,'running')", ids["a"], tid); e != nil {
		t.Fatal(e)
	}
	h.a.dispatchGraph(tid, gid)
	awaitGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs/"+gid, "interrupted")
	var status string
	if e := h.db.QueryRow(ctx, "SELECT status FROM model_invocations WHERE id=$1", ids["a"]).Scan(&status); e != nil || status != "interrupted" || calls.Load() != 0 {
		t.Fatal("orphan quota not settled or paid call repeated", status, calls.Load(), e)
	}
}
func graphFixture(t *testing.T, h *harness, c *http.Cookie, tid string) (string, map[string]any) {
	prefix := "/tenants/" + tid
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Graph worker", "adapterType": "pi", "model": "test-model", "instructions": "ORIGINAL-INSTRUCTIONS"}, 201)["id"].(string)
	nodes := []any{}
	for _, id := range []string{"a", "b", "merge"} {
		nodes = append(nodes, map[string]any{"id": id, "kind": "session", "title": id, "runtime": "pi", "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": agent}})
	}
	doc := map[string]any{"nodes": nodes, "edges": []map[string]string{{"id": "a-m", "fromNode": "a", "fromPort": "result", "toNode": "merge", "toPort": "context", "dataType": "text"}, {"id": "b-m", "fromNode": "b", "fromPort": "result", "toNode": "merge", "toPort": "context", "dataType": "text"}}}
	v := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Graph", "document": doc}, 201)
	return v["id"].(string), doc
}
func awaitGraph(t *testing.T, h *harness, c *http.Cookie, path, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		v := h.request(t, c, "GET", path, nil, 200)
		if v["status"] == want {
			return v
		}
		if v["status"] != "queued" && v["status"] != "running" {
			t.Fatalf("unexpected graph terminal %v", v)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("graph timeout " + want)
	return nil
}
func TestPostgresGraphFanoutFaninDetachedAndImmutable(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	var calls atomic.Int32
	var mu sync.Mutex
	prompts := []string{}
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		mu.Lock()
		prompts = append(prompts, b.Prompt)
		mu.Unlock()
		if !strings.Contains(b.SystemPrompt, "ORIGINAL-INSTRUCTIONS") {
			t.Error("mutable instructions leaked")
		}
		if strings.HasPrefix(b.Prompt, "【工作流节点】merge") {
			if len(b.Messages) != 0 {
				t.Error("post-admission conversation leaked into immutable graph inputs")
			}
			if !strings.Contains(b.Prompt, "RESULT-A") || !strings.Contains(b.Prompt, "RESULT-B") {
				t.Error("merge lacks upstream outputs")
			}
			completePi(w, "MERGED")
			return
		}
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		if strings.HasPrefix(b.Prompt, "【工作流节点】a") {
			completePi(w, "RESULT-A")
		} else {
			completePi(w, "RESULT-B")
		}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "graph@example.test")
	other, tb, _ := h.register(t, "graph-other@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	body := map[string]any{"operationId": "graph-operation", "documentVersion": 1}
	v := h.request(t, c, "POST", base, body, 202)
	gid := v["id"].(string)
	path := base + "/" + gid
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("fanout did not run concurrently")
		}
	}
	h.request(t, c, "POST", base, body, 200)
	h.request(t, c, "POST", base, map[string]any{"operationId": "another-operation"}, 409)
	h.request(t, c, "POST", base, map[string]any{"operationId": "graph-operation", "scope": []string{"a"}}, 409)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/"+cid, nil, 409)
	doc["nodes"].([]any)[2].(map[string]any)["title"] = "MUTATED"
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": "Edited", "document": doc, "version": 1}, 200)
	agentID := doc["nodes"].([]any)[2].(map[string]any)["binding"].(map[string]string)["agentId"]
	h.request(t, c, "PUT", "/tenants/"+tid+"/agents/"+agentID+"/instructions", map[string]string{"content": "MUTATED-INSTRUCTIONS"}, 200)
	for _, raw := range v["nodes"].([]any) {
		node := raw.(map[string]any)
		if node["nodeId"] != "merge" {
			continue
		}
		sid := node["sessionId"].(string)
		rid := randomID()
		ctx := context.Background()
		if _, e := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,'later-conversation','hash','LATE-USER','completed')", rid, tid, sid); e != nil {
			t.Fatal(e)
		}
		for _, role := range []string{"user", "assistant"} {
			if _, e := h.db.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,$5,'LATE-CONTENT')", randomID(), tid, sid, rid, role); e != nil {
				t.Fatal(e)
			}
		}
	}
	close(release)
	done := awaitGraph(t, h, c, path, "completed")
	if calls.Load() != 3 {
		t.Fatalf("calls %d", calls.Load())
	}
	nodes := done["nodes"].([]any)
	for _, raw := range nodes {
		node := raw.(map[string]any)
		if node["state"] != "done" || node["runId"] == nil || node["sessionId"] == nil {
			t.Fatal(node)
		}
	}
	if done["documentVersion"] != float64(1) || done["document"].(map[string]any)["nodes"].([]any)[2].(map[string]any)["title"] != "merge" {
		t.Fatal("graph snapshot mutated")
	}
	lookup := h.request(t, c, "GET", base+"?operationId=graph-operation", nil, 200)
	if len(lookup["items"].([]any)) != 1 {
		t.Fatal(lookup)
	}
	h.request(t, other, "GET", path, nil, 404)
	h.request(t, other, "GET", "/tenants/"+tb+"/canvases/"+cid+"/graph-runs/"+gid, nil, 404)
	// Reuse the accepted sessions only as an explicit new request, never by replaying old IDs.
	h.request(t, c, "POST", base, body, 200)
	if calls.Load() != 3 {
		t.Fatal("completed replay redispatched")
	}
}
func TestPostgresGraphScopeCancellationAndTombstone(t *testing.T) {
	var calls atomic.Int32
	entered := make(chan struct{}, 8)
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		entered <- struct{}{}
		<-r.Context().Done()
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "graph-cancel@example.test")
	reader, _, _ := h.register(t, "graph-reader@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	h.request(t, c, "POST", "/tenants/"+tid+"/members", map[string]string{"email": "graph-reader@example.test", "role": "reader"}, 201)
	opURL := base + "/operations/not-yet-created/cancel"
	h.request(t, reader, "POST", opURL, map[string]any{}, 403)
	cancel := h.request(t, c, "POST", opURL, map[string]any{}, 200)
	if cancel["confirmed"] != true || cancel["status"] != "cancelled" {
		t.Fatal(cancel)
	}
	h.request(t, c, "POST", base, map[string]string{"operationId": "not-yet-created"}, 409)
	if calls.Load() != 0 {
		t.Fatal("tombstone invoked provider")
	}
	// Scope-only merge with absent cached upstream must block without charging any call.
	v := h.request(t, c, "POST", base, map[string]any{"operationId": "missing-cached-operation", "scope": []string{"merge"}}, 202)
	done := awaitGraph(t, h, c, base+"/"+v["id"].(string), "failed")
	if calls.Load() != 0 {
		t.Fatal("missing cache invoked provider")
	}
	if len(done["nodes"].([]any)) != 3 {
		t.Fatal("cache dependency status missing")
	}
	for _, raw := range doc["nodes"].([]any) {
		n := raw.(map[string]any)
		n["lastOutput"] = map[string]any{"text": "CACHE-" + n["id"].(string), "source": "manual", "at": 1}
	}
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": "Cached", "document": doc, "version": 1}, 200)
	v = h.request(t, c, "POST", base, map[string]any{"operationId": "cancel-accepted-operation", "scope": []string{"merge"}}, 202)
	gid := v["id"].(string)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("no merge invocation")
	}
	cancel = h.request(t, c, "POST", base+"/operations/cancel-accepted-operation/cancel", map[string]any{}, 200)
	if cancel["graphId"] != gid || cancel["confirmed"] != true {
		t.Fatal(cancel)
	}
	awaitGraph(t, h, c, base+"/"+gid, "cancelled")
	h.request(t, c, "POST", base, map[string]any{"operationId": "cancel-accepted-operation", "scope": []string{"merge"}}, 409)
	time.Sleep(100 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatal("cancelled operation redispatched")
	}
}
func TestPostgresGraphRestartResumesWaitingWithoutDuplicatingAccepted(t *testing.T) {
	for _, acceptedStatus := range []string{"running", "completed"} {
		t.Run(acceptedStatus, func(t *testing.T) {
			var calls atomic.Int32
			pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
				calls.Add(1)
				completePi(w, "RESTORED")
			})
			defer pi.Close()
			h := newHarness(t, pi.URL)
			c, tid, actor := h.register(t, "graph-restart@example.test")
			cid, doc := graphFixture(t, h, c, tid)
			h.server.Close()
			h.a.Close()
			ctx := context.Background()
			gid := randomID()
			raw, _ := json.Marshal(doc)
			scope, _ := json.Marshal([]string{"a", "b", "merge"})
			_, e := h.db.Exec(ctx, "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES($1,$2,$3,$4,'restart-operation','hash',1,$5,$6,'running')", gid, tid, cid, actor, raw, scope)
			if e != nil {
				t.Fatal(e)
			}
			for i, nraw := range doc["nodes"].([]any) {
				n := nraw.(map[string]any)
				nid := n["id"].(string)
				sid := randomID()
				aid := n["binding"].(map[string]string)["agentId"]
				_, e = h.db.Exec(ctx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title) VALUES($1,$2,$3,$4,$5,$4)", sid, tid, cid, nid, aid)
				if e != nil {
					t.Fatal(e)
				}
				snap, _ := json.Marshal(executionSnapshot{Instructions: "ORIGINAL-INSTRUCTIONS", Model: "test-model", Budget: 262144, Health: piHealth{Model: "test-model"}})
				state, rid := "waiting", ""
				if nid == "a" {
					state, rid = "running", randomID()
					_, e = h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output) VALUES($1,$2,$3,'accepted-before-crash','hash','accepted',$4,'PREVIOUS-RESULT')", rid, tid, sid, acceptedStatus)
					if e != nil {
						t.Fatal(e)
					}
				}
				_, e = h.db.Exec(ctx, "INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,session_id,run_id,execution_snapshot) VALUES($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8)", tid, gid, nid, i, state, sid, rid, snap)
				if e != nil {
					t.Fatal(e)
				}
			}
			h.a = New(h.db, h.cfg)
			h.a.cfg.PIURL = pi.URL
			if e = h.a.Start(ctx); e != nil {
				t.Fatal(e)
			}
			h.server = httptest.NewServer(h.a.Handler())
			base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs/" + gid
			want := "interrupted"
			if acceptedStatus == "completed" {
				want = "completed"
			}
			done := awaitGraph(t, h, c, base, want)
			states := map[string]string{}
			for _, raw := range done["nodes"].([]any) {
				n := raw.(map[string]any)
				states[n["nodeId"].(string)] = n["state"].(string)
			}
			if acceptedStatus == "completed" {
				if states["a"] != "done" || states["b"] != "done" || states["merge"] != "done" || calls.Load() != 2 {
					t.Fatalf("completed dependency replay states=%v calls=%d", states, calls.Load())
				}
			} else if states["a"] != "failed" || states["b"] != "done" || states["merge"] != "blocked" || calls.Load() != 1 {
				t.Fatalf("restart states=%v calls=%d", states, calls.Load())
			}
		})
	}
}
func TestPostgresGraphRejectsForgedBindingsAndMembers(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		t.Error("invalid graph reached model")
		completePi(w, "x")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "graph-forge@example.test")
	other, tb, _ := h.register(t, "graph-forge-other@example.test")
	_, foreignAgent, _ := h.fixture(t, other, tb)
	cid, doc := graphFixture(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid
	version := 1
	tests := []struct {
		name   string
		change func(map[string]any)
		status int
	}{{"foreign-binding", func(n map[string]any) { n["binding"] = map[string]string{"companyId": tb, "agentId": foreignAgent} }, 404}, {"unknown-member-model", func(n map[string]any) {
		team := fixtureTeam("sequential")
		team.Members[0].Model = "hidden-other-tenant-model"
		n["team"] = team
	}, 400}, {"tools", func(n map[string]any) {
		team := fixtureTeam("sequential")
		team.Members[0].Tools = []string{"shell"}
		n["team"] = team
	}, 400}, {"runtime", func(n map[string]any) { team := fixtureTeam("sequential"); team.Runtime = "other"; n["team"] = team }, 400}}
	original := doc["nodes"].([]any)[0].(map[string]any)["binding"]
	for _, test := range tests {
		n := doc["nodes"].([]any)[0].(map[string]any)
		n["binding"] = original
		delete(n, "team")
		test.change(n)
		h.request(t, c, "PUT", base, map[string]any{"name": test.name, "document": doc, "version": version}, 200)
		version++
		h.request(t, c, "POST", base+"/graph-runs", map[string]string{"operationId": "invalid-" + test.name}, test.status)
	}
	var count int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM graph_runs WHERE tenant_id=$1", tid).Scan(&count); e != nil || count != 0 {
		t.Fatal("invalid graph admission persisted", count, e)
	}
}

func TestPostgresGraphConcurrentAdmissionCancellation(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { <-r.Context().Done() })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "graph-cancel-race@example.test")
	cid, _ := graphFixture(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	for i := 0; i < 5; i++ {
		op := fmt.Sprintf("race-operation-%d", i)
		start := make(chan struct{})
		var wg sync.WaitGroup
		var createCode int
		var postErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			raw, _ := json.Marshal(map[string]string{"operationId": op})
			req, _ := http.NewRequest("POST", h.server.URL+"/api/v1"+base, strings.NewReader(string(raw)))
			req.AddCookie(c)
			req.Header.Set("Origin", h.cfg.PublicOrigin)
			req.Header.Set("Content-Type", "application/json")
			resp, e := http.DefaultClient.Do(req)
			if e != nil {
				postErr = e
				return
			}
			createCode = resp.StatusCode
			resp.Body.Close()
		}()
		go func() {
			defer wg.Done()
			<-start
			h.request(t, c, "POST", base+"/operations/"+op+"/cancel", map[string]any{}, 200)
		}()
		close(start)
		wg.Wait()
		if postErr != nil || (createCode != 202 && createCode != 409) {
			t.Fatalf("race create status=%d error=%v", createCode, postErr)
		}
		h.request(t, c, "POST", base, map[string]string{"operationId": op}, 409)
		v := h.request(t, c, "GET", base+"?operationId="+op, nil, 200)
		for _, raw := range v["items"].([]any) {
			if raw.(map[string]any)["status"] != "cancelled" {
				t.Fatal("cancelled operation left active graph", raw)
			}
		}
	}
}
