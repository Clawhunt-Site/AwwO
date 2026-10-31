package app

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// graphJSON is a graph run as the web and API clients read it. Each node carries its automatic retries (attempts, and
// attemptLog naming each failed attempt's run, code and end), and nodeRetries is the retry limit in force for the
// graph's plain nodes (graph_retry.go); a collaboration's turns are never retried. The limit is a validated integer.
// startedAt is when the node's current run was admitted and endedAt when that run settled, read from the run itself, so
// the execution timeline draws each node's bar from recorded times on any device; a node with no run (cached, or not
// reached) has neither, a node still in flight has no endedAt, and one waiting for its next attempt shows no start (its
// run is the failed one). A collaboration node's turns are its runs: its first turn's start and, settled, its last end.
func (a *App) graphJSON() string { return a.graphRunJSON(true) }

// graphRunJSON is graphJSON with or without the canvas the run froze at admission (g.document), and nothing else left
// out. createGraphRun writes that canvas when it admits the run and nothing writes it again, so a reader that has read
// it once can ask for the run without it (GET .../graph-runs/{id}?document=false, getGraphRun) and keep what it read: a
// canvas page observes its active run by its id every 2.5 s for as long as the run goes on, hours for a film
// (observeCloudGraph), and a film's frozen canvas is 0.4 MB at 116 nodes and about 1 MB at 300, which the database read
// back out of TOAST for every read. Without it, the query does not name the column, so the database does not read it
// (dropping the key from the whole object, `- 'document'`, would read it first). With it, the query is graphJSON's as it
// always was.
func (a *App) graphRunJSON(document bool) string {
	frozen := ""
	if document {
		frozen = `'document',g.document,`
	}
	return `jsonb_build_object('id',g.id,'canvasId',g.canvas_id,'operationId',g.operation_id,'documentVersion',g.document_version,` + frozen + `'scope',g.scope,'status',g.status,'error',g.error,'createdAt',g.created_at,'updatedAt',g.updated_at,'nodes',COALESCE((SELECT jsonb_agg(jsonb_build_object('nodeId',n.node_id,'state',n.state,'output',n.output,'detail',n.detail,'runId',n.run_id,'sessionId',n.session_id,'partial',g.collaboration IS NOT NULL AND (g.status<>'completed' OR n.node_id<>g.collaboration->>'synthesizerNodeId'),'attempts',n.attempts,'attemptLog',n.attempt_log,'startedAt',CASE WHEN n.state<>'waiting' OR g.collaboration IS NOT NULL THEN tm.started END,'endedAt',CASE WHEN n.state IN ('done','failed','cancelled') AND NOT tm.live THEN tm.ended END) ORDER BY n.ordinal) FROM graph_run_nodes n LEFT JOIN LATERAL (SELECT min(r.created_at) AS started,max(r.updated_at) AS ended,COALESCE(bool_or(r.status IN ('queued','running')),false) AS live FROM (SELECT n.run_id AS id UNION ALL SELECT t.run_id FROM graph_collaboration_turns t WHERE t.graph_id=n.graph_id AND t.node_id=n.node_id) ids JOIN runs r ON r.tenant_id=n.tenant_id AND r.id=ids.id) tm ON true WHERE n.tenant_id=g.tenant_id AND n.graph_id=g.id),'[]'::jsonb),'nodeRetries',CASE WHEN g.collaboration IS NULL THEN ` + strconv.Itoa(a.graphNodeRetries()) + ` ELSE 0 END) || CASE WHEN g.collaboration IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('collaboration',` + collaborationJSON + `) END`
}

// graphSummaryJSON is a graph run as the canvas's run list reads it (GET .../graph-runs): what the run is and how it
// stands, and each of its nodes by its state, with its attempts once it has been retried. It leaves out the canvas the
// run froze at admission (g.document: 0.4 MB for a film's canvas of 116 nodes, 1.1 MB at about 310) and everything its
// nodes made (their outputs, a collaboration's turns), which graphJSON still reads for one run (GET .../graph-runs/{id}).
// The run panel polls the list on every open canvas page, every 5 s while it is closed and every 2 s while it is open,
// and the list carried the canvas's last 50 runs in full: 20 to 55 MB a read for a film's canvas (found 2026-10-21 in
// review of the change that lets a canvas hold 400 nodes). A node's state is what the list's readers use: the run
// receipt finds the latest run that settled a step by it and counts a run's steps, the panel counts the steps done and
// reads the run it shows whole again when a node's state moves. A retry moves a node from running back to running with
// a new run, after a wait no poll need see, so a retried node carries its attempts too (none while it has none). Nor
// does the list read each node's run for its times (graphJSON's lateral join): only the timeline draws them, from a
// run's own read.
const graphSummaryJSON = `jsonb_build_object('id',g.id,'canvasId',g.canvas_id,'operationId',g.operation_id,'documentVersion',g.document_version,'scope',g.scope,'status',g.status,'error',g.error,'createdAt',g.created_at,'updatedAt',g.updated_at,'nodes',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('nodeId',n.node_id,'state',n.state,'attempts',NULLIF(n.attempts,0))) ORDER BY n.ordinal) FROM graph_run_nodes n WHERE n.tenant_id=g.tenant_id AND n.graph_id=g.id),'[]'::jsonb))`

func (a *App) listGraphRuns(w http.ResponseWriter, r *http.Request) {
	v, e := rowsJSON(r.Context(), a.db, "SELECT "+graphSummaryJSON+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND ($3='' OR g.operation_id=$3) ORDER BY g.created_at DESC,g.id DESC LIMIT 50", r.PathValue("tenantId"), r.PathValue("canvasId"), r.URL.Query().Get("operationId"))
	a.replyList(w, v, e)
}

// getGraphRun reads one run whole, or with ?document=false without the canvas it froze at admission (graphRunJSON), for
// a reader that already holds that canvas: the canvas page's observer of its active run and the open run panel's reads
// again of the run it shows. ?document=true is the default, the run whole; any other value, or the option twice, is
// refused rather than read as either. So is a query that does not parse, as the artifact and tenant lists refuse
// theirs: r.URL.Query() drops a malformed pair (a bad escape, a ";") and would read the run as though no one had asked.
func (a *App) getGraphRun(w http.ResponseWriter, r *http.Request) {
	query, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		fail(w, 400, "invalid_input", "Invalid query")
		return
	}
	document := true
	if values, ok := query["document"]; ok {
		if len(values) != 1 || (values[0] != "true" && values[0] != "false") {
			fail(w, 400, "invalid_input", "document must be true or false")
			return
		}
		document = values[0] == "true"
	}
	a.replyGraphRun(w, r, document)
}

// replyGraphRun answers with the run the request's path names, whole or without its frozen canvas. A cancellation
// answers with the run whole whatever its query says: it has already committed when it replies, and a refusal then would
// read as though it had not.
func (a *App) replyGraphRun(w http.ResponseWriter, r *http.Request, document bool) {
	v, e := oneJSON(r.Context(), a.db, "SELECT "+a.graphRunJSON(document)+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.id=$3", r.PathValue("tenantId"), r.PathValue("canvasId"), r.PathValue("id"))
	a.replyOne(w, v, e, 200)
}
func (a *App) createGraphRun(w http.ResponseWriter, r *http.Request) {
	var b struct {
		OperationID          string               `json:"operationId"`
		Scope                []string             `json:"scope"`
		DocumentVersion      *int64               `json:"documentVersion"`
		Collaboration        *collaborationPolicy `json:"collaboration,omitempty"`
		KnowledgeRevisionIDs []string             `json:"knowledgeRevisionIds,omitempty"`
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
		Scope                []string
		Version              *int64
		Collaboration        *collaborationPolicy `json:",omitempty"`
		KnowledgeRevisionIDs []string             `json:",omitempty"`
	}{b.Scope, b.DocumentVersion, b.Collaboration, b.KnowledgeRevisionIDs})
	hash := tokenHash(string(request))
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	actorRole, ok := a.mutationRole(w, r, tx, tid, 2)
	if !ok {
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
		v, e := oneJSON(r.Context(), tx, "SELECT "+a.graphJSON()+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.operation_id=$3", tid, cid, b.OperationID)
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
	if err := validateCanvasTaskFrames(raw); err != nil {
		fail(w, 400, "invalid_task_frame", err.Error())
		return
	}
	if err := validateCanvasSkills(raw); err != nil {
		a.skillFailure(w, err)
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
	// An edit node renders on the render worker: without one the run is refused before anything paid runs upstream.
	if a.cfg.RenderURL == "" && scopeHasEdit(d, scope) {
		fail(w, 409, "edit_unavailable", "Edit nodes need the render worker, which this server does not run")
		return
	}
	// Several graphs may run on one canvas at once, each executing its own nodes; the canvas row lock taken above
	// serializes admissions, so two graphs can never both claim a node.
	busy, e := graphAdmissionConflict(r.Context(), tx, tid, cid, scope, b.Collaboration != nil)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if busy {
		fail(w, 409, "graph_busy", "Some of these components are already running on this canvas")
		return
	}
	entitlement, e := tenantModelEntitlement(r.Context(), tx, tid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	catalog := runtimeCatalog{}
	knowledge, e := freezeKnowledgeContext(r.Context(), tx, tid, b.KnowledgeRevisionIDs)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
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
	// Collected here and counted after commit: a graph that is rejected or rolled
	// back decided nothing, and a metric emitted inside the transaction would claim
	// an envelope that no run will ever use.
	contractOutcomes := []string{}
	// The owner's plan, read once a paid market Agent's node needs it.
	var paidPlan *activePlan
	// Each helper below looks one node up in a document; given the whole canvas, admission read it whole once per helper
	// per node under the workspace's row lock (a 400-node canvas: thousands of full parses). Each gets its node alone.
	nodeDocs := savedNodeDocuments(raw)
	// A market Agent's text is a third party's: it feeds no node that works with tools (a sandbox, a team), even through
	// nodes in between, as its instructions could be read there as the task's (market_use.go).
	fromMarket := marketDescendants(d)
	for i, n := range d.Nodes {
		if !needed[n.ID] {
			continue
		}
		own := nodeDocs[n.ID]
		if own == nil {
			own = raw
		}
		state, output, detail, sid := "waiting", "", "", ""
		snap := executionSnapshot{}
		if !in[n.ID] {
			state = "cached"
			if n.Kind == "form" {
				output = formOutput(n)
			} else if n.LastOutput != nil && !n.LastOutput.Partial {
				// This text is recorded as the cached node's own deliverable and served
				// back to the workspace, so a document saved before stripping existed
				// must be healed here too and not only where the contract reads it.
				output = stripReasoningPreamble(n.LastOutput.Text)
				// A row saved before stripping existed may be nothing but a scratchpad, and
				// heals to empty. Projecting that would hand a downstream agent an empty
				// operand and settle the graph as completed, claiming a deliverable that was
				// never produced. Blank for any reason is the same absence as no cached
				// output at all, so it takes the same refusal: a row that was already blank
				// before healing is no more of a deliverable than one that became blank.
				if strings.TrimSpace(output) == "" {
					state, detail = "blocked", "Cached upstream output holds no deliverable"
				}
			} else {
				state, detail = "blocked", "Missing cached upstream output"
			}
			if _, e := graphOutput(n, output); e != nil {
				state, detail = "blocked", e.Error()
			}
		}
		if in[n.ID] && n.Kind == "session" {
			if err := validateSavedWorkspaceAgent(own, n.ID, n.Binding.AgentID); err != nil {
				input := err.(setupError)
				status := 400
				if input.code == "node_setup_required" {
					status = 409
				}
				fail(w, status, input.code, input.message)
				return
			}
			if n.Binding.CompanyID != "" && n.Binding.CompanyID != tid {
				fail(w, 404, "not_found", "Node binding does not belong to this workspace")
				return
			}
			var model, instructions, runtime, effort, engine string
			var marketAgentID *string
			var marketVersion *int
			e = tx.QueryRow(r.Context(), "SELECT model,instructions,runtime,effort,engine,market_agent_id,market_version FROM agents WHERE tenant_id=$1 AND id=$2 AND NOT internal", tid, n.Binding.AgentID).Scan(&model, &instructions, &runtime, &effort, &engine, &marketAgentID, &marketVersion)
			if noRows(e) {
				fail(w, 404, "not_found", "Node agent not found in workspace")
				return
			}
			if e != nil {
				a.dbError(w, e)
				return
			}
			media := engine == agentEngineMedia
			var team *nodeTeam
			if media {
				// An image, video or 3D node generates in the run from its own prompt and its upstream text
				// (graph_media.go). Its model and parameters are frozen now; its allowance is counted when its turn
				// comes, so a graph never pays for a generation it does not reach.
				if b.Collaboration != nil {
					fail(w, 400, "media_collaboration_unsupported", "Image, video and 3D nodes do not take part in a collaboration")
					return
				}
				if snap, e = a.mediaPlanSnapshot(own, n.ID, model, entitlement); e == nil {
					e = a.mediaStorageReady()
				}
				if e != nil {
					// This refusal is the whole canvas's, so a refusal this node's own saved model, type or
					// parameters caused says which node it was (mediaGraphAdmissionError).
					a.mediaGraphAdmissionError(w, e, n.ID)
					return
				}
			} else if team, e = savedNodeTeam(own, n.ID); e != nil {
				fail(w, 400, "invalid_team", e.Error())
				return
			}
			var market *marketRun
			if !media {
				if !savedRuntimeMatches(own, n.ID, runtime) {
					fail(w, 409, "node_setup_required", "Initialize the node to apply its changed runtime")
					return
				}
				// A node running a market Agent sends the version's instructions and skills (market_use.go); its price is
				// held when its turn comes (admitGraphChild), and a paid one is refused now without the owner's plan.
				if market, e = a.admitMarketRun(r.Context(), tx, tid, n.IssueID, n.ID, currentUser(r).ID, own, marketAgentID, marketVersion); e != nil {
					a.marketAdmissionError(w, e)
					return
				}
				if market != nil {
					if b.Collaboration != nil {
						a.marketAdmissionError(w, marketNotUsable("A market Agent does not take part in a collaboration"))
						return
					}
					if e = marketPaidRole(market, actorRole); e != nil {
						a.marketAdmissionError(w, e)
						return
					}
					if market.Price > 0 {
						if paidPlan == nil {
							if paidPlan, e = ownerPlan(r.Context(), tx, tid, false); e != nil {
								a.dbError(w, e)
								return
							}
						}
						if paidPlan == nil {
							fail(w, 402, "market_agent_plan_required", "This Agent is paid: it runs in a workspace whose owner has a paid plan")
							return
						}
					}
					instructions = marketInstructions(market.Version.Instructions)
				}
				snap, e = a.runtimeSnapshot(r.Context(), entitlement, catalog, runtime, model, effort, instructions, team)
				if e != nil {
					a.runtimeAdmissionError(w, e)
					return
				}
				snap.Knowledge = knowledge
				if e = a.requireWorkspaceSnapshot(snap); e != nil {
					a.runtimeAdmissionError(w, e)
					return
				}
				if market != nil && a.marketSandboxed(snap) {
					a.marketAdmissionError(w, marketSandboxRefused())
					return
				}
				if fromMarket[n.ID] && (team != nil || a.marketSandboxed(snap)) {
					a.marketAdmissionError(w, marketFeedRefused(n.Title))
					return
				}
				if e = validateWorkspaceAgentSession(r.Context(), tx, tid, n.IssueID, n.ID, own, snap); e != nil {
					a.workspaceAgentAdmissionError(w, e)
					return
				}
				// Freeze the output policy separately from persona instructions. Team members
				// retain their own personas without overriding this server-owned format.
				snap.OutputPolicy = graphOutputPolicy(n)
				if snap.Workspace != nil {
					snap.Workspace.OutputFields = workspaceOutputFields(n)
					snap.OutputPolicy = graphWorkspaceOutputPolicy(n)
				}
				snap.TaskFrame, e = savedNodeTaskFrame(own, n.ID)
				if e != nil {
					fail(w, 400, "invalid_task_frame", e.Error())
					return
				}
				if market != nil {
					snap.Skills, snap.Market = marketSkillContext(market.Version.Skills), market.snapshot()
				} else if snap.Skills, e = a.freezeNodeSkills(r.Context(), tx, tid, own, n.ID); e != nil {
					a.skillFailure(w, e)
					return
				}
				if snap.Memory, e = freezeMemoryContext(r.Context(), tx, tid, cid, graphMemoryQuery(n)); e != nil {
					a.dbError(w, e)
					return
				}
				// A team's members are framed by their own turns (team_context.go), which carry no lessons, and a
				// collaboration's turns are not counted as a node's run (canvas_lessons.go), so they get none either.
				if team == nil && b.Collaboration == nil {
					if snap.Lessons, e = freezeNodeLessons(r.Context(), tx, tid, cid, n.ID); e != nil {
						a.dbError(w, e)
						return
					}
				}
				// Freeze a structured contract only when the deployment has switched contracts
				// on, and only for a plain single-agent node whose own model advertises the
				// capability. A team turn is excluded because its members deliver into the
				// node's envelope through their own turns, and a runtime or model that never
				// advertised it keeps the textual policy alone. The decision is frozen with the
				// rest of the snapshot, so a capability or switch that changes later cannot
				// change what this run was admitted to do.
				if a.cfg.StructuredContracts && snap.Workspace == nil && team == nil && snap.Runtime == runtimeOpenAIAgents && snap.Health.supportsStructuredOutput(snap.Model) {
					contract, outcome := graphOutputContract(n)
					snap.OutputContract = contract
					if outcome != "none" {
						contractOutcomes = append(contractOutcomes, outcome)
					}
				}
			}
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
			if sid != "" {
				// One node runs one thing at a time: a graph never executes a node that is still answering a chat
				// or running in another task (runs_one_active_session would fail the node later, after admission).
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
			if media {
				// A generation takes no conversation history.
			} else if team != nil {
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
				// The response-format envelope occupies context too, so history is trimmed
				// against the instructions this run will actually send plus that reserve.
				// Both terms are unchanged when no contract is frozen.
				// The node's own prompt is unknown until its inputs arrive: the run trims again against it (execute).
				system := memorySystemPrompt(knowledgeSystemPrompt(taskFrameSystemPrompt(skillsSystemPrompt(graphSystemPrompt(snap.Instructions, effectiveOutputPolicy(snap)), snap.Skills), snap.TaskFrame), snap.Knowledge), snap.Memory)
				evidence := evidenceUserPrompt("", snap.Knowledge, snap.Memory)
				history = boundedHistoryAt(history, snap.tokens(system)+snap.tokens(evidence)+outputContractReserve(snap), snap.Budget, snap.Overhead, snap.ProseRate,
					snap.Health.textUnitsLimit()-utf16Len(system)-utf16Len(evidence))
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
	v, e := oneJSON(r.Context(), tx, "SELECT "+a.graphJSON()+" FROM graph_runs g WHERE g.tenant_id=$1 AND g.id=$2", tid, id)
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
	for _, outcome := range contractOutcomes {
		a.observeGraphOutputContract(outcome)
	}
	a.dispatchGraph(tid, id, r.Context())
	writeJSON(w, 202, v)
}
func (a *App) dispatchGraph(tid, id string, parents ...context.Context) {
	a.mu.Lock()
	if a.closed || a.running["graph:"+id] != nil {
		a.mu.Unlock()
		return
	}
	parent := context.Background()
	if len(parents) > 0 {
		parent = parents[0]
	}
	traceCtx, endTrace := a.startAsyncTrace(parent, "awwo.graph.execute", "graph", "mixed")
	ctx, cancel := context.WithCancel(traceCtx)
	a.running["graph:"+id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer func() {
			c, done := context.WithTimeout(context.Background(), time.Second)
			defer done()
			outcome := "interrupted"
			_ = a.db.QueryRow(c, "SELECT status FROM graph_runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&outcome)
			endTrace(outcome)
		}()
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
	// RetryPending: a waiting node whose next attempt is not due yet (graph_retry.go).
	RetryPending bool `json:"retryPending"`
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
		rows, e := rowsJSON(ctx, a.db, "SELECT jsonb_build_object('nodeId',node_id,'state',state,'output',output,'detail',detail,'runId',COALESCE(run_id,''),'sessionId',COALESCE(session_id,''),'retryPending',retry_at IS NOT NULL AND retry_at>now()) FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 ORDER BY ordinal", tid, id)
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
			tag, e := a.db.Exec(ctx, "UPDATE graph_runs SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, final)
			if e == nil && tag.RowsAffected() == 1 {
				a.observeGraph(final)
				// What its failed nodes teach is written down for their next runs (canvas_lessons.go).
				a.scheduleGraphLessons(tid, id)
			}
			return
		}
		for _, n := range d.Nodes {
			s, ok := states[n.ID]
			if !ok {
				continue
			}
			if n.Kind == "edit" && s.State == "running" {
				a.settleGraphEdit(ctx, tid, id, n)
				continue
			}
			if s.State == "running" {
				var rs, out, code string
				var generation bool
				e = a.db.QueryRow(ctx, "SELECT status,output,error,media_task IS NOT NULL FROM runs WHERE tenant_id=$1 AND id=$2", tid, s.RunID).Scan(&rs, &out, &code, &generation)
				if e != nil {
					continue
				}
				// Normalize once here so the node's recorded deliverable, its stored
				// artifacts and its contract validation all read the same text, even
				// for a child settled before the runtime boundary stripped reasoning.
				out = stripReasoningPreamble(out)
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
					if generation {
						// A generation's files were stored as it finished (storeMediaResults); its delivery is the
						// awwo.media record naming them, published as it is.
					} else if vals, files, err := graphOutputFiles(n, out); err != nil {
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
				// A run that failed for a transient reason sends its node back to waiting for another attempt, while
				// it has retries left (graph_retry.go). Only the run's own failure counts: a delivery that completed
				// but could not be accepted, a cancellation and an interruption are settled as before.
				if rs == "failed" && a.graphNodeRetries() > 0 && graphRetryable(code,
					func() bool { return !generation && a.graphRunSilent(ctx, tid, s.RunID) },
					func() bool { return generation && a.mediaRunUnbilled(ctx, tid, s.RunID) }) {
					if retried, err := a.retryGraphNode(ctx, tid, id, n, s.RunID, code); err != nil || retried {
						continue
					}
				}
				a.setGraphNode(ctx, tid, id, n.ID, state, recorded, detail)
				continue
			}
			if s.State != "waiting" {
				continue
			}
			// A node waiting for its next attempt is not admitted again before its retry_at; its downstream nodes keep
			// waiting for it like for any node not done yet.
			if s.RetryPending {
				continue
			}
			ready, blocked := true, false
			for _, edge := range d.Edges {
				if edge.ToNode != n.ID {
					continue
				}
				up := states[edge.FromNode]
				if up.State == "failed" || up.State == "blocked" || up.State == "cancelled" {
					if softMediaEdge(d, edge) {
						// A picture, clip or model that was not made: the input says so (graphPrompt) and the node
						// goes on without it.
						continue
					}
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
			if n.Kind == "edit" {
				// No model: the render worker joins its files (edits.go); the node runs until its job ends.
				if err := a.admitGraphEdit(ctx, tid, id, canvasID, n, d, outputs); err != nil && !errors.Is(err, errEditWaiting) {
					a.setGraphNode(ctx, tid, id, n.ID, "failed", "", editAdmissionDetail(err))
				}
				continue
			}
			if n.Kind == "assemble" {
				// No model: the node is settled as soon as its inputs are, in this same pass.
				if out, err := a.executeAssembleNode(ctx, tid, id, canvasID, n, d, outputs); err != nil {
					a.setGraphNode(ctx, tid, id, n.ID, "failed", "", err.Error())
				} else {
					a.setGraphNode(ctx, tid, id, n.ID, "done", out, "")
				}
				continue
			}
			var prompt string
			var err error
			media, model := false, ""
			if graphMediaNode(n) {
				if media, model, err = a.frozenMediaNode(ctx, tid, id, n.ID); err != nil {
					continue
				}
			}
			if media {
				if err = wiredVoicesUsable(n, d, model, outputs); err == nil {
					prompt, err = a.graphMediaPrompt(ctx, tid, s.SessionID, n, d, outputs)
				}
			} else {
				prompt, err = graphPrompt(n, d, outputs)
			}
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
	var runID *string
	// A node that was retried settles its pending experiences in the same statement: done as succeeded, any other end as
	// failed (graph_retry.go). A node never retried has none, and the second statement then reads nothing. So does a
	// node whose run was given lessons count them, by the kind of its failure (canvas_lessons.go); one given none counts
	// nothing.
	err := a.db.QueryRow(ctx, `WITH settled AS (UPDATE graph_run_nodes SET state=$4,output=$5,detail=$6,retry_at=NULL WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 AND state IN ('waiting','running') AND state<>$4 AND EXISTS(SELECT 1 FROM graph_runs WHERE tenant_id=$1 AND id=$2 AND status='running') RETURNING run_id,attempts),
		experiences AS (UPDATE canvas_experiences SET outcome=CASE WHEN $4='done' THEN 'succeeded' ELSE 'failed' END,detail=detail||jsonb_build_object('nodeState',$4::text),updated_at=now() WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 AND outcome='pending' AND EXISTS(SELECT 1 FROM settled WHERE attempts>0)),
		`+settleNodeLessonsSQL+`
		SELECT run_id FROM settled`, tid, gid, nid, state, output, detail, givenLessonKind(state, detail)).Scan(&runID)
	if err == nil {
		a.observeGraphNodeState(state)
		if runID != nil && state == "failed" {
			// A market Agent's call whose run completed records the failed delivery (market_use.go).
			a.marketDeliveryFailed(ctx, tid, *runID, detail)
		}
		if runID != nil {
			// The duration is read on the database's clock, which stamped created_at: this process's clock can be a second
			// or more off it, which would move every duration by the difference (a shorter one below 0).
			var created, now time.Time
			var raw json.RawMessage
			if a.db.QueryRow(ctx, "SELECT created_at,clock_timestamp(),execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", tid, *runID).Scan(&created, &now, &raw) == nil {
				var snap executionSnapshot
				if json.Unmarshal(raw, &snap) == nil {
					a.observeGraphNode(snapshotRuntime(snap), state, max(0, now.Sub(created)))
				}
			}
		}
	}
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
	var concurrent, daily int
	var restricted bool
	var allowed []string
	var needsPlan bool
	var routes []byte
	e = tx.QueryRow(ctx, "SELECT status,max_concurrent_runs,allowed_models IS NOT NULL,COALESCE(allowed_models,'{}'),requires_plan,max_runs_per_day,route_limits FROM tenants WHERE id=$1 FOR UPDATE", tid).Scan(&tenantStatus, &concurrent, &restricted, &allowed, &needsPlan, &daily, &routes)
	if e != nil {
		return e
	}
	// A promotion and today's check-in raise a free workspace's stored allowances (promo.go).
	if daily, routes, e = a.todayAllowance(ctx, tx, tid, daily, routes); e != nil {
		return e
	}
	if tenantStatus != "active" {
		return errors.New("execution_revoked")
	}
	entitlement, e := workspaceEntitlement(ctx, tx, tid, restricted, allowed)
	if e != nil {
		return e
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
	// An entitled owner's plan runs its agents at once across the account's workspaces (plans.go); a workspace the
	// plan does not cover runs nothing.
	owner, e := ownerPlan(ctx, tx, tid, false)
	if e != nil {
		return e
	}
	if e = requiresPlan(ctx, tx, tid, needsPlan, owner); e != nil {
		return e
	}
	var active int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1 AND status IN ('queued','running')", tid).Scan(&active); e != nil {
		return e
	}
	if owner == nil && active >= concurrent {
		return errGraphCapacity
	}
	if owner != nil {
		if e = a.planRunSlot(ctx, tx, tid, workspaceLimits{active, concurrent, 0, 1, needsPlan}); errors.Is(e, errPlanBusy) || errors.Is(e, errInvocationQuota) {
			return errGraphCapacity
		} else if e != nil {
			return e
		}
	}
	var sid, state string
	var raw []byte
	var attempts int
	var retryPending bool
	e = tx.QueryRow(ctx, "SELECT session_id,state,execution_snapshot,attempts,retry_at IS NOT NULL AND retry_at>now() FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 FOR UPDATE", tid, gid, nid).Scan(&sid, &state, &raw, &attempts, &retryPending)
	if e != nil {
		return e
	}
	// A node waiting for its next attempt is admitted only once its retry_at has passed (graph_retry.go).
	if turn == nil && (state != "waiting" || retryPending) {
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
	if snap.Media != nil {
		// An image, video or 3D node: a paid generation, admitted on the same allowances as its own Send.
		if turn != nil {
			return errors.New("media_collaboration_unsupported")
		}
		today, err := a.workspaceRunsToday(ctx, tx, tid)
		if err != nil {
			return err
		}
		return a.admitGraphMedia(ctx, tx, tid, gid, nid, sid, actor, graphChildOperationID(gid, nid, attempts), prompt, snap, entitlement, owner != nil, readRouteLimits(routes), workspaceLimits{active, concurrent, today, daily, needsPlan})
	}
	// This node's catalog was frozen when the graph was admitted, which can be long
	// before this child is created — and a graph still queued has no child to
	// cancel at all. Re-stamping from the live row here is what keeps a narrowed
	// allowlist from being outlived by an already pinned model; the error is not
	// errGraphCapacity, so the node settles as failed rather than being retried.
	if e = snap.restamp(entitlement); e != nil {
		return e
	}
	if snap.Workspace != nil {
		inputs, err := materializeWorkspaceInputs(ctx, tx, tid, gid, nid)
		if err != nil {
			return err
		}
		snap.Workspace.Inputs = inputs
	}
	// Files a member uploaded into this node's inputs (or that its prompt otherwise names) go with it like a
	// composer's attachments: quoted text after the prompt, and the files themselves for a workspace runtime.
	var graphCanvas string
	if e = tx.QueryRow(ctx, "SELECT canvas_id FROM graph_runs WHERE tenant_id=$1 AND id=$2", tid, gid).Scan(&graphCanvas); e != nil {
		return e
	}
	workspaceRoom := 0
	if snap.Workspace != nil {
		workspaceRoom = maxWorkspaceInputBytes
		for _, input := range snap.Workspace.Inputs {
			workspaceRoom -= len(input.Content) * 3 / 4
		}
	}
	uploads, e := a.freezeUploadAttachments(ctx, tx, tid, graphCanvas, prompt, max(workspaceRoom, 0))
	if e != nil {
		return e
	}
	if uploads != nil && snap.Workspace != nil {
		snap.Workspace.Inputs = withWorkspaceFiles(snap.Workspace.Inputs, uploads.Workspace)
	}
	if turn != nil {
		if snap.Team != nil {
			return errors.New("collaboration_nested_team_unsupported")
		}
		// A graph critique is discussion, not a deliverable. Override only this
		// turn snapshot; proposal and synthesis retain the frozen contract.
		if turn.Phase == "review" {
			snap.OutputPolicy = "Server-owned collaboration review policy: Return Markdown critique only. This turn is discussion, not a node deliverable; do not follow the original output schema. Preserve the configured persona and review responsibilities."
			// The structured envelope goes with the deliverable, so a critique must not be
			// forced into it. Telling the model to write Markdown while the provider still
			// enforced a JSON schema would fail every review turn.
			snap.OutputContract = nil
			if snap.Workspace != nil {
				snap.Workspace.OutputFields = nil
			}
		}
		if e = appendCollaborationHistory(ctx, tx, tid, gid, nid, &snap); e != nil {
			return e
		}
	}
	if snap.Workspace != nil {
		prompt = workspaceGraphPrompt(prompt, snap.OutputPolicy)
	}
	if snap.OutputContract != nil {
		// The node prompt repeats the textual policy, and so does a proposal or synthesis
		// seed, so the allowance is withdrawn here as well, before the prompt is hashed and stored.
		prompt = withdrawPromptAllowance(prompt)
	}
	// Append quoted file bytes after the structured-format rewrite. Rewriting
	// server prose must never rewrite a matching sentence inside an attachment.
	if snap.Workspace == nil && turn == nil {
		var attached bool
		prompt, attached, e = graphTextFilePrompt(ctx, tx, tid, gid, nid, prompt)
		if e != nil {
			return e
		}
		if attached {
			snap.OutputPolicy += "\n\n" + graphFileDataPolicy
		}
	}
	if turn == nil {
		// A node of a canvas run shows its model the pictures it is given, as a message does (vision.go), moving to a
		// model that sees them when its own cannot; a collaboration's turns stay as they are.
		switchRoutes := routes
		if owner != nil {
			switchRoutes = nil
		}
		if e = a.switchToSeeingModel(ctx, tx, tid, switchRoutes, &snap, uploads); e != nil {
			return e
		}
		freezeVisionImages(&snap, uploads)
	}
	prompt = attachmentUserPrompt(prompt, uploads)
	instructions := graphSystemPrompt(snap.Instructions, effectiveOutputPolicy(snap))
	framed := func() string {
		return a.sentInstructions(lessonsSystemPrompt(memorySystemPrompt(knowledgeSystemPrompt(taskFrameSystemPrompt(skillsSystemPrompt(instructions, snap.Skills), snap.TaskFrame), snap.Knowledge), snap.Memory), snap.Lessons), snap)
	}
	framedInstructions := framed()
	framedPrompt := evidenceUserPrompt(prompt, snap.Knowledge, snap.Memory)
	promptTooLarge := utf16Len(framedPrompt) > maxRunPromptUnits
	tooLargeForModel := func() bool {
		return snap.Team == nil && (snap.tokens(framedPrompt)+snap.tokens(framedInstructions)+snap.Overhead+outputContractReserve(snap) > snap.Budget || len(utf16.Encode([]rune(framedInstructions))) > 32768)
	}
	// A node's lessons help its run, never refuse it (canvas_lessons.go): a run they would not let fit goes without them,
	// and its run's snapshot, which settling counts, names none.
	lessons := snap.Lessons
	if snap.Lessons != nil && !promptTooLarge && tooLargeForModel() {
		snap.Lessons = nil
		framedInstructions = framed()
	}
	// The planner's page skills are a default for a page's one call (plannerPageSkillRefs): a run they would not let fit
	// goes without them, and so does a sandbox run, whose worker keeps room for its workspace that this check cannot see.
	if snap.Market == nil && plannerPageSkills(snap.Skills) && !promptTooLarge && (snap.Workspace != nil || tooLargeForModel()) {
		snap.Skills = nil
		framedInstructions = framed()
		if !tooLargeForModel() {
			a.log.Info("a planned page runs without its design skills", "tenant", tid, "node", nid, "sandbox", snap.Workspace != nil)
		}
		// Lessons left out for room that leaving the skills out then made come back where they fit now.
		if lessons != nil && snap.Lessons == nil {
			snap.Lessons = lessons
			if framedInstructions = framed(); tooLargeForModel() {
				snap.Lessons = nil
				framedInstructions = framed()
			}
		}
	}
	if promptTooLarge || tooLargeForModel() {
		return errors.New("context_limit")
	}
	var busy bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM runs WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','running'))", tid, sid).Scan(&busy); e != nil {
		return e
	}
	if busy {
		return errGraphCapacity
	}
	// A market Agent's node runs only while the Agent still may (not suspended since the graph was admitted), at the
	// price frozen with the graph, and a paid one only while the graph's actor may still pay for it.
	var market *marketRun
	var marketPlan *activePlan
	if snap.Market != nil {
		if !a.cfg.MarketEnabled {
			return errors.New("market_unavailable")
		}
		if a.marketSandboxed(snap) {
			return errors.New("market_agent_not_usable")
		}
		// The owner's plan row before the Agent's, the order every admission keeps (loadMarketUse).
		if marketPlan, e = ownerPlan(ctx, tx, tid, true); e != nil {
			return e
		}
		m, v, err := loadMarketUse(ctx, tx, snap.Market.AgentID, snap.Market.Version, actor, false, true)
		if err != nil {
			return marketAdmissionCode(err)
		}
		if v.ContentHash != snap.Market.ContentHash {
			return errors.New("node_setup_required")
		}
		market = &marketRun{Agent: m, Version: v, Insider: snap.Market.Insider, Price: snap.Market.Price}
		if err = marketPaidRole(market, role); err != nil {
			return err
		}
	}
	rid := randomID()
	op := graphChildOperationID(gid, nid, attempts)
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
	if market != nil {
		// Held on the owner's plan, read under its row lock above.
		if err := a.reserveMarketCall(ctx, tx, tid, rid, actor, market, marketPlan); err != nil {
			return marketAdmissionCode(err)
		}
	}
	if _, e = tx.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'user',$5)", randomID(), tid, sid, rid, prompt); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, rid, `{"type":"queued"}`); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, graphNodeAdmittedSQL, tid, gid, nid, rid); e != nil {
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
	a.notifyRunEvent(rid)
	a.observeGraphNodeState("running")
	a.dispatch(tid, rid, sid, prompt, instructions, "graph", snap.Budget, snap.Overhead, ctx)
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
	var edits []string
	var cancelledNodes int64
	if status == "queued" || status == "running" {
		cancelledNodes, e = collaborationCancellationTransitionCount(r.Context(), tx, tid, id)
		if e != nil {
			a.dbError(w, e)
			return
		}
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
			// The caller stopped it: a market Agent's fee settles now, by what its run holds (market_use.go).
			if e = settleMarketCall(r.Context(), tx, tid, rid, false); e != nil {
				a.dbError(w, e)
				return
			}
		}
		if edits, e = cancelGraphEdits(r.Context(), tx, tid, id); e != nil {
			a.dbError(w, e)
			return
		}
		status, e = a.reconcileCancelledGraph(r.Context(), tx, tid, id)
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
	for _, rid := range ids {
		a.notifyRunEvent(rid)
	}
	a.stopEdits(edits)
	for i := int64(0); i < cancelledNodes; i++ {
		a.observeGraphNodeState("cancelled")
	}
	if cancelledNodes > 0 {
		a.observeGraph("cancelled")
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
	a.replyGraphRun(w, r, true)
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
	var edits []string
	var cancelledNodes int64
	if gid != "" && (status == "queued" || status == "running") {
		cancelledNodes, e = collaborationCancellationTransitionCount(r.Context(), tx, tid, gid)
		if e != nil {
			a.dbError(w, e)
			return
		}
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
			// The caller stopped it: a market Agent's fee settles now, by what its run holds (market_use.go).
			if e = settleMarketCall(r.Context(), tx, tid, id, false); e != nil {
				a.dbError(w, e)
				return
			}
		}
		if edits, e = cancelGraphEdits(r.Context(), tx, tid, gid); e != nil {
			a.dbError(w, e)
			return
		}
		status, e = a.reconcileCancelledGraph(r.Context(), tx, tid, gid)
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
	for _, id := range ids {
		a.notifyRunEvent(id)
	}
	a.stopEdits(edits)
	for i := int64(0); i < cancelledNodes; i++ {
		a.observeGraphNodeState("cancelled")
	}
	if cancelledNodes > 0 {
		a.observeGraph("cancelled")
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
func (a *App) reconcileCancelledGraph(ctx context.Context, tx pgx.Tx, tid, gid string) (string, error) {
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
	rows, e := tx.Query(ctx, "SELECT n.node_id,n.state,n.output,n.detail,COALESCE(n.run_id,''),COALESCE(r.status,''),COALESCE(r.output,''),COALESCE(r.error,''),n.state='waiting' AND n.retry_at IS NOT NULL FROM graph_run_nodes n LEFT JOIN runs r ON r.tenant_id=n.tenant_id AND r.id=n.run_id WHERE n.tenant_id=$1 AND n.graph_id=$2 FOR UPDATE OF n", tid, gid)
	if e != nil {
		return "", e
	}
	type row struct {
		id, state, output, detail, runID, runStatus, runOutput, runError string
		retrying                                                         bool
	}
	all := []row{}
	for rows.Next() {
		var r row
		if e = rows.Scan(&r.id, &r.state, &r.output, &r.detail, &r.runID, &r.runStatus, &r.runOutput, &r.runError, &r.retrying); e != nil {
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
			// A node waiting for its next attempt (graph_retry.go) still names the attempt that failed, which is in
			// its attempt log: the cancellation stops the retry, so the node ends cancelled, not failed.
			if r.runStatus != "" && !r.retrying {
				// graphOutput below validates a normalized copy, so project the same
				// normalization: recording the raw text would let a child stored before
				// stripping existed pass validation and still publish its scratchpad.
				r.output = stripReasoningPreamble(r.runOutput)
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
			if _, e = tx.Exec(ctx, "UPDATE graph_run_nodes SET state=$4,output=$5,detail=$6,retry_at=NULL WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3", tid, gid, r.id, r.state, r.output, r.detail); e != nil {
				return "", e
			}
			// A node whose run ended just before the stop counts the lessons that run was given, as setGraphNode would.
			if r.state == "done" || r.state == "failed" {
				if err := countRunLessons(ctx, tx, tid, r.runID, r.state, r.detail); err != nil {
					a.log.Warn("a stopped canvas run's node did not count its lessons", "error_type", errorType(err))
				}
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
	// Every node is settled now, and so are the experiences of the ones that were retried.
	if _, e = tx.Exec(ctx, settleGraphExperiencesSQL, tid, gid); e != nil {
		return "", e
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
