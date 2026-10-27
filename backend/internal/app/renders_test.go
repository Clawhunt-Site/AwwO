package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func renderPayload(kind, contentType string, data []byte) map[string]any {
	sum := sha256.Sum256(data)
	return map[string]any{"kind": kind, "contentType": contentType, "size": len(data), "sha256": hex.EncodeToString(sum[:]), "data": base64.StdEncoding.EncodeToString(data)}
}

var (
	renderTestMP4 = append([]byte{0, 0, 0, 0x18}, []byte("ftypmp42\x00\x00\x00\x00mp42isom-test-video-bytes")...)
	renderTestGIF = []byte("GIF89a\x01\x00\x01\x00test-gif")
	renderTestPNG = []byte("\x89PNG\r\n\x1a\ncontact-sheet")
)

type fakeRenderer struct {
	server   *httptest.Server
	calls    atomic.Int32
	lastBody atomic.Value
	reply    func(w http.ResponseWriter, body map[string]any)
}

func newFakeRenderer(t *testing.T) *fakeRenderer {
	f := &fakeRenderer{}
	f.reply = func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "mode": "contract", "frames": 24, "fps": 12, "width": 320, "height": 180, "seconds": 2,
			"distinctFrames": 24, "elapsedMs": 900, "probe": map[string]any{"frames": 24}, "warnings": []string{}, "pageErrors": []string{},
			"outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4), renderPayload("gif", "image/gif", renderTestGIF), renderPayload("contact", "image/png", renderTestPNG)}})
	}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("r", 32) {
			w.WriteHeader(401)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.lastBody.Store(body)
		f.calls.Add(1)
		f.reply(w, body)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func renderHarness(t *testing.T, renderer *fakeRenderer) (*harness, string, string, *http.Cookie) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.RenderURL, h.a.cfg.RenderToken, h.a.cfg.MediaDir = renderer.server.URL, strings.Repeat("r", 32), t.TempDir()
	h.a.cfg.RendersPerDay, h.a.cfg.RendersSitePerDay, h.a.cfg.RenderTimeout = 3, 100, 30*time.Second
	h.a.cfg.MediaMinFreeBytes = 0
	owner, tid, _ := h.register(t, "renders-"+randomID()[:8]+"@example.test")
	cid, _, _ := h.fixture(t, owner, tid)
	return h, tid, cid, owner
}

const renderPage = "<!doctype html><html><head></head><body><script>window.renderAt=t=>{}</script></body></html>"

func awaitRender(t *testing.T, h *harness, c *http.Cookie, path, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		v := h.request(t, c, "GET", path, nil, 200)
		if v["status"] == want {
			return v
		}
		if v["status"] == "failed" || v["status"] == "completed" || v["status"] == "cancelled" {
			t.Fatalf("render ended %v, wanted %s", v, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("render timeout")
	return nil
}

func TestRenderParamsValidation(t *testing.T) {
	ok := renderParams{Width: 1921 - 2, Height: 1081, FPS: 30, Seconds: 6}
	if err := ok.validate(); err != nil || ok.Width != 1918 || ok.Height != 1080 {
		t.Fatal("valid params refused or not made even", ok, err)
	}
	for _, p := range []renderParams{{Width: 63, Height: 100, FPS: 30, Seconds: 1}, {Width: 100, Height: 2000, FPS: 30, Seconds: 1}, {Width: 100, Height: 100, FPS: 0, Seconds: 1},
		{Width: 100, Height: 100, FPS: 61, Seconds: 1}, {Width: 100, Height: 100, FPS: 30, Seconds: 0.2}, {Width: 100, Height: 100, FPS: 60, Seconds: 20.5}} {
		if p.validate() == nil {
			t.Fatalf("accepted %+v", p)
		}
	}
}

// The render worker's words for a page whose renderAt(t) waited on its own clock (its held-clock refusal).
const renderHeldReason = "window.renderAt(0) had not settled after 5 s, in which the page did no work the renderer could see while 1 setTimeout timer was waiting on its clock. " +
	"The renderer moves that clock only when it draws a frame, which it does once renderAt(t) has settled, so renderAt must draw from t alone, without waiting on a timer or an animation frame."

func renderRefusal(code, message, detail string) []byte {
	return jsonBytes(map[string]any{"error": map[string]any{"code": code, "message": message, "field": "html", "detail": detail}})
}

// The worker's answers map to stable codes, and only a page it refused for waiting on its own clock keeps its words.
func TestRenderWorkerFailureCodes(t *testing.T) {
	for _, c := range []struct {
		status       int
		raw          []byte
		code, reason string
	}{
		{400, renderRefusal("INVALID_RENDER", renderHeldReason, "page_waits_on_timers"), "render_page_waits_on_timers", renderHeldReason},
		// Without words, or with a message that is not text, the refusal keeps its code and says nothing more.
		{400, []byte(`{"error":{"code":"INVALID_RENDER","field":"html","detail":"page_waits_on_timers"}}`), "render_page_waits_on_timers", ""},
		{400, []byte(`{"error":{"code":"INVALID_RENDER","message":{"text":"x"},"field":"html","detail":"page_waits_on_timers"}}`), "render_page_waits_on_timers", ""},
		{400, renderRefusal("INVALID_RENDER", "Content-Type must be application/json.", ""), "render_rejected", ""},
		{400, renderRefusal("INVALID_RENDER", renderHeldReason, "page_load_failed"), "render_rejected", ""},
		{400, renderRefusal("RENDER_FAILED", renderHeldReason, "page_waits_on_timers"), "render_rejected", ""},
		{400, []byte("not json"), "render_rejected", ""},
		{413, renderRefusal("INVALID_RENDER", renderHeldReason, "page_waits_on_timers"), "render_rejected", ""},
		{422, renderRefusal("RENDER_FAILED", renderHeldReason, "page_waits_on_timers"), "render_failed", ""},
		{422, renderRefusal("RENDER_FAILED", "The render took too long.", "timeout"), "timeout", ""},
		{422, renderRefusal("RENDER_FAILED", "The page did not load.", "page_load_failed"), "render_page_failed", ""},
		{422, renderRefusal("RENDER_FAILED", "The video is too large.", "output_too_large"), "render_output_too_large", ""},
		{422, renderRefusal("RENDER_FAILED", "ffmpeg failed.", "ffmpeg_failed"), "render_failed", ""},
		{429, nil, "render_busy", ""},
		{401, nil, "render_unavailable", ""},
		{503, renderRefusal("RENDER_UNAVAILABLE", renderHeldReason, "page_waits_on_timers"), "render_unavailable", ""},
		{500, nil, "render_failed", ""},
	} {
		if code, reason := renderWorkerFailure(c.status, c.raw); code != c.code || reason != c.reason {
			t.Errorf("%d %s: got %q %q, want %q %q", c.status, c.raw, code, reason, c.code, c.reason)
		}
	}
}

// The worker's words are kept as one line of plain text of at most 500 characters: no control character (a NUL would
// make PostgreSQL refuse the whole record), no invisible formatting, no broken UTF-8.
func TestRenderReasonIsBoundedPlainText(t *testing.T) {
	// A zero-width space, a right-to-left override, the next-line control and the line separator, made from their code
	// points so that this file holds none of them.
	zeroWidth, override, nextLine, lineSeparator := string(rune(0x200b)), string(rune(0x202e)), string(rune(0x85)), string(rune(0x2028))
	raw := "  window.renderAt(0)\x00had\tnot\r\nsettled" + zeroWidth + override + " after\x7f" + nextLine + lineSeparator + "5 s\xff.  "
	if got := renderReason(raw); got != "window.renderAt(0) had not settled after 5 s." {
		t.Fatalf("%q", got)
	}
	if got := renderReason(strings.Repeat("时", 600)); got != strings.Repeat("时", 500) {
		t.Fatal("a long reason must keep its first 500 characters", utf8.RuneCountInString(got), len(got))
	}
	if got := renderReason(strings.Repeat("held ", 120)); got != strings.TrimSpace(strings.Repeat("held ", 100)) {
		t.Fatalf("a reason cut at a space must not end with one: %q", got)
	}
	// At the cut: a space with a character after it fits in the 499th and 500th places, but not from the 500th on.
	if got := renderReason(strings.Repeat("a", 498) + " b c"); got != strings.Repeat("a", 498)+" b" {
		t.Fatalf("a space and a character must fit in the last two places: %d runes, ending %q", utf8.RuneCountInString(got), got[max(0, len(got)-8):])
	}
	if got := renderReason(strings.Repeat("a", 499) + " b"); got != strings.Repeat("a", 499) {
		t.Fatalf("a space in the last place must be left out: %d runes, ending %q", utf8.RuneCountInString(got), got[max(0, len(got)-8):])
	}
	if renderReason(renderHeldReason) != renderHeldReason || renderReason("\x00"+zeroWidth+" \n") != "" {
		t.Fatal("the worker's own reason must be kept as it is, and one of no words not at all")
	}
	// A broken worker's long message costs no more than the words kept: it is read once, never split or copied whole
	// (a cleaner that split the whole message into words took 208 MiB for these 16 MiB of "a ", this one 1 KiB).
	long := strings.Repeat("a ", 8<<20)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	got := renderReason(long)
	runtime.ReadMemStats(&after)
	if got != strings.TrimSpace(strings.Repeat("a ", 250)) || after.TotalAlloc-before.TotalAlloc > 1<<20 {
		t.Fatal("a long message must be read into its first 500 characters alone", utf8.RuneCountInString(got), after.TotalAlloc-before.TotalAlloc)
	}
}

// A page the worker refused for waiting on its own clock fails with its own code and the worker's words, in the
// render's record and its listing; words PostgreSQL would refuse are cleaned rather than leaving the render running,
// and the worker's other refusals keep render_rejected and say nothing more. Each counts against the day's renders, as
// the page's fault.
func TestPostgresRenderKeepsTheReasonOfAPageHeldOnItsOwnClock(t *testing.T) {
	renderer := newFakeRenderer(t)
	h, tid, cid, owner := renderHarness(t, renderer)
	h.a.cfg.RendersPerDay = 10
	base := "/tenants/" + tid + "/canvases/" + cid + "/renders"
	refuse := func(message, detail string) {
		renderer.reply = func(w http.ResponseWriter, _ map[string]any) {
			writeJSON(w, 400, map[string]any{"error": map[string]any{"code": "INVALID_RENDER", "message": message, "field": "html", "detail": detail}})
		}
	}
	render := func(op string) map[string]any {
		job := h.request(t, owner, "POST", base, map[string]any{"operationId": op, "nodeId": "node-a", "html": renderPage, "width": 320, "height": 180, "fps": 12, "seconds": 2}, 202)
		return awaitRender(t, h, owner, base+"/"+job["id"].(string), "failed")
	}
	refuse(renderHeldReason, "page_waits_on_timers")
	failed := render("render-held")
	if failed["errorCode"] != "render_page_waits_on_timers" || failed["result"].(map[string]any)["reason"] != renderHeldReason {
		t.Fatal("a page held on its own clock must fail saying why", failed)
	}
	listed := h.request(t, owner, "GET", base+"?nodeId=node-a", nil, 200)["items"].([]any)[0].(map[string]any)
	if listed["id"] != failed["id"] || listed["result"].(map[string]any)["reason"] != renderHeldReason {
		t.Fatal("the listing must carry the reason too", listed)
	}
	refuse("window.renderAt(0)\x00 had not settled\x1b after 5 s.", "page_waits_on_timers")
	if failed = render("render-held-nul"); failed["errorCode"] != "render_page_waits_on_timers" || failed["result"].(map[string]any)["reason"] != "window.renderAt(0) had not settled after 5 s." {
		t.Fatal("a reason PostgreSQL would refuse must be cleaned, and the render must still end", failed)
	}
	refuse("Content-Type must be application/json.", "")
	if failed = render("render-refused"); failed["errorCode"] != "render_rejected" || len(failed["result"].(map[string]any)) != 0 {
		t.Fatal("the worker's other refusals keep their code and say nothing more", failed)
	}
	if used := h.request(t, owner, "GET", "/tenants/"+tid+"/capabilities", nil, 200)["render"].(map[string]any)["usedToday"]; used != float64(3) {
		t.Fatal("a refused page's render must count against the day's renders", used)
	}
}

// A deployment may set AWWO_MEDIA_DIR for the renderer alone, with no image or video provider (found by the live
// check: the media settings were validated before the renderer's were read, so the API refused to start).
func TestRenderOnlyDeploymentLoadsFromEnv(t *testing.T) {
	c := testConfig()
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", c.DatabaseURL)
	t.Setenv("AWWO_MEDIA_DIR", filepath.Join(t.TempDir(), "media"))
	t.Setenv("AWWO_RENDER_URL", "http://127.0.0.1:8111")
	t.Setenv("AWWO_RENDER_TOKEN", strings.Repeat("t", 40))
	loaded, err := ConfigFromEnv()
	if err != nil || loaded.RenderURL != "http://127.0.0.1:8111" || loaded.MediaDir == "" {
		t.Fatal("a renderer with only a media directory must load", err)
	}
	t.Setenv("AWWO_RENDER_URL", "")
	t.Setenv("AWWO_RENDER_TOKEN", "")
	// Canvas uploads keep their files there too, so the directory loads alone as well (AwwO 本地版 on a computer
	// with neither a renderer nor a media key), and media is still not configured.
	if loaded, err := ConfigFromEnv(); err != nil || loaded.MediaDir == "" || loaded.mediaConfigured() {
		t.Fatal("a media directory alone must load, with no generator configured", err)
	}
}

func TestPostgresRenderStoresVideosAsCanvasArtifacts(t *testing.T) {
	renderer := newFakeRenderer(t)
	h, tid, cid, owner := renderHarness(t, renderer)
	base := "/tenants/" + tid + "/canvases/" + cid + "/renders"
	request := map[string]any{"operationId": "render-first", "nodeId": "node-a", "html": renderPage, "width": 321, "height": 180, "fps": 12, "seconds": 2, "loop": true, "gif": true, "contact": true}
	job := h.request(t, owner, "POST", base, request, 202)
	done := awaitRender(t, h, owner, base+"/"+job["id"].(string), "completed")
	body := renderer.lastBody.Load().(map[string]any)
	if body["width"] != float64(320) || body["html"] != renderPage || len(body["outputs"].([]any)) != 3 {
		t.Fatal("worker request wrong", body)
	}
	outputs := done["result"].(map[string]any)["outputs"].([]any)
	if len(outputs) != 3 {
		t.Fatal(done)
	}
	for _, raw := range outputs {
		out := raw.(map[string]any)
		header, data := h.readRaw(t, owner, "/tenants/"+tid+"/artifacts/"+out["artifactId"].(string)+"/media", 200)
		if header.Get("Content-Type") != out["contentType"] || header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" || int64(len(data)) != int64(out["size"].(float64)) {
			t.Fatal("stored render not served as inline media", out, header)
		}
	}
	if replay := h.request(t, owner, "POST", base, request, 200); replay["id"] != job["id"] {
		t.Fatal("operation replay created another render")
	}
	request["seconds"] = 3
	h.request(t, owner, "POST", base, request, 409)
	if listed := h.request(t, owner, "GET", base+"?nodeId=node-a", nil, 200)["items"].([]any); len(listed) != 1 {
		t.Fatal(listed)
	}
	if renderer.calls.Load() != 1 {
		t.Fatal("worker called more than once", renderer.calls.Load())
	}
}

func TestPostgresRenderRefusesBadOutputsQuotaAndBusy(t *testing.T) {
	renderer := newFakeRenderer(t)
	h, tid, cid, owner := renderHarness(t, renderer)
	base := "/tenants/" + tid + "/canvases/" + cid + "/renders"
	request := func(op string) map[string]any {
		return map[string]any{"operationId": op, "nodeId": "node-a", "html": renderPage, "width": 320, "height": 180, "fps": 12, "seconds": 2}
	}
	// A worker reply whose bytes are not the video it claims is refused, not stored.
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		bogus := renderPayload("mp4", "video/mp4", []byte("<html>not a video</html>"))
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{bogus}})
	}
	job := h.request(t, owner, "POST", base, request("render-bogus"), 202)
	failed := awaitRender(t, h, owner, base+"/"+job["id"].(string), "failed")
	if failed["errorCode"] != "render_invalid_output" {
		t.Fatal(failed)
	}
	var artifacts int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM artifacts WHERE tenant_id=$1 AND run_id=$2", tid, job["id"]).Scan(&artifacts); err != nil || artifacts != 0 {
		t.Fatal("an invalid render was stored", artifacts, err)
	}
	// The worker refusing work maps to a code the user can act on.
	renderer.reply = func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, 422, map[string]any{"error": map[string]any{"code": "RENDER_FAILED", "detail": "page_load_failed"}})
	}
	job = h.request(t, owner, "POST", base, request("render-page-fails"), 202)
	if failed = awaitRender(t, h, owner, base+"/"+job["id"].(string), "failed"); failed["errorCode"] != "render_page_failed" {
		t.Fatal(failed)
	}
	// Two counted renders used; the third of the day is the last one allowed (RendersPerDay = 3).
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		time.Sleep(300 * time.Millisecond)
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4)}})
	}
	job = h.request(t, owner, "POST", base, request("render-third"), 202)
	h.request(t, owner, "POST", base, request("render-while-busy"), 429)
	awaitRender(t, h, owner, base+"/"+job["id"].(string), "completed")
	quota := h.request(t, owner, "POST", base, request("render-fourth"), 429)
	if quota["error"].(map[string]any)["code"] != "render_quota" {
		t.Fatal(quota)
	}
	h.request(t, owner, "POST", base, map[string]any{"operationId": "render-not-html", "html": "just text", "width": 320, "height": 180, "fps": 12, "seconds": 2}, 400)
	h.a.cfg.RenderURL = ""
	h.request(t, owner, "POST", base, request("render-off"), 503)
}

func TestPostgresRenderCancelAndRestartInterruption(t *testing.T) {
	renderer := newFakeRenderer(t)
	release := make(chan struct{})
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		select {
		case <-release:
		case <-time.After(5 * time.Second):
		}
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4)}})
	}
	defer close(release)
	h, tid, cid, owner := renderHarness(t, renderer)
	base := "/tenants/" + tid + "/canvases/" + cid + "/renders"
	job := h.request(t, owner, "POST", base, map[string]any{"operationId": "render-cancel", "html": renderPage, "width": 320, "height": 180, "fps": 12, "seconds": 2}, 202)
	awaitRender(t, h, owner, base+"/"+job["id"].(string), "running")
	cancelled := h.request(t, owner, "POST", base+"/"+job["id"].(string)+"/cancel", nil, 200)
	if cancelled["status"] != "cancelled" {
		t.Fatal(cancelled)
	}
	time.Sleep(100 * time.Millisecond)
	if after := h.request(t, owner, "GET", base+"/"+job["id"].(string), nil, 200); after["status"] != "cancelled" {
		t.Fatal("a cancelled render was overwritten", after)
	}
	if _, err := h.db.Exec(context.Background(), "INSERT INTO render_jobs(id,tenant_id,canvas_id,operation_id,request_hash,status,params,html_sha256,html_bytes) VALUES('left-running',$1,$2,'left-op','h','running','{}','x',1)", tid, cid); err != nil {
		t.Fatal(err)
	}
	tx, err := h.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = interruptRenders(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, code string
	if err = h.db.QueryRow(context.Background(), "SELECT status,error_code FROM render_jobs WHERE id='left-running'").Scan(&status, &code); err != nil || status != "failed" || code != "interrupted" {
		t.Fatal("a render left running must fail as interrupted", status, code, err)
	}
}

// Renders from two workspaces take turns at the single worker instead of failing; a canvas cannot be deleted while
// its render runs, and deleting it afterwards keeps its renders counted; only renders the worker made are charged;
// an operation id belongs to one canvas.
func TestPostgresRenderQueueLedgerAndCharges(t *testing.T) {
	renderer := newFakeRenderer(t)
	var inFlight, peak atomic.Int32
	gate := make(chan struct{}, 8)
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		now := inFlight.Add(1)
		for old := peak.Load(); now > old && !peak.CompareAndSwap(old, now); old = peak.Load() {
		}
		<-gate
		inFlight.Add(-1)
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4)}})
	}
	h, tid, cid, owner := renderHarness(t, renderer)
	other, otherTenant, _ := h.register(t, "renders-other-"+randomID()[:8]+"@example.test")
	otherCanvas := h.request(t, other, "POST", "/tenants/"+otherTenant+"/canvases", map[string]any{"name": "Other", "document": map[string]any{}}, 201)["id"].(string)
	request := func(op string) map[string]any {
		return map[string]any{"operationId": op, "nodeId": "node-a", "html": renderPage, "width": 320, "height": 180, "fps": 12, "seconds": 2}
	}
	base := "/tenants/" + tid + "/canvases/" + cid + "/renders"
	otherBase := "/tenants/" + otherTenant + "/canvases/" + otherCanvas + "/renders"
	first := h.request(t, owner, "POST", base, request("queue-first"), 202)
	awaitRender(t, h, owner, base+"/"+first["id"].(string), "running")
	if busy := h.request(t, owner, "DELETE", "/tenants/"+tid+"/canvases/"+cid, nil, 409); busy["error"].(map[string]any)["code"] != "resource_in_use" {
		t.Fatal("a canvas was deletable while its render ran", busy)
	}
	second := h.request(t, other, "POST", otherBase, request("queue-second"), 202)
	time.Sleep(150 * time.Millisecond)
	if waiting := h.request(t, other, "GET", otherBase+"/"+second["id"].(string), nil, 200); waiting["status"] != "queued" {
		t.Fatal("the second workspace's render should wait for the worker", waiting)
	}
	gate <- struct{}{}
	awaitRender(t, h, owner, base+"/"+first["id"].(string), "completed")
	gate <- struct{}{}
	awaitRender(t, h, other, otherBase+"/"+second["id"].(string), "completed")
	if peak.Load() != 1 {
		t.Fatal("the worker was sent two renders at once", peak.Load())
	}
	h.request(t, owner, "DELETE", "/tenants/"+tid+"/canvases/"+cid, nil, 204)
	fresh := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Fresh", "document": map[string]any{}}, 201)["id"].(string)
	freshBase := "/tenants/" + tid + "/canvases/" + fresh + "/renders"
	if conflict := h.request(t, owner, "POST", freshBase, request("queue-first"), 409); conflict["error"].(map[string]any)["code"] != "idempotency_conflict" {
		t.Fatal("an operation id was replayed onto another canvas", conflict)
	}
	// A worker still too busy to take the render after the retries is not the workspace's doing: it is not charged.
	previousRetry := renderBusyRetry
	renderBusyRetry = 400 * time.Millisecond
	t.Cleanup(func() { renderBusyRetry = previousRetry })
	var busyAnswers atomic.Int32
	renderer.reply = func(w http.ResponseWriter, _ map[string]any) {
		busyAnswers.Add(1)
		writeJSON(w, 429, map[string]any{"error": map[string]any{"code": "RENDER_BUSY"}})
	}
	refused := h.request(t, owner, "POST", freshBase, request("queue-refused"), 202)
	if failed := awaitRender(t, h, owner, freshBase+"/"+refused["id"].(string), "failed"); failed["errorCode"] != "render_busy" || busyAnswers.Load() < 2 {
		t.Fatal("a busy worker is asked again before the render gives up", failed, busyAnswers.Load())
	}
	// A worker that frees itself while the render waits takes it.
	var answers atomic.Int32
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		if answers.Add(1) == 1 {
			writeJSON(w, 429, map[string]any{"error": map[string]any{"code": "RENDER_BUSY"}})
			return
		}
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4)}})
	}
	retried := h.request(t, owner, "POST", freshBase, request("queue-retried"), 202)
	awaitRender(t, h, owner, freshBase+"/"+retried["id"].(string), "completed")
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4)}})
	}
	// RendersPerDay is 3: the deleted canvas's render and the retried one count, the refused one does not.
	for _, op := range []string{"queue-two"} {
		job := h.request(t, owner, "POST", freshBase, request(op), 202)
		awaitRender(t, h, owner, freshBase+"/"+job["id"].(string), "completed")
	}
	if quota := h.request(t, owner, "POST", freshBase, request("queue-three"), 429); quota["error"].(map[string]any)["code"] != "render_quota" {
		t.Fatal(quota)
	}
}

// Every file a render returns is checked before any is kept, so a bad second file leaves no first one behind; a
// render the API stops while closing is charged to nobody.
func TestPostgresRenderKeepsAllOrNothingAndShutdownIsNotCharged(t *testing.T) {
	renderer := newFakeRenderer(t)
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4),
			renderPayload("gif", "image/gif", []byte("<html>not a gif</html>"))}})
	}
	h, tid, cid, owner := renderHarness(t, renderer)
	base := "/tenants/" + tid + "/canvases/" + cid + "/renders"
	job := h.request(t, owner, "POST", base, map[string]any{"operationId": "partial-outputs", "html": renderPage, "width": 320, "height": 180, "fps": 12, "seconds": 2, "gif": true}, 202)
	if failed := awaitRender(t, h, owner, base+"/"+job["id"].(string), "failed"); failed["errorCode"] != "render_invalid_output" {
		t.Fatal(failed)
	}
	var artifacts int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM artifacts WHERE tenant_id=$1 AND run_id=$2", tid, job["id"]).Scan(&artifacts); err != nil || artifacts != 0 {
		t.Fatal("a render with a bad file kept its video", artifacts, err)
	}
	if files, _ := filepath.Glob(filepath.Join(h.a.cfg.MediaDir, tid, job["id"].(string), "*")); len(files) != 0 {
		t.Fatal("files of a refused render were left on disk", files)
	}
	hold := make(chan struct{})
	renderer.reply = func(w http.ResponseWriter, body map[string]any) {
		select {
		case <-hold:
		case <-time.After(5 * time.Second):
		}
		writeJSON(w, 200, map[string]any{"renderId": body["renderId"], "outputs": []any{renderPayload("mp4", "video/mp4", renderTestMP4)}})
	}
	defer close(hold)
	running := h.request(t, owner, "POST", base, map[string]any{"operationId": "render-closing", "html": renderPage, "width": 320, "height": 180, "fps": 12, "seconds": 2}, 202)
	id := running["id"].(string)
	awaitRender(t, h, owner, base+"/"+id, "running")
	h.a.mu.Lock()
	h.a.closed = true
	stop := h.a.running[id]
	h.a.mu.Unlock()
	stop()
	deadline := time.Now().Add(5 * time.Second)
	var status, code string
	for time.Now().Before(deadline) {
		if err := h.db.QueryRow(context.Background(), "SELECT status,COALESCE(error_code,'') FROM render_jobs WHERE id=$1", id).Scan(&status, &code); err != nil {
			t.Fatal(err)
		}
		if status != "running" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != "failed" || code != "interrupted" {
		t.Fatal("a render stopped by a closing API must be interrupted, not charged", status, code)
	}
}
