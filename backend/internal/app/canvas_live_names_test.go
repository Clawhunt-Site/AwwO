package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// What the canvas calls a person, to agents and on the page (docs/awwo-canvas-live-collaboration.md, Participants): the
// name the person's session shows them by, as the people list does, never their account's own name where the two
// differ (found recording the 多人同屏 tutorial on 2026-11-07: agents were given a person's full account name in the
// messages, addressed them by it and repeated it, while the people list showed their ClawHunt name).

const accountName = "Full Account Name" // the account's own name, which must never reach an agent

// mustNotName fails when an answer names the person by their account's own name.
func mustNotName(t *testing.T, what string, value any) {
	t.Helper()
	raw, _ := json.Marshal(value)
	if strings.Contains(string(raw), accountName) {
		t.Fatalf("%s names the person by their account's name: %s", what, raw)
	}
}

// linkedLegacyAccount is an AwwO account made before ClawHunt, named accountName at sign-up, with a canvas of its
// workspace, then linked to a ClawHunt identity named "kite" and signed in through ClawHunt (every request checks it).
func linkedLegacyAccount(t *testing.T) (*identityFixture, liveTeam, string) {
	t.Helper()
	h := newHarness(t, "http://127.0.0.1:1")
	old, tid, uid := h.register(t, "kite@example.invalid")
	if _, err := h.db.Exec(context.Background(), "UPDATE users SET name=$2 WHERE id=$1", uid, accountName); err != nil {
		t.Fatal(err)
	}
	cv := h.request(t, old, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Names", "document": liveCanvasDocument()}, 201)
	f := newIdentityFixture(t, h, "kite@example.invalid", "kite-subject")
	// ClawHunt showed the full name when the person signed in, and "kite" by the time they proved the account.
	f.id.Name = accountName
	first := completeIdentity(t, h, f, "")
	if link, err := url.Parse(first.Header.Get("Location")); err != nil || link.Query().Get("sso") != "link" {
		t.Fatalf("the legacy account was not asked to link: %v %v", link, err)
	}
	f.id.Name = "kite"
	h.request(t, responseCookie(t, first, identityCookie), "POST", "/auth/clawhunt/link", map[string]string{"password": "Strong password 123!"}, 200)
	// The link keeps the name its own check of ClawHunt answered, not the one of the claim it proved.
	if shown := shownName(t, h, uid); shown == nil || *shown != "kite" {
		t.Fatalf("after the link, the account shows %v", shown)
	}
	session := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	h.a.clawHuntSessions.reuse = 0
	cid := cv["id"].(string)
	return f, liveTeam{h: h, owner: session, tid: tid, cid: cid, prefix: "/tenants/" + tid + "/canvases/" + cid}, uid
}

// shownName is the name an account keeps beside its own: nil for none.
func shownName(t *testing.T, h *harness, uid string) *string {
	t.Helper()
	var shown *string
	if err := h.db.QueryRow(context.Background(), "SELECT display_name FROM users WHERE id=$1", uid).Scan(&shown); err != nil {
		t.Fatal(err)
	}
	return shown
}

func TestPostgresCanvasNamesAPersonAsTheCanvasShowsThem(t *testing.T) {
	f, lt, uid := linkedLegacyAccount(t)
	h := lt.h
	// The sign-in keeps the name ClawHunt shows, before any other request; the account's own stays as it was.
	if shown := shownName(t, h, uid); shown == nil || *shown != "kite" {
		t.Fatalf("after the sign-in, the account shows %v", shown)
	}
	if user := h.request(t, lt.owner, "GET", "/auth/me", nil, 200)["user"].(map[string]any); user["name"] != "kite" {
		t.Fatalf("the session shows the person as %v", user["name"])
	}

	// The person makes a token (the list says who made it), writes, holds a node and changes the canvas.
	made := h.request(t, lt.owner, "POST", lt.prefix+"/agent-tokens", map[string]any{"name": "Codex", "scope": "edit", "days": 7}, 201)
	token := made["token"].(string)
	if by := made["item"].(map[string]any)["createdBy"].(map[string]any)["name"]; by != "kite" {
		t.Fatalf("the new token was made by %v", by)
	}
	_, version := lt.document(t)
	lt.say(t, "owner", "Levels is yours")
	h.request(t, lt.owner, "POST", lt.prefix+"/live/claims", map[string]any{"clientId": "owner-page-1", "nodeIds": []string{"n1"}, "ttlSeconds": 600}, 200)
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"nodes", "n2", "title"}, "Build the game")}, 200)
	// Its page is on the canvas: the people list's name.
	page := lt.openLive(t, lt.owner, "", "client=owner-page-1")
	if hello := page.next(t, "hello"); hello["you"].(map[string]any)["name"] != "kite" {
		t.Fatalf("the page's own participant: %v", hello["you"])
	}

	// The agent is told "kite" everywhere, and the account's name nowhere.
	overview := lt.tool(t, token, "canvas_overview", map[string]any{})
	mustNotName(t, "canvas_overview", overview)
	people := []string{}
	for _, p := range overview["participants"].([]any) {
		if p := p.(map[string]any); p["kind"] == "human" {
			people = append(people, p["name"].(string))
		}
	}
	claims := overview["claims"].([]any)
	if fmt.Sprint(people) != "[kite]" || len(claims) != 1 || claims[0].(map[string]any)["name"] != "kite" || !strings.HasPrefix(fmt.Sprint(liveNodeOf(overview, "n1")["heldBy"]), "kite (") {
		t.Fatalf("the overview names the person: people %v, claims %v, n1 %v", people, claims, liveNodeOf(overview, "n1"))
	}
	messages := lt.tool(t, token, "canvas_messages", map[string]any{})
	mustNotName(t, "canvas_messages", messages)
	if item := messages["items"].([]any)[0].(map[string]any); item["name"] != "kite" || item["text"] != "Levels is yours" {
		t.Fatalf("canvas_messages: %v", item)
	}
	waited := lt.tool(t, token, "canvas_wait", map[string]any{"afterVersion": version, "seconds": 5})
	mustNotName(t, "canvas_wait", waited)
	changes := waited["changes"].([]any)
	if len(changes) != 1 || changes[0].(map[string]any)["by"] != "kite" || changes[0].(map[string]any)["kind"] != "human" ||
		fmt.Sprint(texts(t, waited["messages"])) != "[Levels is yours]" || waited["messages"].([]any)[0].(map[string]any)["name"] != "kite" {
		t.Fatalf("canvas_wait: %v", waited)
	}
	refused := lt.tool(t, token, "canvas_update_node", map[string]any{"nodeId": "n1", "title": "Mine now"})
	mustNotName(t, "a refusal", refused)
	if fmt.Sprint(refused["results"]) != "[claimed]" || !strings.Contains(fmt.Sprint(refused["reasons"]), "kite (a person) holds node n1") {
		t.Fatalf("the refusal names the holder: %v", refused)
	}
	stream := lt.openLive(t, nil, token, "")
	mustNotName(t, "the agent's stream", stream.next(t, "hello"))
	tokens := h.request(t, lt.owner, "GET", lt.prefix+"/agent-tokens", nil, 200)
	mustNotName(t, "the token list", tokens)
	if by := tokens["items"].([]any)[0].(map[string]any)["createdBy"].(map[string]any)["name"]; by != "kite" {
		t.Fatalf("the token list: made by %v", by)
	}
	mustNotName(t, "the change log", h.request(t, lt.owner, "GET", lt.prefix+"/changes?after="+fmt.Sprint(version), nil, 200))

	// When ClawHunt shows the person by a new name, what they wrote before says it too.
	f.id.Name = "kestrel"
	h.request(t, lt.owner, "GET", "/auth/me", nil, 200)
	if item := lt.tool(t, token, "canvas_messages", map[string]any{})["items"].([]any)[0].(map[string]any); item["name"] != "kestrel" {
		t.Fatalf("an older message after the person's new name: %v", item)
	}
	var stored string
	if err := h.db.QueryRow(context.Background(), "SELECT name FROM users WHERE id=$1", uid).Scan(&stored); err != nil || stored != accountName {
		t.Fatalf("the account's own name became %q: %v", stored, err)
	}
}

// An account linked to ClawHunt with no shown name kept (linked before migration 058, or by an older API) is named by
// nothing until the person's next request brings the name ClawHunt shows: its own name may be one they no longer show.
func TestPostgresCanvasNamesAnAccountLinkedBeforeTheReleaseByNothing(t *testing.T) {
	f, lt, uid := linkedLegacyAccount(t)
	h := lt.h
	made := h.request(t, lt.owner, "POST", lt.prefix+"/agent-tokens", map[string]any{"name": "Codex", "scope": "edit", "days": 7}, 201)
	token := made["token"].(string)
	lt.say(t, "owner", "Written before the release")
	h.request(t, lt.owner, "POST", lt.prefix+"/live/claims", map[string]any{"clientId": "owner-page-1", "nodeIds": []string{"n1"}, "ttlSeconds": 600}, 200)
	// An account ClawHunt made keeps the name ClawHunt had then, which may be one the person no longer shows. (The
	// stand-in ClawHunt answers every session with one identity: the person's is put back once the other has signed in.)
	kite := f.id
	f.id.Subject, f.id.Email, f.id.Name = "other-subject", "other@example.invalid", "Other"
	other := h.request(t, responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session"), "GET", "/auth/me", nil, 200)["user"].(map[string]any)["id"].(string)
	f.id = kite
	// As the API before this release left them: no name beside the accounts' own (migration 058 again changes nothing).
	if _, err := h.db.Exec(context.Background(), "UPDATE users SET display_name=NULL WHERE id=ANY($1)", []string{uid, other}); err != nil {
		t.Fatal(err)
	}
	sql, err := migrations.ReadFile("migrations/058_display_names.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.db.Exec(context.Background(), string(sql)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{uid, other} {
		var shown string
		if err := h.db.QueryRow(context.Background(), "SELECT "+shownUserName+" FROM users u WHERE u.id=$1", id).Scan(&shown); err != nil || shown != "" {
			t.Fatalf("the linked account %s with no shown name kept is named %q: %v", id, shown, err)
		}
	}
	overview := lt.tool(t, token, "canvas_overview", map[string]any{})
	mustNotName(t, "canvas_overview before the person's next request", overview)
	if held := fmt.Sprint(liveNodeOf(overview, "n1")["heldBy"]); !strings.HasPrefix(held, "someone (") {
		t.Fatalf("a node held by a person not named yet: %q", held)
	}
	messages := lt.tool(t, token, "canvas_messages", map[string]any{})
	mustNotName(t, "canvas_messages before the person's next request", messages)
	if item := messages["items"].([]any)[0].(map[string]any); item["name"] != "" {
		t.Fatalf("a message of an account not seen since the release: %v", item)
	}
	// The token list as another member reads it (the person's own request would bring the name first).
	item, err := oneJSON(context.Background(), h.db, "SELECT "+canvasAgentTokenItemJSON+" FROM canvas_agent_tokens t LEFT JOIN users u ON u.id=t.created_by WHERE t.id=$1",
		made["item"].(map[string]any)["id"])
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		CreatedBy struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"createdBy"`
	}
	if err = json.Unmarshal(item, &listed); err != nil || listed.CreatedBy.ID != uid || listed.CreatedBy.Name != "" {
		t.Fatalf("the token list before the person's next request: %s (%v)", item, err)
	}
	// The person's next request brings ClawHunt's name.
	h.request(t, lt.owner, "GET", "/auth/me", nil, 200)
	if item := lt.tool(t, token, "canvas_messages", map[string]any{})["items"].([]any)[0].(map[string]any); item["name"] != "kite" {
		t.Fatalf("a message after the person's next request: %v", item)
	}
}

// A person signed in without ClawHunt, on an account never linked, is shown by their account's own name: their
// sessions keep none beside it (none is ever taken for ClawHunt's), and a change of their profile renames what they
// wrote at once.
func TestPostgresCanvasNamesWithoutClawHuntAreTheAccounts(t *testing.T) {
	lt := newLiveTeam(t)
	lt.say(t, "owner", "Hello")
	lt.h.request(t, lt.member, "GET", "/auth/me", nil, 200)
	for _, email := range []string{"live-owner@example.test", "live-member@example.test"} {
		var shown *string
		if err := lt.h.db.QueryRow(context.Background(), "SELECT display_name FROM users WHERE email=$1", email).Scan(&shown); err != nil || shown != nil {
			t.Fatalf("a name kept for %s, signed in without ClawHunt: %v, %v", email, shown, err)
		}
	}
	if item := lt.h.request(t, lt.owner, "GET", lt.prefix+"/live/messages", nil, 200)["items"].([]any)[0].(map[string]any); item["name"] != "Test" {
		t.Fatalf("a message of an account without ClawHunt: %v", item)
	}
	lt.h.request(t, lt.owner, "PATCH", "/auth/profile", map[string]any{"name": "Renamed"}, 200)
	if item := lt.h.request(t, lt.member, "GET", lt.prefix+"/live/messages", nil, 200)["items"].([]any)[0].(map[string]any); item["name"] != "Renamed" {
		t.Fatalf("a message after its author's profile changed: %v", item)
	}
}

// liveNodeOf gives a node of canvas_overview's answer.
func liveNodeOf(overview map[string]any, id string) map[string]any {
	for _, n := range overview["nodes"].([]any) {
		if node := n.(map[string]any); node["id"] == id {
			return node
		}
	}
	return nil
}
