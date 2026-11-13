package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// The owner, 2026-11-13: 「开放 Fable 5.2」 for the accounts the operator sponsors
// (AWWO_PLAN_ONLY_SPONSORED_WORKSPACES, plan_only_models.go).

func TestPlanOnlySponsoredWorkspacesSetting(t *testing.T) {
	read := func() (Config, error) {
		var c Config
		return c, c.routeSettingsFromEnv()
	}
	if c, err := read(); err != nil || c.PlanOnlySponsoredWorkspaces != nil || c.planOnlySponsored("t1") {
		t.Fatal("unset names workspaces:", c.PlanOnlySponsoredWorkspaces, err)
	}
	t.Setenv("AWWO_PLAN_ONLY_SPONSORED_WORKSPACES", " t1 , t2,,")
	c, err := read()
	if err != nil || strings.Join(c.PlanOnlySponsoredWorkspaces, ",") != "t1,t2" || !c.planOnlySponsored("t2") || c.planOnlySponsored("t3") || c.planOnlySponsored("") {
		t.Fatal("the list as read:", c.PlanOnlySponsoredWorkspaces, err)
	}
	// The list is read whatever the plan-only models are, "none" included.
	t.Setenv("AWWO_PLAN_ONLY_MODELS", "none")
	if c, err := read(); err != nil || c.PlanOnlyModels != nil || len(c.PlanOnlySponsoredWorkspaces) != 2 {
		t.Fatal("with no plan-only model:", c.PlanOnlyModels, c.PlanOnlySponsoredWorkspaces, err)
	}
	t.Setenv("AWWO_PLAN_ONLY_MODELS", "")
	for _, bad := range []string{"t1,not a workspace", "t1;t2", strings.Repeat("a", 129)} {
		t.Setenv("AWWO_PLAN_ONLY_SPONSORED_WORKSPACES", bad)
		if _, err := read(); err == nil {
			t.Fatal("a list that does not parse was accepted:", bad)
		}
	}
	many := make([]string, 65)
	for i := range many {
		many[i] = "w" + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	t.Setenv("AWWO_PLAN_ONLY_SPONSORED_WORKSPACES", strings.Join(many, ","))
	if _, err := read(); err == nil {
		t.Fatal("more than 64 workspaces were accepted")
	}
	t.Setenv("AWWO_PLAN_ONLY_SPONSORED_WORKSPACES", strings.Join(many[:64], ","))
	if c, err := read(); err != nil || len(c.PlanOnlySponsoredWorkspaces) != 64 {
		t.Fatal("64 workspaces were refused:", err)
	}
}

func TestPostgresSponsoredWorkspaceRunsPlanOnlyModelsWithoutAPlan(t *testing.T) {
	h := planHarness(t)
	const fable, opus, haiku = "bedrock.claude-fable-5-2", "bedrock.claude-opus-5-5", "bedrock.claude-haiku-4-5"
	h.a.cfg.PlanOnlyModels = []string{fable, opus}
	cs, ts, _ := h.register(t, "plan-only-sponsored@example.test")
	cl, tl, _ := h.register(t, "plan-only-sponsored-limited@example.test")
	co, to, _ := h.register(t, "plan-only-sponsored-other@example.test")
	// ts has no route limits, as the sponsored workspaces are set; tl is sponsored with a route limit of its own; to is
	// not sponsored.
	rs := routeHarnessRun(t, h, cs, ts, "")
	rl := routeHarnessRun(t, h, cl, tl, `{"bedrock":1}`)
	ro := routeHarnessRun(t, h, co, to, "")
	closures := func(tid string) modelClosures {
		t.Helper()
		got, e := h.a.closedRoutes(context.Background(), tid)
		if e != nil {
			t.Fatal(e)
		}
		return got
	}

	// Before it is sponsored, a workspace without a plan is refused both models and its catalogue says so.
	for _, model := range []string{fable, opus} {
		if e := reserveModel(h, ts, rs, model); !errors.Is(e, errRouteQuota) {
			t.Fatal("a workspace without a plan ran", model, "before it was sponsored:", e)
		}
	}
	if c := closures(ts); !c.closes(h.a.cfg, fable) || !c.closes(h.a.cfg, opus) {
		t.Fatal("catalogue closures before sponsoring", c)
	}

	h.a.cfg.PlanOnlySponsoredWorkspaces = []string{ts, tl}
	for _, model := range []string{fable, opus, haiku} {
		if e := reserveModel(h, ts, rs, model); e != nil {
			t.Fatal("a sponsored workspace was refused", model, ":", e)
		}
	}
	if c := closures(ts); c.closes(h.a.cfg, fable) || c.closes(h.a.cfg, opus) {
		t.Fatal("a sponsored workspace's catalogue still closes the plan-only models", c)
	}
	// The calls are the workspace's own free ones (no plan is charged), counted on its ledger.
	var calls, billed int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*), count(billed_user_id) FROM model_invocations WHERE tenant_id=$1 AND model_id = ANY($2)",
		ts, []string{fable, opus}).Scan(&calls, &billed); e != nil || calls != 2 || billed != 0 {
		t.Fatal("the sponsored calls on the ledger", calls, billed, e)
	}

	// Sponsoring lifts the plan-only rule alone: a route limit of the workspace's own still holds it.
	if e := reserveModel(h, tl, rl, fable); e != nil {
		t.Fatal("a sponsored, route-limited workspace was refused within its own allowance:", e)
	}
	if e := reserveModel(h, tl, rl, opus); !errors.Is(e, errRouteQuota) {
		t.Fatal("a sponsored workspace passed its own route limit:", e)
	}
	// So does its model allowlist.
	execSQL(t, h, "UPDATE tenants SET allowed_models=ARRAY[$2::text] WHERE id=$1", ts, haiku)
	if e := reserveModel(h, ts, rs, fable); !errors.Is(e, errModelNotAllowed) {
		t.Fatal("a sponsored workspace ran a model outside its allowlist:", e)
	}
	execSQL(t, h, "UPDATE tenants SET allowed_models=NULL WHERE id=$1", ts)

	// Another workspace is as before, and one taken off the list is refused again.
	if e := reserveModel(h, to, ro, fable); !errors.Is(e, errRouteQuota) {
		t.Fatal("a workspace that is not sponsored ran a plan-only model:", e)
	}
	if c := closures(to); !c.closes(h.a.cfg, fable) {
		t.Fatal("a workspace that is not sponsored lost its catalogue mark", c)
	}
	h.a.cfg.PlanOnlySponsoredWorkspaces = nil
	if e := reserveModel(h, ts, rs, fable); !errors.Is(e, errRouteQuota) {
		t.Fatal("a workspace taken off the list still ran a plan-only model:", e)
	}
}

// A model only a user may choose (a Claude Fable model) is never the operator's own call, sponsored or not.
func TestPostgresSponsoredWorkspaceNeverRunsAFableModelAsTheOperatorsCall(t *testing.T) {
	h := planHarness(t)
	const fable = "bedrock.claude-fable-5-2"
	h.a.cfg.PlanOnlyModels = []string{fable}
	c, tid, _ := h.register(t, "plan-only-sponsored-operator-call@example.test")
	rid := routeHarnessRun(t, h, c, tid, "")
	h.a.cfg.PlanOnlySponsoredWorkspaces = []string{tid}
	h.a.cfg.PlannerModel = fable
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	e := h.a.reserveInvocation(ctx, tid, rid, randomID(), fable, &invocationFacts{Runtime: runtimePI, Model: fable, OperatorPaid: true})
	if !errors.Is(e, errModelNotAllowed) {
		t.Fatal("an operator-paid call ran on a Claude Fable model in a sponsored workspace:", e)
	}
}
