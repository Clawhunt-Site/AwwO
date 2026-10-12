package app

import (
	"encoding/json"
	"strings"
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
	if got := graphMediaDraft(n); got != "new prompt" {
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
