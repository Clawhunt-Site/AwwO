package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"
)

// The end of the free plan (owner 2026-11-07: 「免费账号停用，必须订阅」). From AWWO_FREE_PLAN_UNTIL on, a workspace on the
// free plan runs nothing until its owner subscribes to Pro or Max: one with route limits (any workspace a plan can cover,
// as entitledPlanSQL reads it) whose owner has no entitled plan and that no platform administrator owns (the operator's
// own, which planOnlyClosed exempts the same way). The moment is judged on the API's clock, as the promotion's is
// (promo.go), and nothing is written to a workspace: a subscription that lands opens it at its next admission.
//
// Each admission of new work that the free daily allowance or a free cap would hold asks freePlanClosed where it reads
// the owner's plan, in the same transaction, and refuses with 402 free_plan_ended before anything is reserved, counted
// or started: a run (createRun, which plans, knowledge compilations, managed execution and generations go through), a
// canvas run as a whole (createGraphRun) and each relayed call (openRelayGate). Where a plan read without its lock has
// lapsed by the locked read, a new run's admission falls back to the free plan's limits (workspaceLimits.admit), which
// ask again, so no race admits a free run past the moment. A run admitted before the moment finishes as it would have:
// the steps of a run already admitted (its model calls, a canvas run's nodes as their turns come) are not asked again.
// The platform's own calls about a closed workspace (the assistant's router, learning) are not made (routeClosed).
// Reading, editing, saving, export, deletion, billing, invites and the usage meter stay open.

const freePlanEndedMessage = "The free trial has ended: this workspace runs again once its owner subscribes to Pro or Max."

var errFreePlanEnded = errors.New("free_plan_ended")

// freePlanSettingFromEnv reads AWWO_FREE_PLAN_UNTIL, an RFC 3339 time read as AWWO_PROMO_UNTIL is; unset, the free plan
// never ends.
func (c *Config) freePlanSettingFromEnv() error {
	raw := os.Getenv("AWWO_FREE_PLAN_UNTIL")
	if raw == "" {
		return nil
	}
	until, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return errors.New("AWWO_FREE_PLAN_UNTIL must be an RFC 3339 time such as 2026-11-12T16:00:00Z")
	}
	c.FreePlanUntil = until.UTC()
	return nil
}

// validateFreePlan: a workspace the end closes opens again only with a plan, and the plans are ClawHunt's, on operator
// credentials (validateBilling), so the end needs both. A past moment is accepted: the free plan has then ended already.
func (c Config) validateFreePlan() error {
	if c.FreePlanUntil.IsZero() || (!c.UserCredentials && c.ClawHuntURL != "") {
		return nil
	}
	return errors.New("AWWO_FREE_PLAN_UNTIL needs AWWO_CREDENTIAL_MODE=operator and ClawHunt sign-in (AWWO_CLAWHUNT_URL), whose plans keep a workspace running")
}

// freePlanEnded reports whether the free plan has ended at now: an end is set and now is not before it.
func (c Config) freePlanEnded(now time.Time) bool {
	return !c.FreePlanUntil.IsZero() && !now.Before(c.FreePlanUntil)
}

// freePlanHolds reports whether the free plan's end (until) holds the workspace, whether it has come or not: an end is
// set, the owner has no entitled plan (plan, as the caller read it), the workspace has route limits, and no platform
// administrator owns it. The workspace's row is read through q, so an admission reads the row it holds locked.
func freePlanHolds(ctx context.Context, q querier, tid string, until time.Time, plan *activePlan) (bool, error) {
	if until.IsZero() || plan != nil {
		return false, nil
	}
	var limited bool
	switch err := q.QueryRow(ctx, "SELECT route_limits IS NOT NULL FROM tenants WHERE id=$1", tid).Scan(&limited); {
	case noRows(err):
		return false, nil
	case err != nil || !limited:
		return false, err
	}
	operator, err := operatorWorkspace(ctx, q, tid)
	return err == nil && !operator, err
}

// freePlanClosed is errFreePlanEnded once the free plan's end (until) has come for a workspace it holds; nil before it,
// for any other workspace and without an end, when it asks the database nothing.
func freePlanClosed(ctx context.Context, q querier, tid string, until time.Time, plan *activePlan) error {
	if until.IsZero() || time.Now().Before(until) {
		return nil
	}
	holds, err := freePlanHolds(ctx, q, tid, until, plan)
	if err != nil || !holds {
		return err
	}
	return errFreePlanEnded
}

func failFreePlanEnded(w http.ResponseWriter) {
	fail(w, 402, "free_plan_ended", freePlanEndedMessage)
}

// freePlanAdmits answers a new admission that the free plan's end closes (402 free_plan_ended, or the database's
// failure) and reports whether it may go on; plan is the owner's entitled plan as that admission read it, in q.
func (a *App) freePlanAdmits(w http.ResponseWriter, r *http.Request, q querier, tid string, plan *activePlan) bool {
	switch err := freePlanClosed(r.Context(), q, tid, a.cfg.FreePlanUntil, plan); {
	case errors.Is(err, errFreePlanEnded):
		failFreePlanEnded(w)
	case err != nil:
		a.dbError(w, err)
	default:
		return true
	}
	return false
}

// freePlanAdmitsOwner is freePlanAdmits for an admission that reads no plan of its own (a canvas run's): the owner's is
// read here, in q, and only once the end has come.
func (a *App) freePlanAdmitsOwner(w http.ResponseWriter, r *http.Request, q querier, tid string) bool {
	if !a.cfg.freePlanEnded(time.Now()) {
		return true
	}
	plan, err := ownerPlan(r.Context(), q, tid, false)
	if err != nil {
		a.dbError(w, err)
		return false
	}
	return a.freePlanAdmits(w, r, q, tid, plan)
}

// freePlanView is the free plan's end as GET /route-usage shows it to everyone it answers: when (UTC), and whether it
// has come by the API's clock; nil for a workspace the end does not hold (plan: the owner's, whoever is asking).
func (a *App) freePlanView(ctx context.Context, q querier, tid string, plan *activePlan) (map[string]any, error) {
	holds, err := freePlanHolds(ctx, q, tid, a.cfg.FreePlanUntil, plan)
	if err != nil || !holds {
		return nil, err
	}
	return map[string]any{"until": a.cfg.FreePlanUntil.UTC(), "ended": a.cfg.freePlanEnded(time.Now())}, nil
}
