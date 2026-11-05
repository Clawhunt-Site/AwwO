package app

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// A workspace's learning settings: neither is offered until the deployment offers it. Self-learning is on wherever it is
// offered unless an admin turned it off (which they may do even before it is offered), and on again from when it was
// turned back on; Help improve AwwO only the owner turns on, and on again keeps when it was first given. Every member
// reads both, and each change is audited.
func TestPostgresLearningSettings(t *testing.T) {
	h := newHarness(t, "")
	c, tid, _ := h.register(t, "learning@example.test")
	path := "/tenants/" + tid + "/learning"
	setting := func(v map[string]any, name string) (bool, bool, any) {
		t.Helper()
		s, _ := v[name].(map[string]any)
		return s["offered"] == true, s["on"] == true, s["since"]
	}
	view := h.request(t, c, "GET", path, nil, 200)
	if offered, on, since := setting(view, "consent"); offered || on || since != nil {
		t.Fatal("the consent before it is offered", view)
	}
	if offered, on, since := setting(view, "selfLearning"); offered || on || since != nil {
		t.Fatal("self-learning before it is offered", view)
	}
	if _, old := view["memorySuggestions"]; old {
		t.Fatal("052's memory suggestions are still read", view)
	}
	h.request(t, c, "PUT", path, map[string]any{"consent": true}, 409)
	h.request(t, c, "PUT", path, map[string]any{"selfLearning": true}, 409)
	h.request(t, c, "PUT", path, map[string]any{"memorySuggestions": true}, 400)
	// Turned off ahead of the offer, it is off once offered.
	h.request(t, c, "PUT", path, map[string]any{"selfLearning": false}, 200)
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	h.a.cfg.LearningConsent, h.a.cfg.SelfLearning, h.a.cfg.SelfLearningSince = true, true, start
	if offered, on, since := setting(h.request(t, c, "GET", path, nil, 200), "selfLearning"); !offered || on || since != nil {
		t.Fatal("self-learning turned off before it was offered", offered, on, since)
	}
	h.request(t, c, "PUT", path, map[string]any{}, 400)
	on := h.request(t, c, "PUT", path, map[string]any{"consent": true, "selfLearning": true}, 200)
	offered, isOn, since := setting(on, "consent")
	if !offered || !isOn || since == nil {
		t.Fatal("the owner's consent", on)
	}
	if _, isOn, back := setting(on, "selfLearning"); !isOn || back == nil || back == start.Format(time.RFC3339Nano) {
		t.Fatal("self-learning turned on again, since then", on)
	}
	// On again: the same moment for both.
	again := h.request(t, c, "PUT", path, map[string]any{"consent": true, "selfLearning": true}, 200)
	if _, _, later := setting(again, "consent"); later != since {
		t.Fatalf("the consent turned on again from %v to %v", since, later)
	}
	_, _, onSince := setting(on, "selfLearning")
	if _, _, later := setting(again, "selfLearning"); later != onSince {
		t.Fatalf("self-learning on again moved its time from %v to %v", onSince, later)
	}
	// A workspace that never turned it off learns since the deployment began to offer it.
	fresh, freshTID, _ := h.register(t, "learning-fresh@example.test")
	if _, isOn, since := setting(h.request(t, fresh, "GET", "/tenants/"+freshTID+"/learning", nil, 200), "selfLearning"); !isOn || since == nil {
		t.Fatal("a workspace's self-learning by default", isOn, since)
	} else if when, err := time.Parse(time.RFC3339Nano, since.(string)); err != nil || !when.Equal(start) {
		t.Fatalf("on since %v, not the deployment's start", since)
	}
	// An admin may turn self-learning off, never the consent; a member changes neither and reads both.
	o, _, other := h.register(t, "learning-admin@example.test")
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", tid, other); e != nil {
		t.Fatal(e)
	}
	h.request(t, o, "PUT", path, map[string]any{"consent": false}, 403)
	// 052's memory suggestions, on from before: turning self-learning off turns them off too.
	if _, e := h.db.Exec(ctx, "UPDATE workspace_learning SET suggestions_at=now() WHERE tenant_id=$1", tid); e != nil {
		t.Fatal(e)
	}
	off := h.request(t, o, "PUT", path, map[string]any{"selfLearning": false}, 200)
	var suggestions *time.Time
	if e := h.db.QueryRow(ctx, "SELECT suggestions_at FROM workspace_learning WHERE tenant_id=$1", tid).Scan(&suggestions); e != nil || suggestions != nil {
		t.Fatalf("052's memory suggestions after self-learning was turned off: %v %v", suggestions, e)
	}
	if _, isOn, since := setting(off, "selfLearning"); isOn || since != nil {
		t.Fatal("self-learning an admin turned off", off)
	}
	if _, isOn, _ := setting(off, "consent"); !isOn {
		t.Fatal("the consent changed with self-learning", off)
	}
	var offBy string
	if e := h.db.QueryRow(ctx, "SELECT learning_off_by FROM workspace_learning WHERE tenant_id=$1", tid).Scan(&offBy); e != nil || offBy != other {
		t.Fatalf("turned off by %q: %v", offBy, e)
	}
	// Off again keeps who turned it off first.
	h.request(t, c, "PUT", path, map[string]any{"selfLearning": false}, 200)
	if e := h.db.QueryRow(ctx, "SELECT learning_off_by FROM workspace_learning WHERE tenant_id=$1", tid).Scan(&offBy); e != nil || offBy != other {
		t.Fatalf("turned off again, now by %q: %v", offBy, e)
	}
	if _, e := h.db.Exec(ctx, "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2", tid, other); e != nil {
		t.Fatal(e)
	}
	h.request(t, o, "PUT", path, map[string]any{"selfLearning": true}, 403)
	if read := h.request(t, o, "GET", path, nil, 200); read["consent"].(map[string]any)["on"] != true {
		t.Fatal("a member's view", read)
	}
	// A consent is its giver's: given by someone who no longer owns the workspace, it holds no more, and the owner gives
	// it anew.
	if _, e := h.db.Exec(ctx, "UPDATE workspace_learning SET consent_by=$2 WHERE tenant_id=$1", tid, other); e != nil {
		t.Fatal(e)
	}
	if _, isOn, _ := setting(h.request(t, c, "GET", path, nil, 200), "consent"); isOn {
		t.Fatal("a consent its giver no longer owns the workspace for")
	}
	anew := h.request(t, c, "PUT", path, map[string]any{"consent": true}, 200)
	if _, isOn, later := setting(anew, "consent"); !isOn || later == since {
		t.Fatalf("given anew: %v, from %v to %v", isOn, since, later)
	}
	// Off clears it.
	cleared := h.request(t, c, "PUT", path, map[string]any{"consent": false}, 200)
	if _, isOn, since := setting(cleared, "consent"); isOn || since != nil {
		t.Fatal("the consent turned off", cleared)
	}
	var audits int
	if e := h.db.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action IN ('learning.consent_on','learning.consent_off',
		'learning.self_learning_on','learning.self_learning_off')`, tid).Scan(&audits); e != nil || audits != 9 {
		t.Fatalf("%d audit events: %v", audits, e)
	}
	// A deployment that stops offering the consent still lets its owner withdraw one given, never give one.
	h.request(t, c, "PUT", path, map[string]any{"consent": true}, 200)
	h.a.cfg.LearningConsent = false
	if offered, isOn, _ := setting(h.request(t, c, "GET", path, nil, 200), "consent"); offered || !isOn {
		t.Fatal("a consent given where it is no longer offered", offered, isOn)
	}
	h.request(t, c, "PUT", path, map[string]any{"consent": true}, 409)
	if _, isOn, _ := setting(h.request(t, c, "PUT", path, map[string]any{"consent": false}, 200), "consent"); isOn {
		t.Fatal("not withdrawn")
	}
	h.a.cfg.LearningConsent = true
	// Their other workspace says where a consent of theirs holds, so the page keeps the way to it.
	h.request(t, c, "PUT", path, map[string]any{"consent": true}, 200)
	var second string
	if e := h.db.QueryRow(ctx, `SELECT m.tenant_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='learning@example.test' AND m.tenant_id<>$1`, tid).Scan(&second); !noRows(e) {
		t.Fatal("the owner has another workspace", second, e)
	}
	if _, e := h.db.Exec(ctx, "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,u.id,'member' FROM users u WHERE u.email='learning@example.test'", freshTID); e != nil {
		t.Fatal(e)
	}
	if elsewhere := h.request(t, c, "GET", "/tenants/"+freshTID+"/learning", nil, 200)["elsewhere"]; elsewhere != true {
		t.Fatal("the owner's consent in another workspace", elsewhere)
	}
	if elsewhere := h.request(t, c, "GET", path, nil, 200)["elsewhere"]; elsewhere != false {
		t.Fatal("elsewhere for the workspace the consent is in", elsewhere)
	}
	// Another workspace's person reads nothing of it.
	stranger, _, _ := h.register(t, "learning-stranger@example.test")
	h.request(t, stranger, "GET", path, nil, 404)
	// The local edition offers no self-learning.
	h.a.cfg.UserCredentials = true
	if h.a.learningView(nil, nil, nil, false)["selfLearning"].(learningSetting).Offered {
		t.Fatal("self-learning offered in the local edition")
	}
	h.a.cfg.UserCredentials = false
}

// AWWO_SELF_LEARNING is on only with the time it was offered from; AWWO_MEMORY_DISTILL, which it replaced, stops the
// start when it is set to anything but off; AWWO_LEARNING_CYCLE_HOURS is a whole number of hours up to 720, unset 72.
func TestParseSelfLearningAndCycleHours(t *testing.T) {
	for _, off := range [][3]string{{"", "", ""}, {"off", "2026-11-04T00:00:00Z", ""}, {"", "", "off"}} {
		if on, since, err := parseSelfLearning(off[0], off[1], off[2]); err != nil || on || !since.IsZero() {
			t.Errorf("%q: %v %v %v", off, on, since, err)
		}
	}
	if on, since, err := parseSelfLearning("on", "2026-11-04T08:00:00+08:00", ""); err != nil || !on || !since.Equal(time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("on: %v %v %v", on, since, err)
	}
	for _, bad := range [][3]string{{"on", "", ""}, {"on", "tomorrow", ""}, {"yes", "", ""}, {"", "", "on"}, {"on", "2026-11-04T00:00:00Z", "on"}, {"on", "2025-11-04T00:00:00Z", ""}} {
		if _, _, err := parseSelfLearning(bad[0], bad[1], bad[2]); err == nil {
			t.Errorf("%q taken", bad)
		}
	}
	for raw, want := range map[string]time.Duration{"": 72 * time.Hour, "0": 0, "1": time.Hour, "720": 720 * time.Hour} {
		if got, err := parseLearningCycleHours(raw); err != nil || got != want {
			t.Errorf("%q: %v %v", raw, got, err)
		}
	}
	for _, bad := range []string{"-1", "721", "3d", "1.5"} {
		if _, err := parseLearningCycleHours(bad); err == nil {
			t.Errorf("%q taken", bad)
		}
	}
	// On, it needs the credential key, which the hashes of the notes people delete are keyed with.
	c := testConfig()
	c.SelfLearning = true
	if c.Validate() == nil {
		t.Fatal("self-learning on without a credential key")
	}
	c.CredentialKey = []byte(strings.Repeat("k", 32))
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

// readmeStatement is the SQL statement of backend/README.md whose block begins with the comment marker.
func readmeStatement(t *testing.T, marker string) string {
	t.Helper()
	raw, err := os.ReadFile("../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	at := strings.Index(text, "-- "+marker+":")
	if at < 0 {
		t.Fatalf("backend/README.md has no %s statement", marker)
	}
	block := text[at:]
	block = block[strings.Index(block, "\n")+1:]
	return strings.TrimSpace(block[:strings.Index(block, "```")])
}

// The rollback of migration 055 that backend/README.md gives works as it says: before an API from before 055 starts, the
// notes AwwO keeps in use become proposals, which it never gives, people's notes and those a person pinned staying in
// use; when this release starts again, those borne out come back into use, one a person pinned under the older API among
// them, and those on probation stay proposed.
func TestPostgresTheRollbackOf055IsAsTheReadmeSays(t *testing.T) {
	h := newHarness(t, "")
	c, tid, user := h.register(t, "rollback-055@example.test")
	ctx := context.Background()
	cid := retryCanvas(t, h, c, tid)
	notes := cycleNotes{t, h, tid}
	kept, waiting, theirs, pinned := notes.add(cid, "Kept by AwwO", ""), notes.probation(cid, "On probation"), notes.add(cid, "A person's", user), notes.add(cid, "Pinned", "")
	touched := notes.add(cid, "Pinned under the older API", "")
	if _, err := h.db.Exec(ctx, "UPDATE memory_items SET pinned=true WHERE tenant_id=$1 AND id=$2", tid, pinned); err != nil {
		t.Fatal(err)
	}
	states := func() map[string]string {
		t.Helper()
		out := map[string]string{}
		for _, id := range []string{kept, waiting, theirs, pinned, touched} {
			status, _, _ := notes.state(id)
			out[id] = status
		}
		return out
	}
	if _, err := h.db.Exec(ctx, readmeStatement(t, "rollback-055")); err != nil {
		t.Fatal(err)
	}
	if got := states(); got[kept] != "proposed" || got[waiting] != "proposed" || got[theirs] != "active" || got[pinned] != "active" || got[touched] != "proposed" {
		t.Fatalf("after the rollback statement: %v", got)
	}
	// The older API pins a note the rollback set on probation, and leaves it there.
	if _, err := h.db.Exec(ctx, "UPDATE memory_items SET pinned=true,updated_by=$3 WHERE tenant_id=$1 AND id=$2", tid, touched, user); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, readmeStatement(t, "rollforward-055")); err != nil {
		t.Fatal(err)
	}
	if got := states(); got[kept] != "active" || got[waiting] != "proposed" || got[theirs] != "active" || got[pinned] != "active" || got[touched] != "active" {
		t.Fatalf("after the rollforward statement: %v", got)
	}
}

// The backfill of migration 055 that backend/README.md gives fills in, from its snapshot, the notes a run an API from
// before 055 admitted was given, as this release keeps them (the id, the hash of the text, the title and the body of
// each), and none for one given none; a run of this release keeps its own.
func TestPostgresTheBackfillOf055IsAsTheReadmeSays(t *testing.T) {
	h := newHarness(t, "")
	c, tid, _ := h.register(t, "backfill-055@example.test")
	ctx := context.Background()
	_, _, sid := h.fixture(t, c, tid)
	snapshot := jsonBytes(map[string]any{"memory": map[string]any{"text": "Notes", "considered": 1, "items": []map[string]any{
		{"id": "note-1", "contentHash": "hash-1", "title": "Headlines use Fraunces", "body": "At a heavy weight", "kind": "style", "scope": "canvas"}}}})
	older, bare, current := randomID(), randomID(), randomID()
	for _, run := range []struct {
		id       string
		snapshot []byte
		given    any
	}{{older, snapshot, nil}, {bare, []byte("{}"), nil}, {current, snapshot, []byte("[]")}} {
		if _, err := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,execution_snapshot,given_notes) VALUES($1,$2,$3,$1,'hash','test','completed',$4,$5)",
			run.id, tid, sid, run.snapshot, run.given); err != nil {
			t.Fatal(err)
		}
	}
	// The index a failed or cancelled build left, invalid: the first statement drops it, so that the second builds it.
	if _, err := h.db.Exec(ctx, "CREATE INDEX runs_given_notes_unset ON runs(id) WHERE given_notes IS NULL AND status='completed'"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, "UPDATE pg_index SET indisvalid=false WHERE indexrelid=to_regclass('runs_given_notes_unset')"); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"backfill-055-index-drop", "backfill-055-index"} {
		if _, err := h.db.Exec(ctx, readmeStatement(t, statement)); err != nil {
			t.Fatal(statement, err)
		}
	}
	var valid bool
	if err := h.db.QueryRow(ctx, "SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid=to_regclass('runs_given_notes_unset')").Scan(&valid); err != nil || !valid {
		t.Fatalf("the backfill's index: valid %v (%v)", valid, err)
	}
	for rounds := 0; ; rounds++ {
		tag, err := h.db.Exec(ctx, readmeStatement(t, "backfill-055"))
		if err != nil {
			t.Fatal(err)
		}
		if tag.RowsAffected() == 0 {
			break
		}
		if rounds > 10 {
			t.Fatal("the backfill does not end")
		}
	}
	if _, err := h.db.Exec(ctx, readmeStatement(t, "backfill-055-done")); err != nil {
		t.Fatal(err)
	}
	var left bool
	if err := h.db.QueryRow(ctx, "SELECT to_regclass('runs_given_notes_unset') IS NOT NULL").Scan(&left); err != nil || left {
		t.Fatalf("the backfill's index left behind: %v %v", left, err)
	}
	given := func(id string) []map[string]any {
		t.Helper()
		var raw []byte
		if err := h.db.QueryRow(ctx, "SELECT given_notes FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		notes := []map[string]any{}
		if err := json.Unmarshal(raw, &notes); err != nil {
			t.Fatal(err)
		}
		return notes
	}
	want := map[string]any{"id": "note-1", "contentHash": "hash-1", "title": "Headlines use Fraunces", "body": "At a heavy weight"}
	if got := given(older); len(got) != 1 || !maps.Equal(got[0], want) {
		t.Fatalf("an older API's run, filled in: %v", got)
	}
	if got := given(bare); len(got) != 0 {
		t.Fatalf("a run given no notes, filled in: %v", got)
	}
	if got := given(current); len(got) != 0 {
		t.Fatalf("a run of this release, filled in again: %v", got)
	}
}

// The cleanup before the rollforward of migration 055 that backend/README.md gives takes out what an API from before 055
// left of the canvases deleted while it ran: the notes a cycle moved to the whole workspace in their words alone (not one
// a person pinned), the dismissals of their words, and the links of a deleted canvas's own dismissals; and nothing else.
// The notes of other canvases moved or merged into one deleted are archived as unused, in favour of none.
func TestPostgresTheCleanupBeforeTheRollforwardOf055IsAsTheReadmeSays(t *testing.T) {
	h := newHarness(t, "")
	c, tid, user := h.register(t, "cleanup-055@example.test")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cw',$1,'Words'),('cd',$1,'Scope'),('ck',$1,'Kept')", tid)
	notes := cycleNotes{t, h, tid}
	moved := func(title, canvasID string) string {
		t.Helper()
		id := notes.add("", title, "")
		exec("UPDATE memory_items SET origin='evolution',written_hash=content_hash WHERE tenant_id=$1 AND id=$2", tid, id)
		exec("INSERT INTO memory_item_canvases(tenant_id,item_id,canvas_id,words) VALUES($1,$2,$3,true)", tid, id, canvasID)
		return id
	}
	orphan, pinned, kept := moved("Tables use zebra stripes", "cw"), moved("Tables keep a header row", "cw"), moved("Tables keep a footer row", "ck")
	exec("UPDATE memory_items SET pinned=true,updated_by=$3 WHERE tenant_id=$1 AND id=$2", tid, pinned, user)
	// A moved note of cw's words merged into the one deleted, which a person pinned through the API: unused, and theirs.
	pinnedMerged := moved("Tables keep zebra rows", "cw")
	exec("UPDATE memory_items SET status='archived',archived_reason='merged',successor_id=$3,pinned=true,updated_by=$4,version=2 WHERE tenant_id=$1 AND id=$2", tid, pinnedMerged, orphan, user)
	// A moved note of cw's words whose text a person changed under the older API, which kept AwwO's written_hash.
	changed := moved("Tables keep a total row", "cw")
	exec("UPDATE memory_items SET title='Tables keep a total row in bold',content_hash=$3,updated_by=$4 WHERE tenant_id=$1 AND id=$2",
		tid, changed, memoryContentHash("Tables keep a total row in bold", ""), user)
	freed, merged := notes.add("ck", "Tables have zebra stripes", ""), notes.add("ck", "Tables have a footer row", "")
	exec("UPDATE memory_items SET status='archived',archived_reason='promoted',successor_id=$3,version=2 WHERE tenant_id=$1 AND id=$2", tid, freed, orphan)
	exec("UPDATE memory_items SET status='archived',archived_reason='merged',successor_id=$3,version=2 WHERE tenant_id=$1 AND id=$2", tid, merged, kept)
	dismiss := func(scope, hash, words string) {
		t.Helper()
		exec("INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash,canvas_words) VALUES($1,NULLIF($2,''),$3,true)", tid, scope, hash)
		exec("INSERT INTO memory_item_dismissal_canvases(tenant_id,scope,content_hash,canvas_id) VALUES($1,$2,$3,$4)", tid, scope, hash, words)
	}
	dismiss("", "words-of-cw", "cw")
	dismiss("", "words-of-ck", "ck")
	dismiss("cd", "in-cd", "ck")
	// Ordinary dismissals, of no canvas's words: kept whatever canvases go.
	exec("INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash,canvas_words) VALUES($1,NULL,'plain',false),($1,'ck','plain-in-ck',false)", tid)
	// Notes written to replace others, which a person brought into use, or whose note they made theirs, under the older
	// API: the note replaced is superseded, the replacement of a person's note out of date.
	inter, lato := notes.probation("ck", "Headlines use Inter"), notes.add("ck", "Headlines use Lato", "")
	exec("UPDATE memory_items SET evidence=2 WHERE tenant_id=$1 AND id=$2", tid, inter)
	exec("UPDATE memory_items SET replaces_id=$3,updated_by=$4 WHERE tenant_id=$1 AND id=$2", tid, lato, inter, user)
	grey, black := notes.add("ck", "Captions are grey", ""), notes.probation("ck", "Captions are black")
	exec("UPDATE memory_items SET updated_by=$3 WHERE tenant_id=$1 AND id=$2", tid, grey, user)
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, black, grey)
	// A rival of the replacement a person brought into use is superseded by it, as this release has it; a replacement of
	// a person's note in use, or one a tidy archived, is out of date too.
	roboto := notes.probation("ck", "Headlines use Roboto")
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=$2", tid, roboto, inter)
	navy, slate := notes.add("ck", "Captions are navy", ""), notes.add("ck", "Captions are slate", "")
	exec("UPDATE memory_items SET replaces_id=$3 WHERE tenant_id=$1 AND id=ANY($2)", tid, []string{navy, slate}, grey)
	exec("UPDATE memory_items SET status='archived',archived_reason='tidied' WHERE tenant_id=$1 AND id=$2", tid, slate)
	// A replacement a person brought into use of a note brought back from a cycle's change, kept apart, borne out: the
	// note is superseded, as a person's confirm has it in this release, and does not come back into use.
	apart, chosen := notes.probation("ck", "Footers are grey"), notes.add("ck", "Footers are white", "")
	exec("UPDATE memory_items SET evidence=2,kept_apart=true WHERE tenant_id=$1 AND id=$2", tid, apart)
	exec("UPDATE memory_items SET replaces_id=$3,updated_by=$4 WHERE tenant_id=$1 AND id=$2", tid, chosen, apart, user)
	// The older API deletes two canvases without this release's cleanups.
	exec("DELETE FROM canvases WHERE tenant_id=$1 AND id IN ('cw','cd')", tid)
	exec(readmeStatement(t, "rollforward-055-cleanup"))
	exec(readmeStatement(t, "rollforward-055"))
	left := func(when string, want map[string]bool) {
		t.Helper()
		for id, want := range want {
			var left bool
			if err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM memory_items WHERE tenant_id=$1 AND id=$2)", tid, id).Scan(&left); err != nil || left != want {
				t.Errorf("note %s %s: kept %v, want %v (%v)", id, when, left, want, err)
			}
		}
	}
	left("after the cleanup", map[string]bool{orphan: false, pinned: true, kept: true, changed: true, pinnedMerged: true})
	// The notes it spared are their people's for good: unpinned, or changed back, they stay through another deletion.
	var settled int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_items WHERE tenant_id=$1 AND id=ANY($2) AND written_hash='' AND prompt_version=''", tid, []string{pinned, changed, pinnedMerged}).Scan(&settled); err != nil || settled != 3 {
		t.Errorf("the notes the cleanup spared, made their people's: %d of 3 (%v)", settled, err)
	}
	exec("UPDATE memory_items SET pinned=false WHERE tenant_id=$1 AND id=$2", tid, pinned)
	exec("UPDATE memory_items SET title='Tables keep a total row',content_hash=$3 WHERE tenant_id=$1 AND id=$2", tid, changed, memoryContentHash("Tables keep a total row", ""))
	exec("INSERT INTO canvases(id,tenant_id,name) VALUES('cz',$1,'Another')", tid)
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/cz", nil, 204)
	left("unpinned or changed back, after another canvas's deletion", map[string]bool{pinned: true, changed: true})
	for id, want := range map[string][3]string{freed: {"archived", "unused", ""}, merged: {"archived", "merged", kept}, inter: {"archived", "superseded", lato},
		lato: {"active", "", ""}, grey: {"active", "", ""}, black: {"archived", "outdated", ""}, roboto: {"archived", "superseded", lato},
		navy: {"archived", "outdated", ""}, slate: {"archived", "outdated", ""}, pinnedMerged: {"archived", "unused", ""}, apart: {"archived", "superseded", chosen},
		chosen: {"active", "", ""}} {
		if status, reason, by := notes.state(id); [3]string{status, reason, by} != want {
			t.Errorf("note %s after the cleanup: %s %q %q, want %v", id, status, reason, by, want)
		}
	}
	var dismissals []string
	if err := h.db.QueryRow(ctx, "SELECT COALESCE(array_agg(content_hash ORDER BY content_hash),'{}') FROM memory_item_dismissals WHERE tenant_id=$1", tid).Scan(&dismissals); err != nil ||
		!slices.Equal(dismissals, []string{"plain", "plain-in-ck", "words-of-ck"}) {
		t.Errorf("dismissals after the cleanup: %v %v", dismissals, err)
	}
	var links int
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissal_canvases WHERE tenant_id=$1 AND scope='cd'", tid).Scan(&links); err != nil || links != 0 {
		t.Errorf("links of a deleted canvas's dismissals after the cleanup: %d %v", links, err)
	}
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM memory_item_dismissal_canvases WHERE tenant_id=$1 AND scope='' AND content_hash='words-of-ck' AND canvas_id='ck'", tid).Scan(&links); err != nil || links != 1 {
		t.Errorf("the link of a dismissal of the whole workspace's scope after the cleanup: %d %v", links, err)
	}
}

// The statement backend/README.md gives for a rotation of the credential key deletes every dismissal and its links.
func TestPostgresTheKeyRotationOf055IsAsTheReadmeSays(t *testing.T) {
	h := newHarness(t, "")
	_, tid, _ := h.register(t, "rotate-055@example.test")
	ctx := context.Background()
	for _, sql := range []string{"INSERT INTO canvases(id,tenant_id,name) VALUES('cr',$1,'Rotate')",
		"INSERT INTO memory_item_dismissals(tenant_id,canvas_id,content_hash,canvas_words) VALUES($1,'cr','old-key',true)",
		"INSERT INTO memory_item_dismissal_canvases(tenant_id,scope,content_hash,canvas_id) VALUES($1,'cr','old-key','cr')"} {
		if _, err := h.db.Exec(ctx, sql, tid); err != nil {
			t.Fatal(sql, err)
		}
	}
	if _, err := h.db.Exec(ctx, readmeStatement(t, "rotate-key-055")); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := h.db.QueryRow(ctx, "SELECT (SELECT count(*) FROM memory_item_dismissals)+(SELECT count(*) FROM memory_item_dismissal_canvases)").Scan(&left); err != nil || left != 0 {
		t.Fatalf("dismissals and links left after a key rotation: %d %v", left, err)
	}
}
