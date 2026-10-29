package operator

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Account deletion (awwo-control delete-account). The privacy clause has an operator handle every deletion request by
// hand; this deletes one account by its id, in one transaction, and leaves the account's deletion request pending, so
// that the operator then marks it handled in the 删除申请 tab (PATCH /admin/deletions/{id} accepts that only once the
// account is gone).
//
// What goes and what stays (the owner, 2026-10-19: shared work is kept, without the person's name):
//   - Each workspace the person alone owns needs an explicit choice: handed over to one of its members, or deleted with
//     everything in it (its audit rows stay, without the workspace).
//   - In every workspace that stays, the person's runs keep their prompts, outputs and messages, with no actor (NULL, as
//     runs older than migration 007 have); graph runs and graph cancellation records, whose actor is required, are
//     attributed to that workspace's owner. Neither id is shown anywhere: it is read only while a graph runs, and the
//     tool refuses while one does.
//   - The person's invitations, sent and accepted, are deleted: one handed to someone else could come back to life.
//   - Audit rows stay, with no actor, so the record of the request survives.
//   - What the account alone holds goes with its users row: sessions, the ClawHunt identity link, keys, settings, the
//     plan mirror. A later ClawHunt sign-in therefore creates a new account, with a new id and a new workspace.
//   - Where the schema keeps the id as plain text (knowledge, renders, web reads, skills, memory notes, the billing
//     ledger, the Agent market's calls, ratings, payouts and period facts), it stays: it names no account any more, and
//     a new account never gets it, as ids are random.
//   - The person's Agents in the market lose the author's name (the market's and every version's); their author goes
//     with the account, so they list and run no more. Their versions stay: the runs that used them name them.
//
// It refuses while the account's plan is live at ClawHunt (user_plans only mirrors what ClawHunt bills), while a
// checkout or billing portal it opened may still complete, while the person or a workspace to hand over or delete has
// anything running, and for a platform administrator.

const (
	deletionAction = "admin.operator_account_deleted"
	transferAction = "admin.operator_workspace_transferred"
	// A deleted workspace takes its canvases, runs and files' rows with it, and finding one person's runs reads the whole
	// runs table, so statements may take longer than a role change's; locks still fail fast.
	deletionStatementTimeout = "60s"
	maxDispositions          = 50
)

// The statuses ClawHunt counts as a live subscription (its LIVE_STATUSES; billing.go planKnown, plan_sync.go).
const livePlanStatuses = `('active','trialing','past_due','incomplete','unpaid','paused')`

// ErrRefused is returned, as a *RefusedError naming the reasons, when the account cannot be deleted yet.
var ErrRefused = errors.New("account deletion refused")

type RefusedError struct{ Blockers []string }

func (e *RefusedError) Error() string {
	return "account deletion refused: " + strings.Join(e.Blockers, ", ")
}
func (e *RefusedError) Is(target error) bool { return target == ErrRefused }

// Deletion names the account and, for each workspace it alone owns, what happens to it.
type Deletion struct {
	UserID    string `json:"userId"`
	Email     string `json:"expectedEmail"`
	RequestID string `json:"requestId,omitempty"`
	// Without RequestID: the account's latest request, withdrawn or declined, that a later request by email supersedes.
	Supersedes  string            `json:"supersedesRequest,omitempty"`
	Transfers   map[string]string `json:"transferWorkspaces,omitempty"` // workspace id -> the member who becomes its owner
	Renames     map[string]string `json:"renameWorkspaces,omitempty"`   // workspace handed over -> its new name
	Deletes     []string          `json:"deleteWorkspaces,omitempty"`
	OperationID string            `json:"operationId"`
	Reason      string            `json:"reason"`
}

// A workspace's name, as the API accepts one (cleanName: at most 200 bytes), plain text and without the command line's
// list separator. It is shown to every member, so it holds only letters, marks, digits, punctuation, symbols and spaces
// (no format, private-use or unassigned character, line or paragraph separator), no filler or blank Braille cell, and
// starts with something to see: a letter, digit, punctuation mark or symbol (a variation selector or combining mark
// shows nothing by itself, and first it would attach to what the page draws before the name).
func validWorkspaceName(name string) bool {
	first, _ := utf8.DecodeRuneInString(name)
	if !safeText(name, 200) || !utf8.ValidString(name) || strings.Contains(name, ",") ||
		!unicode.In(first, unicode.L, unicode.N, unicode.P, unicode.S) {
		return false
	}
	for _, r := range name {
		if !unicode.In(r, unicode.L, unicode.M, unicode.N, unicode.P, unicode.S, unicode.Zs) || r == '\u2800' ||
			unicode.Is(unicode.Other_Default_Ignorable_Code_Point, r) {
			return false
		}
	}
	return true
}
func (d Deletion) Validate() error {
	if !identifier.MatchString(d.UserID) || !canonicalEmail(d.Email) || !operationID.MatchString(d.OperationID) ||
		!safeText(d.Reason, 1000) || (d.RequestID != "" && !identifier.MatchString(d.RequestID)) ||
		(d.Supersedes != "" && (d.RequestID != "" || !identifier.MatchString(d.Supersedes))) ||
		len(d.Transfers)+len(d.Deletes) > maxDispositions {
		return ErrInput
	}
	named := map[string]bool{}
	for workspace, owner := range d.Transfers {
		if !identifier.MatchString(workspace) || !identifier.MatchString(owner) || owner == d.UserID {
			return ErrInput
		}
		named[workspace] = true
	}
	for _, workspace := range d.Deletes {
		if !identifier.MatchString(workspace) || named[workspace] {
			return ErrInput
		}
		named[workspace] = true
	}
	// Only a workspace handed over is renamed: the others are deleted, or someone else's.
	for workspace, name := range d.Renames {
		if _, handed := d.Transfers[workspace]; !handed || !validWorkspaceName(name) {
			return ErrInput
		}
	}
	return nil
}

// canonical orders the workspaces to delete, so the same request in another order digests the same.
func (d Deletion) canonical() Deletion {
	c := d
	c.Deletes = append([]string(nil), d.Deletes...)
	sort.Strings(c.Deletes)
	if len(c.Deletes) == 0 {
		c.Deletes = nil
	}
	if len(c.Transfers) == 0 {
		c.Transfers = nil
	}
	if len(c.Renames) == 0 {
		c.Renames = nil
	}
	return c
}
func (d Deletion) named() []string {
	out := append([]string(nil), d.Deletes...)
	for workspace := range d.Transfers {
		out = append(out, workspace)
	}
	sort.Strings(out)
	return out
}
func (d Deletion) deletes(workspace string) bool {
	for _, w := range d.Deletes {
		if w == workspace {
			return true
		}
	}
	return false
}

// AccountFacts is what goes with the users row, read before it goes.
type AccountFacts struct {
	PlanStatus       string `json:"planStatus"` // the mirrored plan's status; empty when the account never subscribed
	PlanWatchOpen    bool   `json:"planWatchOpen"`
	ActiveWork       bool   `json:"activeWork"`
	Sessions         int64  `json:"sessions"`
	IdentityLinks    int    `json:"identityLinks"`
	Connections      int64  `json:"connections"`
	RelayKeys        int64  `json:"relayKeys"`        // its AwwO 本地版 connection keys (042), revoked ones too: they go with it
	DeletionRequests int64  `json:"deletionRequests"` // each keeps its email and name, and loses its account (037)
	// The account's latest deletion request, if it made one in 设置 → 数据管理.
	LatestRequestID     string `json:"latestRequestId,omitempty"`
	LatestRequestStatus string `json:"latestRequestStatus,omitempty"`
}

// WorkspaceOutcome is one workspace the person belongs to or has work in.
type WorkspaceOutcome struct {
	ID                 string `json:"id"`
	Name               string `json:"name,omitempty"`      // shown to the operator; never stored in the audit record
	RenamedTo          string `json:"renamedTo,omitempty"` // likewise
	Renamed            bool   `json:"renamed,omitempty"`
	FirstOfPerson      bool   `json:"firstOfPerson,omitempty"` // the workspace the person's account was created with
	Role               string `json:"role"`                    // the person's role there; empty when they are no longer a member
	Outcome            string `json:"outcome"`                 // leave, transfer, delete, or undecided
	Owner              string `json:"ownerAfter,omitempty"`
	NewOwnerRoleBefore string `json:"newOwnerRoleBefore,omitempty"`
	NewOwnerIsAdmin    bool   `json:"newOwnerIsPlatformAdmin,omitempty"`
	NewOwnerOwnsAfter  int64  `json:"newOwnerOwnsAfter,omitempty"` // the workspaces they own once every handover here is made
	RequiresPlan       bool   `json:"requiresPlan,omitempty"`
	Busy               bool   `json:"busy,omitempty"`
	OtherMembers       int64  `json:"otherMembers"`
	Canvases           int64  `json:"canvases"`
	Runs               int64  `json:"personRuns"`
	GraphRuns          int64  `json:"personGraphRuns"`
	GraphCancellations int64  `json:"personGraphCancellations"`
	Invitations        int64  `json:"personInvitations"`
	otherOwners        int64
}

// DeletionRows counts the rows the tool itself changes; the cascades of a deleted canvas, workspace or account are not
// counted. A preview counts what it would change.
type DeletionRows struct {
	WorkspacesTransferred        int64 `json:"workspacesTransferred"`
	WorkspacesDeleted            int64 `json:"workspacesDeleted"`
	CanvasesDeleted              int64 `json:"canvasesDeleted"`
	KnowledgeOriginsDeleted      int64 `json:"knowledgeOriginsDeleted"`
	AuditEventsDetached          int64 `json:"auditEventsDetached"` // a deleted workspace's, kept without the workspace
	RunsUnnamed                  int64 `json:"runsUnnamed"`
	GraphRunsReassigned          int64 `json:"graphRunsReassigned"`
	GraphCancellationsReassigned int64 `json:"graphCancellationsReassigned"`
	InvitationsDeleted           int64 `json:"invitationsDeleted"`
	AuditEventsUnnamed           int64 `json:"auditEventsUnnamed"`
	MarketAgentsUnnamed          int64 `json:"marketAgentsUnnamed"` // the person's market Agents, their versions with them
	MembershipsDeleted           int64 `json:"membershipsDeleted"`
	UsersDeleted                 int64 `json:"usersDeleted"`
}
type DeletionReceipt struct {
	ContractVersion int                `json:"contractVersion"`
	ToolRevision    string             `json:"toolRevision"`
	Applied         bool               `json:"applied"`
	Replayed        bool               `json:"replayed"`
	UserID          string             `json:"userId"`
	OperationID     string             `json:"operationId"`
	Action          string             `json:"action"`
	RequestID       string             `json:"requestId,omitempty"`
	Supersedes      string             `json:"supersedesRequest,omitempty"`
	Blockers        []string           `json:"blockers"`
	Account         AccountFacts       `json:"account"`
	Workspaces      []WorkspaceOutcome `json:"workspaces"`
	Rows            DeletionRows       `json:"rows"`
	AuditID         int64              `json:"auditId"`
}

// deletionRecord is the audit row's metadata, from which a retry with the same operation is answered.
type deletionRecord struct {
	Version      int                `json:"version"`
	OperationID  string             `json:"operationId"`
	RequestHash  string             `json:"requestHash"`
	UserID       string             `json:"userId"`
	Email        string             `json:"expectedEmail"`
	RequestID    string             `json:"requestId,omitempty"`
	Supersedes   string             `json:"supersedesRequest,omitempty"`
	Reason       string             `json:"reason"`
	Operator     Actor              `json:"operator"`
	ToolRevision string             `json:"toolRevision"`
	Account      AccountFacts       `json:"account"`
	Workspaces   []WorkspaceOutcome `json:"workspaces"`
	Rows         DeletionRows       `json:"rows"`
}

func newDeletionReceipt(uid, operation, request, supersedes string, blockers []string, account AccountFacts, workspaces []WorkspaceOutcome, rows DeletionRows) DeletionReceipt {
	if workspaces == nil {
		workspaces = []WorkspaceOutcome{}
	}
	return DeletionReceipt{ContractVersion: 1, ToolRevision: Revision(), UserID: uid, OperationID: operation, Action: deletionAction,
		RequestID: request, Supersedes: supersedes, Blockers: blockers, Account: account, Workspaces: workspaces, Rows: rows}
}

// DeleteAccount previews (apply false, read only) or applies the deletion. A refused apply changes nothing and names
// the reasons; a preview lists them. A retry of an applied operation, with the same arguments, returns its receipt.
func (s *Store) DeleteAccount(ctx context.Context, d Deletion, actor Actor, apply bool) (DeletionReceipt, error) {
	if err := d.Validate(); err != nil {
		return DeletionReceipt{}, err
	}
	if err := checkActor(actor, apply); err != nil {
		return DeletionReceipt{}, err
	}
	d = d.canonical()
	tx, err := s.beginWith(ctx, apply, deletionStatementTimeout)
	if err != nil {
		return DeletionReceipt{}, err
	}
	defer tx.Rollback(ctx)
	hash := digest(d)
	if prior, err := priorDeletion(ctx, tx, d, hash); err != nil || prior != nil {
		if err != nil {
			return DeletionReceipt{}, err
		}
		return *prior, nil
	}
	// Locks in the API's own order. The API locks a workspace before it writes rows naming the person, so the workspaces
	// go first. A withdrawal updates its request and then writes an audit row naming the account (preferences.go), so the
	// account's requests go next, and so do the person's market Agents, which an author's change locks before its audit
	// row names the account (market_author.go). The account goes last: once its row is locked, no new row can reference
	// it through a foreign key (each such write waits on that lock).
	if apply {
		if _, err = tx.Exec(ctx, "SELECT 1 FROM tenants WHERE id = ANY($1) ORDER BY id FOR UPDATE", d.named()); err != nil {
			return DeletionReceipt{}, ErrDatabase
		}
		if _, err = tx.Exec(ctx, "SELECT 1 FROM account_deletion_requests WHERE user_id=$1 OR id=$2 ORDER BY id FOR UPDATE", d.UserID, d.RequestID); err != nil {
			return DeletionReceipt{}, ErrDatabase
		}
		if _, err = tx.Exec(ctx, "SELECT 1 FROM market_agents WHERE author_user_id=$1 ORDER BY id FOR UPDATE", d.UserID); err != nil {
			return DeletionReceipt{}, ErrDatabase
		}
	}
	a, err := account(ctx, tx, d.UserID, "", apply)
	if err != nil {
		return DeletionReceipt{}, err
	}
	if a.Email != d.Email {
		return DeletionReceipt{}, ErrIdentity
	}
	p, err := planDeletion(ctx, tx, a, d, apply)
	if err != nil {
		return DeletionReceipt{}, err
	}
	if !apply {
		return newDeletionReceipt(d.UserID, d.OperationID, d.RequestID, d.Supersedes, p.blockers, p.account, p.workspaces, p.rows), nil
	}
	if len(p.blockers) > 0 {
		return DeletionReceipt{}, &RefusedError{Blockers: p.blockers}
	}
	return executeDeletion(ctx, tx, d, hash, p, actor)
}

// priorDeletion answers a retry: an operation already applied with these arguments returns its receipt, and one used
// for anything else, or for other arguments, is a conflict.
func priorDeletion(ctx context.Context, tx pgx.Tx, d Deletion, hash string) (*DeletionReceipt, error) {
	var id int64
	var action, resource string
	var raw []byte
	err := tx.QueryRow(ctx, "SELECT id,action,resource_id,metadata FROM audit_events WHERE action IN ('admin.operator_grant','admin.operator_rollback','"+deletionAction+"') AND metadata->>'operationId'=$1 ORDER BY id DESC LIMIT 1", d.OperationID).Scan(&id, &action, &resource, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, ErrDatabase
	}
	var r deletionRecord
	if action != deletionAction || json.Unmarshal(raw, &r) != nil || r.Version != 1 || r.RequestHash != hash || r.UserID != resource || resource != d.UserID {
		return nil, ErrConflict
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)", d.UserID).Scan(&exists); err != nil {
		return nil, ErrDatabase
	}
	if exists {
		return nil, ErrConflict
	}
	out := newDeletionReceipt(r.UserID, r.OperationID, r.RequestID, r.Supersedes, []string{}, r.Account, r.Workspaces, r.Rows)
	out.Applied, out.Replayed, out.AuditID = true, true, id
	return &out, nil
}
