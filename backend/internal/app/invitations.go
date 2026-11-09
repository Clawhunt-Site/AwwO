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
	if !a.localAuthentication(w) {
		return
	}
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
	a.tenantList(w, r, "invites")
}

// inviteEmail is an invitation's bound email as it is kept: trimmed and in lower case, "" for none; ok is false for one
// that is no email address, or one with any letter outside ASCII. Only A to Z are lowered: strings.ToLower would also
// fold other letters into them (the Kelvin sign U+212A into k), so an account at a look-alike address would match.
func inviteEmail(raw string) (string, bool) {
	email := strings.TrimSpace(raw)
	if email == "" {
		return "", true
	}
	for i := 0; i < len(email); i++ {
		if email[i] >= utf8.RuneSelf {
			return "", false
		}
	}
	email = asciiLower(email) // graph_assemble.go: A to Z only
	return email, len(email) >= 3 && validEmail(email)
}

// inviteEmailMatches says whether the account is the one a bound invitation names (AWWO-LAW-030): its email (for an
// acceptance, as accountNow reads it now) is the bound one, in any case of A to Z; an address with a letter outside
// ASCII never matches, as none is bound. Whether the address was ever verified is not asked: ClawHunt sends most
// accounts as unverified.
func inviteEmailMatches(bound string, u User) bool {
	return bound != "" && asciiLower(strings.TrimSpace(u.Email)) == bound
}

// inviteTokenHash is how an invitation's token is kept. A bound one's is kept apart, its token hashed behind a fixed
// prefix: an API from before AWWO-LAW-030 (a rollback), which knows nothing of the email, looks the plain hash up, finds
// no invitation and answers not found, so it never lets another account take one. Every lookup asks for both and takes
// a row only by the hash of its own kind (inviteLookupSQL).
func inviteTokenHash(token string, bound bool) string {
	if bound {
		return tokenHash("awwo-bound-invite\x00" + token)
	}
	return tokenHash(token)
}

// inviteLookupSQL finds an invitation by its link, $1 the plain hash and $2 the bound one (inviteTokenHash).
const inviteLookupSQL = `((i.token_hash=$1 AND i.email IS NULL) OR (i.token_hash=$2 AND i.email IS NOT NULL))`

// accountNow is the signed-in account with its email as it is now, for a bound invitation's match (AWWO-LAW-030). A
// ClawHunt sign-in's is asked of the issuer itself: not the verification a.auth may reuse for a minute (an email changed
// on ClawHunt since would still match), and with no outage grace (an issuer that cannot be asked refuses, 503
// sso_unavailable, and one that says the sign-in is over signs this browser out). A password account's is its own, read
// with the session. Nothing is locked while the issuer is asked. ok is false once the answer has been written.
func (a *App) accountNow(w http.ResponseWriter, r *http.Request) (User, bool) {
	u := currentUser(r)
	if linked, _ := r.Context().Value(clawHuntSessionKey{}).(bool); !linked {
		return u, true
	}
	c, err := r.Cookie("awwo_session")
	if err != nil {
		fail(w, 401, "unauthorized", "Sign in required")
		return u, false
	}
	hash := tokenHash(c.Value)
	var issuer, subject string
	var sealed []byte
	err = a.db.QueryRow(r.Context(), "SELECT COALESCE(sso_issuer,''),COALESCE(sso_subject,''),sso_grant FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()", hash, u.ID).Scan(&issuer, &subject, &sealed)
	if noRows(err) {
		fail(w, 401, "unauthorized", "Session expired")
		return u, false
	}
	if err != nil {
		a.dbError(w, err)
		return u, false
	}
	if len(sealed) == 0 {
		a.endedSession(w, hash)
		return u, false
	}
	id, valid, err := a.checkClawHuntSession(r.Context(), hash, u.ID, issuer, subject, sealed, false)
	if err != nil {
		fail(w, 503, "sso_unavailable", "ClawHunt session verification is unavailable")
		return u, false
	}
	if !valid {
		a.endedSession(w, hash)
		return u, false
	}
	u.Name, u.Email = id.Name, id.Email
	return u, true
}

// maskedEmail shows a bound email to whoever holds the link without giving it whole: the first character of its name,
// then *** and its domain (l***@example.com); a name of one character is not shown (***@example.com).
func maskedEmail(email string) string {
	at := strings.LastIndex(email, "@")
	if at < 1 {
		return "***"
	}
	first, size := utf8.DecodeRuneInString(email)
	if size >= at {
		return "***" + email[at:]
	}
	return string(first) + "***" + email[at:]
}

func (a *App) createInvite(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Role     string `json:"role"`
		Hours    *int   `json:"expiresInHours"`
		Email    string `json:"email"`
		CanvasID string `json:"canvasId"`
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
	email, valid := inviteEmail(b.Email)
	if !valid || len(b.CanvasID) > 200 {
		fail(w, 400, "invalid_input", "The email must be one address in ASCII letters, and the canvas one of this workspace's")
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
	// The canvas it is sent from, which the person opens once they have joined: one of this workspace's, else not found,
	// as for one that does not exist (AWWO-LAW-001).
	var canvasID, canvasName, bound any
	if b.CanvasID != "" {
		var name string
		if e = tx.QueryRow(r.Context(), "SELECT name FROM canvases WHERE tenant_id=$1 AND id=$2", tid, b.CanvasID).Scan(&name); noRows(e) {
			fail(w, 404, "not_found", "Canvas not found")
			return
		} else if e != nil {
			a.dbError(w, e)
			return
		}
		canvasID, canvasName = b.CanvasID, name
	}
	if email != "" {
		bound = email
	}
	id, token := randomID(), randomID()+randomID()
	var expires time.Time
	e = tx.QueryRow(r.Context(), `INSERT INTO tenant_invites(id,tenant_id,created_by,role,token_hash,expires_at,email,canvas_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(hours=>$6),$7,$8) RETURNING expires_at`, id, tid, currentUser(r).ID, b.Role, inviteTokenHash(token, email != ""), hours, bound, canvasID).Scan(&expires)
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
	writeJSON(w, 201, map[string]any{"id": id, "role": b.Role, "expiresAt": expires, "token": token, "inviteUrl": a.cfg.PublicOrigin + "/?invite=" + url.QueryEscape(token),
		"email": bound, "canvasId": canvasID, "canvasName": canvasName})
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

// previewInvite tells whoever holds a link what it is: the workspace, the access, until when, its state, the canvas it
// opens, and for a bound one its email masked and whether it is this account's.
func (a *App) previewInvite(w http.ResponseWriter, r *http.Request) {
	if len(r.PathValue("token")) > 256 {
		fail(w, 404, "not_found", "Invitation not found")
		return
	}
	var tid, tenantName, role, status string
	var expires time.Time
	var email, canvasID, canvasName *string
	token := r.PathValue("token")
	e := a.db.QueryRow(r.Context(), `SELECT t.id,t.name,i.role,i.expires_at,`+inviteStatusSQL+`,i.email,c.id,c.name FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id
		LEFT JOIN memberships m ON m.tenant_id=i.tenant_id AND m.user_id=i.created_by LEFT JOIN canvases c ON c.tenant_id=i.tenant_id AND c.id=i.canvas_id
		WHERE `+inviteLookupSQL, inviteTokenHash(token, false), inviteTokenHash(token, true)).Scan(&tid, &tenantName, &role, &expires, &status, &email, &canvasID, &canvasName)
	if noRows(e) {
		fail(w, 404, "not_found", "Resource not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	out := map[string]any{"tenantId": tid, "tenantName": tenantName, "role": role, "expiresAt": expires, "status": status}
	// A bound link that reached another account (a forwarded or leaked one) does not tell it the canvas's name.
	matches := email == nil || inviteEmailMatches(*email, currentUser(r))
	if canvasID != nil && canvasName != nil && matches {
		out["canvasId"], out["canvasName"] = *canvasID, *canvasName
	}
	if email != nil {
		out["email"], out["emailMatches"] = maskedEmail(*email), matches
	}
	writeJSON(w, 200, out)
}
func (a *App) acceptInvite(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if len(token) > 256 {
		fail(w, 404, "not_found", "Invitation not found")
		return
	}
	plain, bound := inviteTokenHash(token, false), inviteTokenHash(token, true)
	// A bound invitation still open is matched against the account's email as it is now (accountNow), asked before the
	// transaction so the issuer is never waited on with the workspace locked. An invitation's email never changes and an
	// open one only closes, so one found closed here is closed below too.
	account, checked := currentUser(r), false
	var open bool
	if e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM tenant_invites WHERE token_hash=$1 AND email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())", bound).Scan(&open); e != nil {
		a.dbError(w, e)
		return
	}
	if open {
		var ok bool
		if account, ok = a.accountNow(w, r); !ok {
			return
		}
		checked = true
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	var id, tid string
	e = tx.QueryRow(r.Context(), "SELECT i.id,i.tenant_id FROM tenant_invites i WHERE "+inviteLookupSQL, plain, bound).Scan(&id, &tid)
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
	var role, issuer string
	var acceptedBy, email *string
	var revoked *time.Time
	var expired bool
	e = tx.QueryRow(r.Context(), "SELECT role,created_by,accepted_by,revoked_at,expires_at<=clock_timestamp(),email FROM tenant_invites WHERE id=$1 FOR UPDATE", id).Scan(&role, &issuer, &acceptedBy, &revoked, &expired, &email)
	if e != nil {
		a.dbError(w, e)
		return
	}
	uid := account.ID
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
		// A bound invitation is for the account with its email now (AWWO-LAW-030). Any other is refused, and the invitation
		// stays as it was for its person: nothing has been written yet.
		if email != nil && (!checked || !inviteEmailMatches(*email, account)) {
			fail(w, 403, "invite_wrong_account", "This invitation is for another account: sign in with the email it was sent to")
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
	// The canvas it was sent from, while it still exists (deleting it clears it): the page opens it.
	var canvasID *string
	if e = tx.QueryRow(r.Context(), "SELECT c.id FROM tenant_invites i JOIN canvases c ON c.tenant_id=i.tenant_id AND c.id=i.canvas_id WHERE i.id=$1", id).Scan(&canvasID); e != nil && !noRows(e) {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	out := map[string]any{"tenantId": tid, "role": role}
	if canvasID != nil {
		out["canvasId"] = *canvasID
	}
	writeJSON(w, 200, out)
}
