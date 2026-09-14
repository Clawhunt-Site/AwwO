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
	Tools    []runtimeTool  `json:"tools,omitempty"`
}
type runtimeTool struct {
	ID               string `json:"id"`
	ContextTextBytes int    `json:"contextTextBytes"`
}
type piModel struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Provider             string `json:"provider"`
	ProviderModel        string `json:"providerModel,omitempty"`
	Protocol             string `json:"protocol,omitempty"`
	Runtime              string `json:"runtime"`
	MaxContextTextBytes  int    `json:"maxContextTextBytes"`
	MessageOverheadBytes int    `json:"messageOverheadBytes"`
}

func (a *App) probePI(ctx context.Context) (piHealth, error) { return a.probeRuntime(ctx, runtimePI) }
func (a *App) runtime(w http.ResponseWriter, r *http.Request) {
	type discovery struct {
		h   piHealth
		err error
	}
	results := make(chan struct {
		runtime string
		discovery
	}, 2)
	for _, id := range []string{runtimePI, runtimeOpenAIAgents} {
		go func(id string) {
			h, err := a.probeRuntime(r.Context(), id)
			results <- struct {
				runtime string
				discovery
			}{id, discovery{h, err}}
		}(id)
	}
	found := map[string]discovery{}
	for range 2 {
		result := <-results
		found[result.runtime] = result.discovery
	}
	models, runtimes := []map[string]string{}, []map[string]any{}
	available, configured := false, false
	for _, id := range []string{runtimePI, runtimeOpenAIAgents} {
		result := found[id]
		h := result.h
		_, _, configError := a.runtimeEndpoint(id)
		descriptor := map[string]any{"id": id, "name": map[string]string{runtimePI: "Pi", runtimeOpenAIAgents: "OpenAI Agents"}[id], "configured": configError == nil, "available": result.err == nil, "supportsEffortSelection": false, "tools": enabledRuntimeTools(h, id)}
		if result.err != nil {
			descriptor["reason"] = result.err.Error()
		} else {
			descriptor["defaultModel"] = h.Model
			seen := map[string]bool{}
			for _, m := range h.Models {
				models = append(models, map[string]string{"id": m.ID, "name": m.Name, "provider": m.Provider, "runtime": id})
				seen[m.ID] = true
			}
			if !seen[h.Model] {
				models = append(models, map[string]string{"id": h.Model, "name": h.Model, "provider": h.Provider, "runtime": id})
			}
		}
		available = available || result.err == nil
		configured = configured || configError == nil
		runtimes = append(runtimes, descriptor)
	}
	pi := found[runtimePI]
	v := map[string]any{"engine": runtimePI, "configured": configured, "available": available, "plannerAvailable": pi.err == nil, "models": models, "runtimes": runtimes, "modelConnectivityVerified": false, "limits": pi.h.Limits}
	if !available {
		v["reason"] = "No configured runtime is available"
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
	// Admission shares the tenant lock with graph creation. A Session reserved
	// by a collaboration cannot accept an interleaved manual turn between phases.
	var reserved bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM graph_run_nodes n JOIN graph_runs g ON g.tenant_id=n.tenant_id AND g.id=n.graph_id WHERE n.tenant_id=$1 AND n.session_id=$2 AND g.collaboration IS NOT NULL AND g.status IN ('queued','running'))", tid, b.SessionID).Scan(&reserved); e != nil {
		a.dbError(w, e)
		return
	}
	if reserved {
		fail(w, 409, "resource_in_use", "This Session belongs to an active collaboration")
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
	var model, instructions, kind, runtime string
	e = tx.QueryRow(r.Context(), `SELECT a.model,a.instructions,s.kind,a.runtime FROM node_sessions s JOIN agents a ON a.tenant_id=s.tenant_id AND a.id=s.agent_id JOIN canvases c ON c.tenant_id=s.tenant_id AND c.id=s.canvas_id WHERE s.tenant_id=$1 AND s.id=$2 AND (s.kind='planner' OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) n WHERE n->>'id'=s.node_id AND (COALESCE(n->'binding'->>'agentId','')='' OR n->'binding'->>'agentId'=s.agent_id) AND (COALESCE(n->'binding'->>'companyId','')='' OR n->'binding'->>'companyId'=s.tenant_id))) FOR UPDATE OF s`, tid, b.SessionID).Scan(&model, &instructions, &kind, &runtime)
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
	if !savedRuntimeMatches(document, nodeID, runtime) {
		fail(w, 409, "node_setup_required", "Initialize the node to apply its changed runtime")
		return
	}
	snapshot, e := a.runtimeSnapshot(r.Context(), runtimeCatalog{}, runtime, model, instructions, team)
	if e != nil {
		a.runtimeAdmissionError(w, e)
		return
	}
	budget, overhead := snapshot.Budget, snapshot.Overhead
	if team == nil && len(b.Prompt)+len(instructions)+overhead > budget {
		fail(w, 413, "context_limit", "Prompt and instructions exceed the selected runtime context budget")
		return
	}
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
	a.dispatch(tid, id, b.SessionID, b.Prompt, instructions, kind, budget, overhead, r.Context())
	writeJSON(w, 202, v)
}
func (a *App) dispatch(tid, id, sid, prompt, instructions, kind string, budget, overhead int, parents ...context.Context) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	parent := context.Background()
	if len(parents) > 0 {
		parent = parents[0]
	}
	traceCtx, endTrace := a.startAsyncTrace(parent, "awwo.run.execute", kind, "unknown")
	ctx, cancel := context.WithTimeout(traceCtx, a.cfg.RunTimeout)
	a.running[id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer func() {
			c, done := context.WithTimeout(context.Background(), time.Second)
			defer done()
			outcome := "interrupted"
			_ = a.db.QueryRow(c, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&outcome)
			endTrace(outcome)
		}()
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
	var queuedAt time.Time
	e = tx.QueryRow(ctx, "UPDATE runs SET status='running',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='queued' RETURNING created_at", tid, id).Scan(&queuedAt)
	if e != nil {
		return
	}
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, `{"type":"running"}`); e != nil {
		return
	}
	if e = tx.Commit(ctx); e != nil {
		return
	}
	queueDuration := time.Since(queuedAt)
	if queueDuration < 0 {
		queueDuration = 0
	}
	a.observeQueue(kind, "started", queueDuration)
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
	facts := invocationMetadata(snapshot, nil)
	facts.Timing.QueueMs = int64ptr(queueDuration.Milliseconds())
	if e = a.reserveInvocation(ctx, tid, id, id, facts); e != nil {
		a.finish(tid, id, "failed", "", e.Error())
		return
	}
	finish := func(status, output, code string) { a.finishWithFacts(tid, id, status, output, code, facts) }
	var history []json.RawMessage
	if snapshot.History != nil {
		history = *snapshot.History
	} else {
		history, e = rowsJSON(ctx, a.db, "SELECT jsonb_build_object('role',m.role,'content',m.content) FROM (SELECT m.role,m.content,m.created_at,m.id FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.tenant_id=$1 AND m.session_id=$2 AND m.run_id<>$3 AND r.status='completed' ORDER BY m.created_at DESC,m.id DESC LIMIT 100) m ORDER BY m.created_at,m.id", tid, sid, id)
	}
	if e != nil {
		finish("failed", "", "history_unavailable")
		return
	}
	if kind == "planner" {
		history = []json.RawMessage{}
	} else {
		history = boundedHistoryWithLimits(history, len(prompt)+len(instructions), budget, overhead)
	}
	body, e := json.Marshal(map[string]any{"runId": id, "tenantId": tid, "sessionId": sid, "prompt": prompt, "messages": history, "systemPrompt": instructions, "model": snapshot.Model, "runtime": defaultRuntime(snapshot.Runtime)})
	if e != nil {
		finish("failed", "", "invalid_request")
		return
	}
	runtimeCompleted := false
	defer func() {
		if !runtimeCompleted {
			a.cancelRuntime(defaultRuntime(snapshot.Runtime), id)
		}
	}()
	if e = a.markInvocationAdmission(ctx, tid, id, facts, "unknown"); e != nil {
		if status, code, ended := runContextOutcome(ctx); ended {
			finish(status, "", code)
			return
		}
		finish("failed", "", "accounting_commit_failed")
		return
	}
	admissionStart := time.Now()
	resp, e := a.admitRuntime(ctx, defaultRuntime(snapshot.Runtime), body)
	facts.Timing.AdmissionMs = int64ptr(time.Since(admissionStart).Milliseconds())
	if errors.Is(e, errSessionBusy) {
		facts.Admission = "rejected_before_start"
	}
	if e != nil {
		if errors.Is(e, errSessionBusy) {
			finish("failed", "", "runtime_session_busy")
		} else if status, code, ended := runContextOutcome(ctx); ended {
			// An expired deadline here is a timeout, not a cancellation; reporting it as the latter
			// hid real admission timeouts behind a state that looks deliberate.
			finish(status, "", code)
		} else {
			finish("failed", "", "runtime_unavailable")
		}
		return
	}
	defer resp.Body.Close()
	facts.Admission = "accepted"
	if resp.StatusCode != http.StatusOK {
		facts.Admission = "unknown"
		if resp.StatusCode == 400 || resp.StatusCode == 401 || resp.StatusCode == 413 || resp.StatusCode == 422 || resp.StatusCode == 429 || resp.StatusCode == 503 {
			facts.Admission = "rejected_before_start"
		}
	}
	if e = a.markInvocationAdmission(ctx, tid, id, facts, facts.Admission); e != nil {
		if status, code, ended := runContextOutcome(ctx); ended {
			finish(status, "", code)
			return
		}
		finish("failed", "", "accounting_commit_failed")
		return
	}
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		code := "runtime_rejected"
		if resp.StatusCode == 413 {
			code = "context_limit"
		}
		finish("failed", "", code)
		return
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	var output strings.Builder
	// A reasoning model's scratchpad is removed from the deliverable but still
	// counted here, so the output cap stays a bound on what the provider actually
	// produced and a model that reasons past it still fails instead of running on.
	produced := 0
	var reasoning reasoningStream
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var ev struct {
			Type          string          `json:"type"`
			Delta         string          `json:"delta"`
			Text          string          `json:"text"`
			Code          string          `json:"code"`
			Message       string          `json:"message"`
			Observability json.RawMessage `json:"observability"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &ev) != nil {
			finish("failed", output.String(), "invalid_runtime_event")
			return
		}
		if ev.Type == "completed" || ev.Type == "failed" || ev.Type == "cancelled" {
			facts.receive(ev.Observability, a.cfg.RunTimeout)
		}
		switch ev.Type {
		case "text_delta":
			if produced+len(ev.Delta) > 2<<20 {
				finish("failed", output.String(), "output_limit")
				return
			}
			produced += len(ev.Delta)
			delta := reasoning.push(ev.Delta)
			output.WriteString(delta)
			// Structured proposals are emitted only after schema validation and
			// normalization; unvalidated token fragments are not a canvas plan.
			// A withheld delta has nothing to persist or replay either.
			if kind == "planner" || delta == "" {
				continue
			}
			if !a.appendDelta(ctx, tid, id, delta) {
				finish("failed", output.String(), "event_persistence_failed")
				return
			}
		case "completed":
			answer, delivered := reasoningAnswer(ev.Text)
			if !strings.HasPrefix(answer, output.String()) {
				finish("failed", output.String(), "inconsistent_runtime_output")
				return
			}
			if !delivered {
				// Only a scratchpad arrived. Storing it would leak model internals,
				// and completing with nothing would claim a deliverable that does
				// not exist, so neither the text nor a success is published.
				finish("failed", "", "reasoning_only_output")
				return
			}
			if len(ev.Text) > 2<<20 {
				finish("failed", output.String(), "output_limit")
				return
			}
			if answer != "" {
				output.Reset()
				output.WriteString(answer)
			}
			runtimeCompleted = true
			finish("completed", output.String(), "")
			return
		case "failed":
			finish("failed", output.String(), "runtime_failed")
			return
		case "cancelled":
			finish("cancelled", output.String(), "")
			return
		default:
			finish("failed", output.String(), "invalid_runtime_event")
			return
		}
	}
	if status, code, ended := runContextOutcome(ctx); ended {
		finish(status, output.String(), code)
	} else {
		finish("failed", output.String(), "runtime_stream_ended")
	}
}

// runContextOutcome reports how a run ended when its own context is what stopped it. Once the
// context is done, every subsequent database write fails too, so any step that writes must consult
// this before blaming the runtime: recording a user's cancellation as a runtime fault shows them a
// failure they caused deliberately and mislabels the invocation's accounting. Every single-run path
// here goes through it, including admission, so a deadline cannot be reported as a cancellation
// depending on which step noticed. The team path enforces the same rule through its own
// contextFailure closure, which additionally has to set the enclosing turn's status.
func runContextOutcome(ctx context.Context) (status, code string, ended bool) {
	if ctx.Err() == nil {
		return "", "", false
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "failed", "run_timeout", true
	}
	return "cancelled", "", true
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
	a.finishWithFacts(tid, id, status, output, code, nil)
}
func (a *App) finishWithFacts(tid, id, status, output, code string, facts *invocationFacts) {
	if e := a.persistExecution(func(ctx context.Context) error {
		return a.finishOnce(ctx, tid, id, status, output, code, facts)
	}); e != nil {
		a.log.Error("run finalization interrupted; restart recovery required", "event", "run_finalize_failed")
	}
}

// Persistence retries only database writes; it never replays a provider request.
// Shutdown or loss of our single-worker lease stops retrying. Start recovers the
// remaining uncertain records before allowing another invocation.
func (a *App) persistExecution(write func(context.Context) error) error {
	for attempt := 0; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		traceCtx, endCommit := a.startLedgerTrace(ctx, "invocation_terminal_commit")
		started := time.Now()
		err := write(traceCtx)
		outcome := "committed"
		dbOutcome := "success"
		if err != nil {
			outcome = "retryable_error"
			dbOutcome = "error"
			if attempt >= 4 {
				outcome = "permanent_error"
			}
		}
		a.observeLedger("invocation_terminal_commit", outcome)
		a.observeDB("invocation_terminal_commit", dbOutcome, time.Since(started))
		endCommit(outcome)
		cancel()
		if err == nil {
			return nil
		}
		a.mu.Lock()
		closed := a.closed
		a.mu.Unlock()
		if closed || attempt >= 4 {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (a *App) finishOnce(ctx context.Context, tid, id, status, output, code string, observations ...*invocationFacts) error {
	var facts *invocationFacts
	if len(observations) > 0 {
		facts = observations[0]
	}
	var committed func()
	var runChanged bool
	runKind, runRuntime := "unknown", "unknown"
	settle := func(tx pgx.Tx) error {
		if facts != nil {
			var err error
			committed, err = a.settleInvocation(ctx, tx, tid, id, status, code, facts)
			if err != nil {
				return err
			}
		}
		return settleExecutionRecords(ctx, tx, tid, id, status)
	}
	commit := func(tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		if committed != nil {
			committed()
		}
		if runChanged {
			a.observeRun(runKind, runRuntime, status)
		}
		return nil
	}
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
		if e = settle(tx); e != nil {
			return e
		}
		return commit(tx)
	}
	if e != nil {
		return e
	}
	runChanged = true
	var snapshotRaw json.RawMessage
	if e = tx.QueryRow(ctx, "SELECT CASE WHEN EXISTS(SELECT 1 FROM graph_run_nodes g WHERE g.tenant_id=r.tenant_id AND g.run_id=r.id) THEN 'graph' ELSE s.kind END,r.execution_snapshot FROM runs r JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE r.tenant_id=$1 AND r.id=$2", tid, id).Scan(&runKind, &snapshotRaw); e != nil {
		return e
	}
	var snap executionSnapshot
	if json.Unmarshal(snapshotRaw, &snap) == nil {
		runRuntime = snapshotRuntime(snap)
		if snap.Team != nil && runKind != "graph" {
			runKind = "team"
		}
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
	if e = settle(tx); e != nil {
		return e
	}
	return commit(tx)
}

func settleExecutionRecords(ctx context.Context, tx pgx.Tx, tid, id, status string) error {
	// Completed member records are immutable; only abandoned active records need
	// reconciliation after the execution goroutine has stopped calling providers.
	if _, e := tx.Exec(ctx, "UPDATE run_turns SET status=$3,error=CASE WHEN $3='interrupted' THEN 'execution_interrupted' ELSE error END,updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND status IN ('queued','running')", tid, id, status); e != nil {
		return e
	}
	return settleAbandonedInvocations(ctx, tx, tid, id, status)
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
	// The active single-Agent request or each team turn performs its own
	// bounded cleanup against the exact worker and submitted ID.
}

// A worker request is keyed by its submitted runId. Team members submit their turn
// ID, whereas a single-Agent request submits the public run ID.
func (a *App) cancelPI(id string) { a.cancelRuntime(runtimePI, id) }
func (a *App) cancelRuntime(runtime, id string) {
	endpoint, token, err := a.runtimeEndpoint(runtime)
	if err != nil {
		return
	}
	ctx, done := context.WithTimeout(context.Background(), 2*time.Second)
	defer done()
	req, e := http.NewRequestWithContext(ctx, "DELETE", endpoint+"/internal/runs/"+id, nil)
	if e != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
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
	return a.admitRuntime(ctx, runtimePI, body)
}
func (a *App) admitRuntime(ctx context.Context, runtime string, body []byte) (*http.Response, error) {
	endpoint, token, err := a.runtimeEndpoint(runtime)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(a.cfg.PIAdmissionWait)
	delay := 50 * time.Millisecond
	for {
		attemptStart := time.Now()
		var selector struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &selector)
		requestCtx, endAttempt := a.startInternalTrace(ctx, runtime, selector.Model)
		observe := func(outcome string) {
			a.observeAdmission(runtime, outcome, time.Since(attemptStart))
			endAttempt(outcome)
		}
		req, e := http.NewRequestWithContext(requestCtx, "POST", endpoint+"/internal/runs", bytes.NewReader(body))
		if e != nil {
			observe("rejected_invalid")
			return nil, e
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		a.injectWorkerTrace(req, runtime)
		resp, e := a.client.Do(req)
		if e != nil {
			observe("transport_unknown")
			return nil, e
		}
		if resp.StatusCode != 409 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			outcome := "rejected_invalid"
			if resp.StatusCode == 200 {
				outcome = "accepted"
			}
			if resp.StatusCode == 429 || resp.StatusCode == 503 {
				outcome = "rejected_capacity"
			}
			observe(outcome)
			return resp, nil
		}
		var rejection struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if e = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&rejection); e != nil || rejection.Error.Code != "SESSION_BUSY" {
			observe("rejected_busy")
			return resp, nil
		}
		observe("session_busy")
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
