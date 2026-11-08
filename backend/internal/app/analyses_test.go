package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

func analyzeDocument(settings map[string]any, edges ...map[string]any) []byte {
	node := map[string]any{"id": "breakdown", "kind": "analyze", "title": "Breakdown"}
	if settings != nil {
		node["analyze"] = settings
	}
	doc := map[string]any{
		"nodes": []any{
			map[string]any{"id": "clip", "kind": "session", "agentKind": "video", "title": "Clip", "binding": map[string]string{"agentId": "a"}},
			map[string]any{"id": "line", "kind": "session", "agentKind": "audio", "title": "Line", "binding": map[string]string{"agentId": "a"}},
			map[string]any{"id": "notes", "kind": "session", "agentKind": "llm", "title": "Notes", "binding": map[string]string{"agentId": "a"}},
			map[string]any{"id": "reel", "kind": "edit", "title": "Reel", "timeline": `{"schema":"awwo.timeline/1"}`},
			node,
		},
		"edges": edges,
	}
	raw, _ := json.Marshal(doc)
	return raw
}

// A video breakdown node takes one video, a clip or a film wired in or an upload of its own, and delivers text.
func TestParseGraphAnalyzeNode(t *testing.T) {
	upload := map[string]any{"source": "aUpload12345"}
	accepted := map[string]struct {
		settings map[string]any
		edges    []map[string]any
	}{
		"a clip wired in":        {nil, []map[string]any{edge("v", "clip", "result", "breakdown", "video", "video")}},
		"an edit's film":         {nil, []map[string]any{edge("v", "reel", "result", "breakdown", "video", "video")}},
		"its own upload":         {upload, nil},
		"its result as context":  {upload, []map[string]any{edge("r", "breakdown", "result", "notes", "context", "text")}},
		"English, Japanese text": {map[string]any{"source": "aUpload12345", "lang": "en", "ocr": true, "ocrLang": "ja", "packaging": false, "stems": true}, nil},
	}
	for name, c := range accepted {
		if _, _, err := parseGraph(analyzeDocument(c.settings, c.edges...), nil); err != nil {
			t.Error(name, err)
		}
	}
	refused := map[string]struct {
		settings map[string]any
		edges    []map[string]any
	}{
		"no video":            {nil, nil},
		"an empty upload":     {map[string]any{"source": "  "}, nil},
		"two videos":          {nil, []map[string]any{edge("v", "clip", "result", "breakdown", "video", "video"), edge("w", "reel", "result", "breakdown", "video", "video")}},
		"a sound as a video":  {nil, []map[string]any{edge("l", "line", "result", "breakdown", "video", "audio")}},
		"an unknown input":    {upload, []map[string]any{edge("v", "clip", "result", "breakdown", "clips", "video")}},
		"a language it lacks": {map[string]any{"source": "aUpload12345", "lang": "fr"}, nil},
		"text it cannot read": {map[string]any{"source": "aUpload12345", "ocrLang": "ko"}, nil},
		"not an artifact id":  {map[string]any{"source": "../../etc/passwd"}, nil},
	}
	for name, c := range refused {
		if _, _, err := parseGraph(analyzeDocument(c.settings, c.edges...), nil); err == nil {
			t.Error(name, "was accepted")
		}
	}
	var n graphNode
	_ = json.Unmarshal([]byte(`{"id":"breakdown","kind":"analyze"}`), &n)
	if st, ok := nodePort(n, "result", false); !ok || st != "text" || graphMediaSource(n) {
		t.Fatal("the result's port", st, ok)
	}
	if st, ok := nodePort(n, "video", true); !ok || st != mediaKindVideo {
		t.Fatal("the video's port", st, ok)
	}
	if inputs, _ := nodePortNames(n, true); strings.Join(inputs, ",") != "video" {
		t.Fatal("the inputs an agent sees", inputs)
	}
	if outputs, _ := nodePortNames(n, false); strings.Join(outputs, ",") != "result" {
		t.Fatal("the outputs an agent sees", outputs)
	}
}

func TestAnalysisOptionsFollowTheSettings(t *testing.T) {
	if got, _ := json.Marshal(analysisOptions(nil)); string(got) != `{"lang":"zh","ocr":true,"ocrLang":"zh","packaging":true,"review":true,"stems":false}` {
		t.Fatal("the defaults", string(got))
	}
	off := false
	got, _ := json.Marshal(analysisOptions(&analyzeSettings{Lang: "en", OCR: &off, OCRLang: "ja", Packaging: &off, Stems: true}))
	if string(got) != `{"lang":"en","ocr":false,"ocrLang":"ja","packaging":false,"review":true,"stems":true}` {
		t.Fatal("the settings", string(got))
	}
	if name := analysisDisplayName("clip/video-1.mp4\n"); name != "clip_video-1.mp4_" {
		t.Fatal("the display name", name)
	}
	if name := analysisDisplayName(strings.Repeat("长", 300)); len([]rune(name)) != 200 {
		t.Fatal("a long display name", len([]rune(name)))
	}
}

func TestAnalysisWorkerErrorsMapToTheJobsEnd(t *testing.T) {
	refusal := func(code, message, detail string) []byte {
		raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": code, "message": message, "detail": detail}})
		return raw
	}
	for _, c := range []struct {
		status       int
		body         []byte
		code, detail string
	}{
		{400, refusal("INVALID_ANALYSIS", "The video is 400 s long; at most 300 s are analysed.", "too_long"), "analysis_rejected", "The video is 400 s long; at most 300 s are analysed."},
		{400, refusal("ANALYSIS_FILE_MISMATCH", "x", ""), "analysis_file_mismatch", ""},
		{400, refusal("ANALYSIS_FILE_UNSUPPORTED", "The file is not a video the analysis takes (MP4, …).", ""), "analysis_rejected", "The file is not a video the analysis takes (MP4, …)."},
		{413, nil, "analysis_rejected", "The request is larger than the worker takes"},
		{429, nil, "analysis_busy", ""},
		{401, nil, "analysis_unavailable", ""}, {404, nil, "analysis_unavailable", ""}, {409, nil, "analysis_unavailable", ""}, {503, nil, "analysis_unavailable", ""},
		{422, refusal("ANALYSIS_FAILED", "The analysis took too long.", "timeout"), "timeout", ""},
		{422, refusal("ANALYSIS_FAILED", "The video could not be analysed.", "analysis_failed"), "analysis_failed", "analysis_failed"},
		{500, nil, "analysis_unavailable", ""},
	} {
		var got analysisError
		if err := analysisWorkerError(c.status, c.body); !errorsAs(err, &got) || got.code != c.code || got.detail != c.detail {
			t.Errorf("%d %s: %+v", c.status, c.body, got)
		}
	}
	if analysisFailureDetail("analysis_rejected", "too long") != "analysis_rejected: too long" || analysisFailureDetail("timeout", "") != "timeout" {
		t.Fatal("what a failed node shows")
	}
	if analysisAdmissionDetail(analysisUserErrorf("The node wired into this video breakdown delivered no video")) != "The node wired into this video breakdown delivered no video" ||
		analysisAdmissionDetail(fmt.Errorf("pq: secret details")) != "analysis_unavailable" || analysisAdmissionDetail(errPlanRequired) != "plan_required" {
		t.Fatal("what an unadmitted node shows")
	}
}

func errorsAs(err error, target *analysisError) bool {
	e, ok := err.(analysisError)
	if ok {
		*target = e
	}
	return ok
}

func analysisOutput(name, contentType string, size int64) editOutput {
	return editOutput{Name: name, ContentType: contentType, Size: size, SHA256: strings.Repeat("a", 64)}
}

func TestCheckAnalysisOutputsTakesOnlyWhatTheWorkerServes(t *testing.T) {
	full := []editOutput{
		analysisOutput("breakdown.json", "application/json", 900), analysisOutput("summary.txt", "text/plain; charset=utf-8", 50),
		analysisOutput("report.html", "text/html; charset=utf-8", 70), analysisOutput("report.md", "text/markdown; charset=utf-8", 60),
		analysisOutput("review_tasks.json", "application/json", 40), analysisOutput("storyboard.jpg", "image/jpeg", 200),
		analysisOutput("audio.png", "image/png", 8), analysisOutput("shots/shot_001.jpg", "image/jpeg", 30),
		analysisOutput("packaging/subtitles.srt", "application/x-subrip", 5), analysisOutput("packaging/overlays.ass", "text/x-ssa; charset=utf-8", 5),
		analysisOutput("packaging/timeline.json", "application/json", 5), analysisOutput("packaging/sticker_01.jpg", "image/jpeg", 7),
		analysisOutput("stems/vocals.wav", "audio/wav", 1000),
	}
	items, files, err := checkAnalysisOutputs(full)
	if err != nil || len(items) != len(full) || files != 200+8+30+7+1000 {
		t.Fatal("a full analysis", len(items), files, err)
	}
	for _, item := range items {
		if inline := !strings.HasSuffix(item.Name, ".jpg") && !strings.HasSuffix(item.Name, ".png") && !strings.HasSuffix(item.Name, ".wav"); item.inline != inline {
			t.Error(item.Name, "inline", item.inline)
		}
	}
	for name, outputs := range map[string][]editOutput{
		"no breakdown":          full[1:],
		"an unknown file":       append(full[:1:1], analysisOutput("env.json", "application/json", 5)),
		"a file in another dir": append(full[:1:1], analysisOutput("other/a.jpg", "image/jpeg", 5)),
		"a wrong type":          append(full[:1:1], analysisOutput("storyboard.jpg", "image/png", 5)),
		"a path out":            append(full[:1:1], analysisOutput("shots/../x.jpg", "image/jpeg", 5)),
		"an empty file":         append(full[:1:1], analysisOutput("audio.png", "image/png", 0)),
		"past its cap":          append(full[:1:1], analysisOutput("summary.txt", "text/plain; charset=utf-8", 64<<10+1)),
		"the same name twice":   append(full[:1:1], full[0]),
		"a stem of its own":     append(full[:1:1], analysisOutput("stems/drums.wav", "audio/wav", 5)),
		"a short digest":        {{Name: "breakdown.json", ContentType: "application/json", Size: 5, SHA256: "abc"}},
	} {
		if _, _, err := checkAnalysisOutputs(outputs); err == nil {
			t.Error(name, "was taken")
		}
	}
	if analysisArtifactName("shots/shot_001.jpg") != "shots-shot_001.jpg" || analysisField("packaging/subtitles.srt") != "analysis-packaging-subtitles.srt" {
		t.Fatal("artifact names")
	}
}

func TestAnalysisDeliveryIsBoundedAndNamesItsFiles(t *testing.T) {
	job := &analysisJob{ID: "an-1", NodeID: "breakdown", Source: editFile{Name: "ref/clip.mp4"}}
	report := readAnalysisReport(json.RawMessage(`{"schema":"rea_video.breakdown.v1","lang":"zh","video":{"seconds":19.04,"width":480,"height":854,"fps":24,"aspect":"9:16","sound":true},
		"verdict":"混合制作：代码/模板渲染 59% + AI 生成视频 41%","shots":10,"confidence":0.57,"vlm":"off","warnings":null}`))
	items := []analysisKept{}
	for i := 0; i < 50; i++ {
		items = append(items, analysisKept{editOutput: editOutput{Name: fmt.Sprintf("shots/shot_%03d.jpg", i)}})
	}
	text := analysisDelivery(job, report, "结论: 混合制作\n#1 code_render 0.53\n", items)
	for _, want := range []string{"Video breakdown of ref_clip.mp4 (19.0 s, 480x854, 10 shots)", "结论: 混合制作", `"verdict":"混合制作`, "Files (50): breakdown/shots-shot_000.jpg", "and 10 more"} {
		if !strings.Contains(text, want) {
			t.Errorf("the delivery lacks %q:\n%s", want, text)
		}
	}
	if report.Warnings == nil {
		t.Fatal("warnings must be a list")
	}
	long := strings.Repeat("一二三四五六七八九十\n", 4000)
	text = analysisDelivery(job, report, long, items)
	if len(text) > maxAnalysisDeliveryBytes || !strings.Contains(text, "summary cut here") || !strings.Contains(text, "Files (50)") {
		t.Fatal("a long summary", len(text))
	}
	if cut, ok := cutUTF8("长长长", 4); !ok || cut != "长" {
		t.Fatal("a cut inside a character", cut, ok)
	}
}

// fakeAnalysisWorker answers the worker's routes (apps/video-analysis-worker/server.mjs) as tests need them.
type fakeAnalysisWorker struct {
	server    *httptest.Server
	mu        sync.Mutex
	manifests []map[string]any
	files     map[string][]byte
	deleted   []string
	busy      int
	refusal   string
	outputs   map[string][]byte
	types     map[string]string
}

func newFakeAnalysisWorker(t *testing.T, token string) *fakeAnalysisWorker {
	f := &fakeAnalysisWorker{files: map[string][]byte{},
		outputs: map[string][]byte{
			"breakdown.json":          []byte(`{"schema":"rea_video.breakdown.v1","source":{"path":"input.mp4"}}`),
			"summary.txt":             []byte("dual_role.mp4 | 19.042s 480x854 24.0fps\n结论: 混合制作\n"),
			"report.html":             []byte("<!doctype html><title>report</title><p>report</p>"),
			"storyboard.jpg":          testJPEG,
			"audio.png":               testPNG,
			"shots/shot_001.jpg":      testJPEG,
			"packaging/subtitles.srt": []byte("1\n00:00:00,000 --> 00:00:01,000\n笔记没人看\n"),
		},
		types: map[string]string{"breakdown.json": "application/json", "summary.txt": "text/plain; charset=utf-8", "report.html": "text/html; charset=utf-8",
			"storyboard.jpg": "image/jpeg", "audio.png": "image/png", "shots/shot_001.jpg": "image/jpeg", "packaging/subtitles.srt": "application/x-subrip"},
	}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(401)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, "/internal/analyses")
		parts := strings.SplitN(strings.TrimPrefix(rest, "/"), "/", 3)
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && rest == "":
			if f.busy > 0 {
				f.busy--
				writeJSON(w, 429, map[string]any{"error": map[string]any{"code": "WORKER_BUSY", "message": "An analysis is already in progress."}})
				return
			}
			var manifest map[string]any
			_ = json.NewDecoder(r.Body).Decode(&manifest)
			f.manifests = append(f.manifests, manifest)
			writeJSON(w, 201, map[string]any{"analysisId": manifest["analysisId"], "expiresInSeconds": 600})
		case r.Method == http.MethodPut && len(parts) == 2 && parts[1] == "file":
			data, _ := io.ReadAll(r.Body)
			f.files[parts[0]] = data
			w.WriteHeader(204)
		case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "run":
			if f.refusal != "" {
				writeJSON(w, 400, map[string]any{"error": map[string]any{"code": "INVALID_ANALYSIS", "message": f.refusal, "field": "file", "detail": "too_long"}})
				return
			}
			outputs := []any{}
			for _, name := range []string{"breakdown.json", "summary.txt", "report.html", "storyboard.jpg", "audio.png", "shots/shot_001.jpg", "packaging/subtitles.srt"} {
				sum := sha256.Sum256(f.outputs[name])
				outputs = append(outputs, map[string]any{"name": name, "kind": "x", "contentType": f.types[name], "size": len(f.outputs[name]), "sha256": hex.EncodeToString(sum[:])})
			}
			summary := string(f.outputs["summary.txt"])
			writeJSON(w, 200, map[string]any{"analysisId": parts[0], "summary": summary, "outputs": outputs,
				"report": map[string]any{"schema": "rea_video.breakdown.v1", "lang": "zh", "video": map[string]any{"seconds": 19.04, "width": 480, "height": 854, "fps": 24, "aspect": "9:16", "sound": true},
					"verdict": "混合制作：代码/模板渲染 59% + AI 生成视频 41%", "shots": 10, "confidence": 0.567, "vlm": "off", "warnings": []string{}}})
		case r.Method == http.MethodGet && len(parts) == 3 && parts[1] == "outputs":
			data, ok := f.outputs[parts[2]]
			if !ok {
				w.WriteHeader(404)
				return
			}
			_, _ = w.Write(data)
		case r.Method == http.MethodDelete && len(parts) == 1:
			f.deleted = append(f.deleted, parts[0])
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

// The executor's steps against a worker, without a database: the manifest (asked again while the worker is busy), the
// video's bytes, the run, and the outputs read back, checked and kept.
func TestAnalysisWorkerProtocol(t *testing.T) {
	token := strings.Repeat("w", 40)
	worker := newFakeAnalysisWorker(t, token)
	worker.busy = 1
	media := t.TempDir()
	a := &App{cfg: Config{}}
	a.cfg.AnalysisURL, a.cfg.AnalysisToken, a.cfg.MediaDir = worker.server.URL, token, media
	sum := sha256.Sum256(testMP4)
	digest := hex.EncodeToString(sum[:])
	rel := "t-proto/r-proto/" + digest + ".mp4"
	if err := os.MkdirAll(filepath.Join(media, "t-proto", "r-proto"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(media, filepath.FromSlash(rel)), testMP4, 0o640); err != nil {
		t.Fatal(err)
	}
	job := &analysisJob{ID: "an-proto-0001", CanvasID: "cv", NodeID: "breakdown", Options: json.RawMessage(`{"lang":"en","review":true}`),
		Source: editFile{Name: "video-1.mp4", ContentType: "video/mp4", Size: int64(len(testMP4)), SHA256: digest, Path: rel}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := a.createWorkerAnalysis(ctx, job); err != nil {
		t.Fatal("the manifest", err)
	}
	if err := a.putWorkerAnalysisFile(ctx, "t-proto", job); err != nil {
		t.Fatal("the file", err)
	}
	reply, err := a.runWorkerAnalysis(ctx, job)
	if err != nil {
		t.Fatal("the run", err)
	}
	kept, err := a.fetchAnalysisOutputs(ctx, "t-proto", job, reply.Outputs)
	if err != nil {
		t.Fatal("the outputs", err)
	}
	worker.mu.Lock()
	manifest, sent, deleted := worker.manifests[0], worker.files[job.ID], worker.deleted
	worker.mu.Unlock()
	file := manifest["file"].(map[string]any)
	if file["name"] != "video-1.mp4" || file["sha256"] != digest || manifest["options"].(map[string]any)["lang"] != "en" || !bytes.Equal(sent, testMP4) || len(deleted) != 1 {
		t.Fatalf("what the worker got: %v, %d bytes, deleted %v", manifest, len(sent), deleted)
	}
	var stored []string
	for _, item := range kept.items {
		switch {
		case item.inline && item.data == nil, !item.inline && item.final == "":
			t.Errorf("%s was not kept", item.Name)
		case !item.inline:
			data, err := os.ReadFile(filepath.Join(media, filepath.FromSlash(item.final)))
			if err != nil || !bytes.Equal(data, worker.outputs[item.Name]) || !strings.HasPrefix(item.final, "t-proto/an-proto-0001/") {
				t.Errorf("%s stored as %s: %v", item.Name, item.final, err)
			}
			stored = append(stored, filepath.Join(media, filepath.FromSlash(item.final)))
		}
	}
	if len(stored) != 3 {
		t.Fatal("the files kept", stored)
	}
	kept.discard()
	for _, path := range stored {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Error("a file of an unsaved analysis stayed", path)
		}
	}
	// A picture whose bytes are not the type the worker named is refused.
	worker.mu.Lock()
	worker.outputs["storyboard.jpg"] = testPNG
	worker.mu.Unlock()
	bad := reply.Outputs
	for i := range bad {
		if bad[i].Name == "storyboard.jpg" {
			s := sha256.Sum256(testPNG)
			bad[i].Size, bad[i].SHA256 = int64(len(testPNG)), hex.EncodeToString(s[:])
		}
	}
	if kept, err = a.fetchAnalysisOutputs(ctx, "t-proto", job, bad); err == nil {
		t.Fatal("a PNG kept as a JPEG")
	}
	kept.discard()
}

// A canvas run makes a clip and the video breakdown node analyses it on the worker: the worker gets the clip's bytes,
// the report, summary and pictures become the canvas's artifacts, and the node delivers text naming its files.
func TestPostgresGraphAnalyzeNodeBreaksDownAClip(t *testing.T) {
	h, rh := newMediaHarness(t)
	rh.query = func(task string, n int) (int, any) {
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.mp4")
	}
	token := strings.Repeat("v", 40)
	worker := newFakeAnalysisWorker(t, token)
	h.a.cfg.AnalysisURL, h.a.cfg.AnalysisToken = worker.server.URL, token
	c, tid, _ := h.register(t, "analysis-graph@example.test")
	base := "/tenants/" + tid
	clip := mediaNode("clip", mediaKindVideo, "rh.seedance-2", nil)
	clip["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": "a lighthouse at dusk", "createdAt": 0}}
	doc := map[string]any{"nodes": []any{clip, map[string]any{"id": "breakdown", "kind": "analyze", "title": "拆解", "analyze": map[string]any{"lang": "zh"}}},
		"edges": []any{edge("c-b", "clip", "result", "breakdown", "video", "video")}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Breakdown", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	run := func(want string) map[string]any {
		t.Helper()
		graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
		for _, raw := range awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), want, 20*time.Second)["nodes"].([]any) {
			if n := raw.(map[string]any); n["nodeId"] == "breakdown" {
				return n
			}
		}
		t.Fatal("no breakdown node")
		return nil
	}

	node := run("completed")
	output := fmt.Sprint(node["output"])
	if node["state"] != "done" || !strings.Contains(output, "Video breakdown of video-1.mp4 (19.0 s, 480x854, 10 shots)") || !strings.Contains(output, "结论: 混合制作") ||
		!strings.Contains(output, "breakdown/storyboard.jpg") || !strings.Contains(output, "breakdown/shots-shot_001.jpg") || strings.Contains(output, h.a.cfg.MediaDir) {
		t.Fatalf("the breakdown node's delivery %v", node)
	}
	worker.mu.Lock()
	manifests, deleted := worker.manifests, worker.deleted
	var sent []byte
	for _, data := range worker.files {
		sent = data
	}
	worker.mu.Unlock()
	if len(manifests) != 1 || manifests[0]["file"].(map[string]any)["name"] != "video-1.mp4" || !bytes.Equal(sent, testMP4) || len(deleted) != 2 || deleted[0] != deleted[1] {
		t.Fatalf("what the worker was sent: %v, %d bytes, deleted %v", manifests, len(sent), deleted)
	}
	var path, sum string
	if e := h.db.QueryRow(t.Context(), "SELECT storage_path,sha256 FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND node_id='breakdown' AND field_id='analysis-storyboard.jpg'", tid, cid).Scan(&path, &sum); e != nil {
		t.Fatal("the storyboard's artifact", e)
	}
	if stored, err := os.ReadFile(filepath.Join(h.a.cfg.MediaDir, filepath.FromSlash(path))); err != nil || !bytes.Equal(stored, testJPEG) {
		t.Fatal("the stored storyboard", err)
	}
	var breakdown []byte
	if e := h.db.QueryRow(t.Context(), "SELECT content FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND field_id='analysis-breakdown.json'", tid, cid).Scan(&breakdown); e != nil || !strings.Contains(string(breakdown), "rea_video.breakdown.v1") {
		t.Fatal("the breakdown's artifact", string(breakdown), e)
	}
	var status, source string
	var attempts int
	if e := h.db.QueryRow(t.Context(), "SELECT status,attempts,source::text FROM analysis_jobs WHERE tenant_id=$1", tid).Scan(&status, &attempts, &source); e != nil || status != "completed" || attempts != 1 || source != "{}" {
		t.Fatal("the job row (a completed job keeps no copy of its source)", status, attempts, source, e)
	}
	if analyze := h.request(t, c, "GET", base+"/capabilities", nil, 200)["analyze"].(map[string]any); analyze["enabled"] != true || analyze["usedToday"] != float64(1) {
		t.Fatal("the analyses used today", analyze)
	}
	// The platform's failures are not charged, a video's own failure is.
	for i, code := range []string{"analysis_unavailable", "analysis_busy", "interrupted", "analysis_file_missing", "analysis_file_mismatch", "analysis_storage_failed", "media_storage_full", "analysis_rejected"} {
		if _, e := h.db.Exec(t.Context(), "INSERT INTO analysis_jobs(id,tenant_id,canvas_id,graph_id,node_id,status,error_code,started_at) VALUES($1,$2,$3,'g-ledger','breakdown','failed',$4,now())",
			fmt.Sprintf("an-ledger-%d", i), tid, cid, code); e != nil {
			t.Fatal(e)
		}
	}
	if analyze := h.request(t, c, "GET", base+"/capabilities", nil, 200)["analyze"].(map[string]any); analyze["usedToday"] != float64(2) {
		t.Fatal("the analyses charged today (the completed one and the refused one)", analyze)
	}
	if _, e := h.db.Exec(t.Context(), "DELETE FROM analysis_jobs WHERE tenant_id=$1 AND graph_id='g-ledger'", tid); e != nil {
		t.Fatal(e)
	}

	// A video the worker refuses fails the node with the worker's words.
	worker.mu.Lock()
	worker.refusal = "The video is 400 s long; at most 300 s are analysed."
	worker.mu.Unlock()
	if node = run("failed"); node["state"] != "failed" || node["detail"] != "analysis_rejected: The video is 400 s long; at most 300 s are analysed." {
		t.Fatalf("a refused video %v", node)
	}
}

func TestPostgresGraphRunWithAnAnalyzeNodeNeedsTheWorker(t *testing.T) {
	h, _ := newMediaHarness(t)
	h.a.cfg.AnalysisURL, h.a.cfg.AnalysisToken = "", ""
	c, tid, _ := h.register(t, "analysis-no-worker@example.test")
	base := "/tenants/" + tid
	doc := map[string]any{"nodes": []any{map[string]any{"id": "breakdown", "kind": "analyze", "title": "拆解", "analyze": map[string]any{"source": "aUpload12345"}}}, "edges": []any{}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Breakdown", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	refused := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 409)
	if !strings.Contains(fmt.Sprint(refused), "analysis_unavailable") {
		t.Fatal("refusal", refused)
	}
	if analyze := h.request(t, c, "GET", base+"/capabilities", nil, 200)["analyze"].(map[string]any); analyze["enabled"] != false {
		t.Fatal("the capability without a worker", analyze)
	}
}
