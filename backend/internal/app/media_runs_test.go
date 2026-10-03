package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	testPNG = append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), bytes.Repeat([]byte{7}, 4096)...)
	testMP4 = append([]byte("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"), bytes.Repeat([]byte{9}, 4096)...)
)

type fakeSubmit struct {
	path, auth string
	body       map[string]any
}

// fakeRunningHub stands in for RunningHub's task API and its result storage. Result URLs name the
// real allowlisted host; the configured file client delivers them to this server.
type fakeRunningHub struct {
	api, files *httptest.Server
	dir        string
	mu         sync.Mutex
	submits    []fakeSubmit
	polls      map[string]int
	submit     func(n int) (int, any)
	query      func(task string, n int) (int, any)
	content    map[string][]byte
	// When set, a submission signals entered and waits for gate before it is answered.
	entered, gate chan struct{}
}

func mediaSuccess(task string, urls ...string) map[string]any {
	results := []any{}
	for _, u := range urls {
		results = append(results, map[string]any{"url": u, "outputType": "png"})
	}
	return map[string]any{"taskId": task, "status": "SUCCESS", "results": results}
}

func newFakeRunningHub(t *testing.T) *fakeRunningHub {
	f := &fakeRunningHub{dir: t.TempDir(), polls: map[string]int{}, content: map[string][]byte{"/out.png": testPNG, "/out.mp4": testMP4}}
	f.submit = func(n int) (int, any) {
		return 200, map[string]any{"taskId": fmt.Sprintf("task-%d", n), "status": "QUEUED"}
	}
	f.query = func(task string, n int) (int, any) {
		if n == 1 {
			return 200, map[string]any{"taskId": task, "status": "RUNNING"}
		}
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.png")
	}
	f.api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/openapi/v2/query" {
			f.mu.Lock()
			entered, gate := f.entered, f.gate
			f.mu.Unlock()
			if entered != nil {
				entered <- struct{}{}
			}
			if gate != nil {
				<-gate
			}
		}
		f.mu.Lock()
		var status int
		var reply any
		if r.URL.Path == "/openapi/v2/query" {
			task, _ := body["taskId"].(string)
			f.polls[task]++
			status, reply = f.query(task, f.polls[task])
		} else {
			f.submits = append(f.submits, fakeSubmit{r.URL.Path, r.Header.Get("Authorization"), body})
			status, reply = f.submit(len(f.submits))
		}
		f.mu.Unlock()
		if reply == nil {
			w.WriteHeader(status)
			return
		}
		writeJSON(w, status, reply)
	}))
	f.files = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		data, ok := f.content[r.URL.Path]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(func() { f.api.Close(); f.files.Close() })
	return f
}

func (f *fakeRunningHub) set(submit func(int) (int, any), query func(string, int) (int, any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if submit != nil {
		f.submit = submit
	}
	if query != nil {
		f.query = query
	}
}

func (f *fakeRunningHub) counts() (submits int, polls int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, n := range f.polls {
		polls += n
	}
	return len(f.submits), polls
}

func (f *fakeRunningHub) submission(i int) fakeSubmit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.submits[i]
}

func (f *fakeRunningHub) configure(a *App) {
	a.cfg.RunningHubAPIKey = "rh-test-key-0123456789"
	a.cfg.RunningHubBaseURL = f.api.URL
	a.cfg.MediaDir = f.dir
	a.cfg.MediaTimeout = time.Minute
	a.cfg.MediaPollInterval = 5 * time.Millisecond
	a.cfg.MediaRunsPerDay = 50
	a.cfg.MediaTotalRunsPerDay = 500
	a.cfg.MediaMaxFileBytes = 1 << 20
	a.cfg.MediaResultHosts = []string{".runninghub.ai"}
	// Test workspaces have no model allowlist; the opt-in itself is tested separately.
	a.cfg.MediaUnrestrictedWorkspaces = true
	hub := newRunningHub(a.cfg)
	hub.files.Transport = redirectTransport{f.files}
	a.media = hub
}

func newMediaHarness(t *testing.T) (*harness, *fakeRunningHub) {
	rh := newFakeRunningHub(t)
	// A healthy text runtime, as in a real deployment; no media test may reach a model.
	pi := teamProvider(t, func(http.ResponseWriter, *http.Request, observedPiCall) { t.Error("unexpected model call") })
	t.Cleanup(pi.Close)
	h := newHarness(t, pi.URL)
	rh.configure(h.a)
	return h, rh
}

func mediaNode(id, kind, model string, params map[string]any) map[string]any {
	return map[string]any{"id": id, "kind": "session", "agentKind": kind, "title": "Media " + id, "runtime": "pi", "model": model, "persona": "", "effort": "",
		"binding": nil, "issueId": nil, "preview": "", "threads": []any{}, "mediaParams": params}
}

func mediaCanvas(t *testing.T, h *harness, c *http.Cookie, tid string, nodes ...map[string]any) (string, map[string]any) {
	t.Helper()
	v := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Media", "document": map[string]any{"nodes": nodes, "edges": []any{}}}, 201)
	cid := v["id"].(string)
	return cid, h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
}

func (h *harness) mediaRun(t *testing.T, c *http.Cookie, tid, sid, prompt string, status int) map[string]any {
	t.Helper()
	return h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": prompt, "operationId": randomID()}, status)
}

func (h *harness) saveDocument(t *testing.T, c *http.Cookie, tid, cid string, canvas map[string]any) map[string]any {
	t.Helper()
	return h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": canvas["name"], "version": canvas["version"], "document": canvas["document"]}, 200)
}

func errorCode(v map[string]any) string {
	e, _ := v["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

func awaitRunRow(t *testing.T, h *harness, tid, id string, want ...string) (string, string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var status, code string
	for time.Now().Before(deadline) {
		if e := h.db.QueryRow(context.Background(), "SELECT status,error FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status, &code); e != nil {
			t.Fatal(e)
		}
		for _, w := range want {
			if status == w {
				return status, code
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("run %s stayed %s (%s), want %v", id, status, code, want)
	return "", ""
}

type mediaOutput struct {
	Type    string      `json:"type"`
	Version int         `json:"version"`
	Kind    string      `json:"kind"`
	Model   string      `json:"model"`
	Items   []mediaItem `json:"items"`
}

func TestPostgresMediaRunGeneratesStoresAndServesAnImage(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-image@example.test")
	cid, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", map[string]any{"resolution": "1k"}))
	node := setupNodeAt(canvas, 0)
	sid, agentID := node["issueId"].(string), node["binding"].(map[string]any)["agentId"].(string)
	var engine string
	if e := h.db.QueryRow(t.Context(), "SELECT engine FROM agents WHERE tenant_id=$1 AND id=$2", tid, agentID).Scan(&engine); e != nil || engine != agentEngineMedia {
		t.Fatal("media node Agent not marked", engine, e)
	}
	// The node's Agent is not a workspace Agent: not listed, read or editable as one.
	for _, item := range h.request(t, c, "GET", "/tenants/"+tid+"/agents", nil, 200)["items"].([]any) {
		if item.(map[string]any)["id"] == agentID {
			t.Fatal("media Agent offered in the workspace Agent library")
		}
	}
	h.request(t, c, "GET", "/tenants/"+tid+"/agents/"+agentID, nil, 404)

	catalogue := h.request(t, c, "GET", "/tenants/"+tid+"/media", nil, 200)
	if catalogue["configured"] != true || catalogue["available"] != true || len(catalogue["models"].([]any)) != len(builtinMediaCatalog.Models) {
		t.Fatal("catalogue", catalogue)
	}
	if raw, _ := json.Marshal(catalogue); bytes.Contains(raw, []byte("openapi")) || bytes.Contains(raw, []byte(h.a.cfg.RunningHubAPIKey)) {
		t.Fatal("catalogue exposes the provider endpoint or key")
	}

	run := h.mediaRun(t, c, tid, sid, "  a red bicycle on a beach  ", 202)
	done := h.awaitRun(t, c, tid, run["id"].(string), "completed")
	submits, _ := rh.counts()
	if submits != 1 {
		t.Fatal("submitted more than once", submits)
	}
	sent := rh.submission(0)
	if sent.path != "/openapi/v2/seedream-v5-pro/text-to-image" || sent.auth != "Bearer "+h.a.cfg.RunningHubAPIKey ||
		sent.body["prompt"] != "a red bicycle on a beach" || sent.body["resolution"] != "1k" || sent.body["outputFormat"] != "jpeg" || len(sent.body) != 3 {
		t.Fatalf("unexpected submission %+v", sent)
	}
	var out mediaOutput
	if e := json.Unmarshal([]byte(done["output"].(string)), &out); e != nil || out.Type != mediaOutputType || out.Version != 1 || out.Kind != "image" || out.Model != "rh.seedream-v5-pro" || len(out.Items) != 1 {
		t.Fatal("output", done["output"], e)
	}
	item := out.Items[0]
	if item.ContentType != "image/png" || item.Size != int64(len(testPNG)) || item.Name != "image-1.png" {
		t.Fatal("item", item)
	}
	var statuses []string
	rows, e := h.db.Query(t.Context(), "SELECT data->>'status' FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND data->>'type'='media_status' ORDER BY id", tid, run["id"])
	if e != nil {
		t.Fatal(e)
	}
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		statuses = append(statuses, s)
	}
	rows.Close()
	if strings.Join(statuses, ",") != "queued,running,saving" {
		t.Fatal("progress reports", statuses)
	}
	var rel, contentType string
	var stored []byte
	if e := h.db.QueryRow(t.Context(), "SELECT storage_path,content_type,content FROM artifacts WHERE tenant_id=$1 AND id=$2", tid, item.ArtifactID).Scan(&rel, &contentType, &stored); e != nil || contentType != "image/png" || len(stored) != 0 {
		t.Fatal("artifact row", rel, contentType, len(stored), e)
	}
	if data, e := os.ReadFile(filepath.Join(rh.dir, filepath.FromSlash(rel))); e != nil || !bytes.Equal(data, testPNG) || !strings.HasPrefix(rel, tid+"/"+run["id"].(string)+"/") {
		t.Fatal("stored file", rel, e)
	}

	media := "/tenants/" + tid + "/artifacts/" + item.ArtifactID + "/media"
	header, body := h.readRaw(t, c, media, 200)
	if !bytes.Equal(body, testPNG) || header.Get("Content-Type") != "image/png" || header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" ||
		!strings.HasPrefix(header.Get("Content-Disposition"), "inline") || header.Get("X-Content-Type-Options") != "nosniff" || header.Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatal("inline media", header)
	}
	ranged, _ := http.NewRequest("GET", h.server.URL+"/api/v1"+media, nil)
	ranged.AddCookie(c)
	ranged.Header.Set("Range", "bytes=0-7")
	resp, e := http.DefaultClient.Do(ranged)
	if e != nil {
		t.Fatal(e)
	}
	part, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 206 || !bytes.Equal(part, testPNG[:8]) {
		t.Fatal("range request", resp.StatusCode, part)
	}
	header, body = h.readRaw(t, c, "/tenants/"+tid+"/artifacts/"+item.ArtifactID, 200)
	if !bytes.Equal(body, testPNG) || header.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(header.Get("Content-Disposition"), "attachment") {
		t.Fatal("download", header)
	}
	other, otherTid, _ := h.register(t, "media-other@example.test")
	h.readRaw(t, other, media, 404)
	h.readRaw(t, other, "/tenants/"+otherTid+"/artifacts/"+item.ArtifactID+"/media", 404)

	// Parameter choices are read at each run and never fork the conversation; a changed model is
	// a new configuration that must be initialized first.
	node["mediaParams"] = map[string]any{"resolution": "2k", "outputFormat": "png"}
	canvas = h.saveDocument(t, c, tid, cid, canvas)
	second := h.mediaRun(t, c, tid, sid, "a blue bicycle on a beach", 202)
	awaitRunRow(t, h, tid, second["id"].(string), "completed")
	if body := rh.submission(1).body; body["resolution"] != "2k" || body["outputFormat"] != "png" {
		t.Fatal("changed parameters not applied", body)
	}
	node = setupNodeAt(canvas, 0)
	node["model"] = "rh.gpt-image-2"
	node["mediaParams"] = map[string]any{}
	canvas = h.saveDocument(t, c, tid, cid, canvas)
	if got := h.mediaRun(t, c, tid, sid, "a green bicycle", 409); errorCode(got) != "node_setup_required" {
		t.Fatal("ran a model the node was not initialized for", got)
	}
	canvas = h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": canvas["version"]}, 200)
	if next := setupNodeAt(canvas, 0); next["issueId"] == sid || next["binding"].(map[string]any)["agentId"] == agentID {
		t.Fatal("a changed media model must start a new conversation and Agent")
	}
}

func TestPostgresMediaRunAdmissionRefusals(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-refusals@example.test")
	base := "/tenants/" + tid

	// Unconfigured media generation cannot initialize a media node.
	key := h.a.cfg.RunningHubAPIKey
	h.a.cfg.RunningHubAPIKey = ""
	v := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Off", "document": map[string]any{"nodes": []any{mediaNode("img", "image", "rh.seedream-v5-pro", nil)}}}, 201)
	// With media generation off the node is refused exactly as before media nodes existed.
	if got := h.request(t, c, "POST", base+"/canvases/"+v["id"].(string)+"/initialize", map[string]any{"documentVersion": 1}, 400); errorCode(got) != "invalid_node_setup" {
		t.Fatal("initialized without a provider", got)
	}
	if got := h.request(t, c, "GET", base+"/media", nil, 200); got["configured"] != false || len(got["models"].([]any)) != 0 {
		t.Fatal("unconfigured catalogue", got)
	}
	h.a.cfg.RunningHubAPIKey = key

	// A video model on an image node, or an unknown model, is not a valid setup.
	for _, model := range []string{"rh.kling-v3-pro", "rh.unknown", "gpt-5"} {
		v := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Wrong", "document": map[string]any{"nodes": []any{mediaNode("img", "image", model, nil)}}}, 201)
		if got := h.request(t, c, "POST", base+"/canvases/"+v["id"].(string)+"/initialize", map[string]any{"documentVersion": 1}, 400); errorCode(got) != "invalid_node_setup" {
			t.Fatal(model, got)
		}
	}
	// A media node cannot borrow a workspace Agent or run a team.
	library := h.request(t, c, "POST", base+"/agents", map[string]any{"name": "Writer", "adapterType": "pi", "adapterConfig": map[string]string{"model": "test-model"}}, 201)
	borrowed := mediaNode("img", "image", "rh.seedream-v5-pro", nil)
	borrowed["agentRef"] = map[string]any{"source": "workspace", "agentId": library["id"]}
	v = h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Borrowed", "document": map[string]any{"nodes": []any{borrowed}}}, 201)
	h.request(t, c, "POST", base+"/canvases/"+v["id"].(string)+"/initialize", map[string]any{"documentVersion": 1}, 400)

	cid, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil), mediaNode("vid", "video", "rh.kling-v3-pro", map[string]any{"duration": "10"}))
	img, vid := setupNodeAt(canvas, 0)["issueId"].(string), setupNodeAt(canvas, 1)["issueId"].(string)
	if got := h.mediaRun(t, c, tid, img, "cat", 400); errorCode(got) != "media_prompt_invalid" {
		t.Fatal("prompt shorter than the model allows", got)
	}
	if got := h.request(t, c, "POST", base+"/runs", map[string]any{"sessionId": img, "prompt": "a cat in a hat", "operationId": randomID(), "knowledgeRevisionIds": []string{"k1"}}, 400); errorCode(got) != "media_knowledge_unsupported" {
		t.Fatal("knowledge context on a media node", got)
	}
	setupNodeAt(canvas, 1)["mediaParams"] = map[string]any{"duration": "99"}
	canvas = h.saveDocument(t, c, tid, cid, canvas)
	if got := h.mediaRun(t, c, tid, vid, "a cat in a hat", 400); errorCode(got) != "media_params_invalid" {
		t.Fatal("parameter outside the closed choices", got)
	}
	setupNodeAt(canvas, 1)["mediaParams"] = map[string]any{"duration": "10", "seed": 7}
	canvas = h.saveDocument(t, c, tid, cid, canvas)
	if got := h.mediaRun(t, c, tid, vid, "a cat in a hat", 400); errorCode(got) != "media_params_invalid" {
		t.Fatal("unknown parameter", got)
	}
	setupNodeAt(canvas, 1)["agentKind"] = "image"
	canvas = h.saveDocument(t, c, tid, cid, canvas)
	if got := h.mediaRun(t, c, tid, vid, "a cat in a hat", 409); errorCode(got) != "node_setup_required" {
		t.Fatal("changed node kind", got)
	}
	// A canvas run never executes a media node.
	if got := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"], "scope": []string{"img"}}, 400); errorCode(got) != "media_graph_unsupported" {
		t.Fatal("graph run admitted a media node", got)
	}
	// Generations are paid from the operator's key: a workspace without an allowlist uses media
	// models only when the operator opts such workspaces in, and an allowlist must name the model.
	h.a.cfg.MediaUnrestrictedWorkspaces = false
	if got := h.mediaRun(t, c, tid, img, "a cat in a hat", 403); errorCode(got) != "model_not_allowed" {
		t.Fatal("unrestricted workspace used a media model without the opt-in", got)
	}
	if got := h.request(t, c, "GET", base+"/media", nil, 200); len(got["models"].([]any)) != 0 || got["available"] != false {
		t.Fatal("catalogue offers media to an unrestricted workspace without the opt-in", got)
	}
	for allowed, want := range map[string]int{"{test-model}": 0, "{test-model,rh.seedream-v5-pro}": 1} {
		if _, e := h.db.Exec(t.Context(), "UPDATE tenants SET allowed_models=$2::text[] WHERE id=$1", tid, allowed); e != nil {
			t.Fatal(e)
		}
		if got := h.request(t, c, "GET", base+"/media", nil, 200); len(got["models"].([]any)) != want {
			t.Fatal("allowlist", allowed, got)
		}
	}
	if got := h.mediaRun(t, c, tid, vid, "a cat in a hat", 403); errorCode(got) != "model_not_allowed" {
		t.Fatal("unlisted media model", got)
	}
	if _, e := h.db.Exec(t.Context(), "UPDATE tenants SET allowed_models=NULL WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	h.a.cfg.MediaUnrestrictedWorkspaces = true
	// No generation is paid for onto a full disk.
	if _, ok := diskFree(rh.dir); ok {
		h.a.cfg.MediaMinFreeBytes = 1 << 62
		if got := h.mediaRun(t, c, tid, img, "a cat in a hat", 503); errorCode(got) != "media_storage_full" {
			t.Fatal("storage floor", got)
		}
		h.a.cfg.MediaMinFreeBytes = 0
	}
	// The daily limit counts every admitted generation, and deleting the canvas that ran them
	// does not give it back.
	h.a.cfg.MediaRunsPerDay = 1
	run := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "completed")
	if got := h.mediaRun(t, c, tid, img, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("daily limit", got)
	}
	h.request(t, c, "DELETE", base+"/canvases/"+cid, nil, 204)
	_, fresh := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	again := setupNodeAt(fresh, 0)["issueId"].(string)
	if got := h.mediaRun(t, c, tid, again, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("deleting a canvas reset the daily media limit", got)
	}
	// A deployment-wide ceiling backs the per-workspace limit.
	h.a.cfg.MediaRunsPerDay, h.a.cfg.MediaTotalRunsPerDay = 50, 1
	if got := h.mediaRun(t, c, tid, again, "a cat in a hat", 429); errorCode(got) != "media_capacity_exceeded" {
		t.Fatal("deployment-wide ceiling", got)
	}
	h.a.cfg.MediaTotalRunsPerDay = 500
	// Generations also spend the workspace's own daily run quota.
	if _, e := h.db.Exec(t.Context(), "UPDATE tenants SET max_runs_per_day=1 WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	if got := h.mediaRun(t, c, tid, again, "a cat in a hat", 429); errorCode(got) != "quota_exceeded" {
		t.Fatal("workspace run quota ignored generations", got)
	}
	if submits, _ := rh.counts(); submits != 1 {
		t.Fatal("a refused run reached the provider", submits)
	}
}

func TestPostgresMediaRunFailuresSettleWithClosedCodes(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-failures@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	succeedWith := func(url string) func(string, int) (int, any) {
		return func(task string, n int) (int, any) { return 200, mediaSuccess(task, url) }
	}
	rh.mu.Lock()
	rh.content["/page.png"] = []byte("<html><script>alert(1)</script></html>")
	rh.content["/clip.png"] = testMP4
	rh.mu.Unlock()
	queued := func(n int) (int, any) {
		return 200, map[string]any{"taskId": fmt.Sprintf("task-%d", n), "status": "QUEUED"}
	}
	cases := []struct {
		name   string
		submit func(int) (int, any)
		query  func(string, int) (int, any)
		code   string
	}{
		{"enterprise key required", func(int) (int, any) { return 200, map[string]any{"code": 1014, "msg": "x", "data": nil} }, nil, "media_provider_unauthorized"},
		{"key refused", func(int) (int, any) { return 401, nil }, nil, "media_provider_unauthorized"},
		{"content rejected", queued, func(task string, n int) (int, any) {
			return 200, map[string]any{"taskId": task, "status": "FAILED", "errorCode": "1501", "errorMessage": "private words"}
		}, "media_content_rejected"},
		{"no output", queued, func(task string, n int) (int, any) { return 200, mediaSuccess(task) }, "media_no_output"},
		{"not an image", queued, succeedWith("https://files.runninghub.ai/page.png"), "media_result_invalid"},
		{"video for an image node", queued, succeedWith("https://files.runninghub.ai/clip.png"), "media_result_invalid"},
		{"foreign host", queued, succeedWith("https://files.evil.test/out.png"), "media_result_refused"},
		{"missing file", queued, succeedWith("https://files.runninghub.ai/gone.png"), "media_result_unavailable"},
		{"provider down", queued, func(string, int) (int, any) { return 503, nil }, "media_provider_unavailable"},
		{"another task", queued, func(string, int) (int, any) {
			return 200, mediaSuccess("someone-else", "https://files.runninghub.ai/out.png")
		}, "media_provider_unavailable"},
	}
	for _, tc := range cases {
		rh.set(tc.submit, tc.query)
		before, _ := rh.counts()
		run := h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
		if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != tc.code {
			t.Fatal(tc.name, "settled with", code, "want", tc.code)
		}
		if after, _ := rh.counts(); after != before+1 {
			t.Fatal(tc.name, "submissions", after-before)
		}
		var message string
		_ = h.db.QueryRow(t.Context(), "SELECT error FROM runs WHERE id=$1", run["id"]).Scan(&message)
		if strings.Contains(message, "private words") {
			t.Fatal("provider message text stored")
		}
	}
	// Pending codes are not failures, however long the generation takes.
	rh.set(queued, func(task string, n int) (int, any) {
		if n < 20 {
			return 200, map[string]any{"code": 804, "msg": "running", "data": map[string]any{"taskId": task, "status": "RUNNING", "errorCode": "804"}}
		}
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.png")
	})
	run := h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
	if status, code := awaitRunRow(t, h, tid, run["id"].(string), "completed", "failed"); status != "completed" {
		t.Fatal("pending answers failed the run", code)
	}
	// The run deadline bounds a generation that never finishes.
	h.a.cfg.MediaTimeout = 300 * time.Millisecond
	rh.set(queued, func(task string, n int) (int, any) { return 200, map[string]any{"taskId": task, "status": "RUNNING"} })
	run = h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_timeout" {
		t.Fatal("deadline", code)
	}
}

func TestPostgresMediaRunCancelStopsPolling(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-cancel@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("vid", "video", "rh.seedance-2", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	rh.set(nil, func(task string, n int) (int, any) { return 200, map[string]any{"taskId": task, "status": "RUNNING"} })
	run := h.mediaRun(t, c, tid, sid, "a slow pan over mountains", 202)
	deadline := time.Now().Add(5 * time.Second)
	for _, polls := rh.counts(); polls < 3 && time.Now().Before(deadline); _, polls = rh.counts() {
		time.Sleep(5 * time.Millisecond)
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/runs/"+run["id"].(string)+"/cancel", nil, 200)
	awaitRunRow(t, h, tid, run["id"].(string), "cancelled")
	time.Sleep(50 * time.Millisecond)
	_, settled := rh.counts()
	time.Sleep(100 * time.Millisecond)
	if _, later := rh.counts(); later != settled {
		t.Fatal("polling continued after cancel", settled, later)
	}
	if status, _ := awaitRunRow(t, h, tid, run["id"].(string), "cancelled"); status != "cancelled" {
		t.Fatal("cancel was overwritten")
	}
}

func TestPostgresMediaRunResumesAfterRestart(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-resume@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("a", "image", "rh.seedream-v5-pro", nil), mediaNode("b", "image", "rh.seedream-v5-pro", nil), mediaNode("c", "image", "rh.seedream-v5-pro", nil))
	finish := make(chan struct{})
	rh.set(nil, func(task string, n int) (int, any) {
		select {
		case <-finish:
			return 200, mediaSuccess(task, "https://files.runninghub.ai/out.png")
		default:
			return 200, map[string]any{"taskId": task, "status": "RUNNING"}
		}
	})
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a lighthouse at dusk", 202)
	rid := run["id"].(string)
	deadline := time.Now().Add(5 * time.Second)
	for {
		var recorded bool
		if e := h.db.QueryRow(t.Context(), "SELECT COALESCE(media_task ? 'taskId',false) FROM runs WHERE id=$1", rid).Scan(&recorded); e != nil {
			t.Fatal(e)
		}
		if recorded {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("task id never recorded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.a.Close()
	var status string
	var interrupted int
	if e := h.db.QueryRow(t.Context(), "SELECT status,(SELECT count(*) FROM run_events WHERE run_id=$1 AND data->>'type'='interrupted') FROM runs WHERE id=$1", rid).Scan(&status, &interrupted); e != nil || status != "running" || interrupted != 0 {
		t.Fatal("a shutdown settled a run whose generation is paid for", status, interrupted, e)
	}
	// Two more rows the restart must settle: one whose task id was never recorded, and one whose
	// deadline passed while the API was down.
	stale, unrecorded := randomID(), randomID()
	for _, row := range []struct {
		id, session, task string
	}{
		{unrecorded, setupNodeAt(canvas, 1)["issueId"].(string), `{"provider":"runninghub","model":"rh.seedream-v5-pro"}`},
		{stale, setupNodeAt(canvas, 2)["issueId"].(string), `{"provider":"runninghub","model":"rh.seedream-v5-pro","taskId":"old-task","submittedAt":"2020-01-01T00:00:00Z"}`},
	} {
		if _, e := h.db.Exec(t.Context(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,media_task) VALUES($1,$2,$3,$4,'h','p','running',$5)", row.id, tid, row.session, randomID(), row.task); e != nil {
			t.Fatal(e)
		}
	}
	close(finish)
	next := New(h.db, h.a.cfg)
	rh.configure(next)
	if e := next.Start(t.Context()); e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	if status, code := awaitRunRow(t, h, tid, rid, "completed", "failed"); status != "completed" {
		t.Fatal("resumed run did not complete", code)
	}
	if submits, _ := rh.counts(); submits != 1 {
		t.Fatal("restart submitted the generation again", submits)
	}
	if status, _ := awaitRunRow(t, h, tid, unrecorded, "interrupted"); status != "interrupted" {
		t.Fatal("unrecorded run")
	}
	if _, code := awaitRunRow(t, h, tid, stale, "failed"); code != "media_timeout" {
		t.Fatal("expired run", code)
	}
}

func TestPostgresMediaSweepRemovesOnlyUnreferencedOldFiles(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-sweep@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a cat in a hat", 202)
	rid := run["id"].(string)
	awaitRunRow(t, h, tid, rid, "completed")
	var rel string
	if e := h.db.QueryRow(t.Context(), "SELECT storage_path FROM artifacts WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&rel); e != nil {
		t.Fatal(e)
	}
	old := time.Now().Add(-7 * time.Hour)
	write := func(rel string, age time.Time) string {
		path := filepath.Join(rh.dir, filepath.FromSlash(rel))
		if e := os.MkdirAll(filepath.Dir(path), 0o750); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(path, testPNG, 0o640); e != nil {
			t.Fatal(e)
		}
		if e := os.Chtimes(path, age, age); e != nil {
			t.Fatal(e)
		}
		return path
	}
	kept := filepath.Join(rh.dir, filepath.FromSlash(rel))
	if e := os.Chtimes(kept, old, old); e != nil {
		t.Fatal(e)
	}
	sum := strings.Repeat("b", 64)
	orphan := write(tid+"/"+rid+"/"+sum+".png", old)
	young := write(tid+"/"+rid+"/"+strings.Repeat("c", 64)+".png", time.Now())
	foreign := write(tid+"/"+rid+"/notes.txt", old)
	gone := write(tid+"/gone-run/"+sum+".mp4", old)
	emptyRunDir := filepath.Join(rh.dir, tid, "empty-run")
	if e := os.Mkdir(emptyRunDir, 0o750); e != nil {
		t.Fatal(e)
	}
	if e := os.Chtimes(emptyRunDir, old, old); e != nil {
		t.Fatal(e)
	}
	active := randomID()
	if _, e := h.db.Exec(t.Context(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p','running')", active, tid, setupNodeAt(canvas, 0)["issueId"], randomID()); e != nil {
		t.Fatal(e)
	}
	writing := write(tid+"/"+active+"/"+sum+".png", old)
	abandoned := write(".tmp/download-123", old)
	fresh := write(".tmp/download-456", time.Now())
	h.a.sweepMedia(t.Context())
	for path, want := range map[string]bool{kept: true, orphan: false, young: true, foreign: true, gone: false, abandoned: false, fresh: true, writing: true} {
		if _, e := os.Stat(path); (e == nil) != want {
			t.Fatal(path, "present:", e == nil, "want", want)
		}
	}
	if _, e := os.Stat(emptyRunDir); !os.IsNotExist(e) {
		t.Fatal("old empty run directory kept", e)
	}
}

func TestPostgresMediaShutdownDuringSubmitKeepsTheTask(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-submit@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	entered, gate := make(chan struct{}, 1), make(chan struct{})
	rh.mu.Lock()
	rh.entered, rh.gate = entered, gate
	rh.mu.Unlock()
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a lighthouse at dusk", 202)
	rid := run["id"].(string)
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the submission never reached the provider")
	}
	closed := make(chan struct{})
	go func() { h.a.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("shutdown abandoned a submission the provider may bill")
	case <-time.After(200 * time.Millisecond):
	}
	rh.mu.Lock()
	rh.entered, rh.gate = nil, nil
	rh.mu.Unlock()
	close(gate)
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown did not finish after the submission was answered")
	}
	var status string
	var recorded bool
	if e := h.db.QueryRow(t.Context(), "SELECT status,COALESCE(media_task->>'taskId','')='task-1' FROM runs WHERE id=$1", rid).Scan(&status, &recorded); e != nil || status != "running" || !recorded {
		t.Fatal("the answered submission was not kept for resume", status, recorded, e)
	}
	next := New(h.db, h.a.cfg)
	rh.configure(next)
	if e := next.Start(t.Context()); e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	if status, code := awaitRunRow(t, h, tid, rid, "completed", "failed"); status != "completed" {
		t.Fatal("resumed run did not complete", code)
	}
	if submits, _ := rh.counts(); submits != 1 {
		t.Fatal("the generation was submitted again", submits)
	}
}
