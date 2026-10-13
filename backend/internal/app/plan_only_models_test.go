package app

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The owner, 2026-10-13: 「Opus 5.5 改成只给付费用户」 (plan_only_models.go).

func TestPlanOnlyModelsSetting(t *testing.T) {
	read := func() []string {
		t.Helper()
		var c Config
		if err := c.routeSettingsFromEnv(); err != nil {
			t.Fatal(err)
		}
		return c.PlanOnlyModels
	}
	if got := read(); !reflect.DeepEqual(got, []string{"bedrock.claude-opus-5-5"}) {
		t.Fatal("unset is not Claude Opus 5.5:", got)
	}
	t.Setenv("AWWO_PLAN_ONLY_MODELS", "")
	if got := read(); !reflect.DeepEqual(got, []string{"bedrock.claude-opus-5-5"}) {
		t.Fatal("empty does not keep the default, as every setting here does:", got)
	}
	t.Setenv("AWWO_PLAN_ONLY_MODELS", "none")
	if got := read(); got != nil {
		t.Fatal("none is not no model:", got)
	}
	t.Setenv("AWWO_PLAN_ONLY_MODELS", "gpt-5.5,bedrock.claude-opus-5-5")
	if got := read(); !reflect.DeepEqual(got, []string{"bedrock.claude-opus-5-5", "gpt-5.5"}) {
		t.Fatal("the list is not kept sorted:", got)
	}
	c := Config{PlanOnlyModels: []string{"bedrock.claude-opus-5-5", "gpt-5.5"}}
	if !c.planOnlyModel("gpt-5.5") || !c.planOnlyModel("bedrock.claude-opus-5-5") || c.planOnlyModel("bedrock.claude-haiku-4-5") {
		t.Fatal("membership")
	}
	for _, bad := range []string{"a b", "x,,y", strings.Repeat("m", 201)} {
		t.Setenv("AWWO_PLAN_ONLY_MODELS", bad)
		var c Config
		if err := c.routeSettingsFromEnv(); err == nil {
			t.Fatal("malformed list accepted:", bad)
		}
	}
	closed := modelClosures{routes: map[string]bool{routeGate: true}, planOnly: true}
	cfg := Config{PlanOnlyModels: []string{"bedrock.claude-opus-5-5"}, RouteFreeModels: []string{"qwen3.8-27b-p6"}}
	for id, want := range map[string]bool{"bedrock.claude-opus-5-5": true, "bedrock.claude-haiku-4-5": false, "gpt-5.5": true, "qwen3.8-27b-p6": false} {
		if got := closed.closes(cfg, id); got != want {
			t.Fatal(id, got)
		}
	}
	if (modelClosures{}).closes(cfg, "bedrock.claude-opus-5-5") {
		t.Fatal("nothing closed closed Opus 5.5")
	}
}

func TestPostgresPlanOnlyModelRunsOnAPaidPlanOrTheOperatorsOwnWorkspace(t *testing.T) {
	h := planHarness(t)
	h.a.cfg.PlanOnlyModels = []string{"bedrock.claude-opus-5-5"}
	const opus, haiku = "bedrock.claude-opus-5-5", "bedrock.claude-haiku-4-5"
	cf, tf, _ := h.register(t, "plan-only-free@example.test")
	cl, tl, _ := h.register(t, "plan-only-legacy@example.test")
	cp, tp, _ := h.register(t, "plan-only-paid@example.test")
	co, to, adminID := h.register(t, "plan-only-operator@example.test")
	rf := routeHarnessRun(t, h, cf, tf, `{"gate":3,"bedrock":5,"media":1}`)
	rl := routeHarnessRun(t, h, cl, tl, "") // created before route limits existed: never route-limited, still free
	rp := routeHarnessRun(t, h, cp, tp, planRoutes)
	ro := routeHarnessRun(t, h, co, to, "")
	now := time.Now()
	givePlan(t, h, "plan-only-paid@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	makePlatformAdmin(t, h, adminID)

	// A free workspace, route-limited or not, is refused Opus 5.5 as a closed route is, and keeps its other models.
	for name, c := range map[string][2]string{"route-limited": {tf, rf}, "legacy": {tl, rl}} {
		if e := reserveModel(h, c[0], c[1], opus); !errors.Is(e, errRouteQuota) {
			t.Fatal(name, "workspace ran Opus 5.5 free:", e)
		}
		if e := reserveModel(h, c[0], c[1], haiku); e != nil {
			t.Fatal(name, "workspace lost another Bedrock model:", e)
		}
	}
	// Refused before anything was reserved: only the Haiku calls are on the ledger.
	var opusCalls int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE model_id=$1 AND tenant_id = ANY($2)", opus, []string{tf, tl}).Scan(&opusCalls); e != nil || opusCalls != 0 {
		t.Fatal("refused calls recorded", opusCalls, e)
	}
	// The paid plan runs it on credits, the operator's own workspace on its unlimited allowance.
	if e := reserveModel(h, tp, rp, opus); e != nil {
		t.Fatal("a paid plan was refused Opus 5.5:", e)
	}
	var billed *string
	if e := h.db.QueryRow(context.Background(), "SELECT billed_user_id FROM model_invocations WHERE tenant_id=$1 AND model_id=$2", tp, opus).Scan(&billed); e != nil || billed == nil {
		t.Fatal("the paid call was not charged to the plan", e)
	}
	if e := reserveModel(h, to, ro, opus); e != nil {
		t.Fatal("the operator's own workspace was refused Opus 5.5:", e)
	}
	// The planner's model is the operator's call (operatorPaidCall), never held by the rule.
	h.a.cfg.PlannerModel = opus
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e := h.a.reserveInvocation(ctx, tf, rf, randomID(), opus, &invocationFacts{Runtime: runtimePI, Model: opus, OperatorPaid: true}); errors.Is(e, errRouteQuota) {
		t.Fatal("an operator-paid call was held by the plan-only rule:", e)
	}
	h.a.cfg.PlannerModel = ""

	// The catalogue says so beforehand: requiresUpgrade on Opus 5.5 for the free workspaces only.
	closures := func(tid string) modelClosures {
		t.Helper()
		got, e := h.a.closedRoutes(context.Background(), tid)
		if e != nil {
			t.Fatal(e)
		}
		return got
	}
	for name, tid := range map[string]string{"route-limited": tf, "legacy": tl} {
		if c := closures(tid); !c.closes(h.a.cfg, opus) || c.closes(h.a.cfg, haiku) {
			t.Fatal(name, "catalogue closures", c)
		}
	}
	for name, tid := range map[string]string{"paid": tp, "operator": to} {
		if c := closures(tid); c.closes(h.a.cfg, opus) {
			t.Fatal(name, "workspace's catalogue closed Opus 5.5", c)
		}
	}
	model := h.a.catalogueModel(map[string]any{"id": opus}, opus, closures(tf))
	if model["requiresUpgrade"] != true || model["route"] != routeBedrock {
		t.Fatal("catalogue entry", model)
	}

	// With no plan-only model ("none"), the free workspace spends its Bedrock allowance on it again.
	h.a.cfg.PlanOnlyModels = nil
	if e := reserveModel(h, tf, rf, opus); e != nil {
		t.Fatal("no plan-only list still refused Opus 5.5:", e)
	}
	if c := closures(tf); c.closes(h.a.cfg, opus) {
		t.Fatal("no plan-only list still closed Opus 5.5 in the catalogue")
	}
}

func TestPostgresAPictureNeverMovesAFreeRunOntoAPlanOnlyModel(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.PlanOnlyModels = []string{"bedrock.claude-opus-5-5"}
	_, free, _ := h.register(t, "plan-only-vision-free@example.test")
	_, mine, adminID := h.register(t, "plan-only-vision-operator@example.test")
	makePlatformAdmin(t, h, adminID)
	health := piHealth{ImageInput: true, Model: "text-only", Models: []piModel{
		{ID: "text-only", Input: []string{"text"}},
		{ID: "bedrock.claude-opus-5-5", Input: []string{"text", "image"}},
		{ID: "gate-vision", Input: []string{"text", "image"}},
	}}
	picture := uploadAttachment{Kind: uploadKindImage, ContentType: "image/png", storagePath: "u/p.png", Size: 10,
		SHA256: strings.Repeat("a", 64), pixels: 100}
	switched := func(tid string) string {
		t.Helper()
		tx, e := h.db.Begin(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(context.Background())
		s := executionSnapshot{Model: "text-only", Health: health}
		if e := h.a.switchToSeeingModel(context.Background(), tx, tid, nil, &s, &uploadAttachments{Items: []uploadAttachment{picture}}); e != nil {
			t.Fatal(e)
		}
		return s.Model
	}
	if got := switched(free); got != "gate-vision" {
		t.Fatal("a free workspace's picture moved its run to", got)
	}
	if got := switched(mine); got != "bedrock.claude-opus-5-5" {
		t.Fatal("the operator's own workspace was kept off Opus 5.5:", got)
	}
}
