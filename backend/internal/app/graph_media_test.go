package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func mediaDraftNode(id, model, draft string) map[string]any {
	node := mediaNode(id, "image", model, nil)
	node["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": draft, "createdAt": 0}}
	return node
}

// A canvas run generates its image nodes: each from its own prompt followed by the text wired into its context, in
// the run's order, on the same allowance a Send spends, and publishes the generation's record as the node's delivery.
func TestPostgresGraphRunGeneratesMediaNodes(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-graph@example.test")
	base := "/tenants/" + tid
	brief := map[string]any{"id": "brief", "kind": "form", "title": "Brief", "fields": []any{map[string]any{"id": "f1", "label": "主题", "value": "a red bicycle on a beach at sunset"}}}
	doc := map[string]any{
		"nodes": []any{brief, mediaDraftNode("img", "rh.seedream-v5-pro", "poster style, warm light"), mediaDraftNode("img2", "rh.seedream-v5-pro", "a matching banner, same palette")},
		"edges": []any{
			map[string]any{"id": "b-i", "fromNode": "brief", "fromPort": "data", "toNode": "img", "toPort": "context", "dataType": "text"},
			// A reference image orders the run; the picture itself is not sent to the provider.
			map[string]any{"id": "i-i2", "fromNode": "img", "fromPort": "result", "toNode": "img2", "toPort": "reference", "dataType": "image"},
		},
	}
	v := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Media graph", "document": doc}, 201)
	cid := v["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	done := awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "completed", 15*time.Second)
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("generations submitted", submits)
	}
	if got := rh.submission(0).body["prompt"]; got != "poster style, warm light\n\n主题: a red bicycle on a beach at sunset" {
		t.Fatalf("first generation's prompt %q", got)
	}
	if got := rh.submission(1).body["prompt"]; got != "a matching banner, same palette" {
		t.Fatalf("second generation's prompt %q", got)
	}
	for _, raw := range done["nodes"].([]any) {
		n := raw.(map[string]any)
		if n["nodeId"] == "brief" {
			continue
		}
		var out mediaOutput
		if n["state"] != "done" || json.Unmarshal([]byte(n["output"].(string)), &out) != nil || out.Type != mediaOutputType || out.Kind != "image" || len(out.Items) != 1 {
			t.Fatalf("media node delivery %v", n)
		}
		var operation string
		if e := h.db.QueryRow(t.Context(), "SELECT operation_id FROM runs WHERE tenant_id=$1 AND id=$2", tid, n["runId"]).Scan(&operation); e != nil || !strings.HasPrefix(operation, "graph:") {
			t.Fatal("generation run", operation, e)
		}
	}
	var generations int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM media_generations WHERE tenant_id=$1 AND provider_accepted", tid).Scan(&generations); e != nil || generations != 2 {
		t.Fatal("generations recorded", generations, e)
	}

	// The same daily allowance a Send spends: a run past it fails the node at its turn and pays for nothing.
	h.a.cfg.MediaRunsPerDay = 2
	graph = h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"], "scope": []string{"img"}}, 202)
	done = awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "failed")
	for _, raw := range done["nodes"].([]any) {
		if n := raw.(map[string]any); n["nodeId"] == "img" && (n["state"] != "failed" || n["detail"] != "media_quota_exceeded") {
			t.Fatal("generation past the daily allowance", n)
		}
	}
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("paid past the daily allowance", submits)
	}
}

func TestGraphMediaDraftReadsTheActiveConversation(t *testing.T) {
	var n graphNode
	if e := json.Unmarshal([]byte(`{"id":"m","kind":"session","agentKind":"image","activeThreadId":"t2","threads":[{"id":"default","draft":"old"},{"id":"t2","draft":"  new prompt\n[附件] ref.png · awwo-file:aFILEFILEFILEFILE  "}]}`), &n); e != nil {
		t.Fatal(e)
	}
	// The file line stays with the draft: a picture among the lines can be the generation's reference, and admission
	// drops the others (freezeMediaPrompt). The words are what is left once the lines are stripped.
	got := graphMediaDraft(n)
	if got != "new prompt\n[附件] ref.png · awwo-file:aFILEFILEFILEFILE" || stripAttachmentLines(got) != "new prompt" {
		t.Fatalf("draft %q", got)
	}
	// Shapes this host does not expect leave the draft empty; they never fail the graph's parsing.
	for _, raw := range []string{`{"id":"m","kind":"session","threads":{"x":1},"activeThreadId":7}`, `{"id":"m","kind":"session","threads":[{"id":3,"draft":true}]}`, `{"id":"m","kind":"session"}`} {
		var odd graphNode
		if e := json.Unmarshal([]byte(raw), &odd); e != nil {
			t.Fatal("odd node shape failed parsing", raw, e)
		}
		if got := graphMediaDraft(odd); got != "" {
			t.Fatal("odd draft", raw, got)
		}
	}
}

func TestGraphPromptNamesMediaFilesInsteadOfTheirRecord(t *testing.T) {
	record := `{"type":"awwo.media","version":1,"kind":"model3d","model":"tripo.p1","items":[{"artifactId":"aAAAAAAAAAAA","name":"model3d-1.glb","contentType":"model/gltf-binary","size":2048}]}`
	d := graphDocument{Nodes: []graphNode{{ID: "hero", Kind: "session", AgentKind: mediaKindModel3D, Title: "Hero"}, {ID: "page", Kind: "session", AgentKind: "coding", Title: "Page"}},
		Edges: []graphEdge{{ID: "e", FromNode: "hero", FromPort: "result", ToNode: "page", ToPort: "context", DataType: "file"}}}
	prompt, err := graphPrompt(d.Nodes[1], d, map[string]string{"hero": record})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(prompt, "aAAAAAAAAAAA") || !strings.Contains(prompt, "hero/model3d-1.glb") || !strings.Contains(prompt, "「Hero」生成的3D 模型文件") {
		t.Fatal(prompt)
	}
	// Anything that is not such a record reads as it was delivered.
	if got := mediaDeliveryText(d.Nodes[0], "plain text"); got != "plain text" {
		t.Fatal(got)
	}
}

// An audio node's delivery reads downstream as its files, by path, with the rule that tells a page how to play them; a
// delivery without audio has no such rule, so every existing case reads as before.
func TestGraphPromptNamesAudioFilesAndHowToPlayThem(t *testing.T) {
	record := `{"type":"awwo.media","version":1,"kind":"audio","model":"rh.minimax-speech-2-8-hd","items":[{"artifactId":"aAAAAAAAAAAA","name":"audio-1.mp3","contentType":"audio/mpeg","size":4106}]}`
	d := graphDocument{Nodes: []graphNode{{ID: "vo_lark_1", Kind: "session", AgentKind: mediaKindAudio, Title: "Lark"}, {ID: "page", Kind: "session", AgentKind: "coding", Title: "Page"}},
		Edges: []graphEdge{{ID: "e", FromNode: "vo_lark_1", FromPort: "result", ToNode: "page", ToPort: "context", DataType: "audio"}}}
	prompt, err := graphPrompt(d.Nodes[1], d, map[string]string{"vo_lark_1": record})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"「Lark」生成的音频文件", "- vo_lark_1/audio-1.mp3（audio/mpeg，4106 字节）", "<audio>", "new Audio("} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("missing %q in %s", want, prompt)
		}
	}
	if strings.Contains(prompt, "aAAAAAAAAAAA") {
		t.Fatal("the record's artifact id reached the page", prompt)
	}
	// Nothing made: the page is told so, by the audio node's kind.
	if got := mediaMissingText(d.Nodes[0]); !strings.Contains(got, "这次没有生成出音频文件") {
		t.Fatal(got)
	}
	picture := `{"type":"awwo.media","version":1,"kind":"image","model":"rh.seedream-v5-pro","items":[{"artifactId":"aAAAAAAAAAAA","name":"image-1.png","contentType":"image/png","size":10}]}`
	if got := mediaDeliveryText(graphNode{ID: "hero", Kind: "session", AgentKind: mediaKindImage, Title: "Hero"}, picture); strings.Contains(got, "<audio>") || strings.Contains(got, mediaAudioPageRule) {
		t.Fatal("a picture's delivery carries the audio rule", got)
	}
	// The audio result is typed audio: it feeds a page's text context (the soft media edge) and nothing that is not text.
	bound := func(n map[string]any) map[string]any {
		n["binding"], n["runtime"] = map[string]any{"agentId": "agent-" + n["id"].(string)}, "pi"
		return n
	}
	doc := func(edge map[string]any) []byte {
		raw, _ := json.Marshal(map[string]any{"nodes": []any{
			bound(map[string]any{"id": "vo", "kind": "session", "agentKind": "audio", "title": "VO"}),
			bound(map[string]any{"id": "hero", "kind": "session", "agentKind": "image", "title": "Hero"}),
			bound(map[string]any{"id": "page", "kind": "session", "agentKind": "coding", "title": "Page"})}, "edges": []any{edge}})
		return raw
	}
	edge := func(from, to, toPort, dataType string) map[string]any {
		return map[string]any{"id": "e", "fromNode": from, "fromPort": "result", "toNode": to, "toPort": toPort, "dataType": dataType}
	}
	if _, _, err := parseGraph(doc(edge("vo", "page", "context", "audio")), nil); err != nil {
		t.Fatal("an audio result feeds a page", err)
	}
	for name, bad := range map[string]map[string]any{
		"audio typed as text":          edge("vo", "page", "context", "text"),
		"audio into a picture input":   edge("vo", "hero", "reference", "audio"),
		"a picture into an audio node": edge("hero", "vo", "reference", "image"),
	} {
		if _, _, err := parseGraph(doc(bad), nil); err == nil {
			t.Error("accepted", name)
		}
	}
	soft := graphDocument{Nodes: d.Nodes, Edges: d.Edges}
	if !softMediaEdge(soft, d.Edges[0]) {
		t.Fatal("an audio result into a page's context is a soft media edge")
	}
}

// A canvas run hands its pictures, clips and 3D models to the page that uses them: a media node's result may feed a
// text input (a page's context, or a text field of a contract node) and reads there as the files it made. Every other
// mismatch is still refused, and the edge keeps its source's type.
func TestGraphMediaResultsFeedTextInputs(t *testing.T) {
	bound := func(n map[string]any) map[string]any {
		n["binding"], n["runtime"] = map[string]any{"agentId": "agent-" + n["id"].(string)}, "pi"
		return n
	}
	page := bound(map[string]any{"id": "page", "kind": "session", "agentKind": "coding", "title": "Page"})
	brief := bound(map[string]any{"id": "brief", "kind": "session", "agentKind": "llm", "title": "Brief",
		"contract": map[string]any{"version": 1, "inputs": []any{map[string]any{"id": "art", "label": "Art", "type": "markdown"}},
			"outputs": []any{map[string]any{"id": "out", "label": "Out", "type": "file"}}}})
	doc := func(edges ...map[string]any) []byte {
		raw, _ := json.Marshal(map[string]any{"nodes": []any{
			bound(map[string]any{"id": "hero", "kind": "session", "agentKind": "image", "title": "Hero"}),
			bound(map[string]any{"id": "clip", "kind": "session", "agentKind": "video", "title": "Clip"}),
			bound(map[string]any{"id": "model", "kind": "session", "agentKind": "model3d", "title": "Model"}),
			page, brief}, "edges": edges})
		return raw
	}
	edge := func(id, from, fromPort, to, toPort, dataType string) map[string]any {
		return map[string]any{"id": id, "fromNode": from, "fromPort": fromPort, "toNode": to, "toPort": toPort, "dataType": dataType}
	}
	if _, _, err := parseGraph(doc(edge("a", "hero", "result", "page", "context", "image"), edge("b", "clip", "result", "page", "context", "video"),
		edge("c", "model", "result", "page", "context", "file"), edge("d", "hero", "result", "brief", "in:art", "image")), nil); err != nil {
		t.Fatal("media results feed text inputs", err)
	}
	for name, bad := range map[string]map[string]any{
		"edge typed as its target":         edge("x", "hero", "result", "page", "context", "text"),
		"text into a picture input":        edge("x", "page", "result", "hero", "reference", "text"),
		"a contract file output into text": edge("x", "brief", "out:out", "page", "context", "file"),
	} {
		if _, _, err := parseGraph(doc(bad), nil); err == nil {
			t.Error("accepted", name)
		}
	}
}

// A media result feeding a text input is the one soft dependency; a picture feeding another picture's reference input,
// and every text edge, still holds its target back.
func TestGraphSoftMediaEdgeIsOnlyTheCrossTypeCase(t *testing.T) {
	d := graphDocument{Nodes: []graphNode{
		{ID: "hero", Kind: "session", AgentKind: mediaKindImage, Title: "Hero"},
		{ID: "edit", Kind: "session", AgentKind: mediaKindImage, Title: "Edit"},
		{ID: "page", Kind: "session", AgentKind: "coding", Title: "Page"},
		{ID: "brief", Kind: "session", AgentKind: "llm", Title: "Brief", Contract: &graphContract{Version: 1,
			Inputs: []graphField{{ID: "art", Type: "markdown", Required: true}}, Outputs: []graphField{{ID: "out", Type: "markdown"}}}},
	}}
	for _, c := range []struct {
		edge graphEdge
		soft bool
	}{
		{graphEdge{ID: "a", FromNode: "hero", FromPort: "result", ToNode: "page", ToPort: "context", DataType: "image"}, true},
		{graphEdge{ID: "b", FromNode: "hero", FromPort: "result", ToNode: "brief", ToPort: "in:art", DataType: "image"}, true},
		{graphEdge{ID: "c", FromNode: "hero", FromPort: "result", ToNode: "edit", ToPort: "reference", DataType: "image"}, false},
		{graphEdge{ID: "d", FromNode: "brief", FromPort: "out:out", ToNode: "page", ToPort: "context", DataType: "text"}, false},
		{graphEdge{ID: "e", FromNode: "gone", FromPort: "result", ToNode: "page", ToPort: "context", DataType: "image"}, false},
	} {
		if got := softMediaEdge(d, c.edge); got != c.soft {
			t.Error("edge", c.edge.ID, "soft", got)
		}
	}
	// What the brief's required field reads when the picture was not made: a note, never an empty value.
	prompt, err := graphPrompt(d.Nodes[3], graphDocument{Nodes: d.Nodes, Edges: []graphEdge{
		{ID: "b", FromNode: "hero", FromPort: "result", ToNode: "brief", ToPort: "in:art", DataType: "image"}}}, map[string]string{"hero": ""})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(prompt, "「Hero」这次没有生成出图片文件") || strings.Contains(prompt, "hero/") {
		t.Fatal(prompt)
	}
}

// A canvas run hands a generated picture to the page that shows it; when the picture is not made (here the day's
// allowance refuses it), the page is still made, told that no file exists, and only the picture's node fails.
func TestPostgresGraphRunPageGoesOnWithoutAPictureThatWasNotMade(t *testing.T) {
	var mu sync.Mutex
	prompts := []string{}
	pi := runtimeProvider(t, runtimePI, func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
		mu.Lock()
		prompts = append(prompts, call.Prompt)
		mu.Unlock()
		completePi(w, `{"result":"PAGE"}`)
	})
	t.Cleanup(pi.Close)
	h := newHarness(t, pi.URL)
	rh := newFakeRunningHub(t)
	rh.configure(h.a)
	c, tid, _ := h.register(t, "media-soft@example.test")
	base := "/tenants/" + tid
	aid := h.request(t, c, "POST", base+"/agents", map[string]any{"name": "Page", "adapterType": "pi", "model": "test-model", "instructions": "PAGE"}, 201)["id"].(string)
	page := map[string]any{"id": "page", "kind": "session", "title": "Page", "runtime": "pi", "agentKind": "llm",
		"binding": map[string]string{"companyId": tid, "agentId": aid},
		"contract": map[string]any{"version": 1, "inputs": []any{map[string]any{"id": "art", "label": "Art", "type": "markdown", "required": true}},
			"outputs": []any{map[string]any{"id": "result", "label": "Result", "type": "markdown", "required": true}}}}
	doc := map[string]any{"nodes": []any{mediaDraftNode("img", "rh.seedream-v5-pro", "a red bicycle on a beach"), page},
		"edges": []any{map[string]any{"id": "i-p", "fromNode": "img", "fromPort": "result", "toNode": "page", "toPort": "in:art", "dataType": "image"}}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Soft media", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	states := func(v map[string]any) map[string]map[string]any {
		out := map[string]map[string]any{}
		for _, raw := range v["nodes"].([]any) {
			n := raw.(map[string]any)
			out[n["nodeId"].(string)] = n
		}
		return out
	}
	graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	nodes := states(awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "completed", 15*time.Second))
	mu.Lock()
	first := append([]string{}, prompts...)
	mu.Unlock()
	if nodes["img"]["state"] != "done" || nodes["page"]["state"] != "done" || len(first) != 1 || !strings.Contains(first[0], "img/image-1.png") {
		t.Fatalf("with the picture: %v %v %q", nodes["img"], nodes["page"], first)
	}

	h.a.cfg.MediaRunsPerDay = 1
	graph = h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	nodes = states(awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "failed", 15*time.Second))
	mu.Lock()
	second := append([]string{}, prompts...)
	mu.Unlock()
	if nodes["img"]["state"] != "failed" || nodes["img"]["detail"] != "media_quota_exceeded" || nodes["page"]["state"] != "done" || len(second) != 2 {
		t.Fatalf("without the picture: %v %v %d", nodes["img"], nodes["page"], len(second))
	}
	if !strings.Contains(second[1], "这次没有生成出图片文件") || strings.Contains(second[1], "img/image-1.png") {
		t.Fatalf("the page's input without the picture %q", second[1])
	}
	if submits, _ := rh.counts(); submits != 1 {
		t.Fatal("generations submitted", submits)
	}
}
