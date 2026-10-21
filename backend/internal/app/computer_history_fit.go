package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"sort"
	"strconv"
	"unicode/utf8"
)

// A direct task's turn keeps every tool call and every tool result it gathered, so its model calls grow until one no
// longer fits its model (2026-10-16: a qwen3.8-27b task's tenth call was refused at 7,332 tokens of input, and the task
// ended). Such a call goes without the bulk of its oldest tool traffic instead, oldest first: an earlier tool result
// keeps its first bytes (what a receipt says: ok, its path, published) and a note of how much more it returned, and an
// earlier tool call keeps its arguments' keys and short values (a path, a command), with a note in place of each long
// value. A result or arguments under minToolTrafficCut bytes stays whole: what a short receipt says is worth its room.
// Each note says the call ran and its effects stand, so that the model reads again what it needs rather than repeat an
// action. The latest exchange (the last answer that called tools, and everything after it), the task's words and every
// other text stay as sent; only those bytes change (nothing else is re-encoded), and the caller validates the result
// again.
const (
	minToolTrafficCut    = 1024
	keptToolResultBytes  = 256
	longToolArgument     = 256
	omittedToolResult    = " [… %d more bytes of this earlier tool result were left out so that this call fits the model's context. The call ran and its effects stand; to see the rest, read it again (a file, say) rather than repeat an action.]"
	omittedToolArgument  = "[%d bytes left out so that this call fits the model's context; the call ran with them]"
	omittedToolArguments = `{"omitted":"the arguments of this earlier tool call (%d bytes) were left out so that this call fits the model's context; the call ran with them"}`
)

// toolTrafficMessage is where one message of a completion request is: its role, the byte ranges, inside their quotes,
// of its texts (string content and the text of content parts), its tool calls (an answer's) and the call it answers (a
// tool result's).
type toolTrafficMessage struct {
	role       string
	texts      [][2]int
	calls      []toolTrafficCall
	toolCallID string
}

// toolTrafficCall is one tool call of an answer: its id, its name, and where its arguments are, inside their quotes
// (ok: they are a string).
type toolTrafficCall struct {
	id, name  string
	arguments [2]int
	ok        bool
}

type trafficCut struct {
	span [2]int
	with []byte
}

// toolTrafficFit is a completion request that goes without some of its earlier tool traffic: the request, how many of
// its earlier messages it cut (oldest first), which of its messages are tool results it cut, and which of those the
// fewest messages that fit at all would cut (needed: the others go for the room the next calls get, or because the
// last call cut them).
type toolTrafficFit struct {
	raw             []byte
	cut             int
	results, needed map[int]bool
}

// trafficState is what a direct task's model calls went without of their earlier tool traffic, for the calls after
// them: how many earlier messages the last call the task made cut (where the next one starts), the results it lost
// (each a resultPrints print: every copy of it cut), and those the calls since the task last brought anything new have
// brought back (thrashesLocked).
type trafficState struct {
	sticky int
	lost   map[string]bool
	run    map[string]bool
}

// stickyCut is how many earlier messages the task's last call cut.
func (l *computerLease) stickyCut() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.traffic.sticky
}

// trafficLocked is what the lease remembers of its calls' tool traffic (l.mu held), for the log of a call that ends its
// task: how many earlier messages the last call cut, how many results it lost, how many the row has brought back.
func (l *computerLease) trafficLocked() (sticky, lost, row int) {
	return l.traffic.sticky, len(l.traffic.lost), len(l.traffic.run)
}

// thrashesLocked says, for a call the task makes (l.mu held), whether its latest exchange brings back again a result
// the task's calls had lost and already brought back once since the task last brought anything new: what it works with
// does not fit its model, and its turn would only trade one result for another until its calls ran out. Reading again
// what it lost, as the note asks, is not that, nor is a result that changed (an edit read again, a check run after a
// fix), one its last call still had whole, or one asked twice in one answer.
func (l *computerLease) thrashesLocked(latest map[string]bool) bool {
	for result := range latest {
		if !l.traffic.lost[result] {
			l.traffic.run = nil // something new: the turn is not going round in circles
			return false
		}
	}
	if len(latest) == 0 {
		l.traffic.run = nil
		return false
	}
	for result := range latest {
		if l.traffic.run[result] {
			return true
		}
	}
	if l.traffic.run == nil {
		l.traffic.run = map[string]bool{}
	}
	for result := range latest {
		l.traffic.run[result] = true
	}
	return false
}

// noteTrafficLocked remembers, for a call the task makes (l.mu held), how many earlier messages it cut and the results
// it lost; a call that went whole (sticky 0) lost nothing, and the next call starts over.
func (l *computerLease) noteTrafficLocked(sticky int, lost map[string]bool) {
	l.traffic.sticky, l.traffic.lost = sticky, lost
	if sticky == 0 {
		l.traffic.run = nil
	}
}

// trafficFit is a call's turn as it goes (raw, fitted: it went without some of its earlier tool traffic), how many
// earlier messages it cut and what it lost, and what its latest exchange brings (latestPrints).
type trafficFit struct {
	raw          []byte
	fitted       bool
	cut          int
	latest, lost map[string]bool
}

// fitTraffic goes without the bulk of a call's earlier tool traffic when the call does not fit its model (over),
// changing nothing on the lease. What it lost is what the fewest messages that fit cut entirely: a result cut only for
// the room the next calls get, or because the last call cut it, is not what the task cannot hold, and reading it again
// is no sign of going round.
func fitTraffic(lease *computerLease, raw []byte, over bool) trafficFit {
	fit := trafficFit{raw: raw}
	if !over {
		return fit
	}
	messages, ok := toolTraffic(raw)
	if !ok {
		return fit
	}
	within := func(budget int) func([]byte) bool {
		return func(candidate []byte) bool {
			c, _, err := validateComputerCompletionAt(candidate, budget, lease.snapshot.ProseRate)
			return err == nil && computerCallFitsWithin(candidate, c, lease, budget)
		}
	}
	budget := lease.snapshot.Budget
	if f, ok := withoutOldToolTraffic(raw, messages, within(budget), within(budget-budget/5), lease.stickyCut()); ok {
		prints := resultPrints(raw, messages)
		fit.raw, fit.fitted, fit.cut = f.raw, true, f.cut
		fit.latest, fit.lost = latestPrints(messages, prints), lostPrints(prints, f.needed)
	}
	return fit
}

// readingTools are the direct task's tools that only read (apps/openmaus-worker advertises them): what one of their
// results brings again is no progress. A write, a publish, an archive and a command, which may change the workspace
// however alike their output, are something new every time (latestPrints).
var readingTools = map[string]bool{"awwo_workspace_read": true, "awwo_workspace_list": true}

// resultPrints are, by message, what makes each result of a reading tool the same result again (its call's name and
// arguments as sent, and its text as sent, hashed), or "" for a message that is no such result.
func resultPrints(raw []byte, messages []toolTrafficMessage) []string {
	keys := map[string]string{}
	for _, m := range messages {
		for _, c := range m.calls {
			if c.ok && c.id != "" && readingTools[c.name] {
				keys[c.id] = c.name + "\x00" + string(raw[c.arguments[0]:c.arguments[1]])
			}
		}
	}
	prints := make([]string, len(messages))
	for i, m := range messages {
		if key := keys[m.toolCallID]; m.role == "tool" && key != "" {
			h := sha256.New()
			h.Write([]byte(key))
			for _, span := range m.texts {
				h.Write([]byte{0})
				h.Write(raw[span[0]:span[1]])
			}
			prints[i] = hex.EncodeToString(h.Sum(nil))
		}
	}
	return prints
}

// latestPrints are the prints of the latest exchange's results; each of its other results (another tool's, or one of
// no known call) counts as something new, which no call lost.
func latestPrints(messages []toolTrafficMessage, prints []string) map[string]bool {
	latest := map[string]bool{}
	for i := latestExchange(messages); i < len(messages); i++ {
		switch {
		case prints[i] != "":
			latest[prints[i]] = true
		case messages[i].role == "tool":
			latest["new "+strconv.Itoa(i)] = true
		}
	}
	return latest
}

// lostPrints are the results a call that cut the results it names goes without entirely: every copy of each is cut.
func lostPrints(prints []string, cut map[int]bool) map[string]bool {
	kept := map[string]bool{}
	for i, result := range prints {
		if result != "" && !cut[i] {
			kept[result] = true
		}
	}
	lost := map[string]bool{}
	for i, result := range prints {
		if result != "" && cut[i] && !kept[result] {
			lost[result] = true
		}
	}
	return lost
}

// withoutOldToolTraffic is the completion request (its messages read by toolTraffic) without the bulk of as much of its
// earlier tool traffic as it needs to fit (fits), oldest first, or false when it holds none to leave out or leaving all
// of it out is not enough. A turn whose first sticky messages a call went without goes without them again where that
// fits, so that the call starts as that one did, which a provider's prompt cache keeps; past them it goes without enough
// for roomy, which leaves the next calls room to grow before the cut moves again, else as little as fits. Both fits and
// roomy only ever say yes to more of a request's traffic left out once they have said yes to less.
func withoutOldToolTraffic(raw []byte, messages []toolTrafficMessage, fits, roomy func([]byte) bool, sticky int) (toolTrafficFit, bool) {
	type group struct {
		cuts   []trafficCut
		index  int
		result bool
	}
	var groups []group
	for i, m := range messages[:latestExchange(messages)] {
		if cuts := messageCuts(raw, m); len(cuts) > 0 {
			groups = append(groups, group{cuts, i, m.role == "tool"})
		}
	}
	fit := func(n int) toolTrafficFit {
		var cuts []trafficCut
		results := map[int]bool{}
		for _, g := range groups[:n] {
			cuts = append(cuts, g.cuts...)
			if g.result {
				results[g.index] = true
			}
		}
		return toolTrafficFit{withTrafficCuts(raw, cuts), n, results, nil}
	}
	// The fewest messages, from `from` on, whose cut says yes to ok.
	fewest := func(from int, ok func([]byte) bool) (toolTrafficFit, bool) {
		if from > len(groups) {
			return toolTrafficFit{}, false
		}
		n := from + sort.Search(len(groups)-from+1, func(i int) bool { return ok(fit(from + i).raw) })
		if n > len(groups) {
			return toolTrafficFit{}, false
		}
		return fit(n), true
	}
	// What the call needs to go without, whatever more it goes without: the fewest messages that fit, from the first
	// (least: f is that already).
	needed := func(f toolTrafficFit, least bool) (toolTrafficFit, bool) {
		f.needed = f.results
		if least {
			return f, true
		}
		if n := 1 + sort.Search(f.cut-1, func(i int) bool { return fits(fit(1 + i).raw) }); n < f.cut {
			f.needed = fit(n).results
		}
		return f, true
	}
	from := 1
	if sticky > 0 && sticky <= len(groups) {
		if f := fit(sticky); fits(f.raw) {
			return needed(f, false)
		}
		from = sticky + 1
	}
	if f, ok := fewest(from, roomy); ok {
		return needed(f, false)
	}
	// The fewest that fit from here are the fewest that fit at all: a sticky cut that did not fit is fewer than those.
	if f, ok := fewest(from, fits); ok {
		return needed(f, true)
	}
	return toolTrafficFit{}, false
}

// latestExchange is the index of the last answer that called tools, where the latest exchange starts (0 for none).
func latestExchange(messages []toolTrafficMessage) int {
	latest := 0
	for i, m := range messages {
		if m.role == "assistant" && slices.ContainsFunc(m.calls, func(c toolTrafficCall) bool { return c.ok }) {
			latest = i
		}
	}
	return latest
}

// messageCuts are the cuts of one earlier message (none for one that is no tool traffic).
func messageCuts(raw []byte, m toolTrafficMessage) []trafficCut {
	var cuts []trafficCut
	switch m.role {
	case "tool":
		for _, span := range m.texts {
			if cut, ok := resultCut(raw, span); ok {
				cuts = append(cuts, cut)
			}
		}
	case "assistant":
		for _, c := range m.calls {
			if cut, ok := argumentsCut(raw, c); ok {
				cuts = append(cuts, cut)
			}
		}
	}
	return cuts
}

// resultCut keeps the first keptToolResultBytes of a tool result of minToolTrafficCut bytes or more, never splitting an
// escape or a character, and a note of how much more it returned.
func resultCut(raw []byte, span [2]int) (trafficCut, bool) {
	if span[1]-span[0] < minToolTrafficCut {
		return trafficCut{}, false
	}
	head := stringHead(raw, span, keptToolResultBytes)
	return trafficCut{[2]int{head, span[1]}, jsonStringForms(fmt.Sprintf(omittedToolResult, decodedLength(raw[head:span[1]])))[0]}, true
}

// argumentsCut keeps the arguments of minToolTrafficCut bytes or more of a tool call as the object they are, every
// string value over longToolArgument bytes replaced by a note, or, when they are no JSON object, as one note.
func argumentsCut(raw []byte, c toolTrafficCall) (trafficCut, bool) {
	span := c.arguments
	if !c.ok || span[1]-span[0] < minToolTrafficCut {
		return trafficCut{}, false
	}
	var arguments string
	if json.Unmarshal(quoted(raw[span[0]:span[1]]), &arguments) != nil {
		return trafficCut{}, false
	}
	text := []byte(arguments)
	var with []byte
	if long, ok := longStrings(text, longToolArgument); !ok {
		with = jsonStringForms(fmt.Sprintf(omittedToolArguments, len(text)))[0]
	} else if len(long) == 0 {
		return trafficCut{}, false
	} else {
		cuts := make([]trafficCut, len(long))
		for i, s := range long {
			cuts[i] = trafficCut{s, jsonStringForms(fmt.Sprintf(omittedToolArgument, decodedLength(text[s[0]:s[1]])))[0]}
		}
		with = jsonStringForms(string(withTrafficCuts(text, cuts)))[0]
	}
	if len(with) >= span[1]-span[0] {
		return trafficCut{}, false
	}
	return trafficCut{span, with}, true
}

// longStrings are where, inside their quotes, the string values (not the keys) of a JSON object that are over limit
// bytes as written are, at any depth, or false when text is not one JSON object.
func longStrings(text []byte, limit int) ([][2]int, bool) {
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.UseNumber()
	// Each open object or array: whether it is an object, and whether its next token is a key.
	type level struct{ object, key bool }
	var stack []level
	var spans [][2]int
	for opened := false; ; {
		from := int(decoder.InputOffset())
		token, e := decoder.Token()
		if e == io.EOF && opened && len(stack) == 0 {
			return spans, true
		}
		if e != nil || (!opened && token != json.Delim('{')) || (opened && len(stack) == 0) {
			return nil, false
		}
		opened = true
		if n := len(stack); n > 0 && stack[n-1].object && stack[n-1].key && token != json.Delim('}') {
			stack[n-1].key = false // a key: its value comes next
			continue
		}
		if n := len(stack); n > 0 && stack[n-1].object {
			stack[n-1].key = true // a value: a key, or the end, comes next
		}
		switch token {
		case json.Delim('{'):
			stack = append(stack, level{object: true, key: true})
		case json.Delim('['):
			stack = append(stack, level{})
		case json.Delim('}'), json.Delim(']'):
			stack = stack[:len(stack)-1]
		default:
			if _, ok := token.(string); ok {
				span := [2]int{from + bytes.IndexByte(text[from:], '"') + 1, int(decoder.InputOffset()) - 1}
				if span[1]-span[0] > limit {
					spans = append(spans, span)
				}
			}
		}
	}
}

// stringHead is where, within a JSON string as written (span: inside its quotes), its first keep bytes end without
// splitting an escape (a surrogate pair's two halves together) or a UTF-8 character.
func stringHead(raw []byte, span [2]int, keep int) int {
	at := span[0]
	for at < span[1] {
		n := 1
		switch c := raw[at]; {
		case c == '\\' && at+1 < span[1] && raw[at+1] == 'u':
			n = 6
			if high, e := strconv.ParseUint(string(raw[at+2:min(at+6, span[1])]), 16, 16); e == nil && high >= 0xD800 && high <= 0xDBFF &&
				at+12 <= span[1] && raw[at+6] == '\\' && raw[at+7] == 'u' {
				n = 12
			}
		case c == '\\':
			n = 2
		case c >= utf8.RuneSelf:
			_, n = utf8.DecodeRune(raw[at:span[1]])
		}
		if at+n-span[0] > keep {
			break
		}
		at += n
	}
	return min(at, span[1])
}

// decodedLength is how many bytes a JSON string's content, as written, stands for.
func decodedLength(written []byte) int {
	var s string
	if json.Unmarshal(quoted(written), &s) != nil {
		return len(written)
	}
	return len(s)
}

func quoted(written []byte) []byte {
	return append(append([]byte{'"'}, written...), '"')
}

// withTrafficCuts is raw with each cut's bytes replaced.
func withTrafficCuts(raw []byte, cuts []trafficCut) []byte {
	sorted := slices.Clone(cuts)
	slices.SortFunc(sorted, func(a, b trafficCut) int { return a.span[0] - b.span[0] })
	out, at := make([]byte, 0, len(raw)), 0
	for _, cut := range sorted {
		out, at = append(append(out, raw[at:cut.span[0]]...), cut.with...), cut.span[1]
	}
	return append(out, raw[at:]...)
}

// toolTraffic reads where each message of a completion request is (toolTrafficMessage), or false when raw is not one
// JSON object.
func toolTraffic(raw []byte) ([]toolTrafficMessage, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var messages []toolTrafficMessage
	// read reads a value's first token, and the byte range inside its quotes when it is a string (only blanks and ':'
	// come between a key and the opening quote of its value).
	read := func() (json.Token, [2]int, bool, error) {
		from := int(decoder.InputOffset())
		token, e := decoder.Token()
		if _, text := token.(string); e == nil && text {
			return token, [2]int{from + bytes.IndexByte(raw[from:], '"') + 1, int(decoder.InputOffset()) - 1}, true, nil
		}
		return token, [2]int{}, false, e
	}
	// skip reads the rest of a value whose first token was read.
	skip := func(token json.Token) error {
		if token != json.Delim('{') && token != json.Delim('[') {
			return nil
		}
		for depth := 1; depth > 0; {
			t, e := decoder.Token()
			if e != nil {
				return e
			}
			switch t {
			case json.Delim('{'), json.Delim('['):
				depth++
			case json.Delim('}'), json.Delim(']'):
				depth--
			}
		}
		return nil
	}
	// members calls each with every key of the object whose '{' was read, then reads its '}'.
	members := func(each func(key string) error) error {
		for decoder.More() {
			key, e := decoder.Token()
			if e != nil {
				return e
			}
			if e = each(key.(string)); e != nil {
				return e
			}
		}
		_, e := decoder.Token()
		return e
	}
	// elements calls each with the first token of every element of the array whose '[' was read, then reads its ']'.
	elements := func(each func(first json.Token) error) error {
		for decoder.More() {
			first, e := decoder.Token()
			if e != nil {
				return e
			}
			if e = each(first); e != nil {
				return e
			}
		}
		_, e := decoder.Token()
		return e
	}
	// field reads an object's members, recording the string value of key into *spans.
	field := func(first json.Token, key string, spans *[][2]int) error {
		if first != json.Delim('{') {
			return skip(first)
		}
		return members(func(k string) error {
			token, span, text, e := read()
			if e != nil {
				return e
			}
			if k == key && text {
				*spans = append(*spans, span)
			}
			return skip(token)
		})
	}
	// call reads one tool call of an answer (its id, and its function's name and arguments).
	call := func(first json.Token) (toolTrafficCall, error) {
		var c toolTrafficCall
		if first != json.Delim('{') {
			return c, skip(first)
		}
		// Read first, then returned: members fills c.
		e := members(func(k string) error {
			token, _, text, e := read()
			switch {
			case e != nil:
				return e
			case k == "id" && text:
				c.id = token.(string)
			case k == "function" && token == json.Delim('{'):
				return members(func(k string) error {
					token, span, text, e := read()
					switch {
					case e != nil:
						return e
					case k == "name" && text:
						c.name = token.(string)
					case k == "arguments" && text:
						c.arguments, c.ok = span, true
					}
					return skip(token)
				})
			}
			return skip(token)
		})
		return c, e
	}
	message := func(first json.Token) error {
		messages = append(messages, toolTrafficMessage{})
		at := len(messages) - 1
		if first != json.Delim('{') {
			return skip(first)
		}
		return members(func(key string) error {
			token, span, text, e := read()
			if e != nil {
				return e
			}
			switch {
			case key == "role" && text:
				messages[at].role = token.(string)
			case key == "tool_call_id" && text:
				messages[at].toolCallID = token.(string)
			case key == "content" && text:
				messages[at].texts = append(messages[at].texts, span)
			case key == "content" && token == json.Delim('['):
				return elements(func(part json.Token) error { return field(part, "text", &messages[at].texts) })
			case key == "tool_calls" && token == json.Delim('['):
				return elements(func(first json.Token) error {
					c, e := call(first)
					if e == nil && first == json.Delim('{') {
						messages[at].calls = append(messages[at].calls, c)
					}
					return e
				})
			}
			return skip(token)
		})
	}
	if first, e := decoder.Token(); e != nil || first != json.Delim('{') {
		return nil, false
	}
	e := members(func(key string) error {
		token, e := decoder.Token()
		if e == nil && key == "messages" && token == json.Delim('[') {
			return elements(message)
		}
		if e != nil {
			return e
		}
		return skip(token)
	})
	if e != nil {
		return nil, false
	}
	if _, e = decoder.Token(); e != io.EOF {
		return nil, false
	}
	return messages, true
}
