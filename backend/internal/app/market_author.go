package app

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// An author's side of the market: drafts, review submissions, listing, and what the author has earned. Only the
// author reads a draft's instructions here; administrators read them in the review queue (market_admin.go).

func insertMarketVersion(ctx context.Context, tx pgx.Tx, agentID string, version int, v marketVersion) error {
	skills, _ := json.Marshal(v.Skills)
	examples, _ := json.Marshal(v.Examples)
	_, err := tx.Exec(ctx, `INSERT INTO market_agent_versions(agent_id,version,state,name,tagline,description,category,kind,instructions,instructions_public,
		skills,runtime,model,effort,model_locked,price_credits,examples,content_hash,author_display) VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
		agentID, version, v.Name, v.Tagline, v.Description, v.Category, v.Kind, v.Instructions, v.InstructionsPublic, skills,
		v.Model.Runtime, v.Model.ID, v.Model.Effort, v.Model.Locked, v.Price, examples, v.ContentHash, v.AuthorName)
	return err
}

func updateMarketDraftRow(ctx context.Context, tx pgx.Tx, agentID string, version int, v marketVersion) error {
	skills, _ := json.Marshal(v.Skills)
	examples, _ := json.Marshal(v.Examples)
	_, err := tx.Exec(ctx, `UPDATE market_agent_versions SET name=$3,tagline=$4,description=$5,category=$6,kind=$7,instructions=$8,instructions_public=$9,
		skills=$10,runtime=$11,model=$12,effort=$13,model_locked=$14,price_credits=$15,examples=$16,content_hash=$17,author_display=$18,review_note='',updated_at=clock_timestamp()
		WHERE agent_id=$1 AND version=$2 AND state='draft'`,
		agentID, version, v.Name, v.Tagline, v.Description, v.Category, v.Kind, v.Instructions, v.InstructionsPublic, skills,
		v.Model.Runtime, v.Model.ID, v.Model.Effort, v.Model.Locked, v.Price, examples, v.ContentHash, v.AuthorName)
	return err
}

// marketDraftVersion validates a draft request and freezes its skills for the author. The author's name is part of
// the version, reviewed with it: the one the request gives, or else the account's name if it passes the same checks.
func (a *App) marketDraftVersion(ctx context.Context, tx pgx.Tx, u User, in marketDraftInput) (marketVersion, error) {
	v, author, err := in.validate(a.cfg.MarketMaxPrice)
	if err != nil {
		return v, err
	}
	if author == "" {
		if author, err = marketAuthorName(shortRunes(u.Name, marketMaxAuthorRunes)); err != nil || author == "" {
			return v, marketInvalid("Give an author name: your account's name cannot be shown in the market")
		}
	}
	v.AuthorName = author
	if v.Skills, err = freezeMarketSkills(ctx, tx, u.ID, in.Skills); err != nil {
		return v, err
	}
	v.ContentHash = marketContentHash(v)
	return v, nil
}

func shortRunes(s string, limit int) string {
	if utf8.RuneCountInString(s) <= limit {
		return s
	}
	return string([]rune(s)[:limit])
}

func (a *App) createMarketAgent(w http.ResponseWriter, r *http.Request) {
	var in marketDraftInput
	if !a.decode(w, r, &in) {
		return
	}
	u := currentUser(r)
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	// One author's creations are counted one at a time, so the per-author limit holds under concurrent requests.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('awwo-market-author:' || $1, 84321020))", u.ID); err != nil {
		a.dbError(w, err)
		return
	}
	var owned int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM market_agents WHERE author_user_id=$1", u.ID).Scan(&owned); err != nil {
		a.dbError(w, err)
		return
	}
	if owned >= marketMaxAgentsPerAuthor {
		fail(w, 409, "market_agent_limit", "You have reached the number of Agents an account may publish")
		return
	}
	v, err := a.marketDraftVersion(ctx, tx, u, in)
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	id := randomID()
	// The Agent shows its author's name once a version of it is approved (decideMarketReview).
	if _, err = tx.Exec(ctx, "INSERT INTO market_agents(id,author_user_id,status) VALUES($1,$2,'draft')", id, u.ID); err != nil {
		a.dbError(w, err)
		return
	}
	if err = insertMarketVersion(ctx, tx, id, 1, v); err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, u.ID, "", "market.agent.created", id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	a.replyMarketDraft(w, r, id, 201)
}

// lockAuthoredAgent reads an Agent for its author, holding its row until the transaction ends. Another account's
// Agent answers not found.
func lockAuthoredAgent(ctx context.Context, tx pgx.Tx, id, userID string) (marketAgentRow, error) {
	m, err := scanMarketAgent(tx.QueryRow(ctx, "SELECT "+marketAgentColumns+" FROM market_agents m WHERE m.id=$1 FOR UPDATE", id))
	if noRows(err) || (err == nil && !m.authoredBy(userID)) {
		return m, marketNotFound()
	}
	return m, err
}

func latestMarketVersion(ctx context.Context, q querier, id string) (marketVersion, error) {
	return scanMarketVersion(q.QueryRow(ctx, "SELECT "+marketVersionColumns+" FROM market_agent_versions v WHERE v.agent_id=$1 ORDER BY v.version DESC LIMIT 1", id))
}

func (a *App) updateMarketDraft(w http.ResponseWriter, r *http.Request) {
	var in marketDraftInput
	if !a.decode(w, r, &in) {
		return
	}
	u := currentUser(r)
	ctx := r.Context()
	id := r.PathValue("id")
	tx, err := a.db.Begin(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	m, err := lockAuthoredAgent(ctx, tx, id, u.ID)
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	if m.Status == "suspended" {
		fail(w, 409, "market_agent_suspended", "This Agent was stopped by the platform; it cannot change")
		return
	}
	latest, err := latestMarketVersion(ctx, tx, id)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if latest.State == "pending" {
		fail(w, 409, "market_review_pending", "A version is waiting for review; withdraw it to change it")
		return
	}
	v, err := a.marketDraftVersion(ctx, tx, u, in)
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	if latest.State == "draft" {
		err = updateMarketDraftRow(ctx, tx, id, latest.Version, v)
	} else {
		err = insertMarketVersion(ctx, tx, id, latest.Version+1, v)
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	if _, err = tx.Exec(ctx, "UPDATE market_agents SET updated_at=clock_timestamp() WHERE id=$1", id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, u.ID, "", "market.draft.saved", id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	a.replyMarketDraft(w, r, id, 200)
}

func (a *App) getMarketDraft(w http.ResponseWriter, r *http.Request) {
	a.replyMarketDraft(w, r, r.PathValue("id"), 200)
}

// replyMarketDraft answers the author with the Agent and every field of its latest version.
func (a *App) replyMarketDraft(w http.ResponseWriter, r *http.Request, id string, status int) {
	ctx := r.Context()
	m, err := scanMarketAgent(a.db.QueryRow(ctx, "SELECT "+marketAgentColumns+" FROM market_agents m WHERE m.id=$1", id))
	if noRows(err) || (err == nil && !m.authoredBy(currentUser(r).ID)) {
		a.marketFailure(w, marketNotFound())
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	latest, err := latestMarketVersion(ctx, a.db, id)
	if err != nil {
		a.dbError(w, err)
		return
	}
	// authorName is the name the latest version gives; listedAuthorName the one the market shows now.
	writeJSON(w, status, map[string]any{"id": m.ID, "status": m.Status, "listedVersion": m.ListedVersion, "authorName": latest.AuthorName,
		"listedAuthorName": m.AuthorDisplay, "draft": marketVersionJSON(latest, true)})
}

// marketVersionJSON is a version as its author or an administrator reads it (full) or as a caller sees its
// description (not full: no instructions unless they are public, no skill text).
func marketVersionJSON(v marketVersion, full bool) map[string]any {
	out := map[string]any{"version": v.Version, "state": v.State, "name": v.Name, "tagline": v.Tagline, "description": v.Description,
		"category": v.Category, "kind": v.Kind, "instructionsPublic": v.InstructionsPublic, "model": v.Model, "price": v.Price,
		"examples": v.Examples, "skills": marketSkillsSummary(v.Skills, v.InstructionsPublic, full), "reviewNote": v.ReviewNote,
		"submittedAt": v.SubmittedAt, "reviewedAt": v.ReviewedAt, "createdAt": v.CreatedAt, "updatedAt": v.UpdatedAt}
	if full || v.InstructionsPublic {
		out["instructions"] = v.Instructions
	}
	if full {
		out["authorName"] = v.AuthorName
	}
	return out
}

// marketAuthorAction moves an author's Agent: submit the latest draft for review, withdraw it, unlist the Agent or
// list it again.
func (a *App) marketAuthorAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.decode(w, r, &struct{}{}) {
			return
		}
		u := currentUser(r)
		ctx := r.Context()
		id := r.PathValue("id")
		tx, err := a.db.Begin(ctx)
		if err != nil {
			a.dbError(w, err)
			return
		}
		defer tx.Rollback(ctx)
		m, err := lockAuthoredAgent(ctx, tx, id, u.ID)
		if err != nil {
			a.marketFailure(w, err)
			return
		}
		if m.Status == "suspended" {
			fail(w, 409, "market_agent_suspended", "This Agent was stopped by the platform; it cannot change")
			return
		}
		latest, err := latestMarketVersion(ctx, tx, id)
		if err != nil {
			a.dbError(w, err)
			return
		}
		switch action {
		case "submit":
			if latest.State != "draft" {
				fail(w, 409, "market_no_draft", "There is no draft to submit")
				return
			}
			_, err = tx.Exec(ctx, "UPDATE market_agent_versions SET state='pending',submitted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE agent_id=$1 AND version=$2", id, latest.Version)
		case "withdraw":
			if latest.State != "pending" {
				fail(w, 409, "market_not_pending", "No version is waiting for review")
				return
			}
			_, err = tx.Exec(ctx, "UPDATE market_agent_versions SET state='draft',submitted_at=NULL,updated_at=clock_timestamp() WHERE agent_id=$1 AND version=$2", id, latest.Version)
		case "unlist":
			if m.Status != "listed" {
				fail(w, 409, "market_not_listed", "This Agent is not listed")
				return
			}
			_, err = tx.Exec(ctx, "UPDATE market_agents SET status='unlisted',updated_at=clock_timestamp() WHERE id=$1", id)
		case "list":
			if m.Status != "unlisted" || m.ListedVersion == nil {
				fail(w, 409, "market_not_listable", "Only an unlisted Agent with an approved version can be listed again")
				return
			}
			_, err = tx.Exec(ctx, "UPDATE market_agents SET status='listed',updated_at=clock_timestamp() WHERE id=$1", id)
		}
		if err != nil {
			a.dbError(w, err)
			return
		}
		if err = audit(ctx, tx, u.ID, "", "market.agent."+action, id); err != nil {
			a.dbError(w, err)
			return
		}
		if err = tx.Commit(ctx); err != nil {
			a.dbError(w, err)
			return
		}
		a.replyMarketDraft(w, r, id, 200)
	}
}

// myMarketAgents lists the account's own Agents with their state, their latest version and their ranking figures.
func (a *App) myMarketAgents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := currentUser(r)
	rows, err := a.db.Query(ctx, "SELECT "+marketAgentColumns+" FROM market_agents m WHERE m.author_user_id=$1 ORDER BY m.created_at DESC, m.id", u.ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	agents := []marketAgentRow{}
	for rows.Next() {
		m, err := scanMarketAgent(rows)
		if err != nil {
			rows.Close()
			a.dbError(w, err)
			return
		}
		agents = append(agents, m)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		a.dbError(w, err)
		return
	}
	stats, err := a.marketStatsFor(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	items := []map[string]any{}
	for _, m := range agents {
		latest, err := latestMarketVersion(ctx, a.db, m.ID)
		if err != nil {
			a.dbError(w, err)
			return
		}
		shown := latest
		if m.ListedVersion != nil {
			if shown, err = scanMarketVersion(a.db.QueryRow(ctx, "SELECT "+marketVersionColumns+" FROM market_agent_versions v WHERE v.agent_id=$1 AND v.version=$2", m.ID, *m.ListedVersion)); err != nil {
				a.dbError(w, err)
				return
			}
		}
		item := marketSummary(m, shown, stats[m.ID])
		item["status"], item["listedVersion"] = m.Status, m.ListedVersion
		item["latest"] = marketLatestJSON(latest)
		items = append(items, item)
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// marketEarnings answers what the account has earned as an author, in credits (1 credit = 1 cent): pending is the
// author's share of calls that were charged but whose callers' billing periods have not closed (an upper bound: the
// share of it that callers paid with gifted credits is taken off when the period closes); available is final and on
// no monthly statement yet; inReview is on a statement the platform has not approved yet; transferring is approved
// and on its way to the ClawHunt wallet; paid has arrived there.
func (a *App) marketEarnings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := currentUser(r)
	// One snapshot for every figure, so an earning a statement takes meanwhile is counted once.
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	var pendingMicro, availableMicro, inReview, transferring, paid int64
	err = tx.QueryRow(ctx, `SELECT
		COALESCE(sum(price_credits::bigint*(10000-fee_bps)*100) FILTER (WHERE status='charged' AND settlement='open'),0),
		COALESCE(sum(earned_microcredits) FILTER (WHERE settlement='final' AND payout_id IS NULL),0)
		FROM market_agent_calls WHERE author_user_id=$1`, u.ID).Scan(&pendingMicro, &availableMicro)
	if err != nil {
		a.dbError(w, err)
		return
	}
	// The remainder below a cent not yet on a statement is the latest statement's: each carries the one before it in,
	// and leaves its own.
	var carry int64
	if err = tx.QueryRow(ctx, `SELECT
		COALESCE(sum(amount_cents) FILTER (WHERE status='review'),0),
		COALESCE(sum(amount_cents) FILTER (WHERE status IN ('pending','held')),0),
		COALESCE(sum(amount_cents) FILTER (WHERE status='sent'),0),
		COALESCE((SELECT carry_out_microcredits FROM market_payouts WHERE author_user_id=$1 ORDER BY period_month DESC NULLS LAST, created_at DESC, id DESC LIMIT 1),0)
		FROM market_payouts WHERE author_user_id=$1`, u.ID).Scan(&inReview, &transferring, &paid, &carry); err != nil {
		a.dbError(w, err)
		return
	}
	payouts, err := rowsJSON(ctx, tx, `SELECT jsonb_build_object('id',id,'month',to_char(period_month,'YYYY-MM'),'calls',calls,'credits',credits,
		'amountCents',amount_cents,'status',status,'createdAt',created_at,'sentAt',sent_at)
		FROM market_payouts WHERE author_user_id=$1 ORDER BY period_month DESC NULLS LAST, created_at DESC, id DESC LIMIT 50`, u.ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if payouts == nil {
		payouts = []json.RawMessage{}
	}
	var linked bool
	if a.clawHuntEnabled() {
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM external_identities WHERE user_id=$1 AND issuer=$2)", u.ID, a.cfg.ClawHuntURL).Scan(&linked); err != nil {
			a.dbError(w, err)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"feeBps": a.cfg.MarketFeeBps, "holdDays": a.cfg.MarketHoldDays, "payoutsEnabled": a.cfg.MarketPayouts,
		"clawHuntLinked": linked, "pending": pendingMicro / 1_000_000, "available": (availableMicro + carry) / 1_000_000,
		"inReview": inReview, "transferring": transferring, "paid": paid, "payouts": payouts, "asOf": time.Now().UTC()})
}
