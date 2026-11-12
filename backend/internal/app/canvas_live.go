package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// The live stream of a canvas and what goes with it (docs/awwo-canvas-live-collaboration.md): its changes, who is on it
// (presence), its claims and its live messages. A stream sends only what is committed (AWWO-LAW-028); it re-checks
// access every 15 s and ends at once when the API stops.

const (
	liveHelloMessages   = 30
	liveMessagePageSize = 50
	liveMessagesKept    = 200
	maxLiveMessageRunes = 2000
	maxLiveStatusRunes  = 140
	// liveAwwoEvery bounds how often a stream reads which of its canvas's nodes AwwO's Agents run now.
	liveAwwoEvery = 2 * time.Second
)

// liveMessage is a live message as the stream and the answers send it.
type liveMessage struct {
	ID            string    `json:"id"`
	AuthorKind    string    `json:"authorKind"`
	ParticipantID string    `json:"participantId"`
	Name          string    `json:"name"`
	Color         string    `json:"color"`
	NodeID        string    `json:"nodeId"`
	Text          string    `json:"text"`
	CreatedAt     time.Time `json:"createdAt"`
}

// liveMessageIDPattern is what a live message's id looks like (randomID).
var liveMessageIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// livePresenceSelectionMax is how many selected nodes a participant's presence carries: more are cut (everyone sees
// the first ones), so a large selection costs every stream on the canvas no more than this.
const livePresenceSelectionMax = 100

// liveMessageColumns and liveMessageFrom read live messages as liveMessage scans them (scanLiveMessages).
const (
	liveMessageColumns = `m.id,m.author_kind,m.user_id,COALESCE(m.token_id,''),
		CASE WHEN m.token_id IS NOT NULL THEN COALESCE(t.name,'') ELSE ` + shownUserName + ` END,m.node_id,m.text,m.created_at`
	liveMessageFrom = `canvas_live_messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN canvas_agent_tokens t ON t.tenant_id=m.tenant_id AND t.id=m.token_id`
)

func listLiveMessages(ctx context.Context, q querier, tid, cid string, before string, limit int) ([]liveMessage, error) {
	rows, err := q.Query(ctx, `SELECT `+liveMessageColumns+` FROM `+liveMessageFrom+`
		WHERE m.tenant_id=$1 AND m.canvas_id=$2
		AND ($3='' OR (m.created_at,m.id)<(SELECT b.created_at,b.id FROM canvas_live_messages b WHERE b.tenant_id=$1 AND b.canvas_id=$2 AND b.id=$3))
		ORDER BY m.created_at DESC,m.id DESC LIMIT $4`, tid, cid, before, limit)
	if err != nil {
		return nil, err
	}
	return scanLiveMessages(rows)
}

// liveMessageCursor is a position among the live messages of a canvas: the newest message a canvas agent token has
// been given (migration 057), or the one a wait was told it has (afterMessage). The messages others wrote after it are
// news. A position before every message is ('epoch', ""): a token made on a canvas without one.
type liveMessageCursor struct {
	at time.Time
	id string
}

// newestLiveMessageAt and newestLiveMessageID are SQL for the position of the newest message of a canvas (its tenant
// and canvas the SQL given), or the position before every message when it has none.
func newestLiveMessageAt(tenant, canvas string) string {
	return "COALESCE((SELECT created_at FROM canvas_live_messages WHERE tenant_id=" + tenant + " AND canvas_id=" + canvas +
		" ORDER BY created_at DESC,id DESC LIMIT 1),'epoch')"
}
func newestLiveMessageID(tenant, canvas string) string {
	return "COALESCE((SELECT id FROM canvas_live_messages WHERE tenant_id=" + tenant + " AND canvas_id=" + canvas +
		" ORDER BY created_at DESC,id DESC LIMIT 1),'')"
}

// liveMessageCursorOf gives a token's cursor. A token made before tokens kept one has none: it is set now to the newest
// message its canvas holds (which of the earlier ones it saw is not known, so none of them comes again). Two first reads
// at once each read it back after either set it.
func (a *App) liveMessageCursorOf(ctx context.Context, tid, cid, tokenID string) (liveMessageCursor, error) {
	var at *time.Time
	var id *string
	read := func() error {
		return a.db.QueryRow(ctx, "SELECT seen_message_at,seen_message_id FROM canvas_agent_tokens WHERE tenant_id=$1 AND id=$2 AND canvas_id=$3",
			tid, tokenID, cid).Scan(&at, &id)
	}
	if err := read(); err != nil {
		return liveMessageCursor{}, err
	}
	if at == nil {
		if err := a.withMessagesHeld(ctx, tid, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, "UPDATE canvas_agent_tokens SET seen_message_at="+newestLiveMessageAt("$1", "$3")+",seen_message_id="+newestLiveMessageID("$1", "$3")+
				" WHERE tenant_id=$1 AND id=$2 AND canvas_id=$3 AND seen_message_at IS NULL", tid, tokenID, cid)
			return err
		}); err != nil {
			return liveMessageCursor{}, err
		}
		if err := read(); err != nil {
			return liveMessageCursor{}, err
		}
	}
	if at == nil || id == nil {
		return liveMessageCursor{}, fmt.Errorf("the token's newest given message is not set")
	}
	return liveMessageCursor{at: *at, id: *id}, nil
}

// liveMessageAt gives the position of a message of a canvas; false when the canvas holds none of that id (never had it,
// or it went with the 200 kept).
func liveMessageAt(ctx context.Context, q querier, tid, cid, id string) (liveMessageCursor, bool, error) {
	var c liveMessageCursor
	err := q.QueryRow(ctx, "SELECT created_at,id FROM canvas_live_messages WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3", tid, cid, id).Scan(&c.at, &c.id)
	if noRows(err) {
		return c, false, nil
	}
	return c, err == nil, err
}

// liveMessagesAfter gives the live messages of a canvas written after a position by anyone but a token, the oldest first,
// at most limit; more says that more follow. The tenant's row, which every write of a message locks first
// (canvasWriteRole), orders the writes, and each is stamped after the newest of its canvas (canvasLiveSay): a message
// committed after this read is newer than every one it gave, whatever the clock did.
func liveMessagesAfter(ctx context.Context, q querier, tid, cid, tokenID string, after liveMessageCursor, limit int) ([]liveMessage, bool, error) {
	rows, err := q.Query(ctx, `SELECT `+liveMessageColumns+` FROM `+liveMessageFrom+`
		WHERE m.tenant_id=$1 AND m.canvas_id=$2 AND m.token_id IS DISTINCT FROM $3 AND (m.created_at,m.id)>($4::timestamptz,$5::text)
		ORDER BY m.created_at,m.id LIMIT $6`, tid, cid, tokenID, after.at, after.id, limit+1)
	if err != nil {
		return nil, false, err
	}
	items, err := scanLiveMessages(rows)
	if err != nil || len(items) <= limit {
		return items, false, err
	}
	return items[:limit], true, nil
}

// markLiveMessagesGiven moves a token's cursor up to a message it has been given (never back), while that message is
// still there: one that went since it was read (with its author's account) may have been the newest of its canvas, so
// a message written after it may be stamped below it, and the cursor stays where it was. It moves with the workspace
// row held (withMessagesHeld), so no message is stamped between the check and the move. A cursor that could not be
// kept costs that token those messages again at its next wait, never a message.
func (a *App) markLiveMessagesGiven(ctx context.Context, tid, tokenID string, newest liveMessage) {
	if err := a.withMessagesHeld(ctx, tid, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE canvas_agent_tokens t SET seen_message_at=$3,seen_message_id=$4 WHERE t.tenant_id=$1 AND t.id=$2
			AND (t.seen_message_at IS NULL OR (t.seen_message_at,t.seen_message_id)<($3::timestamptz,$4::text))
			AND EXISTS(SELECT 1 FROM canvas_live_messages m WHERE m.tenant_id=$1 AND m.canvas_id=t.canvas_id AND m.id=$4)`, tid, tokenID, newest.CreatedAt, newest.ID)
		return err
	}); err != nil {
		a.log.Warn("a canvas agent token's newest given message was not kept; it is given its messages again", "error_type", errorType(err))
	}
}

// withMessagesHeld runs a cursor's move in a transaction holding the workspace's row for share: every write of a live
// message takes that row for update before it stamps its message (canvasLiveSay), so none is stamped while the move
// runs, and the next one is stamped above the cursor the move left (the statement after the lock reads what was
// committed before it, a message gone with its author's account included). Its locks wait 2 s at most: the row held
// for share holds up the workspace's writers while the move waits for its token's row (one an account's deletion
// holds, say), and a move given up costs its token those messages again, never a message.
func (a *App) withMessagesHeld(ctx context.Context, tid string, move func(pgx.Tx) error) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SET LOCAL lock_timeout = '2s'"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", tid); err != nil {
		return err
	}
	if err = move(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scanLiveMessages(rows pgx.Rows) ([]liveMessage, error) {
	defer rows.Close()
	out := []liveMessage{}
	for rows.Next() {
		var m liveMessage
		var userID, tokenID string
		if err := rows.Scan(&m.ID, &m.AuthorKind, &userID, &tokenID, &m.Name, &m.NodeID, &m.Text, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.ParticipantID = "u_" + userID
		if tokenID != "" {
			m.ParticipantID = "t_" + tokenID
		}
		m.Color = liveColor(m.ParticipantID)
		out = append(out, m)
	}
	return out, rows.Err()
}

// canvasLiveMessages answers GET .../live/messages?before=id: the 50 messages before that one, the newest first. It
// moves no token's cursor: what canvas_wait gives does not hang on what an agent read here.
func (a *App) canvasLiveMessages(w http.ResponseWriter, r *http.Request) {
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	before := r.URL.Query().Get("before")
	if before != "" && !liveMessageIDPattern.MatchString(before) {
		fail(w, 400, "invalid_input", "Invalid message id")
		return
	}
	if !a.canvasExists(w, r, tid, cid) {
		return
	}
	items, err := listLiveMessages(r.Context(), a.db, tid, cid, before, liveMessagePageSize)
	if err != nil {
		a.dbError(w, err)
		return
	}
	a.touchCanvasAgent(r, tid, cid)
	writeJSON(w, 200, map[string]any{"items": items})
}

// canvasLiveSay answers POST .../live/messages: one line to everyone on the canvas.
func (a *App) canvasLiveSay(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ClientID string `json:"clientId"`
		Text     string `json:"text"`
		NodeID   string `json:"nodeId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if agentOf(r) != nil {
		b.ClientID = "t_" + agentOf(r).TokenID
	}
	b.Text = strings.TrimSpace(b.Text)
	if !liveClientIDOK(r, b.ClientID) || b.Text == "" || len([]rune(b.Text)) > maxLiveMessageRunes || len(b.NodeID) > 200 {
		fail(w, 400, "invalid_input", fmt.Sprintf("clientId and a text of 1 to %d characters are required", maxLiveMessageRunes))
		return
	}
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
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2)", tid, cid).Scan(&exists); err != nil {
		a.dbError(w, err)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	actor := canvasActorOf(r, b.ClientID)
	kind, token := "human", any(nil)
	if actor.Kind == "agent" {
		kind, token = "agent", actor.TokenID
	}
	id := randomID()
	// Stamped after the newest message of its canvas and after every token's cursor there, whatever the clock did (it may
	// step back, and a message goes with its author's account): with the tenant's row locked above, a message written
	// later is never older, so a cursor of canvas_wait never passes one it did not give.
	if _, err = tx.Exec(ctx, `INSERT INTO canvas_live_messages(id,tenant_id,canvas_id,author_kind,user_id,token_id,node_id,text,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,
		GREATEST(clock_timestamp(),(SELECT max(created_at)+interval '1 microsecond' FROM canvas_live_messages WHERE tenant_id=$2 AND canvas_id=$3),
			(SELECT max(seen_message_at)+interval '1 microsecond' FROM canvas_agent_tokens WHERE tenant_id=$2 AND canvas_id=$3)))`,
		id, tid, cid, kind, actor.UserID, token, b.NodeID, b.Text); err != nil {
		a.dbError(w, err)
		return
	}
	if _, err = tx.Exec(ctx, `DELETE FROM canvas_live_messages WHERE tenant_id=$1 AND canvas_id=$2 AND id IN (
		SELECT id FROM canvas_live_messages WHERE tenant_id=$1 AND canvas_id=$2 ORDER BY created_at DESC,id DESC OFFSET $3)`, tid, cid, liveMessagesKept); err != nil {
		a.dbError(w, err)
		return
	}
	items, err := listLiveMessages(ctx, tx, tid, cid, "", 1)
	if err != nil || len(items) == 0 || items[0].ID != id {
		a.dbError(w, fmt.Errorf("the message just written cannot be read back: %v", err))
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	a.multiplayer.message(tid, cid, items[0])
	a.touchCanvasAgent(r, tid, cid)
	writeJSON(w, 200, map[string]any{"message": items[0]})
}

func (a *App) canvasExists(w http.ResponseWriter, r *http.Request, tid, cid string) bool {
	var exists bool
	if err := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2)", tid, cid).Scan(&exists); err != nil {
		a.dbError(w, err)
		return false
	}
	if !exists {
		fail(w, 404, "not_found", "Canvas not found")
	}
	return exists
}

// livePresenceParts are the parts of a state a presence post may send; the stream's hello names them, so a page sends
// only what the API takes.
var livePresenceParts = []string{"selection", "focus", "cursor", "status", "preview", "editing", "viewport"}

// canvasLivePresence answers POST .../live/presence: the parts of the caller's state it sends (the others stay).
func (a *App) canvasLivePresence(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ClientID string                     `json:"clientId"`
		State    map[string]json.RawMessage `json:"state"`
	}
	if !a.decodeWithin(w, r, &b, livePresenceBodyBytes) {
		return
	}
	agent := agentOf(r)
	if agent != nil {
		b.ClientID = "t_" + agent.TokenID
	}
	if !liveClientIDOK(r, b.ClientID) {
		fail(w, 400, "invalid_input", "clientId is required")
		return
	}
	// A person's role as their session's check found it (a.tenant, or livePresenceAccess within its trust), after the
	// count of membership changes livePresenceAccess took: only one who may edit shows edits in progress and the field
	// they type in.
	role := ""
	if agent == nil {
		role = tenantRoleOf(r)
	}
	since, _ := r.Context().Value(liveMembersKey{}).(uint64)
	update, err := parseLiveState(b.State, agent != nil, agent == nil && roleLevel(role) >= roleLevel("member"))
	if err != nil {
		fail(w, 400, "invalid_input", err.Error())
		return
	}
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	actor := canvasActorOf(r, b.ClientID)
	if agent != nil {
		a.touchCanvasAgent(r, tid, cid)
	}
	switch a.multiplayer.setState(tid, cid, actor, role, since, update) {
	case liveStateTooFast:
		w.Header().Set("Retry-After", "1")
		fail(w, 429, "presence_too_fast", fmt.Sprintf("At most %d presence updates a second: send the latest again in a moment", livePresencePerSecond))
		return
	case liveStateAbsent:
		// Nothing moved: no page of the caller's is on this canvas (an agent's post with no one on it, a page between its
		// streams). Another workspace's canvas, or none, answers 404 as everywhere (AWWO-LAW-001), also to a session
		// trusted for presence (livePresenceAccess); asked only here, so a post on a canvas someone is on reads no row.
		if !a.canvasExists(w, r, tid, cid) {
			return
		}
	}
	w.WriteHeader(204)
}

// liveIDOK is what a node or port id in a state looks like: as the selection's.
func liveIDOK(id string) bool { return id != "" && len(id) <= 200 }

// liveFieldPattern is a field's key in a state's editing: a page's own name for it.
var liveFieldPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,120}$`)

// parseLivePreview reads an edit in progress: nil for none (null, or nothing in it).
func parseLivePreview(raw json.RawMessage) (*livePreview, error) {
	bad := fmt.Errorf("preview is {nodes: [{id, x, y}] (at most %d), resize: {id, x, y, w, h}, wire: {node, port, side, from, to}} or null", livePreviewNodesMax)
	var p *livePreview
	if json.Unmarshal(raw, &p) != nil {
		return nil, bad
	}
	if p == nil {
		return nil, nil
	}
	if len(p.Nodes) > livePreviewNodesMax {
		return nil, bad
	}
	seen := map[string]bool{}
	nodes := make([]livePreviewNode, 0, len(p.Nodes))
	for _, n := range p.Nodes {
		if !liveIDOK(n.ID) || !finiteWorld(n.X) || !finiteWorld(n.Y) {
			return nil, bad
		}
		if !seen[n.ID] {
			seen[n.ID] = true
			nodes = append(nodes, n)
		}
	}
	p.Nodes = nodes
	if box := p.Resize; box != nil && (!liveIDOK(box.ID) || !finiteWorld(box.X) || !finiteWorld(box.Y) || !finiteSize(box.W) || !finiteSize(box.H)) {
		return nil, bad
	}
	if wire := p.Wire; wire != nil && (!liveIDOK(wire.Node) || !liveIDOK(wire.Port) || (wire.Side != "input" && wire.Side != "output") ||
		!finiteWorld(wire.From.X) || !finiteWorld(wire.From.Y) || !finiteWorld(wire.To.X) || !finiteWorld(wire.To.Y)) {
		return nil, bad
	}
	if len(p.Nodes) == 0 && p.Resize == nil && p.Wire == nil {
		return nil, nil
	}
	return p, nil
}

// finiteSize is a box's width or height on the board: more than nothing, and finite.
func finiteSize(f float64) bool { return finiteWorld(f) && f > 0 }

// parseLiveState reads the parts of a state a participant sends. An agent has no pointer and no screen. Only a person who
// may edit (`editor`: a member or above) shows an edit in progress (preview) or the field they type in (editing): from a
// reader or a token the server drops those parts, whatever they hold, as it drops an agent's pointer; the rest of what
// they send is kept, so a reader's page is seen on the canvas.
func parseLiveState(state map[string]json.RawMessage, agent, editor bool) (liveUpdate, error) {
	var steps []func(*liveState)
	preview := false
	for key, raw := range state {
		switch key {
		case "selection":
			var ids []string
			if json.Unmarshal(raw, &ids) != nil || len(ids) > maxGraphNodes {
				return liveUpdate{}, fmt.Errorf("selection is a list of at most %d node ids", maxGraphNodes)
			}
			for _, id := range ids {
				if !liveIDOK(id) {
					return liveUpdate{}, fmt.Errorf("a selected node id is empty or too long")
				}
			}
			ids = uniqueStrings(ids)
			if len(ids) > livePresenceSelectionMax {
				ids = ids[:livePresenceSelectionMax]
			}
			steps = append(steps, func(s *liveState) { s.Selection = ids })
		case "focus":
			var focus *string
			if json.Unmarshal(raw, &focus) != nil || (focus != nil && !liveIDOK(*focus)) {
				return liveUpdate{}, fmt.Errorf("focus is a node id or null")
			}
			steps = append(steps, func(s *liveState) { s.Focus = focus })
		case "cursor":
			var point *livePoint
			if json.Unmarshal(raw, &point) != nil || (point != nil && (!finiteWorld(point.X) || !finiteWorld(point.Y))) {
				return liveUpdate{}, fmt.Errorf("cursor is {x, y} or null")
			}
			if agent {
				point = nil
			}
			steps = append(steps, func(s *liveState) { s.Cursor = point })
		case "status":
			var status *string
			if json.Unmarshal(raw, &status) != nil || (status != nil && len([]rune(*status)) > maxLiveStatusRunes) {
				return liveUpdate{}, fmt.Errorf("status is at most %d characters, or null", maxLiveStatusRunes)
			}
			if status != nil {
				trimmed := strings.TrimSpace(*status)
				status = &trimmed
				if trimmed == "" {
					status = nil
				}
			}
			steps = append(steps, func(s *liveState) { s.Status = status })
		case "preview":
			p, err := parseLivePreview(raw)
			if err != nil {
				return liveUpdate{}, err
			}
			if agent || !editor {
				continue
			}
			preview = p != nil
			steps = append(steps, func(s *liveState) { s.Preview = p })
		case "editing":
			var editing *liveEditing
			if json.Unmarshal(raw, &editing) != nil || (editing != nil && (!liveIDOK(editing.Node) || !liveFieldPattern.MatchString(editing.Field))) {
				return liveUpdate{}, fmt.Errorf("editing is {node, field} or null")
			}
			if agent || !editor {
				continue
			}
			steps = append(steps, func(s *liveState) { s.Editing = editing })
		case "viewport":
			var viewport *liveViewport
			if json.Unmarshal(raw, &viewport) != nil || (viewport != nil && (!finiteWorld(viewport.X) || !finiteWorld(viewport.Y) ||
				!finiteSize(viewport.W) || !finiteSize(viewport.H))) {
				return liveUpdate{}, fmt.Errorf("viewport is {x, y, w, h} or null")
			}
			if agent {
				continue
			}
			steps = append(steps, func(s *liveState) { s.Viewport = viewport })
		default:
			return liveUpdate{}, fmt.Errorf("unknown state part %q", key)
		}
	}
	return liveUpdate{apply: func(s *liveState) {
		for _, step := range steps {
			step(s)
		}
	}, preview: preview}, nil
}

func finiteWorld(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) && math.Abs(f) <= 1e7 }

// liveAwwoAgents gives AwwO's Agents running on a canvas's nodes now, as participants: one per running node run. Only
// the running nodes' titles and models are read from the document.
func liveAwwoAgents(ctx context.Context, q querier, tid, cid string) ([]liveParticipant, error) {
	rows, err := q.Query(ctx, `SELECT s.node_id,r.id,r.status,r.created_at FROM node_sessions s JOIN runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.id
		WHERE s.tenant_id=$1 AND s.canvas_id=$2 AND r.status IN ('queued','running') ORDER BY r.created_at,r.id LIMIT 64`, tid, cid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type running struct {
		node, run, status string
		since             time.Time
	}
	found := []running{}
	for rows.Next() {
		var x running
		if err = rows.Scan(&x.node, &x.run, &x.status, &x.since); err != nil {
			return nil, err
		}
		found = append(found, x)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := []liveParticipant{}
	if len(found) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(found))
	for _, x := range found {
		ids = append(ids, x.node)
	}
	names := map[string][2]string{}
	nodeRows, err := q.Query(ctx, `SELECT n->>'id',COALESCE(n->>'title',''),COALESCE(n->>'model','') FROM canvases c
		CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) AS n
		WHERE c.tenant_id=$1 AND c.id=$2 AND n->>'id'=ANY($3::text[])`, tid, cid, ids)
	if err != nil {
		return nil, err
	}
	for nodeRows.Next() {
		var id, title, model string
		if err = nodeRows.Scan(&id, &title, &model); err != nil {
			nodeRows.Close()
			return nil, err
		}
		if _, seen := names[id]; !seen {
			names[id] = [2]string{title, model}
		}
	}
	nodeRows.Close()
	if err = nodeRows.Err(); err != nil {
		return nil, err
	}
	for _, x := range found {
		title, model := names[x.node][0], names[x.node][1]
		node, status := x.node, x.status
		id := "run_" + x.run
		out = append(out, liveParticipant{ID: id, Kind: "awwo", Port: "awwo", Name: title, Color: liveColor("run_" + x.node), Model: model,
			State: liveState{Selection: []string{node}, Focus: &node, Status: &status}, Since: x.since})
	}
	return out, nil
}

// liveAccess says whether a stream's caller may still read the canvas: a person's session (with ClawHunt's) and
// membership, or a token's liveness and its maker's membership as an owner or admin (who alone hold tokens:
// admitCanvasToken); and the canvas is still there.
// liveAccess checks again that the caller still reaches the canvas: false with no error is a definite no (the stream
// says bye access); an error (the database, ClawHunt unreachable) is no answer, and the caller tries again later.
func (a *App) liveAccess(r *http.Request, tid, cid string) (bool, error) {
	_, ok, err := a.liveAccessRole(r, tid, cid)
	return ok, err
}

// liveAccessRole is liveAccess with a person's role in the workspace now (empty for an agent). A workspace the free
// plan's end has closed since the caller was admitted (the end came, or its owner's plan lapsed) is reached by nobody
// (free_plan.go planLocked): a stream open since before is told to go at its next check, and an agent's wait answers
// nothing of the canvas; the caller's next request is refused with the rest of the workspace.
func (a *App) liveAccessRole(r *http.Request, tid, cid string) (string, bool, error) {
	ctx := r.Context()
	if locked, err := a.planLocked(ctx, tid); err != nil || locked {
		return "", false, err
	}
	var ok bool
	if agent := agentOf(r); agent != nil {
		err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM canvas_agent_tokens t JOIN memberships m ON m.tenant_id=t.tenant_id AND m.user_id=t.created_by
			JOIN canvases c ON c.tenant_id=t.tenant_id AND c.id=t.canvas_id
			WHERE t.tenant_id=$1 AND t.id=$2 AND t.canvas_id=$3 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() AND m.role IN ('owner','admin'))`, tid, agent.TokenID, cid).Scan(&ok)
		return "", err == nil && ok, err
	}
	c, _ := r.Cookie("awwo_session")
	if c == nil {
		return "", false, nil
	}
	var role string
	err := a.db.QueryRow(ctx, `SELECT m.role FROM memberships m JOIN auth_sessions s ON s.user_id=m.user_id JOIN canvases c ON c.tenant_id=m.tenant_id
		WHERE m.tenant_id=$1 AND m.user_id=$2 AND s.token_hash=$3 AND s.expires_at>now() AND c.id=$4`, tid, currentUser(r).ID, tokenHash(c.Value), cid).Scan(&role)
	if noRows(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	var issuer, subject string
	var grant []byte
	if err = a.db.QueryRow(ctx, "SELECT COALESCE(sso_issuer,''),COALESCE(sso_subject,''),sso_grant FROM auth_sessions WHERE token_hash=$1", tokenHash(c.Value)).Scan(&issuer, &subject, &grant); err != nil {
		if noRows(err) {
			return "", false, nil
		}
		return "", false, err
	}
	valid, err := a.validateClawHuntSession(ctx, tokenHash(c.Value), currentUser(r).ID, issuer, subject, grant)
	if err != nil || !valid {
		return "", false, err
	}
	return role, true, nil
}

// canvasLiveEvents answers GET .../live/events?after=v&client=c&device=d: the canvas's live stream. `device` is what
// the page says it runs in (liveDevices); it is shown, never trusted.
func (a *App) canvasLiveEvents(w http.ResponseWriter, r *http.Request) {
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	ctx := r.Context()
	after := int64(0)
	if s := r.URL.Query().Get("after"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			fail(w, 400, "invalid_cursor", "after must be a version")
			return
		}
		after = v
	}
	clientID := r.URL.Query().Get("client")
	if agentOf(r) != nil {
		clientID = "t_" + agentOf(r).TokenID
	}
	if !liveClientIDOK(r, clientID) {
		fail(w, 400, "invalid_input", "client is required")
		return
	}
	var version int64
	if err := a.db.QueryRow(ctx, "SELECT version FROM canvases WHERE tenant_id=$1 AND id=$2", tid, cid).Scan(&version); noRows(err) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	} else if err != nil {
		a.dbError(w, err)
		return
	}
	device := ""
	if d := r.URL.Query().Get("device"); agentOf(r) == nil && liveDevices[d] {
		device = d
	}
	actor := canvasActorOf(r, clientID)
	var stream *liveStream
	refused := liveStale
	// A person's role is read after the count of membership changes is taken, and their stream opens only if no change
	// of theirs came meanwhile: else it is read again. One that came after the stream opened finds the stream
	// (membersChanged), so a removal or a new role never passes a stream by.
	for tries := 0; refused == liveStale && tries < 3; tries++ {
		role, since := "", uint64(0)
		if agentOf(r) == nil {
			since = a.multiplayer.memberCount()
			err := a.db.QueryRow(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, currentUser(r).ID).Scan(&role)
			if noRows(err) {
				// Removed, or gone, since a.tenant let the request in: as for anyone who is no member (AWWO-LAW-001).
				fail(w, 404, "not_found", "Workspace not found")
				return
			}
			if err != nil {
				a.dbError(w, err)
				return
			}
		}
		stream, refused = a.multiplayer.open(tid, cid, liveJoin{actor: actor, role: role, device: device, since: since})
	}
	if refused == liveStale {
		w.Header().Set("Retry-After", "1")
		fail(w, 503, "membership_changing", "Your membership of this workspace is changing: open the canvas again in a moment")
		return
	}
	if refused == liveTaken {
		fail(w, 409, "client_taken", "Someone else on this canvas uses this page id: open the canvas again")
		return
	}
	if refused != "" {
		w.Header().Set("Retry-After", "10")
		fail(w, 429, "too_many_streams", "Too many open streams on this canvas")
		return
	}
	defer a.multiplayer.close(tid, cid, stream)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	put := func(event string, data any) bool {
		raw, err := json.Marshal(data)
		if err != nil {
			return false
		}
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
		return err == nil
	}
	// write puts an event on the stream; send also flushes it. Once the stream's bye is due (its person removed or gone,
	// its token revoked), its next event is that bye, and the stream ends: what it read or queued and had not begun to
	// write never goes (one write already under way may finish just before the bye).
	// byeSent says the stream has said bye (its due one, or another), so it never says two.
	byeSent := false
	write := func(event string, data any) bool {
		if reason := a.multiplayer.takeBye(stream); reason != "" {
			if !byeSent && put("bye", map[string]any{"reason": reason}) {
				_ = controller.Flush()
			}
			byeSent = true
			return false
		}
		byeSent = byeSent || event == "bye"
		return put(event, data)
	}
	// A stream that ends another way while its bye is due (a read that failed, a 15 s check with no answer) still says
	// it, so its page is told why it ended.
	defer func() {
		if reason := a.multiplayer.takeBye(stream); reason != "" && !byeSent && put("bye", map[string]any{"reason": reason}) {
			_ = controller.Flush()
		}
	}()
	send := func(event string, data any) bool {
		return write(event, data) && controller.Flush() == nil
	}
	awwoSeen := map[string]liveParticipant{}
	var awwoAt time.Time
	// refreshAwwo tells the stream which of AwwO's Agents came and went since it last looked.
	refreshAwwo := func(force bool) bool {
		if !force && time.Since(awwoAt) < liveAwwoEvery {
			return true
		}
		awwoAt = time.Now()
		agents, err := liveAwwoAgents(ctx, a.db, tid, cid)
		if err != nil {
			return true
		}
		now := map[string]liveParticipant{}
		for _, p := range agents {
			now[p.ID] = p
			if _, known := awwoSeen[p.ID]; !known && !send("presence", map[string]any{"participant": p}) {
				return false
			}
		}
		for id := range awwoSeen {
			if _, still := now[id]; !still && !send("presence", map[string]any{"left": id}) {
				return false
			}
		}
		awwoSeen = now
		return true
	}
	hello := func(version int64) bool {
		participants, you := a.multiplayer.greet(tid, cid, stream)
		agents, _ := liveAwwoAgents(ctx, a.db, tid, cid)
		awwoSeen, awwoAt = map[string]liveParticipant{}, time.Now()
		for _, p := range agents {
			awwoSeen[p.ID] = p
		}
		claims, err := listCanvasClaims(ctx, a.db, tid, cid)
		if err != nil {
			return false
		}
		messages, err := listLiveMessages(ctx, a.db, tid, cid, "", liveHelloMessages)
		if err != nil {
			return false
		}
		return send("hello", map[string]any{"you": you, "version": version, "participants": append(participants, agents...), "claims": claims, "messages": messages,
			"presenceParts": livePresenceParts})
	}
	// Presence goes paced (livePresenceEvery): each who changed, with their latest state, at once or when their time
	// comes; what is due together goes in one flush.
	var presenceTimer *time.Timer
	var presenceDue <-chan time.Time
	defer func() {
		if presenceTimer != nil {
			presenceTimer.Stop()
		}
	}()
	sendPresence := func() bool {
		if presenceTimer != nil {
			presenceTimer.Stop()
			presenceTimer = nil
		}
		presenceDue = nil
		due, wait := a.multiplayer.takePresence(tid, cid, stream, time.Now())
		for _, data := range due {
			if !write("presence", data) {
				return false
			}
		}
		if len(due) > 0 && controller.Flush() != nil {
			return false
		}
		if wait > 0 {
			presenceTimer = time.NewTimer(wait)
			presenceDue = presenceTimer.C
		}
		return true
	}
	if !hello(version) {
		return
	}
	cursor := after
	if cursor == 0 {
		cursor = version
	}
	// catchUp sends the changes after the cursor, or a reset when the log no longer holds them.
	catchUp := func() bool {
		var current int64
		if err := a.db.QueryRow(ctx, "SELECT version FROM canvases WHERE tenant_id=$1 AND id=$2", tid, cid).Scan(&current); err != nil {
			return false
		}
		if current > cursor {
			changes, reset, err := canvasChangesAfter(ctx, a.db, tid, cid, cursor, current)
			if err != nil {
				return false
			}
			if reset {
				if !send("reset", map[string]any{"version": current}) {
					return false
				}
			} else {
				for _, c := range changes {
					if !send("changes", c) {
						return false
					}
				}
			}
			cursor = current
		}
		return refreshAwwo(false)
	}
	if !catchUp() {
		return
	}
	ping := time.NewTicker(a.reauthEvery)
	defer ping.Stop()
	closing := a.multiplayer.closed()
	for {
		select {
		case <-ctx.Done():
			return
		case <-closing:
			send("bye", map[string]any{"reason": "restart"})
			return
		case <-stream.wake:
			if reason := a.multiplayer.takeBye(stream); reason != "" {
				send("bye", map[string]any{"reason": reason})
				return
			}
			if a.multiplayer.takeBehind(stream) {
				// What queued before the fresh hello is older than it (a participant who has left since, an old pointer):
				// it goes, and the hello says how things are now.
				for drained := false; !drained; {
					select {
					case <-stream.events:
					default:
						drained = true
					}
				}
				var current int64
				if err := a.db.QueryRow(ctx, "SELECT version FROM canvases WHERE tenant_id=$1 AND id=$2", tid, cid).Scan(&current); err != nil || !hello(current) {
					return
				}
			}
			if !catchUp() {
				return
			}
		case <-stream.nudge:
			if !sendPresence() {
				return
			}
		case <-presenceDue:
			if !sendPresence() {
				return
			}
		case event := <-stream.events:
			switch event.name {
			case "claims":
				claims, err := listCanvasClaims(ctx, a.db, tid, cid)
				if err != nil || !send("claims", map[string]any{"claims": claims}) {
					return
				}
			case "bye":
				send("bye", event.data)
				return
			default:
				if !send(event.name, event.data) {
					return
				}
			}
		case <-ping.C:
			since := a.multiplayer.memberCount()
			role, allowed, err := a.liveAccessRole(r, tid, cid)
			if err != nil {
				return // no answer (the database, ClawHunt): the page connects again
			}
			if !allowed {
				send("bye", map[string]any{"reason": "access"})
				return
			}
			// A role changed since the stream opened shows (a viewer made an editor, an editor a viewer), if the hub was not
			// told of it at once (membersChanged).
			a.multiplayer.setRole(tid, cid, actor, role, since)
			a.multiplayer.sweepRoom(tid, cid)
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil || controller.Flush() != nil {
				return
			}
			// A write from outside this process, or one whose wake-up was missed, is read here.
			if !catchUp() {
				return
			}
		}
	}
}
