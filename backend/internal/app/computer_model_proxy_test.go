package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// lockedLog is a log the app may write from any goroutine while a test reads it.
type lockedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func TestComputerWorkerErrorKeepsOnlyLabels(t *testing.T) {
	for _, c := range []struct {
		body                 string
		code, reason, detail string
	}{
		{`{"error":{"code":"PROVIDER_ERROR","message":"PRIVATE provider text","reason":"provider:400:context_length_exceeded"}}`, "PROVIDER_ERROR", "provider:400:context_length_exceeded", ""},
		{`{"error":{"code":"PROVIDER_ERROR","message":"x","reason":"answer","detail":"finish:content_filter"}}`, "PROVIDER_ERROR", "answer", "finish:content_filter"},
		{`{"error":{"code":"INVALID_INPUT","message":"x","detail":"completion:tool-name"}}`, "INVALID_INPUT", "", "completion:tool-name"},
		{`{"error":{"code":"CANCELLED","reason":"stopping"}}`, "CANCELLED", "stopping", ""},
		// What is not a label is dropped, never logged: text, a code of another shape, an oversized label.
		{`{"error":{"code":"provider error","reason":"PRIVATE reason text","detail":"PRIVATE\ndetail"}}`, "", "", ""},
		{fmt.Sprintf(`{"error":{"code":"PROVIDER_ERROR","reason":%q}}`, "provider:"+strings.Repeat("9", 120)), "PROVIDER_ERROR", "", ""},
		{`not json`, "", "", ""},
		{``, "", "", ""},
	} {
		code, reason, detail := computerWorkerError([]byte(c.body))
		if code != c.code || reason != c.reason || detail != c.detail {
			t.Fatalf("%s reads %q %q %q, want %q %q %q", c.body, code, reason, detail, c.code, c.reason, c.detail)
		}
	}
}

// The API logs each direct-task model call its worker refused: the call's place in its task, the model, the worker's
// status and its labels, and the ledger's code; never the call's words or the worker's message.
func TestPostgresComputerModelProxyLogsWhatTheWorkerAnswered(t *testing.T) {
	answers := map[string]struct {
		status int
		error  map[string]string
	}{
		"context":  {413, map[string]string{"code": "CONTEXT_LIMIT", "message": "The managed model request could not be completed."}},
		"gate":     {502, map[string]string{"code": "PROVIDER_ERROR", "message": "PRIVATE provider text", "reason": "provider:400:invalid_request_error"}},
		"filtered": {502, map[string]string{"code": "PROVIDER_ERROR", "message": "x", "reason": "answer", "detail": "finish:content_filter"}},
		"forged":   {502, map[string]string{"code": "PROVIDER_ERROR", "message": "x", "reason": "PRIVATE reason text", "detail": "PRIVATE\ndetail"}},
		"stopping": {499, map[string]string{"code": "CANCELLED", "message": "x", "reason": "stopping"}},
	}
	order := []string{"context", "gate", "filtered", "forged", "stopping", "garbled", "nochoices", "hangup"}
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		var b struct {
			Completion struct {
				Messages []struct {
					Content string `json:"content"`
				} `json:"messages"`
			} `json:"completion"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		switch scenario := strings.TrimPrefix(b.Completion.Messages[0].Content, "PRIVATE task words "); scenario {
		case "garbled": // a 200 that is not the worker's JSON
			w.WriteHeader(200)
			fmt.Fprint(w, "PRIVATE not json")
		case "nochoices": // a 200 whose completion holds no answer
			writeJSON(w, 200, map[string]any{"completion": map[string]any{"choices": []any{}}})
		case "hangup": // the worker drops the connection without an answer
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
		default:
			writeJSON(w, answers[scenario].status, map[string]any{"error": answers[scenario].error})
		}
	}))
	defer trusted.Close()
	runs := make(chan string, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(200)
			return
		}
		var input computerWorkerInput
		_ = json.NewDecoder(r.Body).Decode(&input)
		for _, scenario := range order {
			computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": "PRIVATE task words " + scenario}}}, 502)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n")
		runs <- input.RunID
	}))
	defer worker.Close()
	logs := &lockedLog{}
	h := newHarness(t, trusted.URL, func(a *App) { a.log = slog.New(slog.NewJSONHandler(logs, nil)) })
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-call-log@example.test")
	model := connectionModelID(addPersonalConnection(t, h, owner), "test-chat-model")
	canvas, _, _ := h.fixture(t, owner, tid)
	run := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": "computer-call-log", "prompt": "PRIVATE prompt", "runtime": "pi", "model": model}, 202)
	id := run["id"].(string)
	if <-runs != id {
		t.Fatal("the task did not start")
	}
	h.awaitRun(t, owner, tid, id, "failed")

	type line struct {
		Msg, Run, Runtime, Model, WorkerCode, Reason, Detail, Code string
		Call, WorkerStatus                                         int
		Ms                                                         *int64
	}
	var calls []line
	for _, raw := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var l line
		if json.Unmarshal([]byte(raw), &l) == nil && l.Msg == "managed model call failed" {
			calls = append(calls, l)
		}
	}
	want := []line{
		{WorkerStatus: 413, WorkerCode: "CONTEXT_LIMIT", Code: "computer_model_failed"},
		{WorkerStatus: 502, WorkerCode: "PROVIDER_ERROR", Reason: "provider:400:invalid_request_error", Code: "computer_model_failed"},
		{WorkerStatus: 502, WorkerCode: "PROVIDER_ERROR", Reason: "answer", Detail: "finish:content_filter", Code: "computer_model_answer"},
		{WorkerStatus: 502, WorkerCode: "PROVIDER_ERROR", Code: "computer_model_failed"},
		{WorkerStatus: 499, WorkerCode: "CANCELLED", Reason: "stopping", Code: "computer_model_transport"},
		{WorkerStatus: 200, Code: "computer_model_protocol"},
		{WorkerStatus: 200, Code: "computer_model_protocol"},
		{WorkerStatus: 0, Code: "computer_model_transport"},
	}
	if len(calls) != len(want) {
		t.Fatalf("%d call lines, want %d:\n%s", len(calls), len(want), logs.String())
	}
	for i, got := range calls {
		w := want[i]
		if got.Run != id || got.Call != i+1 || got.Runtime != "pi" || got.Model != model || got.Ms == nil || *got.Ms < 0 ||
			got.WorkerStatus != w.WorkerStatus || got.WorkerCode != w.WorkerCode || got.Reason != w.Reason || got.Detail != w.Detail || got.Code != w.Code {
			t.Fatalf("call %d logged %+v, want %+v", i+1, got, w)
		}
	}
	if strings.Contains(logs.String(), "PRIVATE") {
		t.Fatalf("the log carries a call's words or the worker's text:\n%s", logs.String())
	}
}
