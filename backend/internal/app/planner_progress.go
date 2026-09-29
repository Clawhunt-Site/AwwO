package app

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// A planning run withholds its proposal until the proposal has passed validation:
// unvalidated token fragments are not a canvas plan, and publishing them would let
// a reader act on structure nobody has checked. Withholding everything, though,
// left the browser nothing between "running" and the final answer, so a healthy run
// that streamed a proposal for a minute was indistinguishable from a stalled one.
//
// plannerProgress reports what such a run is measurably doing instead — how much of
// the proposal has arrived, how many nodes and connections it has declared, which
// template the latest node uses, how much the model has reasoned — and never a byte of
// what it wrote. The template is the one value taken from the stream, and only as a
// member of the closed template set the plan gate itself accepts, so no free text the
// model produced can cross. Every number is observed, never estimated: the proposal's
// final length is unknown until it ends, so nothing here is, or can be turned into, a
// completion ratio.

const (
	// Progress rows are coalesced to at most one per interval. A stage change or a
	// newly declared node is reported sooner, because those are what a reader waits
	// for; the running character counts can wait for the next tick. Even those wait
	// the urgent interval, so a model emitting nothing but markers cannot turn every
	// delta into a database row.
	plannerProgressInterval       = time.Second
	plannerProgressUrgentInterval = 200 * time.Millisecond
	// A progress row is observability: it may hold the stream up this long at most,
	// whatever the pool or a concurrent terminal transaction is doing.
	plannerProgressWriteTimeout = time.Second
	// Matched as whole quoted JSON literals, exactly as the browser counts them, so a
	// field whose value mentions add_node inside other text, a "disconnect", or a
	// field type can never be counted as a declared node or connection.
	plannerNodeMarker = `"add_node"`
	plannerEdgeMarker = `"connect"`
	// How much of the stream the template is read from. A node's templateId is found only
	// while its marker is still inside this window, so it bounds both the scan and how far
	// apart a model may write the two; a template written further away is simply not shown.
	plannerTemplateTail = 2048
	// A worker that opts in reports provider reasoning as a count. Sent only on a
	// planner admission: every other run keeps sending exactly the request it sent
	// before, and a worker that does not know the header simply ignores it.
	runActivityHeader    = "X-Awwo-Run-Activity"
	runActivityReasoning = "reasoning"
)

// planTemplateIDs is the closed template set a proposal may declare. The plan gate
// validates against it, and progress reports a template only when it is one of these.
var planTemplateIDs = []string{"general", "frontend", "backend", "data", "users", "materials", "review"}

var plannerTemplatePattern = regexp.MustCompile(`^"templateId"\s{0,8}:\s{0,8}"([a-z]{1,16})"`)

type plannerProgressFrame struct {
	Type       string `json:"type"`
	Stage      string `json:"stage"`
	Characters int    `json:"characters"`
	Nodes      int    `json:"nodes"`
	Edges      int    `json:"edges"`
	Reasoning  int    `json:"reasoning"`
	Template   string `json:"template,omitempty"`
}

// markerCount counts one marker across a stream without rescanning it. Only the new
// bytes are searched, behind a tail one byte shorter than the marker: that finds a
// marker split across deltas, and a marker can never lie wholly inside the tail, so
// none is counted twice. The marker is ASCII and ASCII bytes never occur inside a
// multi-byte rune, so a byte-wise search is exact however the deltas were cut.
type markerCount struct {
	marker string
	tail   string
	total  int
}

func (m *markerCount) add(chunk string) {
	window := m.tail + chunk
	m.total += strings.Count(window, m.marker)
	if keep := len(m.marker) - 1; len(window) > keep {
		m.tail = window[len(window)-keep:]
	} else {
		m.tail = window
	}
}

type plannerProgress struct {
	characters int // runes of the published-to-be proposal received so far
	nodes      markerCount
	edges      markerCount
	template   string
	// The template window is rescanned whole each time; re-finding a pair already
	// seen only confirms the same latest value, so overlap needs no bookkeeping.
	templateTail string
	// Reasoning arrives two ways: spans the stream filter withheld from the
	// proposal, and counts a worker reported for reasoning its provider streamed
	// in a separate field. They are kept apart because the worker's figure is
	// cumulative and the filter's is summed here.
	inlineReasoning int
	workerReasoning int
	// A worker may report that reasoning started before any of it is visible, as
	// providers that hide the reasoning text do; that is still a real stage.
	reasoningSeen bool
	last          plannerProgressFrame
	lastAt        time.Time
	warned        bool
}

// write records a delta of the proposal itself. Counting happens on the bytes the
// filter released, so reasoning that precedes the proposal is never counted as it.
func (p *plannerProgress) write(visible string) {
	if visible == "" {
		return
	}
	if p.nodes.marker == "" {
		p.nodes.marker, p.edges.marker = plannerNodeMarker, plannerEdgeMarker
	}
	p.characters += utf8.RuneCountInString(visible)
	p.nodes.add(visible)
	p.edges.add(visible)
	window := p.templateTail + visible
	if template, decided := newestNodeTemplate(window); decided {
		p.template = template
	}
	if len(window) > plannerTemplateTail {
		window = window[len(window)-plannerTemplateTail:]
	}
	p.templateTail = window
}

// newestNodeTemplate reads the template of the newest declared node from a window of the
// stream, or reports that the window cannot decide. Only a templateId key written after that
// node's marker, directly inside the same operation object, counts: the object is walked as
// JSON from the marker, so a templateId inside a nested value, inside a string, or in a later
// operation (a model that writes templateId ahead of "type" for its next node) never names
// this one. Without a template of its own the newest node shows none, never a predecessor's.
// When the newest marker is not inside the window the previous decision stands, because the
// text after it that could change it has already been read.
func newestNodeTemplate(window string) (string, bool) {
	marker := strings.LastIndex(window, plannerNodeMarker)
	if marker < 0 {
		return "", false
	}
	template := ""
	s := window[marker+len(plannerNodeMarker):]
	depth, inString, escaped := 0, false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '{', '[':
			depth++
		case '}', ']':
			if depth == 0 {
				return template, true // the operation object closed
			}
			depth--
		case '"':
			if depth == 0 {
				if match := plannerTemplatePattern.FindStringSubmatch(s[i:]); match != nil {
					template = ""
					if slices.Contains(planTemplateIDs, match[1]) {
						template = match[1]
					}
					i += len(match[0]) - 1
					continue
				}
			}
			inString = true
		}
	}
	return template, true
}

// reasonInline records runes the stream filter withheld as a leading reasoning span.
func (p *plannerProgress) reasonInline(runes int) {
	if runes > 0 {
		p.inlineReasoning += runes
		p.reasoningSeen = true
	}
}

// reasonReported records a worker's cumulative reasoning count. A smaller figure
// than one already seen is a worker that restarted counting, never lost work, so
// the count only moves forward.
func (p *plannerProgress) reasonReported(characters int) {
	p.reasoningSeen = true
	if characters > p.workerReasoning {
		p.workerReasoning = characters
	}
}

func (p *plannerProgress) frame() plannerProgressFrame {
	stage := ""
	switch {
	case p.characters > 0:
		// Once the proposal is arriving it stays the stage, even if the model
		// interleaves more reasoning: the reader's question is how far it has got.
		stage = "streaming"
	case p.reasoningSeen:
		stage = "thinking"
	}
	return plannerProgressFrame{Type: "progress", Stage: stage, Characters: p.characters, Nodes: p.nodes.total, Edges: p.edges.total,
		Reasoning: p.inlineReasoning + p.workerReasoning, Template: p.template}
}

// due returns the frame to publish now, if any. Nothing is published before the run
// has observably started to produce something, and an unchanged frame never twice.
func (p *plannerProgress) due(now time.Time) (plannerProgressFrame, bool) {
	next := p.frame()
	if next.Stage == "" || next == p.last {
		return next, false
	}
	// A new stage, node, connection or template is what a reader waits for.
	urgent := next.Stage != p.last.Stage || next.Nodes != p.last.Nodes || next.Edges != p.last.Edges || next.Template != p.last.Template
	wait := plannerProgressInterval
	if urgent {
		wait = plannerProgressUrgentInterval
	}
	if now.Sub(p.lastAt) < wait {
		return next, false
	}
	p.last, p.lastAt = next, now
	return next, true
}

// reportPlannerProgress persists the current frame when one is due. It is
// observability, not the result: a row that cannot be written costs the reader one
// update and never the run, and the frame is still treated as sent so a failing
// database is not asked again on every token.
func (a *App) reportPlannerProgress(ctx context.Context, tid, id string, p *plannerProgress) {
	frame, ok := p.due(time.Now())
	if !ok {
		return
	}
	data, _ := json.Marshal(frame)
	// A cancelled or expired run fails this write by design; only a database that
	// refused a live run is worth a note, and one note per run is enough.
	if e := a.appendRunProgress(ctx, tid, id, data); e == nil || p.warned || ctx.Err() != nil {
		return
	}
	p.warned = true
	a.log.Warn("planner progress was not recorded; the run continues", "event", "planner_progress_skipped")
}

// appendRunProgress writes a progress row only while the run is still running, so a
// late frame can never land after the terminal event a reader stops at. The row lock is
// what makes that true: a plain read would not wait for a concurrent cancel or suspension
// that has already inserted its terminal event but not committed, and the progress row,
// holding a later id, could then commit first, so a reader whose cursor passed that id
// would never see the terminal event. FOR SHARE waits for that transaction and re-checks
// the status once it commits; a terminal writer in turn waits for this statement, whose
// row therefore precedes its event. A run that already ended is not an error: there is
// simply nothing left to report on.
func (a *App) appendRunProgress(ctx context.Context, tid, id string, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, plannerProgressWriteTimeout)
	defer cancel()
	tag, e := a.db.Exec(ctx, `WITH live AS (
		SELECT tenant_id,id FROM runs WHERE tenant_id=$1 AND id=$2 AND status='running' FOR SHARE
	)
	INSERT INTO run_events(tenant_id,run_id,data) SELECT tenant_id,id,$3 FROM live`, tid, id, data)
	if e != nil {
		return e
	}
	if tag.RowsAffected() > 0 {
		a.notifyRunEvent(id)
	}
	return nil
}

func plannerActivityHeader() http.Header {
	return http.Header{runActivityHeader: []string{runActivityReasoning}}
}
