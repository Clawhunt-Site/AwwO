package app

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The codes a canvas node is retried for are the Canvas RSI design's closed list, no more and no fewer, and every
// code the design names as never retried stays out of it.
func TestGraphRetryableCodesAreTheDesignedList(t *testing.T) {
	want := []string{"media_failed", "media_motion_failed", "media_provider_busy", "media_provider_unavailable", "media_result_unavailable",
		"provider_rate_limited", "provider_unavailable", "runtime_failed", "runtime_rejected", "runtime_session_busy",
		"runtime_stream_ended", "runtime_unavailable", "workspace_admission_failed", "workspace_busy", "workspace_unavailable"}
	if got := slices.Sorted(maps.Keys(graphRetryableCodes)); !slices.Equal(got, want) {
		t.Fatalf("retryable codes %v", got)
	}
	free := func() bool { return true }
	for _, code := range want {
		if !graphRetryable(code, free, free) {
			t.Fatal("listed code not retried", code)
		}
	}
	// A run that timed out used its whole deadline; a retry would repeat it at full cost (owner, 2026-10-18).
	for _, code := range []string{"run_timeout", "output_limit", "context_limit", "output_contract_invalid", "model_refused", "provider_auth_failed",
		"media_content_rejected", "media_params_invalid", "media_provider_balance", "workspace_step_limit", "accounting_commit_failed",
		"execution_interrupted", "interrupted", "cancelled", "media_timeout", "quota_exceeded", "plan_required", "invalid_runtime_event",
		"workspace_runtime_rejected", ""} {
		if graphRetryable(code, free, free) {
			t.Fatal("retried a code the design keeps out", code)
		}
	}
	for code := range graphRetryableCodes {
		if strings.HasPrefix(code, "accounting_") {
			t.Fatal("an accounting failure is never retried", code)
		}
	}
	// No retry pays twice for work already done: each code asks exactly the question that rules that out, and only it.
	never := func() bool { t.Helper(); t.Fatal("asked a question this code does not depend on"); return false }
	no := func() bool { return false }
	unsent := []string{"runtime_rejected", "runtime_session_busy", "runtime_unavailable", "workspace_admission_failed", "workspace_busy", "workspace_unavailable"}
	silent := []string{"provider_rate_limited", "provider_unavailable", "runtime_failed", "runtime_stream_ended"}
	for _, code := range unsent {
		if !graphRetryable(code, never, never) {
			t.Fatal("a run that never reached a model not retried", code)
		}
	}
	for _, code := range silent {
		if graphRetryable(code, no, never) {
			t.Fatal("retried a run that produced output", code)
		}
	}
	for _, code := range want {
		if strings.HasPrefix(code, "media_") && graphRetryable(code, never, no) {
			t.Fatal("retried a generation that may have been charged", code)
		}
	}
	if len(unsent)+len(silent) != len(want)-5 {
		t.Fatal("every listed code has a class")
	}
}

func TestGraphNodeRetriesFromEnv(t *testing.T) {
	for raw, want := range map[string]int{"": 2, "0": 0, "1": 1, "2": 2, "5": 5, " 3 ": 3} {
		pinWorkspaceEnv(t, "", "", "")
		t.Setenv("AWWO_GRAPH_NODE_RETRIES", raw)
		loaded, err := ConfigFromEnv()
		if err != nil || loaded.GraphNodeRetries != want {
			t.Fatalf("AWWO_GRAPH_NODE_RETRIES=%q gave %d, %v", raw, loaded.GraphNodeRetries, err)
		}
	}
	for _, raw := range []string{"6", "-1", "two", "2.5", "1e1", "0x2", "99999999999999999999"} {
		pinWorkspaceEnv(t, "", "", "")
		t.Setenv("AWWO_GRAPH_NODE_RETRIES", raw)
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AWWO_GRAPH_NODE_RETRIES") {
			t.Fatalf("AWWO_GRAPH_NODE_RETRIES=%q was accepted or not named: %v", raw, err)
		}
	}
	// A Config made in code is held to the same range, and the scheduler never reads past it.
	c := testConfig()
	for _, n := range []int{-1, 6} {
		c.GraphNodeRetries = n
		if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "AWWO_GRAPH_NODE_RETRIES") {
			t.Fatal("out-of-range retries accepted", n, err)
		}
	}
	for n, want := range map[int]int{-3: 0, 0: 0, 4: 4, 9: 5} {
		if got := (&App{cfg: Config{GraphNodeRetries: n}}).graphNodeRetries(); got != want {
			t.Fatal("limit in force", n, got)
		}
	}
}

func TestGraphRetryBackoffDoublesUpToTwoMinutes(t *testing.T) {
	for retries, want := range []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 2 * time.Minute, 2 * time.Minute} {
		if got := graphRetryBackoff(retries, 0); got != want {
			t.Fatalf("after %d retries waited %v, want %v", retries, got, want)
		}
		if got := graphRetryBackoff(retries, graphRetryBase); got != want {
			t.Fatalf("the base unit after %d retries waited %v, want %v", retries, got, want)
		}
	}
	if graphRetryBackoff(-1, 0) != 15*time.Second || graphRetryBackoff(2, time.Millisecond) != 4*time.Millisecond || graphRetryBackoff(40, time.Millisecond) != 8*time.Millisecond {
		t.Fatal("a shortened unit keeps the shape")
	}
}

// The first attempt keeps the operation every graph run has used; each retry gets its own, as one operation names one run.
func TestGraphChildOperationIDs(t *testing.T) {
	if graphChildOperationID("g1", "node", 0) != "graph:g1:"+tokenHash("node")[:20] || graphChildOperationID("g1", "node", 2) != "graph:g1:"+tokenHash("node")[:20]+":retry-2" {
		t.Fatal(graphChildOperationID("g1", "node", 0), graphChildOperationID("g1", "node", 2))
	}
}

func TestGraphExperienceFacts(t *testing.T) {
	node := graphNode{ID: "n", TemplateID: "frontend", Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "page", Type: "html"}, {ID: "notes", Type: "markdown"}, {ID: "more", Type: "html"}, {ID: "plain"}}}}
	snapshot, _ := json.Marshal(executionSnapshot{Runtime: runtimeOpenAIAgents, Model: "oa-default"})
	if f := graphExperienceFacts(node, snapshot); f != (experienceFacts{"frontend", "html+markdown+text", runtimeOpenAIAgents, "oa-default"}) {
		t.Fatal(f)
	}
	media, _ := json.Marshal(executionSnapshot{Runtime: runtimeRunningHub, Model: "rh.image", Media: &mediaPlan{Kind: mediaKindImage, Model: "rh.image"}})
	if f := graphExperienceFacts(graphNode{ID: "m", TemplateID: "not a template"}, media); f != (experienceFacts{"", mediaKindImage, runtimeRunningHub, "rh.image"}) {
		t.Fatal(f)
	}
	if f := graphExperienceFacts(graphNode{ID: "x"}, []byte("not json")); f != (experienceFacts{outputType: "text"}) {
		t.Fatal(f)
	}
}

// Migration 036 adds the retry columns with their defaults and the two RSI tables, whose kinds, outcomes and statuses
// are closed and whose rows go with their workspace; every statement runs again unchanged.
func TestPostgresCanvasRSISchema(t *testing.T) {
	db := migrationTestDatabase(t)
	ctx := context.Background()
	if e := Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	sql, _ := migrations.ReadFile("migrations/036_canvas_rsi.sql")
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, string(sql)); e != nil {
		t.Fatal("036 is not re-runnable", e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	exec := func(statement string, args ...any) error { _, err := db.Exec(ctx, statement, args...); return err }
	for _, statement := range []string{
		"INSERT INTO users(id,email,name,password_hash) VALUES('u','rsi@example.test','RSI','x')",
		"INSERT INTO tenants(id,name) VALUES('t','RSI workspace')",
		"INSERT INTO canvases(id,tenant_id,name) VALUES('c','t','Canvas')",
		"INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES('g','t','c','u','op','h',1,'{}','[]','running')",
		"INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state) VALUES('t','g','n',0,'waiting')",
		"INSERT INTO canvas_experiences(id,tenant_id,canvas_id,graph_id,node_id,kind) VALUES('e','t','c','g','n','retry')",
		"INSERT INTO canvas_lessons(id,tenant_id,rule) VALUES('l','t','Name the input file.')",
	} {
		if e = exec(statement); e != nil {
			t.Fatal(statement, e)
		}
	}
	var attempts int
	var retryAt *time.Time
	var log, detail, scope, evidence string
	var outcome, status, code string
	var applied, succeeded int
	if e = db.QueryRow(ctx, "SELECT attempts,retry_at,attempt_log::text FROM graph_run_nodes WHERE graph_id='g'").Scan(&attempts, &retryAt, &log); e != nil || attempts != 0 || retryAt != nil || log != "[]" {
		t.Fatal("node defaults", attempts, retryAt, log, e)
	}
	if e = db.QueryRow(ctx, "SELECT outcome,detail::text,failure_code FROM canvas_experiences WHERE id='e'").Scan(&outcome, &detail, &code); e != nil || outcome != "pending" || detail != "{}" || code != "" {
		t.Fatal("experience defaults", outcome, detail, code, e)
	}
	if e = db.QueryRow(ctx, "SELECT status,scope::text,evidence::text,applied,succeeded FROM canvas_lessons WHERE id='l'").Scan(&status, &scope, &evidence, &applied, &succeeded); e != nil || status != "proposed" || scope != "{}" || evidence != "[]" || applied != 0 || succeeded != 0 {
		t.Fatal("lesson defaults", status, scope, evidence, applied, succeeded, e)
	}
	for _, statement := range []string{
		"INSERT INTO canvas_experiences(id,tenant_id,canvas_id,graph_id,node_id,kind) VALUES('e2','t','c','g','n','guess')",
		"INSERT INTO canvas_experiences(id,tenant_id,canvas_id,graph_id,node_id,kind,outcome) VALUES('e3','t','c','g','n','repair','done')",
		"INSERT INTO canvas_experiences(id,tenant_id,canvas_id,graph_id,node_id,kind) VALUES('e4','nobody','c','g','n','retry')",
		"INSERT INTO canvas_lessons(id,tenant_id,rule,status) VALUES('l2','t','x','enabled')",
		"UPDATE graph_run_nodes SET attempts=NULL WHERE graph_id='g'",
	} {
		if exec(statement) == nil {
			t.Fatal("accepted", statement)
		}
	}
	// What a workspace learnt goes with the workspace, and outlives the canvas and its graph runs.
	if e = exec("DELETE FROM graph_runs WHERE id='g'"); e != nil {
		t.Fatal(e)
	}
	if e = exec("DELETE FROM canvases WHERE id='c'"); e != nil {
		t.Fatal(e)
	}
	var kept int
	if e = db.QueryRow(ctx, "SELECT (SELECT count(*) FROM canvas_experiences)+(SELECT count(*) FROM canvas_lessons)").Scan(&kept); e != nil || kept != 2 {
		t.Fatal("experiences went with their canvas", kept, e)
	}
	if e = exec("DELETE FROM memberships WHERE tenant_id='t'"); e != nil {
		t.Fatal(e)
	}
	if e = exec("DELETE FROM tenants WHERE id='t'"); e != nil {
		t.Fatal(e)
	}
	if e = db.QueryRow(ctx, "SELECT (SELECT count(*) FROM canvas_experiences)+(SELECT count(*) FROM canvas_lessons)").Scan(&kept); e != nil || kept != 0 {
		t.Fatal("experiences outlived their workspace", kept, e)
	}
}

// piReply is how a scripted Pi worker answers one call: a refusal before any stream (the API records
// runtime_rejected), a failed event with a worker code, or a completed text; hold, when set, delays the answer.
type piReply struct {
	status int
	failed string
	text   string
	hold   <-chan struct{}
	// partial is text streamed before the run fails (with failed set).
	partial string
}

// scriptedPi is a Pi worker that answers each call as reply says for the node the prompt names and the number of that
// node's call (from 1), and records the calls in order.
type scriptedPi struct {
	server *httptest.Server
	mu     sync.Mutex
	calls  []string
	counts map[string]int
	prompt map[string]string
}

func newScriptedPi(t *testing.T, reply func(node string, call int) piReply) *scriptedPi {
	s := &scriptedPi{counts: map[string]int{}, prompt: map[string]string{}}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var call observedPiCall
		if e := json.NewDecoder(r.Body).Decode(&call); e != nil {
			t.Error(e)
		}
		node, _, _ := strings.Cut(strings.TrimPrefix(call.Prompt, "【工作流节点】"), "\n")
		s.mu.Lock()
		s.counts[node]++
		n := s.counts[node]
		s.calls = append(s.calls, fmt.Sprintf("%s#%d", node, n))
		s.prompt[node] = call.Prompt
		s.mu.Unlock()
		answer := reply(node, n)
		if answer.hold != nil {
			select {
			case <-answer.hold:
			case <-r.Context().Done():
				return
			}
		}
		if answer.status != 0 {
			w.WriteHeader(answer.status)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		if answer.failed != "" {
			if answer.partial != "" {
				raw, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": answer.partial})
				fmt.Fprintf(w, "data: %s\n\n", raw)
			}
			failWorker(w, answer.failed)
			return
		}
		completePi(w, answer.text)
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *scriptedPi) seen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.calls)
}

// retryCanvas is a canvas of two nodes, up feeding down, both on one Pi agent; up is a frontend template node.
func retryCanvas(t *testing.T, h *harness, c *http.Cookie, tid string) string {
	t.Helper()
	prefix := "/tenants/" + tid
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Retry worker", "adapterType": "pi", "model": "test-model", "instructions": "Work"}, 201)["id"].(string)
	binding := map[string]string{"companyId": tid, "agentId": agent}
	doc := map[string]any{"nodes": []any{
		map[string]any{"id": "up", "kind": "session", "title": "up", "runtime": "pi", "agentKind": "llm", "templateId": "frontend", "binding": binding},
		map[string]any{"id": "down", "kind": "session", "title": "down", "runtime": "pi", "agentKind": "llm", "binding": binding, "x": 320},
	}, "edges": []map[string]string{{"id": "up-down", "fromNode": "up", "fromPort": "result", "toNode": "down", "toPort": "context", "dataType": "text"}}}
	return h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Retry", "document": doc}, 201)["id"].(string)
}

func graphNodeResult(t *testing.T, graph map[string]any, id string) map[string]any {
	t.Helper()
	for _, raw := range graph["nodes"].([]any) {
		if node := raw.(map[string]any); node["nodeId"] == id {
			return node
		}
	}
	t.Fatalf("node %s missing from %v", id, graph)
	return nil
}

// awaitGraphNode polls a graph run until node id satisfies ok.
func awaitGraphNode(t *testing.T, h *harness, c *http.Cookie, path, id string, ok func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		graph := h.request(t, c, "GET", path, nil, 200)
		if ok(graphNodeResult(t, graph, id)) {
			return graph
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("node %s never reached the expected state: %v", id, graphNodeResult(t, h.request(t, c, "GET", path, nil, 200), id))
	return nil
}

type experienceRow struct {
	kind, code, role, outputType, runtime, model, outcome, runID string
	detail                                                       map[string]any
}

func graphExperiences(t *testing.T, h *harness, tid, gid, node string) []experienceRow {
	t.Helper()
	rows, err := h.db.Query(context.Background(), `SELECT kind,failure_code,node_role,output_type,runtime,model,outcome,COALESCE(run_id,''),detail
		FROM canvas_experiences WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 ORDER BY created_at,id`, tid, gid, node)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []experienceRow{}
	for rows.Next() {
		var r experienceRow
		var raw []byte
		if err = rows.Scan(&r.kind, &r.code, &r.role, &r.outputType, &r.runtime, &r.model, &r.outcome, &r.runID, &raw); err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(raw, &r.detail); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

type nodeRun struct{ id, status, code, operation string }

// sessionRuns lists the runs of node's session in this graph, oldest first.
func sessionRuns(t *testing.T, h *harness, tid, gid, node string) []nodeRun {
	t.Helper()
	rows, err := h.db.Query(context.Background(), `SELECT r.id,r.status,r.error,r.operation_id FROM runs r JOIN graph_run_nodes n ON n.tenant_id=r.tenant_id AND n.session_id=r.session_id
		WHERE n.tenant_id=$1 AND n.graph_id=$2 AND n.node_id=$3 AND r.operation_id LIKE 'graph:'||$2||':%' ORDER BY r.created_at,r.id`, tid, gid, node)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []nodeRun{}
	for rows.Next() {
		var r nodeRun
		if err = rows.Scan(&r.id, &r.status, &r.code, &r.operation); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

// A node whose run was refused by its worker runs again after the backoff and completes; its downstream node starts
// only once the retried upstream is done, and reads the retry's delivery.
func TestPostgresGraphNodeRetriesTransientFailureThenSucceeds(t *testing.T) {
	release := make(chan struct{})
	pi := newScriptedPi(t, func(node string, call int) piReply {
		switch {
		case node == "up" && call == 1:
			return piReply{status: 503}
		case node == "up":
			return piReply{text: "RESULT-UP", hold: release}
		}
		return piReply{text: "RESULT-DOWN"}
	})
	h := newHarness(t, pi.server.URL)
	h.a.cfg.GraphNodeRetries = 2
	h.a.graphRetryUnit = 40 * time.Millisecond
	c, tid, _ := h.register(t, "graph-retry@example.test")
	cid := retryCanvas(t, h, c, tid)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	accepted := h.request(t, c, "POST", base, map[string]any{"operationId": "graph-retry-operation", "documentVersion": 1}, 202)
	gid := accepted["id"].(string)
	path := base + "/" + gid
	if accepted["nodeRetries"] != float64(2) || graphNodeResult(t, accepted, "up")["attempts"] != float64(0) || len(graphNodeResult(t, accepted, "up")["attemptLog"].([]any)) != 0 {
		t.Fatal("admission does not show the retry limit and empty attempts", accepted)
	}
	// The retry is running and held at the worker: the downstream node has not started, and reads as waiting with no run.
	awaitGraphNode(t, h, c, path, "up", func(n map[string]any) bool { return n["state"] == "running" && n["attempts"] == float64(1) })
	for deadline := time.Now().Add(5 * time.Second); len(pi.seen()) < 2 && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
	if calls := pi.seen(); !slices.Equal(calls, []string{"up#1", "up#2"}) {
		t.Fatal("calls before release", calls)
	}
	graph := h.request(t, c, "GET", path, nil, 200)
	if down := graphNodeResult(t, graph, "down"); down["state"] != "waiting" || down["runId"] != nil || down["detail"] != "" {
		t.Fatal("downstream started before the retried upstream finished", down)
	}
	if up := graphNodeResult(t, graph, "up"); up["state"] != "running" || up["detail"] != "" {
		t.Fatal("a running retry still says it is waiting to retry", up)
	}
	close(release)
	done := awaitGraph(t, h, c, path, "completed")
	if calls := pi.seen(); !slices.Equal(calls, []string{"up#1", "up#2", "down#1"}) {
		t.Fatal("call order", calls)
	}
	if !strings.Contains(pi.prompt["down"], "RESULT-UP") {
		t.Fatal("downstream did not read the retry's delivery", pi.prompt["down"])
	}
	up, down := graphNodeResult(t, done, "up"), graphNodeResult(t, done, "down")
	runs := sessionRuns(t, h, tid, gid, "up")
	if len(runs) != 2 || runs[0].status != "failed" || runs[0].code != "runtime_rejected" || runs[1].status != "completed" ||
		runs[0].operation != graphChildOperationID(gid, "up", 0) || runs[1].operation != graphChildOperationID(gid, "up", 1) {
		t.Fatalf("one run per attempt: %+v", runs)
	}
	if up["state"] != "done" || up["attempts"] != float64(1) || up["runId"] != runs[1].id || up["output"] != "RESULT-UP" {
		t.Fatal(up)
	}
	log := up["attemptLog"].([]any)
	if len(log) != 1 {
		t.Fatal(log)
	}
	entry := log[0].(map[string]any)
	if entry["runId"] != runs[0].id || entry["code"] != "runtime_rejected" || entry["attempt"] != float64(1) || entry["endedAt"] == nil || len(entry) != 4 {
		t.Fatal("attempt log entry", entry)
	}
	if down["state"] != "done" || down["attempts"] != float64(0) || len(down["attemptLog"].([]any)) != 0 {
		t.Fatal(down)
	}
	var downStart, upEnd time.Time
	if e := h.db.QueryRow(context.Background(), "SELECT (SELECT created_at FROM runs WHERE id=$1),(SELECT updated_at FROM runs WHERE id=$2)", down["runId"], runs[1].id).Scan(&downStart, &upEnd); e != nil || !downStart.After(upEnd) {
		t.Fatal("downstream run began before the retried upstream ended", downStart, upEnd, e)
	}
	exp := graphExperiences(t, h, tid, gid, "up")
	if len(exp) != 1 || exp[0].kind != "retry" || exp[0].code != "runtime_rejected" || exp[0].outcome != "succeeded" || exp[0].runID != runs[0].id ||
		exp[0].role != "frontend" || exp[0].outputType != "text" || exp[0].runtime != "pi" || exp[0].model != "test-model" ||
		exp[0].detail["attempt"] != float64(1) || exp[0].detail["limit"] != float64(2) || exp[0].detail["nodeState"] != "done" || exp[0].detail["agentKind"] != "llm" {
		t.Fatalf("experience %+v", exp)
	}
	if len(graphExperiences(t, h, tid, gid, "down")) != 0 {
		t.Fatal("a node that never failed has an experience")
	}
	// Each attempt's archive names the node and its attempts.
	for _, run := range runs {
		archive := readRunArchiveManifest(t, h, c, tid, run.id)
		node, _ := archive["graphNode"].(map[string]any)
		if node["graphId"] != gid || node["nodeId"] != "up" || node["attempts"] != float64(1) || len(node["attemptLog"].([]any)) != 1 {
			t.Fatal("archive of", run.id, archive)
		}
	}
	if archive := readRunArchiveManifest(t, h, c, tid, down["runId"].(string)); archive["graphNode"].(map[string]any)["attempts"] != float64(0) {
		t.Fatal("downstream archive", archive)
	}
}

func readRunArchiveManifest(t *testing.T, h *harness, c *http.Cookie, tid, runID string) map[string]any {
	t.Helper()
	req, _ := http.NewRequest("GET", h.server.URL+"/api/v1/tenants/"+tid+"/runs/"+runID+"/archive", nil)
	req.AddCookie(c)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var manifest map[string]any
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&manifest) != nil {
		t.Fatal("archive", runID, resp.StatusCode)
	}
	return manifest
}

// A node that keeps failing for a transient reason runs 1 + AWWO_GRAPH_NODE_RETRIES times and then fails as it would
// have without retries; its downstream node never runs.
func TestPostgresGraphNodeRetriesStopAtTheLimit(t *testing.T) {
	pi := newScriptedPi(t, func(node string, call int) piReply {
		if node == "up" {
			return piReply{failed: "MODEL_UNAVAILABLE"}
		}
		return piReply{text: "RESULT-DOWN"}
	})
	h := newHarness(t, pi.server.URL)
	h.a.cfg.GraphNodeRetries = 2
	h.a.graphRetryUnit = 20 * time.Millisecond
	c, tid, _ := h.register(t, "graph-retry-limit@example.test")
	base := "/tenants/" + tid + "/canvases/" + retryCanvas(t, h, c, tid) + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "graph-retry-limit", "documentVersion": 1}, 202)["id"].(string)
	done := awaitGraph(t, h, c, base+"/"+gid, "failed")
	up, down := graphNodeResult(t, done, "up"), graphNodeResult(t, done, "down")
	runs := sessionRuns(t, h, tid, gid, "up")
	if len(runs) != 3 || up["state"] != "failed" || up["detail"] != "provider_unavailable" || up["attempts"] != float64(2) || up["runId"] != runs[2].id {
		t.Fatalf("%v %+v", up, runs)
	}
	log := up["attemptLog"].([]any)
	if len(log) != 2 || log[0].(map[string]any)["runId"] != runs[0].id || log[1].(map[string]any)["runId"] != runs[1].id || log[1].(map[string]any)["attempt"] != float64(2) {
		t.Fatal(log)
	}
	for _, run := range runs {
		if run.status != "failed" || run.code != "provider_unavailable" {
			t.Fatalf("%+v", runs)
		}
	}
	if down["state"] != "blocked" || down["runId"] != nil {
		t.Fatal("downstream of a failed node", down)
	}
	if calls := pi.seen(); !slices.Equal(calls, []string{"up#1", "up#2", "up#3"}) {
		t.Fatal(calls)
	}
	exp := graphExperiences(t, h, tid, gid, "up")
	if len(exp) != 2 || exp[0].outcome != "failed" || exp[1].outcome != "failed" || exp[0].code != "provider_unavailable" || exp[1].detail["attempt"] != float64(2) || exp[1].detail["nodeState"] != "failed" {
		t.Fatalf("%+v", exp)
	}
}

// runtime_failed is the catch-all of unmapped worker codes, some of them permanent (a run that ran out of turns): a node
// runs again only when its run produced nothing, so no retry pays twice for output already made.
func TestPostgresGraphNodeRetriesOnlyRunsThatProducedNothing(t *testing.T) {
	pi := newScriptedPi(t, func(node string, call int) piReply {
		if node == "up" && call == 1 {
			// The provider cut the call before its first event: nothing was produced.
			return piReply{failed: "SOME_UNMAPPED_CODE"}
		}
		return piReply{text: "RESULT-" + strings.ToUpper(node)}
	})
	h := newHarness(t, pi.server.URL)
	h.a.cfg.GraphNodeRetries = 2
	h.a.graphRetryUnit = 20 * time.Millisecond
	c, tid, _ := h.register(t, "graph-retry-silent@example.test")
	base := "/tenants/" + tid + "/canvases/" + retryCanvas(t, h, c, tid) + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "graph-retry-silent", "documentVersion": 1}, 202)["id"].(string)
	done := awaitGraph(t, h, c, base+"/"+gid, "completed")
	if up := graphNodeResult(t, done, "up"); up["state"] != "done" || up["attempts"] != float64(1) {
		t.Fatal("a silent runtime_failed not retried", up)
	}

	loud := newScriptedPi(t, func(node string, call int) piReply {
		if node == "up" {
			return piReply{partial: "half of a delivery", failed: "MaxTurnsExceeded"}
		}
		return piReply{text: "RESULT-DOWN"}
	})
	h2 := newHarness(t, loud.server.URL)
	h2.a.cfg.GraphNodeRetries = 2
	h2.a.graphRetryUnit = 20 * time.Millisecond
	c2, tid2, _ := h2.register(t, "graph-retry-loud@example.test")
	base2 := "/tenants/" + tid2 + "/canvases/" + retryCanvas(t, h2, c2, tid2) + "/graph-runs"
	gid2 := h2.request(t, c2, "POST", base2, map[string]any{"operationId": "graph-retry-loud", "documentVersion": 1}, 202)["id"].(string)
	failed := awaitGraph(t, h2, c2, base2+"/"+gid2, "failed")
	up := graphNodeResult(t, failed, "up")
	if up["state"] != "failed" || up["detail"] != "runtime_failed" || up["attempts"] != float64(0) {
		t.Fatal("a run that produced output was retried", up)
	}
	if calls := loud.seen(); !slices.Equal(calls, []string{"up#1"}) {
		t.Fatal(calls)
	}
	if len(graphExperiences(t, h2, tid2, gid2, "up")) != 0 {
		t.Fatal("a retry was recorded for a run that produced output")
	}
}

// Failures the request or the model decided, and a run that timed out, are never retried, and with
// AWWO_GRAPH_NODE_RETRIES=0 nothing is: the node fails at once as it always did, with no attempt recorded.
func TestPostgresGraphNodeRetriesSkipPermanentFailuresAndCanBeTurnedOff(t *testing.T) {
	for _, tc := range []struct {
		name    string
		retries int
		reply   piReply
		code    string
	}{
		{"output_limit", 2, piReply{failed: "MODEL_OUTPUT_LIMIT"}, "output_limit"},
		{"model_refused", 2, piReply{failed: "MODEL_REFUSAL"}, "model_refused"},
		// A run that timed out used its whole deadline (owner, 2026-10-18: 「超时不再重试」).
		{"run_timeout", 2, piReply{failed: "DEADLINE_EXCEEDED"}, "run_timeout"},
		{"retries_off", 0, piReply{status: 503}, "runtime_rejected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pi := newScriptedPi(t, func(node string, call int) piReply { return tc.reply })
			h := newHarness(t, pi.server.URL)
			h.a.cfg.GraphNodeRetries = tc.retries
			h.a.graphRetryUnit = 10 * time.Millisecond
			c, tid, _ := h.register(t, "graph-retry-"+strings.ReplaceAll(tc.name, "_", "-")+"@example.test")
			base := "/tenants/" + tid + "/canvases/" + retryCanvas(t, h, c, tid) + "/graph-runs"
			accepted := h.request(t, c, "POST", base, map[string]any{"operationId": "graph-no-retry-" + tc.name, "documentVersion": 1}, 202)
			gid := accepted["id"].(string)
			if accepted["nodeRetries"] != float64(tc.retries) {
				t.Fatal(accepted["nodeRetries"])
			}
			done := awaitGraph(t, h, c, base+"/"+gid, "failed")
			up := graphNodeResult(t, done, "up")
			if up["state"] != "failed" || up["detail"] != tc.code || up["attempts"] != float64(0) || len(up["attemptLog"].([]any)) != 0 {
				t.Fatal(up)
			}
			if runs, calls := sessionRuns(t, h, tid, gid, "up"), pi.seen(); len(runs) != 1 || !slices.Equal(calls, []string{"up#1"}) {
				t.Fatalf("%+v %v", runs, calls)
			}
			if exp := graphExperiences(t, h, tid, gid, "up"); len(exp) != 0 {
				t.Fatalf("%+v", exp)
			}
		})
	}
}

// Cancelling a graph while a node waits for its next attempt stops the retry: the node ends cancelled, not failed,
// no further run is made, and its experience records that the retry did not succeed.
func TestPostgresGraphCancelStopsAPendingRetry(t *testing.T) {
	pi := newScriptedPi(t, func(node string, call int) piReply {
		if node == "up" {
			return piReply{status: 503}
		}
		return piReply{text: "RESULT-DOWN"}
	})
	h := newHarness(t, pi.server.URL)
	h.a.cfg.GraphNodeRetries = 2
	h.a.graphRetryUnit = 10 * time.Second
	c, tid, _ := h.register(t, "graph-retry-cancel@example.test")
	base := "/tenants/" + tid + "/canvases/" + retryCanvas(t, h, c, tid) + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "graph-retry-cancel", "documentVersion": 1}, 202)["id"].(string)
	path := base + "/" + gid
	awaitGraphNode(t, h, c, path, "up", func(n map[string]any) bool { return n["detail"] == "retrying" })
	// The scheduler passes over the node every 70 ms; none of those passes admits it before its retry_at.
	time.Sleep(500 * time.Millisecond)
	graph := h.request(t, c, "GET", path, nil, 200)
	if calls := pi.seen(); !slices.Equal(calls, []string{"up#1"}) {
		t.Fatal("admitted before its retry was due", calls)
	}
	runs := sessionRuns(t, h, tid, gid, "up")
	up := graphNodeResult(t, graph, "up")
	if graph["status"] != "running" || up["state"] != "waiting" || up["attempts"] != float64(1) || len(runs) != 1 || up["runId"] != runs[0].id || runs[0].status != "failed" {
		t.Fatalf("waiting for its retry: %v %+v", up, runs)
	}
	var due time.Time
	if e := h.db.QueryRow(context.Background(), "SELECT retry_at FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id='up'", tid, gid).Scan(&due); e != nil || time.Until(due) < 5*time.Second {
		t.Fatal("retry not due after its backoff", due, e)
	}
	if down := graphNodeResult(t, graph, "down"); down["state"] != "waiting" || down["runId"] != nil {
		t.Fatal(down)
	}
	if exp := graphExperiences(t, h, tid, gid, "up"); len(exp) != 1 || exp[0].outcome != "pending" {
		t.Fatalf("%+v", exp)
	}
	h.request(t, c, "POST", path+"/cancel", map[string]any{}, 200)
	done := awaitGraph(t, h, c, path, "cancelled")
	up = graphNodeResult(t, done, "up")
	if up["state"] != "cancelled" || up["detail"] != "Graph cancelled" || up["attempts"] != float64(1) || len(up["attemptLog"].([]any)) != 1 {
		t.Fatal(up)
	}
	if down := graphNodeResult(t, done, "down"); down["state"] != "cancelled" {
		t.Fatal(down)
	}
	var retryAt *time.Time
	if e := h.db.QueryRow(context.Background(), "SELECT retry_at FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id='up'", tid, gid).Scan(&retryAt); e != nil || retryAt != nil {
		t.Fatal("a cancelled node keeps a retry time", retryAt, e)
	}
	if exp := graphExperiences(t, h, tid, gid, "up"); len(exp) != 1 || exp[0].outcome != "failed" || exp[0].detail["nodeState"] != "cancelled" {
		t.Fatalf("%+v", exp)
	}
	// Even with the retry made due at once, a cancelled graph never runs the node again.
	if _, e := h.db.Exec(context.Background(), "UPDATE graph_run_nodes SET retry_at=now() WHERE tenant_id=$1 AND graph_id=$2", tid, gid); e != nil {
		t.Fatal(e)
	}
	h.a.dispatchGraph(tid, gid)
	time.Sleep(300 * time.Millisecond)
	if calls := pi.seen(); !slices.Equal(calls, []string{"up#1"}) || len(sessionRuns(t, h, tid, gid, "up")) != 1 {
		t.Fatal("a cancelled retry ran", calls)
	}
}

// An interrupted child (its executor was lost, so whether its provider answered is unknown) and a cancelled one are
// never retried, whatever the limit: the orphan is settled without replay as before.
func TestPostgresGraphNeverRetriesInterruptedOrCancelledChildren(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "UNEXPECTED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.GraphNodeRetries = 5
	h.a.graphRetryUnit = 10 * time.Millisecond
	c, tid, actor := h.register(t, "retry-orphan@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	gid, _ := seedUnprojectedGraph(t, h, tid, cid, actor, doc, map[string]string{"a": "running", "b": "cancelled"})
	h.a.dispatchGraph(tid, gid)
	done := awaitGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs/"+gid, "interrupted")
	if a := graphNodeResult(t, done, "a"); a["state"] != "failed" || a["detail"] != "interrupted" || a["attempts"] != float64(0) {
		t.Fatal(a)
	}
	if b := graphNodeResult(t, done, "b"); b["state"] != "cancelled" || b["attempts"] != float64(0) {
		t.Fatal(b)
	}
	time.Sleep(100 * time.Millisecond)
	var experiences int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM canvas_experiences WHERE tenant_id=$1", tid).Scan(&experiences); e != nil || experiences != 0 || calls.Load() != 0 {
		t.Fatal("an interrupted or cancelled child ran again", experiences, calls.Load(), e)
	}
}

// A media node follows the same rule with its media codes: a provider that kept failing to answer is tried again with a
// new generation, admitted and counted like the first, while a generation the provider charged for and failed is not.
func TestPostgresGraphMediaNodeRetries(t *testing.T) {
	h, rh := newMediaHarness(t)
	h.a.cfg.GraphNodeRetries = 2
	h.a.graphRetryUnit = 20 * time.Millisecond
	rh.set(nil, func(task string, n int) (int, any) {
		switch task {
		case "task-1":
			return 503, map[string]any{"error": "upstream unavailable"}
		case "task-3":
			return 200, map[string]any{"taskId": task, "status": "FAILED"}
		}
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.png")
	})
	c, tid, _ := h.register(t, "media-retry@example.test")
	base := "/tenants/" + tid
	cid, canvas := mediaCanvas(t, h, c, tid, mediaDraftNode("img", "rh.seedream-v5-pro", "a red bicycle on a beach"))
	// The provider accepted the first generation, then stopped answering about it: it may well charge for it, so the
	// node is not sent again (a retry pays twice only when the provider provably charged nothing).
	graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	gid := graph["id"].(string)
	done := awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+gid, "failed", 15*time.Second)
	img := graphNodeResult(t, done, "img")
	if img["state"] != "failed" || img["detail"] != "media_provider_unavailable" || img["attempts"] != float64(0) || len(img["attemptLog"].([]any)) != 0 {
		t.Fatal(img)
	}
	if submits, _ := rh.counts(); submits != 1 || len(graphExperiences(t, h, tid, gid, "img")) != 0 {
		t.Fatal("an accepted generation was sent again", submits)
	}
	graph = h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	gid = graph["id"].(string)
	done = awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+gid, "completed", 15*time.Second)
	if img = graphNodeResult(t, done, "img"); img["state"] != "done" || img["attempts"] != float64(0) {
		t.Fatal(img)
	}
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("generations submitted", submits)
	}
	// A refusal at admission is not a run's failure: past the daily allowance the node fails at once, paying nothing.
	h.a.cfg.MediaRunsPerDay = 2
	refused := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	refusedDone := awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+refused["id"].(string), "failed")
	if n := graphNodeResult(t, refusedDone, "img"); n["detail"] != "media_quota_exceeded" || n["attempts"] != float64(0) || n["runId"] != nil {
		t.Fatal("refused at admission", n)
	}
	if submits, _ := rh.counts(); submits != 2 || len(graphExperiences(t, h, tid, refused["id"].(string), "img")) != 0 {
		t.Fatal("an admission refusal was retried", submits)
	}
	h.a.cfg.MediaRunsPerDay = 50
	var counted int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM media_generations g WHERE g.tenant_id=$1 AND "+generationCounts, tid).Scan(&counted); e != nil || counted != 2 {
		t.Fatal("each generation is counted once", counted, e)
	}

	// The provider accepted, charged and failed the third generation: running it again could pay twice.
	graph = h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	gid = graph["id"].(string)
	done = awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+gid, "failed", 15*time.Second)
	img = graphNodeResult(t, done, "img")
	if img["state"] != "failed" || img["detail"] != "media_failed" || img["attempts"] != float64(0) {
		t.Fatal(img)
	}
	if submits, _ := rh.counts(); submits != 3 {
		t.Fatal("a charged generation was submitted again", submits)
	}
	// What makes a failed generation free to run again: the provider ended it uncharged, refused it, or it was never sent.
	failed := img["runId"].(string)
	if h.a.mediaRunUnbilled(t.Context(), tid, failed) {
		t.Fatal("an accepted generation reads as unbilled")
	}
	for _, update := range []string{"provider_accepted=false", "provider_accepted=NULL,provider_refused=true", "provider_accepted=NULL,provider_refused=false,submitted_at=NULL"} {
		if _, e := h.db.Exec(t.Context(), "UPDATE media_generations SET "+update+" WHERE tenant_id=$1 AND run_id=$2", tid, failed); e != nil {
			t.Fatal(e)
		}
		if !h.a.mediaRunUnbilled(t.Context(), tid, failed) {
			t.Fatal("not unbilled after", update)
		}
	}
	// Sent, with no answer either way: it may have been charged.
	if _, e := h.db.Exec(t.Context(), "UPDATE media_generations SET provider_accepted=NULL,provider_refused=false,submitted_at=now() WHERE tenant_id=$1 AND run_id=$2", tid, failed); e != nil {
		t.Fatal(e)
	}
	if h.a.mediaRunUnbilled(t.Context(), tid, failed) {
		t.Fatal("a generation whose outcome is unknown reads as unbilled")
	}
}
