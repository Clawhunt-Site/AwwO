package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Unlike the general team fixture, this worker only cancels an existing key
// from the submitted runId. It deliberately ignores stream disconnection, as
// a buffering proxy or stalled worker can do, so a wrong DELETE cannot pass.
type strictTurnPI struct {
	mu       sync.Mutex
	active   map[string]chan struct{}
	matched  []string
	requests []string
	entered  chan observedPiCall
	server   *httptest.Server
}

func newStrictTurnPI(t *testing.T, run func(http.ResponseWriter, *http.Request, observedPiCall, <-chan struct{}, *strictTurnPI)) *strictTurnPI {
	return newStrictTurnRuntime(t, runtimePI, run)
}
func newStrictTurnRuntime(t *testing.T, runtime string, run func(http.ResponseWriter, *http.Request, observedPiCall, <-chan struct{}, *strictTurnPI)) *strictTurnPI {
	t.Helper()
	token := strings.Repeat("s", 32)
	if runtime == runtimeOpenAIAgents {
		token = strings.Repeat("o", 32)
	}
	p := &strictTurnPI{active: map[string]chan struct{}{"unrelated-run": make(chan struct{})}, entered: make(chan observedPiCall, 8)}
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{{"id": "test-model", "runtime": runtime, "maxContextTextBytes": 262144}, {"id": "alternate", "runtime": runtime, "maxContextTextBytes": 262144}}})
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(401)
			return
		}
		if r.Method == "DELETE" {
			id := strings.TrimPrefix(r.URL.Path, "/internal/runs/")
			p.mu.Lock()
			p.requests = append(p.requests, id)
			cancelled, exists := p.active[id]
			if exists {
				delete(p.active, id)
				p.matched = append(p.matched, id)
				close(cancelled)
			}
			p.mu.Unlock()
			if !exists {
				w.WriteHeader(404)
				return
			}
			w.WriteHeader(202)
			return
		}
		var request struct {
			observedPiCall
			Runtime string `json:"runtime"`
		}
		if e := json.NewDecoder(r.Body).Decode(&request); e != nil {
			t.Error(e)
			w.WriteHeader(400)
			return
		}
		if request.Runtime != runtime {
			t.Error("strict worker received wrong runtime")
			w.WriteHeader(400)
			return
		}
		b := request.observedPiCall
		cancelled := make(chan struct{})
		p.mu.Lock()
		p.active[b.RunID] = cancelled
		p.mu.Unlock()
		p.entered <- b
		run(w, r, b, cancelled, p)
	}))
	t.Cleanup(func() {
		p.mu.Lock()
		for id, cancel := range p.active {
			close(cancel)
			delete(p.active, id)
		}
		p.mu.Unlock()
		p.server.Close()
	})
	return p
}

func (p *strictTurnPI) next(t *testing.T) observedPiCall {
	t.Helper()
	select {
	case b := <-p.entered:
		return b
	case <-time.After(5 * time.Second):
		t.Fatal("Pi turn was never submitted")
		return observedPiCall{}
	}
}

func (p *strictTurnPI) awaitCancelled(t *testing.T, want []observedPiCall) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		ok := len(p.matched) == len(want) && len(p.active) == 1 && p.active["unrelated-run"] != nil
		found := map[string]bool{}
		for _, id := range p.matched {
			found[id] = true
		}
		for _, b := range want {
			ok = ok && found[b.RunID]
		}
		p.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	t.Fatal("DELETE did not target every active turn or affected unrelated work", p.matched, len(p.active))
}

func awaitSettledTeam(t *testing.T, h *harness, rid string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var active int
		e := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM run_turns WHERE run_id=$1 AND status IN ('queued','running'))+(SELECT count(*) FROM model_invocations WHERE run_id=$1 AND status='running')", rid).Scan(&active)
		if e != nil {
			t.Fatal(e)
		}
		if active == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("team cancellation did not settle turns and invocation slots")
}

func TestPostgresTeamCancelUsesTurnIDsDuringAdmissionAndParallelStreaming(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		headers bool
		queued  bool
	}{{"before-headers", false, false}, {"parallel-streaming", true, false}, {"waiting-invocation-slot", true, true}} {
		t.Run(scenario.name, func(t *testing.T) {
			p := newStrictTurnPI(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall, cancelled <-chan struct{}, p *strictTurnPI) {
				if scenario.headers {
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(200)
					http.NewResponseController(w).Flush()
				}
				<-cancelled
			})
			h := newHarness(t, p.server.URL)
			c, tid, _ := h.register(t, "cancel-turn-"+scenario.name+"@example.test")
			mode, expected := "sequential", 1
			if scenario.headers {
				mode, expected = "parallel", 2
			}
			if scenario.queued {
				expected = 1
				if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_concurrent_runs=1 WHERE id=$1", tid); e != nil {
					t.Fatal(e)
				}
			}
			_, _, sid := installTeam(t, h, c, tid, fixtureTeam(mode))
			prefix := "/tenants/" + tid
			rid := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "WAIT", "operationId": "cancel-precise-turn"}, 202)["id"].(string)
			accepted := []observedPiCall{}
			for i := 0; i < expected; i++ {
				accepted = append(accepted, p.next(t))
			}
			for _, b := range accepted {
				if b.RunID == rid {
					t.Fatal("fixture did not create distinct turn IDs")
				}
			}
			if scenario.queued {
				deadline := time.Now().Add(5 * time.Second)
				for {
					var queued int
					if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM run_turns WHERE run_id=$1 AND status='queued'", rid).Scan(&queued); e != nil {
						t.Fatal(e)
					}
					if queued == 1 {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("second member never queued for invocation slot")
					}
					time.Sleep(10 * time.Millisecond)
				}
			}
			h.request(t, c, "POST", prefix+"/runs/"+rid+"/cancel", map[string]any{}, 200)
			h.awaitRun(t, c, tid, rid, "cancelled")
			p.awaitCancelled(t, accepted)
			awaitSettledTeam(t, h, rid)
			turns := h.request(t, c, "GET", prefix+"/runs/"+rid+"/turns", nil, 200)["items"].([]any)
			wantTurns := expected
			if scenario.queued {
				wantTurns++
			}
			if len(turns) != wantTurns {
				t.Fatal("unexpected persisted turn count", len(turns), wantTurns)
			}
			for _, raw := range turns {
				turn := raw.(map[string]any)
				if turn["status"] != "cancelled" || turn["error"] != "" {
					t.Fatal("user cancellation exposed a runtime failure", turn["status"], turn["error"])
				}
			}
			select {
			case b := <-p.entered:
				t.Fatal("cancelled team admitted another member", b.RunID)
			default:
			}
			for _, b := range accepted {
				var parent string
				if e := h.db.QueryRow(context.Background(), "SELECT run_id FROM run_turns WHERE tenant_id=$1 AND id=$2", tid, b.RunID).Scan(&parent); e != nil || parent != rid {
					t.Fatal("cancel did not match persisted child identity", parent, e)
				}
			}
		})
	}
}

func TestPostgresTeamParallelFailureCancelsExactSibling(t *testing.T) {
	gate := make(chan struct{})
	p := newStrictTurnPI(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall, cancelled <-chan struct{}, p *strictTurnPI) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		<-gate
		if strings.Contains(b.SystemPrompt, "MEMBER-A") {
			w.Write([]byte("data: {\"type\":\"failed\"}\n\n"))
			http.NewResponseController(w).Flush()
		}
		<-cancelled
	})
	h := newHarness(t, p.server.URL)
	c, tid, _ := h.register(t, "cancel-parallel-failure@example.test")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("parallel"))
	rid := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "WAIT", "operationId": "parallel-failure"}, 202)["id"].(string)
	accepted := []observedPiCall{p.next(t), p.next(t)}
	close(gate)
	h.awaitRun(t, c, tid, rid, "failed")
	p.awaitCancelled(t, accepted)
	awaitSettledTeam(t, h, rid)
	for _, call := range accepted {
		var status, code string
		if e := h.db.QueryRow(context.Background(), "SELECT status,error FROM run_turns WHERE id=$1", call.RunID).Scan(&status, &code); e != nil {
			t.Fatal(e)
		}
		wantStatus, wantCode := "cancelled", ""
		if strings.Contains(call.SystemPrompt, "MEMBER-A") {
			wantStatus, wantCode = "failed", "runtime_failed"
		}
		if status != wantStatus || code != wantCode {
			t.Fatal("real failure and sibling cancellation were conflated", status, code, wantStatus, wantCode)
		}
	}
	select {
	case b := <-p.entered:
		t.Fatal("failed group admitted aggregate", b.RunID)
	default:
	}
}

func TestPostgresTeamBrokenStreamCancelsSubmittedTurn(t *testing.T) {
	p := newStrictTurnPI(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall, cancelled <-chan struct{}, p *strictTurnPI) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		conn, _, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			return
		}
		conn.Close()
		<-cancelled
	})
	h := newHarness(t, p.server.URL)
	c, tid, _ := h.register(t, "cancel-broken-stream@example.test")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	rid := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "WAIT", "operationId": "broken-stream"}, 202)["id"].(string)
	accepted := p.next(t)
	done := h.awaitRun(t, c, tid, rid, "failed")
	if done["error"] != "runtime_stream_ended" {
		t.Fatal("stream was misreported", done)
	}
	p.awaitCancelled(t, []observedPiCall{accepted})
	awaitSettledTeam(t, h, rid)
}

func TestPostgresTeamCompletedTurnIsNotCancelled(t *testing.T) {
	p := newStrictTurnPI(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall, cancelled <-chan struct{}, p *strictTurnPI) {
		w.Header().Set("Content-Type", "text/event-stream")
		completePi(w, "COMPLETE")
		p.mu.Lock()
		delete(p.active, b.RunID)
		p.mu.Unlock()
	})
	h := newHarness(t, p.server.URL)
	c, tid, _ := h.register(t, "cancel-after-complete@example.test")
	team := fixtureTeam("sequential")
	team.Members = team.Members[:1]
	_, _, sid := installTeam(t, h, c, tid, team)
	prefix := "/tenants/" + tid
	rid := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "FINISH", "operationId": "finish-before-cancel"}, 202)["id"].(string)
	accepted := p.next(t)
	h.awaitRun(t, c, tid, rid, "completed")
	cancelled := h.request(t, c, "POST", prefix+"/runs/"+rid+"/cancel", map[string]any{}, 200)
	if cancelled["status"] != "completed" || cancelled["output"] != "COMPLETE" {
		t.Fatal("late cancel overwrote completion", cancelled)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.matched) != 0 {
		t.Fatal("completed turn explicitly cancelled", p.matched)
	}
	for _, id := range p.requests {
		if id == accepted.RunID {
			t.Fatal("completed turn received a cancellation request", p.requests)
		}
	}
}

func TestTeamPiCancellationHasIndependentDeadline(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() }))
	defer server.Close()
	cfg := testConfig()
	cfg.PIURL = server.URL
	a := New(nil, cfg)
	started := time.Now()
	a.cancelPI("a-turn-id")
	select {
	case <-entered:
	default:
		t.Fatal("cancellation request missing")
	}
	if elapsed := time.Since(started); elapsed < time.Second || elapsed > 3*time.Second {
		t.Fatal("cleanup did not respect independent bounded deadline", elapsed)
	}
}

// Once a run's context is done every database write fails, including the accounting write. A step
// that blames the runtime for that turns a user's own cancellation into a reported fault, which is
// exactly the defect this rule exists to prevent — so pin it here rather than only inside the one
// integration path that happened to expose it.
func TestRunContextOutcomeSeparatesCancellationFromFailure(t *testing.T) {
	if status, code, ended := runContextOutcome(context.Background()); ended || status != "" || code != "" {
		t.Fatalf("a live context reported an ending: %q %q %v", status, code, ended)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	status, code, ended := runContextOutcome(cancelled)
	if !ended || status != "cancelled" || code != "" {
		t.Fatalf("cancellation is not reported as a clean cancel: %q %q %v", status, code, ended)
	}

	// A deadline is not the user's choice, so it stays a failure — with its own code, never the
	// code of whichever write happened to notice first.
	expired, stop := context.WithTimeout(context.Background(), time.Nanosecond)
	defer stop()
	<-expired.Done()
	status, code, ended = runContextOutcome(expired)
	if !ended || status != "failed" || code != "run_timeout" {
		t.Fatalf("an expired deadline is misreported: %q %q %v", status, code, ended)
	}
}
