package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

// Owner decision 2026-10-10: the canvas assistant's plans on the operator's planner model do not spend a
// workspace's daily calls (a free workspace's or a plan's), and are bounded by their own per-workspace ceiling
// instead (default 20). A plan past that ceiling falls back to the default model and is an ordinary call.

func allowanceOf(t *testing.T, v map[string]any, key string) (limit, used int) {
	t.Helper()
	a, ok := v[key].(map[string]any)
	if !ok {
		t.Fatalf("route usage has no %q: %#v", key, v)
	}
	l, _ := a["limit"].(float64)
	u, _ := a["used"].(float64)
	return int(l), int(u)
}

// runningRun stores one running run of the workspace so model calls can be admitted directly against it,
// leaving the workspace's own allowances as they are.
func runningRun(t *testing.T, h *harness, c *http.Cookie, tid string) string {
	t.Helper()
	_, _, sid := h.fixture(t, c, tid)
	rid := randomID()
	execSQL(t, h, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p','running')", rid, tid, sid, "daily-"+rid)
	return rid
}

func TestPostgresCanvasPlansOnThePlannerModelSpendNoDailyCalls(t *testing.T) {
	pi, asked := plannerModelWorker(t, true)
	h := newHarness(t, pi.URL)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = testPlannerModel, 3, 100, 60000
	h.a.cfg.RouteFreeModels = []string{"test-model"}
	c, tid, _ := h.register(t, "planner-daily@awwo.invalid")
	// A free workspace as launched, with a single call a day so that one ordinary call uses the day up.
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['test-model'],route_limits='{"gate":0,"bedrock":0,"media":1}'::jsonb,max_runs_per_day=1,max_concurrent_runs=10 WHERE id=$1`, tid)
	usage := func() map[string]any { return h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200) }

	for _, op := range []string{"daily-plan-1", "daily-plan-2"} {
		if m, paid, _ := plannedOn(t, h, c, tid, op); m != testPlannerModel || !paid {
			t.Fatalf("%s planned on %q (operator-paid %v)", op, m, paid)
		}
	}
	v := usage()
	if l, u := allowanceOf(t, v, "daily"); l != 1 || u != 0 {
		t.Fatalf("daily calls %d of %d after two plans on the planner model, want 0 of 1", u, l)
	}
	if l, u := allowanceOf(t, v, "planner"); l != 3 || u != 2 {
		t.Fatalf("planner calls %d of %d, want 2 of 3", u, l)
	}

	// The day's one ordinary call, then none.
	rid := runningRun(t, h, c, tid)
	if e := reserveModel(h, tid, rid, "test-model"); e != nil {
		t.Fatal("the day's one ordinary call was refused after two plans:", e)
	}
	if e := reserveModel(h, tid, rid, "test-model"); !errors.Is(e, errInvocationQuota) {
		t.Fatal("a second ordinary call was admitted on a one-call day:", e)
	}
	// A workspace whose calls are used up can still have its canvas arranged on the planner model.
	if m, paid, _ := plannedOn(t, h, c, tid, "daily-plan-3"); m != testPlannerModel || !paid {
		t.Fatalf("with the daily calls used up a plan ran on %q (operator-paid %v)", m, paid)
	}
	v = usage()
	if l, u := allowanceOf(t, v, "daily"); l != 1 || u != 1 {
		t.Fatalf("daily calls %d of %d, want 1 of 1", u, l)
	}
	if l, u := allowanceOf(t, v, "planner"); l != 3 || u != 3 {
		t.Fatalf("planner calls %d of %d, want 3 of 3", u, l)
	}

	// Past the planner ceiling a plan would fall back to the default model, an ordinary call: the used-up day refuses it.
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	refused := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]string{"prompt": "Build a data product", "context": "schema", "operationId": "daily-plan-4"}, 429)
	if errorCode(refused) != "quota_exceeded" {
		t.Fatalf("a fallback plan on a used-up day: %#v", refused)
	}
	// With a call left the same fallback runs on the default model and spends it.
	execSQL(t, h, "UPDATE tenants SET max_runs_per_day=2 WHERE id=$1", tid)
	if m, paid, _ := plannedOn(t, h, c, tid, "daily-plan-5"); m != "test-model" || paid {
		t.Fatalf("past the planner ceiling a plan ran on %q (operator-paid %v)", m, paid)
	}
	if l, u := allowanceOf(t, usage(), "daily"); l != 2 || u != 2 {
		t.Fatalf("a fallback plan did not spend a daily call: %d of %d", u, l)
	}
	want := []string{testPlannerModel, testPlannerModel, testPlannerModel, "test-model"}
	if got := asked(); !slices.Equal(got, want) {
		t.Fatalf("the worker was asked for %v, want %v", got, want)
	}
}

func TestPostgresPlannerCallsSpendNoPlanDailyCalls(t *testing.T) {
	h := planHarness(t)
	h.a.cfg.PlannerModel = testPlannerModel
	saved := planCatalog["pro"]
	small := saved
	small.Daily = 1
	planCatalog["pro"] = small
	t.Cleanup(func() { planCatalog["pro"] = saved })

	c, tid, _ := h.register(t, "planner-plan-daily@example.test")
	rid := routeHarnessRun(t, h, c, tid, planRoutes)
	// As createRun stores a plan admitted on the planner model; the ledger reads the flag from here.
	execSQL(t, h, `UPDATE runs SET execution_snapshot='{"operatorPaid":true}'::jsonb WHERE id=$1`, rid)
	now := time.Now()
	uid := givePlan(t, h, "planner-plan-daily@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reserve := func(model string, operatorPaid bool) error {
		return h.a.reserveInvocation(ctx, tid, rid, randomID(), model, &invocationFacts{Runtime: runtimePI, Model: model, OperatorPaid: operatorPaid})
	}
	if e := reserve("qwen3.8-27b-p6", false); e != nil {
		t.Fatal("the plan's one default-model call was refused:", e)
	}
	if e := reserve("qwen3.8-27b-p6", false); !errors.Is(e, errInvocationQuota) {
		t.Fatal("a second default-model call was admitted on a one-call plan day:", e)
	}
	for i := range 2 {
		if e := reserve(testPlannerModel, true); e != nil {
			t.Fatalf("operator planner call %d was held by the plan's used-up daily calls: %v", i+1, e)
		}
	}
	usage, e := accountPlanUsage(ctx, h.db, uid, testPlannerModel)
	if e != nil || usage.FreeToday != 1 {
		t.Fatalf("the plan counted %d default-model calls today (%v), want 1: planner calls must not count", usage.FreeToday, e)
	}
	if l, u := allowanceOf(t, h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200), "daily"); l != 1 || u != 1 {
		t.Fatalf("the plan meter shows %d of %d, want 1 of 1", u, l)
	}
}

// catalogWorker offers the free default model, a gate model and a Bedrock model.
func catalogWorker(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			w.WriteHeader(404)
			return
		}
		writeJSON(w, 200, map[string]any{"ready": true, "model": "qwen3.8-27b-p6", "provider": "test", "models": []map[string]any{
			{"id": "qwen3.8-27b-p6", "provider": "test", "maxContextTextBytes": 262144},
			{"id": "claude-opus-5", "provider": "llmgate", "maxContextTextBytes": 262144},
			{"id": "bedrock.claude-opus-5-5", "provider": "bedrock", "maxContextTextBytes": 262144}}})
	}))
	t.Cleanup(server.Close)
	return server
}

func TestPostgresRuntimeCatalogMarksModelsThatNeedAPlan(t *testing.T) {
	h := newHarness(t, catalogWorker(t).URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	c, tid, _ := h.register(t, "catalog-tags@example.test")
	tags := func() map[string]string {
		t.Helper()
		out := map[string]string{}
		for _, raw := range h.request(t, c, "GET", "/tenants/"+tid+"/runtime", nil, 200)["models"].([]any) {
			m := raw.(map[string]any)
			if m["runtime"] != runtimePI {
				continue
			}
			tag, _ := m["route"].(string)
			if m["requiresUpgrade"] == true {
				tag += "+upgrade"
			}
			out[m["id"].(string)] = tag
		}
		return out
	}
	expect := func(label string, want map[string]string) {
		t.Helper()
		got := tags()
		for id, tag := range want {
			if got[id] != tag {
				t.Fatalf("%s: %s is %q, want %q (all %v)", label, id, got[id], tag, got)
			}
		}
	}
	set := func(routes string) {
		execSQL(t, h, "UPDATE tenants SET allowed_models=NULL,route_limits=$2::jsonb WHERE id=$1", tid, nullIfEmpty(routes))
	}
	set(`{"gate":0,"bedrock":0,"media":1}`)
	expect("free tier", map[string]string{"qwen3.8-27b-p6": "free", "claude-opus-5": "gate+upgrade", "bedrock.claude-opus-5-5": "bedrock+upgrade"})
	set(`{"gate":3,"bedrock":0,"media":1}`)
	expect("a few gate calls a day", map[string]string{"qwen3.8-27b-p6": "free", "claude-opus-5": "gate", "bedrock.claude-opus-5-5": "bedrock+upgrade"})
	set(`{}`)
	expect("route-limited, no route limited", map[string]string{"claude-opus-5": "gate", "bedrock.claude-opus-5-5": "bedrock"})
	set("")
	expect("no route limits", map[string]string{"claude-opus-5": "gate", "bedrock.claude-opus-5-5": "bedrock"})
	set(`{"gate":0,"bedrock":0,"media":1}`)
	now := time.Now()
	givePlan(t, h, "catalog-tags@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	expect("on a plan", map[string]string{"qwen3.8-27b-p6": "free", "claude-opus-5": "gate", "bedrock.claude-opus-5-5": "bedrock"})
}
