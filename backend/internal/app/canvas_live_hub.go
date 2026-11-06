package app

import (
	"hash/fnv"
	"net/http"
	"sort"
	"sync"
	"time"
)

// The live state of the canvases people and agents have open (docs/awwo-canvas-live-collaboration.md): which streams
// to wake when a canvas changes, who is on each canvas, and what canvas agent tokens may still do this minute. The API
// is one process (its database lock), so this is the whole site's; it lives in memory only: changes, claims and
// messages are durable in PostgreSQL, and after a restart every page and agent connects again and says who it is.

const (
	// livePageGrace is how long a page stays on a canvas after its last stream closed, so a reconnect does not flicker;
	// liveAgentGrace how long an agent stays after its last request when it holds no stream.
	livePageGrace  = 30 * time.Second
	liveAgentGrace = 90 * time.Second
	// liveParticipantsPerCanvas bounds the participants of one canvas, and liveStreamsPerUser one person's streams
	// on one canvas (tabs), liveStreamsPerToken one token's.
	liveParticipantsPerCanvas = 64
	liveStreamsPerUser        = 8
	liveStreamsPerToken       = 4
	// liveEventBuffer is how many presence, claims and message events wait for one stream; a stream that falls further
	// behind is sent everyone again (a fresh hello) instead.
	liveEventBuffer = 256
	// livePresencePerSecond is how many presence updates a participant may send a second; more are dropped.
	livePresencePerSecond = 10
	// canvasTokenRequestsPerMinute is how many requests one canvas agent token may make a minute, and
	// canvasTokenFailuresPerMinute how many failed token lookups one address may make (as the relay's keys).
	canvasTokenRequestsPerMinute = 120
	canvasTokenFailuresPerMinute = 30
)

// liveParticipantColors are the participants' colours, the same for everyone: one is picked by the participant's id.
var liveParticipantColors = []string{"#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6",
	"#d6409f", "#978365", "#29a383", "#5b5bd6"}

func liveColor(id string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return liveParticipantColors[int(h.Sum32()%uint32(len(liveParticipantColors)))]
}

type canvasKey struct{ tenant, canvas string }

// liveState is what a participant shows: the nodes it selected, the one it works in, its pointer, and a status line.
type liveState struct {
	Selection []string   `json:"selection"`
	Focus     *string    `json:"focus"`
	Cursor    *livePoint `json:"cursor"`
	Status    *string    `json:"status"`
}

type livePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// liveParticipant is one presence on a canvas, as the stream sends it.
type liveParticipant struct {
	ID     string    `json:"id"`
	Kind   string    `json:"kind"` // human, agent or awwo
	Port   string    `json:"port"` // web, mcp, api or awwo
	Name   string    `json:"name"`
	Color  string    `json:"color"`
	UserID string    `json:"userId,omitempty"`
	Role   string    `json:"role,omitempty"`
	Model  string    `json:"model,omitempty"`
	State  liveState `json:"state"`
	Since  time.Time `json:"since"`

	streams    int
	tokenID    string // an agent's token; empty for a person
	lastSeen   time.Time
	goneAt     time.Time // when it leaves, once it has no stream
	presenceAt time.Time // the second its presence updates are counted in
	presenceN  int
}

// heldBy says whether an actor is this participant: the same person or the same token. A page's id is chosen by the
// page, so another member who copies it (every participant sees it) is someone else, not a second tab of the first.
func (p *liveParticipant) heldBy(actor canvasActor) bool {
	return p.Kind == actor.Kind && p.UserID == actor.UserID && p.tokenID == actor.TokenID
}

func (p *liveParticipant) public() liveParticipant {
	out := *p
	out.State.Selection = append([]string{}, p.State.Selection...)
	return out
}

// liveEvent is one event a stream sends besides changes: presence, claims (data nil: read them), a message, or bye.
type liveEvent struct {
	name string
	data any
}

// liveStream is one open stream of one participant.
type liveStream struct {
	participantID string
	userID        string
	tokenID       string
	// waitOnly marks an agent's canvas_wait: woken like a stream, ended by its token's bye, but no participant and in
	// no stream limit.
	waitOnly bool
	// bye is why the stream must end, kept here as well as queued, so a full queue cannot swallow it.
	bye string
	// wake is signalled (coalesced) when the canvas's document changed; events carries everything else.
	wake   chan struct{}
	events chan liveEvent
	// behind is set when events overflowed: the stream sends a fresh hello.
	behind bool
}

type canvasRoom struct {
	streams      map[*liveStream]struct{}
	participants map[string]*liveParticipant
}

type canvasMultiplayer struct {
	mu        sync.Mutex
	rooms     map[canvasKey]*canvasRoom
	limits    relayLimits
	closing   chan struct{}
	closeOnce sync.Once
	// now is the clock of presence (tests set it); nil is time.Now.
	now func() time.Time
}

func (m *canvasMultiplayer) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// closed gives a channel closed once the API stops, which ends every live stream at once.
func (m *canvasMultiplayer) closed() <-chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing == nil {
		m.closing = make(chan struct{})
	}
	return m.closing
}

func (m *canvasMultiplayer) shutdown() {
	m.closeOnce.Do(func() {
		m.mu.Lock()
		if m.closing == nil {
			m.closing = make(chan struct{})
		}
		close(m.closing)
		m.mu.Unlock()
	})
}

func (m *canvasMultiplayer) room(key canvasKey) *canvasRoom {
	if m.rooms == nil {
		m.rooms = map[canvasKey]*canvasRoom{}
	}
	r := m.rooms[key]
	if r == nil {
		r = &canvasRoom{streams: map[*liveStream]struct{}{}, participants: map[string]*liveParticipant{}}
		m.rooms[key] = r
	}
	return r
}

// sweep drops the participants whose grace ran out (telling the room), and the rooms nobody is in. Call with mu held.
func (m *canvasMultiplayer) sweep(key canvasKey, r *canvasRoom) {
	now := m.clock()
	for id, p := range r.participants {
		if p.streams > 0 {
			continue
		}
		if !p.goneAt.IsZero() && now.After(p.goneAt) {
			delete(r.participants, id)
			m.broadcastLocked(r, liveEvent{"presence", map[string]any{"left": id}})
		}
	}
	if len(r.participants) == 0 && len(r.streams) == 0 {
		delete(m.rooms, key)
	}
}

// broadcastLocked sends an event to every stream of a room, never blocking: a stream that cannot take it is marked
// behind and sends everyone again. Call with mu held.
func (m *canvasMultiplayer) broadcastLocked(r *canvasRoom, event liveEvent) {
	for s := range r.streams {
		select {
		case s.events <- event:
		default:
			s.behind = true
			select {
			case s.wake <- struct{}{}:
			default:
			}
		}
	}
}

// changed wakes every stream of a canvas: its document has a new committed change.
func (m *canvasMultiplayer) changed(tid, cid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[canvasKey{tid, cid}]
	if r == nil {
		return
	}
	for s := range r.streams {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

// claimsChanged tells a canvas's streams to send its claims again.
func (m *canvasMultiplayer) claimsChanged(tid, cid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rooms[canvasKey{tid, cid}]; r != nil {
		m.broadcastLocked(r, liveEvent{name: "claims"})
	}
}

// message sends a canvas's new live message to its streams.
func (m *canvasMultiplayer) message(tid, cid string, message any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rooms[canvasKey{tid, cid}]; r != nil {
		m.broadcastLocked(r, liveEvent{"message", map[string]any{"message": message}})
	}
}

// bye ends the streams of a token (revoked) or of a person on a canvas, with a reason.
func (m *canvasMultiplayer) bye(match func(*liveStream) bool, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rooms {
		for s := range r.streams {
			if match(s) {
				if s.bye == "" {
					s.bye = reason
				}
				select {
				case s.events <- liveEvent{"bye", map[string]any{"reason": reason}}:
				default:
					s.behind = true
				}
				select {
				case s.wake <- struct{}{}:
				default:
				}
			}
		}
	}
}

// takeBye gives why a stream must end, if it must.
func (m *canvasMultiplayer) takeBye(s *liveStream) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return s.bye
}

// sweepRoom takes off a canvas the participants whose grace has run out (each stream does it at its ping, so someone
// who left leaves everyone's canvas within about a ping of their grace).
func (m *canvasMultiplayer) sweepRoom(tid, cid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	if r := m.rooms[key]; r != nil {
		m.sweep(key, r)
	}
}

// tokensRevoked ends the streams and waits of tokens revoked together (a member who left, a password changed), takes
// them off their canvases and tells those canvases their claims changed (the tokens' claims went with them).
func (m *canvasMultiplayer) tokensRevoked(tokens []revokedCanvasToken) {
	if len(tokens) == 0 {
		return
	}
	ids := map[string]bool{}
	for _, t := range tokens {
		ids[t.id] = true
	}
	m.bye(func(s *liveStream) bool { return s.tokenID != "" && ids[s.tokenID] }, "revoked")
	for _, t := range tokens {
		m.leave(t.tenantID, t.canvasID, "t_"+t.id)
		m.claimsChanged(t.tenantID, t.canvasID)
	}
}

// leave takes a participant off a canvas at once (a revoked token), telling the room.
func (m *canvasMultiplayer) leave(tid, cid, id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.rooms[key]
	if r == nil || r.participants[id] == nil {
		return
	}
	delete(r.participants, id)
	m.broadcastLocked(r, liveEvent{"presence", map[string]any{"left": id}})
	m.sweep(key, r)
}

// watch registers a stream that only wakes (a long-polling agent's wait, under its token): it is no participant and
// counts in no limit, and its token's revocation ends it.
func (m *canvasMultiplayer) watch(tid, cid, tokenID string) (*liveStream, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.room(key)
	s := &liveStream{tokenID: tokenID, waitOnly: true, wake: make(chan struct{}, 1), events: make(chan liveEvent, liveEventBuffer)}
	r.streams[s] = struct{}{}
	return s, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if r := m.rooms[key]; r != nil {
			delete(r.streams, s)
			m.sweep(key, r)
		}
	}
}

// liveJoin is who opens a stream or touches a canvas.
type liveJoin struct {
	actor canvasActor
	role  string
}

// open registers a stream of a participant on a canvas; ok is false when the canvas or the participant has too many.
// open admits a stream; its refusal is liveFull (a limit) or liveTaken (another person or token holds the id).
func (m *canvasMultiplayer) open(tid, cid string, who liveJoin) (*liveStream, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.room(key)
	m.sweep(key, r)
	r = m.room(key)
	id := who.actor.participantID()
	same := 0
	for s := range r.streams {
		if !s.waitOnly && ((who.actor.Kind == "agent" && s.tokenID == who.actor.TokenID) || (who.actor.Kind != "agent" && s.tokenID == "" && s.userID == who.actor.UserID)) {
			same++
		}
	}
	limit := liveStreamsPerUser
	if who.actor.Kind == "agent" {
		limit = liveStreamsPerToken
	}
	if same >= limit {
		return nil, liveFull
	}
	p := r.participants[id]
	if p != nil && !p.heldBy(who.actor) {
		return nil, liveTaken
	}
	if p == nil {
		// One person (or token) holds at most as many participants as it may have streams, those still in their grace
		// counted: one who opens and closes pages under new ids takes the place of their own oldest page with no stream,
		// never fills the canvas for everyone else.
		var mine []*liveParticipant
		for _, q := range r.participants {
			if q.heldBy(who.actor) {
				mine = append(mine, q)
			}
		}
		if len(mine) >= limit {
			var oldest *liveParticipant
			for _, q := range mine {
				if q.streams == 0 && (oldest == nil || q.lastSeen.Before(oldest.lastSeen)) {
					oldest = q
				}
			}
			if oldest == nil {
				return nil, liveFull
			}
			delete(r.participants, oldest.ID)
			m.broadcastLocked(r, liveEvent{"presence", map[string]any{"left": oldest.ID}})
		}
		if len(r.participants) >= liveParticipantsPerCanvas {
			return nil, liveFull
		}
		p = m.newParticipantLocked(who)
		r.participants[id] = p
	}
	p.streams++
	p.goneAt = time.Time{}
	p.lastSeen = m.clock()
	s := &liveStream{participantID: id, userID: who.actor.UserID, tokenID: who.actor.TokenID, wake: make(chan struct{}, 1), events: make(chan liveEvent, liveEventBuffer)}
	m.broadcastLocked(r, liveEvent{"presence", map[string]any{"participant": p.public()}})
	r.streams[s] = struct{}{}
	return s, ""
}

// Why a stream was not admitted.
const (
	liveFull  = "full"
	liveTaken = "taken"
)

func (m *canvasMultiplayer) newParticipantLocked(who liveJoin) *liveParticipant {
	now := m.clock()
	id := who.actor.participantID()
	port := who.actor.Port
	if port == "" {
		port = "web"
	}
	return &liveParticipant{ID: id, Kind: who.actor.Kind, Port: port, Name: who.actor.Name, Color: liveColor(colorKey(who.actor)), UserID: who.actor.UserID,
		Role: who.role, State: liveState{Selection: []string{}}, Since: now, tokenID: who.actor.TokenID, lastSeen: now}
}

// colorKey is what picks a participant's colour: a person's account (all their tabs and messages alike), an agent's token.
func colorKey(actor canvasActor) string {
	if actor.Kind == "agent" {
		return "t_" + actor.TokenID
	}
	return "u_" + actor.UserID
}

// close ends a stream; its participant stays for its grace.
func (m *canvasMultiplayer) close(tid, cid string, s *liveStream) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.rooms[key]
	if r == nil {
		return
	}
	delete(r.streams, s)
	if p := r.participants[s.participantID]; p != nil {
		p.streams--
		if p.streams <= 0 {
			p.streams = 0
			grace := livePageGrace
			if p.Kind == "agent" {
				grace = liveAgentGrace
			}
			p.goneAt = m.clock().Add(grace)
		}
	}
	m.sweep(key, r)
}

// heldByOther says whether the id an actor names is someone else's on the canvas now: a page id another person (or a
// token) holds. A change under it would pass on that page for the page's own.
func (m *canvasMultiplayer) heldByOther(tid, cid string, actor canvasActor) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[canvasKey{tid, cid}]
	if r == nil {
		return false
	}
	p := r.participants[actor.participantID()]
	return p != nil && !p.heldBy(actor)
}

// touch keeps an agent that makes requests without a stream on the canvas (an MCP client), and brings it there.
func (m *canvasMultiplayer) touch(tid, cid string, who liveJoin) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.room(key)
	m.sweep(key, r)
	r = m.room(key)
	id := who.actor.participantID()
	p := r.participants[id]
	if p != nil && !p.heldBy(who.actor) {
		return
	}
	if p == nil {
		if len(r.participants) >= liveParticipantsPerCanvas {
			return
		}
		p = m.newParticipantLocked(who)
		r.participants[id] = p
		m.broadcastLocked(r, liveEvent{"presence", map[string]any{"participant": p.public()}})
	}
	p.lastSeen = m.clock()
	if p.streams == 0 {
		p.goneAt = p.lastSeen.Add(liveAgentGrace)
	}
}

// setState changes an actor's own state (only the parts given) and tells the room. It is false when the actor is not
// on the canvas (or the id it names is someone else's) or sent too many updates this second (dropped).
func (m *canvasMultiplayer) setState(tid, cid string, actor canvasActor, update func(*liveState)) bool {
	id := actor.participantID()
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.rooms[key]
	if r == nil {
		return false
	}
	p := r.participants[id]
	if p == nil || !p.heldBy(actor) {
		return false
	}
	now := m.clock()
	if now.Sub(p.presenceAt) >= time.Second {
		p.presenceAt, p.presenceN = now, 0
	}
	if p.presenceN >= livePresencePerSecond {
		return false
	}
	p.presenceN++
	p.lastSeen = now
	if p.streams == 0 && p.Kind == "agent" {
		p.goneAt = now.Add(liveAgentGrace)
	}
	update(&p.State)
	m.broadcastLocked(r, liveEvent{"presence", map[string]any{"participant": p.public()}})
	return true
}

// participants lists a canvas's participants (people and agents), the oldest first.
func (m *canvasMultiplayer) participants(tid, cid string) []liveParticipant {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.rooms[key]
	if r == nil {
		return []liveParticipant{}
	}
	m.sweep(key, r)
	out := make([]liveParticipant, 0, len(r.participants))
	for _, p := range r.participants {
		out = append(out, p.public())
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Since.Equal(out[j].Since) {
			return out[i].Since.Before(out[j].Since)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// participant gives one participant of a canvas, if it is there.
func (m *canvasMultiplayer) participant(tid, cid, id string) (liveParticipant, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[canvasKey{tid, cid}]
	if r == nil || r.participants[id] == nil {
		return liveParticipant{}, false
	}
	return r.participants[id].public(), true
}

// takeBehind says whether a stream fell behind (and clears it): it must send a fresh hello.
func (m *canvasMultiplayer) takeBehind(s *liveStream) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	behind := s.behind
	s.behind = false
	return behind
}

// The canvas agent token limits (as the relay keys', relay_limits.go): requests a minute per token, failed lookups a
// minute per address.
func (a *App) canvasTokenRequestAllowed(tokenID string) bool {
	l := &a.multiplayer.limits
	return l.count(&l.keys, tokenID, canvasTokenRequestsPerMinute, true)
}
func (a *App) canvasTokenLookupAllowed(r *http.Request) bool {
	l := &a.multiplayer.limits
	return l.count(&l.failures, signupAddress(a.clientIP(r)), canvasTokenFailuresPerMinute, false)
}
func (a *App) canvasTokenLookupFailed(r *http.Request) {
	l := &a.multiplayer.limits
	l.count(&l.failures, signupAddress(a.clientIP(r)), canvasTokenFailuresPerMinute, true)
}
