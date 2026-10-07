package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"testing"
	"time"
)

func TestRouteSettingGrammar(t *testing.T) {
	got, err := parseRouteSetting("X", "gate=3, bedrock=1,media=0", maxRouteLimit)
	if err != nil || !reflect.DeepEqual(got, routeLimits{routeGate: 3, routeBedrock: 1, routeMedia: 0}) {
		t.Fatal("valid setting", got, err)
	}
	for _, bad := range []string{"gate", "gate=", "gate=-1", "gate=1.5", "gate=100001", "chat=1", "gate=1,gate=2", "gate=1,", "=1"} {
		if _, err := parseRouteSetting("X", bad, maxRouteLimit); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	if _, err := parseRouteSetting("X", "gate=1000000", maxRouteTotal); err != nil {
		t.Fatal("ceiling range", err)
	}
}

func TestRouteLimitsAdminGrammar(t *testing.T) {
	if l, set, err := normalizeRouteLimits(nil); l != nil || set || err != nil {
		t.Fatal("absent must leave the column alone", l, set, err)
	}
	if l, set, err := normalizeRouteLimits(json.RawMessage(" null ")); l != nil || !set || err != nil {
		t.Fatal("null must remove the limits", l, set, err)
	}
	l, set, err := normalizeRouteLimits(json.RawMessage(`{"gate":3,"bedrock":0}`))
	if !set || err != nil || !reflect.DeepEqual(l, routeLimits{routeGate: 3, routeBedrock: 0}) || l.column() != `{"bedrock":0,"gate":3}` {
		t.Fatal("object", l, set, err)
	}
	// An empty object keeps the workspace route-limited, and so on plans, with no route limited.
	if l, set, err := normalizeRouteLimits(json.RawMessage(` {} `)); !set || err != nil || l == nil || len(l) != 0 || l.column() != `{}` {
		t.Fatal("empty object", l, set, err)
	}
	for _, bad := range []string{`[]`, `"gate=3"`, `{"chat":1}`, `{"gate":-1}`, `{"gate":1.5}`, `{"gate":"3"}`, `{"gate":100001}`, `{"gate":1,"gate":2}`, `{`} {
		if _, _, err := normalizeRouteLimits(json.RawMessage(bad)); err == nil {
			t.Fatal("accepted", bad)
		}
	}
}

// A stored value this build cannot read closes every route instead of lifting the limits.
func TestStoredRouteLimitsFailClosed(t *testing.T) {
	if readRouteLimits(nil) != nil {
		t.Fatal("NULL must stay unlimited")
	}
	if got := readRouteLimits([]byte(`{"gate":2,"future":9}`)); !reflect.DeepEqual(got, routeLimits{routeGate: 2}) {
		t.Fatal("known routes", got)
	}
	if got := readRouteLimits([]byte(`{"gate":"x"}`)); !reflect.DeepEqual(got, routeLimits{routeGate: 0, routeBedrock: 0, routeMedia: 0}) {
		t.Fatal("unreadable value", got)
	}
	// Only routes this build does not know (a typo, a newer build's route) would read as the empty object,
	// unlimited and outside the ceilings: closed instead.
	if got := readRouteLimits([]byte(`{"gaet":3}`)); !reflect.DeepEqual(got, routeLimits{routeGate: 0, routeBedrock: 0, routeMedia: 0}) {
		t.Fatal("unknown routes only", got)
	}
	if got := readRouteLimits([]byte(`{}`)); got == nil || len(got) != 0 {
		t.Fatal("the empty object", got)
	}
	if got := readRouteLimits([]byte(`null`)); !reflect.DeepEqual(got, routeLimits{routeGate: 0, routeBedrock: 0, routeMedia: 0}) {
		t.Fatal("a JSON null", got)
	}
}

func TestModelRoutes(t *testing.T) {
	c := Config{RouteFreeModels: []string{"qwen3.8-27b", "qwen3.8-27b-p6"}}
	for model, want := range map[string]string{
		"qwen3.8-27b-p6": routeFree, "qwen3.8-27b": routeFree, "qwen3.8-max": routeGate,
		"claude-sonnet-5": routeGate, "gpt-5.5": routeGate, "bedrock.claude-opus-5-5": routeBedrock,
		"rh.seedance-2": routeMedia, "": routeGate,
	} {
		if got := c.modelRoute(model); got != want {
			t.Fatalf("%s routed to %s, want %s", model, got, want)
		}
	}
}

func TestRouteSettingsFromEnv(t *testing.T) {
	t.Setenv("AWWO_NEW_WORKSPACE_ROUTE_LIMITS", "gate=3,bedrock=1,media=1")
	t.Setenv("AWWO_ROUTE_TOTAL_PER_DAY", "gate=300,bedrock=30,media=50")
	t.Setenv("AWWO_ROUTE_FREE_MODELS", "qwen3.8-27b-p6,qwen3.8-27b,qwen3.8-27b-p6")
	var c Config
	if err := c.routeSettingsFromEnv(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.NewWorkspaceRouteLimits, routeLimits{routeGate: 3, routeBedrock: 1, routeMedia: 1}) ||
		!reflect.DeepEqual(c.RouteTotalsPerDay, routeLimits{routeGate: 300, routeBedrock: 30, routeMedia: 50}) ||
		!reflect.DeepEqual(c.RouteFreeModels, []string{"qwen3.8-27b", "qwen3.8-27b-p6"}) {
		t.Fatal("settings", c.NewWorkspaceRouteLimits, c.RouteTotalsPerDay, c.RouteFreeModels)
	}
	if err := c.validateRouteSettings(); err != nil {
		t.Fatal(err)
	}
	// A gate limit without a free list would put the default model on the premium allowance.
	if err := (Config{NewWorkspaceRouteLimits: routeLimits{routeGate: 3}}).validateRouteSettings(); err == nil {
		t.Fatal("gate limit without free models accepted")
	}
	if err := (Config{RouteTotalsPerDay: routeLimits{routeGate: 300}}).validateRouteSettings(); err == nil {
		t.Fatal("gate ceiling without free models accepted")
	}
	if err := (Config{NewWorkspaceRouteLimits: routeLimits{routeMedia: 1}}).validateRouteSettings(); err != nil {
		t.Fatal("a media-only limit needs no free list", err)
	}
	if err := (Config{UserCredentials: true, RouteTotalsPerDay: routeLimits{routeGate: 3}}).validateRouteSettings(); err == nil {
		t.Fatal("route limits accepted in personal-key mode")
	}
	t.Setenv("AWWO_NEW_WORKSPACE_ROUTE_LIMITS", "gate=x")
	if err := c.routeSettingsFromEnv(); err == nil {
		t.Fatal("malformed setting accepted")
	}
}

// routeHarnessRun gives the workspace one running run, so model calls can be admitted directly
// against it, and lifts the concurrency limit so every admitted call can stay running.
func routeHarnessRun(t *testing.T, h *harness, c *http.Cookie, tid, routes string) string {
	t.Helper()
	_, _, sid := h.fixture(t, c, tid)
	rid := randomID()
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_concurrent_runs=100,max_runs_per_day=1000,route_limits=$2::jsonb WHERE id=$1", tid, nullIfEmpty(routes)); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(context.Background(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p','running')", rid, tid, sid, "route-"+rid); e != nil {
		t.Fatal(e)
	}
	return rid
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func reserveModel(h *harness, tid, rid, model string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return h.a.reserveInvocation(ctx, tid, rid, randomID(), model, &invocationFacts{Runtime: runtimePI, Model: model, Admission: "not_attempted"})
}

func TestPostgresRouteLimitsAdmitPremiumModelsSparingly(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	h.a.cfg.RouteTotalsPerDay = routeLimits{routeGate: 4, routeBedrock: 1}
	ca, ta, _ := h.register(t, "route-a@example.test")
	cb, tb, _ := h.register(t, "route-b@example.test")
	cc, tc, _ := h.register(t, "route-c@example.test")
	ra := routeHarnessRun(t, h, ca, ta, `{"gate":3,"bedrock":1,"media":1}`)
	rb := routeHarnessRun(t, h, cb, tb, `{"gate":3,"bedrock":1}`)
	rc := routeHarnessRun(t, h, cc, tc, "")

	// The free default model only spends the daily allowance.
	for i := 0; i < 5; i++ {
		if e := reserveModel(h, ta, ra, "qwen3.8-27b-p6"); e != nil {
			t.Fatal("free model", i, e)
		}
	}
	for i := 0; i < 3; i++ {
		if e := reserveModel(h, ta, ra, "claude-sonnet-5"); e != nil {
			t.Fatal("gate allowance", i, e)
		}
	}
	if e := reserveModel(h, ta, ra, "gpt-5.5"); !errors.Is(e, errRouteQuota) {
		t.Fatal("fourth gate call admitted", e)
	}
	if e := reserveModel(h, ta, ra, "bedrock.claude-opus-5-5"); e != nil {
		t.Fatal("bedrock allowance", e)
	}
	if e := reserveModel(h, ta, ra, "bedrock.claude-fable-5-1"); !errors.Is(e, errRouteQuota) {
		t.Fatal("second bedrock call admitted", e)
	}
	// The deployment-wide ceiling counts every route-limited workspace but an empty object: three gate calls of A plus
	// one of B reach 4, although B has used one of its own three.
	if e := reserveModel(h, tb, rb, "claude-opus-4-8"); e != nil {
		t.Fatal("B's first gate call", e)
	}
	if e := reserveModel(h, tb, rb, "claude-opus-4-8"); !errors.Is(e, errRouteCapacity) {
		t.Fatal("gate ceiling ignored", e)
	}
	if e := reserveModel(h, tb, rb, "bedrock.claude-opus-5-5"); !errors.Is(e, errRouteCapacity) {
		t.Fatal("bedrock ceiling ignored", e)
	}
	// A workspace without route limits is neither limited nor counted.
	for i := 0; i < 6; i++ {
		if e := reserveModel(h, tc, rc, "claude-fable-5"); e != nil {
			t.Fatal("unrestricted workspace limited", i, e)
		}
	}
	if e := reserveModel(h, tb, rb, "qwen3.8-27b-p6"); e != nil {
		t.Fatal("free model refused at a premium ceiling", e)
	}
	// Refusals are not admissions: nothing was written for them.
	var n int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", ta).Scan(&n); e != nil || n != 9 {
		t.Fatal("admitted calls of A", n, e)
	}
	// The daily allowance still bounds the free model.
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_runs_per_day=9 WHERE id=$1", ta); e != nil {
		t.Fatal(e)
	}
	if e := reserveModel(h, ta, ra, "qwen3.8-27b-p6"); !errors.Is(e, errInvocationQuota) {
		t.Fatal("daily allowance ignored", e)
	}
}

// A workspace that limits no route (an empty object: on plans, nothing limited) is outside the ceilings,
// neither held by them nor counted. Any other route-limited workspace is held by every route's ceiling and
// counted towards it, a route its object leaves out included.
func TestPostgresRouteCeilingsLeaveOutOnlyWorkspacesThatLimitNoRoute(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	h.a.cfg.RouteTotalsPerDay = routeLimits{routeGate: 2, routeBedrock: 1}
	ca, ta, _ := h.register(t, "ceiling-a@example.test")
	cb, tb, _ := h.register(t, "ceiling-b@example.test")
	cc, tc, _ := h.register(t, "ceiling-c@example.test")
	ra := routeHarnessRun(t, h, ca, ta, `{"gate":5,"bedrock":5}`)
	rb := routeHarnessRun(t, h, cb, tb, `{}`)
	rc := routeHarnessRun(t, h, cc, tc, `{"gate":5}`)
	for i := 0; i < 4; i++ {
		if e := reserveModel(h, tb, rb, "claude-opus-4-8"); e != nil {
			t.Fatal("a workspace that limits no route held by the gate ceiling", i, e)
		}
		if e := reserveModel(h, tb, rb, "bedrock.claude-opus-5-5"); e != nil {
			t.Fatal("a workspace that limits no route held by the bedrock ceiling", i, e)
		}
	}
	// None of B's calls counted: A's bedrock allowance finds the whole bedrock ceiling, and fills it.
	if e := reserveModel(h, ta, ra, "bedrock.claude-fable-5-1"); e != nil {
		t.Fatal("the bedrock ceiling was spent by a workspace that limits no route", e)
	}
	if e := reserveModel(h, ta, ra, "bedrock.claude-fable-5-1"); !errors.Is(e, errRouteCapacity) {
		t.Fatal("bedrock ceiling ignored", e)
	}
	// C leaves bedrock out of its object, so it has no bedrock allowance of its own, but the ceiling still holds it.
	if e := reserveModel(h, tc, rc, "bedrock.claude-opus-5-5"); !errors.Is(e, errRouteCapacity) {
		t.Fatal("a route the object leaves out escaped its ceiling", e)
	}
	// The gate ceiling counts A and C: one call of each fills it, and it holds both of them, but not B.
	if e := reserveModel(h, tc, rc, "gpt-5.5"); e != nil {
		t.Fatal("C's first gate call", e)
	}
	if e := reserveModel(h, ta, ra, "gpt-5.5"); e != nil {
		t.Fatal("A's first gate call", e)
	}
	if e := reserveModel(h, ta, ra, "gpt-5.5"); !errors.Is(e, errRouteCapacity) {
		t.Fatal("gate ceiling ignored for A", e)
	}
	if e := reserveModel(h, tc, rc, "gpt-5.5"); !errors.Is(e, errRouteCapacity) {
		t.Fatal("gate ceiling ignored for C", e)
	}
	if e := reserveModel(h, tb, rb, "gpt-5.5"); e != nil {
		t.Fatal("a workspace that limits no route held by a full gate ceiling", e)
	}
	// Without a plan such a workspace shows no meter, like one without route limits; C shows the route it limits.
	if u := h.request(t, cb, "GET", "/tenants/"+tb+"/route-usage", nil, 200); u["limited"] != false || u["routes"] != nil {
		t.Fatal("meter of a workspace that limits no route", u)
	}
	if u := h.request(t, cc, "GET", "/tenants/"+tc+"/route-usage", nil, 200); u["limited"] != true || len(u["routes"].(map[string]any)) != 1 {
		t.Fatal("meter of a workspace that limits gate", u)
	}
}

func TestPostgresRouteLimitsReachNewWorkspacesAndAdminEdits(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.NewWorkspaceRouteLimits = routeLimits{routeGate: 3, routeBedrock: 1, routeMedia: 1}
	_, tid, _ := h.register(t, "route-new@example.test")
	stored := func() map[string]any {
		var raw []byte
		if e := h.db.QueryRow(context.Background(), "SELECT route_limits FROM tenants WHERE id=$1", tid).Scan(&raw); e != nil {
			t.Fatal(e)
		}
		if raw == nil {
			return nil
		}
		var v map[string]any
		json.Unmarshal(raw, &v)
		return v
	}
	if got := stored(); !reflect.DeepEqual(got, map[string]any{"gate": 3.0, "bedrock": 1.0, "media": 1.0}) {
		t.Fatal("new workspace limits", got)
	}
	h.a.cfg.AdminEmail, h.a.cfg.AdminPassword = "admin@example.test", "Strong password 123!"
	admin0 := func() *http.Cookie {
		if e := h.a.BootstrapAdmin(context.Background()); e != nil {
			t.Fatal(e)
		}
		return h.login(t, "admin@example.test")
	}()
	// Without a free list a gate limit would count the default model itself, so the edit is refused.
	h.request(t, admin0, "PATCH", "/admin/tenants/"+tid, map[string]any{"routeLimits": map[string]int{"gate": 10}}, 400)
	// An empty object limits no route, so it needs no free list: the workspace stays on plans, unlimited.
	if v := h.request(t, admin0, "PATCH", "/admin/tenants/"+tid, map[string]any{"routeLimits": map[string]int{}}, 200); !reflect.DeepEqual(v["routeLimits"], map[string]any{}) {
		t.Fatal("admin edit to no limited route", v["routeLimits"])
	}
	if got := stored(); got == nil || len(got) != 0 {
		t.Fatal("stored empty route limits", got)
	}
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	admin := h.login(t, "admin@example.test")
	v := h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"routeLimits": map[string]int{"gate": 10}}, 200)
	if got := stored(); !reflect.DeepEqual(got, map[string]any{"gate": 10.0}) || !reflect.DeepEqual(v["routeLimits"], map[string]any{"gate": 10.0}) {
		t.Fatal("admin edit", got, v["routeLimits"])
	}
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"maxRunsPerDay": 40}, 200)
	if got := stored(); !reflect.DeepEqual(got, map[string]any{"gate": 10.0}) {
		t.Fatal("an unrelated edit changed the route limits", got)
	}
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"routeLimits": map[string]int{"chat": 1}}, 400)
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"routeLimits": nil}, 200)
	if got := stored(); got != nil {
		t.Fatal("null did not remove the limits", got)
	}
}

func TestPostgresMediaRouteLimits(t *testing.T) {
	h, _ := newMediaHarness(t)
	h.a.cfg.MediaUnrestrictedWorkspaces = true
	ca, ta, _ := h.register(t, "media-route-a@example.test")
	cb, tb, _ := h.register(t, "media-route-b@example.test")
	cc, tc, _ := h.register(t, "media-route-c@example.test")
	cd, td, _ := h.register(t, "media-route-d@example.test")
	ce, te, _ := h.register(t, "media-route-e@example.test")
	for tid, routes := range map[string]string{ta: `{"media":1}`, tb: `{"media":5}`, td: `{}`, te: `{"gate":3}`} {
		if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET route_limits=$2::jsonb WHERE id=$1", tid, routes); e != nil {
			t.Fatal(e)
		}
	}
	node := func(c *http.Cookie, tid string) string {
		_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
		return setupNodeAt(canvas, 0)["issueId"].(string)
	}
	a, b, free, unlimited, gateOnly := node(ca, ta), node(cb, tb), node(cc, tc), node(cd, td), node(ce, te)
	run := h.mediaRun(t, ca, ta, a, "a cat in a hat", 202)
	awaitRunRow(t, h, ta, run["id"].(string), "completed")
	if got := h.mediaRun(t, ca, ta, a, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("media route allowance ignored", got)
	}
	// The deployment-wide media route ceiling counts route-limited workspaces only: A's one
	// generation fills it for B, whose own allowance is five.
	h.a.cfg.RouteTotalsPerDay = routeLimits{routeMedia: 1}
	if got := h.mediaRun(t, cb, tb, b, "a cat in a hat", 429); errorCode(got) != "media_capacity_exceeded" {
		t.Fatal("media route ceiling ignored", got)
	}
	run = h.mediaRun(t, cc, tc, free, "a cat in a hat", 202)
	awaitRunRow(t, h, tc, run["id"].(string), "completed")
	if got := h.mediaRun(t, cb, tb, b, "a cat in a hat", 429); errorCode(got) != "media_capacity_exceeded" {
		t.Fatal("an unrestricted workspace's generation changed the route ceiling", got)
	}
	// A workspace that limits no route is neither held by the full ceiling nor counted; one whose object leaves
	// media out is still held.
	run = h.mediaRun(t, cd, td, unlimited, "a cat in a hat", 202)
	awaitRunRow(t, h, td, run["id"].(string), "completed")
	if got := h.mediaRun(t, cb, tb, b, "a cat in a hat", 429); errorCode(got) != "media_capacity_exceeded" {
		t.Fatal("a workspace that limits no route changed the route ceiling", got)
	}
	if got := h.mediaRun(t, ce, te, gateOnly, "a cat in a hat", 429); errorCode(got) != "media_capacity_exceeded" {
		t.Fatal("a workspace that leaves media out of its object escaped the media ceiling", got)
	}
	h.a.cfg.RouteTotalsPerDay = routeLimits{routeMedia: 2}
	run = h.mediaRun(t, cb, tb, b, "a cat in a hat", 202)
	awaitRunRow(t, h, tb, run["id"].(string), "completed")
}

// A call that settled without reaching a provider gives its allowance back, and a text call whose id
// looks like media is still counted as a paid text call.
func TestPostgresRouteLimitsCountOnlyCallsThatCouldCost(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	c, tid, _ := h.register(t, "route-cost@example.test")
	rid := routeHarnessRun(t, h, c, tid, `{"gate":1,"bedrock":1}`)
	if e := reserveModel(h, tid, rid, "bedrock.claude-opus-5-5"); e != nil {
		t.Fatal(e)
	}
	if e := reserveModel(h, tid, rid, "bedrock.claude-opus-5-5"); !errors.Is(e, errRouteQuota) {
		t.Fatal("second bedrock call admitted", e)
	}
	// The runtime turned the call away before any provider saw it.
	if _, e := h.db.Exec(context.Background(), "UPDATE model_invocations SET status='failed',cost_status='not_incurred' WHERE tenant_id=$1 AND model_id LIKE 'bedrock.%'", tid); e != nil {
		t.Fatal(e)
	}
	if e := reserveModel(h, tid, rid, "bedrock.claude-opus-5-5"); e != nil {
		t.Fatal("a call that cost nothing kept its allowance", e)
	}
	// Settled with a possible cost: it keeps counting.
	if _, e := h.db.Exec(context.Background(), "UPDATE model_invocations SET status='failed',cost_status='unknown' WHERE tenant_id=$1 AND model_id LIKE 'bedrock.%' AND status='running'", tid); e != nil {
		t.Fatal(e)
	}
	if e := reserveModel(h, tid, rid, "bedrock.claude-opus-5-5"); !errors.Is(e, errRouteQuota) {
		t.Fatal("a call of unknown cost gave its allowance back", e)
	}
	if e := reserveModel(h, tid, rid, "rh.text-shaped"); e != nil {
		t.Fatal(e)
	}
	if e := reserveModel(h, tid, rid, "claude-sonnet-5"); !errors.Is(e, errRouteQuota) {
		t.Fatal("an rh.* text call was not counted as gate", e)
	}
}
