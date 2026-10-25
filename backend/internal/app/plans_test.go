package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The hidden-reasoning estimate's cap is the model catalog's own per-call output cap (apps/bedrock-catalog.ts), so a
// call of a model the catalog lets write more is never estimated as if it wrote less (Opus 5.5 declares 64,000).
func TestMaxHiddenTokensIsTheCatalogsOutputCap(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "bedrock-catalog.ts"))
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`const MAX_OUTPUT_TOKENS = ([0-9_]+);`).FindSubmatch(source)
	if match == nil {
		t.Fatal("apps/bedrock-catalog.ts has no MAX_OUTPUT_TOKENS")
	}
	catalogCap, err := strconv.Atoi(strings.ReplaceAll(string(match[1]), "_", ""))
	if err != nil || catalogCap != maxHiddenTokens {
		t.Fatalf("catalog cap %q, maxHiddenTokens %d", match[1], maxHiddenTokens)
	}
}

// planPricing prices the paid models the plan tests call: claude-sonnet-5 at $2 / $10 per million tokens (a
// reserve of 12 credits) and bedrock.claude-opus-5-5 at $4.40 / $22 (26 credits) through both runtimes, and the
// harness Pi model test-model at the Sonnet price through Pi.
var planPricing = func() string {
	entry := func(in, out string) string {
		return `{"ratesMicrousdPerMillion":{"input":"` + in + `","cachedInput":null,"cacheWrite":null,"output":"` + out + `","reasoning":null},"semantics":{"cachedInput":"included_in_input_rate","cacheWrite":"unsupported","reasoning":"included_in_output"},"rounding":"ceil_per_component"}`
	}
	models := []string{}
	for _, runtime := range []string{"pi", "openai-agents"} {
		models = append(models, `"`+runtime+`:claude-sonnet-5":`+entry("2000000", "10000000"), `"`+runtime+`:bedrock.claude-opus-5-5":`+entry("4400000", "22000000"))
	}
	models = append(models, `"pi:test-model":`+entry("2000000", "10000000"))
	return `{"version":"plans-v1","currency":"USD","models":{` + strings.Join(models, ",") + `}}`
}()

func TestCreditsRoundUpAtOneAndAHalfTimesThePrice(t *testing.T) {
	for microusd, want := range map[int64]int64{0: 0, -5: 0, 1: 1, 6666: 1, 6667: 2, 20000: 3, 13_333_334: 2001} {
		if got := creditsFor(microusd); got != want {
			t.Fatal("credits for", microusd, "=", got, "want", want)
		}
	}
}

func TestPlanCreditsAreWhatWasPaidForEachPlan(t *testing.T) {
	for _, c := range []struct {
		paid map[string]int64
		want int64
	}{
		{map[string]int64{"pro": 2000}, 2000},
		{map[string]int64{"max": 10000}, 10000},
		// Pro to Max on the last day of a 30-day month: Pro's unused day back, Max's remaining day charged.
		{map[string]int64{"pro": 2000 - 67, "max": 333}, 2266},
		{map[string]int64{"pro": 1000}, 1000}, // a discounted invoice buys what it charged
		{map[string]int64{}, 0},
		{nil, 0},
		{map[string]int64{"pro": -500}, 0},
		{map[string]int64{"ultra": 5000}, 0},
	} {
		if got := planCredits(c.paid); got != c.want {
			t.Fatal(c.paid, "=", got, "want", c.want)
		}
	}
}

func TestMediaCreditsFollowTheSettingsThatRaiseTheirPrice(t *testing.T) {
	for _, c := range []struct {
		model, kind string
		params      map[string]any
		want        int
	}{
		{"rh.seedream-v5-pro", mediaKindImage, map[string]any{"resolution": "2k"}, 30},
		{"rh.qwen-image-3-pro", mediaKindImage, map[string]any{"imageNum": "3"}, 90},
		{"rh.nano-banana-pro", mediaKindImage, map[string]any{"resolution": "4k"}, 120},
		{"rh.gpt-image-2", mediaKindImage, map[string]any{"quality": "high"}, 120},
		{"rh.veo-3-1-fast", mediaKindVideo, map[string]any{"duration": "8", "resolution": "720p"}, 320},
		{"rh.seedance-2", mediaKindVideo, map[string]any{"duration": "10", "resolution": "1080p"}, 600},
		{"rh.pixverse-v6", mediaKindVideo, map[string]any{"duration": float64(15)}, 300},
		{"rh.kling-v3-pro", mediaKindVideo, map[string]any{"duration": "3"}, 200},
		{"rh.wan-2-7", mediaKindVideo, map[string]any{"duration": "5", "resolution": "1080P"}, 150},
		{"rh.someday", mediaKindImage, nil, 200},
		{"rh.wan-2-7-pro", mediaKindImage, map[string]any{"width": float64(4096), "height": float64(1024)}, 60},
		{"rh.midjourney-v7", mediaKindImage, map[string]any{"quality": "2"}, 120},
		{"rh.seedance-2", mediaKindVideo, map[string]any{"duration": "5", "generateAudio": true}, 200},
		// Audio costs one measured price per call, whatever its settings.
		{"rh.minimax-speech-2-8-hd", mediaKindAudio, map[string]any{"voice": "Calm_Woman", "speed": 2.0, "pitch": int64(12)}, 30},
		{"rh.minimax-speech-2-8-hd", mediaKindAudio, nil, speechCreditsPerCall},
		{"rh.minimax-music-2-6-instrumental", mediaKindAudio, map[string]any{"sampleRate": "44100", "bitrate": "256000"}, 40},
		{"rh.minimax-music-2-6-instrumental", mediaKindAudio, map[string]any{"sampleRate": "16000", "bitrate": "32000"}, instrumentalCreditsPerCall},
	} {
		if got := mediaCreditsFor(c.model, c.kind, c.params); got != c.want {
			t.Fatal(c.model, c.params, "=", got, "want", c.want)
		}
	}
}

func planApp(t *testing.T) *App {
	t.Helper()
	p, err := ParseModelPricing(planPricing)
	if err != nil {
		t.Fatal(err)
	}
	return &App{cfg: Config{RouteFreeModels: []string{"qwen3.8-27b-p6"}}, pricing: p}
}

func TestCreditReserveIsALargeCallAtTheModelsPrice(t *testing.T) {
	a := planApp(t)
	for _, runtime := range []string{runtimePI, runtimeOpenAIAgents} {
		if r, e := a.creditReserve(runtime, "claude-sonnet-5", 4000); e != nil || r == nil || *r != 12 {
			t.Fatal("sonnet reserve", runtime, r, e)
		}
		if r, e := a.creditReserve(runtime, "bedrock.claude-opus-5-5", 0); e != nil || r == nil || *r != 26 {
			t.Fatal("opus reserve", runtime, r, e)
		}
		if r, e := a.creditReserve(runtime, "qwen3.8-27b-p6", 1<<20); e != nil || r != nil {
			t.Fatal("a free model holds no credits", r, e)
		}
	}
	// A paid model without a price for its runtime is refused, never guessed at.
	for _, c := range [][2]string{{runtimePI, "gpt-5.5"}, {runtimeOpenAIAgents, "test-model"}} {
		if _, e := a.creditReserve(c[0], c[1], 0); !errors.Is(e, errModelUnpriced) {
			t.Fatal("unpriced", c, e)
		}
	}
	// A request known to be large holds its size: 200 KiB is 102,400 tokens at 2 bytes, at $2 / $10 with 6k out
	// 264,800 microdollars, × 1.5 → 40 credits.
	if r, e := a.creditReserve(runtimePI, "claude-sonnet-5", 200<<10); e != nil || r == nil || *r != 40 {
		t.Fatal("large request reserve", r, e)
	}
	a.pricing = nil
	if _, e := a.creditReserve(runtimePI, "claude-sonnet-5", 0); !errors.Is(e, errModelUnpriced) {
		t.Fatal("no catalog", e)
	}
}

func TestCreditChargeIsTheUsageOrAnEstimateThatErrsHigh(t *testing.T) {
	a := planApp(t)
	_, price := a.pricing.Freeze(runtimePI, "claude-sonnet-5")
	n := func(v int64) *int64 { return &v }
	reported := InvocationUsage{Status: "reported", Source: "provider_raw", InputTokens: n(3000), OutputTokens: n(4000)}
	// 3k in + 4k out at $2 / $10 = 46,000 microdollars, × 1.5 = 6.9 → 7 credits: below the reserve, and charged as is.
	if got := creditCharge(12, false, false, true, reported, price, 0, 0, 0, false, 0); got != 7 {
		t.Fatal("reported usage", got)
	}
	if got := creditCharge(12, true, false, true, reported, price, 0, 0, 0, false, 0); got != 0 {
		t.Fatal("not incurred", got)
	}
	if got := creditCharge(12, false, true, true, missingUsage("unknown", "transport_unknown"), price, 1000, 0, 0, false, 0); got != 0 {
		t.Fatal("refused before any output", got)
	}
	unknown := missingUsage("unknown", "cancelled_after_admission")
	// Unreported and small: the reserve.
	if got := creditCharge(12, false, false, true, unknown, price, 4000, 2000, 0, false, 0); got != 12 {
		t.Fatal("small unreported call", got)
	}
	// Unreported and large: 256 KiB sent (131,072 tokens at 2 bytes) and 64 KiB streamed (32,768): 262,144 +
	// 327,680 = 589,824 microdollars, × 1.5 → 89 credits.
	if got := creditCharge(12, false, false, true, unknown, price, 256<<10, 64<<10, 0, false, 0); got != 89 {
		t.Fatal("large unreported call", got)
	}
	// Partly reported: the larger of the partial usage, the estimate and the reserve.
	partial := InvocationUsage{Status: "partial", Source: "provider_raw", InputTokens: n(100000), OutputTokens: n(1000)}
	if got := creditCharge(12, false, false, true, partial, price, 0, 0, 0, false, 0); got != 32 {
		t.Fatal("partial usage", got)
	}
	// A price snapshot that cannot price anything still charges the reserve.
	if got := creditCharge(12, false, false, true, unknown, nil, 1<<20, 1<<20, 0, false, 0); got != 12 {
		t.Fatal("unpriceable snapshot", got)
	}
	// Reported usage wins over a refusal code: billed tokens are billed.
	if got := creditCharge(12, false, true, true, reported, price, 0, 0, 0, false, 0); got != 7 {
		t.Fatal("reported usage with a refusal code", got)
	}
	// A call that left no trace of reaching the provider costs its reserve, whatever its request's size.
	if got := creditCharge(12, false, false, false, unknown, price, 1<<20, 0, 0, false, time.Minute); got != 12 {
		t.Fatal("unreached call", got)
	}
	// Time before the first streamed text is hidden reasoning: a minute is 7,200 tokens. With 4,000 bytes sent and
	// 2,000 streamed: 4,000 + 10,000 + 72,000 = 86,000 microdollars, × 1.5 → 13 credits.
	if got := creditCharge(12, false, false, true, unknown, price, 4000, 2000, 0, false, time.Minute); got != 13 {
		t.Fatal("hidden reasoning", got)
	}
	// Cancelled while the model reasoned, before any text: five minutes is 36,000 tokens, past the old 32,000 cap, so
	// 4,000 + 360,000 microdollars, × 1.5 → 55 credits; ten minutes (72,000) is capped at the catalog's 65,536 per
	// call, so 4,000 + 655,360 microdollars, × 1.5 → 99 credits.
	if got := creditCharge(12, false, false, true, unknown, price, 4000, 0, 0, false, 5*time.Minute); got != 55 {
		t.Fatal("cancelled while reasoning for five minutes", got)
	}
	if got := creditCharge(12, false, false, true, unknown, price, 4000, 0, 0, false, 10*time.Minute); got != 99 {
		t.Fatal("cancelled while reasoning", got)
	}
	// A report of no output for a call that streamed some is not believed: it is estimated.
	zeroOut := InvocationUsage{Status: "reported", Source: "provider_raw", InputTokens: n(3000), OutputTokens: n(0)}
	if got := creditCharge(12, false, false, true, zeroOut, price, 4000, 200000, 0, false, 0); got != 151 {
		t.Fatal("a report of no output", got)
	}
	// Partly reported usage counts even when the call was then refused.
	if got := creditCharge(12, false, true, true, InvocationUsage{Status: "partial", Source: "provider_raw", InputTokens: n(100000), OutputTokens: n(1000)}, price, 0, 0, 0, false, 0); got != 32 {
		t.Fatal("partial usage and a refusal", got)
	}
	// Reasoning reported (a planner's) and the time before the first text are one estimate, the larger: 20,000
	// characters and 90 s (10,800 tokens) is 20,000 hidden tokens, so 4,000 + 10,000 + 200,000 microdollars → 33.
	if got := creditCharge(12, false, false, true, unknown, price, 4000, 2000, 20000, false, 90*time.Second); got != 33 {
		t.Fatal("planner reasoning", got)
	}
	// A report its price cannot read (no input count) still says the provider worked: never free, even with a refusal.
	unreadable := InvocationUsage{Status: "reported", Source: "provider_raw", OutputTokens: n(4000)}
	if got := creditCharge(12, false, true, true, unreadable, price, 4000, 0, 0, false, 0); got != 12 {
		t.Fatal("an unreadable report with a refusal code", got)
	}
	if !refusedBeforeOutput("provider_rate_limited", "MODEL_RATE_LIMIT", 0, 0) || refusedBeforeOutput("provider_rate_limited", "", 10, 0) || refusedBeforeOutput("runtime_failed", "", 0, 0) {
		t.Fatal("refusals")
	}
	// A throttle or a rejected credential after minutes of reasoning (a Bedrock stream throttled mid-way) may follow
	// billed work, like a late outage.
	if refusedBeforeOutput("provider_rate_limited", "MODEL_RATE_LIMIT", 0, 3*time.Minute) || refusedBeforeOutput("provider_auth_failed", "", 0, 20*time.Second) ||
		!refusedBeforeOutput("provider_auth_failed", "", 0, time.Second) {
		t.Fatal("late refusals")
	}
	// A quick refusal after reasoning the run was told about (a planner throttled mid-thought) is not free.
	if got := creditCharge(12, false, true, true, unknown, price, 4000, 0, 5000, false, 2*time.Second); got != 12 {
		t.Fatal("a refusal after reported reasoning", got)
	}
	// And a run told its model was reasoning without a count of it (every node run, and a planner run refused in the
	// moment after the start) says the same: the provider worked, so its refusal costs the reserve and not nothing.
	if got := creditCharge(12, false, true, true, unknown, price, 4000, 0, 0, true, 2*time.Second); got != 12 {
		t.Fatal("a refusal after reasoning with no count", got)
	}
	// What it is not is a quantity. It settles a refusal and never enters the estimate, because the counts behind it
	// are characters and this adds up tokens: the same call reaching the provider costs what the bytes and the time
	// say either way, with no third of a credit added for having reasoned.
	for _, reasoned := range []bool{false, true} {
		if got := creditCharge(12, false, false, true, unknown, price, 4000, 2000, 0, reasoned, time.Minute); got != 13 {
			t.Fatal("reasoning without a count changed an estimate", reasoned, got)
		}
	}
	// Token counts a report carried are never estimated below: 100,000 output tokens reported without an input
	// count is 2,000 in (4,000 bytes) + 100,000 out = 1,004,000 microdollars, × 1.5 → 151 credits.
	if got := creditCharge(12, false, false, true, InvocationUsage{Status: "reported", Source: "provider_raw", OutputTokens: n(100000)}, price, 4000, 0, 0, false, 0); got != 151 {
		t.Fatal("reported token counts in the estimate", got)
	}
	// Hidden time ends at the call's terminal event, not when it was recorded afterwards.
	t0 := time.Now()
	f := invocationFacts{Streamed: t0, Ended: t0.Add(3 * time.Second)}
	if got := f.unseen(t0.Add(20 * time.Second)); got != 3*time.Second {
		t.Fatal("unseen after the terminal event", got)
	}
	// An outage answered at once is not billed; a connection error, or an outage after a while, may follow billed work.
	if !refusedBeforeOutput("provider_unavailable", "MODEL_UNAVAILABLE", 0, 2*time.Second) || refusedBeforeOutput("provider_unavailable", "MODEL_UNAVAILABLE", 0, time.Minute) ||
		refusedBeforeOutput("provider_unavailable", "MODEL_CONNECTION_ERROR", 0, time.Second) {
		t.Fatal("outages")
	}
}

// Owner 2026-10-25: a call its worker cut for silence before it returned anything is not charged, however long it ran
// and whatever reasoning its run was told about; a call that streamed text first, whose usage was reported (in part
// too), that failed otherwise or that did not fail is not such a call.
func TestOnlyACallCutForSilenceBeforeAnyOutputIsStalled(t *testing.T) {
	n := func(v int64) *int64 { return &v }
	unknown := missingUsage("unknown", "transport_unknown")
	for _, u := range []InvocationUsage{unknown, missingUsage("unavailable", "provider_missing"), missingUsage("invalid", "protocol_invalid")} {
		if !stalledBeforeOutput("failed", &invocationFacts{WorkerCode: "MODEL_STALLED"}, u) {
			t.Fatal("a call cut for silence before any output, its usage", u.Status)
		}
	}
	if !stalledBeforeOutput("failed", &invocationFacts{WorkerCode: "MODEL_STALLED", Reasoned: true, HiddenTokens: 5000}, unknown) {
		t.Fatal("reasoning the run was told about made a call cut for silence chargeable")
	}
	stalled := &invocationFacts{WorkerCode: "MODEL_STALLED"}
	for name, c := range map[string]struct {
		status string
		f      *invocationFacts
		u      InvocationUsage
	}{
		"streamed text first": {"failed", &invocationFacts{WorkerCode: "MODEL_STALLED", OutputBytes: 1}, unknown},
		"usage reported":      {"failed", stalled, InvocationUsage{Status: "reported", Source: "provider_raw", InputTokens: n(10), OutputTokens: n(0)}},
		"usage in part":       {"failed", stalled, InvocationUsage{Status: "partial", Source: "provider_raw", InputTokens: n(10)}},
		"an outage":           {"failed", &invocationFacts{WorkerCode: "MODEL_UNAVAILABLE"}, unknown},
		"no worker code":      {"failed", &invocationFacts{}, unknown},
		"cancelled":           {"cancelled", stalled, unknown},
		"interrupted":         {"interrupted", stalled, unknown},
		"completed":           {"completed", stalled, unknown},
	} {
		if stalledBeforeOutput(c.status, c.f, c.u) {
			t.Fatal(name, "was taken as a call cut for silence before any output")
		}
	}
}

func TestStripeURLsMustBeStripes(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://checkout.stripe.com/c/pay/cs_test_1":       true,
		"https://checkout.stripe.com.evil.example/c/pay/cs": false,
		"https://user@checkout.stripe.com/c/pay/cs":         false,
		"http://checkout.stripe.com/c/pay/cs":               false,
		"https://billing.stripe.com/p/session/1":            false, // not the checkout prefix
		"javascript:alert(1)":                               false,
	} {
		if got := validStripeURL(raw, "https://checkout.stripe.com/"); got != want {
			t.Fatal(raw, got)
		}
	}
	if !validStripeURL("https://billing.stripe.com/p/session/1", "https://billing.stripe.com/") {
		t.Fatal("portal URL refused")
	}
}

// givePlan stores a paid period for the account behind email, as a sync from the issuer would; credits 0 is a
// period not paid for.
func givePlan(t *testing.T, h *harness, email, plan, status string, start, end time.Time, credits int) string {
	t.Helper()
	var uid string
	if e := h.db.QueryRow(context.Background(), "SELECT id FROM users WHERE email=$1", email).Scan(&uid); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(context.Background(), `INSERT INTO user_plans(user_id,plan,status,period_start,period_end,credits) VALUES($1,$2,$3,$4,$5,$6)
		ON CONFLICT (user_id) DO UPDATE SET plan=EXCLUDED.plan,status=EXCLUDED.status,period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,credits=EXCLUDED.credits`, uid, plan, status, start, end, credits); e != nil {
		t.Fatal(e)
	}
	return uid
}

// planRoutes are a new workspace's route limits: plans apply only to route-limited workspaces.
const planRoutes = `{"bedrock":1,"gate":3,"media":1}`

func planHarness(t *testing.T) *harness {
	t.Helper()
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	t.Cleanup(provider.Close)
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	h.a.cfg.NewWorkspaceRouteLimits = routeLimits{routeGate: 3, routeBedrock: 1, routeMedia: 1}
	var err error
	if h.a.pricing, err = ParseModelPricing(planPricing); err != nil {
		t.Fatal(err)
	}
	return h
}

func execSQL(t *testing.T, h *harness, sql string, args ...any) {
	t.Helper()
	if _, e := h.db.Exec(context.Background(), sql, args...); e != nil {
		t.Fatal(sql, e)
	}
}

// settleNewest settles the workspace's newest running call: charge nil leaves credit_charge unset.
func settleNewest(t *testing.T, h *harness, tid string, charge *int) {
	t.Helper()
	execSQL(t, h, `UPDATE model_invocations SET status='completed',cost_status='unavailable',credit_charge=$2 WHERE id=(SELECT id FROM model_invocations WHERE tenant_id=$1 AND status='running' ORDER BY created_at DESC LIMIT 1)`, tid, charge)
}

func intp(n int) *int { return &n }

func planCredits0(t *testing.T, h *harness, c *http.Cookie, tid string) map[string]any {
	t.Helper()
	u := h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)
	plan, _ := u["plan"].(map[string]any)
	if plan == nil {
		t.Fatal("no plan in the usage view", u)
	}
	return plan["credits"].(map[string]any)
}

func TestPostgresPaidPlanSpendsCreditsInsteadOfRouteLimits(t *testing.T) {
	h := planHarness(t)
	ca, ta, _ := h.register(t, "plan-a@example.test")
	ra := routeHarnessRun(t, h, ca, ta, `{"gate":3,"bedrock":1,"media":1}`)
	now := time.Now()
	uid := givePlan(t, h, "plan-a@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	// Five Claude calls and two Bedrock calls, beyond the free route limits of 3 and 1, and a free call. Pro runs
	// three model calls at once across the account, so each is settled before the next.
	for i, model := range []string{"claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5", "bedrock.claude-opus-5-5", "bedrock.claude-opus-5-5", "qwen3.8-27b-p6"} {
		if e := reserveModel(h, ta, ra, model); e != nil {
			t.Fatal("paid plan refused", model, e)
		}
		if i < 7 && i > 1 {
			settleNewest(t, h, ta, nil)
		}
	}
	type row struct {
		reserve, charge *int
		billed          *string
		period          *time.Time
	}
	rows, err := h.db.Query(context.Background(), "SELECT credit_reserve,credit_charge,billed_user_id,billed_period_start FROM model_invocations WHERE tenant_id=$1 ORDER BY created_at", ta)
	if err != nil {
		t.Fatal(err)
	}
	list := []row{}
	for rows.Next() {
		var r row
		rows.Scan(&r.reserve, &r.charge, &r.billed, &r.period)
		list = append(list, r)
	}
	rows.Close()
	if len(list) != 8 || *list[0].reserve != 12 || *list[5].reserve != 26 || list[7].reserve != nil {
		t.Fatal("reserves", list)
	}
	for _, r := range list {
		if r.billed == nil || *r.billed != uid || r.period == nil || !r.period.Equal(now.Add(-time.Hour).Truncate(time.Microsecond)) {
			t.Fatal("every call under the plan names the account and its period", *r.billed, r.period)
		}
	}
	if c := planCredits0(t, h, ca, ta); c["granted"] != 2000.0 || c["spent"] != 112.0 || c["remaining"] != 1888.0 {
		t.Fatal("unsettled calls count their reserves", c)
	}
	// A settled call costs its charge.
	execSQL(t, h, `UPDATE model_invocations SET status='completed',credit_charge=CASE WHEN credit_reserve IS NULL THEN NULL WHEN model_id='claude-sonnet-5' THEN 3 ELSE 0 END WHERE tenant_id=$1`, ta)
	if c := planCredits0(t, h, ca, ta); c["spent"] != 15.0 {
		t.Fatal("settled charges", c)
	}
	// Once the period's credits cannot hold another call's reserve, paid routes are refused; free ones are not.
	execSQL(t, h, `UPDATE model_invocations SET credit_charge=1990 WHERE id=(SELECT id FROM model_invocations WHERE tenant_id=$1 AND credit_reserve IS NOT NULL ORDER BY created_at LIMIT 1)`, ta)
	if e := reserveModel(h, ta, ra, "claude-sonnet-5"); !errors.Is(e, errCreditsExhausted) {
		t.Fatal("exhausted credits admitted", e)
	}
	if e := reserveModel(h, ta, ra, "qwen3.8-27b-p6"); e != nil {
		t.Fatal("the free model spends no credits", e)
	}
	settleNewest(t, h, ta, nil)
	if c := planCredits0(t, h, ca, ta); c["remaining"] != 0.0 {
		t.Fatal("remaining never goes below zero", c)
	}
	// The next paid period starts with its own credits: nothing billed to an earlier period counts in it.
	execSQL(t, h, "UPDATE user_plans SET period_start=now(),period_end=now()+interval '30 days'")
	if e := reserveModel(h, ta, ra, "claude-sonnet-5"); e != nil {
		t.Fatal("an earlier period's spend was counted", e)
	}
	settleNewest(t, h, ta, intp(12))
	// A period without paid credits entitles nothing: the free plan's allowances apply, which the paid calls
	// never spent.
	execSQL(t, h, "UPDATE user_plans SET credits=0")
	if e := reserveModel(h, ta, ra, "claude-sonnet-5"); e != nil {
		t.Fatal("the free gate allowance after paid calls", e)
	}
	var billed *string
	if e := h.db.QueryRow(context.Background(), "SELECT billed_user_id FROM model_invocations WHERE tenant_id=$1 AND status='running'", ta).Scan(&billed); e != nil || billed != nil {
		t.Fatal("a free call was billed", billed, e)
	}
	settleNewest(t, h, ta, nil)
	// After the period and its grace day, or once cancelled, the free plan's route limits apply again: and the
	// paid calls of today never spent the free route allowance.
	execSQL(t, h, "UPDATE user_plans SET credits=2000,period_start=now()-interval '40 days',period_end=now()-interval '2 days'")
	if e := reserveModel(h, ta, ra, "bedrock.claude-opus-5-5"); e != nil {
		t.Fatal("paid Bedrock calls spent the free allowance", e)
	}
	settleNewest(t, h, ta, nil)
	if e := reserveModel(h, ta, ra, "bedrock.claude-opus-5-5"); !errors.Is(e, errRouteQuota) {
		t.Fatal("an expired plan still spent credits", e)
	}
	execSQL(t, h, "UPDATE user_plans SET period_start=now()-interval '1 hour',period_end=now()+interval '30 days',status='canceled'")
	if e := reserveModel(h, ta, ra, "bedrock.claude-opus-5-5"); !errors.Is(e, errRouteQuota) {
		t.Fatal("a cancelled plan still spent credits", e)
	}
	// Past due (Stripe still retrying the renewal) keeps the paid period.
	execSQL(t, h, "UPDATE user_plans SET status='past_due'")
	if e := reserveModel(h, ta, ra, "bedrock.claude-opus-5-5"); e != nil {
		t.Fatal("past due lost the plan", e)
	}
}

func TestPostgresPaidPlanAllowancesAreTheAccounts(t *testing.T) {
	h := planHarness(t)
	ca, ta, _ := h.register(t, "plan-wide@example.test")
	ra := routeHarnessRun(t, h, ca, ta, planRoutes)
	second := h.request(t, ca, "POST", "/tenants", map[string]string{"name": "Second"}, 201)["id"].(string)
	rb := routeHarnessRun(t, h, ca, second, planRoutes)
	now := time.Now()
	givePlan(t, h, "plan-wide@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	// Three model calls at once across both workspaces; the fourth waits for one of them.
	for _, c := range [][2]string{{ta, ra}, {second, rb}, {ta, ra}} {
		if e := reserveModel(h, c[0], c[1], "claude-sonnet-5"); e != nil {
			t.Fatal(e)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	e := h.a.reserveInvocation(ctx, second, rb, randomID(), "claude-sonnet-5", &invocationFacts{Runtime: runtimePI, Model: "claude-sonnet-5"})
	cancel()
	if !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("a fourth call ran at once", e)
	}
	settleNewest(t, h, ta, nil)
	if e := reserveModel(h, second, rb, "claude-sonnet-5"); e != nil {
		t.Fatal("a freed slot", e)
	}
	execSQL(t, h, "UPDATE model_invocations SET status='completed',credit_charge=credit_reserve WHERE status='running'")
	// The default model's 300 calls a day are the account's: 299 in one workspace leave one in the other.
	execSQL(t, h, `INSERT INTO model_invocations(id,tenant_id,run_id,status,runtime,model_id,admission_status,usage_status,usage_source,usage_reason,cost_status,billed_user_id,billed_period_start)
		SELECT 'free-'||g,$1,$2,'completed','pi','qwen3.8-27b-p6','accepted','unavailable','none','provider_missing','unavailable',p.user_id,p.period_start FROM generate_series(1,299) g, user_plans p`, ta, ra)
	if e := reserveModel(h, second, rb, "qwen3.8-27b-p6"); e != nil {
		t.Fatal("the 300th call", e)
	}
	settleNewest(t, h, second, nil)
	if e := reserveModel(h, ta, ra, "qwen3.8-27b-p6"); !errors.Is(e, errInvocationQuota) {
		t.Fatal("the 301st call", e)
	}
	// Paid calls are not counted against the default model's daily calls.
	if e := reserveModel(h, ta, ra, "claude-sonnet-5"); e != nil {
		t.Fatal("a paid call after the daily calls", e)
	}
	u := h.request(t, ca, "GET", "/tenants/"+second+"/route-usage", nil, 200)
	if d := u["daily"].(map[string]any); d["limit"] != 300.0 || d["used"] != 300.0 {
		t.Fatal("the daily calls shown are the account's", u)
	}
}

func TestPostgresPaidPlanCreditsAreTheAccountsAndSurviveDeletion(t *testing.T) {
	h := planHarness(t)
	ca, ta, _ := h.register(t, "plan-owner@example.test")
	ra := routeHarnessRun(t, h, ca, ta, planRoutes)
	second := h.request(t, ca, "POST", "/tenants", map[string]string{"name": "Second"}, 201)["id"].(string)
	rb := routeHarnessRun(t, h, ca, second, planRoutes)
	cm, tm, _ := h.register(t, "plan-member@example.test")
	rm := routeHarnessRun(t, h, cm, tm, planRoutes)
	now := time.Now()
	owner := givePlan(t, h, "plan-owner@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	for _, c := range [][2]string{{ta, ra}, {second, rb}} {
		if e := reserveModel(h, c[0], c[1], "claude-sonnet-5"); e != nil {
			t.Fatal(e)
		}
	}
	// Another account's workspace has no plan and spends nothing of these credits.
	if e := reserveModel(h, tm, rm, "claude-sonnet-5"); e != nil {
		t.Fatal(e)
	}
	// Generations: one the provider accepted, one still queued (it may be), one whose run ended before the
	// provider took it, and one the provider accepted after its run was cancelled.
	cid, _, sid := h.fixture(t, ca, ta)
	for i, c := range []struct {
		status   string
		accepted *bool
	}{{"completed", boolp(true)}, {"queued", nil}, {"failed", nil}, {"cancelled", boolp(true)}} {
		rid := randomID()
		execSQL(t, h, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p',$5)", rid, ta, sid, "media-"+rid, c.status)
		execSQL(t, h, `INSERT INTO media_generations(run_id,tenant_id,model,credit_points,provider_accepted,billed_user_id,billed_period_start)
			SELECT $1,$2,'rh.seedream-v5-pro',$3,$4,user_id,period_start FROM user_plans WHERE user_id=$5`, rid, ta, 30+i, c.accepted, owner)
	}
	want := 12.0 + 12 + 30 + 31 + 33
	for _, tid := range []string{ta, second} {
		if c := planCredits0(t, h, ca, tid); c["spent"] != want {
			t.Fatal("credits are the owner's, across workspaces", tid, c)
		}
	}
	if u := h.request(t, cm, "GET", "/tenants/"+tm+"/route-usage", nil, 200); u["plan"] != nil {
		t.Fatal("another account's workspace has the plan", u)
	}
	// Deleting the canvas (and with it the runs) gives nothing back: the queued generation's run is gone, so it
	// was never accepted.
	execSQL(t, h, "UPDATE runs SET status='completed' WHERE tenant_id=$1 AND status='queued'", ta)
	h.request(t, ca, "DELETE", "/tenants/"+ta+"/canvases/"+cid, nil, 204)
	if c := planCredits0(t, h, ca, ta); c["spent"] != want-31 {
		t.Fatal("deleting a canvas gave credits back", c)
	}
}

func boolp(b bool) *bool { return &b }

func TestPostgresPaidCallsLeaveTheFreeCeilingsAlone(t *testing.T) {
	h := planHarness(t)
	h.a.cfg.RouteTotalsPerDay = routeLimits{routeGate: 2, routeBedrock: 1}
	cp, tp, _ := h.register(t, "ceiling-paid@example.test")
	rp := routeHarnessRun(t, h, cp, tp, `{"gate":3,"bedrock":1}`)
	cf, tf, _ := h.register(t, "ceiling-free@example.test")
	rf := routeHarnessRun(t, h, cf, tf, `{"gate":3,"bedrock":1}`)
	now := time.Now()
	givePlan(t, h, "ceiling-paid@example.test", "max", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 10000)
	for i := 0; i < 4; i++ {
		for _, model := range []string{"claude-sonnet-5", "bedrock.claude-opus-5-5"} {
			if e := reserveModel(h, tp, rp, model); e != nil {
				t.Fatal("paid call", i, model, e)
			}
			settleNewest(t, h, tp, nil)
		}
	}
	// The paid account's eight calls left the deployment's free gate and Bedrock ceilings untouched.
	for _, model := range []string{"claude-sonnet-5", "claude-sonnet-5", "bedrock.claude-opus-5-5"} {
		if e := reserveModel(h, tf, rf, model); e != nil {
			t.Fatal("free call after paid traffic", model, e)
		}
	}
	if e := reserveModel(h, tf, rf, "claude-sonnet-5"); !errors.Is(e, errRouteCapacity) {
		t.Fatal("the free ceiling", e)
	}
	// A paid model without a price for its runtime is refused on the plan.
	if e := h.a.reserveInvocation(context.Background(), tp, rp, randomID(), "gpt-5.5", &invocationFacts{Runtime: runtimePI, Model: "gpt-5.5"}); !errors.Is(e, errModelUnpriced) {
		t.Fatal("unpriced model", e)
	}
}

func TestPostgresPlanWorkspacesRunOnlyOnThePlan(t *testing.T) {
	h := planHarness(t)
	h.a.cfg.MaxOwnedWorkspaces = 1
	c, tid, _ := h.register(t, "plan-limits@example.test")
	requireCode(t, h.request(t, c, "POST", "/tenants", map[string]string{"name": "Second"}, 403), "workspace_limit")
	now := time.Now()
	givePlan(t, h, "plan-limits@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	second := h.request(t, c, "POST", "/tenants", map[string]string{"name": "Second"}, 201)["id"].(string)
	h.request(t, c, "POST", "/tenants", map[string]string{"name": "Third"}, 201)
	requireCode(t, h.request(t, c, "POST", "/tenants", map[string]string{"name": "Fourth"}, 403), "workspace_limit")
	var required []bool
	rows, _ := h.db.Query(context.Background(), "SELECT t.requires_plan FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=(SELECT id FROM users WHERE email='plan-limits@example.test') ORDER BY m.created_at")
	for rows.Next() {
		var b bool
		rows.Scan(&b)
		required = append(required, b)
	}
	rows.Close()
	if !reflect.DeepEqual(required, []bool{false, true, true}) {
		t.Fatal("the workspaces beyond the free limit need the plan", required)
	}
	// Without the plan they run nothing; the first workspace runs on the free plan; the plan back, all run.
	rs := routeHarnessRun(t, h, c, second, planRoutes)
	r1 := routeHarnessRun(t, h, c, tid, planRoutes)
	if e := reserveModel(h, second, rs, "qwen3.8-27b-p6"); e != nil {
		t.Fatal(e)
	}
	settleNewest(t, h, second, nil)
	execSQL(t, h, "UPDATE user_plans SET status='canceled'")
	if e := reserveModel(h, second, rs, "qwen3.8-27b-p6"); !errors.Is(e, errPlanRequired) {
		t.Fatal("a plan workspace ran without the plan", e)
	}
	_, _, sid := h.fixture(t, c, second)
	requireCode(t, h.request(t, c, "POST", "/tenants/"+second+"/runs", map[string]any{"sessionId": sid, "prompt": "hi", "operationId": "op-required-1"}, 402), "plan_required")
	if e := reserveModel(h, tid, r1, "qwen3.8-27b-p6"); e != nil {
		t.Fatal("the free workspace", e)
	}
	execSQL(t, h, "UPDATE user_plans SET status='active'")
	if e := reserveModel(h, second, rs, "qwen3.8-27b-p6"); e != nil {
		t.Fatal("renewed", e)
	}
	settleNewest(t, h, second, nil)
	// On Max the account opens two more; back on Pro, the workspaces past Pro's three run nothing.
	execSQL(t, h, "UPDATE user_plans SET plan='max'")
	fourth := h.request(t, c, "POST", "/tenants", map[string]string{"name": "Fourth"}, 201)["id"].(string)
	r4 := routeHarnessRun(t, h, c, fourth, planRoutes)
	if e := reserveModel(h, fourth, r4, "qwen3.8-27b-p6"); e != nil {
		t.Fatal("a fourth workspace on Max", e)
	}
	settleNewest(t, h, fourth, nil)
	execSQL(t, h, "UPDATE user_plans SET plan='pro'")
	if e := reserveModel(h, fourth, r4, "qwen3.8-27b-p6"); !errors.Is(e, errPlanRequired) {
		t.Fatal("a fourth workspace on Pro", e)
	}
	if e := reserveModel(h, second, rs, "qwen3.8-27b-p6"); e != nil {
		t.Fatal("the second workspace on Pro", e)
	}
}

func TestPostgresPlanRunsAtOnceAreTheAccounts(t *testing.T) {
	h := planHarness(t)
	c, ta, _ := h.register(t, "plan-runs-at-once@example.test")
	second := h.request(t, c, "POST", "/tenants", map[string]string{"name": "Second"}, 201)["id"].(string)
	legacy := h.request(t, c, "POST", "/tenants", map[string]string{"name": "Legacy"}, 201)["id"].(string)
	execSQL(t, h, "UPDATE tenants SET route_limits=NULL,max_concurrent_runs=10 WHERE id=$1", legacy)
	execSQL(t, h, "UPDATE tenants SET max_concurrent_runs=10 WHERE id IN ($1,$2)", ta, second)
	now := time.Now()
	givePlan(t, h, "plan-runs-at-once@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	// Pro runs three at once across the account's plan workspaces: two here, one there, a fourth is refused.
	sessions := map[string]string{}
	for _, tid := range []string{ta, second, legacy} {
		_, _, sid := h.fixture(t, c, tid)
		sessions[tid] = sid
	}
	for i, tid := range []string{ta, ta, second} {
		_, _, sid := h.fixture(t, c, tid)
		rid := randomID()
		execSQL(t, h, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$4,'h','p','running')", rid, tid, sid, fmt.Sprintf("busy-run-%d", i))
	}
	requireCode(t, h.request(t, c, "POST", "/tenants/"+second+"/runs", map[string]any{"sessionId": sessions[second], "prompt": "hi", "operationId": "op-fourth-run"}, 429), "plan_busy")
	// The older workspace without route limits keeps its own allowances and is not counted.
	h.request(t, c, "POST", "/tenants/"+legacy+"/runs", map[string]any{"sessionId": sessions[legacy], "prompt": "hi", "operationId": "op-legacy-run"}, 202)
	if p, e := ownerPlan(context.Background(), h.db, legacy, false); e != nil || p != nil {
		t.Fatal("an older workspace took the plan", p, e)
	}
	n, e := accountSlotsUsed(context.Background(), h.db, givePlanUser(t, h, "plan-runs-at-once@example.test"))
	if e != nil || n != 3 {
		t.Fatal("slots used", n, e)
	}
	// A paid model in that workspace is admitted on its own allowances and billed to no one.
	rl := routeHarnessRun(t, h, c, legacy, "")
	if e := reserveModel(h, legacy, rl, "claude-sonnet-5"); e != nil {
		t.Fatal("legacy paid call", e)
	}
	var billed *string
	if e := h.db.QueryRow(context.Background(), "SELECT billed_user_id FROM model_invocations WHERE tenant_id=$1", legacy).Scan(&billed); e != nil || billed != nil {
		t.Fatal("a legacy call was billed", billed, e)
	}
}

// A workspace that limits no route (an empty object) is on its owner's plan, so the operator's own unlimited
// workspaces can subscribe. Without a plan its paid calls are admitted on its own allowances, outside the
// ceilings, and billed to no one; on the plan they hold the period's credits.
func TestPostgresPlanAppliesToAWorkspaceThatLimitsNoRoute(t *testing.T) {
	h := planHarness(t)
	h.a.cfg.RouteTotalsPerDay = routeLimits{routeGate: 1}
	c, tid, _ := h.register(t, "plan-no-route-limited@example.test")
	rid := routeHarnessRun(t, h, c, tid, `{}`)
	for i := 0; i < 3; i++ {
		if e := reserveModel(h, tid, rid, "claude-sonnet-5"); e != nil {
			t.Fatal("paid call without a plan", i, e)
		}
	}
	var billed int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND billed_user_id IS NOT NULL", tid).Scan(&billed); e != nil || billed != 0 {
		t.Fatal("calls billed without a plan", billed, e)
	}
	now := time.Now()
	uid := givePlan(t, h, "plan-no-route-limited@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	if p, e := ownerPlan(context.Background(), h.db, tid, false); e != nil || p == nil || p.UserID != uid {
		t.Fatal("the workspace did not take its owner's plan", p, e)
	}
	if e := reserveModel(h, tid, rid, "claude-sonnet-5"); e != nil {
		t.Fatal("paid call on the plan", e)
	}
	var reserve *int
	if e := h.db.QueryRow(context.Background(), "SELECT credit_reserve FROM model_invocations WHERE tenant_id=$1 AND billed_user_id=$2", tid, uid).Scan(&reserve); e != nil || reserve == nil || *reserve <= 0 {
		t.Fatal("the call on the plan holds no credits", reserve, e)
	}
}

func givePlanUser(t *testing.T, h *harness, email string) string {
	t.Helper()
	var uid string
	if e := h.db.QueryRow(context.Background(), "SELECT id FROM users WHERE email=$1", email).Scan(&uid); e != nil {
		t.Fatal(e)
	}
	return uid
}

func TestPostgresOverspendIsCarriedIntoTheNextPeriod(t *testing.T) {
	h := planHarness(t)
	c, tid, _ := h.register(t, "plan-carry@example.test")
	rid := routeHarnessRun(t, h, c, tid, planRoutes)
	now := time.Now()
	uid := givePlan(t, h, "plan-carry@example.test", "pro", "active", now.Add(-30*24*time.Hour), now.Add(-time.Minute), 2000)
	// The period's last credits admitted calls that cost 2,150 in all: 150 past its 2,000.
	if e := reserveModel(h, tid, rid, "claude-sonnet-5"); e != nil {
		t.Fatal(e)
	}
	settleNewest(t, h, tid, intp(2150))
	ctx := context.Background()
	// The next period's answer is asked at nextAsked; older stands for a read asked a moment before it whose answer
	// comes back after it.
	nextAsked := dbNow(t, h)
	older := nextAsked.Add(-time.Millisecond)
	next := paidPlan("pro", now.Add(-time.Minute).Unix(), now.Add(30*24*time.Hour).Unix(), map[string]int64{"pro": 2000})
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, next), nextAsked); e != nil {
		t.Fatal(e)
	}
	p, e := accountPlan(ctx, h.db, uid)
	if e == nil {
		e = withCarry(ctx, h.db, p)
	}
	if e != nil || p == nil || p.Carry != 150 || p.Credits != 2000 {
		t.Fatal("carry", p, e)
	}
	spent, _ := creditsSpent(ctx, h.db, p)
	if p.remaining(spent) != 1850 {
		t.Fatal("remaining", p.remaining(spent))
	}
	// A later answer about the same period keeps the carry; an answer to an older request changes nothing.
	same := paidPlan("max", now.Add(-time.Minute).Unix(), now.Add(30*24*time.Hour).Unix(), map[string]int64{"pro": 1000, "max": 5000})
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, same), older); e != nil {
		t.Fatal(e)
	}
	if p, _ = accountPlan(ctx, h.db, uid); p.Plan != "pro" || p.Credits != 2000 {
		t.Fatal("an older answer applied", p)
	}
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, same), dbNow(t, h)); e != nil {
		t.Fatal(e)
	}
	if p, _ = accountPlan(ctx, h.db, uid); withCarry(ctx, h.db, p) != nil || p.Plan != "max" || p.Credits != 6000 || p.Carry != 150 {
		t.Fatal("the same period", p)
	}
	u := h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)
	if credits := u["plan"].(map[string]any)["credits"].(map[string]any); credits["carried"] != 150.0 || credits["remaining"] != 5850.0 {
		t.Fatal("usage view", credits)
	}
	// A call of the previous period still running at the switch counts there when it settles, not at its reserve.
	execSQL(t, h, `INSERT INTO model_invocations(id,tenant_id,run_id,status,runtime,model_id,admission_status,usage_status,usage_source,usage_reason,cost_status,credit_reserve,billed_user_id,billed_period_start)
		VALUES('late-call',$1,$2,'running','pi','claude-sonnet-5','accepted','unknown','none','transport_unknown','unknown',12,$3,$4)`, tid, rid, uid, now.Add(-30*24*time.Hour))
	if p, _ = accountPlan(ctx, h.db, uid); withCarry(ctx, h.db, p) != nil || p.Carry != 162 {
		t.Fatal("a running call of the previous period", p.Carry)
	}
	execSQL(t, h, "UPDATE model_invocations SET status='completed',credit_charge=40 WHERE id='late-call'")
	if p, _ = accountPlan(ctx, h.db, uid); withCarry(ctx, h.db, p) != nil || p.Carry != 190 {
		t.Fatal("a late settlement of the previous period", p.Carry)
	}
	// A full refund of the charged period leaves it no credits: the plan stops, the carry stays.
	refunded := paidPlan("max", now.Add(-time.Minute).Unix(), now.Add(30*24*time.Hour).Unix(), nil)
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, refunded), dbNow(t, h)); e != nil {
		t.Fatal(e)
	}
	if p, _ = accountPlan(ctx, h.db, uid); p != nil {
		t.Fatal("a refunded period still entitles", p)
	}
	var credits, prevCredits int
	if e := h.db.QueryRow(ctx, "SELECT credits,prev_credits FROM user_plans WHERE user_id=$1", uid).Scan(&credits, &prevCredits); e != nil || credits != 0 || prevCredits != 2000 {
		t.Fatal("refunded row", credits, prevCredits, e)
	}
	// No subscription at all ends the plan and keeps its record.
	if e := h.a.applyPlan(ctx, uid, nil, dbNow(t, h)); e != nil {
		t.Fatal(e)
	}
	var status string
	if e := h.db.QueryRow(ctx, "SELECT status FROM user_plans WHERE user_id=$1", uid).Scan(&status); e != nil || status != "canceled" {
		t.Fatal("no subscription", status, e)
	}
}

func TestPostgresParallelCallsTakeSlotsButARunsFirstCallNeverWaits(t *testing.T) {
	h := planHarness(t)
	c, ta, _ := h.register(t, "plan-slots@example.test")
	second := h.request(t, c, "POST", "/tenants", map[string]string{"name": "Second"}, 201)["id"].(string)
	now := time.Now()
	givePlan(t, h, "plan-slots@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	team := routeHarnessRun(t, h, c, ta, planRoutes)
	coding := routeHarnessRun(t, h, c, second, planRoutes)
	// Two runs hold two of Pro's three slots. The team run's first call takes its own; its second member takes the
	// third; a third member waits.
	for i := 0; i < 2; i++ {
		if e := reserveModel(h, ta, team, "claude-sonnet-5"); e != nil {
			t.Fatal("team member", i, e)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	e := h.a.reserveInvocation(ctx, ta, team, randomID(), "claude-sonnet-5", &invocationFacts{Runtime: runtimePI, Model: "claude-sonnet-5"})
	cancel()
	if e == nil {
		t.Fatal("a third member ran at once")
	}
	// The other run's call is its run's first: it is admitted at once although every slot is in use.
	start := time.Now()
	if e := reserveModel(h, second, coding, "claude-sonnet-5"); e != nil || time.Since(start) > 2*time.Second {
		t.Fatal("a run's first call waited", e, time.Since(start))
	}
	// And no new run starts while the slots are in use.
	_, _, sid := h.fixture(t, c, second)
	requireCode(t, h.request(t, c, "POST", "/tenants/"+second+"/runs", map[string]any{"sessionId": sid, "prompt": "hi", "operationId": "op-no-slot"}, 429), "plan_busy")
}

func decodePlan(t *testing.T, plan map[string]any) *clawHuntPlan {
	t.Helper()
	raw, _ := json.Marshal(plan)
	var p clawHuntPlan
	if e := json.Unmarshal(raw, &p); e != nil {
		t.Fatal(e)
	}
	return &p
}

func TestPostgresRuntimeRequestsNeverSentAreMarked(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	_, e := h.a.admitRuntimeWith(context.Background(), runtimePI, []byte(`{"model":"m"}`), nil)
	if !errors.Is(e, errNotSent) {
		t.Fatal("a refused connection", e)
	}
}

func TestPostgresPaidRunsAreChargedFromTheirUsageOrTheirSize(t *testing.T) {
	var reply func(w http.ResponseWriter)
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { reply(w) })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	h.a.cfg.NewWorkspaceRouteLimits = routeLimits{routeGate: 3, routeBedrock: 1, routeMedia: 1}
	var err error
	if h.a.pricing, err = ParseModelPricing(planPricing); err != nil {
		t.Fatal(err)
	}
	c, tid, _ := h.register(t, "plan-runs@example.test")
	now := time.Now()
	givePlan(t, h, "plan-runs@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	_, _, sid := h.fixture(t, c, tid)
	charge := func(op string) int {
		t.Helper()
		run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "hello", "operationId": op}, 202)
		h.awaitRun(t, c, tid, run["id"].(string), "completed")
		var n *int
		if e := h.db.QueryRow(context.Background(), "SELECT credit_charge FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, run["id"]).Scan(&n); e != nil || n == nil {
			t.Fatal("charge", n, e)
		}
		return *n
	}
	// Reported usage: 3k in + 4k out → 7 credits.
	reply = func(w http.ResponseWriter) {
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": "done", "observability": map[string]any{"version": 1,
			"usage":  map[string]any{"status": "reported", "source": "provider_raw", "inputTokens": 3000, "outputTokens": 4000, "cachedInputTokens": nil, "cacheWriteTokens": nil, "reasoningTokens": nil, "providerTotalTokens": nil, "computedTotalTokens": nil},
			"timing": map[string]any{"setupMs": nil, "providerMs": nil, "providerTtftMs": nil, "workerTotalMs": nil, "workerFirstDeltaMs": nil}}})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}
	if got := charge("op-run-reported"); got != 7 {
		t.Fatal("reported", got)
	}
	// No usage, a short answer: the reserve.
	reply = func(w http.ResponseWriter) { completePi(w, "done") }
	if got := charge("op-run-small"); got != 12 {
		t.Fatal("small unreported", got)
	}
	// No usage, a long streamed answer: estimated from its bytes (600,000 bytes → 300,000 tokens → $3 × 1.5 →
	// 450 credits, plus the request).
	long := strings.Repeat("a", 600000)
	reply = func(w http.ResponseWriter) {
		for i := 0; i < len(long); i += 60000 {
			raw, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": long[i : i+60000]})
			fmt.Fprintf(w, "data: %s\n\n", raw)
		}
		completePi(w, long)
	}
	if got := charge("op-run-long"); got < 450 || got > 460 {
		t.Fatal("long unreported", got)
	}
}

// sameInstant compares a JSON timestamp with a Unix time.
func sameInstant(v any, unix int64) bool {
	s, _ := v.(string)
	at, err := time.Parse(time.RFC3339Nano, s)
	return err == nil && at.Unix() == unix
}

func clawHuntPlanBody(f *identityFixture, plan map[string]any) map[string]any {
	return map[string]any{"active": true, "sub": f.id.Subject, "plan": plan}
}

func paidPlan(id string, start, end int64, paid map[string]int64) map[string]any {
	return map[string]any{"id": id, "status": "active", "period_start": start, "period_end": end, "cancel_at_period_end": false, "paid": paid}
}

func TestPostgresBillingSyncsWhatWasPaidFromClawHunt(t *testing.T) {
	h, f, c := clawHuntMember(t)
	h.a.billingCalls.perMinute = 1000
	// An account that never subscribed is free, read fresh: no plan stored, none at ClawHunt, nothing stale.
	f.billingBody.Store("plan", clawHuntPlanBody(f, nil))
	if out := h.request(t, c, "GET", "/billing", nil, 200); out["plan"] != nil || out["credits"] != nil || out["stale"] != false {
		t.Fatal("an account that never subscribed", out)
	}
	var uid string
	if e := h.db.QueryRow(context.Background(), "SELECT user_id FROM external_identities").Scan(&uid); e != nil {
		t.Fatal(e)
	}
	if e := h.a.applyPlan(context.Background(), uid, nil, dbNow(t, h)); e != nil {
		t.Fatal("no subscription and no stored plan", e)
	}
	start, end := time.Now().Add(-time.Hour).Unix(), time.Now().Add(30*24*time.Hour).Unix()
	f.billingBody.Store("plan", clawHuntPlanBody(f, paidPlan("pro", start, end, map[string]int64{"pro": 2000})))
	out := h.request(t, c, "GET", "/billing", nil, 200)
	plan, _ := out["plan"].(map[string]any)
	credits, _ := out["credits"].(map[string]any)
	if plan == nil || plan["id"] != "pro" || plan["entitled"] != true || credits["granted"] != 2000.0 || credits["spent"] != 0.0 ||
		out["checkoutEnabled"] != false || out["stale"] != false || len(out["catalog"].([]any)) != 2 {
		t.Fatal("billing view", out)
	}
	if req, _ := f.billingRequest.Load("plan"); req.(map[string]any)["grant_token"] != strings.Repeat("g", 43) || req.(map[string]any)["rebuild"] != false {
		t.Fatal("asked with another grant", req)
	}
	// A fresh plan is not asked about again; ?refresh=1 asks, now with the plan on record.
	calls := f.billingCalls.Load()
	h.request(t, c, "GET", "/billing", nil, 200)
	if f.billingCalls.Load() != calls {
		t.Fatal("a fresh plan was asked about again")
	}
	// An upgrade to Max in the period buys what its proration charged.
	upgraded := paidPlan("max", start, end, map[string]int64{"pro": 2000 - 1900, "max": 9500})
	upgraded["cancel_at_period_end"] = true
	f.billingBody.Store("plan", clawHuntPlanBody(f, upgraded))
	if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); out["plan"].(map[string]any)["id"] != "max" || out["plan"].(map[string]any)["cancelAtPeriodEnd"] != true || out["credits"].(map[string]any)["granted"] != 9600.0 {
		t.Fatal("upgrade", out)
	}
	if req, _ := f.billingRequest.Load("plan"); req.(map[string]any)["rebuild"] != true {
		t.Fatal("a plan on record asks for a rebuild of a lost one", req)
	}
	// A switch to Max whose charge has not been paid keeps Pro's allowances and credits.
	f.billingBody.Store("plan", clawHuntPlanBody(f, paidPlan("max", start, end, map[string]int64{"pro": 9600})))
	if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); out["plan"].(map[string]any)["id"] != "pro" || out["credits"].(map[string]any)["granted"] != 9600.0 {
		t.Fatal("an unpaid switch", out)
	}
	f.billingBody.Store("plan", clawHuntPlanBody(f, upgraded))
	h.request(t, c, "GET", "/billing?refresh=1", nil, 200)
	// A renewal not paid yet keeps the paid period and its credits; its status follows.
	next := paidPlan("max", end, end+30*86400, nil)
	next["status"] = "past_due"
	f.billingBody.Store("plan", clawHuntPlanBody(f, next))
	out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200)
	if p := out["plan"].(map[string]any); p["status"] != "past_due" || p["entitled"] != true || !sameInstant(p["periodEnd"], end) || out["credits"].(map[string]any)["granted"] != 9600.0 {
		t.Fatal("unpaid renewal", out)
	}
	// Paid, it becomes the period, with its own credits; an older period reported later changes nothing.
	f.billingBody.Store("plan", clawHuntPlanBody(f, paidPlan("max", end, end+30*86400, map[string]int64{"max": 10000})))
	if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); !sameInstant(out["plan"].(map[string]any)["periodStart"], end) || out["credits"].(map[string]any)["granted"] != 10000.0 {
		t.Fatal("paid renewal", out)
	}
	f.billingBody.Store("plan", clawHuntPlanBody(f, paidPlan("pro", start, end, map[string]int64{"pro": 2000})))
	if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); out["plan"].(map[string]any)["id"] != "max" || out["stale"] != false {
		t.Fatal("an older period moved the plan back", out)
	}
	// Answers that are not the documented shape, or not about this account, change nothing.
	for _, bad := range []map[string]any{
		{"active": true, "sub": "subject-other", "plan": paidPlan("pro", end, end+86400, map[string]int64{"pro": 2000})},
		clawHuntPlanBody(f, paidPlan("ultra", end, end+86400, nil)),
		clawHuntPlanBody(f, map[string]any{"id": "pro", "status": "free", "period_start": end, "period_end": end + 86400}),
		clawHuntPlanBody(f, paidPlan("pro", end, start, nil)),
		clawHuntPlanBody(f, paidPlan("pro", end, end+500*86400, nil)),
		clawHuntPlanBody(f, paidPlan("pro", end, end+86400, map[string]int64{"ultra": 1})),
	} {
		f.billingBody.Store("plan", bad)
		if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); out["stale"] != true || out["plan"].(map[string]any)["id"] != "max" {
			t.Fatal("a bad answer changed the plan", bad, out)
		}
	}
	f.billingStatus.Store("plan", 503)
	if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); out["stale"] != true || out["plan"] == nil {
		t.Fatal("issuer down", out)
	}
	f.billingStatus.Store("plan", 0)
	// A subscription that was never paid is shown but entitles nothing.
	f.billingBody.Store("plan", clawHuntPlanBody(f, nil))
	h.request(t, c, "GET", "/billing?refresh=1", nil, 200)
	incomplete := paidPlan("pro", end, end+30*86400, nil)
	incomplete["status"] = "incomplete"
	f.billingBody.Store("plan", clawHuntPlanBody(f, incomplete))
	if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); out["plan"].(map[string]any)["entitled"] != false || out["credits"] != nil {
		t.Fatal("unpaid subscription", out)
	}
	// No subscription any more: the plan ends; its record stays.
	f.billingBody.Store("plan", clawHuntPlanBody(f, nil))
	if out = h.request(t, c, "GET", "/billing?refresh=1", nil, 200); out["plan"].(map[string]any)["status"] != "canceled" || out["plan"].(map[string]any)["entitled"] != false || out["credits"] != nil || out["stale"] != false {
		t.Fatal("no subscription", out)
	}
	// An ended grant ends the session.
	f.billingBody.Delete("plan")
	f.active.Store(false)
	h.request(t, c, "GET", "/billing?refresh=1", nil, 401)
}

func TestPostgresPlansAreReadAgainWithoutTheirPayer(t *testing.T) {
	h, f, c := clawHuntMember(t)
	h.a.billingCalls.perMinute = 1000
	start, end := time.Now().Add(-30*24*time.Hour).Unix(), time.Now().Add(5*time.Minute).Unix()
	f.billingBody.Store("plan", clawHuntPlanBody(f, paidPlan("pro", start, end, map[string]int64{"pro": 2000})))
	h.request(t, c, "GET", "/billing", nil, 200)
	ctx := context.Background()
	// Freshly read and not near its renewal: not due.
	h.a.syncDuePlans(ctx)
	if req, _ := f.billingRequest.Load("plan"); req.(map[string]any)["subject"] != nil {
		t.Fatal("a fresh plan was read again", req)
	}
	// Its period about to end and last read six minutes ago: read again by subject, without a session.
	execSQL(t, h, "UPDATE user_plans SET synced_at=now()-interval '6 minutes'")
	renewed := paidPlan("pro", end, end+30*86400, map[string]int64{"pro": 2000})
	f.billingBody.Store("plan", map[string]any{"sub": f.id.Subject, "plan": renewed})
	h.a.syncDuePlans(ctx)
	req, _ := f.billingRequest.Load("plan")
	if req.(map[string]any)["subject"] != f.id.Subject || req.(map[string]any)["grant_token"] != nil || req.(map[string]any)["rebuild"] != true {
		t.Fatal("the renewal read", req)
	}
	var periodStart time.Time
	if e := h.db.QueryRow(ctx, "SELECT period_start FROM user_plans").Scan(&periodStart); e != nil || periodStart.Unix() != end {
		t.Fatal("renewal not stored", periodStart, e)
	}
	// An answer about another account changes nothing.
	execSQL(t, h, "UPDATE user_plans SET synced_at=now()-interval '2 hours'")
	f.billingBody.Store("plan", map[string]any{"sub": "subject-other", "plan": nil})
	h.a.syncDuePlans(ctx)
	var n int
	if h.db.QueryRow(ctx, "SELECT count(*) FROM user_plans").Scan(&n); n != 1 {
		t.Fatal("another account's answer applied")
	}
	// That read failed: unread for two hours, it is tried again in an hour, not every few minutes.
	var wait float64
	if e := h.db.QueryRow(ctx, "SELECT extract(epoch FROM retry_after-now())::float8 FROM user_plans").Scan(&wait); e != nil || wait < 55*60 || wait > 3600 {
		t.Fatal("retry after a failed read", wait, e)
	}
	execSQL(t, h, "UPDATE user_plans SET retry_after=NULL")
	// An account watched after a checkout is read until its watch ends, whether or not it has a plan.
	execSQL(t, h, "DELETE FROM user_plans")
	execSQL(t, h, "INSERT INTO plan_watches(user_id,until) SELECT user_id,now()+interval '1 day' FROM external_identities")
	f.billingBody.Store("plan", map[string]any{"sub": f.id.Subject, "plan": paidPlan("max", time.Now().Unix(), time.Now().Add(30*24*time.Hour).Unix(), map[string]int64{"max": 10000})})
	h.a.syncDuePlans(ctx)
	var plan string
	if e := h.db.QueryRow(ctx, "SELECT plan FROM user_plans").Scan(&plan); e != nil || plan != "max" {
		t.Fatal("a checkout completed after its tab closed", plan, e)
	}
	calls := f.billingCalls.Load()
	h.a.syncDuePlans(ctx)
	if f.billingCalls.Load() != calls {
		t.Fatal("a watch was read again within two minutes")
	}
	execSQL(t, h, "UPDATE plan_watches SET until=now()-interval '1 second'")
	execSQL(t, h, "UPDATE plan_watches SET checked_at='-infinity'")
	h.a.syncDuePlans(ctx)
	if h.db.QueryRow(ctx, "SELECT count(*) FROM plan_watches").Scan(&n); n != 0 {
		t.Fatal("an ended watch stays")
	}
}

func TestPostgresSignInSyncsThePlan(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	f := newIdentityFixture(t, h, "signin-plan@example.invalid", "subject-signin")
	start, end := time.Now().Add(-time.Hour).Unix(), time.Now().Add(30*24*time.Hour).Unix()
	f.billingBody.Store("plan", map[string]any{"active": true, "sub": "subject-signin", "plan": paidPlan("pro", start, end, map[string]int64{"pro": 2000})})
	completeIdentity(t, h, f, "")
	var plan string
	var credits int
	if e := h.db.QueryRow(context.Background(), "SELECT p.plan,p.credits FROM user_plans p JOIN users u ON u.id=p.user_id WHERE u.email='signin-plan@example.invalid'").Scan(&plan, &credits); e != nil || plan != "pro" || credits != 2000 {
		t.Fatal("sign-in did not sync the plan", plan, credits, e)
	}
	// An issuer that cannot answer about the plan never stops a sign-in.
	g := newIdentityFixture(t, h, "signin-down@example.invalid", "subject-down")
	g.billingStatus.Store("plan", 503)
	if r := completeIdentity(t, h, g, ""); responseCookie(t, r, "awwo_session") == nil {
		t.Fatal("sign-in failed with the plan sync")
	}
}

func TestPostgresBillingCheckoutAndPortalGoThroughClawHunt(t *testing.T) {
	h, f, c := clawHuntMember(t)
	h.a.billingCalls.perMinute = 1000
	requireCode(t, h.request(t, c, "POST", "/billing/checkout", map[string]string{"plan": "pro"}, 403), "checkout_closed")
	h.a.cfg.BillingCheckoutEnabled = true
	requireCode(t, h.request(t, c, "POST", "/billing/checkout", map[string]string{"plan": "ultra"}, 400), "invalid_input")
	out := h.request(t, c, "POST", "/billing/checkout", map[string]string{"plan": "max"}, 200)
	if out["url"] != "https://checkout.stripe.com/c/pay/cs_test_fixture" {
		t.Fatal("checkout", out)
	}
	req, _ := f.billingRequest.Load("checkout")
	if want := (map[string]any{"grant_token": strings.Repeat("g", 43), "plan": "max", "success_url": h.cfg.PublicOrigin + "/?account=plans&billing=success", "cancel_url": h.cfg.PublicOrigin + "/?account=plans&billing=cancel"}); !reflect.DeepEqual(req, want) {
		t.Fatal("checkout request", req)
	}
	// The account is read again for a day, whether or not the browser comes back.
	var until time.Time
	if e := h.db.QueryRow(context.Background(), "SELECT until FROM plan_watches").Scan(&until); e != nil || time.Until(until) < 23*time.Hour {
		t.Fatal("no watch after the checkout", until, e)
	}
	for status, code := range map[int]string{409: "already_subscribed", 429: "rate_limited"} {
		f.billingStatus.Store("checkout", status)
		requireCode(t, h.request(t, c, "POST", "/billing/checkout", map[string]string{"plan": "pro"}, status), code)
	}
	f.billingStatus.Store("checkout", 0)
	// Only Stripe's own pages, about this account, are handed to the browser.
	for _, bad := range []map[string]any{
		{"active": true, "sub": f.id.Subject, "url": "https://evil.example/c/pay/cs"},
		{"active": true, "sub": "subject-other", "url": "https://checkout.stripe.com/c/pay/cs"},
	} {
		f.billingBody.Store("checkout", bad)
		requireCode(t, h.request(t, c, "POST", "/billing/checkout", map[string]string{"plan": "pro"}, 503), "billing_unavailable")
	}
	if out = h.request(t, c, "POST", "/billing/portal", map[string]string{}, 200); out["url"] != "https://billing.stripe.com/p/session/test_fixture" {
		t.Fatal("portal", out)
	}
	if req, _ := f.billingRequest.Load("portal"); req.(map[string]any)["return_url"] != h.cfg.PublicOrigin+"/?account=plans&billing=return" {
		t.Fatal("portal request", req)
	}
	f.billingStatus.Store("portal", 404)
	requireCode(t, h.request(t, c, "POST", "/billing/portal", map[string]string{}, 404), "no_subscription")
	// A password account (a deployment without ClawHunt) has no ClawHunt account to bill.
	local := newHarness(t, "http://127.0.0.1:1")
	lc, _, _ := local.register(t, "local-billing@example.invalid")
	requireCode(t, local.request(t, lc, "POST", "/billing/portal", map[string]string{}, 404), "not_found")
	if out = local.request(t, lc, "GET", "/billing", nil, 200); out["plan"] != nil || out["stale"] != false || out["checkoutEnabled"] != false {
		t.Fatal("password account billing view", out)
	}
}

func TestBillingCheckoutNeedsPricing(t *testing.T) {
	models, _ := newWorkspaceModels("qwen3.8-27b-p6,claude-sonnet-5,bedrock.claude-opus-5-5,rh.seedream-v5-pro")
	ok := Config{BillingCheckoutEnabled: true, ClawHuntURL: "https://clawhunt.example", ModelPricingJSON: planPricing,
		RouteFreeModels: []string{"qwen3.8-27b-p6"}, NewWorkspaceModels: models, NewWorkspaceRouteLimits: routeLimits{routeGate: 3}}
	if err := ok.validateBilling(); err != nil {
		t.Fatal(err)
	}
	if err := (Config{}).validateBilling(); err != nil {
		t.Fatal("checkout closed needs nothing", err)
	}
	for name, change := range map[string]func(*Config){
		"no pricing":           func(c *Config) { c.ModelPricingJSON = "" },
		"no ClawHunt":          func(c *Config) { c.ClawHuntURL = "" },
		"personal credentials": func(c *Config) { c.UserCredentials = true },
		"no free models":       func(c *Config) { c.RouteFreeModels = nil },
		"no route limits":      func(c *Config) { c.NewWorkspaceRouteLimits = nil },
		"an unpriced model": func(c *Config) {
			c.NewWorkspaceModels, _ = newWorkspaceModels("qwen3.8-27b-p6,gpt-5.5")
		},
	} {
		c := ok
		change(&c)
		if err := c.validateBilling(); err == nil {
			t.Fatal("checkout opened with", name)
		}
	}
}

func TestPostgresUsageViewShowsTheOwnersBillingToTheOwnerAlone(t *testing.T) {
	h := planHarness(t)
	co, tid, _ := h.register(t, "view-owner@example.test")
	cm, _, _ := h.register(t, "view-member@example.test")
	cr, _, _ := h.register(t, "view-reader@example.test")
	now := time.Now()
	givePlan(t, h, "view-owner@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	for email, role := range map[string]string{"view-member@example.test": "member", "view-reader@example.test": "reader"} {
		execSQL(t, h, "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,$3 FROM users WHERE email=$2", tid, email, role)
	}
	owner := h.request(t, co, "GET", "/tenants/"+tid+"/route-usage", nil, 200)["plan"].(map[string]any)
	if owner["periodEnd"] == nil || owner["cancelAtPeriodEnd"] != false || owner["credits"].(map[string]any)["remaining"] != 2000.0 {
		t.Fatal("owner view", owner)
	}
	member := h.request(t, cm, "GET", "/tenants/"+tid+"/route-usage", nil, 200)["plan"].(map[string]any)
	if _, ok := member["periodEnd"]; ok || member["credits"].(map[string]any)["remaining"] != 2000.0 {
		t.Fatal("member view", member)
	}
	if reader := h.request(t, cr, "GET", "/tenants/"+tid+"/route-usage", nil, 200); reader["plan"] != nil {
		t.Fatal("reader view", reader)
	}
}

func TestPostgresPaidPlanGenerationsSpendCreditsInsteadOfTheMediaRouteLimit(t *testing.T) {
	h, rh := newMediaHarness(t)
	h.a.cfg.MediaUnrestrictedWorkspaces = true
	h.a.cfg.RouteTotalsPerDay = routeLimits{routeMedia: 2}
	c, tid, _ := h.register(t, "media-plan@example.test")
	execSQL(t, h, `UPDATE tenants SET route_limits='{"media":1}'::jsonb WHERE id=$1`, tid)
	now := time.Now()
	givePlan(t, h, "media-plan@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	node := setupNodeAt(canvas, 0)["issueId"].(string)
	for i := 0; i < 3; i++ {
		run := h.mediaRun(t, c, tid, node, "a cat in a hat", 202)
		awaitRunRow(t, h, tid, run["id"].(string), "completed")
	}
	type gen struct {
		points   *int
		accepted *bool
		billed   *string
	}
	rows, err := h.db.Query(context.Background(), "SELECT credit_points,provider_accepted,billed_user_id FROM media_generations WHERE tenant_id=$1", tid)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var g gen
		rows.Scan(&g.points, &g.accepted, &g.billed)
		if g.points == nil || *g.points != 30 || g.accepted == nil || !*g.accepted || g.billed == nil {
			t.Fatal("a paid generation", g)
		}
	}
	rows.Close()
	if spent := planCredits0(t, h, c, tid)["spent"]; spent != 90.0 {
		t.Fatal("generations not counted", spent)
	}
	// The paid generations spent neither the free media allowance nor the deployment's free media ceiling.
	cf, tf, _ := h.register(t, "media-free@example.test")
	execSQL(t, h, `UPDATE tenants SET route_limits='{"media":2}'::jsonb WHERE id=$1`, tf)
	_, freeCanvas := mediaCanvas(t, h, cf, tf, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	freeNode := setupNodeAt(freeCanvas, 0)["issueId"].(string)
	for i := 0; i < 2; i++ {
		run := h.mediaRun(t, cf, tf, freeNode, "a dog in a hat", 202)
		awaitRunRow(t, h, tf, run["id"].(string), "completed")
	}
	if got := h.mediaRun(t, cf, tf, freeNode, "a dog in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("the free allowance", got)
	}
	// A generation the provider refused costs nothing.
	rh.set(func(int) (int, any) { return 401, nil }, nil)
	run := h.mediaRun(t, c, tid, node, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "failed")
	if spent := planCredits0(t, h, c, tid)["spent"]; spent != 90.0 {
		t.Fatal("a refused generation was charged", spent)
	}
	// Once the credits cannot pay for another generation, it is refused before RunningHub is asked.
	execSQL(t, h, "UPDATE user_plans SET credits=100")
	if got := h.mediaRun(t, c, tid, node, "a cat in a hat", 402); errorCode(got) != "credits_exhausted" {
		t.Fatal("exhausted credits admitted a generation", got)
	}
}

// giveGift records what the operator gifted the account, as the grant script does.
func giveGift(t *testing.T, h *harness, uid string, credits int) {
	t.Helper()
	execSQL(t, h, "UPDATE user_plans SET gift_credits=$2,gift_note='beta goodwill' WHERE user_id=$1", uid, credits)
}

func TestPostgresGiftedCreditsAreSpentAfterThePaidOnesAndSurviveEverySync(t *testing.T) {
	h := planHarness(t)
	c, tid, _ := h.register(t, "plan-gift@example.test")
	rid := routeHarnessRun(t, h, c, tid, planRoutes)
	ctx := context.Background()
	now := time.Now()
	start, end := now.Add(-30*24*time.Hour), now.Add(-time.Minute)
	uid := givePlan(t, h, "plan-gift@example.test", "pro", "active", start, end, 2000)
	giveGift(t, h, uid, 4000)
	// The period's credits are what it paid for and what it was gifted, and the gift is in what the account may spend.
	p, e := accountPlan(ctx, h.db, uid)
	if e != nil || p == nil || p.Credits != 2000 || p.Gift != 4000 || p.granted() != 6000 {
		t.Fatal("the gift", p, e)
	}
	if spent, _ := creditsSpent(ctx, h.db, p); p.remaining(spent) != 6000 {
		t.Fatal("remaining", p.remaining(0))
	}
	// A call costing more than the paid credits alone is admitted and settles against the gift.
	if e := reserveModel(h, tid, rid, "claude-sonnet-5"); e != nil {
		t.Fatal(e)
	}
	settleNewest(t, h, tid, intp(2600))
	if credits := planCredits0(t, h, c, tid); credits["granted"] != 6000.0 || credits["gift"] != 4000.0 || credits["remaining"] != 3400.0 {
		t.Fatal("usage view", credits)
	}
	// An answer about the same period never touches the gift: ClawHunt reports payments, and a gift is not one.
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, paidPlan("pro", start.Unix(), end.Unix(), map[string]int64{"pro": 2000})), dbNow(t, h)); e != nil {
		t.Fatal(e)
	}
	var gift int
	if e := h.db.QueryRow(ctx, "SELECT gift_credits FROM user_plans WHERE user_id=$1", uid).Scan(&gift); e != nil || gift != 4000 {
		t.Fatal("a sync took the gift away", gift, e)
	}
	// The next period, paid: the gift belonged to the old period, so the new one starts with none, and prev_gift
	// keeps what the old one was given. Nothing is worked out from the old period's spend, which keeps moving.
	next := paidPlan("pro", end.Unix(), now.Add(30*24*time.Hour).Unix(), map[string]int64{"pro": 2000})
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, next), dbNow(t, h)); e != nil {
		t.Fatal(e)
	}
	p, e = accountPlan(ctx, h.db, uid)
	if e == nil {
		e = withCarry(ctx, h.db, p)
	}
	if e != nil || p == nil || p.Credits != 2000 || p.Gift != 0 || p.PrevGift != 4000 || p.Carry != 0 {
		t.Fatal("the gift after a renewal", p, e)
	}
	var note string
	if e := h.db.QueryRow(ctx, "SELECT gift_note FROM user_plans WHERE user_id=$1", uid).Scan(&note); e != nil || note != "" {
		t.Fatal("the note of a gift that ended", note, e)
	}
	// The overspend carried into a period is measured against the previous period's credits and gift together — only
	// what the old period spent beyond 6,000 comes off this one — and a late settlement of that period, which is why
	// no leftover is frozen at the roll-over, moves the carry and nothing else.
	execSQL(t, h, "UPDATE model_invocations SET credit_charge=6500 WHERE billed_user_id=$1 AND billed_period_start=$2", uid, start)
	if p, _ = accountPlan(ctx, h.db, uid); withCarry(ctx, h.db, p) != nil || p.Carry != 500 || p.Gift != 0 {
		t.Fatal("carry past the credits and the gift", p.Carry, p.Gift)
	}
	if spent, _ := creditsSpent(ctx, h.db, p); p.remaining(spent) != 1500 {
		t.Fatal("the new period after the old one overspent", p.remaining(0))
	}
	// A gift given for this period, then a full refund of it: no paid credits entitles nothing — a gift rides a plan
	// and never makes one — and the gift stays on the row while that period is the charged one.
	giveGift(t, h, uid, 500)
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, paidPlan("pro", end.Unix(), now.Add(30*24*time.Hour).Unix(), nil)), dbNow(t, h)); e != nil {
		t.Fatal(e)
	}
	if p, _ = accountPlan(ctx, h.db, uid); p != nil {
		t.Fatal("a gift alone entitled a refunded period", p)
	}
	var credits int
	if e := h.db.QueryRow(ctx, "SELECT credits,gift_credits FROM user_plans WHERE user_id=$1", uid).Scan(&credits, &gift); e != nil || credits != 0 || gift != 500 {
		t.Fatal("the refunded row", credits, gift, e)
	}
}

// dbNow is the test database's clock, as a plan read stamps it. Ask a test's plan answers at it, never at time.Now():
// applyPlan ignores an answer asked before the stored one's synced_at, which is on the database's clock, and this
// process's clock can run up to a second ahead of it or behind it (a test run on Windows against a PostgreSQL in WSL).
func dbNow(t *testing.T, h *harness) time.Time {
	t.Helper()
	now, err := h.a.databaseNow(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return now
}
