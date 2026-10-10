package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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
	for params, want := range map[string]int{
		`{}`: 60, `{"textureQuality":"detailed"}`: 90, `{"geometryQuality":"detailed","textureQuality":"detailed"}`: 150,
		`{"texture":false,"pbr":false}`: 30,
	} {
		m, _ := builtinMediaCatalog.model("tripo.v3-1")
		resolved, err := m.resolveMediaParams(json.RawMessage(params))
		if err != nil {
			t.Fatal(params, err)
		}
		if got := mediaCreditsFor(m.ID, m.Kind, resolved); got != want {
			t.Fatal(params, got, want)
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
