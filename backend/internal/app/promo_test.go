package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestPromoSettingsFromEnv(t *testing.T) {
	var none Config
	if err := none.promoSettingsFromEnv(); err != nil || !none.Promo.Until.IsZero() {
		t.Fatal("unset", none.Promo, err)
	}
	// Every other promotion setting needs the end time, so a promotion can never run without one.
	for _, name := range promoSettings {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "1")
			var c Config
			if err := c.promoSettingsFromEnv(); err == nil {
				t.Fatal(name, "accepted without AWWO_PROMO_UNTIL")
			}
		})
	}
	t.Setenv("AWWO_PROMO_UNTIL", "2026-10-29T08:00:00+08:00")
	t.Setenv("AWWO_PROMO_DAILY", "100")
	t.Setenv("AWWO_PROMO_ROUTE_LIMITS", "media=5")
	t.Setenv("AWWO_PROMO_ROUTE_TOTAL_PER_DAY", "gate=600,bedrock=60")
	t.Setenv("AWWO_PROMO_MEDIA_TOTAL_RUNS_PER_DAY", "400")
	t.Setenv("AWWO_PROMO_TRIPO_FREE_TOTAL_PER_DAY", "100")
	t.Setenv("AWWO_CHECKIN_BONUS", "daily=50,media=3")
	var c Config
	if err := c.promoSettingsFromEnv(); err != nil {
		t.Fatal(err)
	}
	want := promotion{Until: time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC), Daily: 100, Routes: routeLimits{routeMedia: 5},
		RouteTotals: routeLimits{routeGate: 600, routeBedrock: 60}, MediaTotal: 400, TripoTotal: 100, CheckinDaily: 50, CheckinMedia: 3}
	if !reflect.DeepEqual(c.Promo, want) || c.Promo.Until.Location() != time.UTC {
		t.Fatalf("settings %+v", c.Promo)
	}
	// It tells a reduced workspace by the new-workspace defaults, so it needs them; and it ends within 90 days.
	if err := c.validatePromoSettings(); err == nil {
		t.Fatal("a promotion accepted without the new-workspace defaults")
	}
	c.NewWorkspaceRunsPerDay, c.NewWorkspaceRouteLimits = 30, routeLimits{routeMedia: 1}
	c.Promo.Until = time.Now().Add(14 * 24 * time.Hour)
	if err := c.validatePromoSettings(); err != nil {
		t.Fatal(err)
	}
	c.Promo.Until = time.Now().AddDate(1, 0, 0)
	if err := c.validatePromoSettings(); err == nil {
		t.Fatal("a promotion a year long accepted")
	}
	c.Promo.Until = time.Now().Add(-time.Hour)
	if err := c.validatePromoSettings(); err != nil {
		t.Fatal("an ended promotion refused", err)
	}
	c.UserCredentials = true
	if err := c.validatePromoSettings(); err == nil {
		t.Fatal("a promotion accepted in personal-key mode")
	}
	for name, bad := range map[string]string{
		"AWWO_PROMO_UNTIL": "2026-10-29", "AWWO_PROMO_DAILY": "-1", "AWWO_PROMO_ROUTE_LIMITS": "chat=5",
		"AWWO_PROMO_ROUTE_TOTAL_PER_DAY": "media=x", "AWWO_PROMO_MEDIA_TOTAL_RUNS_PER_DAY": "1.5",
		"AWWO_PROMO_TRIPO_FREE_TOTAL_PER_DAY": "100001", "AWWO_CHECKIN_BONUS": "media=3,media=4",
	} {
		t.Run("bad "+name, func(t *testing.T) {
			t.Setenv(name, bad)
			var c Config
			if err := c.promoSettingsFromEnv(); err == nil {
				t.Fatal("accepted", name, bad)
			}
		})
	}
	for _, bad := range []string{"daily", "daily=", "daily=-1", "daily=100001", "media=1001", "credits=5", "daily=1,", "=1"} {
		if _, _, err := parseCheckinBonus(bad); err == nil {
			t.Fatal("bonus accepted", bad)
		}
	}
	if d, m, err := parseCheckinBonus(" media=3 "); err != nil || d != 0 || m != 3 {
		t.Fatal("a bonus of media alone", d, m, err)
	}
}

// The promotion's ceilings only raise the usual ones, never lower one or cap a route the usual ones leave uncapped,
// and they end with it.
func TestPromoCeilingsOnlyRaise(t *testing.T) {
	c := Config{RouteTotalsPerDay: routeLimits{routeGate: 300, routeMedia: 500}}
	c.MediaTotalRunsPerDay, c.TripoFreeTotalPerDay = 100, 40
	c.Promo = promotion{Until: time.Now().Add(time.Hour), RouteTotals: routeLimits{routeGate: 600, routeBedrock: 60, routeMedia: 100},
		MediaTotal: 400, TripoTotal: 30}
	if got := c.routeTotalsNow(); !reflect.DeepEqual(got, routeLimits{routeGate: 600, routeMedia: 500}) {
		t.Fatal("route ceilings", got)
	}
	if c.mediaTotalNow() != 400 || c.tripoTotalNow() != 40 {
		t.Fatal("generation ceilings", c.mediaTotalNow(), c.tripoTotalNow())
	}
	c.Promo.Until = time.Now().Add(-time.Second)
	if got := c.routeTotalsNow(); !reflect.DeepEqual(got, c.RouteTotalsPerDay) || c.mediaTotalNow() != 100 || c.tripoTotalNow() != 40 {
		t.Fatal("ceilings after the promotion", got, c.mediaTotalNow(), c.tripoTotalNow())
	}
	// A usual ceiling of 0 is an operator's stop: the promotion does not reopen it.
	c.Promo.Until = time.Now().Add(time.Hour)
	c.RouteTotalsPerDay, c.MediaTotalRunsPerDay, c.TripoFreeTotalPerDay = routeLimits{routeGate: 0, routeMedia: 500}, 0, 0
	if got := c.routeTotalsNow(); !reflect.DeepEqual(got, routeLimits{routeGate: 0, routeMedia: 500}) || c.mediaTotalNow() != 0 || c.tripoTotalNow() != 0 {
		t.Fatal("closed ceilings reopened", got, c.mediaTotalNow(), c.tripoTotalNow())
	}
	var off Config
	off.RouteTotalsPerDay = routeLimits{routeGate: 3}
	if got := off.routeTotalsNow(); !reflect.DeepEqual(got, routeLimits{routeGate: 3}) {
		t.Fatal("no promotion", got)
	}
}

func TestCheckinStreak(t *testing.T) {
	day := func(d int) time.Time { return time.Date(2026, 10, d, 0, 0, 0, 0, time.UTC) }
	today := day(20)
	for name, tc := range map[string]struct {
		days []time.Time
		want int
	}{
		"none":                     {nil, 0},
		"today only":               {[]time.Time{day(20)}, 1},
		"today and two before":     {[]time.Time{day(20), day(19), day(18), day(16)}, 3},
		"yesterday's run is alive": {[]time.Time{day(19), day(18)}, 2},
		"a gap ends it":            {[]time.Time{day(18), day(17)}, 0},
	} {
		if got := checkinStreak(tc.days, today); got != tc.want {
			t.Fatal(name, got, "want", tc.want)
		}
	}
}

// promoHarness is a deployment whose free plan is 30 calls and one generation a day, with a promotion running.
func promoHarness(t *testing.T, h *harness) {
	t.Helper()
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	h.a.cfg.NewWorkspaceRunsPerDay = 30
	h.a.cfg.NewWorkspaceRouteLimits = routeLimits{routeMedia: 1}
	h.a.cfg.Promo = promotion{Until: time.Now().Add(time.Hour), Daily: 100, Routes: routeLimits{routeMedia: 5}, CheckinDaily: 50, CheckinMedia: 3}
}

func setLimits(t *testing.T, h *harness, tid string, daily int, routes string) {
	t.Helper()
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_runs_per_day=$2,route_limits=$3::jsonb WHERE id=$1", tid, daily, nullIfEmpty(routes)); e != nil {
		t.Fatal(e)
	}
}

func TestPostgresPromotionRaisesFreeWorkspacesAndCheckins(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	promoHarness(t, h)
	ca, ta, _ := h.register(t, "promo-a@example.test")
	cb, tb, _ := h.register(t, "promo-reduced@example.test")
	cc, tc, _ := h.register(t, "promo-closed@example.test")
	cd, td, _ := h.register(t, "promo-unlimited@example.test")
	setLimits(t, h, ta, 30, `{"media":1}`)
	setLimits(t, h, tb, 5, `{"media":1}`)
	setLimits(t, h, tc, 30, `{"media":0}`)
	setLimits(t, h, td, 30, "")
	usage := func(c *http.Cookie, tid string) map[string]any {
		t.Helper()
		return h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)
	}
	limits := func(u map[string]any) (float64, any) {
		t.Helper()
		var media any
		if routes, ok := u["routes"].(map[string]any); ok {
			media = routes["media"].(map[string]any)["limit"]
		}
		return u["daily"].(map[string]any)["limit"].(float64), media
	}
	// The free plan's workspace is raised to the floors and is offered a check-in.
	u := usage(ca, ta)
	if d, m := limits(u); d != 100 || m != 5.0 {
		t.Fatal("raised limits", d, m)
	}
	promo, _ := u["promo"].(map[string]any)
	checkin, _ := u["checkin"].(map[string]any)
	if promo == nil || promo["daily"] != 100.0 || !reflect.DeepEqual(promo["routes"], map[string]any{"media": 5.0}) || promo["until"] == nil ||
		checkin == nil || checkin["available"] != true || checkin["checkedIn"] != false || checkin["streak"] != 0.0 ||
		!reflect.DeepEqual(checkin["bonus"], map[string]any{"daily": 50.0, "media": 3.0}) || checkin["today"] != nil {
		t.Fatal("promotion and check-in in the meter", u)
	}
	// A daily total an administrator reduced, a route closed with 0 and a workspace without route limits keep their
	// values; only the first is still route-limited, and none is offered a check-in.
	if u = usage(cb, tb); u["promo"] != nil || u["checkin"] != nil {
		t.Fatal("a reduced workspace in the promotion", u)
	} else if d, m := limits(u); d != 5 || m != 1.0 {
		t.Fatal("a reduced workspace raised", d, m)
	}
	if u = usage(cc, tc); u["checkin"] == nil {
		t.Fatal("a workspace with media closed is still free", u)
	} else if d, m := limits(u); d != 100 || m != 0.0 {
		t.Fatal("a route closed with 0 raised", d, m)
	} else if c := u["checkin"].(map[string]any); !reflect.DeepEqual(c["bonus"], map[string]any{"daily": 50.0, "media": 0.0}) ||
		u["promo"].(map[string]any)["routes"] != nil {
		t.Fatal("a closed media route offered generations", u["checkin"], u["promo"])
	}
	h.request(t, cc, "POST", "/tenants/"+tc+"/checkin", map[string]any{}, 200)
	if u = usage(cc, tc); !reflect.DeepEqual(u["checkin"].(map[string]any)["today"], map[string]any{"daily": 50.0, "media": 0.0}) {
		t.Fatal("a closed media route's check-in", u["checkin"])
	} else if d, m := limits(u); d != 150 || m != 0.0 {
		t.Fatal("limits after a closed media route's check-in", d, m)
	}
	// A suspended workspace is offered no check-in.
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET status='suspended' WHERE id=$1", tc); e != nil {
		t.Fatal(e)
	}
	if u = usage(cc, tc); u["checkin"] != nil {
		t.Fatal("a suspended workspace offered a check-in", u)
	}
	if u = usage(cd, td); u["limited"] != false || u["promo"] != nil || u["checkin"] != nil {
		t.Fatal("an unlimited workspace in the promotion", u)
	}
	h.request(t, cb, "POST", "/tenants/"+tb+"/checkin", map[string]any{}, 409)
	h.request(t, cd, "POST", "/tenants/"+td+"/checkin", map[string]any{}, 409)

	// Checking in adds the bonus for the rest of the day; a second press changes nothing.
	v := h.request(t, ca, "POST", "/tenants/"+ta+"/checkin", map[string]any{}, 200)["checkin"].(map[string]any)
	if v["checkedIn"] != true || v["streak"] != 1.0 || !reflect.DeepEqual(v["today"], map[string]any{"daily": 50.0, "media": 3.0}) {
		t.Fatal("check-in", v)
	}
	if again := h.request(t, ca, "POST", "/tenants/"+ta+"/checkin", map[string]any{}, 200)["checkin"]; !reflect.DeepEqual(again, v) {
		t.Fatal("a second press", again)
	}
	if d, m := limits(usage(ca, ta)); d != 150 || m != 8.0 {
		t.Fatal("limits after the check-in", d, m)
	}
	var rows, audits int
	_ = h.db.QueryRow(context.Background(), "SELECT count(*) FROM workspace_checkins WHERE tenant_id=$1", ta).Scan(&rows)
	_ = h.db.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='workspace.checked_in'", ta).Scan(&audits)
	if rows != 1 || audits != 1 {
		t.Fatal("stored check-ins", rows, audits)
	}

	// One check-in per workspace and day: another member sees it taken; and one per person and day.
	cx, tx, _ := h.register(t, "promo-member@example.test")
	setLimits(t, h, tx, 30, `{"media":1}`)
	if _, e := h.db.Exec(context.Background(), "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'member' FROM users WHERE email='promo-member@example.test'", ta); e != nil {
		t.Fatal(e)
	}
	if got := h.request(t, cx, "POST", "/tenants/"+ta+"/checkin", map[string]any{}, 409); errorCode(got) != "checkin_taken" {
		t.Fatal("a second member's check-in", got)
	}
	if c := usage(cx, ta)["checkin"].(map[string]any); c["taken"] != true || c["checkedIn"] != false {
		t.Fatal("taken in the meter", c)
	}
	h.request(t, cx, "POST", "/tenants/"+tx+"/checkin", map[string]any{}, 200)
	if _, e := h.db.Exec(context.Background(), "DELETE FROM workspace_checkins WHERE tenant_id=$1", ta); e != nil {
		t.Fatal(e)
	}
	if got := h.request(t, cx, "POST", "/tenants/"+ta+"/checkin", map[string]any{}, 409); errorCode(got) != "checkin_elsewhere" {
		t.Fatal("a person's second workspace the same day", got)
	}
	if c := usage(cx, ta)["checkin"].(map[string]any); c["elsewhere"] != true {
		t.Fatal("elsewhere in the meter", c)
	}
	// A reader neither checks in nor is offered it; another workspace's check-in is not reachable.
	cr, _, _ := h.register(t, "promo-reader@example.test")
	if _, e := h.db.Exec(context.Background(), "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'reader' FROM users WHERE email='promo-reader@example.test'", ta); e != nil {
		t.Fatal(e)
	}
	h.request(t, cr, "POST", "/tenants/"+ta+"/checkin", map[string]any{}, 403)
	if u = usage(cr, ta); u["checkin"] != nil || u["promo"] == nil {
		t.Fatal("a reader's meter", u)
	}
	h.request(t, cb, "POST", "/tenants/"+ta+"/checkin", map[string]any{}, 404)

	// Admission holds the raised daily total: the floor, then the floor plus the bonus.
	h.a.cfg.Promo.Daily, h.a.cfg.Promo.CheckinDaily = 3, 2
	h.a.cfg.NewWorkspaceRunsPerDay = 1
	rid := routeHarnessRun(t, h, ca, ta, `{"media":1}`)
	setLimits(t, h, ta, 1, `{"media":1}`)
	for i := 0; i < 3; i++ {
		if e := reserveModel(h, ta, rid, "qwen3.8-27b-p6"); e != nil {
			t.Fatal("within the promotion's floor", i, e)
		}
	}
	if e := reserveModel(h, ta, rid, "qwen3.8-27b-p6"); !errors.Is(e, errInvocationQuota) {
		t.Fatal("past the floor", e)
	}
	h.request(t, ca, "POST", "/tenants/"+ta+"/checkin", map[string]any{}, 200)
	for i := 0; i < 2; i++ {
		if e := reserveModel(h, ta, rid, "qwen3.8-27b-p6"); e != nil {
			t.Fatal("within the check-in's bonus", i, e)
		}
	}
	if e := reserveModel(h, ta, rid, "qwen3.8-27b-p6"); !errors.Is(e, errInvocationQuota) {
		t.Fatal("past the bonus", e)
	}

	// When the promotion ends every workspace reads its stored values again, and no check-in is offered.
	h.a.cfg.Promo.Until = time.Now().Add(-time.Second)
	if u = usage(ca, ta); u["promo"] != nil || u["checkin"] != nil {
		t.Fatal("the promotion after its end", u)
	} else if d, m := limits(u); d != 1 || m != 1.0 {
		t.Fatal("limits after the promotion", d, m)
	}
	if got := h.request(t, cx, "POST", "/tenants/"+tx+"/checkin", map[string]any{}, 409); errorCode(got) != "checkin_unavailable" {
		t.Fatal("a check-in after the promotion", got)
	}
	if e := reserveModel(h, ta, rid, "qwen3.8-27b-p6"); !errors.Is(e, errInvocationQuota) {
		t.Fatal("the stored daily total after the promotion", e)
	}
}

// A paid plan's workspace and the operator's own are outside check-ins: neither has a free allowance to raise.
func TestPostgresCheckinsLeavePlansAndTheOperatorAlone(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	promoHarness(t, h)
	cp, tp, up := h.register(t, "promo-plan@example.test")
	setLimits(t, h, tp, 30, `{"media":1}`)
	if _, e := h.db.Exec(context.Background(), `INSERT INTO user_plans(user_id,plan,status,period_start,period_end,credits) VALUES($1,'pro','active',now()-interval '1 day',now()+interval '29 days',2000)`, up); e != nil {
		t.Fatal(e)
	}
	if u := h.request(t, cp, "GET", "/tenants/"+tp+"/route-usage", nil, 200); u["checkin"] != nil || u["promo"] != nil {
		t.Fatal("a plan workspace offered a check-in", u)
	}
	h.request(t, cp, "POST", "/tenants/"+tp+"/checkin", map[string]any{}, 409)
	co, to, uo := h.register(t, "promo-operator@example.test")
	setLimits(t, h, to, 30, `{"media":1}`)
	if _, e := h.db.Exec(context.Background(), "UPDATE users SET platform_role='admin' WHERE id=$1", uo); e != nil {
		t.Fatal(e)
	}
	if u := h.request(t, co, "GET", "/tenants/"+to+"/route-usage", nil, 200); u["checkin"] != nil {
		t.Fatal("the operator's workspace offered a check-in", u)
	}
	h.request(t, co, "POST", "/tenants/"+to+"/checkin", map[string]any{}, 409)
}

// The promotion's media floor and a check-in's media bonus hold image and video generations at admission.
func TestPostgresPromotionMediaAllowance(t *testing.T) {
	h, _ := newMediaHarness(t)
	promoHarness(t, h)
	h.a.cfg.Promo.Routes, h.a.cfg.Promo.CheckinMedia = routeLimits{routeMedia: 2}, 1
	c, tid, _ := h.register(t, "promo-media@example.test")
	setLimits(t, h, tid, 30, `{"media":1}`)
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	for i := 0; i < 2; i++ {
		run := h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
		awaitRunRow(t, h, tid, run["id"].(string), "completed")
	}
	if got := h.mediaRun(t, c, tid, sid, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("past the promotion's media floor", got)
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/checkin", map[string]any{}, 200)
	run := h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "completed")
	if got := h.mediaRun(t, c, tid, sid, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("past the check-in's media bonus", got)
	}
	// The promotion's ceiling for every free generation raises the usual one while it runs.
	h.a.cfg.MediaTotalRunsPerDay, h.a.cfg.Promo.MediaTotal = 3, 10
	setLimits(t, h, tid, 30, `{"media":9}`)
	run = h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "completed")
	h.a.cfg.Promo.MediaTotal = 0
	if got := h.mediaRun(t, c, tid, sid, "a cat in a hat", 429); errorCode(got) != "media_capacity_exceeded" {
		t.Fatal("the usual ceiling without the promotion's", got)
	}
}

// A generation the provider never took (refused, or never sent) costs nothing and gives its attempt back; one it
// accepted counts even if it failed or was refunded later, and one under way counts so concurrent admissions hold.
func TestPostgresRefusedGenerationGivesItsAttemptBack(t *testing.T) {
	h, rh := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-refused@example.test")
	setLimits(t, h, tid, 30, `{"media":1}`)
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	meter := func() (media, daily float64) {
		t.Helper()
		u := h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)
		return u["routes"].(map[string]any)["media"].(map[string]any)["used"].(float64), u["daily"].(map[string]any)["used"].(float64)
	}
	rh.set(func(int) (int, any) { return 401, nil }, nil)
	for i := 0; i < 2; i++ {
		run := h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
		if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_provider_unauthorized" {
			t.Fatal("refusal", code)
		}
	}
	if media, daily := meter(); media != 0 || daily != 0 {
		t.Fatal("refused generations still counted", media, daily)
	}
	rh.set(func(n int) (int, any) { return 200, map[string]any{"taskId": "task-ok", "status": "QUEUED"} }, nil)
	run := h.mediaRun(t, c, tid, sid, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "completed")
	if media, daily := meter(); media != 1 || daily != 1 {
		t.Fatal("an accepted generation", media, daily)
	}
	if got := h.mediaRun(t, c, tid, sid, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("the allowance after an accepted generation", got)
	}
	// A refunded or later-failed generation the provider accepted still counts; one under way counts.
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(context.Background(), sql, args...); e != nil {
			t.Fatal(sql, e)
		}
	}
	queued := randomID()
	exec("INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p','queued')", queued, tid, sid, "q-"+queued)
	exec("INSERT INTO media_generations(run_id,tenant_id,model) VALUES($1,$2,'rh.seedream-v5-pro')", queued, tid)
	exec("INSERT INTO media_generations(run_id,tenant_id,model,provider_accepted) VALUES($1,$2,'rh.seedream-v5-pro',false)", randomID(), tid)
	if media, daily := meter(); media != 3 || daily != 3 {
		t.Fatal("refunded and queued generations", media, daily)
	}
	// The run that held the queued one ends before it was sent: that attempt is back too.
	exec("UPDATE runs SET status='cancelled' WHERE id=$1", queued)
	if media, daily := meter(); media != 2 || daily != 2 {
		t.Fatal("a generation cancelled before it was sent", media, daily)
	}
	// One sent whose outcome is unknown (cancelled, timed out or lost while in flight) keeps counting; a refused one
	// does not, even though it was sent.
	exec("UPDATE media_generations SET submitted_at=now() WHERE run_id=$1", queued)
	if media, daily := meter(); media != 3 || daily != 3 {
		t.Fatal("a generation cancelled while in flight", media, daily)
	}
	exec("UPDATE media_generations SET provider_refused=true WHERE run_id=$1", queued)
	if media, daily := meter(); media != 2 || daily != 2 {
		t.Fatal("a refused generation", media, daily)
	}
	var refused, sent int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FILTER (WHERE provider_refused),count(*) FILTER (WHERE submitted_at IS NOT NULL) FROM media_generations WHERE tenant_id=$1", tid).Scan(&refused, &sent); e != nil {
		t.Fatal(e)
	}
	// The two refusals and the accepted generation were marked sent before their requests; the refusals as refused.
	if refused != 3 || sent != 4 {
		t.Fatal("marked generations", refused, sent)
	}
}

// Only a provider's own refusal of a submission is one that created no task: not a transient answer, which may be sent
// again, and not a failure to read a successful answer, which may hide a task.
func TestRefusedAnswerMarksOnlyDefiniteRefusals(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		want bool
	}{
		"refused":      {&rhError{Code: "media_provider_unauthorized"}, true},
		"balance":      {&rhError{Code: "media_provider_balance"}, true},
		"model gone":   {&rhError{Code: "media_provider_unavailable"}, true},
		"content":      {&rhError{Code: "media_content_rejected"}, false},
		"params":       {&rhError{Code: "media_params_invalid"}, false},
		"transient":    {&rhError{Code: "media_provider_busy", Transient: true}, false},
		"not provider": {context.DeadlineExceeded, false},
		"none":         {nil, false},
	} {
		got := refusedAnswer(tc.err)
		e, ok := asRHError(got)
		if (ok && e.Refused) != tc.want || !errors.Is(got, tc.err) && tc.err != nil {
			t.Fatal(name, got)
		}
	}
	// X-tasy: an error status refuses the submission, unless it is one to send again; a 2xx answer never does.
	if e, _ := asRHError(refusedAnswer(xtasyHTTPError(404, []byte(`{"error":{"code":"MODEL_NOT_FOUND"}}`)))); !e.Refused {
		t.Fatal("model not found")
	}
	if e, _ := asRHError(refusedAnswer(xtasyHTTPError(503, nil))); e.Refused {
		t.Fatal("a 503 marked refused")
	}
}

// A refusal of a resend gives nothing back: an earlier send whose answer never arrived may have made the task.
func TestSubmitMediaRefusalAfterAResendStillCounts(t *testing.T) {
	refused := func() error { return refusedAnswer(&rhError{Code: "media_provider_unauthorized"}) }
	lost := func() error {
		return xtasyResendable(&rhError{Code: "media_provider_unavailable", Transient: true}, time.Millisecond)
	}
	first := &fakeMediaProvider{answers: []error{refused()}}
	if _, err := submitMedia(context.Background(), first, "/x", map[string]any{}, func() {}); err == nil || !err.(*rhError).Refused || first.calls != 1 {
		t.Fatal("a refusal of the first send", err, first.calls)
	}
	again := &fakeMediaProvider{answers: []error{lost(), refused()}}
	if _, err := submitMedia(context.Background(), again, "/x", map[string]any{}, func() {}); err == nil || err.(*rhError).Refused || again.calls != 2 ||
		mediaFailureCode(err) != "media_provider_unauthorized" {
		t.Fatal("a refusal after a resend", err, again.calls)
	}
}

// RunningHub refuses a submission with 200 and an error code: only its flat answer that names no task, with an
// operator-side code, is a refusal that gives the attempt back; an answer with a task, a wrapped one, a refusal of the
// request itself and any answer to a poll keep the generation counted.
func TestRunningHubFlatRefusalsAreRefusals(t *testing.T) {
	// RunningHub's own answer to a bad key, as seen on 2026-10-15, with another code where a case needs one.
	flat := func(code string) string {
		return `{"taskId":"","status":"","errorCode":"` + code + `","errorMessage":"x","results":null,"clientId":"c","promptTips":"","failedReason":{},"usage":null}`
	}
	answers := map[string]string{
		"/openapi/v2/balance":     flat("812"),
		"/openapi/v2/key":         flat("806"),
		"/openapi/v2/spaced":      " \n" + flat("416") + "\n",
		"/openapi/v2/prompt":      flat("1007"),
		"/openapi/v2/busy":        flat("1003"),
		"/openapi/v2/task":        `{"taskId":"task-9","status":"FAILED","errorCode":"812"}`,
		"/openapi/v2/wrapped":     `{"code":812,"msg":"x","data":{"taskId":""}}`,
		"/openapi/v2/results":     `{"taskId":"","status":"","errorCode":"812","results":[{"url":"https://files.runninghub.ai/a.png"}]}`,
		"/openapi/v2/no-field":    `{"status":"","errorCode":"812"}`,
		"/openapi/v2/no-status":   `{"taskId":"","errorCode":"812"}`,
		"/openapi/v2/running":     `{"taskId":"","status":"RUNNING","errorCode":"812","results":null}`,
		"/openapi/v2/queued":      `{"taskId":"","status":"QUEUED","errorCode":"812"}`,
		"/openapi/v2/case":        `{"taskId":"","TaskId":"task-9","status":"FAILED","errorCode":"812"}`,
		"/openapi/v2/repeated":    `{"taskId":"task-9","taskId":"","status":"","errorCode":"812"}`,
		"/openapi/v2/folded":      "{\"ta\u017fkId\":\"task-9\",\"taskId\":\"\",\"status\":\"\",\"errorCode\":\"812\"}",
		"/openapi/v2/null-id":     `{"taskId":null,"status":"","errorCode":"812"}`,
		"/openapi/v2/blank-id":    `{"taskId":" ","status":"","errorCode":"812"}`,
		"/openapi/v2/number-id":   `{"taskId":0,"status":"","errorCode":"812"}`,
		"/openapi/v2/trailing":    flat("812") + `{}`,
		"/openapi/v2/null-code":   `{"taskId":"","status":"","errorCode":null,"code":812}`,
		"/openapi/v2/data-object": `{"taskId":"","status":"","errorCode":"812","data":{}}`,
		"/openapi/v2/query":       flat("806"),
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(answers[r.URL.Path]))
	}))
	defer api.Close()
	h := &runningHub{base: api.URL, key: "secret-key-0123456789", api: api.Client(), hosts: []string{".runninghub.ai"}, maxFile: 1 << 20}
	refused := map[string]bool{"/openapi/v2/balance": true, "/openapi/v2/key": true, "/openapi/v2/spaced": true}
	for path := range answers {
		if path == "/openapi/v2/query" {
			continue
		}
		_, err := h.submit(context.Background(), path, map[string]any{"prompt": "p"})
		e, ok := asRHError(err)
		if !ok || e.Refused != refused[path] {
			t.Errorf("%s: %v (refused %v), want refused %v", path, err, ok && e.Refused, refused[path])
		}
	}
	for path, code := range map[string]string{"/openapi/v2/balance": "media_provider_balance", "/openapi/v2/key": "media_provider_unauthorized",
		"/openapi/v2/prompt": "media_params_invalid", "/openapi/v2/busy": "media_provider_busy"} {
		if _, err := h.submit(context.Background(), path, map[string]any{"prompt": "p"}); mediaFailureCode(err) != code {
			t.Errorf("%s: %v, want %s", path, err, code)
		}
	}
	if _, err := h.query(context.Background(), "task-1"); err == nil {
		t.Fatal("a poll's refusal passed")
	} else if e, _ := asRHError(err); e == nil || e.Refused {
		t.Fatal("a poll's answer marked refused", err)
	}
}

// A run cancelled before its generation was marked sent is not sent at all; one marked sent counts.
func TestPostgresMarkMediaSubmittedHonoursACancel(t *testing.T) {
	h, _ := newMediaHarness(t)
	c, tid, _ := h.register(t, "media-mark@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(context.Background(), sql, args...); e != nil {
			t.Fatal(sql, e)
		}
	}
	for status, want := range map[string]error{"running": nil, "cancelled": errMediaRunEnded} {
		rid := randomID()
		exec("INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p',$5)", rid, tid, sid, "m-"+rid, status)
		exec("INSERT INTO media_generations(run_id,tenant_id,model) VALUES($1,$2,'rh.seedream-v5-pro')", rid, tid)
		if e := h.a.markMediaSubmitted(context.Background(), tid, rid); !errors.Is(e, want) {
			t.Fatal(status, e)
		}
		var sent bool
		if e := h.db.QueryRow(context.Background(), "SELECT submitted_at IS NOT NULL FROM media_generations WHERE run_id=$1", rid).Scan(&sent); e != nil || sent != (want == nil) {
			t.Fatal(status, "marked", sent, e)
		}
		exec("UPDATE runs SET status='completed' WHERE id=$1", rid)
	}
	// A run without its generation row is never sent either.
	rid := randomID()
	exec("INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p','running')", rid, tid, sid, "m-"+rid)
	if e := h.a.markMediaSubmitted(context.Background(), tid, rid); e == nil {
		t.Fatal("a run without its generation row marked sent")
	}
}

// A media limit an administrator reduced below the new-workspace default takes neither the promotion's floor nor a
// check-in's media bonus; the workspace's daily total still takes both.
func TestPostgresPromotionLeavesAReducedMediaLimit(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	promoHarness(t, h)
	h.a.cfg.NewWorkspaceRouteLimits = routeLimits{routeMedia: 5}
	c, tid, _ := h.register(t, "promo-media-reduced@example.test")
	setLimits(t, h, tid, 30, `{"media":1}`)
	h.request(t, c, "POST", "/tenants/"+tid+"/checkin", map[string]any{}, 200)
	u := h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)
	if u["daily"].(map[string]any)["limit"] != 150.0 || u["routes"].(map[string]any)["media"].(map[string]any)["limit"] != 1.0 ||
		u["checkin"].(map[string]any)["bonus"].(map[string]any)["media"] != 0.0 || u["promo"].(map[string]any)["routes"] != nil {
		t.Fatal("a reduced media limit raised", u)
	}
}
