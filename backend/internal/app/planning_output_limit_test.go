package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// A failed planner call whose model wrote every token one answer of it holds ran out of room (plannerSpentOutput): its
// worker reported the call's output tokens, and they reach the cap the run's snapshot froze for its model, read from
// its runtime's health as the call's ledger reads it. Anything less, usage not reported, or no cap frozen, is not.
func TestPlannerSpentOutputReadsTheFrozenCap(t *testing.T) {
	health := piHealth{Model: "qwen", Models: []piModel{{ID: "qwen", MaxOutputTokens: 16384}, {ID: "haiku", MaxOutputTokens: 32000}, {ID: "unsaid"}}}
	snapshot := func(model string) executionSnapshot {
		return executionSnapshot{Runtime: runtimePI, Model: model, RuntimeHealth: runtimeCatalog{runtimePI: health}}
	}
	usage := func(status string, out *int64) InvocationUsage {
		return InvocationUsage{Status: status, Source: "provider_raw", OutputTokens: out}
	}
	for name, c := range map[string]struct {
		u    InvocationUsage
		s    executionSnapshot
		want bool
	}{
		"its whole cap":              {usage("reported", int64ptr(16384)), snapshot("qwen"), true},
		"past its cap":               {usage("reported", int64ptr(16400)), snapshot("qwen"), true},
		"partial usage at the cap":   {usage("partial", int64ptr(16384)), snapshot("qwen"), true},
		"the default model":          {usage("reported", int64ptr(16384)), snapshot("default"), true},
		"no model named":             {usage("reported", int64ptr(16384)), snapshot(""), true},
		"one token short":            {usage("reported", int64ptr(16383)), snapshot("qwen"), false},
		"under another model's cap":  {usage("reported", int64ptr(16384)), snapshot("haiku"), false},
		"usage not reported":         {usage("unknown", int64ptr(16384)), snapshot("qwen"), false},
		"no output tokens":           {usage("reported", nil), snapshot("qwen"), false},
		"zero output tokens":         {usage("reported", int64ptr(0)), snapshot("qwen"), false},
		"a model with no cap":        {usage("reported", int64ptr(16384)), snapshot("unsaid"), false},
		"a model not in the catalog": {usage("reported", int64ptr(16384)), snapshot("other"), false},
		"another runtime, no health": {usage("reported", int64ptr(16384)),
			executionSnapshot{Runtime: runtimeOpenAIAgents, Model: "qwen", RuntimeHealth: runtimeCatalog{runtimePI: health}}, false},
	} {
		if got := plannerSpentOutput(c.u, c.s); got != c.want {
			t.Errorf("%s: %v", name, got)
		}
	}
	// A profile named "default" is the one a snapshot naming "default" ran, as its worker resolves it.
	named := piHealth{Model: "qwen", Models: []piModel{{ID: "qwen", MaxOutputTokens: 128}, {ID: "default", MaxOutputTokens: 512}}}
	withDefault := executionSnapshot{Runtime: runtimePI, Model: "default", RuntimeHealth: runtimeCatalog{runtimePI: named}}
	if plannerSpentOutput(usage("reported", int64ptr(200)), withDefault) || !plannerSpentOutput(usage("reported", int64ptr(512)), withDefault) {
		t.Error(`a profile named "default"`)
	}
	// A snapshot stored before per-runtime health names no runtime (decoded as Pi's, teams.go) and keeps Pi's in health.
	var legacy executionSnapshot
	if err := json.Unmarshal([]byte(`{"model":"qwen","health":{"model":"qwen","models":[{"id":"qwen","maxOutputTokens":16384}]}}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if !plannerSpentOutput(usage("reported", int64ptr(16384)), legacy) || plannerSpentOutput(usage("reported", int64ptr(16383)), legacy) {
		t.Error("a Pi snapshot stored before per-runtime health")
	}
}

// A plan whose worker said only that its call failed (Pi's MODEL_ERROR) after the model wrote every token one answer of
// it holds fails as output_limit, which the canvas says as such and does not ask for again. With fewer tokens, or none
// reported (a Bedrock stream that broke off), it stays runtime_failed, which the canvas asks once more for
// (canvasPlanning.ts). A node's run is not a plan: the same failure there stays runtime_failed.
func TestPostgresPlannerOutOfRoomIsOutputLimit(t *testing.T) {
	var reported atomic.Int64 // the output tokens the next failed call reports; 0 reports no usage
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test",
				"limits": map[string]any{"maxContextTextBytes": 262144, "messageOverheadBytes": 32},
				"models": []map[string]any{{"id": "test-model", "provider": "test", "runtime": runtimePI, "maxContextTextBytes": 262144, "maxOutputTokens": 100}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		delta, _ := json.Marshal(map[string]any{"type": "text_delta", "delta": `{"version":1,"summary":"Report","operations":[`})
		fmt.Fprintf(w, "data: %s\n\n", delta)
		failed := map[string]any{"type": "failed", "code": "MODEL_ERROR", "message": "The model request failed. Check the server provider configuration."}
		if n := reported.Load(); n > 0 {
			failed["observability"] = map[string]any{"version": 1, "usage": map[string]any{"status": "reported", "source": "provider_raw", "inputTokens": 50, "outputTokens": n}}
		}
		raw, _ := json.Marshal(failed)
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(pi.Close)
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner-out-of-room@example.test")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	prefix := "/tenants/" + tid
	cv := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Empty", "document": map[string]any{"nodes": []any{}}}, 201)
	path := prefix + "/canvases/" + cv["id"].(string) + "/plan"
	for i, step := range []struct {
		tokens int64
		want   string
	}{{100, "output_limit"}, {101, "output_limit"}, {99, "runtime_failed"}, {0, "runtime_failed"}} {
		reported.Store(step.tokens)
		v := h.request(t, c, "POST", path, map[string]string{"prompt": "Write the report", "context": "{}", "operationId": fmt.Sprintf("planner-out-of-room-%d", i)}, 202)
		if v = h.awaitRun(t, c, tid, v["id"].(string), "failed"); v["error"] != step.want {
			t.Errorf("a plan whose call reported %d of 100 output tokens: %v, want %s", step.tokens, v["error"], step.want)
		}
	}
	reported.Store(100)
	_, _, sid := h.fixture(t, c, tid)
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "node-out-of-room"}, 202)["id"].(string)
	if done := h.awaitRun(t, c, tid, id, "failed"); done["error"] != "runtime_failed" {
		t.Errorf("a node's run with the same failure: %v", done["error"])
	}
}
