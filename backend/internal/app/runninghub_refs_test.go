package app

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The video made from reference pictures (2026-10-17, M-1a): RunningHub's multimodal route of the same family as
// rh.seedance-2, offering only what a video node can use. Since M-1c (2026-10-19) it also takes up to three voices
// (audioUrls) and its real-person switch (realPersonMode, off unless a node turns it on: without it RunningHub refuses
// a photoreal person, code 1505); its reference video slots and its last frame are still not offered and never sent.
func TestReferenceVideoModelIsInTheCatalogAndClosed(t *testing.T) {
	m, ok := builtinMediaCatalog.model("rh.seedance-2-multimodal")
	if !ok || m.Kind != mediaKindVideo || m.Mode != "text-to-video" || m.Provider != mediaProviderRunningHub || m.References != 9 || m.AudioReferences != 3 ||
		m.Endpoint != "/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video" || m.Prompt != (mediaPrompt{MinLength: 1, MaxLength: 20480}) ||
		m.Verified != "2026-10-19" || m.Label != [2]string{"视频 · 多图参考", "Video · From references"} || m.Vendor != mediaVendorShown ||
		m.Docs != "https://www.runninghub.ai/runninghub-api-doc-en/api-494859282.md" {
		t.Fatalf("reference video model %+v", m)
	}
	if runningHubReferenceField[m.ID] != "imageUrls" || runningHubAudioField[m.ID] != "audioUrls" {
		t.Fatal("its pictures go in imageUrls and its voices in audioUrls", runningHubReferenceField[m.ID], runningHubAudioField[m.ID])
	}
	params := map[string]mediaParam{}
	names := []string{}
	for _, p := range m.Params {
		params[p.Name] = p
		names = append(names, p.Name)
	}
	if strings.Join(names, ",") != "resolution,duration,ratio,generateAudio,seed,realPersonMode" {
		t.Fatal("parameters", names)
	}
	if p := params["resolution"]; p.Type != "enum" || strings.Join(p.Values, ",") != "480p,720p" || p.Default != "720p" {
		t.Fatalf("resolution %+v", p)
	}
	if p := params["duration"]; p.Type != "enum" || strings.Join(p.Values, ",") != "4,5,6,7,8,9,10,11,12,13,14,15" || p.Default != "5" {
		t.Fatalf("duration %+v", p)
	}
	if p := params["ratio"]; p.Type != "enum" || strings.Join(p.Values, ",") != "adaptive,16:9,4:3,1:1,3:4,9:16,21:9" || p.Default != "adaptive" {
		t.Fatalf("ratio %+v", p)
	}
	if p := params["generateAudio"]; p.Type != "boolean" || p.Default != true {
		t.Fatalf("generateAudio %+v", p)
	}
	if p := params["seed"]; p.Type != "integer" || *p.Min != -1 || *p.Max != 2147483647 || p.Default != float64(-1) {
		t.Fatalf("seed %+v", p)
	}
	if p := params["realPersonMode"]; p.Type != "boolean" || p.Default != false || p.Label != [2]string{"真人模式", "Real people"} {
		t.Fatalf("realPersonMode %+v", p)
	}
	if on, err := m.resolveMediaParams(json.RawMessage(`{"realPersonMode":true}`)); err != nil || on["realPersonMode"] != true {
		t.Fatal("a node turns real people on", on, err)
	}
	for _, raw := range []string{`{"resolution":"4k"}`, `{"duration":"-1"}`, `{"seed":-2}`, `{"seed":2147483648}`, `{"returnLastFrame":true}`,
		`{"realPersonMode":"yes"}`, `{"conversionSlots":["all"]}`, `{"videoUrls":[]}`, `{"imageUrls":["https://x.test/a.png"]}`, `{"audioUrls":[]}`} {
		if _, err := m.resolveMediaParams(json.RawMessage(raw)); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	// Three times the measured cost ($1.00 for five seconds at 720p), per five seconds; its pictures add nothing, and
	// 1080p, not measured yet, is not offered.
	for duration, want := range map[string]int{"": 300, "5": 300, "4": 300, "10": 600, "15": 900} {
		settings := map[string]any{"resolution": "720p"}
		if duration != "" {
			settings["duration"] = duration
		}
		if got := mediaCreditsFor(m.ID, mediaKindVideo, settings); got != want {
			t.Fatal("priced", settings, got, "want", want)
		}
	}
	if mediaReferenceCredits(m.ID, 9) != 0 {
		t.Fatal("the pictures cost nothing more")
	}
	if _, err := m.resolveMediaParams(json.RawMessage(`{"resolution":"1080p"}`)); err == nil {
		t.Fatal("1080p is offered before it was measured")
	}
}

// The pictures' URLs go in imageUrls, in order, up to the model's count, with the fixed fields; nothing else is added,
// and a model that names no field for pictures sends exactly the body it sent before.
func TestRunningHubRequestCarriesReferencePictures(t *testing.T) {
	m, _ := builtinMediaCatalog.model("rh.seedance-2-multimodal")
	values, err := m.resolveMediaParams(json.RawMessage(`{"duration":"8","ratio":"16:9"}`))
	if err != nil {
		t.Fatal(err)
	}
	refs := []string{"https://files.runninghub.ai/openapi/a.png", "https://files.runninghub.ai/openapi/b.png"}
	body := runningHubRequest(m, "@Image 1 boards the ship in @Image 2", values, nil, refs)
	want := map[string]any{"prompt": "@Image 1 boards the ship in @Image 2", "resolution": "720p", "duration": "8", "ratio": "16:9",
		"generateAudio": true, "seed": float64(-1), "realPersonMode": false}
	urls, _ := body["imageUrls"].([]string)
	if len(body) != len(want)+1 || len(urls) != 2 || urls[0] != refs[0] || urls[1] != refs[1] {
		t.Fatalf("body with pictures %v", body)
	}
	for k, v := range want {
		if body[k] != v {
			t.Fatalf("body %s = %v, want %v (%v)", k, body[k], v, body)
		}
	}
	refs[0] = "https://elsewhere.test/x.png"
	if urls[0] == refs[0] {
		t.Fatal("the body keeps its own copy of the URLs")
	}
	raw, _ := json.Marshal(body)
	if !bytes.Contains(raw, []byte(`"imageUrls":["https://files.runninghub.ai/openapi/a.png","https://files.runninghub.ai/openapi/b.png"]`)) {
		t.Fatal("imageUrls on the wire", string(raw))
	}
	// Without pictures the field is not sent at all.
	plain := runningHubRequest(m, "a ship at dawn", values, nil, nil)
	if _, sent := plain["imageUrls"]; sent || len(plain) != len(want) {
		t.Fatalf("body without pictures %v", plain)
	}
	// At most the model's count, the first ones, in order.
	many := []string{}
	for i := 0; i < 12; i++ {
		many = append(many, fakeReferenceURL(i+1))
	}
	if urls, _ := runningHubRequest(m, "a ship", values, nil, many)["imageUrls"].([]string); len(urls) != 9 || urls[0] != many[0] || urls[8] != many[8] {
		t.Fatal("capped at the model's count", urls)
	}
	// Nothing frozen replaces the pictures or the words.
	tampered := runningHubRequest(m, "a ship", map[string]any{"duration": "5", "imageUrls": []string{"https://evil.test/x.png"}, "prompt": "other"}, nil, refs[1:])
	if urls, _ := tampered["imageUrls"].([]string); len(urls) != 1 || urls[0] != refs[1] || tampered["prompt"] != "a ship" || len(tampered) != 3 {
		t.Fatalf("body from a tampered plan %v", tampered)
	}
	// A text-only model never sends pictures, whatever it is handed.
	for _, id := range []string{"rh.seedance-2", "rh.seedream-v5-pro", "rh.minimax-speech-2-8-hd"} {
		other, _ := builtinMediaCatalog.model(id)
		resolved, _ := other.resolveMediaParams(nil)
		with, without := runningHubRequest(other, "words", resolved, nil, refs), runningHubRequest(other, "words", resolved, nil, nil)
		a, _ := json.Marshal(with)
		b, _ := json.Marshal(without)
		if !bytes.Equal(a, b) || bytes.Contains(a, []byte("imageUrls")) {
			t.Fatal(id, "sends pictures", string(a))
		}
	}
}

// Voices (M-1c) go in audioUrls, each kind in its own order and up to its own count: the refs say which URL is a voice
// (a URL with no ref is a picture, as before); a model that names no field for voices never sends one.
func TestRunningHubRequestCarriesVoices(t *testing.T) {
	m, _ := builtinMediaCatalog.model("rh.seedance-2-multimodal")
	values, err := m.resolveMediaParams(json.RawMessage(`{"duration":"6","realPersonMode":true}`))
	if err != nil {
		t.Fatal(err)
	}
	picture := mediaReference{ContentType: "image/png"}
	voice := mediaReference{ContentType: "audio/mpeg"}
	refs := []mediaReference{picture, voice, picture, voice, voice, voice}
	urls := []string{fakeReferenceURL(1), fakeReferenceURL(2), fakeReferenceURL(3), fakeReferenceURL(4), fakeReferenceURL(5), fakeReferenceURL(6)}
	body := runningHubRequest(m, "@Image 1 says @Audio 1", values, refs, urls)
	images, _ := body["imageUrls"].([]string)
	voices, _ := body["audioUrls"].([]string)
	if len(images) != 2 || images[0] != urls[0] || images[1] != urls[2] || len(voices) != 3 || voices[0] != urls[1] || voices[1] != urls[3] || voices[2] != urls[4] {
		t.Fatalf("pictures %v and voices %v", images, voices)
	}
	if body["realPersonMode"] != true || body["prompt"] != "@Image 1 says @Audio 1" {
		t.Fatalf("body %v", body)
	}
	raw, _ := json.Marshal(body)
	if !bytes.Contains(raw, []byte(`"audioUrls":["`+urls[1]+`","`+urls[3]+`","`+urls[4]+`"]`)) {
		t.Fatal("audioUrls on the wire", string(raw))
	}
	// Pictures alone send no audioUrls at all.
	if _, sent := runningHubRequest(m, "a ship", values, []mediaReference{picture}, urls[:1])["audioUrls"]; sent {
		t.Fatal("audioUrls without a voice")
	}
	// A model without a voice field sends none, whatever it is handed.
	other, _ := builtinMediaCatalog.model("rh.seedance-2")
	resolved, _ := other.resolveMediaParams(nil)
	if b, _ := json.Marshal(runningHubRequest(other, "words", resolved, refs, urls)); bytes.Contains(b, []byte("audioUrls")) || bytes.Contains(b, []byte("imageUrls")) {
		t.Fatal("a text-only model sends references", string(b))
	}
}

// The catalog takes pictures on a RunningHub model only where its request names their field, takes some on a model
// that has such a field, and refuses any other field (a parameter's, a fixed one or the prompt's) on it.
func TestParseMediaCatalogChecksReferenceFields(t *testing.T) {
	const id = "rh.seedance-2-multimodal"
	refs := func(model string, n int, params ...any) func(map[string]any) {
		return func(m map[string]any) {
			m["id"], m["kind"], m["mode"], m["endpoint"], m["references"] = model, "video", "text-to-video", "/openapi/v2/test/refs", n
			if model == id {
				m["audioReferences"] = 3 // the reference video takes voices too (M-1c)
			}
			if params != nil {
				m["params"] = params
			}
		}
	}
	enum := func(name string) map[string]any {
		return map[string]any{"name": name, "type": "enum", "values": []any{"a", "b"}, "default": "a", "label": []any{"甲", "A"}}
	}
	if _, err := parseMediaCatalog(mediaCatalogFixture(refs(id, 9))); err != nil {
		t.Fatal("the reference video's shape", err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"references without a field":     refs("rh.test-video", 2),
		"one reference without a field":  refs("rh.seedance-2", 1),
		"a field and no references":      refs(id, 0),
		"more references than it takes":  refs(id, maxRunningHubReferences+1),
		"negative references":            refs(id, -1),
		"a parameter named as the field": refs(id, 9, enum("imageUrls")),
		"voices on a model without the field": func(m map[string]any) {
			refs("rh.test-video", 0)(m)
			m["audioReferences"] = 1
		},
		"more voices than it takes": func(m map[string]any) {
			refs(id, 9)(m)
			m["audioReferences"] = maxRunningHubAudioReferences + 1
		},
		"a voice field and no voices": func(m map[string]any) {
			refs(id, 9)(m)
			m["audioReferences"] = 0
		},
		"a parameter named as the voices' field": refs(id, 9, enum("audioUrls")),
	} {
		if _, err := parseMediaCatalog(mediaCatalogFixture(mutate)); err == nil {
			t.Error("accepted catalog with", name)
		}
	}
	// A wire name, a fixed field or the prompt's field on the pictures' field would send it twice. The tables are the
	// package's own, set here for one parse each and put back.
	collides := func(set func(), unset func()) bool {
		set()
		defer unset()
		_, err := parseMediaCatalog(mediaCatalogFixture(refs(id, 9, enum("ratio"))))
		return err != nil
	}
	if _, err := parseMediaCatalog(mediaCatalogFixture(refs(id, 9, enum("ratio")))); err != nil {
		t.Fatal("a plain parameter beside the pictures", err)
	}
	if !collides(func() { runningHubWireParams[id] = map[string]string{"ratio": "imageUrls"} }, func() { delete(runningHubWireParams, id) }) {
		t.Error("accepted a parameter sent as the pictures' field")
	}
	if !collides(func() { runningHubFixed[id] = map[string]any{"imageUrls": []string{}} }, func() { delete(runningHubFixed, id) }) {
		t.Error("accepted a fixed field on the pictures' field")
	}
	if !collides(func() { runningHubPromptField[id] = "imageUrls" }, func() { delete(runningHubPromptField, id) }) {
		t.Error("accepted the words on the pictures' field")
	}
	if !collides(func() { runningHubFixed[id] = map[string]any{"audioUrls": []string{}} }, func() { delete(runningHubFixed, id) }) {
		t.Error("accepted a fixed field on the voices' field")
	}
	if _, err := parseMediaCatalog(mediaCatalogFixture(refs(id, 9, enum("ratio")))); err != nil {
		t.Fatal("the tables were not put back", err)
	}
}

// uploadReference against the fake's upload route: the bearer key, one picture in field "file" under a neutral name
// and its own type, and the answer's download_url, read strictly; every failure is a closed code, the transient ones
// marked so for another try.
func TestRunningHubUploadsAReference(t *testing.T) {
	rh := newFakeRunningHub(t)
	c := testConfig()
	c.RunningHubAPIKey, c.RunningHubBaseURL, c.MediaMaxFileBytes = fakeRunningHubKey, rh.api.URL, 1<<20
	hub := newRunningHub(c)
	var _ referenceUploader = hub

	got, err := hub.uploadReference(context.Background(), testReference(testPNG, "image/png"), testPNG, "run1")
	ups := rh.uploaded()
	if err != nil || got != fakeReferenceURL(1) || len(ups) != 1 || ups[0].auth != "Bearer "+fakeRunningHubKey || ups[0].name != "reference.png" ||
		ups[0].contentType != "image/png" || !bytes.Equal(ups[0].data, testPNG) {
		t.Fatal("the picture is uploaded and named by its URL", got, err, len(ups))
	}
	if submits, _ := rh.counts(); submits != 0 {
		t.Fatal("an upload is not a task", submits)
	}
	for _, kind := range []struct{ contentType, name string }{{"image/jpeg", "reference.jpg"}, {"image/webp", "reference.webp"},
		{"audio/mpeg", "reference.mp3"}, {"audio/wav", "reference.wav"}} {
		before := len(rh.uploaded())
		if _, err := hub.uploadReference(context.Background(), testReference(testPNG, kind.contentType), testPNG, "run1"); err != nil {
			t.Fatal(kind.contentType, err)
		}
		if up := rh.uploaded()[before]; up.contentType != kind.contentType || up.name != kind.name {
			t.Fatal("a picture goes with its own type under a neutral name", up.contentType, up.name)
		}
	}
	// Exactly 10 MB is taken; past it, another type, or nothing at all is refused before anything is sent.
	limit := make([]byte, rhMaxReferenceBytes)
	copy(limit, testPNG)
	if _, err := hub.uploadReference(context.Background(), testReference(limit, "image/png"), limit, "run1"); err != nil {
		t.Fatal("a 10 MB picture is uploaded", err)
	}
	sent := len(rh.uploaded())
	big := make([]byte, rhMaxReferenceBytes+1)
	copy(big, testPNG)
	gif := []byte("GIF89a\x01\x00\x01\x00")
	for name, ref := range map[string]struct {
		ref  mediaReference
		data []byte
	}{
		"over 10 MB": {testReference(big, "image/png"), big},
		"a GIF":      {testReference(gif, "image/gif"), gif},
		"empty":      {testReference(nil, "image/png"), nil},
	} {
		if _, err := hub.uploadReference(context.Background(), ref.ref, ref.data, "run1"); mediaFailureCode(err) != "media_reference_unavailable" {
			t.Fatal(name, "refused", err)
		}
	}
	if len(rh.uploaded()) != sent {
		t.Fatal("a refused picture was sent")
	}

	answer := func(code any, data any) map[string]any {
		return map[string]any{"code": code, "msg": "APIKEY_FILE_SIZE_EXCEEDED for user@example.test", "errorMessages": []any{"secret detail"}, "data": data}
	}
	ok := map[string]any{"type": "image", "download_url": fakeReferenceURL(1)}
	for name, tc := range map[string]struct {
		status    int
		reply     any
		code      string
		transient bool
	}{
		"too large":         {200, answer(809, nil), "media_reference_unavailable", false},
		"bad key":           {200, answer(806, nil), "media_provider_unauthorized", false},
		"no balance":        {200, answer(812, nil), "media_provider_balance", false},
		"busy":              {200, answer(421, nil), "media_provider_busy", true},
		"a task code":       {200, answer(813, ok), "media_provider_unavailable", false},
		"an unknown code":   {200, answer(999999, ok), "media_failed", false},
		"no code":           {200, map[string]any{"msg": "success", "data": ok}, "media_provider_unavailable", false},
		"a text code":       {200, answer("ok", ok), "media_provider_unavailable", false},
		"no data":           {200, answer(0, nil), "media_provider_unavailable", false},
		"no URL":            {200, answer(0, map[string]any{"type": "image"}), "media_provider_unavailable", false},
		"plain http":        {200, rhUploadAnswer("http://files.runninghub.ai/openapi/a.png"), "media_provider_unavailable", false},
		"credentials":       {200, rhUploadAnswer("https://user:pass@files.runninghub.ai/openapi/a.png"), "media_provider_unavailable", false},
		"no host":           {200, rhUploadAnswer("https:///openapi/a.png"), "media_provider_unavailable", false},
		"relative":          {200, rhUploadAnswer("/openapi/a.png"), "media_provider_unavailable", false},
		"a space":           {200, rhUploadAnswer("https://files.runninghub.ai/openapi/a b.png"), "media_provider_unavailable", false},
		"a backslash":       {200, rhUploadAnswer(`https://files.runninghub.ai\@evil.test/a.png`), "media_provider_unavailable", false},
		"too long":          {200, rhUploadAnswer("https://files.runninghub.ai/" + strings.Repeat("a", rhMaxReferenceURL)), "media_provider_unavailable", false},
		"not an object":     {200, "not json", "media_provider_unavailable", true},
		"unauthorized":      {401, nil, "media_provider_unauthorized", false},
		"forbidden":         {403, nil, "media_provider_unauthorized", false},
		"rate limited":      {429, nil, "media_provider_busy", true},
		"server error":      {502, nil, "media_provider_unavailable", true},
		"refused file":      {413, nil, "media_reference_unavailable", false},
		"refused, answered": {400, answer(1007, nil), "media_reference_unavailable", false},
	} {
		rh.setUpload(func(int) (int, any) { return tc.status, tc.reply })
		got, err := hub.uploadReference(context.Background(), testReference(testPNG, "image/png"), testPNG, "run1")
		e, known := asRHError(err)
		if got != "" || !known || e.Code != tc.code || e.Transient != tc.transient || strings.Contains(err.Error(), "APIKEY") || strings.Contains(err.Error(), "secret") {
			t.Errorf("%s: got %q, %v (transient %v), want %s (transient %v)", name, got, err, known && e.Transient, tc.code, tc.transient)
		}
	}
	// The longest URL taken is 2048 bytes.
	longest := "https://files.runninghub.ai/" + strings.Repeat("a", rhMaxReferenceURL-len("https://files.runninghub.ai/"))
	rh.setUpload(func(int) (int, any) { return 200, rhUploadAnswer(longest) })
	if got, err := hub.uploadReference(context.Background(), testReference(testPNG, "image/png"), testPNG, "run1"); err != nil || got != longest {
		t.Fatal("a 2048-byte URL is taken", len(got), err)
	}
	// A key the upload route does not take is the operator's problem, never retried.
	c.RunningHubAPIKey = "rh-wrong-key-0123456789"
	if _, err := newRunningHub(c).uploadReference(context.Background(), testReference(testPNG, "image/png"), testPNG, "run1"); mediaFailureCode(err) != "media_provider_unauthorized" {
		t.Fatal("a wrong key", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	before := len(rh.uploaded())
	if _, err := hub.uploadReference(cancelled, testReference(testPNG, "image/png"), testPNG, "run1"); err == nil || len(rh.uploaded()) != before {
		t.Fatal("a cancelled upload is not sent", err)
	}
}

// A video node on the reference model (Postgres): both pictures its message names are uploaded, in order, before its
// task is submitted; the submission carries their URLs in imageUrls and the words alone as its prompt; the run stores
// the video. A failed upload fails the run with a closed code before any submission, and the generation was never sent.
func TestPostgresMediaRunUploadsReferencePicturesBeforeItsTask(t *testing.T) {
	h, rh := newMediaHarness(t)
	h.a.cfg.UploadMaxBytes, h.a.cfg.UploadsPerDay, h.a.cfg.UploadWorkspaceBytes, h.a.cfg.MediaMinFreeBytes = 64<<10, 20, 1<<20, 0
	c, tid, _ := h.register(t, "media-rh-references@example.test")
	cid, canvas := mediaCanvas(t, h, c, tid, mediaNode("shot", mediaKindVideo, "rh.seedance-2-multimodal", map[string]any{"duration": "6"}))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	ship := append(append([]byte{}, testPNG...), 1, 2, 3)
	hero := h.upload(t, c, tid, cid, "hero.png", testPNG, 201)
	vessel := h.upload(t, c, tid, cid, "ship.png", ship, 201)
	rh.set(nil, func(task string, n int) (int, any) {
		return 200, map[string]any{"taskId": task, "status": "SUCCESS", "results": []any{map[string]any{"url": "https://files.runninghub.ai/out.mp4", "outputType": "mp4"}}}
	})
	words := "@Image 1 walks up the gangway of @Image 2 at dawn"
	lines := "[附件] hero.png · " + hero["reference"].(string) + "\n[附件] ship.png · " + vessel["reference"].(string)
	run := h.mediaRun(t, c, tid, sid, words+"\n\n"+lines, 202)
	done := h.awaitRun(t, c, tid, run["id"].(string), "completed")

	ups := rh.uploaded()
	if len(ups) != 2 || !bytes.Equal(ups[0].data, testPNG) || !bytes.Equal(ups[1].data, ship) || ups[0].contentType != "image/png" || ups[1].name != "reference.png" {
		t.Fatal("both pictures are uploaded, in the order the message names them", len(ups))
	}
	if submits, _ := rh.counts(); submits != 1 {
		t.Fatal("submissions", submits)
	}
	sent := rh.submission(0)
	urls, _ := sent.body["imageUrls"].([]any)
	if sent.uploads != 2 || sent.path != "/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video" || sent.auth != "Bearer "+fakeRunningHubKey ||
		len(urls) != 2 || urls[0] != fakeReferenceURL(1) || urls[1] != fakeReferenceURL(2) {
		t.Fatalf("the submission follows both uploads and names them in order %+v", sent)
	}
	want := map[string]any{"prompt": words, "resolution": "720p", "duration": "6", "ratio": "adaptive", "generateAudio": true, "seed": float64(-1),
		"realPersonMode": false}
	if len(sent.body) != len(want)+1 {
		t.Fatalf("submission %+v", sent.body)
	}
	for k, v := range want {
		if sent.body[k] != v {
			t.Fatalf("submission %s = %v, want %v (%+v)", k, sent.body[k], v, sent.body)
		}
	}
	var out mediaOutput
	if e := json.Unmarshal([]byte(done["output"].(string)), &out); e != nil || out.Kind != mediaKindVideo || out.Model != "rh.seedance-2-multimodal" || len(out.Items) != 1 {
		t.Fatal("output", done["output"], e)
	}
	if item := out.Items[0]; item.ContentType != "video/mp4" || item.Name != "video-1.mp4" || item.Size != int64(len(testMP4)) {
		t.Fatal("item", item)
	}
	// The stored prompt names the pictures the video started from; the URLs RunningHub gave them are kept nowhere.
	var stored string
	if e := h.db.QueryRow(t.Context(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, run["id"]).Scan(&stored); e != nil ||
		stored != words+"\n\n"+lines || strings.Contains(stored, "openapi/ref-") {
		t.Fatal("stored prompt", stored, e)
	}

	// An upload RunningHub refuses fails the run with a closed code; nothing is submitted, so nothing is billed.
	rh.setUpload(func(int) (int, any) {
		return 200, map[string]any{"code": 809, "msg": "APIKEY_FILE_SIZE_EXCEEDED", "errorMessages": []any{"secret detail"}, "data": nil}
	})
	failed := h.mediaRun(t, c, tid, sid, words+"\n\n"+lines, 202)
	if _, code := awaitRunRow(t, h, tid, failed["id"].(string), "failed"); code != "media_reference_unavailable" {
		t.Fatal("a refused upload", code)
	}
	if submits, _ := rh.counts(); submits != 1 {
		t.Fatal("a run whose upload failed was submitted", submits)
	}
	if ups := rh.uploaded(); len(ups) != 3 {
		t.Fatal("a final refusal is not tried again, and the next picture is not sent", len(ups))
	}
	var unsent bool
	if e := h.db.QueryRow(t.Context(), "SELECT submitted_at IS NULL FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, failed["id"]).Scan(&unsent); e != nil || !unsent {
		t.Fatal("the failed generation was never sent", unsent, e)
	}
}
