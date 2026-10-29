package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

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

func (a *App) marketPayoutList(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	switch status {
	case "", "pending", "sent", "held", "failed":
	default:
		fail(w, 400, "invalid_input", "Unknown payout status")
		return
	}
	items, err := rowsJSON(r.Context(), a.db, `SELECT jsonb_build_object('id',p.id,'author',jsonb_build_object('id',p.author_user_id,'email',COALESCE(u.email,''),'name',COALESCE(u.name,'')),
		'amountCents',p.amount_cents,'status',p.status,'attempts',p.attempts,'lastError',p.last_error,'clawHuntTransaction',p.clawhunt_transaction,
		'createdAt',p.created_at,'sentAt',p.sent_at,'nextAttemptAt',p.next_attempt_at)
		FROM market_payouts p LEFT JOIN users u ON u.id=p.author_user_id WHERE ($1='' OR p.status=$1) ORDER BY p.created_at DESC, p.id DESC LIMIT 200`, status)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if items == nil {
		items = []json.RawMessage{}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}
