package app

import (
	"context"
	"net/http"
	"time"
)

// What a route-limited workspace has left today, and a durable "I want more" from its people: the
// list the operator offers paid plans to. Neither changes an allowance.

type routeAllowance struct {
	Limit int `json:"limit"`
	Used  int `json:"used"`
}

// routeUsageToday counts today's use as admission counts it. A free workspace has its daily total (invocations
// plus generations, apart from the operator's planner calls, which the daily total does not hold) and, when
// route-limited, each route it limits; routes is nil for one without route limits
// and for one that limits no route (an empty object, on plans but unlimited), which shows no meter.
// A workspace whose owner has a paid plan reports the plan (plan is set, routes nil) with the account's daily
// default-model calls across its workspaces. The deployment-wide ceilings, the media caps and the model allowlist
// are not counted, so admission can still refuse a call these numbers show room for. The limits are today's, with a
// promotion's floors and today's check-in (todayAllowance), as admission reads them; stored are the workspace's own
// daily total and route limits, from which check-ins are offered.
func (a *App) routeUsageToday(ctx context.Context, tid, uid string) (routeAllowance, map[string]routeAllowance, bool, *activePlan, error) {
	daily, routes, interested, plan, _, e := a.routeUsageWithStored(ctx, tid, uid)
	return daily, routes, interested, plan, e
}

// storedAllowance is a workspace's own daily total and route limits, as the tenants row holds them, and its status.
type storedAllowance struct {
	daily  int
	routes []byte
	status string
}

func (a *App) routeUsageWithStored(ctx context.Context, tid, uid string) (routeAllowance, map[string]routeAllowance, bool, *activePlan, storedAllowance, error) {
	var daily routeAllowance
	var stored storedAllowance
	var invocations, media, freeMedia int
	var raw []byte
	var interested bool
	var status string
	if e := a.db.QueryRow(ctx, `SELECT t.status,t.max_runs_per_day,t.route_limits,
		(SELECT count(*) FROM model_invocations mi WHERE mi.tenant_id=t.id AND mi.created_at>=`+todayUTC+` AND `+countsTowardsDaily("$3")+`),
		(SELECT count(*) FROM media_generations g WHERE g.tenant_id=t.id AND g.created_at>=`+todayUTC+` AND `+generationCounts+`),
		(SELECT count(*) FROM media_generations g WHERE g.tenant_id=t.id AND g.billed_user_id IS NULL AND g.created_at>=`+todayUTC+` AND `+generationCounts+`),
		EXISTS(SELECT 1 FROM upgrade_interests WHERE tenant_id=t.id AND user_id=$2)
		FROM tenants t WHERE t.id=$1`, tid, uid, a.cfg.PlannerModel).Scan(&status, &daily.Limit, &raw, &invocations, &media, &freeMedia, &interested); e != nil {
		return daily, nil, false, nil, stored, e
	}
	stored = storedAllowance{daily.Limit, raw, status}
	var e error
	if daily.Limit, raw, e = a.todayAllowance(ctx, a.db, tid, daily.Limit, raw); e != nil {
		return daily, nil, false, nil, stored, e
	}
	daily.Used = invocations + media
	plan, e := ownerPlan(ctx, a.db, tid, false)
	if e != nil {
		return daily, nil, false, nil, stored, e
	}
	if plan != nil {
		usage, e := accountPlanUsage(ctx, a.db, plan.UserID, a.cfg.PlannerModel)
		if e != nil {
			return daily, nil, false, nil, stored, e
		}
		return routeAllowance{Limit: plan.Limits.Daily, Used: usage.FreeToday}, nil, interested, plan, stored, nil
	}
	limits := readRouteLimits(raw)
	if len(limits) == 0 {
		return daily, nil, interested, nil, stored, nil
	}
	free := a.cfg.RouteFreeModels
	if free == nil {
		free = []string{}
	}
	routes := map[string]routeAllowance{}
	for _, route := range []string{routeGate, routeBedrock} {
		limit, ok := limits[route]
		if !ok {
			continue
		}
		var used int
		if e := a.db.QueryRow(ctx, `SELECT count(*) FROM model_invocations mi WHERE mi.tenant_id=$3 AND mi.created_at>=`+todayUTC+` AND `+routeInvocationFilter, route, free, tid).Scan(&used); e != nil {
			return daily, nil, false, nil, stored, e
		}
		routes[route] = routeAllowance{limit, used}
	}
	if limit, ok := limits[routeMedia]; ok {
		routes[routeMedia] = routeAllowance{limit, freeMedia}
	}
	return daily, routes, interested, nil, stored, nil
}

// routeUsageView answers GET /tenants/{tenantId}/route-usage for any member. A workspace without route
// limits reports limited:false and only its daily allowance; one whose owner has a paid plan reports the
// plan and this period's credits instead of routes. The credits are the account's, shared by everyone who
// runs things in its workspaces; the renewal date and a pending cancellation are shown to the owner alone,
// and a reader, who runs nothing, is not shown the plan. While a promotion raises the workspace (promo.go) it
// reports the promotion's floors (promo) and, to a member who may run things, today's check-in (checkin).
func (a *App) routeUsageView(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tid, uid := r.PathValue("tenantId"), currentUser(r).ID
	daily, routes, interested, plan, stored, e := a.routeUsageWithStored(ctx, tid, uid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	var role string
	if e = a.db.QueryRow(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, uid).Scan(&role); e != nil && !noRows(e) {
		a.dbError(w, e)
		return
	}
	member := roleLevel(role) >= 2
	if !member {
		plan = nil
	}
	out := map[string]any{"limited": routes != nil, "daily": daily, "interested": interested,
		"resetsAt": time.Now().UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)}
	if routes != nil {
		limits := readRouteLimits(stored.routes)
		offered, e := a.checkinOffered(ctx, a.db, tid, stored.status, stored.daily, stored.routes)
		if e != nil {
			a.dbError(w, e)
			return
		}
		if a.cfg.Promo.active(time.Now()) && a.cfg.promoParticipant(stored.daily, limits) {
			out["promo"] = a.cfg.promoFor(stored.daily, limits)
		}
		if offered && member {
			day, e := checkinToday(ctx, a.db)
			if e != nil {
				a.dbError(w, e)
				return
			}
			v, e := a.checkinState(ctx, a.db, tid, uid, day, true, a.cfg.checkinBonusFor(limits))
			if e != nil {
				a.dbError(w, e)
				return
			}
			out["checkin"] = v
		}
	}
	// The canvas assistant's plans on the operator's model: outside the daily calls, inside their own ceiling.
	planner, ok, e := a.plannerAllowanceToday(ctx, a.db, tid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if ok {
		out["planner"] = planner
	}
	if routes != nil {
		out["routes"] = routes
	}
	if plan != nil {
		if e = withCarry(ctx, a.db, plan); e != nil {
			a.dbError(w, e)
			return
		}
		spent, e := creditsSpent(ctx, a.db, plan)
		if e != nil {
			a.dbError(w, e)
			return
		}
		// owner tells the web who can change the plan: only the owner's own account can upgrade it.
		view := map[string]any{"id": plan.Plan, "credits": creditsJSON(plan, spent), "owner": plan.UserID == uid}
		if plan.UserID == uid {
			view["periodEnd"], view["cancelAtPeriodEnd"] = plan.PeriodEnd, plan.CancelAtPeriodEnd
		}
		out["plan"] = view
	}
	writeJSON(w, 200, out)
}

// recordUpgradeInterest answers POST /tenants/{tenantId}/upgrade-interest for any member: one row per
// person and workspace with everything they had used up whenever they asked, the daily total
// ("daily") or a route that offered calls today. The server counts it, so the list does not depend on
// how fresh a page was; a route closed with 0 never offered a call and is not recorded. A click within
// ten minutes of the last one is the same request (a double click, a retry), so clicks counts separate
// occasions, not presses.
func (a *App) recordUpgradeInterest(w http.ResponseWriter, r *http.Request) {
	if !a.decode(w, r, &struct{}{}) {
		return
	}
	tid, uid := r.PathValue("tenantId"), currentUser(r).ID
	daily, routes, _, _, e := a.routeUsageToday(r.Context(), tid, uid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	usedUp := []string{}
	if daily.Used >= daily.Limit {
		usedUp = append(usedUp, "daily")
	}
	for _, route := range []string{routeGate, routeBedrock, routeMedia} {
		if v, ok := routes[route]; ok && v.Limit > 0 && v.Used >= v.Limit {
			usedUp = append(usedUp, route)
		}
	}
	var clicks int
	if e := a.db.QueryRow(r.Context(), `INSERT INTO upgrade_interests(id,user_id,tenant_id,routes) VALUES($1,$2,$3,$4::text[])
		ON CONFLICT (user_id,tenant_id) DO UPDATE SET
		 clicks=upgrade_interests.clicks+CASE WHEN upgrade_interests.last_at<clock_timestamp()-interval '10 minutes' THEN 1 ELSE 0 END,
		 routes=ARRAY(SELECT DISTINCT x FROM unnest(upgrade_interests.routes||EXCLUDED.routes) x ORDER BY x),
		 last_at=clock_timestamp()
		RETURNING clicks`, randomID(), uid, tid, usedUp).Scan(&clicks); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"recorded": true, "clicks": clicks})
}

// The admin listing joins the person and the workspace so the list can be read and exported as it is.
// It pages on the first request's time, which never changes, so a later click cannot move a row
// between pages.
const upgradeInterestSource = `(SELECT i.id,i.created_at,i.last_at,i.clicks,i.routes,i.user_id,i.tenant_id,u.email,u.name AS user_name,t.name AS tenant_name
	FROM upgrade_interests i JOIN users u ON u.id=i.user_id JOIN tenants t ON t.id=i.tenant_id) x`

const upgradeInterestJSON = `jsonb_build_object('id',x.id,'userId',x.user_id,'email',x.email,'userName',x.user_name,'tenantId',x.tenant_id,'tenantName',x.tenant_name,'routes',to_jsonb(x.routes),'clicks',x.clicks,'createdAt',x.created_at,'lastAt',x.last_at)`
