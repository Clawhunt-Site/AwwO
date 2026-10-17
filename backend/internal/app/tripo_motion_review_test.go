package app

import (
	"sync"
	"testing"
	"time"
)

// Findings of the 2026-10-17 review of the motion chain: a step Tripo answered busy (no task made) is not counted as
// sent, so a restart during the wait sends it instead of failing the chain as a lost answer; and a free workspace
// cannot rig or animate a model, whose steps cost the operator's balance several times a model.

func TestPostgresTripoMotionBusyStepIsNotCountedAsSent(t *testing.T) {
	h, _ := newMediaHarness(t)
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "tripo-motion-busy@example.test")
	// A workspace is on its owner's plan only with route limits (entitledPlanSQL).
	execSQL(t, h, `UPDATE tenants SET route_limits='{"media":1}'::jsonb WHERE id=$1`, tid)
	now := time.Now()
	givePlan(t, h, "tripo-motion-busy@example.test", "max", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 10000)
	_, canvas := mediaCanvas(t, h, c, tid, motionNode("hero", "tripo.v3-1", map[string]any{"rig": "biped", "motion": "combat"}))
	var mu sync.Mutex
	busy := true
	f.set(nil, func(path string) (int, any) {
		mu.Lock()
		defer mu.Unlock()
		if path == "/animations/rig" && busy {
			return 200, map[string]any{"code": 2000, "message": "the pool is full"}
		}
		return 0, nil
	})
	rid := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a knight in armour", 202)["id"].(string)
	deadline := time.Now().Add(10 * time.Second)
	for !slicesContainsPath(f.paths(), "/animations/rig") {
		if time.Now().After(deadline) {
			t.Fatal("the rig was never sent", f.paths())
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Tripo answered busy: the chain waits to send the rig again, and the API shuts down meanwhile.
	time.Sleep(50 * time.Millisecond)
	h.a.Close()
	var status string
	var sent *int
	if e := h.db.QueryRow(t.Context(), "SELECT status,(media_task->>'motionSent')::int FROM runs WHERE id=$1", rid).Scan(&status, &sent); e != nil {
		t.Fatal(e)
	}
	if status != "running" || sent == nil || *sent != 0 {
		t.Fatal("a busy answer left the step counted as sent", status, sent)
	}
	mu.Lock()
	busy = false
	mu.Unlock()
	next := New(h.db, h.a.cfg)
	f.configure(next)
	if e := next.Start(t.Context()); e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	if status, code := awaitRunRow(t, h, tid, rid, "completed", "failed"); status != "completed" {
		t.Fatal("the chain after a busy answer and a restart", status, code)
	}
}

func TestPostgresTripoMotionNeedsAPaidPlan(t *testing.T) {
	h, _ := newMediaHarness(t)
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "tripo-motion-free@example.test")
	_, canvas := mediaCanvas(t, h, c, tid,
		motionNode("hero", "tripo.v3-1", map[string]any{"rig": "biped", "motion": "combat"}),
		motionNode("statue", "tripo.v3-1", map[string]any{}))
	refused := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a knight in armour", 402)
	if errorCode(refused) != "model3d_motion_plan_required" {
		t.Fatal("a free workspace rigged a model", refused)
	}
	if got := f.paths(); len(got) != 0 {
		t.Fatal("a refused chain reached Tripo", got)
	}
	// A model without a skeleton is still free.
	if run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 1)["issueId"].(string), "a stone statue", 202); run["id"] == nil {
		t.Fatal(run)
	}
}

func slicesContainsPath(paths []string, want string) bool {
	for _, p := range paths {
		if p == want {
			return true
		}
	}
	return false
}
