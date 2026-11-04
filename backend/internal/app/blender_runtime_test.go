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
)

// blenderHealth answers as a Blender workstation's worker does (apps/openai-agents-worker config.mjs publicHealth): its
// workspace, and whether its Blender answered the worker's probe.
func blenderHealth(w http.ResponseWriter, blender any) {
	workspace := map[string]any{"version": 1, "available": true, "maxModelCalls": 8}
	if blender != nil {
		workspace["blender"] = blender
	}
	writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "fixture", "workspace": workspace,
		"models": []map[string]any{{"id": "test-model", "runtime": runtimeOpenAIAgents, "maxContextTextBytes": 262144, "messageOverheadBytes": 32}}})
}

// The Blender workstation is a sandbox computer with Blender in it: its own worker serves it, only once that worker's
// Blender answered, its models become its own, and its runs still name the worker's runtime.
func TestBlenderRuntimeIsServedOnlyByAWorkstationWhoseBlenderAnswered(t *testing.T) {
	var blender any = map[string]any{"available": true, "gpu": "CUDA: NVIDIA GeForce RTX 4090 D", "eevee": "software", "tools": 13}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { blenderHealth(w, blender) }))
	defer worker.Close()
	cfg := testConfig()
	cfg.OpenAIAgentsURL, cfg.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
	cfg.SandboxAgentsURL, cfg.SandboxAgentsToken = worker.URL, strings.Repeat("s", 32)
	cfg.BlenderAgentsURL, cfg.BlenderAgentsToken = worker.URL, strings.Repeat("b", 32)
	cfg.WorkspaceCallbackURL = "http://127.0.0.1:8087/api/internal/workspace-calls"
	a := New(nil, cfg)
	h, err := a.probeRuntime(context.Background(), runtimeBlender)
	if err != nil || len(h.Models) != 1 || h.Models[0].Runtime != runtimeBlender || h.Workspace == nil || h.Workspace.Blender == nil {
		t.Fatalf("workstation catalogue %+v %v", h, err)
	}
	if got := *h.Workspace.Blender; got != (blenderCapability{Available: true, GPU: "CUDA: NVIDIA GeForce RTX 4090 D", EEVEE: "software", Tools: 13}) {
		t.Fatalf("Blender facts %+v", got)
	}
	entitlement, _ := newModelEntitlement(false, nil)
	station, err := a.runtimeSnapshot(context.Background(), entitlement, runtimeCatalog{}, runtimeBlender, "test-model", "", "Model a ring.", nil)
	if err != nil || station.Workspace == nil || a.requireWorkspaceSnapshot(station) != nil {
		t.Fatalf("workstation node got no workspace: %+v %v", station.Workspace, err)
	}
	team := &nodeTeam{Version: 1, Mode: "parallel", Runtime: runtimeOpenAIAgents, MaxRounds: 1, MaxTurns: 2, TimeoutSeconds: 60,
		Members: []teamMember{{ID: "a", Name: "A", Role: "Builds", Context: "task"}, {ID: "b", Name: "B", Role: "Checks", Context: "task"}}}
	if err := validateTeam(team); err != nil {
		t.Fatal(err)
	}
	if _, err = a.runtimeSnapshot(context.Background(), entitlement, runtimeCatalog{}, runtimeBlender, "test-model", "", "x", team); err == nil || !strings.Contains(err.Error(), "not a team") {
		t.Fatalf("a workstation node ran a team: %v", err)
	}
	// Nor does a team of another node run on a computer of its own, as its runtime or a member's: a team turn has no
	// workspace, which the worker would refuse once the run had started.
	for _, runtime := range []string{runtimeBlender, runtimeSandbox} {
		onComputer := *team
		onComputer.Runtime = runtime
		member := *team
		member.Members = append([]teamMember(nil), team.Members...)
		member.Members[1].Runtime = runtime
		for name, bad := range map[string]*nodeTeam{"team": &onComputer, "member": &member} {
			if validateTeam(bad) == nil {
				t.Fatalf("a team's %s ran on %s", name, runtime)
			}
		}
	}
	if workerRuntime(runtimeBlender) != runtimeOpenAIAgents || !validRuntime(runtimeBlender) || validRuntime("blender ") || !sandboxRuntime(runtimeBlender) || sandboxRuntime(runtimeOpenAIAgents) {
		t.Fatal("workstation runtime mapping")
	}
	// The same worker answering for the sandbox keeps no Blender facts there.
	sandbox, err := a.probeRuntime(context.Background(), runtimeSandbox)
	if err != nil || sandbox.Workspace == nil || sandbox.Workspace.Blender != nil {
		t.Fatalf("sandbox kept Blender facts: %+v %v", sandbox.Workspace, err)
	}
	// A worker whose Blender has not answered (or says nothing of Blender) does not serve the workstation.
	for _, value := range []any{nil, map[string]any{"available": false}, "yes"} {
		blender = value
		if _, err = a.probeRuntime(context.Background(), runtimeBlender); err == nil {
			t.Fatalf("a workstation without its Blender (%v) served the runtime", value)
		}
	}
	a.cfg.BlenderAgentsURL = ""
	if _, _, err = a.runtimeEndpoint(runtimeBlender); err == nil {
		t.Fatal("an unconfigured workstation had an endpoint")
	}
}

// What a worker says of its Blender is shown to members, so only the closed forms its worker writes are kept.
func TestBlenderFactsKeepOnlyTheWorkersOwnForms(t *testing.T) {
	cases := []struct {
		in, out blenderCapability
	}{
		{blenderCapability{Available: true, GPU: "OPTIX: NVIDIA L40S", EEVEE: "gpu", Tools: 13}, blenderCapability{Available: true, GPU: "OPTIX: NVIDIA L40S", EEVEE: "gpu", Tools: 13}},
		{blenderCapability{Available: true, GPU: "none"}, blenderCapability{Available: true, GPU: "none"}},
		{blenderCapability{Available: true, GPU: "<script>alert(1)</script>", EEVEE: "fast", Tools: 999}, blenderCapability{Available: true}},
		{blenderCapability{GPU: "CUDA: " + strings.Repeat("x", 300)}, blenderCapability{}},
	}
	for _, c := range cases {
		if got := shownBlender(&c.in); *got != c.out {
			t.Errorf("%+v kept as %+v", c.in, *got)
		}
	}
	if shownBlender(nil) != nil {
		t.Fatal("nothing became something")
	}
	if validWorkspaceCapability(runtimeBlender, &workspaceCapability{Version: 1, Available: true, MaxModelCalls: 8}) {
		t.Fatal("a workspace without Blender counted for the workstation")
	}
	if !validWorkspaceCapability(runtimeBlender, &workspaceCapability{Version: 1, Available: true, MaxModelCalls: 8, Blender: &blenderCapability{Available: true}}) ||
		!validWorkspaceCapability(runtimeSandbox, &workspaceCapability{Version: 1, Available: true, MaxModelCalls: 8}) {
		t.Fatal("workspace capability rules")
	}
	if !validWorkspaceActivity(3, "workspace_blender") || validWorkspaceActivity(3, "execute_blender_code") {
		t.Fatal("workstation activity label")
	}
}

func TestBlenderRuntimeConfiguration(t *testing.T) {
	base := func() Config {
		c := testConfig()
		c.Env = "development"
		return c
	}
	callback := "http://127.0.0.1:8087/api/internal/workspace-calls"
	cases := map[string]func(*Config){
		"url without token":      func(c *Config) { c.BlenderAgentsURL = "http://127.0.0.1:8113" },
		"token without url":      func(c *Config) { c.BlenderAgentsToken = strings.Repeat("b", 32) },
		"short token":            func(c *Config) { c.BlenderAgentsURL, c.BlenderAgentsToken = "http://127.0.0.1:8113", "short" },
		"no callback":            func(c *Config) { c.BlenderAgentsURL, c.BlenderAgentsToken = "http://127.0.0.1:8113", strings.Repeat("b", 32) },
		"credentials in the url": func(c *Config) { c.BlenderAgentsURL, c.BlenderAgentsToken, c.WorkspaceCallbackURL = "http://u@127.0.0.1:8113", strings.Repeat("b", 32), callback },
		"not http":               func(c *Config) { c.BlenderAgentsURL, c.BlenderAgentsToken, c.WorkspaceCallbackURL = "ftp://127.0.0.1:8113", strings.Repeat("b", 32), callback },
	}
	for name, edit := range cases {
		c := base()
		edit(&c)
		if c.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	c := base()
	c.BlenderAgentsURL, c.BlenderAgentsToken, c.WorkspaceCallbackURL = "http://127.0.0.1:8113", strings.Repeat("b", 32), callback
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

// The runtime catalogue lists the workstation only where one is configured, by its own name, with its workspace.
func TestBlenderRuntimeIsListedOnlyWhereConfigured(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		blenderHealth(w, map[string]any{"available": true, "gpu": "none", "eevee": "software", "tools": 13})
	}))
	defer worker.Close()
	listed := func(cfg Config) map[string]map[string]any {
		a := New(nil, cfg)
		entitlement, _ := newModelEntitlement(false, nil)
		rec := httptest.NewRecorder()
		a.runtimeCatalogue(rec, httptest.NewRequest("GET", "/runtime", nil), entitlement, modelClosures{})
		var body struct {
			Runtimes []map[string]any `json:"runtimes"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		out := map[string]map[string]any{}
		for _, runtime := range body.Runtimes {
			out[runtime["id"].(string)] = runtime
		}
		return out
	}
	cfg := testConfig()
	cfg.OpenAIAgentsURL, cfg.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
	cfg.WorkspaceCallbackURL = "http://127.0.0.1:8087/api/internal/workspace-calls"
	if _, ok := listed(cfg)[runtimeBlender]; ok {
		t.Fatal("an unconfigured workstation was listed")
	}
	cfg.SandboxAgentsURL, cfg.SandboxAgentsToken = worker.URL, strings.Repeat("s", 32)
	cfg.BlenderAgentsURL, cfg.BlenderAgentsToken = worker.URL, strings.Repeat("b", 32)
	station := listed(cfg)[runtimeBlender]
	if station == nil || station["name"] != "Blender workstation" || station["available"] != true || station["workspace"] == nil {
		t.Fatalf("workstation descriptor %v", station)
	}
	if blender := station["workspace"].(map[string]any)["blender"].(map[string]any); blender["available"] != true || blender["gpu"] != "none" {
		t.Fatalf("workstation facts %v", blender)
	}
}

// A workstation node's run goes to the workstation's worker in project-execution mode, naming the worker's own runtime;
// a sandbox node on the same API still goes to the sandbox's worker, and each model call is accounted under its runtime.
func TestPostgresBlenderNodeRunsInItsWorkstation(t *testing.T) {
	snapshot := workspaceFixtureSnapshot(t)
	var stationRuns, sandboxRuns atomic.Int32
	worker := func(blender bool, runs *atomic.Int32) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/health" {
				if blender {
					blenderHealth(w, map[string]any{"available": true, "gpu": "CUDA: NVIDIA L40S", "eevee": "gpu", "tools": 13})
				} else {
					workspaceHealthWithLimit(w, 8)
				}
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
			if e := json.NewDecoder(r.Body).Decode(&request); e != nil || request.Runtime != runtimeOpenAIAgents || request.Workspace.MaxModelCalls != 8 {
				t.Errorf("worker request runtime %q budget %d %v", request.Runtime, request.Workspace.MaxModelCalls, e)
				w.WriteHeader(400)
				return
			}
			runs.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			callbackRequest(t, request.Workspace, map[string]any{"operation": "admit", "index": 1}, 200)
			callbackRequest(t, request.Workspace, map[string]any{"operation": "settle", "index": 1, "status": "completed", "observability": json.RawMessage(observationFixture(3, 4))}, 200)
			fmt.Fprint(w, "data: {\"type\":\"workspace_activity\",\"step\":1,\"tool\":\"workspace_blender\"}\n\n")
			raw, _ := json.Marshal(map[string]any{"type": "completed", "text": "Modelled and rendered.", "workspaceSnapshot": snapshot})
			fmt.Fprintf(w, "data: %s\n\n", raw)
		}))
	}
	station, sandbox := worker(true, &stationRuns), worker(false, &sandboxRuns)
	defer station.Close()
	defer sandbox.Close()
	h := newHarness(t, sandbox.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = sandbox.URL, strings.Repeat("o", 32)
	h.a.cfg.SandboxAgentsURL, h.a.cfg.SandboxAgentsToken = sandbox.URL, strings.Repeat("s", 32)
	h.a.cfg.BlenderAgentsURL, h.a.cfg.BlenderAgentsToken = station.URL, strings.Repeat("b", 32)
	h.a.cfg.WorkspaceCallbackURL = h.server.URL + "/api/internal/workspace-calls"
	c, tid, _ := h.register(t, "blender-runtime@example.test")
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
	got := runOn(runtimeBlender, "blender-operation")
	if got["executionKind"] != "workspace" || stationRuns.Load() != 1 || sandboxRuns.Load() != 0 {
		t.Fatalf("workstation run: kind %v, workstation %d, sandbox %d", got["executionKind"], stationRuns.Load(), sandboxRuns.Load())
	}
	activity, _ := json.Marshal(got["workspaceActivity"])
	if !strings.Contains(string(activity), `"tool":"workspace_blender"`) {
		t.Fatalf("workstation activity %s", activity)
	}
	if runOn(runtimeSandbox, "sandbox-operation")["executionKind"] != "workspace" || stationRuns.Load() != 1 || sandboxRuns.Load() != 1 {
		t.Fatalf("sandbox run went elsewhere: workstation %d, sandbox %d", stationRuns.Load(), sandboxRuns.Load())
	}
	var blenderCalls, sandboxCalls int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FILTER (WHERE runtime='blender'),count(*) FILTER (WHERE runtime='sandbox') FROM model_invocations WHERE tenant_id=$1 AND status='completed'", tid).Scan(&blenderCalls, &sandboxCalls); e != nil || blenderCalls != 1 || sandboxCalls != 1 {
		t.Fatalf("model calls accounted: blender %d, sandbox %d %v", blenderCalls, sandboxCalls, e)
	}
}

// A workstation run's model calls are priced as the OpenAI Agents worker's, as a sandbox run's are.
func TestBlenderRunCallsArePricedAsTheirWorkers(t *testing.T) {
	pricing := &ModelPricing{Version: "test", Currency: "USD", Models: map[string]ModelPrice{}}
	if _, raw := pricing.Freeze(runtimeBlender, "test-model"); !strings.Contains(string(raw), `"catalogKey":"openai-agents:test-model"`) {
		t.Fatalf("workstation price key %s", raw)
	}
}
