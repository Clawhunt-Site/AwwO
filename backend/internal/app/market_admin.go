package app

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// The platform's side of the market: every version is read in full and approved or rejected before it lists, and an
// Agent can be stopped (suspended), which ends every use of it at once: its running calls are cancelled and given back,
// and market_use.go refuses its next run.

// marketReviewHash identifies everything a reviewer reads of a version: a decision names the hash of what it was made
// on, so a version its author withdrew, changed and submitted again is never approved unread.
func marketReviewHash(v marketVersion) string {
	raw, _ := json.Marshal(struct {
		Name, Tagline, Description, Category, Kind, Instructions string
		InstructionsPublic                                       bool
		Skills                                                   []marketSkill
		Model                                                    marketModel
		Price                                                    int
		Examples                                                 []marketExample
		AuthorName                                               string
	}{v.Name, v.Tagline, v.Description, v.Category, v.Kind, v.Instructions, v.InstructionsPublic, v.Skills, v.Model, v.Price, v.Examples, v.AuthorName})
	return tokenHash(string(raw))
}

func (a *App) marketReviews(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := a.db.Query(ctx, `SELECT `+marketVersionColumns+`,`+marketAgentColumns+`,COALESCE(u.email,''),COALESCE(u.name,'')
		FROM market_agent_versions v JOIN market_agents m ON m.id=v.agent_id LEFT JOIN users u ON u.id=m.author_user_id
		WHERE v.state='pending' ORDER BY v.submitted_at, v.agent_id LIMIT 200`)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var v marketVersion
		var m marketAgentRow
		var skills, examples []byte
		var email, name string
		if err = rows.Scan(&v.AgentID, &v.Version, &v.State, &v.Name, &v.Tagline, &v.Description, &v.Category, &v.Kind, &v.Instructions,
			&v.InstructionsPublic, &skills, &v.Model.Runtime, &v.Model.ID, &v.Model.Effort, &v.Model.Locked, &v.Price, &examples,
			&v.ContentHash, &v.AuthorName, &v.ReviewNote, &v.SubmittedAt, &v.ReviewedAt, &v.CreatedAt, &v.UpdatedAt,
			&m.ID, &m.AuthorUserID, &m.AuthorDisplay, &m.Official, &m.Status, &m.ListedVersion, &m.ListedAt, &m.CreatedAt, &email, &name); err != nil {
			a.dbError(w, err)
			return
		}
		if json.Unmarshal(skills, &v.Skills) != nil || json.Unmarshal(examples, &v.Examples) != nil {
			a.log.Error("market review: a version holds invalid skills or examples", "agent", v.AgentID, "version", v.Version)
			continue
		}
		item := marketVersionJSON(v, true)
		item["agentId"], item["agentStatus"], item["listedVersion"], item["contentHash"] = m.ID, m.Status, m.ListedVersion, v.ContentHash
		item["reviewHash"] = marketReviewHash(v)
		// display is the name this version would show; listedDisplay the one the market shows now.
		item["author"] = map[string]any{"id": m.AuthorUserID, "email": email, "name": name, "display": v.AuthorName, "listedDisplay": m.AuthorDisplay}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// decideMarketReview approves or rejects a pending version, as read: the decision names the version's reviewHash
// (marketReviews), and one that no longer matches is refused (market_review_changed). An approved version lists, under
// the author's name it gives: new callers get it, and the version listed before it is superseded, which nodes already
// pinned to it keep running. An Agent its author unlisted, or the platform suspended, stays so.
func (a *App) decideMarketReview(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Decision   string `json:"decision"`
		Note       string `json:"note"`
		ReviewHash string `json:"reviewHash"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	note, err := marketText("note", b.Note, marketMaxReviewNoteRunes, false, true)
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	if b.Decision != "approve" && b.Decision != "reject" {
		fail(w, 400, "invalid_input", "decision is approve or reject")
		return
	}
	if b.ReviewHash == "" {
		fail(w, 400, "invalid_input", "reviewHash names the version as it was read")
		return
	}
	version, convErr := strconv.Atoi(r.PathValue("version"))
	if convErr != nil || version < 1 {
		a.marketFailure(w, marketNotFound())
		return
	}
	ctx := r.Context()
	id, u := r.PathValue("id"), currentUser(r)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	m, err := scanMarketAgent(tx.QueryRow(ctx, "SELECT "+marketAgentColumns+" FROM market_agents m WHERE m.id=$1 FOR UPDATE", id))
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	pending, err := scanMarketVersion(tx.QueryRow(ctx, "SELECT "+marketVersionColumns+" FROM market_agent_versions v WHERE v.agent_id=$1 AND v.version=$2 FOR UPDATE", id, version))
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	if pending.State != "pending" {
		fail(w, 409, "market_not_pending", "This version is not waiting for review")
		return
	}
	if marketReviewHash(pending) != b.ReviewHash {
		fail(w, 409, "market_review_changed", "This version changed since it was read: read it again before deciding")
		return
	}
	if b.Decision == "reject" {
		_, err = tx.Exec(ctx, "UPDATE market_agent_versions SET state='rejected',review_note=$3,reviewed_at=clock_timestamp(),reviewed_by=$4,updated_at=clock_timestamp() WHERE agent_id=$1 AND version=$2", id, version, note, u.ID)
	} else {
		if m.ListedVersion != nil && *m.ListedVersion != version {
			if _, err = tx.Exec(ctx, "UPDATE market_agent_versions SET state='superseded',updated_at=clock_timestamp() WHERE agent_id=$1 AND version=$2 AND state='approved'", id, *m.ListedVersion); err != nil {
				a.dbError(w, err)
				return
			}
		}
		if _, err = tx.Exec(ctx, "UPDATE market_agent_versions SET state='approved',review_note=$3,reviewed_at=clock_timestamp(),reviewed_by=$4,updated_at=clock_timestamp() WHERE agent_id=$1 AND version=$2", id, version, note, u.ID); err != nil {
			a.dbError(w, err)
			return
		}
		status := "listed"
		if m.Status == "suspended" || m.Status == "unlisted" {
			status = m.Status
		}
		_, err = tx.Exec(ctx, `UPDATE market_agents SET listed_version=$2,status=$3,listed_at=COALESCE(listed_at,clock_timestamp()),
			author_display=(SELECT author_display FROM market_agent_versions WHERE agent_id=$1 AND version=$2),updated_at=clock_timestamp() WHERE id=$1`, id, version, status)
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, u.ID, "", "market.review."+b.Decision, id+":"+strconv.Itoa(version)); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	a.marketStats.forget()
	writeJSON(w, 200, map[string]any{"agentId": id, "version": version, "decision": b.Decision})
}

// setMarketAgentStatus stops an Agent (suspended) or lets it run again as it was before it was stopped: listed, or
// unlisted where its author had unlisted it, when it has an approved version, and back to a draft when it has none.
func (a *App) setMarketAgentStatus(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Status string `json:"status"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Status != "suspended" && b.Status != "listed" {
		fail(w, 400, "invalid_input", "status is suspended or listed")
		return
	}
	ctx := r.Context()
	id, u := r.PathValue("id"), currentUser(r)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	m, err := scanMarketAgent(tx.QueryRow(ctx, "SELECT "+marketAgentColumns+" FROM market_agents m WHERE m.id=$1 FOR UPDATE", id))
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	status := b.Status
	if status == "listed" {
		var before string
		if err = tx.QueryRow(ctx, "SELECT COALESCE(suspended_from,'') FROM market_agents WHERE id=$1", id).Scan(&before); err != nil {
			a.dbError(w, err)
			return
		}
		switch {
		case m.Status != "suspended":
			status = m.Status
		case m.ListedVersion == nil:
			status = "draft"
		case before == "unlisted":
			status = "unlisted"
		}
	}
	// A suspension remembers what it stopped; one already in place keeps what it remembered.
	if _, err = tx.Exec(ctx, `UPDATE market_agents SET status=$2,
		suspended_from=CASE WHEN $2='suspended' THEN CASE WHEN status='suspended' THEN suspended_from ELSE status END ELSE NULL END,
		updated_at=clock_timestamp() WHERE id=$1`, id, status); err != nil {
		a.dbError(w, err)
		return
	}
	stopped, err := stopMarketAgentRuns(ctx, tx, id, status)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, u.ID, "", "market.agent."+status, id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	for _, rid := range stopped {
		a.notifyRunEvent(rid)
		a.cancelExecution(rid)
	}
	a.marketStats.forget()
	writeJSON(w, 200, map[string]any{"agentId": id, "status": status, "runsStopped": len(stopped)})
}

// stopMarketAgentRuns cancels, as a suspension of the Agent, every run of it still queued or running, and gives each its
// fee back (the platform's doing: market_agent_suspended), in the transaction that suspends it, which holds the Agent's
// row first, as an admission takes it after its own. The runs are held in the order of their ids, so that two
// transactions stopping some of the same runs wait for each other rather than deadlock; each run before its call, as
// a run's end settles it. It answers the runs, for their executions to be stopped once it commits. Nothing is
// stopped by any other status.
func stopMarketAgentRuns(ctx context.Context, tx pgx.Tx, agentID, status string) ([]string, error) {
	if status != "suspended" {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `SELECT r.tenant_id,r.id FROM runs r JOIN market_agent_calls c ON c.tenant_id=r.tenant_id AND c.run_id=r.id
		WHERE c.agent_id=$1 AND c.status='reserved' AND r.status IN ('queued','running') ORDER BY r.tenant_id,r.id FOR UPDATE OF r`, agentID)
	if err != nil {
		return nil, err
	}
	type run struct{ tid, rid string }
	runs := []run{}
	for rows.Next() {
		var x run
		if err = rows.Scan(&x.tid, &x.rid); err != nil {
			rows.Close()
			return nil, err
		}
		runs = append(runs, x)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	stopped := []string{}
	for _, x := range runs {
		if _, err = tx.Exec(ctx, "UPDATE runs SET status='cancelled',error='market_agent_suspended',updated_at=now() WHERE tenant_id=$1 AND id=$2", x.tid, x.rid); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", x.tid, x.rid, `{"type":"cancelled","code":"market_agent_suspended"}`); err != nil {
			return nil, err
		}
		if err = settleMarketCall(ctx, tx, x.tid, x.rid, false); err != nil {
			return nil, err
		}
		stopped = append(stopped, x.rid)
	}
	return stopped, nil
}

// marketReviewListCap is the most statements waiting for review that the list answers at once, which is more than
// a month's authors are for a long while.
const marketReviewListCap = 5000

// marketStatementJSON is a statement (a market_payouts row p) as an administrator reviews it: whose, the month, its
// calls and what they were charged, earned and carried in, what it sends, who approved it, how its transfer went, and
// its calls by Agent. It reads users u (the author) and users ap (who approved it).
const marketStatementJSON = `jsonb_build_object('id',p.id,'author',jsonb_build_object('id',p.author_user_id,'email',COALESCE(u.email,''),'name',COALESCE(u.name,'')),
	'month',to_char(p.period_month,'YYYY-MM'),'calls',p.calls,'credits',p.credits,'microcredits',p.microcredits,'carryInMicrocredits',p.carry_in_microcredits,
	'amountCents',p.amount_cents,'status',p.status,'attempts',p.attempts,'lastError',p.last_error,'clawHuntTransaction',p.clawhunt_transaction,
	'createdAt',p.created_at,'approvedAt',p.approved_at,'approvedBy',COALESCE(NULLIF(ap.email,''),p.approved_by,''),'sentAt',p.sent_at,'nextAttemptAt',p.next_attempt_at,
	'agents',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.agent_id,'name',COALESCE(v.name,''),'calls',x.calls,'credits',x.credits,'earnedMicrocredits',x.earned)
		ORDER BY x.calls DESC,x.agent_id) FROM (SELECT c.agent_id,count(*) AS calls,COALESCE(sum(c.price_credits),0) AS credits,
		COALESCE(sum(c.earned_microcredits),0) AS earned,max(c.version) AS version FROM market_agent_calls c WHERE c.payout_id=p.id GROUP BY c.agent_id) x
		LEFT JOIN market_agent_versions v ON v.agent_id=x.agent_id AND v.version=x.version),'[]'::jsonb))`

// marketPayoutList lists the monthly statements: every one waiting for review (up to marketReviewListCap), then the
// latest 200 of the others, and says whether transfers are on: approving one sends it, so with transfers off none can
// be approved.
func (a *App) marketPayoutList(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	switch status {
	case "", "review", "pending", "sent", "held", "failed":
	default:
		fail(w, 400, "invalid_input", "Unknown payout status")
		return
	}
	items, err := rowsJSON(r.Context(), a.db, `SELECT `+marketStatementJSON+`
		FROM market_payouts p LEFT JOIN users u ON u.id=p.author_user_id LEFT JOIN users ap ON ap.id=p.approved_by
		WHERE ($1='' OR p.status=$1) AND (p.status='review' OR p.id IN (SELECT q.id FROM market_payouts q WHERE ($1='' OR q.status=$1) AND q.status<>'review'
			ORDER BY q.period_month DESC NULLS LAST, q.created_at DESC, q.id DESC LIMIT 200))
		ORDER BY (p.status='review') DESC, p.period_month DESC NULLS LAST, p.created_at DESC, p.id DESC LIMIT $2`, status, marketReviewListCap+200)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if items == nil {
		items = []json.RawMessage{}
	}
	writeJSON(w, 200, map[string]any{"items": items, "payoutsEnabled": a.cfg.MarketPayouts})
}

// approveMarketStatement is an administrator's approval of a statement waiting for review, which sends it to the
// author's ClawHunt wallet at once; a send that does not go through is asked again by the settlement job with the same
// reference. The approval names the amount the administrator read (amountCents), and a statement of another amount is
// not approved, so what is sent is what was confirmed. Transfers must be on (AWWO_MARKET_PAYOUTS), so that an approval
// never waits unseen behind a switch that is off. The answer is the statement as it stands after the attempt.
func (a *App) approveMarketStatement(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AmountCents *int64 `json:"amountCents"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.AmountCents == nil || *b.AmountCents < 1 {
		fail(w, 400, "invalid_input", "amountCents is the amount of the statement as it was read")
		return
	}
	if !a.cfg.MarketPayouts {
		fail(w, 409, "market_payouts_off", "Transfers to ClawHunt wallets are off: a statement can be approved once they are on")
		return
	}
	ctx := r.Context()
	id, u := r.PathValue("id"), currentUser(r)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	// The settlement job leaves it alone for a while (next_attempt_at), so the send below is the only one.
	var subject, month string
	var cents int64
	var attempts int
	err = tx.QueryRow(ctx, `UPDATE market_payouts SET status='pending',approved_by=$2,approved_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '5 minutes'
		WHERE id=$1 AND status='review' AND amount_cents=$3 RETURNING subject,COALESCE(to_char(period_month,'YYYY-MM'),''),amount_cents,attempts`, id, u.ID, *b.AmountCents).Scan(&subject, &month, &cents, &attempts)
	if noRows(err) {
		var status string
		var stored int64
		switch err = tx.QueryRow(ctx, "SELECT status,amount_cents FROM market_payouts WHERE id=$1", id).Scan(&status, &stored); {
		case noRows(err):
			fail(w, 404, "not_found", "Statement not found")
		case err != nil:
			a.dbError(w, err)
		case status != "review":
			fail(w, 409, "market_statement_not_in_review", "This statement is not waiting for review any more: read the list again")
		default:
			fail(w, 409, "market_statement_changed", "This statement is not the amount that was approved: read it again")
		}
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, u.ID, "", "market.statement.approved", id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.dbError(w, err)
		return
	}
	// Sent on a context of its own: a reviewer who leaves the page does not cut the transfer short.
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	a.sendMarketPayout(sendCtx, id, subject, month, cents, attempts)
	cancel()
	item, err := rowsJSON(ctx, a.db, `SELECT `+marketStatementJSON+`
		FROM market_payouts p LEFT JOIN users u ON u.id=p.author_user_id LEFT JOIN users ap ON ap.id=p.approved_by WHERE p.id=$1`, id)
	if err != nil || len(item) != 1 {
		a.dbError(w, cmp.Or(err, errors.New("the approved statement was not read back")))
		return
	}
	writeJSON(w, 200, item[0])
}
