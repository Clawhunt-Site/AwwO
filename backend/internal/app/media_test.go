package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuiltinMediaCatalogIsCompleteAndClosed(t *testing.T) {
	c := builtinMediaCatalog
	images, videos, audio := 0, 0, 0
	for i := range c.Models {
		m := &c.Models[i]
		switch m.Kind {
		case mediaKindImage:
			images++
		case mediaKindVideo:
			videos++
		case mediaKindAudio:
			audio++
		}
		// Every model must resolve to a complete request from its defaults alone.
		values, err := m.resolveMediaParams(nil)
		if err != nil {
			t.Fatal(m.ID, err)
		}
		for _, p := range m.Params {
			if _, ok := values[p.Name]; !ok && p.Type != "text" {
				t.Fatal(m.ID, "parameter without a default", p.Name)
			}
		}
		if got, ok := c.model(m.ID); !ok || got != m {
			t.Fatal("catalog index lost", m.ID)
		}
	}
	if images < 5 || videos < 5 || audio != 2 || len(c.Models) != images+videos+audio {
		t.Fatal("catalog lacks the expected image, video and audio choices", images, videos, audio)
	}
}

// The two audio models (2026-10-17): a voice-over read from the node's text and instrumental music it describes, each
// with its closed choices, its request names where RunningHub's differ from the catalog's, and its fixed fields.
func TestAudioModelsAreInTheCatalogAndClosed(t *testing.T) {
	speech, ok := builtinMediaCatalog.model("rh.minimax-speech-2-8-hd")
	if !ok || speech.Kind != mediaKindAudio || speech.Mode != "text-to-speech" || speech.Provider != mediaProviderRunningHub || speech.References != 0 ||
		speech.Endpoint != "/openapi/v2/rhart-audio/text-to-audio/speech-2.8-hd" || speech.Prompt != (mediaPrompt{MinLength: 1, MaxLength: 1000}) ||
		speech.Verified != "2026-10-17" || speech.Label != [2]string{"配音 · 旁白", "Voice-over"} || speech.Vendor != mediaVendorShown {
		t.Fatalf("speech model %+v", speech)
	}
	music, ok := builtinMediaCatalog.model("rh.minimax-music-2-6-instrumental")
	if !ok || music.Kind != mediaKindAudio || music.Mode != "text-to-music" || music.Provider != mediaProviderRunningHub || music.References != 0 ||
		music.Endpoint != "/openapi/v2/minimax/music-2.6" || music.Prompt != (mediaPrompt{MinLength: 1, MaxLength: 2000}) ||
		music.Verified != "2026-10-17" || music.Label != [2]string{"配乐 · 纯音乐", "Score · Instrumental"} || music.Vendor != mediaVendorShown {
		t.Fatalf("music model %+v", music)
	}
	// The voices are exactly the system voices the model's documentation lists, Calm_Woman first chosen.
	voices := []string{"Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man", "Calm_Woman", "Casual_Guy", "Lively_Girl",
		"Patient_Man", "Young_Knight", "Determined_Man", "Lovely_Girl", "Decent_Boy", "Imposing_Manner", "Elegant_Man", "Abbess", "Sweet_Girl_2", "Exuberant_Girl"}
	params := map[string]mediaParam{}
	for _, p := range speech.Params {
		params[p.Name] = p
	}
	if v := params["voice"]; v.Type != "enum" || strings.Join(v.Values, ",") != strings.Join(voices, ",") || v.Default != "Calm_Woman" || len(v.ValueLabels) != len(voices) {
		t.Fatalf("voice %+v", v)
	}
	if e := params["emotion"]; e.Type != "enum" || e.Default != "neutral" || len(e.Values) != 7 || len(e.ValueLabels) != 7 {
		t.Fatalf("emotion %+v", e)
	}
	if s := params["speed"]; s.Type != "number" || *s.Min != 0.5 || *s.Max != 2 || s.Default != float64(1) {
		t.Fatalf("speed %+v", s)
	}
	if p := params["pitch"]; p.Type != "integer" || *p.Min != -12 || *p.Max != 12 || p.Default != float64(0) {
		t.Fatalf("pitch %+v", p)
	}
	if n := params["englishNormalization"]; n.Type != "boolean" || n.Default != false || len(speech.Params) != 5 {
		t.Fatalf("english normalization %+v, %d parameters", n, len(speech.Params))
	}
	names := []string{}
	for _, p := range music.Params {
		names = append(names, p.Name+"="+p.Default.(string))
	}
	if strings.Join(names, ",") != "sampleRate=44100,bitrate=256000" {
		t.Fatal("music parameters", names)
	}

	// The request: the words as text (speech) or prompt (music), the request names, and the fixed fields.
	values, err := speech.resolveMediaParams(json.RawMessage(`{"voice":"Young_Knight","emotion":"sad","speed":1.25,"pitch":-3,"englishNormalization":true}`))
	if err != nil {
		t.Fatal(err)
	}
	body := runningHubRequest(speech, "(sighs) The rain will not stop.", values)
	want := map[string]any{"text": "(sighs) The rain will not stop.", "voice_id": "Young_Knight", "emotion": "sad", "speed": 1.25, "pitch": int64(-3),
		"english_normalization": true, "enable_base64_output": false}
	if len(body) != len(want) {
		t.Fatalf("speech body %v", body)
	}
	for k, v := range want {
		if body[k] != v {
			t.Fatalf("speech body %s = %v, want %v (%v)", k, body[k], v, body)
		}
	}
	values, _ = music.resolveMediaParams(nil)
	body = runningHubRequest(music, "warm strings at dusk", values)
	if len(body) != 5 || body["prompt"] != "warm strings at dusk" || body["sampleRate"] != "44100" || body["bitrate"] != "256000" || body["format"] != "mp3" ||
		body["isInstrumental"] != true {
		t.Fatalf("music body %v", body)
	}
	// An image model's request is as before: the prompt and its parameters under their own names.
	image, _ := builtinMediaCatalog.model("rh.seedream-v5-pro")
	values, _ = image.resolveMediaParams(nil)
	if body = runningHubRequest(image, "a cat", values); len(body) != 3 || body["prompt"] != "a cat" || body["resolution"] != "2k" || body["outputFormat"] != "jpeg" {
		t.Fatalf("image body %v", body)
	}
	// A choice outside the closed lists is refused, never sent.
	for _, raw := range []string{`{"voice":"Someone_Else"}`, `{"speed":3}`, `{"pitch":0.5}`, `{"emotion":"bored"}`, `{"enableBase64Output":true}`} {
		if _, err := speech.resolveMediaParams(json.RawMessage(raw)); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	for _, raw := range []string{`{"format":"wav"}`, `{"isInstrumental":false}`} {
		if _, err := music.resolveMediaParams(json.RawMessage(raw)); err == nil {
			t.Fatal("a node chose a fixed music field", raw)
		}
	}
}

// An audio model is checked like any catalog entry: its mode is speech or music, and no parameter's request field is
// the prompt's, a fixed one or another's.
func TestParseMediaCatalogChecksAudioEntries(t *testing.T) {
	audio := func(id, mode string, params ...any) func(map[string]any) {
		return func(m map[string]any) {
			m["id"], m["kind"], m["mode"], m["endpoint"] = id, "audio", mode, "/openapi/v2/test/"+mode
			if params != nil {
				m["params"] = params
			}
		}
	}
	enum := func(name string) map[string]any {
		return map[string]any{"name": name, "type": "enum", "values": []any{"a", "b"}, "default": "a", "label": []any{"甲", "A"}}
	}
	for _, mode := range []string{"text-to-speech", "text-to-music"} {
		if _, err := parseMediaCatalog(mediaCatalogFixture(audio("rh.test-audio", mode))); err != nil {
			t.Fatal("an audio entry", mode, err)
		}
	}
	// The speech model's own shape passes: its two renamed parameters are there.
	if _, err := parseMediaCatalog(mediaCatalogFixture(audio("rh.minimax-speech-2-8-hd", "text-to-speech", enum("voice"), enum("englishNormalization")))); err != nil {
		t.Fatal("the speech model's parameters", err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"audio of another mode": audio("rh.test-audio", "text-to-audio"),
		"audio as an image":     audio("rh.test-audio", "text-to-image"),
		"unknown kind":          func(m map[string]any) { m["kind"], m["mode"] = "sound", "text-to-sound" },
		// The speech model reads its words from "text", and the music model always sends its format: no parameter may
		// be sent as either.
		"parameter on the prompt's field": audio("rh.minimax-speech-2-8-hd", "text-to-speech", enum("voice"), enum("englishNormalization"), enum("text")),
		"parameter on a fixed field":      audio("rh.minimax-music-2-6-instrumental", "text-to-music", enum("format")),
		"parameter on the vocal switch":   audio("rh.minimax-music-2-6-instrumental", "text-to-music", enum("isInstrumental")),
		"wire name for a missing param":   audio("rh.minimax-speech-2-8-hd", "text-to-speech", enum("voice")),
	} {
		if _, err := parseMediaCatalog(mediaCatalogFixture(mutate)); err == nil {
			t.Error("accepted catalog with", name)
		}
	}
	// Every request mapping names a catalog model.
	for _, table := range []map[string]bool{keysOf(runningHubWireParams), keysOf(runningHubPromptField), keysOf(runningHubFixed)} {
		for id := range table {
			if m, ok := builtinMediaCatalog.model(id); !ok || m.Provider != mediaProviderRunningHub {
				t.Error("request mapping for a model RunningHub does not run", id)
			}
		}
	}
}

func keysOf[V any](m map[string]V) map[string]bool {
	keys := map[string]bool{}
	for k := range m {
		keys[k] = true
	}
	return keys
}

func mediaCatalogFixture(mutate func(map[string]any)) []byte {
	model := map[string]any{"id": "rh.test-image", "name": "Test Image", "vendor": "test", "kind": "image", "mode": "text-to-image",
		"endpoint": "/openapi/v2/test/text-to-image", "prompt": map[string]any{"minLength": 1, "maxLength": 100},
		"params": []any{map[string]any{"name": "ratio", "type": "enum", "values": []any{"1:1", "16:9"}, "default": "1:1", "label": []any{"比例", "Ratio"}}},
		"docs":   "https://www.runninghub.ai/runninghub-api-doc-en/api-1", "verified": ""}
	catalog := map[string]any{"version": 1, "provider": "runninghub", "source": "test", "notes": []any{}, "models": []any{model}}
	if mutate != nil {
		mutate(model)
	}
	raw, _ := json.Marshal(catalog)
	return raw
}

func TestParseMediaCatalogRefusesMalformedEntries(t *testing.T) {
	if _, err := parseMediaCatalog(mediaCatalogFixture(nil)); err != nil {
		t.Fatal("fixture must be valid", err)
	}
	param := func(m map[string]any) map[string]any { return m["params"].([]any)[0].(map[string]any) }
	cases := map[string]func(map[string]any){
		"unknown field":        func(m map[string]any) { m["extra"] = true },
		"id without prefix":    func(m map[string]any) { m["id"] = "seedream" },
		"endpoint off the API": func(m map[string]any) { m["endpoint"] = "https://evil.test/x" },
		"endpoint traversal":   func(m map[string]any) { m["endpoint"] = "/openapi/v2/../task" },
		"kind mismatch":        func(m map[string]any) { m["mode"] = "text-to-video" },
		"empty prompt range":   func(m map[string]any) { m["prompt"] = map[string]any{"minLength": 0, "maxLength": 10} },
		"foreign docs":         func(m map[string]any) { m["docs"] = "https://evil.test/doc" },
		"reserved param":       func(m map[string]any) { param(m)["name"] = "prompt" },
		"callback param":       func(m map[string]any) { param(m)["name"] = "webhookUrl" },
		"enum default outside": func(m map[string]any) { param(m)["default"] = "4:3" },
		"enum duplicate":       func(m map[string]any) { param(m)["values"] = []any{"1:1", "1:1"} },
		"unknown type":         func(m map[string]any) { param(m)["type"] = "json" },
		"integer fraction": func(m map[string]any) {
			m["params"] = []any{map[string]any{"name": "steps", "type": "integer", "min": 1.5, "max": 4, "label": []any{"步数", "Steps"}}}
		},
		"text with default": func(m map[string]any) {
			m["params"] = []any{map[string]any{"name": "negative", "type": "text", "maxLength": 10, "default": "x", "label": []any{"反向", "Negative"}}}
		},
		"control character name": func(m map[string]any) { m["name"] = "Bad\nName" },
	}
	for name, mutate := range cases {
		if _, err := parseMediaCatalog(mediaCatalogFixture(mutate)); err == nil {
			t.Fatal("accepted catalog with", name)
		}
	}
	duplicate := mediaCatalogFixture(nil)
	var v map[string]any
	_ = json.Unmarshal(duplicate, &v)
	v["models"] = append(v["models"].([]any), v["models"].([]any)[0])
	raw, _ := json.Marshal(v)
	if _, err := parseMediaCatalog(raw); err == nil {
		t.Fatal("accepted duplicate ids")
	}
}

func TestResolveMediaParamsIsClosedAndTyped(t *testing.T) {
	m, ok := builtinMediaCatalog.model("rh.midjourney-v7")
	if !ok {
		t.Fatal("fixture model missing")
	}
	values, err := m.resolveMediaParams(json.RawMessage(`{"aspectRatio":"16:9","stylize":250,"raw":true,"negativePrompt":"  "}`))
	if err != nil {
		t.Fatal(err)
	}
	if values["aspectRatio"] != "16:9" || values["stylize"] != int64(250) || values["raw"] != true || values["chaos"] != float64(0) || values["quality"] != "1" {
		t.Fatal("unexpected resolved values", values)
	}
	if _, present := values["negativePrompt"]; present {
		t.Fatal("blank optional text must not be sent")
	}
	refused := []string{
		`{"aspectRatio":"5:1"}`, `{"aspectRatio":3}`, `{"stylize":1001}`, `{"stylize":2.5}`, `{"stylize":"250"}`,
		`{"raw":"yes"}`, `{"unknown":1}`, `{"prompt":"override"}`, `[1,2]`, `"text"`, `{"negativePrompt":"` + strings.Repeat("x", 9000) + `"}`,
	}
	for _, raw := range refused {
		if _, err := m.resolveMediaParams(json.RawMessage(raw)); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	if values, err := m.resolveMediaParams(json.RawMessage(`{"stylize":null}`)); err != nil || values["stylize"] != float64(100) {
		t.Fatal("null must fall back to the default", values, err)
	}
	kling, _ := builtinMediaCatalog.model("rh.kling-v3-pro")
	if values, err := kling.resolveMediaParams(json.RawMessage(`{"cfgScale":0.25}`)); err != nil || values["cfgScale"] != 0.25 {
		t.Fatal("number parameter lost its fraction", values, err)
	}
	if !m.validMediaPrompt("a cat") || m.validMediaPrompt("   ") || m.validMediaPrompt("cat\x00") || m.validMediaPrompt(strings.Repeat("字", 8193)) {
		t.Fatal("prompt length is not enforced in characters")
	}
}

func TestParseRunningHubTasks(t *testing.T) {
	task, err := parseRHTask([]byte(`{"taskId":"123","status":"QUEUED","errorCode":"","errorMessage":"","results":null}`))
	if err != nil || task.TaskID != "123" || task.Status != "QUEUED" {
		t.Fatal("plain task", task, err)
	}
	task, err = parseRHTask([]byte(`{"code":0,"msg":"success","data":{"taskId":456,"status":"SUCCESS","results":[{"url":"https://a.runninghub.ai/x.png","outputType":"png"}]}}`))
	if err != nil || task.TaskID != "456" || task.Status != "SUCCESS" || len(task.Results) != 1 {
		t.Fatal("wrapped task", task, err)
	}
	cases := map[string]string{
		`{"code":1014,"msg":"use an enterprise key","data":null}`:                "media_provider_unauthorized",
		`{"code":812,"msg":"no funds","data":{}}`:                                "media_provider_balance",
		`{"taskId":"1","status":"FAILED","errorCode":"1501","errorMessage":"x"}`: "media_content_rejected",
		`{"taskId":"1","status":"FAILED"}`:                                       "media_failed",
		`{"taskId":"1","status":"RUNNING","errorCode":"813"}`:                    "media_pending",
		`{"taskId":"1","status":"PAUSED"}`:                                       "media_provider_unavailable",
		`{"taskId":"../../etc","status":"QUEUED"}`:                               "media_provider_unavailable",
		`not json`: "media_provider_unavailable",
		`{"taskId":"1","status":"FAILED","errorCode":"999999"}`: "media_failed",
	}
	for raw, want := range cases {
		_, err := parseRHTask([]byte(raw))
		if e, ok := asRHError(err); !ok || e.Code != want {
			t.Fatal(raw, "got", err, "want", want)
		}
	}
	// One level of {code,msg,data} is unwrapped, never more: a deeply nested answer costs no parsing.
	if _, err := parseRHTask([]byte(`{"code":0,"data":{"code":0,"data":{"taskId":"1","status":"SUCCESS"}}}`)); mediaFailureCode(err) != "media_provider_unavailable" {
		t.Fatal("nested answer accepted", err)
	}
	many := `{"taskId":"1","status":"SUCCESS","results":[` + strings.TrimSuffix(strings.Repeat(`{"url":"https://a.runninghub.ai/x.png"},`, 20), ",") + `]}`
	if task, err := parseRHTask([]byte(many)); err != nil || len(task.Results) != rhMaxResults {
		t.Fatal("results are not capped", len(task.Results), err)
	}
	// A Seedance 2 answer, shaped as RunningHub sent it on 2026-10-05: the video, then the token
	// count as a value without a URL. Only the video is a file to store.
	seedance := `{"taskId":"1","status":"SUCCESS","results":[{"url":"https://rh-hk-images-1252422369.cos.ap-hongkong.myqcloud.com/v.mp4","outputType":"mp4"},` +
		`{"url":"","outputType":"text","text":"23224","name":"","zindex":0}]}`
	task, err = parseRHTask([]byte(seedance))
	if files := mediaFileResults(task.Results); err != nil || len(task.Results) != 2 || len(files) != 1 || files[0].OutputType != "mp4" {
		t.Fatal("non-file results are not skipped", task.Results, err)
	}
	if files := mediaFileResults([]rhResult{{URL: " ", OutputType: "png"}, {URL: "https://a.runninghub.ai/t.txt", OutputType: "Text"}}); len(files) != 0 {
		t.Fatal("a result without a URL or a text value counted as a file", files)
	}
	if e, _ := asRHError(rhCodeError("415")); !e.Transient {
		t.Fatal("busy must be transient")
	}
	if e, _ := asRHError(rhCodeError("1014")); e.Transient {
		t.Fatal("an unauthorized key must not be retried")
	}
}

func TestRunningHubResultHostsAndAddresses(t *testing.T) {
	h := &runningHub{hosts: []string{".runninghub.ai", ".myqcloud.com", "rh-images-1.cos.example.com"}}
	allowed := []string{"https://rh-images.runninghub.ai/x.png", "https://bucket-1.cos.ap-beijing.myqcloud.com/out.mp4", "https://files.runninghub.ai:443/x.png",
		"https://rh-images-1.cos.example.com/a.png"}
	refused := []string{"http://rh-images.runninghub.ai/x.png", "https://runninghub.ai/x.png", "https://evilrunninghub.ai/x.png",
		"https://x.rh-images-1.cos.example.com/a.png", "https://rh-images-1.cos.example.com.evil.test/a.png",
		"https://rh.runninghub.ai.evil.test/x.png", "https://user:pw@files.runninghub.ai/x.png", "https://files.runninghub.ai:8443/x.png", "file:///etc/passwd"}
	for _, raw := range allowed {
		u, _ := url.Parse(raw)
		if !h.allowedResultURL(u) {
			t.Fatal("refused", raw)
		}
	}
	for _, raw := range refused {
		u, _ := url.Parse(raw)
		if h.allowedResultURL(u) {
			t.Fatal("allowed", raw)
		}
	}
	// The defaults, against the hosts real responses used (2026-10-03): a runninghub.ai generation's
	// result came from the Hong Kong bucket; an upload's signed URL from a CDN host that never
	// carries a result and stays refused, like any other bucket.
	defaults := &runningHub{hosts: strings.Split(defaultMediaResultHosts, ",")}
	for _, raw := range []string{"https://rh-hk-images-1252422369.cos.ap-hongkong.myqcloud.com/output/a.jpg",
		"https://rh-images-1252422369.cos.ap-beijing.myqcloud.com/output/a.png", "https://rh-images.runninghub.cn/a.mp4"} {
		if u, _ := url.Parse(raw); !defaults.allowedResultURL(u) {
			t.Fatal("default hosts refuse", raw)
		}
	}
	for _, raw := range []string{"https://rh-hk-images-switch.xiaoyaoyou.com/a.png", "https://other-1252422369.cos.ap-hongkong.myqcloud.com/a.jpg",
		"https://x.rh-hk-images-1252422369.cos.ap-hongkong.myqcloud.com/a.jpg", "https://cos.ap-hongkong.myqcloud.com/a.jpg"} {
		if u, _ := url.Parse(raw); defaults.allowedResultURL(u) {
			t.Fatal("default hosts allow", raw)
		}
	}
	for _, addr := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "198.18.0.1"} {
		if publicAddress(netip.MustParseAddr(addr)) {
			t.Fatal("treated as public", addr)
		}
	}
	for _, addr := range []string{"8.8.8.8", "43.137.1.1", "2606:4700::1111"} {
		if !publicAddress(netip.MustParseAddr(addr)) {
			t.Fatal("treated as non-public", addr)
		}
	}
	// The address check runs on the dialed address itself, so DNS cannot route around it.
	transport := publicOnlyTransport(Config{Env: "production"})
	if transport.Proxy != nil {
		t.Fatal("production must not consult proxy variables")
	}
	if _, err := transport.DialContext(context.Background(), "tcp", "127.0.0.1:443"); err == nil || !strings.Contains(err.Error(), "non-public") {
		t.Fatal("dialed a loopback address", err)
	}
	// An explicit development proxy is the one loopback address dialed; nothing else is relaxed.
	proxied := publicOnlyTransport(Config{Env: "development", MediaDevProxy: "http://127.0.0.1:1"})
	if proxied.Proxy == nil {
		t.Fatal("explicit development proxy not used")
	}
	if _, err := proxied.DialContext(context.Background(), "tcp", "127.0.0.1:2"); err == nil || !strings.Contains(err.Error(), "non-public") {
		t.Fatal("a development proxy opened other loopback ports", err)
	}
	if _, err := proxied.DialContext(context.Background(), "tcp", "127.0.0.1:1"); err != nil && strings.Contains(err.Error(), "non-public") {
		t.Fatal("the configured proxy address was refused", err)
	}
	if publicOnlyTransport(Config{Env: "production", MediaDevProxy: "http://127.0.0.1:1"}).Proxy != nil {
		t.Fatal("production used a proxy")
	}
}

func TestMediaConfigValidation(t *testing.T) {
	valid := testConfig()
	dir := filepath.Join(t.TempDir(), "media")
	valid.RunningHubAPIKey, valid.RunningHubBaseURL, valid.MediaDir = strings.Repeat("k", 32), defaultRunningHubBaseURL, dir
	valid.MediaTimeout, valid.MediaPollInterval, valid.MediaRunsPerDay, valid.MediaMaxFileBytes = 20*time.Minute, 5*time.Second, 30, 300<<20
	valid.MediaResultHosts = []string{".runninghub.ai"}
	if err := validateMediaConfig(valid); err != nil {
		t.Fatal(err)
	}
	if err := validateMediaConfig(testConfig()); err != nil {
		t.Fatal("unconfigured media must be valid", err)
	}
	mutations := map[string]func(*Config){
		"key without dir":    func(c *Config) { c.MediaDir = "" },
		"dir without key":    func(c *Config) { c.RunningHubAPIKey = "" },
		"short key":          func(c *Config) { c.RunningHubAPIKey = "short" },
		"key with space":     func(c *Config) { c.RunningHubAPIKey = strings.Repeat("k", 20) + " x" },
		"foreign API origin": func(c *Config) { c.RunningHubBaseURL = "https://runninghub.evil.test" },
		"relative dir":       func(c *Config) { c.MediaDir = "media" },
		"unclean dir": func(c *Config) {
			c.MediaDir = dir + string(filepath.Separator) + ".." + string(filepath.Separator) + "media"
		},
		"tiny timeout":    func(c *Config) { c.MediaTimeout = time.Second },
		"oversized files": func(c *Config) { c.MediaMaxFileBytes = 4096 << 20 },
		"wildcard host":   func(c *Config) { c.MediaResultHosts = []string{"*"} },
		"bare tld host":   func(c *Config) { c.MediaResultHosts = []string{".ai"} },
		"loopback in prod": func(c *Config) {
			c.Env, c.PublicOrigin, c.RunningHubBaseURL = "production", "https://awwo.test", "http://127.0.0.1:9000"
		},
		// Go parses 127.0.0.1:1 as credentials here and sends the key to attacker.example.
		"loopback userinfo":  func(c *Config) { c.RunningHubBaseURL = "http://127.0.0.1:1@attacker.example" },
		"loopback with path": func(c *Config) { c.RunningHubBaseURL = "http://127.0.0.1:9000/x" },
		"proxy in production": func(c *Config) {
			c.Env, c.PublicOrigin, c.MediaDevProxy = "production", "https://awwo.test", "http://127.0.0.1:7890"
		},
		"proxy off loopback":  func(c *Config) { c.MediaDevProxy = "http://10.0.0.5:7890" },
		"negative free floor": func(c *Config) { c.MediaMinFreeBytes = -1 },
		"host with port":      func(c *Config) { c.MediaResultHosts = []string{"files.runninghub.ai:8443"} },
		"host with wildcard":  func(c *Config) { c.MediaResultHosts = []string{"*.myqcloud.com"} },
	}
	for name, mutate := range mutations {
		c := valid
		mutate(&c)
		if validateMediaConfig(c) == nil {
			t.Fatal("accepted", name)
		}
	}
	dev := valid
	dev.RunningHubBaseURL, dev.MediaDevProxy = "http://127.0.0.1:9000", "http://127.0.0.1:7890"
	dev.MediaResultHosts = []string{".runninghub.ai", "rh-images-1252422369.cos.ap-beijing.myqcloud.com"}
	if err := validateMediaConfig(dev); err != nil {
		t.Fatal("development may point at a local fake and proxy, and hosts may be exact", err)
	}
}

func TestSniffMediaAndStoredPaths(t *testing.T) {
	cases := map[string][3]string{
		"\x89PNG\r\n\x1a\n0000":               {"image/png", "png", "image"},
		"\xff\xd8\xff\xe0":                    {"image/jpeg", "jpg", "image"},
		"RIFF0000WEBPVP8 ":                    {"image/webp", "webp", "image"},
		"GIF89a":                              {"image/gif", "gif", "image"},
		"\x00\x00\x00\x18ftypisom":            {"video/mp4", "mp4", "video"},
		"\x00\x00\x00\x14ftypqt  ":            {"video/quicktime", "mov", "video"},
		"\x1a\x45\xdf\xa3":                    {"video/webm", "webm", "video"},
		"ID3\x04\x00\x00\x00\x00\x00\x00":     {"audio/mpeg", "mp3", "audio"},
		"\xff\xfb\x90\x64":                    {"audio/mpeg", "mp3", "audio"},
		"RIFF0000WAVEfmt ":                    {"audio/wav", "wav", "audio"},
		"\xff\xf1\x50\x80":                    {"", "", ""},
		"<svg xmlns='http://www.w3.org/2000/": {"", "", ""},
		"<html><script>alert(1)</script>":     {"", "", ""},
	}
	for head, want := range cases {
		ct, ext, kind := sniffMedia([]byte(head))
		if [3]string{ct, ext, kind} != want {
			t.Fatalf("%q sniffed as %s %s %s", head, ct, ext, kind)
		}
	}
	a := New(nil, testConfig())
	a.cfg.MediaDir = "/media"
	sum := strings.Repeat("a", 64)
	if _, ok := a.mediaFile("t1", "t1/r1/"+sum+".png"); !ok {
		t.Fatal("refused a stored path")
	}
	for _, ext := range []string{"mp3", "wav"} {
		if _, ok := a.mediaFile("t1", "t1/r1/"+sum+"."+ext); !ok {
			t.Fatal("refused a stored audio path", ext)
		}
	}
	for _, rel := range []string{"t2/r1/" + sum + ".png", "t1/../t2/" + sum + ".png", "t1/r1/" + sum + ".svg", "t1/r1/x.png", "t1/r1/sub/" + sum + ".png", "/t1/r1/" + sum + ".png"} {
		if _, ok := a.mediaFile("t1", rel); ok {
			t.Fatal("accepted", rel)
		}
	}
}

// redirectTransport sends every request to one test server, whatever host it names, so result
// URLs can use the real allowlisted host names.
type redirectTransport struct{ target *httptest.Server }

func (r redirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	target, _ := url.Parse(r.target.URL)
	clone.URL.Scheme, clone.URL.Host = target.Scheme, target.Host
	clone.Host = req.URL.Host
	return http.DefaultTransport.RoundTrip(clone)
}

func TestRunningHubClientCallsAndDownloads(t *testing.T) {
	var auth, path string
	var body map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, path = r.Header.Get("Authorization"), r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/openapi/v2/test/text-to-image":
			writeJSON(w, 200, map[string]any{"taskId": "task-1", "status": "QUEUED"})
		case "/openapi/v2/query":
			writeJSON(w, 200, map[string]any{"taskId": "task-1", "status": "SUCCESS", "results": []any{map[string]any{"url": "https://files.runninghub.ai/a.png", "outputType": "png"}}})
		case "/openapi/v2/unauthorized":
			w.WriteHeader(401)
		case "/openapi/v2/busy":
			w.WriteHeader(503)
		}
	}))
	defer api.Close()
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1}, 2048)...)
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/a.png":
			_, _ = w.Write(png)
		case "/huge.png":
			w.Header().Set("Content-Length", "999999999")
			w.WriteHeader(200)
		case "/redirect.png":
			http.Redirect(w, r, "https://evil.test/a.png", http.StatusFound)
		default:
			w.WriteHeader(404)
		}
	}))
	defer files.Close()
	h := &runningHub{base: api.URL, key: "secret-key-0123456789", api: api.Client(), hosts: []string{".runninghub.ai"}, maxFile: 1 << 20}
	h.files = &http.Client{Transport: redirectTransport{files}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if !h.allowedResultURL(req.URL) {
			return errors.New("result redirect refused")
		}
		return nil
	}}
	ctx := context.Background()
	task, err := h.submit(ctx, "/openapi/v2/test/text-to-image", map[string]any{"prompt": "a cat", "ratio": "1:1"})
	if err != nil || task.TaskID != "task-1" || auth != "Bearer secret-key-0123456789" || body["prompt"] != "a cat" {
		t.Fatal("submit", task, err, auth, body)
	}
	task, err = h.query(ctx, "task-1")
	if err != nil || path != "/openapi/v2/query" || body["taskId"] != "task-1" || task.Status != "SUCCESS" {
		t.Fatal("query", task, err, body)
	}
	if _, err := h.submit(ctx, "/openapi/v2/unauthorized", map[string]any{}); mediaFailureCode(err) != "media_provider_unauthorized" {
		t.Fatal("401", err)
	}
	if _, err := h.submit(ctx, "/openapi/v2/busy", map[string]any{}); mediaFailureCode(err) != "media_provider_unavailable" {
		t.Fatal("503", err)
	}
	var out bytes.Buffer
	if n, err := h.download(ctx, "https://files.runninghub.ai/a.png", &out); err != nil || n != int64(len(png)) || !bytes.Equal(out.Bytes(), png) {
		t.Fatal("download", n, err)
	}
	for raw, want := range map[string]string{
		"https://files.runninghub.ai/huge.png":     "media_result_too_large",
		"https://files.runninghub.ai/missing.png":  "media_result_unavailable",
		"https://files.runninghub.ai/redirect.png": "media_result_unavailable",
		"https://files.evil.test/a.png":            "media_result_refused",
		"http://files.runninghub.ai/a.png":         "media_result_refused",
	} {
		if _, err := h.download(ctx, raw, io.Discard); mediaFailureCode(err) != want {
			t.Fatal(raw, "got", err, "want", want)
		}
	}
	h.maxFile = 1024
	if _, err := h.download(ctx, "https://files.runninghub.ai/a.png", io.Discard); mediaFailureCode(err) != "media_result_too_large" {
		t.Fatal("a body over the limit was accepted", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := h.query(cancelled, "task-1"); !errors.Is(err, context.Canceled) {
		t.Fatal("a cancelled poll must report the cancellation", err)
	}
}

func TestOnlyStreamsAndInlineMediaOutliveTheRequestDeadline(t *testing.T) {
	a := New(nil, testConfig())
	var bounded bool
	handler := a.security(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, bounded = r.Context().Deadline()
		w.WriteHeader(204)
	}))
	for path, want := range map[string]bool{
		"/api/v1/tenants/t1/media":                  true,
		"/api/v1/tenants/t1/artifacts/a1":           true,
		"/api/v1/tenants/t1/artifacts/a1/media":     false,
		"/api/v1/tenants/t1/runs/r1/events":         false,
		"/api/v1/tenants/t1/canvases/c1/runs/media": true,
	} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
		if bounded != want {
			t.Fatal(path, "deadline", bounded, "want", want)
		}
	}
}

func TestMediaExposureNeedsAWorkspaceCap(t *testing.T) {
	c := testConfig()
	c.RunningHubAPIKey, c.MediaDir = strings.Repeat("k", 32), filepath.Join(t.TempDir(), "media")
	if err := validateMediaExposure(c); err != nil {
		t.Fatal("granting workspaces one by one needs no cap", err)
	}
	c.MediaUnrestrictedWorkspaces = true
	if validateMediaExposure(c) == nil {
		t.Fatal("media opened to every unrestricted workspace without an ownership cap")
	}
	c.MediaUnrestrictedWorkspaces = false
	models, err := newWorkspaceModels("qwen3.8-27b-p6,rh.seedream-v5-pro")
	if err != nil {
		t.Fatal(err)
	}
	c.NewWorkspaceModels = models
	if validateMediaExposure(c) == nil {
		t.Fatal("media opened to every new workspace without an ownership cap")
	}
	c.MaxOwnedWorkspaces = 1
	if err := validateMediaExposure(c); err != nil {
		t.Fatal("a capped deployment may open media widely", err)
	}
}

func TestMediaSpaceReservations(t *testing.T) {
	a := New(nil, testConfig())
	a.cfg.MediaDir = t.TempDir()
	free, known := diskFree(a.cfg.MediaDir)
	if !known {
		t.Skip("free space is not measurable on this platform")
	}
	a.cfg.MediaMinFreeBytes = int64(free) - 100<<20
	first, ok := a.reserveMediaSpace(60 << 20)
	if !ok {
		t.Fatal("a reservation within the margin was refused")
	}
	if _, ok := a.reserveMediaSpace(60 << 20); ok {
		t.Fatal("two downloads together passed the free-space floor")
	}
	if a.mediaStorageReady() != nil {
		t.Fatal("admission refused while space remains above the floor")
	}
	first()
	second, ok := a.reserveMediaSpace(60 << 20)
	if !ok {
		t.Fatal("released space was not returned")
	}
	second()
	a.cfg.MediaMinFreeBytes = int64(free) + 1<<30
	if err, ok := a.mediaStorageReady().(setupError); !ok || err.code != "media_storage_full" {
		t.Fatal("admission allowed below the floor")
	}
}

func TestRunningHubAPIClientIgnoresProxyVariables(t *testing.T) {
	if apiTransport(Config{Env: "production", MediaDevProxy: "http://127.0.0.1:7890"}).Proxy != nil {
		t.Fatal("the key-carrying client used a proxy in production")
	}
	t.Setenv("HTTPS_PROXY", "http://proxy.example:3128")
	if apiTransport(Config{Env: "development"}).Proxy != nil {
		t.Fatal("the key-carrying client read proxy variables")
	}
	proxy := apiTransport(Config{Env: "development", MediaDevProxy: "http://127.0.0.1:7890"}).Proxy
	remote, _ := proxy(httptest.NewRequest("POST", "https://www.runninghub.ai/openapi/v2/query", nil))
	local, _ := proxy(httptest.NewRequest("POST", "http://127.0.0.1:9000/openapi/v2/query", nil))
	if remote == nil || remote.Host != "127.0.0.1:7890" || local != nil {
		t.Fatal("development proxy routing", remote, local)
	}
}
