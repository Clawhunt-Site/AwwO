package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func collaborationNodeMetric(t *testing.T, a *App, state string) float64 {
	t.Helper()
	return collaborationMetric(t, a, "awwo_graph_nodes_total", "state", state)
}

func collaborationMetric(t *testing.T, a *App, name, key, value string) float64 {
	t.Helper()
	families, err := a.obs.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if label.GetName() == key && label.GetValue() == value {
					return metric.GetCounter().GetValue()
				}
			}
		}
	}
	return 0
}

func seedCollaborationMetrics(t *testing.T, h *harness, c *http.Cookie, tid, actor, phase string) (string, string, collaborationTurn) {
	t.Helper()
	cid, doc := graphFixture(t, h, c, tid)
	doc["nodes"] = doc["nodes"].([]any)[:2]
	doc["edges"] = []any{}
	gid, runs := seedUnprojectedGraph(t, h, tid, cid, actor, doc, map[string]string{"a": "completed", "b": "completed"})
	p := collaborationPolicy{Goal: "Verify committed node transition metrics", Rounds: 1, SynthesizerNodeID: "a"}
	raw, _ := json.Marshal(p)
	ctx := context.Background()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "UPDATE graph_runs SET collaboration=$3,scope='[\"a\",\"b\"]' WHERE tenant_id=$1 AND id=$2", tid, gid, raw); err != nil {
		t.Fatal(err)
	}
	if err = seedCollaboration(ctx, tx, tid, gid, []string{"a", "b"}, &p, map[string]string{"a": "A", "b": "B"}); err != nil {
		t.Fatal(err)
	}
	ordinal := 1
	if phase == "synthesis" {
		ordinal = 5
	}
	if _, err = tx.Exec(ctx, "UPDATE graph_collaboration_turns SET state='running',run_id=$4 WHERE tenant_id=$1 AND graph_id=$2 AND ordinal=$3", tid, gid, ordinal, runs["a"]); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return cid, gid, collaborationTurn{Ordinal: ordinal, NodeID: "a", Phase: phase, Round: 1, State: "running", RunID: runs["a"]}
}

func rejectCollaborationTerminalCommit(t *testing.T, h *harness) {
	t.Helper()
	_, err := h.db.Exec(context.Background(), `CREATE FUNCTION reject_collaboration_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.collaboration IS NOT NULL AND NEW.status IN ('completed','failed','cancelled','interrupted') THEN RAISE EXCEPTION 'fixture terminal persistence failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER reject_collaboration_terminal BEFORE UPDATE ON graph_runs FOR EACH ROW EXECUTE FUNCTION reject_collaboration_terminal()`)
	if err != nil {
		t.Fatal(err)
	}
}

func allowCollaborationTerminalCommit(t *testing.T, h *harness) {
	t.Helper()
	if _, err := h.db.Exec(context.Background(), "DROP TRIGGER reject_collaboration_terminal ON graph_runs"); err != nil {
		t.Fatal(err)
	}
}

func assertCollaborationMetricState(t *testing.T, h *harness, tid, gid, state string, nodes int, count float64) {
	t.Helper()
	var actual int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND state=$3", tid, gid, state).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if got := collaborationNodeMetric(t, h.a, state); actual != nodes || got != count {
		t.Fatalf("state=%s durable nodes=%d want=%d counter=%g want=%g", state, actual, nodes, got, count)
	}
}

func TestPostgresCollaborationMetricsProposalReplayDoesNotResetNextTurn(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.MetricsEnabled = true
	c, tid, actor := h.register(t, "collaboration-proposal-metrics@example.test")
	cid, gid, turn := seedCollaborationMetrics(t, h, c, tid, actor, "proposal")
	ctx := context.Background()
	if err := h.a.completeCollaborationTurn(ctx, tid, gid, cid, turn, "candidate", nil, nil); err != nil {
		t.Fatal(err)
	}
	assertCollaborationMetricState(t, h, tid, gid, "waiting", 1, 1)
	// A delayed duplicate of this completed turn must not reset a later turn.
	if _, err := h.db.Exec(ctx, "UPDATE graph_run_nodes SET state='running' WHERE tenant_id=$1 AND graph_id=$2 AND node_id='a'", tid, gid); err != nil {
		t.Fatal(err)
	}
	if err := h.a.completeCollaborationTurn(ctx, tid, gid, cid, turn, "stale replay", nil, nil); err != nil {
		t.Fatal(err)
	}
	assertCollaborationMetricState(t, h, tid, gid, "waiting", 0, 1)
	var output string
	if err := h.db.QueryRow(ctx, "SELECT output FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id='a'", tid, gid).Scan(&output); err != nil || output != "candidate" {
		t.Fatal("replayed turn changed current output", output, err)
	}
}

func TestPostgresCollaborationMetricsSynthesisCountsOnlyCommittedNodes(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.MetricsEnabled = true
	c, tid, actor := h.register(t, "collaboration-synthesis-metrics@example.test")
	cid, gid, turn := seedCollaborationMetrics(t, h, c, tid, actor, "synthesis")
	ctx := context.Background()
	rejectCollaborationTerminalCommit(t, h)
	if err := h.a.completeCollaborationTurn(ctx, tid, gid, cid, turn, "final", nil, nil); err == nil {
		t.Fatal("fixture did not reject terminal commit")
	}
	assertCollaborationMetricState(t, h, tid, gid, "done", 0, 0)
	if got := collaborationMetric(t, h.a, "awwo_graph_runs_total", "outcome", "completed"); got != 0 {
		t.Fatal("rolled-back synthesis counted as completed graph", got)
	}
	if got := collaborationNodeMetric(t, h.a, "waiting"); got != 0 {
		t.Fatal("intermediate synthesis state was counted", got)
	}
	allowCollaborationTerminalCommit(t, h)
	for range 2 {
		if err := h.a.completeCollaborationTurn(ctx, tid, gid, cid, turn, "final", nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	assertCollaborationMetricState(t, h, tid, gid, "done", 2, 2)
	if got := collaborationMetric(t, h.a, "awwo_graph_runs_total", "outcome", "completed"); got != 1 {
		t.Fatal("committed graph counted more than once", got)
	}
}

func TestPostgresCollaborationMetricsTerminalCountsActualTransitions(t *testing.T) {
	for _, status := range []string{"failed", "interrupted", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			h := newHarness(t, "http://127.0.0.1:1")
			h.a.cfg.MetricsEnabled = true
			c, tid, actor := h.register(t, "collaboration-terminal-metrics@example.test")
			_, gid, _ := seedCollaborationMetrics(t, h, c, tid, actor, "proposal")
			state := "failed"
			if status == "cancelled" {
				state = "cancelled"
			}
			ctx := context.Background()
			if _, err := h.db.Exec(ctx, "UPDATE graph_run_nodes SET state=$3 WHERE tenant_id=$1 AND graph_id=$2 AND node_id='b'", tid, gid, state); err != nil {
				t.Fatal(err)
			}
			rejectCollaborationTerminalCommit(t, h)
			h.a.finishCollaboration(ctx, tid, gid, status, "fixture failure")
			assertCollaborationMetricState(t, h, tid, gid, state, 1, 0)
			if got := collaborationMetric(t, h.a, "awwo_graph_runs_total", "outcome", status); got != 0 {
				t.Fatal("rolled-back terminal graph counted", got)
			}
			allowCollaborationTerminalCommit(t, h)
			h.a.finishCollaboration(ctx, tid, gid, status, "fixture failure")
			h.a.finishCollaboration(ctx, tid, gid, status, "duplicate")
			assertCollaborationMetricState(t, h, tid, gid, state, 2, 1)
			if got := collaborationMetric(t, h.a, "awwo_graph_runs_total", "outcome", status); got != 1 {
				t.Fatal("terminal graph count", got)
			}
		})
	}
}

func TestPostgresCollaborationMetricsPublicCancelCommitsOnce(t *testing.T) {
	for _, operation := range []bool{false, true} {
		name := "run"
		if operation {
			name = "operation"
		}
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, "http://127.0.0.1:1")
			h.a.cfg.MetricsEnabled = true
			c, tid, actor := h.register(t, "collaboration-cancel-metrics@example.test")
			cid, gid, _ := seedCollaborationMetrics(t, h, c, tid, actor, "proposal")
			endpoint := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs/" + gid + "/cancel"
			if operation {
				endpoint = "/tenants/" + tid + "/canvases/" + cid + "/graph-runs/operations/" + gid + "/cancel"
			}
			rejectCollaborationTerminalCommit(t, h)
			h.request(t, c, "POST", endpoint, map[string]any{}, 500)
			assertCollaborationMetricState(t, h, tid, gid, "cancelled", 0, 0)
			if got := collaborationMetric(t, h.a, "awwo_graph_runs_total", "outcome", "cancelled"); got != 0 {
				t.Fatal("rolled-back cancellation counted", got)
			}
			allowCollaborationTerminalCommit(t, h)
			h.request(t, c, "POST", endpoint, map[string]any{}, 200)
			h.request(t, c, "POST", endpoint, map[string]any{}, 200)
			assertCollaborationMetricState(t, h, tid, gid, "cancelled", 2, 2)
			if got := collaborationMetric(t, h.a, "awwo_graph_runs_total", "outcome", "cancelled"); got != 1 {
				t.Fatal("cancelled graph count", got)
			}
		})
	}
}
