package app

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

const invitesPath = "/auth/clawhunt/invites"

func clawHuntMember(t *testing.T) (*harness, *identityFixture, *http.Cookie) {
	t.Helper()
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.inviteReads.perMinute = 1000 // these tests read many times a minute
	f := newIdentityFixture(t, h, "member@example.invalid", "subject-member")
	return h, f, responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
}

// invitesRaw posts to the invites route and returns the raw response (status and cookies).
func invitesRaw(t *testing.T, h *harness, c *http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest("POST", h.server.URL+"/api/v1"+invitesPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", h.cfg.PublicOrigin)
	req.AddCookie(c)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestClawHuntInviteReadsAreBoundedPerAccount(t *testing.T) {
	l := &inviteReadLimiter{perMinute: 3}
	now := time.Unix(1_800_000_000, 0)
	done, ok := l.begin("a", now)
	if !ok {
		t.Fatal("first read refused")
	}
	if _, ok := l.begin("a", now); ok {
		t.Fatal("a second read while the first waits on the issuer")
	}
	if release, ok := l.begin("b", now); !ok {
		t.Fatal("another account was held up")
	} else {
		release()
	}
	done()
	for i := 0; i < 2; i++ {
		release, ok := l.begin("a", now.Add(time.Second))
		if !ok {
			t.Fatal("read", i+2, "refused within the budget")
		}
		release()
	}
	if _, ok := l.begin("a", now.Add(2*time.Second)); ok {
		t.Fatal("a fourth read in the same minute")
	}
	if release, ok := l.begin("a", now.Add(61*time.Second)); !ok {
		t.Fatal("still refused a minute later")
	} else {
		release()
	}
	if (&inviteReadLimiter{}).perMinute != 0 {
		t.Fatal("zero value")
	}
}

func TestPostgresClawHuntInviteReadsDoNotUseTheSignInLimiter(t *testing.T) {
	h, _, c := clawHuntMember(t)
	h.a.inviteReads.perMinute = 2
	for i := 0; i < 2; i++ {
		h.request(t, c, "POST", invitesPath, nil, 200)
	}
	h.request(t, c, "POST", invitesPath, nil, 429)
	// The account's own bound refused it; the sign-in limiter was never involved.
	h.a.mu.Lock()
	entries := len(h.a.limits)
	h.a.mu.Unlock()
	start := identityRequest(t, h, nil, "start")
	if start.StatusCode != 303 {
		t.Fatal("sign-in start after invite reads", start.StatusCode, entries)
	}
}

func TestPostgresClawHuntInvitesShowTheAccountsOwnCodes(t *testing.T) {
	h, f, c := clawHuntMember(t)
	out := h.request(t, c, "POST", invitesPath, nil, 200)
	codes, _ := out["codes"].([]any)
	if out["member"] != true || out["limit"] != float64(3) || len(codes) != 3 {
		t.Fatal("member codes", out)
	}
	first, second := codes[0].(map[string]any), codes[1].(map[string]any)
	if first["code"] != "AWWO-AB12-CD34-EF56" || first["status"] != "unused" || second["status"] != "used" {
		t.Fatal("codes changed on the way", codes)
	}
	// AwwO asked with this session's own grant.
	if grant, _ := f.invitesGrant.Load().(string); grant != strings.Repeat("g", 43) {
		t.Fatal("grant", grant)
	}
	// An account with nothing to pass on reads an empty list, never null.
	f.invitesBody.Store(map[string]any{"active": true, "sub": "subject-member", "member": false, "limit": 3, "codes": nil})
	out = h.request(t, c, "POST", invitesPath, nil, 200)
	if out["member"] != false || out["codes"] == nil || len(out["codes"].([]any)) != 0 {
		t.Fatal("non-member", out)
	}
	h.request(t, nil, "POST", invitesPath, nil, 401)
}

func TestPostgresClawHuntInvitesFailClosed(t *testing.T) {
	h, f, c := clawHuntMember(t)
	// An issuer without the endpoint yet, or one that is down.
	for _, status := range []int32{404, 401, 500, 503} {
		f.invitesStatus.Store(status)
		h.request(t, c, "POST", invitesPath, nil, 503)
	}
	f.invitesStatus.Store(0)
	code := map[string]any{"code": "AWWO-AB12-CD34-EF56", "status": "unused"}
	for _, bad := range []map[string]any{
		{"active": true, "sub": "subject-member", "member": true, "limit": 3, "codes": []any{map[string]any{"code": "<img src=x>", "status": "unused"}}},
		{"active": true, "sub": "subject-member", "member": true, "limit": 3, "codes": []any{map[string]any{"code": "AWWO-AB12-CD34-EF56", "status": "stolen"}}},
		{"active": true, "sub": "subject-member", "member": true, "limit": 1, "codes": []any{code, code}},
		{"active": true, "sub": "subject-member", "member": false, "limit": 3, "codes": []any{code}},
		{"active": true, "sub": "subject-member", "member": true, "limit": 50, "codes": []any{}},
		{"active": true, "sub": "subject-member", "member": true, "limit": -1, "codes": []any{}},
		// Another account's codes, or an answer that names no account, are never shown.
		{"active": true, "sub": "subject-other", "member": true, "limit": 3, "codes": []any{code}},
		{"active": true, "member": true, "limit": 3, "codes": []any{code}},
	} {
		f.invitesBody.Store(bad)
		h.request(t, c, "POST", invitesPath, nil, 503)
	}
	f.invitesBody.Store(map[string]any{"active": "yes"})
	h.request(t, c, "POST", invitesPath, nil, 503)
	// None of these ends the session: only an inactive grant does.
	f.invitesBody.Store(map[string]any{"active": true, "sub": "subject-other", "member": true, "limit": 3, "codes": []any{code}})
	for _, status := range []int32{0, 503} {
		f.invitesStatus.Store(status)
		if resp := invitesRaw(t, h, c); resp.StatusCode != 503 || len(resp.Cookies()) != 0 {
			t.Fatal("a refusal touched the session", resp.StatusCode, resp.Cookies())
		}
	}
	f.invitesStatus.Store(0)
	h.request(t, c, "GET", "/auth/me", nil, 200)
}

func TestPostgresClawHuntInvitesEndWithTheGrant(t *testing.T) {
	h, f, c := clawHuntMember(t)
	h.request(t, c, "GET", "/auth/me", nil, 200)
	// Signed out of the main site: the issuer reports the grant inactive, everywhere.
	f.active.Store(false)
	req, err := http.NewRequest("POST", h.server.URL+"/api/v1"+invitesPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", h.cfg.PublicOrigin)
	req.AddCookie(c)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("ended grant", resp.StatusCode)
	}
	cleared := false
	for _, k := range resp.Cookies() {
		cleared = cleared || (k.Name == "awwo_session" && k.MaxAge < 0)
	}
	if !cleared {
		t.Fatal("session cookie kept")
	}
	// The verification cache forgot the session, so the next request asks again and ends it too.
	h.request(t, c, "GET", "/auth/me", nil, 401)
}

func TestPostgresClawHuntInvitesNeedAClawHuntSession(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	c, _, _ := h.register(t, "local@example.invalid")
	h.request(t, c, "POST", invitesPath, nil, 404)
}

func TestPostgresClawHuntStartAsksForSignUpOnlyWhenTold(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	newIdentityFixture(t, h, "new@example.invalid", "subject-new")
	for query, want := range map[string]string{"start?signup=1": "create", "start": "", "start?signup=0": "", "start?signup=true": ""} {
		resp := identityRequest(t, h, nil, query)
		if resp.StatusCode != 303 {
			t.Fatal(query, resp.StatusCode)
		}
		u, err := url.Parse(resp.Header.Get("Location"))
		if err != nil || u.Path != "/api/awwo/sso/authorize" {
			t.Fatal(query, resp.Header.Get("Location"))
		}
		if got := u.Query().Get("prompt"); got != want || (want == "" && u.Query().Has("prompt")) {
			t.Fatalf("%s: prompt %q, want %q", query, got, want)
		}
	}
}
