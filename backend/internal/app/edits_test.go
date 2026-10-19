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
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func editDocument(timeline string, edges ...map[string]any) []byte {
	doc := map[string]any{
		"nodes": []any{
			map[string]any{"id": "clip", "kind": "session", "agentKind": "video", "title": "Clip", "binding": map[string]string{"agentId": "a"}},
			map[string]any{"id": "line", "kind": "session", "agentKind": "audio", "title": "Line", "binding": map[string]string{"agentId": "a"}},
			map[string]any{"id": "cut", "kind": "session", "agentKind": "llm", "title": "Cut", "binding": map[string]string{"agentId": "a"}},
			map[string]any{"id": "edit", "kind": "edit", "title": "Edit", "timeline": timeline},
		},
		"edges": edges,
	}
	raw, _ := json.Marshal(doc)
	return raw
}

func edge(id, from, fromPort, to, toPort, dataType string) map[string]any {
	return map[string]any{"id": id, "fromNode": from, "fromPort": fromPort, "toNode": to, "toPort": toPort, "dataType": dataType}
}

// An edit node takes clips, sounds and pictures of their own types and one timeline; its film is a video.
func TestParseGraphEditNode(t *testing.T) {
	ok := []map[string]any{edge("c", "clip", "result", "edit", "clips", "video"), edge("l", "line", "result", "edit", "sounds", "audio"), edge("t", "cut", "result", "edit", "timeline", "text")}
	if _, _, err := parseGraph(editDocument("", ok...), nil); err != nil {
		t.Fatal("a wired edit node", err)
	}
	if _, _, err := parseGraph(editDocument(`{"schema":"awwo.timeline/1"}`, ok[:2]...), nil); err != nil {
		t.Fatal("an edit node with its own timeline", err)
	}
	for name, edges := range map[string][]map[string]any{
		"no timeline":           ok[:2],
		"sound into clips":      {edge("l", "line", "result", "edit", "clips", "audio"), ok[2]},
		"two timelines":         {ok[2], edge("t2", "clip", "result", "edit", "timeline", "video")},
		"an unknown edit input": {edge("c", "clip", "result", "edit", "reference", "video"), ok[2]},
	} {
		if _, _, err := parseGraph(editDocument("", edges...), nil); err == nil {
			t.Error(name, "was accepted")
		}
	}
	// The film feeds another edit's clips, or a text input (a reviewer reads its file list).
	var n graphNode
	_ = json.Unmarshal([]byte(`{"id":"edit","kind":"edit"}`), &n)
	if st, ok := nodePort(n, "result", false); !ok || st != "video" || !edgeTypesFit(n, "result", "video", "text") || !graphMediaSource(n) {
		t.Fatal("the film's port", st, ok)
	}
}

func TestParseEditTimelineFindsItsFiles(t *testing.T) {
	timeline := `{"schema":"awwo.timeline/1","tracks":{"video":[{"source":"clip/video-1.mp4"},{"card":"<html></html>","seconds":2},{"source":"clip/video-1.mp4"}],"dialogue":[{"source":"line/audio-1.mp3"}],"sfx":[{"source":"bed/audio-1.mp3"}]}}`
	var want any
	_ = json.Unmarshal([]byte(timeline), &want)
	for _, text := range []string{timeline, "Here is the cut:\n```json\n" + timeline + "\n```\nDone.", "The timeline: " + timeline + " (24 fps)", timeline + "\nNotes: all wired."} {
		raw, sources, err := parseEditTimeline(text)
		var got any
		if err != nil || strings.Join(sources, ",") != "clip/video-1.mp4,line/audio-1.mp3,bed/audio-1.mp3" || json.Unmarshal(raw, &got) != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%q: %v %v %s", text, sources, err, raw)
		}
	}
	// Written again for jsonb: a lone surrogate (which jsonb refuses) reads as U+FFFD; numbers and markup stay as written.
	raw, _, err := parseEditTimeline(`{"schema":"awwo.timeline/1","tracks":{"video":[{"card":"<b>A&amp;B</b>","seconds":2.50}]},"subtitles":[{"start":0,"end":1,"text":"x\ud800y"}]}`)
	if err != nil || strings.Contains(string(raw), `\ud800`) || !strings.Contains(string(raw), "x\uFFFDy") || !strings.Contains(string(raw), `"<b>A&amp;B</b>"`) || !strings.Contains(string(raw), `2.50`) {
		t.Fatalf("a lone surrogate: %s %v", raw, err)
	}
	for _, bad := range []string{"no json here", `{"schema":"other","tracks":{}}`, `{"schema":"awwo.timeline/1","tracks":{"video":[{"source":"../../etc/passwd"}]}}`, `{"schema":"awwo.timeline/1","tracks":{"video":{}}}`,
		`{"schema":"awwo.timeline/1","name":"a\u0000b","tracks":{"video":[]}}`} {
		if _, _, err := parseEditTimeline(bad); err == nil {
			t.Error("accepted", bad)
		}
	}
}

func TestEditWorkerErrorsAndOutputs(t *testing.T) {
	refused := editWorkerError(400, []byte(`{"error":{"code":"INVALID_EDIT","message":"tracks.video[0].out is past the end of clip/video-1.mp4 (5.042 s)","field":"tracks.video[0].out"}}`))
	if e, ok := refused.(editError); !ok || e.code != "edit_rejected" || editFailureDetail(e.code, e.detail) != "edit_rejected: tracks.video[0].out is past the end of clip/video-1.mp4 (5.042 s)" {
		t.Fatal("a refused timeline", refused)
	}
	// The worker's own trouble (a 5xx, a job it no longer holds) is the platform's, not charged; a refused size is the film's.
	for status, want := range map[int]string{429: "edit_busy", 503: "edit_unavailable", 401: "edit_unavailable", 404: "edit_unavailable", 409: "edit_unavailable", 500: "edit_unavailable", 502: "edit_unavailable"} {
		if e := editWorkerError(status, nil).(editError); e.code != want {
			t.Error(status, e.code)
		}
	}
	if e := editWorkerError(422, []byte(`{"error":{"code":"EDIT_FAILED","detail":"timeout"}}`)).(editError); e.code != "timeout" {
		t.Error("timeout", e)
	}
	odd := editWorkerError(400, []byte(`{"error":{"code":"EDIT_FILE_UNSUPPORTED","message":"art/image-1.bmp is not a file an edit takes (MP4, MOV, WebM, MP3, WAV, Ogg, FLAC, PNG, JPEG, WebP or GIF)."}}`)).(editError)
	if !strings.HasPrefix(editFailureDetail(odd.code, odd.detail), "edit_rejected: art/image-1.bmp is not a file an edit takes") {
		t.Error("a file of no container an edit takes", odd)
	}
	large := editWorkerError(422, []byte(`{"error":{"code":"EDIT_FAILED","detail":"film_too_large","message":"The film is 9 bytes, more than the 8 the API stores"}}`)).(editError)
	if editFailureDetail(large.code, large.detail) != "edit_rejected: The film is 9 bytes, more than the 8 the API stores" {
		t.Error("a film too large", large)
	}
	// A step this API ran out of time for is the platform's, whatever its cut-off call answered; a step the caller
	// stopped, or one that failed in time, keeps its own error.
	slow := func(step context.Context) error { <-step.Done(); return editError{"edit_failed", "reply_unreadable"} }
	if e := editStep(context.Background(), 20*time.Millisecond, slow).(editError); e.code != "edit_unavailable" {
		t.Error("a step past its time", e)
	}
	stopped, cancel := context.WithCancel(context.Background())
	cancel()
	if e := editStep(stopped, time.Minute, slow).(editError); e.code != "edit_failed" {
		t.Error("a stopped step", e)
	}
	if e := editStep(context.Background(), time.Minute, func(context.Context) error { return editError{"edit_rejected", "x"} }).(editError); e.code != "edit_rejected" {
		t.Error("a step that failed in time", e)
	}
	a := &App{cfg: Config{}}
	a.cfg.MediaMaxFileBytes = 1 << 20
	digest := strings.Repeat("a", 64)
	good := []editOutput{{"R1.mp4", "video", "video/mp4", 10, digest}, {"R1.srt", "subtitles", "application/x-subrip", 5, digest}, {"still-001.jpg", "still", "image/jpeg", 5, digest}, {"report.json", "report", "application/json", 2, digest}}
	if items, total, err := a.checkEditOutputs(good); err != nil || len(items) != 4 || total != 22 {
		t.Fatal("good outputs", items, total, err)
	}
	for name, outputs := range map[string][]editOutput{
		"no film":       good[1:],
		"two films":     append([]editOutput{{"R2.mp4", "video", "video/mp4", 10, digest}}, good...),
		"a path":        {{"../x.mp4", "video", "video/mp4", 10, digest}},
		"a wrong type":  {{"R1.mp4", "video", "video/webm", 10, digest}},
		"too large":     {{"R1.mp4", "video", "video/mp4", 2 << 20, digest}},
		"an extra kind": append([]editOutput{{"x.html", "page", "text/html", 1, digest}}, good...),
	} {
		if _, _, err := a.checkEditOutputs(outputs); err == nil {
			t.Error(name, "was accepted")
		}
	}
}

func TestEditRecordReadsLikeAClipWithItsFiles(t *testing.T) {
	job := &editJob{ID: "edJOB", NodeID: "edit"}
	items := []keptOutput{
		{editOutput: editOutput{Name: "R1.mp4", ContentType: "video/mp4", Size: 900}, role: "film"},
		{editOutput: editOutput{Name: "R1.srt", ContentType: "application/x-subrip", Size: 40}, role: "subtitles"},
		{editOutput: editOutput{Name: "still-001.jpg", ContentType: "image/jpeg", Size: 30}, role: "still"},
	}
	record := editRecord("t1", job, items, json.RawMessage(`{"seconds":12.5,"frames":300,"fps":24,"width":1920,"height":822,"loudness":{"integratedLUFS":-16},"warnings":["audio_cut_at_end:m1"]}`))
	var out struct {
		Type, Kind, Model string
		Items             []mediaItem
		Edit              struct {
			Seconds float64
			Files   []map[string]any
		}
	}
	if json.Unmarshal([]byte(record), &out) != nil || out.Type != mediaOutputType || out.Kind != "video" || out.Model != editModelID || len(out.Items) != 1 || len(out.Edit.Files) != 2 || out.Edit.Seconds != 12.5 {
		t.Fatal("record", record)
	}
	if out.Items[0].ArtifactID != artifactID("t1", "edJOB", "edit", "edit-film") || out.Edit.Files[1]["artifactId"] != artifactID("t1", "edJOB", "edit", "edit-still-001") {
		t.Fatal("artifact ids", record)
	}
	text := mediaDeliveryText(graphNode{ID: "edit", Kind: "edit", Title: "Reel 1"}, record)
	for _, want := range []string{"「Reel 1」生成的视频文件", "- edit/R1.mp4（video/mp4，900 字节）", "成片（12.5 秒）", "- edit/R1.srt（application/x-subrip，40 字节；字幕（SRT））", "- edit/still-001.jpg"} {
		if !strings.Contains(text, want) {
			t.Fatalf("delivery text lacks %q:\n%s", want, text)
		}
	}
	if got := mediaMissingText(graphNode{ID: "edit", Kind: "edit", Title: "Reel 1"}); !strings.Contains(got, "视频文件") {
		t.Fatal("missing text", got)
	}
}

// fakeEditWorker answers the render worker's edit routes: it keeps every manifest and file it is sent, and answers a
// render with a film, subtitles, a still and a report (or with refusal, when set).
type fakeEditWorker struct {
	mu        sync.Mutex
	server    *httptest.Server
	manifests []map[string]any
	files     map[string][]byte
	deleted   []string
	refusal   string
	outputs   map[string][]byte
	// With gate set, a render first says so on entered, then waits for gate (or its caller leaving).
	gate, entered chan struct{}
	renders       int
	stopped       int
}

var testJPEG = append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{7}, 300)...)

func newFakeEditWorker(t *testing.T, token string) *fakeEditWorker {
	f := &fakeEditWorker{files: map[string][]byte{}, outputs: map[string][]byte{
		"R1.mp4": testMP4, "R1.srt": []byte("1\n00:00:00,500 --> 00:00:01,500\nA line.\n"), "still-001.jpg": testJPEG,
		"report.json": []byte(`{"schema":"awwo.edit-report/1","seconds":4.5,"frames":108,"fps":24,"width":640,"height":360,"loudness":{"integratedLUFS":-16},"warnings":[]}`),
	}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(401)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/internal/edits"), "/")
		if r.Method == http.MethodPost && len(parts) == 3 && parts[2] == "render" {
			f.mu.Lock()
			f.renders++
			gate, entered := f.gate, f.entered
			f.mu.Unlock()
			if gate != nil {
				entered <- struct{}{}
				select {
				case <-gate:
				case <-r.Context().Done():
					f.mu.Lock()
					f.stopped++
					f.mu.Unlock()
					return
				}
			}
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && len(parts) == 1:
			var manifest map[string]any
			_ = json.NewDecoder(r.Body).Decode(&manifest)
			f.manifests = append(f.manifests, manifest)
			writeJSON(w, 201, map[string]any{"editId": manifest["editId"], "files": len(manifest["files"].([]any)), "expiresInSeconds": 600})
		case r.Method == http.MethodPut && len(parts) == 4 && parts[2] == "files":
			data, _ := io.ReadAll(r.Body)
			f.files[parts[1]+"/"+parts[3]] = data
			w.WriteHeader(204)
		case r.Method == http.MethodPost && len(parts) == 3 && parts[2] == "render":
			if f.refusal != "" {
				writeJSON(w, 400, map[string]any{"error": map[string]any{"code": "INVALID_EDIT", "message": f.refusal, "field": "tracks.video[0].out"}})
				return
			}
			outputs := []any{}
			for _, name := range []string{"R1.mp4", "R1.srt", "still-001.jpg", "report.json"} {
				kind := map[string]string{"R1.mp4": "video", "R1.srt": "subtitles", "still-001.jpg": "still", "report.json": "report"}[name]
				contentType := map[string]string{"R1.mp4": "video/mp4", "R1.srt": "application/x-subrip", "still-001.jpg": "image/jpeg", "report.json": "application/json"}[name]
				sum := sha256.Sum256(f.outputs[name])
				outputs = append(outputs, map[string]any{"name": name, "kind": kind, "contentType": contentType, "size": len(f.outputs[name]), "sha256": hex.EncodeToString(sum[:])})
			}
			writeJSON(w, 200, map[string]any{"editId": parts[1], "report": json.RawMessage(f.outputs["report.json"]), "outputs": outputs})
		case r.Method == http.MethodGet && len(parts) == 4 && parts[2] == "outputs":
			_, _ = w.Write(f.outputs[parts[3]])
		case r.Method == http.MethodDelete && len(parts) == 2:
			f.deleted = append(f.deleted, parts[1])
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

// A canvas run makes a clip, an agent writes the cut, and the edit node joins them into a film: the worker gets only
// the files the timeline names, the film and its files become the canvas's artifacts, and the node delivers a video.
func TestPostgresGraphEditNodeJoinsAClipIntoAFilm(t *testing.T) {
	var mu sync.Mutex
	timeline := `{"schema":"awwo.timeline/1","name":"R1","output":{"width":640,"height":360},"tracks":{"video":[{"source":"clip/video-1.mp4","in":0.2,"out":4.7}]}}`
	answer := "Here is the cut.\n```json\n" + timeline + "\n```"
	pi := runtimeProvider(t, runtimePI, func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
		mu.Lock()
		defer mu.Unlock()
		completePi(w, answer)
	})
	t.Cleanup(pi.Close)
	h := newHarness(t, pi.URL)
	rh := newFakeRunningHub(t)
	rh.query = func(task string, n int) (int, any) {
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.mp4")
	}
	rh.configure(h.a)
	token := strings.Repeat("r", 40)
	worker := newFakeEditWorker(t, token)
	h.a.cfg.RenderURL, h.a.cfg.RenderToken = worker.server.URL, token

	c, tid, _ := h.register(t, "edit-graph@example.test")
	base := "/tenants/" + tid
	aid := h.request(t, c, "POST", base+"/agents", map[string]any{"name": "Cut", "adapterType": "pi", "model": "test-model", "instructions": "CUT"}, 201)["id"].(string)
	clip := mediaNode("clip", mediaKindVideo, "rh.seedance-2", nil)
	clip["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": "a lighthouse at dusk", "createdAt": 0}}
	cut := map[string]any{"id": "cut", "kind": "session", "title": "Cut", "runtime": "pi", "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": aid}}
	doc := map[string]any{"nodes": []any{clip, cut, map[string]any{"id": "edit", "kind": "edit", "title": "Reel 1"}},
		"edges": []any{edge("c-e", "clip", "result", "edit", "clips", "video"), edge("t-e", "cut", "result", "edit", "timeline", "text")}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Edit", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	run := func(want string) map[string]map[string]any {
		t.Helper()
		graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
		out := map[string]map[string]any{}
		for _, raw := range awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), want, 20*time.Second)["nodes"].([]any) {
			n := raw.(map[string]any)
			out[n["nodeId"].(string)] = n
		}
		return out
	}

	nodes := run("completed")
	var record struct {
		Kind, Model string
		Items       []mediaItem
		Edit        struct{ Files []map[string]any }
	}
	if nodes["edit"]["state"] != "done" || json.Unmarshal([]byte(nodes["edit"]["output"].(string)), &record) != nil || record.Kind != "video" || record.Model != editModelID ||
		len(record.Items) != 1 || record.Items[0].Name != "R1.mp4" || len(record.Edit.Files) != 3 {
		t.Fatalf("the edit node's delivery %v", nodes["edit"])
	}
	worker.mu.Lock()
	manifests, deleted := worker.manifests, worker.deleted
	var clipBytes []byte
	for key, data := range worker.files {
		if strings.HasSuffix(key, "/0") {
			clipBytes = data
		}
	}
	worker.mu.Unlock()
	files := manifests[0]["files"].([]any)
	if len(manifests) != 1 || len(files) != 1 || files[0].(map[string]any)["name"] != "clip/video-1.mp4" || !bytes.Equal(clipBytes, testMP4) || len(deleted) != 2 || deleted[0] != deleted[1] {
		t.Fatalf("what the worker was sent: %v %d bytes, deleted %v", manifests, len(clipBytes), deleted)
	}
	var want any
	_ = json.Unmarshal([]byte(timeline), &want)
	if got, _ := json.Marshal(manifests[0]["timeline"]); !reflect.DeepEqual(manifests[0]["timeline"], want) {
		t.Fatalf("the timeline sent %s", got)
	}
	var path, sum string
	if e := h.db.QueryRow(t.Context(), "SELECT storage_path,sha256 FROM artifacts WHERE tenant_id=$1 AND id=$2", tid, record.Items[0].ArtifactID).Scan(&path, &sum); e != nil {
		t.Fatal("the film's artifact", e)
	}
	if stored, err := os.ReadFile(filepath.Join(h.a.cfg.MediaDir, filepath.FromSlash(path))); err != nil || !bytes.Equal(stored, testMP4) {
		t.Fatal("the stored film", err)
	}
	var subtitles []byte
	if e := h.db.QueryRow(t.Context(), "SELECT content FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND field_id='edit-subtitles'", tid, cid).Scan(&subtitles); e != nil || !strings.Contains(string(subtitles), "A line.") {
		t.Fatal("the subtitles' artifact", string(subtitles), e)
	}
	var status string
	var attempts int
	var kept string
	if e := h.db.QueryRow(t.Context(), "SELECT status,attempts,timeline::text||files::text FROM edit_jobs WHERE tenant_id=$1", tid).Scan(&status, &attempts, &kept); e != nil || status != "completed" || attempts != 1 || kept != "{}[]" {
		t.Fatal("the job row (a completed job keeps no copy of its timeline or files)", status, attempts, kept, e)
	}
	if edit := h.request(t, c, "GET", base+"/capabilities", nil, 200)["edit"].(map[string]any); edit["usedToday"] != float64(1) {
		t.Fatal("the edits used today", edit)
	}
	// The platform's failures are not charged, a film's own failure is (one timeout here), and so is a job that started
	// before it was cancelled; one cancelled before it started is not.
	for i, code := range []string{"edit_unavailable", "edit_busy", "interrupted", "edit_file_missing", "edit_file_mismatch", "edit_storage_failed", "media_storage_full", "timeout"} {
		if _, e := h.db.Exec(t.Context(), "INSERT INTO edit_jobs(id,tenant_id,canvas_id,graph_id,node_id,status,timeline,error_code,started_at) VALUES($1,$2,$3,'g-ledger','edit','failed','{}',$4,now())",
			fmt.Sprintf("ed-ledger-%d", i), tid, cid, code); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := h.db.Exec(t.Context(), "INSERT INTO edit_jobs(id,tenant_id,canvas_id,graph_id,node_id,status,timeline,error_code) VALUES('ed-ledger-c',$1,$2,'g-ledger','edit','cancelled','{}','cancelled')", tid, cid); e != nil {
		t.Fatal(e)
	}
	if edit := h.request(t, c, "GET", base+"/capabilities", nil, 200)["edit"].(map[string]any); edit["usedToday"] != float64(2) {
		t.Fatal("the edits charged today (the completed one and the timeout)", edit)
	}
	if _, e := h.db.Exec(t.Context(), "DELETE FROM edit_jobs WHERE tenant_id=$1 AND graph_id='g-ledger'", tid); e != nil {
		t.Fatal(e)
	}
	// jsonb refuses a lone surrogate as it was written, and takes the timeline as admission writes it.
	written, _, _ := parseEditTimeline(`{"schema":"awwo.timeline/1","tracks":{"video":[]},"subtitles":[{"start":0,"end":1,"text":"x\ud800"}]}`)
	var ok bool
	if e := h.db.QueryRow(t.Context(), "SELECT $1::text::jsonb IS NOT NULL", string(written)).Scan(&ok); e != nil || !ok {
		t.Fatal("the written timeline as jsonb", e)
	}
	if e := h.db.QueryRow(t.Context(), "SELECT $1::text::jsonb IS NOT NULL", `{"t":"x\ud800"}`).Scan(&ok); e == nil {
		t.Fatal("jsonb took a lone surrogate: the check above proves nothing")
	}

	// A timeline the worker refuses fails the node with the worker's words, which the agent can act on.
	worker.mu.Lock()
	worker.refusal = "tracks.video[0].out is past the end of clip/video-1.mp4 (5.042 s)"
	worker.mu.Unlock()
	nodes = run("failed")
	if nodes["edit"]["state"] != "failed" || nodes["edit"]["detail"] != "edit_rejected: tracks.video[0].out is past the end of clip/video-1.mp4 (5.042 s)" {
		t.Fatalf("a refused timeline %v", nodes["edit"])
	}

	// A timeline naming a file no wired node delivered fails before anything is sent.
	mu.Lock()
	answer = strings.Replace(answer, "clip/video-1.mp4", "clip/video-9.mp4", 1)
	mu.Unlock()
	worker.mu.Lock()
	before := len(worker.manifests)
	worker.mu.Unlock()
	nodes = run("failed")
	worker.mu.Lock()
	after := len(worker.manifests)
	worker.mu.Unlock()
	if detail := fmt.Sprint(nodes["edit"]["detail"]); nodes["edit"]["state"] != "failed" || !strings.Contains(detail, "clip/video-9.mp4") || after != before {
		t.Fatalf("an unwired file %v (jobs sent %d → %d)", nodes["edit"], before, after)
	}
}

// A job whose executor is lost (as at a restart) is rendered again from its own row while its graph still runs; a
// cancelled graph stops its edit on the worker; past the day's allowance an edit is refused before it is sent.
func TestPostgresGraphEditNodeRestartCancelAndAllowance(t *testing.T) {
	timeline := `{"schema":"awwo.timeline/1","name":"R1","output":{"width":640,"height":360},"tracks":{"video":[{"source":"clip/video-1.mp4"}]}}`
	h, rh := newMediaHarness(t)
	rh.query = func(task string, n int) (int, any) {
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.mp4")
	}
	token := strings.Repeat("r", 40)
	worker := newFakeEditWorker(t, token)
	h.a.cfg.RenderURL, h.a.cfg.RenderToken = worker.server.URL, token
	c, tid, _ := h.register(t, "edit-restart@example.test")
	base := "/tenants/" + tid
	clip := mediaNode("clip", mediaKindVideo, "rh.seedance-2", nil)
	clip["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": "waves", "createdAt": 0}}
	doc := map[string]any{"nodes": []any{clip, map[string]any{"id": "edit", "kind": "edit", "title": "Reel", "timeline": timeline}},
		"edges": []any{edge("c-e", "clip", "result", "edit", "clips", "video")}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Edit", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	start := func() string {
		return h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)["id"].(string)
	}
	editNode := func(v map[string]any) map[string]any {
		for _, raw := range v["nodes"].([]any) {
			if n := raw.(map[string]any); n["nodeId"] == "edit" {
				return n
			}
		}
		return nil
	}
	gate := func() {
		worker.mu.Lock()
		worker.gate, worker.entered = make(chan struct{}), make(chan struct{}, 4)
		worker.mu.Unlock()
	}
	waitEntered := func() {
		t.Helper()
		select {
		case <-worker.entered:
		case <-time.After(15 * time.Second):
			t.Fatal("the render never reached the worker")
		}
	}

	// The executor is lost while the worker renders: the API is closing, so the job stays running; once the API is
	// back, the graph's next pass renders it again (a second attempt) and the node is done.
	gate()
	gid := start()
	waitEntered()
	var jobID string
	if e := h.db.QueryRow(t.Context(), "SELECT id FROM edit_jobs WHERE tenant_id=$1 AND graph_id=$2", tid, gid).Scan(&jobID); e != nil {
		t.Fatal(e)
	}
	h.a.mu.Lock()
	h.a.closed = true
	stop := h.a.running["edit:"+jobID]
	h.a.mu.Unlock()
	stop()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		h.a.mu.Lock()
		_, executing := h.a.running["edit:"+jobID]
		h.a.mu.Unlock()
		if !executing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the executor did not stop")
		}
	}
	var status string
	if e := h.db.QueryRow(t.Context(), "SELECT status FROM edit_jobs WHERE tenant_id=$1 AND id=$2", tid, jobID).Scan(&status); e != nil || status != "running" {
		t.Fatal("a job stopped by the closing API", status, e)
	}
	worker.mu.Lock()
	close(worker.gate)
	worker.gate = nil
	worker.mu.Unlock()
	h.a.mu.Lock()
	h.a.closed = false
	h.a.mu.Unlock()
	done := awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+gid, "completed", 20*time.Second)
	var attempts int
	if e := h.db.QueryRow(t.Context(), "SELECT status,attempts FROM edit_jobs WHERE tenant_id=$1 AND id=$2", tid, jobID).Scan(&status, &attempts); e != nil || status != "completed" || attempts != 2 || editNode(done)["state"] != "done" {
		t.Fatal("the job rendered again", status, attempts, e, editNode(done))
	}

	// A cancelled graph stops its edit: the worker sees its caller leave, and the job ends cancelled.
	gate()
	gid = start()
	waitEntered()
	worker.mu.Lock()
	stoppedBefore := worker.stopped
	worker.mu.Unlock()
	h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs/"+gid+"/cancel", map[string]any{}, 200)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		worker.mu.Lock()
		stopped := worker.stopped
		worker.mu.Unlock()
		if stopped == stoppedBefore+1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the worker's render was not stopped")
		}
	}
	if e := h.db.QueryRow(t.Context(), "SELECT status FROM edit_jobs WHERE tenant_id=$1 AND graph_id=$2", tid, gid).Scan(&status); e != nil || status != "cancelled" {
		t.Fatal("the cancelled graph's job", status, e)
	}
	worker.mu.Lock()
	worker.gate = nil
	renders := worker.renders
	worker.mu.Unlock()
	_ = renders

	// Cancelled through its operation (the route a client that lost the run's id uses), the edit stops the same way.
	gate()
	operation := randomID()
	gid = h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": operation, "documentVersion": canvas["version"]}, 202)["id"].(string)
	waitEntered()
	worker.mu.Lock()
	stoppedBefore = worker.stopped
	worker.mu.Unlock()
	h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs/operations/"+operation+"/cancel", map[string]any{}, 200)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		worker.mu.Lock()
		stopped := worker.stopped
		worker.mu.Unlock()
		if stopped == stoppedBefore+1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the operation cancel did not stop the worker's render")
		}
	}
	if e := h.db.QueryRow(t.Context(), "SELECT status FROM edit_jobs WHERE tenant_id=$1 AND graph_id=$2", tid, gid).Scan(&status); e != nil || status != "cancelled" {
		t.Fatal("the operation-cancelled graph's job", status, e)
	}
	worker.mu.Lock()
	worker.gate = nil
	renders = worker.renders
	worker.mu.Unlock()

	// Past the workspace's edits for today, an edit fails before the worker is asked.
	h.a.cfg.EditsPerDay = 3
	failed := awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+start(), "failed", 20*time.Second)
	worker.mu.Lock()
	after := worker.renders
	worker.mu.Unlock()
	if n := editNode(failed); n["state"] != "failed" || n["detail"] != "edit_allowance" || after != renders {
		t.Fatal("past the allowance", n, renders, after)
	}
}

// A workspace runs one edit at a time: a second canvas's ready edit node waits, without a job of its own and looking
// again only every editWaitPause, until the first edit ends, and then runs.
func TestPostgresGraphEditNodeWaitsForTheWorkspacesOtherEdit(t *testing.T) {
	pause := editWaitPause
	editWaitPause = 200 * time.Millisecond
	t.Cleanup(func() { editWaitPause = pause })
	timeline := `{"schema":"awwo.timeline/1","name":"R1","output":{"width":640,"height":360},"tracks":{"video":[{"source":"clip/video-1.mp4"}]}}`
	h, rh := newMediaHarness(t)
	rh.query = func(task string, n int) (int, any) {
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.mp4")
	}
	token := strings.Repeat("r", 40)
	worker := newFakeEditWorker(t, token)
	h.a.cfg.RenderURL, h.a.cfg.RenderToken = worker.server.URL, token
	c, tid, _ := h.register(t, "edit-wait@example.test")
	base := "/tenants/" + tid
	canvasWithAnEdit := func(name string) (string, func() string) {
		clip := mediaNode("clip", mediaKindVideo, "rh.seedance-2", nil)
		clip["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": "waves", "createdAt": 0}}
		doc := map[string]any{"nodes": []any{clip, map[string]any{"id": "edit", "kind": "edit", "title": name, "timeline": timeline}},
			"edges": []any{edge("c-e", "clip", "result", "edit", "clips", "video")}}
		cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": name, "document": doc}, 201)["id"].(string)
		canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
		return cid, func() string {
			return h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)["id"].(string)
		}
	}
	firstCanvas, startFirst := canvasWithAnEdit("First")
	secondCanvas, startSecond := canvasWithAnEdit("Second")
	worker.mu.Lock()
	worker.gate, worker.entered = make(chan struct{}), make(chan struct{}, 4)
	worker.mu.Unlock()
	first := startFirst()
	select {
	case <-worker.entered:
	case <-time.After(15 * time.Second):
		t.Fatal("the first edit never reached the worker")
	}
	second := startSecond()
	key := tid + "/" + second + "/edit"
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if _, waiting := h.a.editWaits.Load(key); waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the second edit node never waited")
		}
	}
	time.Sleep(3 * editWaitPause)
	var jobs int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM edit_jobs WHERE tenant_id=$1 AND graph_id=$2", tid, second).Scan(&jobs); e != nil || jobs != 0 {
		t.Fatal("the waiting node's jobs", jobs, e)
	}
	worker.mu.Lock()
	sent := len(worker.manifests)
	close(worker.gate)
	worker.gate = nil
	worker.mu.Unlock()
	if sent != 1 {
		t.Fatal("jobs sent to the worker while one ran", sent)
	}
	awaitGraph(t, h, c, base+"/canvases/"+firstCanvas+"/graph-runs/"+first, "completed", 20*time.Second)
	done := awaitGraph(t, h, c, base+"/canvases/"+secondCanvas+"/graph-runs/"+second, "completed", 20*time.Second)
	for _, raw := range done["nodes"].([]any) {
		if n := raw.(map[string]any); n["nodeId"] == "edit" && n["state"] != "done" {
			t.Fatal("the second edit", n)
		}
	}
	if _, waiting := h.a.editWaits.Load(key); waiting {
		t.Fatal("the node's pause outlived its wait")
	}
}

// A run with an edit node is refused when this server has no render worker: nothing paid upstream runs for an edit
// that cannot be made.
func TestPostgresGraphRunWithAnEditNodeNeedsTheWorker(t *testing.T) {
	h, _ := newMediaHarness(t)
	h.a.cfg.RenderURL, h.a.cfg.RenderToken = "", ""
	c, tid, _ := h.register(t, "edit-no-worker@example.test")
	base := "/tenants/" + tid
	doc := map[string]any{"nodes": []any{map[string]any{"id": "edit", "kind": "edit", "title": "Reel", "timeline": `{"schema":"awwo.timeline/1","tracks":{"video":[]}}`}}, "edges": []any{}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Edit", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	refused := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 409)
	if refused["error"] != nil && fmt.Sprint(refused["error"]) == "" {
		t.Fatal("refusal", refused)
	}
}
