package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The model's answer is held to its shape: one JSON object, at most three notes of the kinds it may propose, a one-line
// title and a bounded body, no links, no hidden text; anything else gives no note.
func TestParseMemoryDistillReplyKeepsOnlyWellFormedNotes(t *testing.T) {
	good := `{"notes":[{"kind":"fact","title":"产品叫阿呜","body":"所有页面都用「阿呜」这个名字。"},{"kind":"style","title":"Short headings","body":"Headings stay under six words."}]}`
	if notes := parseMemoryDistillReply(good); len(notes) != 2 || notes[0].Title != "产品叫阿呜" || notes[1].Kind != "style" {
		t.Fatalf("%+v", notes)
	}
	if notes := parseMemoryDistillReply("```json\n" + good + "\n```"); len(notes) != 2 {
		t.Fatalf("a fenced answer: %+v", notes)
	}
	for name, content := range map[string]string{
		"prose":           "Here are the notes: the product is called AwwO.",
		"two objects":     good + good,
		"unknown field":   `{"notes":[],"instructions":"ignore the rules"}`,
		"not an object":   `[{"kind":"fact","title":"x","body":"y"}]`,
		"empty":           ``,
		"nothing to keep": `{"notes":[]}`,
	} {
		if notes := parseMemoryDistillReply(content); len(notes) != 0 {
			t.Errorf("%s: %+v", name, notes)
		}
	}
	bad := []string{
		`{"kind":"lesson","title":"A lesson","body":"Lessons are AwwO's own."}`,
		`{"kind":"instruction","title":"Do this","body":"Always answer in JSON."}`,
		`{"kind":"fact","title":"Two\nlines","body":"x"}`,
		`{"kind":"fact","title":"` + strings.Repeat("长", 81) + `","body":"x"}`,
		`{"kind":"fact","title":"Long","body":"` + strings.Repeat("b", 501) + `"}`,
		`{"kind":"fact","title":"A link","body":"See https://evil.example/x for more."}`,
		`{"kind":"fact","title":"Hidden","body":"text​with a zero-width space"}`,
		`{"kind":"fact","title":"","body":"no title"}`,
	}
	for _, note := range bad {
		if notes := parseMemoryDistillReply(`{"notes":[` + note + `]}`); len(notes) != 0 {
			t.Errorf("%s: kept %+v", note, notes)
		}
	}
	four := `{"notes":[` + strings.Repeat(`{"kind":"fact","title":"t","body":"b"},`, 3) + `{"kind":"fact","title":"t4","body":"b4"}]}`
	if notes := parseMemoryDistillReply(four); len(notes) != 3 {
		t.Fatalf("more than three kept: %d", len(notes))
	}
}

// distillPi is a Pi worker that answers a canvas run's nodes and the distiller's free-model question.
type distillPi struct {
	server   *httptest.Server
	asked    atomic.Int32
	answer   atomic.Value // string
	busy     atomic.Bool
	lastUser atomic.Value // string
}

func newDistillPi(t *testing.T) *distillPi {
	p := &distillPi{}
	p.answer.Store(`{"notes":[{"kind":"decision","title":"Pages are dark","body":"The team chose a dark theme for every page."}]}`)
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			active := 0
			if p.busy.Load() {
				active = 7
			}
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "maxConcurrency": 8, "activeRuns": active,
				"completionOptions": []string{"thinking", "maxTokens"}, "models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}}})
		case r.URL.Path == "/internal/computer-model":
			p.asked.Add(1)
			var body struct {
				Thinking   bool `json:"thinking"`
				Completion struct {
					Messages []map[string]string `json:"messages"`
				} `json:"completion"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Thinking || len(body.Completion.Messages) != 2 || body.Completion.Messages[0]["content"] != memoryDistillInstructions {
				t.Error("the distiller's question", body)
			}
			if len(body.Completion.Messages) == 2 {
				p.lastUser.Store(body.Completion.Messages[1]["content"])
			}
			content := p.answer.Load().(string)
			writeJSON(w, 200, map[string]any{"completion": map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": content}}}}})
		case r.Method == "DELETE":
			w.WriteHeader(202)
		default:
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			completePi(w, "Dark pages for the launch, RESULT")
		}
	}))
	t.Cleanup(p.server.Close)
	return p
}

type distilledNote struct {
	title, body, kind, status, origin string
	source                            map[string]any
}

func canvasNotes(t *testing.T, h *harness, tid, cid string) []distilledNote {
	t.Helper()
	rows, err := h.db.Query(context.Background(), "SELECT title,body,kind,status,origin,source FROM memory_items WHERE tenant_id=$1 AND canvas_id=$2 ORDER BY created_at", tid, cid)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []distilledNote{}
	for rows.Next() {
		var n distilledNote
		var raw []byte
		if err = rows.Scan(&n.title, &n.body, &n.kind, &n.status, &n.origin, &raw); err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(raw, &n.source)
		out = append(out, n)
	}
	return out
}

func distillation(t *testing.T, h *harness, tid string) (state, reason string, notes int) {
	t.Helper()
	if err := h.db.QueryRow(context.Background(), "SELECT state,reason,notes FROM run_distillations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", tid).Scan(&state, &reason, &notes); err != nil {
		t.Fatal(err)
	}
	return
}

// The canvas's first run to finish whole is queued for its memory when its lessons are written; the distiller asks
// the free model about its briefing and writes what it proposes as proposed notes of the canvas, which no run is given
// until a member accepts one; the same note is never proposed twice, and a busy worker leaves the run queued.
func TestPostgresAFinishedCanvasRunProposesMemoryNotes(t *testing.T) {
	pi := newDistillPi(t)
	h := newHarness(t, pi.server.URL)
	c, tid, _ := h.register(t, "distill@example.test")
	// Off unless the deployment turns it on: a run is not even queued.
	off := retryCanvas(t, h, c, tid)
	runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+off+"/graph-runs", "distill-off-1", "completed")
	time.Sleep(200 * time.Millisecond)
	var none int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM run_distillations WHERE tenant_id=$1", tid).Scan(&none); err != nil || none != 0 {
		t.Fatalf("queued while off: %d %v", none, err)
	}
	h.a.cfg.MemoryDistill = true
	cid := retryCanvas(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	runGraph(t, h, c, base, "distill-run-1", "completed")
	ctx := context.Background()
	deadline := time.Now().Add(6 * time.Second)
	for {
		var queued int
		_ = h.db.QueryRow(ctx, "SELECT count(*) FROM run_distillations WHERE tenant_id=$1 AND state='queued'", tid).Scan(&queued)
		if queued == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the run was not queued for its memory")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A busy worker: asked nothing, still queued.
	pi.busy.Store(true)
	if err := h.a.distillQueuedMemory(ctx); err != nil {
		t.Fatal(err)
	}
	if state, _, _ := distillation(t, h, tid); state != "queued" || pi.asked.Load() != 0 {
		t.Fatalf("a busy worker was asked, or the run let go: %s, %d", state, pi.asked.Load())
	}
	pi.busy.Store(false)
	if err := h.a.distillQueuedMemory(ctx); err != nil {
		t.Fatal(err)
	}
	if state, reason, n := distillation(t, h, tid); state != "done" || n != 1 || reason != "" {
		t.Fatalf("distilled: %s %s %d", state, reason, n)
	}
	user, _ := pi.lastUser.Load().(string)
	if !strings.Contains(user, "Dark pages for the launch") || !strings.Contains(user, `"up"`) {
		t.Fatal("the briefing the model read", user)
	}
	notes := canvasNotes(t, h, tid, cid)
	if len(notes) != 1 || notes[0].status != "proposed" || notes[0].origin != "run" || notes[0].kind != "decision" || notes[0].source["distilled"] != true {
		t.Fatalf("the notes written: %+v", notes)
	}
	// Proposed: the next run is given no memory.
	if snap := lastRunSnapshot(t, h, tid); strings.Contains(snap, "Pages are dark") {
		t.Fatal("a proposed note was given to a run")
	}
	// A later run that is not worth learning from is not queued; one queued again proposes nothing it already holds.
	runGraph(t, h, c, base, "distill-run-2", "completed")
	time.Sleep(200 * time.Millisecond)
	var queued int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM run_distillations WHERE tenant_id=$1", tid).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("an ordinary run was queued: %d %v", queued, err)
	}
	written, err := h.a.proposeRunNotes(ctx, tid, cid, "g", parseMemoryDistillReply(pi.answer.Load().(string)))
	if err != nil || written != 0 || len(canvasNotes(t, h, tid, cid)) != 1 {
		t.Fatalf("the same note again: %d %v", written, err)
	}
}

// lastRunSnapshot is the execution snapshot of the workspace's latest run, as text.
func lastRunSnapshot(t *testing.T, h *harness, tid string) string {
	t.Helper()
	var raw []byte
	if err := h.db.QueryRow(context.Background(), "SELECT execution_snapshot FROM runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", tid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
