package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Canvas agent tokens (docs/awwo-canvas-live-collaboration.md, Tokens): the secret that lets one agent into one canvas,
// made by an owner or admin of its workspace (since 2026-11-08: the owner's decision for people sharing a workspace, as
// for the relay keys), shown once and kept only as its SHA-256. A token acts for its maker and never beyond them
// (canvas_access.go); it ends when it expires, when it is revoked, when its maker leaves the workspace or is no longer
// an owner or admin of it, and when its maker's password changes (as the relay keys).

const (
	maxCanvasAgentTokens     = 10
	canvasAgentTokenDays     = 30
	maxCanvasAgentTokenDays  = 90
	canvasAgentTokenNameMax  = 60
	canvasAgentTokenItemJSON = `jsonb_build_object('id',t.id,'name',t.name,'prefix',t.prefix,'scope',t.scope,'createdAt',t.created_at,'expiresAt',t.expires_at,
		'lastUsedAt',t.last_used_at,'revokedAt',t.revoked_at,'createdBy',jsonb_build_object('id',t.created_by,'name',COALESCE(u.name,'')))`
)

// revokeCanvasAgentTokens revokes a person's canvas agent tokens ($1), in one workspace when tid is not empty, and lets
// go of their claims: where a person leaves a workspace, becomes a reader, or changes or resets their password.
func revokeCanvasAgentTokens(ctx context.Context, tx pgx.Tx, uid, tid string) ([]revokedCanvasToken, error) {
	if _, err := tx.Exec(ctx, `DELETE FROM canvas_claims c USING canvas_agent_tokens t WHERE c.tenant_id=t.tenant_id AND c.token_id=t.id
		AND t.created_by=$1 AND ($2='' OR t.tenant_id=$2)`, uid, tid); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, "UPDATE canvas_agent_tokens SET revoked_at=clock_timestamp() WHERE created_by=$1 AND ($2='' OR tenant_id=$2) AND revoked_at IS NULL RETURNING tenant_id,canvas_id,id", uid, tid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	revoked := []revokedCanvasToken{}
	for rows.Next() {
		var t revokedCanvasToken
		if err = rows.Scan(&t.tenantID, &t.canvasID, &t.id); err != nil {
			return nil, err
		}
		revoked = append(revoked, t)
	}
	return revoked, rows.Err()
}

// revokedCanvasToken is a token revokeCanvasAgentTokens revoked; once its transaction commits, the hub hears of it
// (canvasMultiplayer.tokensRevoked).
type revokedCanvasToken struct{ tenantID, canvasID, id string }

func newCanvasAgentToken() (id, token, hash, prefix string) {
	idBytes := make([]byte, 8)
	secret := make([]byte, 32)
	if _, err := rand.Read(idBytes); err != nil {
		panic(err)
	}
	if _, err := rand.Read(secret); err != nil {
		panic(err)
	}
	id = hex.EncodeToString(idBytes)
	prefix = "awwo_ct_" + id
	token = prefix + "_" + base64.RawURLEncoding.EncodeToString(secret)
	return id, token, tokenHash(token), prefix
}

// listCanvasAgentTokens answers GET .../agent-tokens: the canvas's tokens, never their secrets.
func (a *App) listCanvasAgentTokens(w http.ResponseWriter, r *http.Request) {
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	if !a.canvasExists(w, r, tid, cid) {
		return
	}
	items, err := rowsJSON(r.Context(), a.db, "SELECT "+canvasAgentTokenItemJSON+" FROM canvas_agent_tokens t LEFT JOIN users u ON u.id=t.created_by WHERE t.tenant_id=$1 AND t.canvas_id=$2 ORDER BY t.created_at DESC,t.id LIMIT 100", tid, cid)
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// createCanvasAgentToken answers POST .../agent-tokens: a new token, its secret given once.
func (a *App) createCanvasAgentToken(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name  string `json:"name"`
		Days  int    `json:"days"`
		Scope string `json:"scope"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.Days == 0 {
		b.Days = canvasAgentTokenDays
	}
	if b.Scope == "" {
		b.Scope = "edit"
	}
	if b.Name == "" || len([]rune(b.Name)) > canvasAgentTokenNameMax || strings.ContainsAny(b.Name, "\r\n\t") || b.Days < 1 || b.Days > maxCanvasAgentTokenDays || (b.Scope != "edit" && b.Scope != "read") {
		fail(w, 400, "invalid_input", "A name of 1 to 60 characters, days from 1 to 90 and scope edit or read are required")
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
	if _, ok := a.mutationRole(w, r, tx, tid, roleLevel("admin")); !ok {
		return
	}
	var live int
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE)", tid, cid).Scan(&exists); err != nil {
		a.dbError(w, err)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM canvas_agent_tokens WHERE tenant_id=$1 AND canvas_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()", tid, cid).Scan(&live); err != nil {
		a.dbError(w, err)
		return
	}
	if live >= maxCanvasAgentTokens {
		fail(w, 409, "agent_token_limit", "A canvas has at most 10 live agent tokens; revoke one first")
		return
	}
	id, token, hash, prefix := newCanvasAgentToken()
	// The messages written after the newest the canvas holds now are new to the token (canvas_wait gives them): the
	// tenant's row this holds orders every later message after it.
	if _, err = tx.Exec(ctx, `INSERT INTO canvas_agent_tokens(id,tenant_id,canvas_id,created_by,name,token_hash,prefix,scope,expires_at,seen_message_at,seen_message_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+make_interval(days=>$9),`+newestLiveMessageAt("$2", "$3")+`,`+newestLiveMessageID("$2", "$3")+`)`,
		id, tid, cid, currentUser(r).ID, b.Name, hash, prefix, b.Scope, b.Days); err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, currentUser(r).ID, tid, "canvas.agent_token.created", cid+":"+id); err != nil {
		a.dbError(w, err)
		return
	}
	item, err := oneJSON(ctx, tx, "SELECT "+canvasAgentTokenItemJSON+" FROM canvas_agent_tokens t LEFT JOIN users u ON u.id=t.created_by WHERE t.id=$1", id)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 201, map[string]any{"token": token, "item": item})
}

// revokeCanvasAgentToken answers DELETE .../agent-tokens/{tokenId}: its maker, or a workspace admin or owner, revokes it;
// its streams end at once and its claims go.
func (a *App) revokeCanvasAgentToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	tid, cid, id := r.PathValue("tenantId"), r.PathValue("id"), r.PathValue("tokenId")
	role, ok := a.mutationRole(w, r, tx, tid, 2)
	if !ok {
		return
	}
	var maker string
	if err = tx.QueryRow(ctx, "SELECT created_by FROM canvas_agent_tokens WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 FOR UPDATE", tid, cid, id).Scan(&maker); noRows(err) {
		fail(w, 404, "not_found", "Agent token not found")
		return
	} else if err != nil {
		a.dbError(w, err)
		return
	}
	if maker != currentUser(r).ID && roleLevel(role) < roleLevel("admin") {
		fail(w, 403, "forbidden", "Only the token's maker or a workspace admin may revoke it")
		return
	}
	if _, err = tx.Exec(ctx, "UPDATE canvas_agent_tokens SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL", tid, id); err != nil {
		a.dbError(w, err)
		return
	}
	if _, err = tx.Exec(ctx, "DELETE FROM canvas_claims WHERE tenant_id=$1 AND token_id=$2", tid, id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, currentUser(r).ID, tid, "canvas.agent_token.revoked", cid+":"+id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	a.multiplayer.bye(func(s *liveStream) bool { return s.tokenID == id }, "revoked")
	a.multiplayer.leave(tid, cid, "t_"+id)
	a.multiplayer.claimsChanged(tid, cid)
	w.WriteHeader(204)
}

// canvasAgentTokenExpiry is the latest a token may be made to live, for the panel's choices.
var canvasAgentTokenExpiry = time.Duration(maxCanvasAgentTokenDays) * 24 * time.Hour
