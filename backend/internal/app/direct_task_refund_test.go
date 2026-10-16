package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// refundFixture stores runs with their model calls in a workspace whose canvas has a direct-task session per run.
type refundFixture struct {
	t                         *testing.T
	h                         *harness
	tid, canvas, plain, agent string
}

func newRefundFixture(t *testing.T, h *harness, email string) (*refundFixture, string, *http.Cookie) {
	t.Helper()
	c, tid, _ := h.register(t, email)
	canvas, _, plain := h.fixture(t, c, tid)
	f := &refundFixture{t: t, h: h, tid: tid, canvas: canvas, plain: plain, agent: randomID()}
	execSQL(t, h, "INSERT INTO agents(id,tenant_id,name,role,instructions,internal,runtime,model,effort) VALUES($1,$2,'Execution assistant','computer','x',true,'pi','m','')", f.agent, tid)
	return f, tid, c
}

// run stores a run of the given kind and ending with one model call per "status/cost_status/admission_status/failure_class", and
// records its refund as the API does (finishOnce; app.go Start): an interrupted direct task, one the execution service
// dropped (computer_stream_ended) and one failed with computer_execution_failed.
func (f *refundFixture) run(kind, status, code string, calls ...string) string {
	f.t.Helper()
	rid, sid := randomID(), f.plain
	if kind == "computer" {
		sid = randomID()
		execSQL(f.t, f.h, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title,kind) VALUES($1,$2,$3,'$computer',$4,'Execution assistant','computer')", sid, f.tid, f.canvas, f.agent)
	}
	execSQL(f.t, f.h, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,error) VALUES($1,$2,$3,$4,'h','p',$5,$6)", rid, f.tid, sid, "op-"+rid, status, code)
	if reason := map[string]string{"interrupted": "interrupted", "failed": "failed"}[status]; kind == "computer" && reason != "" && (status == "interrupted" || computerRefundable(code)) {
		if code == "computer_stream_ended" {
			reason = "dropped"
		}
		execSQL(f.t, f.h, "INSERT INTO refunded_runs(tenant_id,run_id,reason) VALUES($1,$2,$3)", f.tid, rid, reason)
	}
	for _, call := range calls {
		parts := strings.Split(call, "/")
		execSQL(f.t, f.h, "INSERT INTO model_invocations(id,tenant_id,run_id,status,cost_status,admission_status,failure_class,model_id) VALUES($1,$2,$3,$4,$5,$6,$7,'bedrock.test')", randomID(), f.tid, rid, parts[0], parts[1], parts[2], parts[3])
	}
	return rid
}

const (
	callDone    = "completed/unavailable/accepted/none"
	callCut     = "failed/unavailable/unknown/transport"                 // the connection to the worker broke: the platform's side
	callLimit   = "failed/unavailable/unknown/timeout"                   // cut by its own limit or its caller: not the platform's
	callAnswer  = "failed/unavailable/unknown/protocol"                  // the model's own answer did not hold
	callRefused = "failed/not_incurred/rejected_before_start/validation" // refused before any work
)

// Owner 2026-10-16: a direct task the platform failed gives its calls back to the daily total, and a call that never
// reached a model never counts. Security review 2026-10-16: a task that failed of its own doing (its limits, a refused
// call) is not refunded, route allowances and the ceilings count as before, at most 32 calls a day come back, and a
// refund outlives a deleted canvas.
func TestPostgresPlatformFailedDirectTasksGiveTheirCallsBack(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	f, tid, c := newRefundFixture(t, h, "refund-owner@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET route_limits='{"gate":5,"bedrock":19,"media":1}'::jsonb,max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	failed := f.run("computer", "failed", "computer_execution_failed", callDone, callCut)      // given back: 2
	refused := f.run("computer", "failed", "computer_execution_failed", callDone, callRefused) // counts 1
	f.run("computer", "failed", "computer_stream_ended", callDone)                             // given back: 1, the service dropped it
	f.run("computer", "failed", "computer_execution_failed", callDone, callAnswer)             // counts 2: its own answer
	f.run("computer", "failed", "computer_execution_failed", callDone, callLimit)              // counts 2: a call cut by its own limit
	f.run("computer", "interrupted", "API restarted before completion", callDone)              // given back: 1
	timeout := f.run("computer", "failed", computerFailureCode("TIMEOUT"), callDone, callCut)  // counts 2: its own limit
	quota := f.run("computer", "failed", "quota_exceeded", callDone)                           // counts 1
	f.run("computer", "cancelled", "", callDone)                                               // counts 1
	f.run("computer", "completed", "", callDone)                                               // counts 1
	f.run("plain", "failed", "computer_execution_failed", callDone, callCut)                   // counts 2: not a direct task
	f.run("computer", "queued", "", "running/not_incurred/unknown/none")                       // counts 1: still running
	f.run("plain", "completed", "", callRefused, "running/not_incurred/not_attempted/none")    // counts 1
	const counted, inRoute = 14, 18                                                            // 20 calls: 4 given back; the route counts all but the 2 settled not_incurred

	v := h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)
	if _, used := allowanceOf(t, v, "daily"); used != counted {
		t.Fatalf("the meter shows %d calls today, want %d", used, counted)
	}
	routes, _ := v["routes"].(map[string]any)
	if _, used := allowanceOf(t, routes, "bedrock"); used != inRoute {
		t.Fatalf("the bedrock allowance shows %d used, want %d: refunds are the daily total's only", used, inRoute)
	}
	// Admission counts the same, on the route and on the daily total.
	open := runningRun(t, h, c, tid)
	if e := reserveModel(h, tid, open, "bedrock.test"); e != nil {
		t.Fatal("a call within the route allowance was refused:", e)
	}
	if e := reserveModel(h, tid, open, "bedrock.test"); !errors.Is(e, errRouteQuota) {
		t.Fatal("the route's limit was not where expected:", e)
	}
	execSQL(t, h, "UPDATE tenants SET max_runs_per_day=$2 WHERE id=$1", tid, counted+2)
	if e := reserveModel(h, tid, open, "claude-sonnet-5"); e != nil {
		t.Fatal("the day's last call was refused:", e)
	}
	if e := reserveModel(h, tid, open, "claude-sonnet-5"); !errors.Is(e, errInvocationQuota) {
		t.Fatal("a call past the daily total was admitted:", e)
	}

	for _, want := range []struct {
		id, code       string
		calls, refunds float64
	}{{failed, "computer_execution_failed", 2, 2}, {refused, "computer_execution_failed", 1, 0},
		{timeout, "computer_task_timeout", 2, 0}, {quota, "quota_exceeded", 1, 0}} {
		detail := h.request(t, c, "GET", "/tenants/"+tid+"/computer-runs/"+want.id, nil, 200)
		if detail["calls"] != want.calls || detail["refundedCalls"] != want.refunds || detail["error"] != want.code {
			t.Fatalf("task %s reads calls=%v refundedCalls=%v error=%v", want.code, detail["calls"], detail["refundedCalls"], detail["error"])
		}
	}
	list := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+f.canvas+"/computer-runs", nil, 200)
	seen := map[string]bool{}
	for _, item := range list["items"].([]any) {
		code, ok := item.(map[string]any)["error"].(string)
		if !ok {
			t.Fatalf("a listed task has no error field: %#v", item)
		}
		seen[code] = true
	}
	if !seen["computer_execution_failed"] || !seen["computer_task_timeout"] || !seen[""] {
		t.Fatalf("the list must say how each task ended: %v", seen)
	}

	// At most refundedCallsPerDay calls a day come back, and deleting the canvas keeps the refund.
	g, other, cm := newRefundFixture(t, h, "refund-many@awwo.invalid")
	for range 3 {
		calls := []string{callCut}
		for range 15 {
			calls = append(calls, callDone)
		}
		g.run("computer", "failed", "computer_stream_ended", calls...)
	}
	daily := func() int {
		t.Helper()
		_, used := allowanceOf(t, h.request(t, cm, "GET", "/tenants/"+other+"/route-usage", nil, 200), "daily")
		return used
	}
	if used := daily(); used != 48-refundedCallsPerDay {
		t.Fatalf("48 refunded calls left %d counted, want %d", used, 48-refundedCallsPerDay)
	}
	h.request(t, cm, "DELETE", "/tenants/"+other+"/canvases/"+g.canvas, nil, 204)
	var runs int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1", other).Scan(&runs); e != nil || runs != 0 {
		t.Fatalf("the canvas's runs are still there (%d, %v)", runs, e)
	}
	if used := daily(); used != 48-refundedCallsPerDay {
		t.Fatalf("after the canvas was deleted %d calls count, want %d", used, 48-refundedCallsPerDay)
	}
}

// The refund is recorded where a direct task ends: a platform failure after a call the worker or provider failed,
// never one whose own answer failed (or broke its stream), that the provider refused before any work or that ran into
// its own limits (the broker's output limit too); the broker stopping a live task (its restart), never the user's own
// stop; an API shutting down under a live task; and a crash found by the next Start.
func TestPostgresDirectTaskEndingsRecordTheirRefund(t *testing.T) {
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
		reason := "bedrock:429:ThrottlingException" // a provider fault, as a Bedrock call reports it (bedrock-call.mjs)
		if len(b.Completion.Messages) > 0 {
			switch b.Completion.Messages[0].Content {
			case "answer", "stream", "drop":
				reason = "answer" // the model's own answer did not hold
				if b.Completion.Messages[0].Content == "stream" {
					reason = "stream" // or broke the stream
				}
			case "slow":
				time.Sleep(2 * time.Second) // longer than its caller waits
			case "refused":
				reason = "bedrock:400:ValidationException" // the provider refused the request before any work
			}
		}
		writeJSON(w, 502, map[string]any{"error": map[string]string{"code": "PROVIDER_ERROR", "message": "x", "reason": reason}})
	}))
	defer trusted.Close()
	long := strings.Repeat("长", 70) + ".html"
	live := make(chan string, 1)
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
		w.Header().Set("Content-Type", "text/event-stream")
		scenario := strings.Fields(input.Prompt)[0]
		switch scenario {
		case "platform", "answer", "refused", "stream", "timeout", "brokerstop", "toolong", "drop":
			computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": scenario}}}, 502)
		case "refusedrop":
			// Its second call meets the day's total (lowered below), then the stream drops.
			computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": "answer"}}}, 502)
			computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": "answer"}}}, 403)
		case "slow":
			// The task's own side gives up on the call (as the core's idle limit does): its caller is gone.
			raw, _ := json.Marshal(map[string]any{"messages": []map[string]string{{"role": "user", "content": scenario}}})
			req, _ := http.NewRequest("POST", input.ModelProxyURL+"/chat/completions", bytes.NewReader(raw))
			req.Header.Set("Authorization", "Bearer "+input.ModelProxyToken)
			req.Header.Set("Content-Type", "application/json")
			if resp, e := (&http.Client{Timeout: 300 * time.Millisecond}).Do(req); e == nil {
				resp.Body.Close()
			}
		}
		switch scenario {
		case "platform", "answer", "refused", "stream", "slow":
			fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n")
		case "brokerstop":
			fmt.Fprint(w, "data: {\"type\":\"cancelled\"}\n\n") // the broker shutting down cancels its running tasks
		case "toolong":
			// Past the broker's output limit (lowered below) it cuts the stream without a last event.
			fmt.Fprintf(w, "data: {\"type\":\"computer_message\",\"role\":\"assistant\",\"text\":%q}\n\n", strings.Repeat("x", 2048))
		case "timeout":
			fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"TIMEOUT\"}\n\n")
		case "budget":
			fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"MODEL_BUDGET_EXCEEDED\"}\n\n")
		case "file":
			data := []byte("<p>ok</p>")
			ev, _ := json.Marshal(map[string]string{"type": "computer_artifact", "name": long, "path": "out/page.html", "encoding": "base64", "content": base64.StdEncoding.EncodeToString(data), "sha256": tokenHash(string(data))})
			fmt.Fprintf(w, "data: %s\n\ndata: {\"type\":\"completed\",\"output\":\"done\"}\n\n", ev)
		case "live":
			w.(http.Flusher).Flush()
			live <- input.RunID
			<-r.Context().Done()
		}
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "refund-endings@example.test")
	model := connectionModelID(addPersonalConnection(t, h, owner), "test-chat-model")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	start := func(prompt string) string {
		t.Helper()
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": "refund-" + prompt + "-" + randomID(), "prompt": prompt + " task", "runtime": "pi", "model": model}, 202)
		return run["id"].(string)
	}
	task := func(prompt, status string) map[string]any {
		t.Helper()
		id := start(prompt)
		h.awaitRun(t, owner, tid, id, status)
		return h.request(t, owner, "GET", base+"/computer-runs/"+id, nil, 200)
	}
	for _, c := range []struct {
		prompt, code string
		refunds      float64
	}{{"platform", "computer_execution_failed", 1}, {"answer", "computer_execution_failed", 0}, {"refused", "computer_execution_failed", 0},
		{"stream", "computer_execution_failed", 0}, {"slow", "computer_execution_failed", 0}, {"timeout", "computer_task_timeout", 0},
		{"budget", "computer_call_budget", 0}} {
		if d := task(c.prompt, "failed"); d["error"] != c.code || d["refundedCalls"] != c.refunds {
			t.Fatalf("%s: the task reads %v, refunded %v; want %s, %v", c.prompt, d["error"], d["refundedCalls"], c.code, c.refunds)
		}
	}
	d := task("file", "completed")
	files := d["artifacts"].([]any)
	if len(files) != 1 {
		t.Fatalf("the long-named file was not kept: %#v", d)
	}
	if name := files[0].(map[string]any)["name"].(string); len(name) > 200 || !strings.HasSuffix(name, ".html") || !utf8.ValidString(name) {
		t.Fatalf("the long name was stored as %q", name)
	}
	reason := func(id string) string {
		t.Helper()
		var r string
		if e := h.db.QueryRow(context.Background(), "SELECT COALESCE((SELECT reason FROM refunded_runs WHERE tenant_id=$1 AND run_id=$2),'')", tid, id).Scan(&r); e != nil {
			t.Fatal(e)
		}
		return r
	}
	// The broker stopping a live task (its restart) interrupts it and gives its calls back.
	if d := task("brokerstop", "interrupted"); d["refundedCalls"] != float64(1) || reason(d["id"].(string)) != "interrupted" {
		t.Fatalf("a task the broker stopped reads %v with refund %v", d["status"], d["refundedCalls"])
	}
	// A stream the execution service dropped is its doing, whatever the calls: they come back.
	if d := task("drop", "failed"); d["error"] != "computer_stream_ended" || d["refundedCalls"] != float64(1) || reason(d["id"].(string)) != "dropped" {
		t.Fatalf("a dropped task reads %v, refunded %v", d["error"], d["refundedCalls"])
	}
	// A task one of whose calls the day's total refused ends with that refusal, though its stream dropped after.
	var today, limit int
	if e := h.db.QueryRow(context.Background(), "SELECT "+dailyCalls("$2", "true")+" FROM model_invocations mi WHERE mi.tenant_id=$1 AND mi.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", tid, h.cfg.PlannerModel).Scan(&today); e != nil {
		t.Fatal(e)
	}
	if e := h.db.QueryRow(context.Background(), "SELECT max_runs_per_day FROM tenants WHERE id=$1", tid).Scan(&limit); e != nil {
		t.Fatal(e)
	}
	execSQL(t, h, "UPDATE tenants SET max_runs_per_day=$2 WHERE id=$1", tid, today+1)
	d = task("refusedrop", "failed")
	execSQL(t, h, "UPDATE tenants SET max_runs_per_day=$2 WHERE id=$1", tid, limit)
	if d["error"] != "quota_exceeded" || d["refundedCalls"] != float64(0) || reason(d["id"].(string)) != "" {
		t.Fatalf("a task whose call its allowance refused reads %v, refunded %v", d["error"], d["refundedCalls"])
	}
	// A stream the broker cut at its output limit is the task's own output: nothing back.
	near := computerBrokerEventsNear
	t.Cleanup(func() { computerBrokerEventsNear = near })
	computerBrokerEventsNear = 1024
	d = task("toolong", "failed")
	computerBrokerEventsNear = near
	if d["error"] != "computer_output_limit" || d["refundedCalls"] != float64(0) {
		t.Fatalf("a task past the broker's output limit reads %v, refunded %v", d["error"], d["refundedCalls"])
	}
	// The user's own stop gives nothing back.
	stopped := start("live")
	if <-live != stopped {
		t.Fatal("the task to stop did not start")
	}
	h.request(t, owner, "POST", base+"/runs/"+stopped+"/cancel", nil, 200)
	h.awaitRun(t, owner, tid, stopped, "cancelled")
	if r := reason(stopped); r != "" {
		t.Fatalf("the user's stop was recorded as a refund (%q)", r)
	}

	// The API shutting down under a live task interrupts it and gives its calls back.
	running := start("live")
	if <-live != running {
		t.Fatal("the live task did not start")
	}
	h.server.Close()
	h.a.Close()
	var status string
	if e := h.db.QueryRow(context.Background(), "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2", tid, running).Scan(&status); e != nil || status != "interrupted" || reason(running) != "interrupted" {
		t.Fatalf("a task the shutdown cut is %q with refund %q (%v)", status, reason(running), e)
	}
	// A crash leaves tasks running: the next Start interrupts them, a direct task with a refund, a canvas run without.
	restart := func() {
		t.Helper()
		h.a = New(h.db, h.cfg)
		if e := h.a.Start(context.Background()); e != nil {
			t.Fatal(e)
		}
		h.server = httptest.NewServer(h.a.Handler())
	}
	restart()
	f := &refundFixture{t: t, h: h, tid: tid, canvas: canvas, agent: randomID()}
	_, _, f.plain = h.fixture(t, owner, tid)
	execSQL(t, h, "INSERT INTO agents(id,tenant_id,name,role,instructions,internal,runtime,model,effort) VALUES($1,$2,'Execution assistant','computer','x',true,'pi','m','')", f.agent, tid)
	cut := f.run("computer", "running", "", "running/not_incurred/unknown/none")
	plain := f.run("plain", "running", "", "running/not_incurred/unknown/none")
	h.server.Close()
	h.a.Close()
	restart()
	if reason(cut) != "interrupted" || reason(plain) != "" {
		t.Fatalf("after a restart the direct task's refund is %q and the canvas run's %q", reason(cut), reason(plain))
	}
}

func TestComputerFailureCodesAndLongFileNames(t *testing.T) {
	for worker, want := range map[string]string{"TIMEOUT": "computer_task_timeout", "MODEL_BUDGET_EXCEEDED": "computer_call_budget",
		"TOOL_BUDGET_EXCEEDED": "computer_tool_budget", "CORE_EXECUTION_FAILED": "computer_execution_failed", "": "computer_execution_failed"} {
		if got := computerFailureCode(worker); got != want {
			t.Fatalf("%q reads %q, want %q", worker, got, want)
		}
	}
	if !computerRefundable("computer_execution_failed") || !computerRefundable("computer_stream_ended") || computerRefundable("computer_task_timeout") || computerRefundable("quota_exceeded") {
		t.Fatal("only the execution service's failures may be refunded")
	}
	long := strings.Repeat("长", 70) + ".html" // 215 bytes: an ordinary Chinese title
	got := computerArtifactName(long)
	if len(got) > 200 || !utf8.ValidString(got) || !strings.HasSuffix(got, ".html") || !cleanName(got) || !strings.HasPrefix(long, strings.TrimSuffix(got, ".html")) {
		t.Fatalf("a long name became %q (%d bytes)", got, len(got))
	}
	for reason, want := range map[string]string{"bedrock:429:ThrottlingException": "computer_model_provider", "bedrock:503:ServiceUnavailableException": "computer_model_provider",
		"bedrock:403:AccessDeniedException": "computer_model_provider", "bridge-error:TypeError": "computer_model_provider", "credentials": "computer_model_provider",
		"child-exit:SIGKILL": "computer_model_provider", "bedrock:400:ValidationException": "computer_model_failed", "stream": "computer_model_answer",
		"answer": "computer_model_answer", "unknown": "computer_model_failed", "": "computer_model_failed", "bedrock:x:y": "computer_model_failed"} {
		body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "PROVIDER_ERROR", "message": "x", "reason": reason}})
		if got := computerModelFailure(502, body); got != want {
			t.Fatalf("a provider error with reason %q reads %q, want %q", reason, got, want)
		}
	}
	if computerModelFailure(499, []byte(`{"error":{"code":"CANCELLED"}}`)) != "computer_model_cut" || computerModelFailure(502, []byte("not json")) != "computer_model_failed" {
		t.Fatal("a cut call or an unreadable answer is classed wrongly")
	}
	if computerArtifactName("report.md") != "report.md" {
		t.Fatal("a short name must stay as it is")
	}
	if odd := computerArtifactName(strings.Repeat("a", 190) + "." + strings.Repeat("x", 40)); len(odd) != 200 {
		t.Fatalf("a name with an overlong extension became %d bytes", len(odd))
	}
}
