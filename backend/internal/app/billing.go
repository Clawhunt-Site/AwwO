package app

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The account's plan, its credits, and the way to buy or manage a subscription. ClawHunt holds the Stripe
// customer and subscriptions; AwwO asks it over the backchannel, with this session's grant when the account is
// here and by subject from plan_sync.go when it is not, and mirrors the answer in user_plans (plans.go reads it
// at admission).

// clawHuntPlan is the issuer's answer: the account's AwwO subscription, or none. Paid is what the paid invoices
// of the current Stripe period charged for each plan, in cents, net of discounts and before tax; an upgrade's
// proration can make one plan's amount negative.
type clawHuntPlan struct {
	ID                string           `json:"id"`
	Status            string           `json:"status"`
	PeriodStart       int64            `json:"period_start"`
	PeriodEnd         int64            `json:"period_end"`
	CancelAtPeriodEnd bool             `json:"cancel_at_period_end"`
	Paid              map[string]int64 `json:"paid"`
}

var planStatuses = map[string]bool{"active": true, "trialing": true, "past_due": true, "canceled": true, "unpaid": true,
	"incomplete": true, "incomplete_expired": true, "paused": true}

// A stored plan is asked about again when it is older than this, whenever the account reads its billing page.
const planSyncAge = 5 * time.Minute

// After a checkout or a visit to the billing portal the account's plan is read again for this long (plan_sync.go).
const planWatchFor = 24 * time.Hour

var errPlanSessionEnded = errors.New("session ended")
var errPlanInvalid = errors.New("invalid plan response")

// syncPlan asks the issuer, with this session's grant, for the account's subscription and stores it. The answer
// must name this session's subject and have the documented shape; anything else changes nothing.
func (a *App) syncPlan(ctx context.Context, userID, subject, grant string) error {
	var out struct {
		Active bool          `json:"active"`
		Sub    string        `json:"sub"`
		Plan   *clawHuntPlan `json:"plan"`
	}
	asked, err := a.databaseNow(ctx)
	if err != nil {
		return err
	}
	if err := a.clawHuntRequest(ctx, "plan", map[string]any{"grant_token": grant, "rebuild": a.planKnown(ctx, userID)}, &out); err != nil {
		return err
	}
	if !out.Active {
		return errPlanSessionEnded
	}
	if subtle.ConstantTimeCompare([]byte(out.Sub), []byte(subject)) != 1 {
		return errPlanInvalid
	}
	return a.applyPlan(ctx, userID, out.Plan, asked)
}

// syncPlanBySubject asks the issuer for an account's subscription without a session: AwwO's own client, for an
// account whose renewal is due or that is being watched after a checkout.
func (a *App) syncPlanBySubject(ctx context.Context, userID, subject string) error {
	_, err := a.syncPlanBySubjectStatus(ctx, userID, subject)
	return err
}

// syncPlanBySubjectStatus is syncPlanBySubject that also says how the issuer answered: its status, 0 for no answer at
// all (market_settle.go tells ClawHunt being down from a failing answer about one account).
func (a *App) syncPlanBySubjectStatus(ctx context.Context, userID, subject string) (int, error) {
	var out struct {
		Sub  string        `json:"sub"`
		Plan *clawHuntPlan `json:"plan"`
	}
	asked, err := a.databaseNow(ctx)
	if err != nil {
		return 0, err
	}
	status, err := a.clawHuntRequestStatus(ctx, "plan", map[string]any{"subject": subject, "rebuild": a.planKnown(ctx, userID)}, &out)
	if err != nil {
		return status, err
	}
	if subtle.ConstantTimeCompare([]byte(out.Sub), []byte(subject)) != 1 {
		return status, errPlanInvalid
	}
	return status, a.applyPlan(ctx, userID, out.Plan, asked)
}

// databaseNow is the database's clock, which stamps synced_at: a request's start is compared with it, never with
// this process's clock, so a read that cannot learn it is not made.
func (a *App) databaseNow(ctx context.Context) (time.Time, error) {
	var now time.Time
	err := a.db.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now)
	return now, err
}

// planKnown says AwwO has a plan on record for the account, so that an answer of none is checked against Stripe
// before it is believed (ClawHunt rebuilds a lost record from there).
func (a *App) planKnown(ctx context.Context, userID string) bool {
	var known bool
	// Every status ClawHunt counts as a live subscription (its LIVE_STATUSES), so a lost record of any of them is looked for.
	_ = a.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM user_plans WHERE user_id=$1 AND status IN ('active','trialing','past_due','incomplete','unpaid','paused'))", userID).Scan(&known)
	return known
}

// applyPlan stores what the issuer reported, in answer to a request sent at asked (the database's clock). A period
// with paid invoices becomes the charged period, with the credits they bought; a later period not paid yet (a
// renewal still being charged, or failing) leaves the last paid period and its credits in place, and only the status
// and cancellation follow, so the account keeps what it paid for until a day after that period and gets the new
// period's credits once it is paid. The charged period reported with nothing paid (refunded, disputed) has no credits
// left. When the charged period moves on, the old one is kept as the previous period: what it spent beyond its
// credits comes off the new one's (withCarry). A report never moves the charged period backwards; an answer to a
// request older than the stored answer's is ignored; no subscription at all ends the plan but keeps its record, so
// an overspend still counts if the account subscribes again.
func (a *App) applyPlan(ctx context.Context, userID string, p *clawHuntPlan, asked time.Time) error {
	if p != nil {
		start, end := time.Unix(p.PeriodStart, 0), time.Unix(p.PeriodEnd, 0)
		if _, ok := planCatalog[p.ID]; !ok || !planStatuses[p.Status] || p.PeriodStart <= 0 || !end.After(start) || end.Sub(start) > 400*24*time.Hour || len(p.Paid) > len(planCatalog) {
			return errPlanInvalid
		}
		for id, cents := range p.Paid {
			if _, ok := planCatalog[id]; !ok || cents < -10_000_000 || cents > 10_000_000 {
				return errPlanInvalid
			}
		}
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var stored activePlan
	var synced time.Time
	err = tx.QueryRow(ctx, "SELECT "+planColumns+",p.synced_at FROM user_plans p WHERE p.user_id=$1 FOR UPDATE", userID).
		Scan(&stored.UserID, &stored.Plan, &stored.Status, &stored.PeriodStart, &stored.PeriodEnd, &stored.CancelAtPeriodEnd, &stored.Credits,
			&stored.Gift, &stored.PrevStart, &stored.PrevCredits, &stored.PrevCarry, &stored.PrevGift, &synced)
	found := err == nil
	if err != nil && !noRows(err) {
		return err
	}
	if found && synced.After(asked) {
		// The stored answer came from a later request.
		return nil
	}
	if p == nil {
		// No subscription. Without a stored plan there is nothing to end (err still holds the lookup's no-rows).
		if found {
			if _, err = tx.Exec(ctx, "UPDATE user_plans SET status='canceled',synced_at=$2,retry_after=NULL WHERE user_id=$1", userID, asked); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}
	start, end, credits := time.Unix(p.PeriodStart, 0), time.Unix(p.PeriodEnd, 0), planCredits(p.Paid)
	// The plan whose allowances apply is one that was paid for in the period: a switch whose charge has not been
	// paid (or was refused) keeps the plan that was.
	plan := p.ID
	if p.Paid[plan] <= 0 {
		for id, cents := range p.Paid {
			if cents > 0 && (p.Paid[plan] <= 0 || cents > p.Paid[plan]) {
				plan = id
			}
		}
	}
	switch {
	case found && start.Before(stored.PeriodStart):
		_, err = tx.Exec(ctx, "UPDATE user_plans SET synced_at=$2,retry_after=NULL WHERE user_id=$1", userID, asked)
	case found && start.Equal(stored.PeriodStart):
		// The charged period: its credits follow what it collected, down to nothing after a full refund.
		if credits <= 0 {
			plan = stored.Plan
		}
		_, err = tx.Exec(ctx, `UPDATE user_plans SET plan=$2,status=$3,period_end=$4,credits=$5,cancel_at_period_end=$6,synced_at=$7,retry_after=NULL WHERE user_id=$1`,
			userID, plan, p.Status, end, max(0, credits), p.CancelAtPeriodEnd, asked)
	case credits > 0 && found:
		// A later period, paid: the stored one becomes the previous period. A gift belonged to that period, so the
		// new one starts without one (the operator grants another if there is to be one), and prev_gift keeps the
		// gift the old period had, so its overspend is measured against its credits and gift together. Both are
		// what the period was given, never anything worked out from a spend that still moves.
		if err = withCarry(ctx, tx, &stored); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE user_plans SET plan=$2,status=$3,period_start=$4,period_end=$5,credits=$6,cancel_at_period_end=$7,
			prev_period_start=$8,prev_credits=$9,prev_carry=$10,prev_gift=$11,gift_credits=0,gift_note='',synced_at=$12,retry_after=NULL WHERE user_id=$1`,
			userID, plan, p.Status, start, end, credits, p.CancelAtPeriodEnd, stored.PeriodStart, stored.Credits, stored.Carry,
			stored.Gift, asked)
	case credits > 0:
		// Two first answers at once: the first stored wins, and the next read brings the other's news.
		_, err = tx.Exec(ctx, `INSERT INTO user_plans(user_id,plan,status,period_start,period_end,credits,cancel_at_period_end,synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (user_id) DO NOTHING`, userID, plan, p.Status, start, end, credits, p.CancelAtPeriodEnd, asked)
	case found:
		// A later period not paid yet: the paid one stays charged; the status and cancellation follow.
		_, err = tx.Exec(ctx, "UPDATE user_plans SET status=$2,cancel_at_period_end=$3,synced_at=$4,retry_after=NULL WHERE user_id=$1", userID, p.Status, p.CancelAtPeriodEnd, asked)
	default:
		_, err = tx.Exec(ctx, `INSERT INTO user_plans(user_id,plan,status,period_start,period_end,credits,cancel_at_period_end,synced_at) VALUES($1,$2,$3,$4,$5,0,$6,$7)
			ON CONFLICT (user_id) DO NOTHING`, userID, p.ID, p.Status, start, end, p.CancelAtPeriodEnd, asked)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// syncPlanAfterSignIn refreshes the plan of a new session without ever failing or delaying the sign-in much.
func (a *App) syncPlanAfterSignIn(ctx context.Context, userID, subject, grant string) {
	if userID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := a.syncPlan(ctx, userID, subject, grant); err != nil && a.log != nil {
		a.log.Warn("plan sync after sign-in failed", "error", err.Error())
	}
}

// billingGrant opens this session's ClawHunt grant. found is false for a session without one (a password
// account, or ClawHunt not configured); err is a failure to read or open it.
func (a *App) billingGrant(r *http.Request) (grant, subject, hash string, found bool, err error) {
	c, e := r.Cookie("awwo_session")
	if e != nil || !a.clawHuntEnabled() {
		return "", "", "", false, nil
	}
	u := currentUser(r)
	hash = tokenHash(c.Value)
	var issuer string
	var sealed []byte
	if err = a.db.QueryRow(r.Context(), "SELECT COALESCE(sso_issuer,''),COALESCE(sso_subject,''),sso_grant FROM auth_sessions WHERE token_hash=$1 AND user_id=$2", hash, u.ID).Scan(&issuer, &subject, &sealed); err != nil {
		if noRows(err) {
			return "", "", "", false, nil
		}
		return "", "", "", false, err
	}
	if len(sealed) == 0 || issuer != a.cfg.ClawHuntURL || subject == "" {
		return "", "", "", false, nil
	}
	if grant, err = a.openCredential(u.ID, "clawhunt-session:"+hash, sealed); err != nil {
		return "", "", "", false, err
	}
	return grant, subject, hash, true, nil
}

// endedSession signs this browser out after the issuer said the grant is over.
func (a *App) endedSession(w http.ResponseWriter, hash string) {
	a.clawHuntSessions.forget(hash)
	a.sessionCookie(w, "", -1)
	fail(w, 401, "unauthorized", "Continue with ClawHunt again")
}

// billingView answers GET /api/v1/billing: the plan catalog, whether checkout is open, and the account's plan
// with this period's credits. A stored plan older than planSyncAge, or any with ?refresh=1, is asked about first;
// when the issuer cannot answer, the stored plan is shown as stale.
func (a *App) billingView(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	ctx := r.Context()
	var synced time.Time
	err := a.db.QueryRow(ctx, "SELECT synced_at FROM user_plans WHERE user_id=$1", u.ID).Scan(&synced)
	if err != nil && !noRows(err) {
		a.dbError(w, err)
		return
	}
	stale := false
	if a.clawHuntEnabled() && (noRows(err) || time.Since(synced) > planSyncAge || r.URL.Query().Get("refresh") == "1") {
		grant, subject, hash, found, e := a.billingGrant(r)
		switch {
		case e != nil:
			stale = true
		case found:
			done, allowed := a.billingCalls.begin(u.ID, time.Now())
			if !allowed {
				stale = true
				break
			}
			err = a.syncPlan(ctx, u.ID, subject, grant)
			done()
			if errors.Is(err, errPlanSessionEnded) {
				a.endedSession(w, hash)
				return
			}
			stale = err != nil
		}
	}
	out := map[string]any{"catalog": planCatalogJSON(), "checkoutEnabled": a.cfg.BillingCheckoutEnabled && a.clawHuntEnabled(), "plan": nil, "credits": nil, "stale": stale}
	var row activePlan
	var entitled bool
	err = a.db.QueryRow(ctx, "SELECT "+planColumns+","+planEntitles+" FROM user_plans p WHERE p.user_id=$1", u.ID).
		Scan(&row.UserID, &row.Plan, &row.Status, &row.PeriodStart, &row.PeriodEnd, &row.CancelAtPeriodEnd, &row.Credits, &row.Gift,
			&row.PrevStart, &row.PrevCredits, &row.PrevCarry, &row.PrevGift, &entitled)
	if err != nil && !noRows(err) {
		a.dbError(w, err)
		return
	}
	if err == nil {
		row.Limits = planCatalog[row.Plan]
		out["plan"] = map[string]any{"id": row.Plan, "status": row.Status, "periodStart": row.PeriodStart, "periodEnd": row.PeriodEnd,
			"cancelAtPeriodEnd": row.CancelAtPeriodEnd, "entitled": entitled}
		if entitled {
			if e := withCarry(ctx, a.db, &row); e != nil {
				a.dbError(w, e)
				return
			}
			spent, e := creditsSpent(ctx, a.db, &row)
			if e != nil {
				a.dbError(w, e)
				return
			}
			out["credits"] = creditsJSON(&row, spent)
		}
	}
	writeJSON(w, 200, out)
}

// creditsJSON is a period's credits as the web reads them: granted (what was paid for the period and what was
// gifted), how much of that was a gift, spent, carried over from an earlier period's overspend, and remaining.
func creditsJSON(p *activePlan, spent int64) map[string]any {
	return map[string]any{"granted": p.granted(), "gift": p.Gift, "spent": spent, "carried": p.Carry, "remaining": max(0, p.remaining(spent))}
}

func planCatalogJSON() []map[string]any {
	out := []map[string]any{}
	for _, id := range planOrder {
		l := planCatalog[id]
		out = append(out, map[string]any{"id": id, "priceUsd": l.PriceUSD, "credits": l.Credits, "dailyCalls": l.Daily,
			"concurrentAgents": l.Concurrent, "workspaces": l.Workspaces, "mediaPerDay": l.MediaPerDay})
	}
	return out
}

// billingCheckout answers POST /api/v1/billing/checkout {plan}: ClawHunt opens a Stripe Checkout for the plan
// and AwwO hands its URL to the browser. Only Stripe's own checkout page is ever returned.
func (a *App) billingCheckout(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Plan string `json:"plan"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if _, ok := planCatalog[b.Plan]; !ok {
		fail(w, 400, "invalid_input", "plan must be pro or max")
		return
	}
	if !a.cfg.BillingCheckoutEnabled {
		fail(w, 403, "checkout_closed", "Paid plans are not on sale yet")
		return
	}
	a.billingRedirect(w, r, "checkout", map[string]any{"plan": b.Plan,
		"success_url": a.cfg.PublicOrigin + "/?account=plans&billing=success", "cancel_url": a.cfg.PublicOrigin + "/?account=plans&billing=cancel"}, "https://checkout.stripe.com/")
}

// billingPortal answers POST /api/v1/billing/portal: Stripe's billing portal for changing or cancelling the plan.
func (a *App) billingPortal(w http.ResponseWriter, r *http.Request) {
	if !a.decode(w, r, &struct{}{}) {
		return
	}
	a.billingRedirect(w, r, "portal", map[string]any{"return_url": a.cfg.PublicOrigin + "/?account=plans&billing=return"}, "https://billing.stripe.com/")
}

func (a *App) billingRedirect(w http.ResponseWriter, r *http.Request, endpoint string, body map[string]any, prefix string) {
	u := currentUser(r)
	done, ok := a.billingCalls.begin(u.ID, time.Now())
	if !ok {
		fail(w, 429, "rate_limited", "Too many billing requests; try again in a minute")
		return
	}
	defer done()
	grant, subject, hash, found, err := a.billingGrant(r)
	if err != nil {
		fail(w, 503, "billing_unavailable", "Billing is unavailable right now")
		return
	}
	if !found {
		fail(w, 404, "not_found", "Plans come with a ClawHunt account")
		return
	}
	body["grant_token"] = grant
	var out struct {
		Active bool   `json:"active"`
		Sub    string `json:"sub"`
		URL    string `json:"url"`
	}
	status, err := a.clawHuntRequestStatus(r.Context(), endpoint, body, &out)
	switch {
	case status == http.StatusConflict:
		fail(w, 409, "already_subscribed", "This account already has a plan; change it from Manage subscription")
		return
	case status == http.StatusTooManyRequests:
		fail(w, 429, "rate_limited", "Another payment page is being opened; try again in a moment")
		return
	case status == http.StatusNotFound && endpoint == "portal":
		fail(w, 404, "no_subscription", "This account has no subscription to manage")
		return
	case err != nil:
		fail(w, 503, "billing_unavailable", "Billing is unavailable right now")
		return
	}
	if !out.Active {
		a.endedSession(w, hash)
		return
	}
	if subtle.ConstantTimeCompare([]byte(out.Sub), []byte(subject)) != 1 || !validStripeURL(out.URL, prefix) {
		fail(w, 503, "billing_unavailable", "Billing is unavailable right now")
		return
	}
	// Whether or not the browser comes back, the plan is read again for a while (plan_sync.go).
	if _, e := a.db.Exec(r.Context(), `INSERT INTO plan_watches(user_id,until) VALUES($1,clock_timestamp()+$2*interval '1 second')
		ON CONFLICT (user_id) DO UPDATE SET until=EXCLUDED.until`, u.ID, int64(planWatchFor.Seconds())); e != nil && a.log != nil {
		a.log.Warn("plan watch not recorded", "error", e.Error())
	}
	writeJSON(w, 200, map[string]any{"url": out.URL})
}

// validStripeURL accepts only an https URL on Stripe's checkout or billing host, without credentials.
func validStripeURL(raw, prefix string) bool {
	if len(raw) > 2048 || !strings.HasPrefix(raw, prefix) {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.User == nil && (u.Host == "checkout.stripe.com" || u.Host == "billing.stripe.com")
}
