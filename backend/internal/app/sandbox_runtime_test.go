package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The sandbox computer is an OpenAI Agents worker in project-execution mode, chosen node by node: its models become the
// sandbox runtime's, a worker that cannot open a sandbox does not serve it, and the run request still names the
// worker's own runtime.
func TestSandboxRuntimeIsServedOnlyByAWorkspaceWorker(t *testing.T) {
	withWorkspace := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { workspaceHealthWithLimit(w, 8) }))
	defer withWorkspace.Close()
	textOnly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "fixture", "models": []map[string]any{{"id": "test-model", "runtime": runtimeOpenAIAgents, "maxContextTextBytes": 262144}}})
	}))
	defer textOnly.Close()
	cfg := testConfig()
	cfg.OpenAIAgentsURL, cfg.OpenAIAgentsToken = withWorkspace.URL, strings.Repeat("o", 32)
	cfg.SandboxAgentsURL, cfg.SandboxAgentsToken = withWorkspace.URL, strings.Repeat("s", 32)
	cfg.WorkspaceCallbackURL = "http://127.0.0.1:8087/api/internal/workspace-calls"
	a := New(nil, cfg)
	h, err := a.probeRuntime(context.Background(), runtimeSandbox)
	if err != nil || len(h.Models) != 1 || h.Models[0].Runtime != runtimeSandbox || h.Workspace == nil {
		t.Fatalf("sandbox catalogue %+v %v", h, err)
	}
	entitlement, _ := newModelEntitlement(false, nil)
	sandbox, err := a.runtimeSnapshot(context.Background(), entitlement, runtimeCatalog{}, runtimeSandbox, "test-model", "", "Build.", nil)
	if err != nil || sandbox.Workspace == nil || a.requireWorkspaceSnapshot(sandbox) != nil {
		t.Fatalf("sandbox node got no sandbox: %+v %v", sandbox.Workspace, err)
	}
	// With a sandbox worker configured, a plain openai-agents node stays a single call even on a worker that could open
	// a sandbox, and is never refused for lacking one.
	plain, err := a.runtimeSnapshot(context.Background(), entitlement, runtimeCatalog{}, runtimeOpenAIAgents, "test-model", "", "Answer.", nil)
	if err != nil || plain.Workspace != nil || a.requireWorkspaceSnapshot(plain) != nil {
		t.Fatalf("plain node was moved into a sandbox: %+v %v", plain.Workspace, err)
	}
	if workerRuntime(runtimeSandbox) != runtimeOpenAIAgents || workerRuntime("") != runtimeOpenAIAgents || workerRuntime(runtimePI) != runtimePI {
		t.Fatal("worker runtime mapping")
	}
	if !validRuntime(runtimeSandbox) || validRuntime("sandbox ") {
		t.Fatal("sandbox runtime id")
	}
	a.cfg.SandboxAgentsURL = textOnly.URL
	if _, err = a.probeRuntime(context.Background(), runtimeSandbox); err == nil {
		t.Fatal("a worker without a sandbox served the sandbox runtime")
	}
	a.cfg.SandboxAgentsURL = ""
	if _, _, err = a.runtimeEndpoint(runtimeSandbox); err == nil {
		t.Fatal("an unconfigured sandbox had an endpoint")
	}
	// Without a sandbox worker, project execution keeps its old meaning: the openai-agents worker runs every node so.
	legacy, err := a.runtimeSnapshot(context.Background(), entitlement, runtimeCatalog{}, runtimeOpenAIAgents, "test-model", "", "Answer.", nil)
	if err != nil || legacy.Workspace == nil {
		t.Fatalf("legacy project execution changed: %+v %v", legacy.Workspace, err)
	}
}

func TestSandboxRuntimeConfiguration(t *testing.T) {
	base := func() Config {
		c := testConfig()
		c.Env = "development"
		return c
	}
	cases := map[string]func(*Config){
		"url without token": func(c *Config) { c.SandboxAgentsURL = "http://127.0.0.1:8098" },
		"token without url": func(c *Config) { c.SandboxAgentsToken = strings.Repeat("s", 32) },
		"short token":       func(c *Config) { c.SandboxAgentsURL, c.SandboxAgentsToken = "http://127.0.0.1:8098", "short" },
		"no callback": func(c *Config) {
			c.SandboxAgentsURL, c.SandboxAgentsToken = "http://127.0.0.1:8098", strings.Repeat("s", 32)
		},
		"credentials in the url": func(c *Config) {
			c.SandboxAgentsURL, c.SandboxAgentsToken, c.WorkspaceCallbackURL = "http://u@127.0.0.1:8098", strings.Repeat("s", 32), "http://127.0.0.1:8087/api/internal/workspace-calls"
		},
	}
	for name, edit := range cases {
		c := base()
		edit(&c)
		if c.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	c := base()
	c.SandboxAgentsURL, c.SandboxAgentsToken, c.WorkspaceCallbackURL = "http://127.0.0.1:8098", strings.Repeat("s", 32), "http://127.0.0.1:8087/api/internal/workspace-calls"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

// A sandbox node's run goes to the sandbox worker in project-execution mode, naming the worker's own runtime, while a
// plain openai-agents node on the same API still goes to its own worker as one call.
func TestPostgresSandboxNodeRunsInItsWorkerAndPlainNodesStayPlain(t *testing.T) {
	snapshot := workspaceFixtureSnapshot(t)
	var sandboxRuns, plainRuns atomic.Int32
	sandboxWorker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			workspaceHealthWithLimit(w, 4)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var request struct {
			Runtime   string           `json:"runtime"`
			Workspace workspaceRequest `json:"workspace"`
		}
		if e := json.NewDecoder(r.Body).Decode(&request); e != nil || request.Runtime != runtimeOpenAIAgents || request.Workspace.MaxModelCalls != 4 {
			t.Errorf("sandbox worker request runtime %q budget %d %v", request.Runtime, request.Workspace.MaxModelCalls, e)
			w.WriteHeader(400)
			return
		}
		sandboxRuns.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		callbackRequest(t, request.Workspace, map[string]any{"operation": "admit", "index": 1}, 200)
		callbackRequest(t, request.Workspace, map[string]any{"operation": "settle", "index": 1, "status": "completed", "observability": json.RawMessage(observationFixture(3, 4))}, 200)
		fmt.Fprint(w, "data: {\"type\":\"workspace_activity\",\"step\":1,\"tool\":\"workspace_exec\"}\n\n")
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": "Tests pass.", "workspaceSnapshot": snapshot})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	defer sandboxWorker.Close()
	plainWorker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "fixture", "models": []map[string]any{{"id": "test-model", "runtime": runtimeOpenAIAgents, "maxContextTextBytes": 262144, "messageOverheadBytes": 32}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var request map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&request)
		if _, has := request["workspace"]; has {
			t.Error("a plain node was sent a workspace")
		}
		plainRuns.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		completePi(w, "One answer.")
	}))
	defer plainWorker.Close()
	h := newHarness(t, plainWorker.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = plainWorker.URL, strings.Repeat("o", 32)
	h.a.cfg.SandboxAgentsURL, h.a.cfg.SandboxAgentsToken = sandboxWorker.URL, strings.Repeat("s", 32)
	h.a.cfg.WorkspaceCallbackURL = h.server.URL + "/api/internal/workspace-calls"
	c, tid, _ := h.register(t, "sandbox-runtime@example.test")
	ctx := context.Background()
	runOn := func(runtime, operation string) map[string]any {
		cid, aid, sid := h.fixture(t, c, tid)
		if _, e := h.db.Exec(ctx, `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,runtime}',to_jsonb($2::text)) WHERE id=$1`, cid, runtime); e != nil {
			t.Fatal(e)
		}
		if _, e := h.db.Exec(ctx, "UPDATE agents SET runtime=$2 WHERE id=$1", aid, runtime); e != nil {
			t.Fatal(e)
		}
		run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "go", "operationId": operation}, 202)
		return h.awaitRun(t, c, tid, run["id"].(string), "completed")
	}
	sandbox := runOn(runtimeSandbox, "sandbox-operation")
	if sandbox["executionKind"] != "workspace" || sandboxRuns.Load() != 1 || plainRuns.Load() != 0 {
		t.Fatalf("sandbox run: kind %v, sandbox %d, plain %d", sandbox["executionKind"], sandboxRuns.Load(), plainRuns.Load())
	}
	plain := runOn(runtimeOpenAIAgents, "plain-operation")
	if plain["executionKind"] != "text" || sandboxRuns.Load() != 1 || plainRuns.Load() != 1 {
		t.Fatalf("plain run: kind %v, sandbox %d, plain %d", plain["executionKind"], sandboxRuns.Load(), plainRuns.Load())
	}
	var priced int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND status='completed'", tid).Scan(&priced); e != nil || priced != 2 {
		t.Fatalf("model calls accounted %d %v", priced, e)
	}
}

// A sandbox run whose worker has every slot taken waits in line for one (2026-10-17: twenty builders found eight slots
// and twelve failed at once): the worker's 429 or 503 is asked again until a slot frees, a wait that runs out fails as
// workspace_busy (which a canvas node retries, since nothing ran), and any other refusal still ends the run at once.
func TestPostgresSandboxRunWaitsInLineForASlot(t *testing.T) {
	waitWas, pollWas := workspaceQueueWait, workspaceQueuePoll
	workspaceQueueWait, workspaceQueuePoll = 5*time.Second, 20*time.Millisecond
	defer func() { workspaceQueueWait, workspaceQueuePoll = waitWas, pollWas }()
	snapshot := workspaceFixtureSnapshot(t)
	var admissions, busyFor atomic.Int32
	var refuse atomic.Int32 // a status the worker answers every admission with; 0 answers busyFor 429s, then runs
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			workspaceHealthWithLimit(w, 4)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var request struct {
			Workspace workspaceRequest `json:"workspace"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		n := admissions.Add(1)
		if code := refuse.Load(); code != 0 {
			writeJSON(w, int(code), map[string]any{"error": map[string]string{"code": "WORKER_BUSY"}})
			return
		}
		if n <= busyFor.Load() {
			writeJSON(w, 429, map[string]any{"error": map[string]string{"code": "WORKER_BUSY"}})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		callbackRequest(t, request.Workspace, map[string]any{"operation": "admit", "index": 1}, 200)
		callbackRequest(t, request.Workspace, map[string]any{"operation": "settle", "index": 1, "status": "completed", "observability": json.RawMessage(observationFixture(3, 4))}, 200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": "Tests pass.", "workspaceSnapshot": snapshot})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	h.a.cfg.SandboxAgentsURL, h.a.cfg.SandboxAgentsToken = worker.URL, strings.Repeat("s", 32)
	h.a.cfg.WorkspaceCallbackURL = h.server.URL + "/api/internal/workspace-calls"
	c, tid, _ := h.register(t, "sandbox-queue@example.test")
	ctx := context.Background()
	start := func(operation string) string {
		cid, aid, sid := h.fixture(t, c, tid)
		if _, e := h.db.Exec(ctx, `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,runtime}',to_jsonb($2::text)) WHERE id=$1`, cid, runtimeSandbox); e != nil {
			t.Fatal(e)
		}
		if _, e := h.db.Exec(ctx, "UPDATE agents SET runtime=$2 WHERE id=$1", aid, runtimeSandbox); e != nil {
			t.Fatal(e)
		}
		return h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "go", "operationId": operation}, 202)["id"].(string)
	}
	events := func(id string) string {
		var types string
		if e := h.db.QueryRow(ctx, "SELECT COALESCE(string_agg(data->>'type',',' ORDER BY id),'') FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND data->>'type' LIKE 'workspace_%'", tid, id).Scan(&types); e != nil {
			t.Fatal(e)
		}
		return types
	}

	// Two busy answers, then a slot: the run waits and completes.
	busyFor.Store(2)
	id := start("queued-then-runs")
	if status, code := awaitRunRow(t, h, tid, id, "completed", "failed"); status != "completed" || admissions.Load() != 3 {
		t.Fatalf("a run that waited for a slot: %s %s after %d admissions", status, code, admissions.Load())
	}
	if got := events(id); got != "workspace_queued,workspace_started" {
		t.Fatal("events", got)
	}

	// Busy for longer than the wait: workspace_busy, which a canvas node retries.
	workspaceQueueWait = 300 * time.Millisecond
	admissions.Store(0)
	refuse.Store(429)
	if _, code := awaitRunRow(t, h, tid, start("busy-all-along"), "failed"); code != "workspace_busy" || admissions.Load() < 3 {
		t.Fatalf("a wait that ran out: %s after %d admissions", code, admissions.Load())
	}
	if graphRetryableCodes["workspace_busy"] != retryUnsent {
		t.Fatal("workspace_busy is not retried as unsent")
	}

	// Any other refusal ends the run at once, as before.
	admissions.Store(0)
	refuse.Store(400)
	if _, code := awaitRunRow(t, h, tid, start("refused-at-once"), "failed"); code != "workspace_runtime_rejected" || admissions.Load() != 1 {
		t.Fatalf("a refusal: %s after %d admissions", code, admissions.Load())
	}
}

// A case canvas is set up the way a member's copy is (POST /initialize): its sandbox node gets an Agent on the sandbox
// runtime and its assemble node, which has no Agent, is left as it is.
func TestPostgresInitializeSetsUpASandboxNodeAndLeavesAnAssembleNode(t *testing.T) {
	sandboxWorker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { workspaceHealthWithLimit(w, 8) }))
	defer sandboxWorker.Close()
	h := newHarness(t, "")
	h.a.cfg.SandboxAgentsURL, h.a.cfg.SandboxAgentsToken = sandboxWorker.URL, strings.Repeat("s", 32)
	h.a.cfg.WorkspaceCallbackURL = h.server.URL + "/api/internal/workspace-calls"
	c, tid, _ := h.register(t, "sandbox-initialize@example.test")
	page := map[string]any{"id": "page", "kind": "assemble", "title": "Page", "template": "<!DOCTYPE html><html><body>{{in:code}}</body></html>", "fileName": "page.html",
		"contract": graphContract{Version: 1, Inputs: []graphField{{ID: "code", Label: "Code", Type: "text", Required: true}}, Outputs: []graphField{{ID: "file", Label: "Page", Type: "file", Required: true}}}}
	test := map[string]any{"id": "test", "kind": "session", "agentKind": "coding", "title": "Test and fix", "runtime": runtimeSandbox, "model": "test-model", "persona": "Test the page.", "effort": "", "binding": nil, "issueId": nil, "preview": "", "threads": []any{},
		"contract": graphContract{Version: 1, Inputs: []graphField{{ID: "page", Label: "Page", Type: "file", Required: true}}, Outputs: []graphField{{ID: "result", Label: "Page", Type: "html", Required: true}}}}
	doc := map[string]any{"nodes": []any{page, test}, "edges": []map[string]string{{"id": "e1", "fromNode": "page", "fromPort": "out:file", "toNode": "test", "toPort": "in:page", "dataType": "file"}}}
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Sandbox setup", "document": doc}, 201)["id"].(string)
	v := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	assembled, tester := setupNodeAt(v, 0), setupNodeAt(v, 1)
	if assembled["kind"] != "assemble" || assembled["binding"] != nil || assembled["template"] != page["template"] {
		t.Fatalf("assemble node changed: %v", assembled)
	}
	binding, _ := tester["binding"].(map[string]any)
	if tester["runtime"] != runtimeSandbox || binding == nil || binding["agentId"] == nil {
		t.Fatalf("sandbox node not set up: %v", tester)
	}
	var runtime string
	if e := h.db.QueryRow(context.Background(), "SELECT runtime FROM agents WHERE tenant_id=$1 AND id=$2", tid, binding["agentId"]).Scan(&runtime); e != nil || runtime != runtimeSandbox {
		t.Fatalf("agent runtime %q %v", runtime, e)
	}
}
