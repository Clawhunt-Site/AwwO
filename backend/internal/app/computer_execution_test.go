package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type computerWorkerInput struct {
	RunID, TenantID, SessionID, Prompt, Instructions, ModelProxyURL, ModelProxyToken string
	TimeoutMs, MaxModelCalls                                                         int
}

func computerProxyRequest(t *testing.T, input computerWorkerInput, body any, status int) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", input.ModelProxyURL+"/chat/completions", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+input.ModelProxyToken)
	req.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Error(e)
		return nil
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Errorf("proxy status %d want %d: %s", resp.StatusCode, status, data)
	}
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return out
}
func awaitComputerApproval(t *testing.T, h *harness, c *http.Cookie, base string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		value := h.request(t, c, "GET", base, nil, 200)
		if len(value["approvals"].([]any)) > 0 {
			return value
		}
		if value["status"] == "failed" {
			t.Fatal("computer failed before approval", value)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("computer did not request approval")
	return nil
}
func TestComputerModelInputAndConfiguration(t *testing.T) {
	for _, p := range []string{"../report.md", "/host/report.md", "a/../report.md", "a\\b.md", "."} {
		if validComputerArtifactPath(p) {
			t.Fatal("unsafe artifact path accepted", p)
		}
	}
	if !validComputerArtifactPath("reports/a/report.md") {
		t.Fatal("relative artifact provenance rejected")
	}

	raw := []byte(`{"model":"anything","messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"x","type":"function","function":{"name":"read","arguments":"{}"}}],"reasoning_details":[{"type":"encrypted","data":"opaque"}]}],"stream":true}`)
	got, stream, e := validateComputerCompletion(raw, 10000)
	if e != nil || !stream || !bytes.Contains(got["messages"], []byte("opaque")) {
		t.Fatal("opaque continuation or tools lost", e)
	}
	for _, raw := range []string{`{"messages":[]}`, `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"http://internal"}}]}]}`, `{"messages":[{"role":"user","content":"x"}],"baseURL":"http://evil"}`, `{"messages":[{"role":"user","content":"x"}],"max_tokens":999999}`} {
		if _, _, e := validateComputerCompletion([]byte(raw), 10000); e == nil {
			t.Fatal("unbounded or injected completion accepted")
		}
	}
	cfg := testConfig()
	cfg.OpenMausURL = "http://openmaus:8199"
	cfg.OpenMausToken = strings.Repeat("x", 32)
	cfg.ComputerModelProxyURL = "http://api:8087/api/internal/computer-model/v1"
	if e := validateComputerConfiguration(cfg); e != nil {
		t.Fatal(e)
	}
	cfg.ComputerModelProxyURL = "http://user:secret@api:8087/api/internal/computer-model/v1"
	if validateComputerConfiguration(cfg) == nil {
		t.Fatal("credentials in proxy URL accepted")
	}
}
func TestPostgresComputerPersonalModelApprovalArtifactsAndIsolation(t *testing.T) {
	var providerCalls, workerCalls, responses atomic.Int32
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		if r.URL.Path != "/internal/computer-model" {
			t.Error("wrong trusted worker endpoint", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		var b map[string]any
		if json.NewDecoder(r.Body).Decode(&b) != nil {
			t.Error("bad model request")
		}
		providerCalls.Add(1)
		if b["userModel"].(map[string]any)["apiKey"] != "synthetic-personal-secret" {
			t.Error("personal key not resolved inside trusted worker")
		}
		completion := b["completion"].(map[string]any)
		if completion["stream"] != false {
			t.Error("provider retry/stream boundary not normalized")
		}
		writeJSON(w, 200, map[string]any{"completion": map[string]any{"id": "chat-result", "object": "chat.completion", "model": "test-chat-model", "created": 1, "choices": []map[string]any{{"index": 0, "message": map[string]any{"role": "assistant", "content": "Model used selected evidence"}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 4, "completion_tokens": 5, "total_tokens": 9}}, "observability": json.RawMessage(observationFixture(4, 5))})
	}))
	defer trusted.Close()
	received := make(chan computerWorkerInput, 1)
	allow := make(chan struct{})
	var released atomic.Bool
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("m", 32) {
			t.Error("managed worker not authenticated")
		}
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(200)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/respond") {
			responses.Add(1)
			writeJSON(w, 200, map[string]bool{"accepted": true})
			if released.CompareAndSwap(false, true) {
				close(allow)
			}
			return
		}
		workerCalls.Add(1)
		var b computerWorkerInput
		if json.NewDecoder(r.Body).Decode(&b) != nil {
			t.Error("bad computer run")
		}
		received <- b
		if strings.Contains(b.Prompt, "synthetic-personal-secret") || strings.Contains(b.Instructions, "FROZEN-COMPUTER-EVIDENCE") || !strings.Contains(b.Prompt, "FROZEN-COMPUTER-EVIDENCE") {
			t.Error("key leaked or evidence priority lost")
		}
		result := computerProxyRequest(t, b, map[string]any{"model": "arbitrary-model-ignored", "messages": []map[string]string{{"role": "user", "content": b.Prompt}}}, 200)
		if result["id"] != "chat-result" {
			t.Error("model proxy did not return actual completion")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		var approval bytes.Buffer
		encoder := json.NewEncoder(&approval)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(map[string]any{"type": "computer_approval", "requestId": "req-a", "title": "Publish report", "description": "Create local report file", "kind": "approval", "arguments": map[string]string{"path": "reports/report.md", "content": strings.Repeat("<", 100000)}})
		fmt.Fprintf(w, "data: {\"type\":\"computer_message\",\"id\":\"one\",\"role\":\"assistant\",\"text\":\"Ready to publish\",\"truncated\":true}\n\ndata: %s\n\n", strings.TrimSpace(approval.String()))
		w.(http.Flusher).Flush()
		select {
		case <-allow:
		case <-r.Context().Done():
			return
		}
		data := []byte("# Computer report\nActual generated bytes.")
		for _, path := range []string{"reports/a/report.md", "reports/b/report.md"} {
			ev, _ := json.Marshal(map[string]string{"type": "computer_artifact", "name": "report.md", "path": path, "encoding": "base64", "content": base64.StdEncoding.EncodeToString(data), "sha256": tokenHash(string(data))})
			fmt.Fprintf(w, "data: %s\n\n", ev)
		}
		fmt.Fprint(w, "data: {\"type\":\"completed\",\"output\":\"Saved report.md after approval.\",\"truncated\":true}\n\n")
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-owner@example.test")
	member, _, _ := h.register(t, "computer-member@example.test")
	outsider, otherTenant, _ := h.register(t, "computer-other@example.test")
	h.request(t, owner, "POST", "/tenants/"+tid+"/members", map[string]string{"email": "computer-member@example.test", "role": "member"}, 201)
	connection := addPersonalConnection(t, h, owner)
	model := connectionModelID(connection, "test-chat-model")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	source := h.request(t, owner, "POST", base+"/knowledge/sources", map[string]string{"title": "Evidence", "content": "FROZEN-COMPUTER-EVIDENCE", "operationId": "computer-evidence-source"}, 201)
	runtime := h.request(t, owner, "GET", base+"/computer-runtime", nil, 200)
	if runtime["ready"] != true || len(runtime["models"].([]any)) != 1 {
		t.Fatal("actual personal models not available", runtime)
	}
	body := map[string]any{"operationId": "computer-run-once", "prompt": "Prepare a report", "runtime": "pi", "model": model, "knowledgeRevisionIds": []string{source["currentRevisionId"].(string)}}
	run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", body, 202)
	rid := run["id"].(string)
	detailPath := base + "/computer-runs/" + rid
	input := <-received
	detail := awaitComputerApproval(t, h, owner, detailPath)
	if detail["approvals"].([]any)[0].(map[string]any)["arguments"].(map[string]any)["content"] != strings.Repeat("<", 100000) {
		t.Fatal("large approval arguments were truncated or hidden")
	}
	if detail["canRespond"] != true {
		t.Fatal("owner cannot respond")
	}
	replay := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", body, 200)
	if replay["id"] != rid {
		t.Fatal("create idempotence lost")
	}
	otherView := h.request(t, member, "GET", detailPath, nil, 200)
	if otherView["canRespond"] != false || otherView["canCancel"] != false {
		t.Fatal("collaborator inherits task approval")
	}
	response := map[string]string{"requestId": "req-a", "behavior": "allow", "operationId": "computer-approve-once"}
	h.request(t, member, "POST", detailPath+"/respond", response, 403)
	h.request(t, member, "POST", base+"/runs/"+rid+"/cancel", map[string]any{}, 403)
	h.request(t, outsider, "GET", "/tenants/"+otherTenant+"/computer-runs/"+rid, nil, 404)
	h.request(t, owner, "POST", detailPath+"/respond", response, 200)
	h.request(t, owner, "POST", detailPath+"/respond", response, 200)
	response["behavior"] = "deny"
	h.request(t, owner, "POST", detailPath+"/respond", response, 409)
	h.awaitRun(t, owner, tid, rid, "completed")
	detail = h.request(t, owner, "GET", detailPath, nil, 200)
	artifacts := detail["artifacts"].([]any)
	if detail["outputTruncated"] != true || detail["messages"].([]any)[0].(map[string]any)["truncated"] != true {
		t.Fatal("worker truncation metadata lost")
	}
	if len(artifacts) != 2 || len(detail["messages"].([]any)) != 1 {
		t.Fatal("durable messages/files missing", detail)
	}
	artifact := artifacts[0].(map[string]any)
	copy := h.request(t, owner, "POST", base+"/knowledge/sources", map[string]string{"title": "Stored execution report", "artifactId": artifact["id"].(string), "operationId": "computer-result-source"}, 201)
	if copy["content"] != "# Computer report\nActual generated bytes." {
		t.Fatal("artifact bytes not copied")
	}
	if workerCalls.Load() != 1 || providerCalls.Load() != 1 || responses.Load() != 1 {
		t.Fatal("execution or approval repeated", workerCalls.Load(), providerCalls.Load(), responses.Load())
	}
	var invocations int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND run_id=$2 AND status='completed'", tid, rid).Scan(&invocations); e != nil || invocations != 1 {
		t.Fatal("model call not accounted", invocations, e)
	}
	time.Sleep(30 * time.Millisecond)
	computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": "reuse expired capability"}}}, 401)
	encoded, _ := json.Marshal(detail)
	if bytes.Contains(encoded, []byte(input.ModelProxyToken)) || bytes.Contains(encoded, []byte("synthetic-personal-secret")) {
		t.Fatal("credential exposed in detail")
	}
}

func TestPostgresComputerProxyBudgetRevocationAndCancellation(t *testing.T) {
	var calls, cancels atomic.Int32
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		calls.Add(1)
		writeJSON(w, 200, map[string]any{"completion": map[string]any{"id": "one", "choices": []map[string]any{{"index": 0, "message": map[string]string{"role": "assistant", "content": "OK"}, "finish_reason": "stop"}}}, "observability": json.RawMessage(observationFixture(1, 1))})
	}))
	defer trusted.Close()
	started := make(chan computerWorkerInput, 4)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		if r.Method == "DELETE" {
			cancels.Add(1)
			w.WriteHeader(200)
			return
		}
		var input computerWorkerInput
		_ = json.NewDecoder(r.Body).Decode(&input)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- input
		<-r.Context().Done()
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-revoke@example.test")
	connection := addPersonalConnection(t, h, owner)
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	body := map[string]string{"operationId": "computer-call-budget", "prompt": "Wait for local operation", "runtime": "pi", "model": connectionModelID(connection, "test-chat-model")}
	first := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", body, 202)
	input := <-started
	completion := map[string]any{"messages": []map[string]string{{"role": "user", "content": "bounded model call"}}}
	for range 16 {
		computerProxyRequest(t, input, completion, 200)
	}
	computerProxyRequest(t, input, completion, 409)
	if calls.Load() != 16 {
		t.Fatal("model budget not enforced", calls.Load())
	}
	h.request(t, owner, "POST", base+"/runs/"+first["id"].(string)+"/cancel", map[string]any{}, 200)
	deadline := time.Now().Add(3 * time.Second)
	for cancels.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if cancels.Load() < 1 {
		t.Fatal("computer worker was not cancelled")
	}
	computerProxyRequest(t, input, completion, 401)
	body["operationId"] = "computer-revoked-key"
	second := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", body, 202)
	input = <-started
	h.request(t, owner, "DELETE", "/auth/connections/"+connection, nil, 204)
	computerProxyRequest(t, input, completion, 403)
	if calls.Load() != 16 {
		t.Fatal("deleted credential made a paid call")
	}
	h.request(t, owner, "POST", base+"/runs/"+second["id"].(string)+"/cancel", map[string]any{}, 200)
}
func TestPostgresComputerUncertainApprovalIsNeverAutomaticallyRepeated(t *testing.T) {
	var responses atomic.Int32
	trusted := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) { t.Error("no model call expected") })
	defer trusted.Close()
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(200)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/respond") {
			responses.Add(1)
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"computer_approval\",\"requestId\":\"ask-one\",\"title\":\"Choose output\",\"description\":\"Which report?\",\"kind\":\"question\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-unknown@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": "computer-unknown-task", "prompt": "Prepare a report", "runtime": "pi", "model": "test-model"}, 202)
	path := base + "/computer-runs/" + run["id"].(string)
	awaitComputerApproval(t, h, owner, path)
	h.request(t, owner, "POST", path+"/respond", map[string]string{"requestId": "ask-one", "behavior": "allow", "message": " \n\t", "operationId": "computer-response-uncertain"}, 400)
	if responses.Load() != 0 {
		t.Fatal("empty answer consumed the pending approval")
	}
	body := map[string]string{"requestId": "ask-one", "behavior": "allow", "message": "Markdown report", "operationId": "computer-response-uncertain"}
	for range 2 {
		value := h.request(t, owner, "POST", path+"/respond", body, 200)
		if value["accepted"] != false || value["status"] != "unknown" {
			t.Fatal("uncertain approval looked accepted", value)
		}
	}
	body["operationId"] = "computer-response-no-retry"
	h.request(t, owner, "POST", path+"/respond", body, 409)
	if responses.Load() != 1 {
		t.Fatal("uncertain external action repeated")
	}
	detail := h.request(t, owner, "GET", path, nil, 200)
	if detail["approvals"].([]any)[0].(map[string]any)["status"] != "unknown" {
		t.Fatal("unknown response not durable")
	}
	h.request(t, owner, "POST", base+"/runs/"+run["id"].(string)+"/cancel", map[string]any{}, 200)
}

// A Bedrock model is refused when a managed execution run is created, before any invocation is
// reserved or the execution service is called: the Bedrock bridge serves streaming chat only.
func TestPostgresComputerRunRefusesBedrockModels(t *testing.T) {
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{
				{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144},
				{"id": "bedrock.glm-5", "name": "GLM-5", "provider": "bedrock", "maxContextTextBytes": 262144}}})
			return
		}
		t.Error("unexpected model worker call", r.Method, r.URL.Path)
	}))
	defer pi.Close()
	var runs atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		runs.Add(1)
		w.WriteHeader(500)
	}))
	defer worker.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-bedrock@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	refused := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": "computer-bedrock", "prompt": "Build a page", "runtime": "pi", "model": "bedrock.glm-5"}, 400)
	if refused["error"].(map[string]any)["code"] != "computer_model_unsupported" {
		t.Fatal("unexpected refusal", refused)
	}
	var invocations int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); e != nil || invocations != 0 {
		t.Fatal("a refused run reserved an invocation", invocations, e)
	}
	if runs.Load() != 0 {
		t.Fatal("the execution service was called for a refused run")
	}
}

// The worker refuses a task whose run time is outside its own bounds, while AWWO_RUN_TIMEOUT also
// bounds canvas runs and may be longer (production 30 min: every task was refused, 2026-10-06).
// The bounds are pinned against the worker's own check, so neither side can drift alone.
func TestComputerRunTimeoutStaysWithinTheWorkerBounds(t *testing.T) {
	for in, want := range map[time.Duration]time.Duration{30 * time.Minute: 15 * time.Minute, 15 * time.Minute: 15 * time.Minute,
		180 * time.Second: 180 * time.Second, 500 * time.Millisecond: time.Second} {
		if got := computerRunTimeout(in); got != want {
			t.Errorf("computerRunTimeout(%s) = %s, want %s", in, got, want)
		}
	}
	source, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "openmaus-worker", "protocol.ts"))
	if e != nil {
		t.Fatal(e)
	}
	bound := func(op string) int64 {
		m := regexp.MustCompile(`Number\(timeoutMs\) ` + op + ` ([0-9_]+)`).FindSubmatch(source)
		if m == nil {
			t.Fatal("the worker's run-time check moved: update computerMinRunTimeout and computerMaxRunTimeout", op)
		}
		n, _ := strconv.ParseInt(strings.ReplaceAll(string(m[1]), "_", ""), 10, 64)
		return n
	}
	if bound("<") != computerMinRunTimeout.Milliseconds() || bound(">") != computerMaxRunTimeout.Milliseconds() {
		t.Fatal("computer run-time bounds differ from the worker's", bound("<"), bound(">"))
	}
}

// The worker's reason for a refused task is read from its closed set of codes, and nothing else:
// the log line must not carry whatever a broken or hostile peer put in the body.
func TestComputerRefusalReadsOnlyTheWorkersCodes(t *testing.T) {
	for body, want := range map[string]string{`{"error":"WORKER_BUSY"}`: "WORKER_BUSY", `{"error":"INVALID_BUDGET"}`: "INVALID_BUDGET",
		`{"error":"secret value"}`: "", `{"error":"` + strings.Repeat("A", 65) + `"}`: "", `not json`: "", `{}`: ""} {
		response := &http.Response{Body: io.NopCloser(strings.NewReader(body))}
		if got := computerRefusal(response); got != want {
			t.Errorf("computerRefusal(%s) = %q, want %q", body, got, want)
		}
	}
	for status, want := range map[int]string{429: "computer_busy", 503: "computer_unavailable", 400: "computer_rejected", 409: "computer_rejected", 200: "computer_rejected"} {
		if got := computerRefusalError(status); got != want {
			t.Errorf("computerRefusalError(%d) = %s, want %s", status, got, want)
		}
	}
}

// A refusal whose body never arrives is given up on, rather than holding the run open until its
// deadline.
func TestComputerRefusalDoesNotWaitOnAStalledBody(t *testing.T) {
	stalled, writer := io.Pipe()
	defer writer.Close()
	started := time.Now()
	if got := computerRefusal(&http.Response{Body: stalled}); got != "" {
		t.Fatal("a stalled body produced a code", got)
	}
	if waited := time.Since(started); waited < computerRefusalWait || waited > computerRefusalWait+3*time.Second {
		t.Fatal("refusal body wait not bounded by computerRefusalWait", waited)
	}
}

func awaitComputerStatus(t *testing.T, h *harness, c *http.Cookie, path, status string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if value := h.request(t, c, "GET", path, nil, 200); value["status"] == status {
			return value
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("computer run did not reach", status, h.request(t, c, "GET", path, nil, 200))
	return nil
}

// A worker with the real one's admission (run time 1 s–15 min) starts a task even when
// AWWO_RUN_TIMEOUT is production's 30 min, and a task it will not start fails with a code that
// says why.
func TestPostgresComputerTaskFitsTheWorkerAndNamesItsRefusals(t *testing.T) {
	trusted := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) { t.Error("no model call expected") })
	defer trusted.Close()
	started := make(chan computerWorkerInput, 1)
	var refuse atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var input computerWorkerInput
		_ = json.NewDecoder(r.Body).Decode(&input)
		switch status := int(refuse.Load()); {
		case input.TimeoutMs < 1000 || input.TimeoutMs > 900_000:
			writeJSON(w, 400, map[string]string{"error": "INVALID_BUDGET"})
			return
		case status == 429:
			writeJSON(w, 429, map[string]string{"error": "WORKER_BUSY"})
			return
		case status != 0:
			writeJSON(w, status, map[string]string{"error": "WORKER_NOT_READY"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- input
		<-r.Context().Done()
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	h.a.cfg.RunTimeout = 30 * time.Minute
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-run-time@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	task := func(operation string) string {
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": operation, "prompt": "Prepare a report", "runtime": "pi", "model": "test-model"}, 202)
		return base + "/computer-runs/" + run["id"].(string)
	}
	running := task("computer-within-worker-bounds")
	select {
	case input := <-started:
		if input.TimeoutMs != 900_000 {
			t.Fatal("run time not capped at the worker's limit", input.TimeoutMs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the worker did not start the task", h.request(t, owner, "GET", running, nil, 200))
	}
	h.request(t, owner, "POST", base+"/runs/"+strings.TrimPrefix(running, base+"/computer-runs/")+"/cancel", map[string]any{}, 200)
	awaitComputerStatus(t, h, owner, running, "cancelled")
	for status, want := range map[int32]string{429: "computer_busy", 503: "computer_unavailable", 409: "computer_rejected"} {
		refuse.Store(status)
		detail := awaitComputerStatus(t, h, owner, task(fmt.Sprintf("computer-refused-%d", status)), "failed")
		if detail["error"] != want {
			t.Errorf("worker status %d recorded as %v, want %s", status, detail["error"], want)
		}
	}
}

// Managed execution's model calls go to POST /internal/computer-model on the runtime's worker. Which
// workers serve it is pinned against the workers themselves: should the Python openai-agents worker gain
// the route, or stop naming itself "python", this fails and its exclusion must be revisited.
func TestComputerModelCallsFollowTheWorkers(t *testing.T) {
	for _, c := range []struct {
		runtime, sdk string
		want         bool
	}{{runtimePI, "", true}, {runtimePI, "python", true}, {runtimeOpenAIAgents, "0.18.0", true}, {runtimeOpenAIAgents, "", true},
		{runtimeOpenAIAgents, "python", false}, {"other", "", false}} {
		if got := computerModelCalls(c.runtime, piHealth{SDKVersion: c.sdk}); got != c.want {
			t.Errorf("computerModelCalls(%q, sdkVersion %q) = %v, want %v", c.runtime, c.sdk, got, c.want)
		}
	}
	read := func(parts ...string) string {
		raw, e := os.ReadFile(filepath.Join(append([]string{"..", "..", ".."}, parts...)...))
		if e != nil {
			t.Fatal(e)
		}
		return string(raw)
	}
	for _, worker := range [][]string{{"apps", "pi-worker", "server.mjs"}, {"apps", "openai-agents-worker", "server.mjs"}} {
		if !strings.Contains(read(worker...), "pathname === '/internal/computer-model'") {
			t.Error("this worker no longer serves managed-execution model calls", worker)
		}
	}
	if strings.Contains(read("apps", "openai-agents-python-worker", "server.py"), "/internal/computer-model") {
		t.Error("the Python worker serves managed-execution model calls now: drop its exclusion in computerModelCalls")
	}
	if !strings.Contains(read("apps", "openai-agents-python-worker", "config.py"), `"sdkVersion": "python"`) {
		t.Error("the Python worker no longer reports sdkVersion python, which computerModelCalls relies on")
	}
}

// The runtime list is Pi first however the probes race, and leaves out a runtime whose worker serves no
// managed-execution model calls; such a task is refused before an invocation is reserved or the worker is
// called (production 2026-10-06: the panel preselected Python-worker models, and each task failed at
// its first model call).
func TestPostgresComputerRuntimeOffersOnlyWorkersThatServeModelCalls(t *testing.T) {
	health := func(runtime, model string) map[string]any {
		return map[string]any{"ready": true, "model": model, "provider": "test", "models": []map[string]any{{"id": model, "provider": "test", "runtime": runtime, "maxContextTextBytes": 262144}}}
	}
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			time.Sleep(150 * time.Millisecond) // answers after the other runtime
			writeJSON(w, 200, health(runtimePI, "pi-model"))
			return
		}
		t.Error("unexpected Pi worker call", r.Method, r.URL.Path)
	}))
	defer pi.Close()
	var sdk atomic.Value
	sdk.Store("python")
	agents := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			body := health(runtimeOpenAIAgents, "agents-model")
			body["sdkVersion"] = sdk.Load()
			writeJSON(w, 200, body)
			return
		}
		t.Error("unexpected openai-agents worker call", r.Method, r.URL.Path)
	}))
	defer agents.Close()
	var runs atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		runs.Add(1)
		w.WriteHeader(500)
	}))
	defer worker.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL = agents.URL
	h.a.cfg.OpenAIAgentsToken = strings.Repeat("o", 32)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-runtimes@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	runtimes := func() []string {
		listed := []string{}
		for _, m := range h.request(t, owner, "GET", base+"/computer-runtime", nil, 200)["models"].([]any) {
			listed = append(listed, m.(map[string]any)["runtime"].(string)+"/"+m.(map[string]any)["id"].(string))
		}
		return listed
	}
	if got := runtimes(); strings.Join(got, ",") != "pi/pi-model" {
		t.Fatal("Python-worker models offered for managed execution", got)
	}
	refused := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": "computer-python-worker", "prompt": "Prepare a report", "runtime": "openai-agents", "model": "agents-model"}, 400)
	if refused["error"].(map[string]any)["code"] != "computer_model_unsupported" {
		t.Fatal("unexpected refusal", refused)
	}
	var invocations int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); e != nil || invocations != 0 {
		t.Fatal("a refused run reserved an invocation", invocations, e)
	}
	if runs.Load() != 0 {
		t.Fatal("the execution service was called for a refused run")
	}
	sdk.Store("0.18.0") // the JavaScript worker serves the runtime: its models are offered, after Pi's
	if got := runtimes(); strings.Join(got, ",") != "pi/pi-model,openai-agents/agents-model" {
		t.Fatal("runtime order or availability wrong", got)
	}
}

// Personal-credential mode builds each runtime's catalog from the user's connections, and keeps the
// worker's own identity: a Python worker serving openai-agents is left out there too.
func TestPostgresComputerRuntimeKeepsTheWorkerIdentityWithPersonalCredentials(t *testing.T) {
	trusted := func(sdk string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/health" {
				writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true, "sdkVersion": sdk})
				return
			}
			t.Error("unexpected model worker call", r.Method, r.URL.Path)
		}))
	}
	pi, agents := trusted(""), trusted("python")
	defer pi.Close()
	defer agents.Close()
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		t.Error("unexpected execution service call", r.Method, r.URL.Path)
	}))
	defer worker.Close()
	h := newHarness(t, pi.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenAIAgentsURL = agents.URL
	h.a.cfg.OpenAIAgentsToken = strings.Repeat("o", 32)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-personal-runtimes@example.test")
	addPersonalConnection(t, h, owner)
	h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "llmgate", "runtime": "openai-agents", "apiKey": "synthetic-personal-secret", "name": "Agents"}, 201)
	listed := []string{}
	for _, m := range h.request(t, owner, "GET", "/tenants/"+tid+"/computer-runtime", nil, 200)["models"].([]any) {
		listed = append(listed, m.(map[string]any)["runtime"].(string))
	}
	if len(listed) == 0 || slices.Contains(listed, runtimeOpenAIAgents) {
		t.Fatal("personal-credential listing kept Python-worker models or lost Pi's", listed)
	}
}
