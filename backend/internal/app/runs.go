package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

type piHealth struct {
	Ready    bool           `json:"ready"`
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Status   string         `json:"status"`
	Limits   map[string]any `json:"limits"`
	Models   []piModel      `json:"models"`
}
type piModel struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Provider             string `json:"provider"`
	MaxContextTextBytes  int    `json:"maxContextTextBytes"`
	MessageOverheadBytes int    `json:"messageOverheadBytes"`
}

func (a *App) probePI(ctx context.Context) (piHealth, error) {
	var h piHealth
	if a.cfg.PIToken == "" {
		return h, errors.New("Pi service token is not configured")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(a.cfg.PIURL, "/")+"/health", nil)
	if e != nil {
		return h, e
	}
	resp, e := a.client.Do(req)
	if e != nil {
		return h, errors.New("Pi service is unavailable")
	}
	defer resp.Body.Close()
	if e = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&h); e != nil || resp.StatusCode != 200 || !h.Ready {
		return h, errors.New("Pi provider is not configured or available")
	}
	return h, nil
}
func (a *App) runtime(w http.ResponseWriter, r *http.Request) {
	h, e := a.probePI(r.Context())
	models := []map[string]string{}
	if h.Model != "" {
		models = append(models, map[string]string{"id": h.Model, "provider": h.Provider})
	}
	if len(h.Models) > 0 {
		models = []map[string]string{}
		for _, m := range h.Models {
			models = append(models, map[string]string{"id": m.ID, "name": m.Name, "provider": m.Provider, "runtime": "pi"})
		}
	}
	v := map[string]any{"engine": "pi", "configured": a.cfg.PIToken != "" && h.Ready, "available": e == nil, "plannerAvailable": e == nil, "models": models, "modelConnectivityVerified": false, "limits": h.Limits}
	if e != nil {
		v["reason"] = e.Error()
	}
	writeJSON(w, 200, v)
}
func (a *App) listRuns(w http.ResponseWriter, r *http.Request) {
	a.tenantList(w, r, "runs")
}
func (a *App) getRun(w http.ResponseWriter, r *http.Request) {
	v, e := oneJSON(r.Context(), a.db, "SELECT "+runJSON+" FROM runs WHERE tenant_id=$1 AND id=$2", r.PathValue("tenantId"), r.PathValue("id"))
	a.replyOne(w, v, e, 200)
}

type runInput struct {
	SessionID   string `json:"sessionId"`
	Prompt      string `json:"prompt"`
	OperationID string `json:"operationId"`
}

func (a *App) createRun(w http.ResponseWriter, r *http.Request) {
	var b runInput
	if !a.decode(w, r, &b) {
		return
	}
	if b.OperationID == "" {
		b.OperationID = r.Header.Get("Idempotency-Key")
	}
	if b.SessionID == "" || strings.TrimSpace(b.Prompt) == "" || len(b.Prompt) > 128000 || len(b.OperationID) < 8 || len(b.OperationID) > 200 {
		fail(w, 400, "invalid_input", "Session, prompt (up to 128000 bytes) and operationId (8–200 bytes) required")
		return
	}
	body, _ := json.Marshal(struct{ SessionID, Prompt string }{b.SessionID, b.Prompt})
	hash := tokenHash(string(body))
	tid := r.PathValue("tenantId")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var concurrent, daily int
	if e = tx.QueryRow(r.Context(), "SELECT max_concurrent_runs,max_runs_per_day FROM tenants WHERE id=$1", tid).Scan(&concurrent, &daily); e != nil {
		a.dbError(w, e)
		return
	}
	var oldHash string
	e = tx.QueryRow(r.Context(), "SELECT request_hash FROM runs WHERE tenant_id=$1 AND operation_id=$2", tid, b.OperationID).Scan(&oldHash)
	if e == nil {
		if oldHash != hash {
			fail(w, 409, "idempotency_conflict", "operationId was used with different parameters")
			return
		}
		v, e := oneJSON(r.Context(), tx, "SELECT "+runJSON+" FROM runs WHERE tenant_id=$1 AND operation_id=$2", tid, b.OperationID)
		a.replyOne(w, v, e, 200)
		return
	}
	if !noRows(e) {
		a.dbError(w, e)
		return
	}
	var active, today int
	if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM runs WHERE tenant_id=$1 AND status IN ('queued','running')", tid).Scan(&active); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", tid).Scan(&today); e != nil {
		a.dbError(w, e)
		return
	}
	if active >= concurrent || today >= daily {
		fail(w, 429, "quota_exceeded", "Workspace run quota exceeded")
		return
	}
	var model, instructions, kind string
	e = tx.QueryRow(r.Context(), `SELECT a.model,a.instructions,s.kind FROM node_sessions s JOIN agents a ON a.tenant_id=s.tenant_id AND a.id=s.agent_id JOIN canvases c ON c.tenant_id=s.tenant_id AND c.id=s.canvas_id WHERE s.tenant_id=$1 AND s.id=$2 AND (s.kind='planner' OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) n WHERE n->>'id'=s.node_id AND (COALESCE(n->'binding'->>'agentId','')='' OR n->'binding'->>'agentId'=s.agent_id) AND (COALESCE(n->'binding'->>'companyId','')='' OR n->'binding'->>'companyId'=s.tenant_id))) FOR UPDATE OF s`, tid, b.SessionID).Scan(&model, &instructions, &kind)
	if noRows(e) {
		fail(w, 404, "not_found", "Session, agent or canvas node not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	var busy bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM runs WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','running'))", tid, b.SessionID).Scan(&busy); e != nil {
		a.dbError(w, e)
		return
	}
	if busy {
		fail(w, 409, "session_busy", "This session already has an active run")
		return
	}
	health, e := a.probePI(r.Context())
	if e != nil {
		fail(w, 503, "runtime_unavailable", e.Error())
		return
	}
	budget, overhead := health.contextLimits()
	if _, _, ok := health.modelLimits(model); !ok {
		fail(w, 409, "model_unavailable", "Agent model differs from the configured Pi model")
		return
	}
	var document []byte
	var nodeID string
	if e = tx.QueryRow(r.Context(), "SELECT c.document,s.node_id FROM node_sessions s JOIN canvases c ON c.tenant_id=s.tenant_id AND c.id=s.canvas_id WHERE s.tenant_id=$1 AND s.id=$2", tid, b.SessionID).Scan(&document, &nodeID); e != nil {
		a.dbError(w, e)
		return
	}
	team, e := savedNodeTeam(document, nodeID)
	if e != nil {
		fail(w, 400, "invalid_team", e.Error())
		return
	}
	if e = validateTeamModels(team, health); e != nil {
		fail(w, 400, "invalid_team", e.Error())
		return
	}
	if model == "" {
		model = health.Model
	}
	budget, overhead, _ = health.modelLimits(model)
	if team == nil && len(b.Prompt)+len(instructions)+overhead > budget {
		fail(w, 413, "context_limit", "Prompt and instructions exceed the configured model context budget")
		return
	}
	snapshot := executionSnapshot{Instructions: instructions, Model: model, Budget: budget, Overhead: overhead, Team: team, Health: health}
	if team != nil {
		history, available, err := completedTeamHistory(r.Context(), tx, tid, b.SessionID)
		if err != nil {
			a.dbError(w, err)
			return
		}
		snapshot.History, snapshot.HistoryAvailable = &history, available
	}
	id := randomID()
	v, e := oneJSON(r.Context(), tx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,$5,$6,'queued') RETURNING "+runJSON, id, tid, b.SessionID, b.OperationID, hash, b.Prompt)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = saveRunSnapshot(r.Context(), tx, tid, id, currentUser(r).ID, snapshot); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'user',$5)", randomID(), tid, b.SessionID, id, b.Prompt); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, `{"type":"queued"}`); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "run.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	// Provider health and database waits may outlive the worker's lease. Refuse
	// known loss before committing admission; this is not a distributed fence
	// against an undetected physical loss in the remaining commit interval.
	if !a.workerAvailable(w) {
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.dispatch(tid, id, b.SessionID, b.Prompt, instructions, kind, budget, overhead)
	writeJSON(w, 202, v)
}
func (a *App) dispatch(tid, id, sid, prompt, instructions, kind string, budget, overhead int) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), a.cfg.RunTimeout)
	a.running[id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer cancel()
		defer func() { a.mu.Lock(); delete(a.running, id); a.mu.Unlock() }()
		a.execute(ctx, tid, id, sid, prompt, instructions, kind, budget, overhead)
		// Every accepted child must become terminal even if execution returned
		// before provider admission or after a failed persistence operation.
		a.finish(tid, id, "interrupted", "", "execution_interrupted")
	}()
}
func (a *App) execute(ctx context.Context, tid, id, sid, prompt, instructions, kind string, budget, overhead int) {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		a.finish(tid, id, "failed", "", "database_unavailable")
		return
	}
	defer tx.Rollback(context.Background())
	tag, e := tx.Exec(ctx, "UPDATE runs SET status='running',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='queued'", tid, id)
	if e != nil || tag.RowsAffected() == 0 {
		return
	}
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, `{"type":"running"}`); e != nil {
		return
	}
	if e = tx.Commit(ctx); e != nil {
		return
	}
	var snapshot executionSnapshot
	var snapshotRaw []byte
	if e = a.db.QueryRow(ctx, "SELECT execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&snapshotRaw); e != nil {
		a.finish(tid, id, "failed", "", "snapshot_unavailable")
		return
	}
	if json.Unmarshal(snapshotRaw, &snapshot) != nil {
		a.finish(tid, id, "failed", "", "snapshot_invalid")
		return
	}
	if snapshot.Team != nil {
		a.executeTeam(ctx, tid, id, sid, prompt, snapshot)
		return
	}
	if e = a.reserveInvocation(ctx, tid, id, id); e != nil {
		a.finish(tid, id, "failed", "", e.Error())
		return
	}
	defer a.settleRunInvocation(tid, id)
	var history []json.RawMessage
	if snapshot.History != nil {
		history = *snapshot.History
	} else {
		history, e = rowsJSON(ctx, a.db, "SELECT jsonb_build_object('role',m.role,'content',m.content) FROM (SELECT m.role,m.content,m.created_at,m.id FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.tenant_id=$1 AND m.session_id=$2 AND m.run_id<>$3 AND r.status='completed' ORDER BY m.created_at DESC,m.id DESC LIMIT 100) m ORDER BY m.created_at,m.id", tid, sid, id)
	}
	if e != nil {
		a.finish(tid, id, "failed", "", "history_unavailable")
		return
	}
	if kind == "planner" {
		history = []json.RawMessage{}
	} else {
		history = boundedHistoryWithLimits(history, len(prompt)+len(instructions), budget, overhead)
	}
	body, e := json.Marshal(map[string]any{"runId": id, "tenantId": tid, "sessionId": sid, "prompt": prompt, "messages": history, "systemPrompt": instructions, "model": snapshot.Model, "runtime": "pi"})
	if e != nil {
		a.finish(tid, id, "failed", "", "invalid_request")
		return
	}
	resp, e := a.admitPI(ctx, body)
	if e != nil {
		if errors.Is(e, errSessionBusy) {
			a.finish(tid, id, "failed", "", "runtime_session_busy")
		} else if ctx.Err() != nil {
			a.finish(tid, id, "cancelled", "", "")
		} else {
			a.finish(tid, id, "failed", "", "runtime_unavailable")
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		code := "runtime_rejected"
		if resp.StatusCode == 413 {
			code = "context_limit"
		}
		a.finish(tid, id, "failed", "", code)
		return
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	var output strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var ev struct {
			Type    string `json:"type"`
			Delta   string `json:"delta"`
			Text    string `json:"text"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &ev) != nil {
			a.finish(tid, id, "failed", output.String(), "invalid_runtime_event")
			return
		}
		switch ev.Type {
		case "text_delta":
			if output.Len()+len(ev.Delta) > 2<<20 {
				a.finish(tid, id, "failed", output.String(), "output_limit")
				return
			}
			output.WriteString(ev.Delta)
			// Structured proposals are emitted only after schema validation and
			// normalization; unvalidated token fragments are not a canvas plan.
			if kind == "planner" {
				continue
			}
			if !a.appendDelta(ctx, tid, id, ev.Delta) {
				a.finish(tid, id, "failed", output.String(), "event_persistence_failed")
				return
			}
		case "completed":
			if !strings.HasPrefix(ev.Text, output.String()) {
				a.finish(tid, id, "failed", output.String(), "inconsistent_runtime_output")
				return
			}
			if len(ev.Text) > 2<<20 {
				a.finish(tid, id, "failed", output.String(), "output_limit")
				return
			}
			if ev.Text != "" {
				output.Reset()
				output.WriteString(ev.Text)
			}
			a.finish(tid, id, "completed", output.String(), "")
			return
		case "failed":
			a.finish(tid, id, "failed", output.String(), "runtime_failed")
			return
		case "cancelled":
			a.finish(tid, id, "cancelled", output.String(), "")
			return
		default:
			a.finish(tid, id, "failed", output.String(), "invalid_runtime_event")
			return
		}
	}
	if ctx.Err() != nil {
		status := "cancelled"
		code := ""
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			status = "failed"
			code = "run_timeout"
		}
		a.finish(tid, id, status, output.String(), code)
	} else {
		a.finish(tid, id, "failed", output.String(), "runtime_stream_ended")
	}
}
func (a *App) appendDelta(ctx context.Context, tid, id, delta string) bool {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return false
	}
	defer tx.Rollback(ctx)
	tag, e := tx.Exec(ctx, "UPDATE runs SET output=output||$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, delta)
	if e != nil || tag.RowsAffected() == 0 {
		return false
	}
	data, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": delta})
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, data); e != nil {
		return false
	}
	return tx.Commit(ctx) == nil
}
func (a *App) finish(tid, id, status, output, code string) {
	if e := a.persistExecution(func(ctx context.Context) error {
		return a.finishOnce(ctx, tid, id, status, output, code)
	}); e != nil {
		a.log.Error("run finalization interrupted; restart recovery required", "runId", id)
	}
}

// Persistence retries only database writes; it never replays a provider request.
// Shutdown or loss of our single-worker lease stops retrying. Start recovers the
// remaining uncertain records before allowing another invocation.
func (a *App) persistExecution(write func(context.Context) error) error {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := write(ctx)
		cancel()
		if err == nil {
			return nil
		}
		a.mu.Lock()
		closed := a.closed
		a.mu.Unlock()
		if closed {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (a *App) finishOnce(ctx context.Context, tid, id, status, output, code string) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var sid string
	if status == "completed" {
		var kind string
		if e = tx.QueryRow(ctx, "SELECT s.kind FROM runs r JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE r.tenant_id=$1 AND r.id=$2", tid, id).Scan(&kind); e != nil {
			if noRows(e) {
				return nil
			}
			return e
		}
		if kind == "planner" {
			if !validatePlan(output) {
				status = "failed"
				code = "invalid_canvas_plan"
			} else {
				output = normalizePlanJSON(output)
			}
		}
	}
	e = tx.QueryRow(ctx, "UPDATE runs SET status=$3,output=CASE WHEN $4='' THEN output ELSE $4 END,error=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING session_id,output", tid, id, status, output, code).Scan(&sid, &output)
	if noRows(e) {
		if e = tx.QueryRow(ctx, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status); e != nil {
			if noRows(e) {
				return nil
			}
			return e
		}
		if e = settleExecutionRecords(ctx, tx, tid, id, status); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	if e != nil {
		return e
	}
	event := map[string]string{"type": status}
	if status == "completed" {
		event["text"] = output
		if _, e = tx.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'assistant',$5)", randomID(), tid, sid, id, output); e != nil {
			return e
		}
	}
	if status == "failed" {
		event["code"] = code
		event["message"] = "Pi execution failed"
	}
	data, _ := json.Marshal(event)
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, data); e != nil {
		return e
	}
	if e = settleExecutionRecords(ctx, tx, tid, id, status); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func settleExecutionRecords(ctx context.Context, tx pgx.Tx, tid, id, status string) error {
	// Completed member records are immutable; only abandoned active records need
	// reconciliation after the execution goroutine has stopped calling providers.
	if _, e := tx.Exec(ctx, "UPDATE run_turns SET status=$3,error=CASE WHEN $3='interrupted' THEN 'execution_interrupted' ELSE error END,updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND status IN ('queued','running')", tid, id, status); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "UPDATE model_invocations SET status=$3,updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND status='running'", tid, id, status)
	return e
}
func (a *App) cancelRun(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var exists bool
	e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM runs WHERE tenant_id=$1 AND id=$2)", tid, id).Scan(&exists)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Run not found")
		return
	}
	tag, e := tx.Exec(r.Context(), "UPDATE runs SET status='cancelled',error='',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')", tid, id)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if tag.RowsAffected() > 0 {
		if _, e = tx.Exec(r.Context(), "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, `{"type":"cancelled"}`); e != nil {
			a.dbError(w, e)
			return
		}
		if e = audit(r.Context(), tx, currentUser(r).ID, tid, "run.cancelled", id); e != nil {
			a.dbError(w, e)
			return
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.cancelExecution(id)
	a.getRun(w, r)
}
func (a *App) cancelExecution(id string) {
	a.mu.Lock()
	cancel := a.running[id]
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	ctx, done := context.WithTimeout(context.Background(), 2*time.Second)
	defer done()
	req, e := http.NewRequestWithContext(ctx, "DELETE", strings.TrimRight(a.cfg.PIURL, "/")+"/internal/runs/"+id, nil)
	if e != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.PIToken)
	resp, e := a.client.Do(req)
	if e == nil {
		resp.Body.Close()
	}
}
func (a *App) events(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	cursor := int64(0)
	s := r.Header.Get("Last-Event-ID")
	if s == "" {
		s = r.URL.Query().Get("after")
	}
	if s != "" {
		v, e := strconv.ParseInt(s, 10, 64)
		if e != nil || v < 0 {
			fail(w, 400, "invalid_cursor", "Invalid event cursor")
			return
		}
		cursor = v
	}
	var status string
	if e := a.db.QueryRow(r.Context(), "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status); noRows(e) {
		fail(w, 404, "not_found", "Run not found")
		return
	} else if e != nil {
		a.dbError(w, e)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if e := controller.Flush(); e != nil {
		return
	}
	tick := time.NewTicker(150 * time.Millisecond)
	defer tick.Stop()
	heartbeat := time.NewTicker(a.reauthEvery)
	defer heartbeat.Stop()
	nextAuth := time.Now().Add(a.reauthEvery)
	checkAccess := func() bool {
		if time.Now().Before(nextAuth) {
			return true
		}
		var valid bool
		c, _ := r.Cookie("awwo_session")
		if c == nil {
			return false
		}
		e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM memberships m JOIN auth_sessions s ON s.user_id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND s.token_hash=$3 AND s.expires_at>now())", tid, currentUser(r).ID, tokenHash(c.Value)).Scan(&valid)
		nextAuth = time.Now().Add(a.reauthEvery)
		return e == nil && valid
	}
	for {
		if !checkAccess() {
			return
		}
		rows, e := a.db.Query(r.Context(), "SELECT id,data FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND id>$3 ORDER BY id LIMIT 100", tid, id, cursor)
		if e != nil {
			return
		}
		type replayEvent struct {
			id   int64
			data []byte
		}
		batch := []replayEvent{}
		for rows.Next() {
			var event replayEvent
			if e = rows.Scan(&event.id, &event.data); e != nil {
				rows.Close()
				return
			}
			batch = append(batch, event)
		}
		rows.Close()
		if rows.Err() != nil {
			return
		}
		// Release the database connection before network writes or reauthorization.
		// Backlog replay must obey the same deadline as an idle/live stream.
		for _, event := range batch {
			if !checkAccess() {
				return
			}
			cursor = event.id
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, e = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", cursor, event.data); e != nil {
				return
			}
		}
		count := len(batch)
		if !checkAccess() {
			return
		}
		if count > 0 {
			if e = controller.Flush(); e != nil {
				return
			}
		}
		if !checkAccess() {
			return
		}
		if count == 100 {
			continue
		}
		if e = a.db.QueryRow(r.Context(), "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status); e != nil {
			return
		}
		if status != "queued" && status != "running" {
			var more bool
			if e = a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND id>$3)", tid, id, cursor).Scan(&more); e != nil || !more {
				return
			}
			continue
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		case <-heartbeat.C:
			if !checkAccess() {
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, e = fmt.Fprint(w, ": heartbeat\n\n"); e != nil {
				return
			}
			if e = controller.Flush(); e != nil {
				return
			}
		}
	}
}

// Keep the most recent complete conversation pairs; provider context windows
// still depend on the selected model. The current prompt is never truncated.
func boundedHistory(history []json.RawMessage, currentBytes int) []json.RawMessage {
	return boundedHistoryWithLimits(history, currentBytes, 262144, 0)
}
func boundedHistoryWithLimits(history []json.RawMessage, currentBytes, budget, overhead int) []json.RawMessage {
	if budget > 262144 {
		budget = 262144
	}
	budget -= currentBytes + overhead
	total := 0
	start := len(history)
	for i := len(history) - 2; i >= 0; i -= 2 {
		pair := 2 * overhead
		valid := true
		for _, raw := range history[i : i+2] {
			var m struct {
				Content string `json:"content"`
			}
			if json.Unmarshal(raw, &m) == nil {
				if len(utf16.Encode([]rune(m.Content))) > 32768 {
					valid = false
				}
				pair += len(m.Content)
			}
		}
		if !valid || total+pair > budget {
			break
		}
		total += pair
		start = i
	}
	return history[start:]
}

func (h piHealth) contextLimits() (int, int) {
	budget, overhead := 262144, 0
	if n, ok := h.Limits["maxContextTextBytes"].(float64); ok && n >= 0 && n < 262144 {
		budget = int(n)
	}
	if n, ok := h.Limits["messageOverheadBytes"].(float64); ok && n >= 0 && n <= 1024 {
		overhead = int(n)
	}
	return budget, overhead
}

var errSessionBusy = errors.New("Pi session cleanup did not finish within admission wait")

// SESSION_BUSY is an explicit rejection before Pi registers this runId or starts
// a child. Only that response may be retried. Network errors, RUN_BUSY, capacity
// errors and streams already accepted with HTTP 200 are never retried here.
func (a *App) admitPI(ctx context.Context, body []byte) (*http.Response, error) {
	deadline := time.Now().Add(a.cfg.PIAdmissionWait)
	delay := 50 * time.Millisecond
	for {
		req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(a.cfg.PIURL, "/")+"/internal/runs", bytes.NewReader(body))
		if e != nil {
			return nil, e
		}
		req.Header.Set("Authorization", "Bearer "+a.cfg.PIToken)
		req.Header.Set("Content-Type", "application/json")
		resp, e := a.client.Do(req)
		if e != nil {
			return nil, e
		}
		if resp.StatusCode != 409 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			return resp, nil
		}
		var rejection struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if e = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&rejection); e != nil || rejection.Error.Code != "SESSION_BUSY" {
			return resp, nil
		}
		resp.Body.Close()
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, errSessionBusy
		}
		wait := delay
		if wait > remaining {
			wait = remaining
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		if time.Now().After(deadline) {
			return nil, errSessionBusy
		}
		if delay < 250*time.Millisecond {
			delay *= 2
			if delay > 250*time.Millisecond {
				delay = 250 * time.Millisecond
			}
		}
	}
}
