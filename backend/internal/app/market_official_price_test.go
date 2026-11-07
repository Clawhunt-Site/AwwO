package app

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"testing"
	"time"
)

func TestMarketOfficialPriceSettings(t *testing.T) {
	from := time.Date(2026, 11, 12, 16, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		price, from string
		want        int
		wantFrom    time.Time
		ok          bool
	}{
		{"", "", 0, time.Time{}, true},
		{"0", "", 0, time.Time{}, true},
		{" 5 ", "", 5, time.Time{}, true},
		{"5", "2026-11-13T00:00:00+08:00", 5, from, true},
		{"500", "", 500, time.Time{}, true},
		{"501", "", 0, time.Time{}, false},
		{"-1", "", 0, time.Time{}, false},
		{"1.5", "", 0, time.Time{}, false},
		{"", "2026-11-12T16:00:00Z", 0, time.Time{}, false},
		{"0", "2026-11-12T16:00:00Z", 0, time.Time{}, false},
		{"5", "2026-11-12", 0, time.Time{}, false},
	} {
		price, at, err := parseMarketOfficialPrice(c.price, c.from, 500)
		if (err == nil) != c.ok || price != c.want || !at.Equal(c.wantFrom) || (!at.IsZero() && at.Location() != time.UTC) {
			t.Fatal(c.price, c.from, price, at, err)
		}
	}
	// The price is bounded by the highest an author may set, read from the same settings.
	t.Setenv("AWWO_MARKET_MAX_PRICE", "50")
	t.Setenv("AWWO_MARKET_OFFICIAL_PRICE", "60")
	var c Config
	if err := c.marketSettingsFromEnv(); err == nil {
		t.Fatal("an official price above AWWO_MARKET_MAX_PRICE accepted")
	}
	t.Setenv("AWWO_MARKET_OFFICIAL_PRICE", "5")
	t.Setenv("AWWO_MARKET_OFFICIAL_PRICE_FROM", "2026-11-12T16:00:00Z")
	if err := c.marketSettingsFromEnv(); err != nil || c.MarketOfficialPrice != 5 || !c.MarketOfficialPriceFrom.Equal(from) {
		t.Fatal("the official price", c.MarketOfficialPrice, c.MarketOfficialPriceFrom, err)
	}
}

func TestMarketOfficialPriceStartsAtItsMoment(t *testing.T) {
	from := time.Date(2026, 11, 12, 16, 0, 0, 0, time.UTC)
	var c Config
	c.MarketOfficialPrice, c.MarketOfficialPriceFrom = 5, from
	if c.marketOfficialPriceAt(from.Add(-time.Nanosecond)) != 0 || c.marketOfficialPriceAt(from) != 5 || c.marketOfficialPriceAt(from.AddDate(0, 1, 0)) != 5 {
		t.Fatal("the official price starts at its moment")
	}
	official, authored := marketAgentRow{Official: true}, marketAgentRow{}
	if c.marketPriceAt(official, marketVersion{}, from) != 5 || c.marketPriceAt(authored, marketVersion{Price: 7}, from) != 7 ||
		c.marketPriceAt(official, marketVersion{}, from.Add(-time.Second)) != 0 {
		t.Fatal("an official Agent's price is the official one; an author's is its version's")
	}
	c.MarketOfficialPriceFrom = time.Time{}
	if c.marketOfficialPriceAt(time.Time{}) != 5 || (Config{}).marketOfficialPriceAt(from) != 0 {
		t.Fatal("without a start the price applies at once; without a price there is none")
	}
	// The capability says what is coming only where there is a price, and when only where it has a start.
	a := New(nil, testConfig())
	if m := a.marketCapability(); m["officialPrice"] != nil || m["officialPriceFrom"] != nil {
		t.Fatal("unset", m)
	}
	a.cfg.MarketOfficialPrice = 5
	if m := a.marketCapability(); m["officialPrice"] != 5 || m["officialPriceFrom"] != nil {
		t.Fatal("a price at once", m)
	}
	a.cfg.MarketOfficialPriceFrom = from.In(time.FixedZone("CST", 8*3600))
	m := a.marketCapability()
	if at, _ := m["officialPriceFrom"].(time.Time); m["officialPrice"] != 5 || !at.Equal(from) || at.Location() != time.UTC {
		t.Fatal("a price from a moment, said in UTC", m)
	}
}

// officialCall is the market call of run rid as stored: its price, settlement, fee, author and who it was billed to.
func officialCall(t *testing.T, h *harness, rid string) (price int, settlement string, fee int, author, billed *string) {
	t.Helper()
	if err := h.db.QueryRow(context.Background(), "SELECT price_credits,settlement,fee_bps,author_user_id,billed_user_id FROM market_agent_calls WHERE run_id=$1", rid).
		Scan(&price, &settlement, &fee, &author, &billed); err != nil {
		t.Fatal(err)
	}
	return price, settlement, fee, author, billed
}

// officialRun runs the official node session sid of tid as c, answering the finished run.
func officialRun(t *testing.T, h *harness, c *http.Cookie, tid, sid, op string) map[string]any {
	t.Helper()
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "Review this function", "operationId": op}, 202)
	return h.awaitRun(t, c, tid, run["id"].(string), "completed")
}

// Without an official price (the default), or before its start, an official Agent takes no Agent fee: it runs in a free
// workspace without a plan and for a member, and its call, the platform's, earns no author and waits on no settlement.
func TestPostgresMarketOfficialAgentsWithoutAPriceTakeNoAgentFee(t *testing.T) {
	for name, price := range map[string]func(c *Config){
		"no official price":         func(*Config) {},
		"an official price to come": func(c *Config) { c.MarketOfficialPrice, c.MarketOfficialPriceFrom = 5, time.Now().Add(time.Hour) },
	} {
		t.Run(name, func(t *testing.T) {
			h, _ := marketTestHarness(t)
			price(&h.a.cfg)
			c, tid, _ := h.register(t, "official-unpriced@example.test")
			execSQL(t, h, "UPDATE tenants SET route_limits=$2::jsonb,max_runs_per_day=1000,max_concurrent_runs=10 WHERE id=$1", tid, planRoutes)
			member, _, memberID := h.register(t, "official-unpriced-member@example.test")
			execSQL(t, h, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", tid, memberID)
			_, sid := marketNode(t, h, c, tid, "official-code-reviewer")
			if m := h.request(t, c, "GET", "/tenants/"+tid+"/capabilities", nil, 200)["market"].(map[string]any); (m["officialPrice"] != nil) != (h.a.cfg.MarketOfficialPrice > 0) {
				t.Fatal("an official price is announced exactly where one is set", m)
			}
			for i, who := range []*http.Cookie{c, member} {
				done := officialRun(t, h, who, tid, sid, "official-unpriced-"+strconv.Itoa(i))
				if done["market"].(map[string]any)["price"] != 0.0 {
					t.Fatal("no Agent fee", done["market"])
				}
				if price, settlement, fee, author, billed := officialCall(t, h, done["id"].(string)); price != 0 || settlement != "none" || fee != 10000 || author != nil || billed != nil {
					t.Fatal("the platform's call", price, settlement, fee, author, billed)
				}
			}
		})
	}
}

// marketListedInOrder reports whether the market listed cheapest first (one page: the 39 official Agents and a few
// more) holds ids in this order.
func marketListedInOrder(t *testing.T, h *harness, c *http.Cookie, ids ...string) bool {
	t.Helper()
	listed := []string{}
	for _, item := range h.request(t, c, "GET", "/market/agents?sort=price&limit=50", nil, 200)["items"].([]any) {
		listed = append(listed, item.(map[string]any)["id"].(string))
	}
	last := -1
	for _, id := range ids {
		i := slices.Index(listed, id)
		if i <= last {
			return false
		}
		last = i
	}
	return true
}

// marketShownPrice is the price GET /market/agents/{id} shows (path may carry ?version=).
func marketShownPrice(t *testing.T, h *harness, c *http.Cookie, path string) any {
	t.Helper()
	return h.request(t, c, "GET", "/market/agents/"+path, nil, 200)["price"]
}

// From AWWO_MARKET_OFFICIAL_PRICE_FROM on, a call to an official Agent costs AWWO_MARKET_OFFICIAL_PRICE: it needs the
// owner's plan, spends its credits, is the platform's revenue (settled none, never on a statement), and any member may
// run it; listing, detail and the price sort show it; authors' Agents and insiders are as before, and the ranking counts
// official calls at either price. The start is moved from an hour ahead to just past while nothing runs; a run before
// it is TestPostgresMarketOfficialAgentsWithoutAPriceTakeNoAgentFee's.
func TestPostgresMarketOfficialAgentsTakeTheOfficialPriceFromItsStart(t *testing.T) {
	h, _ := marketTestHarness(t)
	admin, _, adminID := h.register(t, "official-price-admin@example.test")
	makeAdmin(t, h, adminID)
	cheapAuthor, cheapTenant, _ := h.register(t, "official-price-cheap@example.test")
	dearAuthor, dearTenant, _ := h.register(t, "official-price-dear@example.test")
	cheap := publishMarketAgent(t, h, cheapAuthor, admin, cheapTenant, 3, nil)
	dear := publishMarketAgent(t, h, dearAuthor, admin, dearTenant, 10, nil)
	caller, tc, callerID := h.register(t, "official-price-caller@example.test")
	execSQL(t, h, "UPDATE tenants SET route_limits=$2::jsonb,max_runs_per_day=1000,max_concurrent_runs=10 WHERE id=$1", tc, planRoutes)
	now := time.Now()
	givePlan(t, h, "official-price-caller@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	member, _, memberID := h.register(t, "official-price-member@example.test")
	execSQL(t, h, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", tc, memberID)
	free, tf, _ := h.register(t, "official-price-free@example.test")
	execSQL(t, h, "UPDATE tenants SET route_limits=$2::jsonb,max_runs_per_day=1000 WHERE id=$1", tf, planRoutes)
	canvas, callerSession := marketNode(t, h, caller, tc, "official-code-reviewer")
	_, freeSession := marketNode(t, h, free, tf, "official-code-reviewer")
	_, cheapSession := marketNode(t, h, caller, tc, cheap)
	_, insiderSession := marketNode(t, h, cheapAuthor, cheapTenant, cheap)
	from := time.Now().Add(time.Hour)
	h.a.cfg.MarketOfficialPrice, h.a.cfg.MarketOfficialPriceFrom = 5, from
	// Before its start: the capability says what is coming, and an official Agent lists and sorts at no Agent fee.
	m := h.request(t, caller, "GET", "/tenants/"+tc+"/capabilities", nil, 200)["market"].(map[string]any)
	if m["officialPrice"] != 5.0 || m["officialPriceFrom"] != from.UTC().Format(time.RFC3339Nano) {
		t.Fatal("the capability", m)
	}
	if p := marketShownPrice(t, h, caller, "official-code-reviewer"); p != 0.0 {
		t.Fatal("listed at no fee before the start", p)
	}
	if !marketListedInOrder(t, h, caller, "official-code-reviewer", cheap, dear) {
		t.Fatal("sorted at 0 before the start")
	}
	h.a.cfg.MarketOfficialPriceFrom = time.Now().Add(-time.Second)
	officialPriceApplies(t, h, caller, free, tc, tf, callerSession, freeSession, cheap, dear)
	officialCallsArePaid(t, h, caller, member, tc, callerID, canvas, callerSession)
	// An author's paid Agent stays the owner's and administrators' to run; the author's own runs are still free.
	if refused := h.request(t, member, "POST", "/tenants/"+tc+"/runs", map[string]any{"sessionId": cheapSession, "prompt": "Mine", "operationId": "official-cheap-member"}, 403); errorCode(refused) != "market_agent_role_required" {
		t.Fatal(refused)
	}
	if done := officialRun(t, h, cheapAuthor, cheapTenant, insiderSession, "official-insider"); done["market"].(map[string]any)["price"] != 0.0 || done["market"].(map[string]any)["insider"] != true {
		t.Fatal("an insider's call", done["market"])
	}
	officialCallsLeaveSettlementAlone(t, h)
}

// officialPriceApplies checks the market once the official price has started: detail, a pinned version, the price sort,
// and a free workspace refused for want of a plan.
func officialPriceApplies(t *testing.T, h *harness, caller, free *http.Cookie, tc, tf, callerSession, freeSession, cheap, dear string) {
	t.Helper()
	for _, path := range []string{"official-code-reviewer", "official-code-reviewer?version=1"} {
		if p := marketShownPrice(t, h, caller, path); p != 5.0 {
			t.Fatal("shown at the official price", path, p)
		}
	}
	if !marketListedInOrder(t, h, caller, cheap, "official-code-reviewer", dear) {
		t.Fatal("sorted at the official price")
	}
	refused := h.request(t, free, "POST", "/tenants/"+tf+"/runs", map[string]any{"sessionId": freeSession, "prompt": "Again", "operationId": "official-free-after"}, 402)
	if errorCode(refused) != "market_agent_plan_required" {
		t.Fatal("a free workspace's call after the start", refused)
	}
}

// officialCallsArePaid runs the official node as the owner and as a member, alone and as a canvas run, each charged the
// official price to the owner's plan as the platform's revenue.
func officialCallsArePaid(t *testing.T, h *harness, caller, member *http.Cookie, tc, payer, canvas, sid string) {
	t.Helper()
	spent := planCredits0(t, h, caller, tc)["spent"].(float64)
	runs := []string{}
	for i, who := range []*http.Cookie{caller, member} {
		done := officialRun(t, h, who, tc, sid, "official-after-"+strconv.Itoa(i))
		if market := done["market"].(map[string]any); market["price"] != 5.0 || market["status"] != "charged" {
			t.Fatal("charged the official price", market)
		}
		runs = append(runs, done["id"].(string))
	}
	graphs := "/tenants/" + tc + "/canvases/" + canvas + "/graph-runs"
	gid := h.request(t, member, "POST", graphs, map[string]any{"operationId": "official-canvas-run"}, 202)["id"].(string)
	awaitGraph(t, h, member, graphs+"/"+gid, "completed")
	var node string
	if err := h.db.QueryRow(context.Background(), "SELECT run_id FROM graph_run_nodes WHERE graph_id=$1 AND run_id IS NOT NULL", gid).Scan(&node); err != nil {
		t.Fatal(err)
	}
	for _, rid := range append(runs, node) {
		price, settlement, fee, author, billed := officialCall(t, h, rid)
		if price != 5 || settlement != "none" || fee != 10000 || author != nil || billed == nil || *billed != payer {
			t.Fatal("the platform's revenue, billed to the owner", rid, price, settlement, fee, author, billed)
		}
	}
	if now := planCredits0(t, h, caller, tc)["spent"].(float64); now < spent+15 {
		t.Fatal("the official price is spent from the period's credits", spent, now)
	}
}

// officialCallsLeaveSettlementAlone runs the settlement job over official calls whose billing period ended long ago:
// none becomes an earning or reaches a statement, and no payer's period is kept for them; and the ranking still counts
// every completed official call, at either price.
func officialCallsLeaveSettlementAlone(t *testing.T, h *harness) {
	t.Helper()
	ctx := context.Background()
	// A completed call from before the price started, at no Agent fee, by someone else.
	execSQL(t, h, `INSERT INTO market_agent_calls(id,agent_id,version,actor_id,price_credits,fee_bps,status,outcome,settlement)
		VALUES('call-before-the-price','official-code-reviewer',1,'user-before-the-price',0,10000,'charged','completed','none')`)
	execSQL(t, h, "UPDATE market_agent_calls SET billed_period_end=now()-interval '60 days' WHERE agent_id='official-code-reviewer' AND price_credits>0")
	h.a.settleMarket(ctx)
	var unsettled, earned, stated, facts, free, paid int
	if err := h.db.QueryRow(ctx, `SELECT count(*) FILTER (WHERE settlement<>'none'),count(*) FILTER (WHERE earned_microcredits IS NOT NULL),
		count(*) FILTER (WHERE payout_id IS NOT NULL),(SELECT count(*) FROM market_period_facts),
		count(*) FILTER (WHERE price_credits=0 AND outcome='completed'),count(*) FILTER (WHERE price_credits=5 AND outcome='completed')
		FROM market_agent_calls WHERE agent_id='official-code-reviewer'`).Scan(&unsettled, &earned, &stated, &facts, &free, &paid); err != nil {
		t.Fatal(err)
	}
	if unsettled != 0 || earned != 0 || stated != 0 || facts != 0 {
		t.Fatal("the settlement job touched official calls", unsettled, earned, stated, facts)
	}
	h.a.marketStats.forget()
	stats, err := h.a.marketStatsFor(ctx)
	if err != nil || free < 1 || paid < 2 || stats["official-code-reviewer"].Runs != free+paid {
		t.Fatal("the ranking counts official calls at either price", free, paid, stats["official-code-reviewer"], err)
	}
}

// AwwO does not charge itself: once the official price applies, a workspace with no route limits (which no plan can
// cover) and one a platform administrator owns run an official Agent with no plan and no Agent fee, as the platform's call.
func TestPostgresMarketOfficialAgentsTakeNoFeeInAwwOsOwnWorkspaces(t *testing.T) {
	h, _ := marketTestHarness(t)
	h.a.cfg.MarketOfficialPrice, h.a.cfg.MarketOfficialPriceFrom = 5, time.Now().Add(-time.Second)
	unlimited, tu, _ := h.register(t, "official-own-unlimited@example.test")
	execSQL(t, h, "UPDATE tenants SET route_limits=NULL,max_runs_per_day=1000,max_concurrent_runs=10 WHERE id=$1", tu)
	operator, to, operatorID := h.register(t, "official-own-operator@example.test")
	makeAdmin(t, h, operatorID)
	execSQL(t, h, "UPDATE tenants SET route_limits=$2::jsonb,max_runs_per_day=1000,max_concurrent_runs=10 WHERE id=$1", to, planRoutes)
	for i, own := range []struct {
		who *http.Cookie
		tid string
	}{{unlimited, tu}, {operator, to}} {
		_, sid := marketNode(t, h, own.who, own.tid, "official-code-reviewer")
		done := officialRun(t, h, own.who, own.tid, sid, "official-own-"+strconv.Itoa(i))
		if done["market"].(map[string]any)["price"] != 0.0 {
			t.Fatal("AwwO's own workspace takes no Agent fee", own.tid, done["market"])
		}
		if price, settlement, _, author, billed := officialCall(t, h, done["id"].(string)); price != 0 || settlement != "none" || author != nil || billed != nil {
			t.Fatal("the platform's call", price, settlement, author, billed)
		}
	}
}
