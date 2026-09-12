package app

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
)

const graphJSON = `jsonb_build_object('id',g.id,'canvasId',g.canvas_id,'operationId',g.operation_id,'documentVersion',g.document_version,'document',g.document,'scope',g.scope,'status',g.status,'error',g.error,'createdAt',g.created_at,'updatedAt',g.updated_at,'nodes',COALESCE((SELECT jsonb_agg(jsonb_build_object('nodeId',n.node_id,'state',n.state,'output',n.output,'detail',n.detail,'runId',n.run_id,'sessionId',n.session_id,'partial',g.collaboration IS NOT NULL AND (g.status<>'completed' OR n.node_id<>g.collaboration->>'synthesizerNodeId')) ORDER BY n.ordinal) FROM graph_run_nodes n WHERE n.tenant_id=g.tenant_id AND n.graph_id=g.id),'[]'::jsonb)) || CASE WHEN g.collaboration IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('collaboration',` + collaborationJSON + `) END`

func (a *App) listGraphRuns(w http.ResponseWriter, r *http.Request) {
	v, e := rowsJSON(r.Context(), a.db, "SELECT "+graphJSON+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND ($3='' OR g.operation_id=$3) ORDER BY g.created_at DESC,g.id DESC LIMIT 50", r.PathValue("tenantId"), r.PathValue("canvasId"), r.URL.Query().Get("operationId"))
	a.replyList(w, v, e)
}
func (a *App) getGraphRun(w http.ResponseWriter, r *http.Request) {
	v, e := oneJSON(r.Context(), a.db, "SELECT "+graphJSON+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.id=$3", r.PathValue("tenantId"), r.PathValue("canvasId"), r.PathValue("id"))
	a.replyOne(w, v, e, 200)
}
func (a *App) createGraphRun(w http.ResponseWriter, r *http.Request) {
	var b struct {
		OperationID     string               `json:"operationId"`
		Scope           []string             `json:"scope"`
		DocumentVersion *int64               `json:"documentVersion"`
		Collaboration   *collaborationPolicy `json:"collaboration,omitempty"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if len(b.OperationID) < 8 || len(b.OperationID) > 200 {
		fail(w, 400, "invalid_input", "operationId must be 8–200 bytes")
		return
	}
	tid, cid := r.PathValue("tenantId"), r.PathValue("canvasId")
	request, _ := json.Marshal(struct {
		Scope         []string
		Version       *int64
		Collaboration *collaborationPolicy `json:",omitempty"`
	}{b.Scope, b.DocumentVersion, b.Collaboration})
	hash := tokenHash(string(request))
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var cancelled bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM graph_operation_cancellations WHERE tenant_id=$1 AND canvas_id=$2 AND operation_id=$3)", tid, cid, b.OperationID).Scan(&cancelled); e != nil {
		a.dbError(w, e)
		return
	}
	if cancelled {
		fail(w, 409, "operation_cancelled", "This graph operation was cancelled before admission")
		return
	}
	var oldHash string
	e = tx.QueryRow(r.Context(), "SELECT request_hash FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND operation_id=$3", tid, cid, b.OperationID).Scan(&oldHash)
	if e == nil {
		if oldHash != hash {
			fail(w, 409, "idempotency_conflict", "operationId was used with different parameters")
			return
		}
		v, e := oneJSON(r.Context(), tx, "SELECT "+graphJSON+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.operation_id=$3", tid, cid, b.OperationID)
		a.replyOne(w, v, e, 200)
		return
	}
	if !noRows(e) {
		a.dbError(w, e)
		return
	}
	var raw []byte
	var version int64
	e = tx.QueryRow(r.Context(), "SELECT document,version FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, cid).Scan(&raw, &version)
	if noRows(e) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if b.DocumentVersion != nil && *b.DocumentVersion != version {
		fail(w, 409, "version_conflict", "Canvas changed before graph admission")
		return
	}
	var active bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND status IN ('queued','running'))", tid, cid).Scan(&active); e != nil {
		a.dbError(w, e)
		return
	}
	if active {
		fail(w, 409, "graph_busy", "Canvas already has an active graph run")
		return
	}
	var d graphDocument
	var scope []string
	seeds := map[string]string{}
	if b.Collaboration != nil {
		d, scope, seeds, e = parseCollaborationGraph(raw, b.Scope, b.Collaboration)
	} else {
		d, scope, e = parseGraph(raw, b.Scope)
	}
	if e != nil {
		fail(w, 400, "invalid_graph", e.Error())
		return
	}
	health, e := a.probePI(r.Context())
	hasSession := false
	in := map[string]bool{}
	needed := map[string]bool{}
	for _, id := range scope {
		in[id] = true
		needed[id] = true
	}
	for _, edge := range d.Edges {
		if b.Collaboration == nil && in[edge.ToNode] {
			needed[edge.FromNode] = true
		}
	}
	for _, n := range d.Nodes {
		if in[n.ID] && n.Kind == "session" {
			hasSession = true
		}
	}
	if e != nil && hasSession {
		fail(w, 503, "runtime_unavailable", e.Error())
		return
	}
	id := randomID()
	var collaborationRaw []byte
	if b.Collaboration != nil {
		collaborationRaw, _ = json.Marshal(b.Collaboration)
	}
	scopeRaw, _ := json.Marshal(scope)
	_, e = tx.Exec(r.Context(), "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status,collaboration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10)", id, tid, cid, currentUser(r).ID, b.OperationID, hash, version, raw, scopeRaw, collaborationRaw)
	if e != nil {
		a.dbError(w, e)
		return
	}
	for i, n := range d.Nodes {
		if !needed[n.ID] {
			continue
		}
		state, output, detail, sid := "waiting", "", "", ""
		snap := executionSnapshot{}
		if !in[n.ID] {
			state = "cached"
			if n.Kind == "form" {
				output = formOutput(n)
			} else if n.LastOutput != nil && !n.LastOutput.Partial {
				output = n.LastOutput.Text
			} else {
				state, detail = "blocked", "Missing cached upstream output"
			}
			if _, e := graphOutput(n, output); e != nil {
				state, detail = "blocked", e.Error()
			}
		}
		if in[n.ID] && n.Kind == "session" {
			if n.Binding.CompanyID != "" && n.Binding.CompanyID != tid {
				fail(w, 404, "not_found", "Node binding does not belong to this workspace")
				return
			}
			var model, instructions string
			e = tx.QueryRow(r.Context(), "SELECT model,instructions FROM agents WHERE tenant_id=$1 AND id=$2 AND NOT internal", tid, n.Binding.AgentID).Scan(&model, &instructions)
			if noRows(e) {
				fail(w, 404, "not_found", "Node agent not found in workspace")
				return
			}
			if e != nil {
				a.dbError(w, e)
				return
			}
			team, e := savedNodeTeam(raw, n.ID)
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
			budget, overhead, ok := health.modelLimits(model)
			if !ok {
				fail(w, 409, "model_unavailable", "Node model is unavailable")
				return
			}
			snap = executionSnapshot{Instructions: instructions, Model: model, Budget: budget, Overhead: overhead, Team: team, Health: health}
			sid = n.IssueID
			if sid != "" {
				var exists bool
				e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM node_sessions WHERE tenant_id=$1 AND id=$2 AND canvas_id=$3 AND node_id=$4 AND agent_id=$5 AND kind='node')", tid, sid, cid, n.ID, n.Binding.AgentID).Scan(&exists)
				if e != nil {
					a.dbError(w, e)
					return
				}
				if !exists {
					fail(w, 404, "not_found", "Node session not found in workspace")
					return
				}
			} else {
				sid = randomID()
				_, e = tx.Exec(r.Context(), "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title) VALUES($1,$2,$3,$4,$5,$6)", sid, tid, cid, n.ID, n.Binding.AgentID, n.Title)
				if e != nil {
					a.dbError(w, e)
					return
				}
			}
			if b.Collaboration != nil {
				var busy bool
				if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM runs WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','running'))", tid, sid).Scan(&busy); e != nil {
					a.dbError(w, e)
					return
				}
				if busy {
					fail(w, 409, "resource_in_use", "A selected Session already has an active run")
					return
				}
			}
			if team != nil {
				history, available, err := completedTeamHistory(r.Context(), tx, tid, sid)
				if err != nil {
					a.dbError(w, err)
					return
				}
				snap.History, snap.HistoryAvailable = &history, available
			} else {
				history, err := rowsJSON(r.Context(), tx, "SELECT jsonb_build_object('role',m.role,'content',m.content) FROM (SELECT m.role,m.content,m.created_at,m.id FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.tenant_id=$1 AND m.session_id=$2 AND r.status='completed' ORDER BY m.created_at DESC,m.id DESC LIMIT 100) m ORDER BY m.created_at,m.id", tid, sid)
				if err != nil {
					a.dbError(w, err)
					return
				}
				history = boundedHistoryWithLimits(history, len(instructions), budget, overhead)
				snap.History = &history
			}
		}
		snapRaw, _ := json.Marshal(snap)
		_, e = tx.Exec(r.Context(), "INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,output,detail,session_id,execution_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9)", tid, id, n.ID, i, state, output, detail, sid, snapRaw)
		if e != nil {
			a.dbError(w, e)
			return
		}
	}
	if b.Collaboration != nil {
		if e = seedCollaboration(r.Context(), tx, tid, id, scope, b.Collaboration, seeds); e != nil {
			a.dbError(w, e)
			return
		}
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "graph.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	v, e := oneJSON(r.Context(), tx, "SELECT "+graphJSON+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.id=$2", tid, id)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !a.workerAvailable(w) {
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.dispatchGraph(tid, id)
	writeJSON(w, 202, v)
}
func (a *App) dispatchGraph(tid, id string) {
	a.mu.Lock()
	if a.closed || a.running["graph:"+id] != nil {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.running["graph:"+id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer cancel()
		defer func() { a.mu.Lock(); delete(a.running, "graph:"+id); a.mu.Unlock() }()
		for ctx.Err() == nil {
			a.executeGraph(ctx, tid, id)
			var status string
			if e := a.db.QueryRow(ctx, "SELECT status FROM graph_runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status); noRows(e) || (e == nil && status != "queued" && status != "running") {
				return
			}
			// Transient pool/read failures do not abandon an accepted graph. Resume
			// its durable node states; an already associated child is never reissued.
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
	}()
}

type graphState struct {
	NodeID    string `json:"nodeId"`
	State     string `json:"state"`
	Output    string `json:"output"`
	Detail    string `json:"detail"`
	RunID     string `json:"runId"`
	SessionID string `json:"sessionId"`
}

func (a *App) executeGraph(ctx context.Context, tid, id string) {
	_, e := a.db.Exec(ctx, "UPDATE graph_runs SET status='running',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='queued'", tid, id)
	if e != nil {
		return
	}
	var raw []byte
	var canvasID string
	var collaborationRaw []byte
	// The canvas scopes any file deliverable this graph stores, so it is read with the document.
	if e = a.db.QueryRow(ctx, "SELECT canvas_id,document,collaboration FROM graph_runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&canvasID, &raw, &collaborationRaw); e != nil {
		return
	}
	if len(collaborationRaw) > 0 {
		a.executeCollaboration(ctx, tid, id, canvasID, raw, collaborationRaw)
		return
	}
	var d graphDocument
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	for {
		if ctx.Err() != nil {
			return
		}
		var status string
		if e = a.db.QueryRow(ctx, "SELECT status FROM graph_runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status); e != nil || status != "running" {
			return
		}
		rows, e := rowsJSON(ctx, a.db, "SELECT jsonb_build_object('nodeId',node_id,'state',state,'output',output,'detail',detail,'runId',COALESCE(run_id,''),'sessionId',COALESCE(session_id,'')) FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 ORDER BY ordinal", tid, id)
		if e != nil {
			return
		}
		states := map[string]graphState{}
		outputs := map[string]string{}
		pending := false
		failed := false
		interrupted := false
		for _, row := range rows {
			var s graphState
			if json.Unmarshal(row, &s) != nil {
				return
			}
			states[s.NodeID] = s
			outputs[s.NodeID] = s.Output
			if s.State == "running" || s.State == "waiting" {
				pending = true
			}
			if s.State == "failed" || s.State == "blocked" || s.State == "cancelled" {
				failed = true
			}
			if s.Detail == "interrupted" {
				interrupted = true
			}
		}
		if !pending {
			final := "completed"
			if failed {
				final = "failed"
			}
			if interrupted {
				final = "interrupted"
			}
			_, _ = a.db.Exec(ctx, "UPDATE graph_runs SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, final)
			return
		}
		for _, n := range d.Nodes {
			s, ok := states[n.ID]
			if !ok {
				continue
			}
			if s.State == "running" {
				var rs, out, code string
				e = a.db.QueryRow(ctx, "SELECT status,output,error FROM runs WHERE tenant_id=$1 AND id=$2", tid, s.RunID).Scan(&rs, &out, &code)
				if e != nil {
					continue
				}
				if rs == "queued" || rs == "running" {
					a.mu.Lock()
					_, executing := a.running[s.RunID]
					a.mu.Unlock()
					if !executing {
						// The child was accepted durably but its executor stopped.
						// Its provider outcome is uncertain, so settle without replay.
						a.finish(tid, s.RunID, "interrupted", "", "execution_interrupted")
					}
					continue
				}
				state, detail := "failed", code
				recorded := out
				if rs == "completed" {
					state = "done"
					vals, files, err := graphOutputFiles(n, out)
					if err != nil {
						state, detail = "failed", err.Error()
					} else if stored, storeErr := a.storeArtifacts(ctx, tid, canvasID, s.RunID, n.ID, out, vals, files); storeErr != nil {
						// The deliverable content could not be made durable, so the node must not
						// report success with a reference that resolves to nothing.
						state, detail = "failed", "deliverable_storage_failed"
					} else {
						recorded = stored
					}
				} else if rs == "cancelled" {
					state = "cancelled"
				} else if rs == "interrupted" {
					detail = "interrupted"
				}
				a.setGraphNode(ctx, tid, id, n.ID, state, recorded, detail)
				continue
			}
			if s.State != "waiting" {
				continue
			}
			ready, blocked := true, false
			for _, edge := range d.Edges {
				if edge.ToNode != n.ID {
					continue
				}
				up := states[edge.FromNode]
				if up.State == "failed" || up.State == "blocked" || up.State == "cancelled" {
					blocked = true
				}
				if up.State != "done" && up.State != "cached" {
					ready = false
				}
			}
			if blocked {
				a.setGraphNode(ctx, tid, id, n.ID, "blocked", "", "Upstream did not complete")
				continue
			}
			if !ready {
				continue
			}
			if n.Kind == "form" {
				a.setGraphNode(ctx, tid, id, n.ID, "done", formOutput(n), "")
				continue
			}
			prompt, err := graphPrompt(n, d, outputs)
			if err != nil {
				a.setGraphNode(ctx, tid, id, n.ID, "failed", "", err.Error())
				continue
			}
			if err = a.admitGraphNode(ctx, tid, id, n.ID, prompt); err != nil && !errors.Is(err, errGraphCapacity) {
				a.setGraphNode(ctx, tid, id, n.ID, "failed", "", err.Error())
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(70 * time.Millisecond):
		}
	}
}
func (a *App) setGraphNode(ctx context.Context, tid, gid, nid, state, output, detail string) {
	_, _ = a.db.Exec(ctx, "UPDATE graph_run_nodes SET state=$4,output=$5,detail=$6 WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 AND state IN ('waiting','running') AND EXISTS(SELECT 1 FROM graph_runs WHERE tenant_id=$1 AND id=$2 AND status='running')", tid, gid, nid, state, output, detail)
}

var errGraphCapacity = errors.New("graph_waiting_for_capacity")

func (a *App) admitGraphNode(ctx context.Context, tid, gid, nid, prompt string) error {
	return a.admitGraphChild(ctx, tid, gid, nid, prompt, nil)
}
func (a *App) admitGraphChild(ctx context.Context, tid, gid, nid, prompt string, turn *collaborationTurn) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	var tenantStatus string
	var concurrent int
	e = tx.QueryRow(ctx, "SELECT status,max_concurrent_runs FROM tenants WHERE id=$1 FOR UPDATE", tid).Scan(&tenantStatus, &concurrent)
	if e != nil {
		return e
	}
	if tenantStatus != "active" {
		return errors.New("execution_revoked")
	}
	var actor, gstatus string
	e = tx.QueryRow(ctx, "SELECT actor_id,status FROM graph_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, gid).Scan(&actor, &gstatus)
	if e != nil {
		return e
	}
	if gstatus != "running" {
		return errors.New("graph_not_running")
	}
	var role string
	e = tx.QueryRow(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, actor).Scan(&role)
	if e != nil || roleLevel(role) < 2 {
		return errors.New("execution_revoked")
	}
	var active int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1 AND status IN ('queued','running')", tid).Scan(&active); e != nil {
		return e
	}
	if active >= concurrent {
		return errGraphCapacity
	}
	var sid, state string
	var raw []byte
	e = tx.QueryRow(ctx, "SELECT session_id,state,execution_snapshot FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 FOR UPDATE", tid, gid, nid).Scan(&sid, &state, &raw)
	if e != nil {
		return e
	}
	if turn == nil && state != "waiting" {
		return nil
	}
	if turn != nil {
		var turnState string
		if e = tx.QueryRow(ctx, "SELECT state FROM graph_collaboration_turns WHERE tenant_id=$1 AND graph_id=$2 AND ordinal=$3 FOR UPDATE", tid, gid, turn.Ordinal).Scan(&turnState); e != nil {
			return e
		}
		if turnState != "waiting" {
			return nil
		}
	}
	var snap executionSnapshot
	if json.Unmarshal(raw, &snap) != nil {
		return errors.New("invalid_snapshot")
	}
	if turn != nil {
		if snap.Team != nil {
			return errors.New("collaboration_nested_team_unsupported")
		}
		if e = appendCollaborationHistory(ctx, tx, tid, gid, nid, &snap); e != nil {
			return e
		}
	}
	if len(prompt) > 128000 || (snap.Team == nil && len(prompt)+len(snap.Instructions)+snap.Overhead > snap.Budget) {
		return errors.New("context_limit")
	}
	var busy bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM runs WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','running'))", tid, sid).Scan(&busy); e != nil {
		return e
	}
	if busy {
		return errGraphCapacity
	}
	rid := randomID()
	op := "graph:" + gid + ":" + tokenHash(nid)[:20]
	if turn != nil {
		op = collaborationOperationID(gid, *turn)
	}
	_, e = tx.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,$5,$6,'queued')", rid, tid, sid, op, tokenHash(prompt), prompt)
	if e != nil {
		return e
	}
	if e = saveRunSnapshot(ctx, tx, tid, rid, actor, snap); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'user',$5)", randomID(), tid, sid, rid, prompt); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, rid, `{"type":"queued"}`); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "UPDATE graph_run_nodes SET state='running',run_id=$4 WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3", tid, gid, nid, rid); e != nil {
		return e
	}
	if turn != nil {
		if _, e = tx.Exec(ctx, "UPDATE graph_collaboration_turns SET state='running',run_id=$4 WHERE tenant_id=$1 AND graph_id=$2 AND ordinal=$3 AND state='waiting'", tid, gid, turn.Ordinal, rid); e != nil {
			return e
		}
	}
	if e = audit(ctx, tx, actor, tid, "graph.node.accepted", rid); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	a.dispatch(tid, rid, sid, prompt, snap.Instructions, "node", snap.Budget, snap.Overhead)
	return nil
}
func (a *App) cancelGraphRun(w http.ResponseWriter, r *http.Request) {
	tid, cid, id := r.PathValue("tenantId"), r.PathValue("canvasId"), r.PathValue("id")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var status string
	e = tx.QueryRow(r.Context(), "SELECT status FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 FOR UPDATE", tid, cid, id).Scan(&status)
	if noRows(e) {
		fail(w, 404, "not_found", "Graph run not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	ids := []string{}
	if status == "queued" || status == "running" {
		rows, e := tx.Query(r.Context(), "UPDATE runs SET status='cancelled',error='',updated_at=now() WHERE tenant_id=$1 AND id IN(SELECT run_id FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2) AND status IN ('queued','running') RETURNING id", tid, id)
		if e != nil {
			a.dbError(w, e)
			return
		}
		for rows.Next() {
			var rid string
			if e = rows.Scan(&rid); e != nil {
				rows.Close()
				a.dbError(w, e)
				return
			}
			ids = append(ids, rid)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			a.dbError(w, e)
			return
		}
		for _, rid := range ids {
			if _, e = tx.Exec(r.Context(), "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, rid, `{"type":"cancelled"}`); e != nil {
				a.dbError(w, e)
				return
			}
		}
		status, e = reconcileCancelledGraph(r.Context(), tx, tid, id)
		if e != nil {
			a.dbError(w, e)
			return
		}
		if _, e = tx.Exec(r.Context(), "UPDATE graph_runs SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", tid, id, status); e != nil {
			a.dbError(w, e)
			return
		}
		if e = audit(r.Context(), tx, currentUser(r).ID, tid, "graph.cancelled", id); e != nil {
			a.dbError(w, e)
			return
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.mu.Lock()
	stop := a.running["graph:"+id]
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
	for _, rid := range ids {
		a.cancelExecution(rid)
	}
	a.getGraphRun(w, r)
}
func (a *App) recoverGraphs(ctx context.Context) error {
	rows, e := a.db.Query(ctx, "SELECT tenant_id,id FROM graph_runs WHERE status IN ('queued','running')")
	if e != nil {
		return e
	}
	type pair struct{ tid, id string }
	pending := []pair{}
	for rows.Next() {
		var p pair
		if e = rows.Scan(&p.tid, &p.id); e != nil {
			rows.Close()
			return e
		}
		pending = append(pending, p)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	for _, p := range pending {
		a.dispatchGraph(p.tid, p.id)
	}
	return nil
}

// Cancelling an operation before its response arrives creates a durable tombstone.
// Admission and cancellation share tenant/canvas locks, so a delayed POST cannot
// start a paid run after the caller has received positive cancellation evidence.
func (a *App) cancelGraphOperation(w http.ResponseWriter, r *http.Request) {
	tid, cid, op := r.PathValue("tenantId"), r.PathValue("canvasId"), r.PathValue("operationId")
	if len(op) < 8 || len(op) > 200 {
		fail(w, 400, "invalid_input", "operationId must be 8–200 bytes")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var canvas string
	e = tx.QueryRow(r.Context(), "SELECT id FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, cid).Scan(&canvas)
	if noRows(e) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO graph_operation_cancellations(tenant_id,canvas_id,operation_id,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", tid, cid, op, currentUser(r).ID); e != nil {
		a.dbError(w, e)
		return
	}
	gid, status := "", "cancelled"
	e = tx.QueryRow(r.Context(), "SELECT id,status FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND operation_id=$3 FOR UPDATE", tid, cid, op).Scan(&gid, &status)
	if e != nil && !noRows(e) {
		a.dbError(w, e)
		return
	}
	ids := []string{}
	if gid != "" && (status == "queued" || status == "running") {
		rows, err := tx.Query(r.Context(), "UPDATE runs SET status='cancelled',error='',updated_at=now() WHERE tenant_id=$1 AND id IN (SELECT run_id FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2) AND status IN ('queued','running') RETURNING id", tid, gid)
		if err != nil {
			a.dbError(w, err)
			return
		}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				a.dbError(w, err)
				return
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			a.dbError(w, err)
			return
		}
		for _, id := range ids {
			if _, e = tx.Exec(r.Context(), "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, `{"type":"cancelled"}`); e != nil {
				a.dbError(w, e)
				return
			}
		}
		status, e = reconcileCancelledGraph(r.Context(), tx, tid, gid)
		if e != nil {
			a.dbError(w, e)
			return
		}
		if _, e = tx.Exec(r.Context(), "UPDATE graph_runs SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", tid, gid, status); e != nil {
			a.dbError(w, e)
			return
		}
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "graph.operation.cancelled", op); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	if gid != "" {
		a.mu.Lock()
		stop := a.running["graph:"+gid]
		a.mu.Unlock()
		if stop != nil {
			stop()
		}
	}
	for _, id := range ids {
		a.cancelExecution(id)
	}
	result := map[string]any{"confirmed": true, "status": status}
	if gid != "" {
		result["graphId"] = gid
	}
	writeJSON(w, 200, result)
}

// Child finalization can commit just before cancellation while the graph's
// polling projection still says running. Reconcile inside the cancellation
// transaction so completed deliverables and partial cancellation evidence survive.
func reconcileCancelledGraph(ctx context.Context, tx pgx.Tx, tid, gid string) (string, error) {
	var raw []byte
	var collaborationRaw []byte
	if e := tx.QueryRow(ctx, "SELECT document,collaboration FROM graph_runs WHERE tenant_id=$1 AND id=$2", tid, gid).Scan(&raw, &collaborationRaw); e != nil {
		return "", e
	}
	if len(collaborationRaw) > 0 {
		return reconcileCancelledCollaboration(ctx, tx, tid, gid)
	}
	var doc graphDocument
	if e := json.Unmarshal(raw, &doc); e != nil {
		return "", e
	}
	nodes := map[string]graphNode{}
	for _, n := range doc.Nodes {
		nodes[n.ID] = n
	}
	rows, e := tx.Query(ctx, "SELECT n.node_id,n.state,n.output,n.detail,COALESCE(r.status,''),COALESCE(r.output,''),COALESCE(r.error,'') FROM graph_run_nodes n LEFT JOIN runs r ON r.tenant_id=n.tenant_id AND r.id=n.run_id WHERE n.tenant_id=$1 AND n.graph_id=$2 FOR UPDATE OF n", tid, gid)
	if e != nil {
		return "", e
	}
	type row struct{ id, state, output, detail, runStatus, runOutput, runError string }
	all := []row{}
	for rows.Next() {
		var r row
		if e = rows.Scan(&r.id, &r.state, &r.output, &r.detail, &r.runStatus, &r.runOutput, &r.runError); e != nil {
			rows.Close()
			return "", e
		}
		all = append(all, r)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return "", e
	}
	cancelled, failed, interrupted := false, false, false
	for _, r := range all {
		if r.state == "waiting" || r.state == "running" {
			r.state, r.detail = "cancelled", "Graph cancelled"
			if r.runStatus != "" {
				r.output = r.runOutput
				switch r.runStatus {
				case "completed":
					r.state, r.detail = "done", "completed"
					if _, err := graphOutput(nodes[r.id], r.runOutput); err != nil {
						r.state, r.detail = "failed", err.Error()
					}
				case "failed":
					r.state, r.detail = "failed", r.runError
				case "interrupted":
					r.state, r.detail = "failed", "interrupted"
				}
			}
			if _, e = tx.Exec(ctx, "UPDATE graph_run_nodes SET state=$4,output=$5,detail=$6 WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3", tid, gid, r.id, r.state, r.output, r.detail); e != nil {
				return "", e
			}
		}
		if r.state == "cancelled" {
			cancelled = true
		}
		if r.state == "failed" || r.state == "blocked" {
			failed = true
		}
		if r.detail == "interrupted" {
			interrupted = true
		}
	}
	if cancelled {
		return "cancelled", nil
	}
	if interrupted {
		return "interrupted", nil
	}
	if failed {
		return "failed", nil
	}
	return "completed", nil
}
