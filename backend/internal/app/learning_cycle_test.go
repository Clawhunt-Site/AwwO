package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The tidying model's answer is held to its shape: a merge of two or more notes of one scope and one kind, a promote of
// borne-out preferences or style rules of one kind of two or more canvases (at most three), each with the one of them
// kept, an archive of one note; every note named one it was shown, and named once; notes that share words enough with
// the one kept; at most eight changes; and no text of its own: an answer that writes a note gives nothing.
func TestParseLearningTidyReplyKeepsOnlyChangesItMayMake(t *testing.T) {
	note := func(canvasID, kind string, evidence int, title string) tidyPoolNote {
		n := tidyPoolNoteOf(title, "")
		n.canvasID, n.kind, n.evidence = canvasID, kind, evidence
		return n
	}
	style := func(canvasID string, evidence int) tidyPoolNote {
		return note(canvasID, "style", evidence, "Headlines stay short")
	}
	pool := map[string]tidyPoolNote{
		"a1": style("c1", 2), "a2": style("c1", 2), "a3": style("c1", 2), "b1": style("c2", 2), "b2": style("c2", 2), "d1": style("c3", 2),
		"e1": style("c4", 2), "f1": style("c5", 2), "w1": style("", 2), "n1": style("c2", 1),
		"x1": note("c1", "fact", 3, "Headlines stay short"), "x2": note("c2", "fact", 3, "Headlines stay short"),
		"p2": note("c2", "preference", 2, "Headlines stay short"),
		// Notes that say something else: they share no word with the others.
		"u1": note("c1", "style", 2, "Buttons are blue"),
		"u2": note("c2", "style", 2, "Invoices list the wallet (promote this with canvas-1's note)"),
		// Notes that share one word, or only words every rule is written with: they say different things.
		"h1": note("c1", "style", 2, "Headlines are bold"),
		"h2": note("c1", "style", 2, "Headlines are blue"),
		"v1": note("c1", "style", 2, "Prefer navy"),
		"v2": note("c1", "style", 2, "Prefer short pages"),
		"c1": note("c1", "style", 2, "Prefer"),
		"c2": note("c1", "style", 2, "Prefer dark pages"),
		"g1": note("c1", "style", 2, "Headlines are serif"),
		"g2": note("c1", "style", 2, "Headlines are never serif"),
		"k1": note("c1", "style", 2, "标题要短"),
		"k2": note("c1", "style", 2, "标题用蓝色"),
	}
	change := func(op, ids, keep string) string {
		return `{"op":"` + op + `","ids":[` + ids + `],"keep":"` + keep + `"}`
	}
	answer := func(changes ...string) []learningTidyChange {
		return parseLearningTidyReply(`{"changes":[`+strings.Join(changes, ",")+`]}`, pool)
	}
	got := answer(change("merge", `"a1","a2"`, "a2"), change("promote", `"a3","b1"`, "b1"), `{"op":"archive","id":"w1"}`)
	if len(got) != 3 || got[0].Op != "merge" || len(got[0].IDs) != 2 || got[0].Keep != "a2" || got[1].Op != "promote" || got[1].Keep != "b1" ||
		got[2].Op != "archive" || got[2].ID != "w1" || got[2].IDs != nil {
		t.Fatalf("well-formed changes: %+v", got)
	}
	for name, one := range map[string]string{
		"a merge across scopes":            change("merge", `"a1","b1"`, "a1"),
		"a merge of one note":              change("merge", `"a1"`, "a1"),
		"a merge across kinds":             change("merge", `"a1","x1"`, "a1"),
		"a merge keeping another note":     change("merge", `"a1","a2"`, "a3"),
		"a merge keeping none":             `{"op":"merge","ids":["a1","a2"]}`,
		"a merge that writes a note":       `{"op":"merge","ids":["a1","a2"],"keep":"a1","kind":"style","title":"Short headlines","body":"Headlines stay under six words."}`,
		"a promote within one canvas":      change("promote", `"a1","a2"`, "a1"),
		"a promote of a workspace note":    change("promote", `"a1","w1"`, "a1"),
		"a promote of a note on probation": change("promote", `"a1","n1"`, "a1"),
		"a promote of facts":               change("promote", `"x1","x2"`, "x1"),
		"a promote across kinds":           change("promote", `"a1","p2"`, "a1"),
		"a merge of unlike notes":          change("merge", `"a1","u1"`, "a1"),
		"a promote of unlike notes":        change("promote", `"u2","a1"`, "u2"),
		"a merge sharing one word":         change("merge", `"h1","h2"`, "h1"),
		"a merge sharing a common word":    change("merge", `"v1","v2"`, "v1"),
		"a merge sharing a common pair":    change("merge", `"k1","k2"`, "k1"),
		"a merge of common words alone":    change("merge", `"c1","c2"`, "c2"),
		"a merge of a rule and its denial": change("merge", `"g1","g2"`, "g1"),
		"an archive of a note not shown":   `{"op":"archive","id":"elsewhere"}`,
		"a merge of a note not shown":      change("merge", `"a1","elsewhere"`, "a1"),
		"one note twice in a merge":        change("merge", `"a1","a1"`, "a1"),
		"an unknown change":                change("delete", `"a1","a2"`, "a1"),
	} {
		if kept := answer(one); len(kept) != 0 {
			t.Errorf("%s: kept %+v", name, kept)
		}
	}
	if kept := answer(change("merge", `"a1","a2"`, "a1"), `{"op":"archive","id":"a1"}`); len(kept) != 1 {
		t.Fatalf("a note named twice in the answer: %+v", kept)
	}
	if kept := answer(change("promote", `"a1","b1"`, "a1"), change("promote", `"a2","d1"`, "a2"), change("promote", `"a3","e1"`, "a3"), change("promote", `"b2","f1"`, "b2")); len(kept) != 3 {
		t.Fatalf("more than three promotes kept: %+v", kept)
	}
	many := []string{}
	for _, id := range []string{"a1", "a2", "a3", "b1", "b2", "d1", "e1", "f1", "w1"} {
		many = append(many, `{"op":"archive","id":"`+id+`"}`)
	}
	if kept := answer(many...); len(kept) != learningTidyChanges {
		t.Fatalf("%d changes kept of nine", len(kept))
	}
	for name, content := range map[string]string{
		"prose":             "Merge a1 and a2.",
		"unknown field":     `{"changes":[],"note":"x"}`,
		"cut off reasoning": `<think>merge ` + change("merge", `"a1","a2"`, "a1"),
	} {
		if kept := parseLearningTidyReply(content, pool); len(kept) != 0 {
			t.Errorf("%s: %+v", name, kept)
		}
	}
}

// tidyPi is a Pi worker that runs canvas nodes and answers the learning cycle's question.
type tidyPi struct {
	server   *httptest.Server
	asked    atomic.Int32
	answer   atomic.Value // string
	lastUser atomic.Value // string
	drop     atomic.Bool  // the question is read, then its connection closed with no answer
	// onHealth and onAsk, when set, run as the worker is asked for its health and for the free model's answer.
	onHealth, onAsk atomic.Value // func()
}

func newTidyPi(t *testing.T) *tidyPi {
	p := &tidyPi{}
	p.answer.Store(`{"changes":[]}`)
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			if hook, _ := p.onHealth.Load().(func()); hook != nil {
				hook()
			}
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "maxConcurrency": 8, "activeRuns": 0,
				"completionOptions": []string{"thinking", "maxTokens"}, "models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}}})
		case r.URL.Path == "/internal/computer-model":
			p.asked.Add(1)
			if hook, _ := p.onAsk.Load().(func()); hook != nil {
				hook()
			}
			var body struct {
				Completion struct {
					Messages []map[string]string `json:"messages"`
				} `json:"completion"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Completion.Messages) != 2 || body.Completion.Messages[0]["content"] != learningTidyInstructions {
				t.Error("the learning cycle's question", body)
			} else {
				p.lastUser.Store(body.Completion.Messages[1]["content"])
			}
			if p.drop.Load() {
				if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
					conn.Close()
				}
				return
			}
			writeJSON(w, 200, map[string]any{"completion": map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": p.answer.Load().(string)}}}}})
		case r.Method == "DELETE":
			w.WriteHeader(202)
		default:
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			completePi(w, "Done, RESULT")
		}
	}))
	t.Cleanup(p.server.Close)
	return p
}

// cycleNotes writes notes straight into a workspace, as AwwO's own (by no person) or a person's.
type cycleNotes struct {
	t   *testing.T
	h   *harness
	tid string
}

// add writes a person's note, or one AwwO keeps in use: borne out by two runs, as every such note is.
func (n cycleNotes) add(canvasID, title string, person string) string {
	n.t.Helper()
	id := randomID()
	if _, err := n.h.db.Exec(context.Background(), `INSERT INTO memory_items(id,tenant_id,canvas_id,title,body,kind,status,origin,source,content_hash,created_by,updated_by,evidence)
		VALUES($1,$2,NULLIF($3,''),$4,'','preference','active',CASE WHEN $5='' THEN 'run' ELSE 'user' END,'{}',$6,NULLIF($5,''),NULLIF($5,''),CASE WHEN $5='' THEN 2 ELSE 1 END)`,
		id, n.tid, canvasID, title, person, memoryContentHash(title, "")); err != nil {
		n.t.Fatal(err)
	}
	return id
}

// probation writes a note AwwO keeps on probation: proposed, borne out by the run that wrote it alone.
func (n cycleNotes) probation(canvasID, title string) string {
	n.t.Helper()
	id := n.add(canvasID, title, "")
	if _, err := n.h.db.Exec(context.Background(), "UPDATE memory_items SET status='proposed',evidence=1 WHERE tenant_id=$1 AND id=$2", n.tid, id); err != nil {
		n.t.Fatal(err)
	}
	return id
}

// state is a note's status, why it was archived and what superseded it.
func (n cycleNotes) state(id string) (status, reason, by string) {
	n.t.Helper()
	if err := n.h.db.QueryRow(context.Background(), "SELECT status,archived_reason,COALESCE(successor_id,'') FROM memory_items WHERE tenant_id=$1 AND id=$2", n.tid, id).Scan(&status, &reason, &by); err != nil {
		n.t.Fatal(id, err)
	}
	return
}

// lastCycle is the workspace's latest learning cycle: its state, reason, whether it read the notes, and its counts.
func lastCycle(t *testing.T, h *harness, tid string) (state, reason string, read bool, counts map[string]int) {
	t.Helper()
	var raw []byte
	if err := h.db.QueryRow(context.Background(), "SELECT state,reason,read_notes,counts FROM learning_cycles WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1", tid).
		Scan(&state, &reason, &read, &raw); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &counts)
	return
}

// A learning cycle gives a lesson that kept helping to its template's nodes, archives the notes AwwO kept that went
// unused, moves word-for-word copies of several canvases to the whole workspace, and makes the changes the free model
// answers to the notes it read: only those AwwO keeps for the workspace, never people's (neither read nor changed), nor
// another workspace's. Each change is logged, listed and can be taken back, once, while what it made is untouched; a note that
// comes back is AwwO's still, kept apart: the next cycle leaves it alone.
func TestPostgresALearningCycleTidiesItsWorkspaceAlone(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, user := h.register(t, "cycle@example.test")
	other, otherTID, _ := h.register(t, "cycle-other@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	first, second := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	otherCanvas := retryCanvas(t, h, other, otherTID)
	notes, theirs := cycleNotes{t, h, tid}, cycleNotes{t, h, otherTID}
	copyA, copyB := notes.add(first, "Copy in both", ""), notes.add(second, "Copy in both", "")
	stale := notes.add(first, "Old note", "")
	// Borne out by the run that wrote it alone, and no run used it for 40 days.
	exec("UPDATE memory_items SET evidence=1,created_at=now()-interval '40 days' WHERE tenant_id=$1 AND id=$2", tid, stale)
	m1, m2 := notes.add(first, "Short headlines", ""), notes.add(first, "Headlines are short", "")
	p1, p2 := notes.add(first, "Prefer blue", ""), notes.add(second, "Blue is preferred", "")
	vague := notes.add(second, "Something", "")
	person := notes.add(first, "Person's rule", user)
	secret := theirs.add(otherCanvas, "Other workspace's secret plan", "")
	// A node lesson that helped three runs, of a node of the frontend template.
	lesson := randomID()
	exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
		VALUES($1,$2,$3,'up','output_limit','rule',$1,'Keep it short.','active',3,3,0)`, lesson, tid, first)
	// Two that did not keep helping: one helped only two runs, one failed two.
	exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
		VALUES('few',$1,$2,'up','step_limit','rule','few','Use fewer steps.','active',2,2,0),('flaky',$1,$2,'up','run_timeout','rule','flaky','Finish sooner.','active',7,5,2)`, tid, first)
	pi.answer.Store(`{"changes":[{"op":"merge","ids":["` + m1 + `","` + m2 + `"],"keep":"` + m2 + `"},` +
		`{"op":"promote","ids":["` + p1 + `","` + p2 + `"],"keep":"` + p1 + `"},` +
		`{"op":"archive","id":"` + vague + `"},{"op":"archive","id":"` + person + `"}]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	state, reason, read, counts := lastCycle(t, h, tid)
	if state != "done" || reason != "" || !read || counts["lessons_promoted"] != 1 || counts["notes_archived"] != 2 || counts["notes_promoted"] != 2 || counts["notes_merged"] != 1 {
		t.Fatalf("the cycle: %s %q read %v %v", state, reason, read, counts)
	}
	briefing, _ := pi.lastUser.Load().(string)
	if !strings.Contains(briefing, "Short headlines") || strings.Contains(briefing, "Person's rule") || strings.Contains(briefing, "secret plan") ||
		strings.Contains(briefing, "Old note") || !strings.Contains(briefing, "Retry") || !strings.Contains(briefing, `"evidence":2`) {
		t.Fatal("the briefing the model read", briefing)
	}
	// What each note is now.
	want := func(id, wantStatus, wantReason string) string {
		t.Helper()
		status, why, by := notes.state(id)
		if status != wantStatus || why != wantReason {
			t.Fatalf("note %s: %s %s, want %s %s", id, status, why, wantStatus, wantReason)
		}
		return by
	}
	copies, merged, promoted := want(copyA, "archived", "promoted"), want(m1, "archived", "merged"), want(p1, "archived", "promoted")
	if want(copyB, "archived", "promoted") != copies || want(p2, "archived", "promoted") != promoted {
		t.Fatal("notes moved into different notes")
	}
	// A merge keeps one of its notes as it is, which the others are archived in favour of.
	if merged != m2 || want(m2, "active", "") != "" {
		t.Fatalf("a merge kept %s, not %s, or changed it", merged, m2)
	}
	want(stale, "archived", "unused")
	want(vague, "archived", "tidied")
	want(person, "active", "")
	text := func(id string) (title, canvasID, origin, status string) {
		t.Helper()
		if err := h.db.QueryRow(ctx, "SELECT title,COALESCE(canvas_id,''),origin,status FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&title, &canvasID, &origin, &status); err != nil {
			t.Fatal(err)
		}
		return
	}
	// The moved notes are the workspace's, the copies' text and the text of the one a promotion kept, word for word.
	for id, wantTitle := range map[string]string{copies: "Copy in both", promoted: "Prefer blue"} {
		if title, canvasID, origin, status := text(id); title != wantTitle || canvasID != "" || origin != "evolution" || status != "active" {
			t.Fatalf("the note %s took the others' place: %q %q %s %s", id, title, canvasID, origin, status)
		}
	}
	if title, canvasID, origin, _ := text(merged); title != "Headlines are short" || canvasID != first || origin != "run" {
		t.Fatalf("the note a merge kept: %q %q %s", title, canvasID, origin)
	}
	evidence := func(id string) int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT evidence FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Moved copies are borne out as often as together; a promotion as the least borne out of its notes; the note a merge
	// keeps as often as it was.
	if evidence(copies) != 4 || evidence(merged) != 2 || evidence(promoted) != 2 {
		t.Fatalf("borne out: copies %d, merged %d, promoted %d", evidence(copies), evidence(merged), evidence(promoted))
	}
	if status, _, _ := theirs.state(secret); status != "active" {
		t.Fatal("another workspace's note was changed")
	}
	var workspaceLessons int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL AND kind='output_limit' AND scope->>'templateId'='frontend' AND source='rule' AND status='active'",
		tid).Scan(&workspaceLessons); err != nil || workspaceLessons != 1 {
		t.Fatalf("the lesson given to the template: %d %v", workspaceLessons, err)
	}
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL", tid).Scan(&workspaceLessons); err != nil || workspaceLessons != 1 {
		t.Fatalf("the lesson given to the template: %d %v", workspaceLessons, err)
	}
	// The cycle as the 经验 panel lists it.
	view := h.request(t, c, "GET", "/tenants/"+tid+"/learning/cycles", nil, 200)
	cycles := view["cycles"].([]any)
	if len(cycles) != 1 || view["everyHours"] == nil {
		t.Fatal("the cycles listed", view)
	}
	changes := cycles[0].(map[string]any)["changes"].([]any)
	byKind := map[string][]map[string]any{}
	for _, raw := range changes {
		change := raw.(map[string]any)
		if change["undoable"] != true {
			t.Fatal("a change not undoable", change)
		}
		byKind[change["kind"].(string)] = append(byKind[change["kind"].(string)], change)
	}
	if len(changes) != 6 || len(byKind["promote_lesson"]) != 1 || len(byKind["archive_note"]) != 2 || len(byKind["promote_note"]) != 2 || len(byKind["merge_notes"]) != 1 {
		t.Fatalf("the changes listed: %v", byKind)
	}
	if lessonChange := byKind["promote_lesson"][0]; lessonChange["lessonKind"] != "output_limit" || lessonChange["templateId"] != "frontend" ||
		len(lessonChange["canvases"].([]any)) != 1 || lessonChange["canvases"].([]any)[0] != first {
		t.Fatal("the lesson's change", lessonChange)
	}
	h.request(t, other, "GET", "/tenants/"+tid+"/learning/cycles", nil, 404)
	if theirView := h.request(t, other, "GET", "/tenants/"+otherTID+"/learning/cycles", nil, 200); len(theirView["cycles"].([]any)) != 0 {
		t.Fatal("another workspace sees cycles", theirView)
	}
	// Taking each back.
	undo := func(change map[string]any, status int) {
		t.Helper()
		h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/"+change["id"].(string)+"/undo", map[string]any{}, status)
	}
	undo(byKind["promote_lesson"][0], 200)
	var retired string
	if err := h.db.QueryRow(ctx, "SELECT status||':'||retired_reason FROM canvas_lessons WHERE tenant_id=$1 AND id=$2", tid, byKind["promote_lesson"][0]["itemId"]).Scan(&retired); err != nil || retired != "retired:person" {
		t.Fatalf("the lesson taken back: %q %v", retired, err)
	}
	for _, change := range byKind["archive_note"] {
		undo(change, 200)
	}
	want(stale, "active", "")
	want(vague, "active", "")
	// The merge taken back: the note it archived comes back, the one it kept stays.
	undo(byKind["merge_notes"][0], 200)
	want(m1, "active", "")
	want(m2, "active", "")
	// What came back is AwwO's still, kept apart from the cycles.
	var apart bool
	if err := h.db.QueryRow(ctx, "SELECT kept_apart AND created_by IS NULL AND updated_by IS NULL AND NOT pinned FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, m1).Scan(&apart); err != nil || !apart {
		t.Fatalf("a note taken back is AwwO's kept apart: %v %v", apart, err)
	}
	// A note a person touched is theirs: the change that made it cannot be taken back.
	var copiesChange, promotedChange map[string]any
	for _, change := range byKind["promote_note"] {
		if change["itemId"] == copies {
			copiesChange = change
		} else {
			promotedChange = change
		}
	}
	pin := listedNote(t, h, c, tid, first, promoted)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+promoted, map[string]any{"version": pin["version"], "pinned": true}, 200)
	undo(promotedChange, 409)
	for _, raw := range h.request(t, c, "GET", "/tenants/"+tid+"/learning/cycles", nil, 200)["cycles"].([]any)[0].(map[string]any)["changes"].([]any) {
		if change := raw.(map[string]any); change["id"] == promotedChange["id"] && change["undoable"] != false {
			t.Fatal("a change whose note a person pinned is listed as one to take back", change)
		}
	}
	undo(copiesChange, 200)
	want(copies, "archived", "undone")
	want(copyA, "active", "")
	want(copyB, "active", "")
	// Once only.
	undo(copiesChange, 409)
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/nope/undo", map[string]any{}, 404)
	h.request(t, other, "POST", "/tenants/"+tid+"/learning/changes/"+copiesChange["id"].(string)+"/undo", map[string]any{}, 404)
	var audits int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='learning.change_undone'", tid).Scan(&audits); err != nil || audits != 5 {
		t.Fatalf("%d undo audits: %v", audits, err)
	}
	// The notes that came back are kept apart: the next cycle neither moves the copies again nor offers them to its model
	// to change (the one note left to show, which the merge kept, is too few to ask about).
	exec("UPDATE learning_cycles SET started_at=now()-interval '4 days' WHERE tenant_id=$1", tid)
	pi.answer.Store(`{"changes":[{"op":"merge","ids":["` + m1 + `","` + m2 + `"],"keep":"` + m2 + `"}]}`)
	asked := pi.asked.Load()
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if _, reason, _, counts := lastCycle(t, h, tid); reason != "few_notes" || pi.asked.Load() != asked || counts["notes_promoted"] != 0 || counts["notes_merged"] != 0 ||
		counts["lessons_promoted"] != 0 {
		t.Fatalf("the next cycle changed the notes taken back, or showed them to its model: %s %v", reason, counts)
	}
	if err := h.db.QueryRow(ctx, "SELECT status||':'||retired_reason FROM canvas_lessons WHERE tenant_id=$1 AND id=$2", tid, byKind["promote_lesson"][0]["itemId"]).Scan(&retired); err != nil || retired != "retired:person" {
		t.Fatalf("the lesson taken back, a cycle later: %q %v", retired, err)
	}
	// The panel lists the latest cycle, which changed nothing, and the one before it, which did.
	if listed := h.request(t, c, "GET", "/tenants/"+tid+"/learning/cycles", nil, 200)["cycles"].([]any); len(listed) != 2 ||
		len(listed[0].(map[string]any)["changes"].([]any)) != 0 || len(listed[1].(map[string]any)["changes"].([]any)) != 6 {
		t.Fatal("the cycles listed after one that changed nothing", listed)
	}
	want(copyA, "active", "")
	want(m1, "active", "")
	// Deleting a canvas takes its notes and the changes of them along.
	var changesOfFirst int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM learning_changes WHERE tenant_id=$1 AND canvas_id=$2", tid, first).Scan(&changesOfFirst); err != nil || changesOfFirst == 0 {
		t.Fatalf("changes of the first canvas: %d %v", changesOfFirst, err)
	}
	exists := func(id string) bool {
		t.Helper()
		var there bool
		if err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM memory_items WHERE tenant_id=$1 AND id=$2)", tid, id).Scan(&there); err != nil {
			t.Fatal(err)
		}
		return there
	}
	var from []string
	if rows, err := h.db.Query(ctx, "SELECT canvas_id FROM memory_item_canvases WHERE tenant_id=$1 AND item_id=$2 ORDER BY canvas_id", tid, copies); err != nil {
		t.Fatal(err)
	} else {
		for rows.Next() {
			var canvasID string
			_ = rows.Scan(&canvasID)
			from = append(from, canvasID)
		}
		rows.Close()
	}
	if len(from) != 2 {
		t.Fatalf("the moved copies' note keeps the canvases it came from: %v", from)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/"+first, nil, 204)
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM learning_changes WHERE tenant_id=$1 AND canvas_id=$2", tid, first).Scan(&changesOfFirst); err != nil || changesOfFirst != 0 {
		t.Fatalf("changes of a deleted canvas kept: %d %v", changesOfFirst, err)
	}
	var left int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_items WHERE tenant_id=$1 AND canvas_id=$2", tid, first).Scan(&left); err != nil || left != 0 {
		t.Fatalf("notes of a deleted canvas kept: %d %v", left, err)
	}
	// One of the canvases a moved note came from is left: it stays. Once none is, it goes, unless a person made it theirs.
	if !exists(copies) || !exists(promoted) {
		t.Fatal("a moved note went while a canvas it came from is left")
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/"+second, nil, 204)
	if exists(copies) {
		t.Fatal("a moved note outlived every canvas it came from")
	}
	if !exists(promoted) {
		t.Fatal("a moved note a person pinned went with its canvases")
	}
}

// A cycle moves to the whole workspace no text a person archived in one of its canvases, by copies or by a promotion;
// it leaves alone a note a replacement waits to take the place of; a promotion whose note later changes built on is not
// taken back; and a promotion's note goes with the canvas whose words it holds, though others it came from are left,
// while one whose words other canvases hold too stays.
func TestPostgresALearningCycleKeepsToPeoplesArchives(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, user := h.register(t, "cycle-archives@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	first, second, third := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	active := func(ids ...string) {
		t.Helper()
		for _, id := range ids {
			if status, _, _ := notes.state(id); status != "active" {
				t.Fatalf("note %s %s", id, status)
			}
		}
	}
	// Copies in two canvases of a text a person archived in a third; a promotion of a text a person archived in a third.
	copyA, copyB := notes.add(first, "Prefer short pages", ""), notes.add(second, "Prefer short pages", "")
	p1, p2 := notes.add(first, "Prefer serif type", ""), notes.add(second, "Serif type is preferred", "")
	exec("UPDATE memory_items SET status='archived' WHERE tenant_id=$1 AND id=ANY($2)", tid,
		[]string{notes.add(third, "Prefer short pages", user), notes.add(third, "Prefer serif type", user)})
	// A merge of a note a replacement waits to take the place of.
	m1, m2 := notes.add(first, "Headlines are short", ""), notes.add(first, "Short headlines", "")
	exec(`INSERT INTO memory_items(id,tenant_id,canvas_id,title,body,kind,status,origin,source,content_hash,evidence,replaces_id)
		VALUES('pending',$1,$2,'Headlines are long','','preference','proposed','run','{}',$3,1,$4)`, tid, first, memoryContentHash("Headlines are long", ""), m1)
	// Two promotions, each keeping the first canvas's words.
	w1, w2 := notes.add(first, "Prefer navy", ""), notes.add(second, "Navy is preferred", "")
	v1, v2 := notes.add(first, "Prefer round corners", ""), notes.add(second, "Round corners are preferred", "")
	keep := func(op, kept string, ids ...string) string {
		return `{"op":"` + op + `","ids":["` + strings.Join(ids, `","`) + `"],"keep":"` + kept + `"}`
	}
	pi.answer.Store(`{"changes":[` + keep("promote", p1, p1, p2) + `,` + keep("merge", m2, m1, m2) + `,` + keep("promote", w1, w1, w2) + `,` +
		keep("promote", v1, v1, v2) + `]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if _, _, read, counts := lastCycle(t, h, tid); !read || counts["notes_promoted"] != 2 || counts["notes_merged"] != 0 {
		t.Fatalf("the cycle: read %v %v", read, counts)
	}
	active(copyA, copyB, p1, p2, m1, m2)
	workspaceNote := func(title string) string {
		t.Helper()
		var id string
		if err := h.db.QueryRow(ctx, "SELECT id FROM memory_items WHERE tenant_id=$1 AND canvas_id IS NULL AND title=$2", tid, title).Scan(&id); err != nil {
			t.Fatal(title, err)
		}
		return id
	}
	navy, round := workspaceNote("Prefer navy"), workspaceNote("Prefer round corners")
	if briefing, _ := pi.lastUser.Load().(string); strings.Contains(briefing, "Headlines are short") || !strings.Contains(briefing, "Short headlines") {
		t.Fatal("the briefing shows a note a replacement waits on, or leaves out its neighbour", briefing)
	}
	// Copies of the navy note's text in two more canvases go into it in the next cycle: the promotion that wrote it is not
	// taken back since.
	notes.add(second, "Prefer navy", "")
	notes.add(third, "Prefer navy", "")
	exec("UPDATE learning_cycles SET started_at=now()-interval '4 days',finished_at=now()-interval '4 days' WHERE tenant_id=$1", tid)
	pi.answer.Store(`{"changes":[]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	var change string
	if err := h.db.QueryRow(ctx, "SELECT id FROM learning_changes WHERE tenant_id=$1 AND kind='promote_note' AND item_id=$2 ORDER BY created_at LIMIT 1", tid, navy).Scan(&change); err != nil {
		t.Fatal(err)
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/"+change+"/undo", map[string]any{}, 409)
	// Deleting the first canvas, whose words both notes hold: the round corners note goes, its second canvas left; the
	// navy note, whose words two more canvases hold, stays.
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/"+first, nil, 204)
	var left []string
	if err := h.db.QueryRow(ctx, "SELECT COALESCE(array_agg(id ORDER BY id),'{}') FROM memory_items WHERE tenant_id=$1 AND id=ANY($2)", tid, []string{navy, round}).Scan(&left); err != nil ||
		len(left) != 1 || left[0] != navy {
		t.Fatalf("the workspace's notes left: %v %v", left, err)
	}
}

// Taking a merge back brings back every note it archived, or none: one that would repeat a note in use leaves the merge
// as it is (409), and once that note is gone the merge is taken back whole; the note it kept stays in use throughout.
func TestPostgresTakingAChangeBackIsWholeOrNothing(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, user := h.register(t, "cycle-undo@example.test")
	ctx := context.Background()
	cid := retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	m1, m2, m3 := notes.add(cid, "Short headlines", ""), notes.add(cid, "Headlines are short", ""), notes.add(cid, "Keep headlines short", "")
	// Of a version of its own, for the merge to log that one.
	if _, err := h.db.Exec(ctx, "UPDATE memory_items SET version=5 WHERE tenant_id=$1 AND id=$2", tid, m3); err != nil {
		t.Fatal(err)
	}
	pi.answer.Store(`{"changes":[{"op":"merge","ids":["` + m1 + `","` + m2 + `","` + m3 + `"],"keep":"` + m3 + `"}]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	var change, merged string
	if err := h.db.QueryRow(ctx, "SELECT id,item_id FROM learning_changes WHERE tenant_id=$1 AND kind='merge_notes'", tid).Scan(&change, &merged); err != nil {
		t.Fatal(err)
	}
	if merged != m3 {
		t.Fatalf("the merge kept %s, not %s", merged, m3)
	}
	var logged, version int64
	if err := h.db.QueryRow(ctx, "SELECT (c.before->>'itemVersion')::bigint,m.version FROM learning_changes c JOIN memory_items m ON m.tenant_id=c.tenant_id AND m.id=c.item_id WHERE c.tenant_id=$1 AND c.id=$2",
		tid, change).Scan(&logged, &version); err != nil || logged != version {
		t.Fatalf("the merge logged the version of the note it kept as %d, the note has %d: %v", logged, version, err)
	}
	// A person writes m2's text again: bringing m2 back would repeat it.
	blocker := notes.add(cid, "Headlines are short", user)
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/"+change+"/undo", map[string]any{}, 409)
	if status, _, _ := notes.state(m3); status != "active" {
		t.Fatal("the note a merge kept is not in use")
	}
	for _, id := range []string{m1, m2} {
		if status, why, by := notes.state(id); status != "archived" || why != "merged" || by != m3 {
			t.Fatalf("note %s after a refused undo: %s %s %s", id, status, why, by)
		}
	}
	if _, err := h.db.Exec(ctx, "DELETE FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, blocker); err != nil {
		t.Fatal(err)
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/"+change+"/undo", map[string]any{}, 200)
	for _, id := range []string{m1, m2, m3} {
		if status, _, _ := notes.state(id); status != "active" {
			t.Fatalf("note %s not in use after the undo", id)
		}
	}
}

// A node lesson already given to its template is no candidate, so those given cannot keep the next ones from their
// turn: more lessons than one cycle gives are given over the cycles that follow, each once.
func TestPostgresALessonGivenToItsTemplateLeavesRoomForOthers(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "cycle-lessons@example.test")
	ctx := context.Background()
	cid := retryCanvas(t, h, c, tid)
	// Twelve lessons of the canvas's frontend node that helped, each of its own kind or refused delivery: twelve of the
	// workspace's lessons to give, five a cycle.
	type spec struct{ kind, reason string }
	specs := []spec{{"output_limit", ""}, {"step_limit", ""}, {"run_timeout", ""}, {"workspace_context", ""}}
	for _, reason := range []string{"not_an_object", "missing_output", "empty_output", "incomplete_html", "wrong_type", "file_shape", "file_name", "file_content"} {
		specs = append(specs, spec{"delivery", reason})
	}
	for i, x := range specs {
		evidence := `[]`
		if x.reason != "" {
			evidence = `[{"reason":"` + x.reason + `"}]`
		}
		if _, err := h.db.Exec(ctx, `INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed,evidence)
			VALUES($1,$2,$3,'up',$4,'rule',$1,'A rule.','active',20,$5,0,$6)`, fmt.Sprintf("l-%02d", i), tid, cid, x.kind, 20-i, evidence); err != nil {
			t.Fatal(err)
		}
	}
	given := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for cycle, want := range []int{learningLessonsMax, 2 * learningLessonsMax, len(specs), len(specs)} {
		if _, err := h.db.Exec(ctx, "DELETE FROM learning_cycles WHERE tenant_id=$1", tid); err != nil {
			t.Fatal(err)
		}
		if err := h.a.runLearningCycle(ctx, tid); err != nil {
			t.Fatal(err)
		}
		if n := given(); n != want {
			t.Fatalf("after cycle %d: %d lessons given to their template, want %d", cycle+1, n, want)
		}
	}
}

// A workspace that turned self-learning off has its cycle give no lesson, and read, change or archive no note, nor ask a
// model; where self-learning is not offered, a cycle does nothing; nor does a suspended workspace's.
func TestPostgresALearningCycleWhereTheWorkspaceDoesNotLearn(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, _ := h.register(t, "cycle-off@example.test")
	ctx := context.Background()
	cid := retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	stale := notes.add(cid, "Old note", "")
	if _, err := h.db.Exec(ctx, "UPDATE memory_items SET evidence=1,created_at=now()-interval '40 days' WHERE tenant_id=$1 AND id=$2", tid, stale); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < learningTidyMin; i++ {
		notes.add(cid, "Note "+string(rune('a'+i)), "")
	}
	if _, err := h.db.Exec(ctx, `INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
		VALUES('l1',$1,$2,'up','step_limit','rule','l1','Use fewer steps.','active',4,3,1)`, tid, cid); err != nil {
		t.Fatal(err)
	}
	h.request(t, c, "PUT", "/tenants/"+tid+"/learning", map[string]any{"selfLearning": false}, 200)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if state, reason, read, counts := lastCycle(t, h, tid); state != "done" || reason != "learning_off" || read || counts["lessons_promoted"] != 0 || counts["notes_archived"] != 0 {
		t.Fatalf("a cycle of a workspace that does not learn: %s %s %v %v", state, reason, read, counts)
	}
	var workspaceLessons int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL", tid).Scan(&workspaceLessons); err != nil || workspaceLessons != 0 {
		t.Fatalf("a lesson given to its template where self-learning is off: %d %v", workspaceLessons, err)
	}
	if status, _, _ := notes.state(stale); status != "active" || pi.asked.Load() != 0 {
		t.Fatalf("an unused note archived (%s), or the model asked (%d)", status, pi.asked.Load())
	}
	// Not offered at all: the same.
	h.request(t, c, "PUT", "/tenants/"+tid+"/learning", map[string]any{"selfLearning": true}, 200)
	h.a.cfg.SelfLearning = false
	if _, err := h.db.Exec(ctx, "DELETE FROM learning_cycles WHERE tenant_id=$1", tid); err != nil {
		t.Fatal(err)
	}
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if _, reason, read, counts := lastCycle(t, h, tid); reason != "learning_not_offered" || read || len(counts) != 0 {
		t.Fatalf("a cycle where self-learning is not offered: %s %v %v", reason, read, counts)
	}
	if status, _, _ := notes.state(stale); status != "active" || pi.asked.Load() != 0 {
		t.Fatalf("an unused note archived (%s), or the model asked (%d)", status, pi.asked.Load())
	}
	// Offered and on, but the workspace suspended: nothing.
	learnFromRuns(h)
	if _, err := h.db.Exec(ctx, "UPDATE tenants SET status='suspended' WHERE id=$1", tid); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, "DELETE FROM learning_cycles WHERE tenant_id=$1", tid); err != nil {
		t.Fatal(err)
	}
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if state, reason, read, counts := lastCycle(t, h, tid); state != "done" || reason != "workspace_inactive" || read || len(counts) != 0 {
		t.Fatalf("a cycle of a suspended workspace: %s %s %v %v", state, reason, read, counts)
	}
	if status, _, _ := notes.state(stale); status != "active" || pi.asked.Load() != 0 {
		t.Fatalf("an unused note archived (%s), or the model asked (%d), for a suspended workspace", status, pi.asked.Load())
	}
	if _, err := h.db.Exec(ctx, "UPDATE tenants SET status='active' WHERE id=$1", tid); err != nil {
		t.Fatal(err)
	}
	// Offered and on, with the worker unable to answer: the cycle fails, to be tried again.
	learnFromRuns(h)
	pi.server.Close()
	if _, err := h.db.Exec(ctx, "DELETE FROM learning_cycles WHERE tenant_id=$1", tid); err != nil {
		t.Fatal(err)
	}
	if err := h.a.runLearningCycle(ctx, tid); err == nil {
		t.Fatal("a cycle whose worker cannot be reached did not fail")
	}
	if state, reason, read, _ := lastCycle(t, h, tid); state != "failed" || (reason != "worker_unavailable" && reason != "transport") || read {
		t.Fatalf("a cycle whose worker cannot be reached: %s %s %v", state, reason, read)
	}
	if status, _, _ := notes.state(stale); status != "archived" {
		t.Fatal("the steps before the model's were not kept")
	}
}

// Cycles come to a workspace whose canvas runs ended since its last one, once every LearningCycleEvery; a failed one is
// tried again after learningCycleRetry; one left running is let go; a workspace with no run since is left alone.
func TestPostgresLearningCyclesComeWhenDue(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	h.a.cfg.LearningCycleEvery = 72 * time.Hour
	c, tid, _ := h.register(t, "cycle-due@example.test")
	_, idle, _ := h.register(t, "cycle-idle@example.test")
	ctx := context.Background()
	cid := retryCanvas(t, h, c, tid)
	runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs", "due-run-1", "completed")
	cycles := func(tenant string) int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM learning_cycles WHERE tenant_id=$1", tenant).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	run := func() {
		t.Helper()
		if err := h.a.runDueLearningCycles(ctx); err != nil {
			t.Fatal(err)
		}
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	// A process that lost the database's worker lock runs none.
	h.a.leaseLost.Store(true)
	run()
	if cycles(tid) != 0 {
		t.Fatalf("a cycle run by a process without the worker lock: %d", cycles(tid))
	}
	h.a.leaseLost.Store(false)
	run()
	if cycles(tid) != 1 || cycles(idle) != 0 {
		t.Fatalf("the first cycles: %d, idle %d", cycles(tid), cycles(idle))
	}
	if state, reason, _, _ := lastCycle(t, h, tid); state != "done" || reason != "learning_not_offered" {
		t.Fatalf("a cycle where self-learning is not offered: %s %s", state, reason)
	}
	run()
	if cycles(tid) != 1 {
		t.Fatal("a second cycle within three days")
	}
	// Two hours on, past the hour a failed cycle waits, with a run since: none, until three days are out.
	exec("UPDATE learning_cycles SET started_at=now()-interval '2 hours',finished_at=now()-interval '2 hours' WHERE tenant_id=$1", tid)
	exec("UPDATE graph_runs SET updated_at=now() WHERE tenant_id=$1", tid)
	run()
	if cycles(tid) != 1 {
		t.Fatal("a second cycle two hours after the last")
	}
	// Three days on, with no run since: none.
	exec("UPDATE learning_cycles SET started_at=now()-interval '73 hours',finished_at=now()-interval '73 hours' WHERE tenant_id=$1", tid)
	exec("UPDATE graph_runs SET updated_at=now()-interval '74 hours' WHERE tenant_id=$1", tid)
	run()
	if cycles(tid) != 1 {
		t.Fatal("a cycle with no run since the last")
	}
	// A run since: one.
	exec("UPDATE graph_runs SET updated_at=now() WHERE tenant_id=$1", tid)
	run()
	if cycles(tid) != 2 {
		t.Fatal("no cycle three days on, with a run since")
	}
	// A failed one waits an hour; one left running past its time is let go.
	exec("UPDATE learning_cycles SET state='failed',reason='worker_busy',started_at=now()-interval '30 minutes',finished_at=now() WHERE tenant_id=$1", tid)
	run()
	if cycles(tid) != 2 {
		t.Fatal("a failed cycle tried again within the hour")
	}
	exec("UPDATE learning_cycles SET started_at=now()-interval '2 hours' WHERE tenant_id=$1", tid)
	run()
	if cycles(tid) != 3 {
		t.Fatal("a failed cycle not tried again after the hour")
	}
	// One running past its own time, but not twice it, may still be writing its end: it is left; past twice, let go.
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
	exec("INSERT INTO learning_cycles(id,tenant_id,state,started_at) VALUES('stuck',$1,'running',now()-interval '7 minutes')", tid)
	stuck := func() string {
		t.Helper()
		var s string
		if err := h.db.QueryRow(ctx, "SELECT state||':'||reason FROM learning_cycles WHERE tenant_id=$1 AND id='stuck'", tid).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	run()
	if got := stuck(); got != "running:" {
		t.Fatalf("a cycle past its time, not twice it, let go: %q", got)
	}
	exec("UPDATE learning_cycles SET started_at=now()-interval '11 minutes' WHERE tenant_id=$1 AND id='stuck'", tid)
	run()
	if got := stuck(); got != "failed:unfinished" {
		t.Fatalf("a cycle left running: %q", got)
	}
	// A long interval: a run ended since the last cycle, a month ago, makes the workspace due, however old the run.
	h.a.cfg.LearningCycleEvery = 720 * time.Hour
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
	exec("INSERT INTO learning_cycles(id,tenant_id,state,started_at,finished_at) VALUES('month',$1,'done',now()-interval '31 days',now()-interval '31 days')", tid)
	exec("UPDATE graph_runs SET updated_at=now()-interval '29 days' WHERE tenant_id=$1", tid)
	run()
	if cycles(tid) != 2 {
		t.Fatal("no cycle a month on, with a run since the last one")
	}
	h.a.cfg.LearningCycleEvery = 72 * time.Hour
	// Never two at once.
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
	exec("INSERT INTO learning_cycles(id,tenant_id,state) VALUES('busy',$1,'running')", tid)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if cycles(tid) != 1 {
		t.Fatal("a second cycle while one runs")
	}
	// The day's limit counts the cycles whose model read notes: a hundred that read none hold up no other.
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
	exec("UPDATE graph_runs SET updated_at=now() WHERE tenant_id=$1", tid)
	exec(`INSERT INTO learning_cycles(id,tenant_id,state,started_at,finished_at) SELECT 'quiet-'||i,$1,'done',now()-interval '1 hour',now()-interval '1 hour'
		FROM generate_series(1,$2) i`, idle, learningCycleDay)
	run()
	if cycles(tid) != 1 {
		t.Fatal("cycles that read no notes held up a workspace's")
	}
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
	exec("UPDATE learning_cycles SET read_notes=true WHERE tenant_id=$1", idle)
	run()
	if cycles(tid) != 0 {
		t.Fatal("a cycle past the day's limit of cycles that read notes")
	}
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", idle)
	// A workspace that turned self-learning off has none.
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
	h.request(t, c, "PUT", "/tenants/"+tid+"/learning", map[string]any{"selfLearning": false}, 200)
	run()
	if cycles(tid) != 0 {
		t.Fatal("a cycle of a workspace that turned self-learning off")
	}
	// A cycle, and the log of its changes, is kept 90 days.
	exec(`INSERT INTO learning_cycles(id,tenant_id,state,started_at,finished_at) VALUES('old',$1,'done',now()-interval '91 days',now()-interval '91 days'),
		('kept',$1,'done',now()-interval '89 days',now()-interval '89 days')`, idle)
	exec(`INSERT INTO learning_changes(id,tenant_id,cycle_id,kind,item_id) VALUES('old-change',$1,'old','archive_note','gone')`, idle)
	run()
	var kept []string
	if err := h.db.QueryRow(ctx, "SELECT array_agg(id ORDER BY id) FROM learning_cycles WHERE tenant_id=$1", idle).Scan(&kept); err != nil || len(kept) != 1 || kept[0] != "kept" {
		t.Fatalf("the cycles kept: %v %v", kept, err)
	}
	var changes int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM learning_changes WHERE tenant_id=$1", idle).Scan(&changes); err != nil || changes != 0 {
		t.Fatalf("an old cycle's changes kept: %d %v", changes, err)
	}
}

// A cycle moves only a preference or a style rule that runs bore out, never to the whole workspace a text a person
// deleted in it, nor one it holds archived or on probation; a merge leaves the note it keeps as borne out as it was; its
// model is shown no note of people's nor one on probation; and the cycle records that its model read the notes once
// they went, whatever came of the answer.
func TestPostgresALearningCycleKeepsProbationAndDeletions(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, user := h.register(t, "cycle-probation@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	first, second := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	borne := func(n int, ids ...string) {
		t.Helper()
		exec("UPDATE memory_items SET evidence=$3 WHERE tenant_id=$1 AND id=ANY($2)", tid, ids, n)
	}
	dismiss := func(canvasID, title, body string) {
		t.Helper()
		exec("INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash) VALUES($1,NULLIF($2,''),$3)", tid, canvasID, h.a.dismissalHash(tid, memoryContentHash(title, body)))
	}
	// Copies on probation, copies of a fact, and borne-out copies whose text a person deleted in one canvas stay apart.
	newA, newB := notes.probation(first, "Copy on probation"), notes.probation(second, "Copy on probation")
	factA, factB := notes.add(first, "Copy of a fact", ""), notes.add(second, "Copy of a fact", "")
	exec("UPDATE memory_items SET kind='fact' WHERE tenant_id=$1 AND id=ANY($2)", tid, []string{factA, factB})
	goneA, goneB := notes.add(first, "Copy a person deleted", ""), notes.add(second, "Copy a person deleted", "")
	borne(3, factA, factB, goneA, goneB)
	dismiss(first, "Copy a person deleted", "")
	// A merge of a note borne out with one on probation (never shown), and one of a note borne out three times into one
	// borne out twice.
	m1, m2 := notes.add(first, "Short headlines", ""), notes.probation(first, "Headlines are short")
	borne(3, m1)
	m3, m4 := notes.add(first, "Headlines are brief", ""), notes.add(first, "Keep headlines brief", "")
	borne(3, m3)
	person := notes.add(first, "A person's own rule", user)
	// Promotions of a text a person deleted in a canvas, of one the workspace holds archived, and of one it holds on
	// probation; and borne-out copies whose text the workspace holds archived.
	d1, d2 := notes.add(second, "Blue buttons", ""), notes.add(first, "Buttons are blue", "")
	dismiss(first, "Blue buttons", "")
	setWorkspace, oldWay := notes.add("", "Set aside copy", ""), notes.add("", "Prefer the old way", "")
	exec("UPDATE memory_items SET status='archived' WHERE tenant_id=$1 AND id=ANY($2)", tid, []string{setWorkspace, oldWay})
	o1, o2 := notes.add(first, "Prefer the old way", ""), notes.add(second, "The old way is preferred", "")
	// The workspace holds "Prefer serif type" on probation: neither the copies of it in two canvases nor a promotion of
	// it move there.
	waiting := notes.probation("", "Prefer serif type")
	q1, q2, q3 := notes.add(first, "Prefer serif type", ""), notes.add(second, "Serif type is preferred", ""), notes.add(second, "Prefer serif type", "")
	setA, setB := notes.add(first, "Set aside copy", ""), notes.add(second, "Set aside copy", "")
	borne(3, setA, setB)
	keep := func(op, kept string, ids ...string) string {
		return `{"op":"` + op + `","ids":["` + strings.Join(ids, `","`) + `"],"keep":"` + kept + `"}`
	}
	pi.answer.Store(`{"changes":[` + keep("merge", m1, m1, m2) + `,` + keep("merge", m4, m3, m4) + `,` + keep("promote", d1, d1, d2) + `,` +
		keep("promote", o1, o1, o2) + `,` + keep("promote", newA, newA, newB) + `,` + keep("promote", q1, q1, q2) + `]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if state, reason, read, counts := lastCycle(t, h, tid); state != "done" || reason != "" || !read || counts["notes_promoted"] != 0 || counts["notes_merged"] != 1 {
		t.Fatalf("the cycle: %s %q read %v %v", state, reason, read, counts)
	}
	for _, id := range []string{factA, factB, goneA, goneB, d1, d2, person, o1, o2, q1, q2, q3, setA, setB, m1, m4} {
		if status, _, _ := notes.state(id); status != "active" {
			t.Fatalf("note %s was moved, merged or archived", id)
		}
	}
	for _, id := range []string{newA, newB, m2, waiting} {
		if status, _, _ := notes.state(id); status != "proposed" {
			t.Fatalf("note %s on probation was moved, merged or archived", id)
		}
	}
	_, why, merged := notes.state(m3)
	var evidence int
	var status string
	if err := h.db.QueryRow(ctx, "SELECT evidence,status FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, merged).Scan(&evidence, &status); why != "merged" || err != nil ||
		merged != m4 || evidence != 2 || status != "active" {
		t.Fatalf("the merge of a note borne out three times into one borne out twice: %s into %s, borne out %d, %s, %v", why, merged, evidence, status, err)
	}
	var workspaceNotes int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_items WHERE tenant_id=$1 AND canvas_id IS NULL AND status='active'", tid).Scan(&workspaceNotes); err != nil || workspaceNotes != 0 {
		t.Fatalf("notes written for the whole workspace: %d %v", workspaceNotes, err)
	}
	briefing, _ := pi.lastUser.Load().(string)
	if strings.Contains(briefing, "A person's own rule") || !strings.Contains(briefing, `"evidence":3`) || strings.Contains(briefing, "Copy on probation") ||
		strings.Contains(briefing, "Headlines are short") {
		t.Fatal("the briefing the model read", briefing)
	}
	// The worker reads the question and drops it: the cycle fails, to be tried again, and records that its model read
	// the notes.
	pi.drop.Store(true)
	exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
	if err := h.a.runLearningCycle(ctx, tid); err == nil {
		t.Fatal("a cycle whose question was dropped did not fail")
	}
	if state, reason, read, _ := lastCycle(t, h, tid); state != "failed" || reason != "transport" || !read {
		t.Fatalf("a cycle whose question was dropped: %s %s read %v", state, reason, read)
	}
}

// A cycle archives a note AwwO kept that no run used or bore out in 30 days, and no other: not a person's, not one a
// second run bore out, not one a run was given or bore out of late.
func TestPostgresOnlyUnusedNotesAreArchived(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "cycle-unused@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	cid := retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	old := func(title, person, since string) string {
		t.Helper()
		id := notes.add(cid, title, person)
		exec("UPDATE memory_items SET evidence=1,created_at=now()-interval '40 days' WHERE tenant_id=$1 AND id=$2", tid, id)
		if since != "" {
			exec("UPDATE memory_items SET "+since+"=now()-interval '1 day' WHERE tenant_id=$1 AND id=$2", tid, id)
		}
		return id
	}
	unused, theirs, borne := old("Unused", "", ""), old("A person's", user, ""), old("Borne out", "", "")
	exec("UPDATE memory_items SET evidence=2 WHERE tenant_id=$1 AND id=$2", tid, borne)
	used, seen := old("Used of late", "", "last_used_at"), old("Seen of late", "", "last_seen_at")
	waiting := old("Waiting on probation", "", "")
	exec("UPDATE memory_items SET status='proposed' WHERE tenant_id=$1 AND id=$2", tid, waiting)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{unused: "archived", theirs: "active", borne: "active", used: "active", seen: "active", waiting: "archived"} {
		if status, why, _ := notes.state(id); status != want || (want == "archived" && why != "unused") {
			t.Errorf("note %s: %s %s, want %s", id, status, why, want)
		}
	}
	// Taken back, the note on probation comes back on probation, AwwO's and kept apart.
	var change string
	if err := h.db.QueryRow(ctx, "SELECT id FROM learning_changes WHERE tenant_id=$1 AND kind='archive_note' AND item_id=$2", tid, waiting).Scan(&change); err != nil {
		t.Fatal(err)
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/"+change+"/undo", map[string]any{}, 200)
	var back string
	if err := h.db.QueryRow(ctx, "SELECT status||':'||kept_apart::text||':'||(updated_by IS NULL)::text FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, waiting).Scan(&back); err != nil ||
		back != "proposed:true:true" {
		t.Fatalf("a note on probation taken back: %q %v", back, err)
	}
}

// What changes while the model answers holds: a note changed or made a person's since it was read is left as it is; a
// workspace that turns self-learning off while the model answers keeps nothing of it, and one that turns it off, or
// deletes a canvas whose notes were read, just before the notes go has nothing sent.
func TestPostgresALearningCycleKeepsToWhatChangedMeanwhile(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, user := h.register(t, "cycle-meanwhile@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Error(sql, err)
		}
	}
	cid, other := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	a1, a2, b1, b2 := notes.add(cid, "Short headlines", ""), notes.add(cid, "Headlines are short", ""), notes.add(cid, "Blue buttons", ""), notes.add(cid, "Buttons are blue", "")
	notes.add(other, "A note of another canvas", "")
	merge := func(x, y string) string {
		return `{"op":"merge","ids":["` + x + `","` + y + `"],"keep":"` + y + `"}`
	}
	cycle := func() (state, reason string, read bool, counts map[string]int) {
		t.Helper()
		exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
		_ = h.a.runLearningCycle(ctx, tid)
		return lastCycle(t, h, tid)
	}
	active := func(ids ...string) {
		t.Helper()
		for _, id := range ids {
			if status, _, _ := notes.state(id); status != "active" {
				t.Fatalf("note %s %s", id, status)
			}
		}
	}
	// While the model answers, one note gets a new version and another becomes a person's: neither merge is made.
	pi.answer.Store(`{"changes":[` + merge(a1, a2) + `,` + merge(b1, b2) + `]}`)
	pi.onAsk.Store(func() {
		exec("UPDATE memory_items SET version=version+1 WHERE tenant_id=$1 AND id=$2", tid, a1)
		exec("UPDATE memory_items SET updated_by=$3 WHERE tenant_id=$1 AND id=$2", tid, b1, user)
	})
	if state, _, read, counts := cycle(); state != "done" || !read || counts["notes_merged"] != 0 {
		t.Fatalf("notes changed while the model answered: %s %v %v", state, read, counts)
	}
	active(a1, a2, b1, b2)
	// Turned off while the model answers: nothing it answered is kept.
	pi.answer.Store(`{"changes":[` + merge(a1, a2) + `]}`)
	off := func() {
		exec("INSERT INTO workspace_learning(tenant_id,learning_off_at) VALUES($1,now()) ON CONFLICT (tenant_id) DO UPDATE SET learning_off_at=now()", tid)
	}
	pi.onAsk.Store(off)
	if state, reason, read, counts := cycle(); state != "done" || reason != "learning_off" || !read || counts["notes_merged"] != 0 {
		t.Fatalf("turned off while the model answered: %s %s %v %v", state, reason, read, counts)
	}
	active(a1, a2)
	pi.onAsk.Store(func() {})
	// Turned off as the worker is asked for its health, just before the notes would go: nothing is sent.
	on := func() { exec("UPDATE workspace_learning SET learning_off_at=NULL WHERE tenant_id=$1", tid) }
	on()
	pi.onHealth.Store(off)
	asked := pi.asked.Load()
	if state, reason, read, _ := cycle(); state != "done" || reason != "learning_off" || read || pi.asked.Load() != asked {
		t.Fatalf("turned off just before the notes went: %s %s read %v, asked %d", state, reason, read, pi.asked.Load()-asked)
	}
	// A canvas whose notes were read is deleted just before they would go: nothing is sent, and the cycle says why.
	on()
	pi.onHealth.Store(func() { exec("DELETE FROM canvases WHERE tenant_id=$1 AND id=$2", tid, other) })
	if state, reason, read, _ := cycle(); state != "done" || reason != "notes_changed" || read || pi.asked.Load() != asked {
		t.Fatalf("a canvas deleted just before the notes went: %s %s read %v, asked %d", state, reason, read, pi.asked.Load()-asked)
	}
	// A learning write of the workspace under way (another run's notes being kept) as the notes would go: it is not waited
	// for (well under the 5 s a row is waited for), nothing is sent, and the cycle fails, to be tried again.
	release, once := make(chan struct{}), sync.Once{}
	var released sync.Once
	letGo := func() { released.Do(func() { close(release) }) }
	t.Cleanup(letGo)
	pi.onHealth.Store(func() {
		once.Do(func() {
			held := make(chan error, 1)
			go func() {
				tx, err := h.db.Begin(context.Background())
				if err == nil {
					err = serializeLearningWrites(context.Background(), tx, tid)
				}
				held <- err
				<-release
				if tx != nil {
					_ = tx.Rollback(context.Background())
				}
			}()
			if err := <-held; err != nil {
				t.Error(err)
			}
		})
	})
	began := time.Now()
	if state, reason, read, _ := cycle(); state != "failed" || reason != "learning_busy" || read || pi.asked.Load() != asked {
		t.Fatalf("a learning write under way as the notes would go: %s %s read %v, asked %d", state, reason, read, pi.asked.Load()-asked)
	}
	if took := time.Since(began); took > 4*time.Second {
		t.Fatalf("the cycle waited %s for the learning write under way", took)
	}
	letGo()
	pi.onHealth.Store(func() {})
	// With nothing changing, the merge is made.
	if state, reason, read, counts := cycle(); state != "done" || reason != "" || !read || counts["notes_merged"] != 1 {
		t.Fatalf("a cycle with nothing changing meanwhile: %s %s %v %v", state, reason, read, counts)
	}
}

// A node's lesson whose template has the workspace's lesson already is cited there, as a person's promotion of it is:
// the next cycles look past it.
func TestPostgresALessonItsTemplateHasIsCitedThere(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "cycle-cited@example.test")
	ctx := context.Background()
	first, second := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	for i, cid := range []string{first, second} {
		if _, err := h.db.Exec(ctx, `INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
			VALUES($1,$2,$3,'up','output_limit','rule',$1,'Keep it short.','active',5,$4,0)`, fmt.Sprintf("lesson-%d", i), tid, cid, 5-i); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	var cited []map[string]string
	var raw []byte
	if err := h.db.QueryRow(ctx, "SELECT evidence FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL", tid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &cited)
	if len(cited) != 2 || cited[0]["lessonId"] != "lesson-1" || cited[1]["lessonId"] != "lesson-0" {
		t.Fatalf("the workspace's lesson cites %v", cited)
	}
	if _, _, _, counts := lastCycle(t, h, tid); counts["lessons_promoted"] != 1 {
		t.Fatalf("lessons given: %v", counts)
	}
}

// Taking a change back needs every note it took the place of as it left them: one a person brought back since leaves
// the change as it is (409), and one that would fill its scope past its limit too, until there is room.
func TestPostgresTakingAChangeBackNeedsWhatItLeft(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, _ := h.register(t, "cycle-undo-left@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	first, second := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	a, b, d := notes.add(first, "Short headlines", ""), notes.add(first, "Headlines are short", ""), notes.add(first, "Keep headlines short", "")
	x, y := notes.add(second, "Blue buttons", ""), notes.add(second, "Buttons are blue", "")
	pi.answer.Store(`{"changes":[{"op":"merge","ids":["` + a + `","` + b + `","` + d + `"],"keep":"` + d + `"},` +
		`{"op":"merge","ids":["` + x + `","` + y + `"],"keep":"` + y + `"}]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	change := func(canvasID string) (id, merged string) {
		t.Helper()
		if err := h.db.QueryRow(ctx, "SELECT id,item_id FROM learning_changes WHERE tenant_id=$1 AND kind='merge_notes' AND canvas_id=$2", tid, canvasID).Scan(&id, &merged); err != nil {
			t.Fatal(err)
		}
		return
	}
	undo := func(id string, status int) {
		t.Helper()
		h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/"+id+"/undo", map[string]any{}, status)
	}
	still := func(merged string, sources ...string) {
		t.Helper()
		if status, _, _ := notes.state(merged); status != "active" {
			t.Fatal("a merge partly taken back")
		}
		for _, id := range sources {
			if status, why, by := notes.state(id); status != "archived" || why != "merged" || by != merged {
				t.Fatalf("note %s after a refused undo: %s %s %s", id, status, why, by)
			}
		}
	}
	// A person brings back one of the notes the merge archived: nothing more is taken back.
	edited, merged := change(first)
	note := listedNote(t, h, c, tid, first, b)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+b, map[string]any{"version": note["version"], "status": "active"}, 200)
	undo(edited, 409)
	if status, _, _ := notes.state(merged); status != "active" || merged != d {
		t.Fatal("a merge partly taken back after a person brought back one of its notes")
	}
	if status, why, _ := notes.state(a); status != "archived" || why != "merged" {
		t.Fatalf("note %s brought back alone: %s %s", a, status, why)
	}
	// The second canvas full but for the note its merge kept: bringing the other back would pass its limit.
	full, merged2 := change(second)
	exec(`INSERT INTO memory_items(id,tenant_id,canvas_id,title,body,kind,status,origin,source,content_hash,created_by)
		SELECT 'fill-'||i,$1,$2,'Filler '||i,'','preference','active','user','{}',encode(sha256(convert_to('Filler '||i,'UTF8')||'\x00'::bytea),'hex'),NULL FROM generate_series(1,$3) i`,
		tid, second, maxMemoryPerScope-1)
	undo(full, 409)
	still(merged2, x)
	exec("DELETE FROM memory_items WHERE tenant_id=$1 AND id='fill-1'", tid)
	undo(full, 200)
	for _, id := range []string{x, y} {
		if status, _, _ := notes.state(id); status != "active" {
			t.Fatalf("note %s not brought back once there was room", id)
		}
	}
}

// Within one answer, a note an earlier change kept or wrote is not changed again: a merge, then an archive of the note
// it kept, leaves that note in use; two promotions whose kept notes say the same, word for word, make one note of the
// whole workspace, the second leaving its own notes as they are.
func TestPostgresATidyAnswerDoesNotUndoItself(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, _ := h.register(t, "cycle-itself@example.test")
	ctx := context.Background()
	cid, other, third := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	a, b := notes.add(cid, "Short headlines", ""), notes.add(cid, "Headlines are short", "")
	pi.answer.Store(`{"changes":[{"op":"merge","ids":["` + a + `","` + b + `"],"keep":"` + b + `"},{"op":"archive","id":"` + b + `"}]}`)
	// Enough notes for the model to be asked.
	notes.add(cid, "A note to show", "")
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if _, _, _, counts := lastCycle(t, h, tid); counts["notes_merged"] != 1 || counts["notes_archived"] != 0 {
		t.Fatalf("the cycle: %v", counts)
	}
	if status, _, _ := notes.state(b); status != "active" {
		t.Fatal("the note a merge kept was archived by the same answer")
	}
	if status, why, by := notes.state(a); status != "archived" || why != "merged" || by != b {
		t.Fatalf("note %s: %s %s %s", a, status, why, by)
	}
	// Two promotions whose kept notes (of one canvas: no copies of several canvases to move first) say the same: the
	// second finds the note of the whole workspace the first wrote, and leaves its own notes.
	p1, p2 := notes.add(cid, "Blue buttons", ""), notes.add(other, "Buttons are blue", "")
	p3, p4 := notes.add(cid, "Blue buttons", ""), notes.add(third, "Buttons blue", "")
	pi.answer.Store(`{"changes":[{"op":"promote","ids":["` + p1 + `","` + p2 + `"],"keep":"` + p1 + `"},` +
		`{"op":"promote","ids":["` + p3 + `","` + p4 + `"],"keep":"` + p3 + `"}]}`)
	if _, err := h.db.Exec(ctx, "DELETE FROM learning_cycles WHERE tenant_id=$1", tid); err != nil {
		t.Fatal(err)
	}
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	if _, _, _, counts := lastCycle(t, h, tid); counts["notes_promoted"] != 1 {
		t.Fatalf("two promotions into one text: %v", counts)
	}
	for _, id := range []string{p1, p2} {
		if status, why, _ := notes.state(id); status != "archived" || why != "promoted" {
			t.Fatalf("note %s not promoted: %s %s", id, status, why)
		}
	}
	for _, id := range []string{p3, p4} {
		if status, _, _ := notes.state(id); status != "active" {
			t.Fatalf("note %s moved into a note the same answer wrote", id)
		}
	}
}

// A template's lesson cites the node lessons like the one it came from while its evidence has room, and no more: the
// cycles after leave it as it is.
func TestPostgresALessonsCitesStopAtTheirLimit(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, _ := h.register(t, "cycle-cites@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	lessons := maxLessonEvidence + 2
	for i := 0; i < lessons; i++ {
		canvas := fmt.Sprintf("cites-%02d", i)
		exec(`INSERT INTO canvases(id,tenant_id,name,document) VALUES($1,$2,$1,'{"nodes":[{"id":"up","kind":"session","templateId":"frontend"}]}')`, canvas, tid)
		exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
			VALUES($1,$2,$3,'up','output_limit','rule',$1,'Keep it short.','active',9,$4,0)`, "lesson-"+canvas, tid, canvas, 9-i%5)
	}
	cycle := func() (evidence int, updated time.Time) {
		t.Helper()
		exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
		if err := h.a.runLearningCycle(ctx, tid); err != nil {
			t.Fatal(err)
		}
		if err := h.db.QueryRow(ctx, "SELECT jsonb_array_length(evidence),updated_at FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL", tid).Scan(&evidence, &updated); err != nil {
			t.Fatal(err)
		}
		return
	}
	evidence, updated := cycle()
	if evidence != maxLessonEvidence {
		t.Fatalf("the template's lesson cites %d", evidence)
	}
	if again, then := cycle(); again != maxLessonEvidence || !then.Equal(updated) {
		t.Fatalf("a full lesson changed again: %d cites, updated %v then %v", again, updated, then)
	}
}

// The node lessons a cycle looks at are read a page at a time, past those whose template's lesson cites as many as it
// may: a lesson of another template, behind more of those than a page holds, is still given; and no more are read than
// the cycle reads in all.
func TestPostgresTheLessonsOfAFullTemplateHoldUpNoOther(t *testing.T) {
	page, scan := learningLessonPage, learningLessonScan
	learningLessonPage, learningLessonScan = 3, 50
	t.Cleanup(func() { learningLessonPage, learningLessonScan = page, scan })
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, _ := h.register(t, "cycle-pages@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec(`INSERT INTO canvases(id,tenant_id,name,document) VALUES('pages',$1,'Pages','{"nodes":[{"id":"up","kind":"session","templateId":"frontend"},{"id":"down","kind":"session","templateId":"backend"}]}')`, tid)
	// The frontend template's lesson of the kind, citing as many node lessons as it may.
	cites := []map[string]string{}
	for i := 0; i < maxLessonEvidence; i++ {
		cites = append(cites, map[string]string{"lessonId": fmt.Sprintf("cited-%d", i), "canvasId": "pages"})
	}
	exec(`INSERT INTO canvas_lessons(id,tenant_id,kind,source,fingerprint,rule,scope,evidence,status) VALUES('full',$1,'output_limit','rule',$2,'Keep it short.','{"templateId":"frontend"}',$3,'active')`,
		tid, workspaceLessonFingerprint("frontend", "output_limit", ""), jsonBytes(cites))
	// Ten lessons of the frontend node that helped most, then one of the backend node.
	for i := 0; i < 10; i++ {
		exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
			VALUES($1,$2,'pages','up','output_limit','rule',$1,'Keep it short.','active',9,9,0)`, fmt.Sprintf("front-%02d", i), tid)
	}
	exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
		VALUES('back',$1,'pages','down','output_limit','rule','back','Keep it short.','active',4,4,0)`, tid)
	backend := func() int {
		t.Helper()
		exec("DELETE FROM learning_cycles WHERE tenant_id=$1", tid)
		if err := h.a.runLearningCycle(ctx, tid); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL AND scope->>'templateId'='backend' AND status='active'", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := backend(); n != 1 {
		t.Fatalf("the backend template's lesson behind a full template's: %d", n)
	}
	var cited int
	if err := h.db.QueryRow(ctx, "SELECT jsonb_array_length(evidence) FROM canvas_lessons WHERE tenant_id=$1 AND id='full'", tid).Scan(&cited); err != nil || cited != maxLessonEvidence {
		t.Fatalf("the full template's lesson cites %d: %v", cited, err)
	}
	// Read only as far as a cycle reads in all, the backend node's lesson is not reached.
	exec("DELETE FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL AND scope->>'templateId'='backend'", tid)
	learningLessonScan = 9
	if n := backend(); n != 0 {
		t.Fatalf("a lesson past what a cycle reads was given: %d", n)
	}
}

// A promotion into a note of the whole workspace that held the text already is taken back only while that note is as
// the promotion left it: once a person pinned it, the copies stay where they were moved (itemVersion).
func TestPostgresAPromotionIntoANoteThatWasThereIsTakenBackOnlyAsItLeftIt(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, _ := h.register(t, "cycle-promote-there@example.test")
	ctx := context.Background()
	first, second := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	copyA, copyB, there := notes.add(first, "Copy in both", ""), notes.add(second, "Copy in both", ""), notes.add("", "Copy in both", "")
	pi.answer.Store(`{"changes":[]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{copyA, copyB} {
		if status, reason, by := notes.state(id); status != "archived" || reason != "promoted" || by != there {
			t.Fatalf("a copy moved into the workspace's note of its text: %s %s %s", status, reason, by)
		}
	}
	change := func() map[string]any {
		t.Helper()
		for _, raw := range h.request(t, c, "GET", "/tenants/"+tid+"/learning/cycles", nil, 200)["cycles"].([]any)[0].(map[string]any)["changes"].([]any) {
			if ch := raw.(map[string]any); ch["kind"] == "promote_note" {
				return ch
			}
		}
		t.Fatal("no promotion listed")
		return nil
	}
	if moved := change(); moved["undoable"] != true {
		t.Fatal("a promotion into a note that was there, as it left it, is not offered to be taken back", moved)
	}
	pin := listedNote(t, h, c, tid, "", there)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+there, map[string]any{"version": pin["version"], "pinned": true}, 200)
	moved := change()
	if moved["undoable"] != false {
		t.Fatal("a promotion into a note a person pinned since is offered to be taken back", moved)
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/"+moved["id"].(string)+"/undo", map[string]any{}, 409)
	if status, reason, _ := notes.state(copyA); status != "archived" || reason != "promoted" {
		t.Fatalf("a copy after a refused undo: %s %s", status, reason)
	}
}

// A cycle and its log go after learningCyclesKept, and one left running is let go of, whether or not cycles run; where
// none run, the cycles' route says so (everyHours 0).
func TestPostgresCyclesOfBeforeGoWhereNoneRun(t *testing.T) {
	// Every 72 hours, as a deployment sets it: only the offer of self-learning is missing.
	h := newHarness(t, "", func(a *App) { a.cfg.LearningCycleEvery = 72 * time.Hour })
	c, tid, _ := h.register(t, "cycle-prune@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec(`INSERT INTO learning_cycles(id,tenant_id,state,started_at,finished_at) VALUES('old',$1,'done',now()-interval '100 days',now()-interval '100 days'),
		('stuck',$1,'running',now()-interval '1 day',NULL),('new',$1,'done',now()-interval '1 day',now()-interval '1 day')`, tid)
	exec(`INSERT INTO learning_changes(id,tenant_id,cycle_id,kind,item_id,sources,before) VALUES('logged',$1,'old','archive_note','x','{}','{}')`, tid)
	if h.a.learningCyclesRun() {
		t.Fatal("cycles run where self-learning is not offered")
	}
	// The background loop lets go of them, as it does where no cycles run.
	watch, stop := context.WithCancel(ctx)
	t.Cleanup(stop)
	h.a.startLearningCycles(watch)
	var left []string
	var logged int
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if err := h.db.QueryRow(ctx, "SELECT COALESCE(array_agg(id||':'||state ORDER BY id),'{}') FROM learning_cycles WHERE tenant_id=$1", tid).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM learning_changes WHERE tenant_id=$1", tid).Scan(&logged); err != nil {
			t.Fatal(err)
		}
		if slices.Equal(left, []string{"new:done", "stuck:failed"}) && logged == 0 || time.Now().After(deadline) {
			break
		}
	}
	if !slices.Equal(left, []string{"new:done", "stuck:failed"}) {
		t.Fatalf("the cycles left: %v", left)
	}
	if logged != 0 {
		t.Fatalf("the log of a cycle gone: %d", logged)
	}
	if every := h.request(t, c, "GET", "/tenants/"+tid+"/learning/cycles", nil, 200)["everyHours"]; every != float64(0) {
		t.Fatalf("how often cycles come where none run: %v", every)
	}
}
