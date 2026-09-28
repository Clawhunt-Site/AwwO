package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const identityCookie = "awwo_identity_flow"

type clawHuntIdentity struct {
	Issuer        string `json:"iss"`
	Audience      string `json:"aud"`
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}
type clawHuntGrant struct {
	Token     string           `json:"grant_token"`
	ExpiresIn int64            `json:"expires_in"`
	Identity  clawHuntIdentity `json:"identity"`
}
type clawHuntSessionKey struct{}
type clawHuntReturnKey struct{}

var identityInvitePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)

func identityReturnURL(invite string) string {
	if invite != "" {
		return "/?invite=" + url.QueryEscape(invite)
	}
	return "/"
}

func (c Config) validateClawHunt() error {
	if c.ClawHuntURL == "" && c.ClawHuntClientID == "" && c.ClawHuntClientSecret == "" {
		return nil
	}
	u, err := url.Parse(c.ClawHuntURL)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(c.ClawHuntURL, "#") {
		return errors.New("AWWO_CLAWHUNT_URL must be an exact trusted origin")
	}
	loopback := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(c.Env == "development" && u.Scheme == "http" && loopback) {
		return errors.New("ClawHunt identity requires HTTPS outside loopback development")
	}
	if len(c.ClawHuntClientID) < 1 || len(c.ClawHuntClientID) > 100 || strings.ContainsAny(c.ClawHuntClientID, ":\r\n ") || len(c.ClawHuntClientSecret) < 32 || strings.ContainsAny(c.ClawHuntClientSecret, "\r\n") {
		return errors.New("ClawHunt client ID and secret are required")
	}
	if len(c.CredentialKey) != 32 {
		return errors.New("ClawHunt identity requires a 32-byte credential encryption key")
	}
	return nil
}
func (a *App) clawHuntEnabled() bool { return a.cfg.ClawHuntURL != "" }
func (a *App) localAuthentication(w http.ResponseWriter) bool {
	if a.clawHuntEnabled() {
		fail(w, 403, "clawhunt_required", "Continue with your ClawHunt account")
		return false
	}
	return true
}
func (a *App) identityFlowCookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: identityCookie, Value: value, Path: "/api/v1/auth/clawhunt", HttpOnly: true, Secure: a.cfg.Env != "development", SameSite: http.SameSiteLaxMode, MaxAge: age})
}
func identityOutcomeURL(invite, outcome, reason string) string {
	query := url.Values{"sso": {outcome}}
	if reason != "" {
		query.Set("reason", reason)
	}
	if identityInvitePattern.MatchString(invite) {
		query.Set("invite", invite)
	}
	return "/?" + query.Encode()
}
func (a *App) identityRedirect(w http.ResponseWriter, r *http.Request, reason, invite string) {
	a.identityFlowCookie(w, "", -1)
	http.Redirect(w, r, a.cfg.PublicOrigin+identityOutcomeURL(invite, "error", reason), http.StatusSeeOther)
}
func (a *App) clawHuntStart(w http.ResponseWriter, r *http.Request) {
	if !a.clawHuntEnabled() {
		fail(w, 404, "not_found", "Identity provider is not configured")
		return
	}
	invite := r.URL.Query().Get("invite")
	if len(r.URL.Query()["invite"]) > 1 || (invite != "" && !identityInvitePattern.MatchString(invite)) {
		fail(w, 400, "invalid_input", "Invalid workspace invitation")
		return
	}
	// A new flow supersedes only this browser's earlier flow. A random browser
	// binding, state and PKCE verifier never leave their intended channels.
	state, browser, verifier := randomID()+randomID(), randomID()+randomID(), randomID()+randomID()
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), "DELETE FROM identity_flows WHERE expires_at<now()"); err != nil {
		a.dbError(w, err)
		return
	}
	if old, e := r.Cookie(identityCookie); e == nil && len(old.Value) <= 256 {
		if _, err = tx.Exec(r.Context(), "DELETE FROM identity_flows WHERE browser_hash=$1", tokenHash(old.Value)); err != nil {
			a.dbError(w, err)
			return
		}
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO identity_flows(state_hash,browser_hash,verifier,expires_at,invite) VALUES($1,$2,$3,$4,$5)", tokenHash(state), tokenHash(browser), verifier, time.Now().Add(5*time.Minute), invite); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	a.identityFlowCookie(w, browser, 300)
	sum := sha256.Sum256([]byte(verifier))
	params := url.Values{"client_id": {a.cfg.ClawHuntClientID}, "redirect_uri": {a.cfg.PublicOrigin + "/api/v1/auth/clawhunt/callback"}, "state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}}
	http.Redirect(w, r, a.cfg.ClawHuntURL+"/api/awwo/sso/authorize?"+params.Encode(), http.StatusSeeOther)
}

// The provider is an explicit deployment origin. Never follow a redirect with
// client credentials, and never expose upstream response bodies in diagnostics.
func (a *App) clawHuntRequest(ctx context.Context, endpoint string, body any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", a.cfg.ClawHuntURL+"/api/awwo/sso/"+endpoint, bytes.NewReader(raw))
	if err != nil {
		return errors.New("identity unavailable")
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(a.cfg.ClawHuntClientID, a.cfg.ClawHuntClientSecret)
	client := *a.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("identity unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("identity rejected")
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(result); err != nil {
		return errors.New("invalid identity response")
	}
	return nil
}
func (a *App) validClawHuntIdentity(id clawHuntIdentity) bool {
	return id.Issuer == a.cfg.ClawHuntURL && id.Audience == a.cfg.ClawHuntClientID && len(id.Subject) > 0 && len(id.Subject) <= 200 && validEmail(id.Email) && len(id.Name) > 0 && len(id.Name) <= 200
}
func (a *App) introspectClawHunt(ctx context.Context, token string) (clawHuntIdentity, time.Time, bool, error) {
	var out struct {
		Active    bool             `json:"active"`
		Identity  clawHuntIdentity `json:"identity"`
		ExpiresAt int64            `json:"expires_at"`
	}
	err := a.clawHuntRequest(ctx, "introspect", map[string]string{"grant_token": token}, &out)
	expires := time.Unix(out.ExpiresAt, 0)
	if err != nil {
		return out.Identity, expires, false, err
	}
	return out.Identity, expires, out.Active && expires.After(time.Now()) && a.validClawHuntIdentity(out.Identity), nil
}
func (a *App) clawHuntCallback(w http.ResponseWriter, r *http.Request) {
	if !a.clawHuntEnabled() {
		fail(w, 404, "not_found", "Identity provider is not configured")
		return
	}
	q := r.URL.Query()
	state, code := q.Get("state"), q.Get("code")
	cookie, err := r.Cookie(identityCookie)
	if err != nil || len(cookie.Value) > 256 || len(state) < 32 || len(state) > 256 || len(q["state"]) != 1 || len(q["code"]) > 1 || len(code) > 512 {
		a.identityRedirect(w, r, "expired", "")
		return
	}
	var verifier, invite string
	err = a.db.QueryRow(r.Context(), "DELETE FROM identity_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() AND identity IS NULL RETURNING verifier,invite", tokenHash(state), tokenHash(cookie.Value)).Scan(&verifier, &invite)
	if noRows(err) {
		a.identityRedirect(w, r, "expired", "")
		return
	}
	if err != nil {
		a.identityRedirect(w, r, "unavailable", "")
		return
	}
	// Only the consumed flow proves this invitation belongs to this browser.
	// Retain it across retries; never accept invite from the callback query.
	if e := q.Get("error"); e != "" {
		reason := "unavailable"
		if e == "access_denied" || e == "waitlisted" {
			reason = "waitlisted"
		}
		a.identityRedirect(w, r, reason, invite)
		return
	}
	if code == "" {
		a.identityRedirect(w, r, "expired", invite)
		return
	}
	var grant clawHuntGrant
	err = a.clawHuntRequest(r.Context(), "token", map[string]string{"code": code, "code_verifier": verifier, "redirect_uri": a.cfg.PublicOrigin + "/api/v1/auth/clawhunt/callback"}, &grant)
	if err != nil {
		a.identityRedirect(w, r, "unavailable", invite)
		return
	}
	if !a.validClawHuntIdentity(grant.Identity) || len(grant.Token) < 32 || len(grant.Token) > 4096 || grant.ExpiresIn <= 0 || grant.ExpiresIn > 3600 {
		a.identityRedirect(w, r, "invalid_identity", invite)
		return
	}
	expires := time.Now().Add(time.Duration(grant.ExpiresIn) * time.Second)
	_, session, collision, err := a.acceptClawHunt(r.Context(), grant.Identity, grant.Token, expires, "")
	if err != nil {
		a.identityRedirect(w, r, "conflict", invite)
		return
	}
	if collision {
		// This grant is only a pending identity claim. It grants no AwwO session
		// until the existing account password is proved in the same browser.
		binding := randomID() + randomID()
		hash := tokenHash(binding)
		sealed, e := a.sealCredential("clawhunt-pending", hash, grant.Token)
		if e != nil {
			a.identityRedirect(w, r, "unavailable", invite)
			return
		}
		identity, _ := json.Marshal(grant.Identity)
		if expires.After(time.Now().Add(5 * time.Minute)) {
			expires = time.Now().Add(5 * time.Minute)
		}
		_, e = a.db.Exec(r.Context(), "INSERT INTO identity_flows(state_hash,browser_hash,identity,grant_secret,expires_at,invite) VALUES($1,$1,$2,$3,$4,$5)", hash, identity, sealed, expires, invite)
		if e != nil {
			a.identityRedirect(w, r, "unavailable", invite)
			return
		}
		a.identityFlowCookie(w, binding, 300)
		http.Redirect(w, r, a.cfg.PublicOrigin+identityOutcomeURL(invite, "link", ""), http.StatusSeeOther)
		return
	}
	a.identityFlowCookie(w, "", -1)
	a.sessionCookie(w, session, int(time.Until(expires).Seconds()))
	http.Redirect(w, r, a.cfg.PublicOrigin+identityReturnURL(invite), http.StatusSeeOther)
}

// Stable provider subject is the identity key. Matching email never proves
// ownership of an existing AwwO user, including an unverified provider email.
func (a *App) acceptClawHunt(ctx context.Context, id clawHuntIdentity, grant string, expires time.Time, proof string) (User, string, bool, error) {
	var u User
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return u, "", false, err
	}
	defer tx.Rollback(ctx)
	// Serialize identities and email claims across concurrent callbacks.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,84321003))", id.Issuer+":"+id.Subject); err != nil {
		return u, "", false, err
	}
	err = tx.QueryRow(ctx, "SELECT u.id,u.email,u.name,u.platform_role FROM users u JOIN external_identities e ON e.user_id=u.id WHERE e.issuer=$1 AND e.subject=$2 FOR UPDATE OF u", id.Issuer, id.Subject).Scan(&u.ID, &u.Email, &u.Name, &u.PlatformRole)
	if noRows(err) {
		email := strings.ToLower(strings.TrimSpace(id.Email))
		var hash string
		err = tx.QueryRow(ctx, "SELECT id,email,name,platform_role,password_hash FROM users WHERE email=$1 FOR UPDATE", email).Scan(&u.ID, &u.Email, &u.Name, &u.PlatformRole, &hash)
		if err == nil {
			if proof == "" {
				return u, "", true, nil
			}
			if len(proof) > 1024 || !checkPassword(proof, hash) {
				return User{}, "", false, errors.New("account proof rejected")
			}
		} else if noRows(err) {
			if proof != "" {
				return User{}, "", false, errors.New("account changed")
			}
			u = User{randomID(), email, id.Name, "user"}
			if _, err = tx.Exec(ctx, "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,'!clawhunt')", u.ID, u.Email, u.Name); err != nil {
				return u, "", false, err
			}
			tid := randomID()
			if _, err = tx.Exec(ctx, "INSERT INTO tenants(id,name) VALUES($1,$2)", tid, id.Name+" · AwwO"); err != nil {
				return u, "", false, err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", tid, u.ID); err != nil {
				return u, "", false, err
			}
		} else {
			return u, "", false, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO external_identities(issuer,subject,user_id) VALUES($1,$2,$3)", id.Issuer, id.Subject, u.ID); err != nil {
			return u, "", false, err
		}
	} else if err != nil {
		return u, "", false, err
	}
	token, err := a.createLogin(ctx, tx, u.ID)
	if err != nil {
		return u, "", false, err
	}
	sealed, err := a.sealCredential(u.ID, "clawhunt-session:"+tokenHash(token), grant)
	if err != nil {
		return u, "", false, err
	}
	if _, err = tx.Exec(ctx, "UPDATE auth_sessions SET sso_issuer=$2,sso_subject=$3,sso_grant=$4,expires_at=LEAST(expires_at,$5) WHERE token_hash=$1", tokenHash(token), id.Issuer, id.Subject, sealed, expires); err != nil {
		return u, "", false, err
	}
	if err = audit(ctx, tx, u.ID, "", "auth.clawhunt_login", u.ID); err != nil {
		return u, "", false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return u, "", false, err
	}
	// Display the provider's current profile without rewriting the legacy
	// account email used during explicit ownership proof.
	u.Name, u.Email = id.Name, id.Email
	return u, token, false, nil
}
func (a *App) readPendingClawHunt(r *http.Request) (clawHuntIdentity, string, time.Time, error) {
	var id clawHuntIdentity
	var raw, sealed []byte
	var expires time.Time
	c, err := r.Cookie(identityCookie)
	if err != nil || len(c.Value) > 256 || !a.clawHuntEnabled() {
		return id, "", expires, errors.New("missing pending identity")
	}
	hash := tokenHash(c.Value)
	err = a.db.QueryRow(r.Context(), "SELECT identity,grant_secret,expires_at FROM identity_flows WHERE state_hash=$1 AND browser_hash=$1 AND identity IS NOT NULL AND expires_at>now()", hash).Scan(&raw, &sealed, &expires)
	if err != nil {
		return id, "", expires, err
	}
	if err = json.Unmarshal(raw, &id); err != nil || !a.validClawHuntIdentity(id) {
		return id, "", expires, errors.New("invalid pending identity")
	}
	grant, err := a.openCredential("clawhunt-pending", hash, sealed)
	return id, grant, expires, err
}
func (a *App) clawHuntPending(w http.ResponseWriter, r *http.Request) {
	id, _, expires, err := a.readPendingClawHunt(r)
	if err != nil {
		fail(w, 401, "sso_expired", "Continue with ClawHunt again")
		return
	}
	writeJSON(w, 200, map[string]any{"email": id.Email, "expiresAt": expires})
}
func (a *App) clawHuntLink(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Password string `json:"password"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Password == "" || len(b.Password) > 1024 {
		fail(w, 400, "invalid_input", "Account password is required")
		return
	}
	id, grant, expires, err := a.readPendingClawHunt(r)
	if err != nil {
		fail(w, 401, "sso_expired", "Continue with ClawHunt again")
		return
	}
	live, grantExpiry, active, err := a.introspectClawHunt(r.Context(), grant)
	if err != nil {
		fail(w, 503, "sso_unavailable", "ClawHunt is unavailable")
		return
	}
	if !active || live.Subject != id.Subject || live.Issuer != id.Issuer {
		fail(w, 401, "sso_expired", "Continue with ClawHunt again")
		return
	}
	c, _ := r.Cookie(identityCookie)
	// Consume before password proof to make every link attempt single-use.
	var invite string
	err = a.db.QueryRow(r.Context(), "DELETE FROM identity_flows WHERE state_hash=$1 AND expires_at>now() RETURNING invite", tokenHash(c.Value)).Scan(&invite)
	if noRows(err) {
		fail(w, 401, "sso_expired", "Continue with ClawHunt again")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	a.identityFlowCookie(w, "", -1)
	expires = grantExpiry
	u, token, _, err := a.acceptClawHunt(r.Context(), id, grant, expires, b.Password)
	if err != nil {
		fail(w, 401, "sso_link_failed", "Account proof failed; continue with ClawHunt again")
		return
	}
	// Proof remains bound to the original pending account; profile changes
	// since that claim are display-only and cannot retarget the password proof.
	u.Name, u.Email = live.Name, live.Email
	a.sessionCookie(w, token, int(time.Until(expires).Seconds()))
	ctx := context.WithValue(r.Context(), clawHuntSessionKey{}, true)
	ctx = context.WithValue(ctx, clawHuntReturnKey{}, identityReturnURL(invite))
	a.meResponse(w, r.WithContext(ctx), u, 200)
}

func (a *App) validateClawHuntSession(ctx context.Context, hash, user, issuer, subject string, sealed []byte) (bool, error) {
	_, valid, err := a.validateClawHuntSessionIdentity(ctx, hash, user, issuer, subject, sealed)
	return valid, err
}

func (a *App) validateClawHuntSessionIdentity(ctx context.Context, hash, user, issuer, subject string, sealed []byte) (clawHuntIdentity, bool, error) {
	var empty clawHuntIdentity
	if len(sealed) == 0 {
		return empty, !a.clawHuntEnabled(), nil
	}
	if !a.clawHuntEnabled() || issuer != a.cfg.ClawHuntURL {
		return empty, false, nil
	}
	grant, err := a.openCredential(user, "clawhunt-session:"+hash, sealed)
	if err != nil {
		return empty, false, err
	}
	id, _, active, err := a.introspectClawHunt(ctx, grant)
	if err != nil {
		return empty, false, err
	}
	return id, active && subtle.ConstantTimeCompare([]byte(id.Subject), []byte(subject)) == 1 && id.Issuer == issuer, nil
}
func (a *App) validClawHuntLogoutURL(raw string) bool {
	if raw == a.cfg.PublicOrigin+"/" {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" {
		return false
	}
	return u.Scheme+"://"+u.Host == a.cfg.ClawHuntURL && u.Path == "/api/awwo/sso/logout" && len(u.Query()["ticket"]) == 1 && len(u.Query().Get("ticket")) >= 32 && len(u.Query()) == 1
}
