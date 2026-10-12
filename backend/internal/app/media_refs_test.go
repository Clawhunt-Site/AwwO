package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func testReference(data []byte, contentType string) mediaReference {
	sum := sha256.Sum256(data)
	return mediaReference{ArtifactID: "a0123456789abcdef", Name: "cat.png", ContentType: contentType, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), Path: "t/uploads/x.bin"}
}

func TestMediaReferenceCatalog(t *testing.T) {
	want := map[string]int{"xt.xtasy-3": 1, "xt.xtasy-3-pro": 1, "xt.seedream-5-pro": 1, "tripo.v3-1": 1, "tripo.p1": 1,
		"jm.image-cinema": 1, "jm.image-express": 1}
	for _, m := range builtinMediaCatalog.List() {
		if m.References != want[m.ID] {
			t.Errorf("%s takes %d references, want %d", m.ID, m.References, want[m.ID])
		}
		if m.References > 0 && m.Kind == mediaKindVideo {
			t.Errorf("%s: no video model takes a reference yet", m.ID)
		}
	}
	bad := *xtasyModels()[0]
	bad.ID, bad.References = "xt.omni-video", 1
	bad.Kind, bad.Endpoint, bad.Mode = mediaKindVideo, xtasyEndpoints[mediaKindVideo], "text-to-video"
	if validXtasyModel(&bad) == nil {
		t.Fatal("a video model may not claim references")
	}
	three := *tripoModels()[0]
	if err := validTripoModel(&three); err != nil {
		t.Fatal("the shipped 3D model is valid", err)
	}
	three.References = 2
	if validTripoModel(&three) == nil {
		t.Fatal("image-to-model takes one picture")
	}
}

func TestMediaReferenceRequests(t *testing.T) {
	image, _ := builtinMediaCatalog.model("xt.xtasy-3-pro")
	params, _ := image.resolveMediaParams(nil)
	body := xtasyRequest(image, "make it blue", params, "run1", []string{"file_1", "file_2"})
	refs := body["references"].([]any)
	parameters := body["parameters"].(map[string]any)
	if parameters["mode"] != "img2img" || len(refs) != 1 || refs[0].(map[string]any)["role"] != "reference_image" || refs[0].(map[string]any)["file_id"] != "file_1" {
		t.Fatal("an image model edits its one reference", body)
	}
	if plain := xtasyRequest(image, "a cat", params, "run1", nil); plain["parameters"].(map[string]any)["mode"] != "txt2img" || len(plain["references"].([]any)) != 0 {
		t.Fatal("without a reference the model generates from words", plain)
	}
	words, _ := builtinMediaCatalog.model("xt.gpt-image-2")
	wordParams, _ := words.resolveMediaParams(nil)
	if b := xtasyRequest(words, "a cat", wordParams, "run1", []string{"file_1"}); b["parameters"].(map[string]any)["mode"] != "txt2img" || len(b["references"].([]any)) != 0 {
		t.Fatal("a model that takes no reference never sends one", b)
	}
	three, _ := builtinMediaCatalog.model("tripo.v3-1")
	resolved, _ := three.resolveMediaParams(json.RawMessage(`{"negativePrompt":"blurry","textureQuality":"detailed"}`))
	tb := tripoImageRequest(three, "file_abc", resolved)
	if tb["input"] != "file_abc" || tb["model"] != three.Version || tb["texture_quality"] != "detailed" || tb["prompt"] != nil || tb["negative_prompt"] != nil {
		t.Fatal("image-to-model sends the picture and the choices, no words", tb)
	}
}

func TestMediaReferencePromptsAndPrices(t *testing.T) {
	ref := []mediaReference{testReference(testPNG, "image/png")}
	three, _ := builtinMediaCatalog.model("tripo.p1")
	image, _ := builtinMediaCatalog.model("xt.xtasy-3")
	if !mediaPromptAccepted(three, "", ref) || mediaPromptAccepted(three, "", nil) || mediaPromptAccepted(three, strings.Repeat("x", 1025), ref) {
		t.Fatal("a 3D model built from a picture needs no words, and words stay within the bound")
	}
	if mediaPromptAccepted(image, "", ref) || !mediaPromptAccepted(image, "make it blue", ref) {
		t.Fatal("an edited image still needs words")
	}
	for _, id := range []string{"tripo.v3-1", "tripo.p1"} {
		if mediaReferenceCredits(id, 1) != 30 || mediaReferenceCredits(id, 0) != 0 {
			t.Fatal(id, "image-to-3D costs Tripo 10 more credits, 30 here")
		}
	}
	if mediaReferenceCredits("xt.xtasy-3", 1) != 0 {
		t.Fatal("an edited image costs what generating it would")
	}
	if got := withReferenceLines("make it blue", ref); got != "make it blue\n\n[附件] cat.png · awwo-file:a0123456789abcdef" || stripAttachmentLines(got) != "make it blue" {
		t.Fatal("the stored prompt names its reference in a composer line", got)
	}
	if got := uploadReferences(withReferenceLines("", ref)); len(got) != 1 || got[0] != ref[0].ArtifactID {
		t.Fatal("the line resolves back to the reference", got)
	}
}

func TestWiredReferenceLines(t *testing.T) {
	record, _ := json.Marshal(map[string]any{"type": mediaOutputType, "version": 1, "kind": "image", "items": []mediaItem{
		{ArtifactID: "aimage000000001", Name: "image-1.png", ContentType: "image/png", Size: 10},
		{ArtifactID: "avideo000000001", Name: "video-1.mp4", ContentType: "video/mp4", Size: 10}}})
	outputs := map[string]string{"img": string(record), "txt": "a plain text delivery awwo-file:aother00000000"}
	lines := wiredReferenceLines([]graphEdge{{FromNode: "img"}, {FromNode: "txt"}}, outputs)
	if lines != "[附件] image-1.png · awwo-file:aimage000000001" {
		t.Fatal("only pictures an image node delivered become reference lines", lines)
	}
}

func TestTripoUploadsAReference(t *testing.T) {
	var got struct {
		path, auth, field, name, contentType string
		data                                 []byte
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path, got.auth = r.URL.Path, r.Header.Get("Authorization")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			w.WriteHeader(400)
			return
		}
		for field, files := range r.MultipartForm.File {
			f, _ := files[0].Open()
			got.data, _ = io.ReadAll(f)
			got.field, got.name, got.contentType = field, files[0].Filename, files[0].Header.Get("Content-Type")
		}
		writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"file_token": "file_tok123"}})
	}))
	defer api.Close()
	c := &tripoClient{base: api.URL, key: "tsk_secret-key-0123456789", api: api.Client(), maxFile: 1 << 20}
	token, err := c.uploadReference(context.Background(), testReference(testPNG, "image/png"), testPNG, "run1")
	if err != nil || token != "file_tok123" || got.path != "/files" || got.auth != "Bearer tsk_secret-key-0123456789" || got.field != "file" ||
		got.name != "reference.png" || got.contentType != "image/png" || string(got.data) != string(testPNG) {
		t.Fatal("the picture goes to Tripo's file store under a neutral name", token, err, got.path, got.field, got.name, got.contentType)
	}
	if _, err = c.uploadReference(context.Background(), testReference(testPNG, "image/webp"), testPNG, "run1"); mediaFailureCode(err) != "media_reference_unavailable" {
		t.Fatal("Tripo's upload takes JPEG and PNG only", err)
	}
}

func TestXtasyUploadsAReferenceAndWaitsForIt(t *testing.T) {
	var mu sync.Mutex
	var keys, paths []string
	reads := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/openapi/v1/files":
			keys = append(keys, r.Header.Get("Idempotency-Key"))
			if err := r.ParseMultipartForm(1 << 20); err != nil || r.MultipartForm.File["file"] == nil {
				w.WriteHeader(400)
				return
			}
			writeJSON(w, 201, map[string]any{"file_id": "file_abc", "status": "processing"})
		case r.Method == http.MethodGet && r.URL.Path == "/openapi/v1/files/file_abc":
			reads++
			if reads < 2 {
				writeJSON(w, 200, map[string]any{"file_id": "file_abc", "status": "ready", "preparation": map[string]any{"status": "processing"}})
				return
			}
			writeJSON(w, 200, map[string]any{"file_id": "file_abc", "status": "ready", "preparation": map[string]any{"status": "ready"}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer api.Close()
	c := testConfig()
	c.XtasyAPIKey, c.XtasyBaseURL, c.MediaMaxFileBytes = "xtk_test-key-0123456789", api.URL, 1<<20
	x := newXtasy(c)
	ref := testReference(testPNG, "image/png")
	id, err := x.uploadReference(context.Background(), ref, testPNG, "run1")
	mu.Lock()
	defer mu.Unlock()
	if err != nil || id != "file_abc" || len(keys) != 1 || keys[0] != "awwo-ref-run1-"+ref.SHA256[:16] || reads != 2 {
		t.Fatal("the picture is uploaded once under the run's key and used when prepared", id, err, keys, reads, paths)
	}
}

func TestUploadMediaReferencesRefusesChangedBytes(t *testing.T) {
	h := &App{cfg: testConfig()}
	h.cfg.MediaDir = t.TempDir()
	ref := testReference(testPNG, "image/png")
	if _, err := h.uploadMediaReferences(context.Background(), &fakeMediaProvider{}, "t", "run1", []mediaReference{ref}); mediaFailureCode(err) != "media_reference_unavailable" {
		t.Fatal("a provider without uploads, or a missing file, ends the run before anything is billed", err)
	}
}
