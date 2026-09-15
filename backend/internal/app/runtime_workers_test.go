package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOptionalRuntimeConfiguration(t *testing.T) {
	c := testConfig()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Config){
		func(c *Config) { c.OpenAIAgentsURL = "http://localhost:8098" },
		func(c *Config) { c.OpenAIAgentsToken = strings.Repeat("o", 32) },
		func(c *Config) {
			c.OpenAIAgentsURL, c.OpenAIAgentsToken = "https://user:secret@localhost", strings.Repeat("o", 32)
		},
		func(c *Config) {
			c.OpenAIAgentsURL, c.OpenAIAgentsToken = "file:///tmp/worker", strings.Repeat("o", 32)
		},
		func(c *Config) {
			c.OpenAIAgentsURL, c.OpenAIAgentsToken = "http://localhost/?token=secret", strings.Repeat("o", 32)
		},
		func(c *Config) { c.OpenAIAgentsURL, c.OpenAIAgentsToken = "http://localhost", "short" },
	} {
		bad := c
		change(&bad)
		if err := bad.Validate(); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("invalid configuration accepted or leaked: %v", err)
		}
	}
	// ConfigFromEnv reads the whole process environment, so this must pin every value its result
	// depends on. Inheriting the host's APP_ENV made this fail on a machine where it is set to
	// production: the default public origin is http, which Validate rejects outside development.
	// What is under test is optional worker loading, not origin validation.
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", c.DatabaseURL)
	t.Setenv("AWWO_OPENAI_AGENTS_URL", "http://localhost:8098")
	t.Setenv("AWWO_OPENAI_AGENTS_TOKEN", strings.Repeat("o", 32))
	loaded, err := ConfigFromEnv()
	if err != nil || loaded.OpenAIAgentsURL != "http://localhost:8098" || loaded.OpenAIAgentsToken != strings.Repeat("o", 32) {
		t.Fatal("optional worker env was not loaded", err)
	}
}

func TestRuntimeTeamResolutionAndLegacySnapshots(t *testing.T) {
	catalog := runtimeCatalog{
		runtimePI:           {Model: "pi-default", Models: []piModel{{ID: "shared"}, {ID: "pi-only"}}},
		runtimeOpenAIAgents: {Model: "oa-default", Tools: []runtimeTool{{ID: "calculator", ContextTextBytes: 512}, {ID: "current_time", ContextTextBytes: 512}}, Models: []piModel{{ID: "shared"}, {ID: "oa-only"}}},
	}
	team := fixtureTeam("sequential")
	team.Runtime = runtimeOpenAIAgents
	team.Members[0].Tools = []string{"calculator", "current_time"}
	team.Members[1].Runtime, team.Members[1].Model = runtimePI, ""
	team.Members[2].Model = "shared"
	resolved, err := resolveTeam(&team, runtimePI, "pi-only", "", catalog)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Members[0].Runtime != runtimeOpenAIAgents || resolved.Members[0].Model != "oa-default" || resolved.Members[1].Model != "pi-only" || resolved.Members[2].Model != "shared" {
		t.Fatal("runtime-specific inheritance lost", resolved)
	}
	if team.Members[0].Runtime != "" || team.Members[1].Model != "" {
		t.Fatal("normalization mutated accepted input")
	}
	for _, mutate := range []func(*nodeTeam){
		func(t *nodeTeam) { t.Members[0].Model = "pi-only" },
		func(t *nodeTeam) { t.Members[0].Runtime = "shell" },
		func(t *nodeTeam) { t.Members[1].Tools = []string{"calculator"} },
		func(t *nodeTeam) { t.Members[0].Tools = []string{"calculator", "calculator"} },
		func(t *nodeTeam) { t.Members[0].Tools = []string{"http://untrusted"} },
	} {
		bad := *resolved
		bad.Members = append([]teamMember{}, resolved.Members...)
		mutate(&bad)
		if _, err := resolveTeam(&bad, runtimePI, "pi-only", "", catalog); err == nil {
			t.Fatal("invalid runtime/model/tools pairing accepted")
		}
	}
	var legacy executionSnapshot
	if json.Unmarshal([]byte(`{"model":"test-model","health":{"model":"test-model"}}`), &legacy) != nil {
		t.Fatal("invalid fixture")
	}
	if _, ok := legacy.memberHealth(runtimePI); !ok {
		t.Fatal("legacy Pi snapshot rejected")
	}
	if _, ok := legacy.memberHealth(runtimeOpenAIAgents); ok {
		t.Fatal("legacy Pi budget used for another runtime")
	}
	withoutTools := runtimeCatalog{runtimePI: catalog[runtimePI], runtimeOpenAIAgents: {Model: "oa-default", Models: catalog[runtimeOpenAIAgents].Models}}
	if _, err := resolveTeam(&team, runtimePI, "pi-only", "", withoutTools); err == nil {
		t.Fatal("tool accepted when operator has not enabled it")
	}
}

func TestRuntimeToolSchemaBudgetPrecedesInvocation(t *testing.T) {
	m := teamMember{ID: "calculator", Name: "Calculate", Role: "worker", Runtime: runtimeOpenAIAgents, Model: "model", Context: "task", Tools: []string{"calculator"}}
	input := teamTurnInput{Task: "TASK", Purpose: "work"}
	textBytes := len(teamSystemPrompt("", m)) + len(input.Task)
	h := piHealth{Model: "model", Limits: map[string]any{"maxContextTextBytes": float64(textBytes + 64)}, Tools: []runtimeTool{{ID: "calculator", ContextTextBytes: 128}}}
	snap := executionSnapshot{Runtime: runtimeOpenAIAgents, RuntimeHealth: runtimeCatalog{runtimeOpenAIAgents: h}}
	a := New(nil, testConfig())
	if _, err := a.executeTeamTurn(context.Background(), "tenant", "run", "session", snap, m, 1, 1, input); err == nil || err.Error() != "context_limit" {
		t.Fatal("tool overhead was not rejected before database/invocation access", err)
	}
}

type runtimeCall struct {
	observedPiCall
	Runtime  string   `json:"runtime"`
	TenantID string   `json:"tenantId"`
	Tools    []string `json:"tools"`
	Effort   string   `json:"effort"`
	// EffortPresent records whether the request carried an effort key at all, so
	// "no level" cannot be confused with an explicit empty string.
	EffortPresent bool `json:"-"`
}

func runtimeProvider(t *testing.T, runtime string, handle func(http.ResponseWriter, *http.Request, runtimeCall)) *httptest.Server {
	t.Helper()
	token, model, extra := strings.Repeat("s", 32), "test-model", "pi-only"
	if runtime == runtimeOpenAIAgents {
		token, model, extra = strings.Repeat("o", 32), "oa-default", "oa-only"
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("wrong worker bearer token")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": model, "provider": "fixture", "tools": func() []runtimeTool {
				if runtime == runtimeOpenAIAgents {
					return []runtimeTool{{ID: "calculator", ContextTextBytes: 512}, {ID: "current_time", ContextTextBytes: 512}}
				}
				return nil
			}(), "models": []map[string]any{func() map[string]any {
				// Only the OA default profile advertises effort levels, so tests can
				// tell "runtime supports it" from "this model supports it".
				m := map[string]any{"id": model, "runtime": runtime, "maxContextTextBytes": 262144}
				if runtime == runtimeOpenAIAgents {
					m["reasoningEfforts"], m["defaultReasoningEffort"] = []string{"low", "high"}, "low"
				}
				return m
			}(), {"id": extra, "runtime": runtime, "maxContextTextBytes": 262144}, {"id": "shared", "runtime": runtime, "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var call runtimeCall
		var keys map[string]json.RawMessage
		raw, readErr := io.ReadAll(r.Body)
		if readErr != nil || json.Unmarshal(raw, &call) != nil || json.Unmarshal(raw, &keys) != nil || call.Runtime != runtime {
			t.Error("request routed to wrong runtime")
			w.WriteHeader(400)
			return
		}
		_, call.EffortPresent = keys["effort"]
		if runtime == runtimePI && call.EffortPresent {
			t.Error("Pi request included an effort field")
		}
		if runtime == runtimePI && call.Tools != nil {
			t.Error("Pi request included unsupported tools field")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		handle(w, r, call)
	}))
}

func TestRuntimeDiscoveryAndStrictWorkerIdentity(t *testing.T) {
	pi := runtimeProvider(t, runtimePI, func(http.ResponseWriter, *http.Request, runtimeCall) { t.Error("health invoked a model") })
	defer pi.Close()
	oa := runtimeProvider(t, runtimeOpenAIAgents, func(http.ResponseWriter, *http.Request, runtimeCall) { t.Error("health invoked a model") })
	defer oa.Close()
	c := testConfig()
	c.PIURL = pi.URL
	c.OpenAIAgentsURL, c.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	a := New(nil, c)
	w := httptest.NewRecorder()
	a.runtimeCatalogue(w, httptest.NewRequest("GET", "/api/v1/tenants/t/runtime", nil), modelEntitlement{})
	var body struct {
		Available, PlannerAvailable bool
		Runtimes                    []struct {
			ID                                             string
			Available, Configured, SupportsEffortSelection bool
			Tools                                          []string
		}
		Models []piModel
	}
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || !body.Available || !body.PlannerAvailable || len(body.Runtimes) != 2 {
		t.Fatal(w.Body.String())
	}
	for _, runtime := range body.Runtimes {
		if !runtime.Available || !runtime.Configured || runtime.SupportsEffortSelection != (runtime.ID == runtimeOpenAIAgents) || !reflect.DeepEqual(runtime.Tools, runtimeTools(runtime.ID)) {
			t.Fatal(runtime)
		}
	}
	for _, m := range body.Models {
		if !validRuntime(m.Runtime) {
			t.Fatal("unscoped model", m)
		}
		if (m.ID == "oa-default") != (len(m.ReasoningEfforts) == 2 && m.DefaultReasoningEffort == "low") {
			t.Fatal("per-model effort advertisement", m)
		}
	}
	if strings.Contains(w.Body.String(), c.OpenAIAgentsToken) || strings.Contains(w.Body.String(), oa.URL) {
		t.Fatal("private worker configuration exposed")
	}
	// Miswiring the OA URL to a Pi worker must not populate an OA catalog.
	c.OpenAIAgentsURL, c.OpenAIAgentsToken = pi.URL, c.PIToken
	a = New(nil, c)
	if _, err := a.probeRuntime(context.Background(), runtimeOpenAIAgents); err == nil {
		t.Fatal("wrong worker accepted")
	}
	c.OpenAIAgentsURL, c.OpenAIAgentsToken = "", ""
	a = New(nil, c)
	if _, err := a.runtimeSnapshot(context.Background(), modelEntitlement{}, runtimeCatalog{}, runtimeOpenAIAgents, "", "", "", nil); err == nil {
		t.Fatal("disabled runtime fell back to Pi")
	}
}

func TestPostgresMixedRuntimeTeamsAndHistory(t *testing.T) {
	for _, mode := range []string{"sequential", "parallel"} {
		t.Run(mode, func(t *testing.T) {
			var mu sync.Mutex
			calls := []runtimeCall{}
			workers := make(chan struct{}, 2)
			release := make(chan struct{})
			if mode == "parallel" {
				go func() {
					for range 2 {
						<-workers
					}
					close(release)
				}()
			}
			handle := func(w http.ResponseWriter, r *http.Request, c runtimeCall) {
				if mode == "parallel" && !strings.Contains(c.SystemPrompt, "MEMBER-C") {
					workers <- struct{}{}
					select {
					case <-release:
					case <-time.After(2 * time.Second):
						t.Error("workers did not run concurrently")
						return
					}
				}
				mu.Lock()
				calls = append(calls, c)
				mu.Unlock()
				completePi(w, c.Runtime+"-result")
			}
			pi := runtimeProvider(t, runtimePI, handle)
			defer pi.Close()
			oa := runtimeProvider(t, runtimeOpenAIAgents, handle)
			defer oa.Close()
			h := newHarness(t, pi.URL)
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
			c, tid, _ := h.register(t, "mixed-"+mode+"@example.test")
			team := fixtureTeam(mode)
			team.Members[1].Runtime, team.Members[1].Model = runtimeOpenAIAgents, ""
			team.Members[1].Tools = []string{"calculator"}
			cid, _, sid := installTeam(t, h, c, tid, team)
			prefix := "/tenants/" + tid
			run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "operationId": "mixed-first-operation", "prompt": "ORIGINAL-TASK"}, 202)
			rid := run["id"].(string)
			h.awaitRun(t, c, tid, rid, "completed")
			turns := h.request(t, c, "GET", prefix+"/runs/"+rid+"/turns", nil, 200)["items"].([]any)
			if len(turns) != 3 {
				t.Fatal("turns missing")
			}
			mu.Lock()
			captured := append([]runtimeCall{}, calls...)
			mu.Unlock()
			if len(captured) != 3 {
				t.Fatal("wrong call count", len(captured))
			}
			if mode == "sequential" && captured[1].Runtime != runtimeOpenAIAgents {
				t.Fatal("sequential order changed")
			}
			for _, call := range captured {
				if call.TenantID != tid || !strings.HasPrefix(call.SessionID, sid+"_") || !strings.Contains(call.SystemPrompt, "Use plain words") {
					t.Fatal("request isolation or common instructions lost", call)
				}
				if call.Runtime == runtimeOpenAIAgents && (call.Model != "oa-default" || !strings.Contains(call.SystemPrompt, "MEMBER-B") || strings.Contains(call.SystemPrompt, "MEMBER-A") || !reflect.DeepEqual(call.Tools, []string{"calculator"})) {
					t.Fatal("member identity/model/tools lost", call)
				}
				if strings.Contains(call.SystemPrompt, "MEMBER-C") && (!strings.Contains(call.Prompt, "openai-agents-result") || !strings.Contains(call.Prompt, "pi-result")) {
					t.Fatal("aggregate/upstream incomplete", call)
				}
				found := false
				for _, raw := range turns {
					turn := raw.(map[string]any)
					if turn["id"] == call.RunID {
						found = true
						if turn["runtime"] != call.Runtime || turn["model"] != call.Model || turn["systemPrompt"] != call.SystemPrompt || turn["prompt"] != call.Prompt {
							t.Fatal("audit differs from actual payload", turn)
						}
					}
				}
				if !found {
					t.Fatal("actual worker ID absent from turn audit")
				}
			}
			other, otherTID, _ := h.register(t, "other-"+mode+"@example.test")
			h.request(t, other, "GET", prefix+"/runs/"+rid+"/turns", nil, 404)
			h.request(t, other, "POST", "/tenants/"+otherTID+"/runs", map[string]string{"sessionId": sid, "operationId": "forged-operation", "prompt": "forged"}, 404)
			var otherUser string
			if err := h.db.QueryRow(context.Background(), "SELECT user_id FROM memberships WHERE tenant_id=$1", otherTID).Scan(&otherUser); err != nil {
				t.Fatal(err)
			}
			if _, err := h.db.Exec(context.Background(), "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'reader')", tid, otherUser); err != nil {
				t.Fatal(err)
			}
			h.request(t, other, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "operationId": "reader-denied-operation", "prompt": "denied"}, 403)
			if mode == "sequential" {
				run = h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "operationId": "mixed-followup-operation", "prompt": "FOLLOW-UP"}, 202)
				h.awaitRun(t, c, tid, run["id"].(string), "completed")
				mu.Lock()
				again := append([]runtimeCall{}, calls[3:]...)
				mu.Unlock()
				for _, call := range again {
					if len(call.Messages) != 2 || !strings.Contains(string(call.Messages[0]), "ORIGINAL-TASK") {
						t.Fatal("completed session history absent", call)
					}
				}
			}
			var count int
			if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&count); err != nil {
				t.Fatal(err)
			}
			want := 3
			if mode == "sequential" {
				want = 6
			}
			if count != want {
				t.Fatal("model invocation accounting", count, want)
			}
			// Graph admission uses the same saved selectors and freezes them once.
			if mode == "sequential" {
				graph := h.request(t, c, "POST", prefix+"/canvases/"+cid+"/graph-runs", map[string]string{"operationId": "mixed-graph-operation"}, 202)
				awaitGraph(t, h, c, prefix+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "completed")
			}
		})
	}
}

func TestPostgresMixedRuntimeCancellationAndDeadline(t *testing.T) {
	for _, scenario := range []string{"parallel-stream", "before-headers", "deadline"} {
		t.Run(scenario, func(t *testing.T) {
			handle := func(w http.ResponseWriter, r *http.Request, c observedPiCall, cancelled <-chan struct{}, p *strictTurnPI) {
				if scenario != "before-headers" {
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(200)
					http.NewResponseController(w).Flush()
				}
				<-cancelled // Intentionally ignore disconnected streams: DELETE must match.
			}
			pi, oa := newStrictTurnRuntime(t, runtimePI, handle), newStrictTurnRuntime(t, runtimeOpenAIAgents, handle)
			h := newHarness(t, pi.server.URL)
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.server.URL, strings.Repeat("o", 32)
			if scenario == "deadline" {
				h.a.cfg.RunTimeout = 700 * time.Millisecond
			}
			c, tid, _ := h.register(t, scenario+"-mixed-cancel@example.test")
			team := fixtureTeam("parallel")
			team.Members[1].Runtime = runtimeOpenAIAgents
			_, _, sid := installTeam(t, h, c, tid, team)
			run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "operationId": "mixed-cancellation-operation", "prompt": "Wait"}, 202)
			rid := run["id"].(string)
			first, second := pi.next(t), oa.next(t)
			if first.RunID == rid || second.RunID == rid || first.RunID == second.RunID {
				t.Fatal("member identity reused")
			}
			if scenario == "deadline" {
				h.awaitRun(t, c, tid, rid, "failed")
			} else {
				h.request(t, c, "POST", "/tenants/"+tid+"/runs/"+rid+"/cancel", map[string]any{}, 200)
				h.awaitRun(t, c, tid, rid, "cancelled")
			}
			pi.awaitCancelled(t, []observedPiCall{first})
			oa.awaitCancelled(t, []observedPiCall{second})
			awaitSettledTeam(t, h, rid)
			turns := h.request(t, c, "GET", "/tenants/"+tid+"/runs/"+rid+"/turns", nil, 200)["items"].([]any)
			if len(turns) != 2 {
				t.Fatal("aggregate ran after cancellation")
			}
			for _, raw := range turns {
				turn := raw.(map[string]any)
				if scenario != "deadline" && (turn["status"] != "cancelled" || turn["error"] != "") {
					t.Fatal("user cancellation represented as failure", turn)
				}
			}
		})
	}
}

func TestPostgresRuntimeSetupForkAndSingleAgent(t *testing.T) {
	var mu sync.Mutex
	seen := []runtimeCall{}
	handle := func(w http.ResponseWriter, r *http.Request, c runtimeCall) {
		mu.Lock()
		seen = append(seen, c)
		mu.Unlock()
		completePi(w, c.Runtime+"-answer")
	}
	pi := runtimeProvider(t, runtimePI, handle)
	defer pi.Close()
	oa := runtimeProvider(t, runtimeOpenAIAgents, handle)
	defer oa.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	c, tid, _ := h.register(t, "runtime-fork@example.test")
	prefix := "/tenants/" + tid
	cid, _ := setupFixture(t, h, c, tid, 1)
	path := prefix + "/canvases/" + cid
	v := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 1}, 200)
	n := setupNodeAt(v, 0)
	oldSID := n["issueId"].(string)
	oldAgent := n["binding"].(map[string]any)["agentId"].(string)
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": oldSID, "operationId": "old-pi-conversation", "prompt": "Old Pi question"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	n["runtime"], n["model"] = runtimeOpenAIAgents, ""
	v = h.request(t, c, "PUT", path, map[string]any{"name": "Runtime switch", "document": v["document"], "version": v["version"]}, 200)
	h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": oldSID, "operationId": "must-initialize-first", "prompt": "Do not fall back"}, 409)
	h.request(t, c, "PUT", prefix+"/agents/"+oldAgent, map[string]any{"name": "Writer", "adapterType": runtimeOpenAIAgents}, 409)
	v = h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": v["version"]}, 200)
	n = setupNodeAt(v, 0)
	newSID := n["issueId"].(string)
	newAgent := n["binding"].(map[string]any)["agentId"].(string)
	if oldSID == newSID || oldAgent == newAgent || n["model"] != "oa-default" || len(n["threads"].([]any)) != 2 {
		t.Fatal("runtime did not fork actual identity", n)
	}
	old := h.request(t, c, "GET", prefix+"/agents/"+oldAgent, nil, 200)
	fresh := h.request(t, c, "GET", prefix+"/agents/"+newAgent, nil, 200)
	if old["adapterType"] != runtimePI || fresh["adapterType"] != runtimeOpenAIAgents {
		t.Fatal("Agent runtime changed or lied")
	}
	if len(h.request(t, c, "GET", prefix+"/sessions/"+oldSID+"/messages", nil, 200)["items"].([]any)) != 2 {
		t.Fatal("prior conversation lost")
	}
	// A legacy PUT that omits adapterType must preserve the new runtime.
	fresh = h.request(t, c, "PUT", prefix+"/agents/"+newAgent, map[string]any{"name": fresh["name"], "model": fresh["model"], "instructions": fresh["instructions"]}, 200)
	if fresh["adapterType"] != runtimeOpenAIAgents {
		t.Fatal("legacy PUT switched runtime")
	}
	again := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": v["version"]}, 200)
	if !reflect.DeepEqual(again, v) {
		t.Fatal("runtime setup is not idempotent")
	}
	run = h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": newSID, "operationId": "new-oa-conversation", "prompt": "New OA question"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	mu.Lock()
	captured := append([]runtimeCall{}, seen...)
	mu.Unlock()
	if len(captured) != 2 || captured[1].Runtime != runtimeOpenAIAgents || captured[1].SessionID != newSID || len(captured[1].Messages) != 0 {
		t.Fatal("single Agent/history runtime isolation failed", captured)
	}
	graph := h.request(t, c, "POST", path+"/graph-runs", map[string]string{"operationId": "oa-single-agent-graph"}, 202)
	awaitGraph(t, h, c, path+"/graph-runs/"+graph["id"].(string), "completed")
	var runtime string
	if err := h.db.QueryRow(context.Background(), "SELECT runtime FROM agents WHERE id=$1", oldAgent).Scan(&runtime); err != nil || runtime != runtimePI {
		t.Fatal("Pi compatibility", err)
	}
	if _, err := h.db.Exec(context.Background(), "UPDATE agents SET runtime='shell' WHERE id=$1", oldAgent); err == nil {
		t.Fatal("database accepted unsupported runtime")
	}
}

func TestPostgresMixedRuntimeQuotaAndRejectedPairing(t *testing.T) {
	var mu sync.Mutex
	calls := []runtimeCall{}
	handle := func(w http.ResponseWriter, r *http.Request, c runtimeCall) {
		mu.Lock()
		calls = append(calls, c)
		mu.Unlock()
		completePi(w, "one invocation")
	}
	pi := runtimeProvider(t, runtimePI, handle)
	defer pi.Close()
	oa := runtimeProvider(t, runtimeOpenAIAgents, handle)
	defer oa.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	c, tid, _ := h.register(t, "runtime-quota@example.test")
	prefix := "/tenants/" + tid
	team := fixtureTeam("sequential")
	team.Members[0].Runtime = runtimeOpenAIAgents
	team.Members[0].Model = "pi-only"
	team.Members[1].Model = ""
	cid, _, sid := installTeam(t, h, c, tid, team)
	h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "operationId": "invalid-pairing-operation", "prompt": "reject"}, 400)
	var count int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM runs WHERE tenant_id=$1", tid).Scan(&count); err != nil || count != 0 {
		t.Fatal("invalid selector admitted a run", count, err)
	}
	path := prefix + "/canvases/" + cid
	v := h.request(t, c, "GET", path, nil, 200)
	n := setupNodeAt(v, 0)
	team.Members[0].Model = ""
	n["team"] = team
	h.request(t, c, "PUT", path, map[string]any{"name": "quota", "version": v["version"], "document": v["document"]}, 200)
	if _, err := h.db.Exec(context.Background(), "UPDATE tenants SET max_runs_per_day=1 WHERE id=$1", tid); err != nil {
		t.Fatal(err)
	}
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "operationId": "quota-one-operation", "prompt": "one only"}, 202)
	result := h.awaitRun(t, c, tid, run["id"].(string), "failed")
	if result["error"] != "quota_exceeded" {
		t.Fatal("quota failure not surfaced", result)
	}
	mu.Lock()
	captured := append([]runtimeCall{}, calls...)
	mu.Unlock()
	if len(captured) != 1 || captured[0].Runtime != runtimeOpenAIAgents {
		t.Fatal("quota admitted more than one invocation", captured)
	}
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&count); err != nil || count != 1 {
		t.Fatal("wrong ledger count", count, err)
	}
	h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "operationId": "quota-next-operation", "prompt": "blocked"}, 429)
}

func TestPostgresRuntimeMigrationRetainsLegacyAgents(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	c, tid, _ := h.register(t, "legacy-runtime-migration@example.test")
	_, aid, _ := h.fixture(t, c, tid)
	ctx := context.Background()
	// Recreate the pre-011 shape in this test's isolated schema, with an actual
	// existing Agent/session/history identity, then perform the upgrade twice.
	if _, err := h.db.Exec(ctx, "ALTER TABLE agents DROP COLUMN runtime; DELETE FROM awwo_schema_migrations WHERE version=11"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Migrate(ctx, h.db); err != nil {
			t.Fatal(err)
		}
	}
	agent := h.request(t, c, "GET", "/tenants/"+tid+"/agents/"+aid, nil, 200)
	if agent["runtime"] != runtimePI || agent["adapterType"] != runtimePI || agent["model"] != "test-model" {
		t.Fatal("migration changed existing identity", agent)
	}
	var sessions int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM node_sessions WHERE agent_id=$1", aid).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatal("migration damaged session binding", sessions, err)
	}
}

func TestPostgresOpenAIAgentCancellationUsesOnlyItsWorker(t *testing.T) {
	handle := func(w http.ResponseWriter, r *http.Request, c observedPiCall, cancelled <-chan struct{}, p *strictTurnPI) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		<-cancelled
	}
	pi, oa := newStrictTurnRuntime(t, runtimePI, handle), newStrictTurnRuntime(t, runtimeOpenAIAgents, handle)
	h := newHarness(t, pi.server.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.server.URL, strings.Repeat("o", 32)
	c, tid, _ := h.register(t, "oa-single-cancel@example.test")
	cid, doc := setupFixture(t, h, c, tid, 1)
	path := "/tenants/" + tid + "/canvases/" + cid
	doc["nodes"].([]any)[0].(map[string]any)["runtime"] = runtimeOpenAIAgents
	h.request(t, c, "PUT", path, map[string]any{"name": "OA single cancellation", "document": doc, "version": 1}, 200)
	v := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 2}, 200)
	sid := setupNodeAt(v, 0)["issueId"].(string)
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "operationId": "single-oa-cancel-operation", "prompt": "wait"}, 202)
	rid := run["id"].(string)
	call := oa.next(t)
	if call.RunID != rid {
		t.Fatal("single Agent did not use run identity")
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/runs/"+rid+"/cancel", map[string]any{}, 200)
	oa.awaitCancelled(t, []observedPiCall{call})
	awaitSettledTeam(t, h, rid)
	pi.mu.Lock()
	requests := len(pi.requests)
	pi.mu.Unlock()
	if requests != 0 {
		t.Fatal("OA cancellation sent an unrelated Pi DELETE")
	}
}
