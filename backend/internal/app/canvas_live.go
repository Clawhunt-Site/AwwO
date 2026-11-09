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

func listLiveMessages(ctx context.Context, q querier, tid, cid string, before string, limit int) ([]liveMessage, error) {
	rows, err := q.Query(ctx, `SELECT m.id,m.author_kind,m.user_id,COALESCE(m.token_id,''),
		CASE WHEN m.token_id IS NOT NULL THEN COALESCE(t.name,'') ELSE COALESCE(u.name,'') END,m.node_id,m.text,m.created_at
		FROM canvas_live_messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN canvas_agent_tokens t ON t.tenant_id=m.tenant_id AND t.id=m.token_id
		WHERE m.tenant_id=$1 AND m.canvas_id=$2
		AND ($3='' OR (m.created_at,m.id)<(SELECT b.created_at,b.id FROM canvas_live_messages b WHERE b.tenant_id=$1 AND b.canvas_id=$2 AND b.id=$3))
		ORDER BY m.created_at DESC,m.id DESC LIMIT $4`, tid, cid, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []liveMessage{}
	for rows.Next() {
		var m liveMessage
		var userID, tokenID string
		if err = rows.Scan(&m.ID, &m.AuthorKind, &userID, &tokenID, &m.Name, &m.NodeID, &m.Text, &m.CreatedAt); err != nil {
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

// canvasLiveMessages answers GET .../live/messages?before=id: the 50 messages before that one, the newest first.
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
	if _, err = tx.Exec(ctx, "INSERT INTO canvas_live_messages(id,tenant_id,canvas_id,author_kind,user_id,token_id,node_id,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
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

// canvasLivePresence answers POST .../live/presence: the parts of the caller's state it sends (the others stay).
func (a *App) canvasLivePresence(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ClientID string                     `json:"clientId"`
		State    map[string]json.RawMessage `json:"state"`
	}
	if !a.decode(w, r, &b) {
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
	update, err := parseLiveState(b.State, agent != nil)
	if err != nil {
		fail(w, 400, "invalid_input", err.Error())
		return
	}
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	actor := canvasActorOf(r, b.ClientID)
	if agent != nil {
		a.touchCanvasAgent(r, tid, cid)
	}
	a.multiplayer.setState(tid, cid, actor, update)
	w.WriteHeader(204)
}

// parseLiveState reads the parts of a state a participant sends. An agent has no pointer.
func parseLiveState(state map[string]json.RawMessage, agent bool) (func(*liveState), error) {
	var steps []func(*liveState)
	for key, raw := range state {
		switch key {
		case "selection":
			var ids []string
			if json.Unmarshal(raw, &ids) != nil || len(ids) > maxGraphNodes {
				return nil, fmt.Errorf("selection is a list of at most %d node ids", maxGraphNodes)
			}
			for _, id := range ids {
				if id == "" || len(id) > 200 {
					return nil, fmt.Errorf("a selected node id is empty or too long")
				}
			}
			ids = uniqueStrings(ids)
			if len(ids) > livePresenceSelectionMax {
				ids = ids[:livePresenceSelectionMax]
			}
			steps = append(steps, func(s *liveState) { s.Selection = ids })
		case "focus":
			var focus *string
			if json.Unmarshal(raw, &focus) != nil || (focus != nil && (*focus == "" || len(*focus) > 200)) {
				return nil, fmt.Errorf("focus is a node id or null")
			}
			steps = append(steps, func(s *liveState) { s.Focus = focus })
		case "cursor":
			var point *livePoint
			if json.Unmarshal(raw, &point) != nil || (point != nil && (!finiteWorld(point.X) || !finiteWorld(point.Y))) {
				return nil, fmt.Errorf("cursor is {x, y} or null")
			}
			if agent {
				point = nil
			}
			steps = append(steps, func(s *liveState) { s.Cursor = point })
		case "status":
			var status *string
			if json.Unmarshal(raw, &status) != nil || (status != nil && len([]rune(*status)) > maxLiveStatusRunes) {
				return nil, fmt.Errorf("status is at most %d characters, or null", maxLiveStatusRunes)
			}
			if status != nil {
				trimmed := strings.TrimSpace(*status)
				status = &trimmed
				if trimmed == "" {
					status = nil
				}
			}
			steps = append(steps, func(s *liveState) { s.Status = status })
		default:
			return nil, fmt.Errorf("unknown state part %q", key)
		}
	}
	return func(s *liveState) {
		for _, step := range steps {
			step(s)
		}
	}, nil
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
	ctx := r.Context()
	var ok bool
	if agent := agentOf(r); agent != nil {
		err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM canvas_agent_tokens t JOIN memberships m ON m.tenant_id=t.tenant_id AND m.user_id=t.created_by
			JOIN canvases c ON c.tenant_id=t.tenant_id AND c.id=t.canvas_id
			WHERE t.tenant_id=$1 AND t.id=$2 AND t.canvas_id=$3 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() AND m.role IN ('owner','admin'))`, tid, agent.TokenID, cid).Scan(&ok)
		return err == nil && ok, err
	}
	c, _ := r.Cookie("awwo_session")
	if c == nil {
		return false, nil
	}
	err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN auth_sessions s ON s.user_id=m.user_id JOIN canvases c ON c.tenant_id=m.tenant_id
		WHERE m.tenant_id=$1 AND m.user_id=$2 AND s.token_hash=$3 AND s.expires_at>now() AND c.id=$4)`, tid, currentUser(r).ID, tokenHash(c.Value), cid).Scan(&ok)
	if err != nil || !ok {
		return false, err
	}
	var issuer, subject string
	var grant []byte
	if err = a.db.QueryRow(ctx, "SELECT COALESCE(sso_issuer,''),COALESCE(sso_subject,''),sso_grant FROM auth_sessions WHERE token_hash=$1", tokenHash(c.Value)).Scan(&issuer, &subject, &grant); err != nil {
		if noRows(err) {
			return false, nil
		}
		return false, err
	}
	valid, err := a.validateClawHuntSession(ctx, tokenHash(c.Value), currentUser(r).ID, issuer, subject, grant)
	return err == nil && valid, err
}

// canvasLiveEvents answers GET .../live/events?after=v&client=c: the canvas's live stream.
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
	role := ""
	if agentOf(r) == nil {
		_ = a.db.QueryRow(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, currentUser(r).ID).Scan(&role)
	}
	actor := canvasActorOf(r, clientID)
	stream, refused := a.multiplayer.open(tid, cid, liveJoin{actor: actor, role: role})
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
	send := func(event string, data any) bool {
		raw, err := json.Marshal(data)
		if err != nil {
			return false
		}
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw); err != nil {
			return false
		}
		return controller.Flush() == nil
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
		participants := a.multiplayer.participants(tid, cid)
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
		you, _ := a.multiplayer.participant(tid, cid, actor.participantID())
		return send("hello", map[string]any{"you": you, "version": version, "participants": append(participants, agents...), "claims": claims, "messages": messages})
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
			allowed, err := a.liveAccess(r, tid, cid)
			if err != nil {
				return // no answer (the database, ClawHunt): the page connects again
			}
			if !allowed {
				send("bye", map[string]any{"reason": "access"})
				return
			}
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
