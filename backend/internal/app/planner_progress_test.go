package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

const progressPlan = `{"version":1,"summary":"数据与后端","operations":[{"type":"add_node","ref":"data","templateId":"data"},{"type":"add_node","ref":"api","templateId":"backend"},{"type":"connect","fromNode":"data","fromField":"schema","toNode":"api","toField":"schema"}]}`

func TestPlannerProgressCountsOnlyWhatArrived(t *testing.T) {
	var p plannerProgress
	now := time.Unix(1_000, 0)
	if _, ok := p.due(now); ok {
		t.Fatal("reported progress before the run produced anything")
	}
	p.write("")
	if _, ok := p.due(now); ok {
		t.Fatal("an empty delta counted as output")
	}
	// Every cut through the plan must count each marker exactly once, including cuts
	// inside the marker itself. Deltas are decoded JSON strings, so they always end on
	// a rune boundary, and only such cuts are exercised.
	for cut := 0; cut <= len(progressPlan); cut++ {
		if cut < len(progressPlan) && !utf8.RuneStart(progressPlan[cut]) {
			continue
		}
		var q plannerProgress
		q.write(progressPlan[:cut])
		q.write(progressPlan[cut:])
		if q.nodes.total != 2 || q.edges.total != 1 || q.template != "backend" || q.characters != utf8.RuneCountInString(progressPlan) {
			t.Fatalf("cut %d counted %d nodes / %d edges / template %q / %d runes", cut, q.nodes.total, q.edges.total, q.template, q.characters)
		}
	}
	// One byte at a time, which is smaller than the marker. Only the node count is
	// meaningful here: single bytes of a multi-byte rune are not a real delta.
	var bytewise plannerProgress
	for i := 0; i < len(progressPlan); i++ {
		bytewise.write(progressPlan[i : i+1])
	}
	if bytewise.nodes.total != 2 || bytewise.edges.total != 1 || bytewise.template != "backend" {
		t.Fatalf("byte-wise stream counted %d nodes / %d edges / template %q", bytewise.nodes.total, bytewise.edges.total, bytewise.template)
	}
	// Neither a disconnect nor a field's own type value is a declared node.
	var other plannerProgress
	other.write(`{"operations":[{"type":"disconnect","edgeId":"e"},{"type":"add_field","field":{"type":"markdown"}}]}`)
	if other.nodes.total != 0 || other.edges.total != 0 {
		t.Fatalf("counted %d nodes / %d edges in operations that declare none", other.nodes.total, other.edges.total)
	}
	// Only a member of the closed template set is reported; model text never is.
	var foreign plannerProgress
	foreign.write(`{"type":"add_node","templateId":"exfiltrate","title":"\"templateId\":\"users\""}`)
	if foreign.template != "" {
		t.Fatalf("reported template %q from outside the template set", foreign.template)
	}
	var spaced plannerProgress
	spaced.write(`{"type":"add_node","templateId" :  "review"}`)
	if spaced.template != "review" {
		t.Fatalf("template with JSON whitespace read as %q", spaced.template)
	}
	// A new node never borrows its predecessor's template while its own is still unwritten.
	var owner plannerProgress
	owner.write(`{"operations":[{"type":"add_node","ref":"a","templateId":"data"},`)
	owner.write(`{"type":"add_node","ref":"b",`)
	if owner.template != "" || owner.nodes.total != 2 {
		t.Fatalf("node 2 reported node 1's template %q", owner.template)
	}
	owner.write(`"templateId":"users"}`)
	if owner.template != "users" {
		t.Fatalf("node 2's own template read as %q", owner.template)
	}
	// Written ahead of its "type", a template cannot be told apart from the previous node's,
	// so it is not shown at all — whether or not the two arrive in the same delta.
	var ahead plannerProgress
	ahead.write(`{"operations":[{"templateId":"users","type":"add_node","ref":"a"}`)
	if ahead.template != "" {
		t.Fatalf("a template written before its node marker was attributed: %q", ahead.template)
	}
	var split plannerProgress
	split.write(`{"operations":[{"type":"add_node","ref":"a","templateId":"data"},`)
	split.write(`{"templateId":"users",`)
	if split.template != "data" || split.nodes.total != 1 {
		t.Fatalf("node 1 took the next operation's template: %q (%d nodes)", split.template, split.nodes.total)
	}
	split.write(`"type":"add_node","ref":"b"}`)
	if split.template != "" || split.nodes.total != 2 {
		t.Fatalf("node 2 kept an unattributable template: %q", split.template)
	}
	// Only a direct key of the operation names it: nested values and strings never do.
	for _, raw := range []string{
		`{"type":"add_node","ref":"a","inputValues":{"templateId":"users"}}`,
		`{"type":"add_node","ref":"a","title":"x \"templateId\":\"users\""}`,
		`{"type":"add_node","ref":"a","persona":"} {\"templateId\":\"users\"}"}`,
	} {
		var nested plannerProgress
		nested.write(raw)
		if nested.template != "" {
			t.Fatalf("%s attributed template %q", raw, nested.template)
		}
	}
	// A template far behind the window is not shown, but never wrongly.
	var distant plannerProgress
	distant.write(`{"operations":[{"type":"add_node","ref":"a","persona":"` + strings.Repeat("长", 1000) + `","templateId":"review"}`)
	if distant.template != "" && distant.template != "review" {
		t.Fatalf("distant template read as %q", distant.template)
	}
	// Characters are runes, so a CJK summary is not reported three times over.
	var cjk plannerProgress
	cjk.write("数据")
	if cjk.characters != 2 {
		t.Fatalf("counted %d characters for two runes", cjk.characters)
	}
}

// operationPlan has the shape a real model produced for a five-node request: every node
// first, then an input for each node, then the connections.
const operationPlan = `{"version":1,"summary":"预约系统","operations":[` +
	`{"type":"add_node","ref":"data-node","templateId":"data","title":"数据"},` +
	`{"type":"add_node","ref":"api-node","templateId":"backend","title":"后端"},` +
	`{"type":"set_input","nodeId":"api-node","fieldId":"brief","value":"会员预约与排课规则"},` +
	`{"type":"set_input","nodeId":"data-node","fieldId":"brief","value":"课程、教练与预约数据"},` +
	`{"type":"connect","fromNode":"data-node","fromField":"schema","toNode":"api-node","toField":"schema"}]}`

// inPlan wraps operations in a proposal's root object, where operations live.
func inPlan(operations string) string {
	return `{"version":1,"summary":"s","operations":[` + operations + `]}`
}

// operationAt feeds a proposal up to the end of the first occurrence of marker (or all of it)
// and reports the operation and target the stream shows at that point.
func operationAt(text, marker string) (string, string) {
	var p plannerProgress
	end := len(text)
	if marker != "" {
		end = strings.Index(text, marker) + len(marker)
	}
	p.write(text[:end])
	return p.operation, p.target
}

func TestPlannerProgressFollowsTheNewestOperation(t *testing.T) {
	for _, step := range []struct{ upTo, operation, target string }{
		{`"summary":"预约系统"`, "", ""},
		{`"type":"add_node","ref":"data-node"`, "add_node", ""},
		{`"templateId":"data"`, "add_node", "data"},
		{`"templateId":"backend"`, "add_node", "backend"},
		{`{"type":"set_input"`, "set_input", ""},
		{`"nodeId":"api-node"`, "set_input", "backend"},
		{`"会员预约与排课规则"`, "set_input", "backend"},
		{`"nodeId":"data-node"`, "set_input", "data"},
		{`"type":"connect"`, "connect", ""},
		{"", "connect", ""},
	} {
		if operation, target := operationAt(operationPlan, step.upTo); operation != step.operation || target != step.target {
			t.Fatalf("after %q: operation %q target %q, want %q %q", step.upTo, operation, target, step.operation, step.target)
		}
	}
	// However the deltas are cut, the stream ends on the same decision and the legacy
	// template still names the newest declared node.
	for cut := 0; cut <= len(operationPlan); cut++ {
		if cut < len(operationPlan) && !utf8.RuneStart(operationPlan[cut]) {
			continue
		}
		var q plannerProgress
		q.write(operationPlan[:cut])
		q.write(operationPlan[cut:])
		if q.operation != "connect" || q.target != "" || q.template != "backend" || len(q.refs) != 2 {
			t.Fatalf("cut %d: operation %q target %q template %q refs %v", cut, q.operation, q.target, q.template, q.refs)
		}
	}
	// One byte at a time, a node's input still names that node while it is written.
	var bytewise plannerProgress
	upTo := strings.Index(operationPlan, `"会员预约`)
	for i := 0; i < upTo; i++ {
		bytewise.write(operationPlan[i : i+1])
	}
	if bytewise.operation != "set_input" || bytewise.target != "backend" {
		t.Fatalf("byte-wise stream: operation %q target %q", bytewise.operation, bytewise.target)
	}
	// Only an element of the root "operations" array is an operation, and only its own "type"
	// names it: a ref, a field id, a string, or a nested object spelled like an operation —
	// even one with its own "type" and "nodeId" — is not.
	for _, raw := range []string{
		inPlan(`{"type":"add_node","ref":"set_input","templateId":"frontend"}`),
		inPlan(`{"type":"add_node","ref":"a","templateId":"frontend","inputValues":{"connect":"x"}}`),
		inPlan(`{"type":"add_node","ref":"a","templateId":"frontend","title":"{\"type\":\"remove_node\"}"}`),
		inPlan(`{"type":"add_node","ref":"api-node","templateId":"backend"},{"type":"add_node","ref":"form","templateId":"frontend","inputValues":{"type":"set_input","nodeId":"api-node"}}`),
		inPlan(`{"type":"add_node","ref":"a","templateId":"frontend","inputValues":{"operations":[{"type":"remove_node","nodeId":"a"}]}}`),
		inPlan(`{"type":"add_node","ref":"a","templateId":"frontend","inputValues":[{"type":"connect"}]}`),
		`{"type":"set_input","nodeId":"api-node","operations":[{"type":"add_node","ref":"a","templateId":"frontend"}]}`,
	} {
		if operation, target := operationAt(raw, ""); operation != "add_node" || target != "frontend" {
			t.Fatalf("%s read as operation %q target %q", raw, operation, target)
		}
	}
	for raw, want := range map[string]string{
		inPlan(`{"type":"add_field","nodeId":"a","side":"input","field":{"id":"connect","type":"text"}}`):                               "add_field",
		inPlan(`{"type":"update_field","nodeId":"a","side":"input","fieldId":"f","changes":{"type":"markdown","label":"remove_node"}}`): "update_field",
		`{"type":"connect","summary":"x"}`:                  "",
		`{"type":"add_node","ref":"a","templateId":"data"}`: "",
	} {
		if operation, _ := operationAt(raw, ""); operation != want {
			t.Fatalf("%s read as operation %q, want %q", raw, operation, want)
		}
	}
	// A node already on the canvas, an escaped id and a node declared with a template outside
	// the set are all unnamed rather than guessed.
	for _, raw := range []string{
		inPlan(`{"type":"add_node","ref":"a","templateId":"data"},{"type":"set_input","nodeId":"existing","fieldId":"f","value":"v"}`),
		inPlan(`{"type":"add_node","ref":"a\"b","templateId":"data"},{"type":"remove_node","nodeId":"a\"b"}`),
		inPlan(`{"type":"add_node","ref":"a","templateId":"exfiltrate"},{"type":"update_field","nodeId":"a","side":"input","fieldId":"f","changes":{"label":"x"}}`),
	} {
		if _, target := operationAt(raw, ""); target != "" {
			t.Fatalf("%s named target %q", raw, target)
		}
	}
	// The object's own keys name it in whatever order they are written.
	if operation, target := operationAt(inPlan(`{"type":"add_node","ref":"a","templateId":"data"},{"nodeId":"a","type":"update_node","title":"x"}`), ""); operation != "update_node" || target != "data" {
		t.Fatalf("keys ahead of type: operation %q target %q", operation, target)
	}
	// Every node-level operation names a node this proposal declared; a connection names none.
	for _, kind := range []string{"update_node", "set_input", "add_field", "update_field", "remove_field", "remove_node"} {
		raw := inPlan(`{"type":"add_node","ref":"r","templateId":"users"},{"type":"` + kind + `","nodeId":"r"}`)
		if operation, target := operationAt(raw, ""); operation != kind || target != "users" {
			t.Fatalf("%s: operation %q target %q", kind, operation, target)
		}
	}
	for _, raw := range []string{
		inPlan(`{"type":"add_node","ref":"r","templateId":"users"},{"type":"disconnect","edgeId":"e"}`),
		inPlan(`{"type":"add_node","ref":"r","templateId":"users"},{"type":"connect","fromNode":"r","fromField":"f","toNode":"r","nodeId":"r"}`),
	} {
		if operation, target := operationAt(raw, ""); (operation != "disconnect" && operation != "connect") || target != "" {
			t.Fatalf("%s: operation %q target %q", raw, operation, target)
		}
	}
	// A long input keeps its decision after its operation scrolls out of the window.
	var long plannerProgress
	long.write(`{"operations":[{"type":"add_node","ref":"a","templateId":"review"},{"type":"set_input","nodeId":"a","fieldId":"f","value":"`)
	for i := 0; i < 20; i++ {
		long.write(strings.Repeat("长", 200))
	}
	if long.operation != "set_input" || long.target != "review" {
		t.Fatalf("a long input lost its decision: %q %q", long.operation, long.target)
	}
	// Neither nesting nor an endless identifier can grow what the scanner keeps.
	var deep plannerProgress
	deep.write(`{"operations":[` + strings.Repeat(`{"a":[`, 10*plannerScanDepth) + `"` + strings.Repeat("x", 100_000) + `"`)
	if len(deep.structure.stack) > plannerScanDepth || cap(deep.structure.text) > 2*plannerIdentifierLimit {
		t.Fatalf("scanner kept %d frames / %d bytes", len(deep.structure.stack), cap(deep.structure.text))
	}
	// The refs a stream can make the process remember are bounded by what a valid plan holds.
	var many plannerProgress
	var b strings.Builder
	b.WriteString(`{"operations":[`)
	for i := 0; i < 3*plannerRefLimit; i++ {
		fmt.Fprintf(&b, `{"type":"add_node","ref":"n%d","templateId":"data"},`, i)
	}
	many.write(b.String())
	if len(many.refs) != plannerRefLimit {
		t.Fatalf("remembered %d refs, limit %d", len(many.refs), plannerRefLimit)
	}
	many.write(fmt.Sprintf(`{"type":"set_input","nodeId":"n%d"}`, 2*plannerRefLimit))
	if many.target != "" {
		t.Fatalf("a ref past the limit was named %q", many.target)
	}
	many.write(`{"type":"set_input","nodeId":"n7"}`)
	if many.target != "data" {
		t.Fatalf("a remembered ref was not named: %q", many.target)
	}
	// An operation change is urgent, so the headline follows within the urgent interval.
	var p plannerProgress
	start := time.Unix(1_000, 0)
	p.write(`{"operations":[{"type":"add_node","ref":"a","templateId":"data"},`)
	if _, ok := p.due(start); !ok {
		t.Fatal("the first node was not published")
	}
	p.write(`{"type":"set_input","nodeId":"a","fieldId":"f","value":"x"`)
	frame, ok := p.due(start.Add(plannerProgressUrgentInterval))
	if !ok || frame.Operation != "set_input" || frame.Target != "data" || frame.Nodes != 1 {
		t.Fatalf("the new operation waited for the interval: %+v %v", frame, ok)
	}
	encoded, _ := json.Marshal(frame)
	if !strings.Contains(string(encoded), `"operation":"set_input","target":"data"`) {
		t.Fatalf("frame JSON: %s", encoded)
	}
}

func TestPlannerProgressCoalescesButNeverHidesAStageOrANode(t *testing.T) {
	var p plannerProgress
	start := time.Unix(1_000, 0)
	p.write(`{"version":1,`)
	frame, ok := p.due(start)
	if !ok || frame.Stage != "streaming" || frame.Type != "progress" {
		t.Fatalf("the first output did not change the stage at once: %+v %v", frame, ok)
	}
	p.write(`"summary":"x",`)
	if _, ok = p.due(start.Add(100 * time.Millisecond)); ok {
		t.Fatal("a character count inside the interval was not coalesced")
	}
	p.write(`"operations":[{"type":"add_node"`)
	if frame, ok = p.due(start.Add(200 * time.Millisecond)); !ok || frame.Nodes != 1 {
		t.Fatalf("a newly declared node waited for the interval: %+v %v", frame, ok)
	}
	p.write(`,"ref":"a"}`)
	if _, ok = p.due(start.Add(300 * time.Millisecond)); ok {
		t.Fatal("reported again inside the interval without a stage or node change")
	}
	p.write(`,{"type":"connect"`)
	if frame, ok = p.due(start.Add(400 * time.Millisecond)); !ok || frame.Edges != 1 {
		t.Fatalf("a newly declared connection waited for the interval: %+v %v", frame, ok)
	}
	p.write(`}`)
	if frame, ok = p.due(start.Add(1500 * time.Millisecond)); !ok || frame.Characters != utf8.RuneCountInString(`{"version":1,"summary":"x","operations":[{"type":"add_node","ref":"a"},{"type":"connect"}`) {
		t.Fatalf("the interval did not release the running count: %+v %v", frame, ok)
	}
	// Urgent changes are still spaced, so a stream of bare markers cannot write a row per delta;
	// the change is kept and goes out with the next write after the urgent interval.
	p.write(`,{"type":"add_node"`)
	if _, ok = p.due(start.Add(1550 * time.Millisecond)); ok {
		t.Fatal("an urgent change inside the urgent interval was written at once")
	}
	if frame, ok = p.due(start.Add(1700 * time.Millisecond)); !ok || frame.Nodes != 2 {
		t.Fatalf("the deferred node was lost: %+v %v", frame, ok)
	}
	// Nothing new happened, however much later it is asked.
	if _, ok = p.due(start.Add(time.Hour)); ok {
		t.Fatal("an unchanged frame was published twice")
	}
}

func TestPlannerProgressReportsReasoningBeforeTheProposal(t *testing.T) {
	var p plannerProgress
	start := time.Unix(1_000, 0)
	// A provider that hides its reasoning text still reports that reasoning began.
	p.reasonReported(0)
	frame, ok := p.due(start)
	if !ok || frame.Stage != "thinking" || frame.Reasoning != 0 || frame.Characters != 0 {
		t.Fatalf("reasoning start was not a stage: %+v %v", frame, ok)
	}
	p.reasonReported(120)
	if frame, ok = p.due(start.Add(1100 * time.Millisecond)); !ok || frame.Reasoning != 120 {
		t.Fatalf("reasoning count not reported: %+v %v", frame, ok)
	}
	// A worker's figure is cumulative; a smaller one never takes counted work away.
	p.reasonReported(80)
	p.reasonInline(30)
	if frame = p.frame(); frame.Reasoning != 150 {
		t.Fatalf("reasoning total = %d, want 150", frame.Reasoning)
	}
	p.write("{")
	if frame, ok = p.due(start.Add(1400 * time.Millisecond)); !ok || frame.Stage != "streaming" || frame.Reasoning != 150 {
		t.Fatalf("the proposal did not take over the stage at once: %+v %v", frame, ok)
	}
	// Interleaved reasoning after the proposal began does not send the reader back.
	p.reasonReported(500)
	if frame = p.frame(); frame.Stage != "streaming" {
		t.Fatalf("stage regressed to %q", frame.Stage)
	}
	p.reasonInline(-4)
	if frame = p.frame(); frame.Reasoning != 530 {
		t.Fatalf("a negative inline count changed the total: %d", frame.Reasoning)
	}
}

func TestRunArchiveProjectsPlannerProgressCountsOnly(t *testing.T) {
	event := projectRunArchiveEvent(3, time.Now(), []byte(`{"type":"progress","stage":"streaming","characters":12,"nodes":1,"edges":0,"reasoning":0,"template":"data","text":"hidden proposal"}`))
	if event.Type != "progress" || event.PayloadOmitted || event.Stage != "streaming" || *event.Characters != 12 || *event.Nodes != 1 ||
		*event.Edges != 0 || *event.Reasoning != 0 || event.Template != "data" || event.Text != "" {
		t.Fatalf("progress not projected as counts: %+v", event)
	}
	event = projectRunArchiveEvent(3, time.Now(), []byte(`{"type":"progress","stage":"streaming","characters":40,"nodes":2,"edges":0,"reasoning":0,"template":"backend","operation":"set_input","target":"data"}`))
	if event.PayloadOmitted || event.Operation != "set_input" || event.Target != "data" || event.Template != "backend" {
		t.Fatalf("operation and target not projected: %+v", event)
	}
	for _, raw := range []string{
		`{"type":"progress","stage":"done","characters":1,"nodes":0,"edges":0,"reasoning":0}`,
		`{"type":"progress","stage":"streaming","characters":-1,"nodes":0,"edges":0,"reasoning":0}`,
		`{"type":"progress","stage":"thinking","nodes":0,"edges":0,"reasoning":0}`,
		`{"type":"progress","stage":"streaming","characters":1,"nodes":0,"edges":0,"reasoning":0,"template":"free text"}`,
		`{"type":"progress","stage":"streaming","characters":1,"nodes":0,"edges":0,"reasoning":0,"operation":"exec"}`,
		`{"type":"progress","stage":"streaming","characters":1,"nodes":0,"edges":0,"reasoning":0,"operation":"set_input","target":"api-node"}`,
		`{"type":"progress","stage":"streaming","characters":1,"nodes":0,"edges":0,"reasoning":0,"target":"data"}`,
		`{"type":"progress","stage":"streaming","characters":1,"nodes":0,"edges":0,"reasoning":0,"operation":"connect","target":"data"}`,
	} {
		if got := projectRunArchiveEvent(4, time.Now(), []byte(raw)); got.Type != "unsupported" || !got.PayloadOmitted || got.Characters != nil {
			t.Fatalf("malformed progress row was projected: %s -> %+v", raw, got)
		}
	}
	// Every other event type serializes exactly as before: no count keys appear.
	for _, raw := range []string{`{"type":"text_delta","delta":"a"}`, `{"type":"completed","text":"b"}`, `{"type":"queued"}`} {
		encoded, _ := json.Marshal(projectRunArchiveEvent(5, time.Unix(0, 0).UTC(), []byte(raw)))
		for _, key := range []string{"stage", "characters", "nodes", "edges", "reasoning", "template", "operation", "target"} {
			if strings.Contains(string(encoded), `"`+key+`"`) {
				t.Fatalf("%s gained %q: %s", raw, key, encoded)
			}
		}
	}
}

// plannerWorker is a Pi worker for planning runs that records the activity header it
// was sent and replays the events a test scripts, flushing each one. A gap spaces the
// events the way a real model's deltas are spaced, so each can become its own row.
func plannerWorker(t *testing.T, activity *atomic.Value, events func(runID string) []map[string]any, gap ...time.Duration) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var body struct {
			RunID string `json:"runId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		activity.Store(r.Header.Get(runActivityHeader))
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		flush := http.NewResponseController(w)
		for index, event := range events(body.RunID) {
			if index > 0 && len(gap) > 0 {
				time.Sleep(gap[0])
			}
			raw, _ := json.Marshal(event)
			fmt.Fprintf(w, "data: %s\n\n", raw)
			_ = flush.Flush()
		}
	}))
}

// pacedGap spaces scripted deltas past the urgent interval with room for scheduling jitter,
// so every urgent change in a test stream becomes its own row, as it does at a model's pace.
const pacedGap = plannerProgressUrgentInterval + 170*time.Millisecond

type storedEvent struct {
	id   int64
	data map[string]any
	raw  string
}

func runEvents(t *testing.T, h *harness, tid, id string) []storedEvent {
	t.Helper()
	rows, e := h.db.Query(context.Background(), "SELECT id,data::text FROM run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY id", tid, id)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	var out []storedEvent
	for rows.Next() {
		var event storedEvent
		if e = rows.Scan(&event.id, &event.raw); e != nil {
			t.Fatal(e)
		}
		if e = json.Unmarshal([]byte(event.raw), &event.data); e != nil {
			t.Fatal(e)
		}
		out = append(out, event)
	}
	return out
}

func progressRows(events []storedEvent) []storedEvent {
	var out []storedEvent
	for _, event := range events {
		if event.data["type"] == "progress" {
			out = append(out, event)
		}
	}
	return out
}

// cutAfter cuts a proposal into deltas that each end just after the next of the given markers.
func cutAfter(text string, markers ...string) []map[string]any {
	var out []map[string]any
	start := 0
	for _, marker := range markers {
		end := start + strings.Index(text[start:], marker) + len(marker)
		out = append(out, map[string]any{"type": "text_delta", "delta": text[start:end]})
		start = end
	}
	return append(out, map[string]any{"type": "text_delta", "delta": text[start:]})
}

// planChunks cuts on rune boundaries, as a worker's decoded JSON deltas always are.
func planChunks(plan string, size int) []map[string]any {
	var out []map[string]any
	runes := []rune(plan)
	for start := 0; start < len(runes); start += size {
		end := min(start+size, len(runes))
		out = append(out, map[string]any{"type": "text_delta", "delta": string(runes[start:end])})
	}
	return out
}

func startPlan(t *testing.T, h *harness, c *http.Cookie, tid, operation string) string {
	t.Helper()
	prefix := "/tenants/" + tid
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	return h.request(t, c, "POST", prefix+"/canvases/"+cid+"/plan", map[string]string{"prompt": "Build a data product", "context": "schema", "operationId": operation}, 202)["id"].(string)
}

func TestPostgresPlannerPublishesProgressButNeverTheProposal(t *testing.T) {
	var activity atomic.Value
	pi := plannerWorker(t, &activity, func(string) []map[string]any {
		events := []map[string]any{{"type": "reasoning", "characters": 0}, {"type": "reasoning", "characters": 40}}
		events = append(events, planChunks(progressPlan, 60)...)
		return append(events, map[string]any{"type": "completed", "text": progressPlan})
	}, pacedGap)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner-progress@awwo.invalid")
	id := startPlan(t, h, c, tid, "planner-progress")
	done := h.awaitRun(t, c, tid, id, "completed")
	if done["output"] != progressPlan {
		t.Fatalf("the proposal changed: %#v", done["output"])
	}
	if activity.Load() != runActivityReasoning {
		t.Fatalf("planner admission did not opt in to reasoning activity: %v", activity.Load())
	}
	events := runEvents(t, h, tid, id)
	progress := progressRows(events)
	if len(progress) < 3 {
		t.Fatalf("expected thinking and streaming progress, got %d rows: %v", len(progress), events)
	}
	completedAt := int64(-1)
	for _, event := range events {
		switch event.data["type"] {
		case "text_delta":
			t.Fatalf("a proposal fragment was published: %s", event.raw)
		case "completed":
			completedAt = event.id
		}
	}
	stages := []string{}
	lastCharacters, lastNodes := -1.0, -1.0
	for _, row := range progress {
		assertCountOnlyProgress(t, row, "数据与后端", "templateId", `"api"`, `"ref"`, "schema", "fromField")
		if row.id > completedAt {
			t.Fatalf("progress was written after the terminal event: %s", row.raw)
		}
		characters, nodes := row.data["characters"].(float64), row.data["nodes"].(float64)
		if characters < lastCharacters || nodes < lastNodes {
			t.Fatalf("progress moved backwards: %v", progress)
		}
		lastCharacters, lastNodes = characters, nodes
		if len(stages) == 0 || stages[len(stages)-1] != row.data["stage"] {
			stages = append(stages, row.data["stage"].(string))
		}
	}
	if strings.Join(stages, ">") != "thinking>streaming" {
		t.Fatalf("stages = %v", stages)
	}
	if lastNodes != 2 || progress[0].data["reasoning"].(float64) != 0 {
		t.Fatalf("final node count %v / first reasoning %v", lastNodes, progress[0].data["reasoning"])
	}
	if last := progress[len(progress)-1].data; last["edges"].(float64) != 1 || last["template"] != "backend" {
		t.Fatalf("final connection count or template missing: %v", last)
	}
	// The browser reads the same rows through the replay endpoint (jsonb re-serializes
	// them, so the frames are decoded rather than matched as text).
	_, replay := h.readRaw(t, c, "/tenants/"+tid+"/runs/"+id+"/events", 200)
	replayed := 0
	for _, line := range strings.Split(string(replay), "\n") {
		var frame map[string]any
		if !strings.HasPrefix(line, "data: ") || json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame) != nil {
			continue
		}
		if frame["type"] == "progress" {
			replayed++
		}
	}
	if replayed != len(progress) {
		t.Fatalf("replay carried %d of %d progress frames: %s", replayed, len(progress), replay)
	}
}

// assertCountOnlyProgress fails a progress row that carries anything but its counts and the
// closed-set values progress may name, or that contains any of the given proposal fragments.
func assertCountOnlyProgress(t *testing.T, row storedEvent, fragments ...string) {
	t.Helper()
	for _, key := range []string{"type", "stage", "characters", "nodes", "edges", "reasoning"} {
		if _, present := row.data[key]; !present {
			t.Fatalf("progress row lacks %q: %s", key, row.raw)
		}
	}
	for key, value := range row.data {
		switch key {
		case "type", "stage", "characters", "nodes", "edges", "reasoning":
		case "template", "target":
			if !slices.Contains(planTemplateIDs, value.(string)) {
				t.Fatalf("progress row names %s outside the template set: %s", key, row.raw)
			}
		case "operation":
			if !slices.Contains(planOperationTypes, value.(string)) {
				t.Fatalf("progress row names an operation outside the set: %s", row.raw)
			}
		default:
			t.Fatalf("progress row carries more than counts: %s", row.raw)
		}
	}
	for _, fragment := range fragments {
		if strings.Contains(row.raw, fragment) {
			t.Fatalf("progress row leaked %q: %s", fragment, row.raw)
		}
	}
}

// The headline a reader sees follows the operation the model is writing, and names the node
// it concerns: through the node declarations, then each node's input, then the connections.
func TestPostgresPlannerProgressNamesTheOperationAndItsNode(t *testing.T) {
	var activity atomic.Value
	pi := plannerWorker(t, &activity, func(string) []map[string]any {
		// Each delta ends where the next step is decided, so each step is its own row.
		deltas := cutAfter(operationPlan, `"templateId":"data"`, `"templateId":"backend"`, `"nodeId":"api-node"`, `"nodeId":"data-node"`, `"type":"connect"`)
		return append(deltas, map[string]any{"type": "completed", "text": operationPlan})
	}, pacedGap)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner-operations@awwo.invalid")
	id := startPlan(t, h, c, tid, "planner-operations")
	h.awaitRun(t, c, tid, id, "completed")
	var seen []string
	for _, row := range progressRows(runEvents(t, h, tid, id)) {
		assertCountOnlyProgress(t, row, "预约系统", "data-node", "api-node", "brief", "会员", "schema", "templateId", "nodeId")
		operation, _ := row.data["operation"].(string)
		target, _ := row.data["target"].(string)
		if step := operation + ":" + target; operation != "" && (len(seen) == 0 || seen[len(seen)-1] != step) {
			seen = append(seen, step)
		}
	}
	want := []string{"add_node:data", "add_node:backend", "set_input:backend", "set_input:data", "connect:"}
	if strings.Join(seen, " ") != strings.Join(want, " ") {
		t.Fatalf("operation steps %v, want %v", seen, want)
	}
}

// A cancel commits its status and terminal event together. A progress write racing it must
// wait for that decision: if it slipped in ahead with a later id, a live reader could pass the
// terminal event's id before it became visible and then never deliver it.
func TestPostgresPlannerProgressNeverLandsAfterACommittingCancel(t *testing.T) {
	release := make(chan struct{})
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer pi.Close()
	defer close(release)
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner-progress-cancel@awwo.invalid")
	id := startPlan(t, h, c, tid, "planner-progress-cancel")
	h.awaitRun(t, c, tid, id, "running")
	ctx := context.Background()
	tx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "UPDATE runs SET status='cancelled',updated_at=now() WHERE tenant_id=$1 AND id=$2", tid, id); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, `{"type":"cancelled"}`); e != nil {
		t.Fatal(e)
	}
	written := make(chan error, 1)
	go func() {
		written <- h.a.appendRunProgress(ctx, tid, id, []byte(`{"type":"progress","stage":"streaming","characters":1,"nodes":0,"edges":0,"reasoning":0}`))
	}()
	select {
	case e = <-written:
		t.Fatalf("the progress write did not wait for the committing cancel: %v", e)
	case <-time.After(300 * time.Millisecond):
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-written; e != nil {
		t.Fatal(e)
	}
	events := runEvents(t, h, tid, id)
	if last := events[len(events)-1]; last.data["type"] != "cancelled" {
		t.Fatalf("an event landed after the terminal one: %s", last.raw)
	}
	for _, event := range events {
		if event.data["type"] == "progress" {
			t.Fatalf("progress was written for a cancelled run: %s", event.raw)
		}
	}
}

func TestPostgresPlannerProgressCountsAWithheldReasoningPreamble(t *testing.T) {
	const secret = "tenant ledger 55117"
	var activity atomic.Value
	pi := plannerWorker(t, &activity, func(string) []map[string]any {
		var events []map[string]any
		for _, delta := range leakedDeltas("weighing options "+secret, progressPlan) {
			events = append(events, map[string]any{"type": "text_delta", "delta": delta})
		}
		return append(events, map[string]any{"type": "completed", "text": leakedText("weighing options "+secret, progressPlan)})
	}, pacedGap)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner-inline-reasoning@awwo.invalid")
	id := startPlan(t, h, c, tid, "planner-inline-reasoning")
	if done := h.awaitRun(t, c, tid, id, "completed"); done["output"] != progressPlan {
		t.Fatalf("plan not recovered from behind the preamble: %#v", done["output"])
	}
	events := runEvents(t, h, tid, id)
	for _, event := range events {
		// The stage is named "thinking", so the check is for the scratchpad itself.
		if strings.Contains(event.raw, "55117") || strings.Contains(event.raw, "weighing") || strings.Contains(event.raw, "<think") {
			t.Fatalf("a stored event retained the scratchpad: %s", event.raw)
		}
	}
	progress := progressRows(events)
	if len(progress) < 2 || progress[0].data["stage"] != "thinking" || progress[0].data["reasoning"].(float64) <= 0 || progress[0].data["characters"].(float64) != 0 {
		t.Fatalf("withheld reasoning was not reported as thinking first: %v", progress)
	}
	last := progress[len(progress)-1]
	if last.data["stage"] != "streaming" || last.data["nodes"].(float64) != 2 {
		t.Fatalf("proposal progress missing after the preamble: %s", last.raw)
	}
}

func TestPostgresOnlyPlannerRunsAcceptReasoningActivity(t *testing.T) {
	var activity atomic.Value
	pi := plannerWorker(t, &activity, func(string) []map[string]any {
		return []map[string]any{{"type": "reasoning", "characters": 12}, {"type": "completed", "text": "hello"}}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "node-reasoning@awwo.invalid")
	_, _, sid := h.fixture(t, c, tid)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "node-reasoning"}, 202)["id"].(string)
	if failed := h.awaitRun(t, c, tid, id, "failed"); failed["error"] != "invalid_runtime_event" {
		t.Fatalf("a node run accepted an activity event it never asked for: %#v", failed)
	}
	if got := activity.Load(); got != "" {
		t.Fatalf("a node run opted in to reasoning activity: %v", got)
	}
	for _, event := range runEvents(t, h, tid, id) {
		if event.data["type"] == "progress" {
			t.Fatalf("a node run published planner progress: %s", event.raw)
		}
	}
}

func TestPostgresPlannerRejectsAMalformedReasoningCount(t *testing.T) {
	var activity atomic.Value
	for name, event := range map[string]map[string]any{
		"negative": {"type": "reasoning", "characters": -3},
		"missing":  {"type": "reasoning"},
	} {
		t.Run(name, func(t *testing.T) {
			pi := plannerWorker(t, &activity, func(string) []map[string]any {
				return []map[string]any{event, {"type": "completed", "text": progressPlan}}
			})
			defer pi.Close()
			h := newHarness(t, pi.URL)
			c, tid, _ := h.register(t, "planner-malformed-"+name+"@awwo.invalid")
			id := startPlan(t, h, c, tid, "planner-malformed-"+name)
			if failed := h.awaitRun(t, c, tid, id, "failed"); failed["error"] != "invalid_runtime_event" {
				t.Fatalf("malformed reasoning count accepted: %#v", failed)
			}
		})
	}
}
