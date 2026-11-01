package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Migration 048 keys a lesson to its canvas, and the key cascades (through an index of a canvas's lessons of every
// status). Applied to a database as 047 left it, it removes the lessons canvases deleted before it left behind (keyed to
// no canvas of their workspace) and keeps the rest, the workspace's own (no canvas) among them; a lesson can then name
// no other canvas, and a canvas deleted any way takes its lessons with it. Every statement runs again unchanged.
func TestPostgresMigration048KeysALessonToItsCanvas(t *testing.T) {
	db := migrationTestDatabase(t)
	ctx := context.Background()
	if e := Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	exec := func(statement string) error { _, err := db.Exec(ctx, statement); return err }
	for _, statement := range []string{
		// The database as 047 left it, with what canvases deleted then left behind.
		"ALTER TABLE canvas_lessons DROP CONSTRAINT canvas_lessons_tenant_id_canvas_id_fkey",
		"DROP INDEX canvas_lessons_canvas_all",
		"DELETE FROM awwo_schema_migration_identities WHERE version=48",
		"DELETE FROM awwo_schema_migrations WHERE version=48",
		"INSERT INTO tenants(id,name) VALUES('t','Lessons workspace'),('t2','Another workspace')",
		"INSERT INTO canvases(id,tenant_id,name) VALUES('c','t','Canvas'),('c2','t2','Another workspace''s canvas')",
		`INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,fingerprint,rule,status) VALUES
			('kept','t','c','n','output_limit','f-kept','Rule.','active'),('left','t','gone','n','output_limit','f-left','Rule.','active'),
			('elsewhere','t','c2','n','step_limit','f-elsewhere','Rule.','retired')`,
		"INSERT INTO canvas_lessons(id,tenant_id,kind,rule,status) VALUES('workspace','t','output_limit','Rule.','active')",
	} {
		if e := exec(statement); e != nil {
			t.Fatal(statement, e)
		}
	}
	if e := Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	sql, _ := migrations.ReadFile("migrations/048_canvas_lessons_cascade.sql")
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, string(sql)); e != nil {
		t.Fatal("048 is not re-runnable", e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	lessons := func() string {
		t.Helper()
		var ids string
		if e := db.QueryRow(ctx, "SELECT COALESCE(string_agg(id,',' ORDER BY id),'') FROM canvas_lessons").Scan(&ids); e != nil {
			t.Fatal(e)
		}
		return ids
	}
	if got := lessons(); got != "kept,workspace" {
		t.Fatal("the lessons 048 kept", got)
	}
	var valid bool
	var action string
	if e = db.QueryRow(ctx, `SELECT convalidated,confdeltype::text FROM pg_constraint WHERE conrelid='canvas_lessons'::regclass
		AND conname='canvas_lessons_tenant_id_canvas_id_fkey' AND confrelid='canvases'::regclass`).Scan(&valid, &action); e != nil || !valid || action != "c" {
		t.Fatal("the key", valid, action, e)
	}
	var index string
	if e = db.QueryRow(ctx, "SELECT pg_get_indexdef('canvas_lessons_canvas_all'::regclass)").Scan(&index); e != nil || !strings.HasSuffix(index, "(tenant_id, canvas_id)") {
		t.Fatal("the index the key's cascade reads", index, e)
	}
	for _, statement := range []string{
		"INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,rule) VALUES('l1','t','gone','n','Rule.')",
		"INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,rule) VALUES('l2','t','c2','n','Rule.')",
		"UPDATE canvas_lessons SET canvas_id='gone' WHERE id='kept'",
	} {
		if exec(statement) == nil {
			t.Fatal("accepted", statement)
		}
	}
	// Deleted by hand rather than through the API, a canvas takes its lessons too.
	if e = exec("DELETE FROM canvases WHERE id='c'"); e != nil {
		t.Fatal(e)
	}
	if got := lessons(); got != "workspace" {
		t.Fatal("the lessons a deleted canvas left", got)
	}
	// A key of that name that is not the cascading key to canvases (one that does not cascade, one on other columns) is
	// refused rather than taken for it.
	for _, key := range []string{
		"FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases(tenant_id, id)",
		"FOREIGN KEY (tenant_id, node_id) REFERENCES canvases(tenant_id, id) ON DELETE CASCADE",
	} {
		for _, statement := range []string{
			"ALTER TABLE canvas_lessons DROP CONSTRAINT canvas_lessons_tenant_id_canvas_id_fkey",
			"ALTER TABLE canvas_lessons ADD CONSTRAINT canvas_lessons_tenant_id_canvas_id_fkey " + key,
		} {
			if e = exec(statement); e != nil {
				t.Fatal(statement, e)
			}
		}
		if e = exec(string(sql)); e == nil || !strings.Contains(e.Error(), "is not the cascading key to canvases") {
			t.Fatal("048 ran over another key of its key's name:", key, e)
		}
	}
}

// Writing a run's lessons waits at most 5 s for any lock, unless a test sets the App's own bound.
func TestALessonWriteWaitsForALockAtMostFiveSeconds(t *testing.T) {
	for _, c := range []struct {
		wait time.Duration
		want string
	}{{0, "5000"}, {-time.Second, "5000"}, {500 * time.Millisecond, "500"}, {time.Microsecond, "1"}} {
		if got := (&App{lessonLockWait: c.wait}).lessonLockTimeout(); got != c.want {
			t.Errorf("%v: %s, want %s", c.wait, got, c.want)
		}
	}
}

// lessonGate runs statement in a transaction of a connection of its own, which holds its locks, and returns that
// transaction and a wait that blocks until n backends queue behind it, directly or behind one that does
// (gatedBackends). The gate and the probe have their own connections, as gateTenantInserts' do.
func lessonGate(ctx context.Context, t *testing.T, h *harness, statement string, args ...any) (pgx.Tx, func(n int)) {
	t.Helper()
	gate, err := pgx.ConnectConfig(ctx, h.db.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { gate.Close(context.Background()) })
	probe, err := pgx.ConnectConfig(ctx, h.db.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { probe.Close(context.Background()) })
	held, err := gate.Begin(ctx)
	if err == nil {
		_, err = held.Exec(ctx, statement, args...)
	}
	if err != nil {
		t.Fatal(err)
	}
	return held, func(n int) {
		t.Helper()
		for waiting := 0; waiting < n; {
			time.Sleep(10 * time.Millisecond)
			if err := probe.QueryRow(ctx, gatedBackends, int32(gate.PgConn().PID())).Scan(&waiting); err != nil {
				t.Fatal("not everything reached its lock wait", waiting, err)
			}
		}
	}
}

// deleteCanvasOutcome deletes a canvas through the API and returns the status it answered (0 when the request failed);
// unlike h.request it can run in a goroutine.
func deleteCanvasOutcome(h *harness, c *http.Cookie, tid, cid string) int {
	r, err := http.NewRequest("DELETE", h.server.URL+"/api/v1/tenants/"+tid+"/canvases/"+cid, nil)
	if err != nil {
		return 0
	}
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	r.AddCookie(c)
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		return 0
	}
	resp.Body.Close()
	return resp.StatusCode
}

// A sweep and a deletion of the canvas it learns from never leave a lesson behind (migration 048). Through the API, in
// either order (both lock the workspace row first, so one waits for the other), the deletion takes the lesson the sweep
// counted again or wrote for the first time, and a sweep that comes after it finds no run to learn from. By hand
// without that lock: in the operator's order (the canvas's runs, then the canvas) the deletion waits for the sweep and
// takes its lesson; in the API's order (the canvas, its runs, then the canvas) beside a canvas's first lesson the two
// deadlock and PostgreSQL ends one of them, and neither leaves a lesson behind.
func TestPostgresALessonWrittenAsItsCanvasIsDeletedGoesWithIt(t *testing.T) {
	pi := newLessonPi(t, func(node string, call int) piReply {
		if node == "up" {
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT"}
	})
	// A sweep held at a gate waits there while the test queues the other side: its lock bound is raised well past that
	// (and past the deadlock check's second), so only the gate decides when it goes on.
	h := newHarness(t, pi.server.URL, func(a *App) { a.lessonLockWait = 30 * time.Second })
	h.a.cfg.GraphNodeRetries = 0
	c, tid, _ := h.register(t, "lessons-race@example.test")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Each case's canvas has run once and its node's lesson is written; its run is due again, as though the lesson had
	// been missed. The sweep then counts that lesson once more, waiting for its row while heldLesson holds it, or, the
	// lesson gone (first), writes it for the first time, waiting while heldFingerprint holds an uncommitted lesson of the
	// same fingerprint (one of the whole workspace, which locks no canvas).
	const heldLesson = "SELECT 1 FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id=$2 FOR UPDATE"
	const heldFingerprint = "INSERT INTO canvas_lessons(id,tenant_id,kind,fingerprint,rule,status) VALUES('gate-'||$2::text,$1,'output_limit',$3,'Rule.','active')"
	prepare := func(name string, first bool) string {
		t.Helper()
		cid := retryCanvas(t, h, c, tid)
		runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs", "race-"+name, "failed")
		awaitLessons(t, h, tid, cid, "up", func(l []lessonRow) bool { return len(l) == 1 })
		statements := []string{"UPDATE graph_runs SET lessons_at=NULL,updated_at=now()-interval '10 minutes' WHERE tenant_id=$1 AND canvas_id=$2"}
		if first {
			statements = append(statements, "DELETE FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id=$2")
		}
		for _, statement := range statements {
			if _, e := h.db.Exec(ctx, statement, tid, cid); e != nil {
				t.Fatal(statement, e)
			}
		}
		return cid
	}
	sweep := func() chan error {
		swept := make(chan error, 1)
		go func() { swept <- h.a.sweepGraphLessons(ctx) }()
		return swept
	}
	apiDelete := func(cid string) chan error {
		deleted := make(chan error, 1)
		go func() {
			if code := deleteCanvasOutcome(h, c, tid, cid); code != 204 {
				deleted <- fmt.Errorf("the API answered %d", code)
				return
			}
			deleted <- nil
		}()
		return deleted
	}
	// byHand deletes the canvas's runs and then the canvas, in a transaction of a connection of its own and without the
	// workspace's lock; canvasFirst locks the canvas's row before, as the API's deletion does.
	byHand := func(cid string, canvasFirst bool) chan error {
		deleted := make(chan error, 1)
		go func() {
			conn, err := pgx.ConnectConfig(ctx, h.db.Config().ConnConfig.Copy())
			if err != nil {
				deleted <- err
				return
			}
			defer conn.Close(context.Background())
			statements := []string{"DELETE FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2", "DELETE FROM canvases WHERE tenant_id=$1 AND id=$2"}
			if canvasFirst {
				statements = append([]string{"SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE"}, statements...)
			}
			deleted <- pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
				for _, statement := range statements {
					if _, err := tx.Exec(ctx, statement, tid, cid); err != nil {
						return err
					}
				}
				return nil
			})
		}()
		return deleted
	}
	release := func(gate pgx.Tx) {
		t.Helper()
		if e := gate.Rollback(ctx); e != nil {
			t.Fatal(e)
		}
	}
	succeeded := func(swept, deleted chan error) {
		t.Helper()
		if e := <-swept; e != nil {
			t.Fatal("the sweep failed", e)
		}
		if e := <-deleted; e != nil {
			t.Fatal("the deletion failed", e)
		}
	}
	gone := func(cid string) {
		t.Helper()
		var left, lessons int
		if e := h.db.QueryRow(ctx, "SELECT (SELECT count(*) FROM canvases WHERE id=$1),(SELECT count(*) FROM canvas_lessons WHERE canvas_id=$1)", cid).Scan(&left, &lessons); e != nil || left != 0 || lessons != 0 {
			t.Errorf("the canvas (%d) left %d lessons behind: %v", left, lessons, e)
		}
	}

	// The sweep first, held at its lesson's row: the API's deletion waits for the workspace row the sweep holds, and
	// then takes the lesson it counted.
	again := prepare("api-again", false)
	gate, await := lessonGate(ctx, t, h, heldLesson, tid, again)
	swept := sweep()
	await(1)
	deleted := apiDelete(again)
	await(2)
	release(gate)
	succeeded(swept, deleted)
	gone(again)

	// The same with the canvas's first lesson, whose insert key-shares the canvas's row. The deletion queues behind the
	// gate as well (the gate's lesson key-shares the workspace row through its own workspace key), and still behind the
	// sweep once the gate is gone.
	first := prepare("api-first", true)
	gate, await = lessonGate(ctx, t, h, heldFingerprint, tid, first, lessonFingerprint(first, "up", "output_limit"))
	swept = sweep()
	await(1)
	deleted = apiDelete(first)
	await(2)
	release(gate)
	succeeded(swept, deleted)
	gone(first)

	// The API's deletion first, held at its canvas's row: the sweep waits for the workspace row the deletion holds, and
	// then finds no run to learn from.
	after := prepare("api-delete-first", false)
	gate, await = lessonGate(ctx, t, h, "SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE", tid, after)
	deleted = apiDelete(after)
	await(1)
	swept = sweep()
	await(2)
	release(gate)
	succeeded(swept, deleted)
	gone(after)

	// By hand, in the operator's order: the deletion waits for the run's row the sweep holds, and its canvas then takes
	// the lesson the sweep counted.
	runsFirst := prepare("by-hand", false)
	gate, await = lessonGate(ctx, t, h, heldLesson, tid, runsFirst)
	swept = sweep()
	await(1)
	deleted = byHand(runsFirst, false)
	await(2)
	release(gate)
	succeeded(swept, deleted)
	gone(runsFirst)

	// By hand in the API's order, beside the canvas's first lesson: the deletion holds the canvas's row and waits for the
	// run's, the sweep holds the run's and its insert waits for the canvas's. PostgreSQL ends one of the two: the sweep,
	// having written nothing, or the deletion, after which the sweep writes the lesson and the deletion done again takes
	// it.
	canvasFirst := prepare("by-hand-first", true)
	gate, await = lessonGate(ctx, t, h, heldFingerprint, tid, canvasFirst, lessonFingerprint(canvasFirst, "up", "output_limit"))
	swept = sweep()
	await(1)
	deleted = byHand(canvasFirst, true)
	await(2)
	release(gate)
	switch sweptErr, deletedErr := <-swept, <-deleted; {
	case sweptErr == nil && errorType(deletedErr) == "sql_40P01":
		t.Log("the deadlock ended the deletion")
		if e := <-byHand(canvasFirst, true); e != nil {
			t.Fatal("the deletion done again failed", e)
		}
	case errorType(sweptErr) == "sql_40P01" && deletedErr == nil:
		t.Log("the deadlock ended the sweep")
	default:
		t.Fatalf("not one of the two ended by a deadlock: the sweep %v, the deletion %v", sweptErr, deletedErr)
	}
	gone(canvasFirst)
}

// A run whose lessons cannot be written holds up no other in a sweep. Its canvas's row is left locked by a transaction
// opened by hand, so its first lesson's insert, which key-shares that row, gives up after its lock bound (shortened
// here) rather than wait as long as that transaction stays open while it holds the workspace row's key share (every
// write to the workspace would queue behind it). The next run's lessons are still written, the failure is returned for
// the sweeper to log, and the run stays due: once its canvas's row is free, the next sweep learns from it.
func TestPostgresTheSweepGoesOnPastARunItCannotLearnFrom(t *testing.T) {
	pi := newLessonPi(t, func(node string, call int) piReply {
		if node == "up" {
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT"}
	})
	const wait = 500 * time.Millisecond
	h := newHarness(t, pi.server.URL, func(a *App) { a.lessonLockWait = wait })
	h.a.cfg.GraphNodeRetries = 0
	c, tid, _ := h.register(t, "lessons-sweep-on@example.test")
	stuck, next := retryCanvas(t, h, c, tid), retryCanvas(t, h, c, tid)
	for i, cid := range []string{stuck, next} {
		runGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs", fmt.Sprintf("sweep-on-%d", i), "failed")
		awaitLessons(t, h, tid, cid, "up", func(l []lessonRow) bool { return len(l) == 1 })
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// The stuck canvas's run ended first, so the sweep meets it first, and its lesson is to be written anew.
	for _, statement := range []struct {
		sql string
		cid string
	}{
		{"DELETE FROM canvas_lessons WHERE tenant_id=$1 AND canvas_id=$2", stuck},
		{"UPDATE graph_runs SET lessons_at=NULL,updated_at=now()-interval '20 minutes' WHERE tenant_id=$1 AND canvas_id=$2", stuck},
		{"UPDATE graph_runs SET lessons_at=NULL,updated_at=now()-interval '10 minutes' WHERE tenant_id=$1 AND canvas_id=$2", next},
	} {
		if _, e := h.db.Exec(ctx, statement.sql, tid, statement.cid); e != nil {
			t.Fatal(statement.sql, e)
		}
	}
	held, _ := lessonGate(ctx, t, h, "SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, stuck)
	began := time.Now()
	if e := h.a.sweepGraphLessons(ctx); errorType(e) != "sql_55P03" {
		t.Fatalf("the sweep returned %v", e)
	}
	if took := time.Since(began); took < wait || took > wait+20*time.Second {
		t.Fatalf("the sweep gave up after %v", took)
	}
	if l := nodeLessons(t, h, tid, next, "up"); len(l) != 1 || l[0].seen != 2 {
		t.Fatalf("the run after the one that failed was not learnt from: %+v", l)
	}
	var due bool
	if e := h.db.QueryRow(ctx, "SELECT lessons_at IS NULL FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2", tid, stuck).Scan(&due); e != nil || !due {
		t.Fatalf("the run that failed is no longer due: %v", e)
	}
	if l := nodeLessons(t, h, tid, stuck, "up"); len(l) != 0 {
		t.Fatalf("the run that failed wrote a lesson: %+v", l)
	}
	if e := held.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	if e := h.a.sweepGraphLessons(ctx); e != nil {
		t.Fatal("the next sweep failed", e)
	}
	if l := nodeLessons(t, h, tid, stuck, "up"); len(l) != 1 || l[0].seen != 1 {
		t.Fatalf("the next sweep did not learn from the run: %+v", l)
	}
}
