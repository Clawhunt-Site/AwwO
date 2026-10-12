package app

import (
	"crypto/sha256"
	"encoding/binary"
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
)

// A picture attached to a 3D node's message, or one the canvas generated, is uploaded to Tripo and the model is
// built from it (image-to-model, no words); words alone still use text-to-model; a picture from another canvas or
// of another type is never sent.
func TestPostgresMediaReferencesGoToTheProvider(t *testing.T) {
	h, _ := newMediaHarness(t)
	glb := append([]byte("glTF"), make([]byte, 2048)...)
	binary.LittleEndian.PutUint32(glb[4:8], 2)
	var mu sync.Mutex
	uploads := [][]byte{}
	bodies := map[string][]map[string]any{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/files":
			if r.ParseMultipartForm(1<<20) != nil || r.MultipartForm.File["file"] == nil {
				w.WriteHeader(400)
				return
			}
			f, _ := r.MultipartForm.File["file"][0].Open()
			data, _ := io.ReadAll(f)
			uploads = append(uploads, data)
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"file_token": fmt.Sprintf("file_%d", len(uploads))}})
		case r.Method == http.MethodPost:
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			bodies[r.URL.Path] = append(bodies[r.URL.Path], b)
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": fmt.Sprintf("task_%d", len(bodies[r.URL.Path]))}})
		default:
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": strings.TrimPrefix(r.URL.Path, "/tasks/"), "status": "success",
				"output": map[string]any{"model_url": "https://tripo-data.cdn.tripo3d.ai/m.glb", "rendered_image_url": "https://tripo-data.cdn.tripo3d.ai/p.png"}}})
		}
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
	h.a.cfg.UploadMaxBytes, h.a.cfg.UploadsPerDay, h.a.cfg.UploadWorkspaceBytes, h.a.cfg.MediaMinFreeBytes = 64<<10, 20, 1<<20, 0
	hub := newTripo(h.a.cfg)
	hub.files.Transport = redirectTransport{files}
	h.a.tripo = hub

	c, tid, _ := h.register(t, "media-refs@example.test")
	cid, canvas := mediaCanvas(t, h, c, tid, mediaNode("hero", mediaKindModel3D, "tripo.p1", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	stored := func(id string) (string, *mediaPlan) {
		t.Helper()
		var prompt string
		var raw json.RawMessage
		if e := h.db.QueryRow(t.Context(), "SELECT prompt,execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt, &raw); e != nil {
			t.Fatal(e)
		}
		var snap executionSnapshot
		if e := json.Unmarshal(raw, &snap); e != nil || snap.Media == nil {
			t.Fatal("snapshot", string(raw), e)
		}
		return prompt, snap.Media
	}

	// A picture alone: uploaded, then the model is built from it; the stored prompt names it, nothing else.
	picture := h.upload(t, c, tid, cid, "cat.png", testPNG, 201)
	note := h.upload(t, c, tid, cid, "notes.txt", []byte("not a picture"), 201)
	line := "[附件] cat.png · " + picture["reference"].(string)
	run := h.mediaRun(t, c, tid, sid, "[附件] notes.txt · "+note["reference"].(string)+"\n"+line, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	prompt, plan := stored(run["id"].(string))
	mu.Lock()
	image := bodies[tripoImageEndpoint]
	if len(uploads) != 1 || string(uploads[0]) != string(testPNG) || len(image) != 1 || image[0]["input"] != "file_1" || image[0]["model"] != "P1-20260311" ||
		image[0]["prompt"] != nil || len(bodies["/generation/text-to-model"]) != 0 {
		mu.Unlock()
		t.Fatal("the attached picture is uploaded and the model built from it", len(uploads), image, bodies)
	}
	mu.Unlock()
	if prompt != line || len(plan.References) != 1 || plan.References[0].ArtifactID != strings.TrimPrefix(picture["reference"].(string), artifactRefPrefix) {
		t.Fatal("the run keeps exactly the picture it started from", prompt, plan.References)
	}

	// Words alone still build from text.
	text := h.mediaRun(t, c, tid, sid, "a low-poly robot", 202)
	h.awaitRun(t, c, tid, text["id"].(string), "completed")
	mu.Lock()
	if words := bodies["/generation/text-to-model"]; len(words) != 1 || words[0]["prompt"] != "a low-poly robot" || len(uploads) != 1 {
		mu.Unlock()
		t.Fatal("words alone use text-to-model and upload nothing", words, len(uploads))
	}
	mu.Unlock()

	// A picture this canvas generated (a media-N artifact) can be the reference too.
	sum := sha256.Sum256(testPNG)
	digest := hex.EncodeToString(sum[:])
	rel := tid + "/rgenerated/" + digest + ".png"
	if e := os.MkdirAll(filepath.Join(h.a.cfg.MediaDir, tid, "rgenerated"), 0o750); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(h.a.cfg.MediaDir, filepath.FromSlash(rel)), testPNG, 0o640); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(t.Context(), `INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,storage_path,content_type)
		VALUES('agenerated0001',$1,$2,'rgenerated','img','media-0','image-1.png',$3,$4,''::bytea,$5,'image/png')`, tid, cid, len(testPNG), digest, rel); e != nil {
		t.Fatal(e)
	}
	made := h.mediaRun(t, c, tid, sid, "[附件] image-1.png · awwo-file:agenerated0001", 202)
	h.awaitRun(t, c, tid, made["id"].(string), "completed")
	mu.Lock()
	if len(uploads) != 2 || len(bodies[tripoImageEndpoint]) != 2 || bodies[tripoImageEndpoint][1]["input"] != "file_2" {
		mu.Unlock()
		t.Fatal("a generated picture of this canvas is a reference", len(uploads), bodies[tripoImageEndpoint])
	}
	mu.Unlock()

	// Another canvas's picture is not this canvas's to use: the message has no picture and no words left.
	otherID, _ := mediaCanvas(t, h, c, tid, mediaNode("other", mediaKindModel3D, "tripo.p1", nil))
	foreign := h.upload(t, c, tid, otherID, "dog.png", testPNG, 201)
	if got := h.mediaRun(t, c, tid, sid, "[附件] dog.png · "+foreign["reference"].(string), 400); errorCode(got) != "media_prompt_invalid" {
		t.Fatal("another canvas's picture is never sent", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(uploads) != 2 {
		t.Fatal("nothing more was uploaded", len(uploads))
	}
}
