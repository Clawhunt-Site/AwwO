package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
		id := randomID()
		execSQL(f.t, f.h, "INSERT INTO model_invocations(id,tenant_id,run_id,status,cost_status,admission_status,failure_class,model_id) VALUES($1,$2,$3,$4,$5,$6,$7,'bedrock.test')", id, f.tid, rid, parts[0], parts[1], parts[2], parts[3])
		if len(parts) > 4 && parts[4] == "noted" { // as settleComputerCall notes a call a time limit on its way cut
			execSQL(f.t, f.h, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,$2,'timeout')", f.tid, id)
		}
	}
	return rid
}

const (
	callDone    = "completed/unavailable/accepted/none"
	callCut     = "failed/unavailable/unknown/transport"                 // the connection to the worker broke: the platform's side
	callLimit   = "failed/unavailable/unknown/timeout"                   // cut by its own limit or its caller: not the platform's
	callEdge    = "failed/unavailable/unknown/timeout/noted"             // cut by a time limit on its way: the platform's, itself only
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
	execSQL(t, h, `UPDATE tenants SET route_limits='{"gate":5,"bedrock":29,"media":1}'::jsonb,max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
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
	// The owner, 2026-10-18: a call a time limit on its way cut gives back itself only, once its task ended for the
	// platform's sake; not the task's other calls, unless another of them failed on the platform's side; nothing for a
	// task that completed or that its own limit ended.
	edge := f.run("computer", "failed", "computer_execution_failed", callDone, callDone, callEdge) // given back: 1, counts 2
	mixed := f.run("computer", "failed", "computer_execution_failed", callDone, callEdge, callCut) // given back: 3
	f.run("computer", "completed", "", callDone, callEdge)                                         // counts 2
	ownLimit := f.run("computer", "failed", computerFailureCode("TIMEOUT"), callDone, callEdge)    // counts 2: its own limit
	const counted, inRoute = 20, 28                                                                // 30 calls: 8 given back; the route counts all but the 2 settled not_incurred

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
		id, code, scope string
		calls, refunds  float64
	}{{failed, "computer_execution_failed", "task", 2, 2}, {refused, "computer_execution_failed", "", 1, 0},
		{timeout, "computer_task_timeout", "", 2, 0}, {quota, "quota_exceeded", "", 1, 0},
		{edge, "computer_execution_failed", "cut", 3, 1}, {mixed, "computer_execution_failed", "task", 3, 3},
		{ownLimit, "computer_task_timeout", "", 2, 0}} {
		detail := h.request(t, c, "GET", "/tenants/"+tid+"/computer-runs/"+want.id, nil, 200)
		if detail["calls"] != want.calls || detail["refundedCalls"] != want.refunds || detail["error"] != want.code {
			t.Fatalf("task %s reads calls=%v refundedCalls=%v error=%v", want.code, detail["calls"], detail["refundedCalls"], detail["error"])
		}
		// Which calls came back: every call of the task, or only those a time limit on their way cut; none, none.
		if (want.refunds > 0 && detail["refundScope"] != want.scope) || (want.refunds == 0 && detail["refundScope"] != nil) {
			t.Fatalf("task %s gave back %v calls as %v, want %q", want.code, want.refunds, detail["refundScope"], want.scope)
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
	for range 2 { // a call a time limit cut counts against the same cap
		g.run("computer", "failed", "computer_execution_failed", callEdge, callDone)
	}
	daily := func() int {
		t.Helper()
		_, used := allowanceOf(t, h.request(t, cm, "GET", "/tenants/"+other+"/route-usage", nil, 200), "daily")
		return used
	}
	if used := daily(); used != 52-refundedCallsPerDay {
		t.Fatalf("52 calls, 50 of them refunded, left %d counted, want %d", used, 52-refundedCallsPerDay)
	}
	h.request(t, cm, "DELETE", "/tenants/"+other+"/canvases/"+g.canvas, nil, 204)
	var runs int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1", other).Scan(&runs); e != nil || runs != 0 {
		t.Fatalf("the canvas's runs are still there (%d, %v)", runs, e)
	}
	if used := daily(); used != 52-refundedCallsPerDay {
		t.Fatalf("after the canvas was deleted %d calls count, want %d", used, 52-refundedCallsPerDay)
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
			case "gate":
				// A provider's outage, as the worker names its status (computer-model.ts): this harness's calls run on a
				// personal connection, whose provider is the user's own, so it gives nothing back.
				reason = "provider:503"
			case "gaterefused":
				reason = "provider:400:invalid_request_error" // LLM Gate refused the request as invalid
			case "workerstop":
				// The model worker stopped under the call (a release or a restart).
				writeJSON(w, 499, map[string]any{"error": map[string]string{"code": "CANCELLED", "message": "x", "reason": "stopping"}})
				return
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
		case "platform", "answer", "refused", "stream", "timeout", "brokerstop", "toolong", "drop", "gate", "gaterefused", "workerstop":
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
		case "platform", "answer", "refused", "stream", "slow", "gate", "gaterefused", "workerstop":
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
		{"budget", "computer_call_budget", 0}, {"gate", "computer_execution_failed", 0}, {"gaterefused", "computer_execution_failed", 0},
		{"workerstop", "computer_execution_failed", 1}} {
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
	if !computerRefundable("computer_execution_failed") || !computerRefundable("computer_stream_ended") || computerRefundable("computer_task_timeout") || computerRefundable("quota_exceeded") ||
		computerRefundable("computer_context_limit") {
		t.Fatal("only the execution service's failures may be refunded")
	}
	// A call a time limit on its way cut is a timeout in the ledger, never evidence that gives back its task's every call.
	if invocationFailure("failed", "computer_model_timeout") != "timeout" || invocationFailure("failed", "computer_model_provider") != "provider" {
		t.Fatal("a cut on the way must be a timeout, a provider's failure the provider's")
	}
	long := strings.Repeat("长", 70) + ".html" // 215 bytes: an ordinary Chinese title
	got := computerArtifactName(long)
	if len(got) > 200 || !utf8.ValidString(got) || !strings.HasSuffix(got, ".html") || !cleanName(got) || !strings.HasPrefix(long, strings.TrimSuffix(got, ".html")) {
		t.Fatalf("a long name became %q (%d bytes)", got, len(got))
	}
	for reason, want := range map[string]string{"bedrock:429:ThrottlingException": "computer_model_provider", "bedrock:503:ServiceUnavailableException": "computer_model_provider",
		"bedrock:403:AccessDeniedException": "computer_model_provider", "bridge-error:TypeError": "computer_model_provider", "credentials": "computer_model_provider",
		"child-exit:SIGKILL": "computer_model_provider", "bedrock:400:ValidationException": "computer_model_failed", "stream": "computer_model_answer",
		"answer": "computer_model_answer", "unknown": "computer_model_failed", "": "computer_model_failed", "bedrock:x:y": "computer_model_failed",
		// A provider behind LLM Gate (apps/computer-model.ts): refusing our key, missing the model, throttling or out of
		// service is the platform's side; a 403 (a firewall rule on the task's words), another 5xx, a refusal of the request
		// or an error in a 200 is not, nor is no answer at all unless the provider was out of reach before the request was sent.
		"provider:503": "computer_model_provider", "provider:529:overloaded_error": "computer_model_provider", "provider:429:rate_limit_exceeded": "computer_model_provider",
		"provider:401:invalid_api_key": "computer_model_provider", "provider:404:model_not_found": "computer_model_provider",
		// Cloudflare could not reach LLM Gate's origin: an outage; a 403 is the platform's only when it names the operator's
		// quota or key, never a bare one (a firewall's page).
		"provider:521": "computer_model_provider", "provider:522": "computer_model_provider", "provider:523": "computer_model_provider",
		"provider:525": "computer_model_provider", "provider:526": "computer_model_provider", "provider:530": "computer_model_provider",
		"provider:403:insufficient_user_quota": "computer_model_provider", "provider:403:permission_error": "computer_model_provider",
		"provider:403:forbidden": "computer_model_failed", "provider:403": "computer_model_failed", "provider:500:do_request_failed": "computer_model_failed",
		"provider:502": "computer_model_failed",
		"provider:520": "computer_model_failed", "provider:400:context_length_exceeded": "computer_model_failed", "provider:422": "computer_model_failed",
		"provider:200:new_api_error": "computer_model_failed", "network:ECONNREFUSED": "computer_model_provider", "network:ENOTFOUND": "computer_model_provider",
		"network": "computer_model_failed", "network:UND_ERR_SOCKET": "computer_model_failed", "network:ECONNRESET": "computer_model_failed",
		"body": "computer_model_provider", "worker": "computer_model_provider",
		// A Gate call cut by a time limit on its way (a 408, an edge's 504 or 524, the worker's HTTP client's) and a Bedrock
		// model's own time limit (its 408, or after its stream began) are the platform's timeouts (the owner, 2026-10-17),
		// which give back only the call they cut (the owner, 2026-10-18). A connection that never opened is an outage.
		"provider:524": "computer_model_timeout", "provider:504:gateway_timeout": "computer_model_timeout", "provider:504": "computer_model_timeout",
		"network:UND_ERR_HEADERS_TIMEOUT": "computer_model_timeout", "network:UND_ERR_BODY_TIMEOUT": "computer_model_timeout",
		"stream:error:408:ModelTimeoutException": "computer_model_timeout", "stream:error:408:modelTimeoutException": "computer_model_timeout",
		"provider:408": "computer_model_timeout", "bedrock:408:ModelTimeoutException": "computer_model_timeout",
		// The bridge names an AWS 504 it has no exception name for api_error (bridgeFailure in apps/bedrock-bridge.ts).
		"network:UND_ERR_CONNECT_TIMEOUT": "computer_model_provider", "bedrock:504:api_error": "computer_model_timeout",
		"provider:5240": "computer_model_failed", "bedrock:4080:x": "computer_model_provider", // a status, not its prefix
		// A Bedrock stream: an AWS outage after it began is the provider's; a model whose output broke it, the bridge's refusal
		// of what the model sent and a stream that ended early are the answer's.
		// A streamed Gate call whose stream closed after a silence as long as the edge's idle limit is the same edge's cut as
		// a 524 (the refund session's reading of the owner's rule, 2026-10-17); a close at once, which a task's own words can
		// bring about (a moderation stop), is not.
		"stream:closed:idle": "computer_model_timeout", "stream:closed": "computer_model_answer", "stream:closed:idle:x": "computer_model_answer",
		// A Gate stream's error frame is the Gate's error inside a 200, as one read whole: the platform's when it names the
		// provider's capacity or the operator's access, as its status would have; not a server error, the Gate's catch-all
		// or a moderation code (the refund session, 2026-10-17).
		"provider:200:overloaded_error": "computer_model_provider", "provider:200:rate_limit_error": "computer_model_provider",
		"provider:200:rate_limit_exceeded": "computer_model_provider", "provider:200:insufficient_quota": "computer_model_provider",
		"provider:200:insufficient_user_quota": "computer_model_provider", "provider:200:permission_error": "computer_model_provider",
		"provider:200:server_error": "computer_model_failed", "provider:200:api_error": "computer_model_failed", "provider:200": "computer_model_failed",
		"provider:200:bad_response_status_code": "computer_model_failed", "provider:200:DataInspectionFailed": "computer_model_failed",
		"stream:unfinished": "computer_model_answer", "stream:error:429:throttlingException": "computer_model_provider", "stream:error:503:serviceUnavailableException": "computer_model_provider",
		"stream:error:500:InternalServerException": "computer_model_provider", "stream:error:502:modelStreamErrorException": "computer_model_answer",
		"stream:error:502:ModelErrorException": "computer_model_answer", "stream:error:400:validationException": "computer_model_answer",
		"stream:error:api_error": "computer_model_answer", "stream:error:503": "computer_model_answer", "stream:truncated": "computer_model_answer"} {
		body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "PROVIDER_ERROR", "message": "x", "reason": reason, "detail": "finish:length"}})
		if got := computerModelFailure(502, body, false); got != want {
			t.Fatalf("a provider error with reason %q reads %q, want %q", reason, got, want)
		}
	}
	// With personal credentials the provider, its key and its quota are the user's: none of its failures is the platform's,
	// its time limits on the way included; the worker's own failure stays the platform's.
	for reason, want := range map[string]string{"provider:503": "computer_model_failed", "provider:401:invalid_api_key": "computer_model_failed",
		"network:ECONNREFUSED": "computer_model_failed", "body": "computer_model_failed", "provider:524": "computer_model_failed",
		"network:UND_ERR_HEADERS_TIMEOUT": "computer_model_failed", "stream:closed:idle": "computer_model_failed", "stream:closed": "computer_model_failed",
		"provider:200:overloaded_error": "computer_model_failed",
		// A personal LLM Gate key streams too (its error frames read provider:200:…): no stream label, whatever produced it,
		// is the platform's on a personal connection.
		"stream:error:503:ServiceUnavailableException": "computer_model_failed", "worker": "computer_model_provider", "answer": "computer_model_answer"} {
		body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "PROVIDER_ERROR", "message": "x", "reason": reason}})
		if got := computerModelFailure(502, body, true); got != want {
			t.Fatalf("on a personal connection, a provider error with reason %q reads %q, want %q", reason, got, want)
		}
	}
	if computerModelFailure(499, []byte(`{"error":{"code":"CANCELLED"}}`), false) != "computer_model_cut" || computerModelFailure(502, []byte("not json"), false) != "computer_model_failed" {
		t.Fatal("a cut call or an unreadable answer is classed wrongly")
	}
	// A call is cut by its own limit, its caller or a cancel, but lost with a worker that stopped under it.
	for reason, want := range map[string]string{"timeout": "computer_model_cut", "disconnected": "computer_model_cut", "cancelled": "computer_model_cut", "stopping": "computer_model_transport"} {
		for _, personal := range []bool{false, true} {
			if got := computerModelFailure(499, []byte(`{"error":{"code":"CANCELLED","reason":"`+reason+`"}}`), personal); got != want {
				t.Fatalf("a call cancelled for %q reads %q, want %q", reason, got, want)
			}
		}
	}
	if computerArtifactName("report.md") != "report.md" {
		t.Fatal("a short name must stay as it is")
	}
	if odd := computerArtifactName(strings.Repeat("a", 190) + "." + strings.Repeat("x", 40)); len(odd) != 200 {
		t.Fatalf("a name with an overlong extension became %d bytes", len(odd))
	}
}

// The owner, 2026-10-17: with the platform's own credentials, a direct task whose LLM Gate call an edge's time limit cut
// (a 524: a call that is not streamed answers nothing until its last token), or whose Gate call failed with a server
// error however long it had run, failed for the platform's sake and gives its calls back. So does one whose streamed Gate
// call's stream closed after a silence as long as the edge's idle limit (the same edge's cut of a streamed call), or
// whose Gate stream's error frame named the provider's capacity (as its status would have, sent whole); one closed at
// once or stopped by moderation gives nothing back, nor does a call the task's own side gave up on, whatever its worker
// would have said.
func TestPostgresDirectTaskGateTimeoutsAndLateErrorsAreRefunded(t *testing.T) {
	// The "gone" call has reached its model worker: its task's side gives up on it from then on, not on a timer.
	received := make(chan struct{}, 1)
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{
				{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}}})
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
		reason := "provider:524"
		if len(b.Completion.Messages) > 0 {
			switch b.Completion.Messages[0].Content {
			case "answer":
				reason = "answer" // the model's own answer did not hold: the call counts, and is never the platform's
			case "late":
				time.Sleep(1500 * time.Millisecond) // a server error after the call has run a while
				reason = "provider:503"
			case "idle", "closed":
				time.Sleep(300 * time.Millisecond) // part of the answer streamed, then the stream closed on its way
				reason = map[string]string{"idle": "stream:closed:idle", "closed": "stream:closed"}[b.Completion.Messages[0].Content]
			case "overloaded", "moderated":
				// Part of the answer streamed, then the Gate's error frame: the upstream overloaded, or a moderation stop.
				time.Sleep(300 * time.Millisecond)
				reason = map[string]string{"overloaded": "provider:200:overloaded_error", "moderated": "provider:200:DataInspectionFailed"}[b.Completion.Messages[0].Content]
			case "gone":
				// The stream is still coming when the task's own side gives up on the call; what the worker says afterwards
				// reaches nobody.
				select {
				case received <- struct{}{}:
				default:
				}
				time.Sleep(1500 * time.Millisecond)
				reason = "stream:closed:idle"
			}
		}
		writeJSON(w, 502, map[string]any{"error": map[string]string{"code": "PROVIDER_ERROR", "message": "x", "reason": reason}})
	}))
	defer pi.Close()
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
		scenario := strings.Fields(input.Prompt)[0]
		if scenario == "gone" {
			// The task's own side gives up on the call (as the core's idle limit does) once it is running: its caller is gone.
			raw, _ := json.Marshal(map[string]any{"messages": []map[string]string{{"role": "user", "content": scenario}}})
			ctx, cancel := context.WithCancel(context.Background())
			req, _ := http.NewRequestWithContext(ctx, "POST", input.ModelProxyURL+"/chat/completions", bytes.NewReader(raw))
			req.Header.Set("Authorization", "Bearer "+input.ModelProxyToken)
			req.Header.Set("Content-Type", "application/json")
			done := make(chan struct{})
			go func() {
				if resp, e := http.DefaultClient.Do(req); e == nil {
					resp.Body.Close()
				}
				close(done)
			}()
			select {
			case <-received:
			case <-time.After(10 * time.Second):
				t.Error("the gone call never reached its model worker")
			}
			cancel()
			<-done
		} else {
			// One call per part, in order: a call whose own answer failed, then the one the scenario is about.
			parts := map[string][]string{"answeredge": {"answer", "edge"}, "answerlate": {"answer", "late"}}[scenario]
			if parts == nil {
				parts = []string{scenario}
			}
			for _, part := range parts {
				computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": part}}}, 502)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n")
	}))
	defer worker.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "gate-refund@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	runs := map[string]string{}
	// The owner, 2026-10-18: a time limit on the way (the edge's 524, its idle cut) gives back only the call it cut, so a
	// task with another call gets one back; a server error after a while gives back the task's every call.
	for _, c := range []struct {
		scenario, scope string
		calls, refunds  float64
	}{{"edge", "cut", 1, 1}, {"late", "task", 1, 1}, {"idle", "cut", 1, 1}, {"closed", "", 1, 0}, {"gone", "", 1, 0},
		{"overloaded", "task", 1, 1}, {"moderated", "", 1, 0}, {"answeredge", "cut", 2, 1}, {"answerlate", "task", 2, 2}} {
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": "gate-refund-" + c.scenario, "prompt": c.scenario + " task", "runtime": "pi", "model": "test-model"}, 202)
		id := run["id"].(string)
		runs[c.scenario] = id
		h.awaitRun(t, owner, tid, id, "failed")
		d := h.request(t, owner, "GET", base+"/computer-runs/"+id, nil, 200)
		if d["error"] != "computer_execution_failed" || d["calls"] != c.calls || d["refundedCalls"] != c.refunds {
			t.Fatalf("%s: the task reads %v with %v calls, refunded %v; want computer_execution_failed, %v, %v", c.scenario, d["error"], d["calls"], d["refundedCalls"], c.calls, c.refunds)
		}
		if (c.refunds > 0 && d["refundScope"] != c.scope) || (c.refunds == 0 && d["refundScope"] != nil) {
			t.Fatalf("%s: the refund reads %v, want %q", c.scenario, d["refundScope"], c.scope)
		}
	}
	// The ledger: a cut on the way is a timeout, noted with its call; a server error is the provider's, noted nowhere.
	for scenario, want := range map[string]string{"answeredge": "protocol,timeout|1", "answerlate": "protocol,provider|0", "idle": "timeout|1", "gone": "timeout|0"} {
		var classes string
		var noted int
		if e := h.db.QueryRow(context.Background(), `SELECT string_agg(failure_class, ',' ORDER BY created_at, id),
			(SELECT count(*) FROM refunded_calls rc JOIN model_invocations c ON c.tenant_id=rc.tenant_id AND c.id=rc.invocation_id WHERE c.tenant_id=$1 AND c.run_id=$2)
			FROM model_invocations WHERE tenant_id=$1 AND run_id=$2`, tid, runs[scenario]).Scan(&classes, &noted); e != nil {
			t.Fatal(e)
		}
		if got := fmt.Sprintf("%s|%d", classes, noted); got != want {
			t.Fatalf("%s: the ledger reads %s, want %s", scenario, got, want)
		}
	}
	// The day's total gives back what the tasks read: 1+1+1+1+1+2 of the 11 calls.
	if _, used := allowanceOf(t, h.request(t, owner, "GET", base+"/route-usage", nil, 200), "daily"); used != 11-7 {
		t.Fatalf("the meter shows %d calls today, want %d", used, 11-7)
	}
}

// 039 can run again unchanged on a database that already holds refunded calls; it takes no other reason, and a deleted
// workspace takes its notes along.
func TestPostgresRefundedCallsMigrationRunsAgain(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	_, tid, _ := h.register(t, "refund-migration@awwo.invalid")
	execSQL(t, h, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,'call-1','timeout')", tid)
	sql, _ := migrations.ReadFile("migrations/039_refunded_calls.sql")
	for run := 0; run < 2; run++ {
		tx, e := h.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, string(sql)); e != nil {
			tx.Rollback(ctx)
			t.Fatal("039 run again, run", run+1, e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	}
	var rows int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM refunded_calls WHERE tenant_id=$1 AND invocation_id='call-1' AND reason='timeout'", tid).Scan(&rows); e != nil || rows != 1 {
		t.Fatal("the noted call did not keep its row", rows, e)
	}
	if _, e := h.db.Exec(ctx, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,'call-2','provider')", tid); e == nil {
		t.Fatal("a reason other than a timeout was taken")
	}
	var onDelete string
	if e := h.db.QueryRow(ctx, "SELECT confdeltype::text FROM pg_constraint WHERE conrelid='refunded_calls'::regclass AND contype='f'").Scan(&onDelete); e != nil || onDelete != "c" {
		t.Fatal("refunded_calls must go with its workspace", onDelete, e)
	}
}

// A call whose worker never answered in full (security review 2026-10-19): cut on its way when this API's HTTP client's
// own time limit ended it, whether no answer came or an answer stalled; cut, never the platform's, when the call's own
// context ended; the platform's transport when the worker could not be reached or its answer broke off.
func TestComputerCallBrokeReadsTheClientsOwnTimeLimit(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stall" {
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
		}
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer slow.Close()
	client := &http.Client{Timeout: 200 * time.Millisecond}
	_, silent := client.Get(slow.URL + "/silent")
	if got := computerCallBroke(silent, false); got != "computer_model_timeout" {
		t.Fatalf("no answer within the client's limit reads %q (%v)", got, silent)
	}
	response, e := client.Get(slow.URL + "/stall")
	if e != nil {
		t.Fatal(e)
	}
	_, stalled := io.ReadAll(response.Body)
	response.Body.Close()
	if got := computerCallBroke(stalled, false); got != "computer_model_timeout" {
		t.Fatalf("an answer stalled past the client's limit reads %q (%v)", got, stalled)
	}
	if got := computerCallBroke(stalled, true); got != "computer_model_cut" {
		t.Fatalf("a call whose own context ended reads %q", got)
	}
	_, refused := (&http.Client{Timeout: time.Second}).Get("http://127.0.0.1:1/")
	if got := computerCallBroke(refused, false); got != "computer_model_transport" {
		t.Fatalf("an unreachable worker reads %q (%v)", got, refused)
	}
	if got := computerCallBroke(io.ErrUnexpectedEOF, false); got != "computer_model_transport" {
		t.Fatalf("an answer that broke off reads %q", got)
	}
}
