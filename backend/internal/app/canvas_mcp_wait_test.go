package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// canvas_wait and the live messages (docs/awwo-canvas-live-collaboration.md, Ports): each message someone else wrote
// after the position a wait goes on from comes in it, one written while the agent was busy between two waits too
// (found recording the 多人同屏 tutorial on 2026-11-07: Claude Code's "Levels is your node", sent while Codex worked,
// never reached Codex's next wait).

// tool calls one of the canvas MCP tools with a token and gives its structured answer.
func (lt liveTeam) tool(t *testing.T, token, name string, args map[string]any) map[string]any {
	t.Helper()
	return mcpStructured(t, lt.mcp(t, token, map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}}, 200))
}

// say writes a live message as a person's page.
func (lt liveTeam) say(t *testing.T, who string, text string) {
	t.Helper()
	lt.h.request(t, lt.cookieOf(who), "POST", lt.prefix+"/live/messages", map[string]any{"clientId": who + "-page-1", "text": text}, 200)
}

func (lt liveTeam) cookieOf(who string) *http.Cookie {
	if who == "member" {
		return lt.member
	}
	return lt.owner
}

// sayLater writes a live message as a person's page after a while, from another goroutine (which may not fail the
// test), and gives the answer's status once it came.
func (lt liveTeam) sayLater(who, text string, after time.Duration) <-chan int {
	done := make(chan int, 1)
	go func() {
		time.Sleep(after)
		body, _ := json.Marshal(map[string]any{"clientId": who + "-page-1", "text": text})
		r, _ := http.NewRequest("POST", lt.h.server.URL+"/api/v1"+lt.prefix+"/live/messages", bytes.NewReader(body))
		r.Header.Set("Origin", lt.h.cfg.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(lt.cookieOf(who))
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	return done
}

// texts gives the texts of a wait's or a read's messages, in their order.
func texts(t *testing.T, items any) []string {
	t.Helper()
	out := []string{}
	list, ok := items.([]any)
	if !ok {
		t.Fatalf("no list of messages: %v", items)
	}
	for _, item := range list {
		out = append(out, item.(map[string]any)["text"].(string))
	}
	return out
}

// waitFor runs canvas_wait after the canvas's version, with the arguments given beside it, and says how long it took;
// during, when given, runs once the version is read, just before the wait.
func (lt liveTeam) waitFor(t *testing.T, token string, seconds float64, extra map[string]any, during ...func()) (map[string]any, time.Duration) {
	t.Helper()
	_, version := lt.document(t)
	args := map[string]any{"afterVersion": version, "seconds": seconds}
	for k, v := range extra {
		args[k] = v
	}
	for _, f := range during {
		f()
	}
	began := time.Now()
	out := lt.tool(t, token, "canvas_wait", args)
	return out, time.Since(began)
}

func TestPostgresCanvasWaitGivesEachMessageOnceAlsoOneWrittenWhileBusy(t *testing.T) {
	lt := newLiveTeam(t)
	// Written before the tokens were made: history, which canvas_messages reads, no news to them.
	lt.say(t, "owner", "Before any agent")
	codex, codexID := lt.token(t, lt.owner, "Codex", "edit")
	claude, _ := lt.token(t, lt.owner, "Claude Code", "edit")
	lt.say(t, "owner", "Hello agents")

	// The first wait gives at once what was said since the token was made.
	first, took := lt.waitFor(t, codex, 10, nil)
	if got := texts(t, first["messages"]); fmt.Sprint(got) != "[Hello agents]" || took > 5*time.Second || first["moreMessages"] != nil ||
		first["lastMessage"] != first["messages"].([]any)[0].(map[string]any)["id"] {
		t.Fatalf("the first wait: %v after %v", first, took)
	}
	// Claude Code writes while Codex is busy, between two of its waits: Codex's next wait gives it at once.
	said := lt.tool(t, claude, "canvas_say", map[string]any{"text": "Levels is your node", "nodeId": "n2"})
	if said["message"] == nil {
		t.Fatalf("say: %v", said)
	}
	busy, took := lt.waitFor(t, codex, 10, nil)
	if got := texts(t, busy["messages"]); fmt.Sprint(got) != "[Levels is your node]" || took > 5*time.Second {
		t.Fatalf("a message written while the agent was busy: %v after %v", busy, took)
	}
	message := busy["messages"].([]any)[0].(map[string]any)
	if message["authorKind"] != "agent" || message["name"] != "Claude Code" || message["nodeId"] != "n2" || busy["lastMessage"] != message["id"] {
		t.Fatalf("the message as given: %v (lastMessage %v)", message, busy["lastMessage"])
	}
	// Given once: the next wait runs to its end with nothing, and says where it goes on from.
	quiet, took := lt.waitFor(t, codex, 1.5, nil)
	if len(quiet["messages"].([]any)) != 0 || took < 1400*time.Millisecond || quiet["note"] == nil || quiet["lastMessage"] != message["id"] {
		t.Fatalf("a message given twice: %v after %v", quiet, took)
	}
	// Each token is given what it has not been: Claude Code gets the person's message, never its own.
	theirs, _ := lt.waitFor(t, claude, 10, nil)
	if got := texts(t, theirs["messages"]); fmt.Sprint(got) != "[Hello agents]" {
		t.Fatalf("the other token's first wait: %v", theirs)
	}
	// An agent's own message, written between its waits, is never given to it.
	lt.tool(t, codex, "canvas_say", map[string]any{"text": "On it"})
	own, took := lt.waitFor(t, codex, 1.5, nil)
	if len(own["messages"].([]any)) != 0 || took < 1400*time.Millisecond {
		t.Fatalf("the agent's own message given to it: %v after %v", own, took)
	}
	// A message written during a wait ends it, and is given once (without the agent's own written before it).
	var sent <-chan int
	during, took := lt.waitFor(t, codex, 10, nil, func() { sent = lt.sayLater("member", "Seen while waiting", time.Second) })
	if status := <-sent; status != 200 {
		t.Fatalf("the message written during the wait: %d", status)
	}
	if got := texts(t, during["messages"]); fmt.Sprint(got) != "[Seen while waiting]" || took > 5*time.Second {
		t.Fatalf("a message written during the wait: %v after %v", during, took)
	}
	// What an agent reads in the thread moves nothing: the next wait still gives what the agent was not given.
	lt.say(t, "owner", "Read in the thread")
	if read := lt.tool(t, codex, "canvas_messages", map[string]any{}); fmt.Sprint(texts(t, read["items"])[0]) != "Read in the thread" {
		t.Fatalf("canvas_messages: %v", read)
	}
	if after, _ := lt.waitFor(t, codex, 10, nil); fmt.Sprint(texts(t, after["messages"])) != "[Read in the thread]" {
		t.Fatalf("a message read in canvas_messages, then waited for: %v", after)
	}
	// The newest message given is kept with the token, not in the API's memory, so a restart forgets none.
	var seen string
	if err := lt.h.db.QueryRow(context.Background(), "SELECT seen_message_id FROM canvas_agent_tokens WHERE tenant_id=$1 AND id=$2", lt.tid, codexID).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	newest := lt.h.request(t, lt.owner, "GET", lt.prefix+"/live/messages", nil, 200)["items"].([]any)[0].(map[string]any)
	if seen != newest["id"] || newest["text"] != "Read in the thread" {
		t.Fatalf("the token keeps %q; the newest message is %v", seen, newest)
	}
}

// More messages than a wait gives come in order, the oldest first, over as many waits as they take.
func TestPostgresCanvasWaitGivesManyMessagesInOrder(t *testing.T) {
	lt := newLiveTeam(t)
	codex, codexID := lt.token(t, lt.owner, "Codex", "edit")
	for i := 1; i <= mcpWaitMessages+5; i++ {
		lt.say(t, "owner", fmt.Sprintf("Line %02d", i))
	}
	first, _ := lt.waitFor(t, codex, 10, nil)
	got := texts(t, first["messages"])
	last := first["messages"].([]any)[mcpWaitMessages-1].(map[string]any)["id"]
	if len(got) != mcpWaitMessages || got[0] != "Line 01" || got[len(got)-1] != fmt.Sprintf("Line %02d", mcpWaitMessages) || first["moreMessages"] != true || first["lastMessage"] != last {
		t.Fatalf("the first %d: %v, more %v, last %v", mcpWaitMessages, got, first["moreMessages"], first["lastMessage"])
	}
	// The newest given never moves back, whatever a later call says it gave (two waits of one token at once), nor to a
	// message that is not there (one that went with its author's account after the wait read it).
	lt.h.a.markLiveMessagesGiven(context.Background(), lt.tid, codexID, liveMessage{ID: first["messages"].([]any)[0].(map[string]any)["id"].(string),
		CreatedAt: time.Now().Add(-time.Hour)})
	lt.h.a.markLiveMessagesGiven(context.Background(), lt.tid, codexID, liveMessage{ID: "no-such-message", CreatedAt: time.Now().Add(time.Hour)})
	rest, took := lt.waitFor(t, codex, 10, nil)
	got = texts(t, rest["messages"])
	want := []string{}
	for i := mcpWaitMessages + 1; i <= mcpWaitMessages+5; i++ {
		want = append(want, fmt.Sprintf("Line %02d", i))
	}
	if fmt.Sprint(got) != fmt.Sprint(want) || rest["moreMessages"] != nil || took > 5*time.Second {
		t.Fatalf("the rest: %v (want %v), more %v, after %v", got, want, rest["moreMessages"], took)
	}
}

// afterMessage: an agent that passes back the lastMessage it was given is given again what it did not receive (an
// answer lost on its way), and two waits after one message give the same.
func TestPostgresCanvasWaitAfterAMessageGivesAgainWhatWasLost(t *testing.T) {
	lt := newLiveTeam(t)
	codex, _ := lt.token(t, lt.owner, "Codex", "edit")
	lt.say(t, "owner", "First")
	first, _ := lt.waitFor(t, codex, 10, nil)
	last, _ := first["lastMessage"].(string)
	if fmt.Sprint(texts(t, first["messages"])) != "[First]" || last == "" {
		t.Fatalf("the first wait: %v", first)
	}
	lt.say(t, "owner", "Second")
	lt.say(t, "member", "Third")
	got, _ := lt.waitFor(t, codex, 10, map[string]any{"afterMessage": last})
	// Its answer is lost: the agent asks again after the same message, and is given the same.
	again, _ := lt.waitFor(t, codex, 10, map[string]any{"afterMessage": last})
	if fmt.Sprint(texts(t, got["messages"])) != "[Second Third]" || fmt.Sprint(texts(t, again["messages"])) != "[Second Third]" || got["lastMessage"] != again["lastMessage"] {
		t.Fatalf("after a message, twice: %v then %v", got, again)
	}
	// Without afterMessage the token's own cursor, moved by those waits, gives nothing again.
	quiet, took := lt.waitFor(t, codex, 1.5, nil)
	if len(quiet["messages"].([]any)) != 0 || took < 1400*time.Millisecond || quiet["lastMessage"] != got["lastMessage"] {
		t.Fatalf("a wait after the token's cursor: %v after %v", quiet, took)
	}
	// After a message the canvas does not hold (never, or gone with the 200 kept, all of whose successors it holds are
	// newer), a wait goes on from the oldest it holds: none an agent may not have received is skipped. An id that is no
	// message id is refused.
	if gone, _ := lt.waitFor(t, codex, 10, map[string]any{"afterMessage": "no-such-message"}); fmt.Sprint(texts(t, gone["messages"])) != "[First Second Third]" ||
		gone["lastMessage"] != got["lastMessage"] || gone["fromOldest"] != true {
		t.Fatalf("after a message the canvas does not hold: %v", gone)
	}
	if again["fromOldest"] != nil {
		t.Fatalf("a wait after a message the canvas holds says fromOldest: %v", again)
	}
	bad := lt.mcp(t, codex, map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{"name": "canvas_wait", "arguments": map[string]any{"afterMessage": "not an id!"}}}, 200)
	if bad["result"].(map[string]any)["isError"] != true {
		t.Fatalf("a wait after a malformed id: %v", bad)
	}
}

// A clock that steps back puts no message behind one already given: each is stamped after the newest of its canvas.
func TestPostgresCanvasWaitSurvivesAClockSteppingBack(t *testing.T) {
	lt := newLiveTeam(t)
	codex, _ := lt.token(t, lt.owner, "Codex", "edit")
	owner := lt.h.request(t, lt.owner, "GET", "/auth/me", nil, 200)["user"].(map[string]any)["id"].(string)
	// Written while the clock was an hour ahead.
	if _, err := lt.h.db.Exec(context.Background(), `INSERT INTO canvas_live_messages(id,tenant_id,canvas_id,author_kind,user_id,node_id,text,created_at)
		VALUES('ahead-message-1',$1,$2,'human',$3,'','From a clock ahead',clock_timestamp()+interval '1 hour')`, lt.tid, lt.cid, owner); err != nil {
		t.Fatal(err)
	}
	if ahead, _ := lt.waitFor(t, codex, 10, nil); fmt.Sprint(texts(t, ahead["messages"])) != "[From a clock ahead]" {
		t.Fatalf("the message from a clock ahead: %v", ahead)
	}
	lt.say(t, "owner", "After the clock stepped back")
	if after, _ := lt.waitFor(t, codex, 10, nil); fmt.Sprint(texts(t, after["messages"])) != "[After the clock stepped back]" {
		t.Fatalf("a message written after the clock stepped back: %v", after)
	}
	// A token made then starts after the newest message, not at the clock's time.
	claude, _ := lt.token(t, lt.owner, "Claude Code", "edit")
	lt.say(t, "member", "For the new token")
	if fresh, _ := lt.waitFor(t, claude, 10, nil); fmt.Sprint(texts(t, fresh["messages"])) != "[For the new token]" {
		t.Fatalf("a token made after a clock ahead: %v", fresh)
	}
}

// A token made before tokens kept the newest message they were given starts at the newest message its canvas holds at
// its first read: none of the earlier ones comes again, and every later one comes.
func TestPostgresCanvasWaitOfAnOlderTokenRepeatsNothing(t *testing.T) {
	lt := newLiveTeam(t)
	codex, codexID := lt.token(t, lt.owner, "Codex", "edit")
	lt.say(t, "owner", "Said before the release")
	forget := func(team liveTeam, id string) {
		if _, err := team.h.db.Exec(context.Background(), "UPDATE canvas_agent_tokens SET seen_message_at=NULL,seen_message_id=NULL WHERE tenant_id=$1 AND id=$2", team.tid, id); err != nil {
			t.Fatal(err)
		}
	}
	forget(lt, codexID)
	// Its first reads may come at once (an agent's tools called side by side): each finds the cursor either set.
	var group sync.WaitGroup
	answers := make([]map[string]any, 4)
	for i := range answers {
		group.Add(1)
		go func() {
			defer group.Done()
			body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "canvas_wait", "arguments": map[string]any{"seconds": 1}}})
			r, _ := http.NewRequest("POST", lt.h.server.URL+"/api/v1/mcp", bytes.NewReader(body))
			r.Header.Set("Authorization", "Bearer "+codex)
			r.Header.Set("Content-Type", "application/json")
			if resp, err := http.DefaultClient.Do(r); err == nil {
				_ = json.NewDecoder(resp.Body).Decode(&answers[i])
				resp.Body.Close()
			}
		}()
	}
	group.Wait()
	for i, answer := range answers {
		result, _ := answer["result"].(map[string]any)
		if result == nil || result["isError"] == true || len(result["structuredContent"].(map[string]any)["messages"].([]any)) != 0 {
			t.Fatalf("first read %d of an older token: %v", i, answer)
		}
	}
	lt.say(t, "owner", "Said after it")
	if later, _ := lt.waitFor(t, codex, 10, nil); fmt.Sprint(texts(t, later["messages"])) != "[Said after it]" {
		t.Fatalf("a message after an older token's first wait: %v", later)
	}
	// On an empty canvas such a token starts before every message (its first read, a wait of no time, sets it).
	other := newLiveTeam(t)
	token, id := other.token(t, other.owner, "Claude Code", "edit")
	forget(other, id)
	if set, _ := other.waitFor(t, token, 0, nil); set["lastMessage"] != mcpWaitStart {
		t.Fatalf("an older token's first read on an empty canvas: %v", set)
	}
	other.say(t, "member", "The first message")
	if first, _ := other.waitFor(t, token, 10, nil); !strings.Contains(fmt.Sprint(first["messages"]), "The first message") {
		t.Fatalf("an older token on an empty canvas: %v", first)
	}
}

// An agent's very first answer can be lost too: canvas_overview gives the position its first wait goes on from, on a
// canvas without messages (start) and on one with some, and asked again from it the wait gives the same.
func TestPostgresCanvasWaitGivesAgainALostFirstAnswer(t *testing.T) {
	for _, before := range []string{"", "Said before the token"} {
		lt := newLiveTeam(t)
		if before != "" {
			lt.say(t, "owner", before)
		}
		codex, _ := lt.token(t, lt.owner, "Codex", "edit")
		overview := lt.tool(t, codex, "canvas_overview", map[string]any{})
		anchor, _ := overview["lastMessage"].(string)
		if (before == "") != (anchor == mcpWaitStart) || anchor == "" {
			t.Fatalf("the overview's lastMessage %q with %q before the token", anchor, before)
		}
		lt.say(t, "owner", "One")
		given, _ := lt.waitFor(t, codex, 10, map[string]any{"afterMessage": anchor})
		// Lost on its way: asked again after the same position, the wait gives the same.
		again, _ := lt.waitFor(t, codex, 10, map[string]any{"afterMessage": anchor})
		if fmt.Sprint(texts(t, given["messages"])) != "[One]" || fmt.Sprint(texts(t, again["messages"])) != "[One]" || again["lastMessage"] == mcpWaitStart ||
			again["fromOldest"] != nil {
			t.Fatalf("the first message, twice (%q before): %v then %v", before, given, again)
		}
	}
}

// A message that goes with its author's account takes no stamp below a cursor a token was given: the next message is
// stamped after it.
func TestPostgresCanvasWaitAfterAMessageThatWent(t *testing.T) {
	lt := newLiveTeam(t)
	codex, _ := lt.token(t, lt.owner, "Codex", "edit")
	// Written while the clock was an hour ahead, and given; then it goes (its author's account was deleted).
	if _, err := lt.h.db.Exec(context.Background(), `INSERT INTO canvas_live_messages(id,tenant_id,canvas_id,author_kind,user_id,node_id,text,created_at)
		VALUES('gone-message-1',$1,$2,'human',$3,'','From an account that goes',clock_timestamp()+interval '1 hour')`, lt.tid, lt.cid, lt.memberID); err != nil {
		t.Fatal(err)
	}
	if ahead, _ := lt.waitFor(t, codex, 10, nil); fmt.Sprint(texts(t, ahead["messages"])) != "[From an account that goes]" {
		t.Fatalf("the message ahead: %v", ahead)
	}
	if _, err := lt.h.db.Exec(context.Background(), "DELETE FROM canvas_live_messages WHERE id='gone-message-1'"); err != nil {
		t.Fatal(err)
	}
	lt.say(t, "owner", "After it went")
	if after, _ := lt.waitFor(t, codex, 10, nil); fmt.Sprint(texts(t, after["messages"])) != "[After it went]" {
		t.Fatalf("a message after one that went: %v", after)
	}
}
