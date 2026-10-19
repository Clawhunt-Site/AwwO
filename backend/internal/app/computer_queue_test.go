package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func computerPiHealth(w http.ResponseWriter) {
	writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}}})
}

func computerWorkerHealth(w http.ResponseWriter) {
	writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
}

func computerHarness(t *testing.T, piURL, workerURL string) *harness {
	t.Helper()
	h := newHarness(t, piURL)
	h.a.cfg.OpenMausURL = workerURL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	return h
}

func startComputerTestRun(t *testing.T, h *harness, email, operation string) (*http.Cookie, string, string) {
	t.Helper()
	owner, tid, _ := h.register(t, email)
	canvas, _, _ := h.fixture(t, owner, tid)
	run := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": operation, "prompt": "Prepare a report", "runtime": "pi", "model": "test-model"}, 202)
	return owner, tid, run["id"].(string)
}

func runEventTypes(t *testing.T, h *harness, tid, rid string) []string {
	t.Helper()
	rows, e := h.db.Query(t.Context(), "SELECT data->>'type' FROM run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY id", tid, rid)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	types := []string{}
	for rows.Next() {
		var typ string
		_ = rows.Scan(&typ)
		types = append(types, typ)
	}
	return types
}

// Launch day: every managed-execution model call that took longer than the API's 30 s request deadline was cut off
// at exactly 30 s (computer_model_transport), and the task failed as computer_execution_failed. A thinking model
// often needs longer; the proxy's call is bounded by its own limit and the task, never by that deadline.
func TestPostgresComputerModelCallOutlivesTheRequestDeadline(t *testing.T) {
	saved := requestDeadline
	requestDeadline = 400 * time.Millisecond
	defer func() { requestDeadline = saved }()
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			computerPiHealth(w)
			return
		}
		if r.URL.Path != "/internal/computer-model" {
			w.WriteHeader(404)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-time.After(3 * requestDeadline):
		case <-r.Context().Done():
			return
		}
		writeJSON(w, 200, map[string]any{"completion": map[string]any{"id": "slow", "object": "chat.completion", "model": "test-model", "created": 1, "choices": []map[string]any{{"index": 0, "message": map[string]any{"role": "assistant", "content": "Thought it through"}, "finish_reason": "stop"}}}, "observability": json.RawMessage(observationFixture(3, 4))})
	}))
	defer pi.Close()
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			computerWorkerHealth(w)
			return
		case r.Method == "DELETE":
			w.WriteHeader(202)
			return
		}
		var input computerWorkerInput
		_ = json.NewDecoder(r.Body).Decode(&input)
		result := computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": input.Prompt}}}, 200)
		w.Header().Set("Content-Type", "text/event-stream")
		output, _ := json.Marshal(map[string]any{"type": "completed", "output": fmt.Sprintf("model said: %v", result["id"])})
		fmt.Fprintf(w, "data: %s\n\n", output)
	}))
	defer worker.Close()
	h := computerHarness(t, pi.URL, worker.URL)
	owner, tid, rid := startComputerTestRun(t, h, "computer-slow-model@example.test", "computer-slow-model")
	h.awaitRun(t, owner, tid, rid, "completed")
	var completed int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND run_id=$2 AND status='completed'", tid, rid).Scan(&completed); e != nil || completed != 1 {
		t.Fatal("the slow model call was not completed and accounted", completed, e)
	}
	if !requestDeadlineApplies("/api/v1/tenants/t/canvases/c") || requestDeadlineApplies(computerModelRoute) || requestDeadlineApplies("/api/v1/runs/r/events") {
		t.Fatal("the request deadline exemptions changed")
	}
}

// Launch day: with both worker slots taken, eleven tasks were refused at once as computer_busy. A busy worker now
// puts the task in line, and it starts as soon as a slot frees; only a wait past computerQueueWait fails it.
func TestPostgresComputerTaskWaitsInLineForAFreeSlot(t *testing.T) {
	savedWait, savedPoll := computerQueueWait, computerQueuePoll
	computerQueueWait, computerQueuePoll = 5*time.Second, 20*time.Millisecond
	defer func() { computerQueueWait, computerQueuePoll = savedWait, savedPoll }()
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { computerPiHealth(w) }))
	defer pi.Close()
	var attempts atomic.Int32
	var busyForever atomic.Bool
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			computerWorkerHealth(w)
			return
		case r.Method == "DELETE":
			w.WriteHeader(202)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		if n := attempts.Add(1); busyForever.Load() || n <= 3 {
			writeJSON(w, 429, map[string]string{"error": "WORKER_BUSY"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"completed\",\"output\":\"Done after waiting in line.\"}\n\n")
	}))
	defer worker.Close()
	h := computerHarness(t, pi.URL, worker.URL)
	owner, tid, rid := startComputerTestRun(t, h, "computer-queue@example.test", "computer-queue-wait")
	h.awaitRun(t, owner, tid, rid, "completed")
	if attempts.Load() != 4 {
		t.Fatalf("want 3 busy answers then the start, got %d attempts", attempts.Load())
	}
	types := strings.Join(runEventTypes(t, h, tid, rid), ",")
	if !strings.Contains(types, "computer_queued,computer_started") {
		t.Fatalf("the wait in line is not recorded: %s", types)
	}
	detail := h.request(t, owner, "GET", "/tenants/"+tid+"/computer-runs/"+rid, nil, 200)
	if detail["waitingForSlot"] != false || detail["output"] != "Done after waiting in line." {
		t.Fatal("finished task still reads as waiting, or lost its result", detail)
	}

	computerQueueWait = 150 * time.Millisecond
	busyForever.Store(true)
	before := attempts.Load()
	_, tid2, rid2 := startComputerTestRun(t, h, "computer-queue-full@example.test", "computer-queue-full")
	var status, code string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if e := h.db.QueryRow(t.Context(), "SELECT status,error FROM runs WHERE tenant_id=$1 AND id=$2", tid2, rid2).Scan(&status, &code); e == nil && status == "failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != "failed" || code != "computer_busy" || attempts.Load()-before < 2 {
		t.Fatalf("a wait past the limit must fail as computer_busy after asking again: %s %s, %d attempts", status, code, attempts.Load()-before)
	}
}

// Launch day: tasks waited on their owner to allow a workspace tool or answer a question, and held a worker slot
// until the worker's 15-minute limit. Workspace tools the deployment allows are now allowed as they are requested,
// and a question is answered "go on with sensible defaults": at once by default (the owner's choice of 2026-10-11),
// or once a configured wait has passed.
func TestPostgresComputerAllowsWorkspaceToolsAndAnswersQuestions(t *testing.T) {
	for _, c := range []struct {
		name string
		wait time.Duration
	}{{"at once", 0}, {"after the configured wait", 300 * time.Millisecond}} {
		t.Run(c.name, func(t *testing.T) { checkComputerAutoAnswers(t, c.wait) })
	}
}

func checkComputerAutoAnswers(t *testing.T, wait time.Duration) {
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { computerPiHealth(w) }))
	defer pi.Close()
	answers := make(chan map[string]string, 4)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			computerWorkerHealth(w)
			return
		case r.Method == "DELETE":
			w.WriteHeader(202)
			return
		case strings.HasSuffix(r.URL.Path, "/respond"):
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			answers <- b
			writeJSON(w, 200, map[string]bool{"accepted": true})
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		send := func(event map[string]any) {
			raw, _ := json.Marshal(event)
			fmt.Fprintf(w, "data: %s\n\n", raw)
			w.(http.Flusher).Flush()
		}
		await := func(request string) map[string]string {
			select {
			case b := <-answers:
				if b["requestId"] != request {
					t.Errorf("answered %v, want %s", b, request)
				}
				return b
			case <-time.After(5 * time.Second):
				t.Errorf("request %s was never answered", request)
			case <-r.Context().Done():
			}
			return nil
		}
		send(map[string]any{"type": "computer_approval", "requestId": "tool-1", "title": "awwo_workspace_exec", "description": "批准后将在隔离工作区执行此工具。", "kind": "approval", "arguments": map[string]string{"command": "ls"}})
		if b := await("tool-1"); b != nil && (b["behavior"] != "allow" || b["message"] != "") {
			t.Errorf("workspace tool not simply allowed: %v", b)
		}
		asked := time.Now()
		send(map[string]any{"type": "computer_approval", "requestId": "ask-1", "title": "Your bot has a question", "description": "Which language?", "kind": "question"})
		if b := await("ask-1"); b != nil && (b["behavior"] != "allow" || b["message"] != computerQuestionFallback) {
			t.Errorf("question not answered with the fallback: %v", b)
		}
		if waited := time.Since(asked); waited < wait {
			t.Errorf("question answered after %v, before the configured wait of %v", waited, wait)
		}
		send(map[string]any{"type": "completed", "output": "Report written in Chinese, as assumed."})
	}))
	defer worker.Close()
	h := computerHarness(t, pi.URL, worker.URL)
	h.a.cfg.ComputerAutoAllowTools, _ = parseComputerAutoAllow("")
	h.a.cfg.ComputerQuestionWait = wait
	owner, tid, rid := startComputerTestRun(t, h, "computer-auto@example.test", "computer-auto-answers")
	h.awaitRun(t, owner, tid, rid, "completed")
	detail := h.request(t, owner, "GET", "/tenants/"+tid+"/computer-runs/"+rid, nil, 200)
	for _, item := range detail["approvals"].([]any) {
		if status := item.(map[string]any)["status"]; status != "allowed" {
			t.Errorf("request left %v", item)
		}
	}
	var audited int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND actor_id IS NULL AND action IN ('computer.response.auto_allow','computer.response.auto_answer')", tid, rid).Scan(&audited); e != nil || audited != 2 {
		t.Fatal("automatic answers not audited", audited, e)
	}
}

// A tool's card carries the arguments of the call it approves (the broker pairs it with that call, 2026-10-18). A card
// that comes without them is refused, even for a workspace tool the deployment allows: never allowed as if it had none.
func TestPostgresComputerRefusesAToolCardWithoutArguments(t *testing.T) {
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { computerPiHealth(w) }))
	defer pi.Close()
	var answered atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			computerWorkerHealth(w)
			return
		case r.Method == "DELETE":
			w.WriteHeader(202)
			return
		case strings.HasSuffix(r.URL.Path, "/respond"):
			answered.Add(1)
			writeJSON(w, 200, map[string]bool{"accepted": true})
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"computer_approval\",\"requestId\":\"tool-1\",\"title\":\"awwo_workspace_exec\",\"description\":\"批准后将在隔离工作区执行此工具。\",\"kind\":\"approval\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer worker.Close()
	h := computerHarness(t, pi.URL, worker.URL)
	h.a.cfg.ComputerAutoAllowTools, _ = parseComputerAutoAllow("")
	owner, tid, rid := startComputerTestRun(t, h, "computer-unpaired@example.test", "computer-unpaired-card")
	if detail := awaitComputerStatus(t, h, owner, "/tenants/"+tid+"/computer-runs/"+rid, "failed"); detail["error"] != "invalid_computer_approval" {
		t.Fatal("a tool card without arguments recorded as", detail["error"])
	}
	var stored int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM computer_approvals WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&stored); e != nil || stored != 0 {
		t.Fatal("the card was stored", stored, e)
	}
	time.Sleep(100 * time.Millisecond)
	if n := answered.Load(); n != 0 {
		t.Fatal("the card was answered", n)
	}
}

// The owner's 2026-10-11 choice is the default: unset answers a question at once; a wait is opt-in and bounded.
func TestComputerQuestionWaitSetting(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 0, " ": 0, "0": 0, "120": 2 * time.Minute, "900": 15 * time.Minute} {
		if got, e := parseComputerQuestionWait(raw); e != nil || got != want {
			t.Errorf("parseComputerQuestionWait(%q) = %v, %v; want %v", raw, got, e, want)
		}
	}
	for _, raw := range []string{"-1", "901", "1.5", "2m", "abc"} {
		if _, e := parseComputerQuestionWait(raw); e == nil {
			t.Errorf("parseComputerQuestionWait(%q) accepted", raw)
		}
	}
}

func TestComputerAutoAllowPolicy(t *testing.T) {
	all, e := parseComputerAutoAllow("")
	if e != nil || len(all) != len(computerWorkspaceTools) || !all["awwo_workspace_exec"] || all["Publish report"] {
		t.Fatal("default policy", all, e)
	}
	none, e := parseComputerAutoAllow("none")
	if e != nil || len(none) != 0 {
		t.Fatal("none", none, e)
	}
	some, e := parseComputerAutoAllow(" awwo_workspace_list , awwo_workspace_read")
	if e != nil || len(some) != 2 || some["awwo_workspace_exec"] {
		t.Fatal("subset", some, e)
	}
	for _, raw := range []string{"bash", "awwo_workspace_exec,shell", "*"} {
		if _, e := parseComputerAutoAllow(raw); e == nil {
			t.Fatal("a tool outside the workspace accepted:", raw)
		}
	}
	if !strings.Contains(computerInstructions, "Do not ask the user questions") {
		t.Fatal("instructions do not discourage avoidable questions")
	}
}
