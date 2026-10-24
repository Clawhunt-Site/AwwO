package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// AwwO 本地版's links to the hosted site (docs/awwo-cloud-relay.md), in the shape of a device authorization grant
// (RFC 8628): the local edition asks for one and holds its device code, the person approves its short user code for one
// of their workspaces from a signed-in session here, and the local edition exchanges the device code once for a token
// that relays its model calls to that workspace's Bedrock models (relay.go). Only the SHA-256 of either secret is kept.
// The hosted site alone serves these, and only with AWWO_LOCAL_RELAY=on.

// localLinkInterval is how often a local edition may ask whether its code was approved; a variable so tests can shorten it.
var localLinkInterval = 5 * time.Second

const (
	// localLinkCodeTTL is how long a user code may be approved, and its device code exchanged.
	localLinkCodeTTL = 15 * time.Minute
	// localLinkTokenTTL is how long a link's token relays calls unless it is revoked first.
	localLinkTokenTTL = 90 * 24 * time.Hour
	// localLinkMax is how many links an account may have at once; localLinkPendingMax bounds the codes waiting
	// across the site, which anyone may ask for.
	localLinkMax         = 10
	localLinkPendingMax  = 10000
	localLinkTokenPrefix = "awwo_lk_"
	// localLinkFreshSignIn is how recently a person must have signed in to approve a link: a link outlives the session that
	// approves it by months, so a session someone else took over long ago may not make one (a ClawHunt account's password
	// changes at ClawHunt, which no AwwO link hears of).
	localLinkFreshSignIn = 15 * time.Minute
)

// A user code's letters: no vowels (no words can be spelt) and none of 0/O, 1/I/L that read alike.
const userCodeAlphabet = "BCDFGHJKMNPQRSTVWXZ23456789"

var (
	deviceCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	linkTokenPattern  = regexp.MustCompile(`^awwo_lk_[A-Za-z0-9_-]{43}$`)
	userCodePattern   = regexp.MustCompile(`^[` + userCodeAlphabet + `]{4}-[` + userCodeAlphabet + `]{4}$`)
)

func randomSecret() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func newUserCode() string {
	b := make([]byte, 8)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	code := make([]byte, 0, 9)
	for i, v := range b {
		if i == 4 {
			code = append(code, '-')
		}
		// 256 % 27 leaves a slight bias towards the first letters; a code lives 15 minutes behind a rate limit.
		code = append(code, userCodeAlphabet[int(v)%len(userCodeAlphabet)])
	}
	return string(code)
}

// normalUserCode reads a code as a person types it: any case, with or without its dash and spaces.
func normalUserCode(raw string) (string, bool) {
	s := strings.ToUpper(strings.NewReplacer("-", "", " ", "", " ", "").Replace(strings.TrimSpace(raw)))
	if len(s) != 8 {
		return "", false
	}
	code := s[:4] + "-" + s[4:]
	return code, userCodePattern.MatchString(code)
}

// validDeviceName takes the name a local edition gives itself (「AwwO 本地版 · Mac」): 1 to 80 printable characters.
func validDeviceName(name string) bool {
	if name == "" || !utf8.ValidString(name) {
		return false
	}
	n := 0
	for _, r := range name {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
			return false
		}
		n++
	}
	return n <= 80
}

// localLinkStart begins a link: POST /local-links/start {deviceName}, rate limited per address (authRate).
func (a *App) localLinkStart(w http.ResponseWriter, r *http.Request) {
	var b struct {
		DeviceName string `json:"deviceName"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	name := strings.TrimSpace(b.DeviceName)
	if !validDeviceName(name) {
		fail(w, 400, "invalid_device_name", "Name the device in 1 to 80 printable characters")
		return
	}
	ctx := r.Context()
	if e := a.dropEndedLinkCodes(ctx); e != nil {
		a.dbError(w, e)
		return
	}
	var waiting int
	if e := a.db.QueryRow(ctx, `SELECT count(*) FROM local_links WHERE status='pending' AND code_expires_at > now()`).Scan(&waiting); e != nil {
		a.dbError(w, e)
		return
	}
	if waiting >= localLinkPendingMax {
		w.Header().Set("Retry-After", "60")
		fail(w, 503, "link_busy", "Too many connections are waiting; try again in a minute")
		return
	}
	device := randomSecret()
	for attempt := 0; attempt < 5; attempt++ {
		code := newUserCode()
		_, e := a.db.Exec(ctx, `INSERT INTO local_links(id,device_hash,user_code,device_name,status,code_expires_at,request_ip) VALUES($1,$2,$3,$4,'pending',now()+$5::bigint*interval '1 second',$6)`,
			randomID(), tokenHash(device), code, name, int64(localLinkCodeTTL.Seconds()), requestAddress(a.clientIP(r)))
		var pg *pgconn.PgError
		if errors.As(e, &pg) && pg.Code == "23505" {
			continue // another waiting link drew the same code
		}
		if e != nil {
			a.dbError(w, e)
			return
		}
		writeJSON(w, 201, map[string]any{"deviceCode": device, "userCode": code, "verificationURL": a.cfg.PublicOrigin + "/?link=" + code,
			"expiresIn": int(localLinkCodeTTL.Seconds()), "interval": max(1, int(math.Ceil(localLinkInterval.Seconds())))})
		return
	}
	fail(w, 503, "link_busy", "Could not make a code; try again")
}

// dropEndedLinkCodes deletes the codes nobody approved or exchanged in time, an hour after they ended: they say nothing
// more, and a waiting code's address goes with it.
func (a *App) dropEndedLinkCodes(ctx context.Context) error {
	_, e := a.db.Exec(ctx, `DELETE FROM local_links WHERE status IN ('pending','approved','denied') AND code_expires_at < now() - interval '1 hour'`)
	return e
}

// requestAddress is the address kept with a waiting code, or nil.
func requestAddress(ip string) any {
	if ip == "" || len(ip) > 64 {
		return nil
	}
	return ip
}

// sameNetwork tells whether two addresses are one network as the relay's limits count them: one IPv4 address, or one
// IPv6 /64.
func sameNetwork(a, b string) bool { return a != "" && addressKey(a) == addressKey(b) }

// signIn reads the request's session as q sees it: whether it still exists unexpired, and whether it began within
// localLinkFreshSignIn.
func signIn(r *http.Request, q querier) (live, fresh bool, e error) {
	c, e := r.Cookie("awwo_session")
	if e != nil {
		return false, false, nil
	}
	e = q.QueryRow(r.Context(), `SELECT created_at > now() - $2::bigint * interval '1 second' FROM auth_sessions WHERE token_hash=$1 AND user_id=$3 AND expires_at > now()`,
		tokenHash(c.Value), int64(localLinkFreshSignIn.Seconds()), currentUser(r).ID).Scan(&fresh)
	if noRows(e) {
		return false, false, nil
	}
	return e == nil, fresh, e
}

// localLinkToken answers a local edition that asks after its code: POST /local-links/token {deviceCode}. The answers are
// a device grant's (RFC 8628 §3.5): authorization_pending, slow_down, access_denied, expired_token, or the token once.
func (a *App) localLinkToken(w http.ResponseWriter, r *http.Request) {
	var b struct {
		DeviceCode string `json:"deviceCode"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if !deviceCodePattern.MatchString(b.DeviceCode) {
		fail(w, 400, "expired_token", "This connection request is not known or has ended")
		return
	}
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(context.Background())
	// An approved link's workspace and person are locked before its row, as a membership change and an approval take
	// them (lockLinkOwners); one approved meanwhile is asked about again.
	var ownerTenant, ownerUser string
	e = tx.QueryRow(ctx, `SELECT COALESCE(tenant_id,''),COALESCE(user_id,'') FROM local_links WHERE device_hash=$1`, tokenHash(b.DeviceCode)).Scan(&ownerTenant, &ownerUser)
	if e != nil && !noRows(e) {
		a.dbError(w, e)
		return
	}
	if e = lockLinkOwners(ctx, tx, ownerTenant, ownerUser); e != nil {
		a.dbError(w, e)
		return
	}
	var id, status, userID, tenantID string
	var expires time.Time
	var polled *time.Time
	e = tx.QueryRow(ctx, `SELECT id,status,COALESCE(user_id,''),COALESCE(tenant_id,''),code_expires_at,polled_at FROM local_links WHERE device_hash=$1 FOR UPDATE`, tokenHash(b.DeviceCode)).
		Scan(&id, &status, &userID, &tenantID, &expires, &polled)
	if noRows(e) || (e == nil && (status == "issued" || status == "revoked" || time.Now().After(expires))) {
		fail(w, 400, "expired_token", "This connection request is not known or has ended")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if status == "approved" && (tenantID != ownerTenant || userID != ownerUser) {
		fail(w, 400, "authorization_pending", "Waiting for the connection to be approved")
		return
	}
	// A fifth's grace: a client that waits its interval from its last answer arrives a moment early.
	if polled != nil && time.Since(*polled) < localLinkInterval*4/5 {
		fail(w, 400, "slow_down", "Ask again after the interval")
		return
	}
	if _, e = tx.Exec(ctx, `UPDATE local_links SET polled_at=now() WHERE id=$1`, id); e != nil {
		a.dbError(w, e)
		return
	}
	switch status {
	case "pending":
		if e = tx.Commit(ctx); e != nil {
			a.dbError(w, e)
			return
		}
		fail(w, 400, "authorization_pending", "Waiting for the connection to be approved")
		return
	case "denied":
		if e = tx.Commit(ctx); e != nil {
			a.dbError(w, e)
			return
		}
		fail(w, 400, "access_denied", "The connection was declined")
		return
	}
	// Approved: the token is made now, once. A workspace that someone left or that was suspended since is no grant.
	var tenantName, tenantStatus, role string
	e = tx.QueryRow(ctx, `SELECT t.name,t.status,COALESCE(m.role,'') FROM tenants t LEFT JOIN memberships m ON m.tenant_id=t.id AND m.user_id=$2 WHERE t.id=$1`, tenantID, userID).Scan(&tenantName, &tenantStatus, &role)
	if e != nil && !noRows(e) {
		a.dbError(w, e)
		return
	}
	if noRows(e) || tenantStatus != "active" || roleLevel(role) < roleLevel("member") {
		if _, e = tx.Exec(ctx, `UPDATE local_links SET status='denied' WHERE id=$1`, id); e == nil {
			e = tx.Commit(ctx)
		}
		if e != nil {
			a.dbError(w, e)
			return
		}
		fail(w, 400, "access_denied", "The workspace can no longer be used")
		return
	}
	token := localLinkTokenPrefix + randomSecret()
	var until time.Time
	if e = tx.QueryRow(ctx, `UPDATE local_links SET status='issued',token_hash=$2,issued_at=now(),expires_at=now()+$3::bigint*interval '1 second' WHERE id=$1 RETURNING expires_at`,
		id, tokenHash(token), int64(localLinkTokenTTL.Seconds())).Scan(&until); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(ctx, tx, userID, tenantID, "local_link.issued", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"token": token, "linkId": id, "expiresAt": until, "workspace": map[string]string{"id": tenantID, "name": tenantName}})
}

// localLinkPending shows a signed-in person what they are about to approve: GET /local-links/pending/{code}. Besides
// the name the device gave itself, it shows the address that asked and theirs: a code someone else sent them, from a
// computer that is not theirs, most often comes from another network. signInAgain says approving it needs a fresh
// sign-in first.
func (a *App) localLinkPending(w http.ResponseWriter, r *http.Request) {
	code, ok := normalUserCode(r.PathValue("code"))
	if !ok {
		fail(w, 404, "link_not_found", "No connection is waiting with this code")
		return
	}
	var name, requestIP string
	var created, expires time.Time
	e := a.db.QueryRow(r.Context(), `SELECT device_name,COALESCE(request_ip,''),created_at,code_expires_at FROM local_links WHERE user_code=$1 AND status='pending' AND code_expires_at > now()`, code).
		Scan(&name, &requestIP, &created, &expires)
	if noRows(e) {
		fail(w, 404, "link_not_found", "No connection is waiting with this code")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	_, fresh, e := signIn(r, a.db)
	if e != nil {
		a.dbError(w, e)
		return
	}
	yourIP := a.clientIP(r)
	writeJSON(w, 200, map[string]any{"userCode": code, "deviceName": name, "createdAt": created, "expiresAt": expires,
		"requestIP": requestIP, "yourIP": yourIP, "sameNetwork": sameNetwork(requestIP, yourIP), "signInAgain": !fresh})
}

// localLinkApprove grants a waiting link one of the person's workspaces: POST /local-links/approve {userCode, tenantId,
// confirmed}. Its calls will spend that workspace's allowance and credits, so a reader of it may not grant it; the person
// confirms the code is the one their own computer shows (confirmed), and must have signed in within
// localLinkFreshSignIn.
func (a *App) localLinkApprove(w http.ResponseWriter, r *http.Request) {
	var b struct {
		UserCode  string `json:"userCode"`
		TenantID  string `json:"tenantId"`
		Confirmed bool   `json:"confirmed"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	code, ok := normalUserCode(b.UserCode)
	if !ok {
		fail(w, 404, "link_not_found", "No connection is waiting with this code")
		return
	}
	if !b.Confirmed {
		fail(w, 400, "link_unconfirmed", "Confirm that this code is shown on your own computer")
		return
	}
	u := currentUser(r)
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(context.Background())
	// Locks in the order a membership change takes them (resources.go: the workspace, then the membership), the
	// account's between: the workspace's row first, which the link's own row will refer to.
	var status, tenantName string
	e = tx.QueryRow(ctx, `SELECT status,name FROM tenants WHERE id=$1 FOR KEY SHARE`, b.TenantID).Scan(&status, &tenantName)
	if noRows(e) {
		fail(w, 404, "not_found", "Workspace not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	// The account's row serializes its approvals, so two at once cannot pass the limit together; a password change
	// takes it too (account_security.go), so the session is read again under it: an approval that waited for a change
	// that ended this session and the account's links does not outlive it.
	if _, e = tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, u.ID); e != nil {
		a.dbError(w, e)
		return
	}
	live, fresh, e := signIn(r, tx)
	switch {
	case e != nil:
		a.dbError(w, e)
		return
	case !live:
		fail(w, 401, "unauthorized", "Session expired")
		return
	case !fresh:
		fail(w, 403, "sign_in_again", "Sign in again to connect a computer")
		return
	}
	// The membership is held as it is read: a member being removed or made a reader meanwhile (resources.go, which locks
	// the row to change it and then revokes their links) waits for this approval, which it then revokes, or is seen.
	var role string
	e = tx.QueryRow(ctx, `SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`, b.TenantID, u.ID).Scan(&role)
	if noRows(e) {
		fail(w, 404, "not_found", "Workspace not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if roleLevel(role) < roleLevel("member") {
		fail(w, 403, "forbidden", "Readers of a workspace cannot spend its allowance")
		return
	}
	if status != "active" {
		fail(w, 403, "tenant_suspended", "Workspace is suspended")
		return
	}
	var held int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM local_links WHERE user_id=$1 AND ((status='issued' AND expires_at > now()) OR (status='approved' AND code_expires_at > now()))`, u.ID).Scan(&held); e != nil {
		a.dbError(w, e)
		return
	}
	if held >= localLinkMax {
		fail(w, 409, "link_limit", "At most ten computers can be connected; disconnect one first")
		return
	}
	var id, name string
	e = tx.QueryRow(ctx, `UPDATE local_links SET status='approved',user_id=$2,tenant_id=$3,approved_at=now(),request_ip=NULL WHERE user_code=$1 AND status='pending' AND code_expires_at > now() RETURNING id,device_name`, code, u.ID, b.TenantID).Scan(&id, &name)
	if noRows(e) {
		fail(w, 404, "link_not_found", "No connection is waiting with this code")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(ctx, tx, u.ID, b.TenantID, "local_link.approved", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "deviceName": name, "workspace": map[string]string{"id": b.TenantID, "name": tenantName}})
}

// localLinkDeny declines a waiting link: POST /local-links/deny {userCode}.
func (a *App) localLinkDeny(w http.ResponseWriter, r *http.Request) {
	var b struct {
		UserCode string `json:"userCode"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	code, ok := normalUserCode(b.UserCode)
	if !ok {
		fail(w, 404, "link_not_found", "No connection is waiting with this code")
		return
	}
	tag, e := a.db.Exec(r.Context(), `UPDATE local_links SET status='denied',request_ip=NULL WHERE user_code=$1 AND status='pending' AND code_expires_at > now()`, code)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, 404, "link_not_found", "No connection is waiting with this code")
		return
	}
	w.WriteHeader(204)
}

// localLinkList lists the person's connected computers: GET /local-links. A link approved whose computer has not taken
// its token yet is listed too (status approved, no expiry yet), so it can be disconnected before it is.
func (a *App) localLinkList(w http.ResponseWriter, r *http.Request) {
	items, e := rowsJSON(r.Context(), a.db, `SELECT jsonb_build_object('id',l.id,'status',l.status,'deviceName',l.device_name,'workspace',jsonb_build_object('id',t.id,'name',t.name),
		'createdAt',l.created_at,'approvedAt',l.approved_at,'lastUsedAt',l.last_used_at,'expiresAt',l.expires_at)
		FROM local_links l JOIN tenants t ON t.id=l.tenant_id WHERE l.user_id=$1
		AND ((l.status='issued' AND l.expires_at > now()) OR (l.status='approved' AND l.code_expires_at > now())) ORDER BY l.created_at DESC`, currentUser(r).ID)
	a.replyList(w, items, e)
}

// localLinkRevoke disconnects one of the person's computers: DELETE /local-links/{id}. Its next relayed call is refused.
func (a *App) localLinkRevoke(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(context.Background())
	var owner string
	if e = tx.QueryRow(ctx, `SELECT COALESCE(tenant_id,'') FROM local_links WHERE id=$1 AND user_id=$2`, r.PathValue("id"), u.ID).Scan(&owner); e != nil && !noRows(e) {
		a.dbError(w, e)
		return
	}
	if e = lockLinkOwners(ctx, tx, owner, u.ID); e != nil {
		a.dbError(w, e)
		return
	}
	var tenantID string
	e = tx.QueryRow(ctx, `UPDATE local_links SET status='revoked',revoked_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('approved','issued') RETURNING tenant_id`, r.PathValue("id"), u.ID).Scan(&tenantID)
	if noRows(e) {
		fail(w, 404, "not_found", "Connection not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(ctx, tx, u.ID, tenantID, "local_link.revoked", r.PathValue("id")); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}

// localLinkRevokeAll disconnects every one of the person's computers: DELETE /local-links. It is what to do when a
// computer is lost, or a ClawHunt account's password was changed: links outlive sessions.
func (a *App) localLinkRevokeAll(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(context.Background())
	if e = lockLinkOwners(ctx, tx, "", u.ID); e == nil {
		e = revokeLocalLinks(ctx, tx, u.ID)
	}
	if e == nil {
		e = audit(ctx, tx, u.ID, "", "local_link.revoked_all", u.ID)
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}

// lockLinkOwners takes the locks a change to a link's row needs before that row's, in the order a membership change
// (resources.go: the workspace, then the membership) and an approval (the workspace, then the account) take them: the
// workspace's, which the link and its audit event refer to, then its person's. Taken after the link's row instead, a
// change waiting for one while a membership change holds it and waits for the link deadlocks. Either may be "".
func lockLinkOwners(ctx context.Context, tx pgx.Tx, tenantID, userID string) error {
	if tenantID != "" {
		if _, e := tx.Exec(ctx, `SELECT 1 FROM tenants WHERE id=$1 FOR KEY SHARE`, tenantID); e != nil {
			return e
		}
	}
	if userID != "" {
		if _, e := tx.Exec(ctx, `SELECT 1 FROM users WHERE id=$1 FOR KEY SHARE`, userID); e != nil {
			return e
		}
	}
	return nil
}

// revokeLocalLinks ends every link of an account, inside the caller's transaction: a changed password signs every
// device out, and a linked computer is one.
func revokeLocalLinks(ctx context.Context, tx pgx.Tx, userID string) error {
	_, e := tx.Exec(ctx, `UPDATE local_links SET status='revoked',revoked_at=now() WHERE user_id=$1 AND status IN ('approved','issued')`, userID)
	return e
}

// revokeMemberLinks ends a person's links to one workspace, inside the caller's transaction: they were removed from it
// or made a reader of it. Being given a role again later gives no link back.
func revokeMemberLinks(ctx context.Context, tx pgx.Tx, tenantID, userID string) error {
	_, e := tx.Exec(ctx, `UPDATE local_links SET status='revoked',revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND status IN ('approved','issued')`, tenantID, userID)
	return e
}

// relayLink is a token's link, as a relayed call is made through it.
type relayLink struct {
	ID, UserID, TenantID, TenantName string
	ExpiresAt                        time.Time
}

// errRelayUnauthorized is a token that is not one: unknown, ended or revoked.
var errRelayUnauthorized = errors.New("invalid_api_key")

// errRelayWorkspace is a link whose person may no longer spend its workspace, or whose workspace is suspended.
var errRelayWorkspace = errors.New("workspace_unavailable")

// relayTokenLink reads the issued, unexpired link of a bearer token, whatever its person may do in its workspace now:
// what ending the link itself needs (relayRevokeSelf).
func (a *App) relayTokenLink(ctx context.Context, header string) (relayLink, error) {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || !linkTokenPattern.MatchString(token) {
		return relayLink{}, errRelayUnauthorized
	}
	var l relayLink
	e := a.db.QueryRow(ctx, `SELECT id,user_id,tenant_id,expires_at FROM local_links WHERE token_hash=$1 AND status='issued' AND expires_at > now()`, tokenHash(token)).
		Scan(&l.ID, &l.UserID, &l.TenantID, &l.ExpiresAt)
	if noRows(e) {
		return relayLink{}, errRelayUnauthorized
	}
	return l, e
}

// relayLinkFor reads the link of a relay request's bearer token. Its person must still be a member (owner, admin or
// member) of an active workspace; the link's last use is noted at most once a minute.
func (a *App) relayLinkFor(ctx context.Context, header string) (relayLink, error) {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || !linkTokenPattern.MatchString(token) {
		return relayLink{}, errRelayUnauthorized
	}
	var l relayLink
	var status, role string
	e := a.db.QueryRow(ctx, `SELECT l.id,l.user_id,l.tenant_id,t.name,t.status,COALESCE(m.role,''),l.expires_at FROM local_links l JOIN tenants t ON t.id=l.tenant_id
		LEFT JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id WHERE l.token_hash=$1 AND l.status='issued' AND l.expires_at > now()`, tokenHash(token)).
		Scan(&l.ID, &l.UserID, &l.TenantID, &l.TenantName, &status, &role, &l.ExpiresAt)
	if noRows(e) {
		return relayLink{}, errRelayUnauthorized
	}
	if e != nil {
		return relayLink{}, e
	}
	if status != "active" || roleLevel(role) < roleLevel("member") {
		return relayLink{}, errRelayWorkspace
	}
	if _, e = a.db.Exec(ctx, `UPDATE local_links SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, l.ID); e != nil {
		return relayLink{}, e
	}
	return l, nil
}
