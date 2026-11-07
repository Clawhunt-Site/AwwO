package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// setHostedSiteEnv is the environment of a hosted site on operator credentials with ClawHunt sign-in, as far as the free
// plan's end needs one.
func setHostedSiteEnv(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", testConfig().DatabaseURL)
	t.Setenv("AWWO_CREDENTIAL_MODE", "operator")
	t.Setenv("AWWO_CREDENTIAL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("AWWO_CLAWHUNT_URL", "http://127.0.0.1:9")
	t.Setenv("AWWO_CLAWHUNT_CLIENT_ID", "awwo-test")
	t.Setenv("AWWO_CLAWHUNT_CLIENT_SECRET", strings.Repeat("c", 32))
}

func TestFreePlanSettingFromEnv(t *testing.T) {
	setHostedSiteEnv(t)
	if c, err := ConfigFromEnv(); err != nil || !c.FreePlanUntil.IsZero() {
		t.Fatal("unset, the free plan never ends", c.FreePlanUntil, err)
	}
	// The end of 11-12 in Beijing is 16:00 UTC that day.
	t.Setenv("AWWO_FREE_PLAN_UNTIL", "2026-11-13T00:00:00+08:00")
	c, err := ConfigFromEnv()
	if err != nil || !c.FreePlanUntil.Equal(time.Date(2026, 11, 12, 16, 0, 0, 0, time.UTC)) || c.FreePlanUntil.Location() != time.UTC {
		t.Fatal("the end", c.FreePlanUntil, err)
	}
	// A moment already past is accepted: the free plan has ended.
	t.Setenv("AWWO_FREE_PLAN_UNTIL", "2020-01-01T00:00:00Z")
	if _, err := ConfigFromEnv(); err != nil {
		t.Fatal("a past end refused", err)
	}
	for _, bad := range []string{"2026-11-12", "2026-11-12T16:00:00", "2026-11-12 16:00:00Z", "soon"} {
		t.Run("bad "+bad, func(t *testing.T) {
			setHostedSiteEnv(t)
			t.Setenv("AWWO_FREE_PLAN_UNTIL", bad)
			if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AWWO_FREE_PLAN_UNTIL") {
				t.Fatal("accepted", bad, err)
			}
		})
	}
}

// The plans that open a closed workspace are ClawHunt's, on operator credentials: without either the end is refused at
// startup, so a site without ClawHunt, a personal-key site and the local edition never close.
func TestFreePlanEndNeedsClawHuntAndOperatorCredentials(t *testing.T) {
	withoutClawHunt := func(t *testing.T) {
		for _, key := range []string{"AWWO_CLAWHUNT_URL", "AWWO_CLAWHUNT_CLIENT_ID", "AWWO_CLAWHUNT_CLIENT_SECRET"} {
			t.Setenv(key, "")
		}
	}
	for name, change := range map[string]func(t *testing.T){
		"without ClawHunt":  withoutClawHunt,
		"personal keys":     func(t *testing.T) { t.Setenv("AWWO_CREDENTIAL_MODE", "user") },
		"the local edition": func(t *testing.T) { withoutClawHunt(t); setLocalEditionEnv(t) },
	} {
		t.Run(name, func(t *testing.T) {
			setHostedSiteEnv(t)
			change(t)
			if _, err := ConfigFromEnv(); err != nil {
				t.Fatal("the site itself must load", err)
			}
			t.Setenv("AWWO_FREE_PLAN_UNTIL", "2026-11-12T16:00:00Z")
			if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AWWO_FREE_PLAN_UNTIL") {
				t.Fatal("the free plan's end accepted", err)
			}
		})
	}
}

func TestFreePlanEndsAtItsMoment(t *testing.T) {
	until := time.Date(2026, 11, 12, 16, 0, 0, 0, time.UTC)
	c := Config{FreePlanUntil: until}
	if c.freePlanEnded(until.Add(-time.Nanosecond)) || !c.freePlanEnded(until) || !c.freePlanEnded(until.Add(time.Hour)) || (Config{}).freePlanEnded(until) {
		t.Fatal("the free plan ends at its moment, as the promotion does")
	}
	// Without an end, before it, or for a workspace whose owner has a plan, the gate asks the database nothing: a nil
	// querier would panic.
	ctx := context.Background()
	for _, end := range []time.Time{{}, time.Now().Add(time.Hour)} {
		if err := freePlanClosed(ctx, nil, "workspace-1", end, nil); err != nil {
			t.Fatal(end, err)
		}
	}
	if err := freePlanClosed(ctx, nil, "workspace-1", time.Now().Add(-time.Hour), &activePlan{Plan: "pro"}); err != nil {
		t.Fatal("a plan's workspace", err)
	}
	// A relayed call refused for it reserved nothing and says so, as the other plan refusals do.
	w := httptest.NewRecorder()
	relayRefusal(w, errFreePlanEnded)
	if !relayRefused(errFreePlanEnded) || w.Code != 402 || w.Header().Get("x-should-retry") != "false" || !strings.Contains(w.Body.String(), `"free_plan_ended"`) {
		t.Fatal("a relayed call's refusal", w.Code, w.Header(), w.Body.String())
	}
}

// freePlanSpace is a workspace of the free plan's end tests, with what each way of starting work in it needs.
type freePlanSpace struct {
	c                                                                 *http.Cookie
	tid, user, chat, team, canvas, image, model3d, revision, relayKey string
}

// freePlanRequest starts work in a workspace: its path and body.
type freePlanRequest struct {
	name, path string
	body       map[string]any
}

// freePlanWork is every admission of new work the free plan's end closes, in s, with operation ids made from op: a run
// of a node, of a team node, a canvas run, a canvas plan, a knowledge compilation, an image and a 3D generation, and a
// managed-execution task. The relayed call is sent apart (sendRelay).
func freePlanWork(s freePlanSpace, op string) []freePlanRequest {
	base := "/tenants/" + s.tid
	canvas := base + "/canvases/" + s.canvas
	run := func(session, prompt, kind string) map[string]any {
		return map[string]any{"sessionId": session, "prompt": prompt, "operationId": op + "-" + kind}
	}
	return []freePlanRequest{
		{"chat run", base + "/runs", run(s.chat, "Write one line", "chat")},
		{"team run", base + "/runs", run(s.team, "Write one line", "team")},
		{"canvas run", canvas + "/graph-runs", map[string]any{"operationId": op + "-graph"}},
		{"canvas plan", canvas + "/plan", map[string]any{"prompt": "Add a reviewer", "context": "", "operationId": op + "-plan"}},
		{"knowledge compilation", canvas + "/knowledge-compile", map[string]any{"revisionIds": []string{s.revision}, "operationId": op + "-compile"}},
		{"image generation", base + "/runs", run(s.image, "a red bicycle on a beach", "image")},
		{"3D generation", base + "/runs", run(s.model3d, "a knight in armour", "model3d")},
		{"managed execution", canvas + "/computer-runs", map[string]any{"operationId": op + "-computer", "prompt": "Prepare a report", "runtime": "pi", "model": "test-model"}},
	}
}

// freePlanHarness is a site where every admission path can start work: a text worker that holds the first canvas run's
// node a until release is closed, image and 3D generation, managed execution (whose worker has no slot, so a task it
// admits fails at once) and the relay.
func freePlanHarness(t *testing.T) (*harness, *fakeRelayWorker, chan struct{}) {
	t.Helper()
	release := make(chan struct{})
	var held atomic.Bool
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		if strings.HasPrefix(b.Prompt, "【工作流节点】a") && held.CompareAndSwap(false, true) {
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		completePi(w, "done")
	})
	t.Cleanup(provider.Close)
	computer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			computerWorkerHealth(w)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(computer.Close)
	token := strings.Repeat("w", 32)
	relay := newFakeRelayWorker(t, token)
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"alternate", "test-model"}
	var err error
	if h.a.pricing, err = ParseModelPricing(planPricing); err != nil {
		t.Fatal(err)
	}
	newFakeRunningHub(t).configure(h.a)
	newFakeTripo(t, h)
	h.a.cfg.OpenMausURL, h.a.cfg.OpenMausToken = computer.URL, strings.Repeat("m", 32)
	h.a.cfg.ComputerModelProxyURL = h.server.URL + "/api/internal/computer-model/v1"
	h.a.cfg.Relay, h.a.cfg.RelayWorkerURL, h.a.cfg.RelayWorkerToken = true, relay.URL, token
	return h, relay, release
}

// freePlanWorkspace registers email's workspace with these route limits ("" for none) and makes what each path needs.
func freePlanWorkspace(t *testing.T, h *harness, email, routes string) freePlanSpace {
	t.Helper()
	c, tid, uid := h.register(t, email)
	execSQL(t, h, "UPDATE tenants SET max_concurrent_runs=100,max_runs_per_day=1000,route_limits=$2::jsonb WHERE id=$1", tid, nullIfEmpty(routes))
	s := freePlanSpace{c: c, tid: tid, user: uid}
	_, _, s.chat = h.fixture(t, c, tid)
	_, _, s.team = installTeam(t, h, c, tid, fixtureTeam("sequential"))
	s.canvas, _ = graphFixture(t, h, c, tid)
	_, media := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", map[string]any{"resolution": "1k"}), motionNode("m3d", "tripo.v3-1", map[string]any{}))
	s.image, s.model3d = setupNodeAt(media, 0)["issueId"].(string), setupNodeAt(media, 1)["issueId"].(string)
	source := h.request(t, c, "POST", "/tenants/"+tid+"/knowledge/sources", map[string]string{"title": "Notes", "content": "FREE-PLAN-EVIDENCE", "operationId": "free-plan-notes"}, 201)
	s.revision = source["currentRevisionId"].(string)
	s.relayKey = h.request(t, c, "POST", "/auth/relay-keys", map[string]any{"name": "Laptop", "tenantId": tid}, 201)["key"].(string)
	return s
}

// awaitFreePlanWork waits until the work started in tid (run or canvas run ids by path name) has ended, however it did.
func awaitFreePlanWork(t *testing.T, h *harness, tid string, started map[string]string) {
	t.Helper()
	for name, id := range started {
		table := "runs"
		if name == "canvas run" {
			table = "graph_runs"
		}
		for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(10 * time.Millisecond) {
			var status string
			if e := h.db.QueryRow(context.Background(), "SELECT status FROM "+table+" WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status); e != nil {
				t.Fatal(name, e)
			}
			if status != "queued" && status != "running" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal(name, "never ended")
			}
		}
	}
}

// freePlanCounts is what a workspace has started, reserved or counted: runs, canvas runs, model calls and generations.
func freePlanCounts(t *testing.T, h *harness, tid string) [4]int {
	t.Helper()
	var n [4]int
	if e := h.db.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM runs WHERE tenant_id=$1),(SELECT count(*) FROM graph_runs WHERE tenant_id=$1),
		(SELECT count(*) FROM model_invocations WHERE tenant_id=$1),(SELECT count(*) FROM media_generations WHERE tenant_id=$1)`, tid).Scan(&n[0], &n[1], &n[2], &n[3]); e != nil {
		t.Fatal(e)
	}
	return n
}

// Before the end a free workspace starts every kind of work, a relayed call included.
func TestPostgresFreePlanTrialAdmitsEveryKindOfWork(t *testing.T) {
	h, _, release := freePlanHarness(t)
	close(release)
	h.a.cfg.FreePlanUntil = time.Now().Add(time.Hour)
	free := freePlanWorkspace(t, h, "free-plan-trial@example.test", `{"media":10}`)
	started := map[string]string{}
	for _, work := range freePlanWork(free, "trial") {
		started[work.name] = h.request(t, free.c, "POST", work.path, work.body, 202)["id"].(string)
	}
	if status, body := sendRelay(t, h, free.relayKey, "POST", relayCompletionsRoute, relayHello); status != 200 {
		t.Fatal("a relayed call before the end", status, body)
	}
	if view, _ := h.request(t, free.c, "GET", "/tenants/"+free.tid+"/route-usage", nil, 200)["freePlan"].(map[string]any); view == nil || view["ended"] != false {
		t.Fatal("the meter before the end", view)
	}
	awaitFreePlanWork(t, h, free.tid, started)
}

// The end comes while a canvas run admitted just before it is still running: that run finishes, its merge node admitted
// after the end, and from then on the free workspace starts nothing. The moment is set a few seconds ahead, with the one
// admission it must follow inside them, rather than moved under running work.
func TestPostgresFreePlanEndClosesNewWorkAndLetsRunningWorkFinish(t *testing.T) {
	h, relay, release := freePlanHarness(t)
	free := freePlanWorkspace(t, h, "free-plan-free@example.test", `{"media":10}`)
	paid := freePlanWorkspace(t, h, "free-plan-paid@example.test", planRoutes)
	now := time.Now()
	givePlan(t, h, "free-plan-paid@example.test", "max", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 10000)
	operator := freePlanWorkspace(t, h, "free-plan-operator@example.test", `{"media":10}`)
	makeAdmin(t, h, operator.user)
	unlimited := freePlanWorkspace(t, h, "free-plan-unlimited@example.test", "")
	until := time.Now().Add(6 * time.Second)
	h.a.cfg.FreePlanUntil = until
	canvasRuns := "/tenants/" + free.tid + "/canvases/" + free.canvas + "/graph-runs"
	gid := h.request(t, free.c, "POST", canvasRuns, map[string]any{"operationId": "trial-graph"}, 202)["id"].(string)
	if !time.Now().Before(until) {
		t.Fatal("the canvas run was admitted no sooner than the end it was to come before")
	}
	time.Sleep(time.Until(until) + 20*time.Millisecond)
	close(release)
	awaitGraph(t, h, free.c, canvasRuns+"/"+gid, "completed", 15*time.Second)
	freePlanRefusesAll(t, h, relay, free)
	// A plan's workspace, the operator's own and one without route limits run everything as before.
	for name, s := range map[string]freePlanSpace{"a plan's": paid, "the operator's": operator, "an unlimited": unlimited} {
		for _, work := range freePlanWork(s, "ended") {
			id := h.request(t, s.c, "POST", work.path, work.body, 202)["id"].(string)
			awaitFreePlanWork(t, h, s.tid, map[string]string{work.name: id})
		}
		if status, body := sendRelay(t, h, s.relayKey, "POST", relayCompletionsRoute, relayHello); status != 200 {
			t.Fatal(name, "relayed call", status, body)
		}
	}
}

// freePlanRefusesAll checks that, the free plan having ended, every admission of new work in the free workspace s is
// refused with 402 free_plan_ended, and that nothing is started, reserved or counted for any of them.
func freePlanRefusesAll(t *testing.T, h *harness, relay *fakeRelayWorker, s freePlanSpace) {
	t.Helper()
	before, sent := freePlanCounts(t, h, s.tid), len(relay.sent())
	for _, work := range freePlanWork(s, "ended") {
		if refused := h.request(t, s.c, "POST", work.path, work.body, 402); errorCode(refused) != "free_plan_ended" {
			t.Fatal(work.name, refused)
		}
	}
	if status, body := sendRelay(t, h, s.relayKey, "POST", relayCompletionsRoute, relayHello); status != 402 || !strings.Contains(body, `"free_plan_ended"`) {
		t.Fatal("a relayed call after the end", status, body)
	}
	if after := freePlanCounts(t, h, s.tid); after != before || len(relay.sent()) != sent {
		t.Fatal("something was started, reserved or counted for a refused admission", before, after, sent, len(relay.sent()))
	}
}

// A plan read without its lock that has lapsed by the locked read leaves a new run on the free plan's limits, which ask
// whether the free plan has ended; a step of a run admitted already does not ask.
func TestPostgresAPlanThatLapsesAdmitsNoFreeRunAfterTheEnd(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	_, tid, uid := h.register(t, "free-lapsed@example.test")
	setLimits(t, h, tid, 30, `{"media":1}`)
	ctx := context.Background()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	own := workspaceLimits{concurrent: 5, daily: 30, freeUntil: time.Now().Add(-time.Second)}
	if err := h.a.planRunSlot(ctx, tx, tid, own); !errors.Is(err, errFreePlanEnded) {
		t.Fatal("a run on the free plan's limits after the end", err)
	}
	var refusal *mediaRefusal
	if _, err := h.a.admitMediaGeneration(ctx, tx, tid, executionSnapshot{}, nil, true, false, own); !errors.As(err, &refusal) || refusal.status != 402 || refusal.code != "free_plan_ended" {
		t.Fatal("a generation on the free plan's limits after the end", err)
	}
	for _, until := range []time.Time{time.Now().Add(time.Hour), {}} {
		own.freeUntil = until
		if err := h.a.planRunSlot(ctx, tx, tid, own); err != nil {
			t.Fatal("before the end, or a step of a run admitted already", until, err)
		}
	}
	makeAdmin(t, h, uid)
	own.freeUntil = time.Now().Add(-time.Second)
	if err := h.a.planRunSlot(ctx, tx, tid, own); err != nil {
		t.Fatal("the operator's own workspace", err)
	}
}

// freePlanViewer is someone reading a workspace's route-usage.
type freePlanViewer struct {
	c   *http.Cookie
	tid string
}

// freePlanExempt makes the workspaces the free plan's end never holds: a plan's, the operator's own and one without
// route limits.
func freePlanExempt(t *testing.T, h *harness) map[string]freePlanViewer {
	t.Helper()
	paid, tp, _ := h.register(t, "free-view-paid@example.test")
	setLimits(t, h, tp, 30, planRoutes)
	now := time.Now()
	givePlan(t, h, "free-view-paid@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	operator, to, uo := h.register(t, "free-view-operator@example.test")
	setLimits(t, h, to, 30, `{"media":1}`)
	makeAdmin(t, h, uo)
	unlimited, tu, _ := h.register(t, "free-view-unlimited@example.test")
	setLimits(t, h, tu, 30, "")
	return map[string]freePlanViewer{"a plan's": {paid, tp}, "the operator's": {operator, to}, "an unlimited": {unlimited, tu}}
}

// GET /route-usage says when the free plan ends and whether it has, by the API's clock, to everyone it answers (readers
// too), for a workspace the end holds; never for a plan's, the operator's own, one without route limits, or unset.
func TestPostgresRouteUsageSaysWhenTheFreePlanEnds(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tid, _ := h.register(t, "free-view-owner@example.test")
	setLimits(t, h, tid, 30, `{"media":1}`)
	member, _, memberID := h.register(t, "free-view-member@example.test")
	reader, _, readerID := h.register(t, "free-view-reader@example.test")
	execSQL(t, h, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'reader')", tid, memberID, readerID)
	exempt := freePlanExempt(t, h)
	view := func(c *http.Cookie, tid string) any {
		t.Helper()
		return h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)["freePlan"]
	}
	viewers := map[string]*http.Cookie{"owner": owner, "member": member, "reader": reader}
	for who, c := range viewers {
		if v := view(c, tid); v != nil {
			t.Fatal("unset", who, v)
		}
	}
	for _, until := range []time.Time{time.Now().Add(time.Hour), time.Now().Add(-time.Minute)} {
		h.a.cfg.FreePlanUntil = until
		want := map[string]any{"until": until.UTC().Format(time.RFC3339Nano), "ended": !time.Now().Before(until)}
		for who, c := range viewers {
			if v := view(c, tid); !reflect.DeepEqual(v, want) {
				t.Fatal(who, v, want)
			}
		}
		for name, other := range exempt {
			if v := view(other.c, other.tid); v != nil {
				t.Fatal(name, v)
			}
		}
	}
	// A subscription that lands takes the workspace out of it at once.
	now := time.Now()
	givePlan(t, h, "free-view-owner@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	for who, c := range viewers {
		if v := view(c, tid); v != nil {
			t.Fatal("subscribed", who, v)
		}
	}
}

// A workspace the free plan's end closed runs nothing, so the platform asks no model for it: the canvas assistant routes
// its messages without the router's call (to the planner, which then refuses them), and learning skips its runs, with
// the reason routeClosed gives. A subscription that lands opens it at once.
func TestPostgresTheFreePlanEndAsksNoModelForAClosedWorkspace(t *testing.T) {
	worker, calls := routeWorker(t, func(w http.ResponseWriter, _ map[string]any) {
		json.NewEncoder(w).Encode(content(`{"route":"execute"}`))
	})
	h := newHarness(t, worker.URL)
	h.a.cfg.OpenMausURL, h.a.cfg.OpenMausToken = "http://127.0.0.1:1", strings.Repeat("m", 32)
	c, tid, uid := h.register(t, "free-router@example.test")
	setLimits(t, h, tid, 30, planRoutes)
	cv := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Routed", "document": map[string]any{"nodes": []any{}}}, 201)
	path := "/tenants/" + tid + "/canvases/" + cv["id"].(string) + "/assistant/route"
	route := func(want, basis string, modelCalls int) {
		t.Helper()
		got := h.request(t, c, "POST", path, map[string]any{"message": "帮我调研一下竞品", "routes": []string{routePlan, routeExecute},
			"canvas": map[string]any{"nodes": 0, "titles": []string{}, "results": false}, "recent": []any{}}, 200)
		if got["route"] != want || got["basis"] != basis || *calls != modelCalls {
			t.Fatalf("got %v after %d model calls, want %s by %s after %d", got, *calls, want, basis, modelCalls)
		}
	}
	closed := func(want string) {
		t.Helper()
		if got, err := h.a.routeClosed(context.Background(), tid); err != nil || got != want {
			t.Fatalf("closed %q (%v), want %q", got, err, want)
		}
	}
	h.a.cfg.FreePlanUntil = time.Now().Add(time.Hour)
	route(routeExecute, "model", 1)
	closed("")
	h.a.cfg.FreePlanUntil = time.Now().Add(-time.Second)
	route(routePlan, "fallback", 1)
	closed("free_plan_ended")
	// A workspace that exists only under a plan it lacks says so first, as before.
	execSQL(t, h, "UPDATE tenants SET requires_plan=true WHERE id=$1", tid)
	closed("plan_required")
	execSQL(t, h, "UPDATE tenants SET requires_plan=false WHERE id=$1", tid)
	now := time.Now()
	givePlan(t, h, "free-router@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	route(routeExecute, "model", 2)
	closed("")
	// Without a plan again: the operator's own workspace and one without route limits are never closed.
	execSQL(t, h, "DELETE FROM user_plans WHERE user_id=$1", uid)
	closed("free_plan_ended")
	setLimits(t, h, tid, 30, "")
	closed("")
	setLimits(t, h, tid, 30, planRoutes)
	makeAdmin(t, h, uid)
	closed("")
}
