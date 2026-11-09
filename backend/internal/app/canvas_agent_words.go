package app

import (
	"container/heap"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Pages made from words an invited Agent wrote (多人同屏; docs/awwo-canvas-live-collaboration.md, "An agent's page"; the
// owner's choice of 2026-11-08). A page an Agent hands in shows still until its reader runs it (its result's by), and so
// does a page a run makes from what an Agent wrote: an assemble node copies its template and its inputs into its page
// as they are (graph_assemble.go), a form hands on its fields' labels and values as they are (formOutput), an image,
// video, 3D or edit node's file listing names its title (graph_media.go), and a session follows its persona.
//
// The document records no writer of those texts, so the server keeps one: agentWritten, on a node, the fingerprints of
// the texts an Agent wrote there, each with the Agent's name, and of each result of the node held for an Agent's words.
// A text counts as an Agent's while it matches one, so a person's edit ends it and an undo or a copy brings it back;
// and a result held once stays held after the wire, the result or the node that fed it is gone. An Agent's rules leave
// the field out, and a person's write never takes a fingerprint away (it may add some, which only hold more: a page
// fingerprints a result it lands; so a member writing the API by hand can name any Agent on a text, never unhold one).
// The page reads the same rules from the same field (apps/web/src/canvas/agentPages.ts); both are checked against
// testdata/agent_words_vectors.json.

const (
	agentWrittenKey = "agentWritten"
	// agentWrittenStaleMax bounds the fingerprints a node keeps of texts it no longer holds (an undo may bring one back);
	// one of a text it holds now is never let go, however many (a form may hold hundreds), so none is ever cut on reading.
	agentWrittenStaleMax = 16
	// agentWrittenNamesMax bounds the names one fingerprint is kept under (the first stay, so names a write adds later never
	// push out the one it was kept under first): the Agents of a canvas are few, and a write that sent a text's fingerprint
	// under many names would otherwise keep them all.
	agentWrittenNamesMax = 8
	// agentHoldNamesMax bounds the names a hold carries: the first in byte order (the code point order the page compares
	// them in). A page is held while one is left, and a held result's fingerprint keeps at most agentWrittenNamesMax names
	// anyway, so the names one write sends never make a hold, or the work of finding the holds, grow.
	agentHoldNamesMax = agentWrittenNamesMax
	// agentWrittenAddedMax bounds the fingerprints a person's write may add to one node of texts the node does not hold
	// (one of a text it holds is always taken: an undo bringing a form's hundreds of fields back brings their
	// fingerprints with it).
	agentWrittenAddedMax = 64
)

// agentWrittenEntry is one fingerprint: of a text an Agent wrote on the node, or of a result of it held for an Agent's
// words, with that Agent's name.
type agentWrittenEntry struct {
	H  string
	By string
}

// agentPageHold is why a node's result is held for an invited Agent: that Agent handed it in, or it is made from words
// of the Agents named.
type agentPageHold struct {
	handedIn bool
	names    []string
}

// agentTextHash is a text's fingerprint: FNV-1a 64 of its UTF-8 bytes, as 16 hex digits.
func agentTextHash(s string) string {
	h := uint64(14695981039346656037)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= 1099511628211
	}
	out := strconv.FormatUint(h, 16)
	return strings.Repeat("0", 16-len(out)) + out
}

// jsSpace is the white space a page trims (ECMAScript WhiteSpace and LineTerminator), so a name reads the same here.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0xfeff, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// agentName is an Agent's name as it is kept: trimmed, and at most canvasAgentTokenNameMax characters (a page reads a
// result's by the same way, canvasDoc.ts sanitizeOutputAuthor).
func agentName(name string) string {
	name = strings.TrimFunc(name, jsSpace)
	if utf8.RuneCountInString(name) > canvasAgentTokenNameMax {
		name = string([]rune(name)[:canvasAgentTokenNameMax])
	}
	return name
}

func agentHashOK(h string) bool {
	if len(h) != 16 {
		return false
	}
	for i := 0; i < len(h); i++ {
		if c := h[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// agentWrittenOf reads a node's fingerprints in the order they came, each once; anything else in the field is none.
func agentWrittenOf(node map[string]any) []agentWrittenEntry {
	list, _ := node[agentWrittenKey].([]any)
	out := []agentWrittenEntry{}
	seen := map[agentWrittenEntry]bool{}
	for _, item := range list {
		e, _ := item.(map[string]any)
		h, _ := e["h"].(string)
		by, _ := e["by"].(string)
		if entry := (agentWrittenEntry{H: h, By: agentName(by)}); agentHashOK(h) && !seen[entry] {
			seen[entry] = true
			out = append(out, entry)
		}
	}
	return out
}

func hasAgentWritten(entries []agentWrittenEntry, entry agentWrittenEntry) bool {
	for _, e := range entries {
		if e == entry {
			return true
		}
	}
	return false
}

// agentWrittenSet is a node's fingerprints as a set, to add to without searching the list.
type agentWrittenSet struct {
	entries []agentWrittenEntry
	seen    map[agentWrittenEntry]bool
}

func newAgentWrittenSet(entries []agentWrittenEntry) *agentWrittenSet {
	s := &agentWrittenSet{entries: entries, seen: make(map[agentWrittenEntry]bool, len(entries))}
	for _, e := range entries {
		s.seen[e] = true
	}
	return s
}

// add puts entry at the end unless it is there, saying whether it was new.
func (s *agentWrittenSet) add(entry agentWrittenEntry) bool {
	if s.seen[entry] {
		return false
	}
	s.seen[entry] = true
	s.entries = append(s.entries, entry)
	return true
}

func setAgentWritten(node map[string]any, entries []agentWrittenEntry) {
	if len(entries) == 0 {
		delete(node, agentWrittenKey)
		return
	}
	list := make([]any, len(entries))
	for i, e := range entries {
		list[i] = map[string]any{"h": e.H, "by": e.By}
	}
	node[agentWrittenKey] = list
}

// canvasNodeRecords gives a document's nodes by id, each the first record with that id (as findRecord reads them), and
// their ids in document order.
func canvasNodeRecords(doc map[string]any) (map[string]map[string]any, []string) {
	nodes := map[string]map[string]any{}
	order := []string{}
	for _, item := range collectionOf(doc, "nodes") {
		node, ok := item.(map[string]any)
		id, keyed := recordKey(item, "id")
		if !ok || !keyed || nodes[id] != nil {
			continue
		}
		nodes[id] = node
		order = append(order, id)
	}
	return nodes, order
}

// agentNodeTexts are the texts of a node an Agent's words reach a page through, each by its place on the node: its
// title, a session's persona, an assemble node's template, a form field's label and value (the first field of an id),
// its result, and a session's other conversations' personas and results.
func agentNodeTexts(node map[string]any) map[string]string {
	texts := map[string]string{}
	put := func(place string, v any) {
		if s, ok := v.(string); ok && s != "" {
			texts[place] = s
		}
	}
	put("title", node["title"])
	switch node["kind"] {
	case "session":
		put("persona", node["persona"])
	case "assemble":
		put("template", node["template"])
	case "form":
		seen := map[string]bool{}
		for _, item := range collectionOf(node, "fields") {
			field, _ := item.(map[string]any)
			if id, ok := recordKey(item, "id"); ok && !seen[id] {
				seen[id] = true
				put("fields/"+id+"/label", field["label"])
				put("fields/"+id+"/value", field["value"])
			}
		}
	}
	if out, ok := node["lastOutput"].(map[string]any); ok {
		put("lastOutput", out["text"])
	}
	// A session's other conversations keep their results, which its panel still shows, and their personas, which a switch
	// back to one brings back: their fingerprints are kept.
	if node["kind"] != "session" {
		return texts
	}
	for i, item := range collectionOf(node, "threads") {
		thread, _ := item.(map[string]any)
		put("threads/"+strconv.Itoa(i)+"/persona", thread["persona"])
		if out, ok := thread["lastOutput"].(map[string]any); ok {
			put("threads/"+strconv.Itoa(i)+"/lastOutput", out["text"])
		}
	}
	return texts
}

// settleAgentWords keeps agentWritten's rules on a write of a canvas document by actor, from before (as saved; empty for
// a new canvas) to after, which it changes: each node keeps the fingerprints it had, what an Agent's change wrote is
// fingerprinted, a person's write keeps an Agent's name only on what an Agent handed in, and every result held for an
// Agent's words is fingerprinted. Each node's fingerprints are bounded before the holds are worked out from them, as well
// as after, so no write can make that work grow with what it sent.
func settleAgentWords(before, after map[string]any, actor canvasActor) {
	hashes := map[string]string{}
	keepAgentWritten(before, after, actor.Kind != "agent", hashes)
	if actor.Kind == "agent" {
		markAgentWords(before, after, agentName(actor.Name))
	} else {
		checkResultAuthors(before, after)
	}
	nodes, order := canvasNodeRecords(after)
	for _, id := range order {
		pruneAgentWrittenWith(nodes[id], hashes)
	}
	recordAgentPages(before, after, hashes)
	for _, id := range order {
		pruneAgentWrittenWith(nodes[id], hashes)
	}
}

// settleCanvasDocument is settleAgentWords on a whole document written at once (a save, node setup, a new canvas, whose
// saved document is nil), as bytes. It reads every such write: a key a page writes with escapes (\u0062y) is by all the
// same, so no look at the bytes can tell a write that needs none.
func settleCanvasDocument(saved, incoming []byte, actor canvasActor) []byte {
	after, err := decodeCanvasDocument(incoming)
	if err != nil {
		return incoming
	}
	before := map[string]any{}
	if doc, err := decodeCanvasDocument(saved); err == nil {
		before = doc
	}
	settleAgentWords(before, after, actor)
	out, err := json.Marshal(after)
	if err != nil {
		return incoming
	}
	return out
}

// keepAgentWritten gives each node of after that was in before the fingerprints it had there, whatever the write took
// away, and reads those of a node new in this write (an undo of its deletion, a copy) as sent. A person's write may add
// fingerprints, which only ever hold more: every one of a text the node holds (each under at most agentWrittenNamesMax
// names once pruned), and at most agentWrittenAddedMax of texts it does not (pruning keeps the latest of those). A page
// fingerprints a result it lands held for an Agent's words (agentPages.ts recordAgentPages), so it stays held though what
// fed it went before the result reached the server; a save split into batches may carry the fingerprint before the
// result; and an undo brings a text's fingerprint back with it. An Agent's write adds none (its rules leave the field out).
func keepAgentWritten(before, after map[string]any, person bool, hashes map[string]string) {
	prior, _ := canvasNodeRecords(before)
	nodes, order := canvasNodeRecords(after)
	for _, id := range order {
		node := nodes[id]
		old, existed := prior[id]
		if !existed {
			setAgentWritten(node, agentWrittenOf(node))
			continue
		}
		kept := newAgentWrittenSet(agentWrittenOf(old))
		if sent := agentWrittenOf(node); person && len(sent) > 0 {
			// Most writes send the node's fingerprints as they were: its texts are read only for one it did not keep.
			var current map[string]bool
			stale := 0
			for _, entry := range sent {
				if kept.seen[entry] {
					continue
				}
				if current == nil {
					current = agentCurrentHashes(node, hashes)
				}
				if current[entry.H] {
					kept.add(entry)
				} else if stale < agentWrittenAddedMax && kept.add(entry) {
					stale++
				}
			}
		}
		setAgentWritten(node, kept.entries)
	}
}

// agentCurrentHashes are the fingerprints of the texts a node holds now (agentNodeTexts), each worked out once in hashes.
func agentCurrentHashes(node map[string]any, hashes map[string]string) map[string]bool {
	current := map[string]bool{}
	for _, text := range agentNodeTexts(node) {
		h, ok := hashes[text]
		if !ok {
			h = agentTextHash(text)
			hashes[text] = h
		}
		current[h] = true
	}
	return current
}

// markAgentWords fingerprints, under the Agent's name, each text an Agent's change made: one it set to a new text on a
// node that was there, and every text of a node it added.
func markAgentWords(before, after map[string]any, name string) {
	prior, _ := canvasNodeRecords(before)
	nodes, order := canvasNodeRecords(after)
	for _, id := range order {
		node := nodes[id]
		was := map[string]string{}
		if old := prior[id]; old != nil {
			was = agentNodeTexts(old)
		}
		texts := agentNodeTexts(node)
		places := make([]string, 0, len(texts))
		for place := range texts {
			places = append(places, place)
		}
		sort.Strings(places)
		entries := newAgentWrittenSet(agentWrittenOf(node))
		changed := false
		for _, place := range places {
			if text := texts[place]; was[place] != text {
				changed = entries.add(agentWrittenEntry{H: agentTextHash(text), By: name}) || changed
			}
		}
		if changed {
			setAgentWritten(node, entries.entries)
		}
	}
}

// checkResultAuthors keeps, on a person's write, an Agent's name on a result (by) only where an Agent handed it in on
// that node: the very result kept before, or a text the node kept a fingerprint of under the very name the write sends
// (an undo of a hand-in a later write replaced). Any other by goes, and no other name is put in its place: a page's own
// writes never pass a member's result for an Agent's; a node new in this write (an undo of its deletion, a copy) keeps
// what it carries.
func checkResultAuthors(before, after map[string]any) {
	prior, _ := canvasNodeRecords(before)
	nodes, order := canvasNodeRecords(after)
	for _, id := range order {
		out, ok := nodes[id]["lastOutput"].(map[string]any)
		if _, named := out["by"]; !ok || !named {
			continue
		}
		old := prior[id]
		if old == nil {
			continue
		}
		text, _ := out["text"].(string)
		if source, _ := out["source"].(string); source == "manual" && text != "" {
			if was, ok := old["lastOutput"].(map[string]any); ok && sameCanvasValue(was["text"], out["text"]) && sameCanvasValue(was["by"], out["by"]) {
				continue
			}
			if name, handedIn := handInAuthor(out); handedIn && hasAgentWritten(agentWrittenOf(old), agentWrittenEntry{H: agentTextHash(text), By: name}) {
				out["by"] = map[string]any{"kind": "agent", "name": name}
				continue
			}
		}
		delete(out, "by")
	}
}


// recordAgentPages fingerprints each result of after that is held for an Agent's words (agentPageHolds), and each one
// held in before, whether after still shows it or replaced it: what an Agent's words made stays held after what fed it
// is gone, and a held result a write replaces or clears is still the Agent's should an undo bring it back (a hand-in
// older than the fingerprints, undone in a tab still open on an older page, included). hashes keeps the fingerprints
// worked out on the way (the two documents share most texts).
func recordAgentPages(before, after map[string]any, hashes map[string]string) {
	holds := agentPageHoldsWith(after, hashes)
	var held map[string]agentPageHold
	prior, _ := canvasNodeRecords(before)
	nodes, order := canvasNodeRecords(after)
	for _, id := range order {
		node := nodes[id]
		var entries *agentWrittenSet
		changed := false
		add := func(text string, names []string) {
			if text == "" || len(names) == 0 {
				return
			}
			h, ok := hashes[text]
			if !ok {
				h = agentTextHash(text)
				hashes[text] = h
			}
			if entries == nil {
				entries = newAgentWrittenSet(agentWrittenOf(node))
			}
			for _, name := range names {
				changed = entries.add(agentWrittenEntry{H: h, By: name}) || changed
			}
		}
		out, _ := node["lastOutput"].(map[string]any)
		text, _ := out["text"].(string)
		add(text, holds[id].names)
		if old := prior[id]; old != nil {
			was, _ := old["lastOutput"].(map[string]any)
			if wasText, _ := was["text"].(string); wasText != "" {
				if held == nil {
					held = agentPageHoldsWith(before, hashes)
				}
				add(wasText, held[id].names)
			}
		}
		if changed {
			setAgentWritten(node, entries.entries)
		}
	}
}

// pruneAgentWritten keeps a node's fingerprints within bounds: of each text the first agentWrittenNamesMax names it was
// kept under, each one of a text the node holds now, and of the rest the agentWrittenStaleMax that came last.
func pruneAgentWritten(node map[string]any) {
	pruneAgentWrittenWith(node, map[string]string{})
}

// pruneAgentWrittenWith is pruneAgentWritten reading fingerprints already worked out from hashes, by text.
func pruneAgentWrittenWith(node map[string]any, hashes map[string]string) {
	entries := agentWrittenOf(node)
	if len(entries) <= agentWrittenStaleMax && len(entries) <= agentWrittenNamesMax {
		return
	}
	current := agentCurrentHashes(node, hashes)
	first := make([]agentWrittenEntry, 0, len(entries))
	names := map[string]int{}
	for _, e := range entries {
		if names[e.H] < agentWrittenNamesMax {
			names[e.H]++
			first = append(first, e)
		}
	}
	kept := make([]agentWrittenEntry, 0, len(first))
	stale := 0
	for i := len(first) - 1; i >= 0; i-- {
		if e := first[i]; current[e.H] || stale < agentWrittenStaleMax {
			if !current[e.H] {
				stale++
			}
			kept = append(kept, e)
		}
	}
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	if len(kept) != len(entries) {
		setAgentWritten(node, kept)
	}
}

// agentPersonaDrift says whether a session's Agent would run instructions the saved node no longer shows as its persona, on
// a node an invited Agent wrote on (instructions are the Agent's, set from the node's persona, as it is, at its setup):
// they may be an Agent's persona whose fingerprint has gone since, and its result would be held for the persona the
// node shows, not the one it ran. So the run is refused until the node is set up again (node_setup_required), as a page
// does before every run. A node running another Agent (a workspace or market one) runs that Agent's instructions,
// whatever its persona; a canvas of people only runs as before.
func agentPersonaDrift(raw []byte, nodeID, instructions string) bool {
	if instructions == "" {
		return false
	}
	doc, err := decodeCanvasDocument(raw)
	if err != nil {
		return false
	}
	nodes, _ := canvasNodeRecords(doc)
	node := nodes[nodeID]
	if node == nil || node["kind"] != "session" || node["agentRef"] != nil {
		return false
	}
	if persona, _ := node["persona"].(string); persona == instructions {
		return false
	}
	return len(agentWrittenOf(node)) > 0
}

// handInAuthor is the name of the Agent that handed a result in: a result handed in ("manual") with by {kind: "agent"}.
func handInAuthor(out map[string]any) (string, bool) {
	by, _ := out["by"].(map[string]any)
	if source, _ := out["source"].(string); source != "manual" || by == nil || by["kind"] != "agent" {
		return "", false
	}
	name, _ := by["name"].(string)
	return agentName(name), true
}

// agentPageHolds says which results of a document are held for an invited Agent (agentPageHold), as the page reads
// them (agentPages.ts):
//   - a result an Agent handed in (by);
//   - any other result but a copied case's whose text a fingerprint of the node matches (it was held when it came);
//   - a run's result of a session running its own persona (no Agent chosen, not a media node) while that persona is an
//     Agent's text (a run never follows an Agent's persona the node no longer shows: agentPersonaDrift), and of an
//     assemble node while its template is;
//   - a run's result of an assemble node while a wire into it comes from a form with a label or value an Agent wrote,
//     from an image, video, 3D or edit node whose title an Agent wrote, or from a node whose result is held: through a
//     chain of assemble nodes too. A session that only reads an Agent's words is not held for them.
//
// Each hold carries the first agentHoldNamesMax names of all the Agents it is for, so it is the same whatever order the
// nodes are read in.
func agentPageHolds(doc map[string]any) map[string]agentPageHold {
	return agentPageHoldsWith(doc, map[string]string{})
}

// agentPageHoldsWith is agentPageHolds keeping the fingerprints it works out in hashes, by text.
//
// Names reach nodes in byte order, each along each wire at most once: a node's own, the names a form or a media node
// hands on along its wires into assemble nodes, and those of a result that reaches a wire (delivers) on along it into an
// assemble node whose run takes it, and on from there. A node keeps the first agentHoldNamesMax names that reach it (none
// after them can be among its first), so the work is that many names times the wires (each through a heap, so with its
// logarithm), whatever the order the nodes are listed in (a pass over every node until nothing changed took as many
// passes as the longest chain) or the names a document holds.
func agentPageHoldsWith(doc map[string]any, hashes map[string]string) map[string]agentPageHold {
	nodes, order := canvasNodeRecords(doc)
	states := make(map[string]*agentHoldState, len(order))
	arrivals := &agentArrivals{}
	for _, id := range order {
		states[id] = newAgentHoldState(nodes[id], hashes)
		for name := range states[id].own {
			heap.Push(arrivals, agentArrival{name: name, id: id})
		}
	}
	targets := map[string][]string{}
	for _, item := range collectionOf(doc, "edges") {
		edge, _ := item.(map[string]any)
		from, _ := edge["fromNode"].(string)
		to, _ := edge["toNode"].(string)
		if from == to || states[from] == nil || states[to] == nil || !states[to].takes {
			continue
		}
		targets[from] = append(targets[from], to)
		for name := range states[from].gives {
			heap.Push(arrivals, agentArrival{name: name, id: to})
		}
	}
	for arrivals.Len() > 0 {
		a := heap.Pop(arrivals).(agentArrival)
		s := states[a.id]
		if s.names[a.name] || len(s.names) == agentHoldNamesMax {
			continue
		}
		s.names[a.name] = true
		if s.delivers {
			for _, to := range targets[a.id] {
				heap.Push(arrivals, agentArrival{name: a.name, id: to})
			}
		}
	}
	out := map[string]agentPageHold{}
	for _, id := range order {
		if s := states[id]; len(s.names) > 0 {
			names := make([]string, 0, len(s.names))
			for name := range s.names {
				names = append(names, name)
			}
			sort.Strings(names)
			out[id] = agentPageHold{handedIn: s.handedIn, names: names}
		}
	}
	return out
}

// agentArrival is a name reaching a node in agentPageHoldsWith.
type agentArrival struct{ name, id string }

// agentArrivals are the names on their way, the first in byte order taken first (container/heap).
type agentArrivals []agentArrival

func (h agentArrivals) Len() int { return len(h) }
func (h agentArrivals) Less(i, j int) bool {
	if h[i].name != h[j].name {
		return h[i].name < h[j].name
	}
	return h[i].id < h[j].id
}
func (h agentArrivals) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *agentArrivals) Push(x any)   { *h = append(*h, x.(agentArrival)) }
func (h *agentArrivals) Pop() any {
	old := *h
	last := old[len(old)-1]
	*h = old[:len(old)-1]
	return last
}

// agentHoldState is one node in agentPageHolds: the names its own result is held for (own: the first
// agentHoldNamesMax), what its output hands on whatever it delivered (gives: a form's fields, a media node's title, the
// first agentHoldNamesMax), whether its result reaches a wire (delivers: a partial one too, as a review loop's unapproved
// round is read by the steps after it), whether its result takes the Agents' words its wires bring (takes: an assemble
// node's run), and the names it is held for once its wires are read (names).
type agentHoldState struct {
	handedIn, takes, delivers bool
	own, gives, names         map[string]bool
}

// firstNames keeps a set's first agentHoldNamesMax names in byte order.
func firstNames(set map[string]bool) {
	if len(set) <= agentHoldNamesMax {
		return
	}
	names := make([]string, 0, len(set))
	for name := range set {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names[agentHoldNamesMax:] {
		delete(set, name)
	}
}

func newAgentHoldState(node map[string]any, hashes map[string]string) *agentHoldState {
	s := &agentHoldState{own: map[string]bool{}, gives: map[string]bool{}, names: map[string]bool{}}
	byHash := map[string][]string{}
	for _, e := range agentWrittenOf(node) {
		byHash[e.H] = append(byHash[e.H], e.By)
	}
	match := func(v any, into map[string]bool) {
		text, _ := v.(string)
		if text == "" || len(byHash) == 0 {
			return
		}
		h, ok := hashes[text]
		if !ok {
			h = agentTextHash(text)
			hashes[text] = h
		}
		for _, name := range byHash[h] {
			into[name] = true
		}
	}
	kind, _ := node["kind"].(string)
	agentKind, _ := node["agentKind"].(string)
	media := kind == "session" && mediaAgentKind(agentKind)
	if out, ok := node["lastOutput"].(map[string]any); ok {
		if text, _ := out["text"].(string); text != "" {
			source, _ := out["source"].(string)
			if name, handedIn := handInAuthor(out); handedIn {
				s.handedIn, s.own[name] = true, true
			} else if source != "case" {
				match(text, s.own)
				// A run's result (the page reads any source but a hand-in or a case as one).
				if source != "manual" && kind == "session" && node["agentRef"] == nil && !media {
					match(node["persona"], s.own)
				}
				if source != "manual" && kind == "assemble" {
					match(node["template"], s.own)
					s.takes = true
				}
			}
			s.delivers = kind != "form"
		}
	}
	switch {
	case kind == "form":
		seen := map[string]bool{}
		for _, item := range collectionOf(node, "fields") {
			field, _ := item.(map[string]any)
			if id, ok := recordKey(item, "id"); ok && !seen[id] {
				seen[id] = true
				match(field["label"], s.gives)
				match(field["value"], s.gives)
			}
		}
	case kind == "edit" || media:
		match(node["title"], s.gives)
	}
	firstNames(s.own)
	firstNames(s.gives)
	return s
}

