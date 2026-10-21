package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const testPlannerModel = "bedrock.claude-haiku-4-5"

func TestPlannerSettingsFromEnv(t *testing.T) {
	names := []string{"AWWO_PLANNER_MODEL", "AWWO_PLANNER_PER_WORKSPACE_PER_DAY", "AWWO_PLANNER_TOTAL_PER_DAY", "AWWO_PLANNER_MAX_INPUT_BYTES"}
	for _, name := range names {
		t.Setenv(name, "")
	}
	var c Config
	if err := c.plannerSettingsFromEnv(); err != nil || c.PlannerModel != "" || c.PlannerPerWorkspaceDay != 20 || c.PlannerTotalPerDay != 2000 || c.PlannerMaxInputBytes != 60000 {
		t.Fatalf("defaults: model %q, %d/%d/%d, %v", c.PlannerModel, c.PlannerPerWorkspaceDay, c.PlannerTotalPerDay, c.PlannerMaxInputBytes, err)
	}
	for i, value := range []string{testPlannerModel, "5", "0", "4096"} {
		t.Setenv(names[i], value)
	}
	c = Config{}
	if err := c.plannerSettingsFromEnv(); err != nil || c.PlannerModel != testPlannerModel || c.PlannerPerWorkspaceDay != 5 || c.PlannerTotalPerDay != 0 || c.PlannerMaxInputBytes != 4096 {
		t.Fatalf("configured: model %q, %d/%d/%d, %v", c.PlannerModel, c.PlannerPerWorkspaceDay, c.PlannerTotalPerDay, c.PlannerMaxInputBytes, err)
	}
	for _, bad := range [][2]string{
		{"AWWO_PLANNER_MODEL", "bedrock.a,bedrock.b"},
		{"AWWO_PLANNER_MODEL", "has space"},
		{"AWWO_PLANNER_PER_WORKSPACE_PER_DAY", "-1"},
		{"AWWO_PLANNER_PER_WORKSPACE_PER_DAY", "100001"},
		{"AWWO_PLANNER_TOTAL_PER_DAY", "many"},
		{"AWWO_PLANNER_MAX_INPUT_BYTES", "4095"},
		{"AWWO_PLANNER_MAX_INPUT_BYTES", "128001"},
	} {
		t.Run(bad[0]+"="+bad[1], func(t *testing.T) {
			t.Setenv(bad[0], bad[1])
			var c Config
			if err := c.plannerSettingsFromEnv(); err == nil || !strings.Contains(err.Error(), bad[0]) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
	c = testConfig()
	c.PlannerModel = testPlannerModel
	if err := c.validatePlannerSettings(); err != nil {
		t.Fatal(err)
	}
	c.UserCredentials = true
	if err := c.validatePlannerSettings(); err == nil {
		t.Fatal("a personal-credential deployment accepted an operator planner model")
	}
}

// plannerModelWorker is a Pi worker that offers the planner model (unless withPlanner is false), records the
// model each run asks for and answers every run with a valid plan.
func plannerModelWorker(t *testing.T, withPlanner bool) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var asked []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			offered := []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}}
			if withPlanner {
				offered = append(offered, map[string]any{"id": testPlannerModel, "provider": "bedrock", "maxContextTextBytes": 262144})
			}
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": offered})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		asked = append(asked, body.Model)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": progressPlan})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(server.Close)
	return server, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(asked)
	}
}

// plannedOn runs one canvas plan to completion and reports the model its only call used, whether its run was
// admitted as the operator's, and whether that call reserved plan credits.
func plannedOn(t *testing.T, h *harness, c *http.Cookie, tid, operation string) (string, bool, bool) {
	t.Helper()
	id := startPlan(t, h, c, tid, operation)
	if done := h.awaitRun(t, c, tid, id, "completed"); done["output"] != progressPlan {
		t.Fatalf("%s: plan changed: %#v", operation, done["output"])
	}
	return runCall(t, h, tid, id)
}

func runCall(t *testing.T, h *harness, tid, rid string) (model string, operatorPaid, reserved bool) {
	t.Helper()
	if e := h.db.QueryRow(context.Background(), `SELECT mi.model_id, r.execution_snapshot @> '{"operatorPaid":true}'::jsonb, mi.credit_reserve IS NOT NULL
		FROM model_invocations mi JOIN runs r ON r.tenant_id=mi.tenant_id AND r.id=mi.run_id WHERE mi.tenant_id=$1 AND mi.run_id=$2`, tid, rid).Scan(&model, &operatorPaid, &reserved); e != nil {
		t.Fatal(e)
	}
	return model, operatorPaid, reserved
}

func TestPostgresCanvasPlansRunOnTheOperatorPlannerModelWithinItsCeilings(t *testing.T) {
	pi, asked := plannerModelWorker(t, true)
	h := newHarness(t, pi.URL)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = testPlannerModel, 2, 100, 60000
	// As in production, the default model is the free route (qwen there), so the fallback runs everywhere.
	h.a.cfg.RouteFreeModels = []string{"test-model"}
	expect := func(label, operation, model string, paid bool, gotModel string, gotPaid, reserved bool) {
		t.Helper()
		if gotModel != model || gotPaid != paid || reserved {
			t.Fatalf("%s (%s): model %q operator-paid %v reserved %v, want %q %v false", label, operation, gotModel, gotPaid, reserved, model, paid)
		}
	}

	// A free workspace as launched: only the default model, no Bedrock allowance at all.
	ca, ta, _ := h.register(t, "planner-model-free@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['test-model'],route_limits='{"gate":0,"bedrock":0,"media":1}'::jsonb,max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, ta)
	m, paid, reserved := plannedOn(t, h, ca, ta, "planner-a1")
	expect("outside the allowlist and the route allowance", "planner-a1", testPlannerModel, true, m, paid, reserved)
	// A run posted straight to the planner session is not a canvas plan: it keeps the default model.
	var sid string
	if e := h.db.QueryRow(context.Background(), "SELECT id FROM node_sessions WHERE tenant_id=$1 AND kind='planner' LIMIT 1", ta).Scan(&sid); e != nil {
		t.Fatal(e)
	}
	direct := h.request(t, ca, "POST", "/tenants/"+ta+"/runs", map[string]string{"sessionId": sid, "prompt": "Plan anything", "operationId": "planner-direct"}, 202)["id"].(string)
	h.awaitRun(t, ca, ta, direct, "completed")
	m, paid, reserved = runCall(t, h, ta, direct)
	expect("direct planner-session run", "planner-direct", "test-model", false, m, paid, reserved)
	m, paid, reserved = plannedOn(t, h, ca, ta, "planner-a2")
	expect("second plan", "planner-a2", testPlannerModel, true, m, paid, reserved)
	m, paid, reserved = plannedOn(t, h, ca, ta, "planner-a3")
	expect("workspace ceiling of 2 reached", "planner-a3", "test-model", false, m, paid, reserved)

	// A workspace with one Bedrock call a day: canvas plans never spend it, and its own calls of the planner
	// model never spend its planner allowance.
	cb, tb, _ := h.register(t, "planner-model-routes@awwo.invalid")
	rb := routeHarnessRun(t, h, cb, tb, `{"gate":3,"bedrock":1}`)
	h.a.cfg.PlannerMaxInputBytes = 16
	m, paid, reserved = plannedOn(t, h, cb, tb, "planner-b-large")
	expect("input over the ceiling", "planner-b-large", "test-model", false, m, paid, reserved)
	h.a.cfg.PlannerMaxInputBytes = 60000
	m, paid, reserved = plannedOn(t, h, cb, tb, "planner-b1")
	expect("route-limited workspace", "planner-b1", testPlannerModel, true, m, paid, reserved)
	if e := reserveModel(h, tb, rb, testPlannerModel); e != nil {
		t.Fatal("a canvas plan spent the workspace's Bedrock allowance:", e)
	}
	if e := reserveModel(h, tb, rb, "bedrock.claude-opus-5-5"); !errors.Is(e, errRouteQuota) {
		t.Fatal("the workspace's own Bedrock call did not spend its allowance:", e)
	}
	m, paid, reserved = plannedOn(t, h, cb, tb, "planner-b2")
	expect("own calls of the model do not count, a spent route allowance does not matter", "planner-b2", testPlannerModel, true, m, paid, reserved)

	// The deployment's ceiling counts every workspace's canvas plans: 4 so far (a1, a2, b1, b2).
	h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay = 10, 4
	m, paid, reserved = plannedOn(t, h, cb, tb, "planner-b3")
	expect("deployment ceiling reached", "planner-b3", "test-model", false, m, paid, reserved)
	h.a.cfg.PlannerTotalPerDay = 5
	m, paid, reserved = plannedOn(t, h, cb, tb, "planner-b4")
	expect("deployment ceiling raised", "planner-b4", testPlannerModel, true, m, paid, reserved)
	h.a.cfg.PlannerTotalPerDay = 0
	m, paid, reserved = plannedOn(t, h, cb, tb, "planner-b5")
	expect("a ceiling of 0 admits none", "planner-b5", "test-model", false, m, paid, reserved)

	want := []string{testPlannerModel, "test-model", testPlannerModel, "test-model", "test-model", testPlannerModel, testPlannerModel, "test-model", testPlannerModel, "test-model"}
	if got := asked(); !slices.Equal(got, want) {
		t.Fatalf("the worker was asked for %v, want %v", got, want)
	}
}

func TestPostgresCanvasPlanFallsBackWhenTheWorkerLacksThePlannerModel(t *testing.T) {
	pi, asked := plannerModelWorker(t, false)
	h := newHarness(t, pi.URL)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = testPlannerModel, 2, 100, 60000
	c, tid, _ := h.register(t, "planner-model-missing@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['test-model'] WHERE id=$1`, tid)
	if m, paid, _ := plannedOn(t, h, c, tid, "planner-missing"); m != "test-model" || paid {
		t.Fatalf("planned on %q (operator-paid %v) with a worker that does not offer the planner model", m, paid)
	}
	if got := asked(); !slices.Equal(got, []string{"test-model"}) {
		t.Fatalf("the worker was asked for %v", got)
	}
}

func TestPostgresOperatorPlannerCallsSpendNoPlanCredits(t *testing.T) {
	h := planHarness(t)
	h.a.cfg.PlannerModel = testPlannerModel
	c, tid, _ := h.register(t, "planner-paid@example.test")
	rid := routeHarnessRun(t, h, c, tid, planRoutes)
	now := time.Now()
	givePlan(t, h, "planner-paid@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reserve := func(model string, operatorPaid bool) error {
		return h.a.reserveInvocation(ctx, tid, rid, randomID(), model, &invocationFacts{Runtime: runtimePI, Model: model, OperatorPaid: operatorPaid})
	}
	// The planner model has no plan price: the workspace's own call of it is refused before any credit moves.
	if e := reserve(testPlannerModel, false); !errors.Is(e, errModelUnpriced) {
		t.Fatal("an unpriced model was admitted on plan credits:", e)
	}
	// The operator's planner call is admitted as one of the account's default-model calls, with no reserve.
	if e := reserve(testPlannerModel, true); e != nil {
		t.Fatal(e)
	}
	// The flag covers the planner model only, and nothing once the planner model is unset.
	if e := reserve("bedrock.claude-opus-5-5", true); e != nil {
		t.Fatal(e)
	}
	h.a.cfg.PlannerModel = ""
	if e := reserve(testPlannerModel, true); !errors.Is(e, errModelUnpriced) {
		t.Fatal("an operator-paid flag outlived its planner model:", e)
	}
	rows, e := h.db.Query(ctx, "SELECT model_id, credit_reserve IS NOT NULL, billed_user_id IS NOT NULL FROM model_invocations WHERE tenant_id=$1 ORDER BY created_at", tid)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var model string
		var reserved, billed bool
		if e = rows.Scan(&model, &reserved, &billed); e != nil {
			t.Fatal(e)
		}
		got = append(got, fmt.Sprintf("%s reserved=%v billed=%v", model, reserved, billed))
	}
	want := []string{testPlannerModel + " reserved=false billed=true", "bedrock.claude-opus-5-5 reserved=true billed=true"}
	if !slices.Equal(got, want) {
		t.Fatalf("ledger %v, want %v", got, want)
	}
}

// A call of the operator's planner model that never began (settled not_incurred: refused by its worker, or by its
// provider as larger than the model's window) spends neither planner ceiling, as it spends no daily call.
func TestPostgresPlannerCeilingsSkipCallsThatNeverBegan(t *testing.T) {
	pi, _ := plannerModelWorker(t, true)
	h := newHarness(t, pi.URL)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = testPlannerModel, 1, 1, 60000
	h.a.cfg.RouteFreeModels = []string{"test-model"}
	c, tid, _ := h.register(t, "planner-never-began@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	if m, paid, _ := plannedOn(t, h, c, tid, "never-began-1"); m != testPlannerModel || !paid {
		t.Fatalf("the first plan ran on %q (operator-paid %v)", m, paid)
	}
	execSQL(t, h, `UPDATE model_invocations SET cost_status='not_incurred' WHERE tenant_id=$1`, tid)
	if allowance, ok, e := h.a.plannerAllowanceToday(context.Background(), h.db, tid); e != nil || !ok || allowance.Used != 0 {
		t.Fatalf("the meter counts %d planner calls (%v, %v)", allowance.Used, ok, e)
	}
	// Neither the workspace's ceiling of 1 nor the deployment's is reached: the next plan runs on the planner model, and
	// spends both.
	if m, paid, _ := plannedOn(t, h, c, tid, "never-began-2"); m != testPlannerModel || !paid {
		t.Fatalf("after a call that never began the plan ran on %q (operator-paid %v)", m, paid)
	}
	if m, _, _ := plannedOn(t, h, c, tid, "never-began-3"); m != "test-model" {
		t.Fatalf("a spent ceiling still ran the plan on %q", m)
	}
}
