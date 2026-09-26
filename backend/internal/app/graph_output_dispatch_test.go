package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// structuredWorker is an openai-agents worker whose default model advertises structured
// delivery output while its sibling does not, so a test can tell "this runtime has the
// capability" from "this model has it". contextBytes of 0 means a generous budget.
func structuredWorker(t *testing.T, contextBytes int, handle func(http.ResponseWriter, *http.Request, runtimeCall)) *httptest.Server {
	t.Helper()
	token := strings.Repeat("o", 32)
	if contextBytes == 0 {
		contextBytes = 262144
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("wrong worker bearer token")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/health" {
			// The default model's budget is read from the top-level limits, not from its
			// own catalog entry, so both must be set for a test to bound either model.
			writeJSON(w, 200, map[string]any{"ready": true, "model": "oa-default", "provider": "fixture",
				"limits": map[string]any{"maxContextTextBytes": contextBytes, "messageOverheadBytes": 32},
				"models": []map[string]any{
					{"id": "oa-default", "runtime": runtimeOpenAIAgents, "maxContextTextBytes": contextBytes, "messageOverheadBytes": 32, "structuredOutput": true},
					{"id": "oa-plain", "runtime": runtimeOpenAIAgents, "maxContextTextBytes": contextBytes, "messageOverheadBytes": 32},
				}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var call runtimeCall
		var keys map[string]json.RawMessage
		raw, err := io.ReadAll(r.Body)
		if err != nil || json.Unmarshal(raw, &call) != nil || json.Unmarshal(raw, &keys) != nil {
			t.Error("unreadable worker request")
			w.WriteHeader(400)
			return
		}
		_, call.ContractPresent = keys["outputContract"]
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		handle(w, r, call)
	}))
}

func failWorker(w http.ResponseWriter, code string) {
	raw, _ := json.Marshal(map[string]string{"type": "failed", "code": code, "message": "The model output did not match the required delivery contract."})
	fmt.Fprintf(w, "data: %s\n\n", raw)
}

// structuredCanvas installs a one-node canvas whose node carries the given frozen output
// fields, and returns the graph-run base path.
func structuredCanvas(t *testing.T, h *harness, c *http.Cookie, tid, name, runtime, model string, outputs []graphField, team *nodeTeam) string {
	t.Helper()
	prefix := "/tenants/" + tid
	aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Structured", "adapterType": runtime, "model": model, "instructions": "NODE-PERSONA"}, 201)["id"].(string)
	node := map[string]any{"id": "only", "kind": "session", "title": "Structured", "runtime": runtime,
		"binding": map[string]string{"companyId": tid, "agentId": aid}, "contract": &graphContract{Version: 1, Outputs: outputs}}
	if team != nil {
		node["team"] = team
	}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": name, "document": map[string]any{"nodes": []any{node}, "edges": []any{}}}, 201)["id"].(string)
	return prefix + "/canvases/" + cid + "/graph-runs"
}

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
	aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Budget", "adapterType": "pi", "model": "test-model", "instructions": instructions}, 201)["id"].(string)
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

// A structured contract is gated on the node's own model, and every path that must not
// carry one sends no key at all rather than a null or an empty envelope. The textual
// policy is unconditional: it is what the delivery still depends on when the provider
// enforces nothing.
func TestPostgresGraphStructuredOutputContractGated(t *testing.T) {
	outputs := []graphField{{ID: "result", Type: "markdown", Required: true}, {ID: "count", Type: "number"}}
	const delivered = `{"result":"DELIVERED","count":2}`
	for _, test := range []struct {
		name     string
		runtime  string
		model    string
		outputs  []graphField
		team     bool
		reply    string
		contract bool
		// outcome is the counter label this decision must record, empty when the node
		// was never eligible and nothing should be counted at all.
		outcome string
	}{
		{"capable-model", runtimeOpenAIAgents, "oa-default", outputs, false, delivered, true, "frozen"},
		{"model-without-capability", runtimeOpenAIAgents, "oa-plain", outputs, false, delivered, false, ""},
		{"pi-runtime", runtimePI, "test-model", outputs, false, delivered, false, ""},
		{"team-turn", runtimeOpenAIAgents, "oa-default", outputs, true, delivered, false, ""},
		{"id-out-of-grammar", runtimeOpenAIAgents, "oa-default", []graphField{{ID: "final.result", Type: "markdown", Required: true}}, false, "DELIVERED", false, "fallback_bounds"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var mu sync.Mutex
			calls := []runtimeCall{}
			handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				mu.Lock()
				calls = append(calls, call)
				mu.Unlock()
				completePi(w, test.reply)
			}
			pi := runtimeProvider(t, runtimePI, handle)
			defer pi.Close()
			oa := structuredWorker(t, 0, handle)
			defer oa.Close()
			h := newHarness(t, pi.URL)
			h.a.cfg.StructuredContracts = true
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
			c, tid, _ := h.register(t, "structured-"+test.name+"@example.test")
			var team *nodeTeam
			if test.team {
				value := fixtureTeam("sequential")
				value.Runtime = runtimeOpenAIAgents
				for i := range value.Members {
					value.Members[i].Runtime, value.Members[i].Model = runtimeOpenAIAgents, ""
				}
				team = &value
			}
			h.a.cfg.MetricsEnabled = true
			base := structuredCanvas(t, h, c, tid, "Structured "+test.name, test.runtime, test.model, test.outputs, team)
			accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "structured-" + test.name}, 202)
			awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "completed")
			// This harness owns its registry, so the absolute count is the decision itself:
			// an ineligible node must leave both series empty rather than record a zero.
			for _, outcome := range []string{"frozen", "fallback_bounds"} {
				want := float64(0)
				if outcome == test.outcome {
					want = 1
				}
				if got := collaborationMetric(t, h.a, "awwo_graph_output_contracts_total", "outcome", outcome); got != want {
					t.Fatal("contract outcome counter", outcome, got, "wanted", want)
				}
			}
			mu.Lock()
			captured := append([]runtimeCall{}, calls...)
			mu.Unlock()
			if len(captured) == 0 {
				t.Fatal("no worker call was captured")
			}
			for _, call := range captured {
				if call.ContractPresent != test.contract {
					t.Fatal("output contract presence", call.ContractPresent, "wanted", test.contract, call.SystemPrompt)
				}
				if !strings.Contains(call.SystemPrompt, "Frozen graph output contract") {
					t.Fatal("the frozen textual policy must travel either way", call.SystemPrompt)
				}
				if strings.Contains(call.SystemPrompt, "provider enforces this contract") != test.contract {
					t.Fatal("the schema sentence disagrees with the contract that was sent", call.SystemPrompt)
				}
				if !test.contract {
					continue
				}
				if call.OutputContract == nil || call.OutputContract.Version != outputContractVersion || len(call.OutputContract.Fields) != len(test.outputs) {
					t.Fatal("the contract did not survive the request", call.OutputContract)
				}
				for i, f := range call.OutputContract.Fields {
					if f.ID != test.outputs[i].ID || f.Type != test.outputs[i].Type || f.Required != test.outputs[i].Required {
						t.Fatal("a contract field differs from the frozen field", f)
					}
				}
			}
		})
	}
}

// A critique is discussion, not a deliverable: the review phase must send no contract
// while proposal and synthesis still carry the node's frozen envelope.
func TestPostgresGraphStructuredOutputCollaborationExcludesReview(t *testing.T) {
	var mu sync.Mutex
	calls := []runtimeCall{}
	handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
		mu.Lock()
		calls = append(calls, call)
		mu.Unlock()
		if strings.HasPrefix(call.Prompt, "[AwwO collaboration review") {
			completePi(w, "CRITIQUE: tighten the wording.")
			return
		}
		completePi(w, `{"result":"DELIVERED"}`)
	}
	pi := runtimeProvider(t, runtimePI, handle)
	defer pi.Close()
	oa := structuredWorker(t, 0, handle)
	defer oa.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.StructuredContracts = true
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	c, tid, _ := h.register(t, "structured-collaboration@example.test")
	prefix := "/tenants/" + tid
	aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Structured", "adapterType": runtimeOpenAIAgents, "model": "oa-default", "instructions": "NODE-PERSONA"}, 201)["id"].(string)
	contract := &graphContract{Version: 1, Outputs: []graphField{{ID: "result", Type: "markdown", Required: true}}}
	nodes := []any{}
	for _, id := range []string{"a", "b"} {
		nodes = append(nodes, map[string]any{"id": id, "kind": "session", "title": "Node " + id, "runtime": runtimeOpenAIAgents,
			"binding": map[string]string{"companyId": tid, "agentId": aid}, "contract": contract})
	}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Structured collaboration", "document": map[string]any{"nodes": nodes, "edges": []any{}}}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	accepted := h.request(t, c, "POST", base, map[string]any{"operationId": "structured-collaboration", "scope": []string{"a", "b"},
		"collaboration": collaborationPolicy{Goal: "Deliver the structured result", Rounds: 1, SynthesizerNodeID: "a"}}, 202)
	awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "completed")
	mu.Lock()
	captured := append([]runtimeCall{}, calls...)
	mu.Unlock()
	reviews, deliveries := 0, 0
	for _, call := range captured {
		review := strings.HasPrefix(call.Prompt, "[AwwO collaboration review")
		if call.ContractPresent == review {
			t.Fatal("contract presence follows the phase", review, call.ContractPresent, call.Prompt)
		}
		if review {
			reviews++
			if strings.Contains(call.SystemPrompt, "provider enforces this contract") {
				t.Fatal("a critique was told a schema would be enforced")
			}
			continue
		}
		deliveries++
	}
	if reviews == 0 || deliveries == 0 {
		t.Fatal("collaboration did not exercise both phases", reviews, deliveries)
	}
}

// The worker's refusal is named only for a run that actually carried a contract, and it
// costs exactly one provider call, so a delivery that fails its envelope is not retried.
func TestPostgresGraphStructuredOutputRefusalIsNamedAndCostsOneCall(t *testing.T) {
	for _, test := range []struct {
		name   string
		reply  func(http.ResponseWriter)
		detail string
		// failedRows is how many invocations end as failures. A worker refusal is a
		// failed provider call; output that only Go's validator rejects arrived
		// successfully, so its invocation stays completed and the node alone fails.
		failedRows int
	}{
		{"worker-refuses", func(w http.ResponseWriter) { failWorker(w, "OUTPUT_CONTRACT_INVALID") }, "output_contract_invalid", 1},
		{"go-validator-refuses", func(w http.ResponseWriter) { completePi(w, `{"count":2}`) }, "", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				calls.Add(1)
				if !call.ContractPresent {
					t.Error("capable node sent no contract")
				}
				test.reply(w)
			}
			pi := runtimeProvider(t, runtimePI, handle)
			defer pi.Close()
			oa := structuredWorker(t, 0, handle)
			defer oa.Close()
			h := newHarness(t, pi.URL)
			h.a.cfg.StructuredContracts = true
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
			c, tid, _ := h.register(t, "structured-refusal-"+test.name+"@example.test")
			outputs := []graphField{{ID: "result", Type: "markdown", Required: true}, {ID: "count", Type: "number"}}
			base := structuredCanvas(t, h, c, tid, "Refusal", runtimeOpenAIAgents, "oa-default", outputs, nil)
			accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "structured-refusal-" + test.name}, 202)
			done := awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "failed")
			node := done["nodes"].([]any)[0].(map[string]any)
			var invocations, failed int
			ctx := context.Background()
			if err := h.db.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); err != nil {
				t.Fatal(err)
			}
			if err := h.db.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND status='failed'", tid).Scan(&failed); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 || invocations != 1 || failed != test.failedRows {
				t.Fatal("a refused delivery was retried or misreported in the ledger", calls.Load(), invocations, failed, test.failedRows)
			}
			if node["state"] != "failed" {
				t.Fatal("node did not fail", node)
			}
			if test.detail != "" && node["detail"] != test.detail {
				t.Fatal("refusal detail", node["detail"], "wanted", test.detail)
			}
			if test.detail == "" && node["detail"] == "output_contract_invalid" {
				t.Fatal("Go's own validation was reported as the worker's refusal", node)
			}
		})
	}
}

// The response-format envelope occupies context, so admission counts it. The same canvas
// on a model without the capability still fits, which is what proves the reserve is real.
func TestPostgresGraphStructuredOutputReserveRefusesBeforeInvocation(t *testing.T) {
	outputs := []graphField{{ID: "result", Type: "markdown", Required: true}}
	n := graphNode{ID: "only", Kind: "session", Title: "Structured", Contract: &graphContract{Version: 1, Outputs: outputs}}
	prompt, err := graphPrompt(n, graphDocument{Nodes: []graphNode{n}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	instructions := graphSystemPrompt("NODE-PERSONA", effectiveOutputPolicy(executionSnapshot{
		OutputPolicy:   graphOutputPolicy(n),
		OutputContract: &outputContract{Version: 1, Fields: []outputContractField{{ID: "result", Type: "markdown", Required: true}}},
	}))
	// Room for everything except the reserve: the capable model must refuse and the
	// model without the capability must not.
	budget := len(prompt) + len(instructions) + 1000
	for _, test := range []struct {
		model  string
		state  string
		detail string
		calls  int32
	}{
		{"oa-default", "failed", "context_limit", 0},
		{"oa-plain", "completed", "", 1},
	} {
		t.Run(test.model, func(t *testing.T) {
			var calls atomic.Int32
			handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				calls.Add(1)
				completePi(w, `{"result":"DELIVERED"}`)
			}
			pi := runtimeProvider(t, runtimePI, handle)
			defer pi.Close()
			oa := structuredWorker(t, budget, handle)
			defer oa.Close()
			h := newHarness(t, pi.URL)
			h.a.cfg.StructuredContracts = true
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
			c, tid, _ := h.register(t, "structured-reserve-"+test.model+"@example.test")
			base := structuredCanvas(t, h, c, tid, "Reserve", runtimeOpenAIAgents, test.model, outputs, nil)
			accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "structured-reserve-" + test.model}, 202)
			done := awaitGraph(t, h, c, base+"/"+accepted["id"].(string), test.state)
			node := done["nodes"].([]any)[0].(map[string]any)
			var invocations int
			if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != test.calls {
				t.Fatal("provider calls", calls.Load(), "wanted", test.calls)
			}
			if test.detail != "" && (node["detail"] != test.detail || invocations != 0) {
				t.Fatal("the reserve did not refuse before admission", node, invocations)
			}
		})
	}
}

// The reserve is charged against history trimming too, which is a different expression
// from the admission bound above: a capable node keeps less prior conversation than the
// same canvas on a model without the capability. A collaboration turn is bounded by the
// very same admission expression as a plain node, so the reserve test above covers it.
func TestPostgresGraphStructuredOutputReserveTrimsHistory(t *testing.T) {
	outputs := []graphField{{ID: "result", Type: "markdown", Required: true}}
	n := graphNode{ID: "only", Kind: "session", Title: "Structured", Contract: &graphContract{Version: 1, Outputs: outputs}}
	prompt, err := graphPrompt(n, graphDocument{Nodes: []graphNode{n}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	instructions := graphSystemPrompt("NODE-PERSONA", effectiveOutputPolicy(executionSnapshot{
		OutputPolicy:   graphOutputPolicy(n),
		OutputContract: &outputContract{Version: 1, Fields: []outputContractField{{ID: "result", Type: "markdown", Required: true}}},
	}))
	// Room for two large history messages without the reserve, and for fewer with it.
	delivered := `{"result":"` + strings.Repeat("D", 6000) + `"}`
	budget := len(prompt) + len(instructions) + 32 + 15000
	kept := map[string]int{}
	for _, model := range []string{"oa-default", "oa-plain"} {
		var mu sync.Mutex
		calls := []runtimeCall{}
		handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
			mu.Lock()
			calls = append(calls, call)
			mu.Unlock()
			completePi(w, delivered)
		}
		pi := runtimeProvider(t, runtimePI, handle)
		oa := structuredWorker(t, budget, handle)
		h := newHarness(t, pi.URL)
		h.a.cfg.StructuredContracts = true
		h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
		c, tid, _ := h.register(t, "structured-history-"+model+"@example.test")
		prefix := "/tenants/" + tid
		aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Structured", "adapterType": runtimeOpenAIAgents, "model": model, "instructions": "NODE-PERSONA"}, 201)["id"].(string)
		node := map[string]any{"id": "only", "kind": "session", "title": "Structured", "runtime": runtimeOpenAIAgents,
			"binding": map[string]string{"companyId": tid, "agentId": aid}, "contract": &graphContract{Version: 1, Outputs: outputs}}
		doc := map[string]any{"nodes": []any{node}, "edges": []any{}}
		cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "History", "document": doc}, 201)["id"].(string)
		base := prefix + "/canvases/" + cid + "/graph-runs"
		first := h.request(t, c, "POST", base, map[string]string{"operationId": "structured-history-one"}, 202)
		done := awaitGraph(t, h, c, base+"/"+first["id"].(string), "completed")
		// Pin the node to the session the first run created, so the second run has history.
		node["issueId"] = done["nodes"].([]any)[0].(map[string]any)["sessionId"]
		h.request(t, c, "PUT", prefix+"/canvases/"+cid, map[string]any{"name": "History", "version": 1, "document": doc}, 200)
		second := h.request(t, c, "POST", base, map[string]string{"operationId": "structured-history-two"}, 202)
		awaitGraph(t, h, c, base+"/"+second["id"].(string), "completed")
		mu.Lock()
		if len(calls) < 2 {
			mu.Unlock()
			t.Fatal("the second run never dispatched", model, len(calls))
		}
		kept[model] = len(calls[len(calls)-1].Messages)
		mu.Unlock()
		pi.Close()
		oa.Close()
	}
	if kept["oa-plain"] == 0 || kept["oa-default"] >= kept["oa-plain"] {
		t.Fatal("the reserve did not tighten history trimming", kept)
	}
}

// A durable snapshot can be edited by hand or outlive the capability it was frozen
// against. The contract is re-checked before quota is reserved, so an inconsistent one
// fails the run and leaves no ledger row behind.
func TestPostgresGraphStructuredOutputSnapshotInconsistencyFailsClosed(t *testing.T) {
	for _, test := range []struct {
		name string
		team bool
		// frozen is whether admission itself freezes a contract for this node, which the
		// team case must not; the corruption then supplies one that never belonged there.
		frozen  bool
		corrupt func(*executionSnapshot)
	}{
		{"out-of-grammar-contract", false, true, func(s *executionSnapshot) { s.OutputContract.Fields[0].ID = "final.result" }},
		{"contract-on-a-team-snapshot", true, false, func(s *executionSnapshot) {
			s.OutputContract = &outputContract{Version: outputContractVersion, Fields: []outputContractField{{ID: "result", Type: "markdown", Required: true}}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) { structuredSnapshotFailsClosed(t, test.team, test.frozen, test.corrupt) })
	}
}

func structuredSnapshotFailsClosed(t *testing.T, team, frozen bool, corrupt func(*executionSnapshot)) {
	entered, release := make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	var once sync.Once
	handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
		if first.CompareAndSwap(false, true) {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		completePi(w, `{"result":"DELIVERED"}`)
	}
	pi := runtimeProvider(t, runtimePI, handle)
	defer pi.Close()
	oa := structuredWorker(t, 0, handle)
	defer oa.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.StructuredContracts = true
	defer once.Do(func() { close(release) })
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	c, tid, _ := h.register(t, "structured-snapshot@example.test")
	prefix := "/tenants/" + tid
	aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Structured", "adapterType": runtimeOpenAIAgents, "model": "oa-default", "instructions": "NODE-PERSONA"}, 201)["id"].(string)
	outputs := []graphField{{ID: "result", Type: "markdown", Required: true}}
	binding := map[string]string{"companyId": tid, "agentId": aid}
	upstream := map[string]any{"id": "upstream", "kind": "session", "title": "upstream", "runtime": runtimeOpenAIAgents, "binding": binding,
		"contract": &graphContract{Version: 1, Outputs: outputs}}
	downstream := map[string]any{"id": "downstream", "kind": "session", "title": "downstream", "runtime": runtimeOpenAIAgents, "binding": binding,
		"contract": &graphContract{Version: 1, Inputs: []graphField{{ID: "source", Type: "text", Required: true}}, Outputs: outputs}}
	if team {
		value := fixtureTeam("sequential")
		value.Runtime = runtimeOpenAIAgents
		for i := range value.Members {
			value.Members[i].Runtime, value.Members[i].Model = runtimeOpenAIAgents, ""
		}
		downstream["team"] = &value
	}
	doc := map[string]any{"nodes": []any{upstream, downstream}, "edges": []map[string]string{
		{"id": "edge", "fromNode": "upstream", "fromPort": "out:result", "toNode": "downstream", "toPort": "in:source", "dataType": "text"}}}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Snapshot", "document": doc}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]string{"operationId": "structured-snapshot-operation"}, 202)["id"].(string)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the first node never dispatched")
	}
	ctx := context.Background()
	var raw []byte
	if err := h.db.QueryRow(ctx, "SELECT execution_snapshot FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id='downstream'", tid, gid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var snap executionSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		t.Fatal(err)
	}
	// Also proves what admission itself decided for this waiting node: a plain node froze
	// a contract of its own, and a team node froze none at all.
	if frozen != (snap.OutputContract != nil) {
		t.Fatal("admission froze the wrong thing for this node", frozen, string(raw))
	}
	corrupt(&snap)
	edited, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.db.Exec(ctx, "UPDATE graph_run_nodes SET execution_snapshot=$3 WHERE tenant_id=$1 AND graph_id=$2 AND node_id='downstream'", tid, gid, edited); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(release) })
	done := awaitGraph(t, h, c, base+"/"+gid, "failed")
	var invocations int
	if err = h.db.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, value := range done["nodes"].([]any) {
		node := value.(map[string]any)
		if node["nodeId"] != "downstream" {
			continue
		}
		seen = true
		if node["state"] != "failed" || node["detail"] != "snapshot_invalid" {
			t.Fatal("an inconsistent contract did not fail closed", node)
		}
	}
	// The graph API keys nodes by nodeId; a wrong key must not skip the assertion silently.
	if !seen {
		t.Fatal("the downstream node is missing from the graph response", done["nodes"])
	}
	// Only the upstream node ever reached the provider.
	if invocations != 1 {
		t.Fatal("the refused snapshot still reserved quota", invocations)
	}
}
