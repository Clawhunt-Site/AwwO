package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// People sharing a canvas (migration 059): invitations bound to
// an email and sent from a canvas, who deletes a canvas, who stops a run, who holds agent tokens and AwwO 本地版 keys,
// whose emails a member sees, and leaving a workspace.

// joinAs registers email and has the owner add the account to tid with role (the tests run without ClawHunt, so a
// registered email is added directly).
func joinAs(t *testing.T, h *harness, owner *http.Cookie, tid, email, role string) (*http.Cookie, string) {
	t.Helper()
	c, _, uid := h.register(t, email)
	h.request(t, owner, "POST", "/tenants/"+tid+"/members", map[string]string{"email": email, "role": role}, 201)
	return c, uid
}

func countRows(t *testing.T, h *harness, sql string, args ...any) int {
	t.Helper()
	var n int
	if e := h.db.QueryRow(context.Background(), sql, args...).Scan(&n); e != nil {
		t.Fatal(sql, e)
	}
	return n
}

func TestPostgresBoundInvitationsGoToTheirOwnAccount(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "bound-owner@example.test")
	invitee, _, inviteeID := h.register(t, "bound-invitee@example.test")
	stranger, _, strangerID := h.register(t, "bound-stranger@example.test")
	third, _, _ := h.register(t, "bound-third@example.test")
	p := "/tenants/" + tid
	// An email that is not one address is refused before anything is written.
	for _, email := range []string{"not-an-email", "two@example.test, three@example.test", "a@", strings.Repeat("x", 250) + "@example.test"} {
		requireCode(t, h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "member", "email": email}, 400), "invalid_input")
	}
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE tenant_id=$1", tid); n != 0 {
		t.Fatal("a refused invitation was kept", n)
	}
	// It is kept as one address in lower case.
	made := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "member", "email": "  Bound-Invitee@Example.TEST "}, 201)
	if made["email"] != "bound-invitee@example.test" {
		t.Fatalf("bound email: %v", made)
	}
	token, id := made["token"].(string), made["id"].(string)
	// It is kept under a hash of its own kind: an API from before AWWO-LAW-030, which looks the plain hash up, finds no
	// invitation (a rollback answers not found, and lets no other account take it).
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE token_hash=$1", tokenHash(token)); n != 0 {
		t.Fatal("a bound invitation under the plain hash", n)
	}
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE id=$1 AND token_hash=$2", id, inviteTokenHash(token, true)); n != 1 {
		t.Fatal("a bound invitation not under its own hash", n)
	}
	// Whoever holds the link sees whose it is, masked, and whether it is theirs.
	preview := h.request(t, stranger, "GET", "/invites/"+token, nil, 200)
	if preview["email"] != "b***@example.test" || preview["emailMatches"] != false || preview["status"] != "active" || strings.Contains(fmt.Sprint(preview), "bound-invitee") {
		t.Fatalf("a preview to another account: %v", preview)
	}
	if h.request(t, invitee, "GET", "/invites/"+token, nil, 200)["emailMatches"] != true {
		t.Fatal("the invitee's own preview")
	}
	// Another account is refused, and the invitation stays for its own person.
	requireCode(t, h.request(t, stranger, "POST", "/invites/"+token+"/accept", nil, 403), "invite_wrong_account")
	if n := countRows(t, h, "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, strangerID); n != 0 {
		t.Fatal("the wrong account joined")
	}
	var acceptedAt *string
	if e := h.db.QueryRow(ctx, "SELECT accepted_at::text FROM tenant_invites WHERE id=$1", id).Scan(&acceptedAt); e != nil || acceptedAt != nil {
		t.Fatal("the refusal used the invitation", e)
	}
	if h.request(t, invitee, "GET", "/invites/"+token, nil, 200)["status"] != "active" {
		t.Fatal("the refused invitation is no longer usable")
	}
	// Its own person joins, once; the link is then used up for everyone else.
	accepted := h.request(t, invitee, "POST", "/invites/"+token+"/accept", nil, 200)
	if accepted["role"] != "member" || accepted["tenantId"] != tid {
		t.Fatalf("accepted: %v", accepted)
	}
	if _, ok := accepted["canvasId"]; ok {
		t.Fatalf("an invitation from no canvas opens none: %v", accepted)
	}
	h.request(t, invitee, "POST", "/invites/"+token+"/accept", nil, 200)
	for _, c := range []*http.Cookie{third, stranger} {
		requireCode(t, h.request(t, c, "POST", "/invites/"+token+"/accept", nil, 409), "invite_used")
	}
	if n := countRows(t, h, "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role='member'", tid, inviteeID); n != 1 {
		t.Fatal("the invitee's membership")
	}
	// The owners' and admins' list carries the bound address.
	listed := false
	for _, raw := range h.request(t, owner, "GET", p+"/invites", nil, 200)["items"].([]any) {
		item := raw.(map[string]any)
		listed = listed || (item["id"] == id && item["email"] == "bound-invitee@example.test" && item["status"] == "accepted")
	}
	if !listed {
		t.Fatal("the list lost the bound email")
	}
	// An expired or revoked one says so to anyone, its own account included.
	for _, kind := range []string{"expired", "revoked"} {
		inv := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "reader", "email": "bound-third@example.test"}, 201)
		if kind == "expired" {
			execSQL(t, h, "UPDATE tenant_invites SET expires_at=now()-interval '1 second' WHERE id=$1", inv["id"])
		} else {
			h.request(t, owner, "DELETE", p+"/invites/"+inv["id"].(string), nil, 204)
		}
		for _, c := range []*http.Cookie{stranger, third} {
			requireCode(t, h.request(t, c, "POST", "/invites/"+inv["token"].(string)+"/accept", nil, 410), "invite_"+kind)
		}
	}
	// An invitation bound to no email goes to whoever accepts it first, as before; its preview names no email.
	open := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "reader"}, 201)
	if open["email"] != nil {
		t.Fatalf("an unbound invitation: %v", open)
	}
	if v := h.request(t, stranger, "GET", "/invites/"+open["token"].(string), nil, 200); v["email"] != nil || v["emailMatches"] != nil {
		t.Fatalf("an unbound preview: %v", v)
	}
	// It is kept under the plain hash, as every invitation was before: an older API still takes it.
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE id=$1 AND token_hash=$2", open["id"], tokenHash(open["token"].(string))); n != 1 {
		t.Fatal("an unbound invitation not under the plain hash", n)
	}
	h.request(t, stranger, "POST", "/invites/"+open["token"].(string)+"/accept", nil, 200)
}

// A ClawHunt account is matched by its email as ClawHunt has it at the moment of acceptance, not by the one a.auth may
// reuse for a minute: changed on ClawHunt since, the old address no longer takes its invitation and the new one does.
// An issuer that cannot be asked refuses, and one that says the sign-in is over ends it; either way the invitation stays.
func TestPostgresABoundInvitationAsksClawHuntForTheEmailNow(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	f := newIdentityFixture(t, h, "moving-invitee@example.invalid", "moving-subject")
	invitee := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	h.request(t, invitee, "GET", "/auth/me", nil, 200)
	f.id.Subject, f.id.Email = "moving-owner-subject", "moving-owner@example.invalid"
	owner := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	tid := h.request(t, owner, "GET", "/auth/me", nil, 200)["tenants"].([]any)[0].(map[string]any)["id"].(string)
	p := "/tenants/" + tid
	before := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "member", "email": "moving-invitee@example.invalid"}, 201)["token"].(string)
	after := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "reader", "email": "moved-invitee@example.invalid"}, 201)["token"].(string)
	// The invitee changes their email on ClawHunt; AwwO still holds the verification it made a moment ago.
	f.id.Subject, f.id.Email = "moving-subject", "moved-invitee@example.invalid"
	if me := h.request(t, invitee, "GET", "/auth/me", nil, 200)["user"].(map[string]any); me["email"] != "moving-invitee@example.invalid" {
		t.Fatalf("the test needs the reused verification: %v", me)
	}
	asked := f.introspections.Load()
	requireCode(t, h.request(t, invitee, "POST", "/invites/"+before+"/accept", nil, 403), "invite_wrong_account")
	if f.introspections.Load() == asked {
		t.Fatal("the acceptance did not ask ClawHunt")
	}
	// ClawHunt cannot be asked: refused, nothing written.
	f.unavailable.Store(true)
	requireCode(t, h.request(t, invitee, "POST", "/invites/"+after+"/accept", nil, 503), "sso_unavailable")
	f.unavailable.Store(false)
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE tenant_id=$1 AND accepted_at IS NOT NULL", tid); n != 0 {
		t.Fatal("a refusal used an invitation", n)
	}
	if accepted := h.request(t, invitee, "POST", "/invites/"+after+"/accept", nil, 200); accepted["tenantId"] != tid || accepted["role"] != "reader" {
		t.Fatalf("the address the account has now did not take its invitation: %v", accepted)
	}
	// ClawHunt says the sign-in is over: it ends here, and the invitation stays.
	last := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "reader", "email": "moved-invitee@example.invalid"}, 201)
	execSQL(t, h, "DELETE FROM memberships WHERE tenant_id=$1 AND role<>'owner'", tid)
	f.active.Store(false)
	h.request(t, invitee, "POST", "/invites/"+last["token"].(string)+"/accept", nil, 401)
	f.active.Store(true)
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL", last["id"]); n != 1 {
		t.Fatal("the ended sign-in used the invitation", n)
	}
}

// A ClawHunt account is matched by its email as ClawHunt sends it now, verified or not (ClawHunt sends most accounts as
// unverified; AWWO-LAW-030), in any case.
func TestPostgresAClawHuntAccountMatchesItsBoundInvitationUnverified(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	f := newIdentityFixture(t, h, "Shared-Invitee@example.invalid", "invitee-subject")
	if f.id.EmailVerified {
		t.Fatal("the fixture must sign the invitee in unverified")
	}
	invitee := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	h.request(t, invitee, "GET", "/auth/me", nil, 200)
	f.id.Subject, f.id.Email = "other-subject", "someone-else@example.invalid"
	other := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	h.request(t, other, "GET", "/auth/me", nil, 200)
	f.id.Subject, f.id.Email = "sharing-owner-subject", "sharing-owner@example.invalid"
	owner := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	tid := h.request(t, owner, "GET", "/auth/me", nil, 200)["tenants"].([]any)[0].(map[string]any)["id"].(string)
	token := h.request(t, owner, "POST", "/tenants/"+tid+"/invites", map[string]any{"role": "member", "email": "shared-invitee@example.invalid"}, 201)["token"].(string)
	f.id.Subject, f.id.Email = "other-subject", "someone-else@example.invalid"
	requireCode(t, h.request(t, other, "POST", "/invites/"+token+"/accept", nil, 403), "invite_wrong_account")
	f.id.Subject, f.id.Email = "invitee-subject", "Shared-Invitee@example.invalid"
	if preview := h.request(t, invitee, "GET", "/invites/"+token, nil, 200); preview["emailMatches"] != true {
		t.Fatalf("the unverified invitee's preview: %v", preview)
	}
	if accepted := h.request(t, invitee, "POST", "/invites/"+token+"/accept", nil, 200); accepted["tenantId"] != tid || accepted["role"] != "member" {
		t.Fatalf("the unverified invitee was not let in: %v", accepted)
	}
}

func TestPostgresAnInvitationOpensTheCanvasItWasSentFrom(t *testing.T) {
	h := newHarness(t, "")
	owner, tid, _ := h.register(t, "canvas-invite-owner@example.test")
	other, otherTid, _ := h.register(t, "canvas-invite-other@example.test")
	invitee, _, _ := h.register(t, "canvas-invite-invitee@example.test")
	late, _, _ := h.register(t, "canvas-invite-late@example.test")
	p := "/tenants/" + tid
	empty := map[string]any{"nodes": []any{}}
	canvas := h.request(t, owner, "POST", p+"/canvases", map[string]any{"name": "Shared plan", "document": empty}, 201)["id"].(string)
	foreign := h.request(t, other, "POST", "/tenants/"+otherTid+"/canvases", map[string]any{"name": "Theirs", "document": empty}, 201)["id"].(string)
	// Another workspace's canvas is not found, as one that does not exist is (AWWO-LAW-001); nothing is kept.
	for _, id := range []string{foreign, "no-such-canvas"} {
		requireCode(t, h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "member", "canvasId": id}, 404), "not_found")
	}
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE tenant_id=$1", tid); n != 0 {
		t.Fatal("a refused invitation was kept", n)
	}
	made := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "member", "canvasId": canvas}, 201)
	if made["canvasId"] != canvas || made["canvasName"] != "Shared plan" || made["email"] != nil {
		t.Fatalf("made: %v", made)
	}
	token := made["token"].(string)
	if preview := h.request(t, invitee, "GET", "/invites/"+token, nil, 200); preview["canvasId"] != canvas || preview["canvasName"] != "Shared plan" {
		t.Fatalf("preview: %v", preview)
	}
	accepted := h.request(t, invitee, "POST", "/invites/"+token+"/accept", nil, 200)
	if accepted["canvasId"] != canvas {
		t.Fatalf("accepted: %v", accepted)
	}
	// Accepted again by its own person, it still opens the canvas; and the canvas is theirs to open now.
	if again := h.request(t, invitee, "POST", "/invites/"+token+"/accept", nil, 200); again["canvasId"] != canvas {
		t.Fatalf("accepted again: %v", again)
	}
	h.request(t, invitee, "GET", p+"/canvases/"+canvas, nil, 200)
	listed := h.request(t, owner, "GET", p+"/invites", nil, 200)["items"].([]any)
	if item := listed[0].(map[string]any); item["canvasId"] != canvas || item["canvasName"] != "Shared plan" {
		t.Fatalf("listed: %v", item)
	}
	// Deleting the canvas clears it from its invitations, which stay usable.
	second := h.request(t, owner, "POST", p+"/invites", map[string]any{"role": "reader", "canvasId": canvas}, 201)
	h.request(t, owner, "DELETE", p+"/canvases/"+canvas, nil, 204)
	preview := h.request(t, late, "GET", "/invites/"+second["token"].(string), nil, 200)
	if _, ok := preview["canvasId"]; ok || preview["status"] != "active" {
		t.Fatalf("an invitation whose canvas went: %v", preview)
	}
	accepted = h.request(t, late, "POST", "/invites/"+second["token"].(string)+"/accept", nil, 200)
	if _, ok := accepted["canvasId"]; ok || accepted["role"] != "reader" {
		t.Fatalf("accepted after the canvas went: %v", accepted)
	}
	if n := countRows(t, h, "SELECT count(*) FROM tenant_invites WHERE tenant_id=$1 AND canvas_id IS NULL", tid); n != 2 {
		t.Fatal("the invitations of a deleted canvas", n)
	}
}

func TestPostgresACanvasIsDeletedByItsMakerOrAnOwnerOrAdmin(t *testing.T) {
	h := newHarness(t, "")
	owner, tid, ownerID := h.register(t, "maker-owner@example.test")
	admin, _ := joinAs(t, h, owner, tid, "maker-admin@example.test", "admin")
	maker, makerID := joinAs(t, h, owner, tid, "maker-member@example.test", "member")
	other, _ := joinAs(t, h, owner, tid, "maker-other@example.test", "member")
	p := "/tenants/" + tid
	create := func(c *http.Cookie, name string) string {
		return h.request(t, c, "POST", p+"/canvases", map[string]any{"name": name, "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	}
	mine := create(maker, "Mine")
	// A canvas names its maker, read whole or in the list's summary.
	if v := h.request(t, other, "GET", p+"/canvases/"+mine, nil, 200); v["createdBy"] != makerID {
		t.Fatalf("createdBy: %v", v["createdBy"])
	}
	for _, raw := range h.request(t, other, "GET", p+"/canvases?view=summary", nil, 200)["items"].([]any) {
		if item := raw.(map[string]any); item["id"] == mine && item["createdBy"] != makerID {
			t.Fatalf("summary createdBy: %v", item)
		}
	}
	// Another member may not delete it; its maker may.
	requireCode(t, h.request(t, other, "DELETE", p+"/canvases/"+mine, nil, 403), "canvas_not_yours")
	h.request(t, other, "GET", p+"/canvases/"+mine, nil, 200)
	h.request(t, maker, "DELETE", p+"/canvases/"+mine, nil, 204)
	// An admin and the owner delete anyone's.
	for _, c := range []*http.Cookie{admin, owner} {
		h.request(t, c, "DELETE", p+"/canvases/"+create(maker, "Theirs"), nil, 204)
	}
	// One with no maker recorded (made before migration 059 and never logged, or its maker's account gone) is an owner's
	// or admin's to delete.
	orphan := create(maker, "Orphan")
	execSQL(t, h, "UPDATE canvases SET created_by=NULL WHERE id=$1", orphan)
	requireCode(t, h.request(t, maker, "DELETE", p+"/canvases/"+orphan, nil, 403), "canvas_not_yours")
	h.request(t, admin, "DELETE", p+"/canvases/"+orphan, nil, 204)
	// Another workspace's canvas is not found, whoever asks (AWWO-LAW-001), and stays.
	stranger, strangerTid, _ := h.register(t, "maker-stranger@example.test")
	theirs := create(owner, "The owner's")
	h.request(t, stranger, "DELETE", p+"/canvases/"+theirs, nil, 404)
	h.request(t, owner, "DELETE", "/tenants/"+strangerTid+"/canvases/"+theirs, nil, 404)
	if v := h.request(t, owner, "GET", p+"/canvases/"+theirs, nil, 200); v["createdBy"] != ownerID {
		t.Fatalf("the owner's canvas: %v", v)
	}
}

// seedRun is a run of sid going on, started by actor ("" for none recorded).
func seedRun(t *testing.T, h *harness, tid, sid, actor string) string {
	t.Helper()
	rid := randomID()
	execSQL(t, h, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,actor_id) VALUES($1,$2,$3,$1,'hash','test','running',NULLIF($4,''))", rid, tid, sid, actor)
	return rid
}

func TestPostgresARunIsStoppedByItsStarterOrAnOwnerOrAdmin(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tid, _ := h.register(t, "stop-owner@example.test")
	admin, _ := joinAs(t, h, owner, tid, "stop-admin@example.test", "admin")
	starter, starterID := joinAs(t, h, owner, tid, "stop-starter@example.test", "member")
	other, _ := joinAs(t, h, owner, tid, "stop-other@example.test", "member")
	p := "/tenants/" + tid
	_, _, sid := h.fixture(t, owner, tid)
	status := func(rid string) string {
		var s string
		if e := h.db.QueryRow(context.Background(), "SELECT status FROM runs WHERE id=$1", rid).Scan(&s); e != nil {
			t.Fatal(e)
		}
		return s
	}
	// A run names who started it.
	rid := seedRun(t, h, tid, sid, starterID)
	if by, _ := h.request(t, other, "GET", p+"/runs/"+rid, nil, 200)["startedBy"].(map[string]any); by["id"] != starterID || by["name"] != "Test" {
		t.Fatalf("startedBy: %v", by)
	}
	// Another member may not stop it; its starter may.
	requireCode(t, h.request(t, other, "POST", p+"/runs/"+rid+"/cancel", map[string]any{}, 403), "run_not_yours")
	if status(rid) != "running" {
		t.Fatal("a refused stop stopped the run")
	}
	if v := h.request(t, starter, "POST", p+"/runs/"+rid+"/cancel", map[string]any{}, 200); v["status"] != "cancelled" {
		t.Fatalf("the starter's stop: %v", v)
	}
	// An admin and the owner stop anyone's.
	for _, c := range []*http.Cookie{admin, owner} {
		rid = seedRun(t, h, tid, sid, starterID)
		h.request(t, c, "POST", p+"/runs/"+rid+"/cancel", map[string]any{}, 200)
		if status(rid) != "cancelled" {
			t.Fatal("an admin's or owner's stop")
		}
	}
	// One with no starter recorded is an owner's or admin's to stop.
	rid = seedRun(t, h, tid, sid, "")
	if v := h.request(t, other, "GET", p+"/runs/"+rid, nil, 200); v["startedBy"] != nil {
		t.Fatalf("startedBy of a run with none: %v", v["startedBy"])
	}
	requireCode(t, h.request(t, other, "POST", p+"/runs/"+rid+"/cancel", map[string]any{}, 403), "run_not_yours")
	h.request(t, admin, "POST", p+"/runs/"+rid+"/cancel", map[string]any{}, 200)
	// One that has ended answers as it is, to anyone.
	rid = seedRun(t, h, tid, sid, starterID)
	execSQL(t, h, "UPDATE runs SET status='completed' WHERE id=$1", rid)
	if v := h.request(t, other, "POST", p+"/runs/"+rid+"/cancel", map[string]any{}, 200); v["status"] != "completed" {
		t.Fatalf("an ended run: %v", v)
	}

	// A canvas run, by its id or by its operation.
	cid, doc := graphFixture(t, h, owner, tid)
	base := p + "/canvases/" + cid + "/graph-runs"
	gid, _ := seedUnprojectedGraph(t, h, tid, cid, starterID, doc, map[string]string{"a": "running"})
	if by, _ := h.request(t, other, "GET", base+"/"+gid, nil, 200)["startedBy"].(map[string]any); by["id"] != starterID {
		t.Fatalf("a canvas run's startedBy: %v", by)
	}
	if by, _ := h.request(t, other, "GET", base, nil, 200)["items"].([]any)[0].(map[string]any)["startedBy"].(map[string]any); by["id"] != starterID {
		t.Fatalf("the run list's startedBy: %v", by)
	}
	requireCode(t, h.request(t, other, "POST", base+"/"+gid+"/cancel", map[string]any{}, 403), "run_not_yours")
	requireCode(t, h.request(t, other, "POST", base+"/operations/"+gid+"/cancel", map[string]any{}, 403), "run_not_yours")
	if n := countRows(t, h, "SELECT count(*) FROM graph_operation_cancellations WHERE tenant_id=$1 AND operation_id=$2", tid, gid); n != 0 {
		t.Fatal("a refused stop left a cancellation", n)
	}
	if v := h.request(t, other, "GET", base+"/"+gid, nil, 200); v["status"] != "running" {
		t.Fatalf("a refused stop stopped the canvas run: %v", v["status"])
	}
	h.request(t, starter, "POST", base+"/"+gid+"/cancel", map[string]any{}, 200)
	gid, _ = seedUnprojectedGraph(t, h, tid, cid, starterID, doc, map[string]string{"a": "running"})
	h.request(t, admin, "POST", base+"/operations/"+gid+"/cancel", map[string]any{}, 200)
	// A canvas operation not admitted yet is known only to the page that sent it: its cancellation is kept as asked.
	h.request(t, other, "POST", base+"/operations/not-admitted-yet/cancel", map[string]any{}, 200)

	// A render, too.
	execSQL(t, h, "INSERT INTO render_jobs(id,tenant_id,canvas_id,operation_id,request_hash,status,params,html_sha256,html_bytes,actor_id) VALUES('render-of-starter',$1,$2,'render-op','h','running','{}','x',1,$3)", tid, cid, starterID)
	requireCode(t, h.request(t, other, "POST", p+"/canvases/"+cid+"/renders/render-of-starter/cancel", nil, 403), "run_not_yours")
	if v := h.request(t, starter, "POST", p+"/canvases/"+cid+"/renders/render-of-starter/cancel", nil, 200); v["status"] != "cancelled" {
		t.Fatalf("the starter's render stop: %v", v)
	}
}

// A downgrade that commits while a delete or a stop waits after the middleware is seen by the role read inside the
// write's transaction (AWWO-LAW-003): an admin made a member may no longer delete another's canvas or stop another's run.
func TestPostgresDeleteAndStopRecheckTheRoleInTheirTransaction(t *testing.T) {
	for _, downgraded := range []bool{false, true} {
		t.Run(fmt.Sprintf("downgraded=%t", downgraded), func(t *testing.T) {
			h := newHarness(t, "http://127.0.0.1:1")
			owner, tid, _ := h.register(t, "recheck-owner@example.test")
			admin, adminID := joinAs(t, h, owner, tid, "recheck-admin@example.test", "admin")
			// The run goes on in the fixture's canvas; the canvas to delete is another, with nothing running in it.
			_, _, sid := h.fixture(t, owner, tid)
			rid := seedRun(t, h, tid, sid, "")
			canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "The owner's", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
			type pending struct {
				gate     *requestGate
				response *httptest.ResponseRecorder
				done     chan struct{}
			}
			requests := []pending{}
			for _, op := range []struct {
				id      string
				handler http.HandlerFunc
			}{{canvas, h.a.deleteCanvas}, {rid, h.a.cancelRun}} {
				g := newRequestGate(t)
				req := httptest.NewRequest("POST", "/", nil)
				req.AddCookie(admin)
				req.SetPathValue("tenantId", tid)
				req.SetPathValue("id", op.id)
				p := pending{g, httptest.NewRecorder(), make(chan struct{})}
				requests = append(requests, p)
				handler := h.a.tenant(func(w http.ResponseWriter, r *http.Request) { g.wait(); op.handler(w, r) }, 2)
				go func() { defer close(p.done); handler(p.response, req) }()
				awaitTestSignal(t, g.reached)
			}
			if downgraded {
				h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+adminID, map[string]string{"role": "member"}, 204)
			}
			for _, p := range requests {
				p.gate.open()
			}
			want := []struct {
				status int
				code   string
			}{{204, ""}, {200, ""}}
			if downgraded {
				want = []struct {
					status int
					code   string
				}{{403, "canvas_not_yours"}, {403, "run_not_yours"}}
			}
			for i, p := range requests {
				awaitTestSignal(t, p.done)
				if p.response.Code != want[i].status || !strings.Contains(p.response.Body.String(), want[i].code) {
					t.Errorf("request %d: got %d %s, want %d %s", i, p.response.Code, p.response.Body.String(), want[i].status, want[i].code)
				}
			}
			canvases := countRows(t, h, "SELECT count(*) FROM canvases WHERE id=$1", canvas)
			running := countRows(t, h, "SELECT count(*) FROM runs WHERE id=$1 AND status='running'", rid)
			if downgraded && (canvases != 1 || running != 1) || !downgraded && (canvases != 0 || running != 0) {
				t.Fatalf("canvases=%d running=%d", canvases, running)
			}
		})
	}
}

func TestPostgresOnlyOwnersAndAdminsMakeOrHoldAgentTokensAndRelayKeys(t *testing.T) {
	h, _, owner, tid, _ := relayHarness(t)
	admin, adminID := joinAs(t, h, owner, tid, "keys-admin@example.test", "admin")
	member, memberID := joinAs(t, h, owner, tid, "keys-member@example.test", "member")
	canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Keys", "document": liveCanvasDocument()}, 201)["id"].(string)
	lt := liveTeam{h: h, owner: owner, member: member, tid: tid, cid: canvas, prefix: "/tenants/" + tid + "/canvases/" + canvas, memberID: memberID}
	tokens := lt.prefix + "/agent-tokens"
	// A member makes neither: the owner's plan pays for what they do.
	h.request(t, member, "POST", tokens, map[string]any{"name": "Codex", "scope": "edit", "days": 7}, 403)
	requireCode(t, h.request(t, member, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 403), "forbidden")
	if n := countRows(t, h, "SELECT (SELECT count(*) FROM relay_keys WHERE user_id=$1)+(SELECT count(*) FROM canvas_agent_tokens WHERE created_by=$1)", memberID); n != 0 {
		t.Fatal("a member's key or token was made", n)
	}
	// An admin makes both, and both work.
	token, tokenID := lt.token(t, admin, "Claude Code", "edit")
	key := h.request(t, admin, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)["key"].(string)
	lt.bearer(t, token, "GET", lt.prefix, nil, 200, "")
	if status, _ := sendRelay(t, h, key, "GET", relayModelsRoute, ""); status != 200 {
		t.Fatal("an admin's key", status)
	}
	execSQL(t, h, "INSERT INTO canvas_claims(tenant_id,canvas_id,node_id,participant_id,holder_kind,user_id,token_id,expires_at) VALUES($1,$2,'n1',$3,'agent',$4,$5,clock_timestamp()+interval '1 minute')", tid, canvas, "t_"+tokenID, adminID, tokenID)
	// Made a member, the admin loses both at once, and the token's claims go.
	h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+adminID, map[string]string{"role": "member"}, 204)
	lt.bearer(t, token, "GET", lt.prefix, nil, 401, "")
	if status, body := sendRelay(t, h, key, "GET", relayModelsRoute, ""); status != 401 || !strings.Contains(body, "relay_key_invalid") {
		t.Fatal("a key after its admin became a member", status, body)
	}
	if n := countRows(t, h, "SELECT count(*) FROM canvas_claims WHERE token_id=$1", tokenID); n != 0 {
		t.Fatal("the token's claims stayed", n)
	}
	// A member's key or token left live (one made in the moment before a downgrade, or before migration 059) is refused.
	staleKey, keyHash, keyPrefix := newRelayKey()
	execSQL(t, h, "INSERT INTO relay_keys(id,user_id,tenant_id,key_hash,prefix,name,expires_at) VALUES($1,$2,$3,$4,$5,'Old',clock_timestamp()+interval '1 day')", randomID(), memberID, tid, keyHash, keyPrefix)
	if status, body := sendRelay(t, h, staleKey, "GET", relayModelsRoute, ""); status != 403 || !strings.Contains(body, "relay_key_forbidden") {
		t.Fatal("a member's key", status, body)
	}
	staleID, staleToken, staleHash, stalePrefix := newCanvasAgentToken()
	execSQL(t, h, "INSERT INTO canvas_agent_tokens(id,tenant_id,canvas_id,created_by,name,token_hash,prefix,scope,expires_at) VALUES($1,$2,$3,$4,'Old',$5,$6,'edit',clock_timestamp()+interval '1 day')", staleID, tid, canvas, memberID, staleHash, stalePrefix)
	lt.bearer(t, staleToken, "GET", lt.prefix, nil, 401, "")
	lt.bearer(t, staleToken, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, 401, "")
	// The member made an admin again holds what they make from then on.
	h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+memberID, map[string]string{"role": "admin"}, 204)
	fresh, _ := lt.token(t, member, "Cursor", "read")
	lt.bearer(t, fresh, "GET", lt.prefix, nil, 200, "")
}

func TestPostgresMembersEmailsAreForOwnersAndAdmins(t *testing.T) {
	h := newHarness(t, "")
	owner, tid, _ := h.register(t, "emails-owner@example.test")
	admin, _ := joinAs(t, h, owner, tid, "emails-admin@example.test", "admin")
	member, _ := joinAs(t, h, owner, tid, "emails-member@example.test", "member")
	reader, _ := joinAs(t, h, owner, tid, "emails-reader@example.test", "reader")
	for name, c := range map[string]*http.Cookie{"owner": owner, "admin": admin, "member": member, "reader": reader} {
		listed := h.request(t, c, "GET", "/tenants/"+tid+"/members", nil, 200)
		items := listed["items"].([]any)
		if len(items) != 4 {
			t.Fatalf("%s: %v", name, items)
		}
		raw, _ := json.Marshal(listed)
		manages := name == "owner" || name == "admin"
		if manages != strings.Contains(string(raw), "@example.test") {
			t.Fatalf("%s sees emails: %v (%s)", name, !manages, raw)
		}
		for _, item := range items {
			m := item.(map[string]any)
			if m["name"] != "Test" || m["role"] == nil || m["userId"] == nil {
				t.Fatalf("%s: %v", name, m)
			}
			if _, has := m["email"]; has != manages {
				t.Fatalf("%s: %v", name, m)
			}
		}
	}
}

func TestPostgresAPersonLeavesAWorkspace(t *testing.T) {
	h, _, owner, tid, _ := relayHarness(t)
	admin, adminID := joinAs(t, h, owner, tid, "leave-admin@example.test", "admin")
	member, memberID := joinAs(t, h, owner, tid, "leave-member@example.test", "member")
	stranger, _, _ := h.register(t, "leave-stranger@example.test")
	canvas := h.request(t, admin, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Left behind", "document": liveCanvasDocument()}, 201)["id"].(string)
	lt := liveTeam{h: h, owner: owner, member: member, tid: tid, cid: canvas, prefix: "/tenants/" + tid + "/canvases/" + canvas, memberID: memberID}
	token, _ := lt.token(t, admin, "Claude Code", "edit")
	key := h.request(t, admin, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)["key"].(string)
	leave := "/tenants/" + tid + "/leave"
	// The owner cannot leave; nor can someone who is not in it, who finds no workspace (AWWO-LAW-001).
	requireCode(t, h.request(t, owner, "POST", leave, nil, 409), "owner_cannot_leave")
	h.request(t, stranger, "POST", leave, nil, 404)
	// A member leaves, and is out at once.
	h.request(t, member, "POST", leave, nil, 204)
	h.request(t, member, "GET", "/tenants/"+tid+"/canvases", nil, 404)
	h.request(t, member, "POST", leave, nil, 404)
	// An admin who leaves takes nothing with them and keeps nothing: their key and token end there.
	h.request(t, admin, "POST", leave, nil, 204)
	lt.bearer(t, token, "GET", lt.prefix, nil, 401, "")
	if status, _ := sendRelay(t, h, key, "GET", relayModelsRoute, ""); status != 401 {
		t.Fatal("the key of an admin who left", status)
	}
	if n := countRows(t, h, "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND user_id IN ($2,$3)", tid, adminID, memberID); n != 0 {
		t.Fatal("memberships stayed", n)
	}
	if n := countRows(t, h, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='member.left' AND actor_id IN ($2,$3)", tid, adminID, memberID); n != 2 {
		t.Fatal("the leaving's audit", n)
	}
	// What they made stays the workspace's, with its maker recorded: only the owner or an admin deletes it now.
	if v := h.request(t, owner, "GET", lt.prefix, nil, 200); v["createdBy"] != adminID {
		t.Fatalf("their canvas: %v", v["createdBy"])
	}
	h.request(t, owner, "DELETE", lt.prefix, nil, 204)
	// A suspended workspace can be left too (leaving writes only the person's own membership); its owner still cannot.
	reader, readerID := joinAs(t, h, owner, tid, "leave-reader@example.test", "reader")
	execSQL(t, h, "UPDATE tenants SET status='suspended' WHERE id=$1", tid)
	h.request(t, reader, "POST", leave, nil, 204)
	requireCode(t, h.request(t, owner, "POST", leave, nil, 409), "owner_cannot_leave")
	if n := countRows(t, h, "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, readerID); n != 0 {
		t.Fatal("the reader stayed in the suspended workspace", n)
	}
}

// Leaving takes the account's row first, as a password change does before it revokes the account's keys. Taken last,
// a leave would hold the keys it revoked while its audit row waited on the account's row, and the password change would
// wait on those keys: a deadlock. Here the password change's own statements run in a transaction the test holds, a leave
// comes in while it holds the account's row, and both must finish.
func TestPostgresLeavingWaitsForAPasswordChangeWithoutDeadlock(t *testing.T) {
	h, _, owner, tid, _ := relayHarness(t)
	admin, adminID := joinAs(t, h, owner, tid, "leave-race-admin@example.test", "admin")
	h.request(t, admin, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)
	ctx := context.Background()
	tx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	var pid int
	if e = tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); e != nil {
		t.Fatal(e)
	}
	var old string
	if e = tx.QueryRow(ctx, "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", adminID).Scan(&old); e != nil {
		t.Fatal(e)
	}
	left := make(chan string, 1)
	go func() {
		r, e := http.NewRequest("POST", h.server.URL+"/api/v1/tenants/"+tid+"/leave", nil)
		if e != nil {
			left <- e.Error()
			return
		}
		r.Header.Set("Origin", h.cfg.PublicOrigin)
		r.AddCookie(admin)
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			left <- e.Error()
			return
		}
		resp.Body.Close()
		left <- resp.Status
	}()
	for waited := time.Now(); ; time.Sleep(20 * time.Millisecond) {
		if countRows(t, h, "SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", pid) > 0 {
			break
		}
		if time.Since(waited) > 10*time.Second {
			t.Fatal("the leave never waited on the password change")
		}
	}
	// The rest of the password change: its keys, its tokens, its audit row.
	if _, e = tx.Exec(ctx, revokeRelayKeysSQL, adminID, ""); e != nil {
		t.Fatal("the password change's keys:", e)
	}
	if _, e = revokeCanvasAgentTokens(ctx, tx, adminID, ""); e != nil {
		t.Fatal("the password change's tokens:", e)
	}
	if e = audit(ctx, tx, adminID, "", "auth.password_changed", adminID); e != nil {
		t.Fatal("the password change's audit:", e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal("the password change:", e)
	}
	select {
	case status := <-left:
		if status != "204 No Content" {
			t.Fatal("the leave:", status)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the leave did not finish")
	}
	if n := countRows(t, h, "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, adminID); n != 0 {
		t.Fatal("the admin stayed", n)
	}
}

// Migration 059 on a workspace as it was before it: each canvas takes its maker from its canvas.created audit row, and
// the keys and tokens a member holds are revoked, with their tokens' claims; run again as it is (an operator may run it
// by hand first), it changes nothing more.
func TestPostgresMigration059TakesMakersAndRevokesWhatMembersHeld(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, ownerID := h.register(t, "m059-owner@example.test")
	member, memberID := joinAs(t, h, owner, tid, "m059-member@example.test", "member")
	_, adminID := joinAs(t, h, owner, tid, "m059-admin@example.test", "admin")
	p := "/tenants/" + tid
	byMember := h.request(t, member, "POST", p+"/canvases", map[string]any{"name": "The member's", "document": liveCanvasDocument()}, 201)["id"].(string)
	byOwner := h.request(t, owner, "POST", p+"/canvases", map[string]any{"name": "The owner's", "document": liveCanvasDocument()}, 201)["id"].(string)
	unlogged := randomID()
	execSQL(t, h, "INSERT INTO canvases(id,tenant_id,name) VALUES($1,$2,'Never logged')", unlogged, tid)
	// As before 059: no canvas names its maker, and a member and an admin each hold a live key and token.
	execSQL(t, h, "UPDATE canvases SET created_by=NULL WHERE tenant_id=$1", tid)
	type held struct{ key, token string }
	holds := map[string]held{}
	for i, uid := range []string{memberID, adminID} {
		_, hash, prefix := newRelayKey()
		keyID := randomID()
		execSQL(t, h, "INSERT INTO relay_keys(id,user_id,tenant_id,key_hash,prefix,name,expires_at) VALUES($1,$2,$3,$4,$5,'Laptop',clock_timestamp()+interval '1 day')", keyID, uid, tid, hash, prefix)
		tokenID, _, hashed, tokenPrefix := newCanvasAgentToken()
		execSQL(t, h, "INSERT INTO canvas_agent_tokens(id,tenant_id,canvas_id,created_by,name,token_hash,prefix,scope,expires_at) VALUES($1,$2,$3,$4,'Agent',$5,$6,'edit',clock_timestamp()+interval '1 day')", tokenID, tid, byOwner, uid, hashed, tokenPrefix)
		execSQL(t, h, "INSERT INTO canvas_claims(tenant_id,canvas_id,node_id,participant_id,holder_kind,user_id,token_id,expires_at) VALUES($1,$2,$3,$4,'agent',$5,$6,clock_timestamp()+interval '1 minute')", tid, byOwner, fmt.Sprintf("n%d", i+1), "t_"+tokenID, uid, tokenID)
		holds[uid] = held{keyID, tokenID}
	}
	execSQL(t, h, "DELETE FROM awwo_schema_migration_identities WHERE version=59")
	execSQL(t, h, "DELETE FROM awwo_schema_migrations WHERE version=59")
	if e := Migrate(ctx, h.db); e != nil {
		t.Fatal(e)
	}
	check := func() {
		t.Helper()
		for id, want := range map[string]string{byMember: memberID, byOwner: ownerID, unlogged: ""} {
			if got := countRows(t, h, "SELECT count(*) FROM canvases WHERE id=$1 AND COALESCE(created_by,'')=$2", id, want); got != 1 {
				t.Fatalf("the maker of %s is not %q", id, want)
			}
		}
		revoked := func(table, id string) bool {
			return countRows(t, h, "SELECT count(*) FROM "+table+" WHERE id=$1 AND revoked_at IS NOT NULL", id) == 1
		}
		if !revoked("relay_keys", holds[memberID].key) || !revoked("canvas_agent_tokens", holds[memberID].token) {
			t.Fatal("a member's key or token stayed live")
		}
		if revoked("relay_keys", holds[adminID].key) || revoked("canvas_agent_tokens", holds[adminID].token) {
			t.Fatal("an admin's key or token was revoked")
		}
		if countRows(t, h, "SELECT count(*) FROM canvas_claims WHERE token_id=$1", holds[memberID].token) != 0 ||
			countRows(t, h, "SELECT count(*) FROM canvas_claims WHERE token_id=$1", holds[adminID].token) != 1 {
			t.Fatal("the claims")
		}
	}
	check()
	var before string
	if e := h.db.QueryRow(ctx, "SELECT revoked_at::text FROM relay_keys WHERE id=$1", holds[memberID].key).Scan(&before); e != nil {
		t.Fatal(e)
	}
	sql, e := migrations.ReadFile("migrations/059_people_sharing.sql")
	if e != nil {
		t.Fatal(e)
	}
	for range 2 {
		tx, e := h.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, string(sql)); e != nil {
			t.Fatal("059 run again", e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	}
	check()
	if countRows(t, h, "SELECT count(*) FROM relay_keys WHERE id=$1 AND revoked_at::text=$2", holds[memberID].key, before) != 1 {
		t.Fatal("059 run again revoked the key again")
	}
}

func TestPostgresPeopleSharingIsOfferedOnlyWhenSwitchedOn(t *testing.T) {
	h := newHarness(t, "")
	c, tid, _ := h.register(t, "switch-owner@example.test")
	people := func() any {
		return h.request(t, c, "GET", "/tenants/"+tid+"/capabilities", nil, 200)["multiplayer"].(map[string]any)["people"]
	}
	if people() != false {
		t.Fatal("people sharing offered while switched off")
	}
	h.a.cfg.PeopleSharing = true
	if people() != true {
		t.Fatal("people sharing not offered while switched on")
	}
}

func TestPeopleSharingSwitchIsOnOrOff(t *testing.T) {
	for raw, want := range map[string]bool{"": false, "off": false, "on": true} {
		t.Setenv("AWWO_PEOPLE_SHARING", raw)
		var c Config
		if err := c.capabilityFromEnv(); err != nil || c.PeopleSharing != want {
			t.Fatalf("%q: %v %v", raw, c.PeopleSharing, err)
		}
	}
	t.Setenv("AWWO_PEOPLE_SHARING", "yes")
	var c Config
	if err := c.capabilityFromEnv(); err == nil {
		t.Fatal("an unknown value was taken")
	}
}

func TestInvitationEmailsAreKeptMatchedAndMasked(t *testing.T) {
	for raw, want := range map[string]string{"": "", "  ": "", "Ann@Example.COM": "ann@example.com", " ann@example.com\t": "ann@example.com"} {
		if got, ok := inviteEmail(raw); !ok || got != want {
			t.Fatalf("%q: %q %v", raw, got, ok)
		}
	}
	// No letter outside ASCII is bound: lowering one could make it another address's (Go lowers the Kelvin sign U+212A
	// to k and the dotted capital I U+0130 to i). The letters are built from their code points to keep this file ASCII.
	kelvin, dottedI, eAcute, example := string(rune(0x212A)), string(rune(0x0130)), string(rune(0x00E9)), string([]rune{0x4F8B, 0x5B50})
	for _, raw := range []string{"ann", "ann@", "@example.com", "Ann <ann@example.com>", "a@b, c@d", kelvin + "ate@example.com", "jos" + eAcute + "@example.com", "ann@" + example + ".cn"} {
		if _, ok := inviteEmail(raw); ok {
			t.Fatalf("%q taken as an address", raw)
		}
	}
	if !inviteEmailMatches("ann@example.com", User{Email: " Ann@Example.com "}) || inviteEmailMatches("ann@example.com", User{Email: "anne@example.com"}) ||
		inviteEmailMatches("", User{Email: ""}) || inviteEmailMatches("kate@example.com", User{Email: kelvin + "ate@example.com"}) ||
		inviteEmailMatches("ian@example.com", User{Email: dottedI + "an@example.com"}) {
		t.Fatal("matching")
	}
	if strings.ToLower(kelvin+"ate@example.com") != "kate@example.com" {
		t.Fatal("the test no longer shows what strings.ToLower would let through")
	}
	for email, want := range map[string]string{"ann@example.com": "a***@example.com", "zo@x.io": "z***@x.io", "z@x.io": "***@x.io", "bad": "***"} {
		if got := maskedEmail(email); got != want {
			t.Fatalf("%q: %q", email, got)
		}
	}
}
