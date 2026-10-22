package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestXtasyModelsAreInTheCatalogAndClosed(t *testing.T) {
	models := xtasyModels()
	kinds := map[string]int{}
	for _, want := range models {
		m, ok := builtinMediaCatalog.model(want.ID)
		if !ok || m.Provider != mediaProviderXtasy || m.Endpoint != xtasyEndpoints[m.Kind] || !xtasyRemoteModel.MatchString(m.Version) {
			t.Fatal("x-tasy model missing or wrong", want.ID, m)
		}
		if _, priced := mediaBaseCredits[m.ID]; !priced {
			t.Fatal("every X-tasy model has its own price", m.ID)
		}
		kinds[m.Kind]++
	}
	if kinds[mediaKindImage] != 6 || kinds[mediaKindVideo] != 2 {
		t.Fatal("six image and two video models", kinds)
	}
	// The two models X-tasy's list for the operator's key no longer has (2026-10-15) are gone, and a new video node
	// starts on All-round, the first video model.
	for _, gone := range []string{"xt.xtasy-v3", "xt.gpt-image-2"} {
		if _, ok := builtinMediaCatalog.model(gone); ok {
			t.Fatal("a retired X-tasy model is still offered", gone)
		}
		if _, priced := mediaBaseCredits[gone]; priced {
			t.Fatal("a retired X-tasy model is still priced", gone)
		}
	}
	for _, m := range builtinMediaCatalog.List() {
		if m.Kind == mediaKindVideo && m.Provider == mediaProviderXtasy {
			if m.ID != "xt.omni-video" {
				t.Fatal("the first X-tasy video model", m.ID)
			}
			break
		}
	}
	unmapped := xtasyModels()[0]
	unmapped.Params = append(unmapped.Params, mediaParam{Name: "seed", Type: "integer", Min: new(float64), Max: new(float64), Label: [2]string{"a", "b"}})
	if validXtasyModel(unmapped) == nil {
		t.Fatal("a parameter X-tasy has no field for must be refused")
	}
	foreign := xtasyModels()[1]
	foreign.Version = "../../admin"
	if validXtasyModel(foreign) == nil {
		t.Fatal("a model id that is not X-tasy's must be refused")
	}
	unfixed := xtasyModels()[2]
	unfixed.ID = "xt.unknown"
	if validXtasyModel(unfixed) == nil {
		t.Fatal("a model without its fixed parameters must be refused")
	}
}

// TestXtasyImageHDNamesTheModelTheAccountHas pins what 2026-10-22 decided for 图片 · 高清, whose remote model left the
// operator's account with the key revoked that day (xtasy.go): the id and the label stay, so the 61 nodes saved on it
// and the stored official and epic workflows keep their model, while the id names another model of the platform's own
// catalogue. Only 2K is offered, because the model's list names 4K but refuses to generate it ("image area must be at
// most 4624220 pixels"), and a setting that cannot generate is not offered; and its price is three times the 4 it
// charged at that default, taken to the floor of 30.
func TestXtasyImageHDNamesTheModelTheAccountHas(t *testing.T) {
	m, ok := builtinMediaCatalog.model("xt.seedream-5-pro")
	if !ok {
		t.Fatal("图片 · 高清 is not in the catalog")
	}
	if m.Version != "model_0c50c8be-1468-5599-9532-e592efa7b84e" {
		t.Fatal("图片 · 高清 must name the model the operator's account lists", m.Version)
	}
	if m.Label != [2]string{"图片 · 高清", "Image · HD"} || m.Kind != mediaKindImage {
		t.Fatal("its label and kind stay, so a saved node keeps its model", m.Label, m.Kind)
	}
	// The model db5a9f8c of 2026-10-10 is in no account of the operator's any more: naming it anywhere would fail
	// every generation with media_provider_unavailable, as 5 runs did on production between 07:52Z and 08:10Z.
	for _, every := range builtinMediaCatalog.List() {
		if strings.Contains(every.Version, "db5a9f8c") {
			t.Fatal("a model the account does not have is still named", every.ID, every.Version)
		}
	}
	params := map[string]*mediaParam{}
	for i := range m.Params {
		params[m.Params[i].Name] = &m.Params[i]
	}
	if len(params) != 2 || params["resolution"] == nil || params["aspectRatio"] == nil {
		t.Fatal("it offers the ratio and the resolution, and nothing it cannot send", len(m.Params))
	}
	if got := params["resolution"]; len(got.Values) != 1 || got.Values[0] != "2K" || got.Default != "2K" {
		t.Fatal("only 2K generates; 4K is refused by the model's own area limit", got.Values, got.Default)
	}
	// Each of these eight generated at 2K on 2026-10-22, charging the same 4 credits: the area limit that refuses 4K
	// does not reach 2K at any of them, the widest and the tallest included.
	if got := params["aspectRatio"]; got.Default != "1:1" ||
		strings.Join(got.Values, ",") != "1:1,4:3,3:4,16:9,9:16,3:2,2:3,21:9" {
		t.Fatal("the eight ratios generated on this model", got.Values, got.Default)
	}
	// One reference picture, proved on this model and not taken from its listing: the same run generated from an
	// uploaded picture in img2img (the listing alone is not enough - it offers 4K, which the model refuses).
	if m.References != 1 || xtasyFixed[m.ID]["mode"] != "txt2img" {
		t.Fatal("it still edits one reference picture, from text by default", m.References, xtasyFixed[m.ID])
	}
	// Its defaults must be a request the model accepts: 2K, which is what every run since 2026-10-01 asked for.
	chosen, err := m.resolveMediaParams(nil)
	if err != nil || chosen["resolution"] != "2K" {
		t.Fatal("its default resolution", chosen, err)
	}
	if credits := mediaCreditsFor(m.ID, m.Kind, chosen); credits != 30 {
		t.Fatal("three times the 4 it charged at 2K, at the floor of 30", credits)
	}
	// 4K cannot be asked for through the catalog at all, so the price can never double for a resolution the model
	// refuses: the one it rejects is refused here, before any generation is paid for.
	if _, err := m.resolveMediaParams(json.RawMessage(`{"resolution":"4K"}`)); err == nil {
		t.Fatal("4K must be refused by the catalog, not by the provider after it is charged for")
	}
	// A new image node starts on the first X-tasy image model, so it must be one the account has.
	for _, every := range builtinMediaCatalog.List() {
		if every.Kind == mediaKindImage && every.Provider == mediaProviderXtasy {
			if every.ID != "xt.seedream-5-pro" {
				t.Fatal("the first X-tasy image model", every.ID)
			}
			break
		}
	}
}

func TestXtasyRequestUsesWireNamesFixedValuesAndTheRun(t *testing.T) {
	video, _ := builtinMediaCatalog.model("xt.omni-video")
	params, err := video.resolveMediaParams(json.RawMessage(`{"duration":8,"generateAudio":false}`))
	if err != nil {
		t.Fatal(err)
	}
	body := xtasyRequest(video, "  a lake  ", params, "run1", nil)
	if body["model_id"] != video.Version || body["prompt"] != "a lake" || body[xtasyIdempotencyField] != "awwo-run-run1" || len(body["references"].([]any)) != 0 {
		t.Fatal("body", body)
	}
	want := map[string]any{"mode": "multimodal", "aspect_ratio": "16:9", "duration": int64(8), "resolution": "720p", "generate_audio": false, "watermark": false, "return_last_frame": false}
	got := body["parameters"].(map[string]any)
	if len(got) != len(want) {
		t.Fatal("parameters", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatal("parameter", k, got[k], v)
		}
	}
	omni, _ := builtinMediaCatalog.model("xt.omni-video-2-5")
	resolved, _ := omni.resolveMediaParams(nil)
	fixed := xtasyRequest(omni, "x", resolved, "run2", nil)["parameters"].(map[string]any)
	if fixed["mode"] != "text2video" || fixed["watermark"] != false || fixed["return_last_frame"] != false || fixed["output_format"] != "mp4" || fixed["duration"] != 5.0 {
		t.Fatal("omni video fixed values and the default duration", fixed)
	}
	// An automatic duration (-1) is not offered: its price would be unknown at admission.
	for _, raw := range []string{`{"duration":-1}`, `{"duration":31}`, `{"duration":3}`} {
		if _, err := omni.resolveMediaParams(json.RawMessage(raw)); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	image, _ := builtinMediaCatalog.model("xt.xtasy-3")
	if _, err := image.resolveMediaParams(json.RawMessage(`{"imageNum":7}`)); err == nil {
		t.Fatal("Xtasy 3.0 makes at most six images")
	}
	if p, _ := image.resolveMediaParams(json.RawMessage(`{"imageNum":3,"negativePrompt":"blur"}`)); mediaCreditsFor(image.ID, image.Kind, p) != 90 {
		t.Fatal("three images cost three times one", mediaCreditsFor(image.ID, image.Kind, p))
	}
	// The default video, five seconds at 720p, is the measured price; longer clips cost more, shorter ones no less.
	video5, _ := builtinMediaCatalog.model("xt.omni-video")
	for raw, want := range map[string]int{`{}`: 280, `{"duration":10}`: 560, `{"duration":15}`: 840, `{"duration":4}`: 280} {
		p, _ := video5.resolveMediaParams(json.RawMessage(raw))
		if got := mediaCreditsFor(video5.ID, video5.Kind, p); got != want {
			t.Fatal("video price", raw, got, want)
		}
	}
}

func xtasyTaskJSON(status string, outputs []map[string]any, billing map[string]any, extra map[string]any) []byte {
	v := map[string]any{"task_id": "mt_1", "status": status, "outputs": outputs, "billing": billing}
	for k, value := range extra {
		v[k] = value
	}
	raw, _ := json.Marshal(v)
	return raw
}

func TestParseXtasyTasks(t *testing.T) {
	for status, want := range map[string]string{"queued": "QUEUED", "pending": "QUEUED", "running": "RUNNING", "processing": "RUNNING"} {
		if task, err := parseXtasyTask(xtasyTaskJSON(status, nil, nil, nil), "mt_1", "https://x.test"); err != nil || task.Status != want || task.TaskID != "mt_1" {
			t.Fatal(status, task, err)
		}
	}
	out := func(id, role string) map[string]any {
		return map[string]any{"output_id": id, "role": role, "url": "/openapi/v1/tasks/mt_1/outputs/" + id + "/content", "mime_type": "image/png"}
	}
	task, err := parseXtasyTask(xtasyTaskJSON("completed", []map[string]any{out("a1", "output"), out("f1", "last_frame"), out("a2", "")}, nil, nil), "mt_1", "https://x.test")
	if err != nil || task.Status != "SUCCESS" || len(task.Results) != 2 || task.Results[0].URL != "https://x.test/openapi/v1/tasks/mt_1/outputs/a1/content" {
		t.Fatal("completed keeps the results, not a last frame", task, err)
	}
	foreign := map[string]any{"output_id": "a1", "role": "output", "url": "https://evil.test/a1"}
	if _, err := parseXtasyTask(xtasyTaskJSON("completed", []map[string]any{foreign}, nil, nil), "mt_1", "https://x.test"); mediaFailureCode(err) != "media_result_refused" {
		t.Fatal("an output address other than the task's own", err)
	}
	other := map[string]any{"output_id": "a1", "role": "output", "url": "/openapi/v1/tasks/mt_2/outputs/a1/content"}
	if _, err := parseXtasyTask(xtasyTaskJSON("completed", []map[string]any{other}, nil, nil), "mt_1", "https://x.test"); mediaFailureCode(err) != "media_result_refused" {
		t.Fatal("another task's output", err)
	}
	if _, err := parseXtasyTask(xtasyTaskJSON("completed", []map[string]any{out("f1", "last_frame")}, nil, nil), "mt_1", "https://x.test"); mediaFailureCode(err) != "media_no_output" {
		t.Fatal("no result", err)
	}
	for _, c := range []struct {
		status   string
		billing  map[string]any
		extra    map[string]any
		code     string
		unbilled bool
	}{
		{"failed", map[string]any{"status": "released", "charged": "0.000000"}, nil, "media_failed", true},
		{"failed", map[string]any{"status": "reserved", "charged": "0.000000"}, nil, "media_failed", true},
		{"failed", map[string]any{"status": "settled", "charged": "12.000000"}, nil, "media_failed", false},
		{"failed", nil, map[string]any{"error": map[string]any{"code": "CONTENT_MODERATION_REJECTED"}}, "media_content_rejected", true},
		{"failed", nil, map[string]any{"error": "INSUFFICIENT_CREDITS"}, "media_provider_balance", true},
		{"cancelled", nil, nil, "media_failed", true},
		{"rejected", nil, nil, "media_content_rejected", true},
		{"expired", nil, nil, "media_result_unavailable", true},
	} {
		_, err := parseXtasyTask(xtasyTaskJSON(c.status, nil, c.billing, c.extra), "mt_1", "https://x.test")
		e, ok := asRHError(err)
		if !ok || e.Code != c.code || e.Unbilled != c.unbilled || e.Transient {
			t.Fatal(c.status, c.billing, c.extra, err, e)
		}
	}
	if _, err := parseXtasyTask(xtasyTaskJSON("mystery", nil, nil, nil), "mt_1", ""); mediaFailureCode(err) != "media_provider_unavailable" {
		t.Fatal("an unknown state keeps polling", err)
	} else if e, _ := asRHError(err); !e.Transient {
		t.Fatal("unknown state is transient")
	}
	if task, _ := parseXtasyTask([]byte(`{"status":"running"}`), "mt_9", ""); task.TaskID != "mt_9" {
		t.Fatal("task id fallback", task)
	}
	if _, err := parseXtasyTask([]byte(`{"task_id":"../x","status":"running"}`), "", ""); mediaFailureCode(err) != "media_provider_unavailable" {
		t.Fatal("a malformed task id", err)
	}
}

func TestXtasyErrorCodesAreClosed(t *testing.T) {
	for _, c := range []struct {
		status    int
		body      string
		want      string
		transient bool
	}{
		{401, `{"error":{"code":"INVALID_API_KEY","message":"Invalid API key","retryable":false}}`, "media_provider_unauthorized", false},
		{403, `{"error_code":1010}`, "media_provider_unauthorized", false},
		{402, `{"error":{"code":"INSUFFICIENT_CREDITS"}}`, "media_provider_balance", false},
		{422, `{"error":{"code":"INVALID_PARAMETER","message":"Unsupported value for: resolution"}}`, "media_params_invalid", false},
		{422, `{"error":{"code":"CONTENT_POLICY_VIOLATION"}}`, "media_content_rejected", false},
		{404, `{"error":{"code":"TASK_NOT_FOUND"}}`, "media_task_missing", false},
		{404, `{"error":{"code":"MODEL_NOT_FOUND"}}`, "media_provider_unavailable", false},
		{429, `{"error":{"code":"RATE_LIMITED","retryable":true}}`, "media_provider_busy", true},
		{409, `{"error":{"code":"IDEMPOTENCY_KEY_IN_PROGRESS","retryable":true}}`, "media_provider_busy", true},
		{502, `bad gateway`, "media_provider_unavailable", true},
		{418, `{"error":{"code":"SOMETHING","retryable":true}}`, "media_provider_unavailable", true},
		{418, `{"error":{"code":"SOMETHING"}}`, "media_failed", false},
	} {
		e, _ := asRHError(xtasyHTTPError(c.status, []byte(c.body)))
		if e == nil || e.Code != c.want || e.Transient != c.transient {
			t.Fatal(c.status, c.body, e)
		}
	}
	// Only a transient submission failure is resent, and always after a wait.
	if e, _ := asRHError(xtasyResendable(xtasyHTTPError(502, nil), 0)); e.RetryAfter != xtasyResendWait {
		t.Fatal("server error resend wait", e)
	}
	if e, _ := asRHError(xtasyResendable(xtasyHTTPError(429, nil), 2*time.Second)); e.RetryAfter != 2*time.Second {
		t.Fatal("busy wait", e)
	}
	if e, _ := asRHError(xtasyResendable(xtasyHTTPError(422, nil), 2*time.Second)); e.RetryAfter != 0 {
		t.Fatal("a refusal is final", e)
	}
}

// The HTTP transport never sends a submission again by itself: when a reused connection drops after the request was
// read (a task may exist), the send fails to submitMedia, which resends and counts it, instead of the transport
// resending it inside one call, where a refusal of the resend would look like a refusal of the first send. A
// reference upload, which no allowance counts, is still resent by the transport.
func TestXtasySubmitIsNeverResentByTheTransport(t *testing.T) {
	var mu sync.Mutex
	posts := map[string]int{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/openapi/v1/files/file_1":
			writeJSON(w, 200, map[string]any{"file_id": "file_1", "status": "ready"})
			return
		case r.Method == http.MethodGet:
			writeJSON(w, 200, map[string]any{"task_id": "mt_0", "status": "running"})
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		mu.Lock()
		posts[r.URL.Path]++
		first := posts[r.URL.Path] == 1
		mu.Unlock()
		switch {
		case first:
			// The first send is read and its answer lost: the connection closes without one.
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
		case r.URL.Path == "/openapi/v1/files":
			writeJSON(w, 200, map[string]any{"file_id": "file_1", "status": "processing"})
		default:
			writeJSON(w, 401, map[string]any{"error": map[string]any{"code": "UNAUTHORIZED"}})
		}
	}))
	defer api.Close()
	c := testConfig()
	c.XtasyAPIKey, c.XtasyBaseURL, c.MediaMaxFileBytes = "xtk_test-key-0123456789", api.URL, 1<<20
	x := newXtasy(c)
	// A finished request leaves its connection idle, so the submission goes out on a reused one.
	if _, err := x.query(context.Background(), "mt_0"); err != nil {
		t.Fatal("query", err)
	}
	m, _ := builtinMediaCatalog.model("xt.seedream-5-pro")
	params, _ := m.resolveMediaParams(nil)
	_, err := x.submit(context.Background(), m.Endpoint, xtasyRequest(m, "a lake", params, "run1", nil))
	e, ok := asRHError(err)
	mu.Lock()
	sent := posts[m.Endpoint]
	mu.Unlock()
	if sent != 1 || !ok || e.Refused || !e.Transient || e.RetryAfter <= 0 {
		t.Fatal("a lost answer comes back to be resent by submitMedia", sent, err)
	}
	// The upload goes out on a reused connection too, after the query below leaves one idle.
	if _, err := x.query(context.Background(), "mt_0"); err != nil {
		t.Fatal("query", err)
	}
	id, err := x.uploadReference(context.Background(), testReference(testPNG, "image/png"), testPNG, "run1")
	mu.Lock()
	uploads := posts["/openapi/v1/files"]
	mu.Unlock()
	if err != nil || id != "file_1" || uploads != 2 {
		t.Fatal("an upload whose answer was lost is resent by the transport", id, err, uploads)
	}
}

func TestXtasyClientSubmitsQueriesAndDownloads(t *testing.T) {
	var mu sync.Mutex
	var seen []*http.Request
	var bodies []map[string]any
	fail := 1
	redirected := false
	png := append([]byte(nil), testPNG...)
	var api *httptest.Server
	api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, r)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/openapi/v1/images/generations":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			bodies = append(bodies, b)
			if fail > 0 {
				fail--
				w.Header().Set("Retry-After", "1")
				writeJSON(w, 503, map[string]any{"error": map[string]any{"code": "UPSTREAM_UNAVAILABLE", "retryable": true}})
				return
			}
			writeJSON(w, 202, map[string]any{"task_id": "mt_1", "status": "running", "billing": map[string]any{"status": "reserved"}})
		case r.URL.Path == "/openapi/v1/tasks/mt_1":
			writeJSON(w, 200, map[string]any{"task_id": "mt_1", "status": "completed", "outputs": []any{
				map[string]any{"output_id": "abc", "role": "output", "url": "/openapi/v1/tasks/mt_1/outputs/abc/content", "mime_type": "image/png"}}})
		case r.URL.Path == "/openapi/v1/tasks/mt_1/outputs/abc/content":
			if r.Header.Get("Authorization") != "Bearer xtk_test-key-0123456789" {
				w.WriteHeader(401)
				return
			}
			_, _ = w.Write(png)
		case r.URL.Path == "/openapi/v1/tasks/mt_1/outputs/moved/content":
			http.Redirect(w, r, api.URL+"/elsewhere", http.StatusFound)
		case r.URL.Path == "/elsewhere":
			redirected = true
		default:
			writeJSON(w, 404, map[string]any{"error": map[string]any{"code": "TASK_NOT_FOUND"}})
		}
	}))
	defer api.Close()
	c := testConfig()
	c.XtasyAPIKey, c.XtasyBaseURL, c.MediaMaxFileBytes = "xtk_test-key-0123456789", api.URL, 1<<20
	x := newXtasy(c)
	m, _ := builtinMediaCatalog.model("xt.seedream-5-pro")
	params, _ := m.resolveMediaParams(nil)
	body := xtasyRequest(m, "a lake", params, "run1", nil)
	waits := 0
	task, err := submitMedia(context.Background(), x, m.Endpoint, body, func() { waits++ })
	if err != nil || task.TaskID != "mt_1" || task.Status != "RUNNING" || waits != 1 {
		t.Fatal("a server error is resent once it clears", task, err, waits)
	}
	mu.Lock()
	if len(bodies) != 2 {
		t.Fatal("sends", len(bodies))
	}
	for i, r := range seen[:2] {
		if r.Header.Get("Idempotency-Key") != "awwo-run-run1" || r.Header.Get("Authorization") != "Bearer xtk_test-key-0123456789" || r.Header.Get("User-Agent") != xtasyUserAgent {
			t.Fatal("headers", i, r.Header)
		}
		if _, leaked := bodies[i][xtasyIdempotencyField]; leaked || bodies[i]["model_id"] != m.Version || bodies[i]["prompt"] != "a lake" {
			t.Fatal("body", i, bodies[i])
		}
	}
	mu.Unlock()
	if _, ok := body[xtasyIdempotencyField]; !ok {
		t.Fatal("a resend needs the caller's body intact")
	}
	task, err = x.query(context.Background(), "mt_1")
	if err != nil || task.Status != "SUCCESS" || len(task.Results) != 1 {
		t.Fatal("query", task, err)
	}
	if _, err := x.query(context.Background(), "mt_2"); mediaFailureCode(err) != "media_task_missing" {
		t.Fatal("unknown task", err)
	}
	if _, err := x.query(context.Background(), "../admin"); mediaFailureCode(err) != "media_task_missing" {
		t.Fatal("a malformed task id must never become a path", err)
	}
	var out bytes.Buffer
	if n, err := x.download(context.Background(), task.Results[0].URL, &out); err != nil || n != int64(len(png)) {
		t.Fatal("download", n, err)
	}
	for _, raw := range []string{"https://evil.test/openapi/v1/tasks/mt_1/outputs/abc/content", api.URL + "/openapi/v1/tasks/mt_1/outputs/abc/content?x=1",
		api.URL + "/openapi/v1/admin", api.URL + "/openapi/v1/tasks/mt_1/outputs/../content"} {
		if _, err := x.download(context.Background(), raw, io.Discard); mediaFailureCode(err) != "media_result_refused" {
			t.Fatal("refused", raw, err)
		}
	}
	if _, err := x.download(context.Background(), api.URL+"/openapi/v1/tasks/mt_1/outputs/moved/content", io.Discard); mediaFailureCode(err) != "media_result_unavailable" || redirected {
		t.Fatal("a redirect is not followed, so the key goes nowhere else", err, redirected)
	}
	// A refusal is final after one send.
	refused := &xtasyClient{base: api.URL, key: "xtk_test-key-0123456789", api: api.Client(), files: api.Client(), maxFile: 1 << 20}
	if _, err := refused.submit(context.Background(), "/openapi/v1/videos/generations", map[string]any{xtasyIdempotencyField: "awwo-run-r"}); mediaFailureCode(err) != "media_task_missing" {
		t.Fatal("404 on submit", err)
	}
	if _, err := refused.submit(context.Background(), "/openapi/v1/admin", map[string]any{xtasyIdempotencyField: "awwo-run-r"}); mediaFailureCode(err) != "media_request_invalid" {
		t.Fatal("only the generation endpoints are sent", err)
	}
	if _, err := refused.submit(context.Background(), m.Endpoint, map[string]any{}); mediaFailureCode(err) != "media_request_invalid" {
		t.Fatal("no Idempotency-Key, no send", err)
	}
}

func TestXtasyConfigAndExposure(t *testing.T) {
	valid := testConfig()
	valid.MediaDir = filepath.Join(t.TempDir(), "media")
	valid.MediaTimeout, valid.MediaPollInterval, valid.MediaRunsPerDay, valid.MediaMaxFileBytes = 20*time.Minute, 5*time.Second, 30, 300<<20
	valid.MediaResultHosts = []string{".runninghub.ai"}
	valid.RunningHubBaseURL = defaultRunningHubBaseURL
	valid.XtasyAPIKey, valid.XtasyBaseURL = "xtk_"+strings.Repeat("k", 32), defaultXtasyBaseURL
	if err := validateMediaConfig(valid); err != nil {
		t.Fatal("X-tasy alone is a valid media setup", err)
	}
	if !valid.xtasyConfigured() || valid.runningHubConfigured() || !valid.mediaProviderConfigured(mediaProviderXtasy) || !isMediaModelID("xt.omni-video") {
		t.Fatal("provider predicates")
	}
	for name, mutate := range map[string]func(*Config){
		"no storage":     func(c *Config) { c.MediaDir = "" },
		"short key":      func(c *Config) { c.XtasyAPIKey = "short" },
		"key with space": func(c *Config) { c.XtasyAPIKey = strings.Repeat("k", 20) + " x" },
		"foreign origin": func(c *Config) { c.XtasyBaseURL = "https://service.xtasyart.com.evil.test" },
		"with a path":    func(c *Config) { c.XtasyBaseURL = "https://service.xtasyart.com/openapi" },
		"plain http":     func(c *Config) { c.XtasyBaseURL = "http://service.xtasyart.com" },
		"loopback in prod": func(c *Config) {
			c.Env, c.PublicOrigin, c.XtasyBaseURL = "production", "https://awwo.test", "http://127.0.0.1:9000"
		},
	} {
		c := valid
		mutate(&c)
		if validateMediaConfig(c) == nil {
			t.Fatal("accepted", name)
		}
	}
	dev := valid
	dev.XtasyBaseURL = "http://127.0.0.1:9000"
	if err := validateMediaConfig(dev); err != nil {
		t.Fatal("development may use a local fake", err)
	}
	every := valid
	every.XtasyAllWorkspaces = true
	if validateMediaExposure(every) == nil {
		t.Fatal("X-tasy for every workspace without AWWO_MAX_OWNED_WORKSPACES")
	}
	every.MaxOwnedWorkspaces = 1
	if err := validateMediaExposure(every); err != nil {
		t.Fatal(err)
	}
	// The switch grants X-tasy's models to a workspace whose allowlist names none of them, and nothing else.
	a := &App{cfg: every}
	listed := modelEntitlement{allowed: &[]string{"qwen3.8-27b-p6"}}
	if !a.mediaEntitled(listed, "xt.seedream-5-pro") || a.mediaEntitled(listed, "rh.seedream-v5-pro") || a.mediaEntitled(listed, "tripo.p1") {
		t.Fatal("entitlement")
	}
	t.Setenv("AWWO_XTASY_ALL_WORKSPACES", "maybe")
	c := testConfig()
	if c.mediaFromEnv() == nil {
		t.Fatal("AWWO_XTASY_ALL_WORKSPACES must be true or false")
	}
}

// An image run end to end against a stand-in for X-tasy: a busy answer is resent under the same key and the task
// the second send made is followed, the result's bytes decide its type whatever X-tasy calls it, and a task X-tasy
// fails costs no credits.
func TestPostgresXtasyRunsResendUnderOneKeyAndRefundFailures(t *testing.T) {
	h, _ := newMediaHarness(t)
	var mu sync.Mutex
	keys := []string{}
	busy := 1
	final := map[string]any{"status": "completed"}
	jpeg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{0x11}, 512)...)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodPost:
			keys = append(keys, r.Header.Get("Idempotency-Key"))
			if busy > 0 {
				busy--
				w.Header().Set("Retry-After", "1")
				writeJSON(w, 429, map[string]any{"error": map[string]any{"code": "RATE_LIMITED", "retryable": true}})
				return
			}
			writeJSON(w, 202, map[string]any{"task_id": fmt.Sprintf("mt_%d", len(keys)), "status": "running"})
		case strings.HasSuffix(r.URL.Path, "/content"):
			_, _ = w.Write(jpeg)
		default:
			id := strings.TrimPrefix(r.URL.Path, "/openapi/v1/tasks/")
			v := map[string]any{"task_id": id, "outputs": []any{map[string]any{"output_id": "o1", "role": "output",
				"url": "/openapi/v1/tasks/" + id + "/outputs/o1/content", "mime_type": "image/png"}}}
			for k, value := range final {
				v[k] = value
			}
			writeJSON(w, 200, v)
		}
	}))
	t.Cleanup(api.Close)
	h.a.cfg.XtasyAPIKey, h.a.cfg.XtasyBaseURL = "xtk_test-key-0123456789", api.URL
	h.a.xtasy = newXtasy(h.a.cfg)

	c, tid, _ := h.register(t, "xtasy-runs@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	run := h.mediaRun(t, c, tid, sid, "a quiet mountain lake", 202)
	done := h.awaitRun(t, c, tid, run["id"].(string), "completed")
	var out mediaOutput
	if e := json.Unmarshal([]byte(done["output"].(string)), &out); e != nil || out.Model != "xt.seedream-5-pro" || len(out.Items) != 1 || out.Items[0].ContentType != "image/jpeg" {
		t.Fatal("output", done["output"], e)
	}
	mu.Lock()
	if len(keys) != 2 || keys[0] != keys[1] || keys[0] != "awwo-run-"+run["id"].(string) {
		t.Fatal("one key for every send of a run", keys)
	}
	mu.Unlock()

	mu.Lock()
	final = map[string]any{"status": "failed", "billing": map[string]any{"status": "released", "charged": "0"}}
	mu.Unlock()
	// Without RunningHub there is no backup to make it (media_fallback_test.go has the run that has one).
	h.a.cfg.RunningHubAPIKey = ""
	run = h.mediaRun(t, c, tid, sid, "a quiet mountain lake", 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_failed" {
		t.Fatal("failed task", code)
	}
	var accepted *bool
	if e := h.db.QueryRow(t.Context(), "SELECT provider_accepted FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, run["id"]).Scan(&accepted); e != nil || accepted == nil || *accepted {
		t.Fatal("a task X-tasy failed is not billed", accepted, e)
	}
}
