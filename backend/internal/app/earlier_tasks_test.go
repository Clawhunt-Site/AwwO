package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The 2026-10-16 report, reduced: a task asked for a game and stopped part-way, then 「继续」.
func reportedEarlierTasks() []earlierTask {
	at := time.Date(2026, 10, 16, 6, 43, 15, 0, time.UTC)
	return []earlierTask{
		{ID: "t1", Status: "completed", Request: "你好", Output: "你好！我可以帮你写代码、处理文件。", At: at.Add(-6 * time.Minute)},
		{ID: "t2", Status: "failed", Error: "computer_execution_failed", Request: "帮我做一个针对每个不同个体开发的专属游戏，单个 HTML 文件",
			LastWords: "我先把游戏的框架写进 game.html，接下来写关卡逻辑。", At: at,
			Files: []briefingFile{{NodeID: "$computer", FieldID: "f", Name: "game.html", Size: 34, At: at, Content: []byte("<!doctype html><title>g</title>\n")}}},
	}
}

func TestEarlierTasksTellWhatWasAskedAndHowItEnded(t *testing.T) {
	text := renderEarlierTasks(reportedEarlierTasks(), true, earlierMaxBytes)
	for _, want := range []string{earlierTasksMarker, "last 2 direct task(s)", "继续, 接着做, 重试",
		"1. 2026-10-16 06:37 UTC, completed.", `Request: "你好"`, `Its answer: "你好！我可以帮你写代码、处理文件。"`,
		"2. 2026-10-16 06:43 UTC, failed part-way: a model call failed or took too long.",
		`Request: "帮我做一个针对每个不同个体开发的专属游戏，单个 HTML 文件"`, `Its last words before it ended: "我先把游戏的框架写进 game.html，接下来写关卡逻辑。"`,
		"Files it delivered (the user can open them in its task card): game.html (34 B)",
		"=== file game.html (32 bytes) ===\n<!doctype html><title>g</title>\n   === end of file ===", earlierTasksEnd} {
		if !strings.Contains(text, want) {
			t.Fatalf("earlier tasks lack %q:\n%s", want, text)
		}
	}
	names := renderEarlierTasks(reportedEarlierTasks(), false, earlierMaxBytes)
	if strings.Contains(names, "<!doctype") || !strings.Contains(names, "game.html (34 B)") {
		t.Fatalf("without files the block must name the file, not show it:\n%s", names)
	}
}

func TestEarlierTaskEndingsArePlain(t *testing.T) {
	for _, c := range []struct{ status, code, want string }{
		{"completed", "", "completed"}, {"cancelled", "", "stopped by the user"}, {"interrupted", "", "service restarted"},
		{"failed", "computer_busy", "never started"}, {"failed", "quota_exceeded", "calls for the day ran out"},
		{"failed", "premium_quota_exceeded", "outside the user's allowance"}, {"failed", "", "failed"},
		{"failed", "something_new", "failed (something_new)"}, {"failed", "computer_task_timeout", "ran out of its time"},
		{"failed", "computer_call_budget", "used all of its model calls"}, {"failed", "computer_tool_budget", "more tool calls at once"},
	} {
		if got := earlierTaskEnding(c.status, c.code); !strings.Contains(got, c.want) {
			t.Fatalf("%s/%s: %q lacks %q", c.status, c.code, got, c.want)
		}
	}
}

func TestEarlierTasksStayBounded(t *testing.T) {
	big := strings.Repeat("长", 5000)
	file := []byte(strings.Repeat("x", earlierInlineBytes-10))
	var tasks []earlierTask
	for i := 0; i < earlierTasksMax; i++ {
		tasks = append(tasks, earlierTask{ID: "t", Status: "completed", Request: big, Output: big, At: time.Now(),
			Files: []briefingFile{{Name: "a.txt", Size: len(file), Content: file}, {Name: "b.txt", Size: len(file), Content: file}}})
	}
	text := renderEarlierTasks(tasks, true, earlierMaxBytes)
	if len(text) > earlierMaxBytes {
		t.Fatalf("block is %d bytes", len(text))
	}
	if strings.Count(text, "=== file ") > 1 || strings.Count(renderEarlierTasks(tasks, true, 1<<20), "=== file ") != 1 {
		t.Fatal("inline files must share one budget")
	}
	if strings.Contains(text, strings.Repeat("长", earlierRequestRunes+1)) {
		t.Fatal("a request must be clipped")
	}
	if !strings.HasSuffix(text, earlierTasksEnd) {
		t.Fatal("the block must end with its end line")
	}
	for _, limit := range []int{900, 3000, 9000, 20000} {
		if got := renderEarlierTasks(tasks, true, limit); len(got) > limit {
			t.Fatalf("a %d-byte room got %d bytes", limit, len(got))
		}
	}
}

// Codex 2026-10-16: the block is appended after admission, so it must fit what the model budget leaves, and when the
// room is short the latest task is the one kept.
func TestEarlierTasksKeepTheLatestWithinTheRoom(t *testing.T) {
	tasks := reportedEarlierTasks()
	latest := renderEarlierTasks(tasks[1:], false, earlierMaxBytes)
	text := renderEarlierTasks(tasks, true, len(latest))
	if text != latest {
		t.Fatalf("a room for one task must hold the latest task alone, without its file:\n%s", text)
	}
	if !strings.Contains(text, "last 1 direct task(s)") || !strings.Contains(text, "专属游戏") || strings.Contains(text, `Request: "你好"`) {
		t.Fatalf("the latest task must be the one kept:\n%s", text)
	}
	if renderEarlierTasks(tasks, true, len(latest)-1) != "" {
		t.Fatal("no block when not even the latest task fits")
	}
	both := renderEarlierTasks(tasks, false, earlierMaxBytes)
	withFile := renderEarlierTasks(tasks, true, len(both)+20)
	if withFile != both {
		t.Fatalf("a file that does not fit is left out, the summaries stay:\n%s", withFile)
	}
	h := &App{}
	if h.earlierTasksBriefing(context.Background(), "t", "r", "s", "继续", earlierRoomShare-1) != "" ||
		h.earlierTasksBriefing(context.Background(), "t", "r", "s", "继续", -5000) != "" {
		t.Fatal("no room, no block (and no database read)")
	}
}

// Codex 2026-10-16: the worker refuses a prompt with a NUL, failing the task, so only clean text is inlined.
func TestEarlierTasksInlineOnlyCleanText(t *testing.T) {
	task := earlierTask{ID: "t", Status: "completed", Request: "写几个文件", Output: "好了", At: time.Now(), Files: []briefingFile{
		{Name: "nul.txt", Size: 5, Content: []byte("a\x00bcd")},
		{Name: "bell.md", Size: 4, Content: []byte("ab\x07c")},
		{Name: "del.txt", Size: 4, Content: []byte("ab\x7fc")},
		{Name: "bad.txt", Size: 2, Content: []byte{0xff, 0xfe}},
		{Name: "image.png", Size: 4, Content: []byte("text")},
		{Name: "ok.md", Size: 9, Content: []byte("# T\r\n\tok\n")},
	}}
	text := renderEarlierTasks([]earlierTask{task}, true, earlierMaxBytes)
	if strings.ContainsAny(text, "\x00\x07\x7f") || strings.Count(text, "=== file ") != 1 || !strings.Contains(text, "=== file ok.md (9 bytes) ===\n# T\r\n\tok\n") {
		t.Fatalf("only clean text files may be inlined:\n%q", text)
	}
	for _, name := range []string{"nul.txt", "bell.md", "del.txt", "bad.txt", "image.png"} {
		if !strings.Contains(text, name+" (") {
			t.Fatalf("%s must still be named:\n%s", name, text)
		}
	}
}

func TestDirectTaskTranscriptDropsEarlierTasks(t *testing.T) {
	prompt := "继续"
	if got := withoutCanvasBriefing(prompt + renderEarlierTasks(reportedEarlierTasks(), true, earlierMaxBytes) + renderCanvasBriefing(reportedCanvasFacts(), true)); got != prompt {
		t.Fatalf("transcript shows %q", got)
	}
	if got := withoutCanvasBriefing(prompt + renderEarlierTasks(reportedEarlierTasks(), false, earlierMaxBytes)); got != prompt {
		t.Fatalf("transcript shows %q", got)
	}
	if got := withoutCanvasBriefing(prompt + renderCanvasBriefing(reportedCanvasFacts(), false)); got != prompt {
		t.Fatalf("transcript shows %q", got)
	}
	// Codex round 7: the worker's 64 KiB cut of the echo can fall inside a marker.
	for _, marker := range []string{earlierTasksMarker, canvasBriefingMarker} {
		for _, k := range []int{strings.Index(marker, ":") + 1, len(marker) - 1} {
			if got := withoutCanvasBriefing(prompt + marker[:k] + "\n[truncated]"); got != prompt {
				t.Fatalf("a cut %d bytes into the marker shows %q", k, got)
			}
		}
	}
	for _, kept := range []string{"plain words\n[truncated]", "words\n\n---\n[truncated]", "Preserve my heading:\n\n--- AwwO\n[truncated]",
		"x" + earlierTasksMarker[:strings.Index(earlierTasksMarker, ":")] + "\n[truncated]", "plain task"} {
		if got := withoutCanvasBriefing(kept); got != kept {
			t.Fatalf("%q changed to %q", kept, got)
		}
	}
}

func TestEarlierTaskFollowUpWords(t *testing.T) {
	for _, s := range []string{"继续", "接着做", "重试一下", "再来一次", "continue", "Continue please", "please retry", "try again", "go on", "刚才那个没做完"} {
		if !earlierTaskFollowUp.MatchString(s) {
			t.Fatalf("%q is a follow-up", s)
		}
	}
	// English words match whole only (Codex 2026-10-16).
	for _, s := range []string{"帮我写一份产品方案", "生成一张猫的图片", "a poster against the wall", "the product discontinues", "a retrying network client", "lastly"} {
		if earlierTaskFollowUp.MatchString(s) {
			t.Fatalf("%q is not a follow-up", s)
		}
	}
}

func TestPostgresDirectTaskReadsEarlierTasks(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "earlier-owner@awwo.invalid")
	newCanvas := func(name string) string {
		c := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": name, "document": map[string]any{"nodes": []any{}, "edges": []any{}}}, 201)
		return c["id"].(string)
	}
	cid, other := newCanvas("游戏"), newCanvas("别的画布")
	var actor string
	if err := h.db.QueryRow(ctx, "SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='owner'", tid).Scan(&actor); err != nil {
		t.Fatal(err)
	}
	stranger := randomID()
	aid := randomID()
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	mustExec("INSERT INTO users(id,email,name,password_hash) VALUES($1,'earlier-member@awwo.invalid','m','x')", stranger)
	mustExec("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", tid, stranger)
	mustExec("INSERT INTO agents(id,tenant_id,name,role,instructions,internal,runtime,model,effort) VALUES($1,$2,'Execution assistant','computer','x',true,'pi','m','')", aid, tid)
	task := func(canvas, who, status, code, prompt, output, age string) (rid, sid string) {
		t.Helper()
		rid, sid = randomID(), randomID()
		mustExec("INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title,kind) VALUES($1,$2,$3,'$computer',$4,'Execution assistant','computer')", sid, tid, canvas, aid)
		mustExec("INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,error,actor_id,created_at) VALUES($1,$2,$3,$4,'h',$5,$6,$7,$8,$9,now()-$10::interval)",
			rid, tid, sid, "op-"+rid, prompt, status, output, code, who, age)
		return rid, sid
	}
	failed, _ := task(cid, actor, "failed", "computer_execution_failed", "做一个专属游戏", "", "10 minutes")
	mustExec(`INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,'{"type":"computer_message","role":"assistant","text":"OLDER-WORDS"}')`, tid, failed)
	mustExec(`INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,'{"type":"computer_message","role":"assistant","text":"写到一半的 game.html"}')`, tid, failed)
	done, _ := task(cid, actor, "completed", "", "写一个说明文档", "说明文档写好了", "5 minutes")
	mustExec("INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content) VALUES('e-file',$1,$2,$3,'$computer','computer_x','readme.md',9,'s','README-OK')", tid, cid, done)
	task(cid, stranger, "completed", "", "STRANGER-TASK", "x", "4 minutes")
	task(other, actor, "completed", "", "OTHER-CANVAS-TASK", "x", "3 minutes")
	task(cid, actor, "completed", "", "TOO-OLD-TASK", "x", "13 hours")
	task(cid, actor, "running", "", "STILL-RUNNING-TASK", "", "2 minutes")
	current, sid := task(cid, actor, "running", "", "继续", "", "0 minutes")

	room := 1 << 20
	text := h.a.earlierTasksBriefing(ctx, tid, current, sid, "继续", room)
	i, j := strings.Index(text, `Request: "做一个专属游戏"`), strings.Index(text, `Request: "写一个说明文档"`)
	if i < 0 || j < 0 || i > j {
		t.Fatalf("the two earlier tasks must be listed oldest first:\n%s", text)
	}
	for _, want := range []string{"last 2 direct task(s)", "failed part-way", `Its last words before it ended: "写到一半的 game.html"`, `Its answer: "说明文档写好了"`,
		"readme.md (9 B)", "=== file readme.md (9 bytes) ===\nREADME-OK"} {
		if !strings.Contains(text, want) {
			t.Fatalf("earlier tasks lack %q:\n%s", want, text)
		}
	}
	for _, unwanted := range []string{"OLDER-WORDS", "STRANGER-TASK", "OTHER-CANVAS-TASK", "TOO-OLD-TASK", "STILL-RUNNING-TASK", `Request: "继续"`} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("earlier tasks show %q:\n%s", unwanted, text)
		}
	}
	if h.a.earlierTasksBriefing(ctx, tid, current, sid, "帮我写一份完全不同的产品方案，内容要详细一点，包括市场和竞品", room) == text {
		t.Fatal("a request that neither follows up nor asks for files must not get the file text")
	}
	if tight := h.a.earlierTasksBriefing(ctx, tid, current, sid, "继续", 4*(len(text)-1)); len(tight) >= len(text) || !strings.Contains(tight, `Request: "写一个说明文档"`) {
		t.Fatalf("a tighter room must give a smaller block that keeps the latest task:\n%s", tight)
	}
	if h.a.earlierTasksBriefing(ctx, tid, "missing-run", sid, "继续", room) != "" {
		t.Fatal("a run that is not found must give no block")
	}
	first, firstSID := task(newCanvas("空画布"), actor, "running", "", "第一个任务", "", "0 minutes")
	if h.a.earlierTasksBriefing(ctx, tid, first, firstSID, "继续", room) != "" {
		t.Fatal("a first task on its canvas must give no block")
	}
}

// The 2026-10-16 report end to end: a direct task fails part-way, the user types 「继续」, and the next task's prompt
// carries the first task after the user's words and before the canvas briefing, while its transcript keeps 「继续」.
func TestPostgresDirectTaskContinueCarriesTheFailedTask(t *testing.T) {
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		t.Error("no model call was expected", r.URL.Path)
		w.WriteHeader(404)
	}))
	defer trusted.Close()
	inputs := make(chan computerWorkerInput, 2)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(200)
			return
		}
		var b computerWorkerInput
		if json.NewDecoder(r.Body).Decode(&b) != nil {
			t.Error("bad task request")
		}
		inputs <- b
		w.Header().Set("Content-Type", "text/event-stream")
		user, _ := json.Marshal(map[string]string{"type": "computer_message", "role": "user", "text": b.Prompt})
		fmt.Fprintf(w, "data: %s\n\n", user)
		if strings.HasPrefix(b.Prompt, "做一个专属游戏") {
			fmt.Fprint(w, "data: {\"type\":\"computer_message\",\"role\":\"assistant\",\"text\":\"我先写 game.html 的框架\"}\n\n")
			fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n")
			return
		}
		fmt.Fprint(w, "data: {\"type\":\"completed\",\"output\":\"接着做完了\"}\n\n")
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	owner, tid, _ := h.register(t, "earlier-e2e@example.test")
	model := connectionModelID(addPersonalConnection(t, h, owner), "test-chat-model")
	canvas, _, _ := h.fixture(t, owner, tid)
	doc, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "front", "kind": "session", "title": "游戏前端", "templateId": "frontend"}}, "edges": []any{}})
	if _, err := h.db.Exec(context.Background(), "UPDATE canvases SET document=$3 WHERE tenant_id=$1 AND id=$2", tid, canvas, doc); err != nil {
		t.Fatal(err)
	}
	base := "/tenants/" + tid
	start := func(op, prompt string) string {
		t.Helper()
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": op, "prompt": prompt, "runtime": "pi", "model": model}, 202)
		return run["id"].(string)
	}
	first := start("earlier-e2e-first", "做一个专属游戏，单个 HTML 文件")
	if in := <-inputs; strings.Contains(in.Prompt, earlierTasksMarker) {
		t.Fatalf("a first task has no earlier tasks:\n%s", in.Prompt)
	}
	h.awaitRun(t, owner, tid, first, "failed")
	second := start("earlier-e2e-second", "继续")
	input := <-inputs
	h.awaitRun(t, owner, tid, second, "completed")
	if !strings.HasPrefix(input.Prompt, "继续"+earlierTasksMarker) {
		t.Fatalf("the earlier tasks must follow the user's words:\n%s", input.Prompt)
	}
	for _, want := range []string{`Request: "做一个专属游戏，单个 HTML 文件"`, "failed part-way", `Its last words before it ended: "我先写 game.html 的框架"`, earlierTasksEnd} {
		if !strings.Contains(input.Prompt, want) {
			t.Fatalf("the continued task lacks %q:\n%s", want, input.Prompt)
		}
	}
	if c := strings.Index(input.Prompt, canvasBriefingMarker); c < 0 || c < strings.Index(input.Prompt, earlierTasksEnd) {
		t.Fatalf("the canvas briefing comes after the earlier tasks:\n%s", input.Prompt)
	}
	detail := h.request(t, owner, "GET", base+"/computer-runs/"+second, nil, 200)
	messages := detail["messages"].([]any)
	if len(messages) != 1 || messages[0].(map[string]any)["text"] != "继续" {
		t.Fatalf("the transcript must show the user's words alone: %#v", messages)
	}
}

// Codex 2026-10-16: the budget counts the whole request as the client sent it, so a model call the reference blocks push
// over it goes without them; only the exact bytes of a block go, however the client escaped it.
func TestReferenceBlocksAreCutAsSent(t *testing.T) {
	block := "\n\n--- B \"q\" <&> \u2028 x\t--- end of earlier tasks --- y ---"
	// As JavaScript's JSON.stringify writes it: quotes and controls escaped, <&> and U+2028 literal.
	js := `\n\n--- B \"q\" <&> ` + "\u2028" + ` x\t--- end of earlier tasks --- y ---`
	before := `{"model":"m","messages":[{"role":"user","content":"继续 \u2028<p>`
	raw := []byte(before + js + `"},{"role":"user","content":[{"type":"text","text":"again` + js + `"}]}],"tools":[]}`)
	cut, ok := withoutReferenceBlock(raw, block)
	want := before + `"},{"role":"user","content":[{"type":"text","text":"again"}]}],"tools":[]}`
	if !ok || string(cut) != want || len(cut) != len(raw)-2*len(js) {
		t.Fatalf("both copies must go and nothing else:\n%s", cut)
	}
	if _, _, e := validateComputerCompletion(cut, 1<<20); e != nil {
		t.Fatal("the cut request must stay valid", e)
	}
	marshalled, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "user", "content": "继续" + block}}})
	plain, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "user", "content": "继续"}}})
	if cut, ok := withoutReferenceBlock(marshalled, block); !ok || string(cut) != string(plain) {
		t.Fatalf("Go's escaping must be found too:\n%s", cut)
	}
	// Left alone: after an odd run of backslashes the bytes belong to an escape (x\\n… is "x\" then "n…", not the
	// block); no copy; copies outside a message text (in a key, which the cut would merge with "role", in a tool's
	// description); and a body that is not one JSON value.
	for _, other := range []string{
		`{"messages":[{"role":"user","content":"x\` + js + `"}]}`,
		`{"messages":[{"role":"user","content":"plain"}]}`,
		`{"messages":[{"role":"user","ro` + js + `le":"system","content":"x"}]}`,
		`{"messages":[{"role":"user","content":"x"}],"tools":[{"type":"function","function":{"name":"read","description":"` + js + `"}}]}`,
		`{"messages":[{"role":"user","content":"x"}]}` + js,
	} {
		if _, ok := withoutReferenceBlock([]byte(other), block); ok {
			t.Fatalf("%s must be left alone", other)
		}
	}
	if _, ok := withoutReferenceBlock(raw, ""); ok {
		t.Fatal("an empty block cuts nothing")
	}
	// Codex round 5: the tool-schema keys "\ud800" and "\ud801" both read as U+FFFD in Go; the copy in the first one's
	// description stays, only the message copy goes.
	schema := `{"messages":[{"role":"user","content":"x` + js + `"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object","properties":{"\ud800":{"type":"string","description":"` + js + `"},"\ud801":{"type":"string"}}}}}]}`
	if cut, ok := withoutReferenceBlock([]byte(schema), block); !ok || string(cut) != strings.Replace(schema, js, "", 1) {
		t.Fatalf("only the message copy may go:\n%s", cut)
	}
}

func TestMessageTextSpansReadOnlyMessageTexts(t *testing.T) {
	raw := `{"model":"m","messages":[{"role":"system","content":"S"},{"role":"user","content":[{"type":"text","text":"P1"},{"type":"image","url":"u"},` +
		`{"text":"P2","extra":{"text":"no"}}]},{"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"read","arguments":"{\"content\":\"no\"}"}}]},` +
		`{"role":"tool","tool_call_id":"a","Content":"no","content" : "T"}],"content":"no","tools":[{"type":"function","function":{"name":"read","description":"no",` +
		`"parameters":{"type":"object","properties":{"text":{"type":"string","description":"no"}}}}}]}`
	spans, ok := messageTextSpans([]byte(raw))
	var got []string
	for _, span := range spans {
		got = append(got, raw[span[0]:span[1]])
	}
	if !ok || strings.Join(got, ",") != "S,P1,P2,T" {
		t.Fatalf("message texts are %q (%v)", got, ok)
	}
	for _, bad := range []string{`[]`, `{"messages":[]} x`, `{"messages":[`, `"x"`, ``} {
		if _, ok := messageTextSpans([]byte(bad)); ok {
			t.Fatalf("%q is not one JSON object", bad)
		}
	}
}

func computerProxyRaw(t *testing.T, input computerWorkerInput, raw []byte, status int) {
	t.Helper()
	req, _ := http.NewRequest("POST", input.ModelProxyURL+"/chat/completions", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+input.ModelProxyToken)
	req.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Fatalf("proxy status %d want %d: %s", resp.StatusCode, status, data)
	}
}

func TestPostgresComputerCallGoesWithoutReferenceBlocksOverBudget(t *testing.T) {
	sent := make(chan string, 8)
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
		if json.NewDecoder(r.Body).Decode(&b) != nil || len(b.Completion.Messages) != 1 {
			t.Error("bad model call")
		} else {
			sent <- b.Completion.Messages[0].Content
		}
		writeJSON(w, 200, map[string]any{"completion": map[string]any{"id": "one", "choices": []map[string]any{{"index": 0, "message": map[string]string{"role": "assistant", "content": "OK"}, "finish_reason": "stop"}}}, "observability": json.RawMessage(observationFixture(1, 1))})
	}))
	defer trusted.Close()
	started := make(chan computerWorkerInput, 2)
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
		if !strings.HasPrefix(input.Prompt, "继续") {
			fmt.Fprint(w, "data: {\"type\":\"failed\",\"code\":\"CORE_EXECUTION_FAILED\"}\n\n")
			return
		}
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
	owner, tid, _ := h.register(t, "computer-blocks@example.test")
	model := connectionModelID(addPersonalConnection(t, h, owner), "test-chat-model")
	canvas, _, _ := h.fixture(t, owner, tid)
	doc, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "front", "kind": "session", "title": "游戏前端", "templateId": "frontend"}}, "edges": []any{}})
	if _, err := h.db.Exec(context.Background(), "UPDATE canvases SET document=$3 WHERE tenant_id=$1 AND id=$2", tid, canvas, doc); err != nil {
		t.Fatal(err)
	}
	base := "/tenants/" + tid
	start := func(op, prompt string) string {
		t.Helper()
		run := h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]any{"operationId": op, "prompt": prompt, "runtime": "pi", "model": model}, 202)
		return run["id"].(string)
	}
	h.awaitRun(t, owner, tid, start("blocks-first", "做一个专属游戏"), "failed")
	second := start("blocks-second", "继续")
	input := <-started
	at := strings.Index(input.Prompt, canvasBriefingMarker)
	if at < 0 || !strings.HasPrefix(input.Prompt, "继续"+earlierTasksMarker) {
		t.Fatalf("the task must carry both blocks:\n%s", input.Prompt)
	}
	earlier, canvasBlock := input.Prompt[len("继续"):at], input.Prompt[at:]
	request := func(content string) []byte {
		var b bytes.Buffer
		encoder := json.NewEncoder(&b)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(map[string]any{"messages": []map[string]string{{"role": "user", "content": content}}})
		return bytes.TrimRight(b.Bytes(), "\n")
	}
	const budget = 28416 // the personal connection model's (connections.go)
	k, e, c := len(request("继续")), len(request("继续"+earlier))-len(request("继续")), len(request("继续"+canvasBlock))-len(request("继续"))
	if e < 500 || c < 500 {
		t.Fatalf("the blocks are too small for these steps: %d and %d bytes", e, c)
	}
	both := func(words string) string { return words + earlier + canvasBlock }
	canvasOnly := func(words string) string { return words + canvasBlock }
	// The worker counts the call's JSON plus 32 bytes a message against the same budget: with one message and no tool,
	// the proxy cuts from 288 bytes below it.
	for _, step := range []struct {
		pad    int
		status int
		want   func(words string) string
	}{
		{budget - k - e - c - 400, 200, both},                                   // fits with both, here and in the worker
		{budget - k - e - c - 100, 200, canvasOnly},                             // fits here, not in the worker: without the earlier tasks
		{budget - k - e - c + 100, 200, canvasOnly},                             // over the budget: without the earlier tasks
		{budget - k - c + 100, 200, func(words string) string { return words }}, // still over: without either
		{budget - k + 64, 400, nil},                                             // too large without them
	} {
		words := "继续" + strings.Repeat("a", step.pad)
		computerProxyRaw(t, input, request(words+earlier+canvasBlock), step.status)
		if step.want == nil {
			continue
		}
		if got := <-sent; got != step.want(words) {
			t.Fatalf("pad %d: the model got %d bytes, not the expected %d", step.pad, len(got), len(step.want(words)))
		}
	}
	// A body past the read limit is refused whole, even when a valid prefix would fit without the blocks.
	big := append(request("继续"+earlier+canvasBlock), bytes.Repeat([]byte(" "), 512<<10)...)
	computerProxyRaw(t, input, append(big, "not-json"...), 400)
	select {
	case got := <-sent:
		t.Fatalf("an over-limit body reached the model (%d bytes)", len(got))
	default:
	}
	h.request(t, owner, "POST", base+"/runs/"+second+"/cancel", map[string]any{}, 200)
}

// Codex 2026-10-16: a call the proxy admits must also pass the worker, which counts the call's JSON plus 32 bytes a
// message against the budget and reads at most 512 KiB of the body the proxy sends (with Go's HTML escaping).
func TestComputerCallFitsTheWorker(t *testing.T) {
	lease := &computerLease{tenantID: "t", runID: "r", sessionID: "s", snapshot: executionSnapshot{Model: "m", Budget: 1 << 20}}
	call := func(content string) ([]byte, map[string]json.RawMessage) {
		t.Helper()
		var b bytes.Buffer
		encoder := json.NewEncoder(&b)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(map[string]any{"messages": []map[string]string{{"role": "user", "content": content}}})
		raw := bytes.TrimRight(b.Bytes(), "\n")
		completion, _, e := validateComputerCompletion(raw, 1<<20)
		if e != nil {
			t.Fatal(e)
		}
		return raw, completion
	}
	raw, completion := call(strings.Repeat("a", 1000))
	if !computerCallFits(raw, completion, lease) {
		t.Fatal("a small call fits")
	}
	lease.snapshot.Budget = len(raw) + 287
	if computerCallFits(raw, completion, lease) {
		t.Fatal("the worker's 32 bytes a message (and a margin) count against the budget")
	}
	lease.snapshot.Budget = len(raw) + 288
	if !computerCallFits(raw, completion, lease) {
		t.Fatal("a call within the estimate fits")
	}
	lease.snapshot.Budget = 1 << 20
	raw, completion = call(strings.Repeat("<", 100<<10))
	if len(raw) > 512<<10 || computerCallFits(raw, completion, lease) {
		t.Fatal("100 KiB of '<' is 600 KiB on the way to the worker, over what it reads")
	}
}

// Codex 2026-10-16: the task's start is sent with Go's HTML escaping and the broker reads at most 512 KiB of it, so the
// reference blocks must not push a start that fits without them over that limit.
func TestComputerStartFitsTheBrokersReadLimit(t *testing.T) {
	payload := map[string]any{"runId": "r", "instructions": "i"}
	small, big := earlierTasksMarker+"E"+earlierTasksEnd, strings.Repeat("<", 3000)
	for _, c := range []struct {
		words  string
		blocks []string
		kept   int
	}{
		{"继续", []string{small, canvasBriefingMarker + "C" + canvasBriefingEnd}, 2},
		// 85,000 '<' are 510,000 bytes as Go writes them: a 2,500-'<' block more is over 512 KiB, a small one is not.
		{strings.Repeat("<", 85000), []string{earlierTasksMarker + strings.Repeat("<", 2500) + earlierTasksEnd, canvasBriefingMarker + "C" + canvasBriefingEnd}, 1},
		{strings.Repeat("<", 85000), []string{small, canvasBriefingMarker + big + canvasBriefingEnd}, 0},               // the earlier tasks go first
		{strings.Repeat("<", 88000), []string{small}, 0},                                                               // too large alone: sent as before
		{strings.Repeat("a", 250<<10), []string{earlierTasksMarker + strings.Repeat("e", 8<<10) + earlierTasksEnd}, 0}, // over the 256 KiB prompt
	} {
		kept := fitComputerStart(payload, c.words, c.blocks)
		if len(kept) != c.kept || payload["prompt"] != c.words+strings.Join(c.blocks[len(c.blocks)-c.kept:], "") {
			t.Fatalf("%d bytes of words: kept %d blocks, want %d", len(c.words), len(kept), c.kept)
		}
		if raw, _ := json.Marshal(payload); c.kept > 0 && len(raw) > computerTaskBodyLimit {
			t.Fatalf("the start is %d bytes", len(raw))
		}
	}
}
