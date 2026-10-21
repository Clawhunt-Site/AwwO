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
