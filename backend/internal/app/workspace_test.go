package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkspaceCallbackAndCapabilityFailClosed(t *testing.T) {
	for _, raw := range []string{"https://example.com/api/internal/workspace-calls", "http://localhost:8087/api/internal/workspace-calls", "http://127.0.0.1:8087/other", "http://127.0.0.1:8087/api/internal/workspace-calls?q=1", "http://user@127.0.0.1:8087/api/internal/workspace-calls", "http://192.168.1.1:8087/api/internal/workspace-calls", "http://127.1.2.3:8087/api/internal/workspace-calls", "http://127.0.0.1:0/api/internal/workspace-calls", "http://127.0.0.1:65536/api/internal/workspace-calls"} {
		if validWorkspaceCallbackURL(raw) {
			t.Fatalf("accepted callback %s", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:8087/api/internal/workspace-calls", "http://[::1]:8087/api/internal/workspace-calls"} {
		if !validWorkspaceCallbackURL(raw) {
			t.Fatal("rejected loopback callback")
		}
	}
	good := &workspaceCapability{Version: 1, Available: true, MaxModelCalls: 16}
	if !validWorkspaceCapability(runtimeOpenAIAgents, good) || validWorkspaceCapability(runtimePI, good) || validWorkspaceCapability(runtimeOpenAIAgents, &workspaceCapability{Version: 1, Available: true, MaxModelCalls: 17}) || validWorkspaceCapability(runtimeOpenAIAgents, &workspaceCapability{Version: 1, Available: true, MaxModelCalls: 1}) {
		t.Fatal("workspace capability boundary")
	}
	a := New(nil, testConfig())
	w := httptest.NewRecorder()
	a.workspaceCallback(w, httptest.NewRequest("POST", "/api/internal/workspace-calls", strings.NewReader(`{"operation":"admit","index":1}`)))
	if w.Code != 401 {
		t.Fatal("callback accepted without lease")
	}
	snap := executionSnapshot{Workspace: &workspacePlan{Version: 1, MaxModelCalls: 2}}
	l, token, closeLease := a.registerWorkspaceLease(context.Background(), "tenant", "run", "session", snap)
	if l.sealSuccess() {
		t.Fatal("zero-call run completed")
	}

	rejected, rejectedToken, revoke := a.registerWorkspaceLease(context.Background(), "tenant", "other-run", "session", snap)
	bad := httptest.NewRequest("POST", "/api/internal/workspace-calls", strings.NewReader(`{"operation":"admit","index":3}`))
	bad.Header.Set("Authorization", "Bearer "+rejectedToken)
	bad.Header.Set("Content-Type", "application/json")
	denied := httptest.NewRecorder()
	a.workspaceCallback(denied, bad)
	rejected.calls = []*workspaceCall{{status: "completed"}}
	if denied.Code != 429 || rejected.sealSuccess() {
		t.Fatal("exceeded budget did not fence completion")
	}
	revoke()
	l.calls = []*workspaceCall{{status: "completed"}}
	if !l.sealSuccess() || l.sealSuccess() {
		t.Fatal("completion not fenced exactly once")
	}
	closeLease()
	r := httptest.NewRequest("POST", "/api/internal/workspace-calls", strings.NewReader(`{"operation":"admit","index":1}`))
	r.Header.Set("Authorization", "Bearer "+token)
	w = httptest.NewRecorder()
	a.workspaceCallback(w, r)
	if w.Code != 401 {
		t.Fatal("closed token accepted")
	}
}

func TestWorkspaceSnapshotZIPRejectsCorruptionAndUnsafeEntries(t *testing.T) {
	valid, _ := workspaceFileBytes(workspaceFixtureSnapshot(t))
	if !validWorkspaceZIP(valid) {
		t.Fatal("valid snapshot rejected")
	}
	for _, data := range [][]byte{[]byte("PK\x03\x04"), valid[:len(valid)-4]} {
		if validWorkspaceZIP(data) {
			t.Fatal("truncated snapshot accepted")
		}
	}
	makeZIP := func(names ...string) []byte {
		var b bytes.Buffer
		z := zip.NewWriter(&b)
		for _, name := range names {
			f, e := z.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
			if e != nil {
				t.Fatal(e)
			}
			if _, e = io.WriteString(f, "crc fixture"); e != nil {
				t.Fatal(e)
			}
		}
		if e := z.Close(); e != nil {
			t.Fatal(e)
		}
		return b.Bytes()
	}
	for _, names := range [][]string{{"../outside"}, {"node_modules/package.json"}, {"duplicate", "duplicate"}, {"a", "a/child"}} {
		if validWorkspaceZIP(makeZIP(names...)) {
			t.Fatal("unsafe snapshot entries accepted", names)
		}
	}
	crc := makeZIP("normal.txt")
	crc[bytes.Index(crc, []byte("crc fixture"))] ^= 1
	if validWorkspaceZIP(crc) {
		t.Fatal("wrong CRC accepted")
	}
}
func TestWorkspaceBinaryArtifactsAndHashLimits(t *testing.T) {
	binary := []byte{0, 255, 254, 1, 2, 3}
	f := encodedWorkspaceFile("scene.glb", binary)
	if b, e := workspaceFileBytes(f); e != nil || !bytes.Equal(b, binary) {
		t.Fatal("binary changed", e)
	}
	f.SHA256 = strings.Repeat("0", 64)
	if _, e := workspaceFileBytes(f); e == nil {
		t.Fatal("wrong hash accepted")
	}
	raw, _ := json.Marshal(map[string]any{"summary": "built", "artifact": map[string]any{"name": "scene.glb", "content": base64.StdEncoding.EncodeToString(binary), "encoding": "base64"}})
	_, files, e := graphOutputFiles(fileNode(true), string(raw))
	if e != nil || len(files) != 1 || !bytes.Equal([]byte(files[0].Content), binary) {
		t.Fatal("binary file output lost bytes", e)
	}
	for _, v := range []map[string]any{{"name": "x", "content": "!!!!", "encoding": "base64"}, {"name": "../x", "content": "", "encoding": "base64"}, {"name": "x", "content": "", "encoding": "hex"}, {"name": "x", "content": base64.StdEncoding.EncodeToString(make([]byte, maxWorkspaceFileBytes+1)), "encoding": "base64"}} {
		raw, _ := json.Marshal(map[string]any{"summary": "x", "artifact": v})
		if _, _, e := graphOutputFiles(fileNode(true), string(raw)); e == nil {
			t.Fatal("unsafe binary output accepted")
		}
	}
	n := workspaceOutputNode([]outputContractField{{ID: workspaceSnapshotField, Type: "file", Required: true}})
	if _, _, e := graphOutputFiles(n, `{"__workspace_snapshot":"forged"}`); e == nil {
		t.Fatal("reserved snapshot output accepted")
	}
}
func workspaceFixtureSnapshot(t *testing.T) workspaceFile {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	f, e := z.Create("index.html")
	if e != nil {
		t.Fatal(e)
	}
	_, e = io.WriteString(f, "<html><body>built</body></html>")
	if e != nil {
		t.Fatal(e)
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	return encodedWorkspaceFile("workspace.zip", b.Bytes())
}
func callbackRequest(t *testing.T, work workspaceRequest, body any, want int) {
	t.Helper()
	raw, _ := json.Marshal(body)
	r, e := http.NewRequest("POST", work.CallbackURL, bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	r.Header.Set("Authorization", "Bearer "+work.CallbackToken)
	r.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Error(e)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != want {
		t.Errorf("callback status %d want %d", resp.StatusCode, want)
	}
}
func workspaceHealth(w http.ResponseWriter) {
	writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "fixture", "workspace": workspaceCapability{Version: 1, Available: true, MaxModelCalls: 2}, "models": []map[string]any{{"id": "test-model", "runtime": runtimeOpenAIAgents, "maxContextTextBytes": 262144, "messageOverheadBytes": 32}}})
}
func TestPostgresWorkspaceEachCallAccountedSnapshotRestoredAndLeaseRevoked(t *testing.T) {
	snapshot := workspaceFixtureSnapshot(t)
	var calls atomic.Int32
	var second atomic.Bool
	var firstWork workspaceRequest
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			workspaceHealth(w)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var request struct {
			Workspace workspaceRequest `json:"workspace"`
			Prompt    string           `json:"prompt"`
		}
		if e := json.NewDecoder(r.Body).Decode(&request); e != nil {
			t.Error(e)
			return
		}
		work := request.Workspace
		if work.ID == "" || work.MaxModelCalls != 2 || len(work.OutputFields) != 0 {
			t.Error("workspace wire incomplete")
		}
		if request.Prompt != "build" {
			if request.Prompt == "continue" {
				second.Store(true)
			}
			if work.Snapshot == nil || work.Snapshot.SHA256 != snapshot.SHA256 || work.ID != firstWork.ID {
				t.Error("completed workspace not restored")
			}
		} else {
			firstWork = work
			if work.Snapshot != nil {
				t.Error("new workspace inherited a snapshot")
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		for i := 1; i <= 2; i++ {
			callbackRequest(t, work, map[string]any{"operation": "admit", "index": i}, 200)
			calls.Add(1)
			callbackRequest(t, work, map[string]any{"operation": "settle", "index": i, "status": "completed", "observability": json.RawMessage(observationFixture(4, 5))}, 200)
		}
		deliverySnapshot := snapshot
		if request.Prompt == "corrupt" {
			deliverySnapshot = encodedWorkspaceFile("workspace.zip", []byte("PK\x03\x04"))
		}
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": "Built and tested.", "workspaceSnapshot": deliverySnapshot})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	h.a.cfg.OpenAIAgentsURL = worker.URL
	h.a.cfg.OpenAIAgentsToken = strings.Repeat("o", 32)
	h.a.cfg.WorkspaceCallbackURL = h.server.URL + "/api/internal/workspace-calls"
	c, tid, _ := h.register(t, "workspace-accounting@example.test")
	cid, aid, sid := h.fixture(t, c, tid)
	if _, e := h.db.Exec(context.Background(), `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,runtime}','"openai-agents"') WHERE id=$1`, cid); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(context.Background(), "UPDATE agents SET runtime='openai-agents' WHERE id=$1", aid); e != nil {
		t.Fatal(e)
	}
	var lastID string
	for _, prompt := range []string{"build", "corrupt", "continue"} {
		v := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": prompt, "operationId": "workspace-" + prompt}, 202)
		lastID = v["id"].(string)
		status := "completed"
		if prompt == "corrupt" {
			status = "failed"
		}
		h.awaitRun(t, c, tid, lastID, status)
	}
	var count, input int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*),COALESCE(sum(input_tokens),0) FROM model_invocations WHERE tenant_id=$1 AND status='completed'", tid).Scan(&count, &input); e != nil || count != 6 || input != 24 || calls.Load() != 6 || !second.Load() {
		t.Fatal("per-call accounting", e, count, input, calls.Load())
	}
	out := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid+"/artifacts", nil, 200)
	if len(out["items"].([]any)) != 0 {
		t.Fatal("internal snapshot exposed as deliverable")
	}
	callbackRequest(t, firstWork, map[string]any{"operation": "admit", "index": 1}, 401)
	var snapCount int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM artifacts WHERE tenant_id=$1 AND field_id=$2", tid, workspaceSnapshotField).Scan(&snapCount); e != nil || snapCount != 2 {
		t.Fatal("snapshot not stored", e, snapCount)
	}
	var raw string
	if e := h.db.QueryRow(context.Background(), "SELECT execution_snapshot::text FROM runs WHERE id=$1", lastID).Scan(&raw); e != nil || strings.Contains(raw, "callbackToken") {
		t.Fatal("ephemeral credential persisted", e)
	}
}
func TestPostgresWorkspaceRevocationBlocksNextCallAndCompletion(t *testing.T) {
	snapshot := workspaceFixtureSnapshot(t)
	var h *harness
	var tid string
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			workspaceHealth(w)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var b struct {
			Workspace workspaceRequest `json:"workspace"`
		}
		if e := json.NewDecoder(r.Body).Decode(&b); e != nil {
			t.Error(e)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		callbackRequest(t, b.Workspace, map[string]any{"operation": "admit", "index": 1}, 200)
		callbackRequest(t, b.Workspace, map[string]any{"operation": "settle", "index": 1, "status": "completed", "observability": json.RawMessage(observationFixture(4, 5))}, 200)
		if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET allowed_models='{}' WHERE id=$1", tid); e != nil {
			t.Error(e)
		}
		callbackRequest(t, b.Workspace, map[string]any{"operation": "admit", "index": 2}, 403)
		// Even a buggy worker claiming completion after rejected admission cannot publish.
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": "not valid", "workspaceSnapshot": snapshot})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	defer worker.Close()
	h = newHarness(t, worker.URL)
	h.a.cfg.OpenAIAgentsURL = worker.URL
	h.a.cfg.OpenAIAgentsToken = strings.Repeat("o", 32)
	h.a.cfg.WorkspaceCallbackURL = h.server.URL + "/api/internal/workspace-calls"
	c, tenant, _ := h.register(t, "workspace-revoked@example.test")
	tid = tenant
	cid, aid, sid := h.fixture(t, c, tid)
	if _, e := h.db.Exec(context.Background(), `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,runtime}','"openai-agents"') WHERE id=$1`, cid); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(context.Background(), "UPDATE agents SET runtime='openai-agents' WHERE id=$1", aid); e != nil {
		t.Fatal(e)
	}
	v := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "build", "operationId": "workspace-revoke"}, 202)
	h.awaitRun(t, c, tid, v["id"].(string), "failed")
	var n int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&n); e != nil || n != 1 {
		t.Fatal("revoked call reached ledger", e, n)
	}
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM artifacts WHERE tenant_id=$1 AND field_id=$2", tid, workspaceSnapshotField).Scan(&n); e != nil || n != 0 {
		t.Fatal("failed run published snapshot", e, n)
	}
}

func TestPostgresWorkspaceInputsUseFrozenEdgesAndArtifactProvenance(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	c, tid, uid := h.register(t, "workspace-inputs@example.test")
	cid, _, _ := h.fixture(t, c, tid)
	source := graphNode{ID: "source", Kind: "session", Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "source_file", Type: "file", Required: true}}}}
	target := graphNode{ID: "review", Kind: "session", Contract: &graphContract{Version: 1, Inputs: []graphField{{ID: "code", Type: "file", Required: true}}}}
	d := graphDocument{Nodes: []graphNode{source, target}, Edges: []graphEdge{{ID: "wire", FromNode: "source", FromPort: "out:source_file", ToNode: "review", ToPort: "in:code", DataType: "file"}}}
	doc, _ := json.Marshal(d)
	raw := `{"source_file":{"name":"main.ts","content":"export const answer = 42;"}}`
	vals, files, e := graphOutputFiles(source, raw)
	if e != nil {
		t.Fatal(e)
	}
	stored, e := h.a.storeArtifacts(ctx, tid, cid, "source-run", "source", raw, vals, files)
	if e != nil {
		t.Fatal(e)
	}
	gid := randomID()
	if _, e = h.db.Exec(ctx, `INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES($1,$2,$3,$4,$1,'test',0,$5,'[]','completed')`, gid, tid, cid, uid, doc); e != nil {
		t.Fatal(e)
	}
	if _, e = h.db.Exec(ctx, `INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,output) VALUES($1,$2,'source',0,'done',$3)`, tid, gid, stored); e != nil {
		t.Fatal(e)
	}
	load := func() ([]workspaceFile, error) {
		tx, e := h.db.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer tx.Rollback(ctx)
		return materializeWorkspaceInputs(ctx, tx, tid, gid, "review")
	}
	got, e := load()
	if e != nil || len(got) != 1 || got[0].SourceNodeID != "source" || got[0].FieldID != "source_file" {
		t.Fatal("linked file missing", e, got)
	}
	data, e := workspaceFileBytes(got[0])
	if e != nil || string(data) != "export const answer = 42;" {
		t.Fatal("downstream did not receive actual bytes", e)
	}
	// Editing the current canvas cannot widen the admitted graph's operands.
	if _, e = h.db.Exec(ctx, `UPDATE canvases SET document='{"nodes":[],"edges":[]}' WHERE id=$1`, cid); e != nil {
		t.Fatal(e)
	}
	got, e = load()
	if e != nil || len(got) != 1 {
		t.Fatal("live canvas replaced frozen operands", e)
	}
	id := artifactID(tid, "source-run", "source", "source_file")
	if _, e = h.db.Exec(ctx, `UPDATE artifacts SET sha256=$2 WHERE id=$1`, id, strings.Repeat("0", 64)); e != nil {
		t.Fatal(e)
	}
	if _, e = load(); e == nil {
		t.Fatal("corrupt file hash accepted")
	}
	original := encodedWorkspaceFile("main.ts", []byte("export const answer = 42;"))
	if _, e = h.db.Exec(ctx, `UPDATE artifacts SET sha256=$2,node_id='other-node' WHERE id=$1`, id, original.SHA256); e != nil {
		t.Fatal(e)
	}
	if _, e = load(); e == nil {
		t.Fatal("unconnected producer artifact accepted")
	}
	other := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Other", "document": map[string]any{}}, 201)["id"].(string)
	if _, e = h.db.Exec(ctx, `UPDATE artifacts SET node_id='source',canvas_id=$2 WHERE id=$1`, id, other); e != nil {
		t.Fatal(e)
	}
	if _, e = load(); e == nil {
		t.Fatal("cross-canvas artifact accepted")
	}
	// A genuinely optional edge carries no file when its optional producer
	// omitted it, returned null, or published the empty placeholder.
	source.Contract.Outputs[0].Required = false
	target.Contract.Inputs[0].Required = false
	d.Nodes = []graphNode{source, target}
	doc, _ = json.Marshal(d)
	if _, e = h.db.Exec(ctx, "UPDATE graph_runs SET document=$2 WHERE id=$1", gid, doc); e != nil {
		t.Fatal(e)
	}
	for _, empty := range []string{`{}`, `{"source_file":null}`, `{"source_file":""}`} {
		if _, e = h.db.Exec(ctx, "UPDATE graph_run_nodes SET output=$3 WHERE tenant_id=$1 AND graph_id=$2", tid, gid, empty); e != nil {
			t.Fatal(e)
		}
		if got, e = load(); e != nil || len(got) != 0 {
			t.Fatal("optional missing file blocked successor", empty, e)
		}
	}
	target.Contract.Inputs[0].Required = true
	d.Nodes = []graphNode{source, target}
	doc, _ = json.Marshal(d)
	if _, e = h.db.Exec(ctx, "UPDATE graph_runs SET document=$2 WHERE id=$1", gid, doc); e != nil {
		t.Fatal(e)
	}
	if _, e = load(); e == nil {
		t.Fatal("missing required downstream file accepted")
	}
}

func TestPostgresWorkspaceCancellationPreservesPaidReceipt(t *testing.T) {
	for _, withReceipt := range []bool{true, false} {
		t.Run(fmt.Sprint(withReceipt), func(t *testing.T) {
			admitted := make(chan workspaceRequest, 1)
			stopped := make(chan struct{}, 1)
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/health" {
					workspaceHealth(w)
					return
				}
				if r.Method == "DELETE" {
					select {
					case stopped <- struct{}{}:
					default:
					}
					w.WriteHeader(202)
					return
				}
				var request struct {
					Workspace workspaceRequest `json:"workspace"`
				}
				if e := json.NewDecoder(r.Body).Decode(&request); e != nil {
					t.Error(e)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				callbackRequest(t, request.Workspace, map[string]any{"operation": "admit", "index": 1}, 200)
				admitted <- request.Workspace
				<-stopped
				callbackRequest(t, request.Workspace, map[string]any{"operation": "admit", "index": 2}, 409)
				if withReceipt {
					callbackRequest(t, request.Workspace, map[string]any{"operation": "settle", "index": 1, "status": "cancelled", "observability": json.RawMessage(observationFixture(4, 5))}, 200)
				}
			}))
			defer worker.Close()
			h := newHarness(t, worker.URL)
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
			h.a.cfg.WorkspaceCallbackURL = h.server.URL + "/api/internal/workspace-calls"
			c, tid, _ := h.register(t, "workspace-cancel@example.test")
			cid, aid, sid := h.fixture(t, c, tid)
			if _, e := h.db.Exec(context.Background(), `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,runtime}','"openai-agents"') WHERE id=$1`, cid); e != nil {
				t.Fatal(e)
			}
			if _, e := h.db.Exec(context.Background(), "UPDATE agents SET runtime='openai-agents' WHERE id=$1", aid); e != nil {
				t.Fatal(e)
			}
			rid := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "work", "operationId": "workspace-cancel"}, 202)["id"].(string)
			var work workspaceRequest
			select {
			case work = <-admitted:
			case <-time.After(5 * time.Second):
				t.Fatal("no admitted call")
			}
			h.request(t, c, "POST", "/tenants/"+tid+"/runs/"+rid+"/cancel", nil, 200)
			deadline := time.Now().Add(15 * time.Second)
			for {
				var status, usage, cost string
				var input, output *int64
				e := h.db.QueryRow(context.Background(), "SELECT status,usage_status,cost_status,input_tokens,output_tokens FROM model_invocations WHERE run_id=$1", rid).Scan(&status, &usage, &cost, &input, &output)
				if e != nil {
					t.Fatal(e)
				}
				if status != "running" {
					if status != "cancelled" {
						t.Fatal("wrong cancellation status", status)
					}
					if withReceipt && (usage != "reported" || input == nil || output == nil || *input != 4 || *output != 5) {
						t.Fatal("paid receipt lost on cancellation", usage, input, output)
					}
					if !withReceipt && (usage != "unknown" || cost != "unknown" || input != nil || output != nil) {
						t.Fatal("uncertain call became zero", usage, cost, input, output)
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("cancellation did not settle bounded calls")
				}
				time.Sleep(20 * time.Millisecond)
			}
			var n int
			if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM artifacts WHERE run_id=$1", rid).Scan(&n); e != nil || n != 0 {
				t.Fatal("cancelled snapshot published", e, n)
			}
			for until := time.Now().Add(time.Second); time.Now().Before(until); {
				if _, open := h.a.workspaceLeases.Load(tokenHash(work.CallbackToken)); !open {
					break
				}
				time.Sleep(time.Millisecond)
			}
			callbackRequest(t, work, map[string]any{"operation": "settle", "index": 1, "status": "cancelled"}, 401)
		})
	}
}

func TestPostgresWorkspaceDeletedPersonalConnectionDeniesNextPaidCall(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	c, tid, uid := h.register(t, "workspace-key-revoked@example.test")
	_, _, sid := h.fixture(t, c, tid)
	h.a.cfg.UserCredentials = true
	ctx := context.Background()
	connectionID, rid := randomID(), randomID()
	model := connectionModelID(connectionID, "test-model")
	if _, e := h.db.Exec(ctx, "INSERT INTO user_connections(id,user_id,provider,runtime,name,secret,models) VALUES($1,$2,'llmgate','openai-agents','fixture',$3,'[\"test-model\"]')", connectionID, uid, []byte("fixture")); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,actor_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,$1,'fixture','test','running')", rid, tid, sid, uid); e != nil {
		t.Fatal(e)
	}
	snap := executionSnapshot{Runtime: runtimeOpenAIAgents, Model: model, Workspace: &workspacePlan{Version: 1, MaxModelCalls: 2}}
	lease, token, closeLease := h.a.registerWorkspaceLease(ctx, tid, rid, sid, snap)
	defer closeLease()
	work := workspaceRequest{CallbackURL: h.server.URL + "/api/internal/workspace-calls", CallbackToken: token}
	callbackRequest(t, work, map[string]any{"operation": "admit", "index": 1}, 200)
	callbackRequest(t, work, map[string]any{"operation": "settle", "index": 1, "status": "completed", "observability": json.RawMessage(observationFixture(4, 5))}, 200)
	if _, e := h.db.Exec(ctx, "DELETE FROM user_connections WHERE id=$1", connectionID); e != nil {
		t.Fatal(e)
	}
	callbackRequest(t, work, map[string]any{"operation": "admit", "index": 2}, 403)
	if lease.sealSuccess() {
		t.Fatal("revoked personal key allowed completion")
	}
	var n int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE run_id=$1", rid).Scan(&n); e != nil || n != 1 {
		t.Fatal("revoked key reserved another paid call", e, n)
	}
	h.a.finish(tid, rid, "failed", "", "workspace_admission_failed")
}

func TestWorkspaceAdmissionDoesNotDowngradeAndPolicyUsesActualFiles(t *testing.T) {
	a := New(nil, testConfig())
	a.cfg.WorkspaceCallbackURL = "http://127.0.0.1:8087/api/internal/workspace-calls"
	if a.requireWorkspaceSnapshot(executionSnapshot{Runtime: runtimeOpenAIAgents}) == nil {
		t.Fatal("configured coding run silently downgraded")
	}
	if a.requireWorkspaceSnapshot(executionSnapshot{Runtime: runtimePI}) != nil {
		t.Fatal("legacy Pi changed")
	}
	a.cfg.WorkspaceCallbackURL = ""
	if a.requireWorkspaceSnapshot(executionSnapshot{Runtime: runtimeOpenAIAgents}) != nil {
		t.Fatal("opt-out text profile changed")
	}
	n := fileNode(true)
	policy := graphWorkspaceOutputPolicy(n)
	if strings.Contains(policy, "256 KiB") || !strings.Contains(policy, "workspace_publish") || !strings.Contains(policy, "workspace_archive") {
		t.Fatal("coding policy still asks for invented text files")
	}
	original := "User task and inputs\n\n" + outputFormatMarker + graphOutputPolicy(n) + "\n\nEnd"
	got := workspaceGraphPrompt(original, policy)
	if !strings.HasPrefix(got, "User task and inputs") || strings.Contains(got, "256 KiB") {
		t.Fatal("graph prompt retained conflicting legacy policy")
	}
}

func TestPostgresWorkspaceRunActivityProjectionIsBoundedAndTenantScoped(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	c, tid, uid := h.register(t, "workspace-activity@example.test")
	_, _, sid := h.fixture(t, c, tid)
	rid := randomID()
	snapshot, _ := json.Marshal(executionSnapshot{Runtime: runtimeOpenAIAgents, Workspace: &workspacePlan{Version: 1, MaxModelCalls: 16}})
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,actor_id,operation_id,request_hash,prompt,status,execution_snapshot) VALUES($1,$2,$3,$4,$1,'fixture','test','running',$5)", rid, tid, sid, uid, snapshot); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 65; i++ {
		data, _ := json.Marshal(map[string]any{"type": "workspace_activity", "step": i%16 + 1, "tool": "workspace_exec", "args": "private command", "path": "private source", "apiKey": "private key"})
		if _, e := h.db.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, rid, data); e != nil {
			t.Fatal(e)
		}
	}
	v := h.request(t, c, "GET", "/tenants/"+tid+"/runs/"+rid, nil, 200)
	activity, ok := v["workspaceActivity"].(map[string]any)
	if !ok || v["executionKind"] != "workspace" || activity["truncated"] != true {
		t.Fatal("missing workbench projection", v)
	}
	items := activity["items"].([]any)
	if len(items) != 64 || items[0].(map[string]any)["step"] != float64(2) || items[63].(map[string]any)["step"] != float64(1) {
		t.Fatal("activity not bounded ordered tail")
	}
	for _, item := range items {
		if len(item.(map[string]any)) != 2 {
			t.Fatal("activity leaked extra fields", item)
		}
	}
	public, _ := json.Marshal(v)
	if bytes.Contains(public, []byte("private")) || bytes.Contains(public, []byte("callback")) {
		t.Fatal("private event values escaped projection")
	}
	other, otherTID, _ := h.register(t, "workspace-activity-other@example.test")
	h.request(t, other, "GET", "/tenants/"+tid+"/runs/"+rid, nil, 404)
	h.request(t, other, "GET", "/tenants/"+otherTID+"/runs/"+rid, nil, 404)
	for _, test := range []struct{ snapshot, kind string }{{`{"team":{"mode":"sequential"},"workspace":{"version":1},"runtime":"openai-agents"}`, "team"}, {`{}`, "text"}} {
		if _, e := h.db.Exec(ctx, "UPDATE runs SET execution_snapshot=$2 WHERE id=$1", rid, test.snapshot); e != nil {
			t.Fatal(e)
		}
		v = h.request(t, c, "GET", "/tenants/"+tid+"/runs/"+rid, nil, 200)
		if v["executionKind"] != test.kind || v["workspaceActivity"] != nil {
			t.Fatal("legacy execution mislabeled as full workspace", v)
		}
	}
	h.a.finish(tid, rid, "failed", "", "test_complete")
}
