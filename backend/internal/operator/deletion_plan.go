package operator

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

// The checks of an account deletion (deletion.go): what it would do, and why it cannot be done yet.

type deletionPlan struct {
	account    AccountFacts
	workspaces []WorkspaceOutcome
	blockers   []string
	rows       DeletionRows
	person     string // the account's name, which a first workspace is named after
}

// planDeletion reads what the deletion would do and why it cannot be done yet. Applying, it runs after the locks.
func planDeletion(ctx context.Context, tx pgx.Tx, a Account, d Deletion, apply bool) (*deletionPlan, error) {
	p := &deletionPlan{blockers: []string{}, person: a.Name}
	if a.Role != "user" {
		p.block("platform_admin")
	}
	if err := p.readAccount(ctx, tx, a, apply); err != nil {
		return nil, err
	}
	if err := p.checkRequest(ctx, tx, d); err != nil {
		return nil, err
	}
	if err := p.readWorkspaces(ctx, tx, d); err != nil {
		return nil, err
	}
	for i := range p.workspaces {
		if err := p.decide(ctx, tx, &p.workspaces[i], d, apply); err != nil {
			return nil, err
		}
	}
	p.countNewOwners()
	return p, p.countRows(ctx, tx, d)
}
func (p *deletionPlan) block(reason string) { p.blockers = append(p.blockers, reason) }

// Work the API itself still counts as in flight. An API restart settles runs, graphs, renders, model calls and web
// reads; three kinds can stay unsettled all the same, so the API's own bounds apply and an older one holds nothing up:
//   - a TypeSafe evaluation records itself started and settles its audit row (typesafe.go) within its timeout, at most 25 s;
//   - a web read whose settle was lost stays started, and the API stops counting it after two minutes (webread_import.go);
//   - a managed dispatch's send times out after 12 s, and the API calls one sending for over 15 s unknown (openmaus_bridge.go).
const (
	typeSafeStarted = `action='typesafe.evaluation' AND metadata->>'status'='started' AND created_at>clock_timestamp()-interval '2 minutes'`
	webReadStarted  = `status='started' AND created_at>clock_timestamp()-interval '2 minutes'`
	dispatchSending = `status='sending' AND updated_at>clock_timestamp()-interval '1 minute'`
)
const accountFactsSQL = `SELECT COALESCE((SELECT status FROM user_plans WHERE user_id=$1),''),
	EXISTS(SELECT 1 FROM plan_watches WHERE user_id=$1 AND until>clock_timestamp()),
	EXISTS(SELECT 1 FROM runs WHERE actor_id=$1 AND status IN ('queued','running'))
	OR EXISTS(SELECT 1 FROM graph_runs WHERE actor_id=$1 AND status IN ('queued','running'))
	OR EXISTS(SELECT 1 FROM render_jobs WHERE actor_id=$1 AND status IN ('queued','running'))
	OR EXISTS(SELECT 1 FROM web_reads WHERE actor_id=$1 AND ` + webReadStarted + `)
	OR EXISTS(SELECT 1 FROM openmaus_dispatches WHERE actor_id=$1 AND ` + dispatchSending + `)
	OR EXISTS(SELECT 1 FROM model_invocations WHERE billed_user_id=$1 AND status='running')
	OR EXISTS(SELECT 1 FROM audit_events WHERE actor_id=$1 AND ` + typeSafeStarted + `),
	(SELECT count(*) FROM auth_sessions WHERE user_id=$1),
	(SELECT count(*) FROM user_connections WHERE user_id=$1),
	(SELECT count(*) FROM relay_keys WHERE user_id=$1),
	(SELECT count(*) FROM account_deletion_requests WHERE user_id=$1),
	COALESCE((SELECT id FROM account_deletion_requests WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1),''),
	COALESCE((SELECT status FROM account_deletion_requests WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1),''),
	COALESCE((SELECT status FROM user_plans WHERE user_id=$1),'') IN ` + livePlanStatuses

func (p *deletionPlan) readAccount(ctx context.Context, tx pgx.Tx, a Account, apply bool) error {
	// A plan sync or a checkout updates these rows without touching users, so the account's lock does not hold them:
	// applying, they are locked first, and a change waits for the commit (and then finds the rows gone).
	if apply {
		if _, err := tx.Exec(ctx, "SELECT 1 FROM user_plans WHERE user_id=$1 FOR UPDATE", a.ID); err != nil {
			return ErrDatabase
		}
		if _, err := tx.Exec(ctx, "SELECT 1 FROM plan_watches WHERE user_id=$1 FOR UPDATE", a.ID); err != nil {
			return ErrDatabase
		}
	}
	f := &p.account
	var live bool
	if err := tx.QueryRow(ctx, accountFactsSQL, a.ID).Scan(&f.PlanStatus, &f.PlanWatchOpen, &f.ActiveWork, &f.Sessions, &f.Connections, &f.RelayKeys, &f.DeletionRequests, &f.LatestRequestID, &f.LatestRequestStatus, &live); err != nil {
		return ErrDatabase
	}
	f.IdentityLinks = len(a.Identities)
	if live {
		p.block("paid_plan_live")
	}
	if f.PlanWatchOpen {
		p.block("plan_checkout_open")
	}
	if f.ActiveWork {
		p.block("active_work")
	}
	return nil
}

// checkRequest binds the deletion to the person's pending request, when one is named. Applying, DeleteAccount locked it
// with the account's other requests, before the account, as a withdrawal takes them: a withdrawal either went before
// (and refuses) or waits, and then finds no pending request of the account. Without one (a request sent by email), the
// account's own latest request must not say otherwise: a pending one is to be named, so that it is then marked handled;
// one withdrawn or declined means the person changed their mind or was told no, unless the operator names it as
// superseded by the later request (Supersedes).
func (p *deletionPlan) checkRequest(ctx context.Context, tx pgx.Tx, d Deletion) error {
	if d.RequestID == "" {
		latest, status := p.account.LatestRequestID, p.account.LatestRequestStatus
		superseded := (status == "withdrawn" || status == "declined") && d.Supersedes == latest
		switch {
		case status == "pending":
			p.block("deletion_request_not_named:" + latest)
		case (status == "withdrawn" || status == "declined") && !superseded:
			p.block("deletion_request_" + status + ":" + latest)
		}
		if d.Supersedes != "" && !superseded {
			p.block("deletion_request_not_superseded:" + d.Supersedes)
		}
		return nil
	}
	var status, owner string
	err := tx.QueryRow(ctx, "SELECT status,COALESCE(user_id,'') FROM account_deletion_requests WHERE id=$1", d.RequestID).Scan(&status, &owner)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		p.block("deletion_request_not_found")
	case err != nil:
		return ErrDatabase
	case owner != d.UserID:
		p.block("deletion_request_other_account")
	case status != "pending":
		p.block("deletion_request_not_pending")
	}
	return nil
}

// Anything still running in a workspace, by anyone: runs, graphs, renders, edits, web reads, managed dispatches, model
// calls, TypeSafe evaluations.
const workspaceBusySQL = `(EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=t.id AND r.status IN ('queued','running'))
	OR EXISTS(SELECT 1 FROM graph_runs g WHERE g.tenant_id=t.id AND g.status IN ('queued','running'))
	OR EXISTS(SELECT 1 FROM render_jobs j WHERE j.tenant_id=t.id AND j.status IN ('queued','running'))
	OR EXISTS(SELECT 1 FROM edit_jobs e WHERE e.tenant_id=t.id AND e.status IN ('queued','running'))
	OR EXISTS(SELECT 1 FROM web_reads w WHERE w.tenant_id=t.id AND ` + webReadStarted + `)
	OR EXISTS(SELECT 1 FROM openmaus_dispatches o WHERE o.tenant_id=t.id AND ` + dispatchSending + `)
	OR EXISTS(SELECT 1 FROM model_invocations i WHERE i.tenant_id=t.id AND i.status='running')
	OR EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=t.id AND ` + typeSafeStarted + `))`

// Every workspace the person belongs to, has runs, graph rows or invitations in (a member removed earlier keeps them), or
// that the operator named, with the person's rows there.
const workspacesSQL = `WITH touched AS (
	SELECT tenant_id FROM memberships WHERE user_id=$1
	UNION SELECT tenant_id FROM runs WHERE actor_id=$1
	UNION SELECT tenant_id FROM graph_runs WHERE actor_id=$1
	UNION SELECT tenant_id FROM graph_operation_cancellations WHERE actor_id=$1
	UNION SELECT tenant_id FROM tenant_invites WHERE created_by=$1 OR accepted_by=$1
	UNION SELECT unnest($2::text[])
)
SELECT t.id, t.name, COALESCE(m.role,''), t.requires_plan, ` + workspaceBusySQL + `,
	-- The workspace the account was created with: sign-up writes the account and its workspace in one transaction
	-- (clawhunt_identity.go, auth.go), so both carry the same now(). Memberships are dated only since migration 005,
	-- which gave the older ones its own date.
	COALESCE(m.role='owner' AND t.created_at=(SELECT u.created_at FROM users u WHERE u.id=$1),false),
	(SELECT count(*) FROM memberships o WHERE o.tenant_id=t.id AND o.user_id<>$1),
	(SELECT count(*) FROM memberships o WHERE o.tenant_id=t.id AND o.user_id<>$1 AND o.role='owner'),
	COALESCE((SELECT o.user_id FROM memberships o WHERE o.tenant_id=t.id AND o.user_id<>$1 AND o.role='owner' ORDER BY o.created_at,o.user_id LIMIT 1),''),
	(SELECT count(*) FROM canvases c WHERE c.tenant_id=t.id),
	(SELECT count(*) FROM runs r WHERE r.tenant_id=t.id AND r.actor_id=$1),
	(SELECT count(*) FROM graph_runs g WHERE g.tenant_id=t.id AND g.actor_id=$1),
	(SELECT count(*) FROM graph_operation_cancellations c WHERE c.tenant_id=t.id AND c.actor_id=$1),
	(SELECT count(*) FROM tenant_invites i WHERE i.tenant_id=t.id AND (i.created_by=$1 OR i.accepted_by=$1))
FROM touched x JOIN tenants t ON t.id=x.tenant_id
LEFT JOIN memberships m ON m.tenant_id=t.id AND m.user_id=$1
ORDER BY t.created_at,t.id`

func (p *deletionPlan) readWorkspaces(ctx context.Context, tx pgx.Tx, d Deletion) error {
	rows, err := tx.Query(ctx, workspacesSQL, d.UserID, d.named())
	if err != nil {
		return ErrDatabase
	}
	defer rows.Close()
	found := map[string]bool{}
	for rows.Next() {
		var w WorkspaceOutcome
		if rows.Scan(&w.ID, &w.Name, &w.Role, &w.RequiresPlan, &w.Busy, &w.FirstOfPerson, &w.OtherMembers, &w.otherOwners, &w.Owner, &w.Canvases, &w.Runs, &w.GraphRuns, &w.GraphCancellations, &w.Invitations) != nil {
			return ErrDatabase
		}
		found[w.ID] = true
		p.workspaces = append(p.workspaces, w)
	}
	if rows.Err() != nil {
		return ErrDatabase
	}
	for _, workspace := range d.named() {
		if !found[workspace] {
			p.block("workspace_not_found:" + workspace)
		}
	}
	return nil
}

// decide gives each workspace its outcome. Only a workspace the person alone owns can be handed over or deleted, and it
// must be one of the two; any other is left, and its owner takes the person's graph rows there.
func (p *deletionPlan) decide(ctx context.Context, tx pgx.Tx, w *WorkspaceOutcome, d Deletion, apply bool) error {
	newOwner, transfer := d.Transfers[w.ID]
	remove := d.deletes(w.ID)
	if w.Role != "owner" || w.otherOwners > 0 {
		w.Outcome = "leave"
		if transfer || remove {
			p.block("workspace_not_solely_owned:" + w.ID)
		}
		if w.Owner == "" && w.GraphRuns+w.GraphCancellations > 0 {
			p.block("workspace_without_owner:" + w.ID)
		}
		return nil
	}
	if w.Busy {
		p.block("workspace_busy:" + w.ID)
	}
	switch {
	case remove:
		w.Outcome, w.Owner = "delete", ""
	case transfer:
		w.Outcome, w.Owner = "transfer", newOwner
		// The workspace an account is created with is named after the person ("<name> · AwwO" at a first ClawHunt sign-in,
		// clawhunt_identity.go) or by them at sign-up, and no route renames a workspace: handed over as it is, it could
		// keep showing the person's name to every member. It needs a name given (its own again keeps it, unless it is
		// "<a name> · AwwO" as a first sign-in made it, after the person's name then), as does any workspace named
		// "<name> · AwwO" after the person's present name; a name given may not be that either. Only a name that differs
		// renames it.
		name, given := d.Renames[w.ID]
		if given && name != w.Name {
			w.RenamedTo, w.Renamed = name, true
		}
		personal := p.person + " · AwwO"
		kept := !w.Renamed
		if name == personal || (kept && (w.Name == personal || (w.FirstOfPerson && (!given || strings.HasSuffix(w.Name, " · AwwO"))))) {
			p.block("workspace_needs_new_name:" + w.ID)
		}
		return p.checkNewOwner(ctx, tx, w, apply)
	default:
		w.Outcome, w.Owner = "undecided", ""
		p.block("workspace_undecided:" + w.ID)
	}
	return nil
}

// checkNewOwner reads, and when applying locks, the membership of the member who takes a workspace over.
func (p *deletionPlan) checkNewOwner(ctx context.Context, tx pgx.Tx, w *WorkspaceOutcome, apply bool) error {
	query := `SELECT m.role,u.platform_role='admin',(SELECT count(*) FROM memberships o WHERE o.user_id=m.user_id AND o.role='owner')
	FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2`
	if apply {
		query += " FOR UPDATE OF m"
	}
	err := tx.QueryRow(ctx, query, w.ID, w.Owner).Scan(&w.NewOwnerRoleBefore, &w.NewOwnerIsAdmin, &w.NewOwnerOwnsAfter)
	if errors.Is(err, pgx.ErrNoRows) {
		p.block("transfer_target_not_member:" + w.ID)
		return nil
	}
	if err != nil {
		return ErrDatabase
	}
	return nil
}

// countNewOwners adds to each new owner's workspaces every workspace handed to them here.
func (p *deletionPlan) countNewOwners() {
	handed := map[string]int64{}
	for _, w := range p.workspaces {
		if w.Outcome == "transfer" {
			handed[w.Owner]++
		}
	}
	for i := range p.workspaces {
		if w := &p.workspaces[i]; w.Outcome == "transfer" && w.NewOwnerRoleBefore != "" {
			w.NewOwnerOwnsAfter += handed[w.Owner]
		}
	}
}

// countRows totals what the steps below change, from the plan and three counts the workspaces do not carry.
func (p *deletionPlan) countRows(ctx context.Context, tx pgx.Tx, d Deletion) error {
	r := &p.rows
	for _, w := range p.workspaces {
		switch w.Outcome {
		case "delete":
			r.WorkspacesDeleted++
			r.CanvasesDeleted += w.Canvases
			r.MembershipsDeleted += w.OtherMembers + 1
		case "transfer":
			r.WorkspacesTransferred++
		}
		if w.Outcome != "delete" {
			r.RunsUnnamed += w.Runs
			r.GraphRunsReassigned += w.GraphRuns
			r.GraphCancellationsReassigned += w.GraphCancellations
			r.InvitationsDeleted += w.Invitations
			if w.Role != "" {
				r.MembershipsDeleted++
			}
		}
	}
	// A deleted workspace's invitations go with it, whoever sent them.
	var invites int64
	err := tx.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM audit_events WHERE tenant_id = ANY($2)),
		(SELECT count(*) FROM tenant_invites WHERE tenant_id = ANY($2)),
		(SELECT count(*) FROM knowledge_source_origins WHERE tenant_id = ANY($2)),
		(SELECT count(*) FROM audit_events WHERE actor_id=$1)`, d.UserID, d.Deletes).Scan(&r.AuditEventsDetached, &invites, &r.KnowledgeOriginsDeleted, &r.AuditEventsUnnamed)
	if err != nil {
		return ErrDatabase
	}
	r.InvitationsDeleted += invites
	r.UsersDeleted = 1
	return nil
}
