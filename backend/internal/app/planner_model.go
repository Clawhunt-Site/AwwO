package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// The canvas planner may run on an operator-chosen model instead of its runtime's default (AWWO_PLANNER_MODEL,
// e.g. a Claude model on Bedrock). Such a call is the operator's cost, not the workspace's: it is admitted outside
// the workspace's model allowlist, its paid-route allowances and its plan credits, and counts only towards its
// daily total like the free default model. Only a plan the canvas assistant requests (planCanvas) qualifies; a run
// posted straight to a planner session keeps the default model, so the operator's model cannot be used as a free
// general-purpose endpoint. Each workspace and the whole deployment have a daily ceiling of such calls, and a
// request too large for it, a ceiling reached or a worker that does not offer the model all fall back to the
// default model rather than failing.
//
// AWWO_PLANNER_PER_WORKSPACE_PER_DAY and AWWO_PLANNER_TOTAL_PER_DAY count planner-model calls per UTC day (0: none,
// like a route allowance of 0); AWWO_PLANNER_MAX_INPUT_BYTES bounds the prompt plus the planner instructions.
const (
	defaultPlannerPerWorkspaceDay = 30
	defaultPlannerTotalPerDay     = 2000
	defaultPlannerMaxInputBytes   = 60000
)

type plannerRequestKey struct{}

// withPlannerRequest marks the request planCanvas hands to createRun.
func withPlannerRequest(r *http.Request) *http.Request {
	return r.Clone(context.WithValue(r.Context(), plannerRequestKey{}, true))
}

func isPlannerRequest(r *http.Request) bool {
	v, _ := r.Context().Value(plannerRequestKey{}).(bool)
	return v
}

func (c *Config) plannerSettingsFromEnv() error {
	c.PlannerPerWorkspaceDay, c.PlannerTotalPerDay, c.PlannerMaxInputBytes = defaultPlannerPerWorkspaceDay, defaultPlannerTotalPerDay, defaultPlannerMaxInputBytes
	if raw := os.Getenv("AWWO_PLANNER_MODEL"); raw != "" {
		models, err := newWorkspaceModels(raw)
		list, _ := models.column().([]string)
		if err != nil || len(list) != 1 {
			return errors.New("AWWO_PLANNER_MODEL must be one model id of at most 200 bytes, without whitespace or control characters")
		}
		c.PlannerModel = list[0]
	}
	for _, s := range []struct {
		name     string
		into     *int
		min, max int
	}{
		{"AWWO_PLANNER_PER_WORKSPACE_PER_DAY", &c.PlannerPerWorkspaceDay, 0, 100000},
		{"AWWO_PLANNER_TOTAL_PER_DAY", &c.PlannerTotalPerDay, 0, 10000000},
		{"AWWO_PLANNER_MAX_INPUT_BYTES", &c.PlannerMaxInputBytes, 4096, 128000},
	} {
		raw := os.Getenv(s.name)
		if raw == "" {
			continue
		}
		v, err := strconv.Atoi(raw)
		if err != nil || v < s.min || v > s.max {
			return errors.New(s.name + " must be a whole number from " + strconv.Itoa(s.min) + " to " + strconv.Itoa(s.max))
		}
		*s.into = v
	}
	return nil
}

func (c Config) validatePlannerSettings() error {
	if c.PlannerModel != "" && c.UserCredentials {
		return errors.New("AWWO_PLANNER_MODEL requires AWWO_CREDENTIAL_MODE=operator")
	}
	return nil
}

// operatorPaidRun matches a ledger row (alias mi) whose run was admitted on the operator's planner model: the
// execution snapshot createRun froze says so, and nothing a workspace sends can set it. Such calls are counted by
// the planner ceilings below and by nothing that measures a workspace's own route allowances (route_limits.go).
const operatorPaidRun = `EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=mi.tenant_id AND r.id=mi.run_id AND r.execution_snapshot @> '{"operatorPaid":true}'::jsonb)`

// Why a plan the canvas assistant requested stays on the default model ("" when it may use the planner model).
const (
	plannerOff           = "off"
	plannerInputTooLarge = "input_too_large"
	plannerWorkspaceDay  = "workspace_daily_ceiling"
	plannerDeploymentDay = "deployment_daily_ceiling"
)

// plannerModelRefusal reports why this planning request may not use the operator's planner model now, or "" when
// it may: it fits the input ceiling, and neither the workspace's nor the deployment's daily planner-model calls
// are used up. Only operator-paid calls count, so a workspace's own calls of the same model never use up its
// planner allowance. Counts include calls in flight, so a burst cannot overshoot a ceiling by more than the calls
// racing it.
func (a *App) plannerModelRefusal(ctx context.Context, q pgx.Tx, tid string, inputBytes int) (string, error) {
	if a.cfg.PlannerModel == "" || a.cfg.UserCredentials {
		return plannerOff, nil
	}
	if inputBytes > a.cfg.PlannerMaxInputBytes {
		return plannerInputTooLarge, nil
	}
	var mine, all int
	if e := q.QueryRow(ctx, `SELECT count(*) FILTER (WHERE mi.tenant_id=$2), count(*) FROM model_invocations mi
		WHERE mi.model_id=$1 AND mi.created_at>=`+todayUTC+` AND `+operatorPaidRun, a.cfg.PlannerModel, tid).Scan(&mine, &all); e != nil {
		return "", e
	}
	if mine >= a.cfg.PlannerPerWorkspaceDay {
		return plannerWorkspaceDay, nil
	}
	if all >= a.cfg.PlannerTotalPerDay {
		return plannerDeploymentDay, nil
	}
	return "", nil
}

// operatorPaidCall is the one rule for whether reserveInvocation treats a call as the operator's: the run's
// snapshot was admitted on the planner model (createRun) and the call is that model.
func (a *App) operatorPaidCall(facts *invocationFacts, model string) bool {
	return facts != nil && facts.OperatorPaid && a.cfg.PlannerModel != "" && !a.cfg.UserCredentials && model == a.cfg.PlannerModel
}
