package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The gate holds back exactly what may still be a page request, across any split of the deltas, and lets an answer go
// the moment it cannot be one.
func TestPageRequestGateHoldsOnlyWhatMayBeARequest(t *testing.T) {
	cases := []struct {
		name     string
		deltas   []string
		released string
		request  bool
	}{
		{"a request split mid-tag", []string{"  \n", "AW", "WO-READ-PA", `GES {"urls":["https://a.example/x"]}`}, "", true},
		{"a fenced request", []string{"``", "`json\n", `AWWO-READ-PAGES {"urls":[]}`, "\n```"}, "", true},
		// A CRLF fence whose \r arrives before its \n.
		{"a CRLF fenced request", []string{"```json\r", "\nAWWO-READ-PAGES {\"urls\":[]}\r\n", "```"}, "", true},
		{"an answer that starts like the tag", []string{"AW", "ESOME answer"}, "AWESOME answer", false},
		{"an answer at once", []string{"Hello", " there"}, "Hello there", false},
		{"a code block that is not a request", []string{"```go\nfunc main() {}\n```"}, "```go\nfunc main() {}\n```", false},
		{"a fence with a long info word", []string{"```" + strings.Repeat("x", 20)}, "```" + strings.Repeat("x", 20), false},
		// Prose that names the tag is an answer: a request is the tag and then its object.
		{"prose that names the tag", []string{pageRequestTag, " is the line ", "a model asks with."}, pageRequestTag + " is the line a model asks with.", false},
		{"the tag and its object with no space", []string{pageRequestTag + `{"urls":[]}`}, "", true},
		// The object on the tag's next line, as the parser takes it.
		{"the object on the next line", []string{pageRequestTag + "\n", `{"urls":["https://a.example/x"]}`}, "", true},
		{"the object on the next line after a CRLF", []string{pageRequestTag + "\r", "\n{\"urls\":[]}"}, "", true},
		{"the tag on its own line, then prose", []string{pageRequestTag + "\n", "is how a model asks."}, pageRequestTag + "\nis how a model asks.", false},
		// A request stays held whole however long it runs: it is read or refused, never answered with.
		{"a request far longer than any address list", []string{pageRequestTag + ` {"urls":["`, strings.Repeat("u", 2*pageRequestLimit), `"]}`}, "", true},
		// More white space than a request has before it: an answer, released whole.
		{"an answer padded with white space", []string{strings.Repeat(" ", pageRequestLeadMax+1), pageRequestTag + ` {"urls":[]}`}, strings.Repeat(" ", pageRequestLeadMax+1) + pageRequestTag + ` {"urls":[]}`, false},
		{"white space between the tag and its object", []string{pageRequestTag + strings.Repeat(" ", pageRequestLeadMax+1) + "{"}, pageRequestTag + strings.Repeat(" ", pageRequestLeadMax+1) + "{", false},
	}
	// Every split of a request's text into two deltas, LF and CRLF, is held whole: no split lets part of it out.
	for _, whole := range []string{"```json\n" + pagesRequestLine + "\n```", "```json\r\n" + pagesRequestLine + "\r\n```", "  " + pagesRequestLine} {
		for at := 0; at <= len(whole); at++ {
			g := &pageRequestGate{}
			if out := g.push(whole[:at]) + g.push(whole[at:]); out != "" || !g.requested() {
				t.Fatalf("split at %d of %q released %q (requested %v)", at, whole, out, g.requested())
			}
		}
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := &pageRequestGate{}
			var released strings.Builder
			for _, d := range c.deltas {
				released.WriteString(g.push(d))
			}
			if released.String() != c.released || g.requested() != c.request {
				t.Fatalf("released %q (requested %v), want %q (%v)", released.String(), g.requested(), c.released, c.request)
			}
			if c.request && !g.holding() {
				t.Fatal("a request is held, never streamed")
			}
		})
	}
	// The whole answer, as a worker that sends no delta delivers it, is judged the same way.
	for text, want := range map[string]gateState{
		pageRequestTag + ` {"urls":[]}`:                                              gateRequest,
		"```\n" + pageRequestTag + ` {"urls":[]}` + "\n```":                          gateRequest,
		pageRequestTag + " explained in prose":                                       gatePass,
		pageRequestTag + "\r\n" + `{"urls":[]}`:                                      gateRequest,
		strings.Repeat("\n", pageRequestLeadMax+1) + pageRequestTag + ` {"urls":[]}`: gatePass,
		pageRequestTag: gateDeciding,
	} {
		if got := pageRequestStart(text); got != want {
			t.Fatalf("%q judged %v, want %v", text, got, want)
		}
	}
	// No gate (a run that offers no reads) passes everything through untouched.
	var none *pageRequestGate
	if none.push(pageRequestTag) != pageRequestTag || none.requested() || none.holding() {
		t.Fatal("a nil gate must pass text through")
	}
}

func TestParsePageRequest(t *testing.T) {
	urls, problem := parsePageRequest("  AWWO-READ-PAGES {\"urls\":[\"https://a.example/x\",\"https://b.example/y\"]}\n")
	if problem != "" || len(urls) != 2 || urls[1] != "https://b.example/y" {
		t.Fatalf("plain request: %v %q", urls, problem)
	}
	if urls, problem = parsePageRequest("```\nAWWO-READ-PAGES {\"urls\":[\"https://a.example/x\"]}\n```"); problem != "" || len(urls) != 1 {
		t.Fatalf("fenced request: %v %q", urls, problem)
	}
	if urls, problem = parsePageRequest("```json\r\nAWWO-READ-PAGES {\"urls\":[\"https://a.example/x\"]}\r\n```\r\n"); problem != "" || len(urls) != 1 {
		t.Fatalf("CRLF fenced request: %v %q", urls, problem)
	}
	if urls, problem = parsePageRequest("AWWO-READ-PAGES\n{\"urls\":[\"https://a.example/x\"]}"); problem != "" || len(urls) != 1 {
		t.Fatalf("object on the next line: %v %q", urls, problem)
	}
	for text, want := range map[string]string{
		`AWWO-READ-PAGES {"urls":[]}`:                             "named no address",
		`AWWO-READ-PAGES {"urls":["https://a.example"],"x":1}`:    "not one JSON object",
		`AWWO-READ-PAGES {"urls":["https://a.example"]} and more`: "not one JSON object",
		`AWWO-READ-PAGES please read https://a.example`:           "not one JSON object",
		"```\nAWWO-READ-PAGES {\"urls\":[\"https://a.example\"]}": "not closed",
	} {
		if _, problem := parsePageRequest(text); !strings.Contains(problem, want) {
			t.Fatalf("%q: problem %q, want it to say %q", text, problem, want)
		}
	}
}

// The longest note: three pages read and three addresses not read, each address as long as the note keeps it, the
// longest reason, a long document id, and the rest counted. It stays within pageReadNoteMax, which leaves the rest of
// pageNoteReserve for the evidence block's own words and the estimate's joins.
func TestPageReadNoteStaysWithinItsBound(t *testing.T) {
	long := "https://" + strings.Repeat("a", modelReadURLBytes)
	reason, longest := "", 0
	for _, code := range []string{"robots_disallowed", "blocked_by_site_protection", "empty_content", "unsupported_type", "too_large", "timeout",
		"model_query", "model_url_too_long", "model_probe_path", "invalid_url", "too_many_pages", "web_read_quota", "free_plan_ended", "no_room",
		"web_reader_busy", "not_a_member", "workspace_suspended", "run_ended", "unavailable", "not_saved"} {
		if r := pageReadReason(code); len(r) > longest {
			reason, longest = code, len(r)
		}
	}
	item := &knowledgeContextItem{knowledgeReference: knowledgeReference{DocumentID: strings.Repeat("d", 64)}}
	var reads []pageRead
	for range modelReadPagesMax {
		reads = append(reads, pageRead{URL: clipAddress(long), Item: item})
	}
	for range 9999 {
		reads = append(reads, pageRead{URL: clipAddress(long), Code: reason})
	}
	note := pageReadNote(reads)
	if len(note) > pageReadNoteMax || pageReadNoteMax+1024 > pageNoteReserve {
		t.Fatalf("the note takes %d bytes of %d (reserve %d)", len(note), pageReadNoteMax, pageNoteReserve)
	}
	if strings.Count(note, "\n- read: ") != modelReadPagesMax || strings.Count(note, "\n- not read: ") != pageNoteRefusedMax+1 || !strings.Contains(note, "- not read: 9996 more addresses") {
		t.Fatalf("the note names the pages read, the first refused addresses, and counts the rest:\n%s", note)
	}
}

// An address asked for twice is taken once, read or not: a looped list of refused addresses makes one line each.
func TestReadRunPagesTakesEachAddressOnce(t *testing.T) {
	urls := []string{"ftp://a.example/x", "http://site.test/search?q=1", "ftp://a.example/x", " ftp://a.example/x", "http://site.test/search?q=1"}
	reads := (&App{}).readRunPages(context.Background(), "tenant", "run", urls, "", 1<<20, maxKnowledgeRunReferences)
	if len(reads) != 2 || reads[0].Code == "" || reads[1].Code != "model_query" {
		t.Fatalf("each refused address once: %#v", reads)
	}
}

// fillItems makes n quoted items that take exactly room bytes in an evidence array, each with the comma that joins it
// (so their own array, brackets included, is room+1 bytes), all of it text whose estimate is its bytes (one long word
// with digits).
func fillItems(t *testing.T, n, room int) []knowledgeContextItem {
	t.Helper()
	items := make([]knowledgeContextItem, n)
	for i := range items {
		items[i].DocumentID, items[i].RevisionID = fmt.Sprintf("doc-%02d-%s", i, strings.Repeat("d", 40)), strings.Repeat("r", 44)
		items[i].SourceURI, items[i].Provenance = "http://site.test/"+strings.Repeat("p", 280), json.RawMessage(`{"origin":"web"}`)
	}
	raw, _ := json.Marshal(items)
	short := room + 1 - len(raw)
	if short < n {
		t.Fatalf("room %d is too small for %d items", room, n)
	}
	for i := range items {
		add := short / n
		if i == 0 {
			add += short % n
		}
		items[i].Content = strings.Repeat("7", add)
	}
	if raw, _ = json.Marshal(items); len(raw) != room+1 {
		t.Fatalf("items take %d bytes, want %d", len(raw), room+1)
	}
	return items
}

// The second call fits however much the pages and the note bring: pages that fill the whole room the run was offered,
// with the longest note, whether the model's budget, the prompt's own bound or the quoted knowledge's own bound sets
// the room, on a run that quotes no knowledge of its own (whose second call gains the evidence block and its boundary)
// and on one that does. A run whose second call's instructions would pass their bound is offered no reads at all.
func TestPageAnswerFitsTheRoomItWasOffered(t *testing.T) {
	a := &App{promptClock: func() time.Time { return time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC) }}
	a.cfg.WebReaderEnabled, a.cfg.ModelWebReads = true, true
	long := "https://" + strings.Repeat("a", modelReadURLBytes)
	raw := "Answer briefly and cite the pages."
	plain := executionSnapshot{Model: "test-model", WebReads: &webReadPlan{Pages: modelReadPagesMax}}
	own := knowledgeContextItem{knowledgeReference: knowledgeReference{DocumentID: "doc-own", RevisionID: "rev-own", Title: "Own notes"}, Content: strings.Repeat("Notes of the team. ", 200)}
	ownJSON, _ := json.Marshal([]knowledgeContextItem{own})
	known := plain
	known.Knowledge = &knowledgeContext{Items: []knowledgeContextItem{own}, Text: "Quoted knowledge evidence (immutable revisions, JSON):\n" + string(ownJSON)}
	// Every other context a run may quote or frame: memory notes, a skill, a lesson, a task frame.
	withAll := func(s executionSnapshot) executionSnapshot {
		s.Memory = &memoryContext{Text: "Quoted memory notes (JSON):\n" + `[{"id":"memory-1","title":"Team style","body":"MEMORY-NOTE: short answers."}]`, Items: []memoryNote{{ID: "memory-1", Title: "Team style", Body: "MEMORY-NOTE: short answers."}}}
		s.Skills = &skillContext{Items: []frozenSkill{{Name: "web-research", Title: "Web research", Version: 3, Source: "builtin", Body: "SKILL-BODY: " + strings.Repeat("Cite every page you use. ", 40)}}}
		s.Lessons = &lessonContext{Items: []lessonNote{{ID: "lesson-1", Kind: "do", Rule: "LESSON-RULE: name the page an answer comes from."}}}
		s.TaskFrame = &taskFrame{Version: 1, Source: "manual", Constraints: []string{"FRAME-CONSTRAINT: at most 200 words."}, AcceptanceCriteria: []string{"Cites the release notes."}}
		return s
	}
	edge := strings.Repeat("x", 32768-utf16Len(a.sentInstructions(webReadSystemPrompt(""), plain)))
	// Words and white space at the estimator's limits (context_estimate.go): 32 letters is a prose word, more than 32
	// white space characters is strict, so the joins the second call makes can move them across.
	limits := strings.Repeat(" ", 32) + strings.Repeat("abcdefghijklmnopqrstuvwxyzabcdef ", 600) + strings.Repeat(" ", 31)
	cases := []struct {
		name, prompt, raw string
		s                 executionSnapshot
		budget            int
		rate              float64
		offered           bool
	}{
		{"the model's budget", "What changed in the release? " + strings.Repeat("word ", 4000), raw, plain, 60000, 0, true},
		{"the model's budget at a prose rate", "What changed in the release? " + strings.Repeat("word ", 4000), raw, plain, 30000, 4, true},
		{"the estimator's limits at a prose rate", limits, raw, plain, 30000, 4, true},
		{"the prompt's own bound", strings.Repeat("9", maxRunPromptUnits-40<<10), raw, plain, 1 << 30, 0, true},
		{"the quoted knowledge's own bound", "What changed in the release?", raw, plain, 1 << 30, 0, true},
		{"a run with knowledge of its own", "What changed in the release? " + strings.Repeat("word ", 4000), raw, known, 60000, 0, true},
		{"every other context, no knowledge of its own", "What changed in the release? " + strings.Repeat("word ", 4000), raw, withAll(plain), 60000, 4, true},
		{"every context", limits, raw, withAll(known), 40000, 4, true},
		{"instructions the boundary would take past their bound", "What changed?", edge, plain, 1 << 30, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := c.s
			s.ProseRate = c.rate
			// The first call's prompt and instructions as execute frames them.
			framed := evidenceUserPrompt(c.prompt, s.Knowledge, s.Memory)
			base := taskFrameSystemPrompt(lessonsSystemPrompt(memorySystemPrompt(knowledgeSystemPrompt(skillsSystemPrompt(c.raw, s.Skills), s.Knowledge), s.Memory), s.Lessons), s.TaskFrame)
			offered, room := a.offerPageReads(s, "node", base, c.raw, framed, 0, c.budget)
			if !c.offered {
				if room != 0 || offered != "" {
					t.Fatalf("a run whose second call could not be sent is offered reads (room %d)", room)
				}
				return
			}
			if room < webFitLeastRoom || offered != a.sentInstructions(webReadSystemPrompt(base), s) {
				t.Fatalf("no reads offered (room %d)", room)
			}
			items := fillItems(t, modelReadPagesMax, room)
			var reads []pageRead
			for i := range items {
				reads = append(reads, pageRead{URL: clipAddress(long), Item: &items[i]})
			}
			for range 50 {
				reads = append(reads, pageRead{URL: clipAddress(long), Code: "blocked_by_site_protection"})
			}
			evidence, err := pageEvidence(s.Knowledge, reads)
			if err != nil {
				t.Fatal(err)
			}
			prompt, instructions := pageAnswerPrompt(s, c.prompt, evidence, reads), a.pageAnswerInstructions(s, c.raw, evidence)
			if !pageAnswerFits(s, prompt, instructions, 0, c.budget) {
				t.Fatalf("the second call does not fit: prompt %d tokens %d units, instructions %d tokens %d units, budget %d, room %d",
					s.tokens(prompt), utf16Len(prompt), s.tokens(instructions), utf16Len(instructions), c.budget, room)
			}
			// The second call keeps everything the first had: its words, its own evidence and memory ahead of them, and its
			// instructions' skills, lessons and frame, with the evidence boundary now that pages are quoted.
			for _, want := range []string{c.prompt, "AwwO read web pages for this task", "End of quoted knowledge evidence."} {
				if !strings.Contains(prompt, want) {
					t.Fatalf("the second call's prompt lacks %.60q", want)
				}
			}
			if s.Knowledge != nil && !strings.Contains(prompt, own.Content) {
				t.Fatal("the second call's prompt lacks the run's own knowledge")
			}
			if s.Memory != nil && (!strings.Contains(prompt, "MEMORY-NOTE") || !strings.Contains(instructions, memoryNotesBoundary)) {
				t.Fatal("the second call lacks the run's memory notes")
			}
			for _, want := range []string{knowledgeEvidenceBoundary, webReadFrame, c.raw} {
				if !strings.Contains(instructions, want) {
					t.Fatalf("the second call's instructions lack %.60q", want)
				}
			}
			if s.Skills != nil && (!strings.Contains(instructions, "SKILL-BODY") || !strings.Contains(instructions, "LESSON-RULE") || !strings.Contains(instructions, "FRAME-CONSTRAINT")) {
				t.Fatal("the second call's instructions lack the run's skill, lesson or task frame")
			}
		})
	}
}

// pagesSite serves site.test (serveWebSite): a readable article, a page robots.txt disallows.
func pagesSite(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "User-agent: *\nDisallow: /private\n") })
	mux.HandleFunc("/article", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html lang="en"><head><title>Release notes</title></head><body><article><h1>Release notes</h1>
<p>MODEL-READ-FACT: version 2.4 adds offline search across every workspace document and keeps the index on the device.</p>
<p>The second paragraph gives enough words for the reader to treat this as the article body rather than navigation.</p></article></body></html>`)
	})
	mux.HandleFunc("/private/page", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "never read") })
	// A page that redirects where a model's address may not go: the redirect is held to the same rules.
	mux.HandleFunc("/moved", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/.env", http.StatusFound) })
	mux.HandleFunc("/.env", func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a redirect led a model's read to a refused address")
	})
	serveWebSite(t, mux)
}

// streamText streams text as deltas of a few bytes, then completes with it.
func streamText(w http.ResponseWriter, text string) {
	for len(text) > 0 {
		n := min(7, len(text))
		raw, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": text[:n]})
		fmt.Fprintf(w, "data: %s\n\n", raw)
		text = text[n:]
	}
}

const pagesRequestLine = `AWWO-READ-PAGES {"urls":["http://site.test/article","http://site.test/private/page","http://site.test/search?q=secret","http://site.test/moved"]}`

func modelReadsHarness(t *testing.T, workerURL string) *harness {
	h := newHarness(t, workerURL)
	h.a.cfg.WebReaderEnabled, h.a.cfg.ModelWebReads, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, true, 10, 100
	return h
}

// The whole path: a model asks for three addresses, AwwO reads the one it may (robots.txt refuses one, the address rules
// another before anything is counted), saves it as a source of the run, and calls the model again with the page quoted
// and a note of what was not read. The request itself never reaches the stored output, the events or the messages.
func TestPostgresModelPageReadsReadThenAnswer(t *testing.T) {
	pagesSite(t)
	var mu sync.Mutex
	var calls []observedPiCall
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		mu.Lock()
		calls = append(calls, call)
		first := len(calls) == 1
		mu.Unlock()
		if first {
			streamText(w, pagesRequestLine)
			completePi(w, pagesRequestLine)
			return
		}
		const answer = "Version 2.4 adds offline search (http://site.test/article)."
		streamText(w, answer)
		completePi(w, answer)
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	c, tid, _ := h.register(t, "model-reads@example.test")
	_, _, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "What does version 2.4 add?", "operationId": "model-reads-run"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "completed")
	if done["output"] != "Version 2.4 adds offline search (http://site.test/article)." {
		t.Fatalf("stored output is not the second call's answer: %#v", done["output"])
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 2 {
		t.Fatalf("want two model calls, got %d", len(calls))
	}
	first, second := calls[0], calls[1]
	if !strings.Contains(first.SystemPrompt, webReadFrame) || !strings.Contains(second.SystemPrompt, webReadFrame) {
		t.Fatal("both calls carry the page-read frame")
	}
	if first.RunID != id || second.RunID == id || second.SessionID != first.SessionID {
		t.Fatalf("the second call is submitted under its own id in the same session: %q %q / %q %q", first.RunID, second.RunID, first.SessionID, second.SessionID)
	}
	if strings.Contains(first.Prompt, "MODEL-READ-FACT") {
		t.Fatal("the first call cannot have the page yet")
	}
	for _, want := range []string{"Quoted knowledge evidence", "MODEL-READ-FACT", "User task:\nWhat does version 2.4 add?",
		"- read: http://site.test/article", "- not read: http://site.test/private/page (the site's robots.txt does not let AwwO read it)",
		"- not read: http://site.test/search?q=secret (addresses with a query are not read)", "Do not ask for pages again"} {
		if !strings.Contains(second.Prompt, want) {
			t.Fatalf("second call's prompt lacks %q:\n%s", want, second.Prompt)
		}
	}
	if !strings.Contains(second.SystemPrompt, knowledgeEvidenceBoundary) {
		t.Fatal("the second call says its quoted evidence is untrusted")
	}
	ctx := context.Background()
	// Two ledger rows for the run, each settled as completed from its own call (failure class none), not swept up with the
	// run as a call left behind (restart), which would charge the second call its whole reserve.
	var rows, completed int
	if err := h.db.QueryRow(ctx, "SELECT count(*),count(*) FILTER (WHERE status='completed' AND failure_class='none') FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, id).Scan(&rows, &completed); err != nil || rows != 2 || completed != 2 {
		t.Fatalf("ledger rows %d completed from their own calls %d (%v)", rows, completed, err)
	}
	// Three reads counted (the article; the one robots.txt refused; the one whose redirect the address rules refused);
	// the query was refused before counting.
	var ok, failed int
	var codes string
	if err := h.db.QueryRow(ctx, "SELECT count(*) FILTER (WHERE status='ok'),count(*) FILTER (WHERE status='failed'),coalesce(string_agg(error_code,',' ORDER BY error_code),'') FROM web_reads WHERE tenant_id=$1 AND operation_id LIKE $2", tid, "model:"+id+":%").Scan(&ok, &failed, &codes); err != nil || ok != 1 || failed != 2 || codes != "model_probe_path,robots_disallowed" {
		t.Fatalf("reads ok %d failed %d codes %q (%v)", ok, failed, codes, err)
	}
	if !strings.Contains(second.Prompt, "- not read: http://site.test/moved (it is not a page's address)") {
		t.Fatalf("the redirect's refusal is told to the model:\n%s", second.Prompt)
	}
	// The page is a knowledge source whose provenance names the run.
	var provenance string
	if err := h.db.QueryRow(ctx, "SELECT v.provenance::text FROM knowledge_revisions v JOIN knowledge_documents d ON d.tenant_id=v.tenant_id AND d.current_revision_id=v.id WHERE d.tenant_id=$1 AND d.title='Release notes'", tid).Scan(&provenance); err != nil || !strings.Contains(provenance, `"runId": "`+id+`"`) || !strings.Contains(provenance, `"by": "model"`) {
		t.Fatalf("saved page provenance %q (%v)", provenance, err)
	}
	// The request line is in no durable sink, and the events say which pages were asked for.
	_, replay := h.readRaw(t, c, prefix+"/runs/"+id+"/events", 200)
	sinks := map[string]string{
		"runs.output":     scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
		"messages":        scalar(t, h, "SELECT coalesce(string_agg(content,'|'),'') FROM messages WHERE tenant_id=$1 AND run_id=$2", tid, id),
		"run_events.data": scalar(t, h, "SELECT coalesce(string_agg(data::text,'|'),'') FROM run_events WHERE tenant_id=$1 AND run_id=$2", tid, id),
		"events replay":   string(replay),
	}
	for name, text := range sinks {
		if strings.Contains(text, pageRequestTag) {
			t.Fatalf("%s holds the page request: %s", name, text)
		}
	}
	events := sinks["run_events.data"]
	for _, want := range []string{`"type": "web_read"`, `"state": "reading"`, `"state": "read"`, `"state": "skipped"`, `"code": "robots_disallowed"`, `"title": "Release notes"`} {
		if !strings.Contains(events, want) {
			t.Fatalf("run events lack %s: %s", want, events)
		}
	}
}

// A second request is never read: the run fails with web_read_repeat and stores neither request.
func TestPostgresModelPageReadsRefuseASecondRequest(t *testing.T) {
	pagesSite(t)
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		streamText(w, `AWWO-READ-PAGES {"urls":["http://site.test/article"]}`)
		completePi(w, `AWWO-READ-PAGES {"urls":["http://site.test/article"]}`)
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	c, tid, _ := h.register(t, "model-reads-twice@example.test")
	_, _, sid := h.fixture(t, c, tid)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "Read it again", "operationId": "model-reads-twice"}, 202)["id"].(string)
	failed := h.awaitRun(t, c, tid, id, "failed")
	if failed["error"] != "web_read_repeat" || strings.Contains(scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id), pageRequestTag) {
		t.Fatalf("a second request must fail the run without storing it: %#v", failed)
	}
	if n := scalar(t, h, "SELECT count(*)::text FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, id); n != "2" {
		t.Fatalf("want two calls, got %s", n)
	}
	// Its first call completed and was paid for, so a canvas would not run the node again for a refused second one.
	if h.a.graphRunSilent(context.Background(), tid, id) {
		t.Fatal("a run with a completed call is not silent")
	}
}

// An answer that only starts like a request (the tag and an object, then more: an answer about the request line) reads
// nothing. From a first call the model is asked again with a note saying the request could not be read; from a second
// call it is the run's answer. A second call that asks again, even for no address, fails the run as a repeat.
func TestPostgresModelPageReadsAnswerThatOnlyStartsLikeARequest(t *testing.T) {
	pagesSite(t)
	const explanation = "AWWO-READ-PAGES\n{\"urls\":[\"http://site.test/article\"]}\nThat line is how a model asks AwwO for pages."
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		second := strings.Contains(call.Prompt, "AwwO read web pages")
		switch {
		case !second || strings.Contains(call.Prompt, "explain twice"):
			streamText(w, explanation)
			completePi(w, explanation)
		case strings.Contains(call.Prompt, "ask for nothing"):
			completePi(w, `AWWO-READ-PAGES {"urls":[]}`)
		default:
			if !strings.Contains(call.Prompt, "- not read: (the request) (the request was not one JSON object") {
				t.Errorf("the second call is told the request could not be read:\n%s", call.Prompt)
			}
			completePi(w, "The request is one line.")
		}
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	c, tid, _ := h.register(t, "model-reads-shaped@example.test")
	prefix := "/tenants/" + tid
	for _, c2 := range []struct{ task, status, output, code, ledger string }{
		{"How does a model ask for pages?", "completed", "The request is one line.", "", "completed:none,completed:none"},
		{"How does a model ask for pages? explain twice", "completed", explanation, "", "completed:none,completed:none"},
		{"How does a model ask for pages? ask for nothing", "failed", "", "web_read_repeat", "completed:none,failed:validation"},
	} {
		_, _, sid := h.fixture(t, c, tid)
		id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": c2.task, "operationId": "model-reads-shaped-" + fmt.Sprint(len(c2.task))}, 202)["id"].(string)
		done := h.awaitRun(t, c, tid, id, c2.status)
		if done["output"] != c2.output || (c2.code != "" && done["error"] != c2.code) {
			t.Fatalf("%q: output %#v error %#v", c2.task, done["output"], done["error"])
		}
		if n := scalar(t, h, "SELECT count(*)::text FROM web_reads WHERE tenant_id=$1 AND operation_id LIKE $2", tid, "model:"+id+":%"); n != "0" {
			t.Fatalf("%q: an answer that only starts like a request read %s pages", c2.task, n)
		}
		// Both calls are settled from their own facts: the first completed, the second as the run ended.
		if rows := scalar(t, h, "SELECT coalesce(string_agg(status||':'||failure_class,',' ORDER BY created_at,id),'') FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, id); rows != c2.ledger {
			t.Fatalf("%q: the run's calls settled as %s, want %s", c2.task, rows, c2.ledger)
		}
		// Text held as a possible request is never streamed: it reaches the run whole, at the end, or not at all.
		if n := scalar(t, h, "SELECT count(*)::text FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND data->>'type'='text_delta' AND position($3 in data->>'delta')>0", tid, id, "AWWO-"); n != "0" {
			t.Fatalf("%q: %s deltas carry held text", c2.task, n)
		}
		completed := scalar(t, h, "SELECT coalesce(string_agg(data->>'text','|'),'') FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND data->>'type'='completed'", tid, id)
		message := scalar(t, h, "SELECT coalesce(string_agg(content,'|'),'') FROM messages WHERE tenant_id=$1 AND run_id=$2 AND role='assistant'", tid, id)
		stored := scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id)
		if completed != c2.output || message != c2.output || stored != c2.output {
			t.Fatalf("%q: the completed event %q, the assistant message %q and the stored output %q are the run's answer %q", c2.task, completed, message, stored, c2.output)
		}
	}
}

// A worker may send its whole answer only at the end, with no delta before: a request there (here a CRLF-fenced one) is
// read just the same, a repeated one fails the run, and neither is stored anywhere.
func TestPostgresModelPageReadsFromAWholeAnswer(t *testing.T) {
	pagesSite(t)
	// A first call asks; a second answers, unless its run's task asks it to ask again.
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		if !strings.Contains(call.Prompt, "AwwO read web pages") || strings.Contains(call.Prompt, "ask twice") {
			completePi(w, "```json\r\n"+`AWWO-READ-PAGES {"urls":["http://site.test/article"]}`+"\r\n```")
			return
		}
		completePi(w, "From the page: offline search.")
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	c, tid, _ := h.register(t, "model-reads-whole@example.test")
	prefix := "/tenants/" + tid
	for _, repeat := range []bool{false, true} {
		_, _, sid := h.fixture(t, c, tid)
		task := "Look it up"
		if repeat {
			task = "Look it up and ask twice"
		}
		id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": task, "operationId": fmt.Sprintf("model-reads-whole-%v", repeat)}, 202)["id"].(string)
		if repeat {
			if failed := h.awaitRun(t, c, tid, id, "failed"); failed["error"] != "web_read_repeat" {
				t.Fatalf("a repeated whole-answer request fails the run: %#v", failed)
			}
		} else if done := h.awaitRun(t, c, tid, id, "completed"); done["output"] != "From the page: offline search." {
			t.Fatalf("stored output is not the second call's answer: %#v", done["output"])
		}
		_, replay := h.readRaw(t, c, prefix+"/runs/"+id+"/events", 200)
		for name, text := range map[string]string{
			"runs.output":     scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
			"messages":        scalar(t, h, "SELECT coalesce(string_agg(content,'|'),'') FROM messages WHERE tenant_id=$1 AND run_id=$2", tid, id),
			"run_events.data": scalar(t, h, "SELECT coalesce(string_agg(data::text,'|'),'') FROM run_events WHERE tenant_id=$1 AND run_id=$2", tid, id),
			"events replay":   string(replay),
		} {
			if strings.Contains(text, pageRequestTag) {
				t.Fatalf("%s holds the page request: %s", name, text)
			}
		}
		if n := scalar(t, h, "SELECT count(*) FILTER (WHERE status IN ('completed','failed'))::text||'/'||count(*)::text FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, id); n != "2/2" {
			t.Fatalf("both calls settled, got %s", n)
		}
		if n := scalar(t, h, "SELECT count(*)::text FROM web_reads WHERE tenant_id=$1 AND operation_id LIKE $2 AND status='ok'", tid, "model:"+id+":%"); n != "1" {
			t.Fatalf("the page was read once, got %s", n)
		}
	}
}

// The authorization a read was counted under is asked again before its page is saved (AWWO-LAW-003): a starter who is
// no longer a member who may write, while the page is read, saves nothing, and the run then stops.
func TestPostgresModelPageReadsRecheckBeforeSaving(t *testing.T) {
	entered, release := make(chan struct{}, 1), make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "User-agent: *\nAllow: /\n") })
	mux.HandleFunc("/slow", func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-release
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><head><title>Slow page</title></head><body><article><p>SLOW-FACT: a page whose read outlives its reader's membership, with enough words to count as the article body.</p></article></body></html>`)
	})
	serveWebSite(t, mux)
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		if calls.Add(1) == 1 {
			completePi(w, `AWWO-READ-PAGES {"urls":["http://site.test/slow"]}`)
			return
		}
		completePi(w, "answer")
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	c, tid, _ := h.register(t, "model-reads-recheck@example.test")
	_, _, sid := h.fixture(t, c, tid)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "Read the slow page", "operationId": "model-reads-recheck"}, 202)["id"].(string)
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the page was never requested")
	}
	if _, err := h.db.Exec(context.Background(), "UPDATE memberships SET role='reader' WHERE tenant_id=$1 AND user_id=(SELECT actor_id FROM runs WHERE tenant_id=$1 AND id=$2)", tid, id); err != nil {
		t.Fatal(err)
	}
	close(release)
	h.awaitRun(t, c, tid, id, "failed")
	if n := scalar(t, h, "SELECT count(*)::text FROM knowledge_documents WHERE tenant_id=$1 AND title='Slow page'", tid); n != "0" {
		t.Fatalf("a page was saved for a starter who may no longer write: %s", n)
	}
	if code := scalar(t, h, "SELECT coalesce(error_code,'')||'/'||status FROM web_reads WHERE tenant_id=$1 AND operation_id=$2", tid, modelReadOperation(id, 1)); code != "not_a_member/failed" {
		t.Fatalf("the read settles as refused: %s", code)
	}
}

// A run's first call gives its slot back when it is settled, so another of the workspace's calls may take it while the
// pages are read. A second call still waiting for a slot when the run's time is up ends the run as run_timeout, as the
// run's other exits out of time do, and is never reserved.
func TestPostgresModelPageReadsSecondCallOutOfTime(t *testing.T) {
	reading, proceed, holding, done := make(chan struct{}, 1), make(chan struct{}), make(chan struct{}, 1), make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "User-agent: *\nAllow: /\n") })
	mux.HandleFunc("/page", func(w http.ResponseWriter, _ *http.Request) {
		reading <- struct{}{}
		<-proceed
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><head><title>Late page</title></head><body><article><p>LATE-FACT: a page read while another call of the workspace takes the only slot, with enough words to count as the article body.</p></article></body></html>`)
	})
	serveWebSite(t, mux)
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		if strings.Contains(call.Prompt, "hold the slot") {
			holding <- struct{}{}
			<-done
			completePi(w, "held")
			return
		}
		completePi(w, `AWWO-READ-PAGES {"urls":["http://site.test/page"]}`)
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	h.a.cfg.RunTimeout = 3 * time.Second
	c, tid, _ := h.register(t, "model-reads-late@example.test")
	prefix := "/tenants/" + tid
	_, _, sid := h.fixture(t, c, tid)
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "Read the late page", "operationId": "model-reads-late"}, 202)["id"].(string)
	select {
	case <-reading:
	case <-time.After(10 * time.Second):
		t.Fatal("the page was never requested")
	}
	// While the page is read another run's call takes the slot, and the workspace has only that one.
	_, _, other := h.fixture(t, c, tid)
	holder := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": other, "prompt": "hold the slot", "operationId": "model-reads-holder"}, 202)["id"].(string)
	select {
	case <-holding:
	case <-time.After(10 * time.Second):
		t.Fatal("the other run's call never started")
	}
	execSQL(t, h, "UPDATE tenants SET max_concurrent_runs=1 WHERE id=$1", tid)
	close(proceed)
	failed := h.awaitRun(t, c, tid, id, "failed")
	close(done)
	// The page was read and saved in time, so the run ran out of time waiting for its second call's slot.
	if read := scalar(t, h, "SELECT status FROM web_reads WHERE tenant_id=$1 AND operation_id=$2", tid, modelReadOperation(id, 1)); read != "ok" || failed["error"] != "run_timeout" {
		t.Fatalf("a second call out of time ends the run as run_timeout: %#v (the read %s)", failed["error"], read)
	}
	if n := scalar(t, h, "SELECT count(*)::text||'/'||count(*) FILTER (WHERE status='completed')::text FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, id); n != "1/1" {
		t.Fatalf("only the first call was reserved, and it was settled: %s", n)
	}
	// The other run ends either way before the harness closes.
	for deadline := time.Now().Add(15 * time.Second); scalar(t, h, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2", tid, holder) == "running"; {
		if time.Now().After(deadline) {
			t.Fatal("the other run never ended")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// With the switch off the run sends what it always sent (AWWO-LAW-013) and an answer that happens to start with the tag
// is just an answer.
func TestPostgresModelPageReadsOffChangesNothing(t *testing.T) {
	var system string
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		system = call.SystemPrompt
		streamText(w, pagesRequestLine)
		completePi(w, pagesRequestLine)
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.WebReaderEnabled = true // the member's reader on, the model's reads off
	c, tid, _ := h.register(t, "model-reads-off@example.test")
	_, _, sid := h.fixture(t, c, tid)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "model-reads-off"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "completed")
	if done["output"] != pagesRequestLine || strings.Contains(system, pageRequestTag) {
		t.Fatalf("with the switch off nothing changes: output %#v, frame sent %v", done["output"], strings.Contains(system, pageRequestTag))
	}
	if snapshot := scalar(t, h, "SELECT execution_snapshot::text FROM runs WHERE tenant_id=$1 AND id=$2", tid, id); strings.Contains(snapshot, "webReads") {
		t.Fatal("a run admitted with the switch off freezes no webReads")
	}
}
