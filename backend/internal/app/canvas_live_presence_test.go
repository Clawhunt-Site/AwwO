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

// rest gives a stream's events until it ends, waiting at most `within`, and when it ended (zero: it did not).
func (l *liveEvents) rest(t *testing.T, within time.Duration) ([][2]string, time.Time) {
	t.Helper()
	var events [][2]string
	deadline := time.After(within)
	for {
		select {
		case e, ok := <-l.events:
			if !ok {
				return events, time.Now()
			}
			events = append(events, e)
		case <-deadline:
			return events, time.Time{}
		}
	}
}

// nextLeft waits for the presence event that tells a participant left.
func (l *liveEvents) nextLeft(t *testing.T, id string) {
	t.Helper()
	for l.next(t, "presence")["left"] != id {
	}
}

// nextRole waits for the presence event that tells of a participant with a role, and gives that participant.
func (l *liveEvents) nextRole(t *testing.T, id, role string) map[string]any {
	t.Helper()
	for {
		if p := l.nextOf(t, id); p["role"] == role {
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

// A presence post that names another workspace's canvas under the caller's own workspace, or a canvas that does not
// exist, answers 404 as everywhere (AWWO-LAW-001): checked in full, and trusted for presence too.
func TestPostgresCanvasLivePresenceAnswersNotFoundForAnotherWorkspacesCanvas(t *testing.T) {
	lt := newLiveTeam(t)
	otherOwner, otherTid, _ := lt.h.register(t, "live-other-owner@example.test")
	other := lt.h.request(t, otherOwner, "POST", "/tenants/"+otherTid+"/canvases", map[string]any{"name": "Other", "document": liveCanvasDocument()}, 201)["id"].(string)
	post := func(who *http.Cookie, cid string) int {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"clientId": "member-page-5", "state": map[string]any{"status": "here"}})
		r, _ := http.NewRequest("POST", lt.h.server.URL+"/api/v1/tenants/"+lt.tid+"/canvases/"+cid+"/live/presence", bytes.NewReader(raw))
		r.Header.Set("Origin", lt.h.cfg.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(who)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	// The first post is checked in full, the next ones within the session's trust: the same answers both ways.
	for round := 0; round < 2; round++ {
		if got := post(lt.member, other); got != 404 {
			t.Fatalf("round %d, another workspace's canvas: %d", round, got)
		}
		if got := post(lt.member, "no-such-canvas"); got != 404 {
			t.Fatalf("round %d, a canvas that does not exist: %d", round, got)
		}
		if got := post(lt.member, lt.cid); got != 204 {
			t.Fatalf("round %d, the workspace's own canvas: %d", round, got)
		}
	}
	// On a canvas the member is on (a stream open), the post moves their state.
	live := lt.openLive(t, lt.member, "", "after=1&client=member-page-5")
	live.next(t, "hello")
	if got := post(lt.member, lt.cid); got != 204 {
		t.Fatalf("on the open canvas: %d", got)
	}
	if p, ok := lt.h.a.multiplayer.participant(lt.tid, lt.cid, "member-page-5"); !ok || p.State.Status == nil || *p.State.Status != "here" {
		t.Fatalf("the member's state: %+v", p)
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

// A membership change reaches the person's open streams at once, not at the stream's own check (an hour away here):
// removed, their stream ends with one bye access, no change made after the removal reaches it, and everyone else sees
// them leave at once; leaving is the same; made a reader with no post of theirs, they show as one at once, with no edit
// in progress or editing mark, and their stream goes on.
func TestPostgresCanvasLiveMembershipChangesReachOpenStreamsAtOnce(t *testing.T) {
	// A hold, once armed, holds the notice of the next change of its person giving its role ("" a removal), after that
	// change's commit, until its release is closed; a watch, once armed, says when the next change of its person giving
	// its role comes to take the notices' lock. Every release is closed on every way out of the test (a held request
	// would keep the test's server from closing).
	type hold struct {
		user, role    string
		held, release chan struct{}
		released      bool
	}
	type watch struct {
		user, role string
		arrived    chan struct{}
	}
	var holding atomic.Pointer[hold]
	var watching atomic.Pointer[watch]
	var holds []*hold
	letGo := func(h *hold) {
		if !h.released {
			h.released = true
			close(h.release)
		}
	}
	defer func() {
		for _, h := range holds {
			letGo(h)
		}
	}()
	lt := newLiveTeam(t, func(a *App) {
		a.reauthEvery = time.Hour
		a.liveMemberNoticeHook = func(step, _, userID, role string) {
			if w := watching.Load(); step == "commit" && w != nil && w.user == userID && w.role == role && watching.CompareAndSwap(w, nil) {
				w.arrived <- struct{}{}
			}
			if h := holding.Load(); step == "notice" && h != nil && h.user == userID && h.role == role && holding.CompareAndSwap(h, nil) {
				h.held <- struct{}{}
				<-h.release
			}
		}
	})
	// ordered sends a first membership change of a person (giving firstRole) and holds its notice after its commit, then
	// sends a second one (giving secondRole) and checks that, once it has come to the notices' lock, it is not answered
	// while the first one's notice is held; then lets the first go and gives both answers.
	ordered := func(name, user, firstRole string, first func() int, secondRole string, second func() int) (int, int) {
		t.Helper()
		h := &hold{user: user, role: firstRole, held: make(chan struct{}, 1), release: make(chan struct{})}
		holds = append(holds, h)
		holding.Store(h)
		a, b := make(chan int, 1), make(chan int, 1)
		go func() { a <- first() }()
		select {
		case <-h.held:
		case code := <-a:
			t.Fatalf("%s: the first change was answered (%d) without its notice", name, code)
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: the first change's notice never came", name)
		}
		w := &watch{user: user, role: secondRole, arrived: make(chan struct{}, 1)}
		watching.Store(w)
		go func() { b <- second() }()
		select {
		case <-w.arrived:
		case code := <-b:
			t.Fatalf("%s: the second change was answered (%d) before it came to the notices' lock", name, code)
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: the second change never came to the notices' lock", name)
		}
		select {
		case code := <-b:
			t.Fatalf("%s: the second change was answered (%d) while the first one's notice was held", name, code)
		case <-time.After(time.Second):
		}
		letGo(h)
		var answers [2]int
		for i, ch := range []chan int{a, b} {
			select {
			case answers[i] = <-ch:
			case <-time.After(30 * time.Second):
				t.Fatalf("%s: change %d was never answered after the first one's notice was let go", name, i+1)
			}
		}
		return answers[0], answers[1]
	}
	client := &http.Client{Timeout: 30 * time.Second}
	call := func(who *http.Cookie, method, path string, body any) int {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, lt.h.server.URL+"/api/v1"+path, bytes.NewReader(raw))
		req.Header.Set("Origin", lt.h.cfg.PublicOrigin)
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(who)
		resp, err := client.Do(req)
		if err != nil {
			return 0
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	owner := lt.openLive(t, lt.owner, "", "after=1&client=owner-page-1")
	owner.next(t, "hello")
	ended := func(l *liveEvents, from time.Time, who string) {
		t.Helper()
		events, at := l.rest(t, 5*time.Second)
		if at.IsZero() {
			t.Fatalf("%s's stream is still open: %v", who, events)
		}
		var byes []string
		for _, e := range events {
			switch e[0] {
			case "bye":
				byes = append(byes, e[1])
			case "changes", "reset", "message", "claims":
				t.Fatalf("%s's stream was sent %s after the change: %s", who, e[0], e[1])
			}
		}
		if len(byes) != 1 || byes[0] != `{"reason":"access"}` || events[len(events)-1][0] != "bye" {
			t.Fatalf("%s's stream ended with %v", who, events)
		}
		t.Logf("%s's stream ended %d ms after the change", who, at.Sub(from).Milliseconds())
	}

	// Removed: the member's open stream ends at once, the owner's edit right after never reaches it, and the owner sees
	// them leave at once, not after their 30 s.
	removed, removedID := lt.addPerson(t, "live-removed@example.test", "member")
	gone := lt.openLive(t, removed, "", "after=1&client=removed-page-1")
	gone.next(t, "hello")
	owner.nextOf(t, "removed-page-1")
	if status, _ := lt.presenceStatus(t, removed, "removed-page-1", map[string]any{"cursor": map[string]any{"x": 1, "y": 1}}); status != 204 {
		t.Fatalf("the member's presence: %d", status)
	}
	owner.nextOf(t, "removed-page-1")
	at := time.Now()
	lt.h.request(t, lt.owner, "DELETE", "/tenants/"+lt.tid+"/members/"+removedID, nil, 204)
	_, version := lt.document(t)
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"nodes", "n1", "title"}, "After the removal")}, 200)
	lt.h.request(t, lt.owner, "POST", lt.prefix+"/live/messages", map[string]any{"clientId": "owner-page-1", "text": "After the removal"}, 200)
	ended(gone, at, "the removed member")
	owner.nextLeft(t, "removed-page-1")
	if _, here := lt.h.a.multiplayer.participant(lt.tid, lt.cid, "removed-page-1"); here {
		t.Fatal("the removed member is still on the canvas")
	}
	// Its answer is closed and its request cancelled before the check, so a stream wrongly opened cannot keep the test's
	// server from closing.
	reopen, cancelReopen := context.WithCancel(context.Background())
	stream, _ := http.NewRequestWithContext(reopen, "GET", lt.h.server.URL+"/api/v1"+lt.prefix+"/live/events?after=1&client=removed-page-1", nil)
	stream.AddCookie(removed)
	reopened, err := http.DefaultClient.Do(stream)
	status := 0
	if err == nil {
		status = reopened.StatusCode
		reopened.Body.Close()
	}
	cancelReopen()
	if status != 404 {
		t.Fatalf("the removed member opens the stream again: %d %v", status, err)
	}

	// Leaving is the same. (The stream opens at the canvas's version: what it catches up on would be from before.)
	leaver, _ := lt.addPerson(t, "live-leaver@example.test", "reader")
	_, version = lt.document(t)
	left := lt.openLive(t, leaver, "", fmt.Sprintf("after=%v&client=leaver-page-1", version))
	left.next(t, "hello")
	owner.nextOf(t, "leaver-page-1")
	at = time.Now()
	lt.h.request(t, leaver, "POST", "/tenants/"+lt.tid+"/leave", nil, 204)
	ended(left, at, "the member who left")
	owner.nextLeft(t, "leaver-page-1")

	// Made a reader with no post of theirs: the owner and the member's own page see a reader at once, with no edit in
	// progress or editing mark, and the member's stream goes on.
	_, version = lt.document(t)
	member := lt.openLive(t, lt.member, "", fmt.Sprintf("after=%v&client=member-page-1", version))
	member.next(t, "hello")
	if status, _ := lt.presenceStatus(t, lt.member, "member-page-1", map[string]any{
		"preview": map[string]any{"nodes": []any{map[string]any{"id": "n1", "x": 5, "y": 6}}},
		"editing": map[string]any{"node": "n1", "field": "title"},
	}); status != 204 {
		t.Fatalf("the member's presence: %d", status)
	}
	for p := owner.nextOf(t, "member-page-1"); p["state"].(map[string]any)["editing"] == nil; p = owner.nextOf(t, "member-page-1") {
	}
	lt.h.request(t, lt.owner, "PATCH", "/tenants/"+lt.tid+"/members/"+lt.memberID, map[string]string{"role": "reader"}, 204)
	for name, l := range map[string]*liveEvents{"the owner": owner, "the member": member} {
		state := l.nextRole(t, "member-page-1", "reader")["state"].(map[string]any)
		if state["preview"] != nil || state["editing"] != nil {
			t.Fatalf("%s sees the reader's %v", name, state)
		}
	}
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"nodes", "n2", "title"}, "Seen by a reader")}, 200)
	if change := member.next(t, "changes"); change["version"] != version+1 {
		t.Fatalf("the reader's stream: %v", change)
	}

	// Two quick changes of one person are told in the order they were committed: the second waits for the first one's
	// notice, so the change committed last stands.
	members := "/tenants/" + lt.tid + "/members"
	role := func(r string) func() int {
		return func() int { return call(lt.owner, "PATCH", members+"/"+lt.memberID, map[string]string{"role": r}) }
	}
	if a, b := ordered("two role changes", lt.memberID, "member", role("member"), "reader", role("reader")); a != 204 || b != 204 {
		t.Fatalf("the two role changes: %d, %d", a, b)
	}
	if p, _ := lt.h.a.multiplayer.participant(lt.tid, lt.cid, "member-page-1"); p.Role != "reader" {
		t.Fatalf("the change committed last does not stand: %+v", p)
	}
	lt.patch(t, lt.owner, version+1, []map[string]any{set([]string{"nodes", "n2", "title"}, "Still seen")}, 200)
	if change := member.next(t, "changes"); change["version"] != version+2 {
		t.Fatalf("the reader's stream after the two changes: %v", change)
	}

	// A person removed and at once added back, by the owner or by an invitation: the adding waits for the removal's
	// notice, which ends the stream they had open, so a stream they open once they are back stays open.
	readd, readdID := lt.addPerson(t, "live-readd@example.test", "member")
	invite := lt.h.request(t, lt.owner, "POST", "/tenants/"+lt.tid+"/invites", map[string]any{"role": "member", "email": "live-readd@example.test"}, 201)
	for i, way := range []struct {
		name string
		add  func() int
		want int
	}{
		{"added back by the owner", func() int {
			return call(lt.owner, "POST", members, map[string]string{"email": "live-readd@example.test", "role": "member"})
		}, 201},
		{"added back by an invitation", func() int { return call(readd, "POST", "/invites/"+invite["token"].(string)+"/accept", nil) }, 200},
	} {
		_, v := lt.document(t)
		before := lt.openLive(t, readd, "", fmt.Sprintf("after=%v&client=readd-page-%d", v, 2*i))
		before.next(t, "hello")
		at := time.Now()
		remove := func() int { return call(lt.owner, "DELETE", members+"/"+readdID, nil) }
		if a, b := ordered(way.name, readdID, "", remove, "member", way.add); a != 204 || b != way.want {
			t.Fatalf("%s: the removal %d, the adding %d", way.name, a, b)
		}
		ended(before, at, "the member "+way.name)
		back := lt.openLive(t, readd, "", fmt.Sprintf("after=%v&client=readd-page-%d", v, 2*i+1))
		back.next(t, "hello")
		lt.patch(t, lt.owner, v, []map[string]any{set([]string{"nodes", "n1", "title"}, way.name)}, 200)
		if change := back.next(t, "changes"); change["version"] != v+1 {
			t.Fatalf("%s: the stream opened once back: %v", way.name, change)
		}
	}
}
