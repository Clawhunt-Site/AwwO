package app

import (
	"context"
	"errors"
	"os"
	"sort"
	"strings"
)

// Plan-only models (owner 2026-10-13: Opus 5.5 改成只给付费用户). A model on AWWO_PLAN_ONLY_MODELS runs only for a
// workspace whose owner has a paid plan (Pro or Max, on credits) or that a platform administrator owns (the
// operator's own, operator_workspace.go). For every other workspace it is outside the free allowance, the way a paid
// route limited to 0 is (route_limits.go): the catalogue marks it requiresUpgrade (closedRoutes), the switch to a model
// that sees pictures passes it over (vision.go), and admission refuses a call on it with premium_quota_exceeded
// (reserveInvocation), the refusal the web already answers with the way to Pro and Max. The operator's planner calls
// are the operator's, never held by it.
//
// Empty or unset, the list is Claude Opus 5.5 (an empty value keeps the default, as every setting here does); "none"
// makes no model plan-only. The ids are worker model ids, so a personal catalogue's per-connection models are never on it.
const defaultPlanOnlyModels = "bedrock.claude-opus-5-5"

func (c *Config) planOnlySettingFromEnv() error {
	raw := strings.TrimSpace(os.Getenv("AWWO_PLAN_ONLY_MODELS"))
	c.PlanOnlyModels = nil
	switch raw {
	case "none":
		return nil
	case "":
		raw = defaultPlanOnlyModels
	}
	models, err := newWorkspaceModels(raw)
	if err != nil {
		return errors.New(`AWWO_PLAN_ONLY_MODELS must be empty (Claude Opus 5.5), "none", or 1 to 64 comma-separated model ids of at most 200 bytes, without whitespace or control characters`)
	}
	list, _ := models.column().([]string)
	c.PlanOnlyModels = append([]string{}, list...)
	sort.Strings(c.PlanOnlyModels)
	return nil
}

// planOnlyModel reports whether model is on the plan-only list (kept sorted).
func (c Config) planOnlyModel(model string) bool {
	i := sort.SearchStrings(c.PlanOnlyModels, model)
	return i < len(c.PlanOnlyModels) && c.PlanOnlyModels[i] == model
}

// planOnlyClosed reports whether the plan-only models are outside this workspace's allowance: there are some, its
// owner has no paid plan (plan, as the caller read it), and no platform administrator owns it.
func (a *App) planOnlyClosed(ctx context.Context, q querier, tid string, plan *activePlan) (bool, error) {
	if plan != nil || len(a.cfg.PlanOnlyModels) == 0 {
		return false, nil
	}
	operator, err := operatorWorkspace(ctx, q, tid)
	return err == nil && !operator, err
}

// modelClosures are what a workspace cannot call on its current plan, so the catalogue marks those models
// requiresUpgrade and a picker can say that Pro or Max is needed before a run is refused with premium_quota_exceeded:
// a free workspace's paid routes limited to 0, and the plan-only models for one that planOnlyClosed holds.
type modelClosures struct {
	routes   map[string]bool
	planOnly bool
}

func (c modelClosures) closes(cfg Config, id string) bool {
	return c.routes[cfg.modelRoute(id)] || (c.planOnly && cfg.planOnlyModel(id))
}
