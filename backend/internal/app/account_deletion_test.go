package app

import (
	"errors"
	"slices"
	"testing"
	"time"

	"awwo/backend/internal/operator"
)

// The operator's account deletion (awwo-control delete-account, internal/operator) against the API it serves: an
// account built through the API, deleted by the tool, and its request then marked handled in the 删除申请 tab.

var rootOperator = operator.Actor{UID: 0, EffectiveUID: 0, Host: "awwo-host"}

func deletionRefusedFor(t *testing.T, err error, blocker string) {
	t.Helper()
	var r *operator.RefusedError
	if !errors.As(err, &r) || !slices.Contains(r.Blockers, blocker) {
		t.Fatalf("wanted the deletion refused for %s, got %v", blocker, err)
	}
}

func (h *harness) rows(t *testing.T, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if e := h.db.QueryRow(t.Context(), sql, args...).Scan(&n); e != nil {
		t.Fatal(sql, e)
	}
	return n
}

func TestPostgresOperatorDeletesASharedAccountAndTheRequestIsHandled(t *testing.T) {
	h := newHarness(t, "")
	ctx := t.Context()
	leaving, own, uid := h.register(t, "leaving@example.test")
	team, teamID, ownerID := h.register(t, "team-owner@example.test")
	helper, _, helperID := h.register(t, "helper@example.test")
	admin, _, adminID := h.register(t, "operator@example.test")
	if _, e := h.db.Exec(ctx, "UPDATE users SET platform_role='admin' WHERE id=$1", adminID); e != nil {
		t.Fatal(e)
	}
	// The person leaving owns two workspaces: their first, which they share with the helper, and a second, alone.
	solo := h.request(t, leaving, "POST", "/tenants", map[string]any{"name": "Solo"}, 201)["id"].(string)
	shared := h.request(t, leaving, "POST", "/tenants/"+own+"/invites", map[string]any{"role": "admin"}, 201)
	h.request(t, helper, "POST", "/invites/"+shared["token"].(string)+"/accept", nil, 200)
	// They belong to the team owner's workspace as an admin, and sent an invitation there nobody accepted.
	joined := h.request(t, team, "POST", "/tenants/"+teamID+"/invites", map[string]any{"role": "admin"}, 201)
	h.request(t, leaving, "POST", "/invites/"+joined["token"].(string)+"/accept", nil, 200)
	unanswered := h.request(t, leaving, "POST", "/tenants/"+teamID+"/invites", map[string]any{"role": "reader"}, 201)
	ownCanvas, _, ownSession := h.fixture(t, leaving, own)
	teamCanvas, _, teamSession := h.fixture(t, leaving, teamID)
	_, _, soloSession := h.fixture(t, leaving, solo)
	// Their runs, as a worker leaves them, and a graph each of them ran in the team; the owner's graph uses their run.
	for _, s := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,actor_id) VALUES
			('del-own-run',$1,$2,'del-own-run','hash','Draft the launch plan','completed','The launch plan',$7),
			('del-team-run',$3,$4,'del-team-run','hash','Write the brief','completed','The brief',$7),
			('del-solo-run',$5,$6,'del-solo-run','hash','Private notes','completed','Notes',$7)`, []any{own, ownSession, teamID, teamSession, solo, soloSession, uid}},
		{`INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES
			('del-m1',$1,$2,'del-team-run','user','Write the brief'),('del-m2',$1,$2,'del-team-run','assistant','The brief')`, []any{teamID, teamSession}},
		{`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES
			('del-graph',$1,$2,$3,'del-graph','hash',1,'{}','["node-a"]','completed'),('del-owner-graph',$1,$2,$4,'del-owner-graph','hash',1,'{}','["node-a"]','completed')`, []any{teamID, teamCanvas, uid, ownerID}},
		{`INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,session_id,run_id) VALUES
			($1,'del-graph','node-a',0,'done',$2,'del-team-run'),($1,'del-owner-graph','node-a',0,'done',$2,'del-team-run')`, []any{teamID, teamSession}},
		{`INSERT INTO graph_operation_cancellations(tenant_id,canvas_id,operation_id,actor_id) VALUES($1,$2,'del-cancelled-op',$3)`, []any{teamID, teamCanvas, uid}},
		// In the workspace handed over, their graph becomes the new owner's (their own membership there is the older one).
		{`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES
			('del-own-graph',$1,$2,$3,'del-own-graph','hash',1,'{}','["node-a"]','completed')`, []any{own, ownCanvas, uid}},
		{`INSERT INTO user_preferences(user_id,preferences) VALUES($1,'{}')`, []any{uid}},
	} {
		if _, e := h.db.Exec(ctx, s.sql, s.args...); e != nil {
			t.Fatal(e)
		}
	}
	request := h.request(t, leaving, "POST", "/auth/deletion-request", map[string]string{"reason": "Please delete my account"}, 201)["request"].(map[string]any)["id"].(string)
	path := "/admin/deletions/" + request
	// "Handled" waits for the account to be gone.
	requireCode(t, h.request(t, admin, "PATCH", path, map[string]string{"status": "handled"}, 409), "deletion_account_exists")

	store := operator.New(h.db)
	d := operator.Deletion{UserID: uid, Email: "leaving@example.test", RequestID: request, Deletes: []string{solo},
		OperationID: "delete-leaving-account-0001", Reason: "The person asked in the deletion tab"}
	// Without a choice for the shared workspace it alone owns, nothing is deleted.
	_, err := store.DeleteAccount(ctx, d, rootOperator, true)
	deletionRefusedFor(t, err, "workspace_undecided:"+own)
	d.Transfers = map[string]string{own: helperID}
	// The workspace they signed up with is found as their first, and is handed over only under a new name.
	preview, err := store.DeleteAccount(ctx, d, rootOperator, false)
	if err != nil || !slices.Equal(preview.Blockers, []string{"workspace_needs_new_name:" + own}) {
		t.Fatal(preview, err)
	}
	for _, w := range preview.Workspaces {
		if (w.ID == own) != w.FirstOfPerson {
			t.Fatal("the first workspace", w)
		}
	}
	// Its own name again keeps it: one the person typed at sign-up (here the default) is no first ClawHunt name.
	d.Renames = map[string]string{own: "Workspace"}
	preview, err = store.DeleteAccount(ctx, d, rootOperator, false)
	if err != nil || len(preview.Blockers) != 0 {
		t.Fatal("its own name again", preview.Blockers, err)
	}
	d.Renames = map[string]string{own: "Launch team"}
	preview, err = store.DeleteAccount(ctx, d, rootOperator, false)
	if err != nil || len(preview.Blockers) != 0 || preview.Applied {
		t.Fatal(preview, err)
	}
	done, err := store.DeleteAccount(ctx, d, rootOperator, true)
	if err != nil || !done.Applied || done.Rows != preview.Rows || done.Rows.UsersDeleted != 1 || done.Rows.WorkspacesDeleted != 1 || done.Rows.WorkspacesTransferred != 1 {
		t.Fatal(done, err)
	}

	// The person is signed out, and nothing of the account is left.
	h.request(t, leaving, "GET", "/auth/me", nil, 401)
	for _, table := range []string{"users WHERE id", "memberships WHERE user_id", "auth_sessions WHERE user_id", "user_preferences WHERE user_id"} {
		if n := h.rows(t, "SELECT count(*) FROM "+table+"=$1", uid); n != 0 {
			t.Error(table, n)
		}
	}
	// The workspace they owned with the helper is the helper's, with its canvas and the person's run, which names nobody.
	if h.rows(t, "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role='owner'", own, helperID) != 1 ||
		h.rows(t, "SELECT count(*) FROM tenants WHERE id=$1 AND name='Launch team'", own) != 1 {
		t.Fatal("the shared workspace has no new owner, or not its new name")
	}
	h.request(t, helper, "GET", "/tenants/"+own+"/canvases/"+ownCanvas, nil, 200)
	if run := h.request(t, helper, "GET", "/tenants/"+own+"/runs/del-own-run", nil, 200); run["output"] != "The launch plan" {
		t.Fatal("the shared workspace lost the person's run", run)
	}
	// The team keeps the brief and its conversation; the person's graph and cancellation are the owner's now.
	if run := h.request(t, team, "GET", "/tenants/"+teamID+"/runs/del-team-run", nil, 200); run["output"] != "The brief" {
		t.Fatal("the team lost the person's run", run)
	}
	for _, c := range []struct {
		sql  string
		arg  any
		want int64
	}{
		{"SELECT count(*) FROM runs WHERE id IN ('del-own-run','del-team-run') AND actor_id IS NULL AND $1::text IS NOT NULL", "", 2},
		{"SELECT count(*) FROM messages WHERE run_id='del-team-run' AND $1::text IS NOT NULL", "", 2},
		{"SELECT count(*) FROM graph_runs WHERE id IN ('del-graph','del-owner-graph') AND actor_id=$1", ownerID, 2},
		{"SELECT count(*) FROM graph_run_nodes WHERE run_id='del-team-run' AND $1::text IS NOT NULL", "", 2},
		{"SELECT count(*) FROM graph_operation_cancellations WHERE operation_id='del-cancelled-op' AND actor_id=$1", ownerID, 1},
		{"SELECT count(*) FROM graph_runs WHERE id='del-own-graph' AND actor_id=$1", helperID, 1},
		{"SELECT count(*) FROM tenants WHERE id=$1", solo, 0},
		{"SELECT count(*) FROM runs WHERE id='del-solo-run' AND $1::text IS NOT NULL", "", 0},
		{"SELECT count(*) FROM audit_events WHERE action='account.deletion_requested' AND resource_id=$1 AND actor_id IS NULL", request, 1},
		{"SELECT count(*) FROM audit_events WHERE action='canvas.created' AND resource_id=$1 AND actor_id IS NULL", teamCanvas, 1},
	} {
		if got := h.rows(t, c.sql, c.arg); got != c.want {
			t.Errorf("%s = %d, want %d", c.sql, got, c.want)
		}
	}
	members := h.request(t, team, "GET", "/tenants/"+teamID+"/members", nil, 200)["items"].([]any)
	invites := h.request(t, team, "GET", "/tenants/"+teamID+"/invites", nil, 200)["items"].([]any)
	if len(members) != 1 || len(invites) != 0 {
		t.Fatal("the team still lists the person or their invitations", members, invites)
	}
	h.request(t, helper, "GET", "/invites/"+unanswered["token"].(string), nil, 404)

	// The operator marks the request handled: it keeps who asked and why, without the account.
	handled := h.request(t, admin, "PATCH", path, map[string]string{"status": "handled", "note": "Deleted with awwo-control"}, 200)
	if handled["status"] != "handled" || handled["userId"] != nil || handled["email"] != "leaving@example.test" || handled["reason"] != "Please delete my account" || handled["decidedBy"] != adminID {
		t.Fatal("the request is not handled", handled)
	}
	if h.rows(t, "SELECT count(*) FROM audit_events WHERE action='account.deletion_handled' AND actor_id=$1 AND resource_id=$2", adminID, request) != 1 ||
		h.rows(t, "SELECT count(*) FROM audit_events WHERE action='admin.operator_account_deleted' AND resource_id=$1 AND id=$2", uid, done.AuditID) != 1 {
		t.Fatal("the deletion is not on record")
	}
	// A second run of the same command answers from the record.
	if again, err := store.DeleteAccount(ctx, d, rootOperator, true); err != nil || !again.Replayed || again.AuditID != done.AuditID {
		t.Fatal(again, err)
	}
}

// ClawHunt bills the plan and AwwO only mirrors it: the deletion waits until the mirror shows the subscription ended.
// The identity link goes with the account, so the same ClawHunt account signing in later gets a new AwwO account.
func TestPostgresDeletedClawHuntAccountSignsInAsANewAccount(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	ctx := t.Context()
	f := newIdentityFixture(t, h, "returning@example.invalid", "subject-returning")
	start, end := time.Now().Add(-time.Hour).Unix(), time.Now().Add(30*24*time.Hour).Unix()
	f.billingBody.Store("plan", clawHuntPlanBody(f, paidPlan("pro", start, end, map[string]int64{"pro": 2000})))
	c := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	me := h.request(t, c, "GET", "/auth/me", nil, 200)
	uid := me["user"].(map[string]any)["id"].(string)
	tid := me["tenants"].([]any)[0].(map[string]any)["id"].(string)
	request := h.request(t, c, "POST", "/auth/deletion-request", map[string]string{"reason": ""}, 201)["request"].(map[string]any)["id"].(string)

	store := operator.New(h.db)
	d := operator.Deletion{UserID: uid, Email: "returning@example.invalid", RequestID: request, Deletes: []string{tid},
		OperationID: "delete-returning-account-01", Reason: "The person asked in the deletion tab"}
	preview, err := store.DeleteAccount(ctx, d, rootOperator, false)
	if err != nil || preview.Account.PlanStatus != "active" || !slices.Equal(preview.Blockers, []string{"paid_plan_live"}) ||
		len(preview.Workspaces) != 1 || !preview.Workspaces[0].FirstOfPerson {
		t.Fatal(preview, err)
	}
	_, err = store.DeleteAccount(ctx, d, rootOperator, true)
	deletionRefusedFor(t, err, "paid_plan_live")
	// Cancelled at ClawHunt: the next read of the plan (here the person's next sign-in) mirrors it.
	f.billingBody.Store("plan", clawHuntPlanBody(f, nil))
	completeIdentity(t, h, f, "")
	done, err := store.DeleteAccount(ctx, d, rootOperator, true)
	if err != nil || !done.Applied || done.Account.PlanStatus != "canceled" || done.Account.IdentityLinks != 1 {
		t.Fatal(done, err)
	}
	h.request(t, c, "GET", "/auth/me", nil, 401)

	// Signing in again with the same ClawHunt account creates a new AwwO account and workspace.
	again := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	fresh := h.request(t, again, "GET", "/auth/me", nil, 200)
	freshID := fresh["user"].(map[string]any)["id"].(string)
	tenants := fresh["tenants"].([]any)
	if freshID == uid || len(tenants) != 1 || tenants[0].(map[string]any)["id"] == tid {
		t.Fatal("the sign-in found the deleted account", fresh)
	}
	if seen := h.request(t, again, "GET", "/auth/deletion-request", nil, 200); seen["request"] != nil {
		t.Fatal("the new account sees the old request", seen)
	}
	if h.rows(t, "SELECT count(*) FROM external_identities WHERE subject='subject-returning' AND user_id=$1", freshID) != 1 ||
		h.rows(t, "SELECT count(*) FROM account_deletion_requests WHERE id=$1 AND user_id IS NULL AND status='pending'", request) != 1 {
		t.Fatal("the identity link or the request is not as it should be")
	}
}
