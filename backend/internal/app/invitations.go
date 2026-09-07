package app

import (
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

func (a *App) updateProfile(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name string `json:"name"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if n := utf8.RuneCountInString(b.Name); n < 1 || n > 120 {
		fail(w, 400, "invalid_input", "Name must contain 1–120 characters")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	u := currentUser(r)
	if _, e = tx.Exec(r.Context(), "UPDATE users SET name=$2 WHERE id=$1", u.ID, b.Name); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, u.ID, "", "profile.updated", u.ID); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"id": u.ID, "email": u.Email, "name": b.Name, "isPlatformAdmin": u.PlatformRole == "admin"})
}

func grantAllowed(actor, role string) bool {
	return actor == "owner" || (actor == "admin" && (role == "reader" || role == "member"))
}

// Every tenant mutation takes this lock before resource locks. Revocation,
// suspension, quota changes and admission therefore have a single order.
func (a *App) lockTenantRow(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid string) (string, bool) {
	var status string
	e := tx.QueryRow(r.Context(), "SELECT status FROM tenants WHERE id=$1 FOR UPDATE", tid).Scan(&status)
	if noRows(e) {
		fail(w, 404, "not_found", "Workspace not found")
		return "", false
	}
	if e != nil {
		a.dbError(w, e)
		return "", false
	}
	if !a.workerAvailable(w) {
		return "", false
	}
	return status, true
}
func (a *App) lockTenant(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid string) bool {
	status, ok := a.lockTenantRow(w, r, tx, tid)
	if !ok {
		return false
	}
	if status != "active" {
		fail(w, 403, "tenant_suspended", "Workspace is suspended")
		return false
	}
	return true
}
func (a *App) managementRole(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid string) (string, bool) {
	return a.mutationRole(w, r, tx, tid, 3)
}

// Middleware rejects unauthorized requests early, but bodies and lock waits can
// outlive that decision. Recheck membership after locking, in the transaction
// that performs the write; never acquire the tenant lock while reading a body.
func (a *App) mutationRole(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid string, minRole int) (string, bool) {
	status, ok := a.lockTenantRow(w, r, tx, tid)
	if !ok {
		return "", false
	}
	var role string
	e := tx.QueryRow(r.Context(), "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, currentUser(r).ID).Scan(&role)
	if noRows(e) {
		fail(w, 404, "not_found", "Workspace not found")
		return "", false
	}
	if e != nil {
		a.dbError(w, e)
		return "", false
	}
	if roleLevel(role) < minRole {
		fail(w, 403, "forbidden", "Insufficient workspace permissions")
		return "", false
	}
	if status != "active" {
		fail(w, 403, "tenant_suspended", "Workspace is suspended")
		return "", false
	}
	return role, true
}

// Status exposes no token or credential data, including to workspace admins.
const inviteStatusSQL = `CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.expires_at<=clock_timestamp() THEN 'expired' WHEN t.status<>'active' THEN 'suspended' WHEN COALESCE(m.role='owner' OR (m.role='admin' AND i.role IN ('reader','member')),false)=false THEN 'unavailable' ELSE 'active' END`

func (a *App) listInvites(w http.ResponseWriter, r *http.Request) {
	v, e := rowsJSON(r.Context(), a.db, `SELECT jsonb_build_object('id',i.id,'role',i.role,'createdBy',i.created_by,'createdAt',i.created_at,'expiresAt',i.expires_at,'status',`+inviteStatusSQL+`,'acceptedBy',i.accepted_by,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at) FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN memberships m ON m.tenant_id=i.tenant_id AND m.user_id=i.created_by WHERE i.tenant_id=$1 ORDER BY i.created_at DESC,i.id DESC`, r.PathValue("tenantId"))
	a.replyList(w, v, e)
}
func (a *App) createInvite(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Role  string `json:"role"`
		Hours *int   `json:"expiresInHours"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	hours := 72
	if b.Hours != nil {
		hours = *b.Hours
	}
	if (b.Role != "reader" && b.Role != "member" && b.Role != "admin") || hours < 1 || hours > 168 {
		fail(w, 400, "invalid_input", "Role must be reader, member or admin; expiry must be 1–168 hours")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid := r.PathValue("tenantId")
	actor, ok := a.managementRole(w, r, tx, tid)
	if !ok {
		return
	}
	if !grantAllowed(actor, b.Role) {
		fail(w, 403, "forbidden", "Only owners may invite administrators")
		return
	}
	id, token := randomID(), randomID()+randomID()
	var expires time.Time
	e = tx.QueryRow(r.Context(), `INSERT INTO tenant_invites(id,tenant_id,created_by,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(hours=>$6)) RETURNING expires_at`, id, tid, currentUser(r).ID, b.Role, tokenHash(token), hours).Scan(&expires)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "invite.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "role": b.Role, "expiresAt": expires, "token": token, "inviteUrl": a.cfg.PublicOrigin + "/?invite=" + url.QueryEscape(token)})
}
func (a *App) revokeInvite(w http.ResponseWriter, r *http.Request) {
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	actor, ok := a.managementRole(w, r, tx, tid)
	if !ok {
		return
	}
	var role string
	var accepted, revoked *time.Time
	e = tx.QueryRow(r.Context(), "SELECT role,accepted_at,revoked_at FROM tenant_invites WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, id).Scan(&role, &accepted, &revoked)
	if noRows(e) {
		fail(w, 404, "not_found", "Invitation not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !grantAllowed(actor, role) {
		fail(w, 403, "forbidden", "Only owners may revoke administrator invitations")
		return
	}
	if accepted != nil {
		fail(w, 409, "invite_used", "Invitation has already been accepted")
		return
	}
	if revoked == nil {
		if _, e = tx.Exec(r.Context(), "UPDATE tenant_invites SET revoked_at=clock_timestamp() WHERE id=$1", id); e != nil {
			a.dbError(w, e)
			return
		}
		if e = audit(r.Context(), tx, currentUser(r).ID, tid, "invite.revoked", id); e != nil {
			a.dbError(w, e)
			return
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}
func (a *App) previewInvite(w http.ResponseWriter, r *http.Request) {
	if len(r.PathValue("token")) > 256 {
		fail(w, 404, "not_found", "Invitation not found")
		return
	}
	v, e := oneJSON(r.Context(), a.db, `SELECT jsonb_build_object('tenantId',t.id,'tenantName',t.name,'role',i.role,'expiresAt',i.expires_at,'status',`+inviteStatusSQL+`) FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN memberships m ON m.tenant_id=i.tenant_id AND m.user_id=i.created_by WHERE i.token_hash=$1`, tokenHash(r.PathValue("token")))
	a.replyOne(w, v, e, 200)
}
func (a *App) acceptInvite(w http.ResponseWriter, r *http.Request) {
	if len(r.PathValue("token")) > 256 {
		fail(w, 404, "not_found", "Invitation not found")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	hash := tokenHash(r.PathValue("token"))
	var tid string
	e = tx.QueryRow(r.Context(), "SELECT tenant_id FROM tenant_invites WHERE token_hash=$1", hash).Scan(&tid)
	if noRows(e) {
		fail(w, 404, "not_found", "Invitation not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !a.lockTenant(w, r, tx, tid) {
		return
	}
	var id, role, issuer string
	var acceptedBy *string
	var revoked *time.Time
	var expired bool
	e = tx.QueryRow(r.Context(), "SELECT id,role,created_by,accepted_by,revoked_at,expires_at<=clock_timestamp() FROM tenant_invites WHERE token_hash=$1 FOR UPDATE", hash).Scan(&id, &role, &issuer, &acceptedBy, &revoked, &expired)
	if e != nil {
		a.dbError(w, e)
		return
	}
	uid := currentUser(r).ID
	if acceptedBy != nil && *acceptedBy != uid {
		fail(w, 409, "invite_used", "Invitation has already been accepted")
		return
	}
	if acceptedBy == nil {
		if revoked != nil {
			fail(w, 410, "invite_revoked", "Invitation has been revoked")
			return
		}
		if expired {
			fail(w, 410, "invite_expired", "Invitation has expired")
			return
		}
		var issuerRole string
		e = tx.QueryRow(r.Context(), "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, issuer).Scan(&issuerRole)
		if e != nil && !noRows(e) {
			a.dbError(w, e)
			return
		}
		if !grantAllowed(issuerRole, role) {
			fail(w, 403, "invite_unavailable", "Invitation issuer no longer has permission")
			return
		}
		if _, e = tx.Exec(r.Context(), "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", tid, uid, role); e != nil {
			a.dbError(w, e)
			return
		}
		if _, e = tx.Exec(r.Context(), "UPDATE tenant_invites SET accepted_by=$2,accepted_at=clock_timestamp() WHERE id=$1", id, uid); e != nil {
			a.dbError(w, e)
			return
		}
		if e = audit(r.Context(), tx, uid, tid, "invite.accepted", id); e != nil {
			a.dbError(w, e)
			return
		}
	}
	e = tx.QueryRow(r.Context(), "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, uid).Scan(&role)
	if noRows(e) {
		fail(w, 409, "invite_membership_removed", "Your workspace membership has been removed")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]string{"tenantId": tid, "role": role})
}
