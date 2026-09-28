package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClawHuntConfigurationAndNavigationBoundaries(t *testing.T) {
	c := testConfig()
	c.CredentialKey = bytes.Repeat([]byte{1}, 32)
	c.ClawHuntClientID = "awwo-test"
	c.ClawHuntClientSecret = strings.Repeat("s", 32)
	for _, origin := range []string{"http://127.0.0.1:8795", "http://localhost:8795", "https://clawhunt.store"} {
		c.ClawHuntURL = origin
		if err := c.Validate(); err != nil {
			t.Fatal(origin, err)
		}
	}
	for _, origin := range []string{"http://evil.example", "https://user@clawhunt.store", "https://clawhunt.store/", "https://clawhunt.store?", "https://clawhunt.store#", "http://127.1:8795"} {
		c.ClawHuntURL = origin
		if err := c.Validate(); err == nil {
			t.Fatal("unsafe issuer accepted", origin)
		}
	}
	c.ClawHuntURL = "http://127.0.0.1:8795"
	c.Env = "production"
	c.PublicOrigin = "https://awwo.example"
	if c.Validate() == nil {
		t.Fatal("production loopback accepted")
	}
	c.Env = "development"
	a := New(nil, c)
	if !a.validClawHuntLogoutURL(c.ClawHuntURL + "/api/awwo/sso/logout?ticket=" + strings.Repeat("a", 43)) {
		t.Fatal("expected trusted logout")
	}
	for _, raw := range []string{"https://evil.example/api/awwo/sso/logout?ticket=" + strings.Repeat("a", 43), c.ClawHuntURL + "/api/awwo/sso/logout?ticket=" + strings.Repeat("a", 43) + "&next=https://evil.example", c.ClawHuntURL + "/wrong?ticket=" + strings.Repeat("a", 43)} {
		if a.validClawHuntLogoutURL(raw) {
			t.Fatal("unsafe logout URL")
		}
	}
}

type identityFixture struct {
	server      *httptest.Server
	active      atomic.Bool
	unavailable atomic.Bool
	exchanges   atomic.Int32
	id          clawHuntIdentity
	challenge   string
}

func newIdentityFixture(t *testing.T, h *harness, email, subject string) *identityFixture {
	t.Helper()
	f := &identityFixture{}
	f.active.Store(true)
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		client, secret, ok := r.BasicAuth()
		if !ok || client != "awwo-test" || secret != strings.Repeat("s", 32) {
			w.WriteHeader(401)
			return
		}
		if f.unavailable.Load() {
			w.WriteHeader(503)
			return
		}
		switch r.URL.Path {
		case "/api/awwo/sso/token":
			var b map[string]string
			json.NewDecoder(r.Body).Decode(&b)
			sum := sha256.Sum256([]byte(b["code_verifier"]))
			if b["code"] != "test-code" || b["redirect_uri"] != h.cfg.PublicOrigin+"/api/v1/auth/clawhunt/callback" || base64.RawURLEncoding.EncodeToString(sum[:]) != f.challenge {
				w.WriteHeader(400)
				return
			}
			f.exchanges.Add(1)
			writeJSON(w, 200, clawHuntGrant{strings.Repeat("g", 43), 3600, f.id})
		case "/api/awwo/sso/introspect":
			writeJSON(w, 200, map[string]any{"active": f.active.Load(), "expires_at": time.Now().Add(time.Hour).Unix(), "identity": f.id})
		case "/api/awwo/sso/revoke":
			if !f.active.Load() {
				writeJSON(w, 200, map[string]string{"logout_url": h.cfg.PublicOrigin + "/"})
				return
			}
			f.active.Store(false)
			writeJSON(w, 200, map[string]string{"logout_url": f.server.URL + "/api/awwo/sso/logout?ticket=" + strings.Repeat("t", 43)})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.server.Close)
	f.id = clawHuntIdentity{f.server.URL, "awwo-test", subject, email, false, "ClawHunt Test"}
	h.a.cfg.ClawHuntURL = f.server.URL
	h.a.cfg.ClawHuntClientID = "awwo-test"
	h.a.cfg.ClawHuntClientSecret = strings.Repeat("s", 32)
	h.a.cfg.CredentialKey = bytes.Repeat([]byte{1}, 32)
	return f
}
func identityRequest(t *testing.T, h *harness, cookie *http.Cookie, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest("GET", h.server.URL+"/api/v1/auth/clawhunt/"+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}
func startIdentity(t *testing.T, h *harness, f *identityFixture, invite string) (*http.Cookie, string) {
	t.Helper()
	resp := identityRequest(t, h, nil, "start?invite="+url.QueryEscape(invite))
	if resp.StatusCode != 303 {
		t.Fatal("start", resp.StatusCode)
	}
	u, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	f.challenge = u.Query().Get("code_challenge")
	if u.Query().Get("code_challenge_method") != "S256" || len(f.challenge) != 43 {
		t.Fatal("missing PKCE")
	}
	for _, c := range resp.Cookies() {
		if c.Name == identityCookie {
			if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
				t.Fatal("unsafe cookie")
			}
			return c, u.Query().Get("state")
		}
	}
	t.Fatal("missing flow cookie")
	return nil, ""
}
func completeIdentity(t *testing.T, h *harness, f *identityFixture, invite string) *http.Response {
	c, state := startIdentity(t, h, f, invite)
	return identityRequest(t, h, c, "callback?code=test-code&state="+url.QueryEscape(state))
}
func responseCookie(t *testing.T, r *http.Response, name string) *http.Cookie {
	t.Helper()
	for _, c := range r.Cookies() {
		if c.Name == name && c.Value != "" {
			return c
		}
	}
	t.Fatal("missing", name)
	return nil
}
func TestPostgresClawHuntIdentitySessionRevocationAndStableWorkspace(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	f := newIdentityFixture(t, h, "unified@example.invalid", "subject-one")
	invite := strings.Repeat("x", 66)
	first := completeIdentity(t, h, f, invite)
	if first.StatusCode != 303 || first.Header.Get("Location") != h.cfg.PublicOrigin+"/?invite="+invite {
		t.Fatal("lost invitation", first.StatusCode, first.Header.Get("Location"))
	}
	c := responseCookie(t, first, "awwo_session")
	me := h.request(t, c, "GET", "/auth/me", nil, 200)
	if me["authentication"] != "clawhunt" || len(me["tenants"].([]any)) != 1 {
		t.Fatal("unified identity missing", me)
	}
	uid := me["user"].(map[string]any)["id"].(string)
	tid := me["tenants"].([]any)[0].(map[string]any)["id"]
	second := completeIdentity(t, h, f, "")
	c2 := responseCookie(t, second, "awwo_session")
	again := h.request(t, c2, "GET", "/auth/me", nil, 200)
	if again["user"].(map[string]any)["id"] != uid || again["tenants"].([]any)[0].(map[string]any)["id"] != tid {
		t.Fatal("repeat login duplicated workspace")
	}
	for _, path := range []string{"/auth/register", "/auth/login", "/auth/forgot-password", "/auth/reset-password"} {
		h.request(t, nil, "POST", path, map[string]any{}, 403)
	}
	h.request(t, c, "POST", "/auth/password", map[string]any{}, 403)
	h.request(t, c, "PATCH", "/auth/profile", map[string]any{}, 403)
	f.unavailable.Store(true)
	h.request(t, c, "GET", "/auth/me", nil, 503)
	f.unavailable.Store(false)
	f.active.Store(false)
	h.request(t, c, "GET", "/auth/me", nil, 401)
	f.active.Store(true)
	out := h.request(t, c2, "POST", "/auth/logout", nil, 200)
	if !strings.Contains(out["logoutURL"].(string), "/api/awwo/sso/logout?ticket=") {
		t.Fatal("missing unified logout")
	}
	h.request(t, c2, "GET", "/auth/me", nil, 401)
	completed := h.request(t, c, "POST", "/auth/logout", nil, 200)
	if completed["logoutURL"] != h.cfg.PublicOrigin+"/" {
		t.Fatal("revoked source cannot sign out")
	}
	h.request(t, c, "POST", "/auth/logout", nil, 204)
}
func TestPostgresClawHuntStateIsBoundAndConsumed(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	f := newIdentityFixture(t, h, "state@example.invalid", "state-user")
	c, state := startIdentity(t, h, f, "")
	wrong := identityRequest(t, h, &http.Cookie{Name: identityCookie, Value: randomID()}, "callback?code=test-code&state="+state)
	if !strings.Contains(wrong.Header.Get("Location"), "reason=expired") || f.exchanges.Load() != 0 {
		t.Fatal("unbound callback admitted")
	}
	valid := identityRequest(t, h, c, "callback?code=test-code&state="+state)
	responseCookie(t, valid, "awwo_session")
	replay := identityRequest(t, h, c, "callback?code=test-code&state="+state)
	if !strings.Contains(replay.Header.Get("Location"), "reason=expired") || f.exchanges.Load() != 1 {
		t.Fatal("callback replay admitted")
	}
	c, state = startIdentity(t, h, f, "")
	denied := identityRequest(t, h, c, "callback?error=access_denied&state="+state)
	if !strings.Contains(denied.Header.Get("Location"), "reason=waitlisted") {
		t.Fatal("waitlist lost")
	}
}

func TestPostgresClawHuntCallbackFailurePreservesOnlyBoundInvitation(t *testing.T) {
	for _, tc := range []struct {
		name, callback, reason       string
		unavailable, invalidIdentity bool
	}{
		{name: "provider unavailable", callback: "code=test-code", reason: "unavailable", unavailable: true},
		{name: "waitlisted", callback: "error=access_denied", reason: "waitlisted"},
		{name: "missing code", callback: "", reason: "expired"},
		{name: "invalid identity", callback: "code=test-code", reason: "invalid_identity", invalidIdentity: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, "http://127.0.0.1:1")
			f := newIdentityFixture(t, h, "invited@example.invalid", "invited-subject")
			invite, injected := strings.Repeat("i", 66), strings.Repeat("x", 66)
			cookie, state := startIdentity(t, h, f, invite)
			f.unavailable.Store(tc.unavailable)
			if tc.invalidIdentity {
				f.id.Audience = "another-client"
			}
			callback := "callback?state=" + url.QueryEscape(state) + "&invite=" + injected + "&" + tc.callback
			// Neither a supplied invite nor knowledge of state proves the browser binding.
			wrong := identityRequest(t, h, &http.Cookie{Name: identityCookie, Value: randomID()}, callback)
			wrongURL, err := url.Parse(wrong.Header.Get("Location"))
			if err != nil || wrongURL.Query().Get("invite") != "" {
				t.Fatal("unbound invitation reflected", wrong.Header.Get("Location"), err)
			}
			response := identityRequest(t, h, cookie, callback)
			location, err := url.Parse(response.Header.Get("Location"))
			if err != nil || response.StatusCode != 303 || location.Query().Get("sso") != "error" || location.Query().Get("reason") != tc.reason || location.Query().Get("invite") != invite {
				t.Fatal("bound invitation lost or replaced during retry", response.StatusCode, response.Header.Get("Location"), err)
			}
			// A consumed callback can no longer recover an invite from its query.
			replay := identityRequest(t, h, cookie, callback)
			replayURL, err := url.Parse(replay.Header.Get("Location"))
			if err != nil || replayURL.Query().Get("invite") != "" {
				t.Fatal("replayed invitation reflected", replay.Header.Get("Location"), err)
			}
		})
	}
}

func TestPostgresClawHuntLegacyProofPreservesDataAndCredentials(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	old, tid, uid := h.register(t, "legacy@example.invalid")
	canvas := h.request(t, old, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Existing workspace history", "document": map[string]any{}}, 201)
	f := newIdentityFixture(t, h, "legacy@example.invalid", "legacy-main-subject")
	connectionID := randomID()
	sealed, err := h.a.sealCredential(uid, connectionID, "fixture-provider-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.db.Exec(context.Background(), "INSERT INTO user_connections(id,user_id,provider,runtime,name,secret,models) VALUES($1,$2,'llmgate','pi','Existing engine',$3,'[\"fixture-model\"]')", connectionID, uid, sealed); err != nil {
		t.Fatal(err)
	}
	h.request(t, old, "GET", "/auth/me", nil, 401)
	invite := strings.Repeat("i", 66)
	first := completeIdentity(t, h, f, invite)
	linkURL, err := url.Parse(first.Header.Get("Location"))
	if err != nil || linkURL.Query().Get("sso") != "link" || linkURL.Query().Get("invite") != invite {
		t.Fatal("email auto-merged or invitation lost before password proof", first.Header.Get("Location"), err)
	}
	flow := responseCookie(t, first, identityCookie)
	h.request(t, flow, "GET", "/auth/clawhunt/pending", nil, 200)
	h.request(t, flow, "POST", "/auth/clawhunt/link", map[string]string{"password": "incorrect-password"}, 401)
	h.request(t, flow, "GET", "/auth/clawhunt/pending", nil, 401)
	// The frontend clears only sso/reason, and retries from the retained invite.
	// Exercise that return URL after the first password proof consumed its flow.
	second := completeIdentity(t, h, f, linkURL.Query().Get("invite"))
	flow = responseCookie(t, second, identityCookie)
	f.id.Name = "Updated while proof was pending"
	// Use the same legacy password as the shared registration fixture.
	out := h.request(t, flow, "POST", "/auth/clawhunt/link", map[string]string{"password": "Strong password 123!"}, 200)
	if out["user"].(map[string]any)["id"] != uid || out["tenants"].([]any)[0].(map[string]any)["id"] != tid || out["redirectURL"] != "/?invite="+strings.Repeat("i", 66) {
		t.Fatal("legacy data identity changed", out)
	}
	if out["user"].(map[string]any)["name"] != f.id.Name {
		t.Fatal("link response did not use the latest provider profile", out["user"])
	}
	var n int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM users WHERE email=$1", "legacy@example.invalid").Scan(&n); err != nil || n != 1 {
		t.Fatal("duplicate account", err, n)
	}
	login := completeIdentity(t, h, f, "")
	session := responseCookie(t, login, "awwo_session")
	saved := h.request(t, session, "GET", "/tenants/"+tid+"/canvases/"+canvas["id"].(string), nil, 200)
	if saved["name"] != "Existing workspace history" {
		t.Fatal("lost canvas")
	}
	connections := h.request(t, session, "GET", "/auth/connections", nil, 200)
	if len(connections["items"].([]any)) != 1 {
		t.Fatal("lost credentials")
	}
	if secret, err := h.a.openCredential(uid, connectionID, sealed); err != nil || secret != "fixture-provider-key" {
		t.Fatal("credential ownership changed", err)
	}
}

func TestPostgresClawHuntLiveProfileDoesNotReassignEmailOwnership(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	_, otherTenant, otherUser := h.register(t, "existing-other@example.invalid")
	f := newIdentityFixture(t, h, "original-profile@example.invalid", "stable-profile-subject")
	session := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	before := h.request(t, session, "GET", "/auth/me", nil, 200)
	uid := before["user"].(map[string]any)["id"].(string)
	tid := before["tenants"].([]any)[0].(map[string]any)["id"].(string)
	role := before["user"].(map[string]any)["platformRole"]
	canvas := h.request(t, session, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Original subject canvas", "document": map[string]any{}}, 201)
	connectionID := randomID()
	sealed, err := h.a.sealCredential(uid, connectionID, "original-subject-provider-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.db.Exec(context.Background(), "INSERT INTO user_connections(id,user_id,provider,runtime,name,secret,models) VALUES($1,$2,'llmgate','pi','Original subject engine',$3,'[\"fixture-model\"]')", connectionID, uid, sealed); err != nil {
		t.Fatal(err)
	}
	f.id.Name = "Current main-site profile"
	f.id.Email = "existing-other@example.invalid"
	after := h.request(t, session, "GET", "/auth/me", nil, 200)
	user := after["user"].(map[string]any)
	if user["name"] != f.id.Name || user["email"] != f.id.Email || user["id"] != uid || user["platformRole"] != role {
		t.Fatal("live profile was stale or changed stable account ownership", user)
	}
	if len(after["tenants"].([]any)) != 1 || after["tenants"].([]any)[0].(map[string]any)["id"] != tid {
		t.Fatal("provider email inherited another account's workspaces", after["tenants"])
	}
	h.request(t, session, "GET", "/tenants/"+otherTenant+"/canvases", nil, 404)
	h.request(t, session, "GET", "/tenants/"+tid+"/canvases/"+canvas["id"].(string), nil, 200)
	connections := h.request(t, session, "GET", "/auth/connections", nil, 200)
	if len(connections["items"].([]any)) != 1 {
		t.Fatal("provider change lost the original model connection")
	}
	if value, err := h.a.openCredential(uid, connectionID, sealed); err != nil || value != "original-subject-provider-key" {
		t.Fatal("provider change altered credential ownership", err)
	}
	if _, err := h.a.openCredential(otherUser, connectionID, sealed); err == nil {
		t.Fatal("another local account could decrypt the original credentials")
	}
	var storedEmail, storedName string
	if err := h.db.QueryRow(context.Background(), "SELECT email,name FROM users WHERE id=$1", uid).Scan(&storedEmail, &storedName); err != nil || storedEmail != "original-profile@example.invalid" || storedName != "ClawHunt Test" {
		t.Fatal("display projection rewrote legacy account data", err)
	}
	repeated := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	stable := h.request(t, repeated, "GET", "/auth/me", nil, 200)
	if stable["user"].(map[string]any)["id"] != uid || stable["tenants"].([]any)[0].(map[string]any)["id"] != tid {
		t.Fatal("repeated login remapped the identity by email", stable)
	}
}
