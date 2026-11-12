package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The routes of a workspace that stay open while the free plan's end has it closed are two, and neither carries any of
// its content: the usage answer and the note that its person would pay. Everything else is closed, reads too, and
// stopping work with them (a stop answers with the run it stopped, output and all).
func TestPlanLockOpenNamesOnlyTheTwoThatCarryNoContent(t *testing.T) {
	open := [][2]string{{"GET", "/route-usage"}, {"POST", "/upgrade-interest"}}
	closed := [][2]string{{"GET", ""}, {"GET", "/canvases"}, {"GET", "/canvases/c1"}, {"GET", "/runs"}, {"GET", "/members"}, {"GET", "/capabilities"},
		{"GET", "/usage"}, {"GET", "/runtime"}, {"GET", "/artifacts/a1/media"}, {"GET", "/canvases/c1/live/events"}, {"GET", "/route-usage/more"},
		{"GET", "/runs/r1/cancel"}, {"POST", "/route-usage"}, {"POST", "/canvases"}, {"PUT", "/canvases/c1"}, {"PATCH", "/canvases/c1"},
		{"DELETE", "/canvases/c1"}, {"DELETE", "/runs/r1/cancel"}, {"POST", "/runs"}, {"POST", "/checkin"}, {"POST", "/invites"},
		{"POST", "/members"}, {"POST", "/canvases/c1/uploads"}, {"POST", "/canvases/c1/ui-events"}, {"POST", "/leave/now"}, {"PUT", "/leave"},
		{"POST", "/leave"}, {"POST", "/runs/r1/cancel"}, {"POST", "/canvases/c1/graph-runs/g1/cancel"}, {"POST", "/canvases/c1/graph-runs/operations/op/cancel"},
		{"POST", "/canvases/c1/renders/x/cancel"}, {"POST", "/evolution/changes/x/cancel"}, {"GET", "/upgrade-interest"}, {"POST", "/upgrade-interest/x"},
		{"GET", "/route-usage/"}, {"GET", "//route-usage"}, {"HEAD", "/route-usage"}}
	for _, c := range open {
		if !planLockOpen(c[0], c[1]) {
			t.Error("closed, but it is one of the two:", c)
		}
	}
	for _, c := range closed {
		if planLockOpen(c[0], c[1]) {
			t.Error("open, but it is neither of the two:", c)
		}
	}
}

// Owner 2026-11-12: 「确保现在没有付费的用户使用不了任何awwo的功能」, and, asked how far: locked completely, only the plans
// page left. After the free plan's end a workspace it holds answers 402 free_plan_ended on every route, reads included,
// to its owner, its members and its agents' tokens (the MCP endpoint among them); nothing in it is changed or removed;
// the two routes that carry none of its content stay; the account's own routes stay, and its export leaves the closed
// workspace's canvases out; a plan's workspace, the operator's and one without route limits are untouched; and a
// subscription that lands opens the workspace at its next request.
func TestPostgresFreePlanEndLocksTheWorkspaceWhole(t *testing.T) {
	lt := newLiveTeam(t)
	h := lt.h
	setLimits(t, h, lt.tid, 100, `{"media":1}`)
	base := "/tenants/" + lt.tid
	token, _ := lt.token(t, lt.owner, "Codex", "edit")
	reads := []string{"", "/canvases", "/canvases/" + lt.cid, "/canvases/" + lt.cid + "/changes?after=0", "/agents", "/runs", "/sessions", "/knowledge",
		"/members", "/invites", "/capabilities", "/runtime", "/skills", "/memory", "/media", "/learning", "/canvases/" + lt.cid + "/agent-tokens"}
	writes := []struct {
		method, path string
		body         any
	}{
		{"POST", "/canvases", map[string]any{"name": "New", "document": liveCanvasDocument()}},
		{"PUT", "/canvases/" + lt.cid, map[string]any{"name": "Renamed", "document": liveCanvasDocument(), "version": 1}},
		{"PATCH", "/canvases/" + lt.cid, map[string]any{"baseVersion": 1, "clientId": "page-x", "ops": []any{}}},
		{"DELETE", "/canvases/" + lt.cid, nil},
		{"POST", "/agents", map[string]any{"name": "Worker", "adapterType": "pi", "model": "test-model"}},
		{"POST", "/invites", map[string]any{"email": "someone@example.test", "role": "member"}},
		{"POST", "/members", map[string]string{"email": "live-member@example.test", "role": "member"}},
		{"POST", "/checkin", map[string]any{}},
		{"POST", "/canvases/" + lt.cid + "/agent-tokens", map[string]any{"name": "Another", "scope": "read", "days": 1}},
		{"POST", "/canvases/" + lt.cid + "/ui-events", map[string]any{"events": []any{}}},
	}
	state := func() [3]int {
		t.Helper()
		var n [3]int
		if e := h.db.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM canvases WHERE tenant_id=$1),(SELECT version FROM canvases WHERE tenant_id=$1 AND id=$2),
			(SELECT count(*) FROM memberships WHERE tenant_id=$1)`, lt.tid, lt.cid).Scan(&n[0], &n[1], &n[2]); e != nil {
			t.Fatal(e)
		}
		return n
	}

	// Before the end every read answers, for the owner and the member; the token reads the canvas.
	h.a.cfg.FreePlanUntil = time.Now().Add(time.Hour)
	for _, path := range reads {
		if path == "" {
			continue // the workspace has no route of its own
		}
		h.request(t, lt.owner, "GET", base+path, nil, 200)
	}
	h.request(t, lt.member, "GET", base+"/canvases/"+lt.cid, nil, 200)
	lt.bearer(t, token, "GET", base+"/canvases/"+lt.cid, nil, 200, "")
	if got := exportedCanvases(t, h, lt.member); got[lt.tid] != 1 {
		t.Fatal("a member's export before the end", got)
	}
	// An invitation sent from the canvas before the end, to someone who has not answered it yet.
	guest, _, _ := h.register(t, "lock-guest@example.test")
	invite := h.request(t, lt.owner, "POST", base+"/invites", map[string]any{"role": "member", "canvasId": lt.cid}, 201)["token"].(string)
	if open := h.request(t, guest, "GET", "/invites/"+invite, nil, 200); open["status"] != "active" || open["canvasName"] != "Live" {
		t.Fatal("the invitation before the end", open)
	}
	// And one the member answered before the end (already a member: it joins nothing).
	taken := h.request(t, lt.owner, "POST", base+"/invites", map[string]any{"role": "member", "canvasId": lt.cid}, 201)["token"].(string)
	h.request(t, lt.member, "POST", "/invites/"+taken+"/accept", nil, 200)
	if old := h.request(t, lt.member, "GET", "/invites/"+taken, nil, 200); old["status"] != "accepted" || old["canvasName"] != "Live" {
		t.Fatal("the answered invitation before the end", old)
	}
	before := state()

	// After it the workspace is closed whole.
	h.a.cfg.FreePlanUntil = time.Now().Add(-time.Minute)
	for _, path := range reads {
		if path == "" {
			continue
		}
		if refused := h.request(t, lt.owner, "GET", base+path, nil, 402); errorCode(refused) != "free_plan_ended" {
			t.Fatal("GET", path, refused)
		}
	}
	// A member's too (what a member may not read at all is refused as before, by their role).
	for _, path := range []string{"/canvases", "/canvases/" + lt.cid, "/runs", "/members", "/capabilities"} {
		if refused := h.request(t, lt.member, "GET", base+path, nil, 402); errorCode(refused) != "free_plan_ended" {
			t.Fatal("a member's GET", path, refused)
		}
	}
	for _, w := range writes {
		if refused := h.request(t, lt.owner, w.method, base+w.path, w.body, 402); errorCode(refused) != "free_plan_ended" {
			t.Fatal(w.method, w.path, refused)
		}
	}
	// An agent's token reads and changes nothing, by the canvas's own routes or the MCP endpoint.
	if refused := lt.bearer(t, token, "GET", base+"/canvases/"+lt.cid, nil, 402, ""); errorCode(refused) != "free_plan_ended" {
		t.Fatal("a token's read", refused)
	}
	if refused := lt.mcp(t, token, map[string]any{"id": 1, "method": "tools/list"}, 402); errorCode(refused) != "free_plan_ended" {
		t.Fatal("a token's MCP call", refused)
	}
	if after := state(); after != before {
		t.Fatal("a refused request changed the workspace", before, after)
	}
	// Two routes stay: the usage answer says the free plan has ended; the note that its person would pay. Stopping
	// work is closed with the rest, whether there is such a run or not (nothing is learnt of the workspace's runs).
	if view, _ := h.request(t, lt.member, "GET", base+"/route-usage", nil, 200)["freePlan"].(map[string]any); view == nil || view["ended"] != true {
		t.Fatal("the usage answer of a closed workspace", view)
	}
	h.request(t, lt.owner, "POST", base+"/upgrade-interest", map[string]any{}, 200)
	for _, path := range []string{"/runs/no-such-run/cancel", "/canvases/" + lt.cid + "/graph-runs/no-such-run/cancel", "/canvases/" + lt.cid + "/renders/no-such-render/cancel"} {
		if refused := h.request(t, lt.owner, "POST", base+path, map[string]any{}, 402); errorCode(refused) != "free_plan_ended" {
			t.Fatal("POST", path, refused)
		}
	}
	// An invitation into the closed workspace reads closed, names no canvas, and takes nobody in; one the member
	// answered before the end names no canvas either, and is confirmed again as ever (it joins nothing).
	if old := h.request(t, lt.member, "GET", "/invites/"+taken, nil, 200); old["status"] != "accepted" || old["canvasName"] != nil {
		t.Fatal("an answered invitation's preview in a closed workspace", old)
	}
	if again := h.request(t, lt.member, "POST", "/invites/"+taken+"/accept", nil, 200); again["tenantId"] != lt.tid {
		t.Fatal("confirming an answered invitation again in a closed workspace", again)
	}
	if shut := h.request(t, guest, "GET", "/invites/"+invite, nil, 200); shut["status"] != "closed" || shut["canvasName"] != nil || shut["canvasId"] != nil {
		t.Fatal("the invitation's preview in a closed workspace", shut)
	}
	if refused := h.request(t, guest, "POST", "/invites/"+invite+"/accept", nil, 402); errorCode(refused) != "free_plan_ended" {
		t.Fatal("accepting an invitation into a closed workspace", refused)
	}
	if after := state(); after != before {
		t.Fatal("a refused invitation changed the workspace", before, after)
	}
	// The account's export names the closed workspace and carries none of its canvases, for its owner or a member.
	for name, c := range map[string]*http.Cookie{"the owner's": lt.owner, "a member's": lt.member} {
		if got := exportedCanvases(t, h, c); got[lt.tid] != 0 {
			t.Fatal(name, "export carries the closed workspace's canvases", got)
		}
	}
	// The account's own routes stay whole: who they are and their workspaces, billing, the plans on offer.
	if me := h.request(t, lt.owner, "GET", "/auth/me", nil, 200); len(me["tenants"].([]any)) != 1 {
		t.Fatal("the account's own answer", me)
	}
	h.request(t, lt.owner, "GET", "/billing", nil, 200)
	h.request(t, lt.owner, "GET", "/billing/catalog", nil, 200)

	// A plan's workspace, the operator's own and one without route limits are untouched.
	paid, tp, _ := h.register(t, "lock-paid@example.test")
	setLimits(t, h, tp, 100, planRoutes)
	now := time.Now()
	givePlan(t, h, "lock-paid@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	operator, to, uo := h.register(t, "lock-operator@example.test")
	setLimits(t, h, to, 100, `{"media":1}`)
	makeAdmin(t, h, uo)
	unlimited, tu, _ := h.register(t, "lock-unlimited@example.test")
	setLimits(t, h, tu, 100, "")
	for name, s := range map[string]struct {
		c   *http.Cookie
		tid string
	}{"a plan's": {paid, tp}, "the operator's": {operator, to}, "an unlimited": {unlimited, tu}} {
		h.request(t, s.c, "GET", "/tenants/"+s.tid+"/canvases", nil, 200)
		if made := h.request(t, s.c, "POST", "/tenants/"+s.tid+"/canvases", map[string]any{"name": name, "document": liveCanvasDocument()}, 201); made["id"] == nil {
			t.Fatal(name, made)
		}
	}

	// A member leaves the closed workspace.
	h.request(t, lt.member, "POST", base+"/leave", map[string]any{}, 204)
	// A subscription that lands opens it at the next request, with everything as it was.
	givePlan(t, h, "live-owner@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	if doc := h.request(t, lt.owner, "GET", base+"/canvases/"+lt.cid, nil, 200); doc["id"] != lt.cid {
		t.Fatal("the canvas after the subscription", doc)
	}
	lt.bearer(t, token, "GET", base+"/canvases/"+lt.cid, nil, 200, "")
	if after := state(); after[0] != before[0] || after[1] != before[1] || after[2] != before[2]-1 {
		t.Fatal("the workspace's canvases changed while it was closed, or the member did not leave", before, after)
	}
	if got := exportedCanvases(t, h, lt.owner); got[lt.tid] != 1 {
		t.Fatal("the owner's export after the subscription", got)
	}
	// The invitation is good again: it names its canvas and takes its person in.
	if open := h.request(t, guest, "GET", "/invites/"+invite, nil, 200); open["status"] != "active" || open["canvasName"] != "Live" {
		t.Fatal("the invitation after the subscription", open)
	}
	if joined := h.request(t, guest, "POST", "/invites/"+invite+"/accept", nil, 200); joined["tenantId"] != lt.tid {
		t.Fatal("accepting the invitation after the subscription", joined)
	}
}

// exportedCanvases reads the account's export and counts its canvases by workspace; the export must be whole and must
// name every workspace the account belongs to.
func exportedCanvases(t *testing.T, h *harness, c *http.Cookie) map[string]int {
	t.Helper()
	r, _ := http.NewRequest("GET", h.server.URL+"/api/v1/auth/export", nil)
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	r.AddCookie(c)
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		Complete   bool              `json:"complete"`
		Workspaces []json.RawMessage `json:"workspaces"`
		Canvases   []struct {
			TenantID string `json:"tenantId"`
		} `json:"canvases"`
	}
	if resp.StatusCode != 200 || json.Unmarshal(raw, &out) != nil || !out.Complete || len(out.Workspaces) == 0 || !bytes.Contains(raw, []byte(`"canvases":[`)) {
		t.Fatal("the account's export", resp.StatusCode, string(raw))
	}
	got := map[string]int{}
	for _, cv := range out.Canvases {
		got[cv.TenantID]++
	}
	return got
}

// A canvas's live stream open since before the free plan's end is told to go at its first check after it, so nothing
// more of the closed workspace's canvas goes down it; the end is set a few seconds ahead, before the server starts,
// rather than moved under the open stream.
func TestPostgresFreePlanEndEndsAnOpenLiveStream(t *testing.T) {
	var until time.Time
	lt := newLiveTeam(t, func(a *App) {
		a.reauthEvery = 200 * time.Millisecond
		until = time.Now().Add(4 * time.Second)
		a.cfg.FreePlanUntil = until
	})
	setLimits(t, lt.h, lt.tid, 100, `{"media":1}`)
	owner := lt.openLive(t, lt.owner, "", "client=owner-page-1")
	owner.next(t, "hello")
	if !time.Now().Before(until) {
		t.Fatal("the stream opened no sooner than the end it was to come before")
	}
	if bye := owner.next(t, "bye"); bye["reason"] != "access" {
		t.Fatalf("bye: %v", bye)
	}
	if time.Now().Before(until) {
		t.Fatal("the stream was told to go before the end")
	}
	if refused := lt.h.request(t, lt.owner, "GET", lt.prefix+"/live/events?client=owner-page-2", nil, 402); errorCode(refused) != "free_plan_ended" {
		t.Fatal("opening the stream again", refused)
	}
}

// An agent's canvas_wait that began before the free plan's end and ends after it answers nothing of the canvas: the
// token no longer reaches it.
func TestPostgresFreePlanEndEndsAnAgentsWait(t *testing.T) {
	var until time.Time
	lt := newLiveTeam(t, func(a *App) {
		until = time.Now().Add(4 * time.Second)
		a.cfg.FreePlanUntil = until
	})
	setLimits(t, lt.h, lt.tid, 100, `{"media":1}`)
	token, _ := lt.token(t, lt.owner, "Codex", "edit")
	began := time.Now()
	out := lt.tool(t, token, "canvas_wait", map[string]any{"seconds": 7})
	if !began.Before(until) || time.Now().Before(until) {
		t.Fatal("the wait did not span the end", began, until)
	}
	if _, told := out["version"]; told || out["error"] != "This token no longer reaches the canvas" {
		t.Fatal("a wait that ended in a closed workspace", out)
	}
}

// A run's event stream open since before the free plan's end sends no more of the run after it: held at its first
// event until the end has passed, it ends at its next check instead of replaying the rest.
func TestPostgresFreePlanEndEndsAnOpenRunStream(t *testing.T) {
	h := newHarness(t, "")
	h.a.reauthEvery = 20 * time.Millisecond
	owner, tid, _ := h.register(t, "lock-stream@example.test")
	setLimits(t, h, tid, 100, `{"media":1}`)
	_, _, sid := h.fixture(t, owner, tid)
	rid := randomID()
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,'lock-stream-operation','hash','test','completed')", rid, tid, sid); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, `INSERT INTO run_events(tenant_id,run_id,data) SELECT $1,$2,'{"type":"text_delta","delta":"private"}'::jsonb FROM generate_series(1,201)`, tid, rid); e != nil {
		t.Fatal(e)
	}
	until := time.Now().Add(1500 * time.Millisecond)
	h.a.cfg.FreePlanUntil = until
	g := newRequestGate(t)
	w := &gatedReplayWriter{httptest.NewRecorder(), g}
	r := httptest.NewRequest("GET", "/api/v1/tenants/"+tid+"/runs/"+rid+"/events", nil)
	r.AddCookie(owner)
	done := make(chan struct{})
	go func() { defer close(done); h.a.Handler().ServeHTTP(w, r) }()
	awaitTestSignal(t, g.reached)
	if !time.Now().Before(until) {
		t.Fatal("the stream opened no sooner than the end it was to come before")
	}
	time.Sleep(time.Until(until) + 3*h.a.reauthEvery)
	g.open()
	awaitTestSignal(t, done)
	if n := strings.Count(w.Body.String(), "data: "); n > 1 {
		t.Fatalf("replayed %d events in a closed workspace instead of ending at the next check", n)
	}
}

// The market's routes are the account's, not a workspace's: a draft takes no skill out of a workspace the free plan's
// end has closed (a new Agent, or a change to one), nothing of it is kept, and the same draft without the skill, or
// with it once the owner subscribes, is saved.
func TestPostgresFreePlanEndKeepsAClosedWorkspacesSkillsOutOfTheMarket(t *testing.T) {
	h, _ := marketTestHarness(t)
	author, tid, uid := h.register(t, "lock-author@example.test")
	setLimits(t, h, tid, 100, `{"media":1}`)
	skill := h.request(t, author, "POST", "/tenants/"+tid+"/skills", map[string]any{"name": "voice", "title": "Voice", "description": "Voice", "body": "CLOSED-WORKSPACE-SKILL-TEXT\n"}, 201)
	draft := func(name string, withSkill bool) map[string]any {
		d := map[string]any{"name": name, "tagline": "Writes", "category": "writing", "instructions": "Write well.", "price": 10}
		if withSkill {
			d["skills"] = []map[string]any{{"tenantId": tid, "ref": skill["ref"]}}
		}
		return d
	}
	h.a.cfg.FreePlanUntil = time.Now().Add(time.Hour)
	plain := h.request(t, author, "POST", "/market/agents", draft("Plain", false), 201)["id"].(string)
	agents := func() (n int) {
		t.Helper()
		if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM market_agents WHERE author_user_id=$1", uid).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}

	h.a.cfg.FreePlanUntil = time.Now().Add(-time.Minute)
	for _, try := range []struct{ method, path string }{{"POST", "/market/agents"}, {"PUT", "/market/agents/" + plain + "/draft"}} {
		refused := h.request(t, author, try.method, try.path, draft("Taker", true), 402)
		if raw, _ := json.Marshal(refused); errorCode(refused) != "free_plan_ended" || bytes.Contains(raw, []byte("CLOSED-WORKSPACE-SKILL-TEXT")) {
			t.Fatal(try.method, try.path, refused)
		}
	}
	var kept int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM market_agent_versions v JOIN market_agents m ON m.id=v.agent_id WHERE m.author_user_id=$1 AND v.skills::text LIKE '%CLOSED-WORKSPACE-SKILL-TEXT%'", uid).Scan(&kept); e != nil || kept != 0 || agents() != 1 {
		t.Fatal("a refused draft kept the skill or made an Agent", kept, agents(), e)
	}
	// The account's market itself stays: the same draft without the workspace's skill is saved.
	h.request(t, author, "PUT", "/market/agents/"+plain+"/draft", draft("Plain again", false), 200)
	// Once the owner subscribes the skill goes into a draft as before.
	now := time.Now()
	givePlan(t, h, "lock-author@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	made := h.request(t, author, "POST", "/market/agents", draft("Taker", true), 201)
	if raw, _ := json.Marshal(made); !bytes.Contains(raw, []byte("CLOSED-WORKSPACE-SKILL-TEXT")) {
		t.Fatal("the author's draft after the subscription", made)
	}
}
