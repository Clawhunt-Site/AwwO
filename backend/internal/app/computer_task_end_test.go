package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// heldCall makes a task's one model call through the API's proxy and never gives it up, as a broker whose task ends while
// its call runs on; it reports the status the proxy answered with (0: none).
func heldCall(input computerWorkerInput, answered chan<- int) {
	raw, _ := json.Marshal(map[string]any{"messages": []map[string]string{{"role": "user", "content": "think it through"}}})
	req, _ := http.NewRequest("POST", input.ModelProxyURL+"/chat/completions", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+input.ModelProxyToken)
	req.Header.Set("Content-Type", "application/json")
	status := 0
	if resp, e := http.DefaultClient.Do(req); e == nil {
		status = resp.StatusCode
		resp.Body.Close()
	}
	answered <- status
}

// heldLog holds the app's log line msg until release gives a token (or is closed), once it says so on held. A model
// call's handler logs its failure just before it settles the call (computerModelProxy), so this holds that settling.
type heldLog struct {
	slog.Handler
	msg           string
	held, release chan struct{}
}

func (h *heldLog) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == h.msg {
		h.held <- struct{}{}
		<-h.release
	}
	return h.Handler.Handle(ctx, r)
}

// awaitValue is the next value of ch, or the test's failure after 10 s.
func awaitValue[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for " + what)
	}
	var zero T
	return zero
}

// callLedger reads a run's one model call: status|failure_class|usage_reason|cost_status|times noted in refunded_calls.
func callLedger(t *testing.T, h *harness, tid, rid string) string {
	t.Helper()
	var status, class, reason, cost string
	var noted int
	if e := h.db.QueryRow(context.Background(), `SELECT c.status,COALESCE(c.failure_class,''),c.usage_reason,c.cost_status,
		(SELECT count(*) FROM refunded_calls rc WHERE rc.tenant_id=c.tenant_id AND rc.invocation_id=c.id)
		FROM model_invocations c WHERE c.tenant_id=$1 AND c.run_id=$2`, tid, rid).Scan(&status, &class, &reason, &cost, &noted); e != nil {
		t.Fatal(e)
	}
	return fmt.Sprintf("%s|%s|%s|%s|%d", status, class, reason, cost, noted)
}

// taskEndBegun says whether a run's ending has begun: its transaction holds the run's row (finishOnce), or it ended. The
// probe's lock conflicts with that UPDATE's, not with the key-share locks a child row's insert takes.
func taskEndBegun(t *testing.T, h *harness, tid, rid string) bool {
	t.Helper()
	ctx := context.Background()
	tx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	var status string
	e = tx.QueryRow(ctx, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE NOWAIT", tid, rid).Scan(&status)
	var locked *pgconn.PgError
	if errors.As(e, &locked) && locked.Code == "55P03" {
		return true
	}
	if e != nil {
		t.Fatal(e)
	}
	return status != "running"
}

// cutCallPi is a model worker whose calls run until something cuts them, or until stop; it says which run each call came
// from.
func cutCallPi(received chan<- string, stop <-chan struct{}) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			computerPiHealth(w)
			return
		}
		var b struct {
			RunID string `json:"runId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		received <- b.RunID
		select {
		case <-r.Context().Done():
		case <-stop:
		}
	}))
}

// endsWithin fails the test unless a task that waited for its call's handler ends soon after that handler was let go:
// its ending waits for the handler, never for its bound (computerCallSettleWait, which a drain that waited it out would
// reach about as long after the hold began; the margin leaves room for a stalled machine).
func endsWithin(t *testing.T, what string, since time.Time) {
	t.Helper()
	if took := time.Since(since); took > computerCallSettleWait-2*time.Second {
		t.Fatalf("%s ended %v after its call's handler was let go: it waited out its bound", what, took.Round(time.Millisecond))
	}
}

// The owner, 2026-10-19: however a direct task ends, the model call it still has running is cut and settled by its own
// handler first, with what that handler knows of the call (computerLease.drain), never as a call its run left open. Here
// the broker reports its task failed, completed or cancelled (its restart), loses its stream or sends an event the API
// refuses while its call runs on, never given up; the call's ledger row is held, so its settling waits, and the task must
// not begin to end meanwhile, then end at once.
func TestPostgresADirectTaskEndsOnlyOnceItsCutCallIsSettled(t *testing.T) {
	ctx := context.Background()
	stop := make(chan struct{})
	received := make(chan string, 1)
	pi := cutCallPi(received, stop)
	defer pi.Close()
	proceed, answered := make(chan struct{}, 1), make(chan int, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			computerWorkerHealth(w)
			return
		case r.Method == "DELETE":
			w.WriteHeader(200)
			return
		}
		var input computerWorkerInput
		_ = json.NewDecoder(r.Body).Decode(&input)
		go heldCall(input, answered)
		select {
		case <-proceed:
		case <-stop:
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		// "dropped": the stream ends with no last event.
		fmt.Fprint(w, map[string]string{"failed": "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n",
			"completed": "data: {\"type\":\"completed\",\"output\":\"done\"}\n\n", "cancelled": "data: {\"type\":\"cancelled\"}\n\n",
			"invalid": "data: {not json}\n\n"}[strings.Fields(input.Prompt)[0]])
	}))
	defer worker.Close()
	defer close(stop) // first, so the fake servers' handlers return
	h := computerHarness(t, pi.URL, worker.URL)
	owner, tid, _ := h.register(t, "task-end-cut@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	for _, c := range []struct {
		scenario, status, code string
		refunds                float64
	}{{"failed", "failed", "computer_execution_failed", 0}, {"completed", "completed", "", 0},
		{"cancelled", "interrupted", "execution service restarted before completion", 1},
		{"dropped", "failed", "computer_stream_ended", 1}, {"invalid", "failed", "invalid_computer_event", 0}} {
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": "task-end-" + c.scenario, "prompt": c.scenario + " task", "runtime": "pi", "model": "test-model"}, 202)
		id := run["id"].(string)
		if got := awaitValue(t, received, c.scenario+"'s call"); got != id {
			t.Fatalf("%s: a call of run %s reached the model worker, want %s", c.scenario, got, id)
		}
		// The call's ledger row is held while the broker ends the task, and let go once the task is seen waiting.
		begun := func() bool {
			lock, e := h.db.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer lock.Rollback(ctx)
			var one int
			if e = lock.QueryRow(ctx, "SELECT 1 FROM model_invocations WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE", tid, id).Scan(&one); e != nil {
				t.Fatal(e)
			}
			proceed <- struct{}{}
			time.Sleep(300 * time.Millisecond)
			return taskEndBegun(t, h, tid, id)
		}()
		let := time.Now()
		if begun {
			t.Fatalf("%s: the task began to end before the handler of the call it cut had settled it", c.scenario)
		}
		h.awaitRun(t, owner, tid, id, c.status)
		endsWithin(t, c.scenario, let)
		// Cut by its task's ending: a timeout, its usage unknown, never noted as a cut on the way.
		if got := callLedger(t, h, tid, id); got != "failed|timeout|transport_unknown|unknown|0" {
			t.Fatalf("%s: the ledger reads %s, want the handler's cut", c.scenario, got)
		}
		d := h.request(t, owner, "GET", base+"/computer-runs/"+id, nil, 200)
		if d["error"] != c.code || d["calls"] != float64(1) || d["refundedCalls"] != c.refunds {
			t.Fatalf("%s: the task reads %v with %v calls, refunded %v; want %q, 1, %v", c.scenario, d["error"], d["calls"], d["refundedCalls"], c.code, c.refunds)
		}
		if status := awaitValue(t, answered, c.scenario+"'s answer"); status != 502 {
			t.Fatalf("%s: the broker's call was answered %d", c.scenario, status)
		}
	}
}

// The owner, 2026-10-19, for a stop too: the user's stop and an API shutting down cut the call a task still has running,
// and the task ends only once that call's handler has settled it as the cut it is, never as a call its run left open
// (cancelled or interrupted, class restart: its reserve), then at once. The handler is held as it is about to settle it.
func TestPostgresAStoppedDirectTaskEndsOnlyOnceItsCutCallIsSettled(t *testing.T) {
	ctx := context.Background()
	stop := make(chan struct{})
	received := make(chan string, 1)
	pi := cutCallPi(received, stop)
	defer pi.Close()
	answered, tokens := make(chan int, 1), make(chan string, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			computerWorkerHealth(w)
			return
		case r.Method == "DELETE":
			w.WriteHeader(200)
			return
		}
		var input computerWorkerInput
		_ = json.NewDecoder(r.Body).Decode(&input)
		tokens <- input.ModelProxyToken
		go heldCall(input, answered)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-stop:
		}
	}))
	defer worker.Close()
	defer close(stop) // first, so the fake servers' handlers return
	held := &heldLog{Handler: slog.NewJSONHandler(io.Discard, nil), msg: "managed model call failed", held: make(chan struct{}, 2), release: make(chan struct{}, 2)}
	h := newHarness(t, pi.URL, func(a *App) { a.log = slog.New(held) })
	var closed chan struct{} // the shutdown below, which the harness's own Close must not overlap
	t.Cleanup(func() {
		close(held.release)
		if closed != nil {
			select {
			case <-closed:
			case <-time.After(15 * time.Second):
			}
		}
	})
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "task-end-stop@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	start := func(operation string) (string, string) {
		t.Helper()
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": operation, "prompt": "live task", "runtime": "pi", "model": "test-model"}, 202)
		id := run["id"].(string)
		token := awaitValue(t, tokens, operation+"'s start")
		if got := awaitValue(t, received, operation+"'s call"); got != id {
			t.Fatalf("a call of run %s reached the model worker, want %s", got, id)
		}
		return id, token
	}
	// settled lets the run's call be settled, once the run's ending has waited for it, and says when it let it go.
	settled := func(id string) (string, time.Time) {
		t.Helper()
		awaitValue(t, held.held, "the cut call's handler")
		time.Sleep(300 * time.Millisecond)
		if got := callLedger(t, h, tid, id); !strings.HasPrefix(got, "running|") {
			t.Fatalf("the task's ending settled the call it cut before its handler did: %s", got)
		}
		held.release <- struct{}{}
		let := time.Now()
		for deadline := let.Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
			if got := callLedger(t, h, tid, id); !strings.HasPrefix(got, "running|") || time.Now().After(deadline) {
				return got, let
			}
		}
	}

	stopped, token := start("task-end-stop")
	h.request(t, owner, "POST", base+"/runs/"+stopped+"/cancel", nil, 200)
	got, let := settled(stopped)
	if got != "failed|timeout|transport_unknown|unknown|0" {
		t.Fatalf("the call the user's stop cut reads %s, want its handler's cut", got)
	}
	// The stopped task's ending is over once its lease is gone (executeComputer's last step).
	for _, live := h.a.computerLeases.Load(tokenHash(token)); live; _, live = h.a.computerLeases.Load(tokenHash(token)) {
		if time.Since(let) > 5*time.Second {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	endsWithin(t, "the stopped task", let)
	if status := awaitValue(t, answered, "the stopped call's answer"); status != 502 {
		t.Fatalf("the stopped task's call was answered %d", status)
	}

	// An API shutting down under a live task: its ending, interrupted, waits for the call's handler too.
	running, _ := start("task-end-shutdown")
	closed = make(chan struct{})
	go func(done chan struct{}) { h.a.Close(); close(done) }(closed)
	got, let = settled(running)
	awaitValue(t, closed, "the API's shutdown")
	endsWithin(t, "the shut-down task", let)
	if got != "failed|timeout|transport_unknown|unknown|0" {
		t.Fatalf("the call the shutdown cut reads %s, want its handler's cut", got)
	}
	var status, reason string
	if e := h.db.QueryRow(ctx, "SELECT r.status,COALESCE((SELECT reason FROM refunded_runs WHERE tenant_id=r.tenant_id AND run_id=r.id),'') FROM runs r WHERE r.tenant_id=$1 AND r.id=$2", tid, running).Scan(&status, &reason); e != nil || status != "interrupted" || reason != "interrupted" {
		t.Fatalf("the task the shutdown cut is %q with refund %q (%v)", status, reason, e)
	}
	if status := awaitValue(t, answered, "the shut-down call's answer"); status != 502 {
		t.Fatalf("the shut-down task's call was answered %d", status)
	}
}

// A handler that cannot settle its call in time (held here as it is about to) does not hold its task's ending past
// computerCallSettleWait: the run's end then settles the call as one its run left open, as after a crash (class restart,
// worker_lost: its reserve), never noted in refunded_calls nor evidence that gives the task's calls back, and the
// handler's own settling after it leaves that record as it is.
func TestPostgresADirectTasksEndingSettlesACallItsHandlerCouldNotSettleInTime(t *testing.T) {
	ctx := context.Background()
	saved := computerCallSettleWait
	t.Cleanup(func() { computerCallSettleWait = saved }) // after the harness is closed: registered before it
	computerCallSettleWait = 100 * time.Millisecond
	stop := make(chan struct{})
	received := make(chan string, 1)
	pi := cutCallPi(received, stop)
	defer pi.Close()
	proceed, answered := make(chan struct{}, 1), make(chan int, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			computerWorkerHealth(w)
			return
		case r.Method == "DELETE":
			w.WriteHeader(200)
			return
		}
		var input computerWorkerInput
		_ = json.NewDecoder(r.Body).Decode(&input)
		go heldCall(input, answered)
		select {
		case <-proceed:
		case <-stop:
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n")
	}))
	defer worker.Close()
	defer close(stop) // first, so the fake servers' handlers return
	held := &heldLog{Handler: slog.NewJSONHandler(io.Discard, nil), msg: "managed model call failed", held: make(chan struct{}, 1), release: make(chan struct{}, 1)}
	h := newHarness(t, pi.URL, func(a *App) { a.log = slog.New(held) })
	t.Cleanup(func() { close(held.release) })
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "task-end-late@example.test")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": "task-end-late", "prompt": "failed task", "runtime": "pi", "model": "test-model"}, 202)
	id := run["id"].(string)
	if got := awaitValue(t, received, "the task's call"); got != id {
		t.Fatalf("a call of run %s reached the model worker, want %s", got, id)
	}
	proceed <- struct{}{}
	awaitValue(t, held.held, "the cut call's handler")
	h.awaitRun(t, owner, tid, id, "failed")
	record := func() string {
		t.Helper()
		var xid string
		if e := h.db.QueryRow(ctx, "SELECT completed_xid::text FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, id).Scan(&xid); e != nil {
			t.Fatal(e)
		}
		return callLedger(t, h, tid, id) + " xid " + xid
	}
	before := record()
	if !strings.HasPrefix(before, "failed|restart|worker_lost|unknown|0 ") {
		t.Fatalf("the ending that could not wait settled the call as %s, want one its run left open", before)
	}
	d := h.request(t, owner, "GET", base+"/computer-runs/"+id, nil, 200)
	if d["error"] != "computer_execution_failed" || d["calls"] != float64(1) || d["refundedCalls"] != float64(0) || d["refundScope"] != nil {
		t.Fatalf("the task reads %v with %v calls, refunded %v as %v; a call left open is no evidence of the platform's failure", d["error"], d["calls"], d["refundedCalls"], d["refundScope"])
	}
	held.release <- struct{}{}
	if status := awaitValue(t, answered, "the call's answer"); status != 502 {
		t.Fatalf("the call was answered %d", status)
	}
	if after := record(); after != before {
		t.Fatalf("the handler's settling after the run's end changed the record: %s, was %s", after, before)
	}
}

// The lease's drain closes the lease before it cuts its calls (so no call starts between its look and the cut), cuts
// them once, then waits for the call in progress only, never past its bound.
func TestComputerLeaseDrainWaitsForTheCallInProgressOnly(t *testing.T) {
	var lease *computerLease
	cuts, closedAtCut := 0, []bool{}
	cut := func() { cuts++; closedAtCut = append(closedAtCut, lease.closed) }
	// drained runs the drain on its own goroutine, so a drain that never returns fails the test instead of hanging it.
	drained := func(wait time.Duration) {
		t.Helper()
		done := make(chan struct{})
		go func() { lease.drain(cut, wait); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("the drain did not return within 5 s")
		}
	}
	lease = &computerLease{}
	began := time.Now()
	drained(time.Minute)
	if took := time.Since(began); took > 2*time.Second || cuts != 1 || !lease.closed {
		t.Fatalf("with no call in progress the drain took %v, cut %d times, closed %v", took, cuts, lease.closed)
	}
	idle := make(chan struct{})
	lease = &computerLease{busy: true, idle: idle}
	began = time.Now()
	go func() { time.Sleep(100 * time.Millisecond); close(idle) }()
	drained(time.Minute)
	if took := time.Since(began); took < 100*time.Millisecond || cuts != 2 || !lease.closed {
		t.Fatalf("a call that ended after 100 ms held the drain %v (cut %d times, closed %v)", took, cuts, lease.closed)
	}
	lease = &computerLease{busy: true, idle: make(chan struct{})}
	began = time.Now()
	drained(150 * time.Millisecond)
	if took := time.Since(began); took < 150*time.Millisecond || cuts != 3 || !lease.closed {
		t.Fatalf("a call that never ended held the drain %v, not its 150 ms bound (cut %d times, closed %v)", took, cuts, lease.closed)
	}
	for i, closed := range closedAtCut {
		if !closed {
			t.Fatalf("cut %d came before the lease was closed: a call could start between the drain's look and the cut", i+1)
		}
	}
}

// The owner, 2026-10-19: what a cut paid-route call costs follows whoever settles it first, which is why a direct task's
// ending lets the call's own handler go first (computerLease.drain). Ten minutes without an answer, as the core's idle
// limit cuts a call, are hidden reasoning to its handler (plans.go creditCharge: 120 tokens a second, at most 65,536):
// 99 credits at $2 / $10 a million tokens; the run's end, settling it as a call its run left open, charges its reserve,
// 12. Whichever comes second leaves the record as it is, and neither notes the call in refunded_calls.
func TestPostgresACutCallCostsWhatItsFirstSettlingSays(t *testing.T) {
	h := planHarness(t)
	ctx := context.Background()
	c, tid, _ := h.register(t, "cut-call-charge@example.test")
	now := time.Now()
	givePlan(t, h, "cut-call-charge@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	call := func() (string, string) {
		t.Helper()
		rid, id := routeHarnessRun(t, h, c, tid, planRoutes), randomID()
		f := &invocationFacts{Runtime: runtimePI, Model: "claude-sonnet-5", Admission: "not_attempted", InputBytes: 4000}
		if e := h.a.reserveInvocation(ctx, tid, rid, id, "claude-sonnet-5", f); e != nil {
			t.Fatal(e)
		}
		if e := h.a.markInvocationAdmission(ctx, tid, id, f, "unknown"); e != nil {
			t.Fatal(e)
		}
		return rid, id
	}
	// What the proxy knows of a call it cut after ten minutes with no answer (computerModelProxy).
	cut := func(id string) {
		t.Helper()
		f := &invocationFacts{Runtime: runtimePI, Model: "claude-sonnet-5", Admission: "unknown", InputBytes: 4000, Streamed: time.Now().Add(-10 * time.Minute), Ended: time.Now()}
		if e := h.a.settleComputerCall(tid, id, "failed", "computer_model_cut", f); e != nil {
			t.Fatal(e)
		}
	}
	ledger := func(id string) string {
		t.Helper()
		var status, class, reason string
		var reserve, charge, noted int
		if e := h.db.QueryRow(ctx, `SELECT status,failure_class,usage_reason,COALESCE(credit_reserve,-1),COALESCE(credit_charge,-1),
			(SELECT count(*) FROM refunded_calls WHERE tenant_id=$1 AND invocation_id=$2) FROM model_invocations WHERE tenant_id=$1 AND id=$2`, tid, id).Scan(&status, &class, &reason, &reserve, &charge, &noted); e != nil {
			t.Fatal(e)
		}
		return fmt.Sprintf("%s|%s|%s|%d|%d|%d", status, class, reason, reserve, charge, noted)
	}
	// The handler first, then the run's end.
	rid, id := call()
	cut(id)
	h.a.finish(tid, rid, "failed", "", "computer_execution_failed")
	if got := ledger(id); got != "failed|timeout|transport_unknown|12|99|0" {
		t.Fatalf("a cut its handler settled first reads %s", got)
	}
	// The run's end first, then the handler.
	rid, id = call()
	h.a.finish(tid, rid, "failed", "", "computer_execution_failed")
	cut(id)
	if got := ledger(id); got != "failed|restart|worker_lost|12|12|0" {
		t.Fatalf("a cut the run's end settled first reads %s", got)
	}
}
