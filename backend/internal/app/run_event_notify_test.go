package app

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func runEventCursor(t *testing.T, h *harness, tenantID, runID string) int64 {
	t.Helper()
	var cursor int64
	if err := h.db.QueryRow(context.Background(), "SELECT COALESCE(max(id),0) FROM run_events WHERE tenant_id=$1 AND run_id=$2", tenantID, runID).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	return cursor
}

func openRunEventStream(t *testing.T, h *harness, cookie *http.Cookie, tenantID, runID string, cursor int64) (<-chan string, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", h.server.URL+"/api/v1/tenants/"+tenantID+"/runs/"+runID+"/events?after="+fmt.Sprint(cursor), nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		t.Fatalf("events status %d", resp.StatusCode)
	}
	data := make(chan string, 16)
	t.Cleanup(func() {
		cancel()
		resp.Body.Close()
	})
	go func() {
		defer close(data)
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			if line := scanner.Text(); strings.HasPrefix(line, "data: ") {
				select {
				case data <- line:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return data, cancel
}

func awaitRunEventType(t *testing.T, data <-chan string, eventType string) string {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case line, ok := <-data:
			if !ok {
				t.Fatalf("event stream closed before %s", eventType)
			}
			if strings.Contains(line, `"type": "`+eventType+`"`) || strings.Contains(line, `"type":"`+eventType+`"`) {
				return line
			}
		case <-timer.C:
			t.Fatalf("event stream did not publish %s without the heartbeat fallback", eventType)
		}
	}
}

func awaitNotifierWake(t *testing.T, wake <-chan struct{}) {
	t.Helper()
	select {
	case <-wake:
	case <-time.After(time.Second):
		t.Fatal("committed writer did not notify its run subscribers")
	}
}

func TestRunEventNotifierWakesEverySubscriberAndCoalesces(t *testing.T) {
	a := New(nil, testConfig())
	first, unsubscribeFirst := a.subscribeRunEvents("run-1")
	second, unsubscribeSecond := a.subscribeRunEvents("run-1")
	other, unsubscribeOther := a.subscribeRunEvents("run-2")
	defer unsubscribeFirst()
	defer unsubscribeSecond()
	defer unsubscribeOther()

	a.notifyRunEvent("run-1")
	a.notifyRunEvent("run-1")
	for name, subscriber := range map[string]<-chan struct{}{"first": first, "second": second} {
		select {
		case <-subscriber:
		case <-time.After(time.Second):
			t.Fatalf("%s subscriber was not notified", name)
		}
		select {
		case <-subscriber:
			t.Fatalf("%s subscriber received an uncoalesced duplicate", name)
		default:
		}
	}
	select {
	case <-other:
		t.Fatal("notification leaked to another run")
	default:
	}
}

func TestRunEventNotifierUnsubscribeIsIdempotent(t *testing.T) {
	a := New(nil, testConfig())
	wake, unsubscribe := a.subscribeRunEvents("run-1")
	unsubscribe()
	unsubscribe()
	a.notifyRunEvent("run-1")

	select {
	case <-wake:
		t.Fatal("unsubscribed listener was notified")
	default:
	}
	a.runEvents.Lock()
	defer a.runEvents.Unlock()
	if len(a.runEvents.subscribers) != 0 {
		t.Fatalf("subscriber registry leaked: %#v", a.runEvents.subscribers)
	}
}

func TestRunEventsWakeAfterCommittedDelta(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var enteredOnce sync.Once
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, http.StatusOK, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		enteredOnce.Do(func() { close(entered) })
		<-release
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"text_delta\",\"delta\":\"fast\"}\n\ndata: {\"type\":\"completed\",\"text\":\"fast\"}\n\n")
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	h.a.reauthEvery = time.Hour
	cookie, tenantID, _ := h.register(t, "event-wake@example.test")
	_, _, sessionID := h.fixture(t, cookie, tenantID)
	prefix := "/tenants/" + tenantID
	run := h.request(t, cookie, "POST", prefix+"/runs", map[string]string{
		"sessionId":   sessionID,
		"prompt":      "wait for release",
		"operationId": "event-wake-operation",
	}, http.StatusAccepted)
	runID := run["id"].(string)

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("worker request did not start")
	}
	data, cancelStream := openRunEventStream(t, h, cookie, tenantID, runID, runEventCursor(t, h, tenantID, runID))
	defer cancelStream()
	wake, unsubscribe := h.a.subscribeRunEvents(runID)
	defer unsubscribe()
	started := time.Now()
	close(release)
	awaitNotifierWake(t, wake)
	line := awaitRunEventType(t, data, "text_delta")
	if !strings.Contains(line, `fast`) {
		t.Fatalf("unexpected delta event: %s", line)
	}
	elapsed := time.Since(started)
	t.Logf("committed delta reached SSE in %s", elapsed)
	if elapsed > time.Second {
		t.Fatalf("committed event notification took %s", elapsed)
	}
	completed := h.awaitRun(t, cookie, tenantID, runID, "completed")
	if completed["output"] != "fast" {
		t.Fatalf("unexpected persisted output: %#v", completed)
	}
	var before int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM run_events WHERE tenant_id=$1 AND run_id=$2", tenantID, runID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if h.a.appendDelta(context.Background(), tenantID, runID, "late") {
		t.Fatal("terminal run accepted a late delta")
	}
	var after int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM run_events WHERE tenant_id=$1 AND run_id=$2", tenantID, runID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("failed atomic append created an event: before=%d after=%d", before, after)
	}
}

func TestRunEventsWakeForTerminalAndCancellationWriters(t *testing.T) {
	t.Run("terminal without delta", func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		t.Cleanup(func() {
			select {
			case <-release:
			default:
				close(release)
			}
		})
		var once sync.Once
		worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/health" {
				writeJSON(w, http.StatusOK, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
				return
			}
			once.Do(func() { close(entered) })
			<-release
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"type\":\"completed\",\"text\":\"terminal-only\"}\n\n")
		}))
		defer worker.Close()
		h := newHarness(t, worker.URL)
		h.a.reauthEvery = time.Hour
		cookie, tenantID, _ := h.register(t, "event-terminal@example.test")
		_, _, sessionID := h.fixture(t, cookie, tenantID)
		runID := h.request(t, cookie, "POST", "/tenants/"+tenantID+"/runs", map[string]string{"sessionId": sessionID, "prompt": "terminal", "operationId": "event-terminal-operation"}, http.StatusAccepted)["id"].(string)
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("worker request did not start")
		}
		data, cancel := openRunEventStream(t, h, cookie, tenantID, runID, runEventCursor(t, h, tenantID, runID))
		defer cancel()
		wake, unsubscribe := h.a.subscribeRunEvents(runID)
		defer unsubscribe()
		close(release)
		awaitNotifierWake(t, wake)
		awaitRunEventType(t, data, "completed")
	})

	for _, mode := range []string{"run_cancel", "tenant_suspend"} {
		t.Run(mode, func(t *testing.T) {
			entered := make(chan struct{})
			var once sync.Once
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/health" {
					writeJSON(w, http.StatusOK, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
					return
				}
				if r.Method == http.MethodDelete {
					w.WriteHeader(http.StatusAccepted)
					return
				}
				once.Do(func() { close(entered) })
				w.Header().Set("Content-Type", "text/event-stream")
				http.NewResponseController(w).Flush()
				<-r.Context().Done()
			}))
			defer worker.Close()
			h := newHarness(t, worker.URL)
			h.a.reauthEvery = time.Hour
			cookie, tenantID, _ := h.register(t, "event-"+mode+"@example.test")
			_, _, sessionID := h.fixture(t, cookie, tenantID)
			runID := h.request(t, cookie, "POST", "/tenants/"+tenantID+"/runs", map[string]string{"sessionId": sessionID, "prompt": "wait", "operationId": "event-" + mode + "-operation"}, http.StatusAccepted)["id"].(string)
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Fatal("worker request did not start")
			}
			data, cancel := openRunEventStream(t, h, cookie, tenantID, runID, runEventCursor(t, h, tenantID, runID))
			defer cancel()
			wake, unsubscribe := h.a.subscribeRunEvents(runID)
			defer unsubscribe()
			if mode == "run_cancel" {
				h.request(t, cookie, "POST", "/tenants/"+tenantID+"/runs/"+runID+"/cancel", nil, http.StatusOK)
			} else {
				admin := bootstrapTestAdmin(t, h)
				h.request(t, admin, "PATCH", "/admin/tenants/"+tenantID, map[string]string{"status": "suspended"}, http.StatusOK)
			}
			awaitNotifierWake(t, wake)
			awaitRunEventType(t, data, "cancelled")
		})
	}

	for _, operation := range []bool{false, true} {
		name := "graph_run_cancel"
		if operation {
			name = "graph_operation_cancel"
		}
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, "http://127.0.0.1:1")
			h.a.reauthEvery = time.Hour
			cookie, tenantID, actorID := h.register(t, name+"@example.test")
			canvasID, document := graphFixture(t, h, cookie, tenantID)
			graphID, runIDs := seedUnprojectedGraph(t, h, tenantID, canvasID, actorID, document, map[string]string{"b": "running"})
			runID := runIDs["b"]
			data, cancel := openRunEventStream(t, h, cookie, tenantID, runID, 0)
			defer cancel()
			wake, unsubscribe := h.a.subscribeRunEvents(runID)
			defer unsubscribe()
			base := "/tenants/" + tenantID + "/canvases/" + canvasID + "/graph-runs"
			path := base + "/" + graphID + "/cancel"
			if operation {
				path = base + "/operations/" + graphID + "/cancel"
			}
			h.request(t, cookie, "POST", path, map[string]any{}, http.StatusOK)
			awaitNotifierWake(t, wake)
			awaitRunEventType(t, data, "cancelled")
		})
	}
}

func TestAppendDeltaFailureIsAtomic(t *testing.T) {
	h := newHarness(t, "")
	cookie, tenantID, _ := h.register(t, "event-atomic@example.test")
	_, _, sessionID := h.fixture(t, cookie, tenantID)
	runID := randomID()
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output) VALUES($1,$2,$3,$1,'hash','test','running','before')", runID, tenantID, sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, `CREATE FUNCTION reject_delta_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='`+runID+`' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, "CREATE TRIGGER reject_delta_event BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_delta_event()"); err != nil {
		t.Fatal(err)
	}
	if h.a.appendDelta(ctx, tenantID, runID, "-after") {
		t.Fatal("delta succeeded despite event insert failure")
	}
	var output string
	var events int
	if err := h.db.QueryRow(ctx, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tenantID, runID).Scan(&output); err != nil {
		t.Fatal(err)
	}
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM run_events WHERE tenant_id=$1 AND run_id=$2", tenantID, runID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if output != "before" || events != 0 {
		t.Fatalf("delta/event atomicity failed: output=%q events=%d", output, events)
	}
}

func TestAppendDeltaNeverCommitsAfterTerminalEvent(t *testing.T) {
	h := newHarness(t, "")
	cookie, tenantID, _ := h.register(t, "event-terminal-race@example.test")
	_, _, sessionID := h.fixture(t, cookie, tenantID)
	ctx := context.Background()
	for iteration := 0; iteration < 25; iteration++ {
		runID := randomID()
		if _, err := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$1,'hash','test','running')", runID, tenantID, sessionID); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		appendResult := make(chan bool, 1)
		finishResult := make(chan error, 1)
		go func() {
			<-start
			appendResult <- h.a.appendDelta(ctx, tenantID, runID, "delta")
		}()
		go func() {
			<-start
			finishResult <- h.a.finishOnce(ctx, tenantID, runID, "completed", "final", "")
		}()
		close(start)
		<-appendResult
		if err := <-finishResult; err != nil {
			t.Fatal(err)
		}
		rows, err := h.db.Query(ctx, "SELECT data->>'type' FROM run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY id", tenantID, runID)
		if err != nil {
			t.Fatal(err)
		}
		seenTerminal := false
		for rows.Next() {
			var eventType string
			if err = rows.Scan(&eventType); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			if eventType == "text_delta" && seenTerminal {
				rows.Close()
				t.Fatalf("iteration %d committed delta after terminal event", iteration)
			}
			if eventType == "completed" {
				seenTerminal = true
			}
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		if !seenTerminal {
			t.Fatalf("iteration %d did not commit terminal event", iteration)
		}
	}
}

func TestTeamDeltaPersistsEachFragmentBeforeTerminal(t *testing.T) {
	firstWritten := make(chan struct{})
	release := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	var once sync.Once
	worker := teamProvider(t, func(w http.ResponseWriter, r *http.Request, _ observedPiCall) {
		fmt.Fprint(w, "data: {\"type\":\"text_delta\",\"delta\":\"first-\"}\n\n")
		http.NewResponseController(w).Flush()
		once.Do(func() { close(firstWritten) })
		<-release
		fmt.Fprint(w, "data: {\"type\":\"text_delta\",\"delta\":\"second\"}\n\ndata: {\"type\":\"completed\",\"text\":\"first-second\"}\n\n")
	})
	defer worker.Close()
	h := newHarness(t, worker.URL)
	cookie, tenantID, _ := h.register(t, "team-fragments@example.test")
	team := fixtureTeam("sequential")
	_, _, sessionID := installTeam(t, h, cookie, tenantID, team)
	runID := h.request(t, cookie, "POST", "/tenants/"+tenantID+"/runs", map[string]string{"sessionId": sessionID, "prompt": "fragments", "operationId": "team-fragments-operation"}, http.StatusAccepted)["id"].(string)
	select {
	case <-firstWritten:
	case <-time.After(2 * time.Second):
		t.Fatal("team worker did not write first fragment")
	}
	deadline := time.Now().Add(time.Second)
	for {
		var output string
		err := h.db.QueryRow(context.Background(), "SELECT output FROM run_turns WHERE tenant_id=$1 AND run_id=$2", tenantID, runID).Scan(&output)
		if err == nil && output == "first-" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("first fragment was not persisted while turn was running: output=%q err=%v", output, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(release)
	completed := h.awaitRun(t, cookie, tenantID, runID, "completed")
	if completed["output"] != "first-second" {
		raw, _ := json.Marshal(completed)
		t.Fatalf("unexpected final team output: %s", raw)
	}
}
