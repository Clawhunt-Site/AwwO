package app

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
)

type assembleVector struct {
	Name     string            `json:"name"`
	Template string            `json:"template"`
	Values   map[string]string `json:"values"`
	Output   *string           `json:"output"`
	Error    string            `json:"error"`
}

func TestAssembleVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/assemble_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []assembleVector `json:"vectors"`
	}
	if err = json.Unmarshal(raw, &file); err != nil || len(file.Vectors) < 10 {
		t.Fatal("vectors unreadable", err)
	}
	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			got, err := assembleTemplate(v.Template, v.Values)
			if v.Error != "" {
				if err == nil || err.Error() != v.Error {
					t.Fatalf("want error %q, got %q / %v", v.Error, got, err)
				}
				return
			}
			if err != nil || v.Output == nil || got != *v.Output {
				t.Fatalf("got %q (%v), want %q", got, err, deref(v.Output))
			}
		})
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func assembleTestNode(template string, outputs ...graphField) graphNode {
	if len(outputs) == 0 {
		outputs = []graphField{{ID: "result", Type: "html", Required: true}}
	}
	return graphNode{ID: "page", Kind: "assemble", Title: "Page", Template: template, Contract: &graphContract{Version: 1,
		Inputs:  []graphField{{ID: "a", Label: "Module A", Type: "text", Required: true}, {ID: "b", Label: "Module B", Type: "text"}},
		Outputs: outputs}}
}

func TestValidateAssembleNode(t *testing.T) {
	page := "<!DOCTYPE html><html><head></head><body><script>{{in:a}}{{in:b}}</script></body></html>"
	if err := validateAssembleNode(assembleTestNode(page)); err != nil {
		t.Fatal(err)
	}
	both := assembleTestNode(page, graphField{ID: "result", Type: "html", Required: true}, graphField{ID: "file", Type: "file", Required: true})
	if err := validateAssembleNode(both); err != nil {
		t.Fatal(err)
	}
	bad := map[string]graphNode{
		"no contract":       {ID: "page", Kind: "assemble", Template: page},
		"no outputs":        assembleTestNode(page, []graphField{}...),
		"two text outputs":  assembleTestNode(page, graphField{ID: "x", Type: "html"}, graphField{ID: "y", Type: "markdown"}),
		"number output":     assembleTestNode(page, graphField{ID: "x", Type: "number"}),
		"empty template":    assembleTestNode("  \n "),
		"unknown slot":      assembleTestNode(page + "{{in:c}}"),
		"oversize template": assembleTestNode(strings.Repeat("x", maxAssembleTemplateBytes+1)),
	}
	bad["no outputs"].Contract.Outputs = nil
	fileInput := assembleTestNode(page)
	fileInput.Contract.Inputs[1].Type = "file"
	bad["file input"] = fileInput
	badName := assembleTestNode(page, graphField{ID: "file", Type: "file", Required: true})
	badName.FileName = "../index.html"
	bad["path file name"] = badName
	for name, n := range bad {
		if err := validateAssembleNode(n); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseGraphAssembleNode(t *testing.T) {
	page := assembleTestNode("<!DOCTYPE html><html><head></head><body>{{in:a}}</body></html>")
	form := graphNode{ID: "brief", Kind: "form", Fields: []struct {
		ID    string `json:"id"`
		Label string `json:"label"`
		Value string `json:"value"`
	}{{ID: "f", Label: "Body", Value: "<p>hi</p>"}}}
	d := graphDocument{Nodes: []graphNode{form, page}, Edges: []graphEdge{{ID: "e", FromNode: "brief", FromPort: "data", ToNode: "page", ToPort: "in:a", DataType: "text"}}}
	raw, _ := json.Marshal(d)
	if _, _, err := parseGraph(raw, nil); err != nil {
		t.Fatal(err)
	}
	// An unwired required input with no value is refused at admission, like a session node's.
	d.Edges = nil
	raw, _ = json.Marshal(d)
	if _, _, err := parseGraph(raw, nil); err == nil || !strings.Contains(err.Error(), "Required input/output a is empty") {
		t.Fatal("accepted an empty required input", err)
	}
	d.Nodes[1].Contract.Inputs[0].Value = "<p>typed</p>"
	raw, _ = json.Marshal(d)
	if _, _, err := parseGraph(raw, nil); err != nil {
		t.Fatal(err)
	}
	out, err := assembleInputValues(d.Nodes[1], d, map[string]string{})
	if err != nil || out["a"] != "<p>typed</p>" || out["b"] != "" {
		t.Fatal(out, err)
	}
}

func TestAssembleInputValuesReadUpstreamDeliveries(t *testing.T) {
	page := assembleTestNode("<!DOCTYPE html><html><head></head><body><script>{{in:a}}\n{{in:b}}</script></body></html>")
	contracted := graphNode{ID: "mod-a", Kind: "session", Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "code", Type: "text", Required: true}, {ID: "notes", Type: "markdown"}}}}
	plain := graphNode{ID: "mod-b", Kind: "session"}
	d := graphDocument{Nodes: []graphNode{contracted, plain, page}, Edges: []graphEdge{
		{ID: "a", FromNode: "mod-a", FromPort: "out:code", ToNode: "page", ToPort: "in:a", DataType: "text"},
		{ID: "b", FromNode: "mod-b", FromPort: "result", ToNode: "page", ToPort: "in:b", DataType: "text"},
	}}
	outputs := map[string]string{
		"mod-a": `{"code":"const A = '</script>';","notes":"ignored"}`,
		"mod-b": "<think>planning</think>```js\nboot(A);\n```",
	}
	values, err := assembleInputValues(page, d, outputs)
	if err != nil {
		t.Fatal(err)
	}
	if values["a"] != "const A = '</script>';" || values["b"] != "```js\nboot(A);\n```" {
		t.Fatalf("%q", values)
	}
	got, err := assembleTemplate(page.Template, values)
	want := "<!DOCTYPE html><html><head></head><body><script>const A = '<\\/script>';\nboot(A);</script></body></html>"
	if err != nil || got != want {
		t.Fatalf("got %q (%v)", got, err)
	}
	if !completeHTMLDocument(got) {
		t.Fatal("assembled page is not a complete document")
	}
	// An optional upstream field that came back empty cannot fill a required slot.
	d.Edges[0].FromPort = "out:notes"
	outputs["mod-a"] = `{"code":"x","notes":"   "}`
	if _, err = assembleInputValues(page, d, outputs); err == nil || !strings.Contains(err.Error(), "Module A received nothing") {
		t.Fatal("an empty upstream field filled a required slot", err)
	}
}

// A canvas run: two model nodes deliver modules, the assemble node makes the page and its file without a model call,
// and a reviewer downstream receives the page exactly as assembled.
func TestPostgresGraphAssembleNodeRunsWithoutModel(t *testing.T) {
	var mu sync.Mutex
	prompts := map[string]string{}
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasPrefix(b.Prompt, "【工作流节点】engine"):
			prompts["engine"] = b.Prompt
			completePi(w, "```javascript\nconst Engine = { start(){ document.body.dataset.ready = '</script>'; } };\n```")
		case strings.HasPrefix(b.Prompt, "【工作流节点】boot"):
			prompts["boot"] = b.Prompt
			completePi(w, "Engine.start();")
		case strings.HasPrefix(b.Prompt, "【工作流节点】review"):
			prompts["review"] = b.Prompt
			completePi(w, "Reviewed.")
		default:
			t.Errorf("unexpected model call: %.80s", b.Prompt)
			completePi(w, "?")
		}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, uid := h.register(t, "assemble@example.test")
	prefix := "/tenants/" + tid
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Builder", "adapterType": "pi", "model": "test-model", "instructions": "Build."}, 201)["id"].(string)
	binding := map[string]string{"companyId": tid, "agentId": agent}
	module := func(id string) map[string]any {
		return map[string]any{"id": id, "kind": "session", "title": id, "runtime": "pi", "agentKind": "llm", "binding": binding,
			"contract": graphContract{Version: 1, Outputs: []graphField{{ID: "code", Label: "Code", Type: "text", Required: true}}}}
	}
	template := "<!DOCTYPE html><html><head><title>T</title></head><body><script>{{in:engine}}\n{{in:boot}}</script></body></html>"
	page := map[string]any{"id": "page", "kind": "assemble", "title": "Page", "template": template, "fileName": "game.html",
		"contract": graphContract{Version: 1,
			Inputs:  []graphField{{ID: "engine", Label: "Engine", Type: "text", Required: true}, {ID: "boot", Label: "Boot", Type: "text", Required: true}},
			Outputs: []graphField{{ID: "result", Label: "Page", Type: "html", Required: true}, {ID: "file", Label: "Page file", Type: "file", Required: true}}}}
	review := map[string]any{"id": "review", "kind": "session", "title": "review", "runtime": "pi", "agentKind": "llm", "binding": binding}
	doc := map[string]any{"nodes": []any{module("engine"), module("boot"), page, review}, "edges": []map[string]string{
		{"id": "e1", "fromNode": "engine", "fromPort": "out:code", "toNode": "page", "toPort": "in:engine", "dataType": "text"},
		{"id": "e2", "fromNode": "boot", "fromPort": "out:code", "toNode": "page", "toPort": "in:boot", "dataType": "text"},
		{"id": "e3", "fromNode": "page", "fromPort": "out:result", "toNode": "review", "toPort": "context", "dataType": "text"},
	}}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Assemble", "document": doc}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "assemble-operation", "documentVersion": 1}, 202)["id"].(string)
	done := awaitGraph(t, h, c, base+"/"+gid, "completed")
	want := "<!DOCTYPE html><html><head><title>T</title></head><body><script>const Engine = { start(){ document.body.dataset.ready = '<\\/script>'; } };\nEngine.start();</script></body></html>"
	var recorded string
	for _, raw := range done["nodes"].([]any) {
		n := raw.(map[string]any)
		if n["state"] != "done" {
			t.Fatalf("node not done: %v", n)
		}
		if n["nodeId"] == "page" {
			recorded, _ = n["output"].(string)
			if n["runId"] != nil || n["sessionId"] != nil {
				t.Fatalf("assemble node ran something: %v", n)
			}
		}
	}
	var object map[string]string
	if err := json.Unmarshal([]byte(recorded), &object); err != nil || object["result"] != want || !strings.HasPrefix(object["file"], artifactRefPrefix) {
		t.Fatalf("page output %q (%v)", recorded, err)
	}
	var name string
	var content []byte
	ctx := context.Background()
	if err := h.db.QueryRow(ctx, "SELECT name,content FROM artifacts WHERE tenant_id=$1 AND id=$2 AND node_id='page' AND field_id='file'", tid, strings.TrimPrefix(object["file"], artifactRefPrefix)).Scan(&name, &content); err != nil || name != "game.html" || string(content) != want {
		t.Fatalf("page file %q %q %v", name, content, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(prompts) != 3 || !strings.Contains(prompts["review"], want) {
		t.Fatalf("review did not receive the assembled page: %d calls, %.400s", len(prompts), prompts["review"])
	}
	var invocations int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1", tid).Scan(&invocations); err != nil || invocations != 3 {
		t.Fatalf("runs %d %v", invocations, err)
	}
	// A node with a file input wired from the page's file output (a sandbox node's /inputs) receives the stored
	// page byte for byte, with its provenance.
	var pageNode graphNode
	pageRaw, _ := json.Marshal(page)
	if err := json.Unmarshal(pageRaw, &pageNode); err != nil {
		t.Fatal(err)
	}
	consumer := graphNode{ID: "test", Kind: "session", Contract: &graphContract{Version: 1, Inputs: []graphField{{ID: "page", Type: "file", Required: true}}}}
	wired, _ := json.Marshal(graphDocument{Nodes: []graphNode{pageNode, consumer}, Edges: []graphEdge{{ID: "page-file", FromNode: "page", FromPort: "out:file", ToNode: "test", ToPort: "in:page", DataType: "file"}}})
	fid := randomID()
	if _, err := h.db.Exec(ctx, `INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES($1,$2,$3,$4,$1,'test',0,$5,'[]','completed')`, fid, tid, cid, uid, wired); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, `INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,output) VALUES($1,$2,'page',0,'done',$3)`, tid, fid, recorded); err != nil {
		t.Fatal(err)
	}
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	files, err := materializeWorkspaceInputs(ctx, tx, tid, fid, "test")
	if err != nil || len(files) != 1 || files[0].SourceNodeID != "page" || files[0].FieldID != "file" || !strings.HasSuffix(files[0].Name, "-game.html") {
		t.Fatalf("workspace inputs %+v %v", files, err)
	}
	if data, err := workspaceFileBytes(files[0]); err != nil || string(data) != want {
		t.Fatalf("the sandbox would get %q %v", data, err)
	}
}
