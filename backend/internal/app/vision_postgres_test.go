package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// A picture attached to a node's message reaches a model that takes images as an image of the request, and the
// attachment block says which pictures it is shown; a worker that makes no claim gets the description alone.
func TestPostgresAttachedPicturesReachAModelThatSeesThem(t *testing.T) {
	var claim atomic.Bool
	claim.Store(true)
	var mu sync.Mutex
	type observed struct {
		Prompt string        `json:"prompt"`
		Images []visionImage `json:"images"`
		Raw    map[string]json.RawMessage
	}
	calls := []observed{}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			health := map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{
				{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144, "input": []string{"text", "image"}},
			}}
			if claim.Load() {
				health["imageInput"] = true
			}
			writeJSON(w, 200, health)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var b observed
		raw := map[string]json.RawMessage{}
		var body bytes.Buffer
		_, _ = body.ReadFrom(r.Body)
		if e := json.Unmarshal(body.Bytes(), &b); e != nil {
			t.Error(e)
		}
		_ = json.Unmarshal(body.Bytes(), &raw)
		b.Raw = raw
		mu.Lock()
		calls = append(calls, b)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		completePi(w, "I see a small picture")
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	h.a.cfg.MediaDir = t.TempDir()
	h.a.cfg.UploadMaxBytes, h.a.cfg.UploadsPerDay, h.a.cfg.UploadWorkspaceBytes, h.a.cfg.MediaMinFreeBytes = 64<<10, 10, 1<<20, 0
	c, tid, _ := h.register(t, "vision@example.test")
	cid, _ := setupFixture(t, h, c, tid, 1)
	var picture bytes.Buffer
	_ = png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 8, 5)))
	hero := h.upload(t, c, tid, cid, "hero.png", picture.Bytes(), 201)
	notes := h.upload(t, c, tid, cid, "notes.md", []byte("# 首页"), 201)
	path := "/tenants/" + tid + "/canvases/" + cid
	initialized := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 1, "scope": []string{"a"}}, 200)
	session := setupNodeAt(initialized, 0)["issueId"]
	message := "这张图里是什么\n\n[附件] hero.png · awwo-file:" + hero["id"].(string) + "\n[附件] notes.md · awwo-file:" + notes["id"].(string)

	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"operationId": "vision-1", "sessionId": session, "prompt": message}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	mu.Lock()
	seen := calls[len(calls)-1]
	mu.Unlock()
	if len(seen.Images) != 1 || seen.Images[0].Name != "hero.png" || seen.Images[0].MimeType != "image/png" || seen.Images[0].Data != base64.StdEncoding.EncodeToString(picture.Bytes()) {
		t.Fatal("the picture did not reach the model", seen.Images)
	}
	if !strings.Contains(seen.Prompt, attachmentShownPolicy) || strings.Count(seen.Prompt, `"shown":true`) != 1 {
		t.Fatal("the block does not say which picture is shown", seen.Prompt)
	}
	var quoted []uploadAttachment
	if e := json.Unmarshal([]byte(seen.Prompt[strings.LastIndex(seen.Prompt, "\n")+1:]), &quoted); e != nil || len(quoted) != 2 || !quoted[0].Shown || quoted[1].Shown || quoted[0].Dimensions != "8x5" {
		t.Fatal("quoted files", e, quoted)
	}

	// The same message to a worker that does not claim images: the description alone, and nothing marked shown.
	claim.Store(false)
	follow := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"operationId": "vision-2", "sessionId": session, "prompt": message}, 202)
	h.awaitRun(t, c, tid, follow["id"].(string), "completed")
	mu.Lock()
	plain := calls[len(calls)-1]
	mu.Unlock()
	if _, sent := plain.Raw["images"]; sent || strings.Contains(plain.Prompt, `"shown":true`) || strings.Contains(plain.Prompt, attachmentShownPolicy) {
		t.Fatal("pictures went to a worker that takes none", plain.Prompt)
	}
}
