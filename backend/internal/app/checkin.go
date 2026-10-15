package app

import (
	"context"
	"net/http"
	"time"
)

// Daily check-ins of the free-allowance promotion (promo.go). A member of a free workspace checks in once a UTC day; the
// check-in raises that workspace's allowances for the rest of the day by the promotion's bonus (todayAllowance), which
// is stored on the row so that a later setting never changes a day already given. One check-in per person and day and
// one per workspace and day (migration 029): a person in several workspaces, or several people in one, cannot stack
// bonuses.

// checkinDay is today's UTC date on the database's clock, the day every allowance counts from (todayUTC).
const checkinDay = `(clock_timestamp() AT TIME ZONE 'UTC')::date`

// checkinView is what the usage meter shows of check-ins: offered (available) or not, whether this person checked in
// this workspace today, another member did (taken) or this person did in another workspace (elsewhere), the bonus a
// check-in gives this workspace, what today's check-in of this workspace gave (today), the person's run of consecutive
// days and when check-ins end.
type checkinView struct {
	Available bool          `json:"available"`
	CheckedIn bool          `json:"checkedIn"`
	Taken     bool          `json:"taken,omitempty"`
	Elsewhere bool          `json:"elsewhere,omitempty"`
	Bonus     checkinBonus  `json:"bonus"`
	Today     *checkinBonus `json:"today,omitempty"`
	Streak    int           `json:"streak"`
	EndsAt    time.Time     `json:"endsAt"`
}

type checkinBonus struct {
	Daily int `json:"daily"`
	Media int `json:"media"`
}

// promoView is the promotion as one workspace gets it, for the meter's note (promoFor): its raised daily total and the
// routes the promotion raises, and when it ends; present while the promotion runs for a workspace it raises.
type promoView struct {
	Until  time.Time   `json:"until"`
	Daily  int         `json:"daily"`
	Routes routeLimits `json:"routes,omitempty"`
}

// checkinOffered reports whether a workspace may check in now: the promotion offers check-ins, the workspace is active,
// its stored allowances are the free plan's it raises, its owner has no paid plan (whose allowances are the account's)
// and no platform administrator owns it (whose workspaces have no free allowance to raise).
func (a *App) checkinOffered(ctx context.Context, q querier, tid, status string, daily int, raw []byte) (bool, error) {
	if !a.cfg.Promo.checkins(time.Now()) || status != "active" || !a.cfg.promoParticipant(daily, readRouteLimits(raw)) {
		return false, nil
	}
	plan, e := ownerPlan(ctx, q, tid, false)
	if e != nil || plan != nil {
		return false, e
	}
	operator, e := operatorWorkspace(ctx, q, tid)
	return !operator, e
}

// checkinToday is today's UTC date on the database's clock, read once per request so that every statement of a request
// that crosses midnight speaks of the same day.
func checkinToday(ctx context.Context, q querier) (time.Time, error) {
	var day time.Time
	err := q.QueryRow(ctx, `SELECT `+checkinDay).Scan(&day)
	return day, err
}

// checkinState reads the view for a person in a workspace on day; available is checkinOffered's answer and bonus what a
// check-in gives this workspace (checkinBonusFor).
func (a *App) checkinState(ctx context.Context, q querier, tid, uid string, day time.Time, available bool, bonus checkinBonus) (checkinView, error) {
	v := checkinView{Available: available, Bonus: bonus, EndsAt: a.cfg.Promo.Until}
	var mine, workspace, elsewhere bool
	var given checkinBonus
	if e := q.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM workspace_checkins WHERE tenant_id=$1 AND user_id=$2 AND day=$3::date),
		EXISTS(SELECT 1 FROM workspace_checkins WHERE tenant_id=$1 AND day=$3::date),
		EXISTS(SELECT 1 FROM workspace_checkins WHERE tenant_id<>$1 AND user_id=$2 AND day=$3::date),
		COALESCE((SELECT bonus_daily FROM workspace_checkins WHERE tenant_id=$1 AND day=$3::date),0),
		COALESCE((SELECT bonus_media FROM workspace_checkins WHERE tenant_id=$1 AND day=$3::date),0)`,
		tid, uid, day).Scan(&mine, &workspace, &elsewhere, &given.Daily, &given.Media); e != nil {
		return v, e
	}
	v.CheckedIn, v.Taken, v.Elsewhere = mine, workspace && !mine, elsewhere
	if workspace {
		v.Today = &given
	}
	// The run of consecutive days ends today, or yesterday when today's check-in is still to come.
	rows, e := q.Query(ctx, `SELECT day FROM workspace_checkins WHERE user_id=$1 AND day>$2::date-60 AND day<=$2::date ORDER BY day DESC`, uid, day)
	if e != nil {
		return v, e
	}
	defer rows.Close()
	var days []time.Time
	for rows.Next() {
		var d time.Time
		if e = rows.Scan(&d); e != nil {
			return v, e
		}
		days = append(days, d)
	}
	if e = rows.Err(); e != nil {
		return v, e
	}
	v.Streak = checkinStreak(days, day)
	return v, nil
}

// checkinStreak counts the consecutive days, newest first in days (one per day: a person has at most one check-in a
// day), that end today or yesterday.
func checkinStreak(days []time.Time, today time.Time) int {
	want := today
	if len(days) > 0 && !sameDay(days[0], today) {
		want = today.AddDate(0, 0, -1)
	}
	n := 0
	for _, d := range days {
		if !sameDay(d, want) {
			break
		}
		n++
		want = want.AddDate(0, 0, -1)
	}
	return n
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// checkIn answers POST /tenants/{tenantId}/checkin for a member (role member or above) while check-ins are offered to
// the workspace. A second press on the same day changes nothing and answers with the same state; a workspace another
// member already checked in today answers 409 checkin_taken, and a person who checked in another workspace today
// 409 checkin_elsewhere.
func (a *App) checkIn(w http.ResponseWriter, r *http.Request) {
	if !a.decode(w, r, &struct{}{}) {
		return
	}
	ctx := r.Context()
	tid, uid := r.PathValue("tenantId"), currentUser(r).ID
	tx, e := a.db.Begin(ctx)
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(context.Background())
	// The workspace row's lock orders this with every admission, which reads the check-in under the same lock; the
	// membership and the workspace's status are checked again under it, since the request may have waited for it.
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var daily int
	var raw []byte
	var status string
	if e = tx.QueryRow(ctx, "SELECT status,max_runs_per_day,route_limits FROM tenants WHERE id=$1", tid).Scan(&status, &daily, &raw); e != nil {
		a.dbError(w, e)
		return
	}
	offered, e := a.checkinOffered(ctx, tx, tid, status, daily, raw)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !offered {
		fail(w, 409, "checkin_unavailable", "This workspace has no check-ins now")
		return
	}
	day, e := checkinToday(ctx, tx)
	if e != nil {
		a.dbError(w, e)
		return
	}
	bonus := a.cfg.checkinBonusFor(readRouteLimits(raw))
	tag, e := tx.Exec(ctx, `INSERT INTO workspace_checkins(tenant_id,user_id,day,bonus_daily,bonus_media) VALUES($1,$2,$3::date,$4,$5) ON CONFLICT DO NOTHING`,
		tid, uid, day, bonus.Daily, bonus.Media)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if tag.RowsAffected() == 1 {
		if e = audit(ctx, tx, uid, tid, "workspace.checked_in", tid); e != nil {
			a.dbError(w, e)
			return
		}
	}
	v, e := a.checkinState(ctx, tx, tid, uid, day, true, bonus)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !v.CheckedIn {
		if v.Elsewhere {
			fail(w, 409, "checkin_elsewhere", "You already checked in another workspace today")
		} else {
			fail(w, 409, "checkin_taken", "Another member already checked in this workspace today")
		}
		return
	}
	if e = tx.Commit(ctx); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"checkin": v})
}
