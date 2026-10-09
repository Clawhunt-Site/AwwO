package app

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestFreeModelCeilingSetting(t *testing.T) {
	var unset Config
	if err := unset.routeSettingsFromEnv(); err != nil || unset.FreeModelTotalPerDay != 0 {
		t.Fatal("unset must be no ceiling", unset.FreeModelTotalPerDay, err)
	}
	for raw, want := range map[string]int{"5000": 5000, "0": 0, "1000000": 1000000} {
		t.Setenv("AWWO_FREE_MODEL_TOTAL_PER_DAY", raw)
		var c Config
		if err := c.routeSettingsFromEnv(); err != nil || c.FreeModelTotalPerDay != want {
			t.Fatal(raw, c.FreeModelTotalPerDay, err)
		}
	}
	for _, bad := range []string{"-1", "x", "1.5", "1000001", " 5"} {
		t.Setenv("AWWO_FREE_MODEL_TOTAL_PER_DAY", bad)
		var c Config
		if err := c.routeSettingsFromEnv(); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	// The ceiling counts the free list, so it needs one, and operator credentials like every route setting.
	c := testConfig()
	c.FreeModelTotalPerDay = 5000
	if err := c.Validate(); err == nil {
		t.Fatal("a free-model ceiling without free models accepted")
	}
	c.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (Config{UserCredentials: true, FreeModelTotalPerDay: 5000, RouteFreeModels: []string{"qwen3.8-27b-p6"}}).validateRouteSettings(); err == nil {
		t.Fatal("a free-model ceiling accepted in personal-key mode")
	}
	// The refusal is an admission refusal, reported as the run's own error and classed as quota.
	if admissionRefusal(errFreeCapacity) != "free_capacity_exceeded" || invocationFailure("failed", "free_capacity_exceeded") != "quota" {
		t.Fatal("refusal code", admissionRefusal(errFreeCapacity), invocationFailure("failed", "free_capacity_exceeded"))
	}
}

// The ceiling holds and counts free default-model calls of route-limited workspaces per UTC day, the empty object
// (the operator's own) and workspaces without route limits excepted, and nothing but the free models.
func TestPostgresFreeModelCeilingHoldsFreeCallsOfRouteLimitedWorkspaces(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b", "qwen3.8-27b-p6"}
	ca, ta, _ := h.register(t, "free-ceiling-a@example.test")
	cb, tb, _ := h.register(t, "free-ceiling-b@example.test")
	cc, tc, _ := h.register(t, "free-ceiling-c@example.test")
	cd, td, _ := h.register(t, "free-ceiling-d@example.test")
	ra := routeHarnessRun(t, h, ca, ta, `{"gate":0,"bedrock":0,"media":1}`)
	rb := routeHarnessRun(t, h, cb, tb, `{"gate":2}`)
	rc := routeHarnessRun(t, h, cc, tc, `{}`)
	rd := routeHarnessRun(t, h, cd, td, "")
	free := func(tid, rid string) error { return reserveModel(h, tid, rid, "qwen3.8-27b-p6") }

	// Unset, there is no ceiling: today's behaviour.
	for i := 0; i < 6; i++ {
		if e := free(ta, ra); e != nil {
			t.Fatal("no ceiling is set", i, e)
		}
	}
	// A ceiling of 8 counts A's six calls of today: two are left for B, across both free models.
	h.a.cfg.FreeModelTotalPerDay = 8
	if e := reserveModel(h, tb, rb, "qwen3.8-27b"); e != nil {
		t.Fatal(e)
	}
	if e := free(tb, rb); e != nil {
		t.Fatal(e)
	}
	if e := free(tb, rb); !errors.Is(e, errFreeCapacity) {
		t.Fatal("the ceiling did not hold B", e)
	}
	if e := reserveModel(h, ta, ra, "qwen3.8-27b"); !errors.Is(e, errFreeCapacity) {
		t.Fatal("the ceiling did not hold A", e)
	}
	// It holds the free models only: B's own gate allowance still admits a premium call.
	if e := reserveModel(h, tb, rb, "claude-sonnet-5"); e != nil {
		t.Fatal("a premium call was held by the free-model ceiling", e)
	}
	// A workspace that limits no route and one without route limits are neither held nor counted.
	for i := 0; i < 3; i++ {
		if e := free(tc, rc); e != nil {
			t.Fatal("a workspace that limits no route was held", i, e)
		}
		if e := free(td, rd); e != nil {
			t.Fatal("a workspace without route limits was held", i, e)
		}
	}
	h.a.cfg.FreeModelTotalPerDay = 9
	if e := free(ta, ra); e != nil {
		t.Fatal("calls outside the ceiling were counted", e)
	}
	if e := free(ta, ra); !errors.Is(e, errFreeCapacity) {
		t.Fatal("the raised ceiling admitted more than one call", e)
	}
	// A call that settled without reaching a provider gives its place back; one of unknown cost keeps it.
	execSQL(t, h, `UPDATE model_invocations SET status='failed',cost_status='unknown' WHERE id=(SELECT id FROM model_invocations WHERE tenant_id=$1 ORDER BY created_at LIMIT 1)`, ta)
	if e := free(tb, rb); !errors.Is(e, errFreeCapacity) {
		t.Fatal("a call of unknown cost gave its place back", e)
	}
	execSQL(t, h, `UPDATE model_invocations SET cost_status='not_incurred' WHERE id=(SELECT id FROM model_invocations WHERE tenant_id=$1 ORDER BY created_at LIMIT 1)`, ta)
	if e := free(tb, rb); e != nil {
		t.Fatal("a call that cost nothing kept its place", e)
	}
	// Refusals are not admissions: nothing was written for them.
	var a, b int
	if e := h.db.QueryRow(context.Background(), `SELECT count(*) FILTER (WHERE tenant_id=$1),count(*) FILTER (WHERE tenant_id=$2) FROM model_invocations`, ta, tb).Scan(&a, &b); e != nil || a != 7 || b != 4 {
		t.Fatal("admitted calls", a, b, e)
	}
	// The count is the UTC day's: yesterday's calls leave today's ceiling empty.
	if e := free(ta, ra); !errors.Is(e, errFreeCapacity) {
		t.Fatal(e)
	}
	execSQL(t, h, `UPDATE model_invocations SET created_at=created_at-interval '1 day'`)
	for i := 0; i < 9; i++ {
		if e := free(ta, ra); e != nil {
			t.Fatal("yesterday's calls held today", i, e)
		}
	}
	if e := free(tb, rb); !errors.Is(e, errFreeCapacity) {
		t.Fatal(e)
	}
	// 0 is no ceiling again.
	h.a.cfg.FreeModelTotalPerDay = 0
	if e := free(tb, rb); e != nil {
		t.Fatal("0 must lift the ceiling", e)
	}
}

// operatorPaidHarnessRun is a running run whose snapshot says it was admitted on the operator's planner model, as
// createRun freezes it for a canvas plan.
func operatorPaidHarnessRun(t *testing.T, h *harness, c *http.Cookie, tid string) string {
	t.Helper()
	_, _, sid := h.fixture(t, c, tid)
	rid := randomID()
	execSQL(t, h, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,execution_snapshot) VALUES($1,$2,$3,$4,'h','p','running','{"operatorPaid":true}'::jsonb)`, rid, tid, sid, "planner-"+rid)
	return rid
}

// A paid plan's calls and the operator's planner calls are never held by the free-model ceiling and never counted.
func TestPostgresFreeModelCeilingLeavesOutPlansAndOperatorPlannerCalls(t *testing.T) {
	h := planHarness(t)
	h.a.cfg.FreeModelTotalPerDay = 2
	cf, tf, _ := h.register(t, "free-ceiling-free@example.test")
	cp, tp, _ := h.register(t, "free-ceiling-plan@example.test")
	rf := routeHarnessRun(t, h, cf, tf, planRoutes)
	rp := routeHarnessRun(t, h, cp, tp, planRoutes)
	now := time.Now()
	givePlan(t, h, "free-ceiling-plan@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	free := func(tid, rid string) error { return reserveModel(h, tid, rid, "qwen3.8-27b-p6") }
	for i := 0; i < 2; i++ {
		if e := free(tf, rf); e != nil {
			t.Fatal(i, e)
		}
	}
	if e := free(tf, rf); !errors.Is(e, errFreeCapacity) {
		t.Fatal("the ceiling did not hold the free workspace", e)
	}
	// The plan's default-model calls are the plan's: the full ceiling never holds them. Pro runs three agents at
	// once, so each call is settled before the next.
	for i := 0; i < 4; i++ {
		if e := free(tp, rp); e != nil {
			t.Fatal("a paid plan's call was held by the free-model ceiling", i, e)
		}
		settleNewest(t, h, tp, nil)
	}
	var billed int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND billed_user_id IS NOT NULL", tp).Scan(&billed); e != nil || billed != 4 {
		t.Fatal("the plan's calls are billed to it", billed, e)
	}
	// Nor were they counted: one more place admits exactly one more free call.
	h.a.cfg.FreeModelTotalPerDay = 3
	if e := free(tf, rf); e != nil {
		t.Fatal("a paid plan's calls were counted", e)
	}
	if e := free(tf, rf); !errors.Is(e, errFreeCapacity) {
		t.Fatal(e)
	}
	// The operator's planner calls are the operator's, even on a free model: held by nothing here, counted by nothing.
	h.a.cfg.PlannerModel = "qwen3.8-27b-p6"
	planner := operatorPaidHarnessRun(t, h, cf, tf)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 3; i++ {
		if e := h.a.reserveInvocation(ctx, tf, planner, randomID(), "qwen3.8-27b-p6", &invocationFacts{Runtime: runtimePI, Model: "qwen3.8-27b-p6", OperatorPaid: true}); e != nil {
			t.Fatal("an operator planner call was held by the free-model ceiling", i, e)
		}
	}
	h.a.cfg.FreeModelTotalPerDay = 4
	if e := free(tf, rf); e != nil {
		t.Fatal("operator planner calls were counted", e)
	}
	if e := free(tf, rf); !errors.Is(e, errFreeCapacity) {
		t.Fatal(e)
	}
}
