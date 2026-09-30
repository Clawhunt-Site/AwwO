package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// pinWorkspaceEnv fixes every variable these tests depend on, so the host environment
// cannot change what ConfigFromEnv sees.
func pinWorkspaceEnv(t *testing.T, models, runs, owned string) {
	t.Helper()
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", testConfig().DatabaseURL)
	t.Setenv("AWWO_CREDENTIAL_MODE", "operator")
	t.Setenv("AWWO_NEW_WORKSPACE_ALLOWED_MODELS", models)
	t.Setenv("AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY", runs)
	t.Setenv("AWWO_MAX_OWNED_WORKSPACES", owned)
}

// Unset keeps today's behaviour, and the model list is normalized by the admin PATCH
// normalizer itself: ids outside one worker's profile grammar stay storable,
// duplicates collapse and the order is canonical.
func TestNewWorkspaceSettingsFromEnv(t *testing.T) {
	pinWorkspaceEnv(t, "", "", "")
	loaded, err := ConfigFromEnv()
	if err != nil || !loaded.NewWorkspaceModels.unrestricted() || loaded.NewWorkspaceModels.column() != nil || loaded.NewWorkspaceRunsPerDay != 0 || loaded.MaxOwnedWorkspaces != 0 {
		t.Fatal("unset settings must keep unrestricted models, the column quota and no cap", err)
	}
	long := strings.Repeat("m", 200)
	for _, tc := range []struct {
		models, runs, owned, wantModels string
		wantRuns, wantOwned             int
	}{
		{"qwen3.8-27b-p6", "50", "1", "[qwen3.8-27b-p6]", 50, 1},
		{"qwen3:8b,org/model,qwen3:8b", "1", "0", "[org/model qwen3:8b]", 1, 0},
		{long, "100000", "", "[" + long + "]", 100000, 0},
	} {
		pinWorkspaceEnv(t, tc.models, tc.runs, tc.owned)
		loaded, err = ConfigFromEnv()
		if err != nil || fmt.Sprint(loaded.NewWorkspaceModels.column()) != tc.wantModels || loaded.NewWorkspaceRunsPerDay != tc.wantRuns || loaded.MaxOwnedWorkspaces != tc.wantOwned {
			t.Fatal("valid settings", tc.models, tc.runs, tc.owned, loaded.NewWorkspaceModels.column(), loaded.NewWorkspaceRunsPerDay, loaded.MaxOwnedWorkspaces, err)
		}
	}
	admin, _, _ := normalizeAllowedModels(json.RawMessage(`["qwen3:8b","org/model","qwen3:8b"]`))
	if fmt.Sprint(admin.column()) != "[org/model qwen3:8b]" {
		t.Fatal("the admin PATCH stores the same input differently", admin.column())
	}
}

// Every malformed value stops startup and names its setting.
func TestNewWorkspaceSettingsRejectMalformedValues(t *testing.T) {
	many := make([]string, 65)
	for i := range many {
		many[i] = fmt.Sprintf("model-%d", i)
	}
	for name, values := range map[string][]string{
		"AWWO_NEW_WORKSPACE_ALLOWED_MODELS":   {"a b", " qwen", "qwen ", "a, b", "a,,b", ",", "a,", "a\tb", "a\nb", strings.Repeat("m", 201), strings.Join(many, ",")},
		"AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY": {"0", "-1", "100001", "fifty", "50.0", "5e1", " 50", "50 "},
		"AWWO_MAX_OWNED_WORKSPACES":           {"-1", "one", "1.5", " 1", "1 "},
	} {
		for _, value := range values {
			pinWorkspaceEnv(t, "", "", "")
			t.Setenv(name, value)
			if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), name) {
				t.Fatalf("%s=%q was accepted or not named: %v", name, value, err)
			}
		}
	}
	// Windows environment strings are always valid UTF-16, so raw bytes cannot be
	// placed through t.Setenv on every platform; the parser is checked directly.
	if models, err := newWorkspaceModels("qwen\xff"); err == nil || models.unrestricted() || models.permits("qwen\xff") {
		t.Fatal("invalid UTF-8 must be refused, not replaced", models.column(), err)
	}
	// A configuration built in code is held to the same ranges.
	for _, change := range []func(*Config){
		func(c *Config) { c.NewWorkspaceRunsPerDay = 100001 },
		func(c *Config) { c.NewWorkspaceRunsPerDay = -1 },
		func(c *Config) { c.MaxOwnedWorkspaces = -1 },
	} {
		c := testConfig()
		change(&c)
		if c.Validate() == nil {
			t.Fatal("an out-of-range configuration validated", c.NewWorkspaceRunsPerDay, c.MaxOwnedWorkspaces)
		}
	}
}

// Personal catalogues name models by connection, so a default list could never match
// a new user's models; the quota and the cap do not depend on who pays for a run.
func TestNewWorkspaceModelListRequiresOperatorCredentials(t *testing.T) {
	pinWorkspaceEnv(t, "qwen3.8-27b-p6", "50", "1")
	t.Setenv("AWWO_CREDENTIAL_MODE", "user")
	t.Setenv("AWWO_CREDENTIAL_ENCRYPTION_KEY", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=")
	if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AWWO_NEW_WORKSPACE_ALLOWED_MODELS") {
		t.Fatal("a default model list was accepted with personal credentials", err)
	}
	t.Setenv("AWWO_NEW_WORKSPACE_ALLOWED_MODELS", "")
	if loaded, err := ConfigFromEnv(); err != nil || !loaded.UserCredentials || loaded.NewWorkspaceRunsPerDay != 50 || loaded.MaxOwnedWorkspaces != 1 {
		t.Fatal("the quota and the cap must load in personal mode", err)
	}
}

// loadWorkspaceSettings reads the three settings the way startup does and hands them
// to the running app. Nothing at startup reads or rewrites tenants rows, so this
// stands in for a restart with a new environment.
func loadWorkspaceSettings(t *testing.T, h *harness, models, runs, owned string) {
	t.Helper()
	pinWorkspaceEnv(t, models, runs, owned)
	loaded, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	h.a.cfg.NewWorkspaceModels, h.a.cfg.NewWorkspaceRunsPerDay, h.a.cfg.MaxOwnedWorkspaces = loaded.NewWorkspaceModels, loaded.NewWorkspaceRunsPerDay, loaded.MaxOwnedWorkspaces
}

// workspaceRow renders what a tenants row stores for the two defaults; NULL is the
// unrestricted allowlist.
func workspaceRow(t *testing.T, h *harness, tid string) string {
	t.Helper()
	var restricted bool
	var models []string
	var daily int
	if err := h.db.QueryRow(context.Background(), "SELECT allowed_models IS NOT NULL,COALESCE(allowed_models,'{}'),max_runs_per_day FROM tenants WHERE id=$1", tid).Scan(&restricted, &models, &daily); err != nil {
		t.Fatal(err)
	}
	if !restricted {
		return fmt.Sprintf("NULL %d", daily)
	}
	return fmt.Sprintf("%v %d", models, daily)
}

func ownedWorkspaces(t *testing.T, h *harness, uid string) int {
	t.Helper()
	var n int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM memberships WHERE user_id=$1 AND role='owner'", uid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPostgresNewWorkspaceDefaultsReachEveryCreationPath(t *testing.T) {
	for _, tc := range []struct {
		name, models, runs, want string
		daily                    float64
	}{
		{name: "unset keeps the column defaults", want: "NULL 100", daily: 100},
		{name: "model list only", models: "qwen3.8-27b-p6", want: "[qwen3.8-27b-p6] 100", daily: 100},
		{name: "quota only", runs: "50", want: "NULL 50", daily: 50},
		{name: "both", models: "qwen3.8-27b-p6", runs: "50", want: "[qwen3.8-27b-p6] 50", daily: 50},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, "http://127.0.0.1:1")
			_, existing, _ := h.register(t, "existing@example.test")
			loadWorkspaceSettings(t, h, tc.models, tc.runs, "")
			c, registered, _ := h.register(t, "standalone@example.test")
			created := h.request(t, c, "POST", "/tenants", map[string]string{"name": "Second"}, 201)
			if created["maxRunsPerDay"] != tc.daily || created["role"] != "owner" {
				t.Fatal("the created workspace does not report its stored quota", created)
			}
			// Local sessions end when ClawHunt identity is enabled, so this path runs last.
			f := newIdentityFixture(t, h, "first-sign-in@example.invalid", "first-sign-in")
			me := h.request(t, responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session"), "GET", "/auth/me", nil, 200)
			if len(me["tenants"].([]any)) != 1 {
				t.Fatal("first sign-in must create exactly one workspace", me["tenants"])
			}
			first := me["tenants"].([]any)[0].(map[string]any)["id"].(string)
			for path, tid := range map[string]string{"standalone registration": registered, "POST /tenants": created["id"].(string), "first ClawHunt sign-in": first} {
				if got := workspaceRow(t, h, tid); got != tc.want {
					t.Fatalf("%s stored %s, want %s", path, got, tc.want)
				}
			}
			if got := workspaceRow(t, h, existing); got != "NULL 100" {
				t.Fatal("a workspace created before the settings was rewritten", got)
			}
		})
	}
}

func TestPostgresOwnedWorkspaceCapRefusesOnlyExtraWorkspaces(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	// Unset is unlimited, and a cap applied later leaves what an account already owns.
	veteran, _, veteranID := h.register(t, "veteran@example.test")
	h.request(t, veteran, "POST", "/tenants", map[string]string{"name": "Before the cap"}, 201)
	loadWorkspaceSettings(t, h, "qwen3.8-27b-p6", "50", "1")
	// Registration's automatic workspace is the person's one workspace.
	c, tid, uid := h.register(t, "capped@example.test")
	if ownedWorkspaces(t, h, uid) != 1 || workspaceRow(t, h, tid) != "[qwen3.8-27b-p6] 50" {
		t.Fatal("registration under the cap must still create its workspace with the defaults")
	}
	var tenantsBefore int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM tenants").Scan(&tenantsBefore); err != nil {
		t.Fatal(err)
	}
	refused := h.request(t, c, "POST", "/tenants", map[string]string{"name": "Second"}, 403)
	requireCode(t, refused, "workspace_limit")
	if message, _ := refused["error"].(map[string]any)["message"].(string); message == "" {
		t.Fatal("the refusal must explain itself", refused)
	}
	requireCode(t, h.request(t, veteran, "POST", "/tenants", map[string]string{"name": "Third"}, 403), "workspace_limit")
	var tenantsAfter, audited int
	if err := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM tenants),(SELECT count(*) FROM audit_events WHERE actor_id=$1 AND action='tenant.created')", uid).Scan(&tenantsAfter, &audited); err != nil {
		t.Fatal(err)
	}
	if tenantsAfter != tenantsBefore || audited != 1 || ownedWorkspaces(t, h, uid) != 1 || ownedWorkspaces(t, h, veteranID) != 2 {
		t.Fatal("a refused request must write nothing and existing ownership must stay", tenantsBefore, tenantsAfter, audited)
	}
	// Platform administrators are exempt from the cap.
	admin := bootstrapTestAdmin(t, h)
	for _, name := range []string{"Operations", "Support"} {
		h.request(t, admin, "POST", "/tenants", map[string]string{"name": name}, 201)
	}
	// So is the automatic workspace of a first ClawHunt sign-in; the next one is not.
	f := newIdentityFixture(t, h, "sso-capped@example.invalid", "sso-capped")
	session := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	me := h.request(t, session, "GET", "/auth/me", nil, 200)
	if len(me["tenants"].([]any)) != 1 {
		t.Fatal("the cap refused the first ClawHunt workspace", me["tenants"])
	}
	requireCode(t, h.request(t, session, "POST", "/tenants", map[string]string{"name": "Second"}, 403), "workspace_limit")
}

// createWorkspaceOutcome is safe to call from a goroutine: it reports "status code"
// instead of failing the test.
func createWorkspaceOutcome(h *harness, cookie *http.Cookie, name string) string {
	body, _ := json.Marshal(map[string]string{"name": name})
	r, err := http.NewRequest("POST", h.server.URL+"/api/v1/tenants", bytes.NewReader(body))
	if err != nil {
		return err.Error()
	}
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		return err.Error()
	}
	defer resp.Body.Close()
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return fmt.Sprintf("%d %s", resp.StatusCode, out.Error.Code)
}

// Backends blocked by the gate itself (an INSERT held at the table lock) or by a
// backend that is (a request queued behind the account lock). No other test's
// backend can be either.
const gatedBackends = `SELECT count(*) FROM pg_stat_activity a WHERE $1::int = ANY(pg_blocking_pids(a.pid)) OR EXISTS (
 SELECT 1 FROM pg_stat_activity b WHERE $1::int = ANY(pg_blocking_pids(b.pid)) AND b.pid = ANY(pg_blocking_pids(a.pid)))`

// gateTenantInserts holds a SHARE lock on tenants, which stops every INSERT, and
// returns a wait that blocks until n backends queue behind it. The gate and the probe
// have their own connections because the requests and the app's lease can fill the
// harness pool, which may hold only four. Closing the gate's connection at cleanup
// releases the lock even when the test fails first.
func gateTenantInserts(ctx context.Context, t *testing.T, h *harness) (pgx.Tx, func(n int)) {
	t.Helper()
	gate, err := pgx.ConnectConfig(ctx, h.db.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { gate.Close(context.Background()) })
	probe, err := pgx.ConnectConfig(ctx, h.db.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { probe.Close(context.Background()) })
	held, err := gate.Begin(ctx)
	if err == nil {
		_, err = held.Exec(ctx, "LOCK TABLE tenants IN SHARE MODE")
	}
	if err != nil {
		t.Fatal(err)
	}
	return held, func(n int) {
		for waiting := 0; waiting < n; {
			time.Sleep(10 * time.Millisecond)
			if err := probe.QueryRow(ctx, gatedBackends, int32(gate.PgConn().PID())).Scan(&waiting); err != nil {
				t.Fatal("not every request reached a lock wait", waiting, err)
			}
		}
	}
}

// The count and the insert are serialized per account: concurrent requests from one
// account cannot each see room for one more. Membership in another workspace, even as
// its admin, is not ownership.
func TestPostgresOwnedWorkspaceCapIsRaceSafeAndCountsOwnershipOnly(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	loadWorkspaceSettings(t, h, "", "", "2")
	c, _, uid := h.register(t, "racer@example.test")
	host, hostTenant, _ := h.register(t, "host@example.test")
	h.request(t, host, "POST", "/tenants/"+hostTenant+"/members", map[string]string{"email": "racer@example.test", "role": "admin"}, 201)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// Every request is held at its INSERT after its count, so the requests overlap
	// between counting and inserting unless the per-account lock serializes them;
	// without it each would count one owned workspace and all would be admitted.
	held, await := gateTenantInserts(ctx, t, h)
	const attempts = 3
	results := make(chan string, attempts)
	for i := 0; i < attempts; i++ {
		go func(i int) { results <- createWorkspaceOutcome(h, c, fmt.Sprintf("Concurrent %d", i)) }(i)
	}
	await(attempts)
	if err := held.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	outcomes := map[string]int{}
	for i := 0; i < attempts; i++ {
		outcomes[<-results]++
	}
	if outcomes["201 "] != 1 || outcomes["403 workspace_limit"] != attempts-1 {
		t.Fatal("concurrent creation must admit exactly one workspace", outcomes)
	}
	if n := ownedWorkspaces(t, h, uid); n != 2 {
		t.Fatal("owned workspaces exceed the cap", n)
	}
}
