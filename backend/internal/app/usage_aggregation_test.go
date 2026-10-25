package app

import (
	"context"
	"github.com/prometheus/client_golang/prometheus"
	"net/http"
	"testing"
	"time"
)

func TestPostgresUsageSnapshotsRebuildAndSurviveFailure(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		completeObserved(w, "SNAPSHOT", observationFixture(12, 3))
	})
	defer provider.Close()
	h := newHarness(t, provider.URL)
	c, tid, _ := h.register(t, "usage-snapshot@example.test")
	_, _, sid := h.fixture(t, c, tid)
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TASK", "operationId": "snapshot"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	started, before := time.Now(), dbNow(t, h)
	one, err := h.a.readUsageWindowSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	two, err := h.a.readUsageWindowSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	after := dbNow(t, h)
	if len(one.Rows) != 2 || len(two.Rows) != 2 {
		t.Fatal("missing complete 24h/30d batch", one.At, one.Rows, two.At, two.Rows)
	}
	for _, s := range []*usageWindowSnapshot{one, two} {
		// The windows end at the database's clock, which stamped the call's completed_at: this process's clock can
		// differ from it by a second or more (a test run on Windows against a PostgreSQL in WSL).
		if s.At.Before(before) || s.At.After(after) {
			t.Fatal("windows not cut at the database's clock", before, s.At, after)
		}
		for _, row := range s.Rows {
			if row.Count != 1 || row.Tokens[0] == nil || *row.Tokens[0] != 12 || row.Tokens[1] == nil || *row.Tokens[1] != 3 || row.Cost != nil {
				t.Fatal("wrong snapshot", row)
			}
		}
	}
	collector := newUsageWindowCollector()
	collector.snapshot.Store(one)
	registry := prometheus.NewRegistry()
	registry.MustRegister(collector)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if failed, err := h.a.readUsageWindowSnapshot(ctx); err == nil || failed != nil {
		t.Fatal("cancelled snapshot accepted")
	}
	if collector.snapshot.Load() != one {
		t.Fatal("old snapshot replaced by failure")
	}
	metrics, err := registry.Gather()
	elapsed := time.Since(started).Seconds()
	if err != nil || len(metrics) != 4 {
		t.Fatalf("gather snapshot without missing cost: %v %d", err, len(metrics))
	}
	// The snapshot's age is measured on this process's clock alone, from when it read the cutoff.
	ages := 0
	for _, family := range metrics {
		if family.GetName() != "awwo_usage_snapshot_age_seconds" {
			continue
		}
		for _, m := range family.GetMetric() {
			ages++
			if age := m.GetGauge().GetValue(); age < 0 || age > elapsed {
				t.Fatalf("snapshot age %vs, not between 0 and the %vs since the test began reading", age, elapsed)
			}
		}
	}
	if ages != 2 {
		t.Fatal("snapshot age missing for a window", ages)
	}
}
