package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func briefingContract(fields ...graphField) *struct {
	Outputs []graphField `json:"outputs"`
} {
	return &struct {
		Outputs []graphField `json:"outputs"`
	}{Outputs: fields}
}

func briefingOutput(text string) *struct {
	Text    string `json:"text"`
	Partial bool   `json:"partial"`
} {
	return &struct {
		Text    string `json:"text"`
		Partial bool   `json:"partial"`
	}{Text: text}
}

// The canvas of the 2026-10-11 report, reduced: four components, the third refused for its delivery format, the
// fourth blocked behind it, and the third's page from an earlier run stored as a file.
func reportedCanvasFacts() canvasBriefingFacts {
	at := time.Date(2026, 10, 11, 14, 54, 34, 0, time.UTC)
	return canvasBriefingFacts{
		Name: "模仿steam游戏《倾听画语》制作一个可交互的解谜游戏",
		Nodes: []briefingNode{
			{ID: "need", Kind: "session", Title: "房间解谜游戏需求", TemplateID: "general",
				Contract:   briefingContract(graphField{ID: "result", Label: "交付结果", Type: "markdown"}, graphField{ID: "followups", Label: "待确认", Type: "markdown"}),
				LastOutput: briefingOutput(`{"result":"完成内容：\n1. 交付位置：/workspace/output/index.html","followups":"待确认问题：无"}`)},
			{ID: "engine", Kind: "session", Title: "游戏引擎与逻辑系统", TemplateID: "backend"},
			{ID: "front", Kind: "session", Title: "3D游戏前端实现", TemplateID: "frontend",
				Contract:   briefingContract(graphField{ID: "delivery", Label: "界面与交付说明", Type: "markdown"}, graphField{ID: "preview", Label: "预览入口", Type: "file"}),
				LastOutput: briefingOutput(`{"delivery":"实现页面：解谜游戏","preview":"` + artifactRefPrefix + `a_file"}`)},
			{ID: "review", Kind: "session", Title: "游戏验收", TemplateID: "review"},
		},
		Run: &briefingRun{Status: "failed", At: at, Nodes: map[string]briefingRunNode{
			"need": {State: "done"}, "engine": {State: "done"},
			"front":  {State: "failed", Detail: "Output must be a JSON object keyed by output field IDs"},
			"review": {State: "blocked", Detail: "Upstream did not complete"},
		}},
		Files: []briefingFile{{NodeID: "front", FieldID: "preview", Name: "index.html", Size: 31, At: at.Add(-5 * time.Hour),
			Content: []byte("<!doctype html><html></html>\n")}},
	}
}

func TestCanvasBriefingSaysWhatFailedAndWhereTheDeliveriesAre(t *testing.T) {
	text := renderCanvasBriefing(reportedCanvasFacts(), true)
	for _, want := range []string{
		canvasBriefingMarker, canvasBriefingEnd, "模仿steam游戏《倾听画语》制作一个可交互的解谜游戏", "4 component(s)",
		"(such as /workspace/output/index.html) does not exist", "Results view (成果)", "重新运行失败的节点",
		"Latest canvas run (2026-10-11 14:54 UTC): failed (2 done, 1 failed, 1 blocked).",
		`3. "3D游戏前端实现" (frontend): failed - the run finished, but its answer was not in the component's delivery format`,
		`4. "游戏验收" (review): blocked - an earlier component it depends on did not complete.`,
		`交付结果: "完成内容： 1. 交付位置：/workspace/output/index.html"`, "预览入口: (a delivered file)",
		"Delivered files: index.html (31 B, 2026-10-11 09:54 UTC).",
		"=== file 3D游戏前端实现/index.html (29 bytes) ===\n<!doctype html><html></html>\n\n=== end of file ===",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("briefing lacks %q:\n%s", want, text)
		}
	}
	// A request that is not about deliverables gets their names only.
	names := renderCanvasBriefing(reportedCanvasFacts(), false)
	if strings.Contains(names, "<!doctype html>") || !strings.Contains(names, "File contents are not included") || !strings.Contains(names, "index.html (31 B") {
		t.Fatalf("names-only briefing:\n%s", names)
	}
	if !briefingWantsFiles.MatchString("你找找有没其它目录") || !briefingWantsFiles.MatchString("画布的最后一个节点运行失败了") ||
		!briefingWantsFiles.MatchString("where is the output folder") || briefingWantsFiles.MatchString("写一首关于秋天的诗") {
		t.Fatal("the request test does not tell deliverable questions apart")
	}
}

func TestCanvasBriefingStaysBounded(t *testing.T) {
	facts := reportedCanvasFacts()
	facts.Nodes = nil
	for i := 0; i < briefingMaxNodes+6; i++ {
		facts.Nodes = append(facts.Nodes, briefingNode{ID: fmt.Sprintf("n%d", i), Kind: "session", Title: strings.Repeat("长", 300),
			Contract: briefingContract(graphField{ID: "result", Type: "markdown"}), LastOutput: briefingOutput(`{"result":"` + strings.Repeat("字", 5000) + `"}`)})
	}
	big := make([]byte, briefingInlineBytes+1)
	for i := range big {
		big[i] = 'x'
	}
	facts.Files = append(facts.Files, briefingFile{NodeID: "n0", FieldID: "page", Name: "big.html", Size: len(big), At: time.Now(), Content: big},
		briefingFile{NodeID: "n1", FieldID: "img", Name: "cover.png", Size: 9, At: time.Now(), Content: []byte("\x89PNG\r\n\x1a\n\x00")})
	text := renderCanvasBriefing(facts, true)
	if len(text) > briefingMaxBytes || !strings.HasSuffix(text, canvasBriefingEnd) {
		t.Fatalf("briefing is %d bytes (bound %d) or lost its end", len(text), briefingMaxBytes)
	}
	if !strings.Contains(text, "(6 more component(s) not listed.)") || strings.Contains(text, strings.Repeat("x", 100)) || strings.Contains(text, "PNG") ||
		!strings.Contains(text, "Other delivered files are not shown here") {
		t.Fatalf("bounds not applied:\n%s", clipRunes(text, 2000))
	}
}

// The managed-execution worker refuses a prompt holding a NUL, which fails the whole task: a stored text file with a
// control byte is named, never inlined (Codex 2026-10-16).
func TestCanvasBriefingInlinesOnlyCleanText(t *testing.T) {
	facts := reportedCanvasFacts()
	at := facts.Files[0].At
	facts.Files = append([]briefingFile{
		{NodeID: "front", FieldID: "data", Name: "data.json", Size: 3, At: at, Content: []byte("{\x00}")},
		{NodeID: "front", FieldID: "log", Name: "log.txt", Size: 4, At: at, Content: []byte("a\x1bb\n")},
	}, facts.Files...)
	text := renderCanvasBriefing(facts, true)
	if strings.ContainsAny(text, "\x00\x1b") || strings.Count(text, "=== file ") != 1 || !strings.Contains(text, "=== file 3D游戏前端实现/index.html (") ||
		!strings.Contains(text, "Other delivered files are not shown here") {
		t.Fatalf("only clean text files may be inlined:\n%q", text)
	}
	for _, f := range []briefingFile{{Name: "a.md", Content: []byte("x\ty\r\n")}, {Name: "a.md", Content: []byte{}}} {
		if !inlineableText(f) {
			t.Fatalf("%q is clean text", f.Content)
		}
	}
	for _, f := range []briefingFile{{Name: "a.md"}, {Name: "a.md", Content: []byte("a\x00")}, {Name: "a.md", Content: []byte("a\x7f")},
		{Name: "a.md", Content: []byte{0xc3}}, {Name: "a.bin", Content: []byte("text")}} {
		if inlineableText(f) {
			t.Fatalf("%s %q must not be inlined", f.Name, f.Content)
		}
	}
}

func TestDirectTaskTranscriptKeepsTheUsersWords(t *testing.T) {
	prompt := "画布的最后一个节点运行失败了"
	if got := withoutCanvasBriefing(prompt + renderCanvasBriefing(reportedCanvasFacts(), true)); got != prompt {
		t.Fatalf("transcript shows %q", got)
	}
	if withoutCanvasBriefing("plain task") != "plain task" {
		t.Fatal("a task without a briefing changed")
	}
}

func TestPostgresDirectTaskReadsItsCanvas(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "briefing-owner@awwo.invalid")
	canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "解谜游戏",
		"document": map[string]any{"nodes": []any{map[string]any{"id": "form", "kind": "form", "fields": []any{}}}, "edges": []any{}}}, 201)
	cid := canvas["id"].(string)
	doc, _ := json.Marshal(map[string]any{"nodes": []any{
		map[string]any{"id": "front", "kind": "session", "title": "3D游戏前端实现", "templateId": "frontend",
			"contract":   map[string]any{"version": 1, "inputs": []any{}, "outputs": []any{map[string]any{"id": "delivery", "label": "交付说明", "type": "markdown", "required": true}}},
			"lastOutput": map[string]any{"text": `{"delivery":"实现页面：解谜游戏"}`, "at": 1}},
		map[string]any{"id": "note", "kind": "form", "fields": []any{}},
	}, "edges": []any{}})
	if _, err := h.db.Exec(ctx, "UPDATE canvases SET document=$3 WHERE tenant_id=$1 AND id=$2", tid, cid, doc); err != nil {
		t.Fatal(err)
	}
	var actor string
	if err := h.db.QueryRow(ctx, "SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='owner'", tid).Scan(&actor); err != nil {
		t.Fatal(err)
	}
	sid, aid := randomID(), randomID()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO agents(id,tenant_id,name,role,instructions,internal,runtime,model,effort) VALUES($1,$2,'Execution assistant','computer','x',true,'pi','m','')", []any{aid, tid}},
		{"INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title,kind) VALUES($1,$2,$3,'$computer',$4,'Execution assistant','computer')", []any{sid, tid, cid, aid}},
		{"INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status,created_at) VALUES('g-old',$1,$2,$3,'op-old','h',1,'{}','[]','completed',now()-interval '1 hour')", []any{tid, cid, actor}},
		{"INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES('g-new',$1,$2,$3,'op-new','h',1,'{}','[]','failed')", []any{tid, cid, actor}},
		{"INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,detail) VALUES($1,'g-new','front',0,'failed','Output must be a JSON object keyed by output field IDs')", []any{tid}},
		{"INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state) VALUES($1,'g-old','front',0,'done')", []any{tid}},
		{"INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,created_at) VALUES('f-old',$1,$2,'','front','preview','index.html',9,'s','OLD-PAGE.',now()-interval '1 hour')", []any{tid, cid}},
		{"INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content) VALUES('f-new',$1,$2,'','front','preview','index.html',9,'s','NEW-PAGE.')", []any{tid, cid}},
		{"INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content) VALUES('f-task',$1,$2,'','$computer','workspace','own.md',9,'s','TASK-FILE')", []any{tid, cid}},
	} {
		if _, err := h.db.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(statement.sql, err)
		}
	}
	text := h.a.canvasBriefing(ctx, tid, sid, "游戏文件在哪个目录")
	for _, want := range []string{`"解谜游戏"`, "1 component(s)", "): failed (1 failed).", `1. "3D游戏前端实现" (frontend): failed - the run finished`,
		`交付说明: "实现页面：解谜游戏"`, "=== file 3D游戏前端实现/index.html (9 bytes) ===\nNEW-PAGE."} {
		if !strings.Contains(text, want) {
			t.Fatalf("briefing lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "OLD-PAGE") || strings.Contains(text, "TASK-FILE") || strings.Contains(text, `"note"`) {
		t.Fatalf("briefing shows a superseded file, a task's own file or a non-agent node:\n%s", text)
	}
	if h.a.canvasBriefing(ctx, tid, "missing-session", "x") != "" {
		t.Fatal("a session that is not found must give no briefing")
	}
}
