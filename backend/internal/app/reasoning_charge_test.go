package app

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// A node run whose model reasoned and was then refused says so once, and the refusal reads as one the provider
// worked for. Two things settle such a call on that — creditCharge's refusal branch and sizeRefusal — and both read
// it from the reasoning a run was told about, which until now only a planner run reported. What they read is whether
// any reasoning carried something, never how much: the counts are characters, and the one place that would take a
// number from them prices tokens.
//
// Getting the fixture right matters as much as the assertion. The worker reports its own failure code and the API
// maps it (runtimeFailureCode), so naming the API's code instead of the worker's ends up `runtime_failed` and never
// exercises a refusal at all.
func TestPostgresANodeRunRefusedAfterReasoningStillSaysItOnce(t *testing.T) {
	var activity atomic.Value
	pi := plannerWorker(t, &activity, func(string) []map[string]any {
		return []map[string]any{{"type": "reasoning", "characters": 9001},
			{"type": "failed", "code": "MODEL_RATE_LIMIT", "message": "slow down"}}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "node-reasoning-charge@awwo.invalid")
	_, _, sid := h.fixture(t, c, tid)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/runs",
		map[string]string{"sessionId": sid, "prompt": "think then fail", "operationId": "node-reasoning-charge"}, 202)["id"].(string)
	run := h.awaitRun(t, c, tid, id, "failed")

	// The refusal the charge turns on, not the runtime_failed a worker code the mapper does not know would give.
	if run["error"] != "provider_rate_limited" {
		t.Fatalf("a rate-limited node run failed as %#v, want provider_rate_limited", run["error"])
	}

	// It reasoned, so it says so once, whatever the call then did.
	said := 0
	for _, event := range runEvents(t, h, tid, id) {
		if event.data["type"] == "reasoning_started" {
			said++
		}
	}
	if said != 1 {
		t.Fatalf("a run that reasoned then failed published %d reasoning_started events, want 1", said)
	}
}

// And the fact really does reach the accounting from a node run, which is the whole of the change and the one thing
// the test above cannot see: it would pass just as well if the run kept the fact to itself.
//
// A charge is not what this reads: a reserve exists only for a call on credits, and a workspace here is on the free
// allowance until a plan is given it (which the test below does). sizeRefusal needs no reserve, so this is where a
// run's own wiring is cheapest to pin. A context refusal inside quickRefusal settles as a
// call that never began (`not_incurred`, which also keeps it out of the daily allowance); the same refusal after the
// model has produced reasoning is not that call, and settles as one that did work. Both directions, so neither can
// pass with the wiring removed.
func TestPostgresANodeRunsReasoningReachesWhatSettlesTheCall(t *testing.T) {
	for _, c := range []struct {
		name     string
		events   []map[string]any
		incurred bool
	}{
		{"a context refusal on its own never began", []map[string]any{
			{"type": "failed", "code": "MODEL_CONTEXT_LIMIT", "message": "too large"}}, false},
		{"the same refusal after reasoning did work", []map[string]any{
			{"type": "reasoning", "characters": 9001},
			{"type": "failed", "code": "MODEL_CONTEXT_LIMIT", "message": "too large"}}, true},
		// The worker's "it only began", which is not work: a provider that opens a reasoning item and refuses in
		// the moment after has generated nothing, and such a refusal is not billed (refusedBeforeOutput).
		{"a reasoning start that carried nothing is not work", []map[string]any{
			{"type": "reasoning", "characters": 0},
			{"type": "failed", "code": "MODEL_CONTEXT_LIMIT", "message": "too large"}}, false},
		// A start and then the thinking itself, which is the order a reasoning model really arrives in: both
		// workers report the zero the moment the item opens and the counts as the deltas come. A reading of the
		// first event alone would call this one no work.
		{"a start followed by the thinking is work", []map[string]any{
			{"type": "reasoning", "characters": 0},
			{"type": "reasoning", "characters": 9001},
			{"type": "failed", "code": "MODEL_CONTEXT_LIMIT", "message": "too large"}}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			var activity atomic.Value
			pi := plannerWorker(t, &activity, func(string) []map[string]any { return c.events })
			defer pi.Close()
			h := newHarness(t, pi.URL)
			client, tid, _ := h.register(t, "node-reasoning-settles@awwo.invalid")
			_, _, sid := h.fixture(t, client, tid)
			id := h.request(t, client, "POST", "/tenants/"+tid+"/runs",
				map[string]string{"sessionId": sid, "prompt": "too large", "operationId": "node-reasoning-settles"}, 202)["id"].(string)
			if done := h.awaitRun(t, client, tid, id, "failed"); done["error"] != "context_limit" {
				t.Fatalf("the run ended with %v", done["error"])
			}
			var admission, cost string
			if e := h.db.QueryRow(context.Background(),
				"SELECT admission_status,cost_status FROM model_invocations WHERE tenant_id=$1 AND run_id=$2",
				tid, id).Scan(&admission, &cost); e != nil {
				t.Fatalf("could not read how the call settled: %v", e)
			}
			if incurred := cost != "not_incurred"; incurred != c.incurred {
				t.Fatalf("the call settled %s / %s, want incurred=%v", admission, cost, c.incurred)
			}
		})
	}
}

// What a call on credits is charged for a refusal that followed reasoning, which is the change's reason for being
// and the one thing neither the run's behaviour nor sizeRefusal reaches: creditCharge is called only where a reserve
// exists, so a settling that stopped passing the fact along would leave every test above green while paid calls went
// back to free. A plan makes the reserve, so this reads the charge itself, both ways.
func TestPostgresANodeCallsRefusalAfterReasoningCostsItsReserve(t *testing.T) {
	h := planHarness(t)
	ctx := context.Background()
	const who = "node-reasoning-paid@example.test"
	c, tid, _ := h.register(t, who)
	now := time.Now()
	givePlan(t, h, who, "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)

	// A rate limit answered at once, with nothing streamed: unseen is zero, so it is a refusal before any output,
	// and the call never reached the provider as far as anything but its reasoning says.
	refuse := func(reasoned bool) (reserve, charge int) {
		t.Helper()
		rid, id := routeHarnessRun(t, h, c, tid, planRoutes), randomID()
		f := &invocationFacts{Runtime: runtimePI, Model: "claude-sonnet-5", Admission: "not_attempted", InputBytes: 4000}
		if e := h.a.reserveInvocation(ctx, tid, rid, id, "claude-sonnet-5", f); e != nil {
			t.Fatal(e)
		}
		if e := h.a.markInvocationAdmission(ctx, tid, id, f, "unknown"); e != nil {
			t.Fatal(e)
		}
		f.Reasoned = reasoned
		tx, e := h.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e := h.a.settleInvocation(ctx, tx, tid, id, "failed", "provider_rate_limited", f); e != nil {
			t.Fatal(e)
		}
		if e := tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		if e := h.db.QueryRow(ctx, `SELECT COALESCE(credit_reserve,-1),COALESCE(credit_charge,-1)
			FROM model_invocations WHERE tenant_id=$1 AND id=$2`, tid, id).Scan(&reserve, &charge); e != nil {
			t.Fatal(e)
		}
		return
	}

	// Without reasoning it is the refusal this product does not bill.
	if reserve, charge := refuse(false); reserve <= 0 || charge != 0 {
		t.Fatalf("a refusal with no reasoning reserved %d and cost %d, want a reserve and no charge", reserve, charge)
	}
	// With it the provider did work, so the call costs what was held for it.
	if reserve, charge := refuse(true); reserve <= 0 || charge != reserve {
		t.Fatalf("a refusal after reasoning reserved %d and cost %d, want them equal", reserve, charge)
	}
}
