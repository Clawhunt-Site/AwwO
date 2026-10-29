package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Settling the market (docs/awwo-agent-market.md). Every marketSettleEvery the API, whether the market is open or
// not (closing it stops new use, never the settling of what was used):
//
//  1. settles what a run's own end did not (reconcileMarketCalls): a fee held by a run that a cancellation, a restart
//     or a suspension ended, a run that is gone, and a canvas node that failed its delivery after its run completed;
//  2. makes the author's earning of each charged call final once the caller's billing period has ended and
//     MarketHoldDays have passed (finalizeMarketEarnings), after asking ClawHunt for the caller's plan once more: the
//     author's share of the price, scaled by the part of the period's spending its paid credits covered, so a gift the
//     caller spent earns the author nothing and a period refunded earns nothing at all;
//  3. once a calendar month (UTC) has ended, gathers each author's earnings made final during it into one statement,
//     its calls counted, for a platform administrator to approve (makeMarketStatements). Nothing is transferred by
//     itself (owner 2026-10-29: 「不要自动转账，按照次数累计解决，一个月一次统计完整的调用次数」);
//  4. with transfers on, sends the statements an administrator approved into the authors' ClawHunt wallets
//     (payMarketEarnings).

const (
	marketSettleEvery = 10 * time.Minute
	// A held fee whose run no longer exists (its canvas was deleted) is released after this long.
	marketMissingRunAfter = time.Hour
	marketPayoutBatch     = 50
	microcreditsPerCredit = 1_000_000
)

func (a *App) startMarketSettlement(ctx context.Context) {
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				a.settleMarket(ctx)
				timer.Reset(marketSettleEvery)
			}
		}
	}()
}

func (a *App) settleMarket(ctx context.Context) {
	if err := a.reconcileMarketCalls(ctx); err != nil && ctx.Err() == nil {
		a.log.Warn("market settlement: reconciling calls failed", "error_type", errorType(err))
	}
	if err := a.captureMarketPeriods(ctx); err != nil && ctx.Err() == nil {
		a.log.Warn("market settlement: keeping billing periods failed", "error_type", errorType(err))
	}
	if err := a.finalizeMarketEarnings(ctx); err != nil && ctx.Err() == nil {
		a.log.Warn("market settlement: finalizing earnings failed", "error_type", errorType(err))
	}
	// On the database's clock, which stamps the earnings' finalized_at.
	var now time.Time
	err := a.db.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now)
	if err == nil {
		err = a.makeMarketStatements(ctx, now)
	}
	if err != nil && ctx.Err() == nil {
		a.log.Warn("market settlement: making monthly statements failed", "error_type", errorType(err))
	}
	if a.cfg.MarketPayouts {
		a.payMarketEarnings(ctx)
	}
}

// reconcileMarketCalls settles the market calls their runs' ends left open, as settleMarketCall and
// marketDeliveryFailed would have.
func (a *App) reconcileMarketCalls(ctx context.Context) error {
	if _, err := a.db.Exec(ctx, marketSettleCallsSQL, marketAgentFaults); err != nil {
		return err
	}
	if _, err := a.db.Exec(ctx, `UPDATE market_agent_calls c SET status='released',outcome='missing',platform_fault=true,settlement='none',settled_at=clock_timestamp()
		WHERE c.status='reserved' AND c.created_at < clock_timestamp() - $1::interval
		AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=c.tenant_id AND r.id=c.run_id)`, strconv.Itoa(int(marketMissingRunAfter.Seconds()))+" seconds"); err != nil {
		return err
	}
	// A canvas node whose run completed but whose delivery failed (the only way such a node fails): marketDeliveryFailed,
	// where it did not get through. A node cancelled or blocked after its run completed delivered all the same.
	_, err := a.db.Exec(ctx, `UPDATE market_agent_calls c SET outcome='delivery_failed',outcome_code=left(n.detail,200),
		platform_fault=(n.detail='deliverable_storage_failed'),
		status=CASE WHEN n.detail='deliverable_storage_failed' THEN 'released' ELSE c.status END,
		settlement=CASE WHEN n.detail='deliverable_storage_failed' THEN 'none' ELSE c.settlement END
		FROM graph_run_nodes n WHERE c.status='charged' AND c.outcome='completed' AND c.settlement IN ('open','none')
		AND c.settled_at > clock_timestamp() - interval '1 day'
		AND n.tenant_id=c.tenant_id AND n.run_id=c.run_id AND n.state='failed'`)
	return err
}

// marketPeriod is what a caller's billing period was given and spent, as finalization reads it.
type marketPeriod struct {
	paid, carry, spent int64
	known              bool
}

// planPeriodFacts reads what the caller's period that starts at start was given from user_plans: the charged period,
// or the one before it, which user_plans keeps until the next renewal (applyPlan). found is false for an older period
// or an account without a plan record.
func planPeriodFacts(ctx context.Context, q querier, userID string, start time.Time) (paid, carry int64, found bool, err error) {
	var p activePlan
	var prevStart *time.Time
	err = q.QueryRow(ctx, "SELECT user_id,period_start,credits,gift_credits,prev_period_start,prev_credits,prev_carry,prev_gift FROM user_plans WHERE user_id=$1", userID).
		Scan(&p.UserID, &p.PeriodStart, &p.Credits, &p.Gift, &prevStart, &p.PrevCredits, &p.PrevCarry, &p.PrevGift)
	if noRows(err) {
		return 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, false, err
	}
	p.PrevStart = prevStart
	switch {
	case p.PeriodStart.Equal(start):
		if err = withCarry(ctx, q, &p); err != nil {
			return 0, 0, false, err
		}
		return int64(p.Credits), int64(p.Carry), true, nil
	case prevStart != nil && prevStart.Equal(start):
		return int64(p.PrevCredits), int64(p.PrevCarry), true, nil
	}
	return 0, 0, false, nil
}

// marketSettledSpentSQL is what the account's period starting $2 has spent in settled calls only ($1): a model call
// once its charge is known, a generation its provider accepted, a market Agent's price once charged. Unlike
// creditsSpentSQL it holds no reserve of a call still running, which settles lower; its most is kept
// (market_period_facts.spent), as a deleted workspace's calls and generations leave the count.
const marketSettledSpentSQL = `SELECT
	COALESCE((SELECT sum(COALESCE(credit_charge,credit_reserve)) FROM model_invocations
		WHERE billed_user_id=$1 AND billed_period_start=$2 AND credit_reserve IS NOT NULL AND status<>'running'),0)::bigint
	+COALESCE((SELECT sum(g.credit_points) FROM media_generations g WHERE g.billed_user_id=$1 AND g.billed_period_start=$2 AND g.credit_points IS NOT NULL AND g.provider_accepted),0)::bigint
	+COALESCE((SELECT sum(c.price_credits) FROM market_agent_calls c WHERE c.billed_user_id=$1 AND c.billed_period_start=$2 AND c.price_credits>0 AND c.status='charged'),0)::bigint`

// captureMarketPeriods keeps, for every billing period that has calls to settle, what user_plans says it was given
// while user_plans still has it, so finalization can read it after the period has left user_plans, and the most of its
// settled spending seen.
func (a *App) captureMarketPeriods(ctx context.Context) error {
	rows, err := a.db.Query(ctx, "SELECT DISTINCT billed_user_id,billed_period_start FROM market_agent_calls WHERE settlement='open' AND billed_user_id IS NOT NULL")
	if err != nil {
		return err
	}
	type period struct {
		user  string
		start time.Time
	}
	list := []period{}
	for rows.Next() {
		var p period
		if err = rows.Scan(&p.user, &p.start); err != nil {
			rows.Close()
			return err
		}
		list = append(list, p)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, p := range list {
		paid, carry, found, err := planPeriodFacts(ctx, a.db, p.user, p.start)
		if err != nil {
			return err
		}
		var spent int64
		if err = a.db.QueryRow(ctx, marketSettledSpentSQL, p.user, p.start).Scan(&spent); err != nil {
			return err
		}
		if !found {
			// What it was given is no longer on the plan record: keep what was kept, and the most it was seen to spend.
			if _, err = a.db.Exec(ctx, "UPDATE market_period_facts SET spent=GREATEST(spent,$3) WHERE user_id=$1 AND period_start=$2", p.user, p.start, spent); err != nil {
				return err
			}
			continue
		}
		if _, err = a.db.Exec(ctx, `INSERT INTO market_period_facts(user_id,period_start,paid_credits,carry,spent) VALUES($1,$2,$3,$4,$5)
			ON CONFLICT (user_id,period_start) DO UPDATE SET paid_credits=EXCLUDED.paid_credits,carry=EXCLUDED.carry,
			spent=GREATEST(market_period_facts.spent,EXCLUDED.spent),captured_at=clock_timestamp()`,
			p.user, p.start, max(0, paid), max(0, carry), spent); err != nil {
			return err
		}
	}
	return nil
}

// readMarketPeriod reads the caller's period that starts at start: what it was given from user_plans while it has it,
// or else as captureMarketPeriods last kept it, and what it spent, now or at the most it was seen to (a workspace
// deleted since took its spending out of the count). Neither record of what it was given (the account's plan record
// gone before any was kept) is not known.
func readMarketPeriod(ctx context.Context, q querier, userID string, start time.Time) (marketPeriod, error) {
	paid, carry, found, err := planPeriodFacts(ctx, q, userID, start)
	if err != nil {
		return marketPeriod{}, err
	}
	var keptPaid, keptCarry, keptSpent int64
	err = q.QueryRow(ctx, "SELECT paid_credits,carry,spent FROM market_period_facts WHERE user_id=$1 AND period_start=$2", userID, start).Scan(&keptPaid, &keptCarry, &keptSpent)
	kept := err == nil
	if err != nil && !noRows(err) {
		return marketPeriod{}, err
	}
	if !found {
		if !kept {
			return marketPeriod{}, nil
		}
		paid, carry = keptPaid, keptCarry
	}
	out := marketPeriod{paid: paid, carry: carry, known: true}
	if out.spent, err = creditsSpent(ctx, q, &activePlan{UserID: userID, PeriodStart: start}); err != nil {
		return out, err
	}
	out.spent = max(out.spent, keptSpent)
	return out, nil
}

// marketEarning is the author's final share of one charged price, in micro-credits: the price less the platform's
// basis points, times the part of the period's spending its paid credits (less what an earlier period's overspend
// took) covered, rounded down.
func marketEarning(price, feeBps int, period marketPeriod) int64 {
	if !period.known || price <= 0 || period.spent <= 0 {
		return 0
	}
	covered := min(max(0, period.paid-period.carry), period.spent)
	share := new(big.Int).Mul(big.NewInt(int64(price)), big.NewInt(int64(10000-feeBps)*100))
	share.Mul(share, big.NewInt(covered))
	share.Quo(share, big.NewInt(period.spent))
	return share.Int64()
}

// marketPeriodKnown says of a call c whether what its caller's billing period was given is on record: in user_plans
// (the charged period or the one before it) or as captureMarketPeriods kept it.
const marketPeriodKnown = `(EXISTS(SELECT 1 FROM market_period_facts f WHERE f.user_id=c.billed_user_id AND f.period_start=c.billed_period_start)
	OR EXISTS(SELECT 1 FROM user_plans p WHERE p.user_id=c.billed_user_id AND (p.period_start=c.billed_period_start OR p.prev_period_start=c.billed_period_start)))`

// finalizeMarketEarnings makes final the earnings of every caller period whose hold has passed, the oldest first, and
// after them the periods whose caller's plan could not be read again last time, so that they hold up no other. A period
// whose facts are not on record stays open for the operator, and is left out for the same reason.
func (a *App) finalizeMarketEarnings(ctx context.Context) error {
	hold := strconv.Itoa(a.cfg.MarketHoldDays) + " days"
	rows, err := a.db.Query(ctx, `SELECT c.billed_user_id,c.billed_period_start,min(c.billed_period_end) FROM market_agent_calls c
		WHERE c.settlement='open' AND c.status='charged' AND c.billed_period_end + $1::interval < clock_timestamp() AND `+marketPeriodKnown+`
		GROUP BY c.billed_user_id,c.billed_period_start
		ORDER BY (SELECT f.refresh_failed_at FROM market_period_facts f WHERE f.user_id=c.billed_user_id AND f.period_start=c.billed_period_start) NULLS FIRST,
			min(c.billed_period_end),c.billed_user_id,c.billed_period_start LIMIT 200`, hold)
	if err != nil {
		return err
	}
	type group struct {
		user       string
		start, end time.Time
	}
	groups := []group{}
	for rows.Next() {
		var g group
		if err = rows.Scan(&g.user, &g.start, &g.end); err != nil {
			rows.Close()
			return err
		}
		groups = append(groups, g)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	unreachable := 0
	failed := func(g group) {
		// Its next round tries it after the others (the query's order).
		if _, err := a.db.Exec(ctx, "UPDATE market_period_facts SET refresh_failed_at=clock_timestamp() WHERE user_id=$1 AND period_start=$2", g.user, g.start); err != nil && ctx.Err() == nil {
			a.log.Warn("market settlement: a period's failed plan read was not recorded", "error_type", errorType(err))
		}
	}
	for _, g := range groups {
		outcome := a.refreshMarketPayer(ctx, g.user)
		if outcome == marketPayerUnreachable {
			// ClawHunt gave no answer at all: the period waits, and the others go on, unless ClawHunt answers for none of
			// them (three in a row), when the rest waits for the next round.
			failed(g)
			if unreachable++; unreachable >= 3 {
				return nil
			}
			continue
		}
		// Any answer, even a refusal, says ClawHunt is there.
		unreachable = 0
		if outcome == marketPayerUnread {
			// Asked again every round, after the others; after marketPayerGrace, made final on what is on record.
			if time.Since(g.end) < time.Duration(a.cfg.MarketHoldDays)*24*time.Hour+marketPayerGrace {
				failed(g)
				continue
			}
			a.log.Warn("market settlement: a caller's plan was never read again; its earnings are made final on what is on record")
		}
		if err = a.finalizeMarketPeriod(ctx, g.user, g.start); err != nil {
			return err
		}
	}
	var unknown int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM (SELECT DISTINCT c.billed_user_id,c.billed_period_start FROM market_agent_calls c
		WHERE c.settlement='open' AND c.status='charged' AND c.billed_period_end + $1::interval < clock_timestamp() AND NOT `+marketPeriodKnown+`) s`, hold).Scan(&unknown); err != nil {
		return err
	}
	if unknown > 0 {
		a.log.Error("market settlement: callers' billing periods are not known; their calls stay open for the operator", "periods", unknown)
	}
	return nil
}

// The outcomes of refreshMarketPayer.
const (
	marketPayerRead = iota
	marketPayerUnreachable
	marketPayerUnread
)

// marketPayerGrace is how long past its hold a period's earnings wait for its caller's plan to be read again before
// they are made final on what is on record (an account ClawHunt keeps refusing).
const marketPayerGrace = 30 * 24 * time.Hour

// refreshMarketPayer asks ClawHunt once more for the plan of a caller whose period's earnings are about to be made
// final, as plan_sync.go does for live plans only: a refund or a dispute of a plan cancelled since then shows only so.
// A caller without a ClawHunt account, or a site without ClawHunt, has nothing to ask (read). ClawHunt not answering
// is unreachable; any other failure (a refusal, an answer that cannot be read, the database) is unread.
func (a *App) refreshMarketPayer(ctx context.Context, userID string) int {
	if !a.clawHuntEnabled() {
		return marketPayerRead
	}
	var subject string
	err := a.db.QueryRow(ctx, "SELECT subject FROM external_identities WHERE user_id=$1 AND issuer=$2", userID, a.cfg.ClawHuntURL).Scan(&subject)
	if noRows(err) {
		return marketPayerRead
	}
	status := 0
	if err == nil {
		status, err = a.syncPlanBySubjectStatus(ctx, userID, subject)
	}
	switch {
	case err == nil:
		return marketPayerRead
	case ctx.Err() != nil || (errors.Is(err, errClawHuntUnreachable) && status == 0):
		// No answer at all: ClawHunt is down, or not reached.
		if ctx.Err() == nil {
			a.log.Warn("market settlement: ClawHunt did not answer for a caller's plan; earnings wait")
		}
		return marketPayerUnreachable
	}
	// An answer that refuses or fails this account (a 5xx about it included), or one that cannot be read.
	a.log.Warn("market settlement: a caller's plan could not be read again; its earnings wait", "status", status, "error_type", errorType(err))
	return marketPayerUnread
}

func (a *App) finalizeMarketPeriod(ctx context.Context, userID string, start time.Time) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	// Shared with every other finalizing, until this commits: a month's statement waits for it (marketMonthCloseLock).
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared("+marketMonthCloseLock+")"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('awwo-market-period:' || $1, 84321021))", userID); err != nil {
		return err
	}
	period, err := readMarketPeriod(ctx, tx, userID, start)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, "SELECT id,price_credits,fee_bps FROM market_agent_calls WHERE billed_user_id=$1 AND billed_period_start=$2 AND settlement='open' AND status='charged' FOR UPDATE", userID, start)
	if err != nil {
		return err
	}
	type call struct {
		id          string
		price, bps  int
		earnedMicro int64
	}
	calls := []call{}
	for rows.Next() {
		var c call
		if err = rows.Scan(&c.id, &c.price, &c.bps); err != nil {
			rows.Close()
			return err
		}
		c.earnedMicro = marketEarning(c.price, c.bps, period)
		calls = append(calls, c)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if !period.known {
		// Nothing says what the caller paid for this period (its plan record went before the settlement job kept it):
		// the calls stay open for the operator, earning nothing until then.
		a.log.Error("market settlement: a caller's billing period is not known; its calls stay open", "calls", len(calls))
		return nil
	}
	for _, c := range calls {
		if _, err = tx.Exec(ctx, "UPDATE market_agent_calls SET earned_microcredits=$2,settlement='final',finalized_at=clock_timestamp() WHERE id=$1", c.id, c.earnedMicro); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// marketStatementMonth is the calendar month (UTC) whose statements are made at now, the one before now's, and when
// it ended.
func marketStatementMonth(now time.Time) (month, end time.Time) {
	now = now.UTC()
	end = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	return end.AddDate(0, -1, 0), end
}

// marketMonthOf is the first instant of the calendar month (UTC) t is in.
func marketMonthOf(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// marketStatementID is the id of an author's statement for a month, which is the reference ClawHunt credits once: made
// from the two, so an author's month always names one transfer, however often it is sent or made. It has randomID's
// form, the one ClawHunt accepts.
func marketStatementID(authorID string, month time.Time) string {
	sum := sha256.Sum256([]byte("awwo-market-statement\x00" + authorID + "\x00" + month.UTC().Format("2006-01")))
	return "a" + base64.RawURLEncoding.EncodeToString(sum[:24])
}

// marketMonthCloseLock is the advisory lock that making a statement and making earnings final share, one per schema as
// the worker lease is (app.go). Finalizing holds it shared from before it stamps finalized_at until it commits, and a
// statement is made holding it alone, so every earning stamped before a month ended is in the database when its
// statement is made, and every earning stamped after belongs to a later month: an earning made final in a month is
// never left out of that month's statement by a transaction still committing, here or in another API process.
const marketMonthCloseLock = "hashtextextended('awwo-market-month-close:' || current_schema(), 84321023)"

// marketMonthCloseWait bounds a statement's wait for the lock: one finalizing that never commits (a frozen process
// whose connection stays up) holds up every other finalizing queued behind the wait, so the statement gives up and the
// next round tries again.
const marketMonthCloseWait = "30s"

// makeMarketStatements makes each author's statements up to the calendar month (UTC) before now's, now being the
// database's clock, which stamps finalized_at. An author with earnings made final before that month's end that no
// statement holds, a ClawHunt account, and earnings with their carried remainder of a cent or more, is brought up to date
// month by month (makeAuthorStatements), so a month the job did not run in still gets its own statement. One without a
// ClawHunt account gets none until they link one. The longest waiting go first, marketPayoutBatch a round. Statements
// are made whether transfers are on or not: they are the months' tally, and only an administrator's approval sends one.
func (a *App) makeMarketStatements(ctx context.Context, now time.Time) error {
	if !a.clawHuntEnabled() {
		return nil
	}
	last, end := marketStatementMonth(now)
	rows, err := a.db.Query(ctx, `SELECT c.author_user_id,e.subject,min(c.finalized_at) FROM market_agent_calls c
		JOIN external_identities e ON e.user_id=c.author_user_id AND e.issuer=$1
		WHERE c.settlement='final' AND c.payout_id IS NULL AND c.finalized_at < $2
		AND NOT EXISTS(SELECT 1 FROM market_payouts p WHERE p.author_user_id=c.author_user_id AND p.period_month>=$3::date)
		GROUP BY c.author_user_id,e.subject
		HAVING sum(COALESCE(c.earned_microcredits,0))+COALESCE((SELECT p.carry_out_microcredits FROM market_payouts p WHERE p.author_user_id=c.author_user_id
			ORDER BY p.period_month DESC NULLS LAST,p.created_at DESC,p.id DESC LIMIT 1),0) >= $4
		ORDER BY min(c.finalized_at),c.author_user_id LIMIT $5`, a.cfg.ClawHuntURL, end, last.Format("2006-01-02"), microcreditsPerCredit, marketPayoutBatch)
	if err != nil {
		return err
	}
	type author struct {
		user, subject string
		oldest        time.Time
	}
	authors := []author{}
	for rows.Next() {
		var x author
		if err = rows.Scan(&x.user, &x.subject, &x.oldest); err != nil {
			rows.Close()
			return err
		}
		authors = append(authors, x)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	// One author's failure holds up no other: the round goes on, and answers the first. A month-close lock it could not
	// get in time ends the round, as every other author would wait for it as long.
	var failed error
	for _, x := range authors {
		if err = a.makeAuthorStatements(ctx, x.user, x.subject, x.oldest, last); err != nil {
			var pgErr *pgconn.PgError
			if ctx.Err() != nil || (errors.As(err, &pgErr) && pgErr.Code == "55P03") {
				return err
			}
			if failed == nil {
				failed = err
			}
		}
	}
	return failed
}

// makeAuthorStatements makes an author's statements in order, one for each month from that of their oldest earning on
// no statement (or the month after their latest statement, where that is later) up to last, each with the earnings made
// final before its month ended. A month below a cent gets none, and its earnings go on the next month's.
func (a *App) makeAuthorStatements(ctx context.Context, userID, subject string, oldest, last time.Time) error {
	var latest *time.Time
	if err := a.db.QueryRow(ctx, "SELECT max(period_month)::timestamp FROM market_payouts WHERE author_user_id=$1", userID).Scan(&latest); err != nil {
		return err
	}
	month := marketMonthOf(oldest)
	if latest != nil && !month.After(marketMonthOf(*latest)) {
		month = marketMonthOf(*latest).AddDate(0, 1, 0)
	}
	for ; !month.After(last); month = month.AddDate(0, 1, 0) {
		if err := a.makeMarketStatement(ctx, userID, subject, month); err != nil {
			return err
		}
	}
	return nil
}

// makeMarketStatement makes the author's statement for month, unless they have one for it or a later month (a
// statement is never made out of order: each carries in the remainder its predecessor left).
func (a *App) makeMarketStatement(ctx context.Context, userID, subject string, month time.Time) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SET LOCAL lock_timeout = '"+marketMonthCloseWait+"'"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock("+marketMonthCloseLock+")"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('awwo-market-payout:' || $1, 84321022))", userID); err != nil {
		return err
	}
	day := month.Format("2006-01-02")
	var made bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM market_payouts WHERE author_user_id=$1 AND period_month>=$2::date)", userID, day).Scan(&made); err != nil || made {
		return err
	}
	// The calls are taken into the statement and counted in one statement, so a call made final meanwhile is either in
	// both or in neither. Below a cent the rollback gives them back.
	id := marketStatementID(userID, month)
	var earned, credits int64
	var calls int
	if err = tx.QueryRow(ctx, `WITH taken AS (UPDATE market_agent_calls SET payout_id=$2 WHERE author_user_id=$1 AND settlement='final' AND payout_id IS NULL AND finalized_at < $3
		RETURNING COALESCE(earned_microcredits,0) AS earned,price_credits) SELECT COALESCE(sum(earned),0)::bigint,count(*)::int,COALESCE(sum(price_credits),0)::bigint FROM taken`,
		userID, id, month.AddDate(0, 1, 0)).Scan(&earned, &calls, &credits); err != nil {
		return err
	}
	var carry int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT carry_out_microcredits FROM market_payouts WHERE author_user_id=$1
		ORDER BY period_month DESC NULLS LAST,created_at DESC,id DESC LIMIT 1),0)`, userID).Scan(&carry); err != nil {
		return err
	}
	total := earned + carry
	cents := total / microcreditsPerCredit
	if cents < 1 {
		return nil
	}
	if _, err = tx.Exec(ctx, `INSERT INTO market_payouts(id,author_user_id,subject,microcredits,carry_in_microcredits,carry_out_microcredits,amount_cents,status,period_month,calls,credits)
		VALUES($1,$2,$3,$4,$5,$6,$7,'review',$8::date,$9,$10)`, id, userID, subject, total, carry, total-cents*microcreditsPerCredit, cents, day, calls, credits); err != nil {
		return err
	}
	if err = audit(ctx, tx, "", "", "market.statement.made", id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// payMarketEarnings sends every statement an administrator approved that is due: approving makes it pending, and a
// send that did not go through waits before it is asked again. Nothing an administrator did not approve is sent.
func (a *App) payMarketEarnings(ctx context.Context) {
	rows, err := a.db.Query(ctx, `SELECT id,subject,COALESCE(to_char(period_month,'YYYY-MM'),''),amount_cents,attempts FROM market_payouts
		WHERE status IN ('pending','held') AND approved_at IS NOT NULL AND next_attempt_at<=clock_timestamp()
		ORDER BY next_attempt_at,id LIMIT $1`, marketPayoutBatch)
	if err != nil {
		if ctx.Err() == nil {
			a.log.Warn("market payouts: listing due payouts failed", "error_type", errorType(err))
		}
		return
	}
	type due struct {
		id, subject, month string
		cents              int64
		attempts           int
	}
	list := []due{}
	for rows.Next() {
		var d due
		if err = rows.Scan(&d.id, &d.subject, &d.month, &d.cents, &d.attempts); err != nil {
			rows.Close()
			return
		}
		list = append(list, d)
	}
	rows.Close()
	for _, d := range list {
		if ctx.Err() != nil {
			return
		}
		a.sendMarketPayout(ctx, d.id, d.subject, d.month, d.cents, d.attempts)
	}
}

// marketPayoutNote is the line the author's ClawHunt wallet shows for a statement of month ("2006-01").
func marketPayoutNote(month string) string {
	if month == "" {
		return "AwwO Agent market earnings"
	}
	return "AwwO Agent market earnings, " + month
}

// sendMarketPayout asks ClawHunt to credit one approved statement to the author's wallet, with the statement's id as
// the reference ClawHunt credits once. Only an answer that says it credited this reference sends it. The author's
// ClawHunt account unable to receive it (deleted, suspended, AwwO withdrawn, 409): held, asked again daily. Anything
// else, no answer, an answer cut short or unreadable, another refusal, may follow a credit that was made, so the
// statement stays pending and the same reference is asked again, waiting longer each time up to an hour; after many
// attempts it is logged for the operator.
func (a *App) sendMarketPayout(ctx context.Context, id, subject, month string, cents int64, attempts int) {
	var out struct {
		Credited      bool   `json:"credited"`
		Reference     string `json:"reference"`
		TransactionID string `json:"transaction_id"`
	}
	status, err := a.clawHuntRequestStatus(ctx, "earnings", map[string]any{"subject": subject, "amount_cents": cents, "reference": id,
		"note": marketPayoutNote(month)}, &out)
	if err == nil && (!out.Credited || out.Reference != id) {
		err, status = errors.New("unexpected earnings answer"), 0
	}
	var update string
	var args []any
	switch {
	case err == nil:
		update, args = "UPDATE market_payouts SET status='sent',sent_at=clock_timestamp(),attempts=attempts+1,last_error='',clawhunt_transaction=$2 WHERE id=$1 AND status IN ('pending','held')", []any{id, out.TransactionID}
	case status == http.StatusConflict:
		update, args = "UPDATE market_payouts SET status='held',attempts=attempts+1,last_error='payee_ineligible',next_attempt_at=clock_timestamp()+interval '1 day' WHERE id=$1 AND status IN ('pending','held')", []any{id}
	default:
		reason := "unreachable"
		if status != 0 && !errors.Is(err, errClawHuntUnreachable) {
			// With the code ClawHunt gave, so an administrator reads why (amount_above_cap: its cap must be raised;
			// reference_conflict: the reference was credited for another amount, which an operator must look into).
			reason = "answer_" + strconv.Itoa(status)
			var refusal clawHuntRefusal
			if errors.As(err, &refusal) && refusal.code != "" {
				reason += ":" + refusal.code
			}
		}
		wait := min(time.Hour, time.Minute<<min(attempts, 6))
		update, args = "UPDATE market_payouts SET attempts=attempts+1,last_error=$3,next_attempt_at=clock_timestamp()+$2::interval WHERE id=$1 AND status IN ('pending','held')", []any{id, strconv.Itoa(int(wait.Seconds())) + " seconds", reason}
		if attempts+1 >= 20 {
			a.log.Error("a market payout keeps failing; the operator must look at it", "payout", id, "status", status, "attempts", attempts+1)
		}
	}
	if _, e := a.db.Exec(ctx, update, args...); e != nil && ctx.Err() == nil {
		a.log.Warn("market payouts: recording a payout's outcome failed", "payout", id, "error_type", errorType(e))
	}
}
