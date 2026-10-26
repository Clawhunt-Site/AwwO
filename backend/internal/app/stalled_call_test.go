package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// failAfter answers a run as a worker whose call ended with code: after streaming text, if any, and with usage, if any,
// reported on its terminal event.
func failAfter(w http.ResponseWriter, text, code string, usage map[string]any) {
	if text != "" {
		raw, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": text})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}
	ev := map[string]any{"type": "failed", "code": code, "message": "synthetic failure"}
	if usage != nil {
		ev["observability"] = map[string]any{"version": 1, "usage": usage,
			"timing": map[string]any{"setupMs": nil, "providerMs": nil, "providerTtftMs": nil, "workerTotalMs": nil, "workerFirstDeltaMs": nil}}
	}
	raw, _ := json.Marshal(ev)
	fmt.Fprintf(w, "data: %s\n\n", raw)
}

// Owner 2026-10-25 (「那就按照你的建议往下执行吧」, to the proposal that a call a platform time limit cut not be charged): a
// model call its worker cut for silence before it returned anything (MODEL_STALLED) fails as the service's outage, costs
// no credits and is given back to the daily total, at most refundedCallsPerDay such calls a day a workspace, while the
// route allowance still counts it. A call that streamed text first, whose usage was reported, or that failed otherwise
// settles as before.
func TestPostgresCallsCutForSilenceBeforeAnyOutputAreNotCharged(t *testing.T) {
	var reply atomic.Value
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		reply.Load().(func(http.ResponseWriter))(w)
	})
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	h.a.cfg.NewWorkspaceRouteLimits = routeLimits{routeGate: 3, routeBedrock: 1, routeMedia: 1}
	var err error
	if h.a.pricing, err = ParseModelPricing(planPricing); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	partial := map[string]any{"status": "partial", "source": "provider_raw", "inputTokens": 3000}
	replies := map[string]func(http.ResponseWriter){
		"stalled":     func(w http.ResponseWriter) { failAfter(w, "", "MODEL_STALLED", nil) },
		"wrote first": func(w http.ResponseWriter) { failAfter(w, "Hello", "MODEL_STALLED", nil) },
		"reported":    func(w http.ResponseWriter) { failAfter(w, "", "MODEL_STALLED", partial) },
		"outage":      func(w http.ResponseWriter) { failAfter(w, "", "MODEL_UNAVAILABLE", nil) },
	}
	// run runs one call of the session with the reply named, and reads the run's error, its call's credit charge (nil off
	// a plan) and whether the call was noted as cut for silence.
	run := func(c *http.Cookie, tid, sid, name, op string) (string, *int, bool) {
		t.Helper()
		reply.Store(replies[name])
		id := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "hello", "operationId": op}, 202)["id"].(string)
		done := h.awaitRun(t, c, tid, id, "failed")
		var charge *int
		var noted bool
		if e := h.db.QueryRow(ctx, `SELECT mi.credit_charge,EXISTS(SELECT 1 FROM refunded_calls rs WHERE rs.tenant_id=mi.tenant_id AND rs.invocation_id=mi.id AND rs.reason='stalled')
			FROM model_invocations mi WHERE mi.tenant_id=$1 AND mi.run_id=$2`, tid, id).Scan(&charge, &noted); e != nil {
			t.Fatal(name, e)
		}
		code, _ := done["error"].(string)
		return code, charge, noted
	}
	cases := []struct {
		name  string
		given bool
	}{{"stalled", true}, {"wrote first", false}, {"reported", false}, {"outage", false}}

	// A free workspace: the stalled call is the only one its daily total gives back; its route allowance counts all four.
	cf, tf, _ := h.register(t, "stalled-free@example.test")
	execSQL(t, h, `UPDATE tenants SET route_limits='{"gate":20,"bedrock":1,"media":1}'::jsonb,max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tf)
	_, _, sf := h.fixture(t, cf, tf)
	for i, c := range cases {
		if code, charge, noted := run(cf, tf, sf, c.name, fmt.Sprintf("stalled-free-%d", i)); code != "provider_unavailable" || charge != nil || noted != c.given {
			t.Fatalf("%s: the run failed %s, charged %v, noted %v; want provider_unavailable, no charge, noted %v", c.name, code, charge, noted, c.given)
		}
	}
	v := h.request(t, cf, "GET", "/tenants/"+tf+"/route-usage", nil, 200)
	if _, used := allowanceOf(t, v, "daily"); used != 3 {
		t.Fatalf("the meter shows %d calls today, want 3: the stalled one is given back", used)
	}
	routes, _ := v["routes"].(map[string]any)
	if _, used := allowanceOf(t, routes, "gate"); used != 4 {
		t.Fatalf("the gate allowance shows %d used, want 4: it counts the stalled call too", used)
	}

	// A workspace on a plan: the stalled call costs nothing, every other one at least its reserve. Every refusal is taken
	// as a late one here, as an outage after minutes would be: one answered within moments costs nothing anyway.
	lateRefusals.Store(true)
	defer lateRefusals.Store(false)
	cp, tp, _ := h.register(t, "stalled-plan@example.test")
	now := time.Now()
	givePlan(t, h, "stalled-plan@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	_, _, sp := h.fixture(t, cp, tp)
	for i, c := range cases {
		code, charge, noted := run(cp, tp, sp, c.name, fmt.Sprintf("stalled-plan-%d", i))
		if code != "provider_unavailable" || charge == nil || (*charge == 0) != c.given || noted != c.given {
			t.Fatalf("%s: the run failed %s, charged %v, noted %v; want provider_unavailable, free %v", c.name, code, charge, noted, c.given)
		}
		if !c.given && *charge < 12 {
			t.Fatalf("%s: charged %d, below the reserve", c.name, *charge)
		}
	}
	// The day's number reached (this one and 31 more), the next call cut for silence is charged as any other failure and
	// not noted; the next day's first is free again.
	for i := 1; i < refundedCallsPerDay; i++ {
		execSQL(t, h, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,$2,'stalled')", tp, randomID())
	}
	if code, charge, noted := run(cp, tp, sp, "stalled", "stalled-plan-past"); code != "provider_unavailable" || charge == nil || *charge < 12 || noted {
		t.Fatalf("past the day's number: the run failed %s, charged %v, noted %v; want a charge of at least the reserve, not noted", code, charge, noted)
	}
	// Each workspace has its own number.
	if _, _, noted := run(cf, tf, sf, "stalled", "stalled-free-after"); !noted {
		t.Fatal("another workspace's calls cut for silence took from this one's number")
	}
	execSQL(t, h, "UPDATE refunded_calls SET created_at=created_at-interval '1 day' WHERE tenant_id=$1", tp)
	if _, charge, noted := run(cp, tp, sp, "stalled", "stalled-plan-next-day"); charge == nil || *charge != 0 || !noted {
		t.Fatalf("a new day: charged %v, noted %v; want free and noted", charge, noted)
	}
}

// The day's number holds when one workspace's calls settle at the same moment (Codex and the security review,
// 2026-10-25): with one place left, a second settlement waits for the first's transaction and then finds none. A call
// already noted for another reason gets no second note and keeps its charge, and an operator-paid planner call, which
// costs the workspace nothing, takes no place.
func TestPostgresCallsCutForSilenceAreNotedOneAtATime(t *testing.T) {
	h := planHarness(t)
	// The operator's planner model, which only a call whose run was admitted on it (OperatorPaid) is paid for by the
	// operator: the other calls below are the workspace's.
	h.a.cfg.PlannerModel = "claude-sonnet-5"
	ctx := context.Background()
	const who = "stalled-together@example.test"
	c, tid, _ := h.register(t, who)
	now := time.Now()
	givePlan(t, h, who, "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	// open reserves a paid call of the workspace as a run's call is, and gives it the facts of a call its worker cut for
	// silence three minutes in, nothing streamed.
	open := func() (string, *invocationFacts) {
		t.Helper()
		rid, id := routeHarnessRun(t, h, c, tid, planRoutes), randomID()
		f := &invocationFacts{Runtime: runtimePI, Model: "claude-sonnet-5", Admission: "not_attempted", InputBytes: 4000}
		if e := h.a.reserveInvocation(ctx, tid, rid, id, "claude-sonnet-5", f); e != nil {
			t.Fatal(e)
		}
		if e := h.a.markInvocationAdmission(ctx, tid, id, f, "accepted"); e != nil {
			t.Fatal(e)
		}
		f.Streamed, f.Ended, f.Terminal, f.WorkerCode = time.Now().Add(-3*time.Minute), time.Now(), true, "MODEL_STALLED"
		f.Usage = missingUsage("unavailable", "provider_missing")
		return id, f
	}
	// As a run's finish settles its call (finishOnce): the workspace row first, then the settlement.
	settle := func(tx pgx.Tx, id string, f *invocationFacts) error {
		if e := keyShareBeforeStalledNote(ctx, tx, tid, f); e != nil {
			return e
		}
		_, e := h.a.settleInvocation(ctx, tx, tid, id, "failed", "provider_unavailable", f)
		return e
	}
	settled := func(id string, f *invocationFacts) {
		t.Helper()
		tx, e := h.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx) // a failed step must not leave the connection held (the harness closes its pool)
		if e = settle(tx, id, f); e != nil {
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	}
	read := func(id string) (charge int, noted bool) {
		t.Helper()
		if e := h.db.QueryRow(ctx, `SELECT COALESCE(mi.credit_charge,-1),EXISTS(SELECT 1 FROM refunded_calls rs WHERE rs.tenant_id=mi.tenant_id AND rs.invocation_id=mi.id AND rs.reason='stalled')
			FROM model_invocations mi WHERE mi.tenant_id=$1 AND mi.id=$2`, tid, id).Scan(&charge, &noted); e != nil {
			t.Fatal(e)
		}
		return
	}

	// A call already noted (here as a cut on its way) is not noted again, and keeps its charge.
	id, f := open()
	execSQL(t, h, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,$2,'timeout')", tid, id)
	settled(id, f)
	if charge, noted := read(id); charge < 12 || noted {
		t.Fatalf("a call noted before: charged %d, noted stalled %v; want its reserve and no second note", charge, noted)
	}
	// An operator-paid planner call takes no place (its run's snapshot on the operator's planner model, the call that model).
	id, f = open()
	f.OperatorPaid = true
	settled(id, f)
	if _, noted := read(id); noted {
		t.Fatal("an operator-paid planner call took a place")
	}
	// A settlement that did not lock the workspace row before its own (a path that does not call
	// keyShareBeforeStalledNote) notes nothing and charges as before: the order that keeps it from deadlocking is not kept.
	id, f = open()
	tx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = h.a.settleInvocation(ctx, tx, tid, id, "failed", "provider_unavailable", f); e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if charge, noted := read(id); charge < 12 || noted {
		t.Fatalf("a settlement without the workspace row first: charged %d, noted %v; want its reserve, not noted", charge, noted)
	}

	// One place left: two settlements at once. The first holds its note uncommitted while the second starts.
	for i := 0; i < refundedCallsPerDay-1; i++ {
		execSQL(t, h, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,$2,'stalled')", tid, randomID())
	}
	first, f1 := open()
	second, f2 := open()
	tx1, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx1.Rollback(ctx)
	if e = settle(tx1, first, f1); e != nil {
		t.Fatal(e)
	}
	done, backend := make(chan error, 1), make(chan int, 1)
	go func() {
		tx2, e := h.db.Begin(ctx)
		if e != nil {
			backend <- 0
			done <- e
			return
		}
		defer tx2.Rollback(ctx)
		var pid int
		if e = tx2.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); e != nil {
			backend <- 0
			done <- e
			return
		}
		backend <- pid
		if e = settle(tx2, second, f2); e != nil {
			done <- e
			return
		}
		done <- tx2.Commit(ctx)
	}()
	// The second waits for the first's lock: its own connection seen waiting for an advisory lock in pg_locks (other
	// packages' tests take Migrate's on the same database), and not done.
	pid := <-backend
	waiting := false
	for deadline := time.Now().Add(10 * time.Second); pid != 0 && time.Now().Before(deadline) && !waiting; time.Sleep(20 * time.Millisecond) {
		probe, stop := context.WithTimeout(ctx, 2*time.Second)
		e := h.db.QueryRow(probe, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted)", pid).Scan(&waiting)
		stop()
		if e != nil {
			t.Fatal(e)
		}
	}
	select {
	case e := <-done:
		t.Fatalf("the second settlement did not wait for the first (%v)", e)
	default:
	}
	if !waiting {
		t.Fatal("the second settlement never waited for the first's lock")
	}
	if e = tx1.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	if charge, noted := read(first); charge != 0 || !noted {
		t.Fatalf("the first: charged %d, noted %v; want free and noted", charge, noted)
	}
	if charge, noted := read(second); charge < 12 || noted {
		t.Fatalf("the second, past the day's number: charged %d, noted %v; want its reserve, not noted", charge, noted)
	}
	var today int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM refunded_calls WHERE tenant_id=$1 AND reason='stalled'", tid).Scan(&today); e != nil || today != refundedCallsPerDay {
		t.Fatal("notes today", today, e)
	}
}

// A settlement that may note a call cut for silence and a cancellation of the same run take their locks in one order
// (Codex, 2026-10-25): a cancellation locks the workspace row FOR UPDATE, then the run's; the note's foreign key needs
// the workspace row too, so the settlement takes it FOR KEY SHARE before the run's row, and waits for the cancellation
// instead of holding the run's row against it, which deadlocked.
func TestPostgresAStalledSettlementWaitsForACancellationInsteadOfDeadlocking(t *testing.T) {
	h := planHarness(t)
	ctx := context.Background()
	c, tid, _ := h.register(t, "stalled-order@example.test")
	// A running run and its running call, as a single run reserves it (the call's id is the run's).
	rid := routeHarnessRun(t, h, c, tid, planRoutes)
	f := &invocationFacts{Runtime: runtimePI, Model: "claude-sonnet-5", Admission: "not_attempted", InputBytes: 4000}
	if e := h.a.reserveInvocation(ctx, tid, rid, rid, "claude-sonnet-5", f); e != nil {
		t.Fatal(e)
	}
	if e := h.a.markInvocationAdmission(ctx, tid, rid, f, "accepted"); e != nil {
		t.Fatal(e)
	}
	f.Streamed, f.Ended, f.Terminal, f.WorkerCode = time.Now().Add(-3*time.Minute), time.Now(), true, "MODEL_STALLED"
	f.Usage = missingUsage("unavailable", "provider_missing")
	// The cancellation's transaction holds the workspace row, as cancelRun's mutationRole takes it.
	cancelTx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer cancelTx.Rollback(ctx)
	if _, e = cancelTx.Exec(ctx, "SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", tid); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- h.a.finishOnce(ctx, tid, rid, "failed", "", "provider_unavailable", f) }()
	// The settlement waits for the workspace row before it has taken the run's.
	waiting := false
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline) && !waiting; time.Sleep(20 * time.Millisecond) {
		probe, stop := context.WithTimeout(ctx, 2*time.Second)
		e := h.db.QueryRow(probe, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
			AND query LIKE 'SELECT 1 FROM tenants WHERE id=$1 FOR KEY SHARE%')`).Scan(&waiting)
		stop()
		if e != nil {
			t.Fatal(e)
		}
	}
	if !waiting {
		t.Fatal("the settlement never waited for the workspace row before the run's")
	}
	// So the cancellation takes the run's row at once (a short lock timeout: the old order deadlocked here) and commits.
	if _, e = cancelTx.Exec(ctx, "SET LOCAL lock_timeout = '3s'"); e != nil {
		t.Fatal(e)
	}
	if _, e = cancelTx.Exec(ctx, "UPDATE runs SET status='cancelled',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')", tid, rid); e != nil {
		t.Fatal("the cancellation could not take the run's row:", e)
	}
	if e = cancelTx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	select {
	case e = <-done:
		if e != nil {
			t.Fatal("the settlement after the cancellation:", e)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the settlement did not end after the cancellation")
	}
	// The run stays cancelled, its call settles as the cancelled run's, and nothing is noted for it.
	var status, call string
	var noted bool
	if e := h.db.QueryRow(ctx, `SELECT r.status,mi.status,EXISTS(SELECT 1 FROM refunded_calls rs WHERE rs.tenant_id=r.tenant_id AND rs.invocation_id=mi.id)
		FROM runs r JOIN model_invocations mi ON mi.tenant_id=r.tenant_id AND mi.id=r.id WHERE r.tenant_id=$1 AND r.id=$2`, tid, rid).Scan(&status, &call, &noted); e != nil {
		t.Fatal(e)
	}
	if status != "cancelled" || call != "cancelled" || noted {
		t.Fatalf("after both: the run %s, its call %s, noted %v; want cancelled, cancelled, not noted", status, call, noted)
	}
}

// 043 can run again unchanged on a database that already holds refunded calls; it takes a call cut for silence besides
// a timeout, and no other reason.
func TestPostgresStalledCallsMigrationRunsAgain(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	_, tid, _ := h.register(t, "stalled-migration@awwo.invalid")
	execSQL(t, h, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,'call-1','timeout'),($1,'call-2','stalled')", tid)
	sql, e := migrations.ReadFile("migrations/043_stalled_calls.sql")
	if e != nil || len(sql) == 0 {
		t.Fatal("043 is not embedded", e)
	}
	for run := 0; run < 2; run++ {
		tx, e := h.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, string(sql)); e != nil {
			tx.Rollback(ctx)
			t.Fatal("043 run again, run", run+1, e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	}
	var rows, checks int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM refunded_calls WHERE tenant_id=$1", tid).Scan(&rows); e != nil || rows != 2 {
		t.Fatal("the noted calls did not keep their rows", rows, e)
	}
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM pg_constraint WHERE conrelid='refunded_calls'::regclass AND contype='c'").Scan(&checks); e != nil || checks != 1 {
		t.Fatal("refunded_calls must hold one check on its reason", checks, e)
	}
	if _, e := h.db.Exec(ctx, "INSERT INTO refunded_calls(tenant_id,invocation_id,reason) VALUES($1,'call-3','provider')", tid); e == nil {
		t.Fatal("a reason other than a timeout or a stall was taken")
	}
}
