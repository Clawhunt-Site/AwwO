package app

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const workspaceSnapshotField = "__workspace_snapshot"
const maxWorkspaceFileBytes = 2 << 20
const maxWorkspaceInputBytes = 8 << 20
const maxWorkspaceWireBytes = 16 << 20
const defaultWorkspaceModelCalls = 32
const maxWorkspaceModelCalls = 64

type workspaceCapability struct {
	Version       int  `json:"version"`
	Available     bool `json:"available"`
	MaxModelCalls int  `json:"maxModelCalls"`
}
type workspacePlan struct {
	Version       int                   `json:"version"`
	MaxModelCalls int                   `json:"maxModelCalls"`
	OutputFields  []outputContractField `json:"outputFields"`
	Inputs        []workspaceFile       `json:"inputs,omitempty"`
}
type workspaceFile struct {
	Name         string `json:"name"`
	Content      string `json:"content"`
	Encoding     string `json:"encoding"`
	SHA256       string `json:"sha256"`
	SourceNodeID string `json:"sourceNodeId,omitempty"`
	FieldID      string `json:"fieldId,omitempty"`
}
type workspaceRequest struct {
	Version       int                   `json:"version"`
	ID            string                `json:"id"`
	MaxModelCalls int                   `json:"maxModelCalls"`
	CallbackURL   string                `json:"callbackURL"`
	CallbackToken string                `json:"callbackToken"`
	Inputs        []workspaceFile       `json:"inputs"`
	OutputFields  []outputContractField `json:"outputFields"`
	Snapshot      *workspaceFile        `json:"snapshot,omitempty"`
}

type workspaceActivity struct {
	Step int    `json:"step"`
	Tool string `json:"tool"`
}

func validWorkspaceActivity(step int, tool string) bool {
	if step < 1 || step > maxWorkspaceModelCalls {
		return false
	}
	switch tool {
	case "workspace_list", "workspace_read", "workspace_write", "workspace_exec", "workspace_publish", "workspace_archive":
		return true
	}
	return false
}

// Only bounded, closed tool labels leave the internal event stream. Neither
// snapshot files nor callback credentials or tool arguments enter this response.
func (a *App) projectRunExecution(ctx context.Context, tid, rid string, raw json.RawMessage) (json.RawMessage, error) {
	var kind string
	// A snapshot may contain megabytes of bounded input files. Poll only this
	// small projection, and keep malformed historical snapshots readable.
	if err := a.db.QueryRow(ctx, `SELECT CASE
	 WHEN jsonb_typeof(execution_snapshot->'team')='object' THEN 'team'
	 WHEN jsonb_typeof(execution_snapshot->'workspace')='object' AND execution_snapshot->>'runtime'='openai-agents' THEN 'workspace'
	 ELSE 'text' END FROM runs WHERE tenant_id=$1 AND id=$2`, tid, rid).Scan(&kind); err != nil {
		return nil, err
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	out["executionKind"], _ = json.Marshal(kind)
	if kind == "workspace" {
		rows, err := a.db.Query(ctx, "SELECT data FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND data->>'type'='workspace_activity' ORDER BY id DESC LIMIT 65", tid, rid)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []workspaceActivity{}
		for rows.Next() {
			var data []byte
			if err = rows.Scan(&data); err != nil {
				return nil, err
			}
			var item workspaceActivity
			if json.Unmarshal(data, &item) == nil && validWorkspaceActivity(item.Step, item.Tool) {
				items = append(items, item)
			}
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
		truncated := len(items) > 64
		if truncated {
			items = items[:64]
		}
		for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
			items[i], items[j] = items[j], items[i]
		}
		out["workspaceActivity"], _ = json.Marshal(map[string]any{"items": items, "truncated": truncated})
	}
	return json.Marshal(out)
}

func validWorkspaceCallbackURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/api/internal/workspace-calls" || u.RawPath != "" {
		return false
	}
	port, err := strconv.Atoi(u.Port())
	return err == nil && port > 0 && port <= 65535 && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
}
func validWorkspaceCapability(runtime string, c *workspaceCapability) bool {
	return runtime == runtimeOpenAIAgents && c != nil && c.Version == 1 && c.Available && c.MaxModelCalls >= 2 && c.MaxModelCalls <= maxWorkspaceModelCalls
}

// The generic runtime also has turn limits, but only project execution carries
// this workspace budget. Do not give ordinary runs or teams a project-only error.
func workspaceRuntimeFailureCode(workerCode string, contract bool) string {
	switch workerCode {
	case "MODEL_CALL_LIMIT", "MaxTurnsExceeded", "MaxTurnsExceededError":
		return "workspace_step_limit"
	default:
		return runtimeFailureCode(workerCode, contract)
	}
}

func (a *App) requireWorkspaceSnapshot(s executionSnapshot) error {
	if a.cfg.WorkspaceCallbackURL != "" && s.Runtime == runtimeOpenAIAgents && s.Team == nil && s.Workspace == nil {
		return setupError{"workspace_unavailable", "The project sandbox is unavailable; restore it before running this node"}
	}
	return nil
}
func graphWorkspaceOutputPolicy(n graphNode) string {
	policy := graphOutputPolicy(n)
	if i := strings.LastIndex(policy, "\nFor a `file` output,"); i >= 0 {
		policy = policy[:i]
	}
	if hasFileOutput(n) {
		policy += "\nCreate and test actual files in the project workspace. For every required file output call workspace_publish({field:<exact output field ID>,path:<actual workspace-relative file>}) or workspace_archive({field:<exact output field ID>}) for a project ZIP. These trusted tools read the real bytes. In final JSON leave published file fields as empty string placeholders; the trusted runtime replaces them with the verified file content. Do not fabricate file content, paths, receipts or base64. Each published file is limited to 2 MiB, with 8 MiB across all file outputs."
	}
	return policy
}
func workspaceGraphPrompt(prompt, policy string) string {
	if i := strings.LastIndex(prompt, outputFormatMarker); i >= 0 {
		return prompt[:i] + outputFormatMarker + policy + "\n\n请按本节点职责完成任务，并按声明的格式给出最终输出。"
	}
	return prompt
}

func workspaceOutputFields(n graphNode) []outputContractField {
	fields := []outputContractField{}
	if n.Contract != nil {
		for _, f := range n.Contract.Outputs {
			fields = append(fields, outputContractField{ID: f.ID, Type: f.Type, Required: f.Required})
		}
	}
	return fields
}
func workspaceOutputNode(fields []outputContractField) graphNode {
	n := graphNode{}
	if len(fields) > 0 {
		n.Contract = &graphContract{Version: 1}
		for _, f := range fields {
			n.Contract.Outputs = append(n.Contract.Outputs, graphField{ID: f.ID, Type: f.Type, Required: f.Required})
		}
	}
	return n
}
func workspaceFileBytes(f workspaceFile) ([]byte, error) {
	if _, err := artifactName(f.Name); err != nil || f.Encoding != "base64" || len(f.Content) > base64.StdEncoding.EncodedLen(maxWorkspaceFileBytes) {
		return nil, errors.New("invalid_workspace_file")
	}
	b, err := base64.StdEncoding.Strict().DecodeString(f.Content)
	if err != nil || len(b) > maxWorkspaceFileBytes {
		return nil, errors.New("invalid_workspace_file")
	}
	sum := sha256.Sum256(b)
	if f.SHA256 != hex.EncodeToString(sum[:]) {
		return nil, errors.New("workspace_file_hash_mismatch")
	}
	return b, nil
}
func validWorkspaceZIP(data []byte) bool {
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(z.File) > 1024 {
		return false
	}
	seen := map[string]bool{}
	directories := map[string]bool{}
	skipped := map[string]bool{"node_modules": true, ".git": true, ".venv": true, "__pycache__": true, ".pytest_cache": true, ".mypy_cache": true}
	var total uint64
	for _, f := range z.File {
		name := strings.TrimSuffix(f.Name, "/")
		if name == "" || len(name) > 1024 || !utf8.ValidString(name) || strings.ContainsAny(name, "\\") || seen[name] || f.Flags&1 != 0 || (f.Method != zip.Store && f.Method != zip.Deflate) || (!f.Mode().IsRegular() && !f.Mode().IsDir()) || f.UncompressedSize64 > maxWorkspaceFileBytes {
			return false
		}
		for _, r := range name {
			if r < 32 || r == 127 {
				return false
			}
		}
		for _, part := range strings.Split(name, "/") {
			if part == "" || part == "." || part == ".." || len(part) > 255 || skipped[part] {
				return false
			}
		}
		seen[name] = true
		directories[name] = f.Mode().IsDir()
		total += f.UncompressedSize64
		if total > 32<<20 {
			return false
		}
		reader, err := f.Open()
		if err != nil {
			return false
		}
		n, readErr := io.Copy(io.Discard, io.LimitReader(reader, maxWorkspaceFileBytes+1))
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil || uint64(n) != f.UncompressedSize64 || n > maxWorkspaceFileBytes {
			return false
		}
	}
	// A file cannot also be a parent directory of another entry.
	for _, f := range z.File {
		parts := strings.Split(strings.TrimSuffix(f.Name, "/"), "/")
		for i := 1; i < len(parts); i++ {
			parent := strings.Join(parts[:i], "/")
			if seen[parent] && !directories[parent] {
				return false
			}
		}
	}
	return true
}
func encodedWorkspaceFile(name string, content []byte) workspaceFile {
	sum := sha256.Sum256(content)
	return workspaceFile{Name: name, Content: base64.StdEncoding.EncodeToString(content), Encoding: "base64", SHA256: hex.EncodeToString(sum[:])}
}

// No callback credential or caller supplied path survives into persisted snapshots.
// The ephemeral lease exists only while the exact admitted run is executing.
type workspaceCall struct {
	id          string
	facts       *invocationFacts
	status      string
	settledHash string
	settling    bool
}
type workspaceLease struct {
	mu                         sync.Mutex
	ctx                        context.Context
	tenantID, runID, sessionID string
	snapshot                   executionSnapshot
	calls                      []*workspaceCall
	rejected                   bool
	closed                     bool
	stopping                   bool
	settleUntil                time.Time
	changed                    chan struct{}
}

func (a *App) registerWorkspaceLease(ctx context.Context, tid, rid, sid string, snap executionSnapshot) (*workspaceLease, string, func()) {
	l := &workspaceLease{ctx: ctx, tenantID: tid, runID: rid, sessionID: sid, snapshot: snap, changed: make(chan struct{}, 1)}
	token := randomID() + randomID()
	key := tokenHash(token)
	a.workspaceLeases.Store(key, l)
	return l, token, func() { l.mu.Lock(); l.closed = true; l.mu.Unlock(); a.workspaceLeases.Delete(key) }
}
func (l *workspaceLease) sealSuccess() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.rejected || l.stopping || l.ctx.Err() != nil || len(l.calls) == 0 {
		return false
	}
	for _, c := range l.calls {
		if c.status != "completed" {
			return false
		}
	}
	l.closed = true
	return true
}

// Stop new provider calls immediately, but retain the lease briefly so a call
// already sent to the provider can report its real usage after cancellation.
// Any remaining running rows are finalized as unknown by finishOnce.
func (l *workspaceLease) drain(cancelWorker func(), grace time.Duration) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.stopping = true
	if l.settleUntil.IsZero() {
		l.settleUntil = time.Now().Add(grace)
	}
	deadline := l.settleUntil
	l.mu.Unlock()
	cancelWorker()
	timer := time.NewTimer(max(time.Until(deadline), 0))
	defer timer.Stop()
	for {
		l.mu.Lock()
		pending := false
		for _, call := range l.calls {
			pending = pending || call.status == "running"
		}
		l.mu.Unlock()
		if !pending {
			return
		}
		select {
		case <-l.changed:
		case <-timer.C:
			return
		}
	}
}

// Every permission is consumed once. A lost admit response must stop the worker;
// repeating it cannot authorize another provider call with the same ledger row.
func (a *App) workspaceCallback(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") || len(auth) > 256 || r.Header.Get("Origin") != "" {
		fail(w, 401, "workspace_lease_invalid", "Workspace authorization is unavailable")
		return
	}
	item, ok := a.workspaceLeases.Load(tokenHash(strings.TrimPrefix(auth, "Bearer ")))
	if !ok {
		fail(w, 401, "workspace_lease_invalid", "Workspace authorization is unavailable")
		return
	}
	l := item.(*workspaceLease)
	var b struct {
		Operation     string          `json:"operation"`
		Index         int             `json:"index"`
		Status        string          `json:"status,omitempty"`
		Observability json.RawMessage `json:"observability,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 12288)
	if !a.decode(w, r, &b) {
		l.mu.Lock()
		l.rejected = true
		l.mu.Unlock()
		return
	}
	l.mu.Lock()
	locked := true
	defer func() {
		if locked {
			l.mu.Unlock()
		}
	}()
	reject := func(status int, code, message string) { l.rejected = true; fail(w, status, code, message) }
	if l.closed || (l.stopping && !time.Now().Before(l.settleUntil)) {
		reject(409, "workspace_lease_expired", "Workspace run is no longer active")
		return
	}
	if b.Index < 1 || b.Index > l.snapshot.Workspace.MaxModelCalls {
		reject(429, "workspace_call_limit", "Workspace model call budget exhausted")
		return
	}
	switch b.Operation {
	case "admit":
		if l.rejected || l.stopping || l.ctx.Err() != nil {
			reject(409, "workspace_lease_expired", "Workspace run is no longer active")
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		stop := context.AfterFunc(l.ctx, cancel)
		defer stop()
		if b.Status != "" || len(b.Observability) > 0 || b.Index != len(l.calls)+1 || (len(l.calls) > 0 && l.calls[len(l.calls)-1].status != "completed") {
			reject(409, "workspace_call_order", "Model calls must be admitted and settled in order")
			return
		}
		f := invocationMetadata(l.snapshot, nil)
		f.RequirePersonalConnection = a.cfg.UserCredentials
		id := "w" + tokenHash(fmt.Sprintf("%s\x00%s\x00%d", l.tenantID, l.runID, b.Index))[:40]
		if err := a.reserveInvocation(ctx, l.tenantID, l.runID, id, l.snapshot.Model, f); err != nil {
			reject(403, "workspace_admission_denied", "Execution permission or quota is unavailable")
			return
		}
		call := &workspaceCall{id: id, facts: f, status: "running"}
		l.calls = append(l.calls, call)
		// Persist the possibility of a paid call before returning permission.
		if err := a.markInvocationAdmission(ctx, l.tenantID, id, f, "unknown"); err != nil {
			reject(503, "workspace_accounting_failed", "Could not record model admission")
			return
		}
		writeJSON(w, 200, map[string]any{"admitted": true, "index": b.Index})
	case "settle":
		if b.Index > len(l.calls) || (b.Status != "completed" && b.Status != "failed" && b.Status != "cancelled") || len(b.Observability) > 8192 {
			reject(400, "invalid_workspace_settlement", "Invalid model settlement")
			return
		}
		call := l.calls[b.Index-1]
		if call.settling {
			reject(409, "workspace_call_settling", "Model invocation settlement is in progress")
			return
		}
		serialized, _ := json.Marshal(b)
		hash := tokenHash(string(serialized))
		if call.status != "running" {
			if call.settledHash == hash {
				writeJSON(w, 200, map[string]any{"settled": true, "index": b.Index})
				return
			}
			reject(409, "workspace_call_settled", "Model invocation is already settled")
			return
		}
		call.facts.receive(b.Observability, a.cfg.RunTimeout)
		call.facts.Admission = "accepted"
		call.settling = true
		deadline := time.Now().Add(10 * time.Second)
		if !l.settleUntil.IsZero() && l.settleUntil.Before(deadline) {
			deadline = l.settleUntil
		}
		// Receipt persistence is independent of the run/request cancellation.
		// Release the lease lock during bounded DB writes so drain can expire.
		ctx, cancel := context.WithDeadline(context.WithoutCancel(r.Context()), deadline)
		defer cancel()
		l.mu.Unlock()
		locked = false
		var metric func()
		err := a.persistExecutionContext(ctx, func(ctx context.Context) error {
			tx, e := a.db.Begin(ctx)
			if e != nil {
				return e
			}
			defer tx.Rollback(ctx)
			metric, e = a.settleInvocation(ctx, tx, l.tenantID, call.id, b.Status, "", call.facts)
			if e != nil {
				return e
			}
			return tx.Commit(ctx)
		})
		l.mu.Lock()
		locked = true
		call.settling = false
		if err != nil {
			reject(503, "workspace_accounting_failed", "Could not record model settlement")
			return
		}
		if metric != nil {
			metric()
		}
		call.status = b.Status
		call.settledHash = hash
		select {
		case l.changed <- struct{}{}:
		default:
		}
		writeJSON(w, 200, map[string]any{"settled": true, "index": b.Index})
	default:
		reject(400, "invalid_workspace_operation", "Unknown workspace accounting operation")
	}
}

// The worker retains its decrypted key across turns; deleting or narrowing the
// user's connection must therefore fence the next provider call, under the same
// transaction that reserves its invocation. FOR SHARE serializes key revocation.
func (a *App) requireWorkspacePersonalConnection(ctx context.Context, tx pgx.Tx, actor, runtime, selector string) error {
	match := connectionSelectorPattern.FindStringSubmatch(selector)
	if actor == "" || match == nil {
		return errors.New("personal_credential_unavailable")
	}
	var provider string
	var raw []byte
	if err := tx.QueryRow(ctx, "SELECT provider,models FROM user_connections WHERE id=$1 AND user_id=$2 AND runtime=$3 FOR SHARE", match[1], actor, runtime).Scan(&provider, &raw); err != nil {
		return errors.New("personal_credential_unavailable")
	}
	p, ok := providerByID(provider)
	var models []string
	if !ok || !a.personalProviderAllowed(provider) || !connectionSupports(p, runtime) || json.Unmarshal(raw, &models) != nil {
		return errors.New("personal_model_unavailable")
	}
	for _, model := range models {
		if personalTextModel(model) && connectionModelID(match[1], model) == selector {
			return nil
		}
	}
	return errors.New("personal_model_unavailable")
}

// Read only artifacts selected by the frozen graph's incoming file edges. Names,
// tenant, canvas, producer node and field must all agree with the durable artifact.
func materializeWorkspaceInputs(ctx context.Context, tx pgx.Tx, tid, gid, nid string) ([]workspaceFile, error) {
	var cid string
	var raw []byte
	if err := tx.QueryRow(ctx, "SELECT canvas_id,document FROM graph_runs WHERE tenant_id=$1 AND id=$2", tid, gid).Scan(&cid, &raw); err != nil {
		return nil, err
	}
	var d graphDocument
	if json.Unmarshal(raw, &d) != nil {
		return nil, errors.New("invalid_workspace_graph")
	}
	nodes := map[string]graphNode{}
	for _, n := range d.Nodes {
		nodes[n.ID] = n
	}
	inputs := []workspaceFile{}
	total := 0
	seen := map[string]bool{}
	for _, edge := range d.Edges {
		if edge.ToNode != nid || edge.DataType != "file" {
			continue
		}
		src, ok := nodes[edge.FromNode]
		if !ok {
			return nil, errors.New("invalid_workspace_graph")
		}
		var output, state string
		if err := tx.QueryRow(ctx, "SELECT state,output FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3", tid, gid, src.ID).Scan(&state, &output); err != nil {
			return nil, err
		}
		if state != "done" && state != "cached" {
			return nil, errors.New("workspace_input_not_ready")
		}
		vals, err := graphOutput(src, output)
		if err != nil {
			return nil, err
		}
		field := strings.TrimPrefix(edge.FromPort, "out:")
		ref := vals[field]
		if strings.TrimSpace(ref) == "" && optionalWorkspaceFile(src, field, false) && optionalWorkspaceFile(nodes[nid], strings.TrimPrefix(edge.ToPort, "in:"), true) {
			continue
		}
		if !strings.HasPrefix(ref, artifactRefPrefix) || field == workspaceSnapshotField {
			return nil, errors.New("workspace_input_not_stored")
		}
		id := strings.TrimPrefix(ref, artifactRefPrefix)
		if seen[id] {
			continue
		}
		seen[id] = true
		if len(inputs) >= 8 {
			return nil, errors.New("workspace_input_limit")
		}
		var name, hash string
		var data []byte
		err = tx.QueryRow(ctx, "SELECT name,content,sha256 FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 AND node_id=$4 AND field_id=$5 AND size<=$6", tid, cid, id, src.ID, field, maxWorkspaceFileBytes).Scan(&name, &data, &hash)
		if err != nil {
			return nil, errors.New("workspace_input_unavailable")
		}
		if _, err = artifactName(name); err != nil {
			return nil, err
		}
		display := name
		for len(display) > maxArtifactNameLen-13 {
			_, width := utf8.DecodeLastRuneInString(display)
			display = display[:len(display)-width]
		}
		f := encodedWorkspaceFile(tokenHash(src.ID + "\x00" + field)[:12]+"-"+display, data)
		if f.SHA256 != hash {
			return nil, errors.New("workspace_input_hash_mismatch")
		}
		f.SourceNodeID = src.ID
		f.FieldID = field
		total += len(data)
		if total > maxWorkspaceInputBytes {
			return nil, errors.New("workspace_input_limit")
		}
		inputs = append(inputs, f)
	}
	return inputs, nil
}

func optionalWorkspaceFile(n graphNode, field string, input bool) bool {
	if n.Contract == nil {
		return false
	}
	fields := n.Contract.Outputs
	if input {
		fields = n.Contract.Inputs
	}
	for _, f := range fields {
		if f.ID == field {
			return f.Type == "file" && !f.Required
		}
	}
	return false
}
func (a *App) previousWorkspaceSnapshot(ctx context.Context, tid, sid string) (*workspaceFile, error) {
	var data []byte
	var hash string
	err := a.db.QueryRow(ctx, `SELECT a.content,a.sha256 FROM artifacts a JOIN runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE a.tenant_id=$1 AND r.session_id=$2 AND r.status='completed' AND a.field_id=$3 AND a.canvas_id=s.canvas_id AND a.node_id=s.node_id AND a.size<=$4 ORDER BY r.updated_at DESC,r.id DESC LIMIT 1`, tid, sid, workspaceSnapshotField, maxWorkspaceFileBytes).Scan(&data, &hash)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	f := encodedWorkspaceFile("workspace.zip", data)
	if f.SHA256 != hash || !validWorkspaceZIP(data) {
		return nil, errors.New("workspace_snapshot_hash_mismatch")
	}
	return &f, nil
}
func storeWorkspaceSnapshot(ctx context.Context, tx pgx.Tx, tid, rid, sid string, f workspaceFile) error {
	data, err := workspaceFileBytes(f)
	if err != nil || f.Name != "workspace.zip" || !validWorkspaceZIP(data) {
		return errors.New("invalid_workspace_snapshot")
	}
	var cid, nid string
	if err = tx.QueryRow(ctx, "SELECT canvas_id,node_id FROM node_sessions WHERE tenant_id=$1 AND id=$2 AND kind='node'", tid, sid).Scan(&cid, &nid); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`, artifactID(tid, rid, nid, workspaceSnapshotField), tid, cid, rid, nid, workspaceSnapshotField, f.Name, len(data), f.SHA256, data)
	return err
}

func (a *App) executeWorkspace(ctx context.Context, tid, rid, sid, prompt, instructions, kind string, snap executionSnapshot) {
	var closeWorkspace func()
	failRun := func(code string) {
		if closeWorkspace != nil {
			closeWorkspace()
		}
		status := "failed"
		if s, c, ended := runContextOutcome(ctx); ended {
			status, code = s, c
		}
		a.finish(tid, rid, status, "", code)
	}
	p := snap.Workspace
	if kind == "planner" || kind == "knowledge" || snap.Team != nil || snap.Runtime != runtimeOpenAIAgents || p == nil || p.Version != 1 || p.MaxModelCalls < 2 || p.MaxModelCalls > maxWorkspaceModelCalls || snap.OutputContract != nil || !validWorkspaceCallbackURL(a.cfg.WorkspaceCallbackURL) || !validWorkspaceCapability(snap.Runtime, snap.Health.Workspace) || p.MaxModelCalls > snap.Health.Workspace.MaxModelCalls {
		failRun("workspace_unavailable")
		return
	}
	if len(p.OutputFields) > 0 && !validOutputContract(&outputContract{Version: 1, Fields: p.OutputFields}) {
		failRun("invalid_workspace_contract")
		return
	}
	previous, err := a.previousWorkspaceSnapshot(ctx, tid, sid)
	if err != nil {
		failRun("workspace_restore_failed")
		return
	}
	lease, token, closeLease := a.registerWorkspaceLease(ctx, tid, rid, sid, snap)
	defer closeLease()
	var cancelOnce sync.Once
	cancelWorker := func() { cancelOnce.Do(func() { a.cancelRuntime(snap.Runtime, rid) }) }
	closeWorkspace = func() {
		lease.drain(cancelWorker, 12*time.Second)
		closeLease()
	}
	inputs := p.Inputs
	if inputs == nil {
		inputs = []workspaceFile{}
	}
	total := 0
	for _, f := range inputs {
		data, e := workspaceFileBytes(f)
		if e != nil {
			failRun("workspace_input_invalid")
			return
		}
		total += len(data)
	}
	if len(inputs) > 8 || total > maxWorkspaceInputBytes {
		failRun("workspace_input_limit")
		return
	}
	fields := p.OutputFields
	if fields == nil {
		fields = []outputContractField{}
	}
	work := workspaceRequest{Version: 1, ID: tokenHash(tid + "\x00" + sid), MaxModelCalls: p.MaxModelCalls, CallbackURL: a.cfg.WorkspaceCallbackURL, CallbackToken: token, Inputs: inputs, OutputFields: fields, Snapshot: previous}
	history := []json.RawMessage{}
	if snap.History != nil {
		history = *snap.History
	} else {
		history, err = rowsJSON(ctx, a.db, "SELECT jsonb_build_object('role',role,'content',content) FROM (SELECT m.role,m.content,m.created_at,m.id FROM messages m JOIN runs r ON r.tenant_id=m.tenant_id AND r.id=m.run_id WHERE m.tenant_id=$1 AND m.session_id=$2 AND r.id<>$3 AND r.status='completed' ORDER BY m.created_at DESC,m.id DESC LIMIT 100) m ORDER BY created_at,id", tid, sid, rid)
		if err != nil {
			failRun("history_unavailable")
			return
		}
	}
	instructions = taskFrameSystemPrompt(instructions, snap.TaskFrame)
	history = boundedHistoryWithLimits(history, len(prompt)+len(instructions), snap.Budget, snap.Overhead)
	request := map[string]any{"runId": rid, "tenantId": tid, "sessionId": sid, "prompt": prompt, "messages": history, "systemPrompt": instructions, "model": snap.Model, "runtime": snap.Runtime, "workspace": work}
	if snap.Effort != "" {
		request["effort"] = snap.Effort
	}
	body, err := json.Marshal(request)
	if err != nil || len(body) > maxWorkspaceWireBytes {
		failRun("workspace_input_limit")
		return
	}
	terminal := false
	defer func() {
		if !terminal {
			cancelWorker()
		}
	}()
	resp, err := a.admitRuntime(ctx, snap.Runtime, body)
	if err != nil {
		failRun("runtime_unavailable")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		failRun("workspace_runtime_rejected")
		return
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), maxWorkspaceWireBytes+4096)
	var output strings.Builder
	var reasoning reasoningStream
	produced, activities := 0, 0
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var ev struct {
			Type              string         `json:"type"`
			Delta             string         `json:"delta"`
			Text              string         `json:"text"`
			Code              string         `json:"code"`
			Step              int            `json:"step"`
			Tool              string         `json:"tool"`
			WorkspaceSnapshot *workspaceFile `json:"workspaceSnapshot"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &ev) != nil {
			failRun("invalid_runtime_event")
			return
		}
		switch ev.Type {
		case "text_delta":
			if produced+len(ev.Delta) > maxWorkspaceWireBytes {
				failRun("output_limit")
				return
			}
			produced += len(ev.Delta)
			delta := reasoning.push(ev.Delta)
			output.WriteString(delta)
			if delta != "" && !a.appendDelta(ctx, tid, rid, delta) {
				failRun("event_persistence_failed")
				return
			}
		case "workspace_activity":
			activities++
			if ev.Step > p.MaxModelCalls || !validWorkspaceActivity(ev.Step, ev.Tool) || activities > p.MaxModelCalls*16 {
				failRun("invalid_runtime_event")
				return
			}
			data, _ := json.Marshal(map[string]any{"type": "workspace_activity", "step": ev.Step, "tool": ev.Tool})
			if _, err = a.db.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) SELECT tenant_id,id,$3 FROM runs WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, rid, data); err != nil {
				failRun("event_persistence_failed")
				return
			}
			a.notifyRunEvent(rid)
		case "completed":
			answer, delivered := reasoningAnswer(ev.Text)
			if !delivered {
				failRun("reasoning_only_output")
				return
			}
			if len(ev.Text) > maxWorkspaceWireBytes || !strings.HasPrefix(answer, output.String()) || strings.TrimSpace(ev.Text) == "" || ev.WorkspaceSnapshot == nil || ev.WorkspaceSnapshot.Name != "workspace.zip" {
				failRun("workspace_delivery_invalid")
				return
			}
			snapshotBytes, snapshotErr := workspaceFileBytes(*ev.WorkspaceSnapshot)
			if snapshotErr != nil || !validWorkspaceZIP(snapshotBytes) {
				failRun("workspace_snapshot_invalid")
				return
			}
			if _, _, err = graphOutputFiles(workspaceOutputNode(fields), answer); err != nil {
				failRun("workspace_delivery_invalid")
				return
			}
			if !lease.sealSuccess() {
				failRun("workspace_accounting_incomplete")
				return
			}
			// Closing the lease fences out further callbacks before publishing completion.
			closeLease()
			terminal = true
			facts := invocationMetadata(snap, nil)
			facts.WorkspaceSnapshot = ev.WorkspaceSnapshot
			a.finishWithFacts(tid, rid, "completed", answer, "", facts)
			return
		case "failed":
			failRun(workspaceRuntimeFailureCode(ev.Code, len(fields) > 0))
			return
		case "cancelled":
			closeWorkspace()
			a.finish(tid, rid, "cancelled", output.String(), "")
			return
		default:
			failRun("invalid_runtime_event")
			return
		}
	}
	failRun("runtime_stream_ended")
}

// Preserve binary bytes in bytea while legacy UTF-8 artifacts retain their rules.
func decodeArtifactContent(object map[string]any, content string) (string, error) {
	encoding, hasEncoding := object["encoding"]
	if !hasEncoding {
		if len(content) > maxArtifactBytes {
			return "", errors.New("text file exceeds size limit")
		}
		return content, nil
	}
	if encoding != "base64" || len(content) > base64.StdEncoding.EncodedLen(maxWorkspaceFileBytes) {
		return "", errors.New("invalid binary file encoding or size")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(content)
	if err != nil || len(decoded) > maxWorkspaceFileBytes {
		return "", errors.New("invalid binary file encoding or size")
	}
	return string(decoded), nil
}
