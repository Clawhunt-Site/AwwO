package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
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

func TestTripoModelsAreInTheCatalogAndClosed(t *testing.T) {
	ids := map[string]string{"tripo.v3-1": "v3.1-20260211", "tripo.p1": "P1-20260311"}
	for id, version := range ids {
		m, ok := builtinMediaCatalog.model(id)
		if !ok || m.Provider != mediaProviderTripo || m.Kind != mediaKindModel3D || m.Version != version || m.Endpoint != "/generation/text-to-model" {
			t.Fatal("tripo model missing or wrong", id, m)
		}
		if m.Prompt.MaxLength != 1024 || !m.validMediaPrompt("a low-poly sci-fi soldier") || m.validMediaPrompt(strings.Repeat("字", 1025)) {
			t.Fatal("prompt bounds", id)
		}
	}
	// RunningHub's models keep their provider; the combined list is RunningHub's then the 3D models.
	list := builtinMediaCatalog.List()
	if len(list) != len(builtinMediaCatalog.Models)+2 || list[0].Provider != mediaProviderRunningHub || list[len(list)-1].Provider != mediaProviderTripo {
		t.Fatal("catalog order", len(list))
	}
	bad := tripoModels()[0]
	bad.Params = append(bad.Params, mediaParam{Name: "unmapped", Type: "boolean", Default: true, Label: [2]string{"a", "b"}})
	if validTripoModel(bad) == nil {
		t.Fatal("a parameter Tripo has no field for must be refused")
	}
	foreign := tripoModels()[1]
	foreign.Docs = "https://evil.test/docs"
	if validTripoModel(foreign) == nil {
		t.Fatal("docs outside Tripo's site must be refused")
	}
}

func TestTripoRequestUsesWireNamesAndThePinnedVersion(t *testing.T) {
	m, _ := builtinMediaCatalog.model("tripo.p1")
	params, err := m.resolveMediaParams(json.RawMessage(`{"textureQuality":"detailed","negativePrompt":"blurry","faceLimit":3000}`))
	if err != nil {
		t.Fatal(err)
	}
	body := tripoRequest(m, "  a robot  ", params)
	want := map[string]any{"prompt": "a robot", "model": "P1-20260311", "texture": true, "pbr": true, "texture_quality": "detailed",
		"negative_prompt": "blurry", "face_limit": int64(3000), "auto_size": false}
	if len(body) != len(want) {
		t.Fatal("body", body)
	}
	for k, v := range want {
		if body[k] != v {
			t.Fatal("field", k, body[k], v)
		}
	}
	if _, err := m.resolveMediaParams(json.RawMessage(`{"geometryQuality":"detailed"}`)); err == nil {
		t.Fatal("the P series has no geometry quality")
	}
	if _, err := m.resolveMediaParams(json.RawMessage(`{"faceLimit":20001}`)); err == nil {
		t.Fatal("P1 face limit is at most 20000")
	}
}

func TestParseTripoTasks(t *testing.T) {
	ok := func(status string, output map[string]any) []byte {
		raw, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"task_id": "task_1", "status": status, "progress": 50, "output": output}})
		return raw
	}
	for status, want := range map[string]string{"queued": "QUEUED", "running": "RUNNING"} {
		if task, err := parseTripoTask(ok(status, nil), "task_1"); err != nil || task.Status != want || task.TaskID != "task_1" {
			t.Fatal(status, task, err)
		}
	}
	task, err := parseTripoTask(ok("success", map[string]any{"model_url": "https://cdn.tripo3d.ai/m.glb", "rendered_image_url": "https://cdn.tripo3d.ai/p.png"}), "task_1")
	if err != nil || task.Status != "SUCCESS" || len(task.Results) != 2 || task.Results[0].OutputType != "model" || task.Results[1].URL != "https://cdn.tripo3d.ai/p.png" {
		t.Fatal("success", task, err)
	}
	if _, err := parseTripoTask(ok("success", map[string]any{}), "task_1"); mediaFailureCode(err) != "media_no_output" {
		t.Fatal("a success without a model is not a result", err)
	}
	for status, want := range map[string]string{"banned": "media_content_rejected", "failed": "media_failed", "cancelled": "media_failed",
		"expired": "media_result_unavailable", "mystery": "media_provider_unavailable"} {
		if _, err := parseTripoTask(ok(status, nil), "task_1"); mediaFailureCode(err) != want {
			t.Fatal(status, err)
		}
	}
	// The queried id stands in when the answer omits it; an error code inside a 200 still fails.
	if task, _ := parseTripoTask([]byte(`{"code":0,"data":{"status":"running"}}`), "task_9"); task.TaskID != "task_9" {
		t.Fatal("task id fallback", task)
	}
	if _, err := parseTripoTask([]byte(`{"code":2010,"message":"Insufficient credits"}`), "task_1"); mediaFailureCode(err) != "media_provider_balance" {
		t.Fatal("balance", err)
	}
	// Tripo returns the credits of a failed or cancelled task, so those end unbilled; a documented reason is kept,
	// a busy code is not a reason for a task that already ended, and a banned task stays billed.
	for raw, want := range map[string]struct {
		code     string
		unbilled bool
	}{
		`{"code":0,"data":{"task_id":"task_1","status":"failed","error_code":2008}}`: {"media_content_rejected", true},
		`{"code":0,"data":{"task_id":"task_1","status":"failed","error_code":2000}}`: {"media_failed", true},
		`{"code":0,"data":{"task_id":"task_1","status":"failed"}}`:                   {"media_failed", true},
		`{"code":0,"data":{"task_id":"task_1","status":"cancelled"}}`:                {"media_failed", true},
		`{"code":0,"data":{"task_id":"task_1","status":"banned"}}`:                   {"media_content_rejected", false},
	} {
		_, err := parseTripoTask([]byte(raw), "task_1")
		e, ok := asRHError(err)
		if !ok || e.Code != want.code || e.Unbilled != want.unbilled || e.Transient {
			t.Fatal(raw, err, e)
		}
	}
}

func TestTripoErrorCodesAreClosed(t *testing.T) {
	for code, want := range map[string]string{"1000": "media_provider_unauthorized", "2010": "media_provider_balance", "2008": "media_content_rejected",
		"2000": "media_provider_busy", "1007": "media_provider_busy", "2002": "media_params_invalid", "9999": "media_failed"} {
		if got := mediaFailureCode(tripoCodeError(code)); got != want {
			t.Fatal(code, got, want)
		}
	}
	for status, want := range map[int]string{401: "media_provider_unauthorized", 404: "media_task_missing", 429: "media_provider_busy", 502: "media_provider_unavailable", 400: "media_params_invalid"} {
		if got := mediaFailureCode(tripoHTTPError(status, []byte(`{"message":"echoes the prompt"}`))); got != want {
			t.Fatal(status, got, want)
		}
	}
	// A documented code outranks the HTTP status: 403 with 2010 is the operator's balance, not a bad key.
	if got := mediaFailureCode(tripoHTTPError(403, []byte(`{"code":2010}`))); got != "media_provider_balance" {
		t.Fatal("403 2010", got)
	}
	// Each answer is its own value: marking one resendable never marks another.
	first, second := tripoCodeError("2000").(*rhError), tripoCodeError("2000").(*rhError)
	first.RetryAfter = time.Second
	if first == second || second.RetryAfter != 0 || tripoCodes["2000"].RetryAfter != 0 {
		t.Fatal("shared error value")
	}
	now := time.Unix(1_800_000_000, 0)
	for name, c := range map[string]struct {
		header http.Header
		want   time.Duration
	}{
		"retry-after":   {http.Header{"Retry-After": {"7"}}, 7 * time.Second},
		"reset":         {http.Header{"X-Ratelimit-Reset": {"1800000003"}}, 3 * time.Second},
		"neither":       {http.Header{}, 5 * time.Second},
		"capped":        {http.Header{"Retry-After": {"3600"}}, 30 * time.Second},
		"floor":         {http.Header{"Retry-After": {"0"}}, time.Second},
		"reset in past": {http.Header{"X-Ratelimit-Reset": {"1700000000"}}, time.Second},
		"not a number":  {http.Header{"Retry-After": {"Wed, 21 Oct 2026 07:28:00 GMT"}}, 5 * time.Second},
	} {
		if got := tripoRetryAfter(c.header, now); got != c.want {
			t.Fatal(name, got, c.want)
		}
	}
	// Only a busy answer is resendable, and it always carries a wait.
	if e, _ := asRHError(tripoRefusal(tripoCodeError("2000"), 0)); e.RetryAfter != 5*time.Second {
		t.Fatal("busy without a header", e)
	}
	if e, _ := asRHError(tripoRefusal(tripoHTTPError(429, nil), 2*time.Second)); e.RetryAfter != 2*time.Second {
		t.Fatal("bare 429", e)
	}
	for _, err := range []error{tripoCodeError("2010"), tripoHTTPError(502, nil), &rhError{Code: "media_provider_unavailable", Transient: true}} {
		if e, _ := asRHError(tripoRefusal(err, 3*time.Second)); e.RetryAfter != 0 {
			t.Fatal("not resendable", e)
		}
	}
}

// fakeMediaProvider answers submissions from a script and counts them.
type fakeMediaProvider struct {
	answers []error
	calls   int
}

func (f *fakeMediaProvider) submit(ctx context.Context, endpoint string, body map[string]any) (rhTask, error) {
	f.calls++
	if f.calls <= len(f.answers) && f.answers[f.calls-1] != nil {
		return rhTask{}, f.answers[f.calls-1]
	}
	return rhTask{TaskID: "task_ok", Status: "QUEUED"}, nil
}
func (f *fakeMediaProvider) query(context.Context, string) (rhTask, error) { return rhTask{}, nil }
func (f *fakeMediaProvider) download(context.Context, string, io.Writer) (int64, error) {
	return 0, nil
}
func (f *fakeMediaProvider) fileLimit() int64 { return 0 }

func TestSubmitMediaWaitsOutOnlyNoTaskRefusals(t *testing.T) {
	busy := func() error {
		return &rhError{Code: "media_provider_busy", Transient: true, RetryAfter: time.Millisecond}
	}
	hub := &fakeMediaProvider{answers: []error{busy(), busy()}}
	waits := 0
	task, err := submitMedia(context.Background(), hub, "/generation/text-to-model", map[string]any{}, func() { waits++ })
	if err != nil || task.TaskID != "task_ok" || hub.calls != 3 || waits != 1 {
		t.Fatal("busy answers are waited out, the run shown queued once", task, err, hub.calls, waits)
	}
	// Anything else is final after one send: it may have reached the provider and be billed.
	for _, answer := range []error{&rhError{Code: "media_provider_busy", Transient: true}, &rhError{Code: "media_provider_unavailable", Transient: true},
		&rhError{Code: "media_provider_balance"}, context.DeadlineExceeded} {
		hub := &fakeMediaProvider{answers: []error{answer}}
		if _, err := submitMedia(context.Background(), hub, "/x", map[string]any{}, func() { t.Fatal("not a wait") }); err != answer || hub.calls != 1 {
			t.Fatal("sent again", answer, hub.calls)
		}
	}
	// A cancel or the run's deadline ends the wait with the busy answer.
	ctx, cancel := context.WithCancel(context.Background())
	slow := &fakeMediaProvider{answers: []error{&rhError{Code: "media_provider_busy", Transient: true, RetryAfter: time.Hour}}}
	go cancel()
	if _, err := submitMedia(ctx, slow, "/x", map[string]any{}, func() {}); mediaFailureCode(err) != "media_provider_busy" || slow.calls != 1 {
		t.Fatal("cancel during the wait", err, slow.calls)
	}
}

func TestEveryWorkspace3DNeedsAnOwnedWorkspaceCap(t *testing.T) {
	c := testConfig()
	c.MediaDir = filepath.Join(t.TempDir(), "media")
	c.TripoAPIKey, c.TripoBaseURL, c.TripoResultHosts = "tsk_"+strings.Repeat("k", 32), defaultTripoBaseURL, []string{".tripo3d.ai"}
	c.TripoAllWorkspaces = true
	if validateMediaExposure(c) == nil {
		t.Fatal("3D for every workspace without AWWO_MAX_OWNED_WORKSPACES")
	}
	c.MaxOwnedWorkspaces = 1
	if err := validateMediaExposure(c); err != nil {
		t.Fatal(err)
	}
	c.MaxOwnedWorkspaces, c.TripoAllWorkspaces = 0, false
	c.NewWorkspaceModels = modelEntitlement{allowed: &[]string{"qwen3.8-27b-p6", "tripo.p1"}}
	if validateMediaExposure(c) == nil {
		t.Fatal("a 3D model in the new-workspace list without AWWO_MAX_OWNED_WORKSPACES")
	}
	c.NewWorkspaceModels = modelEntitlement{allowed: &[]string{"qwen3.8-27b-p6"}}
	if err := validateMediaExposure(c); err != nil {
		t.Fatal(err)
	}
}

func TestTripoClientCallsAndDownloads(t *testing.T) {
	var auth, method, path string
	var body map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, method, path = r.Header.Get("Authorization"), r.Method, r.URL.Path
		body = nil
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case r.URL.Path == "/generation/text-to-model":
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": "task_abc123"}})
		case r.URL.Path == "/tasks/task_abc123":
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": "task_abc123", "status": "success",
				"output": map[string]any{"model_url": "https://tripo-data.cdn.tripo3d.ai/m.glb"}}})
		case r.URL.Path == "/tasks/gone":
			writeJSON(w, 404, map[string]any{"code": 2001, "message": "not found"})
		case r.URL.Path == "/generation/poor":
			writeJSON(w, 403, map[string]any{"code": 2010, "message": "Insufficient credits"})
		case r.URL.Path == "/generation/full":
			w.Header().Set("Retry-After", "2")
			writeJSON(w, 429, map[string]any{"code": 2000, "message": "You have exceeded the limit of generation"})
		}
	}))
	defer api.Close()
	glb := append([]byte("glTF"), make([]byte, 2048)...)
	binary.LittleEndian.PutUint32(glb[4:8], 2)
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/m.glb" {
			_, _ = w.Write(glb)
			return
		}
		w.WriteHeader(404)
	}))
	defer files.Close()
	c := &tripoClient{base: api.URL, key: "tsk_secret-key-0123456789", api: api.Client(), hosts: []string{".tripo3d.ai"}, maxFile: 1 << 20}
	c.files = &http.Client{Transport: redirectTransport{files}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if !resultURLAllowed(c.hosts, req.URL) {
			return errors.New("result redirect refused")
		}
		return nil
	}}
	ctx := context.Background()
	task, err := c.submit(ctx, "/generation/text-to-model", map[string]any{"prompt": "a cat", "model": "v3.1-20260211"})
	if err != nil || task.TaskID != "task_abc123" || auth != "Bearer tsk_secret-key-0123456789" || method != "POST" || body["model"] != "v3.1-20260211" {
		t.Fatal("submit", task, err, auth, body)
	}
	task, err = c.query(ctx, "task_abc123")
	if err != nil || method != "GET" || path != "/tasks/task_abc123" || task.Status != "SUCCESS" || len(task.Results) != 1 {
		t.Fatal("query", task, err)
	}
	if _, err := c.query(ctx, "gone"); mediaFailureCode(err) != "media_task_missing" {
		t.Fatal("404", err)
	}
	if _, err := c.query(ctx, "../admin"); mediaFailureCode(err) != "media_task_missing" {
		t.Fatal("a malformed task id must never become a path", err)
	}
	if _, err := c.submit(ctx, "/generation/poor", map[string]any{}); mediaFailureCode(err) != "media_provider_balance" {
		t.Fatal("balance", err)
	} else if e, _ := asRHError(err); e.RetryAfter != 0 {
		t.Fatal("a balance refusal is final", e)
	}
	if _, err := c.submit(ctx, "/generation/full", map[string]any{}); mediaFailureCode(err) != "media_provider_busy" {
		t.Fatal("full concurrency pool", err)
	} else if e, _ := asRHError(err); e.RetryAfter != 2*time.Second {
		t.Fatal("Tripo's Retry-After is the wait", e)
	}
	var out bytes.Buffer
	if n, err := c.download(ctx, "https://tripo-data.cdn.tripo3d.ai/m.glb", &out); err != nil || n != int64(len(glb)) {
		t.Fatal("download", n, err)
	}
	if _, err := c.download(ctx, "https://files.evil.test/m.glb", io.Discard); mediaFailureCode(err) != "media_result_refused" {
		t.Fatal("foreign host", err)
	}
	if contentType, ext, kind := sniffMedia(out.Bytes()[:64]); contentType != "model/gltf-binary" || ext != "glb" || kind != mediaKindModel3D {
		t.Fatal("sniff", contentType, ext, kind)
	}
}

func TestModel3DFilesAndPrices(t *testing.T) {
	v1 := append([]byte("glTF"), make([]byte, 60)...)
	binary.LittleEndian.PutUint32(v1[4:8], 1)
	if _, _, kind := sniffMedia(v1); kind != "" {
		t.Fatal("glTF 1.0 is not stored", kind)
	}
	if !mediaResultFits(mediaKindModel3D, mediaKindModel3D, 1) || mediaResultFits(mediaKindModel3D, mediaKindImage, 1) ||
		!mediaResultFits(mediaKindModel3D, mediaKindImage, 2) || mediaResultFits(mediaKindModel3D, mediaKindVideo, 2) ||
		mediaResultFits(mediaKindImage, mediaKindModel3D, 1) || !mediaResultFits(mediaKindVideo, mediaKindVideo, 3) {
		t.Fatal("which files a 3D node stores")
	}
	if !mediaFileName.MatchString(strings.Repeat("a", 64)+".glb") || mediaFileName.MatchString(strings.Repeat("a", 64)+".gltf") {
		t.Fatal("stored GLB names")
	}
	// Three times Tripo's own tables: H3.1 20 textured / 10 untextured, +10 detailed texture, +20 detailed geometry;
	// P1 40 / 30, +10 detailed texture. An untextured model generates no texture, so detailed texture costs nothing.
	for _, c := range []struct {
		model, params string
		want          int
	}{
		{"tripo.v3-1", `{}`, 60}, {"tripo.v3-1", `{"textureQuality":"detailed"}`, 90},
		{"tripo.v3-1", `{"geometryQuality":"detailed","textureQuality":"detailed"}`, 150},
		{"tripo.v3-1", `{"texture":false,"pbr":false}`, 30}, {"tripo.v3-1", `{"texture":false,"pbr":false,"textureQuality":"detailed"}`, 30},
		{"tripo.v3-1", `{"texture":false,"pbr":true}`, 60},
		{"tripo.p1", `{}`, 120}, {"tripo.p1", `{"textureQuality":"detailed"}`, 150}, {"tripo.p1", `{"texture":false,"pbr":false}`, 90},
		{"tripo.p1", `{"texture":false,"pbr":false,"textureQuality":"detailed"}`, 90},
	} {
		m, _ := builtinMediaCatalog.model(c.model)
		resolved, err := m.resolveMediaParams(json.RawMessage(c.params))
		if err != nil {
			t.Fatal(c.model, c.params, err)
		}
		if got := mediaCreditsFor(m.ID, m.Kind, resolved); got != c.want {
			t.Fatal(c.model, c.params, got, c.want)
		}
	}
	for _, m := range tripoModels() {
		if _, ok := model3DCredits[m.ID]; !ok || mediaBaseCredits[m.ID] != model3DCredits[m.ID].textured {
			t.Fatal("every 3D model has its own price table, its base price the textured one", m.ID)
		}
	}
}

func TestTripoConfig(t *testing.T) {
	valid := testConfig()
	valid.MediaDir = filepath.Join(t.TempDir(), "media")
	valid.MediaTimeout, valid.MediaPollInterval, valid.MediaRunsPerDay, valid.MediaMaxFileBytes = 20*time.Minute, 5*time.Second, 30, 300<<20
	valid.MediaResultHosts = []string{".runninghub.ai"}
	valid.RunningHubBaseURL = defaultRunningHubBaseURL
	valid.TripoAPIKey, valid.TripoBaseURL, valid.TripoResultHosts = "tsk_"+strings.Repeat("k", 32), defaultTripoBaseURL, []string{".tripo3d.ai"}
	valid.TripoFreeRunsPerDay, valid.TripoFreeTotalPerDay = 2, 40
	if err := validateMediaConfig(valid); err != nil {
		t.Fatal("3D generation alone is a valid media setup", err)
	}
	if !valid.tripoConfigured() || valid.runningHubConfigured() || !valid.mediaConfigured() || !valid.mediaProviderConfigured(mediaProviderTripo) || valid.mediaProviderConfigured(mediaProviderRunningHub) {
		t.Fatal("provider predicates")
	}
	for name, mutate := range map[string]func(*Config){
		"no storage":         func(c *Config) { c.MediaDir = "" },
		"short key":          func(c *Config) { c.TripoAPIKey = "short" },
		"key with space":     func(c *Config) { c.TripoAPIKey = strings.Repeat("k", 20) + " x" },
		"foreign origin":     func(c *Config) { c.TripoBaseURL = "https://openapi.tripo3d.ai.evil.test/v3" },
		"old v2 origin":      func(c *Config) { c.TripoBaseURL = "https://api.tripo3d.ai/v2/openapi" },
		"wildcard host":      func(c *Config) { c.TripoResultHosts = []string{"*"} },
		"bare tld host":      func(c *Config) { c.TripoResultHosts = []string{".ai"} },
		"negative free runs": func(c *Config) { c.TripoFreeRunsPerDay = -1 },
		"negative total":     func(c *Config) { c.TripoFreeTotalPerDay = -1 },
		"loopback in prod": func(c *Config) {
			c.Env, c.PublicOrigin, c.TripoBaseURL = "production", "https://awwo.test", "http://127.0.0.1:9000"
		},
	} {
		c := valid
		mutate(&c)
		if validateMediaConfig(c) == nil {
			t.Fatal("accepted", name)
		}
	}
	t.Setenv("AWWO_TRIPO_ALL_WORKSPACES", "maybe")
	c := testConfig()
	if c.mediaFromEnv() == nil {
		t.Fatal("AWWO_TRIPO_ALL_WORKSPACES must be true or false")
	}
}

// A 3D run end to end against a stand-in for Tripo: a full concurrency pool is waited out and the task submitted
// once it frees, the model is kept when its preview cannot be stored, and a task Tripo fails on its side ends with
// its documented reason and costs no credits.
func TestPostgresTripoRunsWaitOutAFullPoolKeepTheModelAndRefundFailures(t *testing.T) {
	h, _ := newMediaHarness(t)
	glb := append([]byte("glTF"), make([]byte, 2048)...)
	binary.LittleEndian.PutUint32(glb[4:8], 2)
	var mu sync.Mutex
	submits, refuse := 0, 0
	final := map[string]any{"status": "success", "output": map[string]any{
		"model_url": "https://tripo-data.cdn.tripo3d.ai/m.glb", "rendered_image_url": "https://tripo-data.cdn.tripo3d.ai/p.png"}}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPost {
			submits++
			if refuse > 0 {
				refuse--
				w.Header().Set("Retry-After", "1")
				writeJSON(w, 429, map[string]any{"code": 2000, "message": "You have exceeded the limit of generation"})
				return
			}
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": fmt.Sprintf("task_%d", submits)}})
			return
		}
		data := map[string]any{"task_id": strings.TrimPrefix(r.URL.Path, "/tasks/")}
		for k, v := range final {
			data[k] = v
		}
		writeJSON(w, 200, map[string]any{"code": 0, "data": data})
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
	h.a.cfg.TripoFreeRunsPerDay, h.a.cfg.TripoFreeTotalPerDay = 10, 10
	hub := newTripo(h.a.cfg)
	hub.files.Transport = redirectTransport{files}
	h.a.tripo = hub

	c, tid, _ := h.register(t, "tripo-runs@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("hero", mediaKindModel3D, "tripo.p1", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	items := func(run map[string]any) []mediaItem {
		t.Helper()
		var out mediaOutput
		if e := json.Unmarshal([]byte(run["output"].(string)), &out); e != nil || out.Kind != mediaKindModel3D || out.Model != "tripo.p1" {
			t.Fatal("output", run["output"], e)
		}
		return out.Items
	}
	accepted := func(id string) *bool {
		t.Helper()
		var v *bool
		if e := h.db.QueryRow(t.Context(), "SELECT provider_accepted FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, id).Scan(&v); e != nil {
			t.Fatal(e)
		}
		return v
	}

	// A full pool is refused once, waited out as Tripo asked, then submitted; the run keeps model and preview.
	mu.Lock()
	refuse = 1
	mu.Unlock()
	run := h.mediaRun(t, c, tid, sid, "a low-poly sci-fi soldier", 202)
	done := h.awaitRun(t, c, tid, run["id"].(string), "completed")
	mu.Lock()
	sent := submits
	mu.Unlock()
	if got := items(done); sent != 2 || len(got) != 2 || got[0].ContentType != "model/gltf-binary" || got[1].ContentType != "image/png" {
		t.Fatal("full pool", sent, got)
	}
	if a := accepted(run["id"].(string)); a == nil || !*a {
		t.Fatal("an accepted task is billed", a)
	}

	// A preview that cannot be fetched leaves the stored model as the result.
	mu.Lock()
	final["output"] = map[string]any{"model_url": "https://tripo-data.cdn.tripo3d.ai/m.glb", "rendered_image_url": "https://tripo-data.cdn.tripo3d.ai/gone.png"}
	mu.Unlock()
	run = h.mediaRun(t, c, tid, sid, "a low-poly sci-fi soldier", 202)
	if got := items(h.awaitRun(t, c, tid, run["id"].(string), "completed")); len(got) != 1 || got[0].ContentType != "model/gltf-binary" {
		t.Fatal("model without its preview", got)
	}

	// A task Tripo fails keeps its documented reason and is not billed: Tripo returns its credits.
	mu.Lock()
	final = map[string]any{"status": "failed", "error_code": 2008}
	mu.Unlock()
	run = h.mediaRun(t, c, tid, sid, "a low-poly sci-fi soldier", 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_content_rejected" {
		t.Fatal("failed task", code)
	}
	if a := accepted(run["id"].(string)); a == nil || *a {
		t.Fatal("a task Tripo failed is not billed", a)
	}
}
