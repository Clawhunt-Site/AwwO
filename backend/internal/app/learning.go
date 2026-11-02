package app

import (
	"context"
	"net/http"
	"time"
)

// A workspace's learning settings (workspace_learning, migration 052; the owner's option A for learning data,
// 2026-10-31), both off until a person turns them on, each change audited, and each offered only where the deployment
// offers it:
//
//   - Help improve AwwO (learning consent). Only the workspace's owner turns it on or off. While it is on, the operator's
//     learning export (operator/learning.go) may take copies of the canvas runs the workspace makes from then on, to
//     evaluate and train models, as ClawHunt's privacy policy says once it does: the deployment offers it only with
//     AWWO_LEARNING_CONSENT=on, set once the policy is live. Off, nothing of the workspace's content is exported; the
//     content-free records every workspace's runs leave (node_outcomes.go) are not under it. The consent is its giver's
//     (consent_by): it holds only while they own the workspace (consentHoldsSQL), and goes with their account, so a
//     workspace an operator hands to another owner is off until its new owner turns it on.
//   - Memory suggestions from runs (run_memory.go). An admin or the owner turns them on: a canvas run worth learning
//     from then has the platform's default model read its record and propose notes for its canvas, which a member
//     accepts or not. Offered only with AWWO_MEMORY_DISTILL=on, and never in the local edition.
//
// Every member sees both, and when each was turned on; one that is on stays shown, and can be turned off, where the
// deployment no longer offers it.

// learningSetting is one of the two, as a workspace's members read it.
type learningSetting struct {
	Offered bool       `json:"offered"`
	On      bool       `json:"on"`
	Since   *time.Time `json:"since"`
}

// consentHoldsSQL is whether workspace_learning row l's consent holds: given, by the workspace's owner as it is now (the
// operator's export reads the same, operator/learning.go).
const consentHoldsSQL = `(l.consent_at IS NOT NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=l.tenant_id AND m.user_id=l.consent_by AND m.role='owner'))`

// learningView is a workspace's two settings, and whether the person has one on in another workspace that they may turn
// off (elsewhere), so that the page keeps the way to it.
func (a *App) learningView(consent, suggestions *time.Time, elsewhere bool) map[string]any {
	return map[string]any{
		"consent":           learningSetting{Offered: a.cfg.LearningConsent, On: consent != nil, Since: consent},
		"memorySuggestions": learningSetting{Offered: a.cfg.MemoryDistill && !a.cfg.UserCredentials, On: suggestions != nil, Since: suggestions},
		"elsewhere":         elsewhere,
	}
}

// learningElsewhere is whether person user has a learning setting on in a workspace other than tid that they may turn
// off: a consent of theirs that holds, or memory suggestions where they are an admin or the owner.
func learningElsewhere(ctx context.Context, q querier, tid, user string) (bool, error) {
	var elsewhere bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_learning l JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=$2
		WHERE l.tenant_id<>$1 AND ((l.consent_at IS NOT NULL AND l.consent_by=$2 AND m.role='owner') OR (l.suggestions_at IS NOT NULL AND m.role IN ('owner','admin'))))`,
		tid, user).Scan(&elsewhere)
	return elsewhere, err
}

func (a *App) learningSettings(w http.ResponseWriter, r *http.Request) {
	var consent, suggestions *time.Time
	err := a.db.QueryRow(r.Context(), `SELECT CASE WHEN `+consentHoldsSQL+` THEN l.consent_at END,l.suggestions_at FROM workspace_learning l WHERE l.tenant_id=$1`,
		r.PathValue("tenantId")).Scan(&consent, &suggestions)
	if err != nil && !noRows(err) {
		a.dbError(w, err)
		return
	}
	elsewhere, err := learningElsewhere(r.Context(), a.db, r.PathValue("tenantId"), currentUser(r).ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, a.learningView(consent, suggestions, elsewhere))
}

// updateLearningSettings turns either setting on or off: the consent by the workspace's owner, the memory suggestions by
// an admin or the owner, each only where the deployment offers it. Turning one on again keeps when it was first turned
// on (a consent that no longer holds, its giver no longer the owner, is given anew); off clears it.
func (a *App) updateLearningSettings(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Consent           *bool `json:"consent"`
		MemorySuggestions *bool `json:"memorySuggestions"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Consent == nil && b.MemorySuggestions == nil {
		fail(w, 400, "invalid_input", "Say which setting to change: consent or memorySuggestions")
		return
	}
	// Turning one on needs the deployment to offer it; turning one off never does, so that one given while it was
	// offered can always be withdrawn.
	consentOffered, suggestionsOffered := a.cfg.LearningConsent, a.cfg.MemoryDistill && !a.cfg.UserCredentials
	if (b.Consent != nil && *b.Consent && !consentOffered) || (b.MemorySuggestions != nil && *b.MemorySuggestions && !suggestionsOffered) {
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
	// The person's role as it stands now (the workspace row is locked first).
	role, ok := a.mutationRole(w, r, tx, tid, 3)
	if !ok {
		return
	}
	if b.Consent != nil && roleLevel(role) < roleLevel("owner") {
		fail(w, 403, "forbidden", "Only the workspace's owner decides whether its content helps improve AwwO")
		return
	}
	var consent, suggestions *time.Time
	// The consent records whose it is; one that no longer holds (its giver no longer the owner) is given anew.
	if err = tx.QueryRow(r.Context(), `INSERT INTO workspace_learning AS l(tenant_id,consent_at,consent_by,suggestions_at)
		VALUES($1,CASE WHEN $2::boolean THEN clock_timestamp() END,CASE WHEN $2::boolean THEN $4 END,CASE WHEN $3::boolean THEN clock_timestamp() END)
		ON CONFLICT (tenant_id) DO UPDATE SET
			consent_at=CASE WHEN $2::boolean IS NULL THEN l.consent_at WHEN NOT $2 THEN NULL
				WHEN l.consent_at IS NOT NULL AND l.consent_by=$4 THEN l.consent_at ELSE clock_timestamp() END,
			consent_by=CASE WHEN $2::boolean IS NULL THEN l.consent_by WHEN NOT $2 THEN NULL ELSE $4 END,
			suggestions_at=CASE WHEN $3::boolean IS NULL THEN l.suggestions_at WHEN $3 THEN COALESCE(l.suggestions_at,clock_timestamp()) END,
			updated_at=clock_timestamp()
		RETURNING CASE WHEN `+consentHoldsSQL+` THEN l.consent_at END,l.suggestions_at`, tid, b.Consent, b.MemorySuggestions, currentUser(r).ID).Scan(&consent, &suggestions); err != nil {
		a.dbError(w, err)
		return
	}
	// Turned off, memory suggestions let go of the workspace's canvas runs still queued for them.
	if b.MemorySuggestions != nil && !*b.MemorySuggestions {
		if _, err = tx.Exec(r.Context(), `UPDATE run_distillations SET state='skipped',reason='suggestions_off',updated_at=clock_timestamp()
			WHERE tenant_id=$1 AND state='queued'`, tid); err != nil {
			a.dbError(w, err)
			return
		}
	}
	actor := currentUser(r).ID
	for _, change := range []struct {
		action string
		value  *bool
	}{{"learning.consent", b.Consent}, {"learning.memory_suggestions", b.MemorySuggestions}} {
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
	writeJSON(w, 200, a.learningView(consent, suggestions, elsewhere))
}
