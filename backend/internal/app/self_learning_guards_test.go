package app

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The guards of round 7 of self-learning: what a later run may not bring into use behind a person's back, what a
// person's deletion, archive or pin keeps out, and what a cycle may not move once a member changed it.

// A run that names a note on probation as the replacement of another gives it a new version: a person who read it
// before, unaware, cannot bring it into use (and so archive the other); read again, they can.
func TestPostgresAReplacementNamedLaterIsANewVersion(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-version@example.test")
	if _, err := h.db.Exec(context.Background(), "INSERT INTO canvases(id,tenant_id,name) VALUES('cv',$1,'Versions')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	dark, light := notes.add("cv", "Pages are dark", ""), notes.probation("cv", "Pages are light")
	read := listedNote(t, h, c, tid, "cv", light)
	// A run that took some nodes' earlier outputs names it as the dark note's replacement, bearing nothing out.
	keepNotesOf(t, h, tid, "cv", user, true, memoryDistillNote{Op: "replace", ID: dark, Kind: "preference", Title: "Pages are light"})
	again := listedNote(t, h, c, tid, "cv", light)
	if again["replacesId"] != dark || again["version"] == read["version"] {
		t.Fatalf("named as a replacement: %v, version %v then %v", again["replacesId"], read["version"], again["version"])
	}
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+light, map[string]any{"version": read["version"], "status": "active"}, 409)
	if status, _, _ := notes.state(dark); status != "active" {
		t.Fatalf("a confirm of the note as it was read archived the one it now replaces: %s", status)
	}
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+light, map[string]any{"version": again["version"], "status": "active"}, 200)
	if status, reason, by := notes.state(dark); status != "archived" || reason != "superseded" || by != light {
		t.Fatalf("confirmed as read again: %s %s %s", status, reason, by)
	}
}

// Once a note's replacement comes into use, the other notes written to take its place are set aside, those archived
// unused too: written again later, none comes back beside it.
func TestPostgresAReplacementLeavesNoRivalToComeBack(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, user := h.register(t, "guard-rivals@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cr',$1,'Rivals')", tid)
	notes := cycleNotes{t, h, tid}
	dark, grey, light := notes.add("cr", "Pages are dark", ""), notes.probation("cr", "Pages are grey"), notes.probation("cr", "Pages are light")
	exec("UPDATE memory_items SET replaces_id=$2 WHERE tenant_id=$1 AND id=ANY($3)", tid, dark, []string{grey, light})
	exec("UPDATE memory_items SET status='archived',archived_reason='unused' WHERE tenant_id=$1 AND id=$2", tid, grey)
	keep := func(note memoryDistillNote) {
		t.Helper()
		keepNotesOf(t, h, tid, "cr", user, false, note)
	}
	keep(memoryDistillNote{Op: "replace", ID: dark, Kind: "preference", Title: "Pages are light"})
	if status, reason, by := notes.state(dark); status != "archived" || reason != "superseded" || by != light {
		t.Fatalf("the note replaced: %s %s %s", status, reason, by)
	}
	if status, reason, by := notes.state(grey); status != "archived" || reason != "superseded" || by != light {
		t.Fatalf("the rival archived unused: %s %s %s", status, reason, by)
	}
	keep(memoryDistillNote{Op: "add", Kind: "preference", Title: "Pages are grey"})
	if status, _, _ := notes.state(grey); status != "archived" {
		t.Fatalf("the rival came back beside the replacement in use: %s", status)
	}
}

// A note a person makes theirs, kept in use, keeps its place: the notes AwwO wrote to take it are set aside, whether the
// person pins it or saves its text as their own, and a run writing one of them again does not bring it back.
func TestPostgresANotePeopleKeepKeepsItsPlace(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-keep@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ck',$1,'Keep')", tid)
	notes := cycleNotes{t, h, tid}
	want := func(id, wantStatus, wantReason string) {
		t.Helper()
		if status, reason, _ := notes.state(id); status != wantStatus || reason != wantReason {
			t.Fatalf("note %s: %s %q, want %s %q", id, status, reason, wantStatus, wantReason)
		}
	}
	dark, light := notes.add("ck", "Pages are dark", ""), notes.probation("ck", "Pages are light")
	exec("UPDATE memory_items SET replaces_id=$2 WHERE tenant_id=$1 AND id=$3", tid, dark, light)
	read := listedNote(t, h, c, tid, "ck", dark)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+dark, map[string]any{"version": read["version"], "pinned": true}, 200)
	want(dark, "active", "")
	want(light, "archived", "outdated")
	keepNotesOf(t, h, tid, "ck", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: "Pages are light"})
	want(light, "archived", "outdated")
	// Saved by a person as their own text: the same.
	long, short := notes.add("ck", "Copy is long", ""), notes.probation("ck", "Copy is short")
	exec("UPDATE memory_items SET replaces_id=$2 WHERE tenant_id=$1 AND id=$3", tid, long, short)
	h.request(t, c, "POST", "/tenants/"+tid+"/memory", map[string]any{"canvasId": "ck", "title": "Copy is long", "body": "", "kind": "preference", "status": "active"}, 200)
	want(long, "active", "")
	want(short, "archived", "outdated")
	// Archived by the person, the note leaves its replacements waiting: one of them may take its place.
	tone, friendly := notes.add("ck", "Tone is formal", ""), notes.probation("ck", "Tone is friendly")
	exec("UPDATE memory_items SET replaces_id=$2 WHERE tenant_id=$1 AND id=$3", tid, tone, friendly)
	read = listedNote(t, h, c, tid, "ck", tone)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+tone, map[string]any{"version": read["version"], "status": "archived"}, 200)
	want(friendly, "proposed", "")
}

// A note AwwO keeps for the whole workspace is not given to a canvas that set its text aside: where a person archived a
// note of it, where the canvas's runs replaced it or found it out of date, where a person undid it, or where a person
// deleted it, in its words or most of them; other canvases are given it, and so is one where a cycle tidied its text
// away (a model's view, which no run bore out).
func TestPostgresAWorkspaceNoteKeepsOutOfACanvasThatSetItAside(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-aside@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec(`INSERT INTO canvases(id,tenant_id,name) VALUES('here',$1,'Here'),('there',$1,'There'),('replaced',$1,'Replaced'),('deleted',$1,'Deleted'),
		('outdated',$1,'Outdated'),('undone',$1,'Undone'),('tidied',$1,'Tidied')`, tid)
	notes := cycleNotes{t, h, tid}
	notes.add("", "Pages are dark with gold accents", "")
	exec("UPDATE memory_items SET status='archived' WHERE tenant_id=$1 AND id=$2", tid, notes.add("here", "Pages are dark with gold accents", user))
	for _, reason := range []string{"replaced", "outdated", "undone", "tidied"} {
		why := map[string]string{"replaced": "superseded"}[reason]
		if why == "" {
			why = reason
		}
		exec("UPDATE memory_items SET status='archived',archived_reason=$3 WHERE tenant_id=$1 AND id=$2", tid, notes.add(reason, "Pages are dark with gold accents", ""), why)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("deleted", "Dark pages, gold accents", ""), nil, 200)
	given := func(canvasID string) bool {
		t.Helper()
		tx, err := h.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		memory, err := h.a.freezeMemoryContext(ctx, tx, tid, canvasID, "dark pages", true, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range memoryItemsOf(memory) {
			if item.Title == "Pages are dark with gold accents" && item.Scope == "workspace" {
				return true
			}
		}
		return false
	}
	if given("here") {
		t.Fatal("the workspace's note was given to a canvas where a person archived its text")
	}
	if given("replaced") {
		t.Fatal("the workspace's note was given to a canvas whose runs replaced its text")
	}
	if given("outdated") || given("undone") {
		t.Fatal("the workspace's note was given to a canvas that found its text out of date, or undid it")
	}
	if given("deleted") {
		t.Fatal("the workspace's note was given to a canvas where a person deleted a note saying the same")
	}
	if !given("there") || !given("tidied") {
		t.Fatal("the workspace's note was not given to another canvas, or to one a cycle tidied its text away in")
	}
}

// memoryItemsOf is the notes a run was given (none without a context).
func memoryItemsOf(memory *memoryContext) []memoryNote {
	if memory == nil {
		return nil
	}
	return memory.Items
}

// A note AwwO kept that a person deleted is not written there again in other words most of which are its own; a
// person's own note leaves nothing behind once deleted; a text AwwO wrote is remembered when a person corrects it, even
// after they pinned it, and the corrected text, theirs, leaves nothing when corrected again.
func TestPostgresADismissedNoteStaysGoneInOtherWords(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-dismissed@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cd',$1,'Dismissed')", tid)
	notes := cycleNotes{t, h, tid}
	dismissals := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	keep := func(title string) int {
		t.Helper()
		return keepNotesOf(t, h, tid, "cd", user, false, memoryDistillNote{Op: "add", Kind: "fact", Title: title})
	}
	gone := notes.add("cd", "Client Wang Lei takes calls on Monday mornings", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+gone, nil, 200)
	if n := dismissals(); n != 1 {
		t.Fatalf("a deleted note of AwwO's left %d dismissals", n)
	}
	if written := keep("Wang Lei, the client, takes calls Monday mornings"); written != 0 {
		t.Fatal("a deleted note was written again in other words")
	}
	if written := keep("Pages are dark"); written != 1 {
		t.Fatal("a note saying something else was refused")
	}
	// A long note holding every word of the deleted one says it too; another canvas's notes are not held to it.
	long := "Wang Lei the client takes calls Monday mornings; " + strings.Repeat("also review alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ", 3)
	if written := keepNotesOf(t, h, tid, "cd", user, false, memoryDistillNote{Op: "add", Kind: "fact", Title: "Calls", Body: long}); written != 0 {
		t.Fatal("a long note holding every word of a deleted one was written")
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('elsewhere',$1,'Elsewhere')", tid)
	if written := keepNotesOf(t, h, tid, "elsewhere", user, false, memoryDistillNote{Op: "add", Kind: "fact", Title: "Wang Lei, the client, takes calls Monday mornings"}); written != 1 {
		t.Fatal("a note of another canvas was held to a deletion in this one")
	}
	// A short note deleted holds back only notes holding all its words: one of another attribute is written; one saying
	// the opposite (a correction) is written too.
	for _, deleted := range []string{"Product cards are blue", "Headlines use serif fonts", "标题用衬线字体", "Releases ship on Fridays", "Captions never use italics",
		"Footers list partner logos"} {
		h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cd", deleted, ""), nil, 200)
	}
	// One that only adds a word with a no in it says the same, and is held back; so does one in its words in the plural or
	// the singular, or in wide letters, and one that says in other words what a deleted denial said; one that denies
	// what a deleted denial said corrects it.
	for title, want := range map[string]int{"Product cards have rounded corners": 1, "Blue product cards": 0, "Headlines never use serif fonts": 1,
		"标题不用衬线字体": 1, "Headlines use serif fonts without exception": 0, "标题特别用衬线字体": 0, "Releases never ship on Fridays": 1,
		"Releases ship, not on Fridays": 1, "Caption text never uses italics": 0, "Captions use italics": 1, "Footer lists partner logo": 0,
		"Ｆｏｏｔｅｒｓ ｌｉｓｔ ｐａｒｔｎｅｒ ｌｏｇｏｓ": 0} {
		if written := keep(title); written != want {
			t.Fatalf("%q after its likes were deleted: written %d, want %d", title, written, want)
		}
	}
	// A person's own note, saved from a node, leaves nothing behind.
	before := dismissals()
	own := h.request(t, c, "POST", "/tenants/"+tid+"/memory", map[string]any{"canvasId": "cd", "title": "Our launch is in spring", "body": "", "kind": "fact",
		"status": "active", "source": map[string]any{"nodeId": "writer"}}, 201)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+own["id"].(string), nil, 200)
	if n := dismissals(); n != before {
		t.Fatalf("a person's own note left a dismissal: %d, %d before", n, before)
	}
	// AwwO's text, pinned, then corrected: its old text is remembered; corrected again, the person's text is not.
	exec(`INSERT INTO memory_items(id,tenant_id,canvas_id,title,body,kind,status,origin,source,content_hash,evidence,prompt_version)
		VALUES('inter',$1,'cd','Headlines use Inter','','style','active','run','{}',$2,2,$3)`, tid, memoryContentHash("Headlines use Inter", ""), memoryDistillPromptVersion)
	patch := func(change map[string]any) {
		t.Helper()
		note := listedNote(t, h, c, tid, "cd", "inter")
		change["version"] = note["version"]
		h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/inter", change, 200)
	}
	patch(map[string]any{"pinned": true})
	patch(map[string]any{"title": "Headlines use Fraunces"})
	if n := dismissals(); n != before+1 {
		t.Fatalf("AwwO's text corrected after a pin left %d dismissals, %d before", n, before)
	}
	patch(map[string]any{"title": "Headlines use Lora"})
	if n := dismissals(); n != before+1 {
		t.Fatalf("a person's own correction corrected again left a dismissal: %d, %d before", n, before)
	}
}

// A cycle moves to the whole workspace no copies of a text another canvas set aside: archived as a person would have it
// (AwwO's archive, archived again by a person), or replaced there by its runs; nor copies one of which a replacement
// waits on. A text no canvas set aside moves.
func TestPostgresCopiesStayWhereACanvasSetTheirTextAside(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-copies@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	first, second, third := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	copies := func(title string) string {
		t.Helper()
		notes.add(first, title, "")
		notes.add(second, title, "")
		return notes.add(third, title, "")
	}
	again := copies("Use round corners")
	exec("UPDATE memory_items SET status='archived',archived_reason='unused' WHERE tenant_id=$1 AND id=$2", tid, again)
	read := listedNote(t, h, c, tid, third, again)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+again, map[string]any{"version": read["version"], "status": "archived"}, 200)
	exec("UPDATE memory_items SET status='archived',archived_reason='superseded' WHERE tenant_id=$1 AND id=$2", tid, copies("Pages are dark"))
	waited := notes.add(first, "Headlines are bold", "")
	notes.add(second, "Headlines are bold", "")
	exec(`INSERT INTO memory_items(id,tenant_id,canvas_id,title,body,kind,status,origin,source,content_hash,evidence,replaces_id)
		VALUES('waiting',$1,$2,'Headlines are thin','','preference','proposed','run','{}',$3,1,$4)`, tid, first, memoryContentHash("Headlines are thin", ""), waited)
	// Deleted in the third canvas in other words.
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add(third, "Footers are bold and narrow", ""), nil, 200)
	notes.add(first, "Narrow bold footers", "")
	notes.add(second, "Narrow bold footers", "")
	notes.add(first, "Use short captions", "")
	notes.add(second, "Use short captions", "")
	pi.answer.Store(`{"changes":[]}`)
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	rows, err := h.db.Query(ctx, "SELECT title FROM memory_items WHERE tenant_id=$1 AND canvas_id IS NULL ORDER BY title", tid)
	if err != nil {
		t.Fatal(err)
	}
	moved := []string{}
	for rows.Next() {
		var title string
		if err = rows.Scan(&title); err != nil {
			t.Fatal(err)
		}
		moved = append(moved, title)
	}
	rows.Close()
	if len(moved) != 1 || moved[0] != "Use short captions" {
		t.Fatalf("moved to the whole workspace: %v", moved)
	}
}

// A replacement written while the tidying model answers keeps the note it waits on out of the merge the model asks for.
func TestPostgresATidyMergeLeavesANoteAReplacementWaitsOn(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-merge@example.test")
	ctx := context.Background()
	first := retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	short, headlines := notes.add(first, "Headlines are short", ""), notes.add(first, "Short headlines", "")
	notes.add(first, "Buttons are blue", "") // a cycle asks the model of three notes at least
	pi.answer.Store(`{"changes":[{"op":"merge","ids":["` + short + `","` + headlines + `"],"keep":"` + headlines + `"}]}`)
	pi.onAsk.Store(func() {
		if _, err := h.db.Exec(ctx, `INSERT INTO memory_items(id,tenant_id,canvas_id,title,body,kind,status,origin,source,content_hash,evidence,replaces_id)
			VALUES('meanwhile',$1,$2,'Headlines are long','','preference','proposed','run','{}',$3,1,$4)`, tid, first, memoryContentHash("Headlines are long", ""), short); err != nil {
			t.Error(err)
		}
	})
	if err := h.a.runLearningCycle(ctx, tid); err != nil {
		t.Fatal(err)
	}
	pi.onAsk.Store(func() {})
	if _, _, read, counts := lastCycle(t, h, tid); !read || counts["notes_merged"] != 0 {
		t.Fatalf("a merge of a note a replacement came to wait on: read %v %v", read, counts)
	}
	for _, id := range []string{short, headlines} {
		if status, _, _ := notes.state(id); status != "active" {
			t.Fatalf("note %s %s", id, status)
		}
	}
}

// A node's lesson whose node changed template, or left its canvas, between a cycle's read and its write is given to no
// template; read again, the lesson of the node still there is given to the template it is on now.
func TestPostgresALessonChangedMeanwhileIsNotGiven(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, _ := h.register(t, "guard-lessons@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec(`INSERT INTO canvases(id,tenant_id,name,document) VALUES('lc',$1,'Lessons','{"nodes":[{"id":"up","kind":"session","templateId":"frontend"},{"id":"down","kind":"session","templateId":"backend"}]}')`, tid)
	for _, node := range []string{"up", "down"} {
		exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
			VALUES($1,$2,'lc',$3,'output_limit','rule',$1,'Keep it short.','active',5,5,0)`, "lesson-"+node, tid, node)
	}
	cycle := &learningCycleRun{id: randomID(), tid: tid, counts: map[string]int{}}
	exec("INSERT INTO learning_cycles(id,tenant_id,state) VALUES($1,$2,'running')", cycle.id, tid)
	found, err := h.a.helpfulLessons(ctx, tid)
	if err != nil || len(found) != 2 {
		t.Fatalf("the lessons read: %d %v", len(found), err)
	}
	exec(`UPDATE canvases SET document='{"nodes":[{"id":"up","kind":"session","templateId":"backend"}]}' WHERE tenant_id=$1 AND id='lc'`, tid)
	if given, err := h.a.giveHelpfulLessons(ctx, cycle, found); err != nil || given != 0 {
		t.Fatalf("lessons whose nodes changed meanwhile were given: %d %v", given, err)
	}
	if found, err = h.a.helpfulLessons(ctx, tid); err != nil || len(found) != 1 || found[0].template != "backend" {
		t.Fatalf("the lessons read again: %+v %v", found, err)
	}
	if given, err := h.a.giveHelpfulLessons(ctx, cycle, found); err != nil || given != 1 {
		t.Fatalf("the lesson as it is now: %d %v", given, err)
	}
	// A lesson whose evidence changed between the read and the write is neither given to its template nor cited by the
	// lesson its template has; as read again, it is.
	exec(`UPDATE canvases SET document='{"nodes":[{"id":"up","kind":"session","templateId":"backend"},{"id":"side","kind":"session","templateId":"backend"},
		{"id":"third","kind":"session","templateId":"frontend"}]}' WHERE tenant_id=$1 AND id='lc'`, tid)
	for _, node := range []string{"side", "third"} {
		exec(`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,status,applied,succeeded,failed)
			VALUES($1,$2,'lc',$3,'output_limit','rule',$1,'Keep it short.','active',5,5,0)`, "lesson-"+node, tid, node)
	}
	cites := func() string {
		t.Helper()
		var evidence string
		if err := h.db.QueryRow(ctx, "SELECT evidence::text FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id IS NULL AND scope->>'templateId'='backend'", tid).Scan(&evidence); err != nil {
			t.Fatal(err)
		}
		return evidence
	}
	if found, err = h.a.helpfulLessons(ctx, tid); err != nil || len(found) != 2 {
		t.Fatalf("the side and third lessons read: %+v %v", found, err)
	}
	exec(`UPDATE canvas_lessons SET evidence='[{"changed":true}]' WHERE tenant_id=$1 AND id IN ('lesson-side','lesson-third')`, tid)
	if given, err := h.a.giveHelpfulLessons(ctx, cycle, found); err != nil || given != 0 || strings.Contains(cites(), "lesson-side") {
		t.Fatalf("lessons whose evidence changed meanwhile: given %d %v, the template's lesson cites %s", given, err, cites())
	}
	if found, err = h.a.helpfulLessons(ctx, tid); err != nil || len(found) != 2 {
		t.Fatalf("the lessons read again: %+v %v", found, err)
	}
	if given, err := h.a.giveHelpfulLessons(ctx, cycle, found); err != nil || given != 1 || !strings.Contains(cites(), "lesson-side") {
		t.Fatalf("the lessons as they are now: given %d %v, the template's lesson cites %s", given, err, cites())
	}
}

// A run cannot bear out a text it was given, in any note: a copy on probation of a note the run was given, merged away
// since, is not borne out by the run writing it again; a later run not given it bears it out.
func TestPostgresARunBearsOutNoTextItWasGiven(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, user := h.register(t, "guard-told@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ct',$1,'Told')", tid)
	notes := cycleNotes{t, h, tid}
	const text, other, named = "Captions stay under ten words", "Buttons use sentence case", "Forms end with one button"
	shared, waiting := notes.add("", text, ""), notes.probation("ct", text)
	// And a note of the canvas on probation the model names to confirm, whose text the run was given by another note.
	sharedNamed, confirmed := notes.add("", named, ""), notes.probation("ct", named)
	// And a note of the canvas archived unused, whose text the run was given by another note of the workspace.
	sharedOther, unused := notes.add("", other, ""), notes.add("ct", other, "")
	exec("UPDATE memory_items SET status='archived',archived_reason='unused',evidence=1 WHERE tenant_id=$1 AND id=$2", tid, unused)
	exec("UPDATE memory_items SET status='archived',archived_reason='merged' WHERE tenant_id=$1 AND id=$2", tid, shared)
	gid := "gt-" + randomID()
	exec(`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status)
		VALUES($1,$2,'ct',$3,$1,'h',1,'{"nodes":[{"id":"done","kind":"session"}]}','["done"]','completed')`, gid, tid, user)
	item := func(id, title string) string {
		return `{"id":"` + id + `","scope":"workspace","kind":"preference","title":"` + title + `","contentHash":"` + memoryContentHash(title, "") + `"}`
	}
	items := `[` + item(shared, text) + `,` + item(sharedOther, other) + `,` + item(sharedNamed, named) + `]`
	exec("INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,output,execution_snapshot,given_notes) VALUES($1,$2,'done',0,'done','Done.',$3,$4)", tid, gid,
		`{"memory":{"items":`+items+`}}`, items)
	exec("INSERT INTO run_distillations(tenant_id,graph_id,canvas_id,state) VALUES($1,$2,'ct','queued')", tid, gid)
	exec("UPDATE memory_items SET status='archived',archived_reason='merged' WHERE tenant_id=$1 AND id=$2", tid, sharedOther)
	if _, err := h.a.keepRunNotes(ctx, tid, "ct", gid, []memoryDistillNote{{Op: "add", Kind: "preference", Title: text}, {Op: "add", Kind: "preference", Title: other},
		{Op: "confirm", ID: confirmed}}); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := notes.state(waiting); status != "proposed" {
		t.Fatalf("a run given the text bore out its copy on probation: %s", status)
	}
	if status, _, _ := notes.state(unused); status != "archived" {
		t.Fatalf("a run given the text brought back its copy archived unused: %s", status)
	}
	if status, _, _ := notes.state(confirmed); status != "proposed" {
		t.Fatalf("a run given the text confirmed a note of it it was not given: %s", status)
	}
	keepNotesOf(t, h, tid, "ct", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: text})
	if status, _, _ := notes.state(waiting); status != "active" {
		t.Fatalf("a run not given the text did not bear it out: %s", status)
	}
}

// The guards of round 9: what bears a note out, what a run told something may write, and what a person's deletion
// holds back.

// A note's terms are read in their compatibility form and without a plural's s, crudely (class, status and analysis
// keep theirs, and a word of three letters is left as it is); a no is taken out of Chinese with nothing in its place.
func TestNoteTermsReadPluralsAndWideLetters(t *testing.T) {
	for text, want := range map[string][]string{
		"Headlines use serif fonts":  {"font", "headlin", "serif"},
		"Ｆｏｏｔｅｒｓ ｌｉｓｔ ｌｏｇｏｓ":         {"footer", "list", "logo"},
		"Class status analysis bus":  {"analysis", "bus", "class", "status"},
		"Makes etc":                  nil,
		withoutNegations("标题不用衬线字体"): {"字体", "用衬", "线字", "衬线", "题用"},
	} {
		if got := slices.Sorted(maps.Keys(noteTerms(text))); !slices.Equal(got, want) {
			t.Fatalf("the terms of %q: %v, want %v", text, got, want)
		}
	}
	for plural, one := range map[string]string{"boxes": "box", "replies": "reply", "sizes": "size", "caches": "cache", "cookies": "cookie",
		"categories": "category", "classes": "class", "statuses": "status", "buses": "bus", "ties": "tie", "keys": "key", "styles": "style",
		"headlines": "headline", "fonts": "font", "canvases": "canvas", "lenses": "lens", "aliases": "alias", "glasses": "glass"} {
		if got, want := noteTerms(plural), noteTerms(one); len(want) != 1 || !maps.Equal(got, want) {
			t.Errorf("%q read as %v, %q as %v", plural, slices.Sorted(maps.Keys(got)), one, slices.Sorted(maps.Keys(want)))
		}
	}
}

// A note on probation is borne out only by a run of every node of its canvas: one of some of its nodes (its scope), or
// one that took a node's earlier output, bears nothing out.
func TestPostgresOnlyARunOfTheWholeCanvasBearsANoteOut(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, user := h.register(t, "guard-whole@example.test")
	if _, err := h.db.Exec(context.Background(), "INSERT INTO canvases(id,tenant_id,name) VALUES('cw',$1,'Whole')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	waiting := notes.probation("cw", "Captions stay under ten words")
	note := memoryDistillNote{Op: "add", Kind: "style", Title: "Captions stay under ten words"}
	for run, name := range map[int]string{scopedRun: "of some of its nodes", cachedNodeRun: "that took a node's earlier output"} {
		keepNotesAfter(t, h, tid, "cw", user, run, nil, note)
		if status, _, _ := notes.state(waiting); status != "proposed" {
			t.Fatalf("a run %s bore a note out: %s", name, status)
		}
	}
	keepNotesAfter(t, h, tid, "cw", user, wholeCanvasRun, nil, note)
	if status, _, _ := notes.state(waiting); status != "active" {
		t.Fatalf("a run of the whole canvas did not bear the note out: %s", status)
	}
}

// A run given a note, a person's or AwwO's, writes no note that says what it says, in its words or most of them, nor
// bears one out, even once the note it was given is gone; it may write one that says the opposite (a correction), and
// one that replaces the very note it was given. A run not given it writes it.
func TestPostgresARunToldANoteWritesNothingThatSaysIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-told-alike@example.test")
	if _, err := h.db.Exec(context.Background(), "INSERT INTO canvases(id,tenant_id,name) VALUES('cg',$1,'Given')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	given := func(id, title string, awwo bool) memoryNote {
		note := memoryNote{ID: id, Scope: "canvas", Kind: "preference", Title: title, ContentHash: memoryContentHash(title, "")}
		if awwo {
			note.KeptBy = "awwo"
		}
		return note
	}
	const serif, caption = "Headlines use serif fonts", "Captions use bold weight"
	person := given(notes.add("cg", serif, user), serif, false)
	alike := notes.probation("cg", "Headlines are set in serif fonts")
	keep := func(given []memoryNote, note memoryDistillNote) int {
		t.Helper()
		return keepNotesAfter(t, h, tid, "cg", user, wholeCanvasRun, given, note)
	}
	if written := keep([]memoryNote{person}, memoryDistillNote{Op: "add", Kind: "preference", Title: "Headline text is set in serif fonts"}); written != 0 {
		t.Fatal("a run given a person's note wrote one saying the same")
	}
	keep([]memoryNote{person}, memoryDistillNote{Op: "confirm", ID: alike})
	if status, _, _ := notes.state(alike); status != "proposed" {
		t.Fatalf("a run given a person's note bore out one saying the same: %s", status)
	}
	if written := keep([]memoryNote{person}, memoryDistillNote{Op: "add", Kind: "preference", Title: "Headlines never use serif fonts"}); written != 1 {
		t.Fatal("a run given a note did not write its correction")
	}
	// A note of one word given (too few to say the same in other words), since deleted: its very words are held back.
	single := given(notes.add("cg", "Serifs", user), "Serifs", false)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+single.ID, nil, 200)
	if written := keep([]memoryNote{single}, memoryDistillNote{Op: "add", Kind: "preference", Title: "Serifs"}); written != 0 {
		t.Fatal("a run given a note of one word wrote it")
	}
	// AwwO's note given: a replacement of it in most of its words is written, the same words added are not.
	bold := notes.add("cg", caption, "")
	if written := keep([]memoryNote{given(bold, caption, true)}, memoryDistillNote{Op: "add", Kind: "style", Title: "Captions use bold weight in italics"}); written != 0 {
		t.Fatal("a run given AwwO's note added one saying the same")
	}
	if written := keep([]memoryNote{given(bold, caption, true)}, memoryDistillNote{Op: "replace", ID: bold, Kind: "style", Title: "Captions use bold weight in italics"}); written != 1 {
		t.Fatal("a run given AwwO's note did not write the note to replace it")
	}
	// One that only restates it (its words and no more, nothing in the other sense) corrects nothing: not written.
	if written := keep([]memoryNote{given(bold, caption, true)}, memoryDistillNote{Op: "replace", ID: bold, Kind: "style", Title: "Use bold weight for captions"}); written != 0 {
		t.Fatal("a run given AwwO's note wrote a replacement that only restates it")
	}
	// The person's note deleted (which leaves nothing of it): a run given it still writes nothing that says it, a run not
	// given it does.
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+person.ID, nil, 200)
	if written := keep([]memoryNote{person}, memoryDistillNote{Op: "add", Kind: "preference", Title: serif}); written != 0 {
		t.Fatal("a run given a note since deleted wrote it")
	}
	if written := keep(nil, memoryDistillNote{Op: "add", Kind: "preference", Title: "Headline text is set in serif fonts"}); written != 1 {
		t.Fatal("a run not given the note did not write it")
	}
}

// A fact or a decision AwwO kept that a person deleted holds back what is said of the same: in a third of its words
// (a preference's holds back only most of them), and saying it is not so (a preference's correction is written).
func TestPostgresADeletedFactHoldsBackWhatIsSaidOfIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-fact@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cf',$1,'Facts'),('cp',$1,'Preferences')", tid)
	notes := cycleNotes{t, h, tid}
	for _, canvasID := range []string{"cf", "cp"} {
		for _, title := range []string{"客户王磊下周三来访", "王磊负责首页设计"} {
			id := notes.add(canvasID, title, "")
			if canvasID == "cf" {
				exec("UPDATE memory_items SET kind='fact' WHERE tenant_id=$1 AND id=$2", tid, id)
			}
			h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+id, nil, 200)
		}
	}
	var facts int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cf' AND kind='fact'", tid).Scan(&facts); err != nil || facts != 2 {
		t.Fatalf("the deleted facts' dismissals: %d %v", facts, err)
	}
	for _, title := range []string{"客户王磊改到下周四来访", "王磊不负责首页设计"} {
		if written := keepNotesOf(t, h, tid, "cf", user, false, memoryDistillNote{Op: "add", Kind: "fact", Title: title}); written != 0 {
			t.Fatalf("%q was written after a fact saying of the same was deleted", title)
		}
		if written := keepNotesOf(t, h, tid, "cp", user, false, memoryDistillNote{Op: "add", Kind: "fact", Title: title}); written != 1 {
			t.Fatalf("%q was not written after a preference saying of the same was deleted", title)
		}
	}
}

// A note in the very words of one a person deleted is held back however many dismissals came after it; one of AwwO's in
// those words in use is not given.
func TestPostgresADismissalInTheVeryWordsHoldsPastTheNewest(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-newest@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cx',$1,'Exact')", tid)
	notes := cycleNotes{t, h, tid}
	const text = "Invoices go out on the first working day"
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cx", text, ""), nil, 200)
	exec(`INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash,created_at) SELECT $1,'cx',md5(i::text),clock_timestamp()+i*interval '1 second'
		FROM generate_series(1,$2::int) i`, tid, memoryDismissalsRead+1)
	if written := keepNotesOf(t, h, tid, "cx", user, false, memoryDistillNote{Op: "add", Kind: "fact", Title: text}); written != 0 {
		t.Fatal("a note in the very words of one deleted before the newest dismissals was written")
	}
	notes.add("cx", text, "")
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	memory, err := h.a.freezeMemoryContext(ctx, tx, tid, "cx", "invoices working day", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(memoryItemsOf(memory)) != 0 {
		t.Fatal("a note in the very words of one deleted before the newest dismissals was given")
	}
}

// A person who deletes a note of their own text sets aside the notes AwwO keeps that say what it said where it was given:
// in its canvas, in use or on probation, in its words or most of them (a correction, a note of another canvas and
// another note stay); for a note of the whole workspace, in every canvas. Nothing of their text is kept.
func TestPostgresDeletingAPersonsNoteSetsAsideAwwOsLikes(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-likes@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ca',$1,'A'),('cb',$1,'B')", tid)
	notes := cycleNotes{t, h, tid}
	want := func(id, wantStatus, wantReason string) {
		t.Helper()
		if status, reason, _ := notes.state(id); status != wantStatus || reason != wantReason {
			t.Fatalf("note %s: %s %q, want %s %q", id, status, reason, wantStatus, wantReason)
		}
	}
	const serif = "Headlines use serif fonts"
	theirs := notes.add("ca", serif, user)
	same, alike, waiting := notes.add("ca", serif, ""), notes.add("ca", "Headline text uses serif fonts", ""), notes.probation("ca", "Headlines are set in serif fonts")
	other, correction, elsewhere := notes.add("ca", "Buttons are blue", ""), notes.add("ca", "Headlines never use serif fonts", ""), notes.add("cb", serif, "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+theirs, nil, 200)
	for _, id := range []string{same, alike, waiting} {
		want(id, "archived", "restated")
	}
	for _, id := range []string{other, correction, elsewhere} {
		want(id, "active", "")
	}
	// The whole workspace's note: AwwO's notes of every canvas that say the same.
	footers := notes.add("", "Footers carry the brand mark", user)
	inA, inB := notes.add("ca", "Footers carry the brand mark", ""), notes.add("cb", "Footer carries the brand marks", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+footers, nil, 200)
	want(inA, "archived", "restated")
	want(inB, "archived", "restated")
	var dismissals int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&dismissals); err != nil || dismissals != 0 {
		t.Fatalf("a person's deleted notes left %d dismissals: %v", dismissals, err)
	}
}

// A person's note is given whatever a person deleted: only AwwO's notes are held to dismissals.
func TestPostgresAPersonsNoteIsGivenWhateverWasDeleted(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-people-given@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cq',$1,'People')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	const text = "Pages use a dark theme"
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cq", text, ""), nil, 200)
	theirs, awwos := notes.add("cq", text, user), notes.add("cq", "Pages use the dark theme", "")
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	memory, err := h.a.freezeMemoryContext(ctx, tx, tid, "cq", "dark theme pages", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, item := range memoryItemsOf(memory) {
		ids[item.ID] = true
	}
	if !ids[theirs] || ids[awwos] {
		t.Fatalf("given %v: the person's %s, not AwwO's %s", ids, theirs, awwos)
	}
}

// The guards of round 10: what a run told a note of several rules may write, what a deletion sets aside and keeps,
// what a replacement that may come back protects, and what can be taken back.

// Keys split into their words at an acronym too, and are read as a configuration's keys; a word of prose is not one.
func TestKeyNamesSplitAtAcronyms(t *testing.T) {
	for key, want := range map[string]string{"APIToken": "api token", "JWTSecret": "jwt secret", "adminPwdMax": "admin pwd max", "MYSQL_ROOT_PASSWORD": "mysql root password"} {
		if got := strings.Join(keySegments(key), " "); got != want {
			t.Errorf("the parts of %q: %q, want %q", key, got, want)
		}
	}
	for key, want := range map[string]bool{"APIToken": true, "adminPwd": true, "smtp.pass": true, "Password": false, "PIN": false} {
		if configKey(key) != want {
			t.Errorf("%q a key of a configuration: %v, want %v", key, !want, want)
		}
	}
}

// Notes are compared in their words as their compatibility form reads them, negations too, and a common word stays
// common in the plural; a note says what a clause of another says in its words, and its denial is a correction.
func TestNotesAreComparedByTheirWordsAndClauses(t *testing.T) {
	if wide := "Headlines ｗｉｔｈｏｕｔ serif fonts"; !noteNegated(wide) || noteTerms(withoutNegations(wide))["without"] {
		t.Errorf("a negation in wide letters: negated %v, its terms without it %v", noteNegated(wide), noteTerms(withoutNegations(wide)))
	}
	if got := slices.Sorted(maps.Keys(noteTerms("Keeps captions short"))); !slices.Equal(got, []string{"caption", "short"}) {
		t.Errorf("the terms of a note with a common word in the plural: %v", got)
	}
	said := saidOf("", "Headlines use Fraunces; body text uses Inter", "")
	for text, want := range map[string]bool{"Headlines use Fraunces": true, "Body text uses Inter": true, "Headlines never use Fraunces": false, "Captions use Inter at 12px": false,
		"Headlines use Fraunces; body copy stays in the default font": true} {
		if got := said.says(saidOf("", text, "")); got != want {
			t.Errorf("%q says a clause of the guideline: %v, want %v", text, got, want)
		}
	}
	// A note that only mentions a clause's words among words of its own says nothing of it; one that denies one clause and
	// repeats another says the other; one clause holding the whole of a note says it, whatever else it says; a fragment
	// of a note mostly in its words says it; a rule of one word is said by that word alone, not in the opposite sense. A
	// title is read whole, its sentences together, as a sentence of a body is read with it, as caution would have it.
	for _, c := range []struct {
		note, text string
		want       bool
	}{
		{"负责人：王小明，李小红", "李小红负责审核文案", false},
		{"Buttons are teal", "Buttons use the brand font; teal is reserved for links", true},
		{"Headlines use Fraunces. Bold marks the key figures. Captions sit under images.", "Headlines are bold", false},
		{"Buttons are teal, links are coral", "Buttons are teal, links are not coral", true},
		{"Headlines use serif fonts", "Headline text is set in serif fonts", true},
		{"Headlines use serif fonts", "Captions use serif fonts", false},
		{"Bold marks the key figures", "Key figures sit in tables", false},
		{"Buttons are teal, links are coral, captions are grey", "Teal buttons with coral links and grey captions", true},
		{"Headlines use serif fonts", "Headline text, set in serif fonts", true},
		{"Headlines use Fraunces", "Headlines are set in Fraunces at a heavy weight", true},
		{"标题用衬线字体", "首页标题统一用衬线字体", true},
		{"Product pages show customer reviews beneath the gallery", "Show customer reviews", true},
		{"Always use Markdown", "Prefer Markdown", true},
		{"Always use Markdown", "Never use Markdown", false},
		{"Always use Markdown", "Markdown tables need headers", false},
		{"Buttons are teal", "Buttons are rounded; teal is reserved for links", true},
		{"Releases ship on Fridays", "Releases ship, not on Fridays", false},
		{"Use Go", "Prefer Go", true},
		{"Use Go", "Go to the settings page", false},
		{"Use JS for scripts", "Scripts in TS", false},
		// A clause of a rule joined to another by a comma, in English or Chinese, is held as a sentence is; an item of a
		// list is not a rule.
		{"Headlines use Fraunces, buttons are teal", "Headlines are set in Fraunces at a heavy weight", true},
		{"标题用衬线字体，按钮用圆角", "首页标题统一用衬线字体", true},
		{"标题用衬线字体、按钮用圆角", "首页标题统一用衬线字体", true},
		{"Teal, coral, grey", "Navy, coral", false},
		// A rule of one word is said by a whole note or a sentence of two terms that holds it, not by an item of a list.
		{"Always use Tailwind", "Pages are styled with Tailwind", true},
		{"Always use Tailwind", "Use Tailwind CSS", true},
		{"Always use Tailwind", "Tools: React, Tailwind, Vite", false},
		// A no said twice says yes, and a correction of it says the opposite; two denials are no yes.
		{"Always deploy with a review", "Never deploy without a review", true},
		{"Every image has alt text", "No image without alt text", true},
		{"Body text uses Inter", "Body text uses nothing but Inter", true},
		{"Never deploy without a review", "Never deploy with a review", false},
		{"Headlines use serif and italics", "Headlines never use serif and never use italics", true},
		{"Publish with review and approval", "Never publish without review and without approval", true},
		{"Never publish with review and approval", "Never publish without review and without approval", true},
		{"Headlines and buttons use serif", "Neither headlines nor buttons use serif", false},
		{"客户同意使用红色", "客户不同意使用红色", false},
		{"按钮既用阴影也用渐变", "按钮既不用阴影也不用渐变", false},
		{"No shadows or gradients", "No shadows & no gradients", true},
		{"No shadows & no gradients", "No shadows or gradients", true},
		// A clause in the very words of a clause of the note in the other sense lies within it saying nothing of it.
		{"用圆角，加阴影，不用渐变", "不用圆角，配色偏冷", false},
		// A plural in -es or -ies reads as its singular.
		{"Boxes have rounded corners", "Each box has rounded corners", true},
		{"Replies use Markdown", "Every reply uses Markdown", true},
		// A full stop before a closing quote ends a sentence.
		{`The tagline is "Made for makers." The hero shows it in Fraunces at 64 px, centred, over the product photo.`, `The tagline is "Made for makers"`, true},
	} {
		if got := saidOf("", c.note, "").says(saidOf("", c.text, "")); got != c.want {
			t.Errorf("%q says %q: %v, want %v", c.text, c.note, got, c.want)
		}
	}
	// A title is a sentence of its note: two notes that share one say the same, whatever their bodies say; a sentence of a
	// title and a body says what a note says, and what a sentence of one says, in other words around it, in Chinese too.
	for _, c := range []struct {
		title, body, otherTitle, otherBody string
		want                               bool
	}{
		{"Brand guidelines", "Headlines use Fraunces", "Brand guidelines", "Buttons are rounded", true},
		{"Pages are dark", "The team chose a dark theme for every page.", "Pages are dark", "Dark backgrounds on every page", true},
		{"Brand guidelines", "Headlines use Fraunces", "Headlines use Fraunces", "", true},
		{"Headlines use Fraunces", "", "Typography", "Headlines are set in Fraunces at a heavy weight. Body text stays in Inter.", true},
		{"Typography", "Headlines use Fraunces. Body text uses Inter.", "Headlines are set in Fraunces at a heavy weight", "", true},
		{"标题用衬线字体", "", "排版", "首页标题统一用衬线字体。正文用黑体。", true},
		{"Typography", "Headlines use Fraunces. Body text uses Inter.", "Captions", "Captions sit under images. Links are underlined.", false},
		{"Pages are dark", "The team chose a dark theme for every page.", "Dark pages", "", true},
		{"Captions", "Keep it short.", "Replies", "Keep it short.", false},
		{"Buttons are teal", "", "Style", "Buttons use the brand font; teal is reserved for links", false},
		{"Buttons are teal", "", "Style", "Buttons are rounded. Teal is reserved for links.", false},
		// A person's heading over a list holds AwwO's statement of an item of it, the list in lines too, one of more terms
		// than a word of the heading holds among them (the item read with its title), and a statement of several items lies
		// within a sentence of it read with its title; a list in lines under a title holds a note of three of its terms or
		// more; a title of one word holds a note of two terms at most that holds it, whatever the list (a rule of one word).
		{"Buttons", "Teal, rounded, larger on mobile", "Buttons are teal", "", true},
		{"Buttons", "Teal, rounded, larger on mobile", "Buttons are teal with a thick outline", "", true},
		{"Buttons", "Teal, rounded, larger on mobile", "Buttons are large", "", true},
		{"Buttons", "- Teal\n- Rounded\n- Larger on mobile", "Buttons are teal", "", true},
		{"Button style", "Teal, rounded corners, soft shadows. Larger on mobile.", "Buttons are teal and rounded", "", true},
		{"Buttons are teal and rounded", "", "Button style", "- Teal\n- Rounded corners\n- Soft shadows\n- Larger on mobile", true},
		{"Buttons are teal and rounded", "", "Buttons follow the brand kit", "- Teal\n- Rounded corners", true},
		{"Buttons", "Teal, rounded, larger on mobile", "Links are teal", "", false},
		// A list's item read with a title of more than a word, which a statement holds whole among words of its own; and
		// a statement of several items whatever else the other note's body says.
		{"Button style", "Teal, rounded, larger on mobile", "Button style: teal with a soft glow", "", true},
		{"Button style", "Teal, rounded corners, soft shadows. Larger on mobile.", "Buttons", "Buttons are teal and rounded. They glow softly on hover.", true},

		{"Reviews", "Product pages show customer reviews beneath the gallery with star ratings and verified badges", "Show star ratings", "", false},
		{"Button style", "Teal; rounded corners; soft shadows", "Buttons are teal and rounded", "", true},
		{"Buttons are teal, rounded, larger on mobile", "", "Buttons are rounded", "", true},
		{"Stack", "We build every page with Next.js and deploy on Vercel. Buttons are teal.", "Buttons are teal", "", true},
	} {
		if got := saidOf("", c.title, c.body).says(saidOf("", c.otherTitle, c.otherBody)); got != c.want {
			t.Errorf("%q / %q says %q / %q: %v, want %v", c.otherTitle, c.otherBody, c.title, c.body, got, c.want)
		}
	}
	// Numbers count as a note's terms do: a number that differs is a term not held, too many of a short rule's to say it,
	// one of a longer note's.
	for _, c := range []struct {
		note, text string
		want       bool
	}{
		{"Filler 2", "Filler 3", false},
		{"Captions stay under 12 words", "Captions stay under 20 words", true},
		{"Annual subscriptions cost 500 dollars", "Annual subscriptions cost 600 dollars", true},
		{"Profit margin is 5%", "Profit margin is 8%", false},
		{"Budget is 5000", "The budget is 5000 dollars a month", true},
		{"Margins are 3.5%", "Margins are 3.5% on mobile", true},
		{"Margins are 3.5%", "Margins are 5.3%", false},
		{"Headings are H2", "Headings are H3", false},
		{"Captions stay under 12 words", "Captions in cards stay under 12 words", true},
		{"Use 2 fonts, 3 colours", "Use 2 fonts", true},
		{"2026", "2026.", true},
	} {
		if got := saidOf("", c.note, "").says(saidOf("", c.text, "")); got != c.want {
			t.Errorf("%q says %q: %v, want %v", c.text, c.note, got, c.want)
		}
	}
	// A note's sentences part at its lines, its semicolons and a full stop that ends one, not one in a number or after an
	// item's number; its clauses at its commas, not one between digits; its numbers keep their points and commas, in wide
	// digits too.
	trimmed := func(pieces []string) []string {
		for i := range pieces {
			pieces[i] = strings.TrimSpace(pieces[i])
		}
		return pieces
	}
	if got := trimmed(noteSentences("Margins are 3.5% wide. Budget is 5000. Pages are dark\nSteps:\n1. Hero first\nCaptions stay short; footers too. 标题用衬线．按钮用圆角｡链接用珊瑚色")); !slices.Equal(got,
		[]string{"Margins are 3.5% wide", "Budget is 5000", "Pages are dark", "Steps:", "1. Hero first", "Captions stay short", "footers too", "标题用衬线", "按钮用圆角", "链接用珊瑚色"}) {
		t.Errorf("the sentences of a note: %q", got)
	}
	// An abbreviation's full stop ends no sentence; one before a closing quote or bracket does.
	for text, want := range map[string]int{"Headlines use a display serif, e.g. Fraunces, set heavy": 1, "Teal, coral, etc. Grey for captions": 1,
		`The tagline is "Made for makers." The hero shows it.`: 2, "Pages are dark (the brand's choice.) Captions stay short.": 2, "Sizes: 12 vs. 14": 1,
		"We build pages with Next.js. Buttons are teal.": 2, "Use plan B. Ship on Fridays.": 2, "Ph.D. holders review the copy": 1} {
		if got := noteSentences(text); len(got) != want {
			t.Errorf("the sentences of %q: %q, want %d", text, got, want)
		}
	}
	// Two parts read together say no where either does, yes twice where either does and neither says no, and are unsure
	// where either is.
	if bothNegations(1, 2) != 1 || bothNegations(2, 0) != 2 || bothNegations(0, 0) != 0 || bothNegations(0, 1) != 1 ||
		bothNegations(noesUnsure, 1) != noesUnsure || bothNegations(0, noesUnsure) != noesUnsure {
		t.Error("what two parts read together say by their noes")
	}
	// What a text says by its noes: read by its clauses and by its statements, unsure where the two differ.
	for text, want := range map[string]int{"Headlines use serif": 0, "Headlines never use serif": 1, "Never deploy without a review": 2,
		"Neither headlines nor buttons use serif": 1, "Body text uses nothing but Inter": 0, "Headlines never use serif, buttons never use shadows": noesUnsure,
		"Headlines never use serif. Buttons never use shadows.": 1, "Never publish without review, without approval": noesUnsure,
		"We didn't ship on Fridays": 1, "Room No. 5 holds the archive": 0, "Room No. 5 holds no archive": 1,
		"Never publish without review and without approval": noesUnsure, "Don't use serif and don't use shadows": noesUnsure,
		"Not serif but sans": 1, "不能不用衬线字体": 2, "标题不用衬线字体": 1, "标题不用衬线字体而按钮不用圆角": noesUnsure, "客户不同意使用红色": 1,
		"按钮既不用阴影也不用渐变": 1, "按钮不用阴影，也不用渐变": 1, "按钮也不用阴影": 1, "页面没有阴影也没有渐变": 1, "别用阴影也别用渐变": 1,
		"客户不同意红色也不同意蓝色": 1, "No shadows & no gradients": noesUnsure, "No shadows / no gradients": noesUnsure, "Rock & roll never dies": 1} {
		if got := noteNegations(text); got != want {
			t.Errorf("what %q says by its noes: %d, want %d", text, got, want)
		}
	}
	if got := trimmed(noteClauses(noteSentences("Teal､coral﹐grey")[0])); !slices.Equal(got, []string{"Teal", "coral", "grey"}) {
		t.Errorf("the clauses of a sentence in wide or small commas: %q", got)
	}
	if got := trimmed(noteClauses("Teal, coral and 1,000 grey、蓝色")); !slices.Equal(got, []string{"Teal", "coral and 1,000 grey", "蓝色"}) {
		t.Errorf("the clauses of a sentence: %q", got)
	}
	if got := slices.Sorted(maps.Keys(noteNumbers("Use 2 accent colours, 1,000 px, 3.5% and ２ more"))); !slices.Equal(got, []string{"1000", "2", "3.5"}) {
		t.Errorf("the numbers of a note: %q", got)
	}
	// Two notes are held to each other by a number they share where they share no word, as by a word.
	if !heldTo(saidOf("", "2026", ""), saidOf("", "2026.", ""), false) || heldTo(saidOf("", "2026", ""), saidOf("", "2027.", ""), false) {
		t.Error("notes of a number alone are not held to each other by it")
	}
	if terms := noteTerms("Filler 2 at 3.5% for H2, 5000 of them"); terms["2"] || terms["3"] || terms["5"] || terms["5000"] || !terms["h2"] || !terms["filler"] {
		t.Errorf("the terms of a note with numbers: %v", terms)
	}
}

// The tidy merges no two notes with numbers that are not the very same in the same order, and counts numbers as words
// otherwise; nor two that differ in their marks of a no or in what they say by them, in doubt; nor two of several clauses
// whose clauses do not say the same the same way.
func TestTheTidyHoldsNotesToTheirNumbers(t *testing.T) {
	note := func(text string) tidyPoolNote {
		n := tidyPoolNoteOf(text, "")
		n.kind = "style"
		return n
	}
	for _, c := range []struct {
		keep, other string
		want        bool
	}{
		{"Filler 2", "Filler 3", false},
		{"Captions stay under 12 words", "Captions stay under 20 words", false},
		{"Budget is 5000", "Budget of 5000", true},
		{"Budget is 5000", "Budget review in March", false},
		{"Cards use 2 columns and 4 px gaps", "Cards use 2 columns and 8 px gaps", false},
		{"Cards use 2 columns and 4 px gaps", "Cards use 4 columns and 2 px gaps", false},
		{"Budget is 5,000", "Budget of 5000", true},
		{"Use 2 accent colours", "Two accent colours", false},
		{"Captions stay short", "Short captions", true},
		{"Sizes are 12, 14 and 16", "Sizes are 12,14,16", true},
		{"Headlines are never bold; body text is", "Body text is never bold; headlines are", false},
		{"Headlines are never bold", "Headlines are bold; body text is never bold", false},
		{"标题用蓝色，按钮用橙色", "标题用橙色，按钮用蓝色", false},
		{"配色鲜艳", "配色不过于鲜艳", false},
		{"客户同意使用红色", "客户不同意使用红色", false},
		{"Body text uses nothing but Inter", "Body text uses Inter", false},
		{"Cards have rounded corners, soft shadows", "Cards use rounded corners and soft shadows", true},
		{"Headlines never use serif", "Headlines don't use serif", true},
		{"Headlines never use serif", "Headlines use nothing but serif", false},
		{"Headlines are bold and captions are italic", "Headlines are italic and captions are bold", false},
		{"标题加粗而说明用斜体", "标题用斜体而说明加粗", false},
		{"Headlines and buttons use serif", "Buttons and headlines use serif", true},
		{"Temperature is -5 degrees", "Temperature is 5 degrees", false},
		{"Headlines are never bold and never italic", "Headlines are bold and italic", false},
	} {
		pool := map[string]tidyPoolNote{"keep": note(c.keep), "other": note(c.other)}
		if got := tidyNotesAlike(pool, []string{"keep", "other"}, "keep"); got != c.want {
			t.Errorf("%q alike %q: %v, want %v", c.other, c.keep, got, c.want)
		}
	}
	// Under a title of no word, the bodies' statements are still held each to one of the other's.
	for _, c := range []struct {
		keep, other string
		want        bool
	}{
		{"Headlines are bold and captions are italic.", "Headlines are italic and captions are bold.", false},
		{"Headlines are bold and captions are italic.", "Headlines are bold, and captions are italic.", true},
	} {
		keep, other := tidyPoolNoteOf("Page", c.keep), tidyPoolNoteOf("Page", c.other)
		keep.kind, other.kind = "style", "style"
		if got := tidyNotesAlike(map[string]tidyPoolNote{"keep": keep, "other": other}, []string{"keep", "other"}, "keep"); got != c.want {
			t.Errorf("%q alike %q under a title of no word: %v, want %v", c.other, c.keep, got, c.want)
		}
	}
}

// A note written to take another's place that only restates it corrects nothing: its words all the other's, the very
// same numbers in the same order, the same said by its noes, nothing in the other sense.
func TestAReplacementThatRestatesItsNoteCorrectsNothing(t *testing.T) {
	for _, c := range []struct {
		old, replacement string
		restates         bool
	}{
		{"Headlines use serif fonts", "Use serif fonts for headlines", true},
		{"Headlines use serif fonts", "Headlines use serif", true},
		{"Headlines never use serif fonts", "Headlines don't use serif fonts", true},
		{"Never publish without review and without approval", "Never publish without review or approval", true},
		{"Headlines use serif fonts", "Headlines never use serif fonts", false},
		{"Headlines use serif fonts", "Headlines never use serif", false},
		{"Headlines use serif fonts", "Headlines use serif fonts on mobile too", false},
		{"Cards use 2 columns", "Cards use 3 columns", false},
		{"Cards use 2 columns and 8 px gaps", "Cards use 8 columns and 2 px gaps", false},
		{"Headlines use serif. Captions never use italics.", "Headlines never use serif. Captions use italics.", false},
	} {
		got := restates(saidOf("", c.old, ""), noteNumberList(c.old), saidOf("", c.replacement, ""), noteNumberList(c.replacement))
		if got != c.restates {
			t.Errorf("%q restates %q: %v, want %v", c.replacement, c.old, got, c.restates)
		}
	}
}

// A run given a person's note of several rules writes no note that says one of them, alone or with words of its own, and
// may write one that says the opposite of one; deleting the person's note sets aside AwwO's note that says one.
func TestPostgresARunToldAClauseOfANoteWritesNothingThatSaysIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-clause@example.test")
	if _, err := h.db.Exec(context.Background(), "INSERT INTO canvases(id,tenant_id,name) VALUES('cq',$1,'Clauses')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	const guideline = "Headlines use Fraunces; body text uses Inter"
	person := memoryNote{ID: notes.add("cq", guideline, user), Scope: "canvas", Kind: "style", Title: guideline, ContentHash: memoryContentHash(guideline, "")}
	for title, want := range map[string]int{"Headlines use Fraunces": 0, "Headlines use Fraunces; body copy stays in the default font": 0, "Headlines never use Fraunces": 1} {
		if written := keepNotesAfter(t, h, tid, "cq", user, wholeCanvasRun, []memoryNote{person}, memoryDistillNote{Op: "add", Kind: "style", Title: title}); written != want {
			t.Fatalf("%q from a run given the guideline: written %d, want %d", title, written, want)
		}
	}
	echo := notes.add("cq", "Headlines are set in Fraunces", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+person.ID, nil, 200)
	if status, reason, _ := notes.state(echo); status != "archived" || reason != "restated" {
		t.Fatalf("AwwO's note saying a clause of a deleted guideline: %s %q", status, reason)
	}
}

// A fact a person deleted holds back a fact that says the same, in a third of its words and half of the new one's, not
// a note of another kind in those words, nor a fact that shares only a couple of its words and few of its own.
func TestPostgresADeletedFactHoldsBackOnlyFactsThatSayIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-fact-kind@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cs',$1,'Invoices'),('ct',$1,'Reports')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	for _, title := range []string{"Invoices go out on the first working day", "Invoices go out on the last working day of each month"} {
		scope := "cs"
		if strings.Contains(title, "month") {
			scope = ""
		}
		fact := notes.add(scope, title, "")
		if _, err := h.db.Exec(ctx, "UPDATE memory_items SET kind='fact' WHERE tenant_id=$1 AND id=$2", tid, fact); err != nil {
			t.Fatal(err)
		}
		h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+fact, nil, 200)
	}
	for _, note := range []struct {
		canvasID, kind, title string
		want                  int
	}{{"cs", "preference", "Reports are due on the first day of every month", 1}, {"cs", "fact", "Reports are due on the first day of the month", 1},
		{"cs", "fact", "Invoices go out on the second working day", 0}, {"cs", "preference", "Reports go out on the last day of the quarter", 1},
		{"ct", "fact", "Reports go out on the last day of the quarter", 0}, {"ct", "fact", "Reports close on the last day", 1}} {
		if written := keepNotesOf(t, h, tid, note.canvasID, user, false, memoryDistillNote{Op: "add", Kind: note.kind, Title: note.title}); written != note.want {
			t.Fatalf("a %s %q after facts were deleted: written %d, want %d", note.kind, note.title, written, note.want)
		}
	}
}

// A note archived unused that a run writes again as the replacement of another is held to what that run was given by the
// note it was written to replace before: a rewording of what the run was told does not come back, nor archives that note.
func TestPostgresARevivalIsHeldToTheNoteItReplaces(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, user := h.register(t, "guard-revive@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cv',$1,'Revive')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	old, other := notes.add("cv", "Headlines use serif fonts", ""), notes.add("cv", "Pages use a light theme", "")
	back := notes.add("cv", "Headline text uses serif fonts", "")
	if _, err := h.db.Exec(ctx, "UPDATE memory_items SET status='archived',archived_reason='unused',evidence=1,replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, back, other); err != nil {
		t.Fatal(err)
	}
	given := []memoryNote{{ID: old, Scope: "canvas", Kind: "preference", Title: "Headlines use serif fonts", ContentHash: memoryContentHash("Headlines use serif fonts", ""), KeptBy: "awwo"}}
	keepNotesAfter(t, h, tid, "cv", user, wholeCanvasRun, given, memoryDistillNote{Op: "replace", ID: old, Kind: "preference", Title: "Headline text uses serif fonts"})
	if status, _, _ := notes.state(back); status != "archived" {
		t.Fatalf("a rewording of what the run was told came back: %s", status)
	}
	if status, _, _ := notes.state(other); status != "active" {
		t.Fatalf("the note it was written to replace before was archived: %s", status)
	}
}

// Deleting a person's note sets aside the notes AwwO keeps that say the same where it was given: one of the whole
// workspace no longer goes to that canvas (another canvas still gets it); one kept apart, one a tidy archived and one
// archived unused are archived as out of date; a person's own note stays. Deleting a note of AwwO's archives its
// rewordings too.
func TestPostgresADeletionSetsAsideEveryEchoWhereTheNoteWasGiven(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-echoes@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ce',$1,'Echoes'),('cf',$1,'Elsewhere')", tid)
	notes := cycleNotes{t, h, tid}
	want := func(id, wantStatus, wantReason string) {
		t.Helper()
		if status, reason, _ := notes.state(id); status != wantStatus || reason != wantReason {
			t.Fatalf("note %s: %s %q, want %s %q", id, status, reason, wantStatus, wantReason)
		}
	}
	const serif = "Headlines use serif fonts"
	theirs, workspace := notes.add("ce", serif, user), notes.add("", serif, "")
	apart, tidied, unused := notes.add("ce", "Headline text uses serif fonts", ""), notes.add("ce", "Headlines are set in serif fonts", ""), notes.add("ce", "Headlines take serif fonts", "")
	persons := notes.add("ce", "Serif fonts for headlines", user)
	exec("UPDATE memory_items SET kept_apart=true WHERE tenant_id=$1 AND id=$2", tid, apart)
	exec("UPDATE memory_items SET status='archived',archived_reason='tidied' WHERE tenant_id=$1 AND id=$2", tid, tidied)
	exec("UPDATE memory_items SET status='archived',archived_reason='unused',evidence=1 WHERE tenant_id=$1 AND id=$2", tid, unused)
	if got := h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+theirs, nil, 200); got["setAside"] != float64(3) || got["heldBack"] != float64(1) {
		t.Fatalf("the deletion said it archived %v notes and held back %v, want 3 and 1", got["setAside"], got["heldBack"])
	}
	for _, id := range []string{apart, tidied, unused} {
		want(id, "archived", "restated")
	}
	want(persons, "active", "")
	want(workspace, "active", "")
	given := func(canvasID string) bool {
		t.Helper()
		tx, err := h.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		memory, err := h.a.freezeMemoryContext(ctx, tx, tid, canvasID, "headlines serif fonts", true, nil)
		if err != nil {
			t.Fatal(err)
		}
		return slices.ContainsFunc(memoryItemsOf(memory), func(n memoryNote) bool { return n.ID == workspace })
	}
	if given("ce") || !given("cf") {
		t.Fatalf("the workspace's echo given where the person deleted their note: %v; elsewhere: %v", given("ce"), given("cf"))
	}
	// A note of AwwO's a person deletes, or corrects: its rewording goes too.
	captions, reworded := notes.add("cf", "Captions stay under ten words", ""), notes.add("cf", "Caption text stays under ten words", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+captions, nil, 200)
	want(reworded, "archived", "outdated")
	corners, rounded := notes.add("cf", "Buttons have rounded corners", ""), notes.add("cf", "Button corners stay rounded", "")
	note := listedNote(t, h, c, tid, "cf", corners)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+corners, map[string]any{"version": note["version"], "title": "Buttons have square corners"}, 200)
	want(rounded, "archived", "outdated")
}

// The dismissal of a note of the whole workspace that held a canvas's words goes with the last of those canvases, and one
// of a note that held none stays; the same text deleted again counts as deleted anew, and as a fact once it was one.
func TestPostgresADismissalOfACanvassWordsGoesWithTheCanvas(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-dismissal-words@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cw1',$1,'Words'),('cw2',$1,'Other')", tid)
	notes := cycleNotes{t, h, tid}
	held, plain := notes.add("", "Footers carry the brand mark", ""), notes.add("", "Tables use zebra stripes", "")
	exec("UPDATE memory_items SET origin='evolution' WHERE tenant_id=$1 AND id=$2", tid, held)
	exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'cw1',true)", tid, held)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+held, nil, 200)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+plain, nil, 200)
	workspaceDismissals := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id IS NULL", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := workspaceDismissals(); n != 2 {
		t.Fatalf("the workspace's dismissals: %d", n)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cw1", nil, 204)
	if n := workspaceDismissals(); n != 1 {
		t.Fatalf("the workspace's dismissals once the canvas whose words one held is deleted: %d", n)
	}
	// Deleted again, a text is dismissed anew, as a fact once it was one.
	dismissal := func() (kind string, at time.Time) {
		t.Helper()
		if err := h.db.QueryRow(ctx, "SELECT kind,created_at FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cw2'", tid).Scan(&kind, &at); err != nil {
			t.Fatal(err)
		}
		return
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cw2", "Invoices are numbered by year", ""), nil, 200)
	_, before := dismissal()
	again := notes.add("cw2", "Invoices are numbered by year", "")
	exec("UPDATE memory_items SET kind='fact' WHERE tenant_id=$1 AND id=$2", tid, again)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+again, nil, 200)
	if kind, at := dismissal(); kind != "fact" || !at.After(before) {
		t.Fatalf("a text deleted again, as a fact: %s at %v, first at %v", kind, at, before)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cw2", "Invoices are numbered by year", ""), nil, 200)
	if kind, _ := dismissal(); kind != "fact" {
		t.Fatalf("a fact's dismissal deleted again as a preference: %s", kind)
	}
}

// A text dismissed again is dismissed in its words as they are read now; one dismissed in a note's own words stays when
// a canvas whose words it was dismissed in as well goes; and the correction of a note that held a canvas's words leaves
// a dismissal that goes with that canvas.
func TestPostgresADismissalAnewKeepsWhatHeldIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-dismissal-anew@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(sql, err)
		}
		return n
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cn',$1,'Anew'),('cv',$1,'Words'),('cu',$1,'Corrected')", tid)
	notes := cycleNotes{t, h, tid}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cn", "Captions sit under every image", ""), nil, 200)
	exec("UPDATE memory_item_dismissals SET terms='{}' WHERE tenant_id=$1 AND canvas_id='cn'", tid)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cn", "Captions sit under every image", ""), nil, 200)
	if n := count("SELECT cardinality(terms) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cn'", tid); n == 0 {
		t.Fatal("a text dismissed anew keeps the words it was read in before")
	}
	// The canvas's own note deleted, and the workspace's in the words of another canvas set aside there with it.
	workspace := notes.add("", "Quotes are set in italics", "")
	exec("UPDATE memory_items SET origin='evolution' WHERE tenant_id=$1 AND id=$2", tid, workspace)
	exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'cv',true)", tid, workspace)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cn", "Quotes are set in italics", ""), nil, 200)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cv", nil, 204)
	if n := count("SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cn'", tid); n != 2 {
		t.Fatalf("the canvas's dismissals once a canvas whose words one was also dismissed in is deleted: %d", n)
	}
	// A correction of the workspace's note in a canvas's words.
	links := notes.add("", "Links are underlined", "")
	exec("UPDATE memory_items SET origin='evolution' WHERE tenant_id=$1 AND id=$2", tid, links)
	exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'cu',true)", tid, links)
	note := listedNote(t, h, c, tid, "", links)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+links, map[string]any{"version": note["version"], "title": "Links are never underlined"}, 200)
	workspaceDismissals := func() int {
		t.Helper()
		return count("SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id IS NULL", tid)
	}
	if n := workspaceDismissals(); n != 1 {
		t.Fatalf("the workspace's dismissals after the correction: %d", n)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cu", nil, 204)
	if n := workspaceDismissals(); n != 0 {
		t.Fatalf("the dismissal of a corrected note in a canvas's words outlived the canvas: %d", n)
	}
}

// A note that a note written to replace it may yet take the place of (on probation, or archived unused) is not shown to a
// tidy, which could move it elsewhere while the replacement may still come back.
func TestPostgresANoteAReplacementMayYetTakeIsNotTidied(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, _ := h.register(t, "guard-replacing@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cr',$1,'Replacing')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	target := notes.add("cr", "Headlines are blue", "")
	for _, title := range []string{"Captions stay short", "Buttons use sentence case", "Pages are dark"} {
		notes.add("cr", title, "")
	}
	replacement := notes.add("cr", "Headlines are red", "")
	if _, err := h.db.Exec(ctx, "UPDATE memory_items SET status='archived',archived_reason='unused',evidence=1,replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, replacement, target); err != nil {
		t.Fatal(err)
	}
	_, pool, err := h.a.learningTidyBriefing(ctx, tid)
	if err != nil {
		t.Fatal(err)
	}
	if _, shown := pool[target]; shown || len(pool) != 3 {
		t.Fatalf("the tidy shown %d notes, the one a replacement may yet take among them: %v", len(pool), shown)
	}
}

// A change of a cycle whose archived notes a person changed since is not offered to be taken back.
func TestPostgresAChangeWhoseNotesChangedIsNotOfferedToBeTakenBack(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-undoable@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cu',$1,'Undo')", tid)
	notes := cycleNotes{t, h, tid}
	kept, merged := notes.add("cu", "Headlines are short", ""), notes.add("cu", "Headlines stay short", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='merged',successor_id=$3,version=2 WHERE tenant_id=$1 AND id=$2", tid, merged, kept)
	exec("INSERT INTO learning_cycles(id,tenant_id,state,finished_at) VALUES('cycle-undo',$1,'done',clock_timestamp())", tid)
	exec(`INSERT INTO learning_changes(id,tenant_id,cycle_id,kind,canvas_id,item_id,sources,before) VALUES('change-undo',$1,'cycle-undo','merge_notes','cu',$2,ARRAY[$3],$4)`,
		tid, kept, merged, jsonBytes(map[string]any{"created": false, "notes": []archivedNote{{ID: merged, Version: 1, Status: "active"}}}))
	if !changeUndoable(t, h, c, tid, "change-undo") {
		t.Fatal("a change left as it was is not offered to be taken back")
	}
	exec("UPDATE memory_items SET version=version+1,updated_by=$3 WHERE tenant_id=$1 AND id=$2", tid, merged, user)
	if changeUndoable(t, h, c, tid, "change-undo") {
		t.Fatal("a change whose archived note a person changed since is offered to be taken back")
	}
}

// changeUndoable is whether the learning cycles of workspace tid offer change id to be taken back.
func changeUndoable(t *testing.T, h *harness, c *http.Cookie, tid, id string) bool {
	t.Helper()
	for _, cycle := range h.request(t, c, "GET", "/tenants/"+tid+"/learning/cycles", nil, 200)["cycles"].([]any) {
		for _, change := range cycle.(map[string]any)["changes"].([]any) {
			if change.(map[string]any)["id"] == id {
				return change.(map[string]any)["undoable"] == true
			}
		}
	}
	t.Fatalf("change %s is not listed", id)
	return false
}

// A run whose node's conversation history comes from a run given a note was told that note too: it writes nothing that
// says it; a run without that history writes it.
func TestPostgresARunToldANoteInItsHistoryWritesNothingThatSaysIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-history@example.test")
	ctx := context.Background()
	cid, _, sid := h.fixture(t, c, tid)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	const font = "Headlines use Fraunces"
	notes := cycleNotes{t, h, tid}
	told := memoryNote{ID: notes.add(cid, font, user), Scope: "canvas", Kind: "style", Title: font, ContentHash: memoryContentHash(font, "")}
	exec(`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,given_notes,created_at)
		VALUES('history-run',$1,$2,'history-run','h','Draft the page','completed',$3,now()-interval '1 hour')`, tid, sid, givenNotesOf(&memoryContext{Items: []memoryNote{told}}))
	// More than a hundred runs since, given nothing: what the first was given reached them through the history all the same.
	exec(`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,given_notes,created_at)
		SELECT 'later-'||i,$1,$2,'later-'||i,'h','Go on','completed','[]'::jsonb,now()-interval '50 minutes'+i*interval '1 second' FROM generate_series(1,120) i`, tid, sid)
	run := func(session string) int {
		t.Helper()
		gid := "gh-" + randomID()
		exec(`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status)
			VALUES($1,$2,$3,$4,$1,'h',1,'{"nodes":[{"id":"node-a","kind":"session"}]}','["node-a"]','completed')`, gid, tid, cid, user)
		exec("INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,output,session_id) VALUES($1,$2,'node-a',0,'done','Done.',NULLIF($3,''))", tid, gid, session)
		exec("INSERT INTO run_distillations(tenant_id,graph_id,canvas_id,state) VALUES($1,$2,$3,'queued')", tid, gid, cid)
		written, err := h.a.keepRunNotes(ctx, tid, cid, gid, []memoryDistillNote{{Op: "add", Kind: "style", Title: "Headline text is set in Fraunces"}})
		if err != nil {
			t.Fatal(err)
		}
		return written
	}
	if written := run(sid); written != 0 {
		t.Fatal("a run whose history was given a note wrote one that says it")
	}
	if written := run(""); written != 1 {
		t.Fatal("a run without that history did not write the note")
	}
}

// A process that loses the database's worker lock while one run is read asks about no other.
func TestPostgresLosingTheWorkerLockStopsTheQueueBetweenRuns(t *testing.T) {
	pi := newDistillPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-lease-queue@example.test")
	ctx := context.Background()
	for _, op := range []string{"lease-run-1", "lease-run-2"} {
		cid := retryCanvas(t, h, c, tid)
		runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs", op, "completed")
	}
	awaitQueued(t, h, tid, 2)
	pi.onAsk.Store(func() { h.a.leaseLost.Store(true) })
	err := h.a.distillQueuedMemory(ctx)
	h.a.leaseLost.Store(false)
	if err != nil {
		t.Fatal(err)
	}
	var waiting int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM run_distillations WHERE tenant_id=$1 AND state='queued' AND attempts=0", tid).Scan(&waiting); err != nil {
		t.Fatal(err)
	}
	if pi.asked.Load() != 1 || waiting != 1 {
		t.Fatalf("after the lock was lost reading one run: asked %d, %d left as they were", pi.asked.Load(), waiting)
	}
}

// A process that loses the database's worker lock during one workspace's learning cycle starts no other.
func TestPostgresLosingTheWorkerLockStopsTheCyclesBetweenWorkspaces(t *testing.T) {
	pi := newTidyPi(t)
	h := newHarness(t, pi.server.URL)
	learnFromRuns(h)
	h.a.cfg.LearningCycleEvery = 72 * time.Hour
	ctx := context.Background()
	for i, email := range []string{"guard-lease-cycle-a@example.test", "guard-lease-cycle-b@example.test"} {
		c, tid, _ := h.register(t, email)
		cid := retryCanvas(t, h, c, tid)
		runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs", "lease-cycle-"+strconv.Itoa(i), "completed")
		notes := cycleNotes{t, h, tid}
		for _, title := range []string{"Captions stay short", "Buttons use sentence case", "Pages are dark"} {
			notes.add(cid, title, "")
		}
	}
	pi.onAsk.Store(func() { h.a.leaseLost.Store(true) })
	err := h.a.runDueLearningCycles(ctx)
	h.a.leaseLost.Store(false)
	if err != nil {
		t.Fatal(err)
	}
	var cycles int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM learning_cycles").Scan(&cycles); err != nil {
		t.Fatal(err)
	}
	if pi.asked.Load() != 1 || cycles != 1 {
		t.Fatalf("after the lock was lost in one workspace's cycle: asked %d, %d cycles", pi.asked.Load(), cycles)
	}
}

// The guards of round 11: what a deletion sets aside from an undo, how long a dismissal holds a canvas's words, and the
// strict rule's kinds where a note comes back or is set aside.

// A span that counts and ends where a pattern stopped reading a long value runs on to the end of the value; a shorter
// one ends where it does.
func TestALongSpanRunsOnToTheEndOfItsValue(t *testing.T) {
	text := "label " + strings.Repeat("x", 300) + " tail, then more"
	if end := valueRunEnd(text, 6, 6+256, nil); end != 306 {
		t.Fatalf("a long span ends at %d, want 306 (the space after its value)", end)
	}
	if end := valueRunEnd(text, 6, 6+40, nil); end != 46 {
		t.Fatalf("a short span ends at %d, want 46", end)
	}
	// A quoted value runs to its closing quote, past a comma; an apostrophe in a word opens no quote; a value among
	// Chinese ends at its first stop.
	quoted := `label "` + strings.Repeat("x", 300) + `, still the value" tail`
	if end := valueRunEnd(quoted, 6, 6+256, nil); end != strings.LastIndex(quoted, `"`) {
		t.Fatalf("a long quoted span ends at %d, want %d", end, strings.LastIndex(quoted, `"`))
	}
	apostrophe := "the user's value " + strings.Repeat("y", 300) + " and more"
	if end := valueRunEnd(apostrophe, 0, 256, nil); end != 317 {
		t.Fatalf("a long span after an apostrophe ends at %d, want 317", end)
	}
	chinese := "密钥 " + strings.Repeat("z", 300) + "，然后"
	if end := valueRunEnd(chinese, 0, 263, nil); end != strings.Index(chinese, "，") {
		t.Fatalf("a long span among Chinese ends at %d, want %d", end, strings.Index(chinese, "，"))
	}
	// A value of a pattern that says which characters end its values (phraseFinds) runs on to the first of them, its
	// line's end, or its next comma, semicolon or ampersand for one of credentialValue, a short one as a long one; one that
	// ended there runs no further, nor one that ended with a quote it closed.
	if end := valueRunEnd(text, 6, 6+256, credentialStops); end != strings.Index(text, ",") {
		t.Fatalf("a long phrase ends at %d, want %d (its comma)", end, strings.Index(text, ","))
	}
	if line := "label " + strings.Repeat("x", 300) + " tail\nnext"; valueRunEnd(line, 6, 6+256, credentialStops) != strings.Index(line, "\n") {
		t.Fatalf("a long phrase ends at %d, want its line's end", valueRunEnd(line, 6, 6+256, credentialStops))
	}
	if end := valueRunEnd(text, 6, 6+40, credentialStops); end != strings.Index(text, ",") {
		t.Fatalf("a short phrase ends at %d, want %d (its comma, as a long one)", end, strings.Index(text, ","))
	}
	if end := valueRunEnd(text, 6, strings.Index(text, ","), credentialStops); end != strings.Index(text, ",") {
		t.Fatalf("a phrase that ended at its comma runs on to %d", end)
	}
	closed := `label "teal and coral" and the note goes on, then`
	if end := valueRunEnd(closed, 6, strings.LastIndex(closed, `"`)+1, credentialStops); end != strings.LastIndex(closed, `"`)+1 {
		t.Fatalf("a phrase that ended with the quote it closed runs on to %d", end)
	}
	// A value in Latin letters among Chinese ends where they start again; a passphrase stopped at its ninth word runs on
	// over its words to the first character not of them.
	cjk := "颜色：teal然后再说，更多"
	start := strings.Index(cjk, "teal")
	if end := valueRunEnd(cjk, start, start+4, nonCJKStops); end != start+4 {
		t.Fatalf("a value among Chinese runs on to %d, want %d", end, start+4)
	}
	if end := valueRunEnd(cjk, start, start+4, credentialStops); end != strings.Index(cjk, "，") {
		t.Fatalf("a value of credentialValue among Chinese ends at %d, want its comma", end)
	}
	long := "颜色：" + strings.Repeat("v", 300) + "然后，更多"
	if end := valueRunEnd(long, len("颜色："), len("颜色：")+256, nonCJKStops); end != strings.Index(long, "然") {
		t.Fatalf("a long value among Chinese ends at %d, want %d", end, strings.Index(long, "然"))
	}
	words := "说明是 one two three four five six seven eight nine ten eleven然后"
	if end := valueRunEnd(words, strings.Index(words, "one"), strings.Index(words, " ten"), asciiWordStops); end != strings.Index(words, "然") {
		t.Fatalf("a passphrase stopped at its ninth word ends at %d, want %d", end, strings.Index(words, "然"))
	}
	if comma := strings.Replace(words, "ten eleven", "ten, eleven", 1); valueRunEnd(comma, strings.Index(comma, "one"), strings.Index(comma, " ten"), asciiWordStops) != strings.Index(comma, ",") {
		t.Fatal("a passphrase stopped at its ninth word does not end at its comma")
	}
	if short := "说明是 teal然后"; valueRunEnd(short, strings.Index(short, "teal"), strings.Index(short, "然"), asciiWordStops) != strings.Index(short, "然") {
		t.Fatal("a passphrase that ended where Chinese starts again runs on")
	}
}

// A person who deletes a note sets aside the notes a cycle merged that said the same, so that taking the merge back
// brings none of them back; the merge is no longer offered to be taken back.
func TestPostgresADeletionLeavesNoMergeToBringItsEchoesBack(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-merge-echo@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cm',$1,'Merge')", tid)
	notes := cycleNotes{t, h, tid}
	theirs := notes.add("cm", "Headlines use serif fonts", user)
	kept, merged := notes.add("cm", "Headline text uses serif fonts", ""), notes.add("cm", "Headlines are set in serif fonts", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='merged',successor_id=$3,version=2 WHERE tenant_id=$1 AND id=$2", tid, merged, kept)
	exec("INSERT INTO learning_cycles(id,tenant_id,state,finished_at) VALUES('cycle-merge',$1,'done',clock_timestamp())", tid)
	exec(`INSERT INTO learning_changes(id,tenant_id,cycle_id,kind,canvas_id,item_id,sources,before) VALUES('change-merge',$1,'cycle-merge','merge_notes','cm',$2,ARRAY[$3],$4)`,
		tid, kept, merged, jsonBytes(map[string]any{"created": false, "notes": []archivedNote{{ID: merged, Version: 1, Status: "active"}}}))
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+theirs, nil, 200)
	for _, id := range []string{kept, merged} {
		if status, reason, _ := notes.state(id); status != "archived" || reason != "restated" {
			t.Fatalf("note %s after the person's deletion: %s %q", id, status, reason)
		}
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/change-merge/undo", map[string]any{}, 409)
	if status, reason, _ := notes.state(merged); status != "archived" || reason != "restated" {
		t.Fatalf("an echo brought back by taking a merge back: %s %q", status, reason)
	}
}

// A merge whose note it kept is set aside since is not taken back, even where its sources were not set aside with it.
func TestPostgresAMergeWhoseNoteIsGoneIsNotTakenBack(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-merge-gone@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cg',$1,'Gone')", tid)
	notes := cycleNotes{t, h, tid}
	kept, merged := notes.add("cg", "Tables use zebra stripes", ""), notes.add("cg", "Rows alternate their shading", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='merged',successor_id=$3,version=2 WHERE tenant_id=$1 AND id=$2", tid, merged, kept)
	exec("INSERT INTO learning_cycles(id,tenant_id,state,finished_at) VALUES('cycle-gone',$1,'done',clock_timestamp())", tid)
	exec(`INSERT INTO learning_changes(id,tenant_id,cycle_id,kind,canvas_id,item_id,sources,before) VALUES('change-gone',$1,'cycle-gone','merge_notes','cg',$2,ARRAY[$3],$4)`,
		tid, kept, merged, jsonBytes(map[string]any{"created": false, "notes": []archivedNote{{ID: merged, Version: 1, Status: "active"}}}))
	if !changeUndoable(t, h, c, tid, "change-gone") {
		t.Fatal("a merge left as it was is not offered to be taken back")
	}
	exec("UPDATE memory_items SET status='archived',archived_reason='',version=version+1 WHERE tenant_id=$1 AND id=$2", tid, kept)
	if changeUndoable(t, h, c, tid, "change-gone") {
		t.Fatal("a merge whose note was archived since is offered to be taken back")
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/change-gone/undo", map[string]any{}, 409)
	if status, _, _ := notes.state(merged); status != "archived" {
		t.Fatalf("a source of a merge whose note was archived came back: %s", status)
	}
}

// A dismissal in a canvas of a note of the whole workspace that held another canvas's words goes with that canvas too.
func TestPostgresACanvasDismissalOfACanvassWordsGoesWithIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-canvas-words@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ca',$1,'Here'),('cb',$1,'Words'),('cc',$1,'Others'),('cx',$1,'Unrelated')", tid)
	notes := cycleNotes{t, h, tid}
	workspace := notes.add("", "Footers carry the brand mark", "")
	exec("UPDATE memory_items SET origin='evolution' WHERE tenant_id=$1 AND id=$2", tid, workspace)
	exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'cb',true)", tid, workspace)
	// The answer counts the workspace's note held back in the canvas apart from the notes archived.
	if got := h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("ca", "Footers carry the brand mark", user), nil, 200); got["setAside"] != float64(0) || got["heldBack"] != float64(1) {
		t.Fatalf("the answer of a deletion whose echo is the workspace's: %v", got)
	}
	dismissals := func(scope string) int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND COALESCE(canvas_id,'')=$2", tid, scope).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := dismissals("ca"); n != 1 {
		t.Fatalf("the workspace's echo dismissed in the canvas: %d", n)
	}
	// The same text dismissed in the whole workspace as well, holding the words of another canvas: each dismissal goes
	// with the canvases of its own scope alone.
	exec(`INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash,terms,kind,canvas_words) SELECT tenant_id,NULL,content_hash,terms,kind,true
		FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='ca'`, tid)
	exec(`INSERT INTO memory_item_dismissal_canvases(tenant_id,scope,content_hash,canvas_id) SELECT tenant_id,'',content_hash,'cc'
		FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='ca'`, tid)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cx", nil, 204)
	if here, there := dismissals("ca"), dismissals(""); here != 1 || there != 1 {
		t.Fatalf("dismissals after deleting a canvas whose words none held: %d in the canvas, %d in the workspace", here, there)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cb", nil, 204)
	if here, there := dismissals("ca"), dismissals(""); here != 0 || there != 1 {
		t.Fatalf("the canvas's dismissal of another canvas's words outlived it (%d), or the workspace's went with it (%d)", here, there)
	}
}

// A deleted fact holds back a fact that comes back from the archive in a third of its words, whatever kind the run calls
// it; a person who deletes a fact of their own sets aside the facts AwwO keeps that say so, not a note of another kind.
func TestPostgresTheStrictRuleGoesByTheKindANoteKeeps(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-stored-kind@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cz',$1,'Facts'),('cy',$1,'Theirs')", tid)
	notes := cycleNotes{t, h, tid}
	const deleted, reworded = "Invoices go out on the last working day of each month", "Reports go out on the last day of the quarter"
	fact := notes.add("cz", deleted, "")
	exec("UPDATE memory_items SET kind='fact' WHERE tenant_id=$1 AND id=$2", tid, fact)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+fact, nil, 200)
	// A fact archived unused after the deletion (one there before it would have been set aside with it) is held to the
	// deleted fact by the kind it keeps, not the kind the run calls it.
	back := notes.add("cz", reworded, "")
	exec("UPDATE memory_items SET kind='fact',status='archived',archived_reason='unused',evidence=1 WHERE tenant_id=$1 AND id=$2", tid, back)
	keepNotesOf(t, h, tid, "cz", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: reworded})
	if status, _, _ := notes.state(back); status != "archived" {
		t.Fatalf("a fact saying a third of a deleted fact came back as a preference: %s", status)
	}
	// A person's own fact deleted: AwwO's fact saying it is set aside, its preference in those words is not.
	theirs, factEcho, preference := notes.add("cy", deleted, user), notes.add("cy", reworded, ""), notes.add("cy", "Reports go out on the last day of the quarter too", "")
	exec("UPDATE memory_items SET kind='fact' WHERE tenant_id=$1 AND id=ANY($2)", tid, []string{theirs, factEcho})
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+theirs, nil, 200)
	if status, reason, _ := notes.state(factEcho); status != "archived" || reason != "restated" {
		t.Fatalf("AwwO's fact saying a deleted fact: %s %q", status, reason)
	}
	if status, _, _ := notes.state(preference); status != "active" {
		t.Fatalf("AwwO's preference sharing a few words of a deleted fact: %s", status)
	}
	// A person's own preference deleted: AwwO's fact sharing a third of its words stays.
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cp',$1,'Preference')", tid)
	mine, factAlike := notes.add("cp", deleted, user), notes.add("cp", reworded, "")
	exec("UPDATE memory_items SET kind='fact' WHERE tenant_id=$1 AND id=$2", tid, factAlike)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+mine, nil, 200)
	if status, _, _ := notes.state(factAlike); status != "active" {
		t.Fatalf("AwwO's fact sharing a third of a deleted preference: %s", status)
	}
}

// A person's change of AwwO's text dismisses all it said, whatever the change kept of it: an addition, a correction of
// the whole or of one sentence, a denial beside it, a title corrected over a body; the notes that said the old text are
// set aside, and a run writes none of it again, the person's note staying theirs. A later change of their text leaves
// nothing more. A correction in other words and the other sense is AwwO's to write.
func TestPostgresAChangeOfAwwOsTextDismissesAllOfIt(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-change@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cr',$1,'Change')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	edit := func(id string, fields map[string]any) {
		t.Helper()
		fields["version"] = listedNote(t, h, c, tid, "cr", id)["version"]
		h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+id, fields, 200)
	}
	dismissals := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	aside := func(what string, ids ...string) {
		t.Helper()
		for _, id := range ids {
			if status, reason, _ := notes.state(id); status != "archived" || reason != "outdated" {
				t.Fatalf("%s: %s %q", what, status, reason)
			}
		}
	}
	written := func(title string) int {
		t.Helper()
		return keepNotesOf(t, h, tid, "cr", user, false, memoryDistillNote{Op: "add", Kind: "style", Title: title})
	}
	// An addition: what the old text said is dismissed, the note saying it set aside; the person's note stays in use.
	teal, buttons := notes.add("cr", "Brand colour is teal", ""), notes.add("cr", "Brand colour teal for buttons", "")
	edit(teal, map[string]any{"title": "Brand colour is teal #0F766E"})
	aside("a note saying the text a person added to", buttons)
	if status, _, _ := notes.state(teal); status != "active" || dismissals() != 1 {
		t.Fatalf("the person's note after an addition: %s; %d dismissals", status, dismissals())
	}
	if n := written("Brand colour is teal"); n != 0 {
		t.Fatalf("the text a person added to, written again: %d", n)
	}
	// Changed again, the text is the person's: nothing more is dismissed.
	edit(teal, map[string]any{"title": "Brand colour is teal #0F766E, with white text"})
	if dismissals() != 1 {
		t.Fatalf("a change of a person's text left a dismissal: %d", dismissals())
	}
	// Corrected: the notes saying the old text go, one that says it in a sentence of its own too.
	tone, formal, both := notes.add("cr", "Tone is formal", ""), notes.add("cr", "Formal tone in replies", ""), notes.add("cr", "Tone stays friendly; formal tone only for contracts", "")
	edit(tone, map[string]any{"title": "Tone is friendly"})
	aside("a note saying the corrected text", formal, both)
	// One sentence corrected, the other kept: what said either goes, and neither is written again.
	fonts := notes.add("cr", "Headlines use Fraunces; body text uses Inter", "")
	inter, same, reworded := notes.add("cr", "Body text set in Inter", ""), notes.add("cr", "Headlines use Fraunces", ""), notes.add("cr", "Headlines are set in Fraunces", "")
	edit(fonts, map[string]any{"title": "Headlines use Fraunces; body text uses Lato"})
	aside("a note saying a sentence of the corrected text", inter, same, reworded)
	if n := written("Fraunces for headlines"); n != 0 || dismissals() != 3 {
		t.Fatalf("a sentence of AwwO's a person kept, written again: %d; %d dismissals", n, dismissals())
	}
	// A denial beside the old text, word for word as it was.
	coral, accent := notes.add("cr", "Accent colour is coral", ""), notes.add("cr", "Coral accent colour", "")
	edit(coral, map[string]any{"title": "Accent colour is coral, no longer"})
	aside("a note saying the text a denial was added to", accent)
	// A title corrected over a body: what the old title said is dismissed with the body.
	title := notes.addBody("cr", "Captions use Lora", "Set in italics under every image", "")
	echo := notes.add("cr", "Captions are set in Lora", "")
	edit(title, map[string]any{"title": "Captions use Inter"})
	aside("a note saying a corrected title", echo)
	if n := written("Lora for captions"); n != 0 || dismissals() != 5 {
		t.Fatalf("a corrected title written again: %d; %d dismissals", n, dismissals())
	}
	// A correction at more length in the other sense is held back too, as caution would have it; one in the deleted
	// note's very words, in the other sense, says the opposite, and is written.
	deleted := notes.add("cr", "Headlines use Playfair", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+deleted, nil, 200)
	if n := written("Headlines never use Playfair because the client finds it too formal"); n != 0 {
		t.Fatalf("a correction at length of a deleted note: written %d", n)
	}
	if n := written("Headlines never use Playfair"); n != 1 {
		t.Fatalf("a correction in a deleted note's very words: written %d", n)
	}
}

// A replacement archived unused longer than 30 days protects the note it replaces no more; one whose note is no longer in
// use does not come back.
func TestPostgresAReplacementLongUnusedHoldsNothing(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, user := h.register(t, "guard-replacement-age@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ca',$1,'Age')", tid)
	notes := cycleNotes{t, h, tid}
	target := notes.add("ca", "Headlines are blue", "")
	for _, title := range []string{"Captions stay short", "Buttons use sentence case", "Pages are dark"} {
		notes.add("ca", title, "")
	}
	replacement := notes.add("ca", "Headlines are red", "")
	exec(`UPDATE memory_items SET status='archived',archived_reason='unused',evidence=1,replaces_id=$3,updated_at=now()-interval '31 days'
		WHERE tenant_id=$1 AND id=$2`, tid, replacement, target)
	if _, pool, err := h.a.learningTidyBriefing(ctx, tid); err != nil {
		t.Fatal(err)
	} else if _, shown := pool[target]; !shown {
		t.Fatal("a note whose replacement was archived unused long ago is still kept from the tidy")
	}
	exec("UPDATE memory_items SET status='archived',archived_reason='merged' WHERE tenant_id=$1 AND id=$2", tid, target)
	keepNotesOf(t, h, tid, "ca", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: "Headlines are red"})
	if status, _, _ := notes.state(replacement); status != "archived" {
		t.Fatalf("a replacement of a note no longer in use came back: %s", status)
	}
}

// The guards of round 12 of self-learning.

// addBody writes a note with a body as add writes one without (a person's where person names them).
func (n cycleNotes) addBody(canvasID, title, body, person string) string {
	n.t.Helper()
	id := randomID()
	if _, err := n.h.db.Exec(context.Background(), `INSERT INTO memory_items(id,tenant_id,canvas_id,title,body,kind,status,origin,source,content_hash,created_by,updated_by,evidence)
		VALUES($1,$2,NULLIF($3,''),$4,$5,'preference','active',CASE WHEN $6='' THEN 'run' ELSE 'user' END,'{}',$7,NULLIF($6,''),NULLIF($6,''),CASE WHEN $6='' THEN 2 ELSE 1 END)`,
		id, n.tid, canvasID, title, body, person, memoryContentHash(title, body)); err != nil {
		n.t.Fatal(err)
	}
	return id
}

// A correction of a note of the whole workspace sets aside a canvas's note of AwwO's that says a clause it kept beside,
// in other words, the one it corrected; a deleted note of several clauses holds back a note of AwwO's that says one of
// them; and a heading two notes share is what they say, as caution would have it.
func TestPostgresACorrectionAndADeletionHoldEveryClause(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-clauses-held@example.test")
	if _, err := h.db.Exec(context.Background(), "INSERT INTO canvases(id,tenant_id,name) VALUES('ch',$1,'Held')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	rules := notes.addBody("", "Font rules", "Headlines use Fraunces; body text uses Inter", "")
	echo := notes.addBody("ch", "Print typography", "Headlines use Fraunces; paragraph copy uses Inter", "")
	note := listedNote(t, h, c, tid, "", rules)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+rules, map[string]any{"version": note["version"], "body": "Headlines use Fraunces; body text uses Lato"}, 200)
	if status, reason, _ := notes.state(echo); status != "archived" || reason != "outdated" {
		t.Fatalf("a canvas's note riding a kept clause beside a corrected one: %s %q", status, reason)
	}
	typography := notes.addBody("ch", "Brand typography", "Headlines use Fraunces; captions use Inter", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+typography, nil, 200)
	if written := keepNotesOf(t, h, tid, "ch", user, false, memoryDistillNote{Op: "add", Kind: "style", Title: "Captions use Inter"}); written != 0 {
		t.Fatalf("a clause of a deleted note written again: %d", written)
	}
	// A person's note of a heading deleted: AwwO's of the same heading in other words is set aside, and a run given the
	// person's writes none.
	theirs, buttons := notes.addBody("ch", "Brand guidelines", "Headlines use Fraunces", user), notes.addBody("ch", "Brand guidelines", "Buttons are rounded", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+theirs, nil, 200)
	if status, reason, _ := notes.state(buttons); status != "archived" || reason != "restated" {
		t.Fatalf("a note sharing a heading with a deleted one: %s %q", status, reason)
	}
	given := memoryNote{ID: "given", Scope: "canvas", Kind: "style", Title: "Brand guidelines", Body: "Headlines use Fraunces", ContentHash: memoryContentHash("Brand guidelines", "Headlines use Fraunces")}
	if written := keepNotesAfter(t, h, tid, "ch", user, wholeCanvasRun, []memoryNote{given}, memoryDistillNote{Op: "add", Kind: "style", Title: "Brand guidelines", Body: "Pages are dark"}); written != 0 {
		t.Fatalf("a note sharing a heading with one the run was given: written %d", written)
	}
	// Deleted, AwwO's note of a heading holds back a note of the same heading in other words, one of a single word too.
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.addBody("ch", "Tone guide", "Replies stay formal", ""), nil, 200)
	if written := keepNotesOf(t, h, tid, "ch", user, false, memoryDistillNote{Op: "add", Kind: "style", Title: "Tone guide", Body: "Emoji are fine in chats"}); written != 0 {
		t.Fatalf("a note sharing a heading with a deleted one: written %d", written)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.addBody("ch", "Pages are dark", "The team chose a dark theme", ""), nil, 200)
	if written := keepNotesOf(t, h, tid, "ch", user, false, memoryDistillNote{Op: "add", Kind: "style", Title: "Pages are dark", Body: "Backgrounds stay near black"}); written != 0 {
		t.Fatalf("a note sharing a heading of one word with a deleted one: written %d", written)
	}
}

// A run told a note writes nothing that holds the whole of it in one clause, whatever else that clause says, nor does one
// whose node an API from before migration 055 admitted; deleting the note sets aside such a note of AwwO's; a deleted
// note of AwwO's sets aside a fragment of it, and a rule of one word the same word alone.
func TestPostgresAnElaborationIsHeldToTheNoteItHolds(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-elaboration@example.test")
	if _, err := h.db.Exec(context.Background(), "INSERT INTO canvases(id,tenant_id,name) VALUES('ce',$1,'Elaboration')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	const rule, heavy = "Headlines use Fraunces", "Headlines are set in Fraunces at a heavy weight"
	person := memoryNote{ID: notes.add("ce", rule, user), Scope: "canvas", Kind: "style", Title: rule, ContentHash: memoryContentHash(rule, "")}
	for _, run := range []int{wholeCanvasRun, olderAPIRun} {
		if written := keepNotesAfter(t, h, tid, "ce", user, run, []memoryNote{person}, memoryDistillNote{Op: "add", Kind: "style", Title: heavy}); written != 0 {
			t.Fatalf("an elaboration from a run (%d) given the rule: written %d", run, written)
		}
	}
	elaboration := notes.add("ce", heavy, "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+person.ID, nil, 200)
	if status, reason, _ := notes.state(elaboration); status != "archived" || reason != "restated" {
		t.Fatalf("AwwO's elaboration of a deleted rule: %s %q", status, reason)
	}
	reviews, fragment := notes.add("ce", "Product pages show customer reviews beneath the gallery", ""), notes.add("ce", "Show customer reviews", "")
	if got := h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+reviews, nil, 200); got["setAside"] != float64(1) {
		t.Fatalf("the notes a deletion set aside: %v", got)
	}
	if status, _, _ := notes.state(fragment); status != "archived" {
		t.Fatalf("a fragment of a deleted note: %s", status)
	}
	markdown, prefer := notes.add("ce", "Always use Markdown", ""), notes.add("ce", "Prefer Markdown", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+markdown, nil, 200)
	if status, _, _ := notes.state(prefer); status != "archived" {
		t.Fatalf("a rule of one word, after the deletion of the same word: %s", status)
	}
	if written := keepNotesOf(t, h, tid, "ce", user, false, memoryDistillNote{Op: "add", Kind: "style", Title: "Markdown always"}); written != 0 {
		t.Fatalf("a deleted rule of one word written again: %d", written)
	}
}

// A replacement archived unused does not come back while the note it replaces is kept apart from cycles (a person
// brought it back from one): it could not take its place, and the two would be in use at once.
func TestPostgresAReplacementOfANoteKeptApartStaysArchived(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, user := h.register(t, "guard-replacement-apart@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ck',$1,'Apart')", tid)
	notes := cycleNotes{t, h, tid}
	target, replacement := notes.add("ck", "Headlines are blue", ""), notes.add("ck", "Headlines are red", "")
	exec("UPDATE memory_items SET kept_apart=true WHERE tenant_id=$1 AND id=$2", tid, target)
	exec("UPDATE memory_items SET status='archived',archived_reason='unused',evidence=1,replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, replacement, target)
	keepNotesOf(t, h, tid, "ck", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: "Headlines are red"})
	if status, _, _ := notes.state(replacement); status != "archived" {
		t.Fatalf("a replacement of a note kept apart came back: %s", status)
	}
	if status, _, _ := notes.state(target); status != "active" {
		t.Fatalf("a note kept apart: %s", status)
	}
}

// A cycle's archive of a note a person changed since is not offered to be taken back.
func TestPostgresAnArchiveWhoseNoteChangedIsNotOfferedToBeTakenBack(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-archive-undoable@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ca',$1,'Archive')", tid)
	note := cycleNotes{t, h, tid}.add("ca", "Captions stay short", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='tidied',version=2 WHERE tenant_id=$1 AND id=$2", tid, note)
	exec("INSERT INTO learning_cycles(id,tenant_id,state,finished_at) VALUES('cycle-archive',$1,'done',clock_timestamp())", tid)
	exec(`INSERT INTO learning_changes(id,tenant_id,cycle_id,kind,canvas_id,item_id,before) VALUES('change-archive',$1,'cycle-archive','archive_note','ca',$2,$3)`,
		tid, note, jsonBytes(map[string]any{"version": 1, "status": "active"}))
	if !changeUndoable(t, h, c, tid, "change-archive") {
		t.Fatal("an archive left as it was is not offered to be taken back")
	}
	exec("UPDATE memory_items SET pinned=true,version=version+1,updated_by=$3 WHERE tenant_id=$1 AND id=$2", tid, note, user)
	if changeUndoable(t, h, c, tid, "change-archive") {
		t.Fatal("an archive whose note a person pinned since is offered to be taken back")
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/change-archive/undo", map[string]any{}, 409)
}

// The links of a dismissal made in a canvas go with that canvas; and the distiller of a canvas is shown no note of
// AwwO's that a dismissal there holds back, where another canvas's is.
func TestPostgresACanvassDismissalsLeaveNothingBehind(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-dismissal-links@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cs',$1,'Scope'),('cw',$1,'Words'),('co',$1,'Other')", tid)
	notes := cycleNotes{t, h, tid}
	workspace := notes.add("", "Footers carry the brand mark", "")
	exec("UPDATE memory_items SET origin='evolution' WHERE tenant_id=$1 AND id=$2", tid, workspace)
	exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'cw',true)", tid, workspace)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cs", "Footers carry the brand mark", user), nil, 200)
	shown := func(canvasID string) bool {
		t.Helper()
		pool, _, err := h.a.distillationPool(ctx, tid, canvasID)
		if err != nil {
			t.Fatal(err)
		}
		_, in := pool[workspace]
		return in
	}
	if shown("cs") || !shown("co") {
		t.Fatalf("the workspace's note dismissed in one canvas, shown to its distiller %v, to another's %v", shown("cs"), shown("co"))
	}
	// Held back for a person's own note, the workspace's note is held by its very text alone, no word of it; one that says
	// the same in other words is shown there still, and held back once AwwO's own note saying it is deleted there.
	var words int
	if err := h.db.QueryRow(ctx, "SELECT cardinality(terms)+cardinality(numbers)+jsonb_array_length(parts) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cs'", tid).Scan(&words); err != nil || words != 0 {
		t.Fatalf("the hold of the workspace's note for a person's own note keeps %d words: %v", words, err)
	}
	inPool := func(canvasID, id string) bool {
		t.Helper()
		pool, _, err := h.a.distillationPool(ctx, tid, canvasID)
		if err != nil {
			t.Fatal(err)
		}
		_, in := pool[id]
		return in
	}
	reworded := notes.add("", "Footers show the brand mark", "")
	exec("UPDATE memory_items SET origin='evolution' WHERE tenant_id=$1 AND id=$2", tid, reworded)
	if !inPool("cs", reworded) {
		t.Fatal("a rewording held back for a person's own note, of which nothing is kept")
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cs", "Brand mark sits at the footer", ""), nil, 200)
	if inPool("cs", reworded) || !inPool("co", reworded) {
		t.Fatalf("the workspace's rewording of AwwO's note deleted in a canvas, shown to its distiller %v, to another's %v", inPool("cs", reworded), inPool("co", reworded))
	}
	// A person's change of the workspace's note dismisses AwwO's text no longer than the canvas whose words it held; one
	// a person pinned, and so kept once that canvas was deleted, leaves no dismissal of its words when they delete it,
	// where one that still holds a canvas's words does.
	dismissed := func(title string) int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND content_hash=$2", tid, h.a.dismissalHash(tid, memoryContentHash(title, ""))).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	evolved := func(title, canvasID string) string {
		t.Helper()
		id := notes.add("", title, "")
		exec("UPDATE memory_items SET origin='evolution',written_hash=content_hash WHERE tenant_id=$1 AND id=$2", tid, id)
		exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,$3,true)", tid, id, canvasID)
		return id
	}
	stripes, header, footer := evolved("Tables use zebra stripes", "co"), evolved("Tables keep a header row", "co"), evolved("Tables keep a footer row", "cw")
	total := evolved("Tables keep a total row", "co")
	note := listedNote(t, h, c, tid, "", stripes)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+stripes, map[string]any{"version": note["version"], "title": "Tables use zebra stripes, light grey"}, 200)
	for _, id := range []string{header, footer, total} {
		note = listedNote(t, h, c, tid, "", id)
		h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+id, map[string]any{"version": note["version"], "pinned": true}, 200)
	}
	if n := dismissed("Tables use zebra stripes"); n != 1 {
		t.Fatalf("the change of the workspace's note dismissed it %d times", n)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/co", nil, 204)
	if n := dismissed("Tables use zebra stripes"); n != 0 {
		t.Fatal("the dismissal of AwwO's words of a deleted canvas outlived it")
	}
	if status, _, _ := notes.state(header); status != "active" {
		t.Fatalf("a note a person pinned, once the canvas of its words was deleted: %s", status)
	}
	for _, id := range []string{header, footer} {
		h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+id, nil, 200)
	}
	if gone, kept := dismissed("Tables keep a header row"), dismissed("Tables keep a footer row"); gone != 0 || kept != 1 {
		t.Fatalf("pinned notes deleted: %d dismissals of a deleted canvas's words, %d of a canvas's left", gone, kept)
	}
	note = listedNote(t, h, c, tid, "", total)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+total, map[string]any{"version": note["version"], "title": "Tables keep a total row in bold"}, 200)
	if n := dismissed("Tables keep a total row"); n != 0 {
		t.Fatalf("a change of a pinned note of a deleted canvas's words dismissed them: %d", n)
	}
	links := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissal_canvases WHERE tenant_id=$1 AND scope='cs'", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := links(); n != 1 {
		t.Fatalf("the links of the canvas's dismissal: %d", n)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cs", nil, 204)
	if n := links(); n != 0 {
		t.Fatalf("the links of a deleted canvas's dismissal: %d", n)
	}
}

// The guards of round 13 of self-learning.

// A person's correction of their own note sets aside AwwO's notes that said its old text, and leaves no dismissal; a
// correction of a sign or a currency in AwwO's text dismisses it; a rule of a short word is held to a rewording of it,
// deleted or told.
func TestPostgresAPersonsCorrectionSetsAsideWhatItCorrected(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-own-correction@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('co',$1,'Own')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	edit := func(id, title string) {
		t.Helper()
		note := listedNote(t, h, c, tid, "co", id)
		h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+id, map[string]any{"version": note["version"], "title": title}, 200)
	}
	dismissals := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	theirs, echo := notes.add("co", "Headlines use Fraunces", user), notes.add("co", "Headlines are set in Fraunces", "")
	edit(theirs, "Headlines use Lato")
	if status, reason, _ := notes.state(echo); status != "archived" || reason != "restated" || dismissals() != 0 {
		t.Fatalf("AwwO's note saying a person's corrected text: %s %q; %d dismissals", status, reason, dismissals())
	}
	margin, positive := notes.add("co", "Profit margin is 5%", ""), notes.add("co", "Profit margin stays at 5%", "")
	edit(margin, "Profit margin is -5%")
	if status, _, _ := notes.state(positive); status != "archived" || dismissals() != 1 {
		t.Fatalf("a sign corrected: the note saying the old value %s; %d dismissals", status, dismissals())
	}
	// The same words of another value say something else, and are written.
	if written := keepNotesOf(t, h, tid, "co", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: "Profit margin is 8%"}); written != 1 {
		t.Fatalf("another value in the words of a dismissed note: written %d", written)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("co", "Use Go", ""), nil, 200)
	if written := keepNotesOf(t, h, tid, "co", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: "Prefer Go"}); written != 0 {
		t.Fatalf("a deleted rule of a short word written again in other words: %d", written)
	}
	given := memoryNote{ID: "given", Scope: "canvas", Kind: "preference", Title: "Write scripts in JS", ContentHash: memoryContentHash("Write scripts in JS", "")}
	if written := keepNotesAfter(t, h, tid, "co", user, wholeCanvasRun, []memoryNote{given}, memoryDistillNote{Op: "add", Kind: "preference", Title: "Prefer JS for scripts"}); written != 0 {
		t.Fatalf("a rule of a short word from a run given it: written %d", written)
	}
}

// The distiller's pool is read again under the workspace's row: a note of the whole workspace held back in the canvas
// since it was read, in use still and as it was read, holds the distillation back.
func TestPostgresTheDistillersPoolIsReadAgainUnderTheHold(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-pool-again@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cp',$1,'Pool')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	workspace := notes.add("", "Captions sit under images", "")
	notes.add("cp", "Buttons are rounded", "")
	pool, _, err := h.a.distillationPool(ctx, tid, "cp")
	if err != nil {
		t.Fatal(err)
	}
	if _, in := pool[workspace]; !in {
		t.Fatal("the workspace's note is not in the canvas's pool")
	}
	ids := slices.Collect(maps.Keys(pool))
	gone := func() bool {
		t.Helper()
		tx, err := h.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		held, err := h.a.poolDismissed(ctx, tx, tid, "cp", ids)
		if err != nil {
			t.Fatal(err)
		}
		return held
	}
	if gone() {
		t.Fatal("a pool no dismissal holds back was held back")
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cp", "Captions sit under images", user), nil, 200)
	if status, _, _ := notes.state(workspace); status != "active" || !gone() {
		t.Fatalf("the workspace's note held back in the canvas since the pool was read: %s, the pool held back %v", status, gone())
	}
	// Older than the newest 1,000 dismissals there, the hold still holds the pool back, in its very text.
	if _, err := h.db.Exec(ctx, `INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash,created_at)
		SELECT $1,'cp',md5('later'||i)||md5('later'||i),clock_timestamp()+make_interval(secs=>i) FROM generate_series(1,1000) i`, tid); err != nil {
		t.Fatal(err)
	}
	if !gone() {
		t.Fatal("a pool note held back by a dismissal older than the newest 1,000 there was not held back")
	}
}

// Without the deployment's credential key no dismissal is kept: a note of the whole workspace saying what a deleted note
// of a canvas said is archived, where nothing could hold it back from that canvas, and the answer says so.
func TestPostgresWithoutTheKeyAWorkspaceEchoIsArchived(t *testing.T) {
	h := newHarness(t, "")
	h.a.cfg.CredentialKey = nil
	c, tid, user := h.register(t, "guard-no-key@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cn',$1,'No key')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	workspace := notes.add("", "Footers carry the brand mark", "")
	got := h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cn", "Footers carry the brand mark", user), nil, 200)
	if got["setAside"] != float64(1) || got["heldBack"] != float64(0) {
		t.Fatalf("the answer of a deletion without the key: %v", got)
	}
	if status, reason, _ := notes.state(workspace); status != "archived" || reason != "restated" {
		t.Fatalf("the workspace's echo without the key: %s %q", status, reason)
	}
	var n int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&n); err != nil || n != 0 {
		t.Fatalf("dismissals kept without the key: %d %v", n, err)
	}
}

// A number is one number however it is written: its marks read as a decimal mark or as groups of thousands, no leading
// zero in its whole part nor a trailing one in its decimals.
func TestANumberIsTheSameHoweverWritten(t *testing.T) {
	// A number keeps the minus of its sign, not that of a range, a hyphened name or a list's dash.
	for text, want := range map[string][]string{"Temperature is -5 degrees": {"-5"}, "Temperature is −5 degrees": {"-5"}, "Range (-5) to 10": {"-5", "10"},
		"Pages 1-5": {"1", "5"}, "Model H-5": {"5"}, "- 5 items": {"5"}, "-0 change": {"0"}, "Margins are -.5 rem": {"-0.5"}} {
		if got := noteNumberList(text); !slices.Equal(got, want) {
			t.Errorf("the numbers of %q: %v, want %v", text, got, want)
		}
	}
	for written, want := range map[string]string{"1,000": "1000", "1000": "1000", "1.5": "1.5", "1.50": "1.5", "05": "5", "3.0": "3",
		"1,000.5": "1000.5", "0.5": "0.5", "1.000.000": "1000000", "0": "0", "100": "100", "1,000.500": "1000.5", "1.10.2": "1.10.2",
		"2026.11.20": "2026.11.20", "2026.01.05": "2026.1.5", "12.345.678": "12345678", "0.125": "0.125",
		".5": "0.5", ".500": "0.5", "0.250": "0.25", "1.500": "1.5", "1.000": "1", "1,000,000": "1000000", "1.000,000": "1000000"} {
		if got := noteNumber(written); got != want {
			t.Errorf("%q kept as %q, want %q", written, got, want)
		}
	}
	for text, want := range map[string][]string{"Sizes are 12,14,16": {"12", "14", "16"}, "Hero is 1,000 px": {"1000"}, "Gaps are 1,5": {"1", "5"},
		"Spend 1,000,000.50 a year": {"1000000.5"}, "Codes are 1,2345": {"1", "2345"}} {
		if got := slices.Sorted(maps.Keys(noteNumbers(text))); !slices.Equal(got, want) {
			t.Errorf("the numbers of %q: %v, want %v", text, got, want)
		}
	}
	if got := noteClauses("Sizes are 12,14,16"); len(got) != 3 {
		t.Errorf("the clauses of a list of numbers: %q", got)
	}
	if got := noteClauses("Hero is 1,000 px wide"); len(got) != 1 {
		t.Errorf("the clauses of a sentence with a number of thousands: %q", got)
	}
	for _, c := range []struct {
		note, text string
		want       bool
	}{
		{"Hero width is 1,000 px", "Hero width is 1000 px", true},
		{"Margins are 1.5 rem", "Margins are 1.50 rem", true},
		{"Margins are 1.5 rem", "Margins are 2.5 rem", false},
		{"Margins are 0.5 rem", "Margins are .5 rem", true},
		{"Transitions last 0.250 s", "Transitions last 0.25 s", true},
		{"Transitions last 0.125 s", "Transitions last 125 s", false},
		{"Sizes are 12, 14 and 16", "Sizes are 12,14,16", true},
	} {
		if got := saidOf("", c.note, "").says(saidOf("", c.text, "")); got != c.want {
			t.Errorf("%q says %q: %v, want %v", c.text, c.note, got, c.want)
		}
	}
}

// What a dismissal keeps holds a note back as the note itself would: of each pair of notes, the dismissal of the first,
// as it is kept and read back (heldWordsOf, its parts through JSON, then dismissal), holds the second back exactly when
// the first note does (heldTo), a sentence of numbers alone and a note of as many parts as a note can hold among them.
func TestADismissalHoldsBackWhatItsNoteWould(t *testing.T) {
	a := &App{cfg: Config{CredentialKey: bytes.Repeat([]byte{7}, 32)}}
	const tid = "tenant-held"
	codes := []string{}
	for i := 0; i < 160; i++ {
		codes = append(codes, string(rune('A'+i/10))+strconv.Itoa(i%10))
	}
	palette := strings.Join(codes, ",") + ",Buttons are teal"
	for _, c := range []struct {
		title, body, otherTitle, otherBody string
		want                               bool
	}{
		{"Typography", "12, 14, 16.\nUse Inter with regular weight", "Text sizes", "12, 14, 16", true},
		{"Palette", palette, "Buttons are teal", "", true},
		{"Headlines use Fraunces; body text uses Inter", "", "Body text set in Inter", "", true},
		{"Brand guidelines", "Headlines use Fraunces", "Brand guidelines", "Buttons are rounded", true},
		{"Pages are dark", "The team chose a dark theme for every page.", "Pages are dark", "Backgrounds stay near black", true},
		{"标题用衬线字体", "", "排版", "首页标题统一用衬线字体。正文用黑体。", true},
		{"Product pages show customer reviews beneath the gallery", "", "Show customer reviews", "", true},
		{"Always use Markdown", "", "Never use Markdown", "", false},
		{"Captions stay under 12 words", "", "Captions stay under 20 words", "", true},
		{"Buttons are rounded", "", "Buttons are rounded with soft shadows to avoid a flat look", "", true},
		{"按钮用圆角", "", "首页按钮用圆角配不同颜色的阴影", "", true},
		{"Buttons are teal and rounded", "", "Button style", "Teal, rounded corners, soft shadows. Larger on mobile.", true},
		{"Buttons are teal and rounded", "", "Buttons are teal, rounded and large, with soft shadows under the brand font", "", true},
		{"Hero width is 1,000 px", "", "Hero width is 1000 px", "", true},
		{"负责人：王小明，李小红", "", "李小红负责审核文案", "", false},
		{"Headlines use Playfair", "", "Headlines never use Playfair because the client finds it too formal", "", true},
		{"Headlines use Playfair", "", "Headlines never use Playfair", "", false},
		{"Headlines use Fraunces", "", "Headlines", "Never use Fraunces", false},
		{"Cards use 2 columns and 4 px gaps", "", "Cards should not use 2 columns and 8 px gaps", "", true},
		{"Margins are 0.5 rem", "", "Margins are .5 rem", "", true},
		{"Transitions last 0.250 s", "", "Transitions last 0.25 s", "", true},
		{"Buttons are teal and rounded", "", "Buttons are teal. Rounded corners, soft shadows under the brand font", "", true},
		{"Headlines use Fraunces", "", "Never use Fraunces. Headlines.", "", false},
		{"Headlines use Fraunces", "", "Typography for the marketing site pages", "Headlines never use Fraunces.", false},
		{"Always use Tailwind", "", "Pages are styled with Tailwind", "", true},
		{"Always use Tailwind", "", "Tools: React, Tailwind, Vite", "", false},
		{"Buttons", "Teal, rounded, larger on mobile", "Buttons are teal", "", true},
		{"Button style", "Teal, rounded corners, soft shadows. Larger on mobile.", "Buttons are teal and rounded", "", true},
		{"Headlines use Fraunces, buttons are teal", "", "Headlines are set in Fraunces at a heavy weight", "", true},
		{"标题用衬线字体，按钮用圆角", "", "首页标题统一用衬线字体", "", true},
		{"Always deploy with a review", "", "Never deploy without a review", "", true},
		{"Never deploy without a review", "", "Never deploy with a review", "", false},
		{"Publish with review and approval", "", "Never publish without review and without approval", "", true},
		{"Never publish without review and without approval", "", "Publish with review and approval", "", true},
		{"Never publish without review and without approval", "", "Never publish with review and approval", "", true},
		{"Button style", "Teal; rounded corners; soft shadows", "Buttons are teal and rounded", "", true},
		{"Buttons are teal, rounded, larger on mobile", "", "Buttons are rounded", "", true},
		{"Button style", "Teal, rounded, larger on mobile", "Button style: teal with a soft glow", "", true},
		{"Tailwind", "Its utility classes live in one file.", "Pages are styled with Tailwind", "", true},
		{"Button style", "Teal, rounded corners, soft shadows. Larger on mobile.", "Buttons", "Buttons are teal and rounded. They glow softly on hover.", true},
		{"Buttons", "Teal, rounded, larger on mobile", "Buttons are teal with a thick outline", "", true},
		// A part of no word read with the title: a body sentence of none, a list ending in "etc.".
		{"Buttons are teal and rounded with soft shadows", "On all pages.", "Buttons are teal", "", true},
		{"Buttons are teal and rounded with soft shadows", "Larger on mobile, etc.", "Buttons are teal", "", true},
		{"按钮既用阴影也用渐变", "", "按钮既不用阴影也不用渐变", "", false},
		{"No shadows & no gradients", "", "No shadows or gradients", "", true},
	} {
		note, other := saidOf("", c.title, c.body), saidOf("", c.otherTitle, c.otherBody)
		if got := heldTo(note, other, false); got != c.want {
			t.Errorf("%q / %q held to %q / %q: %v, want %v", c.otherTitle, c.otherBody, c.title, c.body, got, c.want)
		}
		held := a.heldWordsOf(tid, noteText{c.title, c.body, "style"})
		var parts []heldPart
		if err := json.Unmarshal(jsonBytes(held.Parts), &parts); err != nil {
			t.Fatal(err)
		}
		held.Parts = parts
		if got := heldTo(held.dismissal(a.dismissalMarks(tid)).said, a.keyedSaid(tid, other), false); got != c.want {
			t.Errorf("%q / %q held back by the dismissal of %q / %q: %v, want %v", c.otherTitle, c.otherBody, c.title, c.body, got, c.want)
		}
	}
}

// A person who confirms, adopts or pins a note AwwO wrote before the hash of its text was kept leaves its text AwwO's:
// deleting it, or changing its text, dismisses what it said.
func TestPostgresAPersonsPinKeepsAnOlderNoteAwwOs(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-older-note@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cl',$1,'Older')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	dismissed := func(title string) int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND content_hash=$2", tid, h.a.dismissalHash(tid, memoryContentHash(title, ""))).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Pinned, then deleted.
	pinned := notes.add("cl", "Tables keep a header row", "")
	note := listedNote(t, h, c, tid, "cl", pinned)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+pinned, map[string]any{"version": note["version"], "pinned": true}, 200)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+pinned, nil, 200)
	// Saved again by a person in its very words (adopted), then deleted.
	adopted := notes.add("cl", "Captions sit under images", "")
	h.request(t, c, "POST", "/tenants/"+tid+"/memory", map[string]any{"canvasId": "cl", "title": "Captions sit under images", "kind": "preference"}, 200)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+adopted, nil, 200)
	// Confirmed on probation by saving it again, then changed.
	waiting := notes.probation("cl", "Footers carry the brand mark")
	h.request(t, c, "POST", "/tenants/"+tid+"/memory", map[string]any{"canvasId": "cl", "title": "Footers carry the brand mark", "kind": "preference", "status": "active"}, 200)
	note = listedNote(t, h, c, tid, "cl", waiting)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+waiting, map[string]any{"version": note["version"], "title": "Footers carry the brand mark in grey"}, 200)
	for _, title := range []string{"Tables keep a header row", "Captions sit under images", "Footers carry the brand mark"} {
		if n := dismissed(title); n != 1 {
			t.Errorf("an older note of AwwO's a person made theirs, then deleted or changed (%q): %d dismissals", title, n)
		}
	}
}

// A sentence that holds all a note says says it, whatever else it says, a no among it ("to avoid a flat look") or a word
// of Chinese that holds one and says no no (不同, 特别); and so does a note of a title and a body whose title and one
// sentence of its body hold it together, and a note of one sentence that holds it among its clauses.
func TestAnElaborationSaysANoteWhateverElseItSays(t *testing.T) {
	for _, c := range []struct {
		note, title, body string
		want              bool
	}{
		{"Buttons are rounded", "Buttons are rounded with soft shadows to avoid a flat look", "", true},
		{"Headlines use Fraunces", "Headlines use Fraunces at a heavy weight and never in italics", "", true},
		{"按钮用圆角", "按钮特别用圆角设计以显得亲切", "", true},
		{"按钮用圆角", "首页按钮用圆角配不同颜色的阴影", "", true},
		{"Buttons are teal and rounded", "Button style", "Teal, rounded corners, soft shadows. Larger on mobile.", true},
		{"Buttons are teal and rounded", "Buttons are teal, rounded and large, with soft shadows under the brand font", "", true},
		{"Headlines use Fraunces", "Headlines never use Fraunces", "", false},
		{"Headlines use Fraunces", "Headlines", "Never use Fraunces", false},
		{"Cards use 2 columns and 4 px gaps", "Cards should not use 2 columns and 8 px gaps", "", true},
		{"Buttons are teal", "Buttons are rounded; teal is reserved for links", "", true},
		{"Buttons are teal", "Style", "Buttons are rounded; teal is reserved for links", false},
		{"Headlines use Fraunces", "Typography for the marketing site pages", "Headlines never use Fraunces.", false},
		{"Buttons are teal and rounded", "Buttons are teal. Rounded corners, soft shadows under the brand font", "", true},
		{"Headlines use Fraunces", "Never use Fraunces. Headlines.", "", false},
		{"Headlines use Fraunces", "Fonts. Headlines", "Use Fraunces", true},
	} {
		if got := heldTo(saidOf("", c.note, ""), saidOf("", c.title, c.body), false); got != c.want {
			t.Errorf("%q / %q held to %q: %v, want %v", c.title, c.body, c.note, got, c.want)
		}
	}
}

// Words of Chinese that hold 不 or 别 and say no no are no negation, and stay as they are where a no is taken out.
func TestChineseWordsThatHoldANoAreNoNegation(t *testing.T) {
	for text, want := range map[string]bool{"首页按钮用圆角配不同颜色的阴影": false, "按钮特别用圆角": false, "按钮别用圆角": true, "标题不用衬线字体": true,
		"不得不用圆角": false, "别人的按钮用圆角": false, "客户不同意深色主题": true, "设计要不过时": true, "不过度使用阴影": true, "收集不同意见": false,
		"不过时间很充裕": false, "按钮设计很别致": false, "不妨用圆角": false, "首页不时更新": false, "差不多用圆角": false, "这个设计了不起": false,
		"正文字号不少于16px": true, "不同时使用两种字体": true, "页面不同步更新": true, "不过多使用阴影": true, "配色不过分鲜艳": true, "客户不同意": true,
		"不同时长的视频": false, "不同时候的封面": false, "不同时刻的截图": false, "不过多久就上线": false, "两边不同步调": false, "不同意见都收集": false} {
		if got := noteNegated(text); got != want {
			t.Errorf("%q says no: %v, want %v", text, got, want)
		}
	}
	if got := withoutNegations("配不同颜色别用红色"); got != "配不同颜色用红色" {
		t.Errorf("the no taken out of a text with a word that holds one: %q", got)
	}
	if got := withoutNegations("客户不同意深色主题也收集不同意见"); got != "客户同意深色主题也收集不同意见" {
		t.Errorf("the no taken out of a word that denies: %q", got)
	}
}

// A deletion counts no note of the whole workspace as held back from the canvas that is given nowhere (archived).
func TestPostgresAHeldBackCountLeavesOutArchivedNotes(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-held-count@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cu',$1,'Count')", tid)
	notes := cycleNotes{t, h, tid}
	unused := notes.add("", "Footers carry the brand mark", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='unused' WHERE tenant_id=$1 AND id=$2", tid, unused)
	if got := h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cu", "Footers carry the brand mark", user), nil, 200); got["setAside"] != float64(0) || got["heldBack"] != float64(0) {
		t.Fatalf("the answer of a deletion whose echo of the workspace is archived: %v", got)
	}
	// One in use is counted where the deletion holds it back, though the deleted note held the same text, and not again.
	notes.add("", "Captions sit under images", "")
	for i, want := range []float64{1, 0} {
		if got := h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cu", "Captions sit under images", ""), nil, 200); got["heldBack"] != want {
			t.Fatalf("deletion %d of AwwO's note of the text of one of the workspace in use: %v, want %v held back", i+1, got, want)
		}
	}
}

// A note a cycle moved from two canvases to the whole workspace goes with the canvas of the one it kept; the notes of
// the other canvas moved or merged into it are archived as unused, in favour of none, for a run there to write them
// again; one moved into another note stays as it is.
func TestPostgresTheNotesMovedIntoOneDeletedAreUnused(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-moved-unused@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cka',$1,'Kept'),('ckb',$1,'Other')", tid)
	notes := cycleNotes{t, h, tid}
	workspace, elsewhere, gone := notes.add("", "Tables use zebra stripes", ""), notes.add("", "Tables keep a header row", ""), notes.add("", "Tables are zebra striped", "")
	exec("UPDATE memory_items SET origin='evolution',written_hash=content_hash WHERE tenant_id=$1 AND id=ANY($2)", tid, []string{workspace, elsewhere, gone})
	exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'cka',true),($1,$2,'ckb',false),($1,$3,'ckb',true),($1,$4,'cka',true)",
		tid, workspace, elsewhere, gone)
	kept, promoted := notes.add("cka", "Tables use zebra stripes", ""), notes.add("ckb", "Tables have zebra stripes", "")
	merged, other := notes.add("ckb", "Tables are striped", ""), notes.add("ckb", "Tables keep a header", "")
	archive := func(id, reason, successor string) {
		t.Helper()
		exec("UPDATE memory_items SET status='archived',archived_reason=$3,successor_id=$4,version=2 WHERE tenant_id=$1 AND id=$2", tid, id, reason, successor)
	}
	archive(kept, "promoted", workspace)
	archive(promoted, "promoted", workspace)
	archive(merged, "merged", workspace)
	archive(other, "promoted", elsewhere)
	archive(gone, "merged", workspace)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cka", nil, 204)
	for _, id := range []string{workspace, gone} {
		var left bool
		if err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM memory_items WHERE tenant_id=$1 AND id=$2)", tid, id).Scan(&left); err != nil || left {
			t.Fatalf("moved note %s after the deletion of the canvas of its words: kept %v (%v)", id, left, err)
		}
	}
	for id, want := range map[string][3]string{promoted: {"archived", "unused", ""}, merged: {"archived", "unused", ""}, other: {"archived", "promoted", elsewhere}} {
		if status, reason, by := notes.state(id); [3]string{status, reason, by} != want {
			t.Errorf("note %s after the deletion: %s %q %q, want %v", id, status, reason, by, want)
		}
	}
	var version int64
	if err := h.db.QueryRow(ctx, "SELECT version FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, promoted).Scan(&version); err != nil || version != 3 {
		t.Errorf("the version of a note archived as unused after the deletion: %d %v", version, err)
	}
}

// AwwO's note archived as restating a person's own, deleted, sets aside AwwO's notes that say what it said as out of
// date, its learning since, whose deletion leaves a dismissal; a person's text archived so sets them aside as restating
// a person's note still.
func TestPostgresADeletedRestatementSetsAsideAwwOsNotesAsOutdated(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-restated-echo@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ct',$1,'Restated')", tid)
	notes := cycleNotes{t, h, tid}
	dismissals := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	echo := notes.add("ct", "Captions sit under images", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("ct", "Captions sit under every image", user), nil, 200)
	if status, reason, _ := notes.state(echo); status != "archived" || reason != "restated" {
		t.Fatalf("AwwO's note saying what a person deleted of their own: %s %q", status, reason)
	}
	fresh := notes.add("ct", "Captions sit under images at a small size", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+echo, nil, 200)
	if status, reason, _ := notes.state(fresh); status != "archived" || reason != "outdated" {
		t.Fatalf("AwwO's note in use saying what a deleted restatement said: %s %q", status, reason)
	}
	if n := dismissals(); n != 1 {
		t.Fatalf("a deleted restatement left %d dismissals", n)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+fresh, nil, 200)
	if n := dismissals(); n != 2 {
		t.Fatalf("AwwO's note set aside for a deleted restatement, deleted, left %d dismissals", n)
	}
	// So does a change of its text.
	changed := notes.add("ct", "Links are underlined", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='restated' WHERE tenant_id=$1 AND id=$2", tid, changed)
	since := notes.add("ct", "Links are underlined in body text", "")
	note := listedNote(t, h, c, tid, "ct", changed)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+changed, map[string]any{"version": note["version"], "title": "Links are bold"}, 200)
	if status, reason, _ := notes.state(since); status != "archived" || reason != "outdated" {
		t.Fatalf("AwwO's note in use saying what a changed restatement said: %s %q", status, reason)
	}
	// A person's text archived as restating one: theirs, as any of their notes.
	theirs := notes.add("ct", "Footers carry the brand mark", user)
	exec("UPDATE memory_items SET status='archived',archived_reason='restated' WHERE tenant_id=$1 AND id=$2", tid, theirs)
	alike := notes.add("ct", "Footers carry the brand mark in grey", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+theirs, nil, 200)
	if status, reason, _ := notes.state(alike); status != "archived" || reason != "restated" {
		t.Fatalf("AwwO's note saying what a person's text archived as a restatement said: %s %q", status, reason)
	}
}

// A cycle's merge is taken back only while the note it kept is as the merge left it: once a person changed that note's
// text, the notes merged into it stay as they are, though they say nothing of the old text by the rule of a deletion.
func TestPostgresAMergeIntoANoteAPersonChangedIsNotTakenBack(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-merge-changed@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cg',$1,'Merged')", tid)
	notes := cycleNotes{t, h, tid}
	kept, merged := notes.add("cg", "Headlines use Fraunces at a heavy weight", ""), notes.add("cg", "Fraunces headlines look elegant", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='merged',successor_id=$3,version=2 WHERE tenant_id=$1 AND id=$2", tid, merged, kept)
	exec("INSERT INTO learning_cycles(id,tenant_id,state,finished_at) VALUES('cycle-changed',$1,'done',clock_timestamp())", tid)
	exec(`INSERT INTO learning_changes(id,tenant_id,cycle_id,kind,canvas_id,item_id,sources,before) VALUES('change-changed',$1,'cycle-changed','merge_notes','cg',$2,ARRAY[$3],$4)`,
		tid, kept, merged, jsonBytes(map[string]any{"created": false, "notes": []archivedNote{{ID: merged, Version: 1, Status: "active"}}, "itemVersion": 1}))
	if !changeUndoable(t, h, c, tid, "change-changed") {
		t.Fatal("a merge left as it was is not offered to be taken back")
	}
	note := listedNote(t, h, c, tid, "cg", kept)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+kept, map[string]any{"version": note["version"], "title": "Headlines use Lato"}, 200)
	if status, reason, _ := notes.state(merged); status != "archived" || reason != "merged" {
		t.Fatalf("the merged note after the kept note's change: %s %q", status, reason)
	}
	if changeUndoable(t, h, c, tid, "change-changed") {
		t.Fatal("a merge into a note a person changed since is offered to be taken back")
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/learning/changes/change-changed/undo", map[string]any{}, 409)
	if status, _, _ := notes.state(merged); status != "archived" {
		t.Fatalf("a note merged into one a person changed came back: %s", status)
	}
}

// The distiller's pool read again is held to the dismissals there in other words too: a note of the whole workspace
// that says what a dismissal in the canvas holds back is no longer distilled from there.
func TestPostgresTheDistillersPoolIsHeldToDismissalsInOtherWords(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	_, tid, _ := h.register(t, "guard-pool-words@example.test")
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES('cq',$1,'Words')", tid); err != nil {
		t.Fatal(err)
	}
	notes := cycleNotes{t, h, tid}
	workspace := notes.add("", "Buttons are rounded with soft corners", "")
	pool, _, err := h.a.distillationPool(ctx, tid, "cq")
	if err != nil {
		t.Fatal(err)
	}
	if _, in := pool[workspace]; !in {
		t.Fatal("the workspace's note is not in the canvas's pool")
	}
	ids := slices.Collect(maps.Keys(pool))
	gone := func() bool {
		t.Helper()
		tx, err := h.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		held, err := h.a.poolDismissed(ctx, tx, tid, "cq", ids)
		if err != nil {
			t.Fatal(err)
		}
		return held
	}
	if gone() {
		t.Fatal("a pool no dismissal holds back was held back")
	}
	held := h.a.heldWordsOf(tid, noteText{"Buttons are rounded", "", "style"})
	if _, err := h.db.Exec(ctx, "INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash,terms,numbers,parts,kind) VALUES($1,'cq',$2,$3,$4,$5,'style')",
		tid, held.Hash, held.Terms, append([]string{}, held.Numbers...), jsonBytes(append([]heldPart{}, held.Parts...))); err != nil {
		t.Fatal(err)
	}
	if !gone() {
		t.Fatal("a pool note a dismissal in the canvas holds back in other words was not held back")
	}
}

// A note a cycle moved to the whole workspace goes with the last canvas whose words it holds, though a person archived
// it, brought it back or confirmed it; one they pinned, or whose text they changed, stays.
func TestPostgresAMovedNoteGoesWithItsCanvasUnlessPinnedOrChanged(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-moved-goes@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cx',$1,'Words')", tid)
	notes := cycleNotes{t, h, tid}
	moved := func(title string) string {
		t.Helper()
		id := notes.add("", title, "")
		exec("UPDATE memory_items SET origin='evolution',written_hash=content_hash WHERE tenant_id=$1 AND id=$2", tid, id)
		exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'cx',true)", tid, id)
		return id
	}
	patch := func(id string, fields map[string]any) {
		t.Helper()
		fields["version"] = listedNote(t, h, c, tid, "", id)["version"]
		h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+id, fields, 200)
	}
	archived, confirmed, kinded, pinned, changed := moved("Tables use zebra stripes"), moved("Tables keep a header row"), moved("Tables keep a footer row"),
		moved("Tables keep a total row"), moved("Tables align numbers right")
	exec("UPDATE memory_items SET status='proposed' WHERE tenant_id=$1 AND id=$2", tid, confirmed)
	patch(archived, map[string]any{"status": "archived"})
	patch(confirmed, map[string]any{"status": "active"})
	patch(kinded, map[string]any{"kind": "style"})
	patch(pinned, map[string]any{"pinned": true})
	patch(changed, map[string]any{"title": "Tables align numbers to the right"})
	changedArchived := moved("Tables wrap long text")
	patch(changedArchived, map[string]any{"title": "Tables wrap long text in cells"})
	patch(changedArchived, map[string]any{"status": "archived"})
	// One merged into a note that goes, which a person pinned through the API: unused, and theirs, both.
	mergedPinned := moved("Tables keep a subtotal row")
	exec("UPDATE memory_items SET status='archived',archived_reason='merged',successor_id=$3,pinned=true,updated_by=$4 WHERE tenant_id=$1 AND id=$2", tid, mergedPinned, confirmed, user)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cx", nil, 204)
	if status, reason, by := notes.state(mergedPinned); status != "archived" || reason != "unused" || by != "" {
		t.Errorf("a pinned note merged into one that went: %s %q %q", status, reason, by)
	}
	var settled bool
	if err := h.db.QueryRow(ctx, "SELECT written_hash='' AND prompt_version='' FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, mergedPinned).Scan(&settled); err != nil || !settled {
		t.Errorf("a pinned note merged into one that went, made its person's: %v %v", settled, err)
	}
	kept := func(when string, want map[string]bool) {
		t.Helper()
		for id, want := range want {
			var left bool
			if err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM memory_items WHERE tenant_id=$1 AND id=$2)", tid, id).Scan(&left); err != nil || left != want {
				t.Errorf("note %s %s: kept %v, want %v (%v)", id, when, left, want, err)
			}
		}
	}
	kept("after the deletion of the canvas of its words", map[string]bool{archived: false, confirmed: false, kinded: false, pinned: true, changed: true,
		changedArchived: true})
	// Theirs for good: unpinned, or changed back to AwwO's words, either stays through the deletion of another canvas.
	patch(pinned, map[string]any{"pinned": false})
	patch(changed, map[string]any{"title": "Tables align numbers right"})
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cy',$1,'Other')", tid)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cy", nil, 204)
	kept("unpinned or changed back, after the deletion of another canvas", map[string]bool{pinned: true, changed: true})
}

// AwwO's notes set aside for saying what a person's own note said keep nothing of it: deleted or changed, they leave a
// dismissal of their very text alone, no word of it, and a note of the whole workspace held back in a canvas for a
// person's text, or for a restatement of it, is held by its very text alone; one held back by its very text keeps the
// words a dismissal of AwwO's text held before; and a text so set aside in a canvas is wrong there, given there by no
// note of the whole workspace nor moved to it.
func TestPostgresARestatementOfAPersonsNoteKeepsItsVeryTextAlone(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-restated@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cr',$1,'Restated'),('cs',$1,'Other')", tid)
	notes := cycleNotes{t, h, tid}
	dismissals := func() int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	echo, other := notes.add("cr", "Captions sit under images", ""), notes.add("cr", "Captions are placed under images", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cr", "Captions sit under every image", user), nil, 200)
	for _, id := range []string{echo, other} {
		if status, reason, _ := notes.state(id); status != "archived" || reason != "restated" {
			t.Fatalf("AwwO's note saying what a person deleted of their own: %s %q", status, reason)
		}
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+echo, nil, 200)
	note := listedNote(t, h, c, tid, "cr", other)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+other, map[string]any{"version": note["version"], "title": "Captions go under images"}, 200)
	if n := dismissals(); n != 2 {
		t.Fatalf("restatements of a person's note, deleted or changed, left %d dismissals", n)
	}
	var worded int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND (cardinality(terms)>0 OR cardinality(numbers)>0 OR parts<>'[]'::jsonb)", tid).Scan(&worded); err != nil || worded != 0 {
		t.Fatalf("restatements of a person's note kept %d dismissals of their words: %v", worded, err)
	}
	// Their very texts are not kept there again; other words of the same are, and nothing elsewhere.
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		canvas, title string
		want          bool
	}{{"cr", "Captions sit under images", true}, {"cr", "Captions are placed under images", true}, {"cr", "Captions sit beneath every image", false},
		{"cs", "Captions sit under images", false}} {
		if held, err := h.a.noteDismissed(ctx, tx, tid, c.canvas, c.title, "", "preference"); err != nil || held != c.want {
			t.Errorf("%q in %s held back after a restatement of a person's note was deleted or changed: %v, want %v (%v)", c.title, c.canvas, held, c.want, err)
		}
	}
	tx.Rollback(ctx)
	// Held back for AwwO's text first, then for a person's, the workspace's note keeps the words of the first.
	workspace := notes.add("", "Footers carry the brand mark", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cs", "Footers carry the brand mark", ""), nil, 200)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cs", "Footers carry the brand mark", user), nil, 200)
	var words int
	if err := h.db.QueryRow(ctx, "SELECT cardinality(terms) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cs' AND content_hash=$2",
		tid, h.a.dismissalHash(tid, memoryContentHash("Footers carry the brand mark", ""))).Scan(&words); err != nil || words == 0 {
		t.Fatalf("the words of AwwO's text held back in the canvas, once held back for a person's: %d %v", words, err)
	}
	if status, _, _ := notes.state(workspace); status != "active" {
		t.Fatalf("the workspace's note held back in a canvas: %s", status)
	}
	// Held back for a person's text alone, a workspace's note is held by the hash of its text, no word of it.
	alone := notes.add("", "Tables use zebra stripes", "")
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("cs", "Tables use zebra stripes", user), nil, 200)
	if err := h.db.QueryRow(ctx, "SELECT cardinality(terms)+cardinality(numbers)+jsonb_array_length(parts) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cs' AND content_hash=$2",
		tid, h.a.dismissalHash(tid, memoryContentHash("Tables use zebra stripes", ""))).Scan(&words); err != nil || words != 0 {
		t.Fatalf("a workspace's note held back in a canvas for a person's text keeps %d of its words: %v", words, err)
	}
	if status, _, _ := notes.state(alone); status != "active" {
		t.Fatalf("the workspace's note held back in a canvas for a person's text: %s", status)
	}
	// So does the deletion of a restatement of a person's note: the workspace's note said what the person's said.
	echoed := notes.add("", "Quotes use curly marks", "")
	restatement := notes.add("cs", "Quotes use curly marks everywhere", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='restated' WHERE tenant_id=$1 AND id=$2", tid, restatement)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+restatement, nil, 200)
	if err := h.db.QueryRow(ctx, "SELECT cardinality(terms)+cardinality(numbers)+jsonb_array_length(parts) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='cs' AND content_hash=$2",
		tid, h.a.dismissalHash(tid, memoryContentHash("Quotes use curly marks", ""))).Scan(&words); err != nil || words != 0 {
		t.Fatalf("a workspace's note held back in a canvas for a restatement's deletion keeps %d of its words: %v", words, err)
	}
	if status, _, _ := notes.state(echoed); status != "active" {
		t.Fatalf("the workspace's note held back in a canvas for a restatement's deletion: %s", status)
	}
	// A text archived in a canvas as restating a person's note: wrong there.
	set := notes.add("cs", "Links are underlined", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='restated' WHERE tenant_id=$1 AND id=$2", tid, set)
	given := notes.add("", "Links are underlined", "")
	tx, err = h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if there, err := noteArchivedThere(ctx, tx, tid, "", memoryContentHash("Links are underlined", "")); err != nil || !there {
		t.Fatalf("a text a canvas set aside as restating a person's note, moved to the workspace: %v %v", !there, err)
	}
	memory, err := h.a.freezeMemoryContext(ctx, tx, tid, "cs", "links underlined", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range memoryItemsOf(memory) {
		if item.ID == given {
			t.Fatal("the workspace's note of a text a canvas set aside as restating a person's note, given there")
		}
	}
}

// A replacement a person brought back from a cycle's change (kept apart) is set aside as any other once a person makes
// the note it would replace theirs, or another replacement takes that note's place; and none on probation comes into use
// once the note it would replace may no longer be replaced (a person archived it).
func TestPostgresAReplacementBroughtBackIsSetAsideAsAnyOther(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, user := h.register(t, "guard-replacement-back@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cb',$1,'Back')", tid)
	notes := cycleNotes{t, h, tid}
	blue, red := notes.add("cb", "Headlines are blue", ""), notes.probation("cb", "Headlines are red")
	exec("UPDATE memory_items SET replaces_id=$3,kept_apart=true WHERE tenant_id=$1 AND id=$2", tid, red, blue)
	note := listedNote(t, h, c, tid, "cb", blue)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+blue, map[string]any{"version": note["version"], "title": "Headlines are green"}, 200)
	if status, reason, _ := notes.state(red); status != "archived" || reason != "outdated" {
		t.Fatalf("a replacement kept apart, once a person changed the note it would replace: %s %q", status, reason)
	}
	dark, grey, light := notes.add("cb", "Pages are dark", ""), notes.probation("cb", "Pages are grey"), notes.probation("cb", "Pages are light")
	exec("UPDATE memory_items SET replaces_id=$2 WHERE tenant_id=$1 AND id=ANY($3)", tid, dark, []string{grey, light})
	exec("UPDATE memory_items SET kept_apart=true WHERE tenant_id=$1 AND id=$2", tid, grey)
	keepNotesOf(t, h, tid, "cb", user, false, memoryDistillNote{Op: "replace", ID: dark, Kind: "preference", Title: "Pages are light"})
	if status, reason, by := notes.state(grey); status != "archived" || reason != "superseded" || by != light {
		t.Fatalf("a rival kept apart, once another took the place of the note it would replace: %s %s %s", status, reason, by)
	}
	plain, bold := notes.add("cb", "Captions are plain", ""), notes.probation("cb", "Captions are bold")
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, bold, plain)
	note = listedNote(t, h, c, tid, "cb", plain)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+plain, map[string]any{"version": note["version"], "status": "archived"}, 200)
	keepNotesOf(t, h, tid, "cb", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: "Captions are bold"})
	var evidence int
	if err := h.db.QueryRow(ctx, "SELECT evidence FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, bold).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := notes.state(bold); status != "proposed" || evidence != 1 {
		t.Fatalf("a replacement of a note a person archived, written again: %s, borne out %d times", status, evidence)
	}
	// Nor once a tidy archived it, as AwwO's.
	blueLinks, redLinks := notes.add("cb", "Links are blue", ""), notes.probation("cb", "Links are red")
	exec("UPDATE memory_items SET status='archived',archived_reason='tidied' WHERE tenant_id=$1 AND id=$2", tid, blueLinks)
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, redLinks, blueLinks)
	keepNotesOf(t, h, tid, "cb", user, false, memoryDistillNote{Op: "add", Kind: "preference", Title: "Links are red"})
	if status, _, _ := notes.state(redLinks); status != "proposed" {
		t.Fatalf("a replacement of a note a tidy archived, written again: %s", status)
	}
	// A note a replacement took the place of, which a person brings back, sets that replacement aside.
	oldTagline, newTagline := notes.add("cb", "Taglines are short", ""), notes.add("cb", "Taglines are long", "")
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, newTagline, oldTagline)
	exec("UPDATE memory_items SET status='archived',archived_reason='superseded',successor_id=$3 WHERE tenant_id=$1 AND id=$2", tid, oldTagline, newTagline)
	note = listedNote(t, h, c, tid, "cb", oldTagline)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+oldTagline, map[string]any{"version": note["version"], "status": "active"}, 200)
	if status, reason, _ := notes.state(newTagline); status != "archived" || reason != "outdated" {
		t.Fatalf("a replacement in use once a person brought back the note it took the place of: %s %q", status, reason)
	}
	// So is one a tidy archived since, which an undo of the tidy would bring back beside it.
	oldMotto, newMotto := notes.add("cb", "Mottos are short", ""), notes.add("cb", "Mottos are long", "")
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, newMotto, oldMotto)
	exec("UPDATE memory_items SET status='archived',archived_reason='superseded',successor_id=$3 WHERE tenant_id=$1 AND id=$2", tid, oldMotto, newMotto)
	exec("UPDATE memory_items SET status='archived',archived_reason='tidied' WHERE tenant_id=$1 AND id=$2", tid, newMotto)
	note = listedNote(t, h, c, tid, "cb", oldMotto)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+oldMotto, map[string]any{"version": note["version"], "status": "active"}, 200)
	if status, reason, _ := notes.state(newMotto); status != "archived" || reason != "outdated" {
		t.Fatalf("a replacement a tidy archived once a person brought back the note it took the place of: %s %q", status, reason)
	}
	// A person's confirm takes the place of a note a person brought back from a cycle's change, kept apart, as of any.
	greyFooters, whiteFooters := notes.add("cb", "Footers are grey", ""), notes.probation("cb", "Footers are white")
	exec("UPDATE memory_items SET kept_apart=true WHERE tenant_id=$1 AND id=$2", tid, greyFooters)
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, whiteFooters, greyFooters)
	note = listedNote(t, h, c, tid, "cb", whiteFooters)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+whiteFooters, map[string]any{"version": note["version"], "status": "active"}, 200)
	if status, reason, by := notes.state(greyFooters); status != "archived" || reason != "superseded" || by != whiteFooters {
		t.Fatalf("a note kept apart whose replacement a person confirmed: %s %s %s", status, reason, by)
	}
}

// A hold of a note of the whole workspace in a canvas goes with the canvases whose words the note holds as it holds them
// now: one it came to hold later keeps the hold, as it keeps the note, once the first is deleted; once none is left,
// both go.
func TestPostgresAHoldGoesWithTheCanvasesANoteHoldsNow(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-hold-links@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('c1',$1,'First'),('c3',$1,'Third'),('ch',$1,'Held')", tid)
	notes := cycleNotes{t, h, tid}
	const text = "Footers carry the brand mark"
	moved := notes.add("", text, "")
	exec("UPDATE memory_items SET origin='evolution',written_hash=content_hash WHERE tenant_id=$1 AND id=$2", tid, moved)
	exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,'c1',true)", tid, moved)
	// The hold itself: the dismissal of the workspace's note's text in ch (the deleted note's own, of other words, holds
	// most of the same back as well, and is no hold of the workspace's note).
	held := func(when string, want bool) {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND canvas_id='ch' AND content_hash=$2 AND canvas_words",
			tid, h.a.dismissalHash(tid, memoryContentHash(text, ""))).Scan(&n); err != nil || (n == 1) != want {
			t.Fatalf("the workspace's note held back in a canvas %s: %d holds, want %v (%v)", when, n, want, err)
		}
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+notes.add("ch", text+" in grey", ""), nil, 200)
	held("once a note there that said it was deleted", true)
	copied := notes.add("c3", text, "")
	exec("UPDATE memory_items SET status='archived',archived_reason='promoted',successor_id=$3 WHERE tenant_id=$1 AND id=$2", tid, copied, moved)
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.a.recordNoteCanvases(ctx, tx, tid, moved, []string{copied}, []string{copied}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/c1", nil, 204)
	if status, _, _ := notes.state(moved); status != "active" {
		t.Fatalf("a moved note holding the words of a canvas left: %s", status)
	}
	held("once the first canvas of its words is deleted", true)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/c3", nil, 204)
	held("once none of the canvases of its words is left", false)
}

// A text of AwwO's a person changed is theirs whatever they do with the note after: pinned, of another kind or
// archived, its deletion leaves nothing of their text, only the dismissal of AwwO's they changed; and so for a note
// written before the hash of AwwO's text was kept.
func TestPostgresATextAPersonChangedStaysTheirs(t *testing.T) {
	h := newHarness(t, "")
	learnFromRuns(h)
	c, tid, _ := h.register(t, "guard-text-theirs@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('ct',$1,'Theirs')", tid)
	notes := cycleNotes{t, h, tid}
	dismissed := func(title string) int {
		t.Helper()
		var n int
		if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissals WHERE tenant_id=$1 AND content_hash=$2", tid, h.a.dismissalHash(tid, memoryContentHash(title, ""))).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	patch := func(id string, fields map[string]any) {
		t.Helper()
		fields["version"] = listedNote(t, h, c, tid, "ct", id)["version"]
		h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+id, fields, 200)
	}
	written := func(id string) string {
		t.Helper()
		var hash string
		if err := h.db.QueryRow(ctx, "SELECT written_hash FROM memory_items WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&hash); err != nil {
			t.Fatal(err)
		}
		return hash
	}
	// No hash of AwwO's text stays on a note whose text a person changed.
	changedOnce := notes.add("ct", "Tables keep a summary row", "")
	exec("UPDATE memory_items SET written_hash=content_hash,prompt_version='abc' WHERE tenant_id=$1 AND id=$2", tid, changedOnce)
	patch(changedOnce, map[string]any{"title": "Tables keep a summary row in grey"})
	if hash := written(changedOnce); hash != "" {
		t.Errorf("a note whose text a person changed keeps the hash of AwwO's text: %q", hash)
	}
	// A note AwwO archived as restating a person's note, which a person restores, is theirs: its deletion keeps nothing.
	restored := notes.add("ct", "Captions use small caps", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='restated',written_hash=content_hash,prompt_version='abc' WHERE tenant_id=$1 AND id=$2", tid, restored)
	note := listedNote(t, h, c, tid, "ct", restored)
	h.request(t, c, "PATCH", "/tenants/"+tid+"/memory/"+restored, map[string]any{"version": note["version"], "status": "active"}, 200)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+restored, nil, 200)
	if n := dismissed("Captions use small caps"); n != 0 {
		t.Errorf("a restated note a person restored, deleted, left %d dismissals", n)
	}
	for i, then := range []map[string]any{{"pinned": true}, {"kind": "style"}, {"status": "archived"}} {
		written := []string{"Tables keep a header row", "Tables keep a footer row", "Tables keep a total row"}[i]
		id := notes.add("ct", written, "")
		if i < 2 {
			exec("UPDATE memory_items SET written_hash=content_hash,prompt_version='abc' WHERE tenant_id=$1 AND id=$2", tid, id)
		}
		theirs := written + " in bold"
		patch(id, map[string]any{"title": theirs})
		patch(id, then)
		h.request(t, c, "DELETE", "/tenants/"+tid+"/memory/"+id, nil, 200)
		if dismissed(written) != 1 || dismissed(theirs) != 0 {
			t.Errorf("a text a person changed, then %v, deleted: AwwO's text dismissed %d times, theirs %d", then, dismissed(written), dismissed(theirs))
		}
	}
}

// A dismissal keeps a note's sentences and clauses in an order of what each holds, not the note's: two notes of the same
// parts in other orders keep the very same.
func TestADismissalKeepsNoOrderOfItsNote(t *testing.T) {
	a := &App{cfg: Config{CredentialKey: bytes.Repeat([]byte{7}, 32)}}
	for _, pair := range [][2]noteText{
		{{"Type scale", "12, 14, 16", "style"}, {"Type scale", "16, 12, 14", "style"}},
		{{"Cards", "Cards use 2 columns. Cards use 4 columns.", "style"}, {"Cards", "Cards use 4 columns. Cards use 2 columns.", "style"}},
	} {
		if x, y := jsonBytes(a.heldWordsOf("tenant-order", pair[0]).Parts), jsonBytes(a.heldWordsOf("tenant-order", pair[1]).Parts); string(x) != string(y) {
			t.Errorf("%q and %q keep their parts in their own orders: %s, %s", pair[0].body, pair[1].body, x, y)
		}
	}
}
