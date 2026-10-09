package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestSignupSettings(t *testing.T) {
	var unset Config
	if err := unset.signupSettingsFromEnv(); err != nil || unset.NewAccountsPerIPPerDay != 0 || unset.RequireVerifiedEmail {
		t.Fatal("unset must hold nothing", unset.NewAccountsPerIPPerDay, unset.RequireVerifiedEmail, err)
	}
	t.Setenv("AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY", "3")
	t.Setenv("AWWO_REQUIRE_VERIFIED_EMAIL", "true")
	var c Config
	if err := c.signupSettingsFromEnv(); err != nil || c.NewAccountsPerIPPerDay != 3 || !c.RequireVerifiedEmail {
		t.Fatal(c.NewAccountsPerIPPerDay, c.RequireVerifiedEmail, err)
	}
	t.Setenv("AWWO_REQUIRE_VERIFIED_EMAIL", "false")
	t.Setenv("AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY", "0")
	c = Config{}
	if err := c.signupSettingsFromEnv(); err != nil || c.NewAccountsPerIPPerDay != 0 || c.RequireVerifiedEmail {
		t.Fatal("0 and false hold nothing", c.NewAccountsPerIPPerDay, c.RequireVerifiedEmail, err)
	}
	for _, bad := range []string{"-1", "x", "2.5", "100001", " 3"} {
		t.Setenv("AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY", bad)
		if err := (&Config{}).signupSettingsFromEnv(); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	t.Setenv("AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY", "")
	for _, bad := range []string{"TRUE", "1", "yes", "on"} {
		t.Setenv("AWWO_REQUIRE_VERIFIED_EMAIL", bad)
		if err := (&Config{}).signupSettingsFromEnv(); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	// Both hold first ClawHunt sign-ins only, so without ClawHunt they are refused rather than silently idle.
	for _, set := range []func(*Config){func(c *Config) { c.NewAccountsPerIPPerDay = 3 }, func(c *Config) { c.RequireVerifiedEmail = true }} {
		c := testConfig()
		set(&c)
		if err := c.Validate(); err == nil {
			t.Fatal("a sign-up limit accepted without ClawHunt")
		}
		c.ClawHuntURL, c.ClawHuntClientID, c.ClawHuntClientSecret, c.CredentialKey = "https://clawhunt.store", "awwo-test", strings.Repeat("s", 32), bytes.Repeat([]byte{1}, 32)
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSignupAddressAndKeyedHash(t *testing.T) {
	for ip, want := range map[string]string{
		"198.51.100.7":           "198.51.100.7",
		"::ffff:198.51.100.7":    "198.51.100.7",
		"2001:db8:1:2::10":       "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff::1":   "2001:db8:1:2::/64",
		"2001:db8:1:3::1":        "2001:db8:1:3::/64",
		"fe80::1%eth0":           "fe80::/64",
		"not-an-address":         "not-an-address",
		"[2001:db8::1]:443":      "[2001:db8::1]:443",
		"2001:0db8:0001:0002::1": "2001:db8:1:2::/64",
	} {
		if got := signupAddress(ip); got != want {
			t.Fatalf("%s counts as %s, want %s", ip, got, want)
		}
	}
	a := &App{cfg: Config{CredentialKey: bytes.Repeat([]byte{1}, 32)}}
	other := &App{cfg: Config{CredentialKey: bytes.Repeat([]byte{2}, 32)}}
	h := a.signupIPHash("2026-10-09", "198.51.100.7")
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(h) || strings.Contains(h, "198") {
		t.Fatal("not a hex digest", h)
	}
	// Keyed: neither a plain digest of the address nor the same under another key; per day; one /64 is one key.
	for _, plain := range []string{tokenHash("198.51.100.7"), tokenHash("2026-10-09\x00198.51.100.7"), other.signupIPHash("2026-10-09", "198.51.100.7"), a.signupIPHash("2026-10-10", "198.51.100.7"), a.signupIPHash("2026-10-09", "198.51.100.8")} {
		if plain == h {
			t.Fatal("hash is not keyed, per day and per address")
		}
	}
	if a.signupIPHash("2026-10-09", "198.51.100.7") != h || a.signupIPHash("2026-10-09", "2001:db8:1:2::10") != a.signupIPHash("2026-10-09", "2001:db8:1:2:ffff::1") {
		t.Fatal("hash is not stable for one address and one /64")
	}
	a.signupClock = func() time.Time { return time.Date(2026, 10, 9, 23, 59, 59, 0, time.FixedZone("UTC+8", 8*3600)) }
	if a.signupDay() != "2026-10-09" {
		t.Fatal("the day must be the UTC day", a.signupDay())
	}
}

func TestSignupRefusalReasons(t *testing.T) {
	for err, want := range map[error]string{
		errSignupLimited:                            "signup_limited",
		errSignupUnverifiedEmail:                    "email_unverified",
		fmt.Errorf("wrapped: %w", errSignupLimited): "signup_limited",
		errors.New("account proof rejected"):        "conflict",
	} {
		if got := signupRefusal(err); got != want {
			t.Fatal(err, got, want)
		}
	}
	// An issuer that leaves email_verified out reports an unverified email.
	var id clawHuntIdentity
	if err := json.Unmarshal([]byte(`{"iss":"https://clawhunt.store","aud":"awwo","sub":"s","email":"a@example.invalid","name":"A"}`), &id); err != nil || id.EmailVerified {
		t.Fatal("an absent email_verified must read as unverified", id.EmailVerified, err)
	}
}

// signInFrom completes a ClawHunt sign-in for f's identity whose callback reaches the API from ip through a trusted
// proxy (as nginx forwards it), and reports the sign-in page's outcome and whether a session was set.
func signInFrom(t *testing.T, h *harness, f *identityFixture, ip string) (outcome *url.URL, signedIn bool) {
	t.Helper()
	cookie, state := startIdentity(t, h, f, "")
	req, err := http.NewRequest("GET", h.server.URL+"/api/v1/auth/clawhunt/callback?code=test-code&state="+url.QueryEscape(state), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	if ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return signInOutcome(t, resp)
}

func signInOutcome(t *testing.T, resp *http.Response) (*url.URL, bool) {
	t.Helper()
	if resp.StatusCode != 303 {
		t.Fatal("callback status", resp.StatusCode)
	}
	location, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range resp.Cookies() {
		if c.Name == "awwo_session" && c.Value != "" {
			return location, true
		}
	}
	return location, false
}

func refusedFor(t *testing.T, location *url.URL, signedIn bool, reason string) {
	t.Helper()
	if signedIn || location.Query().Get("sso") != "error" || location.Query().Get("reason") != reason {
		t.Fatalf("want a refusal with %s, got %s (signed in %v)", reason, location, signedIn)
	}
}

func accountsFor(t *testing.T, h *harness, email, subject string) (users, identities int) {
	t.Helper()
	if e := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM users WHERE email=$1),(SELECT count(*) FROM external_identities WHERE subject=$2)", email, subject).Scan(&users, &identities); e != nil {
		t.Fatal(e)
	}
	return users, identities
}

func TestPostgresClawHuntNewAccountsPerAddressPerDay(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	// A password account that a later ClawHunt identity shares an email with: linking it creates no account.
	h.register(t, "legacy-signup@example.invalid")
	f := newIdentityFixture(t, h, "first@example.invalid", "first")
	h.a.cfg.TrustedProxyCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	clock := time.Now().UTC()
	h.a.signupClock = func() time.Time { return clock }
	as := func(subject string) { f.id.Subject, f.id.Email = subject, subject+"@example.invalid" }
	ctx := context.Background()
	counts := func() int {
		var n int
		if e := h.db.QueryRow(ctx, "SELECT count(*) FROM signup_ip_days").Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}

	// Unset: no limit, and nothing is counted.
	for i := 0; i < 3; i++ {
		as(fmt.Sprintf("unlimited-%d", i))
		if location, in := signInFrom(t, h, f, "198.51.100.7"); !in {
			t.Fatal("refused without a limit", location)
		}
	}
	if counts() != 0 {
		t.Fatal("counted without a limit")
	}

	h.a.cfg.NewAccountsPerIPPerDay = 2
	for i := 0; i < 2; i++ {
		as(fmt.Sprintf("limited-%d", i))
		if location, in := signInFrom(t, h, f, "198.51.100.7"); !in {
			t.Fatal("refused under the limit", i, location)
		}
	}
	as("limited-2")
	location, in := signInFrom(t, h, f, "198.51.100.7")
	refusedFor(t, location, in, "signup_limited")
	if users, identities := accountsFor(t, h, "limited-2@example.invalid", "limited-2"); users != 0 || identities != 0 {
		t.Fatal("a refused sign-in created an account", users, identities)
	}
	// Existing accounts always sign in from the full address, those created before the limit included.
	for _, subject := range []string{"limited-0", "unlimited-1"} {
		as(subject)
		if location, in := signInFrom(t, h, f, "198.51.100.7"); !in {
			t.Fatal("an existing account was refused", subject, location)
		}
	}
	// An existing password account is linked by its password, not created: the full address does not hold it.
	f.id.Subject, f.id.Email = "legacy-subject", "legacy-signup@example.invalid"
	if location, in := signInFrom(t, h, f, "198.51.100.7"); in || location.Query().Get("sso") != "link" {
		t.Fatal("a link to an existing account was refused", location)
	}
	// Another address has its own count; an IPv6 address counts by its /64.
	as("limited-2")
	if location, in := signInFrom(t, h, f, "203.0.113.9"); !in {
		t.Fatal("another address was held", location)
	}
	for i, ip := range []string{"2001:db8:1:2::10", "2001:db8:1:2:ffff::1"} {
		as(fmt.Sprintf("six-%d", i))
		if location, in := signInFrom(t, h, f, ip); !in {
			t.Fatal("refused under the limit", ip, location)
		}
	}
	as("six-2")
	location, in = signInFrom(t, h, f, "2001:db8:1:2::abcd")
	refusedFor(t, location, in, "signup_limited")
	if location, in := signInFrom(t, h, f, "2001:db8:1:3::1"); !in {
		t.Fatal("another /64 was held", location)
	}

	// The count is kept under a keyed hash of the day and the address; no address is stored.
	day := clock.Format(time.DateOnly)
	want := map[string]int{h.a.signupIPHash(day, "198.51.100.7"): 2, h.a.signupIPHash(day, "203.0.113.9"): 1, h.a.signupIPHash(day, "2001:db8:1:2::1"): 2, h.a.signupIPHash(day, "2001:db8:1:3::"): 1}
	rows, err := h.db.Query(ctx, "SELECT day::text,ip_hash,accounts FROM signup_ip_days")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for rows.Next() {
		var d, hash string
		var n int
		if err = rows.Scan(&d, &hash, &n); err != nil || d != day {
			t.Fatal("count row", d, err)
		}
		for _, ip := range []string{"198.51.100.7", "203.0.113.9", "2001:db8", tokenHash("198.51.100.7")} {
			if strings.Contains(hash, ip) {
				t.Fatal("the count stores an address or its plain digest", hash)
			}
		}
		got[hash] = n
	}
	rows.Close()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatal("counts", got, want)
	}

	// The next UTC day starts a new count under a new key.
	clock = clock.Add(24 * time.Hour)
	as("tomorrow-0")
	if location, in := signInFrom(t, h, f, "198.51.100.7"); !in {
		t.Fatal("yesterday's count held today", location)
	}
	var tomorrow int
	if e := h.db.QueryRow(ctx, "SELECT accounts FROM signup_ip_days WHERE day=$1::date AND ip_hash=$2", clock.Format(time.DateOnly), h.a.signupIPHash(clock.Format(time.DateOnly), "198.51.100.7")).Scan(&tomorrow); e != nil || tomorrow != 1 {
		t.Fatal("the new day's count", tomorrow, e)
	}

	// A sign-in start deletes the counts of days more than three days back.
	execSQL(t, h, `INSERT INTO signup_ip_days(day,ip_hash,accounts) VALUES((now() AT TIME ZONE 'UTC')::date-4,repeat('a',64),5),((now() AT TIME ZONE 'UTC')::date-3,repeat('b',64),5)`)
	startIdentity(t, h, f, "")
	var old, kept int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FILTER (WHERE ip_hash=repeat('a',64)),count(*) FILTER (WHERE ip_hash=repeat('b',64)) FROM signup_ip_days").Scan(&old, &kept); e != nil || old != 0 || kept != 1 {
		t.Fatal("pruning", old, kept, e)
	}
}

func TestPostgresClawHuntRequireVerifiedEmail(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.register(t, "legacy-unverified@example.invalid")
	f := newIdentityFixture(t, h, "existing@example.invalid", "existing")
	if f.id.EmailVerified {
		t.Fatal("the fixture must start unverified")
	}
	// Off, the default: an unverified email creates an account, as before.
	if location, in := signInOutcome(t, completeIdentity(t, h, f, "")); !in {
		t.Fatal("refused with the requirement off", location)
	}
	h.a.cfg.RequireVerifiedEmail = true
	h.a.cfg.NewAccountsPerIPPerDay = 1
	// A first sign-in with an unverified email creates nothing, keeps its invitation, and spends no address count.
	invite := strings.Repeat("v", 66)
	f.id.Subject, f.id.Email = "newcomer", "newcomer@example.invalid"
	location, in := signInOutcome(t, completeIdentity(t, h, f, invite))
	refusedFor(t, location, in, "email_unverified")
	if location.Query().Get("invite") != invite {
		t.Fatal("the invitation was lost", location)
	}
	if users, identities := accountsFor(t, h, "newcomer@example.invalid", "newcomer"); users != 0 || identities != 0 {
		t.Fatal("an unverified email created an account", users, identities)
	}
	var counted int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM signup_ip_days").Scan(&counted); e != nil || counted != 0 {
		t.Fatal("a refused unverified sign-in spent the address's count", counted, e)
	}
	// The existing account still signs in unverified.
	f.id.Subject, f.id.Email = "existing", "existing@example.invalid"
	if location, in := signInOutcome(t, completeIdentity(t, h, f, "")); !in {
		t.Fatal("an existing account was refused", location)
	}
	// An existing password account is linked by its password, not created.
	f.id.Subject, f.id.Email = "legacy", "legacy-unverified@example.invalid"
	if location, in := signInOutcome(t, completeIdentity(t, h, f, "")); in || location.Query().Get("sso") != "link" {
		t.Fatal("a link to an existing account was refused", location)
	}
	// Verified, the same identity creates its account, which spends the address's one account of the day.
	f.id.EmailVerified = true
	f.id.Subject, f.id.Email = "newcomer", "newcomer@example.invalid"
	if location, in := signInOutcome(t, completeIdentity(t, h, f, "")); !in {
		t.Fatal("a verified email was refused", location)
	}
	if users, identities := accountsFor(t, h, "newcomer@example.invalid", "newcomer"); users != 1 || identities != 1 {
		t.Fatal("the verified sign-in's account", users, identities)
	}
	f.id.Subject, f.id.Email = "second", "second@example.invalid"
	location, in = signInOutcome(t, completeIdentity(t, h, f, ""))
	refusedFor(t, location, in, "signup_limited")
}
