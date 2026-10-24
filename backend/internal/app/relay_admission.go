package app

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// relayAdmissionWait is the longest a relayed call waits for a free slot (its workspace's calls at once, or its plan's
// agents at once). It answers nothing meanwhile, so it stays well inside the ~100 s that Cloudflare lets a response send
// nothing; past it the call is refused as relay_busy, which costs nothing, and the person's computer may ask again.
var relayAdmissionWait = 60 * time.Second

// errRelayBusy is a relayed call that found no free slot in time; errRelayClosing one whose API began to close while it
// waited for one.
var (
	errRelayBusy    = errors.New("relay_busy")
	errRelayClosing = errors.New("relay_closing")
)

// relayRunID is the logical run a link's calls are recorded under (model_invocations.run_id): no run has it.
func relayRunID(link relayLink) string { return "relay-" + link.ID }

// reserveRelayInvocation admits one relayed call (relay.go) the way reserveInvocation admits a run's call: under the
// workspace's row, against its live allowlist, the plan rules and its own allowances or its owner's plan, and records
// it as the workspace's model invocation. A relayed call has no run, so it holds a slot of its own while it runs: a free
// workspace counts it among its calls at once (admitFreeInvocation), a plan among its agents at once (accountSlotsUsed).
// The link and its person are checked again under the lock, so a link revoked or a member removed a moment ago is not
// admitted.
func (a *App) reserveRelayInvocation(ctx context.Context, link relayLink, invID, model string, facts *invocationFacts) error {
	deadline := time.Now().Add(relayAdmissionWait)
	wait := 40 * time.Millisecond
	for {
		if a.relayClosing() {
			return errRelayClosing
		}
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		admitted, e := a.admitRelayInvocation(ctx, tx, link, invID, model, facts)
		if e == nil && admitted {
			return tx.Commit(ctx)
		}
		tx.Rollback(context.Background())
		if e != nil {
			return e
		}
		if time.Now().After(deadline) {
			return errRelayBusy
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, 500*time.Millisecond)
	}
}

// admitRelayInvocation is one try of reserveRelayInvocation inside its transaction: false while no slot is free.
func (a *App) admitRelayInvocation(ctx context.Context, tx pgx.Tx, link relayLink, invID, model string, facts *invocationFacts) (bool, error) {
	tid := link.TenantID
	var status string
	var concurrent, daily int
	var restricted, needsPlan bool
	var allowed []string
	var routes []byte
	e := tx.QueryRow(ctx, "SELECT status,max_concurrent_runs,max_runs_per_day,allowed_models IS NOT NULL,COALESCE(allowed_models,'{}'),route_limits,requires_plan FROM tenants WHERE id=$1 FOR UPDATE", tid).
		Scan(&status, &concurrent, &daily, &restricted, &allowed, &routes, &needsPlan)
	if noRows(e) {
		return false, errRelayWorkspace
	}
	if e != nil {
		return false, e
	}
	var linkStatus, role string
	e = tx.QueryRow(ctx, `SELECT l.status,COALESCE(m.role,'') FROM local_links l LEFT JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id
		WHERE l.id=$1 AND l.tenant_id=$2 AND l.expires_at > now()`, link.ID, tid).Scan(&linkStatus, &role)
	if noRows(e) || (e == nil && linkStatus != "issued") {
		return false, errRelayUnauthorized
	}
	if e != nil {
		return false, e
	}
	if status != "active" || roleLevel(role) < roleLevel("member") {
		return false, errRelayWorkspace
	}
	// A promotion and today's check-in raise a free workspace's stored allowances (promo.go).
	if daily, routes, e = a.todayAllowance(ctx, tx, tid, daily, routes); e != nil {
		return false, e
	}
	plan, e := ownerPlan(ctx, tx, tid, false)
	if e != nil {
		return false, e
	}
	entitlement, e := newModelEntitlement(restricted, allowed)
	if e != nil || !entitlement.permits(model) {
		return false, errModelNotAllowed
	}
	if e = requiresPlan(ctx, tx, tid, needsPlan, plan); e != nil {
		return false, e
	}
	if a.cfg.planOnlyModel(model) {
		closed, e := a.planOnlyClosed(ctx, tx, tid, plan)
		if e != nil {
			return false, e
		}
		if closed {
			return false, errRouteQuota
		}
	}
	var reserve *int
	if plan != nil {
		if reserve, e = a.creditReserve(facts.Runtime, model, facts.InputBytes); e != nil {
			return false, e
		}
	}
	var billed *activePlan
	if plan == nil {
		free, e := a.admitFreeInvocation(ctx, tx, tid, model, concurrent, daily, routes, false)
		if e != nil || !free {
			return false, e
		}
	} else if billed, e = a.admitPlanRelayInvocation(ctx, tx, tid, reserve); e != nil || billed == nil {
		return false, e
	}
	if e = a.reserveInvocationFacts(ctx, tx, tid, relayRunID(link), invID, facts, reserve, billed); e != nil {
		return false, e
	}
	if _, e = tx.Exec(ctx, "UPDATE model_invocations SET relay_link_id=$3 WHERE tenant_id=$1 AND id=$2", tid, invID, link.ID); e != nil {
		return false, e
	}
	return true, nil
}

// admitPlanRelayInvocation applies the owner's plan to a relayed call as admitPlanInvocation does to a run's: today's
// free default-model calls, and for a paid route the period's credits. The call has no run holding a slot for it, so it
// needs a free one of the plan's agents at once (accountSlotsUsed counts relayed calls running). The account is counted
// without a lock first, then again under the plan row's lock. It returns the locked plan the call is charged to, or nil
// while no slot is free (or the plan lapsed meanwhile, and the next try is free).
func (a *App) admitPlanRelayInvocation(ctx context.Context, tx pgx.Tx, tid string, reserve *int) (*activePlan, error) {
	check := func(plan *activePlan) (bool, error) {
		usage, e := accountPlanUsage(ctx, tx, plan.UserID, a.cfg.PlannerModel)
		if e != nil {
			return false, e
		}
		if reserve == nil && usage.FreeToday >= plan.Limits.Daily {
			return false, errInvocationQuota
		}
		used, e := accountSlotsUsed(ctx, tx, plan.UserID)
		return used < plan.Limits.Concurrent, e
	}
	for _, lock := range []bool{false, true} {
		plan, e := ownerPlan(ctx, tx, tid, lock)
		if e != nil || plan == nil {
			return nil, e
		}
		if free, e := check(plan); e != nil || !free {
			return nil, e
		}
		if lock {
			if reserve != nil {
				if e = checkCredits(ctx, tx, plan, *reserve); e != nil {
					return nil, e
				}
			}
			return plan, nil
		}
	}
	return nil, nil
}
