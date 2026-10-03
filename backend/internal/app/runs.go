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
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type piHealth struct {
	Workspace *workspaceCapability `json:"workspace,omitempty"`

	Ready    bool           `json:"ready"`
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Status   string         `json:"status"`
	Limits   map[string]any `json:"limits"`
	Models   []piModel      `json:"models"`
	Tools    []runtimeTool  `json:"tools,omitempty"`
	// Allowed is the workspace model entitlement frozen with this catalog. nil
	// means unrestricted, so an omitted field keeps every persisted snapshot
	// decoding exactly as it did before. It travels inside execution snapshots so
	// a pinned catalog carries the entitlement it was admitted under, and
	// admission re-reads the live row before creating any child from it.
	Allowed *[]string `json:"allowedModels,omitempty"`
}
type runtimeTool struct {
	ID               string `json:"id"`
	ContextTextBytes int    `json:"contextTextBytes"`
}
type piModel struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Label                string `json:"label,omitempty"`
	Provider             string `json:"provider"`
	ProviderModel        string `json:"providerModel,omitempty"`
	Protocol             string `json:"protocol,omitempty"`
	Runtime              string `json:"runtime"`
	MaxContextTextBytes  int    `json:"maxContextTextBytes"`
	MessageOverheadBytes int    `json:"messageOverheadBytes"`
	// ReasoningEfforts is the closed set of reasoning-effort levels a worker
	// advertises for this model. Empty means the model accepts no explicit level,
	// so an effort on such a node is refused rather than silently dropped. The
	// default is display metadata only: it is never back-filled into a request.
	ReasoningEfforts       []string `json:"reasoningEfforts,omitempty"`
	DefaultReasoningEffort string   `json:"defaultReasoningEffort,omitempty"`
	// StructuredOutput reports that this model's own endpoint honours a json_schema
	// response format on its protocol. It is a property of the model, never of the
	// runtime, and it is omitted when false so a catalog without the capability
	// serializes exactly as it did before.
	StructuredOutput bool `json:"structuredOutput,omitempty"`
	// structuredOutputMalformed remembers a worker value that was neither a boolean
	// nor null, so the probe can record why the capability was cleared.
	structuredOutputMalformed bool
}

// UnmarshalJSON decodes a catalog model. Only a literal true sets StructuredOutput.
// Any other value leaves it false instead of failing the decode, so one malformed
// capability field cannot take down the runtime's whole catalog and every text run
// on it. Encoding is unchanged, which keeps catalogs and snapshots byte-identical.
func (m *piModel) UnmarshalJSON(b []byte) error {
	type plain piModel
	var v struct {
		plain
		StructuredOutput json.RawMessage `json:"structuredOutput"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*m = piModel(v.plain)
	raw := bytes.TrimSpace(v.StructuredOutput)
	m.StructuredOutput = bytes.Equal(raw, []byte("true"))
	m.structuredOutputMalformed = len(raw) > 0 && !m.StructuredOutput && !bytes.Equal(raw, []byte("false")) && !bytes.Equal(raw, []byte("null"))
	return nil
}

// supportsEffort reports whether model accepts the exact effort level. An empty
// effort is always acceptable: it means "no explicit setting", which every model
// supports because the provider then applies its own default.
func (h piHealth) supportsEffort(model, effort string) bool {
	if effort == "" {
		return true
	}
	for _, m := range h.Models {
		if m.ID == model {
			for _, level := range m.ReasoningEfforts {
				if level == effort {
					return true
				}
			}
			return false
		}
	}
	return false
}

func (h piHealth) supportsEffortSelection() bool {
	for _, m := range h.Models {
		if len(m.ReasoningEfforts) > 0 {
			return true
		}
	}
	return false
}

// supportsStructuredOutput requires an exact model id match. A model missing from
// the catalog never inherits the capability: an unknown id means the contract must
// be withheld, not sent to a model that would ignore the schema and deliver prose.
func (h piHealth) supportsStructuredOutput(model string) bool {
	for _, m := range h.Models {
		if m.ID == model {
			return m.StructuredOutput
		}
	}
	return false
}

func (a *App) probePI(ctx context.Context) (piHealth, error) { return a.probeRuntime(ctx, runtimePI) }

// The catalogue is workspace scoped because advertising is part of the
// entitlement: a model a workspace may not run must not be offered to it either,
// which is what lets one workspace hold a private model while others are
// restricted away from it.
func (a *App) runtime(w http.ResponseWriter, r *http.Request) {
	entitlement, e := tenantModelEntitlement(r.Context(), a.db, r.PathValue("tenantId"))
	if e != nil {
		a.dbError(w, e)
		return
	}
	a.runtimeCatalogue(w, r, entitlement)
}

// Worker discovery is separated from resolving whose entitlement applies so the
// two concerns stay independently testable.
func (a *App) runtimeCatalogue(w http.ResponseWriter, r *http.Request, entitlement modelEntitlement) {
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
	models, runtimes := []map[string]any{}, []map[string]any{}
	available, configured := false, false
	for _, id := range []string{runtimePI, runtimeOpenAIAgents} {
		result := found[id]
		h := entitlement.apply(result.h)
		_, _, configError := a.runtimeEndpoint(id)
		// Effort selection is a per-model fact taken from the worker catalog, so
		// the same runtime can advertise it for one profile and refuse it for another.
		// The picker treats the levels as a closed enum ("select"), never free text.
		descriptor := map[string]any{"id": id, "name": map[string]string{runtimePI: "Pi", runtimeOpenAIAgents: "OpenAI Agents"}[id], "configured": configError == nil, "available": result.err == nil, "supportsEffortSelection": result.err == nil && h.supportsEffortSelection(), "effortInputMode": "select", "tools": enabledRuntimeTools(h, id)}
		if id == runtimeOpenAIAgents && a.cfg.WorkspaceCallbackURL != "" {
			descriptor["workspace"] = &workspaceCapability{Version: 1, Available: false, MaxModelCalls: defaultWorkspaceModelCalls}
		}
		if result.err != nil {
			descriptor["reason"] = result.err.Error()
		} else {
			descriptor["defaultModel"] = h.defaultModel()
			if a.cfg.WorkspaceCallbackURL != "" && validWorkspaceCapability(id, h.Workspace) {
				descriptor["workspace"] = h.Workspace
			}
			seen := map[string]bool{}
			for _, m := range h.Models {
				efforts := []string{}
				if len(m.ReasoningEfforts) > 0 {
					efforts = append(efforts, m.ReasoningEfforts...)
				}
				model := map[string]any{"id": m.ID, "name": m.Name, "provider": m.Provider, "runtime": id, "reasoningEfforts": efforts, "defaultReasoningEffort": m.DefaultReasoningEffort}
				if m.Label != "" {
					model["label"] = m.Label
				}
				models = append(models, model)
				seen[m.ID] = true
			}
			// A legacy catalog may omit its own default. Offer it only when the
			// entitlement still resolves to it, never as an unfiltered fallback.
			if fallback := h.defaultModel(); fallback != "" && !seen[fallback] {
				models = append(models, map[string]any{"id": fallback, "name": fallback, "provider": h.Provider, "runtime": id, "reasoningEfforts": []string{}, "defaultReasoningEffort": ""})
			}
		}
		available = available || result.err == nil
		configured = configured || configError == nil
		runtimes = append(runtimes, descriptor)
	}
	pi := found[runtimePI]
	// configured/available stay service-level facts, but planning must not be
	// offered when this workspace has no model to plan with: the planner Agent
	// carries no explicit model, so an empty entitlement would fail at admission.
	plannerRuntime := runtimePI
	if a.cfg.UserCredentials {
		for _, id := range []string{runtimeOpenAIAgents, runtimePI} {
			if item := found[id]; item.err == nil && entitlement.apply(item.h).defaultModel() != "" {
				plannerRuntime = id
				break
			}
		}
	}
	selectedPlanner := found[plannerRuntime]
	planner := selectedPlanner.err == nil && entitlement.apply(selectedPlanner.h).defaultModel() != ""
	v := map[string]any{"engine": runtimePI, "configured": configured, "available": available, "plannerAvailable": planner, "plannerRuntime": plannerRuntime, "models": models, "runtimes": runtimes, "modelConnectivityVerified": false, "limits": pi.h.Limits}
	if !available {
		v["reason"] = "No configured runtime is available"
	} else if len(models) == 0 {
		v["reason"] = "No model is available to this workspace"
	}
	writeJSON(w, 200, v)
}
func (a *App) listRuns(w http.ResponseWriter, r *http.Request) {
	a.tenantList(w, r, "runs")
}
func (a *App) getRun(w http.ResponseWriter, r *http.Request) {
	tid, rid := r.PathValue("tenantId"), r.PathValue("id")
	v, e := oneJSON(r.Context(), a.db, "SELECT "+runJSON+" FROM runs WHERE tenant_id=$1 AND id=$2", tid, rid)
	if e == nil {
		v, e = a.projectRunExecution(r.Context(), tid, rid, v)
	}
	if e == nil {
		v, e = projectDeliveryRecord(r.Context(), a.db, tid, rid, v, "output")
	}
	a.replyOne(w, v, e, 200)
}

type runInput struct {
	SessionID            string   `json:"sessionId"`
	Prompt               string   `json:"prompt"`
	OperationID          string   `json:"operationId"`
	KnowledgeRevisionIDs []string `json:"knowledgeRevisionIds,omitempty"`
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
	body, _ := json.Marshal(struct {
		SessionID, Prompt    string
		KnowledgeRevisionIDs []string `json:",omitempty"`
	}{b.SessionID, b.Prompt, b.KnowledgeRevisionIDs})
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
	var restricted bool
	var allowed []string
	// The entitlement rides along with the quota read, so admission cannot resolve
	// a model without having loaded the workspace's allowlist first.
	if e = tx.QueryRow(r.Context(), "SELECT max_concurrent_runs,max_runs_per_day,allowed_models IS NOT NULL,COALESCE(allowed_models,'{}') FROM tenants WHERE id=$1", tid).Scan(&concurrent, &daily, &restricted, &allowed); e != nil {
		a.dbError(w, e)
		return
	}
	entitlement, e := newModelEntitlement(restricted, allowed)
	if e != nil {
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
		if e == nil {
			v, e = projectDeliveryRecord(r.Context(), tx, tid, "", v, "output")
		}
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
	if e = tx.QueryRow(r.Context(), "SELECT (SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+(SELECT count(*) FROM media_generations WHERE tenant_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')", tid).Scan(&today); e != nil {
		a.dbError(w, e)
		return
	}
	if active >= concurrent || today >= daily {
		fail(w, 429, "quota_exceeded", "Workspace run quota exceeded")
		return
	}
	var model, instructions, kind, runtime, effort, agentID, engine string
	e = tx.QueryRow(r.Context(), `SELECT a.model,a.instructions,s.kind,a.runtime,a.effort,a.id,a.engine FROM node_sessions s JOIN agents a ON a.tenant_id=s.tenant_id AND a.id=s.agent_id JOIN canvases c ON c.tenant_id=s.tenant_id AND c.id=s.canvas_id WHERE s.tenant_id=$1 AND s.id=$2 AND (s.kind IN ('planner','knowledge','computer') OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) n WHERE n->>'id'=s.node_id AND (COALESCE(n->'binding'->>'agentId','')='' OR n->'binding'->>'agentId'=s.agent_id) AND (COALESCE(n->'binding'->>'companyId','')='' OR n->'binding'->>'companyId'=s.tenant_id))) FOR UPDATE OF s`, tid, b.SessionID).Scan(&model, &instructions, &kind, &runtime, &effort, &agentID, &engine)
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
	if kind == "planner" || kind == "knowledge" || kind == "computer" {
		// Internal service sessions cannot inherit a user-authored node that happens
		// to reuse the reserved node id, persona, team, or task frame.
		document, nodeID = []byte(`{}`), ""
	} else if engine == agentEngineMedia {
		// Image and video nodes run through the media provider, not a model worker.
		a.createMediaRun(w, r, tx, tid, b, hash, document, nodeID, model, entitlement)
		return
	}
	team, e := savedNodeTeam(document, nodeID)
	if e != nil {
		fail(w, 400, "invalid_team", e.Error())
		return
	}
	if err := validateSavedWorkspaceAgent(document, nodeID, agentID); err != nil {
		input := err.(setupError)
		status := 400
		if input.code == "node_setup_required" {
			status = 409
		}
		fail(w, status, input.code, input.message)
		return
	}
	if !savedRuntimeMatches(document, nodeID, runtime) {
		fail(w, 409, "node_setup_required", "Initialize the node to apply its changed runtime")
		return
	}
	catalog := runtimeCatalog{}
	if (kind == "planner" || kind == "knowledge") && a.cfg.UserCredentials {
		// A planner session is shared with its canvas, but its model credential is
		// always the current actor's. Never write a personal selector into that Agent.
		runtime, model, e = a.personalPlanner(r.Context(), entitlement, catalog)
		if e != nil {
			a.runtimeAdmissionError(w, e)
			return
		}
		effort = ""
	}
	snapshot, e := a.runtimeSnapshot(r.Context(), entitlement, catalog, runtime, model, effort, instructions, team)
	if e != nil {
		a.runtimeAdmissionError(w, e)
		return
	}
	if kind == "planner" || kind == "knowledge" || kind == "computer" {
		snapshot.Workspace = nil
	} else if e = a.requireWorkspaceSnapshot(snapshot); e != nil {
		a.runtimeAdmissionError(w, e)
		return
	}
	if e = validateWorkspaceAgentSession(r.Context(), tx, tid, b.SessionID, nodeID, document, snapshot); e != nil {
		a.workspaceAgentAdmissionError(w, e)
		return
	}
	snapshot.TaskFrame, e = savedNodeTaskFrame(document, nodeID)
	if e != nil {
		fail(w, 400, "invalid_task_frame", e.Error())
		return
	}
	if kind == "computer" {
		var owner string
		if e = tx.QueryRow(r.Context(), "SELECT actor_id FROM computer_sessions WHERE tenant_id=$1 AND session_id=$2", tid, b.SessionID).Scan(&owner); e != nil || owner != currentUser(r).ID {
			fail(w, 403, "computer_owner_required", "Only the task owner can execute this session")
			return
		}
		// Managed execution makes non-streaming completion calls, which the Bedrock bridge does
		// not serve; refuse such a model here instead of after an invocation is reserved.
		if snapshot.Health.modelProvider(snapshot.Model) == "bedrock" {
			fail(w, 400, "computer_model_unsupported", "Managed execution cannot use this model")
			return
		}
		snapshot.Computer = &computerPlan{Version: 1, MaxModelCalls: 16}
		history := []json.RawMessage{}
		snapshot.History = &history
	}
	budget, overhead := snapshot.Budget, snapshot.Overhead
	snapshot.Knowledge, e = freezeKnowledgeContext(r.Context(), tx, tid, b.KnowledgeRevisionIDs)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	framedInstructions := knowledgeSystemPrompt(taskFrameSystemPrompt(instructions, snapshot.TaskFrame), snapshot.Knowledge)
	framedPrompt := knowledgeUserPrompt(b.Prompt, snapshot.Knowledge)
	if team == nil && (len(framedPrompt) > 128000 || len(framedPrompt)+len(framedInstructions)+overhead > budget || ((snapshot.TaskFrame != nil || snapshot.Knowledge != nil) && len(utf16.Encode([]rune(framedInstructions))) > 32768)) {
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
	a.notifyRunEvent(id)
	a.dispatch(tid, id, b.SessionID, b.Prompt, instructions, kind, budget, overhead, r.Context())
	writeJSON(w, 202, v)
}
func (a *App) dispatch(tid, id, sid, prompt, instructions, kind string, budget, overhead int, parents ...context.Context) {
	a.dispatchFor(a.cfg.RunTimeout, tid, id, kind, func(ctx context.Context) {
		a.execute(ctx, tid, id, sid, prompt, instructions, kind, budget, overhead)
	}, parents...)
}

// dispatchFor runs one admitted run under its own deadline. A media run waiting on a provider task
// when the API shuts down is left running (see leaveForResume) so the next start resumes it.
func (a *App) dispatchFor(timeout time.Duration, tid, id, kind string, run func(context.Context), parents ...context.Context) {
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
	ctx, cancel := context.WithTimeout(traceCtx, timeout)
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
		run(ctx)
		if a.resumesAfterRestart(id) {
			return
		}
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
	a.notifyRunEvent(id)
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
	// A snapshot is durable and replayed after a restart, and a row can be edited by
	// hand, so an inconsistent contract must fail the run before any quota is reserved.
	// This runs ahead of the team branch on purpose: "a team snapshot never carries a
	// contract" is half of the invariant, and checking only the single-agent path below
	// would leave that half unenforced for exactly the snapshot it is meant to catch.
	if !structuredContractConsistent(snapshot) {
		a.finish(tid, id, "failed", "", "snapshot_invalid")
		return
	}
	if snapshot.Media != nil {
		a.executeMedia(ctx, tid, id, sid, prompt, snapshot)
		return
	}
	if snapshot.Team != nil {
		a.executeTeam(ctx, tid, id, sid, prompt, snapshot)
		return
	}
	instructions = knowledgeSystemPrompt(instructions, snapshot.Knowledge)
	prompt = knowledgeUserPrompt(prompt, snapshot.Knowledge)
	if kind == "computer" {
		a.executeComputer(ctx, tid, id, sid, prompt, instructions, snapshot)
		return
	}
	if snapshot.Workspace != nil {
		a.executeWorkspace(ctx, tid, id, sid, prompt, instructions, kind, snapshot)
		return
	}
	instructions = taskFrameSystemPrompt(instructions, snapshot.TaskFrame)
	if (snapshot.TaskFrame != nil || snapshot.Knowledge != nil) && (len(prompt)+len(instructions)+overhead+outputContractReserve(snapshot) > budget || len(utf16.Encode([]rune(instructions))) > 32768) {
		a.finish(tid, id, "failed", "", "context_limit")
		return
	}
	facts := invocationMetadata(snapshot, nil)
	facts.Timing.QueueMs = int64ptr(queueDuration.Milliseconds())
	if e = a.reserveInvocation(ctx, tid, id, id, snapshot.Model, facts); e != nil {
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
	if kind == "planner" || kind == "knowledge" || kind == "computer" {
		history = []json.RawMessage{}
	} else {
		history = boundedHistoryWithLimits(history, len(prompt)+len(instructions)+outputContractReserve(snapshot), budget, overhead)
	}
	request := map[string]any{"runId": id, "tenantId": tid, "sessionId": sid, "prompt": prompt, "messages": history, "systemPrompt": instructions, "model": snapshot.Model, "runtime": defaultRuntime(snapshot.Runtime)}
	if snapshot.Effort != "" {
		request["effort"] = snapshot.Effort
	}
	// Sent only when it was frozen at admission. The worker derives the schema from
	// this contract alone, so the request still carries no schema text.
	if snapshot.OutputContract != nil {
		request["outputContract"] = snapshot.OutputContract
	}
	body, e := json.Marshal(request)
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
	// Only a planner run opts in to reasoning activity: it is the one run kind whose
	// output is withheld while it streams, so it is the one that needs another signal.
	var progress *plannerProgress
	var activity http.Header
	if kind == "planner" {
		progress, activity = &plannerProgress{}, plannerActivityHeader()
	}
	admissionStart := time.Now()
	resp, e := a.admitRuntimeWith(ctx, defaultRuntime(snapshot.Runtime), body, activity)
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
			Characters    *int            `json:"characters"`
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
			spanned := reasoning.inSpan()
			delta := reasoning.push(ev.Delta)
			output.WriteString(delta)
			// Structured proposals are emitted only after schema validation and
			// normalization; unvalidated token fragments are not a canvas plan.
			// What a planner run publishes meanwhile is progress, never the text.
			if progress != nil {
				if spanned || reasoning.inSpan() {
					// Whatever this delta carried beyond what it released belongs to a
					// leading reasoning span, or to the whitespace that closed one.
					progress.reasonInline(utf8.RuneCountInString(ev.Delta) - utf8.RuneCountInString(delta))
				}
				progress.write(delta)
				a.reportPlannerProgress(ctx, tid, id, progress)
				continue
			}
			// A withheld delta has nothing to persist or replay either.
			if delta == "" {
				continue
			}
			if !a.appendDelta(ctx, tid, id, delta) {
				finish("failed", output.String(), "event_persistence_failed")
				return
			}
		case "reasoning":
			// Reasoning activity is a count the worker sends only to a run that asked
			// for it. Anywhere else it is a worker ignoring the protocol, which stays
			// the same failure as any other event this run cannot account for.
			if progress == nil || ev.Characters == nil || *ev.Characters < 0 {
				finish("failed", output.String(), "invalid_runtime_event")
				return
			}
			progress.reasonReported(*ev.Characters)
			a.reportPlannerProgress(ctx, tid, id, progress)
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
			finish("failed", output.String(), runtimeFailureCode(ev.Code, snapshot.OutputContract != nil))
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

// runtimeFailureCode turns a worker's failed-event code into the run's error code. The
// named codes are the ones a workspace can act on differently: a refused or exhausted
// provider, a declined request, a response that hit the output cap or the deadline.
// Every other code, including an unknown or absent one, stays the generic runtime
// failure rather than inventing a cause the worker never reported. Single runs, graph
// nodes and collaboration turns all read the run's error, and team member turns apply
// this same table, so one worker code means one thing everywhere.
//
// OUTPUT_CONTRACT_INVALID is named separately only when this run actually carried a
// contract: a worker reporting it otherwise is not describing this run, and inventing
// that cause would tell the workspace to fix an envelope it never had.
func runtimeFailureCode(workerCode string, contract bool) string {
	switch workerCode {
	case "OUTPUT_CONTRACT_INVALID":
		if contract {
			return "output_contract_invalid"
		}
	case "MODEL_OUTPUT_LIMIT":
		return "output_limit"
	case "MODEL_REFUSAL":
		return "model_refused"
	case "MODEL_AUTHENTICATION":
		return "provider_auth_failed"
	case "MODEL_RATE_LIMIT":
		return "provider_rate_limited"
	case "MODEL_UNAVAILABLE", "MODEL_CONNECTION_ERROR":
		return "provider_unavailable"
	case "DEADLINE_EXCEEDED":
		return "run_timeout"
	case "WORKSPACE_CONTEXT_LIMIT":
		return "workspace_context_limit"
	case "WORKSPACE_ADMISSION_FAILED":
		return "workspace_admission_failed"
	case "WORKSPACE_FILE_INVALID":
		return "workspace_file_invalid"
	case "WORKSPACE_UNAVAILABLE":
		return "workspace_unavailable"
	}
	return "runtime_failed"
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
	data, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": delta})
	// One PostgreSQL statement keeps output and replay event atomic while
	// avoiding BEGIN/UPDATE/INSERT/COMMIT round trips for every model delta.
	tag, e := a.db.Exec(ctx, `WITH updated AS (
		UPDATE runs SET output=output||$3,updated_at=now()
		WHERE tenant_id=$1 AND id=$2 AND status='running'
		RETURNING tenant_id,id
	)
	INSERT INTO run_events(tenant_id,run_id,data)
	SELECT tenant_id,id,$4 FROM updated`, tid, id, delta, data)
	if e != nil || tag.RowsAffected() == 0 {
		return false
	}
	a.notifyRunEvent(id)
	return true
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
	return a.persistExecutionContext(context.Background(), write)
}

func (a *App) persistExecutionContext(parent context.Context, write func(context.Context) error) error {
	for attempt := 0; ; attempt++ {
		if err := parent.Err(); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(parent, 2*time.Second)
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
		select {
		case <-parent.Done():
			return parent.Err()
		case <-time.After(100 * time.Millisecond):
		}
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
		if runChanged {
			a.notifyRunEvent(id)
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
		var raw json.RawMessage
		if e = tx.QueryRow(ctx, "SELECT s.kind,r.execution_snapshot FROM runs r JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE r.tenant_id=$1 AND r.id=$2", tid, id).Scan(&kind, &raw); e != nil {
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
		if kind == "knowledge" {
			var snapshot executionSnapshot
			if json.Unmarshal(raw, &snapshot) != nil || !validateWikiCompilationWithContext(output, snapshot.Knowledge) {
				status, code = "failed", "invalid_knowledge_compilation"
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
		if facts != nil && facts.WorkspaceSnapshot != nil {
			if e = storeWorkspaceSnapshot(ctx, tx, tid, id, sid, *facts.WorkspaceSnapshot); e != nil {
				return e
			}
		}
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
	var computerOtherOwner bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM runs r JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE r.tenant_id=$1 AND r.id=$2 AND s.kind='computer' AND r.actor_id<>$3)", tid, id, currentUser(r).ID).Scan(&computerOtherOwner); e != nil {
		a.dbError(w, e)
		return
	}
	if computerOtherOwner {
		fail(w, 403, "computer_owner_required", "Only the task owner can cancel this execution")
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
	if tag.RowsAffected() > 0 {
		a.notifyRunEvent(id)
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
	wake, unsubscribe := a.subscribeRunEvents(id)
	defer unsubscribe()
	heartbeat := time.NewTicker(a.reauthEvery)
	defer heartbeat.Stop()
	nextAuth := time.Now().Add(a.reauthEvery)
	checkAccess := func(force bool) bool {
		if !force && time.Now().Before(nextAuth) {
			return true
		}
		var valid bool
		c, _ := r.Cookie("awwo_session")
		if c == nil {
			return false
		}
		e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM memberships m JOIN auth_sessions s ON s.user_id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND s.token_hash=$3 AND s.expires_at>now())", tid, currentUser(r).ID, tokenHash(c.Value)).Scan(&valid)
		nextAuth = time.Now().Add(a.reauthEvery)
		if e != nil || !valid {
			return false
		}
		var issuer, subject string
		var grant []byte
		e = a.db.QueryRow(r.Context(), "SELECT COALESCE(sso_issuer,''),COALESCE(sso_subject,''),sso_grant FROM auth_sessions WHERE token_hash=$1", tokenHash(c.Value)).Scan(&issuer, &subject, &grant)
		if e != nil {
			return false
		}
		valid, e = a.validateClawHuntSession(r.Context(), tokenHash(c.Value), currentUser(r).ID, issuer, subject, grant)
		return e == nil && valid
	}
	for {
		if !checkAccess(false) {
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
			if !checkAccess(false) {
				return
			}
			cursor = event.id
			var header struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(event.data, &header) == nil && header.Type == "completed" {
				event.data, e = projectDeliveryRecord(r.Context(), a.db, tid, id, event.data, "text")
				if e != nil {
					return
				}
			}
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, e = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", cursor, event.data); e != nil {
				return
			}
		}
		count := len(batch)
		if !checkAccess(false) {
			return
		}
		if count > 0 {
			if e = controller.Flush(); e != nil {
				return
			}
		}
		if !checkAccess(false) {
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
		case <-wake:
		case <-heartbeat.C:
			// A fixed heartbeat must always hit PostgreSQL. Using the cached
			// deadline here can phase-shift revocation checks to almost twice the
			// configured interval after an authorization check during replay.
			if !checkAccess(true) {
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
	// Historical/frozen snapshots can predate artifact publication. Never send
	// embedded file bytes to another model, even when no durable reference exists.
	var clean []json.RawMessage
	if history != nil {
		clean = make([]json.RawMessage, len(history))
		copy(clean, history)
	}
	for i, raw := range clean {
		var message map[string]json.RawMessage
		if json.Unmarshal(raw, &message) != nil {
			continue
		}
		var role, content string
		_ = json.Unmarshal(message["role"], &role)
		_ = json.Unmarshal(message["content"], &content)
		if role == "assistant" {
			if projected := projectHistoryDelivery(content); projected != content {
				message["content"], _ = json.Marshal(projected)
				clean[i], _ = json.Marshal(message)
			}
		}
	}
	history = clean
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
	return a.admitRuntimeWith(ctx, runtime, body, nil)
}

// admitRuntimeWith is admission with extra request headers. Headers, unlike body
// fields, are not part of the worker's strict request schema, so an opt-in carried
// here is ignored by a worker that predates it instead of rejecting the run.
func (a *App) admitRuntimeWith(ctx context.Context, runtime string, body []byte, extra http.Header) (*http.Response, error) {
	endpoint, token, err := a.runtimeEndpoint(runtime)
	if err != nil {
		return nil, err
	}
	if a.cfg.UserCredentials {
		body, err = a.personalAdmission(ctx, runtime, body)
		if err != nil {
			return nil, err
		}
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
		for key, values := range extra {
			for _, value := range values {
				req.Header.Add(key, value)
			}
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
