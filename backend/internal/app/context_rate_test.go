package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// A worker's published rate resolves as the budget does, and only a rate a worker would accept loosens a budget.
func TestModelRateResolvesAsTheBudget(t *testing.T) {
	var h piHealth
	raw := `{"ready":true,"model":"m","limits":{"maxContextTextBytes":1000,"messageOverheadBytes":32,"proseBytesPerToken":2.95},
		"models":[{"id":"m","maxContextTextBytes":1000,"proseBytesPerToken":2.95},{"id":"x","maxContextTextBytes":900,"proseBytesPerToken":2.15},
		{"id":"far","maxContextTextBytes":900,"proseBytesPerToken":5},{"id":"odd","maxContextTextBytes":900,"proseBytesPerToken":2.13},
		{"id":"plain","maxContextTextBytes":900}]}`
	if e := json.Unmarshal([]byte(raw), &h); e != nil {
		t.Fatal(e)
	}
	for model, want := range map[string]float64{"": 2.95, "m": 2.95, "x": 2.15, "far": 1, "odd": 1, "plain": 1, "unknown": 1} {
		if got := h.modelRate(model); got != want {
			t.Errorf("modelRate(%q) = %v, want %v", model, got, want)
		}
	}
	// A workspace allowlist resolves an unnamed model to its default first, as modelLimits does.
	h.Allowed = &[]string{"x"}
	if got := h.modelRate(""); got != h.modelRate(h.defaultModel()) {
		t.Errorf("allowlisted default rate %v", got)
	}
	// A snapshot keeps no rate for the byte rule, so a run on a model without one freezes what it froze before.
	if frozenRate(1) != 0 || frozenRate(0) != 0 || frozenRate(2.95) != 2.95 {
		t.Fatal("frozenRate")
	}
	plain, _ := json.Marshal(executionSnapshot{Model: "m", Budget: 10})
	if bytes.Contains(plain, []byte("proseRate")) {
		t.Fatalf("a snapshot without a rate names one: %s", plain)
	}
	rated, _ := json.Marshal(executionSnapshot{Model: "m", Budget: 10, ProseRate: 2.95})
	var back executionSnapshot
	if !bytes.Contains(rated, []byte(`"proseRate":2.95`)) || json.Unmarshal(rated, &back) != nil || back.ProseRate != 2.95 {
		t.Fatalf("a rated snapshot: %s", rated)
	}
	if back.tokens(strings.Repeat("界", 300)) != 306 || (executionSnapshot{}).tokens(strings.Repeat("界", 300)) != 900 {
		t.Fatal("a snapshot counts its text at its rate, and byte for byte without one")
	}
}

// History is trimmed at the model's rate: pairs the byte rule leaves out still fit where the model reads them.
func TestBoundedHistoryCountsTheRate(t *testing.T) {
	history := append(historyPair("问题一"+strings.Repeat("内容", 300), "回答一"+strings.Repeat("内容", 300)),
		historyPair("问题二"+strings.Repeat("内容", 300), "回答二"+strings.Repeat("内容", 300))...)
	// Each pair is 3,618 bytes, 1,206 estimated tokens at 3, and 64 of framing; 2,568 remain beside the turn.
	budget := 2700
	if n := len(boundedHistoryAt(history, 100, budget, 32, 0, 1<<20)); n != 0 {
		t.Fatalf("byte rule kept %d messages of 3.6 KB pairs in a 2,700 budget", n)
	}
	if n := len(boundedHistoryAt(history, 100, budget, 32, 3, 1<<20)); n != 4 {
		t.Fatalf("at 3 bytes a token kept %d messages, want both pairs", n)
	}
	// Digits are strict whatever the rate.
	numbers := historyPair(strings.Repeat("1234 ", 300), strings.Repeat("5678 ", 300))
	if n := len(boundedHistoryAt(numbers, 100, budget, 32, 3, 1<<20)); n != 0 {
		t.Fatalf("digits kept %d messages", n)
	}
	// The worker's transport counts UTF-16 units across the texts, which a token budget no longer bounds: English at
	// 3 bytes a token fits the budget long before it fits the units, so the units decide.
	english := append(historyPair(strings.Repeat("plain words ", 400), strings.Repeat("plain words ", 400)),
		historyPair(strings.Repeat("plain words ", 400), strings.Repeat("plain words ", 400))...)
	if n := len(boundedHistoryAt(english, 0, 100000, 32, 3, 1<<20)); n != 4 {
		t.Fatalf("with room, kept %d messages", n)
	}
	if n := len(boundedHistoryAt(english, 0, 100000, 32, 3, 2*4800+100)); n != 2 {
		t.Fatalf("with room for one pair's 9,600 units, kept %d messages", n)
	}
	if n := len(boundedHistoryAt(english, 0, 100000, 32, 3, 0)); n != 0 {
		t.Fatalf("with no units left, kept %d messages", n)
	}
	health := piHealth{Limits: map[string]any{"totalTextChars": float64(500000)}}
	if health.textUnitsLimit() != 500000 || (piHealth{}).textUnitsLimit() != 262144 || (piHealth{Limits: map[string]any{"totalTextChars": "x"}}).textUnitsLimit() != 262144 {
		t.Fatal("textUnitsLimit")
	}
	if utf16Len("a界😀") != 4 || utf16Len("\xff") != 1 {
		t.Fatal("utf16Len")
	}
}

// A team member's turn counts its prompt and system at the rate of its model in the frozen health its budget came from.
func TestTeamTurnCountsTheMemberRate(t *testing.T) {
	m := fixtureTeam("sequential").Members[0]
	health := piHealth{Model: m.Model, Limits: map[string]any{"maxContextTextBytes": float64(100000), "messageOverheadBytes": float64(32), "proseBytesPerToken": float64(3)}}
	snap := executionSnapshot{Instructions: "说明", RuntimeHealth: runtimeCatalog{m.Runtime: health}}
	input := teamTurnInput{Task: strings.Repeat("任务内容", 1000), Purpose: "work"}
	system := teamSystemPrompt(snap.Instructions, m)
	budget := len(system) + 6000
	if _, _, _, _, e := prepareTeamInput(snap, m, input, budget, 32); e != nil {
		t.Fatalf("12 KB of Chinese at 3 bytes a token fits a %d budget: %v", budget, e)
	}
	plain := executionSnapshot{Instructions: snap.Instructions}
	if _, _, _, _, e := prepareTeamInput(plain, m, input, budget, 32); e == nil || e.Error() != "context_limit" {
		t.Fatalf("without the member's health the byte rule refuses it: %v", e)
	}
}

// A team member's history leaves room for the note the turn's system prompt gains after it (the member's model and the
// date, teams.go) within the worker's transport limit on all texts.
func TestTeamHistoryLeavesRoomForTheModelNote(t *testing.T) {
	m := fixtureTeam("sequential").Members[0]
	health := piHealth{Model: m.Model, Limits: map[string]any{"maxContextTextBytes": float64(250000), "messageOverheadBytes": float64(32),
		"proseBytesPerToken": float64(3), "totalTextChars": float64(40000)}}
	history := []json.RawMessage{}
	for i := 0; i < 6; i++ {
		history = append(history, historyPair(strings.Repeat("问", 2900), strings.Repeat("答", 2900))...)
	}
	snap := executionSnapshot{Instructions: "说明", RuntimeHealth: runtimeCatalog{m.Runtime: health}, History: &history, HistoryAvailable: len(history)}
	input := teamTurnInput{Task: "整理", Purpose: "work"}
	_, _, without, _, e := prepareTeamInputWith(snap, m, input, 250000, 32, 0)
	if e != nil {
		t.Fatal(e)
	}
	_, _, with, _, e := prepareTeamInputWith(snap, m, input, 250000, 32, 6000)
	if e != nil || len(with) >= len(without) || len(without) == 0 {
		t.Fatalf("history kept %d messages without the note's room, %d with it (%v)", len(without), len(with), e)
	}
}

// The direct-task proxy counts a call's JSON at the run's rate, as the worker does: prose the byte rule refused is
// admitted, base64 of the same size is not.
func TestComputerCallCountsTheRate(t *testing.T) {
	call := func(content string) []byte {
		raw, _ := json.Marshal(map[string]any{"messages": []map[string]string{{"role": "user", "content": content}}})
		return raw
	}
	prose, dense := call(strings.Repeat("画布方案", 1000)), call(strings.Repeat("QUJD", 3000))
	budget := 6000
	if _, _, e := validateComputerCompletion(prose, budget); e == nil || e.Error() != "context_limit" {
		t.Fatal("byte rule: 12 KB over a 6,000 budget")
	}
	completion, _, e := validateComputerCompletionAt(prose, budget, 3)
	if e != nil {
		t.Fatal(e)
	}
	lease := &computerLease{tenantID: "t", runID: "r", sessionID: "s", snapshot: executionSnapshot{Model: "m", Budget: budget, ProseRate: 3}}
	if !computerCallFits(prose, completion, lease) {
		t.Fatal("prose at the run's rate fits the worker's measure")
	}
	if _, _, e = validateComputerCompletionAt(dense, budget, 3); e == nil || e.Error() != "context_limit" {
		t.Fatal("base64 counts byte for byte")
	}
	lease.snapshot.ProseRate = 0
	if computerCallFits(prose, completion, lease) {
		t.Fatal("a run frozen without a rate keeps the byte rule")
	}
}

// rateWorker is a Pi worker whose default model takes *budget estimated tokens at the rate it publishes, and answers
// every run with a valid plan.
func rateWorker(t *testing.T, budget *atomic.Int64, rate float64) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test",
				"limits": map[string]any{"maxContextTextBytes": budget.Load(), "messageOverheadBytes": 32, "proseBytesPerToken": rate}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": progressPlan})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(server.Close)
	return server
}

// A run whose model publishes a rate is admitted while its estimate fits, its snapshot freezes the rate, and a run of
// dense text of the same size is still refused before any call.
func TestPostgresProseRateAdmitsWhatTheModelReads(t *testing.T) {
	var budget atomic.Int64
	budget.Store(8000)
	h := newHarness(t, rateWorker(t, &budget, 3).URL)
	c, tid, _ := h.register(t, "prose-rate@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	_, _, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	// 18,000 bytes of Chinese: over the budget byte for byte, 6,000 estimated tokens at 3.
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": strings.Repeat("界", 6000), "operationId": "rate-prose"}, 202)["id"].(string)
	h.awaitRun(t, c, tid, id, "completed")
	var rate float64
	if e := h.db.QueryRow(context.Background(), "SELECT (execution_snapshot->>'proseRate')::float8 FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&rate); e != nil || rate != 3 {
		t.Fatalf("frozen rate %v (%v)", rate, e)
	}
	refused := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": strings.Repeat("QUJD", 2500), "operationId": "rate-dense"}, 413)
	if refused["error"].(map[string]any)["code"] != "context_limit" {
		t.Fatalf("dense run: %#v", refused)
	}
	// Past the estimate too, Chinese is refused.
	h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": strings.Repeat("界", 9000), "operationId": "rate-too-much"}, 413)
}

// A run's prompt is bounded in UTF-16 code units, as its worker's transport counts it: 50,000 Chinese characters
// (150,000 bytes, past the 128,000 the bound once counted) are admitted and run, an emoji counts two, and the bound
// still holds for ASCII.
func TestPostgresPromptBoundCountsUnits(t *testing.T) {
	var budget atomic.Int64
	budget.Store(100000)
	h := newHarness(t, rateWorker(t, &budget, 3).URL)
	c, tid, _ := h.register(t, "prompt-units@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	_, _, sid := h.fixture(t, c, tid)
	run := func(prompt, operation string, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": prompt, "operationId": operation}, status)
	}
	h.awaitRun(t, c, tid, run(strings.Repeat("界", 50000), "units-chinese", 202)["id"].(string), "completed")
	// The part of a prompt whose files go with the run is bounded the same way.
	attached := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": strings.Repeat("界", 50000),
		"attachmentText": strings.Repeat("界", 50000), "operationId": "units-attachment"}, 202)
	h.awaitRun(t, c, tid, attached["id"].(string), "completed")
	for name, prompt := range map[string]string{"ascii": strings.Repeat("a", maxRunPromptUnits+1), "emoji": strings.Repeat("😀", maxRunPromptUnits/2+1)} {
		if refused := run(prompt, "units-over-"+name, 400); refused["error"].(map[string]any)["code"] != "invalid_input" {
			t.Fatalf("%s past the bound: %#v", name, refused)
		}
	}
	// 64,000 emoji are 128,000 units, within the bound, and 256,000 strict estimated tokens, past the model's budget.
	if refused := run(strings.Repeat("😀", maxRunPromptUnits/2), "units-emoji-budget", 413); refused["error"].(map[string]any)["code"] != "context_limit" {
		t.Fatalf("emoji at the bound: %#v", refused)
	}
}

// A plan's context is bounded in UTF-16 code units too: a Chinese canvas past the 120,000 bytes the bound once counted
// is planned whole, and one past 120,000 units is told a room in bytes, at the context's own bytes per unit, that is
// then planned.
func TestPostgresPlanBoundsCountUnits(t *testing.T) {
	var budget atomic.Int64
	budget.Store(200000)
	h := newHarness(t, rateWorker(t, &budget, 3).URL)
	c, tid, _ := h.register(t, "plan-units@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	h.request(t, c, "PUT", "/auth/preferences", map[string]any{"version": 0, "preferences": map[string]any{"personalization": map[string]any{
		"enabled": true, "aboutMe": "PLAN-UNITS-ABOUT", "instructions": "Keep it short."}}}, 200)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(context, operation string, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
			map[string]string{"prompt": "Build a data product", "context": context, "operationId": operation}, status)
	}
	whole := plan(strings.Repeat("界", 50000), "plan-units-1", 202)["id"].(string)
	h.awaitRun(t, c, tid, whole, "completed")
	// Its personal settings are within the bound in units too, and go with it.
	var prompt string
	if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, whole).Scan(&prompt); e != nil || !strings.Contains(prompt, "PLAN-UNITS-ABOUT") {
		t.Fatalf("the plan lost its personal settings (%v)", e)
	}
	// 130,000 characters, 10,000 units past the bound: 30,000 bytes of it come out, and the margin.
	r := roomOf(t, plan(strings.Repeat("界", 130000), "plan-units-2", 413))
	if r != 3*130000-30000-planContextRoomMargin {
		t.Fatalf("room %d", r)
	}
	h.awaitRun(t, c, tid, plan(strings.Repeat("界", r/3), "plan-units-3", 202)["id"].(string), "completed")
}

// A plan its selected knowledge takes past the prompt's bound, whose personal settings its size left out, is told a room
// that leaves their units too: a context of that size is admitted with them.
func TestPostgresPlanRoomLeavesUnitsForPersonalSettings(t *testing.T) {
	var budget atomic.Int64
	budget.Store(200000)
	h := newHarness(t, rateWorker(t, &budget, 3).URL)
	c, tid, _ := h.register(t, "plan-units-personal@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	h.request(t, c, "PUT", "/auth/preferences", map[string]any{"version": 0, "preferences": map[string]any{"personalization": map[string]any{
		"enabled": true, "aboutMe": "PLAN-UNITS-PERSONAL " + strings.Repeat("p", 900), "instructions": strings.Repeat("q", 1500)}}}, 200)
	source := h.request(t, c, "POST", "/tenants/"+tid+"/knowledge/sources", map[string]string{"title": "Evidence", "content": "SELECTED-EVIDENCE " + strings.Repeat("e", 100), "operationId": "units-personal-source"}, 201)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(context, operation string, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]any{"prompt": strings.Repeat("r", 8000), "context": context,
			"knowledgeRevisionIds": []string{source["currentRevisionId"].(string)}, "operationId": operation}, status)
	}
	// Context and request take 127,916 units: within the bound, without the settings; the knowledge takes it past.
	room := roomOf(t, plan(strings.Repeat("a", 119900), "units-personal-1", 413))
	id := plan(strings.Repeat("a", room), "units-personal-2", 202)["id"].(string)
	h.awaitRun(t, c, tid, id, "completed")
	var prompt string
	if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt); e != nil || !strings.Contains(prompt, "PLAN-UNITS-PERSONAL") {
		t.Fatalf("the plan of the room it was told lost its personal settings (%v)", e)
	}
}

// A canvas node's prompt is bounded in UTF-16 code units too: a brief of 50,000 Chinese characters (150,000 bytes)
// reaches its model whole.
func TestPostgresGraphPromptBoundCountsUnits(t *testing.T) {
	brief := strings.Repeat("界", 50000)
	var whole atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test",
				"limits": map[string]any{"maxContextTextBytes": 200000, "messageOverheadBytes": 32, "proseBytesPerToken": 3}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var call observedPiCall
		if json.NewDecoder(r.Body).Decode(&call) == nil && strings.Contains(call.Prompt, brief) {
			whole.Add(1)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		completePi(w, `{"result":"done"}`)
	}))
	t.Cleanup(server.Close)
	h := newHarness(t, server.URL)
	c, tid, _ := h.register(t, "graph-units@awwo.invalid")
	prefix := "/tenants/" + tid
	aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Brief", "adapterType": "pi", "model": "test-model", "instructions": "Summarise the brief."}, 201)["id"].(string)
	n := graphNode{ID: "only", Kind: "session", Title: "Brief", Contract: &graphContract{Version: 1,
		Inputs: []graphField{{ID: "brief", Type: "text", Value: brief}}, Outputs: []graphField{{ID: "result", Type: "text", Required: true}}}}
	n.Binding = &struct {
		CompanyID string `json:"companyId"`
		AgentID   string `json:"agentId"`
	}{CompanyID: tid, AgentID: aid}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Units", "document": graphDocument{Nodes: []graphNode{n}, Edges: []graphEdge{}}}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "graph-units-operation"}, 202)
	awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "completed")
	if whole.Load() != 1 {
		t.Fatalf("%d calls carried the whole brief", whole.Load())
	}
}

// A run its provider refuses as larger than its model's window (the worker's MODEL_CONTEXT_LIMIT) fails as one too large
// for its model, and its call settles as one that never began: not counted, not paid for. A canvas node refused so is not
// run again; any other failure of the model counts as before.
func TestPostgresProviderSizeRefusalNeitherCountsNorRepeats(t *testing.T) {
	var code atomic.Value
	code.Store("MODEL_CONTEXT_LIMIT")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "limits": map[string]any{"maxContextTextBytes": 100000, "messageOverheadBytes": 32}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "failed", "code": code.Load(), "message": "The model service refused the request."})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(server.Close)
	h := newHarness(t, server.URL)
	c, tid, _ := h.register(t, "provider-size@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	_, aid, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	ledger := func(id string) (admission, cost string) {
		t.Helper()
		if e := h.db.QueryRow(context.Background(), "SELECT admission_status,cost_status FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, id).Scan(&admission, &cost); e != nil {
			t.Fatal(e)
		}
		return
	}
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "provider-size-run"}, 202)["id"].(string)
	if done := h.awaitRun(t, c, tid, id, "failed"); done["error"] != "context_limit" {
		t.Fatalf("the run ended with %v", done["error"])
	}
	if admission, cost := ledger(id); admission != "rejected_before_start" || cost != "not_incurred" {
		t.Fatalf("the refused call settled %s / %s", admission, cost)
	}
	code.Store("MODEL_ERROR")
	other := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "provider-size-other"}, 202)["id"].(string)
	if done := h.awaitRun(t, c, tid, other, "failed"); done["error"] != "runtime_failed" {
		t.Fatalf("the other run ended with %v", done["error"])
	}
	if admission, cost := ledger(other); admission == "rejected_before_start" || cost == "not_incurred" {
		t.Fatalf("a model failure settled %s / %s, as a call that never began", admission, cost)
	}
	// A canvas node refused so fails at once, after its one call.
	code.Store("MODEL_CONTEXT_LIMIT")
	calls.Store(0)
	n := graphNode{ID: "only", Kind: "session", Title: "Sized"}
	n.Binding = &struct {
		CompanyID string `json:"companyId"`
		AgentID   string `json:"agentId"`
	}{CompanyID: tid, AgentID: aid}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Sized", "document": graphDocument{Nodes: []graphNode{n}, Edges: []graphEdge{}}}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "provider-size-graph"}, 202)
	done := awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "failed")
	if node := done["nodes"].([]any)[0].(map[string]any); node["detail"] != "context_limit" || calls.Load() != 1 {
		t.Fatalf("the node ended %v after %d calls", node["detail"], calls.Load())
	}
}

// A team member's turn its provider refuses as larger than its model's window settles the same way: a call that never
// began, and a turn and run that fail as too large for the model.
func TestPostgresTeamTurnSizeRefusalDoesNotCount(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"MODEL_CONTEXT_LIMIT\",\"message\":\"The model service refused the request.\"}\n\n")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "team-size@awwo.invalid")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	id := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "team-size-refusal"}, 202)["id"].(string)
	if done := h.awaitRun(t, c, tid, id, "failed"); done["error"] != "context_limit" {
		t.Fatalf("the team run ended with %v", done["error"])
	}
	var calls, counted int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*), count(*) FILTER (WHERE admission_status<>'rejected_before_start' OR cost_status<>'not_incurred') FROM model_invocations WHERE tenant_id=$1 AND run_id=$2",
		tid, id).Scan(&calls, &counted); e != nil || calls == 0 || counted != 0 {
		t.Fatalf("%d calls, %d of them counted (%v)", calls, counted, e)
	}
}

func TestSizeRefusalIsOnlyAProviderRefusalBeforeAnyWork(t *testing.T) {
	if runtimeFailureCode("MODEL_CONTEXT_LIMIT", true) != "context_limit" || runtimeFailureCode("CONTEXT_LIMIT", false) != "context_limit" ||
		runtimeFailureCode("MODEL_ERROR", false) != "runtime_failed" {
		t.Fatal("runtimeFailureCode")
	}
	for _, c := range []struct {
		facts invocationFacts
		want  bool
	}{
		{invocationFacts{WorkerCode: "MODEL_CONTEXT_LIMIT"}, true},
		{invocationFacts{WorkerCode: "MODEL_CONTEXT_LIMIT", Usage: missingUsage("unknown", "transport_unknown")}, true},
		// The Python worker's own measure, after its stream began.
		{invocationFacts{WorkerCode: "CONTEXT_LIMIT"}, true},
		{invocationFacts{WorkerCode: "MODEL_CONTEXT_LIMIT", OutputBytes: 1}, false},
		{invocationFacts{WorkerCode: "MODEL_CONTEXT_LIMIT", HiddenTokens: 1}, false},
		// A provider that reported usage read the request: it did work.
		{invocationFacts{WorkerCode: "MODEL_CONTEXT_LIMIT", Usage: InvocationUsage{Status: "reported"}}, false},
		{invocationFacts{WorkerCode: "MODEL_CONTEXT_LIMIT", Usage: InvocationUsage{Status: "partial"}}, false},
		{invocationFacts{WorkerCode: "MODEL_ERROR"}, false},
	} {
		if got := sizeRefusal(&c.facts); got != c.want {
			t.Errorf("sizeRefusal(%+v) = %v", c.facts, got)
		}
	}
	for body, want := range map[string]bool{
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:400:context_length_exceeded","detail":"before-output"}}`: true,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:413:context_length_exceeded","detail":"before-output"}}`: true,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:422:context_length_exceeded","detail":"before-output"}}`: true,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:200:context_length_exceeded","detail":"before-output"}}`: true,
		`{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:400:context_length_exceeded"}}`:                           true,
		// A provider's label without the worker's word that nothing else came back is a refusal after some of the answer
		// or beside usage that counts something, or an older worker's label of one.
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:400:context_length_exceeded"}}`:                          false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:413:context_length_exceeded"}}`:                          false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:422:context_length_exceeded"}}`:                          false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:200:context_length_exceeded"}}`:                          false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:400:context_length_exceeded","detail":"usage"}}`:         false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:429:context_length_exceeded","detail":"before-output"}}`: false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:500:context_length_exceeded","detail":"before-output"}}`: false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"stream:error:400:context_length_exceeded"}}`:                      false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"provider:400:invalid_request_error","detail":"before-output"}}`:   false,
		`{"error":{"code":"CONTEXT_LIMIT","reason":"provider:400:context_length_exceeded","detail":"before-output"}}`:  false,
		`{"error":{"code":"PROVIDER_ERROR","reason":"answer","detail":"context_length_exceeded"}}`:                     false,
	} {
		if got := computerSizeRefusal(502, []byte(body)); got != want {
			t.Errorf("computerSizeRefusal(502, %s) = %v", body, got)
		}
	}
	if computerSizeRefusal(413, []byte(`{"error":{"code":"PROVIDER_ERROR","reason":"provider:400:context_length_exceeded","detail":"before-output"}}`)) {
		t.Error("a status other than the worker's 502 for a provider's refusal")
	}
}

// A direct task's call is measured as its worker writes it again, compactly: the client's indentation changes nothing.
func TestComputerCallTokensIgnoreTheClientsIndentation(t *testing.T) {
	compact := []byte(`{"messages":[{"role":"user","content":"画布方案 plain words, if (a < b) {}"}],"tools":[]}`)
	var indented bytes.Buffer
	if e := json.Indent(&indented, compact, "", "        "); e != nil {
		t.Fatal(e)
	}
	if got, want := computerCallTokens(indented.Bytes(), 3.25), estimateTokens(string(compact), 3.25); got != want || computerCallTokens(compact, 3.25) != want {
		t.Fatalf("indented %d, compact %d, want %d", got, computerCallTokens(compact, 3.25), want)
	}
	if computerCallTokens([]byte("not json"), 3) != estimateTokens("not json", 3) {
		t.Fatal("a body that is not JSON is measured as sent")
	}
}

// A run of whitespace longer than 32 counts strictly whatever word follows it, so the class of that word (which a field
// the worker adds when it writes a direct task's call again can change: apps/computer-model.ts measures its own JSON)
// moves at most 32 bytes of whitespace: the API and the worker agree within the API's margin.
func TestLongWhitespaceCountsStrictlyWhateverFollows(t *testing.T) {
	content := strings.Repeat(" ", 30000) + strings.Repeat("x", 18)
	asSent := `{"messages":[{"role":"user","content":"` + content + `"}]}`
	asWritten := `{"messages":[{"role":"user","content":"` + content + `"}],"tools":[]}`
	sent, written := estimateTokens(asSent, 2.95), estimateTokens(asWritten, 2.95)
	if sent < 30000 || written < sent || written-sent > 64 {
		t.Fatalf("the call as sent counts %d, as its worker writes it %d", sent, written)
	}
	if strict, _ := textCost(strings.Repeat(" ", 33) + "word"); strict != 33 {
		t.Fatalf("33 spaces before a short word: %d strict", strict)
	}
	if strict, _ := textCost(strings.Repeat(" ", 32) + "word"); strict != 0 {
		t.Fatalf("32 spaces before a short word: %d strict", strict)
	}
}

func TestPlannerContextBytesForUnits(t *testing.T) {
	c := plannerContext{bytes: 300, units: 100}
	for units, want := range map[int]int{10: 30, 1: 3, 0: 0, -5: -5} {
		if got := c.bytesForUnits(units); got != want {
			t.Errorf("bytesForUnits(%d) = %d, want %d", units, got, want)
		}
	}
	// Rounded up: a byte short would leave a view that still does not fit.
	if got := (plannerContext{bytes: 10, units: 3}).bytesForUnits(1); got != 4 {
		t.Errorf("rounded %d", got)
	}
	if got := (plannerContext{}).bytesForUnits(7); got != 7 {
		t.Errorf("an empty context %d", got)
	}
}

// A plan's room counts the model's rate: a Chinese canvas the byte rule refused is planned whole, one past the estimate
// is told a room of Chinese that does fit, and a dense canvas gets the byte rule's room.
func TestPostgresPlanRoomCountsTheRate(t *testing.T) {
	var budget atomic.Int64
	budget.Store(20000)
	h := newHarness(t, rateWorker(t, &budget, 3).URL)
	c, tid, _ := h.register(t, "plan-rate@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(context, operation string, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
			map[string]string{"prompt": "Build a data product", "context": context, "operationId": operation}, status)
	}
	// 30,000 bytes of Chinese over a 20,000 budget: refused by the byte rule before (planning_context_test.go), planned
	// whole now.
	whole := plan(strings.Repeat("界", 10000), "plan-rate-1", 202)["id"].(string)
	h.awaitRun(t, c, tid, whole, "completed")
	// 90,000 bytes: past the estimate; the room it is told, in the same text, is planned.
	r := roomOf(t, plan(strings.Repeat("界", 30000), "plan-rate-2", 413))
	if r < 3*(20000-len(plannerInstructions)-2000) || r > 3*20000 {
		t.Fatalf("room %d bytes of Chinese for a 20,000-token budget at 3 bytes a token", r)
	}
	fits := plan(strings.Repeat("界", r/3), "plan-rate-3", 202)["id"].(string)
	h.awaitRun(t, c, tid, fits, "completed")
	// Base64 of 30,000 bytes counts byte for byte: its room is about the budget's bytes, as before.
	dense := roomOf(t, plan(strings.Repeat("QUJD", 7500), "plan-rate-4", 413))
	if dense <= 0 || dense > 20000 {
		t.Fatalf("dense room %d", dense)
	}
	h.awaitRun(t, c, tid, plan(strings.Repeat("QUJD", dense/4), "plan-rate-5", 202)["id"].(string), "completed")
}
