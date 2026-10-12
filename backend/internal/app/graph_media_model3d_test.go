package app

import (
	"encoding/binary"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// A canvas run hands a generated 3D model to the page that shows it. A 3D node's result is typed file, so its wire
// keeps DataType "file"; on 2026-10-12 every such page failed with workspace_input_not_stored, because the stored-file
// reader took the model's record for one stored file. The page is made from the model's file list, and, when no model
// was made, without it, exactly as with a picture.
func TestPostgresGraphRunPageTakesA3DModel(t *testing.T) {
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
	newFakeRunningHub(t).configure(h.a) // media directory, timings and allowances; no picture is made here

	glb := append([]byte("glTF"), make([]byte, 2048)...)
	binary.LittleEndian.PutUint32(glb[4:8], 2)
	submits := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPost {
			submits++
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": fmt.Sprintf("task_%d", submits)}})
			return
		}
		writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": strings.TrimPrefix(r.URL.Path, "/tasks/"), "status": "success",
			"output": map[string]any{"model_url": "https://tripo-data.cdn.tripo3d.ai/m.glb", "rendered_image_url": "https://tripo-data.cdn.tripo3d.ai/p.png"}}})
	}))
	t.Cleanup(api.Close)
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/m.glb":
			_, _ = w.Write(glb)
		case "/p.png":
			_, _ = w.Write(testPNG)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(files.Close)
	h.a.cfg.TripoAPIKey, h.a.cfg.TripoBaseURL, h.a.cfg.TripoResultHosts = "tsk_test-key-0123456789", api.URL, []string{".tripo3d.ai"}
	h.a.cfg.TripoFreeRunsPerDay, h.a.cfg.TripoFreeTotalPerDay, h.a.cfg.MediaMinFreeBytes = 10, 10, 0
	tripo := newTripo(h.a.cfg)
	tripo.files.Transport = redirectTransport{files}
	h.a.tripo = tripo

	c, tid, _ := h.register(t, "media-model3d@example.test")
	base := "/tenants/" + tid
	aid := h.request(t, c, "POST", base+"/agents", map[string]any{"name": "Page", "adapterType": "pi", "model": "test-model", "instructions": "PAGE"}, 201)["id"].(string)
	page := map[string]any{"id": "page", "kind": "session", "title": "Page", "runtime": "pi", "agentKind": "llm",
		"binding": map[string]string{"companyId": tid, "agentId": aid},
		"contract": map[string]any{"version": 1, "inputs": []any{map[string]any{"id": "model", "label": "Model", "type": "markdown", "required": true}},
			"outputs": []any{map[string]any{"id": "result", "label": "Result", "type": "markdown", "required": true}}}}
	model := mediaNode("hero", mediaKindModel3D, "tripo.p1", nil)
	model["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": "a low-poly speaker", "createdAt": 0}}
	doc := map[string]any{"nodes": []any{model, page},
		"edges": []any{map[string]any{"id": "m-p", "fromNode": "hero", "fromPort": "result", "toNode": "page", "toPort": "in:model", "dataType": "file"}}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "3D page", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	states := func(v map[string]any) map[string]map[string]any {
		out := map[string]map[string]any{}
		for _, raw := range v["nodes"].([]any) {
			n := raw.(map[string]any)
			out[n["nodeId"].(string)] = n
		}
		return out
	}
	run := func(want string) map[string]map[string]any {
		t.Helper()
		graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
		return states(awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), want, 20*time.Second))
	}

	nodes := run("completed")
	mu.Lock()
	first := append([]string{}, prompts...)
	mu.Unlock()
	if nodes["hero"]["state"] != "done" || nodes["page"]["state"] != "done" || len(first) != 1 {
		t.Fatalf("with the model: %v %v %d", nodes["hero"], nodes["page"], len(first))
	}
	if !strings.Contains(first[0], "「Media hero」生成的3D 模型文件") || !strings.Contains(first[0], "hero/") || !strings.Contains(first[0], ".glb") ||
		strings.Contains(first[0], `"type":"awwo.media"`) {
		t.Fatalf("the page's input with the model %q", first[0])
	}

	// No model this time (the day's allowance refuses it): only the 3D node fails; the page is made without it.
	h.a.cfg.MediaRunsPerDay = 1
	nodes = run("failed")
	mu.Lock()
	second := append([]string{}, prompts...)
	n := submits
	mu.Unlock()
	if nodes["hero"]["state"] != "failed" || nodes["page"]["state"] != "done" || len(second) != 2 {
		t.Fatalf("without the model: %v %v %d", nodes["hero"], nodes["page"], len(second))
	}
	if !strings.Contains(second[1], "这次没有生成出3D 模型文件") || strings.Contains(second[1], "hero/") {
		t.Fatalf("the page's input without the model %q", second[1])
	}
	if n != 1 {
		t.Fatal("3D generations submitted", n)
	}
}
