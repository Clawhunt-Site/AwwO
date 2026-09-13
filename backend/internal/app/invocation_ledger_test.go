package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func observationFixture(input, output any) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{"version": 1, "usage": map[string]any{"status": "reported", "source": "provider_raw", "inputTokens": input, "outputTokens": output}, "timing": map[string]any{"workerTotalMs": 100, "setupMs": 10, "providerMs": 80, "providerTtftMs": 30, "workerFirstDeltaMs": 50}})
	return raw
}
func TestInvocationObservabilityValidation(t *testing.T) {
	tests := []struct {
		name string
		raw  json.RawMessage
		want string
		zero bool
	}{
		{"legacy", nil, "unavailable", false},
		{"explicit zero", observationFixture(0, 0), "reported", true},
		{"valid", observationFixture(12, 3), "reported", false},
		{"missing input", observationFixture(nil, 3), "invalid", false},
		{"negative", observationFixture(-1, 3), "invalid", false},
		{"fraction", observationFixture(1.5, 3), "invalid", false},
		{"oversize", observationFixture(9007199254740992, 3), "invalid", false},
		{"unknown version", []byte(`{"version":2,"usage":{}}`), "invalid", false},
		{"total mismatch", []byte(`{"version":1,"usage":{"status":"reported","source":"provider_raw","inputTokens":5,"outputTokens":3,"providerTotalTokens":10}}`), "invalid", false},
		{"cache subset", []byte(`{"version":1,"usage":{"status":"reported","source":"provider_raw","inputTokens":5,"outputTokens":3,"cachedInputTokens":6}}`), "invalid", false},
		{"reasoning subset", []byte(`{"version":1,"usage":{"status":"reported","source":"provider_raw","inputTokens":5,"outputTokens":3,"reasoningTokens":4}}`), "invalid", false},
		{"SDK unknown zero", []byte(`{"version":1,"usage":{"status":"reported","source":"none","inputTokens":0,"outputTokens":0}}`), "invalid", false},
		{"missing provider", []byte(`{"version":1,"usage":{"status":"unavailable","source":"none"}}`), "unavailable", false},
		{"partial", []byte(`{"version":1,"usage":{"status":"partial","source":"provider_raw","inputTokens":0}}`), "partial", true},
		{"invalid timing", []byte(`{"version":1,"usage":{"status":"unavailable","source":"none"},"timing":{"workerTotalMs":10,"providerTtftMs":30,"providerMs":20}}`), "invalid", false},
		{"content rejected", []byte(`{"version":1,"usage":{"status":"unavailable","source":"none"},"prompt":"sensitive-canary"}`), "invalid", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, _ := parseInvocationObservability(tt.raw, 10*time.Second)
			if u.Status != tt.want {
				t.Fatalf("got %+v", u)
			}
			if tt.zero && (u.InputTokens == nil || *u.InputTokens != 0) {
				t.Fatal("explicit zero lost")
			}
			if u.Status == "invalid" || u.Status == "unavailable" {
				if u.InputTokens != nil || u.OutputTokens != nil {
					t.Fatal("missing became token amount")
				}
			}
		})
	}
}

func completeObserved(w http.ResponseWriter, text string, raw json.RawMessage) {
	payload, _ := json.Marshal(map[string]any{"type": "completed", "text": text, "observability": raw})
	fmt.Fprintf(w, "data: %s\n\n", payload)
}
func TestPostgresInvocationLedgerAtomicAndIdempotent(t *testing.T) {
	var calls atomic.Int32
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completeObserved(w, "ACCOUNTED", observationFixture(12, 3))
	})
	defer provider.Close()
	h := newHarness(t, provider.URL)
	c, tid, _ := h.register(t, "ledger-atomic@example.test")
	_, _, sid := h.fixture(t, c, tid)
	_, err := h.db.Exec(context.Background(), `CREATE SEQUENCE fail_ledger_once;CREATE FUNCTION fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' AND nextval('fail_ledger_once')=1 THEN RAISE EXCEPTION 'transient terminal failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_ledger BEFORE UPDATE ON model_invocations FOR EACH ROW EXECUTE FUNCTION fail_ledger()`)
	if err != nil {
		t.Fatal(err)
	}
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "ledger-atomic"}, 202)
	rid := run["id"].(string)
	h.awaitRun(t, c, tid, rid, "completed")
	var input, output, total, events, messages int64
	var status, source, admission, cost string
	err = h.db.QueryRow(context.Background(), `SELECT input_tokens,output_tokens,computed_total_tokens,usage_status,usage_source,admission_status,cost_status FROM model_invocations WHERE id=$1`, rid).Scan(&input, &output, &total, &status, &source, &admission, &cost)
	if err != nil || input != 12 || output != 3 || total != 15 || status != "reported" || source != "provider_raw" || admission != "accepted" || cost != "unavailable" {
		t.Fatalf("ledger %v %d %d %d %s %s %s %s", err, input, output, total, status, source, admission, cost)
	}
	facts := &invocationFacts{Runtime: runtimePI, Model: "test", Admission: "accepted"}
	facts.receive(observationFixture(999, 999), 10*time.Second)
	if err = h.a.finishOnce(context.Background(), tid, rid, "completed", "SHOULD NOT REPLACE", "", facts); err != nil {
		t.Fatal(err)
	}
	h.db.QueryRow(context.Background(), `SELECT input_tokens FROM model_invocations WHERE id=$1`, rid).Scan(&input)
	h.db.QueryRow(context.Background(), `SELECT count(*) FROM run_events WHERE run_id=$1 AND data->>'type'='completed'`, rid).Scan(&events)
	h.db.QueryRow(context.Background(), `SELECT count(*) FROM messages WHERE run_id=$1 AND role='assistant'`, rid).Scan(&messages)
	if calls.Load() != 1 || input != 12 || events != 1 || messages != 1 {
		t.Fatal("duplicate provider/ledger/terminal", calls.Load(), input, events, messages)
	}
	var terminalVisible bool
	if err = h.db.QueryRow(context.Background(), "SELECT pg_visible_in_snapshot(completed_xid,pg_current_snapshot()) FROM model_invocations WHERE id=$1", rid).Scan(&terminalVisible); err != nil || !terminalVisible {
		t.Fatal("terminal transaction identity missing", err)
	}
	page := h.request(t, c, "GET", "/tenants/"+tid+"/runs/"+rid+"/invocations", nil, 200)
	if len(page["items"].([]any)) != 1 {
		t.Fatal("actual invocation missing from paginated API", page)
	}
}

func TestPostgresTeamLedgerRecordsEachInvocation(t *testing.T) {
	var calls atomic.Int32
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completeObserved(w, "TEAM ACCOUNTED", observationFixture(0, 3))
	})
	defer provider.Close()
	h := newHarness(t, provider.URL)
	c, tid, _ := h.register(t, "ledger-team@example.test")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "team-ledger"}, 202)
	rid := run["id"].(string)
	h.awaitRun(t, c, tid, rid, "completed")
	var n, input, output int64
	err := h.db.QueryRow(context.Background(), `SELECT count(*),sum(input_tokens),sum(output_tokens) FROM model_invocations WHERE run_id=$1 AND status='completed' AND usage_status='reported' AND turn_id=id`, rid).Scan(&n, &input, &output)
	if err != nil || n != 3 || input != 0 || output != 9 || calls.Load() != 3 {
		t.Fatal("team ledger", err, n, input, output, calls.Load())
	}
}

func TestPostgresInvocationTransportLossStaysUnknown(t *testing.T) {
	var calls atomic.Int32
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		fmt.Fprint(w, "data: {\"type\":\"text_delta\",\"delta\":\"partial\"}\n\n")
	})
	defer provider.Close()
	h := newHarness(t, provider.URL)
	c, tid, _ := h.register(t, "ledger-unknown@example.test")
	_, _, sid := h.fixture(t, c, tid)
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "unknown-ledger"}, 202)
	rid := run["id"].(string)
	h.awaitRun(t, c, tid, rid, "failed")
	var usage, cost string
	var input *int64
	err := h.db.QueryRow(context.Background(), `SELECT usage_status,cost_status,input_tokens FROM model_invocations WHERE id=$1`, rid).Scan(&usage, &cost, &input)
	if err != nil || usage != "unknown" || cost != "unknown" || input != nil || calls.Load() != 1 {
		t.Fatal("unknown billed as zero or replayed", err, usage, cost, input, calls.Load())
	}
}

func TestPostgresInvocationPermanentLedgerFailureNeverCompletes(t *testing.T) {
	var calls atomic.Int32
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completeObserved(w, "PAID RESULT", observationFixture(4, 5))
	})
	defer provider.Close()
	h := newHarness(t, provider.URL)
	c, tid, _ := h.register(t, "ledger-permanent@example.test")
	_, _, sid := h.fixture(t, c, tid)
	_, err := h.db.Exec(context.Background(), `CREATE FUNCTION reject_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'permanent ledger failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_ledger BEFORE UPDATE ON model_invocations FOR EACH ROW EXECUTE FUNCTION reject_ledger()`)
	if err != nil {
		t.Fatal(err)
	}
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "permanent-ledger"}, 202)
	rid := run["id"].(string)
	h.awaitRun(t, c, tid, rid, "interrupted")
	var completed int
	h.db.QueryRow(context.Background(), `SELECT count(*) FROM run_events WHERE run_id=$1 AND data->>'type'='completed'`, rid).Scan(&completed)
	if completed != 0 || calls.Load() != 1 {
		t.Fatal("published completed or replayed", completed, calls.Load())
	}
	var usage string
	h.db.QueryRow(context.Background(), `SELECT usage_status FROM model_invocations WHERE id=$1`, rid).Scan(&usage)
	if !strings.EqualFold(usage, "unknown") {
		t.Fatal(usage)
	}
}

func TestPostgresInvocationCostUsesReservedPrice(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		close(started)
		select {
		case <-release:
			completeObserved(w, "PRICED", observationFixture(12, 3))
		case <-r.Context().Done():
		}
	})
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.MetricsEnabled = true
	c, tid, _ := h.register(t, "frozen-price@example.test")
	_, _, sid := h.fixture(t, c, tid)
	raw := strings.NewReplacer("openai-agents:fixture", "pi:test-model", `"cachedInput":"500000"`, `"cachedInput":null`, "replace_input_rate_for_subset", "included_in_input_rate").Replace(pricingFixture)
	var err error
	h.a.pricing, err = ParseModelPricing(raw)
	if err != nil {
		t.Fatal(err)
	}
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "frozen-price"}, 202)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("provider never admitted")
	}
	// A later catalog edit must not re-price an already accepted invocation.
	h.a.pricing.Models["pi:test-model"] = ModelPrice{}
	close(release)
	rid := run["id"].(string)
	h.awaitRun(t, c, tid, rid, "completed")
	page := h.request(t, c, "GET", "/tenants/"+tid+"/runs/"+rid+"/invocations", nil, 200)
	item := page["items"].([]any)[0].(map[string]any)
	if item["costStatus"] != "estimated" || item["estimatedCostMicrousd"] != "48" || item["pricingVersion"] != "test-v1" {
		t.Fatal("price snapshot not honored", item)
	}
	metrics := metricText(t, h.a)
	if !strings.Contains(metrics, "awwo_model_estimated_cost_usd_total") {
		t.Fatal("committed estimate metric missing")
	}
}
