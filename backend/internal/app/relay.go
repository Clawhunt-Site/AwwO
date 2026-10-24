package app

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// The cloud relay: AwwO 本地版 has this site make its model calls (owner 2026-10-24: 「本地连接云端服务器再发送到
// bedrock」). A local install cannot reach every model itself (Anthropic's on Bedrock refuse streamed calls from some
// countries, and this site's AWS credentials work from its own host alone), so it sends each call here with a key its
// member made on 设置 → 本机版连接 for one of their workspaces. The call runs on this site's relay worker (a Pi worker
// whose catalog is the models offered: AWWO_RELAY_WORKER_URL) through its managed-call route, and is admitted, recorded
// and charged as one of that workspace's model calls: its owner's plan and credits, or its free allowance and paid-route
// allowances, as the owner chose (「计入线上账号」). Nothing of a call's words is kept: the ledger records its usage, as
// for any call. The keys are here; reading a call is relay_call.go, running it relay_completion.go, and what the relay
// may take of this site at once relay_limits.go.

// relaySettings are the relay's switches: AWWO_RELAY=on, and its worker's URL and token. Off unless AWWO_RELAY=on.
type relaySettings struct {
	Relay                            bool
	RelayWorkerURL, RelayWorkerToken string
}

func (c *Config) relayFromEnv() error {
	switch os.Getenv("AWWO_RELAY") {
	case "", "off":
	case "on":
		c.Relay = true
	default:
		return errors.New("AWWO_RELAY must be on or off")
	}
	c.RelayWorkerURL, c.RelayWorkerToken = os.Getenv("AWWO_RELAY_WORKER_URL"), os.Getenv("AWWO_RELAY_WORKER_TOKEN")
	return nil
}

// validateRelay checks the relay's settings: with the relay on, a loopback worker origin and its token, and the proxies
// in front of this API (the relay holds off an address that keeps sending keys that are not, which behind an unnamed
// proxy would be every caller's at once); never on the local edition or with personal keys, whose calls are their
// person's own.
func (c Config) validateRelay() error {
	if !c.Relay {
		if c.RelayWorkerURL != "" || c.RelayWorkerToken != "" {
			return errors.New("AWWO_RELAY_WORKER_URL and AWWO_RELAY_WORKER_TOKEN need AWWO_RELAY=on")
		}
		return nil
	}
	if c.Edition == editionLocal || c.UserCredentials {
		return errors.New("AWWO_RELAY=on serves this site's own models: not with AWWO_EDITION=local or AWWO_CREDENTIAL_MODE=user")
	}
	if len(c.TrustedProxyCIDRs) == 0 {
		return errors.New("AWWO_RELAY=on needs AWWO_TRUSTED_PROXY_CIDRS: the proxies in front of this API, so each caller is told apart by its own address")
	}
	u, e := url.Parse(c.RelayWorkerURL)
	if e != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") ||
		(u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" && u.Hostname() != "localhost") {
		return errors.New("AWWO_RELAY_WORKER_URL must be a loopback HTTP origin")
	}
	if len(c.RelayWorkerToken) < 32 || strings.ContainsAny(c.RelayWorkerToken, " \t\r\n") {
		return errors.New("AWWO_RELAY_WORKER_TOKEN must be at least 32 characters without spaces")
	}
	return nil
}

const (
	relayModelsRoute      = "/api/v1/relay/v1/models"
	relayCompletionsRoute = "/api/v1/relay/v1/chat/completions"
	// relayKeyLimit is how many live keys one account may hold, and relayKeyLife how long a key works: a sign-in here is
	// checked with ClawHunt again and again, a key never is, so a member whose ClawHunt access ends keeps a key at most
	// that long.
	relayKeyLimit = 5
	relayKeyLife  = "90 days"
)

var relayKeyPattern = regexp.MustCompile(`^awwo_rk_[A-Za-z0-9_-]{43}$`)

// newRelayKey is a key and what this site keeps of it: its SHA-256 and the prefix its member sees.
func newRelayKey() (key, hash, prefix string) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	key = "awwo_rk_" + base64.RawURLEncoding.EncodeToString(b)
	return key, tokenHash(key), key[:len("awwo_rk_")+4]
}

func (a *App) registerRelayRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/auth/relay-keys", a.auth(a.listRelayKeys))
	m.HandleFunc("POST /api/v1/auth/relay-keys", a.auth(a.authRate(a.createRelayKey)))
	m.HandleFunc("DELETE /api/v1/auth/relay-keys/{id}", a.auth(a.revokeRelayKey))
	m.HandleFunc("GET "+relayModelsRoute, a.relayModels)
	m.HandleFunc("POST "+relayCompletionsRoute, a.relayCompletion)
}

func (a *App) relayAvailable(w http.ResponseWriter) bool {
	if !a.cfg.Relay {
		fail(w, 404, "relay_unavailable", "Connections for AwwO 本地版 are not offered here")
		return false
	}
	return true
}

const relayKeyJSON = `jsonb_build_object('id',k.id,'name',k.name,'prefix',k.prefix,'tenant',jsonb_build_object('id',t.id,'name',t.name),
	'createdAt',k.created_at,'expiresAt',k.expires_at,'lastUsedAt',k.last_used_at,'revokedAt',k.revoked_at)`

// listRelayKeys lists the account's keys: the live ones and the twenty it revoked last, newest first. An expired key is
// listed as it is (expiresAt in the past) until it is revoked.
func (a *App) listRelayKeys(w http.ResponseWriter, r *http.Request) {
	if !a.relayAvailable(w) {
		return
	}
	items, e := rowsJSON(r.Context(), a.db, `SELECT `+relayKeyJSON+` FROM relay_keys k JOIN tenants t ON t.id=k.tenant_id
		WHERE k.user_id=$1 AND (k.revoked_at IS NULL OR k.id IN (SELECT id FROM relay_keys WHERE user_id=$1 AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 20))
		ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC, k.id`, currentUser(r).ID)
	if e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "limit": relayKeyLimit})
}

// createRelayKey makes a key for one of the member's workspaces, one it may run calls in (as a member, an admin or its
// owner, while it is active). The key itself is in this answer alone.
func (a *App) createRelayKey(w http.ResponseWriter, r *http.Request) {
	if !a.relayAvailable(w) {
		return
	}
	var b struct {
		Name     string `json:"name"`
		TenantID string `json:"tenantId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" {
		b.Name = "AwwO 本地版"
	}
	if len([]rune(b.Name)) > 80 || strings.ContainsAny(b.Name, "\r\n\x00") || b.TenantID == "" || len(b.TenantID) > 200 {
		fail(w, 400, "invalid_relay_key", "Name the key (at most 80 characters) and choose one of your workspaces")
		return
	}
	uid := currentUser(r).ID
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	// The account's row serializes its keys, so two made at once cannot pass the limit together. FOR NO KEY UPDATE, not
	// FOR UPDATE: a run created meanwhile locks its workspace's row and then checks its actor against this one (the
	// foreign key's FOR KEY SHARE), which FOR UPDATE would block while this insert waits on that workspace: a deadlock.
	// Then the workspace's row, which a member's removal or downgrade locks before it revokes their keys there
	// (changeMember): whichever comes second sees the first, so a key is never made for a member just removed, nor kept
	// by one. The session is read again after both: a password changed or reset meanwhile ended it, after revoking the
	// account's keys (account_security.go), and a key made now would outlive it.
	var session, member bool
	var live int
	token := ""
	if cookie, missing := r.Cookie("awwo_session"); missing == nil {
		token = cookie.Value
	}
	if _, e = tx.Exec(r.Context(), "SELECT 1 FROM users WHERE id=$1 FOR NO KEY UPDATE", uid); e == nil {
		_, e = tx.Exec(r.Context(), "SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", b.TenantID)
	}
	if e == nil {
		e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=$3 AND user_id=$2 AND expires_at>now()),
			EXISTS(SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
			WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin','member') AND t.status='active'),
			(SELECT count(*) FROM relay_keys WHERE user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp())`, b.TenantID, uid, tokenHash(token)).Scan(&session, &member, &live)
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !session {
		fail(w, 401, "unauthorized", "Session expired")
		return
	}
	if !member {
		fail(w, 404, "tenant_not_found", "Workspace not found")
		return
	}
	if live >= relayKeyLimit {
		fail(w, 409, "relay_key_limit", fmt.Sprintf("At most %d connection keys at once: revoke one first", relayKeyLimit))
		return
	}
	key, hash, prefix := newRelayKey()
	id := randomID()
	if _, e = tx.Exec(r.Context(), "INSERT INTO relay_keys(id,user_id,tenant_id,key_hash,prefix,name,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7::interval)",
		id, uid, b.TenantID, hash, prefix, b.Name, relayKeyLife); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, uid, b.TenantID, "relay_key.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	item, e := oneJSON(r.Context(), tx, `SELECT `+relayKeyJSON+` FROM relay_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.id=$1`, id)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 201, map[string]any{"key": key, "item": item})
}

func (a *App) revokeRelayKey(w http.ResponseWriter, r *http.Request) {
	if !a.relayAvailable(w) {
		return
	}
	uid, id := currentUser(r).ID, r.PathValue("id")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	var tenant string
	e = tx.QueryRow(r.Context(), "UPDATE relay_keys SET revoked_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING tenant_id", id, uid).Scan(&tenant)
	if noRows(e) {
		fail(w, 404, "not_found", "Connection key not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, uid, tenant, "relay_key.revoked", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}

// revokeRelayKeysSQL revokes an account's keys ($1), in one workspace when $2 is not empty: those of a member who leaves
// it or may no longer run calls there (changeMember), every one when its password changes or is reset (a session taken
// over could have made one). A key revoked stays revoked, whatever its member's later role.
const revokeRelayKeysSQL = "UPDATE relay_keys SET revoked_at=clock_timestamp() WHERE user_id=$1 AND ($2='' OR tenant_id=$2) AND revoked_at IS NULL"

// relayCaller is who a relayed call is from: its key, the key's member and the workspace it counts in.
type relayCaller struct{ keyID, userID, tenantID string }

// relayAuthenticate reads a relayed call's key: a live key of a member of an active workspace, sent by a program, never
// by a page (a request with any Origin is refused, so a key pasted into a site cannot be used from it). An address that
// keeps sending keys that are not, and a key that sends too many requests, are held off a minute (relayLimits).
func (a *App) relayAuthenticate(w http.ResponseWriter, r *http.Request) (relayCaller, bool) {
	var c relayCaller
	if !a.relayAvailable(w) {
		return c, false
	}
	if r.Header.Get("Origin") != "" {
		fail(w, 403, "relay_browser_refused", "Connection keys are for AwwO 本地版, not for web pages")
		return c, false
	}
	address := a.clientIP(r)
	if !a.relayLimits.lookupAllowed(address) {
		relayRateLimited(w)
		return c, false
	}
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !relayKeyPattern.MatchString(key) {
		a.relayLimits.lookupFailed(address)
		fail(w, 401, "relay_key_invalid", "Invalid connection key")
		return c, false
	}
	var expired, revoked bool
	var role, status string
	e := a.db.QueryRow(r.Context(), `SELECT k.id,k.user_id,k.tenant_id,k.expires_at<=clock_timestamp(),k.revoked_at IS NOT NULL,COALESCE(m.role,''),t.status FROM relay_keys k
		JOIN tenants t ON t.id=k.tenant_id LEFT JOIN memberships m ON m.tenant_id=k.tenant_id AND m.user_id=k.user_id
		WHERE k.key_hash=$1`, tokenHash(key)).Scan(&c.keyID, &c.userID, &c.tenantID, &expired, &revoked, &role, &status)
	switch {
	case noRows(e):
		a.relayLimits.lookupFailed(address)
		fail(w, 401, "relay_key_invalid", "Invalid connection key")
	case e != nil:
		a.dbError(w, e)
	case revoked:
		// A key that was one: a program still holding it is no guesser, and is never held off for it with its address.
		fail(w, 401, "relay_key_invalid", "Invalid connection key")
	case !a.relayLimits.requestAllowed(c.keyID):
		relayRateLimited(w)
	case expired:
		fail(w, 401, "relay_key_expired", "This connection key has expired: make a new one on 设置 → 本机版连接")
	case roleLevel(role) < roleLevel("member"):
		fail(w, 403, "relay_key_forbidden", "This key's account can no longer run calls in its workspace")
	case status != "active":
		fail(w, 403, "tenant_suspended", "Workspace is suspended")
	default:
		// When it was last used, written at most once a minute.
		_, _ = a.db.Exec(r.Context(), "UPDATE relay_keys SET last_used_at=clock_timestamp() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute')", c.keyID)
		return c, true
	}
	return c, false
}

func relayRateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "60")
	fail(w, 429, "relay_rate_limited", "Too many requests with this connection: wait a minute")
}

// relayModels lists the models a key's workspace may have this site run: the relay worker's catalog as its entitlement
// permits, with what a caller needs to size its calls (AwwO's fields beside OpenAI's): a call may hold
// context_window - max_output_tokens - 256 tokens, counted at prose_bytes_per_token bytes a token of its JSON plus 32 a
// message, as the worker counts it. None takes a reasoning effort here (the worker's managed-call route serves its
// Bedrock models through its Converse bridge, which sends none).
func (a *App) relayModels(w http.ResponseWriter, r *http.Request) {
	caller, ok := a.relayAuthenticate(w, r)
	if !ok {
		return
	}
	worker, e := a.relayCatalog(r.Context())
	if e != nil {
		fail(w, 503, "relay_unavailable", "Cloud models are unavailable right now")
		return
	}
	var restricted bool
	var allowed []string
	if e = a.db.QueryRow(r.Context(), "SELECT allowed_models IS NOT NULL,COALESCE(allowed_models,'{}') FROM tenants WHERE id=$1", caller.tenantID).Scan(&restricted, &allowed); e != nil {
		a.dbError(w, e)
		return
	}
	entitlement, e := newModelEntitlement(restricted, allowed)
	if e != nil {
		fail(w, 503, "relay_unavailable", "Cloud models are unavailable right now")
		return
	}
	data := []map[string]any{}
	for _, m := range worker.models {
		if !entitlement.permits(m.ID) {
			continue
		}
		name := m.Name
		if name == "" {
			name = m.ID
		}
		data = append(data, map[string]any{"id": m.ID, "object": "model", "owned_by": "awwo", "name": name,
			"context_window": m.ContextWindow, "max_output_tokens": m.MaxOutputTokens, "prose_bytes_per_token": m.ProseBytesPerToken,
			"reasoning_efforts": []string{}})
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": data})
}
