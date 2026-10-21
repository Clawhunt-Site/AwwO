package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

// coreRequest writes a completion request as the OpenMaus core does (JSON.stringify keeps <, > and & as they are).
func coreRequest(t *testing.T, messages []map[string]any) []byte {
	t.Helper()
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	tools := []map[string]any{{"type": "function", "function": map[string]any{"name": "read", "parameters": map[string]any{"type": "object"}}}}
	if e := encoder.Encode(map[string]any{"model": "awwo-model", "messages": messages, "tools": tools}); e != nil {
		t.Fatal(e)
	}
	return bytes.TrimRight(b.Bytes(), "\n")
}

func toolCall(id, name, arguments string) map[string]any {
	return map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": arguments}}
}

func answer(calls ...map[string]any) map[string]any {
	return map[string]any{"role": "assistant", "content": "", "tool_calls": calls}
}

func result(id, content string) map[string]any {
	return map[string]any{"role": "tool", "tool_call_id": id, "content": content}
}

// A task's turn: its words, three tool calls and their results, the last one the latest exchange.
func toolTurn(size int) []map[string]any {
	big := func(c string) string { return strings.Repeat(c, size) }
	return []map[string]any{
		{"role": "system", "content": "You are the agent."},
		{"role": "user", "content": "build the page"},
		answer(toolCall("c1", "write", `{"path":"index.html","content":"`+big("w")+`"}`)),
		result("c1", big("a")),
		answer(toolCall("c2", "read", `{"path":"index.html"}`)),
		result("c2", big("b")),
		answer(toolCall("c3", "exec", `{"command":"ls"}`)),
		result("c3", big("c")),
	}
}

type turnMessage struct {
	Role       string `json:"role"`
	Content    string `json:"content"`
	ToolCallID string `json:"tool_call_id"`
	ToolCalls  []struct {
		ID       string `json:"id"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	} `json:"tool_calls"`
}

func turnOf(t *testing.T, raw []byte) []turnMessage {
	t.Helper()
	var request struct {
		Messages []turnMessage `json:"messages"`
	}
	if e := json.Unmarshal(raw, &request); e != nil {
		t.Fatalf("not a completion request: %v", e)
	}
	return request.Messages
}

// argumentsOf reads a tool call's arguments as the object they are.
func argumentsOf(t *testing.T, m turnMessage) map[string]any {
	t.Helper()
	var arguments map[string]any
	if e := json.Unmarshal([]byte(m.ToolCalls[0].Function.Arguments), &arguments); e != nil {
		t.Fatalf("arguments %q: %v", m.ToolCalls[0].Function.Arguments, e)
	}
	return arguments
}

func cutResult(kept string, left int) string { return kept + fmt.Sprintf(omittedToolResult, left) }

func TestToolTrafficReadsWhereEachMessageIs(t *testing.T) {
	// Content before role, escapes, content parts, a call's arguments written as JSON inside JSON.
	raw := []byte(`{"model":"m","messages":[{"content":"say \"hi\" \\ now","role":"user"},` +
		`{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"write","arguments":"{\"path\":\"a.html\",\"content\":\"<p>x</p>\"}"}},{"function":{"arguments":7,"name":"odd"},"id":"c2"}]},` +
		`{"tool_call_id":"c1","content":[{"type":"text","text":"part one"},{"text":"part é two","type":"text"}],"role":"tool"}],"tools":[]}`)
	messages, ok := toolTraffic(raw)
	if !ok || len(messages) != 3 {
		t.Fatalf("read %d messages, ok %v", len(messages), ok)
	}
	text := func(span [2]int) string { return string(raw[span[0]:span[1]]) }
	if m := messages[0]; m.role != "user" || len(m.texts) != 1 || text(m.texts[0]) != `say \"hi\" \\ now` || len(m.calls) != 0 {
		t.Fatalf("user message: %+v", m)
	}
	if m := messages[1]; m.role != "assistant" || len(m.texts) != 0 || len(m.calls) != 2 || m.calls[0].id != "c1" || m.calls[0].name != "write" || !m.calls[0].ok ||
		text(m.calls[0].arguments) != `{\"path\":\"a.html\",\"content\":\"<p>x</p>\"}` || m.calls[1].id != "c2" || m.calls[1].name != "odd" || m.calls[1].ok {
		t.Fatalf("assistant message: %+v", m)
	}
	if m := messages[2]; m.role != "tool" || m.toolCallID != "c1" || len(m.texts) != 2 || text(m.texts[0]) != "part one" || text(m.texts[1]) != `part é two` {
		t.Fatalf("tool message: %+v", m)
	}
	for _, bad := range []string{`[]`, `{"messages":[}`, `{"messages":[]} {}`} {
		if _, ok := toolTraffic([]byte(bad)); ok {
			t.Fatalf("read %q", bad)
		}
	}
}

func within(limit int) func([]byte) bool { return func(c []byte) bool { return len(c) <= limit } }

// trim is withoutOldToolTraffic for a request read here.
func trim(t *testing.T, raw []byte, fits, roomy func([]byte) bool, sticky int) (toolTrafficFit, bool) {
	t.Helper()
	messages, ok := toolTraffic(raw)
	if !ok {
		t.Fatal("not a completion request")
	}
	return withoutOldToolTraffic(raw, messages, fits, roomy, sticky)
}

func TestWithoutOldToolTrafficLeavesOutOnlyWhatTheCallNeeds(t *testing.T) {
	raw := coreRequest(t, toolTurn(3000))
	original := turnOf(t, raw)

	// About 5 KB less: the first call's long value and the bulk of its result go, nothing else.
	got, ok := trim(t, raw, within(len(raw)-5000), within(len(raw)-5000), 0)
	if !ok || got.cut != 2 {
		t.Fatalf("cut %d messages, ok %v", got.cut, ok)
	}
	turn := turnOf(t, got.raw)
	if len(turn) != len(original) {
		t.Fatalf("%d messages, want %d", len(turn), len(original))
	}
	// The write keeps its path, and says its content was left out and that it ran.
	if arguments := argumentsOf(t, turn[2]); arguments["path"] != "index.html" || arguments["content"] != fmt.Sprintf(omittedToolArgument, 3000) || len(arguments) != 2 {
		t.Fatalf("the first call's arguments: %v", arguments)
	}
	if want := cutResult(strings.Repeat("a", keptToolResultBytes), 3000-keptToolResultBytes); turn[3].Content != want {
		t.Fatalf("the first result: %q", turn[3].Content)
	}
	for _, i := range []int{0, 1, 4, 5, 6, 7} {
		if fmt.Sprint(turn[i]) != fmt.Sprint(original[i]) {
			t.Fatalf("message %d changed: %+v", i, turn[i])
		}
	}
	if turn[2].ToolCalls[0].ID != "c1" || turn[2].ToolCalls[0].Function.Name != "write" || turn[3].ToolCallID != "c1" {
		t.Fatal("a call's id or name changed")
	}
	// Of the two, one is a result: the write's.
	if fmt.Sprint(got.results) != fmt.Sprint(map[int]bool{3: true}) {
		t.Fatalf("the results cut: %v", got.results)
	}
	// Every earlier result, if the call needs it; the latest exchange stays whole, and a short call's arguments too.
	all, ok := trim(t, raw, within(len(raw)-7500), within(len(raw)-7500), 0)
	if turn = turnOf(t, all.raw); !ok || all.cut != 3 || turn[5].Content != cutResult(strings.Repeat("b", keptToolResultBytes), 3000-keptToolResultBytes) ||
		turn[4].ToolCalls[0].Function.Arguments != `{"path":"index.html"}` || turn[7].Content != original[7].Content || turn[6].ToolCalls[0].Function.Arguments != `{"command":"ls"}` {
		t.Fatalf("all earlier traffic: %+v", turn)
	}
	// Not enough even without all of it (the latest exchange is never left out), or nothing to leave out: the call is
	// left as it was.
	if _, ok := trim(t, raw, within(len(raw)-11000), within(len(raw)-11000), 0); ok {
		t.Fatal("the latest exchange was left out")
	}
	if _, ok := trim(t, coreRequest(t, toolTurn(3000)[:2]), within(1<<20), within(1<<20), 0); ok {
		t.Fatal("a call without tool traffic had something left out")
	}
	// Results and arguments under a kilobyte stay whole, whatever room the call needs: nothing is left out, even where
	// any cut would do.
	always := func([]byte) bool { return true }
	for _, size := range []int{20, 500, 900} {
		if got, ok := trim(t, coreRequest(t, toolTurn(size)), always, always, 0); ok {
			t.Fatalf("traffic of %d bytes was left out: %.300s", size, got.raw)
		}
	}
}

// What a short receipt says stays: a write's, a publish's and an answer to a question the task may not ask. Only a long
// read goes, and its note says the calls ran, so that the model repeats no action to see a result again.
func TestWithoutOldToolTrafficKeepsReceipts(t *testing.T) {
	receipts := []map[string]any{
		{"role": "system", "content": "You are the agent."},
		{"role": "user", "content": "build the page"},
		answer(toolCall("w1", "write", `{"path":"index.html","content":"<p>hi</p>"}`)),
		result("w1", `{"ok":true,"path":"index.html","bytes":9,"written":true,"note":"The file is in the workspace; publish it to deliver it."}`),
		answer(toolCall("p1", "publish", `{"path":"index.html"}`)),
		result("p1", `{"ok":true,"path":"index.html","published":true,"note":"Delivered: the reader sees this file as the task's result."}`),
		answer(toolCall("q1", "question", `{"question":"Which colour?"}`)),
		result("q1", "请不要再提问：这个任务不能向用户提问。请按最合理的理解继续完成，并在最终回答里写明你做了哪些假设。Do not ask again: this task cannot ask the user; carry on as best you understand it."),
		answer(toolCall("r1", "read", `{"path":"data.csv"}`)),
		result("r1", strings.Repeat("row,", 2000)),
		answer(toolCall("r2", "read", `{"path":"more.csv"}`)),
		result("r2", "short"),
	}
	raw := coreRequest(t, receipts)
	got, ok := trim(t, raw, within(len(raw)-1000), within(len(raw)-1000), 0)
	if !ok || got.cut != 1 {
		t.Fatalf("cut %d, ok %v", got.cut, ok)
	}
	turn, original := turnOf(t, got.raw), turnOf(t, raw)
	for i := range turn {
		if i != 9 && fmt.Sprint(turn[i]) != fmt.Sprint(original[i]) {
			t.Fatalf("message %d changed: %+v", i, turn[i])
		}
	}
	if !strings.HasPrefix(turn[9].Content, strings.Repeat("row,", 64)) || !strings.Contains(turn[9].Content, "The call ran and its effects stand") ||
		!strings.Contains(turn[9].Content, "read it again") || strings.Contains(turn[9].Content, "Run the tool again") {
		t.Fatalf("the long read: %.400q", turn[9].Content)
	}
}

// The latest exchange (the last answer that called tools, its results and anything after them, the note of a task's
// last call among them) goes to the model byte for byte as sent, however large it is.
func TestWithoutOldToolTrafficKeepsTheLatestExchangeAsSent(t *testing.T) {
	turn := append(toolTurn(3000)[:6],
		answer(toolCall("c3", "write", `{"path":"page.html","content":"`+strings.Repeat("x", 5000)+`"}`), toolCall("c4", "exec", `{"command":"ls -la"}`)),
		result("c3", strings.Repeat("y", 4000)),
		result("c4", strings.Repeat("z", 4000)),
		map[string]any{"role": "user", "content": "[AwwO] This is the last model call this task allows: reply with your final answer now."})
	raw := coreRequest(t, turn)
	start := bytes.LastIndex(raw[:bytes.Index(raw, []byte(`"id":"c3"`))], []byte(`{"content":`))
	got, ok := trim(t, raw, within(len(raw)-7500), within(len(raw)-7500), 0)
	if !ok || got.cut != 3 || !bytes.HasSuffix(got.raw, raw[start:]) {
		t.Fatalf("cut %d, ok %v: the latest exchange did not reach the model as sent", got.cut, ok)
	}
	// Where the earlier traffic is not enough, the latest exchange's long arguments and results are not cut instead.
	if got, ok := trim(t, raw, within(len(raw)-11000), within(len(raw)-11000), 0); ok {
		t.Fatalf("cut %d messages, the latest exchange's among them", got.cut)
	}
}

// A call cuts where the task's last call cut while that fits, so that it starts as that one did; past that, as far as
// leaves the next calls room to grow (roomy), else as little as fits.
func TestWithoutOldToolTrafficStaysWhereTheLastCallCut(t *testing.T) {
	raw := coreRequest(t, toolTurn(3000))
	// Room for all of it cut, roomy only past it: the fewest messages that fit.
	if got, ok := trim(t, raw, within(len(raw)-5000), within(0), 0); !ok || got.cut != 2 {
		t.Fatalf("cut %d without room to spare", got.cut)
	}
	// Roomy at three: three, though two fit; what it needed is the two's (its result: the write's, message 3).
	if got, ok := trim(t, raw, within(len(raw)-5000), within(len(raw)-7500), 0); !ok || got.cut != 3 ||
		fmt.Sprint(got.results) != fmt.Sprint(map[int]bool{3: true, 5: true}) || fmt.Sprint(got.needed) != fmt.Sprint(map[int]bool{3: true}) {
		t.Fatalf("cut %d with room to spare at three, results %v, needed %v", got.cut, got.results, got.needed)
	}
	// Where the last call cut three, this one does too, though one would fit, and needed only the first.
	if got, ok := trim(t, raw, within(len(raw)-1000), within(len(raw)-1000), 3); !ok || got.cut != 3 || len(got.needed) != 0 {
		t.Fatalf("cut %d after a call that cut 3, needed %v", got.cut, got.needed)
	}
	// Where the last call's cut no longer fits, more; where it is past what this turn has, from the start.
	if got, ok := trim(t, raw, within(len(raw)-5000), within(len(raw)-5000), 1); !ok || got.cut != 2 {
		t.Fatalf("cut %d after a call that cut 1", got.cut)
	}
	if got, ok := trim(t, raw, within(len(raw)-1000), within(len(raw)-1000), 9); !ok || got.cut != 1 {
		t.Fatalf("cut %d after a call that cut more than this turn has", got.cut)
	}
	if _, ok := trim(t, raw, within(len(raw)-11000), within(len(raw)-11000), 3); ok {
		t.Fatal("the last call's cut was kept though it does not fit")
	}
}

func TestStringHeadNeverSplitsAnEscapeOrACharacter(t *testing.T) {
	// a, b, an escaped quote, é written and escaped, 😀 as an escaped surrogate pair and written, an escaped newline, x.
	const bs = `\`
	raw := []byte(`"ab` + bs + `"é` + bs + `u00e9` + bs + `ud83d` + bs + `ude00😀` + bs + `nx"`)
	span := [2]int{1, len(raw) - 1}
	ends := []int{0, 1, 2, 4, 6, 12, 24, 28, 30, 31}
	for keep := 0; keep <= span[1]-span[0]+1; keep++ {
		// The head ends at the last end of a whole escape or character within keep bytes.
		want := 0
		for _, end := range ends {
			if end <= keep {
				want = end
			}
		}
		head := stringHead(raw, span, keep)
		if head-span[0] != want {
			t.Fatalf("keep %d: head of %d bytes, want %d", keep, head-span[0], want)
		}
		var s string
		if e := json.Unmarshal(quoted(raw[span[0]:head]), &s); e != nil || !utf8.ValidString(s) || strings.ContainsRune(s, utf8.RuneError) {
			t.Fatalf("keep %d: %q splits (%v)", keep, raw[span[0]:head], e)
		}
	}
	if stringHead(raw, span, 1<<20) != span[1] {
		t.Fatal("a head longer than the string is not the whole string")
	}
}

func TestLongStringsFindsValuesNotKeys(t *testing.T) {
	long := strings.Repeat("v", 300)
	text := []byte(`{"path":"a.html","content":"` + long + `","` + strings.Repeat("k", 300) + `":"short","nested":{"inner":"` + long + `","n":1},"list":["` + long + `","s",{"deep":"` + long + `"}]}`)
	spans, ok := longStrings(text, 256)
	if !ok || len(spans) != 4 {
		t.Fatalf("%d spans, ok %v", len(spans), ok)
	}
	for _, span := range spans {
		if string(text[span[0]:span[1]]) != long {
			t.Fatalf("span %v is %q", span, text[span[0]:min(span[1], span[0]+20)])
		}
	}
	for _, bad := range []string{`["` + long + `"]`, `"` + long + `"`, `{"a":"b"} {}`, `{"a":`, ``} {
		if _, ok := longStrings([]byte(bad), 256); ok {
			t.Fatalf("read %q as one object", bad[:min(len(bad), 20)])
		}
	}
	if spans, ok := longStrings([]byte(`{"a":"short","b":[1,2]}`), 256); !ok || len(spans) != 0 {
		t.Fatal("an object of short values")
	}
}

// A long argument value goes with a note; arguments that are no JSON object go as one note.
func TestArgumentsCutKeepsWhatTheCallWasAbout(t *testing.T) {
	odd := coreRequest(t, []map[string]any{{"role": "user", "content": "go"}, answer(toolCall("o1", "exec", strings.Repeat("not json ", 200))), result("o1", "done"),
		answer(toolCall("o2", "exec", `{"command":"ls"}`)), result("o2", "done")})
	got, ok := trim(t, odd, within(len(odd)-1000), within(len(odd)-1000), 0)
	if !ok {
		t.Fatal("arguments that are no JSON object were kept")
	}
	var omitted struct{ Omitted string }
	if e := json.Unmarshal([]byte(turnOf(t, got.raw)[1].ToolCalls[0].Function.Arguments), &omitted); e != nil || !strings.Contains(omitted.Omitted, "1800 bytes") {
		t.Fatalf("the odd arguments: %q (%v)", turnOf(t, got.raw)[1].ToolCalls[0].Function.Arguments, e)
	}
	// Escapes inside the arguments come back as the same JSON: a value with quotes, a newline and <tags>.
	escaped := coreRequest(t, []map[string]any{{"role": "user", "content": "go"},
		answer(toolCall("e1", "write", `{"path":"a \"b\".html","content":"`+strings.Repeat(`<p>\"x\"\n</p>`, 200)+`","mode":"w"}`)), result("e1", "ok"),
		answer(toolCall("e2", "exec", `{"command":"ls"}`)), result("e2", "done")})
	got, ok = trim(t, escaped, within(len(escaped)-1000), within(len(escaped)-1000), 0)
	if !ok {
		t.Fatal("a long escaped value was kept")
	}
	if arguments := argumentsOf(t, turnOf(t, got.raw)[1]); arguments["path"] != `a "b".html` || arguments["mode"] != "w" || !strings.Contains(arguments["content"].(string), "bytes left out") {
		t.Fatalf("the escaped arguments: %v", arguments)
	}
}

// Why a task's calls could not be made is the first reason met: a later refusal does not replace it.
func TestNoteRefusalKeepsTheFirstReason(t *testing.T) {
	l := &computerLease{}
	l.noteRefusal("computer_context_limit")
	l.noteRefusal("something_later")
	if got := l.refused(); got != "computer_context_limit" {
		t.Fatalf("refusal %q", got)
	}
	quota := &computerLease{refusal: "quota_exceeded"}
	quota.noteRefusal("computer_context_limit")
	if got := quota.refused(); got != "quota_exceeded" {
		t.Fatalf("an allowance's refusal was replaced by %q", got)
	}
}

// A result of a reading tool is the same again when the same call (its name and arguments) answers byte for byte as
// before; a call loses a result when it cuts every copy of it; anything else a latest exchange brings is new.
func TestResultPrintsAndWhatACallLoses(t *testing.T) {
	const reading = "awwo_workspace_read"
	read := func(id, path string) map[string]any { return answer(toolCall(id, reading, `{"path":"`+path+`"}`)) }
	turn := []map[string]any{{"role": "user", "content": "go"}, read("r1", "a.txt"), result("r1", "A1"), read("r2", "a.txt"), result("r2", "A1"),
		read("r3", "a.txt"), result("r3", "A2"), read("r4", "b.txt"), result("r4", "A1"), answer(toolCall("r5", reading, `{"path":"a.txt"}`), toolCall("r6", reading, `{"path":"a.txt"}`)),
		result("r5", "A1"), result("r6", "A1"), result("unknown", "A1")}
	raw := coreRequest(t, turn)
	messages, _ := toolTraffic(raw)
	prints := resultPrints(raw, messages)
	if prints[2] == "" || prints[2] != prints[4] || prints[2] == prints[6] || prints[2] == prints[8] || prints[10] != prints[2] || prints[11] != prints[2] ||
		prints[12] != "" || prints[1] != "" {
		t.Fatalf("prints %q", prints)
	}
	// The latest exchange brings A1 (twice, one result), and a result of no known call, which is new.
	if latest := latestPrints(messages, prints); len(latest) != 2 || !latest[prints[2]] || !latest["new 12"] {
		t.Fatalf("latest %v", latest)
	}
	// A command's result, alike as it may be (a fix applied, the same errors printed), is new every time, as is a write's.
	exec := func(id string) map[string]any {
		return answer(toolCall(id, "awwo_workspace_exec", `{"command":"apply-next-fix && npx tsc --noEmit"}`))
	}
	again := coreRequest(t, []map[string]any{{"role": "user", "content": "go"}, exec("x1"), result("x1", "ERRORS"), exec("x2"), result("x2", "ERRORS")})
	messages, _ = toolTraffic(again)
	if againPrints := resultPrints(again, messages); againPrints[2] != "" || againPrints[4] != "" || !latestPrints(messages, againPrints)["new 4"] {
		t.Fatalf("a command's results: %q", againPrints)
	}
	// A list only reads, as a read does.
	list := coreRequest(t, []map[string]any{{"role": "user", "content": "go"}, answer(toolCall("l1", "awwo_workspace_list", `{"path":"."}`)), result("l1", "a.txt")})
	messages, _ = toolTraffic(list)
	if listPrints := resultPrints(list, messages); listPrints[2] == "" {
		t.Fatal("a list's result was taken for something new")
	}
	// Cutting one copy of A1 loses nothing; cutting both earlier copies loses nothing either while the latest exchange
	// holds it; A2, its only copy cut, is lost.
	if lost := lostPrints(prints, map[int]bool{2: true}); len(lost) != 0 {
		t.Fatalf("lost %v", lost)
	}
	if lost := lostPrints(prints, map[int]bool{2: true, 4: true, 6: true}); len(lost) != 1 || !lost[prints[6]] {
		t.Fatalf("lost %v", lost)
	}
}

// A task thrashes when, in a row of calls that bring back nothing but what the last call lost, the same result comes
// back a second time; anything new starts the row over, and a result asked twice in one answer counts once.
func TestThrashingIsTheSameLostResultTwiceInARow(t *testing.T) {
	l := &computerLease{}
	set := func(prints ...string) map[string]bool {
		s := map[string]bool{}
		for _, p := range prints {
			s[p] = true
		}
		return s
	}
	// Nothing lost: nothing brought back.
	if l.thrashesLocked(set("A")) || l.thrashesLocked(nil) {
		t.Fatal("a result no call lost counted")
	}
	// Two files that do not fit together: A lost, brought back; B lost, brought back; A again.
	l.noteTrafficLocked(1, set("A"))
	if l.thrashesLocked(set("A")) {
		t.Fatal("reading again what was lost, once, ended the task")
	}
	if l.noteTrafficLocked(2, set("B")); l.thrashesLocked(set("B")) {
		t.Fatal("another lost result, once")
	}
	if l.noteTrafficLocked(3, set("A")); !l.thrashesLocked(set("A")) {
		t.Fatal("A brought back a second time in a row was not thrashing")
	}
	if sticky := l.stickyCut(); sticky != 3 || !l.traffic.lost["A"] {
		t.Fatalf("sticky %d, lost %v", sticky, l.traffic.lost)
	}
	// Anything new between (a fix written, a changed result) starts the row over: an edit loop never ends the task.
	l = &computerLease{}
	for i := 0; i < 4; i++ {
		l.noteTrafficLocked(1, set("R"))
		if l.thrashesLocked(set("R")) {
			t.Fatalf("round %d: the same check after a fix ended the task", i)
		}
		if l.noteTrafficLocked(1, set("R")); l.thrashesLocked(set("W" + fmt.Sprint(i))) {
			t.Fatal("a new result ended the task")
		}
	}
	// A latest exchange that brings a lost result and a new one is something new; one with none starts over too.
	l = &computerLease{}
	l.noteTrafficLocked(1, set("A", "B"))
	if l.thrashesLocked(set("A")) || l.thrashesLocked(set("A", "N")) || l.thrashesLocked(set("A")) || l.thrashesLocked(nil) || l.thrashesLocked(set("A")) {
		t.Fatal("a row with something new in it ended the task")
	}
	// What a call that went whole lost is nothing.
	if l.noteTrafficLocked(0, nil); l.thrashesLocked(set("A")) {
		t.Fatal("a result counted lost after a call that went whole")
	}
	if l.stickyCut() != 0 || len(l.traffic.lost) != 0 || len(l.traffic.run) != 0 {
		t.Fatal("a call that went whole kept the last call's cut, what it lost or the row")
	}
}

// fakeComputerModel is a model worker that measures a call as apps/computer-model.ts does (the call's JSON as the worker
// writes it, plus 32 bytes a message, against the model's budget) and refuses one over it with 413 CONTEXT_LIMIT; it
// sends every call it takes on sent, and answers refuseNext's with that 413 too.
func fakeComputerModel(t *testing.T, budget int, sent chan<- []byte, refuseNext *atomic.Bool) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		var b struct {
			Completion json.RawMessage `json:"completion"`
		}
		if json.NewDecoder(r.Body).Decode(&b) != nil {
			t.Error("bad model call")
		}
		var completion struct {
			Messages []json.RawMessage `json:"messages"`
		}
		var parsed any
		decoder := json.NewDecoder(bytes.NewReader(b.Completion))
		decoder.UseNumber()
		var written bytes.Buffer
		encoder := json.NewEncoder(&written)
		encoder.SetEscapeHTML(false)
		if json.Unmarshal(b.Completion, &completion) != nil || decoder.Decode(&parsed) != nil || encoder.Encode(parsed) != nil {
			t.Error("bad completion")
		}
		if refuseNext.Swap(false) || written.Len()-1+32*len(completion.Messages) > budget {
			writeJSON(w, 413, map[string]any{"error": map[string]any{"code": "CONTEXT_LIMIT", "message": "The managed model request could not be completed."}})
			return
		}
		sent <- b.Completion
		writeJSON(w, 200, map[string]any{"completion": map[string]any{"id": "one", "choices": []map[string]any{{"index": 0, "message": map[string]string{"role": "assistant", "content": "OK"}, "finish_reason": "stop"}}}, "observability": json.RawMessage(observationFixture(1, 1))})
	}))
	t.Cleanup(server.Close)
	return server
}

// A direct task whose turn outgrows its model keeps working without the bulk of its earlier tool traffic, and one whose
// latest exchange alone is too large, or which keeps bringing back what its calls went without, ends saying so
// (computer_context_limit), as one the worker's own measure refuses does; no such task gives its calls back.
func TestPostgresComputerCallGoesWithoutEarlierToolTrafficOverBudget(t *testing.T) {
	const budget = 28416 // the personal connection model's (connections.go)
	sent := make(chan []byte, 8)
	var refuseNext atomic.Bool
	trusted := fakeComputerModel(t, budget, sent, &refuseNext)
	started := make(chan computerWorkerInput, 2)
	end := make(chan struct{}, 2)
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
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- input
		select {
		case <-end: // the core gave up on the turn after the refused call, as it does
			fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n")
		case <-r.Context().Done():
		}
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "computer-traffic@example.test")
	model := connectionModelID(addPersonalConnection(t, h, owner), "test-chat-model")
	canvas, _, _ := h.fixture(t, owner, tid)
	base := "/tenants/" + tid
	start := func(op string) (string, computerWorkerInput) {
		t.Helper()
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": op, "prompt": "build the page", "runtime": "pi", "model": model}, 202)
		return run["id"].(string), <-started
	}
	calls := func() (n int) {
		t.Helper()
		if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}
	ended := func(id string, forwarded float64) {
		t.Helper()
		if done := h.awaitRun(t, owner, tid, id, "failed"); done["error"] != "computer_context_limit" {
			t.Fatalf("the task ended with %v", done["error"])
		}
		if detail := h.request(t, owner, "GET", base+"/computer-runs/"+id, nil, 200); detail["calls"] != forwarded || detail["refundedCalls"] != float64(0) {
			t.Fatalf("the task reads calls=%v refundedCalls=%v, want %v and none back", detail["calls"], detail["refundedCalls"], forwarded)
		}
	}

	first, input := start("traffic-first")
	// About 37 KB of turn over a 28,416-byte model: it goes without the bulk of the oldest of its earlier traffic, as
	// far as leaves a fifth of the budget to grow into, and the worker's own measure takes it.
	raw := coreRequest(t, toolTurn(9000))
	if len(raw) <= budget {
		t.Fatalf("the turn is only %d bytes", len(raw))
	}
	computerProxyRaw(t, input, raw, 200)
	got := <-sent
	turn, original := turnOf(t, got), turnOf(t, raw)
	if len(got) > budget-budget/5 || argumentsOf(t, turn[2])["path"] != "index.html" || argumentsOf(t, turn[2])["content"] != fmt.Sprintf(omittedToolArgument, 9000) ||
		turn[3].Content != cutResult(strings.Repeat("a", keptToolResultBytes), 9000-keptToolResultBytes) {
		t.Fatalf("the model got %d bytes, its first call's arguments %.80q, its first result %.80q", len(got), turn[2].ToolCalls[0].Function.Arguments, turn[3].Content)
	}
	for _, i := range []int{0, 1, 4, 5, 6, 7} {
		if fmt.Sprint(turn[i]) != fmt.Sprint(original[i]) {
			t.Fatalf("message %d changed though the call fitted without it", i)
		}
	}
	// A call that fits whole goes as sent, and the next call that does not starts its cut over.
	computerProxyRaw(t, input, coreRequest(t, toolTurn(100)), 200)
	if got := <-sent; !bytes.Contains(got, []byte(strings.Repeat("a", 100))) {
		t.Fatal("a call that fitted whole went without some of its traffic")
	}
	// A turn within the budget but over what the worker's measure takes (32 bytes a message and 256 more) goes without
	// some of it too: its oldest value alone leaves it room.
	size := 6000
	for len(coreRequest(t, toolTurn(size+1))) <= budget-64 {
		size++
	}
	if raw = coreRequest(t, toolTurn(size)); len(raw) > budget || len(raw) <= budget-256 {
		t.Fatalf("the turn is %d bytes", len(raw))
	}
	computerProxyRaw(t, input, raw, 200)
	if turn = turnOf(t, <-sent); argumentsOf(t, turn[2])["content"] != fmt.Sprintf(omittedToolArgument, size) || turn[3].Content != strings.Repeat("a", size) {
		t.Fatalf("a turn the worker would refuse went as %.80q / %.80q", turn[2].ToolCalls[0].Function.Arguments, turn[3].Content)
	}
	// One that, without all of its earlier traffic, is still over the worker's measure though within the budget is
	// refused here, as one over the budget is, and not sent for the worker to refuse.
	bothCut := func(c []byte) bool { return bytes.Count(c, []byte("so that this call fits the model's context")) == 2 }
	near := func(n int) ([]byte, int) {
		raw := coreRequest(t, []map[string]any{{"role": "system", "content": "You are the agent."}, {"role": "user", "content": "build the page"},
			answer(toolCall("n1", "write", `{"path":"index.html","content":"`+strings.Repeat("w", 2000)+`"}`)), result("n1", strings.Repeat("a", 2000)),
			answer(toolCall("n2", "exec", `{"command":"ls -R"}`)), result("n2", strings.Repeat("c", n))})
		f, _ := trim(t, raw, bothCut, bothCut, 0)
		return raw, len(f.raw)
	}
	// Each byte of the latest result is one byte of the call: 149 bytes under the budget, without all its earlier traffic.
	_, empty := near(0)
	nearRaw, cut := near(budget - 149 - empty)
	if cut != budget-149 || len(nearRaw) <= budget {
		t.Fatalf("the turn is %d bytes, %d without its traffic", len(nearRaw), cut)
	}
	computerProxyRaw(t, input, nearRaw, 400)
	// A latest exchange too large on its own is refused before any reservation, and the task that gives up on it says why.
	before := calls()
	computerProxyRaw(t, input, coreRequest(t, append(toolTurn(100)[:7], result("c3", strings.Repeat("c", 30000)))), 400)
	if after := calls(); after != before {
		t.Fatalf("a refused call was reserved: %d calls, then %d", before, after)
	}
	end <- struct{}{}
	ended(first, 3)

	// The worker's own measure refusing the call ends the task the same way.
	second, input := start("traffic-second")
	refuseNext.Store(true)
	computerProxyRaw(t, input, coreRequest(t, toolTurn(100)), 502)
	end <- struct{}{}
	ended(second, 0) // refused before any model work, the call is not counted

	// Two files that do not fit the model together: reading one again leaves out the other, which the model then reads
	// again. The second time a file it went without comes back, the task ends instead of trading them until its calls
	// run out.
	third, input := start("traffic-thrash")
	a, b := strings.Repeat("A", 14000), strings.Repeat("B", 14000)
	readA := func(id string) map[string]any { return answer(toolCall(id, "awwo_workspace_read", `{"path":"a.txt"}`)) }
	readB := func(id string) map[string]any { return answer(toolCall(id, "awwo_workspace_read", `{"path":"b.txt"}`)) }
	thrash := []map[string]any{{"role": "system", "content": "You are the agent."}, {"role": "user", "content": "compare the files"},
		readA("t1"), result("t1", a), readB("t2"), result("t2", b)}
	for i, next := range [][]map[string]any{nil, {readA("t3"), result("t3", a)}, {readB("t4"), result("t4", b)}} {
		thrash = append(thrash, next...)
		computerProxyRaw(t, input, coreRequest(t, thrash), 200)
		if got := <-sent; len(got) > budget {
			t.Fatalf("call %d went with %d bytes", i+1, len(got))
		}
	}
	before = calls()
	computerProxyRaw(t, input, coreRequest(t, append(thrash, readA("t5"), result("t5", a))), 400)
	if after := calls(); after != before {
		t.Fatalf("the thrashing call was reserved: %d calls, then %d", before, after)
	}
	end <- struct{}{}
	ended(third, 3)

	// A check run again after each fix, with the same errors each time, while its earlier runs are left out: something
	// new between each (the fix), so the task goes on.
	fourth, input := start("traffic-edits")
	errorsOut := strings.Repeat("E", 14000)
	edits := []map[string]any{{"role": "system", "content": "You are the agent."}, {"role": "user", "content": "make the build pass"}}
	for round := 1; round <= 4; round++ {
		check, fix := fmt.Sprintf("e%d", round), fmt.Sprintf("f%d", round)
		edits = append(edits, answer(toolCall(check, "awwo_workspace_exec", `{"command":"npx tsc --noEmit"}`)), result(check, errorsOut))
		computerProxyRaw(t, input, coreRequest(t, edits), 200)
		<-sent
		edits = append(edits, answer(toolCall(fix, "awwo_workspace_write", fmt.Sprintf(`{"path":"a.ts","content":"fix %d"}`, round))), result(fix, `{"ok":true,"written":true}`))
		computerProxyRaw(t, input, coreRequest(t, edits), 200)
		<-sent
	}
	end <- struct{}{}
	if done := h.awaitRun(t, owner, tid, fourth, "failed"); done["error"] == "computer_context_limit" {
		t.Fatal("an edit loop ended as too large for its model")
	}

	// Three files that fit the model while one of them is left out: read back one at a time, as the notes ask, they
	// never end the task, though each call leaves out more than it needs, for the room the next calls get.
	fifth, input := start("traffic-room")
	readFile := func(id, path string) map[string]any {
		return answer(toolCall(id, "awwo_workspace_read", `{"path":"`+path+`"}`))
	}
	files := map[string]string{"a.txt": strings.Repeat("A", 11000), "b.txt": strings.Repeat("B", 11000), "c.txt": strings.Repeat("C", 12000)}
	room := []map[string]any{{"role": "system", "content": "You are the agent."}, {"role": "user", "content": "compare the files"},
		readFile("q1", "a.txt"), result("q1", files["a.txt"]), readFile("q2", "b.txt"), result("q2", files["b.txt"]), readFile("q3", "c.txt"), result("q3", files["c.txt"])}
	for i, path := range []string{"", "a.txt", "b.txt", "a.txt", "b.txt"} {
		if path != "" {
			id := fmt.Sprintf("q%d", 4+i)
			room = append(room, readFile(id, path), result(id, files[path]))
		}
		computerProxyRaw(t, input, coreRequest(t, room), 200)
		<-sent
	}
	end <- struct{}{}
	if done := h.awaitRun(t, owner, tid, fifth, "failed"); done["error"] == "computer_context_limit" {
		t.Fatal("a turn that fits while one file is left out ended as too large for its model")
	}
}
