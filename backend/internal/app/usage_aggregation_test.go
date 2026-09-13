package app

import (
	"context"
	"github.com/prometheus/client_golang/prometheus"
	"net/http"
	"testing"
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
	one, err := h.a.readUsageWindowSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	two, err := h.a.readUsageWindowSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(one.Rows) != 2 || len(two.Rows) != 2 {
		t.Fatal("missing complete 24h/30d batch", one, two)
	}
	for _, s := range []*usageWindowSnapshot{one, two} {
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
	if err != nil || len(metrics) != 4 {
		t.Fatalf("gather snapshot without missing cost: %v %d", err, len(metrics))
	}
}
