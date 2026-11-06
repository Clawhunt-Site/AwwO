package app

import (
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
	for drained := false; !drained; {
		select {
		case <-a.events:
		default:
			drained = true
		}
	}
	now = now.Add(livePageGrace + time.Second)
	m.sweepRoom("t1", "c1")
	select {
	case e := <-a.events:
		if e.name != "presence" || e.data.(map[string]any)["left"] != leaver.ClientID {
			t.Fatalf("event: %+v", e)
		}
	default:
		t.Fatal("no one heard that B left")
	}
	if _, here := m.participant("t1", "c1", leaver.ClientID); here {
		t.Fatal("B is still on the canvas")
	}
}
