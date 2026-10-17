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
		// model's own time limit after its stream began are the platform's timeouts (the owner, 2026-10-17).
		"provider:524": "computer_model_provider", "provider:504:gateway_timeout": "computer_model_provider",
		"network:UND_ERR_HEADERS_TIMEOUT": "computer_model_provider", "network:UND_ERR_BODY_TIMEOUT": "computer_model_provider",
		"stream:error:408:ModelTimeoutException": "computer_model_provider", "provider:408": "computer_model_provider",
		// A Bedrock stream: an AWS outage after it began is the provider's; a model whose output broke it, the bridge's refusal
		// of what the model sent and a stream that ended early are the answer's.
		// A streamed Gate call whose stream closed after a silence as long as the edge's idle limit is the same edge's cut as
		// a 524 (the refund session's reading of the owner's rule, 2026-10-17); a close at once, which a task's own words can
		// bring about (a moderation stop), is not.
		"stream:closed:idle": "computer_model_provider", "stream:closed": "computer_model_answer", "stream:closed:idle:x": "computer_model_answer",
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
			computerProxyRequest(t, input, map[string]any{"messages": []map[string]string{{"role": "user", "content": scenario}}}, 502)
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
	for _, c := range []struct {
		scenario string
		refunds  float64
	}{{"edge", 1}, {"late", 1}, {"idle", 1}, {"closed", 0}, {"gone", 0}, {"overloaded", 1}, {"moderated", 0}} {
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": "gate-refund-" + c.scenario, "prompt": c.scenario + " task", "runtime": "pi", "model": "test-model"}, 202)
		id := run["id"].(string)
		h.awaitRun(t, owner, tid, id, "failed")
		if d := h.request(t, owner, "GET", base+"/computer-runs/"+id, nil, 200); d["error"] != "computer_execution_failed" || d["calls"] != float64(1) || d["refundedCalls"] != c.refunds {
			t.Fatalf("%s: the task reads %v with %v calls, refunded %v; want computer_execution_failed, 1, %v", c.scenario, d["error"], d["calls"], d["refundedCalls"], c.refunds)
		}
	}
}
