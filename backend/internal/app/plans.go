package app

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Paid plans. ClawHunt takes the payment and renews the subscription; billing.go reads it over the backchannel
// and user_plans mirrors what the account has paid for. A workspace's plan is its owner's. While the owner is
// entitled, runs and calls in the owner's route-limited workspaces are admitted on the plan's allowances, which
// are the account's and not each workspace's, and the paid model routes spend the period's credits (1 credit =
// $0.01 paid) instead of the free plan's route limits. An older workspace without route limits keeps its own
// allowances: a plan never gives it less. Each admitted call and generation records the account and period it is
// charged to (migration 026), and a period's spend is summed from those rows.

type planLimits struct {
	Credits     int `json:"credits"`
	Daily       int `json:"dailyCalls"`
	Concurrent  int `json:"concurrentAgents"`
	Workspaces  int `json:"workspaces"`
	MediaPerDay int `json:"mediaPerDay"`
	PriceUSD    int `json:"priceUsd"`
}

// planCatalog is the owner-approved v1 ladder (2026-10-06). Credits is what a full period's payment of PriceUSD
// buys; the credits actually granted are converted from what was paid (planCredits). Daily counts the free
// default model's calls, Concurrent the runs active at once (and so the model calls), and MediaPerDay the
// generations, across all of the account's plan workspaces.
var planCatalog = map[string]planLimits{
	"pro": {Credits: 2000, Daily: 300, Concurrent: 3, Workspaces: 3, MediaPerDay: 30, PriceUSD: 20},
	"max": {Credits: 10000, Daily: 1000, Concurrent: 6, Workspaces: 10, MediaPerDay: 100, PriceUSD: 100},
}

var planOrder = []string{"pro", "max"}

const (
	microusdPerCredit = 10000
	// A paid-route call holds at least this estimate while it runs: a large call (in our ledger the 95th
	// percentile is 24k in / 13k out, the median 3k / 4k) at the model's official price, plus the markup. A call
	// whose request is known to be larger holds its request's size instead.
	reserveInputTokens  = 8000
	reserveOutputTokens = 6000
	// A call whose usage is never reported (cancelled, failed after it reached the provider, or from a runtime
	// that does not report it) is charged from what it sent and streamed at this many bytes a token, fewer than
	// tokenizers average for any written language, so the estimate errs high; and for the time before its first
	// streamed text, which a reasoning model spends on hidden reasoning, at unseenTokensPerSecond. It is never
	// charged less than its reserve.
	estimateBytesPerToken = 2
	unseenTokensPerSecond = 120
	// The hidden-reasoning estimate is capped at the largest output any configured model may produce in one call.
	maxHiddenTokens = 32000
)

// creditsFor converts an official-price cost to credits: × 1.5, rounded up to a whole credit.
func creditsFor(microusd int64) int64 {
	if microusd <= 0 {
		return 0
	}
	return (microusd*3 + 2*microusdPerCredit - 1) / (2 * microusdPerCredit)
}

// planCredits converts what a period's paid invoices charged for each plan, in cents, into its credits at that
// plan's rate (Credits per PriceUSD). An upgrade's proration nets a credit for the old plan's unused time against
// a charge for the new plan's remaining time, so the period ends up with what was paid for each.
func planCredits(paid map[string]int64) int64 {
	total := 0.0
	for id, cents := range paid {
		l, ok := planCatalog[id]
		if !ok || l.PriceUSD <= 0 {
			continue
		}
		total += float64(cents) * float64(l.Credits) / float64(l.PriceUSD*100)
	}
	if total <= 0 {
		return 0
	}
	return int64(math.Floor(total + 1e-9))
}

type activePlan struct {
	UserID            string
	Plan              string
	Status            string
	PeriodStart       time.Time
	PeriodEnd         time.Time
	CancelAtPeriodEnd bool
	Credits           int
	// The charged period before this one, its credits and what was carried into it: what it spent beyond them
	// comes off this period's credits.
	PrevStart              *time.Time
	PrevCredits, PrevCarry int
	// Carry is that overspend, counted now (withCarry), so a call of the previous period that settles after the
	// switch still lands in it.
	Carry  int
	Limits planLimits
}

// remaining is what the period still has after spent.
func (p *activePlan) remaining(spent int64) int64 { return int64(p.Credits) - int64(p.Carry) - spent }

var (
	errCreditsExhausted = errors.New("credits_exhausted")
	errModelUnpriced    = errors.New("model_unpriced")
	errPlanRequired     = errors.New("plan_required")
	// errPlanBusy refuses a run while the account's agents at once are all in use, in any of its workspaces.
	errPlanBusy = errors.New("plan_busy")
)

// planEntitles is the one rule for whether a stored plan applies: active, trialing or past due (Stripe still
// retrying the renewal), a period that was paid for, and at most planGrace after that period.
const planEntitles = `p.status IN ('active','trialing','past_due') AND p.credits > 0 AND clock_timestamp() < p.period_end + interval '1 day'`

const planColumns = `p.user_id,p.plan,p.status,p.period_start,p.period_end,p.cancel_at_period_end,p.credits,p.prev_period_start,p.prev_credits,p.prev_carry`

// entitledPlanSQL finds the entitled plan of a route-limited workspace's owner. Every workspace has exactly one
// owner; a workspace without route limits is never on a plan.
const entitledPlanSQL = `SELECT ` + planColumns + `
	FROM memberships m JOIN user_plans p ON p.user_id=m.user_id JOIN tenants t ON t.id=m.tenant_id
	WHERE m.tenant_id=$1 AND m.role='owner' AND t.route_limits IS NOT NULL AND ` + planEntitles + `
	ORDER BY m.created_at, m.user_id LIMIT 1`

func scanPlan(row pgx.Row) (*activePlan, error) {
	var p activePlan
	if err := row.Scan(&p.UserID, &p.Plan, &p.Status, &p.PeriodStart, &p.PeriodEnd, &p.CancelAtPeriodEnd, &p.Credits, &p.PrevStart, &p.PrevCredits, &p.PrevCarry); err != nil {
		if noRows(err) {
			return nil, nil
		}
		return nil, err
	}
	limits, ok := planCatalog[p.Plan]
	if !ok {
		return nil, nil
	}
	p.Limits = limits
	return &p, nil
}

// ownerPlan returns the plan the workspace's owner is entitled to, or nil for the free plan. With lock it holds
// the owner's plan row until the transaction ends: every admission that counts the account's allowances or
// spends its credits takes it, after its workspace row (and, for media, the media lock; for a graph node, its
// graph row), so admissions across the account's workspaces are serialized without a lock cycle.
func ownerPlan(ctx context.Context, q querier, tid string, lock bool) (*activePlan, error) {
	sql := entitledPlanSQL
	if lock {
		sql += " FOR UPDATE OF p"
	}
	return scanPlan(q.QueryRow(ctx, sql, tid))
}

// accountPlan returns the account's own entitled plan, or nil.
func accountPlan(ctx context.Context, q querier, userID string) (*activePlan, error) {
	return scanPlan(q.QueryRow(ctx, `SELECT `+planColumns+` FROM user_plans p WHERE p.user_id=$1 AND `+planEntitles, userID))
}

// planUsage is what the account has admitted under its plan: model calls running now, today's free default-model
// calls (UTC) apart from the operator's planner calls (planner_model.go), and today's generations.
type planUsage struct {
	Running, FreeToday, MediaToday int
}

// accountPlanUsage counts it; plannerModel is the operator's planner model, or "" when there is none.
func accountPlanUsage(ctx context.Context, q querier, userID, plannerModel string) (planUsage, error) {
	var u planUsage
	err := q.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM model_invocations WHERE billed_user_id=$1 AND status='running'),
		(SELECT count(*) FROM model_invocations mi WHERE mi.billed_user_id=$1 AND mi.credit_reserve IS NULL AND mi.created_at>=`+todayUTC+` AND `+countsTowardsDaily("$2")+`),
		(SELECT count(*) FROM media_generations WHERE billed_user_id=$1 AND created_at>=`+todayUTC+`)`, userID, plannerModel).Scan(&u.Running, &u.FreeToday, &u.MediaToday)
	return u, err
}

// accountSlotsUsed is how many of the plan's agents at once the account uses: one for every run queued or running in
// its plan workspaces, whether or not its model call is running, and one more for each further call such a run has
// running at once (the members of a parallel team). The plan's Concurrent caps it, so a run that calls one model at a
// time never waits for a slot.
func accountSlotsUsed(ctx context.Context, q querier, userID string) (int, error) {
	var n int
	err := q.QueryRow(ctx, `SELECT COALESCE(sum(GREATEST(1,(SELECT count(*) FROM model_invocations mi
		WHERE mi.tenant_id=r.tenant_id AND mi.run_id=r.id AND mi.status='running' AND mi.billed_user_id=$1))),0)::int
		FROM runs r JOIN memberships m ON m.tenant_id=r.tenant_id AND m.role='owner' JOIN tenants t ON t.id=r.tenant_id
		WHERE m.user_id=$1 AND t.route_limits IS NOT NULL AND r.status IN ('queued','running')`, userID).Scan(&n)
	return n, err
}

// runCallsRunning counts the model calls a run has running now.
func runCallsRunning(ctx context.Context, q querier, tid, rid string) (int, error) {
	var n int
	err := q.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND run_id=$2 AND status='running'", tid, rid).Scan(&n)
	return n, err
}

// workspaceLimits are a workspace's own allowances, read where a run is admitted: what applies when the owner's plan
// lapses between the first read and the locked one.
type workspaceLimits struct {
	active, concurrent, today, daily int
	needsPlan                        bool
}

func (l workspaceLimits) admit(ctx context.Context, q querier, tid string) error {
	if err := requiresPlan(ctx, q, tid, l.needsPlan, nil); err != nil {
		return err
	}
	if l.active >= l.concurrent || l.today >= l.daily {
		return errInvocationQuota
	}
	return nil
}

// planRunSlot admits one more run of a plan workspace while the account has one of the plan's agents at once free
// (errPlanBusy otherwise). It counts without a lock first, so a graph waiting for capacity does not keep taking the
// plan row, then again under the plan row's lock (after the workspace row, and for media the media lock). A plan
// that lapsed since it was read leaves the workspace's own limits.
func (a *App) planRunSlot(ctx context.Context, tx pgx.Tx, tid string, own workspaceLimits) error {
	for _, lock := range []bool{false, true} {
		plan, err := ownerPlan(ctx, tx, tid, lock)
		if err != nil {
			return err
		}
		if plan == nil {
			if lock {
				return own.admit(ctx, tx, tid)
			}
			continue
		}
		used, err := accountSlotsUsed(ctx, tx, plan.UserID)
		if err != nil {
			return err
		}
		if used >= plan.Limits.Concurrent {
			return errPlanBusy
		}
	}
	return nil
}

// withCarry fills p.Carry: what the previous charged period spent beyond its credits and its own carry, counted now.
func withCarry(ctx context.Context, q querier, p *activePlan) error {
	if p == nil || p.PrevStart == nil {
		return nil
	}
	spent, err := creditsSpent(ctx, q, &activePlan{UserID: p.UserID, PeriodStart: *p.PrevStart})
	if err != nil {
		return err
	}
	p.Carry = int(min(max(0, spent+int64(p.PrevCarry)-int64(p.PrevCredits)), math.MaxInt32))
	return nil
}

// creditsSpentSQL is what the account spent in the period starting $2: a running call its reserve, a settled
// one its charge. A generation costs its points once its provider accepted the task, and while its run is still
// active (the provider may yet accept it); one whose run ended before the provider accepted it costs nothing.
// Only a pending generation looks at its run, and a canvas whose run is active cannot be deleted.
const creditsSpentSQL = `SELECT
	COALESCE((SELECT sum(CASE WHEN status='running' THEN credit_reserve ELSE COALESCE(credit_charge,credit_reserve) END) FROM model_invocations
		WHERE billed_user_id=$1 AND billed_period_start=$2 AND credit_reserve IS NOT NULL),0)::bigint
	+COALESCE((SELECT sum(g.credit_points) FROM media_generations g WHERE g.billed_user_id=$1 AND g.billed_period_start=$2 AND g.credit_points IS NOT NULL
		AND (g.provider_accepted OR (g.provider_accepted IS NULL AND EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=g.tenant_id AND r.id=g.run_id AND r.status IN ('queued','running'))))),0)::bigint`

func creditsSpent(ctx context.Context, q querier, p *activePlan) (int64, error) {
	var spent int64
	err := q.QueryRow(ctx, creditsSpentSQL, p.UserID, p.PeriodStart).Scan(&spent)
	return spent, err
}

// checkCredits admits a paid-route call or generation only while its reserve still fits in the period's credits.
func checkCredits(ctx context.Context, tx pgx.Tx, p *activePlan, reserve int) error {
	if err := withCarry(ctx, tx, p); err != nil {
		return err
	}
	spent, err := creditsSpent(ctx, tx, p)
	if err != nil {
		return err
	}
	if p.remaining(spent) < int64(reserve) {
		return errCreditsExhausted
	}
	return nil
}

// creditRates is model's official price through runtime, in microdollars per million input and output tokens.
func (a *App) creditRates(runtime, model string) (in, out int64, ok bool) {
	if a.pricing == nil {
		return 0, 0, false
	}
	price, found := a.pricing.Models[runtime+":"+model]
	if !found || price.Rates.Input == nil || price.Rates.Output == nil {
		return 0, 0, false
	}
	in, e1 := strconv.ParseInt(*price.Rates.Input, 10, 64)
	out, e2 := strconv.ParseInt(*price.Rates.Output, 10, 64)
	return in, out, e1 == nil && e2 == nil && in >= 0 && out >= 0
}

// creditReserve is what a call to model through runtime holds under a plan: nil for the free default models,
// which spend no credits. A request of inputBytes is held at its estimated size when that is larger than the
// fixed reserve. A paid model without a price for its runtime is refused rather than guessed at.
func (a *App) creditReserve(runtime, model string, inputBytes int64) (*int, error) {
	if a.cfg.modelRoute(model) == routeFree {
		return nil, nil
	}
	in, out, ok := a.creditRates(runtime, model)
	if !ok {
		return nil, errModelUnpriced
	}
	tokensIn := max(int64(reserveInputTokens), max(0, inputBytes)/estimateBytesPerToken)
	n := int(min(max(1, creditsFor((tokensIn*in+reserveOutputTokens*out)/1_000_000)), math.MaxInt32))
	return &n, nil
}

// creditCharge is what a settled paid-route call costs. A call that never reached the provider costs nothing. A
// call with reported usage costs that usage at its frozen price. A call the provider refused before producing
// anything (a rate limit, a rejected credential, an outage) costs nothing. A call that may have reached the provider
// but left no trace of it (no terminal report, no streamed text) costs its reserve. Any other call, a cancelled or
// failed one, or one whose usage was not reported, costs the larger of its reserve, any partly reported usage, and an
// estimate from the bytes it sent and streamed plus its hidden reasoning: the larger of the reasoning it reported
// (hidden tokens) and the time before its first streamed text (unseen).
func creditCharge(reserve int, notIncurred, refused, reached bool, u InvocationUsage, price json.RawMessage, bytesIn, bytesOut, hidden int64, unseen time.Duration) int {
	if notIncurred {
		return 0
	}
	// Reported usage is the bill, unless it claims no output for a call that streamed some (a broken report).
	if u.Status == "reported" && !(bytesOut > 0 && u.OutputTokens != nil && *u.OutputTokens == 0) {
		if cost, _ := EstimateInvocationCost(price, u); cost != nil {
			return int(min(creditsFor(*cost), math.MaxInt32))
		}
	}
	charge := int64(reserve)
	if u.Status == "partial" {
		if cost, _ := EstimateInvocationCost(price, u); cost != nil {
			charge = max(charge, creditsFor(*cost))
		}
	} else if refused && u.Status != "reported" && hidden <= 0 {
		// A report, even one its price cannot read, or reasoning the run was told about, says the provider did work.
		return 0
	}
	if !reached {
		return int(charge)
	}
	zero := int64(0)
	in := max(0, bytesIn) / estimateBytesPerToken
	reasoning := min(max(max(0, hidden), int64(max(0, unseen.Seconds())*unseenTokensPerSecond)), maxHiddenTokens)
	out := max(0, bytesOut)/estimateBytesPerToken + reasoning
	// Token counts a report did carry (one its price could not read, or a partial one) are never estimated below.
	if u.InputTokens != nil {
		in = max(in, *u.InputTokens)
	}
	if u.OutputTokens != nil {
		out = max(out, *u.OutputTokens)
	}
	estimate := InvocationUsage{Status: "reported", Source: "sdk_normalized", InputTokens: &in, OutputTokens: &out,
		CachedInputTokens: &zero, CacheWriteTokens: &zero, ReasoningTokens: &zero}
	if cost, _ := EstimateInvocationCost(price, estimate); cost != nil {
		charge = max(charge, creditsFor(*cost))
	}
	return int(min(charge, math.MaxInt32))
}

// refusedBeforeOutput reports a failure the provider answers before generating anything, which it does not bill: a
// rate limit, a rejected credential or an outage, answered within moments of the request (workerCode is the
// worker's own code; a connection error, which may follow billed work, is not one of them). The same answers after a
// while may follow billed reasoning (a throttle mid-stream), so they are charged like any other failure.
func refusedBeforeOutput(code, workerCode string, bytesOut int64, unseen time.Duration) bool {
	if bytesOut > 0 || unseen >= 15*time.Second {
		return false
	}
	return code == "provider_rate_limited" || code == "provider_auth_failed" || workerCode == "MODEL_UNAVAILABLE"
}

// mediaBaseCredits is a generation's price at the model's default settings: RunningHub charged $0.17–0.33 a
// generation in our probes, so these hold at least three times that until each model is measured. Videos are
// priced per five seconds.
var mediaBaseCredits = map[string]int{
	"rh.seedream-v5-pro": 30, "rh.nano-banana-2": 30, "rh.grok-imagine": 30, "rh.wan-2-7-pro": 30, "rh.jimeng-4-6": 30,
	"rh.qwen-image-3-pro": 30, "rh.nano-banana-pro": 60, "rh.gpt-image-2": 60, "rh.midjourney-v7": 60,
	"rh.vidu-q3-pro": 100, "rh.wan-2-7": 100, "rh.grok-imagine-video": 100, "rh.pixverse-v6": 100,
	"rh.kling-v3-pro": 200, "rh.seedance-2": 200, "rh.veo-3-1-fast": 200, "rh.sora-2": 200, "rh.hailuo-2-3-pro": 200,
	// Tripo 3D models at their default (textured) settings; model3DCredits holds the rest of each price.
	"tripo.v3-1": 60, "tripo.p1": 120,
	// X-tasy, three times what it charged at each model's defaults in the verification of 2026-10-10 (one X-tasy credit
	// taken as $0.01), images never below RunningHub's 30: Nano Banana 2 1K 12.3, Seedream 5.0 Pro 2K 12, 全能图片 5.0
	// Pro 2K 12, Xtasy 3.0 Pro 1K 12, Xtasy 3.0 1K 9.6, GPT Image 2 / 2.5 1.3; videos for five seconds at 720p with
	// sound: Xtasy V3 66, 全能视频 91.5, 全能视频 v2.5 139.8. Videos are priced per five seconds.
	"xt.seedream-5-pro": 40, "xt.gemini-3-1-flash-image": 40, "xt.omni-image-5-pro": 40, "xt.xtasy-3-pro": 40,
	"xt.xtasy-3": 30, "xt.gpt-image-2": 30, "xt.gpt-image-2-5": 30,
	"xt.xtasy-v3": 200, "xt.omni-video": 280, "xt.omni-video-2-5": 420,
}

// model3DCredits prices a Tripo text-to-3D task at three times Tripo's own credits (one Tripo credit and one AwwO
// credit are both $0.01): with texture, without, and what detailed texture and detailed geometry add. Tripo's
// tables (2026-10): H3.1 20 textured, 10 untextured, +10 detailed texture, +20 detailed geometry; P1 40, 30,
// +10 detailed texture, and no geometry option.
var model3DCredits = map[string]struct{ textured, untextured, detailedTexture, detailedGeometry int }{
	"tripo.v3-1": {textured: 60, untextured: 30, detailedTexture: 30, detailedGeometry: 60},
	"tripo.p1":   {textured: 120, untextured: 90, detailedTexture: 30},
}

// mediaCreditsFor prices a generation from its model and resolved settings. Settings that raise RunningHub's
// price raise it too: more images, 4K or another size past 2048 pixels a side, high quality, longer or sharper
// video. Sound, on by default where a model offers it, is in the base price. An unknown model takes the highest
// video price.
func mediaCreditsFor(model, kind string, params map[string]any) int {
	base, ok := mediaBaseCredits[model]
	if !ok {
		base = 200
		kind = mediaKindVideo
	}
	text := func(name string) string {
		switch v := params[name].(type) {
		case string:
			return strings.ToLower(v)
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64)
		case int:
			return strconv.Itoa(v)
		case int64:
			return strconv.FormatInt(v, 10)
		case bool:
			return strconv.FormatBool(v)
		}
		return ""
	}
	number := func(name string, fallback float64) float64 {
		if n, err := strconv.ParseFloat(text(name), 64); err == nil && n > 0 {
			return n
		}
		return fallback
	}
	large := func(name string) bool {
		v := text(name)
		if strings.Contains(v, "4k") {
			return true
		}
		// A pixel size such as 4096x4096 or 1792*1024: anything past 2048 on a side is priced as 4K.
		for _, part := range strings.FieldsFunc(v, func(r rune) bool { return r == 'x' || r == '*' || r == ':' || r == ' ' }) {
			if n, err := strconv.Atoi(part); err == nil && n > 2048 {
				return true
			}
		}
		return false
	}
	credits := float64(base)
	if kind == mediaKindModel3D {
		price, ok := model3DCredits[model]
		if !ok {
			// A 3D model without its own table pays the highest of every option.
			price.textured, price.untextured, price.detailedTexture, price.detailedGeometry = base, base, base, base
		}
		// PBR materials force a texture on, so a model is untextured only with both off; detailed texture is
		// then not generated and not charged.
		n := price.untextured
		if text("texture") != "false" || text("pbr") != "false" {
			n = price.textured
			if text("textureQuality") == "detailed" {
				n += price.detailedTexture
			}
		}
		if text("geometryQuality") == "detailed" {
			n += price.detailedGeometry
		}
		return n
	}
	if kind == mediaKindVideo {
		credits *= max(1, number("duration", 5)/5)
		switch res := text("resolution"); {
		case large("resolution") || large("size"):
			credits *= 2
		case strings.Contains(res, "1080") || strings.Contains(text("size"), "1080") || strings.Contains(text("size"), "1792"):
			credits *= 1.5
		}
	} else {
		credits *= max(1, number("imageNum", 1))
		if large("resolution") || large("size") || large("width") || large("height") {
			credits *= 2
		}
		if q := text("quality"); q == "high" || q == "2" || q == "4" {
			credits *= 2
		}
	}
	return int(math.Ceil(credits))
}

// admissionRefusal is the code of an allowance or plan refusal from reserveInvocation, which a run reports as
// its own error instead of a generic failure; "" for any other error.
func admissionRefusal(err error) string {
	if err == nil {
		return ""
	}
	switch code := err.Error(); code {
	case "quota_exceeded", "premium_quota_exceeded", "premium_capacity_exceeded", "free_capacity_exceeded", "credits_exhausted", "plan_required", "model_unpriced", "plan_busy":
		return code
	}
	return ""
}

// requiresPlan refuses a workspace that exists only because its owner's plan allowed it while the owner's plan
// does not allow it now: no plan, or a smaller one (a workspace beyond the plan's count, by when it was created).
func requiresPlan(ctx context.Context, q querier, tid string, needsPlan bool, plan *activePlan) error {
	if !needsPlan {
		return nil
	}
	if plan == nil {
		return errPlanRequired
	}
	var rank int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM memberships m JOIN memberships mine ON mine.tenant_id=$1 AND mine.role='owner'
		WHERE m.user_id=mine.user_id AND m.role='owner' AND (m.created_at, m.tenant_id) <= (mine.created_at, mine.tenant_id)`, tid).Scan(&rank); err != nil {
		return err
	}
	if rank > plan.Limits.Workspaces {
		return errPlanRequired
	}
	return nil
}
