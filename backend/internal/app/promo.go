package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// A free-allowance promotion (owner 2026-10-15: 「全面放开…每天签到就加送额度，维持2周」). Until AWWO_PROMO_UNTIL, every free
// workspace (route-limited with some route limited: not the operator's empty object, not one without route limits) has
// at least AWWO_PROMO_DAILY calls a day and at least AWWO_PROMO_ROUTE_LIMITS on each route it limits; the deployment-wide
// ceilings AWWO_PROMO_ROUTE_TOTAL_PER_DAY, AWWO_PROMO_MEDIA_TOTAL_RUNS_PER_DAY and AWWO_PROMO_TRIPO_FREE_TOTAL_PER_DAY raise
// their usual values; and the workspace's people may check in once a UTC day for AWWO_CHECKIN_BONUS more that day
// (checkin.go). A promotion only ever raises: a value below the usual one changes nothing.
//
// Nothing is written to a workspace. When the time passes, every allowance reads its stored value again, with no
// restart. A daily total an administrator set below the new-workspace default, a route allowance below it and a route
// closed with 0 are deliberate reductions and keep their values; such a workspace takes no part in check-ins either.
type promotion struct {
	Until time.Time
	// Daily and Routes are floors; 0 or absent raises nothing.
	Daily  int
	Routes routeLimits
	// RouteTotals, MediaTotal and TripoTotal raise the deployment-wide ceilings of the same names.
	RouteTotals            routeLimits
	MediaTotal, TripoTotal int
	// A check-in's bonus for the rest of its UTC day; both 0 offers no check-ins.
	CheckinDaily, CheckinMedia int
}

const (
	maxCheckinDaily = 100000
	maxCheckinMedia = 1000
)

var promoSettings = []string{"AWWO_PROMO_DAILY", "AWWO_PROMO_ROUTE_LIMITS", "AWWO_PROMO_ROUTE_TOTAL_PER_DAY",
	"AWWO_PROMO_MEDIA_TOTAL_RUNS_PER_DAY", "AWWO_PROMO_TRIPO_FREE_TOTAL_PER_DAY", "AWWO_CHECKIN_BONUS"}

func (c *Config) promoSettingsFromEnv() error {
	raw := os.Getenv("AWWO_PROMO_UNTIL")
	if raw == "" {
		for _, name := range promoSettings {
			if os.Getenv(name) != "" {
				return fmt.Errorf("%s needs AWWO_PROMO_UNTIL", name)
			}
		}
		return nil
	}
	until, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return errors.New("AWWO_PROMO_UNTIL must be an RFC 3339 time such as 2026-10-29T00:00:00Z")
	}
	p := promotion{Until: until.UTC()}
	whole := func(name string, max int) (int, error) {
		s := os.Getenv(name)
		if s == "" {
			return 0, nil
		}
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 || n > max {
			return 0, fmt.Errorf("%s must be a whole number from 0 to %d", name, max)
		}
		return n, nil
	}
	if p.Daily, err = whole("AWWO_PROMO_DAILY", 100000); err != nil {
		return err
	}
	if p.MediaTotal, err = whole("AWWO_PROMO_MEDIA_TOTAL_RUNS_PER_DAY", 1000000); err != nil {
		return err
	}
	if p.TripoTotal, err = whole("AWWO_PROMO_TRIPO_FREE_TOTAL_PER_DAY", 100000); err != nil {
		return err
	}
	if s := os.Getenv("AWWO_PROMO_ROUTE_LIMITS"); s != "" {
		if p.Routes, err = parseRouteSetting("AWWO_PROMO_ROUTE_LIMITS", s, maxRouteLimit); err != nil {
			return err
		}
	}
	if s := os.Getenv("AWWO_PROMO_ROUTE_TOTAL_PER_DAY"); s != "" {
		if p.RouteTotals, err = parseRouteSetting("AWWO_PROMO_ROUTE_TOTAL_PER_DAY", s, maxRouteTotal); err != nil {
			return err
		}
	}
	if s := os.Getenv("AWWO_CHECKIN_BONUS"); s != "" {
		if p.CheckinDaily, p.CheckinMedia, err = parseCheckinBonus(s); err != nil {
			return err
		}
	}
	c.Promo = p
	return nil
}

// parseCheckinBonus reads "daily=50,media=3"; either may be left out (0).
func parseCheckinBonus(raw string) (daily, media int, err error) {
	bad := fmt.Errorf("AWWO_CHECKIN_BONUS must be daily=<0-%d>,media=<0-%d>", maxCheckinDaily, maxCheckinMedia)
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		n, e := strconv.Atoi(value)
		if !ok || e != nil || n < 0 || seen[key] {
			return 0, 0, bad
		}
		seen[key] = true
		switch {
		case key == "daily" && n <= maxCheckinDaily:
			daily = n
		case key == "media" && n <= maxCheckinMedia:
			media = n
		default:
			return 0, 0, bad
		}
	}
	return daily, media, nil
}

// maxPromoDays bounds how far ahead a promotion may end when the API starts, so a mistyped year cannot open the free
// plan for a year unnoticed.
const maxPromoDays = 90

// The promotion's floors name worker model routes the way route limits do, so like them it needs operator credentials;
// and it tells a deliberately reduced workspace by the new-workspace defaults, so it needs those set.
func (c Config) validatePromoSettings() error {
	p := c.Promo
	if p.Until.IsZero() {
		return nil
	}
	if c.UserCredentials {
		return errors.New("AWWO_PROMO_UNTIL requires AWWO_CREDENTIAL_MODE=operator")
	}
	if c.NewWorkspaceRunsPerDay <= 0 || c.NewWorkspaceRouteLimits == nil {
		return errors.New("AWWO_PROMO_UNTIL requires AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY and AWWO_NEW_WORKSPACE_ROUTE_LIMITS, which tell a reduced workspace")
	}
	if p.Until.After(time.Now().AddDate(0, 0, maxPromoDays)) {
		return fmt.Errorf("AWWO_PROMO_UNTIL must be at most %d days ahead", maxPromoDays)
	}
	return nil
}

// active reports whether the promotion runs at now.
func (p promotion) active(now time.Time) bool { return !p.Until.IsZero() && now.Before(p.Until) }

// checkins reports whether check-ins are offered at now.
func (p promotion) checkins(now time.Time) bool {
	return p.active(now) && (p.CheckinDaily > 0 || p.CheckinMedia > 0)
}

// raise is a usual ceiling while the promotion runs: the promotion's when higher, unless the usual one is 0, which
// closes it (an operator's stop the promotion must not reopen).
func raise(usual, promo int) int {
	if usual <= 0 {
		return usual
	}
	return max(usual, promo)
}

// routeTotalsNow is RouteTotalsPerDay with the promotion's ceilings while it runs (raise): a route the usual ceilings
// leave uncapped stays so.
func (c Config) routeTotalsNow() routeLimits {
	if !c.Promo.active(time.Now()) || len(c.Promo.RouteTotals) == 0 {
		return c.RouteTotalsPerDay
	}
	out := routeLimits{}
	for route, ceiling := range c.RouteTotalsPerDay {
		out[route] = raise(ceiling, c.Promo.RouteTotals[route])
	}
	return out
}

// mediaTotalNow is MediaTotalRunsPerDay, raised by the promotion while it runs.
func (c Config) mediaTotalNow() int {
	if c.Promo.active(time.Now()) {
		return raise(c.MediaTotalRunsPerDay, c.Promo.MediaTotal)
	}
	return c.MediaTotalRunsPerDay
}

// tripoTotalNow is TripoFreeTotalPerDay, raised by the promotion while it runs.
func (c Config) tripoTotalNow() int {
	if c.Promo.active(time.Now()) {
		return raise(c.TripoFreeTotalPerDay, c.Promo.TripoTotal)
	}
	return c.TripoFreeTotalPerDay
}

// promoParticipant reports whether a workspace's stored allowances (its daily total and decoded route limits) are the
// free plan's that a promotion raises: route-limited with some route limited, and its daily total not reduced below the
// new-workspace default.
func (c Config) promoParticipant(daily int, limits routeLimits) bool {
	return len(limits) > 0 && daily >= c.NewWorkspaceRunsPerDay
}

// promoRaises reports whether the promotion raises one route of a participant's stored limits: a route it limits, open,
// and not reduced below the new-workspace default.
func (c Config) promoRaises(limits routeLimits, route string) bool {
	v, ok := limits[route]
	return ok && v > 0 && v >= c.NewWorkspaceRouteLimits[route]
}

// checkinBonusFor is what a check-in gives a participant with these stored limits: the bonus calls, and the bonus
// generations only where the promotion raises its media route (a closed or reduced one gets none, and is not told so).
func (c Config) checkinBonusFor(limits routeLimits) checkinBonus {
	b := checkinBonus{Daily: c.Promo.CheckinDaily}
	if c.promoRaises(limits, routeMedia) {
		b.Media = c.Promo.CheckinMedia
	}
	return b
}

// promoFor is the promotion as one participant gets it, without today's check-in: its daily total and the routes the
// promotion raises, at their raised values; for the meter's note.
func (c Config) promoFor(daily int, limits routeLimits) promoView {
	v := promoView{Until: c.Promo.Until, Daily: max(daily, c.Promo.Daily)}
	for route, floor := range c.Promo.Routes {
		if c.promoRaises(limits, route) {
			if v.Routes == nil {
				v.Routes = routeLimits{}
			}
			v.Routes[route] = max(limits[route], floor)
		}
	}
	return v
}

// todayAllowance is what a free workspace may use today (UTC): daily and raw are its stored daily total and route limits
// (the tenants columns, as the caller read them under its lock), raised to the promotion's floors while it runs and by
// the bonus of the workspace's check-in today. Any other workspace keeps its stored values, and so does every
// workspace once the promotion ends. Only a route the promotion raises (promoRaises) is raised; the returned routes are
// in the column's form, for the callers that decode them.
func (a *App) todayAllowance(ctx context.Context, q querier, tid string, daily int, raw []byte) (int, []byte, error) {
	p := a.cfg.Promo
	if !p.active(time.Now()) {
		return daily, raw, nil
	}
	limits := readRouteLimits(raw)
	if !a.cfg.promoParticipant(daily, limits) {
		return daily, raw, nil
	}
	view := a.cfg.promoFor(daily, limits)
	daily = view.Daily
	media := a.cfg.promoRaises(limits, routeMedia)
	for route, value := range view.Routes {
		limits[route] = value
	}
	if p.checkins(time.Now()) {
		var bonusDaily, bonusMedia int
		e := q.QueryRow(ctx, `SELECT bonus_daily,bonus_media FROM workspace_checkins WHERE tenant_id=$1 AND day=`+checkinDay, tid).Scan(&bonusDaily, &bonusMedia)
		if e != nil && !noRows(e) {
			return 0, nil, e
		}
		daily = min(daily+bonusDaily, maxRouteTotal)
		if media {
			limits[routeMedia] = min(limits[routeMedia]+bonusMedia, maxRouteLimit)
		}
	}
	column, _ := limits.column().(string)
	return daily, []byte(column), nil
}
