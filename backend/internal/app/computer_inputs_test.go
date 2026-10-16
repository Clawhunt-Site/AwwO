package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A managed-execution task gets the files its message names in its workspace (/inputs), frozen at admission, so the
// agent can run tools over them; a task naming none is sent exactly as before.
func TestPostgresComputerTaskCarriesTheFilesItsMessageNames(t *testing.T) {
	trusted := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) { t.Error("no model call expected") })
	defer trusted.Close()
	type sent struct {
		Prompt string            `json:"prompt"`
		Inputs []json.RawMessage `json:"inputs"`
		Raw    map[string]json.RawMessage
	}
	started := make(chan sent, 3)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"service": "awwo-openmaus-worker", "ready": true, "capabilities": map[string]bool{"workspace": true, "approvals": true}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		var input sent
		_ = json.Unmarshal(body["prompt"], &input.Prompt)
		_ = json.Unmarshal(body["inputs"], &input.Inputs)
		input.Raw = body
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- input
		<-r.Context().Done()
	}))
	defer worker.Close()
	h := newHarness(t, trusted.URL)
	h.a.cfg.RunTimeout = 30 * time.Minute
	h.a.cfg.OpenMausURL = worker.URL
	h.a.cfg.OpenMausToken = strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	h.a.cfg.MediaDir = t.TempDir()
	h.a.cfg.UploadMaxBytes, h.a.cfg.UploadsPerDay, h.a.cfg.UploadWorkspaceBytes, h.a.cfg.MediaMinFreeBytes = 64<<10, 20, 1<<20, 0
	owner, tid, _ := h.register(t, "computer-inputs@example.test")
	// The fake worker holds every task open, so the three tasks run side by side.
	if _, err := h.db.Exec(context.Background(), "UPDATE tenants SET max_concurrent_runs=5 WHERE id=$1", tid); err != nil {
		t.Fatal(err)
	}
	canvas, _, _ := h.fixture(t, owner, tid)
	app := []byte("import { start } from './engine.js';\nstart();\n")
	upload := h.upload(t, owner, tid, canvas, "app.js", app, 201)
	base := "/tenants/" + tid
	await := func() sent {
		select {
		case input := <-started:
			return input
		case <-time.After(5 * time.Second):
			t.Fatal("the worker did not start the task")
		}
		return sent{}
	}
	h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": "computer-with-a-file", "prompt": "Explain how this app starts: " + upload["reference"].(string), "runtime": "pi", "model": "test-model"}, 202)
	input := await()
	if len(input.Inputs) != 1 {
		t.Fatalf("inputs %s", input.Raw["inputs"])
	}
	var file workspaceFile
	if err := json.Unmarshal(input.Inputs[0], &file); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(app)
	decoded, _ := base64.StdEncoding.DecodeString(file.Content)
	if !strings.HasSuffix(file.Name, "-app.js") || file.Encoding != "base64" || string(decoded) != string(app) || file.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("file %+v", file)
	}
	if !strings.Contains(input.Prompt, file.Name) {
		t.Fatalf("the message does not say where the file is: %s", input.Prompt)
	}
	h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": "computer-without-files", "prompt": "Prepare a report", "runtime": "pi", "model": "test-model"}, 202)
	if plain := await(); plain.Raw["inputs"] != nil {
		t.Fatalf("a task naming no file was sent inputs: %s", plain.Raw["inputs"])
	}
	// A message may name up to ten files; the workspace takes the first eight (the rest stay quoted text), and the
	// task still runs.
	references := []string{}
	for i := 0; i < 9; i++ {
		file := h.upload(t, owner, tid, canvas, fmt.Sprintf("part-%d.js", i), []byte(fmt.Sprintf("export const part = %d;\n", i)), 201)
		references = append(references, file["reference"].(string))
	}
	h.request(t, owner, "POST", base+"/canvases/"+canvas+"/computer-runs", map[string]string{"operationId": "computer-with-nine-files", "prompt": "Read these: " + strings.Join(references, " "), "runtime": "pi", "model": "test-model"}, 202)
	if many := await(); len(many.Inputs) != 8 {
		t.Fatalf("nine named files gave the workspace %d", len(many.Inputs))
	}
}
