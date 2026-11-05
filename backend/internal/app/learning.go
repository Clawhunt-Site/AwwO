package app

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// A workspace's learning settings (workspace_learning, migrations 052 and 055), each change audited, and each offered
// only where the deployment offers it:
//
//   - Self-learning (the owner's 2026-11-04 choice: on unless an admin turns it off). The workspace learns from its own
//     canvas runs: ClawHunt's default model reads a run's record and keeps notes for its canvas, given to its later runs
//     once a later run bears them out (run_memory.go), and the learning cycles tidy the notes AwwO keeps with the same model
//     and give a lesson that kept helping to its template (learning_cycle.go). Offered only with AWWO_SELF_LEARNING=on,
//     set once ClawHunt's privacy policy names this use, and never in the local edition; no run begun before
//     AWWO_SELF_LEARNING_SINCE is read. An admin or the owner turns it off or on again: off, nothing more is read, no
//     note AwwO kept is given to a run and no lesson is moved (what was kept stays, for people to remove in Memory),
//     and 052's memory suggestions go off too; on again, only the runs begun after that are read.
//   - Help improve AwwO (learning consent). Only the workspace's owner turns it on or off. While it is on, the operator's
//     learning export (operator/learning.go) may take copies of the canvas runs the workspace makes from then on, to
//     evaluate and train models, as ClawHunt's privacy policy says once it does: the deployment offers it only with
//     AWWO_LEARNING_CONSENT=on, set once the policy is live. Off, nothing of the workspace's content is exported; the
//     content-free records every workspace's runs leave (node_outcomes.go) are not under it. The consent is its giver's
//     (consent_by): it holds only while they own the workspace (consentHoldsSQL), and goes with their account, so a
//     workspace an operator hands to another owner is off until its new owner turns it on.
//
// Every member sees both: self-learning where it is offered, and since when it has been on; the consent where it is
// offered, or on though no longer offered, to be turned off.

// learningSetting is one of the two, as a workspace's members read it.
type learningSetting struct {
	Offered bool       `json:"offered"`
	On      bool       `json:"on"`
	Since   *time.Time `json:"since"`
}

// consentHoldsSQL is whether workspace_learning row l's consent holds: given, by the workspace's owner as it is now (the
// operator's export reads the same, operator/learning.go).
const consentHoldsSQL = `(l.consent_at IS NOT NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=l.tenant_id AND m.user_id=l.consent_by AND m.role='owner'))`

// learningHoldsSQL is whether workspace tid learns from canvas run gid now, with tid, gid and since the placeholders
// that hold them: the run began at or after since (AWWO_SELF_LEARNING_SINCE), and no admin has self-learning off, nor
// turned it on again only after the run began. Whether the deployment offers it is the caller's to check
// (selfLearningOffered).
func learningHoldsSQL(tid, gid, since string) string {
	return `EXISTS (SELECT 1 FROM graph_runs g WHERE g.tenant_id=` + tid + ` AND g.id=` + gid + ` AND g.created_at>=` + since + `
		AND NOT EXISTS (SELECT 1 FROM workspace_learning l WHERE l.tenant_id=` + tid + ` AND (l.learning_off_at IS NOT NULL OR l.learning_on_at>g.created_at)))`
}

// workspaceLearnsSQL is whether workspace tid (a placeholder) learns now: no admin has self-learning off.
func workspaceLearnsSQL(tid string) string {
	return `NOT EXISTS (SELECT 1 FROM workspace_learning l WHERE l.tenant_id=` + tid + ` AND l.learning_off_at IS NOT NULL)`
}

// errLearningOff is a workspace that turned self-learning off while one of its runs, or its notes, were being read.
var errLearningOff = errors.New("self-learning turned off")

// errWorkspaceInactive is a workspace suspended or gone while one of its runs, or its notes, were being read.
var errWorkspaceInactive = errors.New("workspace not active")

// holdWorkspaceRow takes workspace tid's row in tx, shared (FOR SHARE: every person's write, turning self-learning off
// and a suspension wait for it, and it for them; the learning's own holds share it), and answers whether the workspace
// is active: one suspended or gone has nothing learnt for it.
func holdWorkspaceRow(ctx context.Context, tx pgx.Tx, tid string) (bool, error) {
	var status string
	err := tx.QueryRow(ctx, "SELECT status FROM tenants WHERE id=$1 FOR SHARE", tid).Scan(&status)
	if noRows(err) {
		return false, nil
	}
	return err == nil && status == "active", err
}

// serializeLearningWrites takes, for the rest of tx, workspace tid's lock for the writes self-learning makes (a run's
// notes, a cycle's changes): two of them never interleave, so that neither builds on a note the other is changing.
func serializeLearningWrites(ctx context.Context, tx pgx.Tx, tid string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('awwo-learning-writes:' || $1, 84321006))`, tid)
	return err
}

// errLearningWritesBusy is a learning write of the workspace under way as a hold began: nothing is sent, and the run or
// the cycle is tried again later.
var errLearningWritesBusy = errors.New("a learning write of the workspace is under way")

// tryLearningWrites takes serializeLearningWrites' lock in tx only if no other transaction holds it
// (errLearningWritesBusy): a hold, which keeps the workspace row, never waits on it, so that nothing else waits on the
// row meanwhile.
func tryLearningWrites(ctx context.Context, tx pgx.Tx, tid string) error {
	var got bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('awwo-learning-writes:' || $1, 84321006))`, tid).Scan(&got); err != nil {
		return err
	}
	if !got {
		return errLearningWritesBusy
	}
	return nil
}

// selfLearningOffered is whether this deployment lets workspaces learn from their runs.
func (a *App) selfLearningOffered() bool { return a.cfg.SelfLearning && !a.cfg.UserCredentials }

// selfLearningEarliest is the earliest AWWO_SELF_LEARNING_SINCE: the day self-learning was written, before which no
// privacy policy named it, so that a time mistyped years back reads no run from before.
var selfLearningEarliest = time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)

// parseSelfLearning reads AWWO_SELF_LEARNING (on, off or unset) and AWWO_SELF_LEARNING_SINCE (an RFC 3339 time, needed
// when it is on, not before selfLearningEarliest). AWWO_MEMORY_DISTILL, which offered 052's memory suggestions, is
// replaced by them: on, it stops the start rather than going unread.
func parseSelfLearning(on, since, old string) (bool, time.Time, error) {
	if old != "" && old != "off" {
		return false, time.Time{}, errors.New("AWWO_MEMORY_DISTILL is replaced by AWWO_SELF_LEARNING=on with AWWO_SELF_LEARNING_SINCE")
	}
	switch on {
	case "", "off":
		return false, time.Time{}, nil
	case "on":
		at, err := time.Parse(time.RFC3339, since)
		if err != nil {
			return false, time.Time{}, errors.New("AWWO_SELF_LEARNING=on needs AWWO_SELF_LEARNING_SINCE, an RFC 3339 time: no run begun before it is read")
		}
		if at.Before(selfLearningEarliest) {
			return false, time.Time{}, errors.New("AWWO_SELF_LEARNING_SINCE is before 2026-11-04, when self-learning was written: set it to when the privacy policy began to name it")
		}
		return true, at, nil
	}
	return false, time.Time{}, errors.New("AWWO_SELF_LEARNING must be on or off")
}

// learningView is a workspace's two settings, and whether the person has a consent of theirs on in another workspace
// (elsewhere), so that the page keeps the way to it. Self-learning, where offered, is on unless it was turned off (off),
// since the deployment began to offer it or since it was last turned on again (on), whichever is later.
func (a *App) learningView(consent, off, on *time.Time, elsewhere bool) map[string]any {
	learning := learningSetting{Offered: a.selfLearningOffered()}
	if learning.Offered && off == nil {
		since := a.cfg.SelfLearningSince
		if on != nil && on.After(since) {
			since = *on
		}
		learning.On, learning.Since = true, &since
	}
	return map[string]any{
		"consent":      learningSetting{Offered: a.cfg.LearningConsent, On: consent != nil, Since: consent},
		"selfLearning": learning,
		"elsewhere":    elsewhere,
	}
}

// learningElsewhere is whether person user's consent holds in a workspace other than tid, which they may turn off.
// (Self-learning needs no way there: where it is offered, every workspace shows it.)
func learningElsewhere(ctx context.Context, q querier, tid, user string) (bool, error) {
	var elsewhere bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_learning l JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=$2
		WHERE l.tenant_id<>$1 AND l.consent_at IS NOT NULL AND l.consent_by=$2 AND m.role='owner')`, tid, user).Scan(&elsewhere)
	return elsewhere, err
}

func (a *App) learningSettings(w http.ResponseWriter, r *http.Request) {
	var consent, off, on *time.Time
	err := a.db.QueryRow(r.Context(), `SELECT CASE WHEN `+consentHoldsSQL+` THEN l.consent_at END,l.learning_off_at,l.learning_on_at FROM workspace_learning l WHERE l.tenant_id=$1`,
		r.PathValue("tenantId")).Scan(&consent, &off, &on)
	if err != nil && !noRows(err) {
		a.dbError(w, err)
		return
	}
	elsewhere, err := learningElsewhere(r.Context(), a.db, r.PathValue("tenantId"), currentUser(r).ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, a.learningView(consent, off, on, elsewhere))
}

// updateLearningSettings turns either setting on or off: the consent by the workspace's owner, self-learning by an admin
// or the owner, each turned on only where the deployment offers it. Turning the consent on again keeps when it was
// first given (one that no longer holds, its giver no longer the owner, is given anew); off clears it. Self-learning
// turned off records who and when (once), and turns 052's memory suggestions off with it, so that an API from before
// self-learning does not take them up again; turned on again, it learns from the runs begun from then on.
func (a *App) updateLearningSettings(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Consent      *bool `json:"consent"`
		SelfLearning *bool `json:"selfLearning"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Consent == nil && b.SelfLearning == nil {
		fail(w, 400, "invalid_input", "Say which setting to change: consent or selfLearning")
		return
	}
	// Turning one on needs the deployment to offer it; turning one off never does, so that one given while it was
	// offered can always be withdrawn (and self-learning turned off ahead of an offer stays off).
	if (b.Consent != nil && *b.Consent && !a.cfg.LearningConsent) || (b.SelfLearning != nil && *b.SelfLearning && !a.selfLearningOffered()) {
		fail(w, 409, "learning_unavailable", "This AwwO does not offer that setting")
		return
	}
	tid := r.PathValue("tenantId")
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// The person's role as it stands now (the workspace row is locked first: a run's record and the workspace's notes
	// are read for self-learning only under that row, so turning it off either comes first or after they were read).
	role, ok := a.mutationRole(w, r, tx, tid, 3)
	if !ok {
		return
	}
	if b.Consent != nil && roleLevel(role) < roleLevel("owner") {
		fail(w, 403, "forbidden", "Only the workspace's owner decides whether its content helps improve AwwO")
		return
	}
	var consent, off, on *time.Time
	if err = tx.QueryRow(r.Context(), `INSERT INTO workspace_learning AS l(tenant_id,consent_at,consent_by,learning_off_at,learning_off_by)
		VALUES($1,CASE WHEN $2::boolean THEN clock_timestamp() END,CASE WHEN $2::boolean THEN $4 END,
			CASE WHEN NOT $3::boolean THEN clock_timestamp() END,CASE WHEN NOT $3::boolean THEN $4 END)
		ON CONFLICT (tenant_id) DO UPDATE SET
			consent_at=CASE WHEN $2::boolean IS NULL THEN l.consent_at WHEN NOT $2 THEN NULL
				WHEN l.consent_at IS NOT NULL AND l.consent_by=$4 THEN l.consent_at ELSE clock_timestamp() END,
			consent_by=CASE WHEN $2::boolean IS NULL THEN l.consent_by WHEN NOT $2 THEN NULL ELSE $4 END,
			learning_off_at=CASE WHEN $3::boolean IS NULL THEN l.learning_off_at WHEN $3 THEN NULL ELSE COALESCE(l.learning_off_at,clock_timestamp()) END,
			learning_off_by=CASE WHEN $3::boolean IS NULL OR (l.learning_off_at IS NOT NULL AND NOT $3) THEN l.learning_off_by WHEN $3 THEN NULL ELSE $4 END,
			learning_on_at=CASE WHEN $3 AND l.learning_off_at IS NOT NULL THEN clock_timestamp() ELSE l.learning_on_at END,
			suggestions_at=CASE WHEN NOT $3::boolean THEN NULL ELSE l.suggestions_at END,
			updated_at=clock_timestamp()
		RETURNING CASE WHEN `+consentHoldsSQL+` THEN l.consent_at END,l.learning_off_at,l.learning_on_at`, tid, b.Consent, b.SelfLearning, currentUser(r).ID).Scan(&consent, &off, &on); err != nil {
		a.dbError(w, err)
		return
	}
	// Turned off, self-learning lets go of the workspace's canvas runs still queued for it.
	if b.SelfLearning != nil && !*b.SelfLearning {
		if _, err = tx.Exec(r.Context(), `UPDATE run_distillations SET state='skipped',reason='learning_off',updated_at=clock_timestamp()
			WHERE tenant_id=$1 AND state='queued'`, tid); err != nil {
			a.dbError(w, err)
			return
		}
	}
	actor := currentUser(r).ID
	for _, change := range []struct {
		action string
		value  *bool
	}{{"learning.consent", b.Consent}, {"learning.self_learning", b.SelfLearning}} {
		if change.value == nil {
			continue
		}
		action := change.action + "_off"
		if *change.value {
			action = change.action + "_on"
		}
		if err = audit(r.Context(), tx, actor, tid, action, tid); err != nil {
			a.dbError(w, err)
			return
		}
	}
	elsewhere, err := learningElsewhere(r.Context(), tx, tid, actor)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, a.learningView(consent, off, on, elsewhere))
}
