package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// A canvas create or save may carry up to 8 MiB; every other request keeps the general 2 MiB limit.
func TestCanvasSavesHaveTheirOwnBodyLimit(t *testing.T) {
	a := New(nil, testConfig())
	call := func(handler http.HandlerFunc, size int, version bool) (int, string) {
		// The document is a JSON string: a body within the limit decodes, then fails validation before any database access.
		body := `{"name":"Canvas","document":"` + strings.Repeat("x", size) + `"`
		if version {
			body += `,"version":1`
		}
		body += "}"
		r := httptest.NewRequest("PUT", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler(w, r)
		var reply struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &reply)
		return w.Code, reply.Error.Code
	}
	for name, save := range map[string]struct {
		handler http.HandlerFunc
		version bool
	}{"create": {a.createCanvas, false}, "update": {a.updateCanvas, true}} {
		if code, reason := call(save.handler, 3<<20, save.version); code != 400 || reason != "invalid_input" {
			t.Fatalf("%s: a 3 MiB canvas was refused: %d %s", name, code, reason)
		}
		if code, reason := call(save.handler, 8<<20, save.version); code != 413 || reason != "body_too_large" {
			t.Fatalf("%s: a canvas over 8 MiB was not refused as too large: %d %s", name, code, reason)
		}
	}
	general := func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name     string          `json:"name"`
			Document json.RawMessage `json:"document"`
			Version  int64           `json:"version"`
		}
		if a.decode(w, r, &b) {
			w.WriteHeader(204)
		}
	}
	if code, reason := call(general, 3<<20, true); code != 413 || reason != "body_too_large" {
		t.Fatalf("another request accepted 3 MiB: %d %s", code, reason)
	}
	if code, _ := call(general, 1<<20, true); code != 204 {
		t.Fatalf("another request refused 1 MiB: %d", code)
	}
}

// Canvas creates and saves take turns: at most maxCanvasSaves at once. One that waits past canvasSaveWait, or whose
// request ends first, is answered 503 canvas_save_busy (never an empty reply), and a slot comes back, once, as its
// save's reply starts.
func TestCanvasSavesTakeTurns(t *testing.T) {
	a := New(nil, testConfig())
	defer func(wait time.Duration) { canvasSaveWait = wait }(canvasSaveWait)
	canvasSaveWait = 200 * time.Millisecond
	request := httptest.NewRequest("PUT", "/", nil)
	writers, releases := []http.ResponseWriter{}, []func(){}
	for range maxCanvasSaves {
		w, release, ok := a.canvasSave(httptest.NewRecorder(), request)
		if !ok {
			t.Fatal("a free slot was refused")
		}
		writers, releases = append(writers, w), append(releases, release)
	}
	busy := func(r *http.Request) (*httptest.ResponseRecorder, time.Duration) {
		w := httptest.NewRecorder()
		started := time.Now()
		if _, _, ok := a.canvasSave(w, r); ok {
			t.Fatal("a save went ahead with every slot taken")
		}
		return w, time.Since(started)
	}
	if w, waited := busy(request); w.Code != 503 || w.Header().Get("Retry-After") != "2" ||
		!strings.Contains(w.Body.String(), `"canvas_save_busy"`) || waited < canvasSaveWait {
		t.Fatalf("a save past its wait answered %d %q after %v", w.Code, w.Body.String(), waited)
	}
	// Its request's deadline, or the client leaving, ends the wait with the same answer.
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if w, waited := busy(request.WithContext(ctx)); w.Code != 503 || !strings.Contains(w.Body.String(), `"canvas_save_busy"`) || waited >= canvasSaveWait {
		t.Fatalf("a save whose request ended answered %d %q after %v", w.Code, w.Body.String(), waited)
	}
	// The reply's start alone gives the slot back; its release afterwards gives back nothing more.
	writers[0].WriteHeader(200)
	w, release, ok := a.canvasSave(httptest.NewRecorder(), request)
	if !ok {
		t.Fatal("a slot did not come back as its save's reply started")
	}
	releases[0]()
	if _, waited := busy(request); waited < canvasSaveWait {
		t.Fatal("a slot came back twice")
	}
	_, _ = w.Write([]byte("{}"))
	release()
	for _, release := range releases[1:] {
		release()
	}
}

// Past maxCanvasSaveWaiters a save is answered busy at once, not after its wait: each waiting save holds its body.
func TestCanvasSaveWaitersAreCapped(t *testing.T) {
	a := New(nil, testConfig())
	defer func(wait time.Duration) { canvasSaveWait = wait }(canvasSaveWait)
	canvasSaveWait = 5 * time.Second
	releases := []func(){}
	for range maxCanvasSaves {
		_, release, _ := a.canvasSave(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", nil))
		releases = append(releases, release)
	}
	ctx, cancel := context.WithCancel(context.Background())
	var waiting sync.WaitGroup
	for range maxCanvasSaveWaiters {
		waiting.Add(1)
		go func() {
			defer waiting.Done()
			a.canvasSave(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", nil).WithContext(ctx))
		}()
	}
	for deadline := time.Now().Add(2 * time.Second); a.canvasSaveWaiters.Load() < maxCanvasSaveWaiters && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
	}
	w := httptest.NewRecorder()
	started := time.Now()
	if _, _, ok := a.canvasSave(w, httptest.NewRequest("PUT", "/", nil)); ok || w.Code != 503 || time.Since(started) > time.Second {
		t.Fatalf("a save past the waiters' cap answered %d after %v", w.Code, time.Since(started))
	}
	cancel()
	waiting.Wait()
	if n := a.canvasSaveWaiters.Load(); n != 0 {
		t.Fatalf("%d waiters are still counted", n)
	}
	for _, release := range releases {
		release()
	}
}

// A save that finds every slot taken is answered by the handler itself: 503 canvas_save_busy, not an empty 200 that
// the client would read as saved.
func TestCanvasSaveHandlersAnswerWhenBusy(t *testing.T) {
	a := New(nil, testConfig())
	defer func(wait time.Duration) { canvasSaveWait = wait }(canvasSaveWait)
	canvasSaveWait = 50 * time.Millisecond
	releases := []func(){}
	for range maxCanvasSaves {
		_, release, ok := a.canvasSave(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", nil))
		if !ok {
			t.Fatal("a free slot was refused")
		}
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	for name, save := range map[string]struct {
		handler http.HandlerFunc
		body    string
	}{"create": {a.createCanvas, `{"name":"Canvas","document":{}}`}, "update": {a.updateCanvas, `{"name":"Canvas","document":{},"version":1}`}} {
		r := httptest.NewRequest("PUT", "/", strings.NewReader(save.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		save.handler(w, r)
		if w.Code != 503 || !strings.Contains(w.Body.String(), `"canvas_save_busy"`) {
			t.Fatalf("%s with every slot taken answered %d %q", name, w.Code, w.Body.String())
		}
	}
}

// A create or save takes its slot only once its body is in: one whose body is still arriving holds none, so a client
// sending slowly keeps no other save waiting.
func TestCanvasSavesTakeASlotOnlyWithTheirBody(t *testing.T) {
	a := New(nil, testConfig())
	defer func(wait time.Duration) { canvasSaveWait = wait }(canvasSaveWait)
	canvasSaveWait = 500 * time.Millisecond
	for name, handler := range map[string]http.HandlerFunc{"create": a.createCanvas, "update": a.updateCanvas} {
		body, writer := io.Pipe()
		r := httptest.NewRequest("PUT", "/", body)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		done := make(chan struct{})
		go func() { handler(w, r); close(done) }()
		// The handler has read this much when the write returns, and waits for the rest.
		if _, err := writer.Write([]byte(`{"name":"Canvas","document":"`)); err != nil {
			t.Fatalf("%s: the handler did not read the body: %v", name, err)
		}
		releases := []func(){}
		for range maxCanvasSaves {
			_, release, ok := a.canvasSave(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", nil))
			if !ok {
				t.Fatalf("%s: a save whose body is still arriving holds a slot", name)
			}
			releases = append(releases, release)
		}
		for _, release := range releases {
			release()
		}
		writer.CloseWithError(io.ErrUnexpectedEOF)
		<-done
		if w.Code != 400 {
			t.Fatalf("%s: a body that ended early answered %d", name, w.Code)
		}
	}
}

// A list page ends at its item limit or once its items pass maxListPageBytes, and never before its first item.
func TestListPagesEndAtTheirByteBudget(t *testing.T) {
	cases := []struct {
		count, size, next, limit int
		ends                     bool
	}{
		{0, 0, 2 * int(maxCanvasBodyBytes), 200, false},
		{1, int(maxCanvasBodyBytes), 1, 200, true},
		{3, maxListPageBytes - 10, 10, 200, false},
		{3, maxListPageBytes - 10, 11, 200, true},
		{200, 10, 10, 200, true},
		{199, 10, 10, 200, false},
	}
	for _, c := range cases {
		if got := pageEnds(c.count, c.size, c.next, c.limit); got != c.ends {
			t.Fatalf("pageEnds(%d, %d, %d, %d) = %v", c.count, c.size, c.next, c.limit, got)
		}
	}
}
