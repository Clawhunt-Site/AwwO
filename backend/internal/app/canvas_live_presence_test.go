package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// The live lane of 多人同屏 against PostgreSQL (docs/awwo-canvas-live-collaboration.md): what a page shows of an edit in
// progress and who may show it, what it says it runs in, the colours, the pace, and how long a session is trusted for
// presence posts.

// presenceStatus posts a presence update and gives the answer's status and error code.
func (lt liveTeam) presenceStatus(t *testing.T, who *http.Cookie, clientID string, state map[string]any) (int, string) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"clientId": clientID, "state": state})
	r, _ := http.NewRequest("POST", lt.h.server.URL+"/api/v1"+lt.prefix+"/live/presence", bytes.NewReader(raw))
	r.Header.Set("Origin", lt.h.cfg.PublicOrigin)
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(who)
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &out)
	return resp.StatusCode, out.Error.Code
}

// nextOf waits for the presence event that tells of one participant, and gives that participant.
func (l *liveEvents) nextOf(t *testing.T, id string) map[string]any {
	t.Helper()
	for {
		if p, ok := l.next(t, "presence")["participant"].(map[string]any); ok && p["id"] == id {
			return p
		}
	}
}

func (lt liveTeam) addPerson(t *testing.T, email, role string) (*http.Cookie, string) {
	t.Helper()
	cookie, _, id := lt.h.register(t, email)
	lt.h.request(t, lt.owner, "POST", "/tenants/"+lt.tid+"/members", map[string]string{"email": email, "role": role}, 201)
	return cookie, id
}

func TestPostgresCanvasLivePresenceShowsEditsInProgress(t *testing.T) {
	lt := newLiveTeam(t)
	reader, _ := lt.addPerson(t, "live-reader@example.test", "reader")
	owner := lt.openLive(t, lt.owner, "", "after=1&client=owner-page-1&device=browser")
	hello := owner.next(t, "hello")
	if fmt.Sprint(hello["presenceParts"]) != "[selection focus cursor status preview editing viewport]" || hello["you"].(map[string]any)["device"] != "browser" {
		t.Fatalf("hello: %v", hello)
	}
	ownerColor := hello["you"].(map[string]any)["color"]
	member := lt.openLive(t, lt.member, "", "after=1&client=member-page-1&device=phone")
	member.next(t, "hello")
	came := owner.nextOf(t, "member-page-1")
	if came["device"] != "phone" || came["role"] != "member" || came["color"] == ownerColor {
		t.Fatalf("the member as the owner sees them: %v", came)
	}
	// A member's edit in progress and the field they type in reach the others.
	status, _ := lt.presenceStatus(t, lt.member, "member-page-1", map[string]any{
		"preview":  map[string]any{"nodes": []any{map[string]any{"id": "n1", "x": 5, "y": 6}}},
		"editing":  map[string]any{"node": "n1", "field": "title"},
		"viewport": map[string]any{"x": 0, "y": 0, "w": 390, "h": 700},
	})
	if status != 204 {
		t.Fatalf("the member's presence: %d", status)
	}
	state := owner.nextOf(t, "member-page-1")["state"].(map[string]any)
	if fmt.Sprint(state["preview"]) != "map[nodes:[map[id:n1 x:5 y:6]]]" || fmt.Sprint(state["editing"]) != "map[field:title node:n1]" || state["viewport"] == nil {
		t.Fatalf("the member's state: %v", state)
	}
	// A reader is on the canvas and seen, pointer and all, but shows no edit in progress and no editing mark: the server
	// drops them.
	readerLive := lt.openLive(t, reader, "", "after=1&client=reader-page-1&device=tablet")
	readerLive.next(t, "hello")
	if p := owner.nextOf(t, "reader-page-1"); p["role"] != "reader" || p["device"] != "tablet" {
		t.Fatalf("the reader: %v", p)
	}
	status, _ = lt.presenceStatus(t, reader, "reader-page-1", map[string]any{
		"cursor":  map[string]any{"x": 1, "y": 2},
		"preview": map[string]any{"nodes": []any{map[string]any{"id": "n1", "x": 500, "y": 600}}},
		"editing": map[string]any{"node": "n1", "field": "title"},
	})
	if status != 204 {
		t.Fatalf("the reader's presence: %d", status)
	}
	state = owner.nextOf(t, "reader-page-1")["state"].(map[string]any)
	if state["cursor"] == nil || state["preview"] != nil || state["editing"] != nil {
		t.Fatalf("the reader's state: %v", state)
	}
	// Nor does an agent's token, whatever its scope.
	token, id := lt.token(t, lt.owner, "Claude Code", "edit")
	lt.bearer(t, token, "POST", lt.prefix+"/live/presence", map[string]any{"clientId": "ignored-id", "state": map[string]any{
		"status":  "Drafting",
		"preview": map[string]any{"nodes": []any{map[string]any{"id": "n2", "x": 1, "y": 1}}},
		"editing": map[string]any{"node": "n2", "field": "persona"},
	}}, 204, "")
	if p, ok := lt.h.a.multiplayer.participant(lt.tid, lt.cid, "t_"+id); !ok || p.State.Preview != nil || p.State.Editing != nil || p.State.Status == nil {
		t.Fatalf("the agent: %+v", p)
	}
	// A malformed part is refused, a reader's too.
	if status, code := lt.presenceStatus(t, reader, "reader-page-1", map[string]any{"preview": map[string]any{"resize": map[string]any{"id": "n1", "x": 0, "y": 0, "w": -5, "h": 9}}}); status != 400 || code != "invalid_input" {
		t.Fatalf("a malformed preview: %d %s", status, code)
	}
	// Made a reader, the member shows as one at their next post (their session's trust ended with the change) and can no
	// longer show an edit in progress: the one from before stays only until its time is up.
	lt.h.request(t, lt.owner, "PATCH", "/tenants/"+lt.tid+"/members/"+lt.memberID, map[string]string{"role": "reader"}, 204)
	if status, _ := lt.presenceStatus(t, lt.member, "member-page-1", map[string]any{"preview": map[string]any{"nodes": []any{map[string]any{"id": "n2", "x": 9, "y": 9}}}}); status != 204 {
		t.Fatalf("after the downgrade: %d", status)
	}
	if p, _ := lt.h.a.multiplayer.participant(lt.tid, lt.cid, "member-page-1"); p.Role != "reader" || p.State.Preview != nil || p.State.Editing != nil {
		// A reader shows no edit in progress and no editing mark: the ones from before go with the role.
		t.Fatalf("the member made a reader: %+v", p)
	}
}

// More than ten presence updates a second are refused (429) rather than dropped unseen, so a page sends its latest again.
func TestPostgresCanvasLivePresenceKeepsItsPace(t *testing.T) {
	stopped := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	lt := newLiveTeam(t, func(a *App) { a.multiplayer.now = func() time.Time { return stopped } })
	live := lt.openLive(t, lt.member, "", "client=member-page-2")
	live.next(t, "hello")
	set, refused := 0, 0
	for i := 0; i < livePresencePerSecond+5; i++ {
		switch status, code := lt.presenceStatus(t, lt.member, "member-page-2", map[string]any{"cursor": map[string]any{"x": i, "y": 0}}); {
		case status == 204:
			set++
		case status == 429 && code == "presence_too_fast":
			refused++
		default:
			t.Fatalf("update %d: %d %s", i, status, code)
		}
	}
	if set != livePresencePerSecond || refused != 5 {
		t.Fatalf("%d set, %d refused", set, refused)
	}
}

// A person's session, once a presence post checked it, is trusted for presence posts for livePresenceTrust: not past it,
// not after signing out, and not after leaving the workspace or a role change.
func TestPostgresCanvasLivePresenceTrustsASessionForAMoment(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC).UnixNano())
	lt := newLiveTeam(t, func(a *App) { a.livePresence.now = func() time.Time { return time.Unix(0, clock.Load()) } })
	post := func(who *http.Cookie) int {
		status, _ := lt.presenceStatus(t, who, "member-page-3", map[string]any{"status": "here"})
		return status
	}
	if got := post(lt.member); got != 204 {
		t.Fatalf("the first post: %d", got)
	}
	// The session ends where this process does not see it: trusted until its window is over.
	if _, err := lt.h.db.Exec(context.Background(), "DELETE FROM auth_sessions WHERE user_id=$1", lt.memberID); err != nil {
		t.Fatal(err)
	}
	if got := post(lt.member); got != 204 {
		t.Fatalf("within the window: %d", got)
	}
	clock.Add(int64(livePresenceTrust))
	if got := post(lt.member); got != 401 {
		t.Fatalf("past the window: %d", got)
	}
	// Signing out ends it at once.
	session := lt.h.login(t, "live-member@example.test")
	if got := post(session); got != 204 {
		t.Fatalf("signed in again: %d", got)
	}
	lt.h.request(t, session, "POST", "/auth/logout", nil, 204)
	if got := post(session); got != 401 {
		t.Fatalf("after signing out: %d", got)
	}
	// So does changing the password, which ends every session of the person.
	session = lt.h.login(t, "live-member@example.test")
	if got := post(session); got != 204 {
		t.Fatalf("signed in once more: %d", got)
	}
	lt.h.request(t, session, "POST", "/auth/password", map[string]string{"currentPassword": "Strong password 123!", "newPassword": "Another strong password 456!"}, 204)
	if got := post(session); got != 401 {
		t.Fatalf("after the password changed: %d", got)
	}
	// So does leaving the workspace.
	raw, _ := json.Marshal(map[string]string{"email": "live-member@example.test", "password": "Another strong password 456!"})
	req, _ := http.NewRequest("POST", lt.h.server.URL+"/api/v1/auth/login", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("sign in with the new password: %v %v", err, resp)
	}
	resp.Body.Close()
	session = resp.Cookies()[0]
	if got := post(session); got != 204 {
		t.Fatalf("signed in with the new password: %d", got)
	}
	lt.h.request(t, session, "POST", "/tenants/"+lt.tid+"/leave", nil, 204)
	if got := post(session); got != 404 {
		t.Fatalf("after leaving: %d", got)
	}
	// And being removed from it.
	reader, _ := lt.addPerson(t, "live-removed@example.test", "reader")
	removedPost := func() int {
		status, _ := lt.presenceStatus(t, reader, "reader-page-9", map[string]any{"status": "here"})
		return status
	}
	if got := removedPost(); got != 204 {
		t.Fatalf("the reader's first post: %d", got)
	}
	var readerID string
	for _, item := range lt.h.request(t, lt.owner, "GET", "/tenants/"+lt.tid+"/members", nil, 200)["items"].([]any) {
		if m := item.(map[string]any); m["email"] == "live-removed@example.test" {
			readerID = m["id"].(string)
		}
	}
	lt.h.request(t, lt.owner, "DELETE", "/tenants/"+lt.tid+"/members/"+readerID, nil, 204)
	if got := removedPost(); got != 404 {
		t.Fatalf("after being removed: %d", got)
	}
}

// The trust ends too when another device of the person's ends the session, and with any admin update of the workspace
// (once it is committed): the next post is checked in full.
func TestPostgresCanvasLivePresenceTrustEndsFromAnotherDeviceAndTheAdmin(t *testing.T) {
	lt := newLiveTeam(t)
	post := func(who *http.Cookie) int {
		status, _ := lt.presenceStatus(t, who, "member-page-4", map[string]any{"status": "here"})
		return status
	}
	first := lt.h.login(t, "live-member@example.test")
	second := lt.h.login(t, "live-member@example.test")
	if got := post(first); got != 204 {
		t.Fatalf("the first device: %d", got)
	}
	var firstID string
	for _, item := range lt.h.request(t, first, "GET", "/auth/sessions", nil, 200)["items"].([]any) {
		if m := item.(map[string]any); m["current"] == true {
			firstID = m["id"].(string)
		}
	}
	if firstID == "" {
		t.Fatal("no current session listed")
	}
	lt.h.request(t, second, "DELETE", "/auth/sessions/"+firstID, nil, 204)
	if got := post(first); got != 401 {
		t.Fatalf("after another device ended it: %d", got)
	}
	// The second device is trusted now; its session ends where this process does not see it, and an admin update of
	// the workspace (its limits) has every trust in it checked again.
	if got := post(second); got != 204 {
		t.Fatalf("the second device: %d", got)
	}
	if _, err := lt.h.db.Exec(context.Background(), "DELETE FROM auth_sessions WHERE token_hash=$1", tokenHash(second.Value)); err != nil {
		t.Fatal(err)
	}
	if got := post(second); got != 204 {
		t.Fatalf("still trusted before the update: %d", got)
	}
	admin, _, adminID := lt.h.register(t, "live-admin@example.test")
	makeAdmin(t, lt.h, adminID)
	lt.h.request(t, admin, "PATCH", "/admin/tenants/"+lt.tid, map[string]any{"maxRunsPerDay": 7}, 200)
	if got := post(second); got != 401 {
		t.Fatalf("after the workspace's admin update: %d", got)
	}
}

// A person's trust is forgotten once what ended it is committed, never before: a presence check that runs while a change
// of password is still open reads the sessions as they were, and must not be remembered past the commit.
func TestPostgresCanvasLivePresenceForgetsOnceTheChangeIsCommitted(t *testing.T) {
	lt := newLiveTeam(t)
	ctx := context.Background()
	session := lt.h.login(t, "live-owner@example.test")
	_, tokenID := lt.token(t, session, "Probe", "edit")
	post := func() int {
		status, _ := lt.presenceStatus(t, session, "owner-page-7", map[string]any{"status": "here"})
		return status
	}
	if got := post(); got != 204 {
		t.Fatalf("the first post: %d", got)
	}
	// Hold the owner's agent token: the change of password waits on it after it ended the sessions, before its commit.
	hold, err := lt.h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Rollback(ctx)
	if _, err = hold.Exec(ctx, "SELECT 1 FROM canvas_agent_tokens WHERE id=$1 FOR UPDATE", tokenID); err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() {
		raw, _ := json.Marshal(map[string]string{"currentPassword": "Strong password 123!", "newPassword": "Another strong password 456!"})
		req, _ := http.NewRequest("POST", lt.h.server.URL+"/api/v1/auth/password", bytes.NewReader(raw))
		req.Header.Set("Origin", lt.h.cfg.PublicOrigin)
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(session)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		var waiting int
		if err = lt.h.db.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE canvas_agent_tokens%'").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the change of password never reached the held token")
		}
	}
	// While the change is open, a post is answered as before.
	if got := post(); got != 204 {
		t.Fatalf("while the change is open: %d", got)
	}
	if err = hold.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if got := <-done; got != 204 {
		t.Fatalf("the change of password: %d", got)
	}
	if got := post(); got != 401 {
		t.Fatalf("after the change was committed: %d", got)
	}
}
