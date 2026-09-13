package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPostgresGraphOutputPolicyFrozenAcrossRuntimesAndTeams(t *testing.T) {
	for _, mode := range []string{"pi", "openai-agents", "sequential", "parallel", "debate", "review"} {
		t.Run(mode, func(t *testing.T) {
			const content = "EXACT-VALIDATED-UPSTREAM"
			const output = `{"result":"EXACT-VALIDATED-UPSTREAM"}`
			entered, release := make(chan struct{}), make(chan struct{})
			var first atomic.Bool
			var once sync.Once
			var mu sync.Mutex
			calls := []runtimeCall{}
			handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				mu.Lock()
				calls = append(calls, call)
				mu.Unlock()
				for _, expected := range []string{"NODE-PERSONA", "Return only concise text", "ORIGINAL-FIELD-GUIDANCE", "takes precedence over any conflicting node or member instruction about response format", `"id":"followups"`} {
					if !strings.Contains(call.SystemPrompt, expected) {
						t.Error("actual worker system prompt lost persona or frozen contract", expected, call.SystemPrompt)
					}
				}
				if strings.Contains(call.SystemPrompt, "MUTATED") || strings.Contains(call.Prompt, "MUTATED") || strings.Contains(call.SystemPrompt, "may alternatively be returned as plain text") {
					t.Error("mutable configuration or invalid plain-text exception reached worker")
				}
				if first.CompareAndSwap(false, true) {
					close(entered)
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				if strings.HasPrefix(call.Prompt, "【工作流节点】downstream") && (!strings.Contains(call.Prompt, content) || strings.Contains(call.Prompt, output)) {
					t.Error("downstream did not receive the exact validated field value")
				}
				if strings.Contains(call.Prompt, "Team operation:\nReview the latest deliverable") {
					if !strings.Contains(call.SystemPrompt, "INSIDE the output string, not to the outer review response") {
						t.Error("review envelope precedence missing from actual worker request")
					}
					verdict, _ := json.Marshal(map[string]any{"approved": true, "output": output, "feedback": ""})
					completePi(w, string(verdict))
					return
				}
				completePi(w, output)
			}
			pi := runtimeProvider(t, runtimePI, handle)
			defer pi.Close()
			oa := runtimeProvider(t, runtimeOpenAIAgents, handle)
			defer oa.Close()
			h := newHarness(t, pi.URL)
			defer once.Do(func() { close(release) })
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
			c, tid, _ := h.register(t, "contract-"+mode+"@example.test")
			prefix := "/tenants/" + tid
			runtime, model := runtimePI, "test-model"
			if mode == runtimeOpenAIAgents {
				runtime, model = runtimeOpenAIAgents, "oa-default"
			}
			aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Contract worker", "adapterType": runtime, "model": model, "instructions": "NODE-PERSONA: You are 李白. Return only concise text, one sentence, no JSON."}, 201)["id"].(string)
			contract := func(input bool) *graphContract {
				value := &graphContract{Version: 1, Outputs: []graphField{{ID: "result", Type: "markdown", Required: true, Help: "ORIGINAL-FIELD-GUIDANCE"}, {ID: "followups", Type: "markdown"}}}
				if input {
					value.Inputs = []graphField{{ID: "source", Type: "text", Required: true}}
				}
				return value
			}
			upstream := map[string]any{"id": "upstream", "kind": "session", "title": "upstream", "runtime": runtime, "binding": map[string]string{"companyId": tid, "agentId": aid}, "contract": contract(false)}
			var team *nodeTeam
			if mode != runtimePI && mode != runtimeOpenAIAgents {
				value := fixtureTeam(mode)
				value.Members[1].Runtime, value.Members[1].Model = runtimeOpenAIAgents, ""
				for i := range value.Members {
					value.Members[i].Instructions += ": Return only concise text, no JSON."
				}
				team = &value
				upstream["team"] = team
			}
			downstream := map[string]any{"id": "downstream", "kind": "session", "title": "downstream", "runtime": runtime, "binding": map[string]string{"companyId": tid, "agentId": aid}, "contract": contract(true)}
			doc := map[string]any{"nodes": []any{upstream, downstream}, "edges": []map[string]string{{"id": "edge", "fromNode": "upstream", "fromPort": "out:result", "toNode": "downstream", "toPort": "in:source", "dataType": "text"}}}
			cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Frozen contract", "document": doc}, 201)["id"].(string)
			base := prefix + "/canvases/" + cid + "/graph-runs"
			accepted := h.request(t, c, "POST", base, map[string]any{"operationId": "contract-frozen-operation", "documentVersion": 1}, 202)
			gid := accepted["id"].(string)
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("first graph worker never dispatched")
			}
			// Both the live persona and contract change after admission. Waiting
			// downstream nodes and later team members must still use their snapshot.
			h.request(t, c, "PUT", prefix+"/agents/"+aid+"/instructions", map[string]string{"content": "MUTATED-PERSONA"}, 200)
			for _, node := range []map[string]any{upstream, downstream} {
				node["contract"].(*graphContract).Outputs[0].Help = "MUTATED-FIELD-GUIDANCE"
			}
			if team != nil {
				team.Members[1].Instructions = "MUTATED-MEMBER"
			}
			h.request(t, c, "PUT", prefix+"/canvases/"+cid, map[string]any{"name": "Edited", "version": 1, "document": doc}, 200)
			once.Do(func() { close(release) })
			done := awaitGraph(t, h, c, base+"/"+gid, "completed")
			for _, raw := range done["nodes"].([]any) {
				node := raw.(map[string]any)
				if node["state"] != "done" || node["output"] != output {
					t.Fatal("runtime completion did not become validated graph output", node)
				}
			}
			mu.Lock()
			captured := append([]runtimeCall{}, calls...)
			mu.Unlock()
			want := 2
			if team != nil {
				want = 4
				if mode == "debate" {
					want = 8
				}
				seenOA := false
				for _, call := range captured {
					if strings.HasPrefix(call.Prompt, "【工作流节点】downstream") {
						continue
					}
					members := 0
					for _, marker := range []string{"MEMBER-A", "MEMBER-B", "MEMBER-C"} {
						if strings.Contains(call.SystemPrompt, marker) {
							members++
						}
					}
					if members != 1 {
						t.Fatal("member persona isolation failed", call.SystemPrompt)
					}
					if call.Runtime == runtimeOpenAIAgents {
						seenOA = true
						if !strings.Contains(call.SystemPrompt, "MEMBER-B") {
							t.Fatal("OpenAI Agents routed to wrong member")
						}
					}
				}
				if !seenOA {
					t.Fatal("mixed-runtime member was never dispatched")
				}
			}
			var invocations int
			if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); err != nil || len(captured) != want || invocations != want {
				t.Fatal("unexpected paid invocation count", len(captured), invocations, want, err)
			}
			var frozen []byte
			if err := h.db.QueryRow(context.Background(), "SELECT execution_snapshot FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id='downstream'", tid, gid).Scan(&frozen); err != nil {
				t.Fatal(err)
			}
			var snap executionSnapshot
			if json.Unmarshal(frozen, &snap) != nil || !strings.Contains(snap.Instructions, "NODE-PERSONA") || !strings.Contains(snap.OutputPolicy, "ORIGINAL-FIELD-GUIDANCE") || strings.Contains(string(frozen), "MUTATED") {
				t.Fatal("execution snapshot lost original persona/contract", string(frozen))
			}
		})
	}
}

func TestPostgresGraphOutputPolicyBudgetStopsBeforeInvocation(t *testing.T) {
	n := graphNode{ID: "only", Kind: "session", Title: "Budget", Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "result", Type: "text", Required: true}, {ID: "followups", Type: "text"}}}}
	const instructions = "Return only one sentence."
	prompt, err := graphPrompt(n, graphDocument{Nodes: []graphNode{n}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	budget := len(prompt) + len(instructions) + 100
	var calls atomic.Int32
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "limits": map[string]int{"maxContextTextBytes": budget}})
			return
		}
		calls.Add(1)
		w.WriteHeader(500)
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "graph-policy-budget@example.test")
	prefix := "/tenants/" + tid
	aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Budget", "model": "test-model", "instructions": instructions}, 201)["id"].(string)
	n.Binding = &struct {
		CompanyID string `json:"companyId"`
		AgentID   string `json:"agentId"`
	}{CompanyID: tid, AgentID: aid}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Budget", "document": graphDocument{Nodes: []graphNode{n}, Edges: []graphEdge{}}}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "policy-budget-operation"}, 202)
	done := awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "failed")
	node := done["nodes"].([]any)[0].(map[string]any)
	var invocations, runs int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); err != nil {
		t.Fatal(err)
	}
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM runs WHERE tenant_id=$1", tid).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if node["detail"] != "context_limit" || calls.Load() != 0 || invocations != 0 || runs != 0 {
		t.Fatal("oversized policy triggered an invocation or lost failure detail", node, calls.Load(), invocations, runs)
	}
}

func TestPostgresExistingPlannerSessionUsesCurrentOutputProtocol(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		calls.Add(1)
		if call.SystemPrompt != plannerInstructions || !strings.Contains(call.SystemPrompt, "declared output contracts define serialization") {
			t.Error("planner continued using obsolete instructions", call.SystemPrompt)
		}
		completePi(w, `{"version":1,"summary":"Need more detail","operations":[]}`)
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner-policy-refresh@example.test")
	prefix := "/tenants/" + tid
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Planner", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	path := prefix + "/canvases/" + cid + "/plan"
	first := h.request(t, c, "POST", path, map[string]string{"prompt": "Plan a workflow", "context": "protocol", "operationId": "planner-policy-first"}, 202)["id"].(string)
	h.awaitRun(t, c, tid, first, "completed")
	if _, err := h.db.Exec(context.Background(), "UPDATE agents SET instructions='OBSOLETE-PLANNER' WHERE tenant_id=$1 AND internal", tid); err != nil {
		t.Fatal(err)
	}
	second := h.request(t, c, "POST", path, map[string]string{"prompt": "Plan again", "context": "protocol", "operationId": "planner-policy-second"}, 202)["id"].(string)
	h.awaitRun(t, c, tid, second, "completed")
	var sessions int
	var frozen string
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM node_sessions WHERE tenant_id=$1 AND kind='planner'", tid).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := h.db.QueryRow(context.Background(), "SELECT execution_snapshot->>'instructions' FROM runs WHERE tenant_id=$1 AND id=$2", tid, first).Scan(&frozen); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || calls.Load() != 2 || frozen != plannerInstructions {
		t.Fatal("planner refresh duplicated sessions or changed accepted snapshot", sessions, calls.Load(), frozen)
	}
}
