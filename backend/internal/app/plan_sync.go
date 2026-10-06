package app

import (
	"context"
	"time"
)

// Plans change at ClawHunt without the account being here: a renewal is charged, a payment fails, a subscription
// is cancelled or refunded, a checkout completes after its tab was closed. The API reads those plans again by
// subject in the background, so that what an account's members may run never waits for its payer to sign in.

const (
	planSyncEvery  = 2 * time.Minute
	planSyncBatch  = 25
	planSyncRounds = 8
)

// duePlansSQL lists the accounts whose plan is read again now: first every live plan around the end of its period
// (from ten minutes before it to two days after, every five minutes), then every account watched after a checkout or
// a portal visit (every two minutes), then every live plan unread for an hour; the longest unread first within each.
// A plan whose last read failed waits until its retry_after.
const duePlansSQL = `SELECT x.user_id,e.subject FROM (
	SELECT user_id,CASE WHEN period_end<clock_timestamp()+interval '10 minutes' AND period_end>clock_timestamp()-interval '2 days' THEN 0 ELSE 2 END AS rank,synced_at AS last
	FROM user_plans WHERE status IN ('active','trialing','past_due','incomplete','unpaid','paused') AND (retry_after IS NULL OR retry_after<=clock_timestamp()) AND (
		(period_end<clock_timestamp()+interval '10 minutes' AND period_end>clock_timestamp()-interval '2 days' AND synced_at<clock_timestamp()-interval '5 minutes')
		OR synced_at<clock_timestamp()-interval '1 hour')
	UNION ALL
	SELECT user_id,1 AS rank,checked_at AS last FROM plan_watches WHERE until>clock_timestamp() AND checked_at<clock_timestamp()-interval '2 minutes'
) x JOIN external_identities e ON e.user_id=x.user_id AND e.issuer=$1
ORDER BY x.rank,x.last LIMIT $2`

func (a *App) startPlanSync(ctx context.Context) {
	if !a.clawHuntEnabled() {
		return
	}
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		timer := time.NewTimer(30 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				a.syncDuePlans(ctx)
				timer.Reset(planSyncEvery)
			}
		}
	}()
}

// syncDuePlans reads the due plans, a batch at a time, for at most planSyncRounds batches a round, and stops early
// when a whole batch could not be read (ClawHunt down). A plan ClawHunt cannot answer for is tried again after as
// long as it has gone unread, from five minutes up to an hour, so plans that keep failing neither crowd out the
// others nor ask ClawHunt more than hourly.
func (a *App) syncDuePlans(ctx context.Context) {
	for range planSyncRounds {
		due, failed := a.syncDueBatch(ctx)
		if due < planSyncBatch || failed == due || ctx.Err() != nil {
			break
		}
	}
	if _, err := a.db.Exec(ctx, "DELETE FROM plan_watches WHERE until<clock_timestamp()"); err != nil && ctx.Err() == nil {
		a.log.Warn("plan sync: expired watches not removed", "error", err.Error())
	}
}

// syncDueBatch reads one batch of due plans and reports how many were due and how many could not be read.
func (a *App) syncDueBatch(ctx context.Context) (int, int) {
	rows, err := a.db.Query(ctx, duePlansSQL, a.cfg.ClawHuntURL, planSyncBatch)
	if err != nil {
		if ctx.Err() == nil {
			a.log.Warn("plan sync: listing due plans failed", "error", err.Error())
		}
		return 0, 0
	}
	type due struct{ user, subject string }
	list, seen := []due{}, map[string]bool{}
	for rows.Next() {
		var d due
		if err = rows.Scan(&d.user, &d.subject); err != nil {
			rows.Close()
			return 0, 0
		}
		if !seen[d.user] {
			seen[d.user] = true
			list = append(list, d)
		}
	}
	rows.Close()
	failed := 0
	for _, d := range list {
		if ctx.Err() != nil {
			return len(list), failed
		}
		if err := a.syncPlanBySubject(ctx, d.user, d.subject); err != nil {
			failed++
			a.log.Warn("plan sync failed", "error", err.Error())
			if _, e := a.db.Exec(ctx, `UPDATE user_plans SET retry_after=clock_timestamp()+LEAST(interval '1 hour',GREATEST(interval '5 minutes',clock_timestamp()-synced_at))
				WHERE user_id=$1`, d.user); e != nil && ctx.Err() == nil {
				a.log.Warn("plan sync: retry not scheduled", "error", e.Error())
			}
		}
		if _, err := a.db.Exec(ctx, "UPDATE plan_watches SET checked_at=clock_timestamp() WHERE user_id=$1", d.user); err != nil && ctx.Err() == nil {
			a.log.Warn("plan sync: watch not updated", "error", err.Error())
		}
	}
	return len(list), failed
}
