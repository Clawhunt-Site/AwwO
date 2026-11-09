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
	// liveEventBuffer is how many claims, message and bye events wait for one stream; a stream that falls further behind
	// is sent everyone again (a fresh hello) instead. Presence never queues there: see livePresenceEvery.
	liveEventBuffer = 256
	// livePresencePerSecond is how many presence updates a participant may send a second; more are refused (429), and
	// the page sends its latest state again a moment later. Pages send at most eight a second.
	livePresencePerSecond = 10
	// livePresenceEvery is the most often a stream tells of one participant: when they change, their latest state goes
	// at once if the stream last told of them at least this long ago, else when that time is up, once, however often
	// they changed meanwhile. A page that sends eight a second is never held back; a faster burst is merged; and since
	// presence never queues, no amount of it can push a stream behind.
	livePresenceEvery = 100 * time.Millisecond
	// livePreviewFor is how long an edit in progress (a drag, a resize, a wire being drawn) stays after its last update:
	// its page sends it again every second while the gesture lasts, so one whose page went leaves no ghost behind.
	livePreviewFor = 2 * time.Second
	// livePreviewNodesMax is how many dragged nodes one preview carries (a larger drag shows its first ones moving).
	livePreviewNodesMax = 50
	// canvasTokenRequestsPerMinute is how many requests one canvas agent token may make a minute, and
	// canvasTokenFailuresPerMinute how many failed token lookups one address may make (as the relay's keys).
	canvasTokenRequestsPerMinute = 120
	canvasTokenFailuresPerMinute = 30
)

// liveParticipantColors are the participants' colours. Each one's own is picked by their id (liveColor): an author's
// messages wear it whether they are here or not. On a canvas a person or token wears the first of these free from
// their own on (canvasRoom.colorLocked), so up to twelve never share one.
var liveParticipantColors = []string{"#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6",
	"#d6409f", "#978365", "#29a383", "#5b5bd6"}

func liveColor(id string) string { return liveParticipantColors[liveColorIndex(id)] }

func liveColorIndex(id string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return int(h.Sum32() % uint32(len(liveParticipantColors)))
}

type canvasKey struct{ tenant, canvas string }

// liveState is what a participant shows: the nodes it selected, the one it works in, its pointer, and a status line;
// for a person who may edit, the edit they are making and have not saved yet (preview) and the field they are typing
// in (editing); and the part of the board their screen shows (viewport), which a person who follows them sees.
type liveState struct {
	Selection []string      `json:"selection"`
	Focus     *string       `json:"focus"`
	Cursor    *livePoint    `json:"cursor"`
	Status    *string       `json:"status"`
	Preview   *livePreview  `json:"preview"`
	Editing   *liveEditing  `json:"editing"`
	Viewport  *liveViewport `json:"viewport"`
}

type livePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// livePreview is an edit in progress, never saved: the nodes being dragged (where they are now), one node being
// resized (its box now), or a wire being drawn (from its port to the loose end). Others draw it until the change
// itself comes, it is renewed, or livePreviewFor passes.
type livePreview struct {
	Nodes  []livePreviewNode `json:"nodes,omitempty"`
	Resize *livePreviewBox   `json:"resize,omitempty"`
	Wire   *livePreviewWire  `json:"wire,omitempty"`
}

type livePreviewNode struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

type livePreviewBox struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	W  float64 `json:"w"`
	H  float64 `json:"h"`
}

// livePreviewWire is a wire being drawn from a node's port (an output, or an input dragged backwards): From is the
// port's place, To the pointer's, both in world coordinates.
type livePreviewWire struct {
	Node string    `json:"node"`
	Port string    `json:"port"`
	Side string    `json:"side"`
	From livePoint `json:"from"`
	To   livePoint `json:"to"`
}

// liveEditing is the field a person is typing in: a node's and its field's key (a page's own names, such as "title",
// "persona" or "form.<field id>.label"), so everyone else's page marks that field with their name.
type liveEditing struct {
	Node  string `json:"node"`
	Field string `json:"field"`
}

// liveViewport is the part of the board a page's screen shows, in world coordinates.
type liveViewport struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// liveParticipant is one presence on a canvas, as the stream sends it: a person's page (one per tab: the pages a page
// shows of one person are drawn as one avatar), an agent's token, or a run of AwwO's Agents.
type liveParticipant struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"` // human, agent or awwo
	Port   string `json:"port"` // web, mcp, api or awwo
	Name   string `json:"name"`
	Color  string `json:"color"`
	UserID string `json:"userId,omitempty"`
	Role   string `json:"role,omitempty"`
	Model  string `json:"model,omitempty"`
	// Device is what a page says it runs in (browser, mac, windows, phone or tablet), shown and never trusted.
	Device string    `json:"device,omitempty"`
	State  liveState `json:"state"`
	Since  time.Time `json:"since"`

	streams    int
	tokenID    string // an agent's token; empty for a person
	colorKey   string // whose colour it wears (colorKey)
	lastSeen   time.Time
	goneAt     time.Time // when it leaves, once it has no stream
	presenceAt time.Time // the second its presence updates are counted in
	presenceN  int
	previewAt  time.Time // when its edit in progress last came
}

// heldBy says whether an actor is this participant: the same person or the same token. A page's id is chosen by the
// page, so another member who copies it (every participant sees it) is someone else, not a second tab of the first.
func (p *liveParticipant) heldBy(actor canvasActor) bool {
	return p.Kind == actor.Kind && p.UserID == actor.UserID && p.tokenID == actor.TokenID
}

// public is the participant as the stream sends it at a moment: an edit in progress older than livePreviewFor is no
// longer there. The parts behind pointers are never changed in place (an update replaces them), so the copy is safe
// to send after the hub's lock is let go.
func (p *liveParticipant) public(now time.Time) liveParticipant {
	out := *p
	out.State.Selection = append([]string{}, p.State.Selection...)
	if out.State.Preview != nil && now.Sub(p.previewAt) > livePreviewFor {
		out.State.Preview = nil
	}
	return out
}

// liveEvent is one event a stream sends besides changes and presence: claims (data nil: read them), a message, or bye.
type liveEvent struct {
	name string
	data any
}

// liveStream is one open stream of one participant.
type liveStream struct {
	participantID string
	userID        string
	tokenID       string
	// waitOnly marks an agent's canvas_wait: woken like a stream, ended by its token's bye, but no participant, in no
	// stream limit, and told nothing of presence.
	waitOnly bool
	// bye is why the stream must end, kept here as well as queued, so a full queue cannot swallow it.
	bye string
	// wake is signalled (coalesced) when the canvas's document changed; events carries claims, messages and byes.
	wake   chan struct{}
	events chan liveEvent
	// behind is set when events overflowed: the stream sends a fresh hello.
	behind bool
	// pending holds who changed their presence (or left) since the stream last told of them, sentAt when it last told of
	// each, and nudge is signalled (coalesced) at every change: the stream tells of each at most every livePresenceEvery.
	pending map[string]struct{}
	sentAt  map[string]time.Time
	nudge   chan struct{}
}

func newLiveStream(participantID string, actor canvasActor, waitOnly bool) *liveStream {
	return &liveStream{participantID: participantID, userID: actor.UserID, tokenID: actor.TokenID, waitOnly: waitOnly,
		wake: make(chan struct{}, 1), events: make(chan liveEvent, liveEventBuffer), pending: map[string]struct{}{},
		sentAt: map[string]time.Time{}, nudge: make(chan struct{}, 1)}
}

type canvasRoom struct {
	streams      map[*liveStream]struct{}
	participants map[string]*liveParticipant
	// colors is the colour each person or token on the canvas wears, by colorKey, while any page of theirs is here.
	colors map[string]string
}

// colorLocked gives the colour a person or token wears on the canvas: the one they already wear, else the first free
// one from their own (liveColor) on, else their own (more than twelve are here). Call with the hub's lock held.
func (r *canvasRoom) colorLocked(key string) string {
	if color, ok := r.colors[key]; ok {
		return color
	}
	worn := make(map[string]bool, len(r.colors))
	for _, color := range r.colors {
		worn[color] = true
	}
	first := liveColorIndex(key)
	color := liveParticipantColors[first]
	for i := range liveParticipantColors {
		if c := liveParticipantColors[(first+i)%len(liveParticipantColors)]; !worn[c] {
			color = c
			break
		}
	}
	r.colors[key] = color
	return color
}

// forgetColorsLocked frees the colours of those with no page left on the canvas. Call with the hub's lock held.
func (r *canvasRoom) forgetColorsLocked() {
	if len(r.colors) == 0 {
		return
	}
	worn := make(map[string]bool, len(r.participants))
	for _, p := range r.participants {
		worn[p.colorKey] = true
	}
	for key := range r.colors {
		if !worn[key] {
			delete(r.colors, key)
		}
	}
}

// markLocked tells a room's streams that a participant's presence changed (or that it left): each tells of their latest
// state as soon as livePresenceEvery allows. Call with the hub's lock held.
func (m *canvasMultiplayer) markLocked(r *canvasRoom, id string) {
	for s := range r.streams {
		if s.waitOnly {
			continue
		}
		s.pending[id] = struct{}{}
		select {
		case s.nudge <- struct{}{}:
		default:
		}
	}
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
		r = &canvasRoom{streams: map[*liveStream]struct{}{}, participants: map[string]*liveParticipant{}, colors: map[string]string{}}
		m.rooms[key] = r
	}
	return r
}

// sweep drops the participants whose grace ran out (telling the room), and the rooms nobody is in. Call with mu held.
func (m *canvasMultiplayer) sweep(key canvasKey, r *canvasRoom) {
	now := m.clock()
	gone := false
	for id, p := range r.participants {
		if p.streams > 0 {
			continue
		}
		if !p.goneAt.IsZero() && now.After(p.goneAt) {
			delete(r.participants, id)
			m.markLocked(r, id)
			gone = true
		}
	}
	if gone {
		r.forgetColorsLocked()
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
	m.markLocked(r, id)
	r.forgetColorsLocked()
	m.sweep(key, r)
}

// watch registers a stream that only wakes (a long-polling agent's wait, under its token): it is no participant and
// counts in no limit, and its token's revocation ends it.
func (m *canvasMultiplayer) watch(tid, cid, tokenID string) (*liveStream, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.room(key)
	s := newLiveStream("", canvasActor{Kind: "agent", TokenID: tokenID}, true)
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

// liveJoin is who opens a stream or touches a canvas, and for a page what it says it runs in (liveDevices).
type liveJoin struct {
	actor  canvasActor
	role   string
	device string
}

// liveDevices are the devices a page may say it runs in: a browser, the Mac app, AwwO Cloud for Windows, a phone or a
// tablet. Anything else is no device.
var liveDevices = map[string]bool{"browser": true, "mac": true, "windows": true, "phone": true, "tablet": true}

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
			m.markLocked(r, oldest.ID)
			r.forgetColorsLocked()
		}
		if len(r.participants) >= liveParticipantsPerCanvas {
			return nil, liveFull
		}
		p = m.newParticipantLocked(r, who)
		r.participants[id] = p
	}
	p.streams++
	p.goneAt = time.Time{}
	p.lastSeen = m.clock()
	if who.device != "" {
		p.Device = who.device
	}
	if who.role != "" {
		p.Role = who.role
	}
	if p.dropEditsUnlessEditor() {
		m.markLocked(r, id)
	}
	s := newLiveStream(id, who.actor, false)
	m.markLocked(r, id)
	r.streams[s] = struct{}{}
	return s, ""
}

// Why a stream was not admitted.
const (
	liveFull  = "full"
	liveTaken = "taken"
)

func (m *canvasMultiplayer) newParticipantLocked(r *canvasRoom, who liveJoin) *liveParticipant {
	now := m.clock()
	id := who.actor.participantID()
	port := who.actor.Port
	if port == "" {
		port = "web"
	}
	key := colorKey(who.actor)
	return &liveParticipant{ID: id, Kind: who.actor.Kind, Port: port, Name: who.actor.Name, Color: r.colorLocked(key), UserID: who.actor.UserID,
		Role: who.role, Device: who.device, State: liveState{Selection: []string{}}, Since: now, tokenID: who.actor.TokenID, colorKey: key, lastSeen: now}
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
			// What only a page with its stream open does ends with its stream: its pointer, the edit it was making and
			// the field it was typing in (a page that comes back says them again). It stays for its grace otherwise.
			if p.State.Cursor != nil || p.State.Preview != nil || p.State.Editing != nil {
				p.State.Cursor, p.State.Preview, p.State.Editing = nil, nil, nil
				m.markLocked(r, p.ID)
			}
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
		p = m.newParticipantLocked(r, who)
		r.participants[id] = p
		m.markLocked(r, id)
	}
	p.lastSeen = m.clock()
	if p.streams == 0 {
		p.goneAt = p.lastSeen.Add(liveAgentGrace)
	}
}

// liveUpdate is the parts of its state a participant sent (parseLiveState): each part given replaces that part.
type liveUpdate struct {
	apply func(*liveState)
	// preview says it carries an edit in progress, whose time starts again (livePreviewFor).
	preview bool
}

// What setState did with an update.
const (
	liveStateSet     = iota
	liveStateAbsent  // the actor is not on the canvas, or the id it names is someone else's: nothing moves
	liveStateTooFast // more than livePresencePerSecond this second: refused, to be sent again
)

// setState changes an actor's own state (only the parts given) and tells the room. `role` is the actor's role as the
// request found it (empty for an agent): a page's participant shows the role it has now, not the one its stream
// opened with.
func (m *canvasMultiplayer) setState(tid, cid string, actor canvasActor, role string, update liveUpdate) int {
	id := actor.participantID()
	m.mu.Lock()
	defer m.mu.Unlock()
	key := canvasKey{tid, cid}
	r := m.rooms[key]
	if r == nil {
		return liveStateAbsent
	}
	p := r.participants[id]
	if p == nil || !p.heldBy(actor) {
		return liveStateAbsent
	}
	// A page with no stream open is on its way out (or back, when it says everything again at its hello): what it says
	// now would outlive it.
	if p.Kind == "human" && p.streams == 0 {
		return liveStateAbsent
	}
	now := m.clock()
	if now.Sub(p.presenceAt) >= time.Second {
		p.presenceAt, p.presenceN = now, 0
	}
	if p.presenceN >= livePresencePerSecond {
		return liveStateTooFast
	}
	p.presenceN++
	p.lastSeen = now
	if p.streams == 0 && p.Kind == "agent" {
		p.goneAt = now.Add(liveAgentGrace)
	}
	if role != "" {
		p.Role = role
	}
	update.apply(&p.State)
	if update.preview {
		p.previewAt = now
	}
	p.dropEditsUnlessEditor()
	m.markLocked(r, id)
	return liveStateSet
}

// dropEditsUnlessEditor takes away the edit in progress and the editing mark of a person who may no longer edit (their
// role went down while they had one): a reader's post cannot say them, nor take them back.
func (p *liveParticipant) dropEditsUnlessEditor() bool {
	if p.Kind != "human" || roleLevel(p.Role) >= roleLevel("member") || (p.State.Preview == nil && p.State.Editing == nil) {
		return false
	}
	p.State.Preview, p.State.Editing = nil, nil
	return true
}

// setRole is a participant's role as its stream's check of access found it again (it may have changed since the stream
// opened); the room is told when it changed.
func (m *canvasMultiplayer) setRole(tid, cid, id, role string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[canvasKey{tid, cid}]
	if r == nil || role == "" {
		return
	}
	if p := r.participants[id]; p != nil {
		changed := p.Role != role
		p.Role = role
		if p.dropEditsUnlessEditor() || changed {
			m.markLocked(r, id)
		}
	}
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
	return m.participantsLocked(key, r)
}

func (m *canvasMultiplayer) participantsLocked(key canvasKey, r *canvasRoom) []liveParticipant {
	m.sweep(key, r)
	now := m.clock()
	out := make([]liveParticipant, 0, len(r.participants))
	for _, p := range r.participants {
		out = append(out, p.public(now))
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Since.Equal(out[j].Since) {
			return out[i].Since.Before(out[j].Since)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// greet gives what a stream's hello says of the canvas's presence (everyone, and the stream's own participant) and
// forgets what it had still to send: the hello says how things are now. One lock, so nothing that changes after the
// hello was read can be forgotten.
func (m *canvasMultiplayer) greet(tid, cid string, s *liveStream) ([]liveParticipant, liveParticipant) {
	m.mu.Lock()
	defer m.mu.Unlock()
	clear(s.pending)
	clear(s.sentAt)
	key := canvasKey{tid, cid}
	r := m.rooms[key]
	if r == nil {
		return []liveParticipant{}, liveParticipant{}
	}
	participants := m.participantsLocked(key, r)
	var you liveParticipant
	for _, p := range participants {
		if p.ID == s.participantID {
			you = p
		}
	}
	return participants, you
}

// takePresence gives what a stream tells of the canvas's presence at `at` (the stream's own clock), and forgets it: for
// each participant who changed since it last told of them, their latest state if it last told of them at least
// livePresenceEvery ago, or that they left (at once); and how long until the next of those held back is due (0: none
// is).
func (m *canvasMultiplayer) takePresence(tid, cid string, s *liveStream, at time.Time) ([]map[string]any, time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(s.pending) == 0 {
		return nil, 0
	}
	r := m.rooms[canvasKey{tid, cid}]
	var ids []string
	var wait time.Duration
	for id := range s.pending {
		if r != nil && r.participants[id] != nil {
			if last, told := s.sentAt[id]; told {
				if left := livePresenceEvery - at.Sub(last); left > 0 {
					if wait == 0 || left < wait {
						wait = left
					}
					continue
				}
			}
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	now := m.clock()
	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		delete(s.pending, id)
		if r != nil {
			if p := r.participants[id]; p != nil {
				out = append(out, map[string]any{"participant": p.public(now)})
				s.sentAt[id] = at
				continue
			}
		}
		out = append(out, map[string]any{"left": id})
		delete(s.sentAt, id)
	}
	return out, wait
}

// participant gives one participant of a canvas, if it is there.
func (m *canvasMultiplayer) participant(tid, cid, id string) (liveParticipant, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[canvasKey{tid, cid}]
	if r == nil || r.participants[id] == nil {
		return liveParticipant{}, false
	}
	return r.participants[id].public(m.clock()), true
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
