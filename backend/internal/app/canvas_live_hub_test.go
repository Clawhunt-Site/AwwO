package app

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// One person who opens and closes pages under new ids holds at most as many participants as they may have streams:
// their own oldest page with no stream makes room, so they never fill a canvas for everyone else.
func TestCanvasLiveHubBoundsEachPersonsParticipants(t *testing.T) {
	var m canvasMultiplayer
	cycler := canvasActor{Kind: "human", UserID: "user-cycler", Name: "Cycler"}
	for i := 0; i < 3*liveParticipantsPerCanvas; i++ {
		cycler.ClientID = fmt.Sprintf("cycler-page-%03d", i)
		s, refused := m.open("t1", "c1", liveJoin{actor: cycler})
		if refused != "" {
			t.Fatalf("page %d refused: %s", i, refused)
		}
		m.close("t1", "c1", s)
	}
	if n := len(m.participants("t1", "c1")); n > liveStreamsPerUser {
		t.Fatalf("one person holds %d participants", n)
	}
	other := canvasActor{Kind: "human", UserID: "user-other", Name: "Other", ClientID: "other-page-1"}
	if _, refused := m.open("t1", "c1", liveJoin{actor: other}); refused != "" {
		t.Fatalf("someone else is refused: %s", refused)
	}
	// A person's open pages are never taken for room: with every allowed stream open, one more is refused.
	keeper := canvasActor{Kind: "human", UserID: "user-keeper", Name: "Keeper"}
	for i := 0; i < liveStreamsPerUser; i++ {
		keeper.ClientID = fmt.Sprintf("keeper-page-%03d", i)
		if _, refused := m.open("t1", "c1", liveJoin{actor: keeper}); refused != "" {
			t.Fatalf("keeper page %d refused: %s", i, refused)
		}
	}
	keeper.ClientID = "keeper-page-999"
	if _, refused := m.open("t1", "c1", liveJoin{actor: keeper}); refused != liveFull {
		t.Fatalf("a page past the streams: %q", refused)
	}
	// An agent's waits count in no stream limit, and its token's revocation ends them.
	agent := canvasActor{Kind: "agent", UserID: "user-other", TokenID: "0123456789abcdef", Name: "Claude Code"}
	var waits []*liveStream
	for i := 0; i < liveStreamsPerToken+2; i++ {
		s, _ := m.watch("t1", "c1", agent.TokenID)
		waits = append(waits, s)
	}
	if _, refused := m.open("t1", "c1", liveJoin{actor: agent}); refused != "" {
		t.Fatalf("the agent's stream beside its waits: %s", refused)
	}
	m.tokensRevoked([]revokedCanvasToken{{tenantID: "t1", canvasID: "c1", id: agent.TokenID}})
	for i, s := range waits {
		select {
		case e := <-s.events:
			for e.name != "bye" {
				e = <-s.events
			}
		default:
			t.Fatalf("wait %d heard no bye", i)
		}
	}
	if _, here := m.participant("t1", "c1", "t_"+agent.TokenID); here {
		t.Fatal("the revoked token is still on the canvas")
	}
}

// Someone who left leaves everyone's canvas once their grace has run out, at the next sweep a stream's ping makes.
func TestCanvasLiveHubSweepsTheDeparted(t *testing.T) {
	now := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	m := canvasMultiplayer{now: func() time.Time { return now }}
	stayer := canvasActor{Kind: "human", UserID: "user-a", Name: "A", ClientID: "page-aaaaaaaa"}
	leaver := canvasActor{Kind: "human", UserID: "user-b", Name: "B", ClientID: "page-bbbbbbbb"}
	a, _ := m.open("t1", "c1", liveJoin{actor: stayer})
	b, _ := m.open("t1", "c1", liveJoin{actor: leaver})
	m.close("t1", "c1", b)
	m.takePresence("t1", "c1", a, now)
	now = now.Add(livePageGrace + time.Second)
	m.sweepRoom("t1", "c1")
	if sent, _ := m.takePresence("t1", "c1", a, now); len(sent) != 1 || sent[0]["left"] != leaver.ClientID {
		t.Fatalf("A is told: %+v", sent)
	}
	if _, here := m.participant("t1", "c1", leaver.ClientID); here {
		t.Fatal("B is still on the canvas")
	}
}

// presenceOf gives the participant a stream is told of in what it has to send, if it is.
func presenceOf(sent []map[string]any, id string) (liveParticipant, bool) {
	for _, data := range sent {
		if p, ok := data["participant"].(liveParticipant); ok && p.ID == id {
			return p, true
		}
	}
	return liveParticipant{}, false
}

func liveAt(clock *time.Time) *canvasMultiplayer {
	return &canvasMultiplayer{now: func() time.Time { return *clock }}
}

// A stream is told of each participant who changed once, with their latest state, however often they moved; a page at
// eight a second is told of at once, a faster one at most every livePresenceEvery. Nothing of presence waits in a
// stream's events, so no amount of moving puts a stream behind (docs/awwo-canvas-live-collaboration.md).
func TestCanvasLiveHubSendsEachStreamTheLatestPresence(t *testing.T) {
	now := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	m := liveAt(&now)
	watcher, _ := m.open("t1", "c1", liveJoin{actor: canvasActor{Kind: "human", UserID: "user-w", Name: "W", ClientID: "page-wwwwwwww"}})
	var movers []canvasActor
	for i := 0; i < 20; i++ {
		mover := canvasActor{Kind: "human", UserID: fmt.Sprintf("user-%02d", i), Name: "M", ClientID: fmt.Sprintf("page-mover-%02d", i)}
		if _, refused := m.open("t1", "c1", liveJoin{actor: mover, role: "member"}); refused != "" {
			t.Fatal(refused)
		}
		movers = append(movers, mover)
	}
	select {
	case <-watcher.nudge:
	default:
		t.Fatal("the watcher's stream was not woken")
	}
	// Twenty people, each moving 8 times a second for 10 seconds: 1,600 updates.
	for second := 0; second < 10; second++ {
		for step := 0; step < 8; step++ {
			for i, mover := range movers {
				x := float64(second*100 + step*10 + i)
				update, err := parseLiveState(map[string]json.RawMessage{"cursor": json.RawMessage(fmt.Sprintf(`{"x":%v,"y":1}`, x))}, false, true)
				if err != nil {
					t.Fatal(err)
				}
				if got := m.setState("t1", "c1", mover, "member", 0, update); got != liveStateSet {
					t.Fatalf("update %d/%d of %d: %d", second, step, i, got)
				}
			}
			now = now.Add(125 * time.Millisecond)
		}
	}
	if n := len(watcher.events); n != 0 {
		t.Fatalf("%d presence events queued", n)
	}
	sent, wait := m.takePresence("t1", "c1", watcher, now)
	if len(sent) != len(movers) || wait != 0 {
		t.Fatalf("the watcher is told %d participants, want %d", len(sent), len(movers))
	}
	for i, mover := range movers {
		p, ok := presenceOf(sent, mover.ClientID)
		if !ok || p.State.Cursor == nil || p.State.Cursor.X != float64(900+70+i) {
			t.Fatalf("mover %d: %+v", i, p.State.Cursor)
		}
	}
	if again, _ := m.takePresence("t1", "c1", watcher, now); len(again) != 0 {
		t.Fatalf("told twice: %+v", again)
	}
	// Moving again at once, a mover is told of when livePresenceEvery has passed since the stream last told of them,
	// once, with the latest of their moves; one 125 ms later (eight a second) is told of at once.
	cursor := func(x int) liveUpdate {
		update, _ := parseLiveState(map[string]json.RawMessage{"cursor": json.RawMessage(fmt.Sprintf(`{"x":%d,"y":2}`, x))}, false, true)
		return update
	}
	at := now
	m.setState("t1", "c1", movers[0], "member", 0, cursor(1))
	m.setState("t1", "c1", movers[0], "member", 0, cursor(2))
	if held, wait := m.takePresence("t1", "c1", watcher, at.Add(30*time.Millisecond)); len(held) != 0 || wait != livePresenceEvery-30*time.Millisecond {
		t.Fatalf("too soon: %+v, wait %v", held, wait)
	}
	if due, _ := m.takePresence("t1", "c1", watcher, at.Add(livePresenceEvery)); len(due) != 1 {
		t.Fatalf("when due: %+v", due)
	} else if p, _ := presenceOf(due, movers[0].ClientID); p.State.Cursor == nil || p.State.Cursor.X != 2 {
		t.Fatalf("not the latest: %+v", p.State.Cursor)
	}
	m.setState("t1", "c1", movers[1], "member", 0, cursor(3))
	if due, _ := m.takePresence("t1", "c1", watcher, at.Add(125*time.Millisecond)); len(due) != 1 {
		t.Fatalf("eight a second is held back: %+v", due)
	}
	// A hello says how things are: what waited to go goes with it.
	update, _ := parseLiveState(map[string]json.RawMessage{"status": json.RawMessage(`"Moving"`)}, false, true)
	m.setState("t1", "c1", movers[0], "member", 0, update)
	if participants, you := m.greet("t1", "c1", watcher); len(participants) != len(movers)+1 || you.ID != "page-wwwwwwww" {
		t.Fatalf("hello: %d participants, you %q", len(participants), you.ID)
	}
	if after, _ := m.takePresence("t1", "c1", watcher, now); len(after) != 0 {
		t.Fatalf("after the hello: %+v", after)
	}
}

// More than ten updates in one second are refused, so the page sends its latest again; the next second takes them.
func TestCanvasLiveHubRefusesPresencePastItsPace(t *testing.T) {
	now := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	m := liveAt(&now)
	actor := canvasActor{Kind: "human", UserID: "user-a", Name: "A", ClientID: "page-aaaaaaaa"}
	if got := m.setState("t1", "c1", actor, "member", 0, liveUpdate{apply: func(*liveState) {}}); got != liveStateAbsent {
		t.Fatalf("a page with no stream: %d", got)
	}
	m.open("t1", "c1", liveJoin{actor: actor})
	for i := 0; i < livePresencePerSecond; i++ {
		if got := m.setState("t1", "c1", actor, "member", 0, liveUpdate{apply: func(*liveState) {}}); got != liveStateSet {
			t.Fatalf("update %d: %d", i, got)
		}
	}
	if got := m.setState("t1", "c1", actor, "member", 0, liveUpdate{apply: func(*liveState) {}}); got != liveStateTooFast {
		t.Fatalf("the eleventh: %d", got)
	}
	now = now.Add(time.Second)
	if got := m.setState("t1", "c1", actor, "member", 0, liveUpdate{apply: func(*liveState) {}}); got != liveStateSet {
		t.Fatalf("the next second: %d", got)
	}
	// Someone else's page id moves nothing.
	other := canvasActor{Kind: "human", UserID: "user-b", Name: "B", ClientID: actor.ClientID}
	if got := m.setState("t1", "c1", other, "member", 0, liveUpdate{apply: func(*liveState) {}}); got != liveStateAbsent {
		t.Fatalf("a copied page id: %d", got)
	}
}

// Each person (all their pages) and each token wears a colour no one else on the canvas wears, up to twelve; it is freed
// when their last page has left.
func TestCanvasLiveHubGivesEachPersonTheirOwnColour(t *testing.T) {
	now := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	m := liveAt(&now)
	colourOf := func(id string) string {
		p, ok := m.participant("t1", "c1", id)
		if !ok {
			t.Fatalf("%s is not on the canvas", id)
		}
		return p.Color
	}
	worn := map[string]string{}
	var streams []*liveStream
	for i := 0; i < len(liveParticipantColors); i++ {
		person := canvasActor{Kind: "human", UserID: fmt.Sprintf("user-%02d", i), Name: "P", ClientID: fmt.Sprintf("page-person-%02d", i)}
		s, _ := m.open("t1", "c1", liveJoin{actor: person})
		streams = append(streams, s)
		color := colourOf(person.ClientID)
		if who, taken := worn[color]; taken {
			t.Fatalf("%s wears %s, as %s does", person.UserID, color, who)
		}
		worn[color] = person.UserID
	}
	// A second tab of a person wears their colour.
	tab := canvasActor{Kind: "human", UserID: "user-03", Name: "P", ClientID: "page-person-03-b"}
	m.open("t1", "c1", liveJoin{actor: tab})
	if colourOf(tab.ClientID) != colourOf("page-person-03") {
		t.Fatal("a person's two tabs wear two colours")
	}
	// The thirteenth wears their own, shared: twelve are unique.
	thirteenth := canvasActor{Kind: "agent", UserID: "user-00", TokenID: "0123456789abcdef", Name: "Claude Code"}
	m.open("t1", "c1", liveJoin{actor: thirteenth})
	if colourOf("t_0123456789abcdef") != liveColor("t_0123456789abcdef") {
		t.Fatal("the thirteenth does not wear their own colour")
	}
	// Person 5 leaves: once their grace has run out their colour is free, and the next person who wants it wears it.
	freed := colourOf("page-person-05")
	m.close("t1", "c1", streams[5])
	now = now.Add(livePageGrace + time.Second)
	m.sweepRoom("t1", "c1")
	var newcomer canvasActor
	for i := 0; ; i++ {
		newcomer = canvasActor{Kind: "human", UserID: fmt.Sprintf("newcomer-%d", i), Name: "N", ClientID: fmt.Sprintf("page-newcomer-%d", i)}
		if liveColor(colorKey(newcomer)) == freed {
			break
		}
	}
	m.open("t1", "c1", liveJoin{actor: newcomer})
	if colourOf(newcomer.ClientID) != freed {
		t.Fatalf("the newcomer wears %s, not the freed %s", colourOf(newcomer.ClientID), freed)
	}
}

// An edit in progress shows until livePreviewFor after its last update, and goes with its page's last stream, as its
// pointer and the field it was typing in do; a page says what it runs in and its role as it is now.
func TestCanvasLiveHubPreviewsEndWithTheirTimeAndTheirPage(t *testing.T) {
	now := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	m := liveAt(&now)
	actor := canvasActor{Kind: "human", UserID: "user-a", Name: "A", ClientID: "page-aaaaaaaa"}
	s, _ := m.open("t1", "c1", liveJoin{actor: actor, role: "reader", device: "phone"})
	state := map[string]json.RawMessage{
		"preview":  json.RawMessage(`{"nodes":[{"id":"n1","x":10,"y":20}]}`),
		"editing":  json.RawMessage(`{"node":"n1","field":"title"}`),
		"cursor":   json.RawMessage(`{"x":1,"y":2}`),
		"viewport": json.RawMessage(`{"x":0,"y":0,"w":1200,"h":800}`),
	}
	update, err := parseLiveState(state, false, true)
	if err != nil {
		t.Fatal(err)
	}
	m.setState("t1", "c1", actor, "member", 0, update)
	p, _ := m.participant("t1", "c1", actor.ClientID)
	if p.State.Preview == nil || p.State.Editing == nil || p.Role != "member" || p.Device != "phone" {
		t.Fatalf("participant: %+v", p)
	}
	now = now.Add(livePreviewFor + time.Millisecond)
	if p, _ = m.participant("t1", "c1", actor.ClientID); p.State.Preview != nil || p.State.Editing == nil {
		t.Fatalf("past its time the preview stays, or the editing went: %+v", p.State)
	}
	// Made a reader by the stream's check, the person loses the editing mark (a reader's post cannot take it back).
	m.setRole("t1", "c1", actor, "reader", 0)
	if p, _ = m.participant("t1", "c1", actor.ClientID); p.State.Editing != nil || p.Role != "reader" || p.State.Cursor == nil {
		t.Fatalf("made a reader: %+v", p)
	}
	m.setRole("t1", "c1", actor, "member", 0)
	editing, _ := parseLiveState(map[string]json.RawMessage{"editing": json.RawMessage(`{"node":"n1","field":"title"}`)}, false, true)
	m.setState("t1", "c1", actor, "member", 0, editing)
	// …and so by a post that finds them a reader.
	reader, _ := parseLiveState(map[string]json.RawMessage{"cursor": json.RawMessage(`{"x":3,"y":3}`)}, false, false)
	m.setState("t1", "c1", actor, "reader", 0, reader)
	if p, _ = m.participant("t1", "c1", actor.ClientID); p.State.Editing != nil || p.Role != "reader" {
		t.Fatalf("a post as a reader: %+v", p)
	}
	m.close("t1", "c1", s)
	p, _ = m.participant("t1", "c1", actor.ClientID)
	if p.State.Cursor != nil || p.State.Editing != nil || p.State.Viewport == nil || p.Role != "reader" {
		t.Fatalf("after its page's stream closed: %+v", p)
	}
	// A post that comes after the page's last stream closed moves nothing: it would outlive the page.
	late, _ := parseLiveState(map[string]json.RawMessage{"cursor": json.RawMessage(`{"x":9,"y":9}`)}, false, true)
	if got := m.setState("t1", "c1", actor, "member", 0, late); got != liveStateAbsent {
		t.Fatalf("a post after the stream closed: %d", got)
	}
	if p, _ = m.participant("t1", "c1", actor.ClientID); p.State.Cursor != nil {
		t.Fatalf("a late post put the pointer back: %+v", p.State.Cursor)
	}
}

// What a participant may show: a reader's and a token's previews and editing marks are dropped (the rest of what they
// send is kept); an agent has no pointer and no screen; a malformed part is refused.
func TestCanvasLivePresenceParts(t *testing.T) {
	apply := func(state map[string]json.RawMessage, agent, editor bool) liveState {
		t.Helper()
		update, err := parseLiveState(state, agent, editor)
		if err != nil {
			t.Fatal(err)
		}
		var s liveState
		update.apply(&s)
		return s
	}
	all := map[string]json.RawMessage{
		"selection": json.RawMessage(`["n1"]`),
		"cursor":    json.RawMessage(`{"x":1,"y":2}`),
		"preview":   json.RawMessage(`{"resize":{"id":"n1","x":0,"y":0,"w":300,"h":200},"wire":{"node":"n1","port":"result","side":"output","from":{"x":1,"y":1},"to":{"x":9,"y":9}}}`),
		"editing":   json.RawMessage(`{"node":"n1","field":"form.q.label"}`),
		"viewport":  json.RawMessage(`{"x":-50,"y":10,"w":800,"h":600}`),
	}
	if s := apply(all, false, true); s.Preview == nil || s.Preview.Resize == nil || s.Preview.Wire == nil || s.Editing == nil || s.Viewport == nil || s.Cursor == nil {
		t.Fatalf("an editor's: %+v", s)
	}
	if s := apply(all, false, false); s.Preview != nil || s.Editing != nil || s.Viewport == nil || s.Cursor == nil || len(s.Selection) != 1 {
		t.Fatalf("a reader's: %+v", s)
	}
	if s := apply(all, true, true); s.Preview != nil || s.Editing != nil || s.Viewport != nil || s.Cursor != nil || len(s.Selection) != 1 {
		t.Fatalf("an agent's: %+v", s)
	}
	if update, _ := parseLiveState(map[string]json.RawMessage{"preview": json.RawMessage(`{"nodes":[]}`)}, false, true); update.preview {
		t.Fatal("an empty preview renews its time")
	}
	many := `{"nodes":[`
	for i := 0; i <= livePreviewNodesMax; i++ {
		if i > 0 {
			many += ","
		}
		many += fmt.Sprintf(`{"id":"n%d","x":0,"y":0}`, i)
	}
	many += `]}`
	for _, bad := range []map[string]json.RawMessage{
		{"preview": json.RawMessage(many)},
		{"preview": json.RawMessage(`{"nodes":[{"id":"","x":0,"y":0}]}`)},
		{"preview": json.RawMessage(`{"resize":{"id":"n1","x":0,"y":0,"w":0,"h":10}}`)},
		{"preview": json.RawMessage(`{"wire":{"node":"n1","port":"p","side":"sideways","from":{"x":0,"y":0},"to":{"x":0,"y":0}}}`)},
		{"preview": json.RawMessage(`{"nodes":[{"id":"n1","x":1e9,"y":0}]}`)},
		{"editing": json.RawMessage(`{"node":"n1","field":"a field with spaces"}`)},
		{"viewport": json.RawMessage(`{"x":0,"y":0,"w":-1,"h":10}`)},
		{"waving": json.RawMessage(`true`)},
	} {
		// Refused whoever sends it: a reader's malformed preview is malformed too.
		if _, err := parseLiveState(bad, false, false); err == nil {
			t.Fatalf("accepted: %s", bad)
		}
	}
}

// A checked session is trusted for presence posts for livePresenceTrust, in its own workspace only, and no longer once
// it signed out or the person left the workspace.
func TestCanvasLivePresenceTrustEnds(t *testing.T) {
	now := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	s := presenceSessions{now: func() time.Time { return now }}
	key := presenceKey("hash-1", "tenant-1")
	s.remember(key, presenceTrust{user: User{ID: "user-1"}, role: "member"}, s.begin())
	if e, ok := s.lookup(key); !ok || e.role != "member" {
		t.Fatal("not trusted at once")
	}
	if _, ok := s.lookup(presenceKey("hash-1", "tenant-2")); ok {
		t.Fatal("trusted in another workspace")
	}
	now = now.Add(livePresenceTrust - time.Millisecond)
	if _, ok := s.lookup(key); !ok {
		t.Fatal("not trusted within its window")
	}
	now = now.Add(time.Millisecond)
	if _, ok := s.lookup(key); ok {
		t.Fatal("trusted past its window")
	}
	s.remember(key, presenceTrust{user: User{ID: "user-1"}}, s.begin())
	s.remember(presenceKey("hash-1", "tenant-2"), presenceTrust{user: User{ID: "user-1"}}, s.begin())
	s.forget("hash-1")
	if _, ok := s.lookup(key); ok {
		t.Fatal("trusted after signing out")
	}
	s.remember(key, presenceTrust{user: User{ID: "user-1"}}, s.begin())
	s.remember(presenceKey("hash-2", "tenant-1"), presenceTrust{user: User{ID: "user-2"}}, s.begin())
	s.forgetMember("tenant-1", "user-1")
	if _, ok := s.lookup(key); ok {
		t.Fatal("trusted after leaving the workspace")
	}
	if _, ok := s.lookup(presenceKey("hash-2", "tenant-1")); !ok {
		t.Fatal("someone else's trust ended too")
	}
	// Bounded: past livePresenceTrusted sessions, a new one is checked in full every time.
	for i := 0; i < livePresenceTrusted+10; i++ {
		s.remember(presenceKey(fmt.Sprintf("bulk-%d", i), "tenant-1"), presenceTrust{}, s.begin())
	}
	if len(s.entries) > livePresenceTrusted {
		t.Fatalf("%d sessions trusted", len(s.entries))
	}
	// A check that was running when a session signed out (or its person left) is not remembered when it ends: it read
	// what is gone since.
	fresh := presenceSessions{now: func() time.Time { return now }}
	running := fresh.begin()
	fresh.forget("hash-9")
	fresh.remember(presenceKey("hash-9", "tenant-1"), presenceTrust{user: User{ID: "user-9"}}, running)
	if _, ok := fresh.lookup(presenceKey("hash-9", "tenant-1")); ok {
		t.Fatal("a check begun before a sign-out is trusted after it")
	}
	running = fresh.begin()
	fresh.forgetMember("tenant-1", "user-9")
	fresh.remember(presenceKey("hash-9", "tenant-1"), presenceTrust{user: User{ID: "user-9"}}, running)
	if _, ok := fresh.lookup(presenceKey("hash-9", "tenant-1")); ok {
		t.Fatal("a check begun before a removal is trusted after it")
	}
}

// A page that comes back (another stream under the same id) as a reader keeps no edit in progress or editing mark.
func TestCanvasLiveHubReopenedAsAReaderDropsEdits(t *testing.T) {
	now := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	m := liveAt(&now)
	actor := canvasActor{Kind: "human", UserID: "user-b", Name: "B", ClientID: "page-bbbbbbbb"}
	first, _ := m.open("t1", "c1", liveJoin{actor: actor, role: "member", device: "browser"})
	editing, err := parseLiveState(map[string]json.RawMessage{
		"editing": json.RawMessage(`{"node":"n1","field":"title"}`),
		"preview": json.RawMessage(`{"nodes":[{"id":"n1","x":10,"y":20}]}`),
	}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	m.setState("t1", "c1", actor, "member", 0, editing)
	if p, _ := m.participant("t1", "c1", actor.ClientID); p.State.Editing == nil || p.State.Preview == nil {
		t.Fatalf("an editor's: %+v", p.State)
	}
	second, _ := m.open("t1", "c1", liveJoin{actor: actor, role: "reader", device: "browser"})
	if p, _ := m.participant("t1", "c1", actor.ClientID); p.Role != "reader" || p.State.Editing != nil || p.State.Preview != nil {
		t.Fatalf("reopened as a reader: %+v", p)
	}
	m.close("t1", "c1", first)
	m.close("t1", "c1", second)
}

// byesOf takes what waits in a stream's queue and gives the reasons of the byes in it, and how many other events.
func byesOf(s *liveStream) (byes []string, others int) {
	for {
		select {
		case e := <-s.events:
			if e.name != "bye" {
				others++
				continue
			}
			byes = append(byes, e.data.(map[string]any)["reason"].(string))
		default:
			return byes, others
		}
	}
}

// A person removed from a workspace (or gone from it) is acted on at once, not at their stream's own check: each of
// their streams there ends with one bye access and is told nothing more, and every page of theirs leaves its canvas at
// once, those still in their grace too, so everyone else is told they left. Their streams in another workspace and their
// agent tokens (tokensRevoked's) stay.
func TestCanvasLiveHubEndsARemovedPersonsStreamsAtOnce(t *testing.T) {
	now := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	m := liveAt(&now)
	owner := canvasActor{Kind: "human", UserID: "user-owner", Name: "O", ClientID: "page-owner-1"}
	removed := canvasActor{Kind: "human", UserID: "user-removed", Name: "R", ClientID: "page-removed-1"}
	watcher, _ := m.open("t1", "c1", liveJoin{actor: owner, role: "owner"})
	first, _ := m.open("t1", "c1", liveJoin{actor: removed, role: "member"})
	onOther := removed
	onOther.ClientID = "page-removed-2"
	second, _ := m.open("t1", "c2", liveJoin{actor: onOther, role: "member"})
	// A page of theirs closed a moment ago, in its 30 s grace, and one in another workspace.
	closed := removed
	closed.ClientID = "page-removed-3"
	gracing, _ := m.open("t1", "c1", liveJoin{actor: closed, role: "member"})
	m.close("t1", "c1", gracing)
	elsewhere := removed
	elsewhere.ClientID = "page-removed-4"
	away, _ := m.open("t2", "c9", liveJoin{actor: elsewhere, role: "owner"})
	// An agent token they made: its own participant, which only its revocation takes off.
	agent := canvasActor{Kind: "agent", UserID: "user-removed", TokenID: "0123456789abcdef", Name: "Claude Code"}
	m.open("t1", "c1", liveJoin{actor: agent})
	for _, s := range []*liveStream{watcher, first} {
		if _, wait := m.takePresence("t1", "c1", s, now); wait != 0 {
			t.Fatalf("held: %v", wait)
		}
	}
	removedColour := m.rooms[canvasKey{"t1", "c1"}].colors[colorKey(removed)]
	m.membersChanged("t1", "user-removed", "")
	for i, s := range []*liveStream{first, second} {
		if m.takeBye(s) != "access" {
			t.Fatalf("stream %d: bye %q", i, m.takeBye(s))
		}
		if byes, _ := byesOf(s); fmt.Sprint(byes) != "[access]" {
			t.Fatalf("stream %d is told %v", i, byes)
		}
	}
	for _, page := range []canvasActor{removed, closed} {
		if _, here := m.participant("t1", "c1", page.ClientID); here {
			t.Fatalf("%s is still on the canvas", page.ClientID)
		}
	}
	if _, here := m.participant("t1", "c2", onOther.ClientID); here {
		t.Fatal("their page on the other canvas is still there")
	}
	if m.takeBye(away) != "" {
		t.Fatal("their stream in another workspace ended")
	}
	if _, here := m.participant("t2", "c9", elsewhere.ClientID); !here {
		t.Fatal("their page in another workspace went")
	}
	if _, here := m.participant("t1", "c1", "t_"+agent.TokenID); !here {
		t.Fatal("their agent token's participant went with them")
	}
	// Everyone else is told at once that both pages left, not once the grace is over.
	sent, wait := m.takePresence("t1", "c1", watcher, now)
	left := map[any]bool{}
	for _, data := range sent {
		left[data["left"]] = true
	}
	if !left[removed.ClientID] || !left[closed.ClientID] || wait != 0 {
		t.Fatalf("the owner is told %+v (wait %v)", sent, wait)
	}
	if _, worn := m.rooms[canvasKey{"t1", "c1"}].colors[colorKey(removed)]; worn || removedColour == "" {
		t.Fatalf("their colour %q is still held", removedColour)
	}
	// Nothing more reaches their ending streams: not someone's move, a claim or a message.
	moved, _ := parseLiveState(map[string]json.RawMessage{"cursor": json.RawMessage(`{"x":4,"y":4}`)}, false, true)
	m.setState("t1", "c1", owner, "owner", m.memberCount(), moved)
	m.claimsChanged("t1", "c1")
	m.message("t1", "c1", liveMessage{ID: "m1", Text: "after the removal"})
	if len(first.pending) != 0 {
		t.Fatalf("an ending stream is told of presence: %v", first.pending)
	}
	if byes, others := byesOf(first); len(byes) != 0 || others != 0 {
		t.Fatalf("an ending stream is sent %v and %d more", byes, others)
	}
	if byes, others := byesOf(watcher); len(byes) != 0 || others != 2 {
		t.Fatalf("the owner's stream: %v and %d events", byes, others)
	}
	// A second bye (as a revocation would send) neither changes the reason nor is queued again.
	m.bye(func(s *liveStream) bool { return s == first }, "revoked")
	if m.takeBye(first) != "access" {
		t.Fatalf("the reason became %q", m.takeBye(first))
	}
	if byes, _ := byesOf(first); len(byes) != 0 {
		t.Fatalf("told again: %v", byes)
	}
	// Their streams close as streams do; no page of theirs comes back for a grace.
	m.close("t1", "c1", first)
	m.close("t1", "c2", second)
	if _, here := m.participant("t1", "c1", removed.ClientID); here {
		t.Fatal("their page came back when its stream closed")
	}
	if _, open := m.rooms[canvasKey{"t1", "c2"}]; open {
		t.Fatal("the canvas nobody is on is still held")
	}
}

// A person given another role shows it on every canvas of the workspace at once, with no post of theirs; made a reader,
// their edit in progress and editing mark go there too. Their streams go on.
func TestCanvasLiveHubShowsANewRoleAtOnce(t *testing.T) {
	now := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	m := liveAt(&now)
	owner := canvasActor{Kind: "human", UserID: "user-owner", Name: "O", ClientID: "page-owner-1"}
	member := canvasActor{Kind: "human", UserID: "user-member", Name: "M", ClientID: "page-member-1"}
	watcher, _ := m.open("t1", "c1", liveJoin{actor: owner, role: "owner"})
	own, _ := m.open("t1", "c1", liveJoin{actor: member, role: "member"})
	elsewhere := member
	elsewhere.ClientID = "page-member-2"
	m.open("t1", "c2", liveJoin{actor: elsewhere, role: "member"})
	editing, err := parseLiveState(map[string]json.RawMessage{
		"editing": json.RawMessage(`{"node":"n1","field":"title"}`),
		"preview": json.RawMessage(`{"nodes":[{"id":"n1","x":10,"y":20}]}`),
		"cursor":  json.RawMessage(`{"x":1,"y":2}`),
	}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	before := m.memberCount()
	m.setState("t1", "c1", member, "member", before, editing)
	m.setState("t1", "c2", elsewhere, "member", before, editing)
	m.greet("t1", "c1", watcher)
	m.greet("t1", "c1", own)
	m.membersChanged("t1", "user-member", "reader")
	for _, at := range []struct{ canvas, id string }{{"c1", member.ClientID}, {"c2", elsewhere.ClientID}} {
		p, _ := m.participant("t1", at.canvas, at.id)
		if p.Role != "reader" || p.State.Preview != nil || p.State.Editing != nil || p.State.Cursor == nil {
			t.Fatalf("on %s: %+v", at.canvas, p)
		}
	}
	// The owner and the person's own page are told at once, and the person's stream goes on.
	for name, s := range map[string]*liveStream{"owner": watcher, "own": own} {
		sent, _ := m.takePresence("t1", "c1", s, now)
		if p, ok := presenceOf(sent, member.ClientID); !ok || p.Role != "reader" || p.State.Editing != nil {
			t.Fatalf("the %s stream is told %+v", name, sent)
		}
	}
	if m.takeBye(own) != "" {
		t.Fatal("a new role ended the stream")
	}
	// A post or a stream's check that read the role before the change does not put the old one back, nor the edits.
	m.setState("t1", "c1", member, "member", before, editing)
	m.setRole("t1", "c1", member, "member", before)
	if p, _ := m.participant("t1", "c1", member.ClientID); p.Role != "reader" || p.State.Preview != nil || p.State.Editing != nil {
		t.Fatalf("a stale read undid the change: %+v", p)
	}
	// One that read it after shows what it read; so does a later change, which nothing stale undoes either.
	m.setRole("t1", "c1", member, "member", m.memberCount())
	if p, _ := m.participant("t1", "c1", member.ClientID); p.Role != "member" {
		t.Fatalf("a fresh check: %+v", p)
	}
	m.membersChanged("t1", "user-member", "admin")
	m.setState("t1", "c2", elsewhere, "member", before, editing)
	if p, _ := m.participant("t1", "c2", elsewhere.ClientID); p.Role != "admin" {
		t.Fatalf("made an admin: %+v", p)
	}
	// Someone else's change, or theirs in another workspace, leaves a read of the person's role as it is.
	since := m.memberCount()
	m.membersChanged("t1", "user-other", "reader")
	m.membersChanged("t2", "user-member", "reader")
	m.setRole("t1", "c1", member, "reader", since)
	if p, _ := m.participant("t1", "c1", member.ClientID); p.Role != "reader" {
		t.Fatalf("another's change hid this one's: %+v", p)
	}
}

// A person's stream opens only on a role read after their last membership change (as membersChanged acts on the streams
// already open, none passes it by): one read before is refused, to be read again. Someone else's change, theirs in
// another workspace, or an agent's stream are not held up; a count too old to tell is refused.
func TestCanvasLiveHubRefusesAStreamOpenedOnAStaleRole(t *testing.T) {
	var m canvasMultiplayer
	person := canvasActor{Kind: "human", UserID: "user-p", Name: "P", ClientID: "page-pppppppp"}
	read := m.memberCount()
	m.membersChanged("t1", "user-p", "")
	if s, refused := m.open("t1", "c1", liveJoin{actor: person, role: "member", since: read}); s != nil || refused != liveStale {
		t.Fatalf("opened on a role read before the removal: %q", refused)
	}
	if _, here := m.participant("t1", "c1", person.ClientID); here {
		t.Fatal("a refused stream left a participant")
	}
	read = m.memberCount()
	m.membersChanged("t1", "user-q", "reader")
	m.membersChanged("t2", "user-p", "reader")
	if _, refused := m.open("t1", "c1", liveJoin{actor: person, role: "member", since: read}); refused != "" {
		t.Fatalf("held up by someone else's change: %q", refused)
	}
	agent := canvasActor{Kind: "agent", UserID: "user-p", TokenID: "0123456789abcdef", Name: "Claude Code"}
	read = m.memberCount()
	m.membersChanged("t1", "user-p", "admin")
	if _, refused := m.open("t1", "c1", liveJoin{actor: agent, since: read}); refused != "" {
		t.Fatalf("an agent's stream: %q", refused)
	}
	read = m.memberCount()
	for i := 0; i <= liveMemberChangesKept; i++ {
		m.membersChanged("t1", fmt.Sprintf("user-%d", i), "member")
	}
	second := person
	second.ClientID = "page-pppp-two"
	if _, refused := m.open("t1", "c1", liveJoin{actor: second, role: "member", since: read}); refused != liveStale {
		t.Fatalf("a count too old to tell: %q", refused)
	}
	if _, refused := m.open("t1", "c1", liveJoin{actor: second, role: "member", since: m.memberCount()}); refused != "" {
		t.Fatalf("a fresh read: %q", refused)
	}
}

// A page taken off a canvas while its stream was still open (its person removed) is not the page of whoever uses its id
// next: the old stream, closing, lets go of its own page only, so the new one keeps its stream, its presence and its
// place past the grace. The id is seen by everyone, so the next one may be someone else's page, or the person's own once
// they are back in the workspace.
func TestCanvasLiveHubAReusedPageIDKeepsItsStream(t *testing.T) {
	for _, next := range []canvasActor{
		{Kind: "human", UserID: "user-other", Name: "B", ClientID: "page-shared-id"},
		{Kind: "human", UserID: "user-removed", Name: "R", ClientID: "page-shared-id"},
	} {
		now := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
		m := liveAt(&now)
		removed := canvasActor{Kind: "human", UserID: "user-removed", Name: "R", ClientID: "page-shared-id"}
		old, _ := m.open("t1", "c1", liveJoin{actor: removed, role: "member"})
		m.membersChanged("t1", "user-removed", "")
		fresh, refused := m.open("t1", "c1", liveJoin{actor: next, role: "member", since: m.memberCount()})
		if refused != "" {
			t.Fatalf("%s: the id is refused: %q", next.UserID, refused)
		}
		m.close("t1", "c1", old)
		p, here := m.participant("t1", "c1", next.ClientID)
		if !here || p.UserID != next.UserID || p.streams != 1 || !p.goneAt.IsZero() {
			t.Fatalf("%s: the new page after the old stream closed: %+v", next.UserID, p)
		}
		// The old stream's 15 s check, run late, sets no role on a page it does not hold.
		if next.UserID != removed.UserID {
			m.setRole("t1", "c1", removed, "reader", m.memberCount())
			if p, _ := m.participant("t1", "c1", next.ClientID); p.Role != "member" {
				t.Fatalf("%s: the old stream's check set the new page's role: %+v", next.UserID, p)
			}
		}
		moved, _ := parseLiveState(map[string]json.RawMessage{"cursor": json.RawMessage(`{"x":7,"y":7}`)}, false, true)
		if got := m.setState("t1", "c1", next, "member", m.memberCount(), moved); got != liveStateSet {
			t.Fatalf("%s: the new page's presence: %d", next.UserID, got)
		}
		now = now.Add(livePageGrace + time.Second)
		m.sweepRoom("t1", "c1")
		if _, here := m.participant("t1", "c1", next.ClientID); !here {
			t.Fatalf("%s: the new page was swept with its stream open", next.UserID)
		}
		m.close("t1", "c1", fresh)
		if p, _ := m.participant("t1", "c1", next.ClientID); p.streams != 0 || p.goneAt.IsZero() {
			t.Fatalf("%s: the new page's own stream closed: %+v", next.UserID, p)
		}
	}
}
