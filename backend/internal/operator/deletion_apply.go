package operator

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// The writes of an account deletion (deletion.go), in one transaction, after its checks found nothing to refuse.

// executeDeletion applies a plan without blockers, under the locks planDeletion ran after. A deleted workspace is
// emptied first, so its rows are not counted as work kept; its knowledge and its own row go last, after the account,
// because deleting knowledge origins locks their table against every workspace's writers until the commit.
func executeDeletion(ctx context.Context, tx pgx.Tx, d Deletion, hash string, p *deletionPlan, actor Actor) (DeletionReceipt, error) {
	var rows DeletionRows
	for _, workspace := range d.Deletes {
		if err := clearWorkspace(ctx, tx, workspace, &rows); err != nil {
			return DeletionReceipt{}, err
		}
	}
	for _, w := range p.workspaces {
		if w.Outcome != "transfer" {
			continue
		}
		// The handover dates the new owner's membership now: an owner's plan workspaces are ranked by it (plans.go
		// requiresPlan), so the workspace they take over is their newest and pushes none of theirs out of their plan.
		tag, err := tx.Exec(ctx, "UPDATE memberships SET role='owner',created_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND role<>'owner'", w.ID, w.Owner)
		if err != nil {
			return DeletionReceipt{}, ErrDatabase
		}
		if tag.RowsAffected() != 1 {
			return DeletionReceipt{}, ErrConflict
		}
		if w.RenamedTo != "" {
			if _, err = tx.Exec(ctx, "UPDATE tenants SET name=$2 WHERE id=$1", w.ID, w.RenamedTo); err != nil {
				return DeletionReceipt{}, ErrDatabase
			}
		}
		rows.WorkspacesTransferred++
	}
	if err := unnameWork(ctx, tx, d.UserID, &rows); err != nil {
		return DeletionReceipt{}, err
	}
	if err := removeAccount(ctx, tx, d.UserID, &rows); err != nil {
		return DeletionReceipt{}, err
	}
	for _, workspace := range d.Deletes {
		if err := dropWorkspace(ctx, tx, workspace, &rows); err != nil {
			return DeletionReceipt{}, err
		}
	}
	// The record keeps no workspace names: a first workspace's is the person's own name.
	kept := make([]WorkspaceOutcome, len(p.workspaces))
	for i, w := range p.workspaces {
		w.Name, w.RenamedTo = "", ""
		kept[i] = w
	}
	record := deletionRecord{Version: 1, OperationID: d.OperationID, RequestHash: hash, UserID: d.UserID, Email: d.Email, RequestID: d.RequestID,
		Supersedes: d.Supersedes, Reason: d.Reason, Operator: actor, ToolRevision: Revision(), Account: p.account, Workspaces: kept, Rows: rows}
	id, err := writeDeletionAudit(ctx, tx, record)
	if err != nil {
		return DeletionReceipt{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DeletionReceipt{}, ErrDatabase
	}
	out := newDeletionReceipt(d.UserID, d.OperationID, d.RequestID, d.Supersedes, []string{}, p.account, p.workspaces, rows)
	out.Applied, out.AuditID = true, id
	return out, nil
}
func execRows(ctx context.Context, tx pgx.Tx, n *int64, sql string, args ...any) error {
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return ErrDatabase
	}
	if n != nil {
		*n += tag.RowsAffected()
	}
	return nil
}

// clearWorkspace empties a workspace to delete of what references people or other rows without an ON DELETE action:
// its audit rows lose the workspace, its invitations and memberships go, then its graph runs before its canvases, as a
// canvas deletion's do (resources.go; their nodes point at the canvases' sessions and runs without an ON DELETE action),
// its canvases with their sessions, runs and files' rows, its agents and its managed dispatches.
func clearWorkspace(ctx context.Context, tx pgx.Tx, workspace string, rows *DeletionRows) error {
	steps := []struct {
		n   *int64
		sql string
	}{
		{&rows.AuditEventsDetached, "UPDATE audit_events SET tenant_id=NULL WHERE tenant_id=$1"},
		{&rows.InvitationsDeleted, "DELETE FROM tenant_invites WHERE tenant_id=$1"},
		{&rows.MembershipsDeleted, "DELETE FROM memberships WHERE tenant_id=$1"},
		{nil, "DELETE FROM graph_runs WHERE tenant_id=$1"},
		{&rows.CanvasesDeleted, "DELETE FROM canvases WHERE tenant_id=$1"},
		{nil, "DELETE FROM agents WHERE tenant_id=$1"},
		{nil, "DELETE FROM openmaus_dispatches WHERE tenant_id=$1"},
	}
	for _, s := range steps {
		if err := execRows(ctx, tx, s.n, s.sql, workspace); err != nil {
			return err
		}
	}
	return nil
}

// dropWorkspace deletes a cleared workspace's knowledge, children before parents, and then the workspace, with which the
// rest of its tables cascade.
func dropWorkspace(ctx context.Context, tx pgx.Tx, workspace string, rows *DeletionRows) error {
	for _, sql := range []string{"DELETE FROM knowledge_links WHERE tenant_id=$1", "DELETE FROM knowledge_proposals WHERE tenant_id=$1"} {
		if err := execRows(ctx, tx, nil, sql, workspace); err != nil {
			return err
		}
	}
	if err := deleteKnowledgeOrigins(ctx, tx, workspace, rows); err != nil {
		return err
	}
	for _, sql := range []string{
		// The current-revision key on knowledge_documents is checked at commit, by when both are gone.
		"DELETE FROM knowledge_revisions WHERE tenant_id=$1",
		"DELETE FROM knowledge_documents WHERE tenant_id=$1",
		"DELETE FROM knowledge_operations WHERE tenant_id=$1",
		"DELETE FROM knowledge_events WHERE tenant_id=$1",
	} {
		if err := execRows(ctx, tx, nil, sql, workspace); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, "DELETE FROM tenants WHERE id=$1", workspace)
	if err != nil {
		return ErrDatabase
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	rows.WorkspacesDeleted++
	return nil
}

const originTriggerState = "SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='knowledge_source_origins'::regclass AND tgname='knowledge_source_origin_immutable'"

// How the origins trigger is switched back on, by the state it was in (pg_trigger.tgenabled): on (O) or always on (A).
// Switched off (D), or on only for replication (R), it does not fire in this session, so it is left as it is.
var originTriggerRestore = map[string]string{
	"O": "ALTER TABLE knowledge_source_origins ENABLE TRIGGER knowledge_source_origin_immutable",
	"A": "ALTER TABLE knowledge_source_origins ENABLE ALWAYS TRIGGER knowledge_source_origin_immutable",
}

// deleteKnowledgeOrigins removes a deleted workspace's knowledge source origins. Migration 021's trigger refuses every
// DELETE on that table; it is switched off for this one statement and back to its state in the same transaction. ALTER
// TABLE is transactional and holds a lock on the table that no other writer passes until the commit, so no other session
// can write the table, or see the trigger off, meanwhile; a failure rolls the switch back with everything else. A role
// that does not own the table cannot switch it, and the whole deletion fails without a change.
func deleteKnowledgeOrigins(ctx context.Context, tx pgx.Tx, workspace string, rows *DeletionRows) error {
	var origins int64
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM knowledge_source_origins WHERE tenant_id=$1", workspace).Scan(&origins); err != nil {
		return ErrDatabase
	}
	if origins == 0 {
		return nil
	}
	var before string
	if err := tx.QueryRow(ctx, originTriggerState).Scan(&before); err != nil {
		return ErrDatabase
	}
	restore := originTriggerRestore[before]
	if restore != "" {
		if err := execRows(ctx, tx, nil, "ALTER TABLE knowledge_source_origins DISABLE TRIGGER knowledge_source_origin_immutable"); err != nil {
			return err
		}
	}
	if err := execRows(ctx, tx, &rows.KnowledgeOriginsDeleted, "DELETE FROM knowledge_source_origins WHERE tenant_id=$1", workspace); err != nil {
		return err
	}
	if restore != "" {
		if err := execRows(ctx, tx, nil, restore); err != nil {
			return err
		}
	}
	var after string
	if err := tx.QueryRow(ctx, originTriggerState).Scan(&after); err != nil || after != before {
		return ErrDatabase
	}
	return nil
}

// The owner each workspace has once the person is gone (after any handover), for the graph rows that need an actor.
const ownersSQL = `(SELECT DISTINCT ON (tenant_id) tenant_id,user_id FROM memberships WHERE role='owner' AND user_id<>$1 ORDER BY tenant_id,created_at,user_id)`

// unnameWork keeps the person's work in the workspaces that stay: runs lose their actor, graph rows pass to the owner.
func unnameWork(ctx context.Context, tx pgx.Tx, uid string, rows *DeletionRows) error {
	steps := []struct {
		n   *int64
		sql string
	}{
		{&rows.RunsUnnamed, "UPDATE runs SET actor_id=NULL WHERE actor_id=$1"},
		{&rows.GraphRunsReassigned, "UPDATE graph_runs g SET actor_id=o.user_id FROM " + ownersSQL + " o WHERE g.actor_id=$1 AND g.tenant_id=o.tenant_id"},
		{&rows.GraphCancellationsReassigned, "UPDATE graph_operation_cancellations c SET actor_id=o.user_id FROM " + ownersSQL + " o WHERE c.actor_id=$1 AND c.tenant_id=o.tenant_id"},
	}
	for _, s := range steps {
		if err := execRows(ctx, tx, s.n, s.sql, uid); err != nil {
			return err
		}
	}
	// The plan refused a workspace without an owner, so nothing of theirs is left; if something is, nothing is applied.
	var left int64
	if err := tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM graph_runs WHERE actor_id=$1)+(SELECT count(*) FROM graph_operation_cancellations WHERE actor_id=$1)", uid).Scan(&left); err != nil {
		return ErrDatabase
	}
	if left != 0 {
		return ErrConflict
	}
	return nil
}

// removeAccount deletes what still names the account, keeps its audit rows without it, and deletes the account. Its
// sessions, identity links, keys, settings, plan mirror and the rest cascade; its deletion requests keep their record.
// Its market Agents lose the author's name first, every version's with it, while the account still says whose they are
// (their author goes with the account: ON DELETE SET NULL).
func removeAccount(ctx context.Context, tx pgx.Tx, uid string, rows *DeletionRows) error {
	steps := []struct {
		n   *int64
		sql string
	}{
		{&rows.InvitationsDeleted, "DELETE FROM tenant_invites WHERE created_by=$1 OR accepted_by=$1"},
		{&rows.AuditEventsUnnamed, "UPDATE audit_events SET actor_id=NULL WHERE actor_id=$1"},
		{&rows.MembershipsDeleted, "DELETE FROM memberships WHERE user_id=$1"},
		{&rows.MarketAgentsUnnamed, "UPDATE market_agents SET author_display='',updated_at=clock_timestamp() WHERE author_user_id=$1"},
	}
	for _, s := range steps {
		if err := execRows(ctx, tx, s.n, s.sql, uid); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE market_agent_versions v SET author_display='' FROM market_agents m WHERE m.id=v.agent_id AND m.author_user_id=$1", uid); err != nil {
		return ErrDatabase
	}
	tag, err := tx.Exec(ctx, "DELETE FROM users WHERE id=$1", uid)
	if err != nil {
		return ErrDatabase
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	rows.UsersDeleted = 1
	return nil
}

// writeDeletionAudit records the deletion (no actor: the operator is not an AwwO account), and each handover in the
// handed-over workspace's own log. A handover names the workspace, not the new owner: a role command treats the newest
// admin.% row naming an account as its own (latest), and must not lose an operator grant to a handover.
func writeDeletionAudit(ctx context.Context, tx pgx.Tx, r deletionRecord) (int64, error) {
	data, err := json.Marshal(r)
	if err != nil {
		return 0, ErrInput
	}
	var id int64
	if err = tx.QueryRow(ctx, "INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata) VALUES(NULL,NULL,$1,$2,$3) RETURNING id", deletionAction, r.UserID, data).Scan(&id); err != nil {
		return 0, ErrDatabase
	}
	for _, w := range r.Workspaces {
		if w.Outcome != "transfer" {
			continue
		}
		meta, _ := json.Marshal(map[string]any{"version": 1, "operationId": r.OperationID, "deletionAuditId": id, "previousOwner": r.UserID, "newOwner": w.Owner, "renamed": w.Renamed})
		if _, err = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata) VALUES(NULL,$1,$2,$1,$3)", w.ID, transferAction, meta); err != nil {
			return 0, ErrDatabase
		}
	}
	return id, nil
}
