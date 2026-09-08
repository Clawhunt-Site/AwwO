package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureTeam(mode string) nodeTeam {
	return nodeTeam{Version: 1, Mode: mode, Runtime: "pi", MaxRounds: 2, MaxTurns: 20, TimeoutSeconds: 30, Members: []teamMember{{ID: "author", Name: "Author", Role: "author", Instructions: "MEMBER-A", Context: "shared", Tools: []string{}}, {ID: "critic", Name: "Critic", Role: "critic", Instructions: "MEMBER-B", Model: "alternate", Context: "shared", Tools: []string{}}, {ID: "judge", Name: "Judge", Role: "reviewer", Instructions: "MEMBER-C", Context: "shared", Tools: []string{}}}}
}
func TestTeamModesAndBudgets(t *testing.T) {
	for _, mode := range []string{"sequential", "parallel", "debate", "review"} {
		t.Run(mode, func(t *testing.T) {
			team := fixtureTeam(mode)
			var calls atomic.Int32
			var reviews atomic.Int32
			out, e := runTeam(context.Background(), team, "TASK", func(ctx context.Context, m teamMember, round, ordinal int, prompt string) (string, error) {
				calls.Add(1)
				if !strings.HasPrefix(prompt, "TASK") {
					t.Error("task missing")
				}
				if mode == "review" && m.ID == "judge" {
					if reviews.Add(1) == 1 {
						return `{"approved":false,"output":"draft","feedback":"FIX-THIS"}`, nil
					}
					if !strings.Contains(prompt, "FIX-THIS") {
						t.Error("review feedback lost")
					}
					return `{"approved":true,"output":"approved-deliverable"}`, nil
				}
				return fmt.Sprintf("%s-%d", m.ID, round), nil
			})
			if e != nil {
				t.Fatal(e)
			}
			want := map[string]int32{"sequential": 3, "parallel": 3, "debate": 7, "review": 6}[mode]
			if calls.Load() != want {
				t.Fatalf("calls %d want %d", calls.Load(), want)
			}
			if mode == "review" && out != "approved-deliverable" {
				t.Fatal(out)
			}
		})
	}
	t.Run("parallel is concurrent and aggregate waits", func(t *testing.T) {
		team := fixtureTeam("parallel")
		entered := make(chan struct{}, 2)
		release := make(chan struct{})
		go func() { <-entered; <-entered; close(release) }()
		_, e := runTeam(context.Background(), team, "T", func(ctx context.Context, m teamMember, r, o int, p string) (string, error) {
			if m.ID != "judge" {
				entered <- struct{}{}
				select {
				case <-release:
				case <-time.After(time.Second):
					return "", errors.New("not parallel")
				}
			} else if !strings.Contains(p, "author-result") || !strings.Contains(p, "critic-result") {
				t.Error("fan-in missing")
			}
			return m.ID + "-result", nil
		})
		if e != nil {
			t.Fatal(e)
		}
	})
	t.Run("review cannot succeed on exhaustion", func(t *testing.T) {
		team := fixtureTeam("review")
		_, e := runTeam(context.Background(), team, "T", func(context.Context, teamMember, int, int, string) (string, error) {
			return `{"approved":false,"output":"bad","feedback":"fix"}`, nil
		})
		if e == nil || e.Error() != "review_rounds_exhausted" {
			t.Fatal(e)
		}
	})
	t.Run("strict verdict", func(t *testing.T) {
		team := fixtureTeam("review")
		_, e := runTeam(context.Background(), team, "T", func(context.Context, teamMember, int, int, string) (string, error) {
			return `{"approved":true,"output":"bad"} {}`, nil
		})
		if e == nil || e.Error() != "invalid_review_verdict" {
			t.Fatal(e)
		}
	})
	t.Run("turn budget", func(t *testing.T) {
		team := fixtureTeam("debate")
		team.MaxTurns = 3
		var calls int
		_, e := runTeam(context.Background(), team, "T", func(context.Context, teamMember, int, int, string) (string, error) { calls++; return "x", nil })
		if e == nil || e.Error() != "team_turn_budget_exhausted" || calls != 3 {
			t.Fatalf("calls=%d error=%v", calls, e)
		}
	})
}
func TestTeamRejectsUnsupportedConfiguration(t *testing.T) {
	for _, change := range []func(*nodeTeam){func(t *nodeTeam) { t.Runtime = "shell" }, func(t *nodeTeam) { t.Members[0].Runtime = "claude" }, func(t *nodeTeam) { t.Members[0].Tools = []string{"bash"} }, func(t *nodeTeam) { t.Members[1].ID = t.Members[0].ID }, func(t *nodeTeam) { t.MaxRounds = 9 }, func(t *nodeTeam) { t.MaxTurns = 2 }, func(t *nodeTeam) { t.Members[0].Context = "foreign-session" }} {
		team := fixtureTeam("sequential")
		change(&team)
		if validateTeam(&team) == nil {
			t.Fatal("accepted unsupported team")
		}
	}
	team := fixtureTeam("sequential")
	if validateTeamModels(&team, piHealth{Model: "test-model"}) == nil {
		t.Fatal("accepted unknown member model")
	}
}

type observedPiCall struct {
	RunID        string            `json:"runId"`
	Model        string            `json:"model"`
	Prompt       string            `json:"prompt"`
	SystemPrompt string            `json:"systemPrompt"`
	SessionID    string            `json:"sessionId"`
	Messages     []json.RawMessage `json:"messages"`
}

func teamProvider(t *testing.T, handler func(http.ResponseWriter, *http.Request, observedPiCall)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}, {"id": "alternate", "provider": "test", "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var b observedPiCall
		if e := json.NewDecoder(r.Body).Decode(&b); e != nil {
			t.Error(e)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		handler(w, r, b)
	}))
}
func completePi(w http.ResponseWriter, text string) {
	raw, _ := json.Marshal(map[string]string{"type": "completed", "text": text})
	fmt.Fprintf(w, "data: %s\n\n", raw)
}
func installTeam(t *testing.T, h *harness, c *http.Cookie, tid string, team nodeTeam) (string, string, string) {
	cid, aid, sid := h.fixture(t, c, tid)
	doc := map[string]any{"nodes": []map[string]any{{"id": "node-a", "kind": "session", "title": "Team task", "runtime": "pi", "binding": map[string]string{"companyId": tid, "agentId": aid}, "issueId": sid, "team": team}}, "edges": []any{}}
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": "Team", "version": 1, "document": doc}, 200)
	return cid, aid, sid
}

func TestPostgresTeamFinalizationRetriesWithoutRepeatingModelCalls(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "DURABLE-RESULT")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "persistence-retry@example.test")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	ctx := context.Background()
	// Sequences survive transaction rollback, so each table's first terminal
	// write fails exactly once. A provider replay would increase calls above 3.
	for _, table := range []string{"runs", "run_turns", "model_invocations"} {
		statements := []string{
			"CREATE SEQUENCE fail_once_" + table,
			fmt.Sprintf("CREATE FUNCTION inject_%s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status IN ('completed','failed','cancelled','interrupted') AND nextval('fail_once_%s') = 1 THEN RAISE EXCEPTION 'injected transient finalization error'; END IF; RETURN NEW; END $$", table, table),
			fmt.Sprintf("CREATE TRIGGER fail_terminal_once BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION inject_%s()", table, table),
		}
		for _, sql := range statements {
			if _, e := h.db.Exec(ctx, sql); e != nil {
				t.Fatal(e)
			}
		}
	}
	v := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "retry-finalization"}, 202)
	rid := v["id"].(string)
	h.awaitRun(t, c, tid, rid, "completed")
	var turns, invocations int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM run_turns WHERE run_id=$1 AND status='completed' AND output='DURABLE-RESULT'", rid).Scan(&turns); e != nil {
		t.Fatal(e)
	}
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE run_id=$1 AND status='completed'", rid).Scan(&invocations); e != nil || turns != 3 || invocations != 3 || calls.Load() != 3 {
		t.Fatal("finalization lost evidence or repeated provider", turns, invocations, calls.Load(), e)
	}
}

func TestPostgresFailedExecutionStartSettlesInterrupted(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "UNEXPECTED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "start-failed@example.test")
	_, _, sid := h.fixture(t, c, tid)
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "CREATE FUNCTION fail_run_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status='queued' AND NEW.status='running' THEN RAISE EXCEPTION 'injected start error'; END IF; RETURN NEW; END $$"); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "CREATE TRIGGER fail_start BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION fail_run_start()"); e != nil {
		t.Fatal(e)
	}
	v := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "start-failed"}, 202)
	h.awaitRun(t, c, tid, v["id"].(string), "interrupted")
	if calls.Load() != 0 {
		t.Fatal("failed durable admission reached provider")
	}
}

func TestPostgresGraphTeamUsesActualMemberContextBudget(t *testing.T) {
	var calls atomic.Int32
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "limits": map[string]any{"maxContextTextBytes": 10}, "models": []map[string]any{{"id": "test-model", "maxContextTextBytes": 10}, {"id": "alternate", "maxContextTextBytes": 262144}}})
			return
		}
		var b observedPiCall
		if e := json.NewDecoder(r.Body).Decode(&b); e != nil {
			t.Error(e)
		}
		if b.Model != "alternate" {
			t.Error("used non-member model", b.Model)
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		completePi(w, "LARGE-MODEL-RESULT")
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "member-context@example.test")
	team := fixtureTeam("sequential")
	for i := range team.Members {
		team.Members[i].Model = "alternate"
	}
	cid, _, _ := installTeam(t, h, c, tid, team)
	path := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	v := h.request(t, c, "POST", path, map[string]string{"operationId": "large-members"}, 202)
	awaitGraph(t, h, c, path+"/"+v["id"].(string), "completed")
	if calls.Load() != 3 {
		t.Fatal("team blocked by unused primary context budget", calls.Load())
	}
}

func TestPostgresLateCompletionAfterCanvasDeletionDoesNotRetry(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	c, tid, _ := h.register(t, "late-completion@example.test")
	cid, _, sid := h.fixture(t, c, tid)
	rid := randomID()
	if _, e := h.db.Exec(context.Background(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$1,'hash','accepted','cancelled')", rid, tid, sid); e != nil {
		t.Fatal(e)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/"+cid, nil, 204)
	finished := make(chan struct{})
	go func() {
		h.a.finish(tid, rid, "completed", "LATE-COMPLETION", "")
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		// Close also unblocks the old retry loop so a regression cannot strand
		// a goroutine against the subsequently removed test schema.
		h.a.Close()
		<-finished
		t.Fatal("late completion retried a deliberately deleted run")
	}
}
func TestPostgresNodeTeamsModesPersistenceAndIsolation(t *testing.T) {
	for _, mode := range []string{"sequential", "parallel", "debate", "review"} {
		t.Run(mode, func(t *testing.T) {
			var mu sync.Mutex
			calls := []observedPiCall{}
			var reviews atomic.Int32
			pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
				mu.Lock()
				calls = append(calls, b)
				mu.Unlock()
				if mode == "review" && strings.Contains(b.Prompt, "Return ONLY strict JSON") {
					if reviews.Add(1) == 1 {
						completePi(w, `{"approved":false,"output":"draft","feedback":"specific-fix"}`)
					} else {
						completePi(w, `{"approved":true,"output":"APPROVED"}`)
					}
					return
				}
				completePi(w, "MEMBER-OUTPUT")
			})
			defer pi.Close()
			h := newHarness(t, pi.URL)
			c, tid, _ := h.register(t, "team-"+mode+"@example.test")
			other, otherTid, _ := h.register(t, "other-"+mode+"@example.test")
			_, _, sid := installTeam(t, h, c, tid, fixtureTeam(mode))
			prefix := "/tenants/" + tid
			b := map[string]string{"sessionId": sid, "prompt": "TEAM-TASK", "operationId": "team-operation-" + mode}
			v := h.request(t, c, "POST", prefix+"/runs", b, 202)
			rid := v["id"].(string)
			done := h.awaitRun(t, c, tid, rid, "completed")
			turns := h.request(t, c, "GET", prefix+"/runs/"+rid+"/turns", nil, 200)["items"].([]any)
			want := map[string]int{"sequential": 3, "parallel": 3, "debate": 7, "review": 6}[mode]
			if len(turns) != want {
				t.Fatalf("turns=%d want=%d", len(turns), want)
			}
			for _, raw := range turns {
				turn := raw.(map[string]any)
				if turn["status"] != "completed" || turn["config"] == nil || turn["output"] == "" {
					t.Fatalf("incomplete turn %v", turn)
				}
			}
			if mode == "review" && done["output"] != "APPROVED" {
				t.Fatal(done)
			}
			h.request(t, c, "POST", prefix+"/runs", b, 200)
			h.request(t, other, "GET", prefix+"/runs/"+rid+"/turns", nil, 404)
			h.request(t, other, "GET", "/tenants/"+otherTid+"/runs/"+rid+"/turns", nil, 404)
			mu.Lock()
			defer mu.Unlock()
			if len(calls) != want {
				t.Fatalf("idempotency duplicated calls %d", len(calls))
			}
			models := map[string]bool{}
			sessions := map[string]bool{}
			for _, call := range calls {
				models[call.Model] = true
				sessions[call.SessionID] = true
				if !strings.Contains(call.SystemPrompt, "Use plain words") || !strings.Contains(call.SystemPrompt, "MEMBER-") {
					t.Error("instructions missing")
				}
			}
			if !models["alternate"] || !models["test-model"] || len(sessions) != 3 {
				t.Fatalf("member model/session isolation %v %v", models, sessions)
			}
		})
	}
}
func TestPostgresTeamQuotaCancellationAndSnapshots(t *testing.T) {
	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		entered <- struct{}{}
		select {
		case <-release:
			completePi(w, "done")
		case <-r.Context().Done():
		}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "team-quota@example.test")
	cid, _, sid := installTeam(t, h, c, tid, fixtureTeam("parallel"))
	prefix := "/tenants/" + tid
	_, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_concurrent_runs=1,max_runs_per_day=2 WHERE id=$1", tid)
	if e != nil {
		t.Fatal(e)
	}
	v := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "wait", "operationId": "team-cancel-operation"}, 202)
	rid := v["id"].(string)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("no invocation")
	}
	if calls.Load() != 1 {
		t.Fatal("quota bypassed")
	}
	cv := h.request(t, c, "GET", prefix+"/canvases/"+cid, nil, 200)
	doc := cv["document"].(map[string]any)
	node := doc["nodes"].([]any)[0].(map[string]any)
	node["team"].(map[string]any)["mode"] = "sequential"
	h.request(t, c, "PUT", prefix+"/canvases/"+cid, map[string]any{"name": "Edited", "version": cv["version"], "document": doc}, 200)
	h.request(t, c, "POST", prefix+"/runs/"+rid+"/cancel", map[string]any{}, 200)
	h.awaitRun(t, c, tid, rid, "cancelled")
	close(release)
	time.Sleep(100 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("invoked after cancellation %d", calls.Load())
	}
	var mode string
	if e = h.db.QueryRow(context.Background(), "SELECT team_snapshot->>'mode' FROM runs WHERE id=$1", rid).Scan(&mode); e != nil || mode != "parallel" {
		t.Fatalf("snapshot mutated %s %v", mode, e)
	}
	v = h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "quota", "operationId": "team-quota-operation"}, 202)
	done := h.awaitRun(t, c, tid, v["id"].(string), "failed")
	if done["error"] != "quota_exceeded" || calls.Load() != 2 {
		t.Fatalf("daily invocation budget not enforced %v calls=%d", done, calls.Load())
	}
	h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "quota", "operationId": "team-quota-rejected"}, 429)
}
