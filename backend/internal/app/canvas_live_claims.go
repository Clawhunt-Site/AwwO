package app

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Claims (docs/awwo-canvas-live-collaboration.md, Claims): a participant's hold on a node until it expires. An agent
// changes only nodes it holds or nobody does (its write takes the node); people are never held back, and see who holds a
// node. Expiry is judged by the database's clock only.

const (
	claimMinTTL     = 15 * time.Second
	claimMaxTTL     = 10 * time.Minute
	claimDefaultTTL = 2 * time.Minute
	maxClaimNodes   = 50
)

type canvasClaimRow struct {
	participant string
	holderKind  string
	expiresAt   time.Time
}

// liveClaim is a claim as the stream and the answers send it.
type liveClaim struct {
	NodeID        string    `json:"nodeId"`
	ParticipantID string    `json:"participantId"`
	HolderKind    string    `json:"holderKind"`
	Name          string    `json:"name"`
	Note          string    `json:"note"`
	ExpiresAt     time.Time `json:"expiresAt"`
}

// activeCanvasClaims gives a canvas's claims that have not expired, by node.
func activeCanvasClaims(ctx context.Context, q querier, tid, cid string) (map[string]canvasClaimRow, error) {
	rows, err := q.Query(ctx, "SELECT node_id,participant_id,holder_kind,expires_at FROM canvas_claims WHERE tenant_id=$1 AND canvas_id=$2 AND expires_at>clock_timestamp()", tid, cid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]canvasClaimRow{}
	for rows.Next() {
		var node string
		var c canvasClaimRow
		if err = rows.Scan(&node, &c.participant, &c.holderKind, &c.expiresAt); err != nil {
			return nil, err
		}
		out[node] = c
	}
	return out, rows.Err()
}

// listCanvasClaims gives a canvas's claims as they are sent, with their holders' names, the soonest to end first.
func listCanvasClaims(ctx context.Context, q querier, tid, cid string) ([]liveClaim, error) {
	rows, err := q.Query(ctx, `SELECT c.node_id,c.participant_id,c.holder_kind,
		CASE WHEN c.token_id IS NOT NULL THEN COALESCE(t.name,'') ELSE COALESCE(u.name,'') END,c.note,c.expires_at
		FROM canvas_claims c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN canvas_agent_tokens t ON t.tenant_id=c.tenant_id AND t.id=c.token_id
		WHERE c.tenant_id=$1 AND c.canvas_id=$2 AND c.expires_at>clock_timestamp() ORDER BY c.expires_at,c.node_id`, tid, cid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []liveClaim{}
	for rows.Next() {
		var c liveClaim
		if err = rows.Scan(&c.NodeID, &c.ParticipantID, &c.HolderKind, &c.Name, &c.Note, &c.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// claimNode takes or renews one participant's claim on a node; false when someone else holds it (another participant,
// or another person who copied this participant's page id). tx holds the canvas row, so two writers never take one node.
//
// onWrite is a claim a write takes (takeAgentClaims): its own live claim is never shortened by it nor its note blanked,
// so a node an agent took for ten minutes stays its own for ten minutes however often it writes.
func claimNode(ctx context.Context, tx pgx.Tx, tid, cid, node string, actor canvasActor, ttl time.Duration, note string, onWrite bool) (bool, error) {
	if len(node) > 200 {
		return false, nil // no node id of the change model is longer (parseCanvasPath): nothing to hold
	}
	kind, token := "human", any(nil)
	if actor.Kind == "agent" {
		kind, token = "agent", actor.TokenID
	}
	tag, err := tx.Exec(ctx, `INSERT INTO canvas_claims(tenant_id,canvas_id,node_id,participant_id,holder_kind,user_id,token_id,note,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+make_interval(secs=>$9))
		ON CONFLICT (tenant_id,canvas_id,node_id) DO UPDATE SET participant_id=EXCLUDED.participant_id,holder_kind=EXCLUDED.holder_kind,
		user_id=EXCLUDED.user_id,token_id=EXCLUDED.token_id,
		note=CASE WHEN $10 AND canvas_claims.participant_id=EXCLUDED.participant_id AND canvas_claims.expires_at>clock_timestamp() THEN canvas_claims.note ELSE EXCLUDED.note END,
		expires_at=CASE WHEN $10 AND canvas_claims.participant_id=EXCLUDED.participant_id AND canvas_claims.expires_at>clock_timestamp()
			THEN GREATEST(canvas_claims.expires_at,EXCLUDED.expires_at) ELSE EXCLUDED.expires_at END,
		created_at=CASE WHEN canvas_claims.participant_id=EXCLUDED.participant_id THEN canvas_claims.created_at ELSE clock_timestamp() END
		WHERE (canvas_claims.participant_id=EXCLUDED.participant_id AND canvas_claims.user_id=EXCLUDED.user_id) OR canvas_claims.expires_at<=clock_timestamp()`,
		tid, cid, node, actor.participantID(), kind, actor.UserID, token, note, ttl.Seconds(), onWrite)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// takeAgentClaims takes, for an agent, the nodes its change wrote that still exist (a write takes what nobody holds,
// and renews its own, never shortening it). It says whether the canvas's streams should hear of it: a claim that is new,
// or one about to end that the write renewed (pages show each claim's end).
func takeAgentClaims(ctx context.Context, tx pgx.Tx, tid, cid string, actor canvasActor, nodes map[string]bool, doc map[string]any) (bool, error) {
	before, err := activeCanvasClaims(ctx, tx, tid, cid)
	if err != nil {
		return false, err
	}
	fresh := false
	for node := range nodes {
		if findRecord(collectionOf(doc, "nodes"), "id", node) < 0 {
			continue
		}
		taken, err := claimNode(ctx, tx, tid, cid, node, actor, agentWriteClaim, "", true)
		if err != nil {
			return false, err
		}
		if held, had := before[node]; taken && (!had || held.participant != actor.participantID() || time.Until(held.expiresAt) < agentWriteClaim/2) {
			fresh = true
		}
	}
	return fresh, nil
}

// canvasLiveClaim answers POST .../live/claims: the nodes asked for, taken where nobody else holds them.
func (a *App) canvasLiveClaim(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ClientID   string   `json:"clientId"`
		NodeIDs    []string `json:"nodeIds"`
		TTLSeconds float64  `json:"ttlSeconds"`
		Note       string   `json:"note"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if agentOf(r) != nil {
		b.ClientID = "t_" + agentOf(r).TokenID
	}
	ttl := claimDefaultTTL
	if b.TTLSeconds != 0 {
		ttl = time.Duration(b.TTLSeconds * float64(time.Second))
	}
	if !liveClientIDOK(r, b.ClientID) || len(b.NodeIDs) == 0 || len(b.NodeIDs) > maxClaimNodes || ttl < claimMinTTL || ttl > claimMaxTTL || len(b.Note) > 140 {
		fail(w, 400, "invalid_input", "clientId, 1 to 50 nodeIds and a ttlSeconds of 15 to 600 are required")
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
	var raw []byte
	if err = tx.QueryRow(ctx, "SELECT document FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, cid).Scan(&raw); noRows(err) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	} else if err != nil {
		a.dbError(w, err)
		return
	}
	doc, _ := decodeCanvasDocument(raw)
	actor := canvasActorOf(r, b.ClientID)
	type refusal struct {
		NodeID string     `json:"nodeId"`
		Holder *liveClaim `json:"holder"`
	}
	refused := []refusal{}
	missing := []string{}
	for _, node := range uniqueStrings(b.NodeIDs) {
		if doc == nil || findRecord(collectionOf(doc, "nodes"), "id", node) < 0 {
			missing = append(missing, node)
			continue
		}
		taken, err := claimNode(ctx, tx, tid, cid, node, actor, ttl, strings.TrimSpace(b.Note), false)
		if err != nil {
			a.dbError(w, err)
			return
		}
		if !taken {
			refused = append(refused, refusal{NodeID: node})
		}
	}
	claims, err := listCanvasClaims(ctx, tx, tid, cid)
	if err != nil {
		a.dbError(w, err)
		return
	}
	for i := range refused {
		for j := range claims {
			if claims[j].NodeID == refused[i].NodeID {
				refused[i].Holder = &claims[j]
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	a.multiplayer.claimsChanged(tid, cid)
	a.touchCanvasAgent(r, tid, cid)
	writeJSON(w, 200, map[string]any{"claims": claims, "refused": refused, "missing": missing})
}

// canvasLiveRelease answers DELETE .../live/claims: the caller lets go of the nodes named, or of all its claims.
func (a *App) canvasLiveRelease(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ClientID string   `json:"clientId"`
		NodeIDs  []string `json:"nodeIds"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if agentOf(r) != nil {
		b.ClientID = "t_" + agentOf(r).TokenID
	}
	if !liveClientIDOK(r, b.ClientID) || len(b.NodeIDs) > maxClaimNodes {
		fail(w, 400, "invalid_input", "clientId and at most 50 nodeIds are required")
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
	actor := canvasActorOf(r, b.ClientID)
	if len(b.NodeIDs) == 0 {
		_, err = tx.Exec(ctx, "DELETE FROM canvas_claims WHERE tenant_id=$1 AND canvas_id=$2 AND participant_id=$3 AND user_id=$4", tid, cid, actor.participantID(), actor.UserID)
	} else {
		_, err = tx.Exec(ctx, "DELETE FROM canvas_claims WHERE tenant_id=$1 AND canvas_id=$2 AND participant_id=$3 AND user_id=$4 AND node_id=ANY($5::text[])", tid, cid, actor.participantID(), actor.UserID, b.NodeIDs)
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	claims, err := listCanvasClaims(ctx, tx, tid, cid)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	a.multiplayer.claimsChanged(tid, cid)
	a.touchCanvasAgent(r, tid, cid)
	writeJSON(w, 200, map[string]any{"claims": claims})
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
