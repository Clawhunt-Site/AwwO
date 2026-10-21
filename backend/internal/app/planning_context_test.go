package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// plannerBudgetWorker is a Pi worker whose default model takes *budget bytes of prompt and instructions (its /health
// limits, read again for every plan) and answers every run with a valid plan.
func plannerBudgetWorker(t *testing.T, budget *atomic.Int64) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test",
				"limits": map[string]any{"maxContextTextBytes": budget.Load(), "messageOverheadBytes": 32}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": progressPlan})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestPlanContextRoom(t *testing.T) {
	for _, tc := range []struct{ context, excess, want int }{
		{30000, 10000, 19744}, {30000, 29744, 0}, {30000, 29745, 0}, {30000, 40000, 0}, {0, 1, 0}, {1000, -500, 1244},
	} {
		if got := planContextRoom(tc.context, tc.excess); got != tc.want {
			t.Errorf("planContextRoom(%d, %d) = %d, want %d", tc.context, tc.excess, got, tc.want)
		}
	}
}

// A plan too large for its model is refused before any run with how much canvas context the same request may carry,
// and a context of that size is admitted: the page sends a shorter view of the canvas instead of failing.
func TestPostgresPlanTooLargeSaysHowMuchContextFits(t *testing.T) {
	var budget atomic.Int64
	budget.Store(20000)
	h := newHarness(t, plannerBudgetWorker(t, &budget).URL)
	c, tid, _ := h.register(t, "plan-room@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(context, operation string, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
			map[string]string{"prompt": "Build a data product", "context": context, "operationId": operation}, status)
	}
	room := func(label string, refused map[string]any) int {
		t.Helper()
		e, _ := refused["error"].(map[string]any)
		details, _ := e["details"].(map[string]any)
		n, ok := details["contextRoom"].(float64)
		if e["code"] != "context_limit" || !ok || n != float64(int(n)) {
			t.Fatalf("%s: refusal %#v", label, refused)
		}
		return int(n)
	}
	runs := func() (n int) {
		t.Helper()
		if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM runs WHERE tenant_id=$1", tid).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}

	// 30,000 bytes of context over a 20,000-byte model: refused, no run, and told what fits.
	r := room("over the model", plan(strings.Repeat("界", 10000), "plan-room-1", 413))
	if r <= 0 || r >= 20000 {
		t.Fatalf("room %d for a 20,000-byte model", r)
	}
	if n := runs(); n != 0 {
		t.Fatalf("a refused plan stored %d runs", n)
	}
	// The room is exact up to its margin: 256 bytes more still fit, one more does not, and the room it reports
	// then is the same.
	if again := room("one byte over", plan(strings.Repeat("a", r+planContextRoomMargin+1), "plan-room-2", 413)); again != r {
		t.Fatalf("room %d, then %d for the same request", r, again)
	}
	edge := plan(strings.Repeat("a", r+planContextRoomMargin), "plan-room-3", 202)["id"].(string)
	h.awaitRun(t, c, tid, edge, "completed")
	fits := plan(strings.Repeat("a", r), "plan-room-4", 202)["id"].(string)
	h.awaitRun(t, c, tid, fits, "completed")

	// Past the plan's own bounds (120,000 UTF-16 code units of context) it is refused the same way before a model is chosen.
	if big := room("over the plan bounds", plan(strings.Repeat("a", 130000), "plan-room-5", 413)); big != maxPlanContextUnits-planContextRoomMargin {
		t.Fatalf("room %d over the plan bounds", big)
	}
	// A model too small for the request and the instructions alone leaves no room for any context.
	budget.Store(4000)
	if none := room("no room", plan(strings.Repeat("a", 3000), "plan-room-6", 413)); none != 0 {
		t.Fatalf("room %d where nothing fits", none)
	}
	if n := runs(); n != 2 {
		t.Fatalf("%d runs, want the 2 admitted plans", n)
	}

	// Context and request together past the plan's prompt bound: refused for the request's bytes too.
	if over := room("prompt over the plan bounds", h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
		map[string]string{"prompt": strings.Repeat("r", 8000), "context": strings.Repeat("a", 120000), "operationId": "plan-room-prompt"}, 413)); over != 120000-16-planContextRoomMargin {
		t.Fatalf("room %d with an 8,000-byte request", over)
	}
	// A run posted straight to the planner session is no canvas plan: it keeps the plain refusal, without a room.
	budget.Store(20000)
	var sid string
	if e := h.db.QueryRow(context.Background(), "SELECT id FROM node_sessions WHERE tenant_id=$1 AND kind='planner'", tid).Scan(&sid); e != nil {
		t.Fatal(e)
	}
	direct := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": strings.Repeat("界", 10000), "operationId": "plan-room-direct"}, 413)
	if e, _ := direct["error"].(map[string]any); e["code"] != "context_limit" || len(e["details"].(map[string]any)) != 0 {
		t.Fatalf("direct planner-session run: %#v", direct)
	}
}

func roomOf(t *testing.T, refused map[string]any) int {
	t.Helper()
	n, ok := refused["error"].(map[string]any)["details"].(map[string]any)["contextRoom"].(float64)
	if !ok {
		t.Fatalf("no room: %#v", refused)
	}
	return int(n)
}

// A request too large for the plan's prompt bound plans without the asker's personal settings, which a request short
// enough carries again: the room a refusal gives leaves space for them, and a context of that size is admitted with them.
func TestPostgresPlanRoomLeavesSpaceForPersonalSettings(t *testing.T) {
	var budget atomic.Int64
	budget.Store(100000)
	h := newHarness(t, plannerBudgetWorker(t, &budget).URL)
	c, tid, _ := h.register(t, "plan-room-personal@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	h.request(t, c, "PUT", "/auth/preferences", map[string]any{"version": 0, "preferences": map[string]any{"personalization": map[string]any{
		"enabled": true, "aboutMe": "PLAN-ROOM-ABOUT " + strings.Repeat("p", 900), "instructions": strings.Repeat("q", 1500)}}}, 200)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(context, operation string, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]string{"prompt": strings.Repeat("r", 7000), "context": context, "operationId": operation}, status)
	}
	room := roomOf(t, plan(strings.Repeat("a", 120000), "personal-room-1", 413))
	if room <= 0 || room >= 100000 {
		t.Fatalf("room %d", room)
	}
	id := plan(strings.Repeat("a", room), "personal-room-2", 202)["id"].(string)
	h.awaitRun(t, c, tid, id, "completed")
	var prompt string
	if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt); e != nil || !strings.Contains(prompt, "PLAN-ROOM-ABOUT") {
		t.Fatalf("the admitted plan lost the personal settings (%v)", e)
	}
	// Past the plan's own prompt bound, the room leaves space for them too.
	bounds := roomOf(t, h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
		map[string]string{"prompt": strings.Repeat("r", 8000), "context": strings.Repeat("a", 120000), "operationId": "personal-room-3"}, 413))
	if bounds > 120000-16-planContextRoomMargin-2400 {
		t.Fatalf("room %d past the plan's bounds leaves no space for 2,400 bytes of personal settings", bounds)
	}
}

// A plan too large for the operator's planner model alone runs on the default model; where that model has no room, the
// room is the one a context needs to run on the operator's model, and a context of that size is admitted on it.
func TestPostgresPlanRoomCountsTheOperatorPlannerModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test",
				"limits": map[string]any{"maxContextTextBytes": 4000, "messageOverheadBytes": 32},
				"models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 4000}, {"id": testPlannerModel, "provider": "bedrock", "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": progressPlan})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(server.Close)
	h := newHarness(t, server.URL)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = testPlannerModel, 20, 100, 60000
	h.a.cfg.RouteFreeModels = []string{"test-model"}
	c, tid, _ := h.register(t, "plan-room-operator@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(context, operation string, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]string{"prompt": "Build a data product", "context": context, "operationId": operation}, status)
	}
	room := roomOf(t, plan(strings.Repeat("a", 70000), "operator-room-1", 413))
	if room <= 4000 || room >= 60000 {
		t.Fatalf("room %d: the default model takes 4,000 bytes, the operator's planner model 60,000 of input", room)
	}
	id := plan(strings.Repeat("a", room), "operator-room-2", 202)["id"].(string)
	h.awaitRun(t, c, tid, id, "completed")
	if model, paid, _ := runCall(t, h, tid, id); model != testPlannerModel || !paid {
		t.Fatalf("the shorter plan ran on %q (operator-paid %v)", model, paid)
	}
	// Past that room the input bound sends it to the default model again, which refuses it.
	plan(strings.Repeat("a", room+planContextRoomMargin+1), "operator-room-3", 413)
	// Once the workspace's planner-model calls are used up (the one above), that model takes no plan however short:
	// the room is the default model's, which has none.
	h.a.cfg.PlannerPerWorkspaceDay = 1
	if spent := roomOf(t, plan(strings.Repeat("a", 70000), "operator-room-4", 413)); spent != 0 {
		t.Fatalf("room %d with the planner model's calls used up, where the default model has no room", spent)
	}
	h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay = 20, 1
	if spent := roomOf(t, plan(strings.Repeat("a", 70000), "operator-room-5", 413)); spent != 0 {
		t.Fatalf("room %d with the deployment's planner-model calls used up", spent)
	}
}

// A DeepSeek planner model never plans (userChosenProvider), so it takes none of a workspace's plans, whatever its
// allowlist names: a plan too large for the default model is told the default model's room, not that model's.
func TestPostgresPlanRoomLeavesOutADeepSeekPlannerModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test",
				"limits": map[string]any{"maxContextTextBytes": 4000, "messageOverheadBytes": 32},
				"models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 4000}, {"id": "deepseek-flash", "provider": "deepseek", "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": progressPlan})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(server.Close)
	h := newHarness(t, server.URL)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = "deepseek-flash", 20, 100, 60000
	roomFor := func(email string, allowed string) int {
		t.Helper()
		c, tid, _ := h.register(t, email)
		execSQL(t, h, `UPDATE tenants SET allowed_models=`+allowed+`,max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
		cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
		return roomOf(t, h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
			map[string]string{"prompt": "Build a data product", "context": strings.Repeat("a", 70000), "operationId": "withheld-room"}, 413))
	}
	for name, allowed := range map[string]string{"without-it": `ARRAY['test-model']`, "naming-it": `ARRAY['test-model','deepseek-flash']`, "unrestricted": `NULL`} {
		if room := roomFor("plan-room-"+name+"@awwo.invalid", allowed); room != 0 {
			t.Fatalf("%s: room %d where the planner model is a DeepSeek one and the default model has none", name, room)
		}
	}
}
