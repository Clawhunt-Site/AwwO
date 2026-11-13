package app

import (
	"context"
	"errors"
	"os"
	"sort"
	"strings"
)

// Plan-only models (owner 2026-10-13: Opus 5.5 改成只给付费用户). A model on AWWO_PLAN_ONLY_MODELS runs only for a
// workspace whose owner has a paid plan (Pro, Max or Ultra, on credits) or that a platform administrator owns (the
// operator's own, operator_workspace.go). For every other workspace it is outside the free allowance, the way a paid
// route limited to 0 is (route_limits.go): the catalogue marks it requiresUpgrade (closedRoutes), the switch to a model
// that sees pictures passes it over (vision.go), and admission refuses a call on it with premium_quota_exceeded
// (reserveInvocation), the refusal the web already answers with the way to the paid plans. The operator's planner calls
// are the operator's, never held by it.
//
// Empty or unset, the list is Claude Opus 5.5 (an empty value keeps the default, as every setting here does); "none"
// makes no model plan-only. The ids are worker model ids, so a personal catalogue's per-connection models are never on it.
//
// AWWO_PLAN_ONLY_SPONSORED_WORKSPACES (owner 2026-11-13: 「开放 Fable 5.2」 for the accounts the operator sponsors) names
// workspaces that run the plan-only models without a plan, as the operator's own do: the catalogue does not mark the
// models requiresUpgrade there and admission does not refuse them. Nothing else changes for such a workspace: its
// model allowlist, its own route limits and run limits, and the rule that a model only a user may choose is never the
// operator's own call all still hold. Nor does it lift the end of the free plan (free_plan.go): a sponsored workspace
// with route limits and no plan still starts nothing after it, so sponsor a workspace that has no route limits.
// Workspace ids separated by commas, at most 64; a list that does not parse stops the API from starting, since it
// names no workspace the operator meant.
const defaultPlanOnlyModels = "bedrock.claude-opus-5-5"

func (c *Config) planOnlySettingFromEnv() error {
	c.PlanOnlySponsoredWorkspaces = nil
	for _, id := range strings.Split(os.Getenv("AWWO_PLAN_ONLY_SPONSORED_WORKSPACES"), ",") {
		if id = strings.TrimSpace(id); id == "" {
			continue
		} else if !mediaWorkspaceID.MatchString(id) {
			return errors.New("AWWO_PLAN_ONLY_SPONSORED_WORKSPACES must list workspace ids separated by commas")
		}
		c.PlanOnlySponsoredWorkspaces = append(c.PlanOnlySponsoredWorkspaces, id)
	}
	if len(c.PlanOnlySponsoredWorkspaces) > 64 {
		return errors.New("AWWO_PLAN_ONLY_SPONSORED_WORKSPACES lists at most 64 workspaces")
	}
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

// planOnlySponsored reports whether the operator named workspace tid in AWWO_PLAN_ONLY_SPONSORED_WORKSPACES.
func (c Config) planOnlySponsored(tid string) bool {
	for _, id := range c.PlanOnlySponsoredWorkspaces {
		if tid != "" && id == tid {
			return true
		}
	}
	return false
}

// planOnlyClosed reports whether the plan-only models are outside this workspace's allowance: there are some, its
// owner has no paid plan (plan, as the caller read it), the operator does not sponsor it (which asks the database
// nothing), and no platform administrator owns it.
func (a *App) planOnlyClosed(ctx context.Context, q querier, tid string, plan *activePlan) (bool, error) {
	if plan != nil || len(a.cfg.PlanOnlyModels) == 0 || a.cfg.planOnlySponsored(tid) {
		return false, nil
	}
	operator, err := operatorWorkspace(ctx, q, tid)
	return err == nil && !operator, err
}

// modelClosures are what a workspace cannot call on its current plan, so the catalogue marks those models
// requiresUpgrade and a picker can say that a paid plan is needed before a run is refused with premium_quota_exceeded:
// a free workspace's paid routes limited to 0, and the plan-only models for one that planOnlyClosed holds.
type modelClosures struct {
	routes   map[string]bool
	planOnly bool
}

func (c modelClosures) closes(cfg Config, id string) bool {
	return c.routes[cfg.modelRoute(id)] || (c.planOnly && cfg.planOnlyModel(id))
}
