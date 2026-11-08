package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Writing changes of a canvas (docs/awwo-canvas-live-collaboration.md). PATCH applies a page's or an agent's ops to the
// current document in the server's order: each op changes only its own path (AWWO-LAW-027). Every write of a canvas
// document (this, a whole-document PUT, node setup) records its change under its new version before it is streamed
// (AWWO-LAW-028), so a page or an agent that holds a version catches up by the changes after it.

const (
	maxCanvasChangeOps = 500
	// The log keeps what a reader can be sent (canvasChangesAfter: canvasCatchUpMax changes, canvasCatchUpBytes of
	// ops, here as stored), always its latest canvasChangesKeptMin (a change sent again finds itself), and nothing
	// older than a day beyond those. It is pruned at each write of the canvas.
	canvasChangesKeptMin = 10
	canvasChangesKeptMax = canvasCatchUpMax
	// canvasCatchUpMax and canvasCatchUpBytes bound the changes one answer carries; a reader further behind gets the
	// document instead.
	canvasCatchUpMax   = 300
	canvasCatchUpBytes = 4 << 20
	// agentWriteClaim is how long the claim an agent's write takes holds (renewed by its next write).
	agentWriteClaim = 60 * time.Second
)

var (
	canvasClientIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	canvasChangeLabelPattern = regexp.MustCompile(`^[a-z]{0,16}$`)
	canvasNodeIDPattern      = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,80}$`)
)

// canvasChangeOut is one change as an answer or the stream sends it.
type canvasChangeOut struct {
	Version int64           `json:"version"`
	Actor   canvasActor     `json:"actor"`
	Label   string          `json:"label"`
	Ops     json.RawMessage `json:"ops"`
	At      time.Time       `json:"at"`
}

// documentChangeOps gives the ops from one stored document to another, false when either cannot be read as a document.
func documentChangeOps(before, after []byte) ([]canvasOp, bool) {
	a, err := decodeCanvasDocument(before)
	if err != nil {
		return nil, false
	}
	b, err := decodeCanvasDocument(after)
	if err != nil {
		return nil, false
	}
	return diffCanvas(a, b), true
}

// recordCanvasChange logs a canvas write as its change, under the canvas's new version; tx holds the canvas row. ops nil
// means a document the log could not follow (label "reset": readers read the document again).
//
// requestHash and results go with a change sent with an id (a PATCH): the hash of what was asked, each op's result.
func recordCanvasChange(ctx context.Context, tx pgx.Tx, tid, cid string, version int64, ops []canvasOp, actor canvasActor, changeID, label, requestHash string, results []string) error {
	if ops == nil {
		ops, label = []canvasOp{}, "reset"
	}
	for _, op := range ops {
		// A path no reader can apply (a record id or key the change model refuses, from a document written whole by a
		// page older than it): the change goes in the log as a reset, so every page and agent reads the canvas whole
		// rather than stopping at it.
		if _, err := parseCanvasPath(op.Path); err != nil {
			ops, label = []canvasOp{}, "reset"
			break
		}
	}
	raw, err := json.Marshal(ops)
	if err != nil {
		return err
	}
	var actorID, tokenID, change, hash, answered any
	if actor.UserID != "" {
		actorID = actor.UserID
	}
	if requestHash != "" {
		hash = requestHash
	}
	if results != nil {
		answered, _ = json.Marshal(results)
	}
	if actor.TokenID != "" {
		tokenID = actor.TokenID
	}
	if changeID != "" {
		change = changeID
	}
	if _, err = tx.Exec(ctx, `INSERT INTO canvas_changes(tenant_id,canvas_id,version,actor_kind,actor_id,token_id,client_id,change_id,label,ops,request_hash,results)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, tid, cid, version, actor.Kind, actorID, tokenID, actor.ClientID, change, label, raw, hash, answered); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM canvas_changes WHERE tenant_id=$1 AND canvas_id=$2 AND version<=$3-$4::bigint
		AND (version<=$3-$5::bigint OR created_at<clock_timestamp()-interval '24 hours'
			OR version<(SELECT COALESCE(min(t.version),0) FROM (SELECT version,sum(pg_column_size(ops)) OVER (ORDER BY version DESC) AS total
				FROM canvas_changes WHERE tenant_id=$1 AND canvas_id=$2 AND version>$3-$5::bigint) t WHERE t.total<=$6))`,
		tid, cid, version, canvasChangesKeptMin, canvasChangesKeptMax, canvasCatchUpBytes)
	return err
}

// recordDocumentWrite logs a write of the whole document (a PUT, node setup) by the diff of its two documents, and lets
// go of the claims on the nodes it deleted; released says whether any went (the canvas's streams then hear of it).
func recordDocumentWrite(ctx context.Context, tx pgx.Tx, tid, cid string, version int64, before, after []byte, actor canvasActor, label string) (released bool, err error) {
	ops, ok := documentChangeOps(before, after)
	if !ok {
		ops = nil
	}
	if released, err = releaseDeletedNodeClaims(ctx, tx, tid, cid, ops); err != nil {
		return false, err
	}
	return released, recordCanvasChange(ctx, tx, tid, cid, version, ops, actor, "", label, "", nil)
}

// canvasChangesAfter reads a canvas's changes after a version up to current, with their actors' names. reset is true when
// the log does not hold every one of them (pruned, written while an API kept no log, or too many to send).
func canvasChangesAfter(ctx context.Context, q querier, tid, cid string, after, current int64) ([]canvasChangeOut, bool, error) {
	out := []canvasChangeOut{}
	if after >= current {
		return out, false, nil
	}
	if after < 1 || current-after > canvasCatchUpMax {
		return nil, true, nil
	}
	rows, err := q.Query(ctx, `SELECT c.version,c.actor_kind,COALESCE(c.actor_id,''),COALESCE(c.token_id,''),c.client_id,c.label,c.ops,c.created_at,
		CASE WHEN c.token_id IS NOT NULL THEN COALESCE(t.name,'') WHEN c.actor_kind='awwo' THEN 'AwwO' ELSE `+shownUserName+` END
		FROM canvas_changes c LEFT JOIN users u ON u.id=c.actor_id LEFT JOIN canvas_agent_tokens t ON t.tenant_id=c.tenant_id AND t.id=c.token_id
		WHERE c.tenant_id=$1 AND c.canvas_id=$2 AND c.version>$3 AND c.version<=$4 ORDER BY c.version`, tid, cid, after, current)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	size := 0
	expect := after + 1
	for rows.Next() {
		var c canvasChangeOut
		var ops []byte
		if err = rows.Scan(&c.Version, &c.Actor.Kind, &c.Actor.UserID, &c.Actor.TokenID, &c.Actor.ClientID, &c.Label, &ops, &c.At, &c.Actor.Name); err != nil {
			return nil, false, err
		}
		if c.Version != expect || c.Label == "reset" {
			return nil, true, nil
		}
		size += len(ops)
		if size > canvasCatchUpBytes {
			return nil, true, nil
		}
		c.Ops = ops
		out = append(out, c)
		expect++
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	if expect != current+1 {
		return nil, true, nil
	}
	return out, false, nil
}

// canvasChanges answers GET .../canvases/{id}/changes?after=v.
func (a *App) canvasChanges(w http.ResponseWriter, r *http.Request) {
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if err != nil || after < 0 {
		fail(w, 400, "invalid_input", "after must be a version")
		return
	}
	var version int64
	var document json.RawMessage
	if err = a.db.QueryRow(r.Context(), "SELECT version,document FROM canvases WHERE tenant_id=$1 AND id=$2", tid, cid).Scan(&version, &document); noRows(err) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	} else if err != nil {
		a.dbError(w, err)
		return
	}
	a.touchCanvasAgent(r, tid, cid)
	changes, reset, err := canvasChangesAfter(r.Context(), a.db, tid, cid, after, version)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if reset {
		writeJSON(w, 200, map[string]any{"version": version, "reset": true, "document": document})
		return
	}
	writeJSON(w, 200, map[string]any{"version": version, "changes": changes})
}

// touchCanvasAgent keeps an agent that reads or writes a canvas on it, as a participant.
func (a *App) touchCanvasAgent(r *http.Request, tid, cid string) {
	if agentOf(r) == nil {
		return
	}
	a.multiplayer.touch(tid, cid, liveJoin{actor: canvasActorOf(r, "")})
}

// liveClientIDOK says whether the caller may use a client id: a page's own (never one starting "t_", the ids the server
// gives agent tokens, so no page passes for an agent), or anything an agent sends (its participant is its token anyway).
func liveClientIDOK(r *http.Request, id string) bool {
	return canvasClientIDPattern.MatchString(id) && (agentOf(r) != nil || !strings.HasPrefix(id, "t_"))
}

// patchCanvas answers PATCH .../canvases/{id}: the sender's ops applied to the current document.
func (a *App) patchCanvas(w http.ResponseWriter, r *http.Request) {
	var b struct {
		BaseVersion int64      `json:"baseVersion"`
		ChangeID    string     `json:"changeId"`
		ClientID    string     `json:"clientId"`
		Ops         []canvasOp `json:"ops"`
		Label       string     `json:"label"`
	}
	if !a.decodeCanvas(w, r, &b) {
		return
	}
	agent := agentOf(r)
	if agent != nil {
		b.ClientID, b.Label = "t_"+agent.TokenID, "agent"
	}
	if b.BaseVersion < 1 || !liveClientIDOK(r, b.ClientID) || (b.ChangeID != "" && !canvasClientIDPattern.MatchString(b.ChangeID)) ||
		len(b.Ops) == 0 || len(b.Ops) > maxCanvasChangeOps || !canvasChangeLabelPattern.MatchString(b.Label) {
		fail(w, 400, "invalid_input", fmt.Sprintf("baseVersion, clientId and 1 to %d ops are required", maxCanvasChangeOps))
		return
	}
	for i, op := range b.Ops {
		if _, err := parseCanvasPath(op.Path); err != nil {
			fail(w, 400, "invalid_op", fmt.Sprintf("op %d: %v", i, err))
			return
		}
	}
	w, release, ok := a.canvasSave(w, r)
	if !ok {
		return
	}
	defer release()
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	if _, ok := a.canvasWriteRole(w, r, tx, tid, 2); !ok {
		return
	}
	// A page's id is seen by everyone on the canvas: a change sent under one another person holds would pass on that
	// page for its own (and so be undone by its next save).
	if agent == nil && a.multiplayer.heldByOther(tid, cid, canvasActorOf(r, b.ClientID)) {
		fail(w, 409, "client_taken", "Someone else on this canvas uses this page id: open the canvas again")
		return
	}
	var version int64
	var saved []byte
	released := false
	if err = tx.QueryRow(ctx, "SELECT version,document FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, cid).Scan(&version, &saved); noRows(err) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	} else if err != nil {
		a.dbError(w, err)
		return
	}
	actor := canvasActorOf(r, b.ClientID)
	if b.BaseVersion > version {
		fail(w, 409, "version_ahead", "baseVersion is newer than the canvas")
		return
	}
	// A change sent again (its answer was lost) is answered with what happened, each op's result as first answered, and
	// never applied twice; the same id asking something else is refused.
	requestHash := canvasChangeRequestHash(b.Ops, b.Label)
	if b.ChangeID != "" {
		var made int64
		var hash string
		var answered []byte
		err = tx.QueryRow(ctx, "SELECT version,COALESCE(request_hash,''),results FROM canvas_changes WHERE tenant_id=$1 AND canvas_id=$2 AND change_id=$3", tid, cid, b.ChangeID).Scan(&made, &hash, &answered)
		if err == nil {
			if hash != requestHash {
				fail(w, 409, "idempotency_conflict", "This change id was used for another change")
				return
			}
			var results []string
			_ = json.Unmarshal(answered, &results)
			a.answerCanvasChange(w, r, tx, tid, cid, b.BaseVersion, version, saved, results, canvasResultReasons(b.Ops, results), true)
			return
		}
		if !noRows(err) {
			a.dbError(w, err)
			return
		}
	}
	applied, err := a.applyCanvasChange(ctx, tx, tid, cid, saved, b.Ops, actor)
	var refusal canvasChangeRefusal
	if errors.As(err, &refusal) {
		fail(w, refusal.status, refusal.code, refusal.message)
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	if len(applied.effective) > 0 {
		if err = tx.QueryRow(ctx, "UPDATE canvases SET document=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version", tid, cid, applied.document).Scan(&version); err != nil {
			a.dbError(w, err)
			return
		}
		if err = recordCanvasChange(ctx, tx, tid, cid, version, applied.effective, actor, b.ChangeID, b.Label, requestHash, applied.results); err != nil {
			a.dbError(w, err)
			return
		}
		action := "canvas.changed"
		if agent != nil {
			action = "canvas.agent_changed"
		}
		if err = audit(ctx, tx, actor.UserID, tid, action, cid); err != nil {
			a.dbError(w, err)
			return
		}
		if released, err = releaseDeletedNodeClaims(ctx, tx, tid, cid, applied.effective); err != nil {
			a.dbError(w, err)
			return
		}
		// A change of the canvas's evolution this change makes is done with it, as after a whole-document save.
		a.settleEvolutionBySave(ctx, tx, tid, cid, actor.UserID)
		saved = applied.document
	}
	a.answerCanvasChange(w, r, tx, tid, cid, b.BaseVersion, version, saved, applied.results, applied.reasons, false)
	if len(applied.effective) > 0 {
		a.multiplayer.changed(tid, cid)
	}
	if applied.claimed || released {
		a.multiplayer.claimsChanged(tid, cid)
	}
	a.touchCanvasAgent(r, tid, cid)
}

// canvasChangeRequestHash names what a change asked: its ops as sent and its label.
func canvasChangeRequestHash(ops []canvasOp, label string) string {
	raw, _ := json.Marshal(struct {
		Ops   []canvasOp `json:"ops"`
		Label string     `json:"label"`
	}{ops, label})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// answerCanvasChange commits and answers a change: its version, each op's result (with reasons, one per op, when one was
// refused), and every change after the sender's base (or the document, when the log no longer reaches back).
func (a *App) answerCanvasChange(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid, cid string, base, version int64, document []byte, results, reasons []string, duplicate bool) {
	ctx := r.Context()
	changes, reset, err := canvasChangesAfter(ctx, tx, tid, cid, base, version)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	out := map[string]any{"version": version, "results": results}
	if canvasChangeRefused(results) {
		out["reasons"] = reasons
	}
	if duplicate {
		out["duplicate"] = true
	}
	if reset {
		out["reset"] = true
		out["document"] = json.RawMessage(document)
	} else {
		out["changes"] = changes
	}
	writeJSON(w, 200, out)
}

// canvasChangeRefusal refuses a whole change, with its HTTP status.
type canvasChangeRefusal struct {
	status        int
	code, message string
}

func (e canvasChangeRefusal) Error() string { return e.message }

// canvasAddOnlyWires marks, in a request's context, a change that may only add wires (MCP's canvas_connect): a set on a
// wire id the canvas already has never replaces that wire, judged under the canvas row's lock (addOnlyWire). Pages name
// wires as the tool does (from:port->to:port), so the wire there may be a person's or the planner's feedback wire of the
// same ports, which a set would make a data wire, or, as node ids and ports may hold ":", another wire whose ends spell
// the same id. Only this process sets the mark, never a request.
type canvasAddOnlyWires struct{}

// addOnlyWire answers an add-only wire op whose id the canvas has: done already when the wire there is a data wire
// joining the same ports, else refused; the wire there is left as it is either way.
func addOnlyWire(op canvasOp, existing any) (string, string) {
	var want, have graphEdge
	_ = json.Unmarshal(op.Value, &want)
	_ = json.Unmarshal(mustCanvasJSON(existing), &have)
	kind := "data"
	if len(have.Kind) != 0 && string(have.Kind) != `"data"` {
		kind = "non-data"
		var named string
		if json.Unmarshal(have.Kind, &named) == nil && named != "" {
			kind = named
		}
	}
	sameEnds := have.FromNode == want.FromNode && have.FromPort == want.FromPort && have.ToNode == want.ToNode && have.ToPort == want.ToPort
	switch {
	case sameEnds && kind == "data":
		return "ok", ""
	case sameEnds:
		return "forbidden", canvasOpTarget(op) + ": a " + reasonBit(kind) + " wire joins these ports already, and connecting only adds; it is left as it is"
	}
	return "forbidden", canvasOpTarget(op) + ": another wire on the canvas has this id, and connecting only adds; canvas_apply can add this one under an id of its own"
}

// appliedCanvasChange is a change worked out on the current document: the document after it, its effective ops (empty
// when it changes nothing), each op's result and the reason of each refused one ("" for one done), and whether it took
// a claim.
type appliedCanvasChange struct {
	document  []byte
	effective []canvasOp
	results   []string
	reasons   []string
	claimed   bool
}

// applyCanvasChange applies ops to the saved document under the fence of running nodes, the claims (an agent's), the
// rules for agents and the rules every save keeps. tx holds the canvas row.
func (a *App) applyCanvasChange(ctx context.Context, tx pgx.Tx, tid, cid string, saved []byte, ops []canvasOp, actor canvasActor) (appliedCanvasChange, error) {
	out := appliedCanvasChange{results: make([]string, len(ops)), reasons: make([]string, len(ops))}
	before, err := decodeCanvasDocument(saved)
	if err != nil {
		return out, canvasChangeRefusal{409, "canvas_unreadable", "The saved canvas cannot be read as a document; reload it"}
	}
	// Bounded before any of it is done: a document grown far past what the canvas draws would cost seconds per op.
	if canvasChangeWork(before, ops) > canvasChangeWorkMax {
		return out, canvasChangeRefusal{413, "canvas_change_too_large", "This change is too large for a canvas of this size"}
	}
	work, _ := decodeCanvasDocument(saved)
	busy, err := runningCanvasNodes(ctx, tx, tid, cid)
	if err != nil {
		return out, err
	}
	var claims map[string]canvasClaimRow
	if actor.Kind == "agent" {
		if claims, err = activeCanvasClaims(ctx, tx, tid, cid); err != nil {
			return out, err
		}
	}
	nodesBefore, edgesBefore := len(collectionOf(before, "nodes")), len(collectionOf(before, "edges"))
	claimFor := map[string]bool{}
	held := map[int]string{} // the ops refused "claimed", each with the node someone else holds
	addOnly, _ := ctx.Value(canvasAddOnlyWires{}).(bool)
	for i, op := range ops {
		if actor.Kind == "agent" {
			next, refusal, why := agentOp(op, work, actor)
			if refusal != "" {
				out.results[i], out.reasons[i] = refusal, why
				continue
			}
			op = next
		}
		targets := canvasOpNodes(op, work)
		result := ""
		for _, node := range targets {
			// The person who started a node's run may still change it (their page fences it); nobody else, no agent.
			if starters, running := busy[node]; running && !(actor.Kind == "human" && starters[actor.UserID]) && !freeDuringRun(op, work) {
				result, out.reasons[i] = "node_running", runningReason(op, node)
				break
			}
			if actor.Kind == "agent" {
				if claim, ok := claims[node]; ok && claim.participant != actor.participantID() {
					result, held[i] = "claimed", node
					break
				}
			}
		}
		if result != "" {
			out.results[i] = result
			continue
		}
		if addOnly && op.Op == canvasOpSet && len(op.Path) == 2 && op.Path[0] == "edges" {
			if j := findRecord(collectionOf(work, "edges"), "id", op.Path[1]); j >= 0 {
				out.results[i], out.reasons[i] = addOnlyWire(op, collectionOf(work, "edges")[j])
				continue
			}
		}
		done, err := applyCanvasOp(work, op)
		if err != nil {
			return out, canvasChangeRefusal{400, "invalid_op", fmt.Sprintf("op %d: %v", i, err)}
		}
		out.results[i] = "ok"
		if !done {
			out.results[i], out.reasons[i] = "gone", goneReason(op, work)
			continue
		}
		if actor.Kind == "agent" {
			for _, node := range targets {
				claimFor[node] = true
			}
		}
	}
	dropDanglingEdges(work)
	reconcileCanvasWires(work)
	if n, e := len(collectionOf(work, "nodes")), len(collectionOf(work, "edges")); (n > maxGraphNodes && n > nodesBefore) || (e > maxGraphEdges && e > edgesBefore) {
		return out, canvasChangeRefusal{409, "canvas_limit", fmt.Sprintf("A canvas holds at most %d nodes and %d wires", maxGraphNodes, maxGraphEdges)}
	}
	if duplicateNodeIDs(work) && !duplicateNodeIDs(before) {
		return out, canvasChangeRefusal{400, "invalid_op", "Two nodes would have one id"}
	}
	after, err := json.Marshal(work)
	if err != nil {
		return out, err
	}
	after = preserveCanvasSkills(saved, preserveCanvasTaskFrames(saved, after))
	if err = validateCanvasTaskFrames(after); err != nil {
		return out, canvasChangeRefusal{400, "invalid_task_frame", err.Error()}
	}
	if err = validateCanvasSkills(after); err != nil {
		var s skillError
		if errors.As(err, &s) {
			return out, canvasChangeRefusal{s.status, s.code, s.message}
		}
		return out, canvasChangeRefusal{400, "invalid_skill", err.Error()}
	}
	if int64(len(after)) > maxCanvasBodyBytes {
		return out, canvasChangeRefusal{413, "canvas_too_large", "The canvas would be over its 8 MB bound"}
	}
	final, err := decodeCanvasDocument(after)
	if err != nil {
		return out, err
	}
	out.document, out.effective = after, diffCanvas(before, final)
	if len(claimFor) > 0 {
		taken, err := takeAgentClaims(ctx, tx, tid, cid, actor, claimFor, final)
		if err != nil {
			return out, err
		}
		out.claimed = taken
	}
	if len(held) > 0 {
		// Who holds them, by name as everyone on the canvas sees the claims (read only when an op was refused for one).
		holders, err := listCanvasClaims(ctx, tx, tid, cid)
		if err != nil {
			return out, err
		}
		for i, node := range held {
			out.reasons[i] = claimedReason(ops[i], node, holders)
		}
	}
	return out, nil
}

// runningCanvasNodes gives the nodes of a canvas in an active run (a canvas run's scope, or a node's own conversation),
// each with the people who started those runs.
func runningCanvasNodes(ctx context.Context, tx pgx.Tx, tid, cid string) (map[string]map[string]bool, error) {
	rows, err := tx.Query(ctx, `SELECT s.node_id,r.actor_id FROM node_sessions s JOIN runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.id
		WHERE s.tenant_id=$1 AND s.canvas_id=$2 AND r.status IN ('queued','running')
		UNION ALL SELECT n.id,g.actor_id FROM graph_runs g CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.scope)='array' THEN g.scope ELSE '[]'::jsonb END) AS n(id)
		WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.status IN ('queued','running')`, tid, cid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	busy := map[string]map[string]bool{}
	for rows.Next() {
		var node string
		var actor *string
		if err = rows.Scan(&node, &actor); err != nil {
			return nil, err
		}
		if busy[node] == nil {
			busy[node] = map[string]bool{}
		}
		if actor != nil {
			busy[node][*actor] = true
		}
	}
	return busy, rows.Err()
}

// canvasOpNodes gives the nodes an op changes: the node of a node path, and the node a wire leads into.
func canvasOpNodes(op canvasOp, doc map[string]any) []string {
	if len(op.Path) < 2 {
		return nil
	}
	switch op.Path[0] {
	case "nodes":
		return []string{op.Path[1]}
	case "edges":
		var to string
		if op.Op == canvasOpSet {
			var edge struct {
				ToNode string `json:"toNode"`
			}
			_ = json.Unmarshal(op.Value, &edge)
			to = edge.ToNode
		}
		if i := findRecord(collectionOf(doc, "edges"), "id", op.Path[1]); i >= 0 {
			if edge, ok := collectionOf(doc, "edges")[i].(map[string]any); ok {
				if existing, ok := edge["toNode"].(string); ok && existing != to {
					if to == "" {
						to = existing
					} else {
						return []string{to, existing}
					}
				}
			}
		}
		if to != "" {
			return []string{to}
		}
	}
	return nil
}

// The fields of a running node anyone may change: where it is and its drawer, and the results every page watching the
// run publishes alike.
var (
	freeRunningNodeFields   = map[string]bool{"x": true, "y": true, "w": true, "h": true, "deliverablesOpen": true, "lastOutput": true, "preview": true, "issueId": true}
	freeRunningThreadFields = map[string]bool{"lastOutput": true, "outputValues": true, "preview": true, "issueId": true}
)

func freeDuringRun(op canvasOp, doc map[string]any) bool {
	p := op.Path
	if len(p) < 3 || p[0] != "nodes" || op.Op == canvasOpOrder {
		return false
	}
	if len(p) == 3 {
		if freeRunningNodeFields[p[2]] {
			return true
		}
		// A contract whose only change is its outputs' values: a run's results.
		return p[2] == "contract" && op.Op == canvasOpSet && contractOnlyOutputValues(doc, p[1], op.Value)
	}
	return len(p) == 5 && p[2] == "threads" && freeRunningThreadFields[p[4]]
}

func contractOnlyOutputValues(doc map[string]any, nodeID string, next json.RawMessage) bool {
	i := findRecord(collectionOf(doc, "nodes"), "id", nodeID)
	if i < 0 {
		return false
	}
	node, _ := collectionOf(doc, "nodes")[i].(map[string]any)
	current, ok := node["contract"]
	if !ok {
		return false
	}
	proposed, err := decodeCanvasValue(next)
	if err != nil {
		return false
	}
	blank := func(v any) any {
		contract, ok := v.(map[string]any)
		if !ok {
			return v
		}
		copyContract := cloneObject(contract)
		if outputs, ok := contract["outputs"].([]any); ok {
			cleared := make([]any, len(outputs))
			for j, field := range outputs {
				if f, ok := field.(map[string]any); ok {
					f = cloneObject(f)
					delete(f, "value")
					cleared[j] = f
				} else {
					cleared[j] = field
				}
			}
			copyContract["outputs"] = cleared
		}
		return copyContract
	}
	return sameCanvasValue(blank(current), blank(proposed))
}

// dropDanglingEdges removes the wires whose node is gone.
func dropDanglingEdges(doc map[string]any) {
	nodes := map[string]bool{}
	for _, n := range collectionOf(doc, "nodes") {
		if id, ok := recordKey(n, "id"); ok {
			nodes[id] = true
		}
	}
	edges := collectionOf(doc, "edges")
	kept := make([]any, 0, len(edges))
	for _, e := range edges {
		edge, ok := e.(map[string]any)
		from, _ := edge["fromNode"].(string)
		to, _ := edge["toNode"].(string)
		if ok && nodes[from] && nodes[to] {
			kept = append(kept, e)
		}
	}
	if len(kept) != len(edges) {
		doc["edges"] = kept
	}
}

// wireNode is what the port rules read of a node (nodePort, edgeTypesFit): its kind, agent kind and contract, read
// without the rest of it (its results can be large).
func wireNode(node map[string]any) graphNode {
	n := graphNode{}
	n.ID, _ = node["id"].(string)
	n.Kind, _ = node["kind"].(string)
	n.AgentKind, _ = node["agentKind"].(string)
	if contract, ok := node["contract"]; ok && contract != nil {
		var c graphContract
		if json.Unmarshal(mustCanvasJSON(contract), &c) == nil {
			n.Contract = &c
		}
	}
	return n
}

// missingContractField says whether a port names a contract field the node does not have (a field removed while a
// wire led to it): the one case where both the page and a canvas run know for certain the wire has no end.
func missingContractField(n graphNode, port string, input bool) bool {
	prefix := "out:"
	if input {
		prefix = "in:"
	}
	return n.Contract != nil && strings.HasPrefix(port, prefix)
}

// reconcileCanvasWires keeps each wire as the canvas reads it (ports.ts reconcileEdges) and a canvas run checks it
// (parseGraph): its type is its source port's, where the port rules know both ends and the types fit; a wire into or
// out of a contract field the node no longer has goes. A wire the rules cannot judge (a port they do not know, types
// they do not fit) is left as it is: the server never drops what a page may still read as a wire.
func reconcileCanvasWires(doc map[string]any) {
	edges := collectionOf(doc, "edges")
	if len(edges) == 0 {
		return
	}
	nodes := map[string]graphNode{}
	for _, item := range collectionOf(doc, "nodes") {
		if node, ok := item.(map[string]any); ok {
			if id, ok := recordKey(node, "id"); ok {
				if _, dup := nodes[id]; !dup {
					nodes[id] = wireNode(node)
				}
			}
		}
	}
	changed := false
	kept := make([]any, 0, len(edges))
	for _, item := range edges {
		edge, ok := item.(map[string]any)
		if !ok {
			kept = append(kept, item)
			continue
		}
		from, _ := edge["fromNode"].(string)
		to, _ := edge["toNode"].(string)
		fromPort, _ := edge["fromPort"].(string)
		toPort, _ := edge["toPort"].(string)
		src, sok := nodes[from]
		dst, dok := nodes[to]
		if !sok || !dok {
			kept = append(kept, item)
			continue
		}
		st, sp := nodePort(src, fromPort, false)
		dt, dp := nodePort(dst, toPort, true)
		if (!sp && missingContractField(src, fromPort, false)) || (!dp && missingContractField(dst, toPort, true)) {
			changed = true
			continue
		}
		if sp && dp && edgeTypesFit(src, fromPort, st, dt) && edge["dataType"] != st {
			next := cloneObject(edge)
			next["dataType"] = st
			kept = append(kept, next)
			changed = true
			continue
		}
		kept = append(kept, item)
	}
	if changed {
		doc["edges"] = kept
	}
}

func duplicateNodeIDs(doc map[string]any) bool {
	seen := map[string]bool{}
	for _, n := range collectionOf(doc, "nodes") {
		if id, ok := recordKey(n, "id"); ok {
			if seen[id] {
				return true
			}
			seen[id] = true
		}
	}
	return false
}

// releaseDeletedNodeClaims lets go of the claims on the nodes a change deleted; it says whether any went (the canvas's
// streams then hear of it).
func releaseDeletedNodeClaims(ctx context.Context, tx pgx.Tx, tid, cid string, ops []canvasOp) (bool, error) {
	gone := []string{}
	for _, op := range ops {
		if op.Op == canvasOpDel && len(op.Path) == 2 && op.Path[0] == "nodes" {
			gone = append(gone, op.Path[1])
		}
	}
	if len(gone) == 0 {
		return false, nil
	}
	tag, err := tx.Exec(ctx, "DELETE FROM canvas_claims WHERE tenant_id=$1 AND canvas_id=$2 AND node_id=ANY($3::text[])", tid, cid, gone)
	return err == nil && tag.RowsAffected() > 0, err
}

// The agent's rules (docs/awwo-canvas-live-collaboration.md, "What an agent may change").

// agentNodeFields are the fields of a node an agent may set, each for the kinds that have it.
var agentNodeFields = map[string]map[string]bool{
	"title": nil, "x": nil, "y": nil, "w": nil, "h": nil, "deliverablesOpen": nil, "lastOutput": nil,
	"persona":  {"session": true},
	"fields":   {"form": true},
	"template": {"assemble": true}, "fileName": {"assemble": true},
	"timeline": {"edit": true},
}

// agentOp checks an agent's op, giving it as it is applied (an agent's result stamped as a manual one, a new node built
// from what an agent may set), or the result that refuses it with its reason: what it would change, the rule, and what
// to do instead (canvas_change_reasons.go).
func agentOp(op canvasOp, doc map[string]any, actor canvasActor) (canvasOp, string, string) {
	p := op.Path
	refuse := func(why string) (canvasOp, string, string) { return op, "forbidden", canvasOpTarget(op) + ": " + why }
	const notOneRecord = "order takes a list, not one record, and the one list an agent puts in order is the nodes (path nodes)"
	if len(p) == 0 {
		return refuse("an op names a path")
	}
	switch p[0] {
	case "nodes":
		if len(p) == 1 {
			if op.Op == canvasOpOrder {
				return op, "", ""
			}
			return refuse("an agent adds, changes and deletes nodes one by one, each by its own path (nodes/<id>)")
		}
		index := findRecord(collectionOf(doc, "nodes"), "id", p[1])
		var node map[string]any
		if index >= 0 {
			node, _ = collectionOf(doc, "nodes")[index].(map[string]any)
		}
		kind, _ := node["kind"].(string)
		if len(p) == 2 {
			switch {
			case op.Op == canvasOpDel:
				return op, "", ""
			case op.Op == canvasOpOrder:
				return refuse(notOneRecord)
			case op.Op != canvasOpSet:
				return refuse("an op is set, del or order")
			case index >= 0:
				return refuse("it is on the canvas already, and an agent changes a node that is there field by field (nodes/<id>/<field>)")
			}
			value, why := agentNewNode(p[1], op.Value, actor)
			if why != "" {
				return refuse(why)
			}
			return canvasOp{Op: canvasOpSet, Path: p, Value: value}, "", ""
		}
		if index < 0 {
			return op, "", "" // its node is gone: applying it does nothing
		}
		if len(p) == 3 {
			kinds, allowed := agentNodeFields[p[2]]
			switch {
			case !allowed:
				return refuse("it is not open to agents: " + agentFieldsRule)
			case kinds != nil && !kinds[kind]:
				owners := []string{}
				for owner := range kinds {
					owners = append(owners, owner)
				}
				sort.Strings(owners)
				return refuse(fmt.Sprintf("%s has no %s (only %s does)", kindPhrase(kind), reasonBit(p[2]), kindPhrase(owners[0])))
			case op.Op == canvasOpOrder && p[2] == "fields":
				return refuse("an agent does not reorder a form's fields: set fields whole, in the order wanted")
			case op.Op == canvasOpOrder:
				return refuse(notOneRecord)
			case op.Op == canvasOpDel:
				if p[2] == "lastOutput" || p[2] == "fileName" {
					return op, "", ""
				}
				return refuse("an agent deletes only a node's lastOutput (its result) and fileName: set it to a new value instead")
			}
			value, why := agentFieldValue(p[2], op.Value, actor)
			if why != "" {
				return refuse(why)
			}
			return canvasOp{Op: canvasOpSet, Path: p, Value: value}, "", ""
		}
		switch {
		case p[2] == "threads":
			return refuse("an agent does not change a node's conversations")
		case p[2] != "fields":
			return refuse("it is not open to agents: " + agentFieldsRule)
		case kind != "form":
			return refuse(kindPhrase(kind) + " has no fields (only a form does)")
		case op.Op == canvasOpOrder:
			return refuse(notOneRecord)
		case len(p) == 4 && op.Op == canvasOpDel:
			return op, "", ""
		case len(p) == 4:
			field, why := agentFormField(p[3], op.Value)
			if why != "" {
				return refuse(why)
			}
			return canvasOp{Op: canvasOpSet, Path: p, Value: field}, "", ""
		case p[4] != "label" && p[4] != "value":
			return refuse("an agent sets a field's label and value (its id stays)")
		case op.Op != canvasOpSet:
			return refuse("an agent sets a field's label or value, or deletes the whole field (nodes/<id>/fields/<field id>)")
		}
		var s string
		if json.Unmarshal(op.Value, &s) != nil || len(s) > 20000 {
			return refuse("a field's label or value is text of at most 20,000 bytes")
		}
		return op, "", ""
	case "edges":
		switch {
		case len(p) != 2:
			return refuse("an agent adds and removes wires one by one (edges/<id>) and does not reorder them")
		case op.Op == canvasOpDel:
			return op, "", ""
		}
		value, why := agentEdge(p[1], op.Value, doc)
		if why != "" && op.Op == canvasOpOrder {
			return refuse(notOneRecord)
		}
		if why != "" {
			return refuse(why)
		}
		return canvasOp{Op: canvasOpSet, Path: p, Value: value}, "", ""
	}
	return refuse("an agent changes nodes and wires only, not the canvas's own settings, displays or saved views")
}

func finiteNumber(raw json.RawMessage, bound float64) (float64, bool) {
	var f float64
	if json.Unmarshal(raw, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > bound {
		return 0, false
	}
	return f, true
}

// agentFieldValue checks one field an agent sets, giving the value to store, or the rule the value breaks.
func agentFieldValue(key string, raw json.RawMessage, actor canvasActor) (json.RawMessage, string) {
	text := func(limit int, name, rule string) (json.RawMessage, string) {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil, name + " is text (a JSON string)"
		}
		if len(s) > limit {
			return nil, rule
		}
		return raw, ""
	}
	switch key {
	case "title":
		return text(200, "a title", "a title is text of at most 200 bytes (UTF-8: about 66 Chinese characters); shorten it")
	case "persona":
		return text(32000, "a persona", "a persona is text of at most 32,000 bytes; shorten it")
	case "template":
		return text(1<<20, "a template", "a template is text of at most 1 MiB")
	case "timeline":
		return text(1<<20, "a timeline", "a timeline is text of at most 1 MiB")
	case "fileName":
		var s string
		if json.Unmarshal(raw, &s) != nil || len(s) > 200 || strings.ContainsAny(s, `/\`) {
			return nil, `a file name is text of at most 200 bytes, without / or \`
		}
		return raw, ""
	case "x", "y":
		if _, ok := finiteNumber(raw, 1e7); !ok {
			return nil, "x and y are numbers from -10,000,000 to 10,000,000"
		}
		return raw, ""
	case "w", "h":
		f, ok := finiteNumber(raw, 1e5)
		if !ok {
			return nil, "w and h are numbers from 40 to 100,000"
		}
		if f < 40 {
			return nil, "w and h are at least 40 (no node is drawn smaller); give 40 or more"
		}
		return raw, ""
	case "deliverablesOpen":
		var b bool
		if json.Unmarshal(raw, &b) != nil {
			return nil, "deliverablesOpen is true or false"
		}
		return raw, ""
	case "fields":
		var list []json.RawMessage
		if json.Unmarshal(raw, &list) != nil {
			return nil, "fields is a list of fields {id, label, value}"
		}
		if len(list) > 100 {
			return nil, "fields set whole are at most 100"
		}
		clean := make([]json.RawMessage, 0, len(list))
		seen := map[string]bool{}
		for _, item := range list {
			var f struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(item, &f) != nil {
				return nil, "each field is an object {id, label, value}"
			}
			if seen[f.ID] {
				return nil, "two fields have the id " + reasonBit(f.ID) + "; give each field an id of its own"
			}
			seen[f.ID] = true
			field, why := agentFormField(f.ID, item)
			if why != "" {
				return nil, why
			}
			clean = append(clean, field)
		}
		out, _ := json.Marshal(clean)
		return out, ""
	case "lastOutput":
		var o struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &o) != nil || o.Text == "" {
			return nil, "a result is {text} with some text; to clear one, delete lastOutput (an empty result in canvas_update_node)"
		}
		if len(o.Text) > 4<<20 {
			return nil, "a result's text is at most 4 MiB"
		}
		// An agent's result is never shown as AwwO's engine's: it is kept as one handed in, at the time it came.
		out, _ := json.Marshal(map[string]any{"text": o.Text, "at": time.Now().UnixMilli(), "source": "manual", "by": map[string]string{"kind": "agent", "name": actor.Name}})
		return out, ""
	}
	return nil, "it is not open to agents: " + agentFieldsRule
}

// agentFormField checks a form field an agent sets under the id its path names, giving it or the rule it breaks.
func agentFormField(id string, raw json.RawMessage) (json.RawMessage, string) {
	var f struct {
		ID    string `json:"id"`
		Label string `json:"label"`
		Value string `json:"value"`
	}
	switch {
	case json.Unmarshal(raw, &f) != nil:
		return nil, "a field is an object {id, label, value} of text"
	case f.ID != id:
		return nil, "a field set here carries the id its path names (" + reasonBit(id) + ")"
	case f.ID == "":
		return nil, "a field needs an id of 1 to 80 ASCII letters, digits, _ . : or -"
	case !canvasNodeIDPattern.MatchString(f.ID):
		return nil, "a field's id is 1 to 80 ASCII letters, digits, _ . : or -, which " + strconv.Quote(reasonBit(f.ID)) + " is not; rename the field"
	case len(f.Label) > 200:
		return nil, "a field's label is text of at most 200 bytes"
	case len(f.Value) > 20000:
		return nil, "a field's value is text of at most 20,000 bytes"
	}
	out, _ := json.Marshal(f)
	return out, ""
}

// agentNewNode builds a new node an agent adds from what it may set: a session node with nothing chosen yet (a person
// picks its runtime and model), or a form; or it gives the rule the node breaks.
func agentNewNode(id string, raw json.RawMessage, actor canvasActor) (json.RawMessage, string) {
	if !canvasNodeIDPattern.MatchString(id) {
		return nil, "a new node's id is 1 to 80 ASCII letters, digits, _ . : or -"
	}
	var given map[string]json.RawMessage
	if json.Unmarshal(raw, &given) != nil {
		return nil, "a new node is an object {id, kind, title, ...}"
	}
	var kind string
	_ = json.Unmarshal(given["kind"], &kind)
	node := map[string]any{"id": id, "kind": kind}
	switch kind {
	case "session":
		node["agentKind"], node["runtime"], node["model"], node["effort"], node["persona"] = "llm", "", "", "", ""
		node["binding"], node["bindAttempt"], node["issueId"], node["preview"] = nil, nil, nil, ""
		node["title"], node["w"], node["h"] = "Agent", 340, 260
	case "form":
		node["title"], node["fields"], node["w"], node["h"] = "需求表单", []any{}, 300, 200
	case "":
		return nil, "a new node names its kind: an agent adds session and form nodes"
	default:
		return nil, "an agent adds session and form nodes only, not " + kindPhrase(kind)
	}
	node["x"], node["y"] = 0, 0
	keys := make([]string, 0, len(given))
	for key := range given {
		keys = append(keys, key)
	}
	sort.Strings(keys) // the first key a node is refused for is the same every time
	for _, key := range keys {
		if key == "id" || key == "kind" {
			continue
		}
		kinds, allowed := agentNodeFields[key]
		if !allowed || (kinds != nil && !kinds[kind]) {
			return nil, "it cannot carry " + reasonBit(key) + ": " + agentNewNodeRule(kind)
		}
		checked, why := agentFieldValue(key, given[key], actor)
		if why != "" {
			return nil, why
		}
		var decoded any
		if json.Unmarshal(checked, &decoded) != nil {
			return nil, "its " + key + " cannot be read"
		}
		node[key] = decoded
	}
	out, err := json.Marshal(node)
	if err != nil {
		return nil, "it cannot be written"
	}
	return out, ""
}

// The inputs that take many wires (ports.ts portsFor: multi): a session's context, a video's references and voices, an
// edit's clips, sounds and pictures.
func multiInput(node graphNode, port string) bool {
	switch port {
	case "context":
		return node.Kind == "session" && node.Contract == nil
	case "reference", "audio":
		return node.Kind == "session" && node.AgentKind == mediaKindVideo
	case "clips", "sounds", "pictures":
		return node.Kind == "edit"
	}
	return false
}

// agentEdge checks a wire an agent adds against its nodes' ports and types, as a canvas run does (graph_contracts.go),
// giving it with its data type the source port's own, or the rule it breaks.
func agentEdge(id string, raw json.RawMessage, doc map[string]any) (json.RawMessage, string) {
	var e graphEdge
	switch {
	case json.Unmarshal(raw, &e) != nil:
		return nil, "a wire is an object {id, fromNode, fromPort, toNode, toPort}"
	case e.ID != id:
		return nil, "a wire set here carries the id its path names (" + reasonBit(id) + ")"
	case len(e.Kind) != 0 && string(e.Kind) != `"data"`:
		return nil, "an agent adds data wires only"
	}
	nodes := collectionOf(doc, "nodes")
	read := func(nodeID, end string) (graphNode, string) {
		i := findRecord(nodes, "id", nodeID)
		if i < 0 && nodeID == "" {
			return graphNode{}, "the wire names no node at its " + end + " (" + map[string]string{"start": "fromNode", "end": "toNode"}[end] + ")"
		}
		if i < 0 {
			return graphNode{}, "node " + reasonBit(nodeID) + " is not on the canvas (a wire joins two nodes that are); read the canvas again"
		}
		var n graphNode
		if json.Unmarshal(mustCanvasJSON(nodes[i]), &n) != nil {
			return graphNode{}, "node " + reasonBit(nodeID) + " cannot be read as a node, so no wire joins it"
		}
		return n, ""
	}
	src, why := read(e.FromNode, "start")
	if why != "" {
		return nil, why
	}
	dst, why := read(e.ToNode, "end")
	if why != "" {
		return nil, why
	}
	if e.FromNode == e.ToNode {
		return nil, "a wire joins two different nodes, and this one would lead from node " + reasonBit(e.FromNode) + " back into itself"
	}
	st, sp := nodePort(src, e.FromPort, false)
	dt, dp := nodePort(dst, e.ToPort, true)
	switch {
	case !sp:
		return nil, portReason(src, e.FromPort, false)
	case !dp:
		return nil, portReason(dst, e.ToPort, true)
	case !edgeTypesFit(src, e.FromPort, st, dt):
		return nil, fmt.Sprintf("node %s's %s gives %s and node %s's %s takes %s; join an output and an input of one type "+
			"(an image, video, audio or 3D result may also go into a text input)", reasonBit(e.FromNode), reasonBit(e.FromPort), reasonBit(st), reasonBit(e.ToNode), reasonBit(e.ToPort), reasonBit(dt))
	}
	if !multiInput(dst, e.ToPort) {
		for _, other := range collectionOf(doc, "edges") {
			if edge, ok := other.(map[string]any); ok && edge["toNode"] == e.ToNode && edge["toPort"] == e.ToPort && edge["id"] != id {
				wired, _ := edge["id"].(string)
				return nil, fmt.Sprintf("node %s's %s takes one wire and has one already (%s); wire another input or, if that wire may go, remove it first",
					reasonBit(e.ToNode), reasonBit(e.ToPort), reasonBit(wired))
			}
		}
	}
	out, _ := json.Marshal(map[string]string{"id": id, "fromNode": e.FromNode, "fromPort": e.FromPort, "toNode": e.ToNode, "toPort": e.ToPort, "dataType": st})
	return out, ""
}
