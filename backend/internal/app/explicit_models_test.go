package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The DeepSeek API's models are offered only explicitly (explicitOnlyProvider): to a workspace whose allowlist names
// them or that a platform administrator owns, never to an unrestricted workspace alone.

func TestDeepSeekModelsAreWithheldFromAnUnrestrictedWorkspaceTheOperatorDoesNotOwn(t *testing.T) {
	base := piHealth{Model: "house", Provider: "llmgate", Limits: map[string]any{"maxContextTextBytes": float64(1024), "messageOverheadBytes": float64(8)},
		Models: []piModel{{ID: "house", Provider: "llmgate", MaxContextTextBytes: 1024}, {ID: "flash", Provider: "deepseek", MaxContextTextBytes: 4096},
			{ID: "alpha", Provider: "bedrock", MaxContextTextBytes: 2048}}}
	ids := func(h piHealth) string {
		out := []string{}
		for _, m := range h.Models {
			out = append(out, m.ID)
		}
		return strings.Join(out, ",")
	}
	// Built without a workspace, or for the operator's own, nothing is withheld: the catalogue is the worker's.
	for name, e := range map[string]modelEntitlement{"no workspace": {}, "operator's own": {tenant: "t", operator: true}} {
		if h := e.apply(base); h.Allowed != nil || ids(h) != "house,flash,alpha" {
			t.Fatalf("%s: the catalogue changed: %s %v", name, ids(h), h.Allowed)
		}
	}
	withheld := modelEntitlement{tenant: "t"}.apply(base)
	if ids(withheld) != "house,alpha" || withheld.Allowed == nil || fmt.Sprint(*withheld.Allowed) != "[alpha house]" {
		t.Fatalf("the DeepSeek model was not withheld as an allowlist of the rest: %s %v", ids(withheld), withheld.Allowed)
	}
	if _, _, ok := withheld.modelLimits("flash"); ok {
		t.Fatal("a withheld model resolved a budget")
	}
	if b, o, ok := withheld.modelLimits(""); !ok || b != 1024 || o != 8 || withheld.defaultModel() != "house" {
		t.Fatal("the workspace's default changed", b, o, ok, withheld.defaultModel())
	}
	// An allowlist naming the model is the explicit grant, for any workspace.
	if h := (modelEntitlement{allowed: &[]string{"flash", "house"}, tenant: "t"}).apply(base); ids(h) != "house,flash" {
		t.Fatal("an allowlist naming the DeepSeek model did not offer it", ids(h))
	}
	// A catalogue without one is left exactly as it was: no workspace sees a difference until a DeepSeek model exists.
	plain := piHealth{Model: "house", Provider: "llmgate", Models: []piModel{{ID: "house", Provider: "llmgate"}, {ID: "alpha", Provider: "bedrock"}}}
	if h := (modelEntitlement{tenant: "t"}).apply(plain); h.Allowed != nil || ids(h) != "house,alpha" {
		t.Fatal("a catalogue without a DeepSeek model was restricted", ids(h), h.Allowed)
	}
	// A worker whose own default is a DeepSeek model has it held like any other, and a restamp keeps it held.
	onDeepSeek := piHealth{Model: "flash", Provider: "deepseek", Models: []piModel{{ID: "flash", Provider: "deepseek"}, {ID: "house", Provider: "llmgate"}}}
	once := modelEntitlement{tenant: "t"}.apply(onDeepSeek)
	twice := modelEntitlement{tenant: "t"}.apply(once)
	for name, h := range map[string]piHealth{"stamped": once, "restamped": twice} {
		if h.defaultModel() != "house" || h.Allowed == nil {
			t.Fatalf("%s: the DeepSeek default was not withheld: %q %v", name, h.defaultModel(), h.Allowed)
		}
		if _, _, ok := h.modelLimits("flash"); ok {
			t.Fatalf("%s: the withheld default resolved a budget", name)
		}
	}
}

func TestASnapshotPinnedOnADeepSeekModelIsRefusedWhereItIsWithheld(t *testing.T) {
	catalog := runtimeCatalog{runtimePI: {Model: "house", Provider: "llmgate", Models: []piModel{
		{ID: "house", Provider: "llmgate", MaxContextTextBytes: 262144}, {ID: "flash", Provider: "deepseek", MaxContextTextBytes: 262144}}}}
	for _, tc := range []struct {
		name, model string
		next        modelEntitlement
		refused     bool
	}{
		{"operator's own", "flash", modelEntitlement{tenant: "t", operator: true}, false},
		{"withheld", "flash", modelEntitlement{tenant: "t"}, true},
		{"another model of the same catalogue", "house", modelEntitlement{tenant: "t"}, false},
		{"granted by an allowlist", "flash", modelEntitlement{allowed: &[]string{"flash"}, tenant: "t"}, false},
	} {
		raw, _ := json.Marshal(executionSnapshot{Runtime: runtimePI, Model: tc.model, Health: catalog[runtimePI], RuntimeHealth: catalog})
		var s executionSnapshot
		if json.Unmarshal(raw, &s) != nil {
			t.Fatal("snapshot did not round-trip")
		}
		if err := s.restamp(tc.next); (err != nil) != tc.refused {
			t.Fatalf("%s: refused=%v want %t", tc.name, err, tc.refused)
		}
	}
}

// A Pi worker that serves a DeepSeek model besides its own default; reached records a call on it, and handle answers
// every call (nil: at once).
func deepseekPI(t *testing.T, reached *atomic.Bool, handle func(http.ResponseWriter, *http.Request, observedPiCall)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{
				{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144},
				{"id": "deepseek-flash", "provider": "deepseek", "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var b observedPiCall
		if e := json.NewDecoder(r.Body).Decode(&b); e != nil {
			t.Error(e)
		}
		if b.Model == "deepseek-flash" {
			reached.Store(true)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		if handle != nil {
			handle(w, r, b)
			return
		}
		completePi(w, "OUTPUT")
	}))
}

// A grant withdrawn mid-run stops the next DeepSeek call at the per-call gate: the allowlist that named the model is
// cleared to none, which grants nothing to a workspace no platform administrator owns.
func TestPostgresAWithdrawnDeepSeekGrantStopsTheRunsNextDeepSeekCall(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan observedPiCall, 8)
	var seen atomic.Int32
	var reached atomic.Bool
	pi := deepseekPI(t, &reached, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		entered <- b
		if seen.Add(1) == 1 {
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		completePi(w, "MEMBER-OUTPUT")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "deepseek-grant@example.test")
	admin := bootstrapTestAdmin(t, h)
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model", "deepseek-flash"}}, 200)
	// The author runs first on the node's model and waits; the critic is the DeepSeek member.
	team := fixtureTeam("sequential")
	team.Members[1].Model = "deepseek-flash"
	_, _, sid := installTeam(t, h, c, tid, team)
	rid := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "TEAM-TASK", "operationId": "deepseek-withdrawn"}, 202)["id"].(string)
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the first member never reached the worker")
	}
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": nil}, 200)
	close(release)
	if v := h.awaitRun(t, c, tid, rid, "failed"); v["error"] != "model_not_allowed" || reached.Load() {
		t.Fatal("a DeepSeek call ran after its grant was withdrawn", v, reached.Load())
	}
}

// The per-call gate decides a DeepSeek call as modelEntitlement.grants does, operator-paid planner calls included (they
// skip the ordinary allowlist check): an allowlist must name the model, even in a workspace an administrator owns, and a
// workspace without one must be an administrator's. Each reservation reads the row again, so this is also what a call
// waiting for a slot meets after the grant was withdrawn.
func TestPostgresTheLastGateHoldsEveryDeepSeekCallToTheLiveGrant(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.PlannerModel = "deepseek-flash"
	cu, user, _ := h.register(t, "deepseek-gate-user@example.test")
	co, mine, adminID := h.register(t, "deepseek-gate-operator@example.test")
	makePlatformAdmin(t, h, adminID)
	runs := map[string]string{user: routeHarnessRun(t, h, cu, user, ""), mine: routeHarnessRun(t, h, co, mine, "")}
	reserve := func(tid string, planner bool) error {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return h.a.reserveInvocation(ctx, tid, runs[tid], randomID(), "deepseek-flash",
			&invocationFacts{Runtime: runtimePI, Model: "deepseek-flash", Provider: "deepseek", OperatorPaid: planner, Admission: "not_attempted"})
	}
	allow := func(tid string, models ...string) {
		t.Helper()
		if models == nil {
			execSQL(t, h, "UPDATE tenants SET allowed_models=NULL WHERE id=$1", tid)
			return
		}
		execSQL(t, h, "UPDATE tenants SET allowed_models=$2::text[] WHERE id=$1", tid, models)
	}
	for _, tc := range []struct {
		name    string
		tid     string
		allowed []string
		ok      bool
	}{
		{"unrestricted, no administrator", user, nil, false},
		{"unrestricted, the operator's own", mine, nil, true},
		{"an allowlist naming it", user, []string{"test-model", "deepseek-flash"}, true},
		{"an allowlist without it, no administrator", user, []string{"test-model"}, false},
		{"an allowlist without it, the operator's own", mine, []string{"test-model"}, false},
		{"an allowlist naming it, the operator's own", mine, []string{"deepseek-flash"}, true},
	} {
		allow(tc.tid, tc.allowed...)
		for _, planner := range []bool{false, true} {
			if e := reserve(tc.tid, planner); (e == nil) != tc.ok || (e != nil && !errors.Is(e, errModelNotAllowed)) {
				t.Fatalf("%s (operator-paid %v): %v, want admitted=%v", tc.name, planner, e, tc.ok)
			}
		}
	}
	// Any other provider's call is held to the allowlist alone, as before (the planner's to nothing).
	allow(user, "test-model")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e := h.a.reserveInvocation(ctx, user, runs[user], randomID(), "test-model", &invocationFacts{Runtime: runtimePI, Model: "test-model", Provider: "test", Admission: "not_attempted"}); e != nil {
		t.Fatal("a call on an allowlisted model of another provider was refused:", e)
	}
}

// Graph admission and each graph child's own admission bind the workspace's owner (forWorkspace): the operator's graph
// runs a DeepSeek node to the end, and the same graph in a workspace nobody of the operator's owns is refused before
// any call.
func TestPostgresAGraphNodeOnDeepSeekRunsForTheOperatorOnly(t *testing.T) {
	var reached atomic.Bool
	pi := deepseekPI(t, &reached, nil)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	graph := func(c *http.Cookie, tid string) string {
		t.Helper()
		prefix := "/tenants/" + tid
		agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Flash", "adapterType": "pi", "model": "deepseek-flash", "instructions": "Use plain words"}, 201)["id"].(string)
		node := map[string]any{"id": "only", "kind": "session", "title": "only", "runtime": "pi", "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": agent}}
		cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Graph", "document": map[string]any{"nodes": []any{node}, "edges": []any{}}}, 201)["id"].(string)
		return prefix + "/canvases/" + cid + "/graph-runs"
	}
	c, tid, uid := h.register(t, "deepseek-graph-operator@example.test")
	makePlatformAdmin(t, h, uid)
	base := graph(c, tid)
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "deepseek-graph", "documentVersion": 1}, 202)["id"].(string)
	awaitGraph(t, h, c, base+"/"+gid, "completed")
	if !reached.Load() {
		t.Fatal("the operator's graph node never reached the DeepSeek model")
	}
	reached.Store(false)
	c2, tid2, _ := h.register(t, "deepseek-graph-user@example.test")
	v := h.request(t, c2, "POST", graph(c2, tid2), map[string]any{"operationId": "deepseek-graph-user", "documentVersion": 1}, 409)
	if v["error"].(map[string]any)["code"] != "model_unavailable" || reached.Load() {
		t.Fatal("a graph on a withheld DeepSeek model was admitted", v, reached.Load())
	}
}

// The operator's planner model is outside a workspace's allowlist, but a DeepSeek one is not: where the workspace may not
// use it, a canvas plan runs on the default model, as for any other planner refusal; the operator's own plans run on it.
func TestPostgresACanvasPlanLeavesADeepSeekPlannerModelWhereItIsWithheld(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{
				{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144},
				{"id": "deepseek-flash", "provider": "deepseek", "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		asked = append(asked, body.Model)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": progressPlan})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = "deepseek-flash", 5, 100, 60000
	cu, user, _ := h.register(t, "deepseek-planner-user@awwo.invalid")
	cl, listed, _ := h.register(t, "deepseek-planner-listed@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['test-model'] WHERE id=$1`, listed)
	cg, granted, _ := h.register(t, "deepseek-planner-granted@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['test-model','deepseek-flash'] WHERE id=$1`, granted)
	co, mine, adminID := h.register(t, "deepseek-planner-operator@awwo.invalid")
	makePlatformAdmin(t, h, adminID)
	for _, tc := range []struct {
		name      string
		c         *http.Cookie
		tid, want string
		paid      bool
	}{{"unrestricted", cu, user, "test-model", false}, {"allowlisted without it", cl, listed, "test-model", false},
		{"allowlisted with it", cg, granted, "deepseek-flash", true}, {"operator", co, mine, "deepseek-flash", true}} {
		if m, paid, _ := plannedOn(t, h, tc.c, tc.tid, "deepseek-plan-"+strings.ReplaceAll(tc.name, " ", "-")); m != tc.want || paid != tc.paid {
			t.Fatalf("%s: planned on %q (operator-paid %v), want %q (%v)", tc.name, m, paid, tc.want, tc.paid)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(asked, []string{"test-model", "test-model", "deepseek-flash", "deepseek-flash"}) {
		t.Fatalf("the worker was asked for %v", asked)
	}
}

// A planner run's catalogue is the operator's own, unstamped (runs.go), so a picture must never move a run onto a
// DeepSeek model the workspace may not use; the operator's own workspace and an allowlist naming it may move there.
func TestPostgresAPictureNeverMovesARunOntoAWithheldDeepSeekModel(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	_, user, _ := h.register(t, "deepseek-vision-user@example.test")
	_, mine, adminID := h.register(t, "deepseek-vision-operator@example.test")
	makePlatformAdmin(t, h, adminID)
	_, granted, _ := h.register(t, "deepseek-vision-granted@example.test")
	execSQL(t, h, "UPDATE tenants SET allowed_models=ARRAY['text-only','deepseek-flash','gate-vision'] WHERE id=$1", granted)
	health := piHealth{ImageInput: true, Model: "text-only", Provider: "llmgate", Models: []piModel{
		{ID: "text-only", Provider: "llmgate", Input: []string{"text"}},
		{ID: "deepseek-flash", Provider: "deepseek", Input: []string{"text", "image"}},
		{ID: "gate-vision", Provider: "llmgate", Input: []string{"text", "image"}},
	}}
	picture := uploadAttachment{Kind: uploadKindImage, ContentType: "image/png", storagePath: "u/p.png", Size: 10,
		SHA256: strings.Repeat("a", 64), pixels: 100}
	switched := func(tid string) string {
		t.Helper()
		tx, e := h.db.Begin(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(context.Background())
		s := executionSnapshot{Model: "text-only", Health: health}
		if e := h.a.switchToSeeingModel(context.Background(), tx, tid, nil, &s, &uploadAttachments{Items: []uploadAttachment{picture}}); e != nil {
			t.Fatal(e)
		}
		return s.Model
	}
	for tid, want := range map[string]string{user: "gate-vision", mine: "deepseek-flash", granted: "deepseek-flash"} {
		if got := switched(tid); got != want {
			t.Fatalf("a picture moved the run to %q, want %q", got, want)
		}
	}
}

func TestPostgresDeepSeekModelsAreOfferedToTheOperatorAndToExplicitGrantsOnly(t *testing.T) {
	var reached atomic.Bool
	pi := deepseekPI(t, &reached, nil)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, uid := h.register(t, "deepseek-withheld@example.test")
	admin := bootstrapTestAdmin(t, h)
	models := func(cookie *http.Cookie, tid string) string {
		t.Helper()
		ids := []string{}
		for _, raw := range h.request(t, cookie, "GET", "/tenants/"+tid+"/runtime", nil, 200)["models"].([]any) {
			ids = append(ids, raw.(map[string]any)["id"].(string))
		}
		return strings.Join(ids, ",")
	}
	if got := models(c, tid); got != "test-model" {
		t.Fatal("an unrestricted workspace nobody of the operator's owns was offered the DeepSeek model", got)
	}
	// An Agent may store the model (authorization, not availability), but no run on it is admitted there.
	prefix := "/tenants/" + tid
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Canvas", "document": map[string]any{"nodes": []map[string]string{{"id": "node-a"}}}}, 201)["id"].(string)
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Flash", "adapterType": "pi", "model": "deepseek-flash", "instructions": "Use plain words"}, 201)["id"].(string)
	sid := h.request(t, c, "POST", prefix+"/sessions", map[string]any{"canvasId": cid, "nodeId": "node-a", "agentId": agent, "title": "Thread"}, 201)["id"].(string)
	v := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "deepseek-withheld"}, 409)
	if v["error"].(map[string]any)["code"] != "model_unavailable" || reached.Load() {
		t.Fatal("a run on a withheld DeepSeek model was not refused before any call", v, reached.Load())
	}
	// The operator's own workspace is offered it and runs it.
	makePlatformAdmin(t, h, uid)
	if got := models(c, tid); got != "test-model,deepseek-flash" {
		t.Fatal("the operator's own workspace was not offered the DeepSeek model", got)
	}
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "deepseek-operator"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if !reached.Load() {
		t.Fatal("the operator's run never reached the DeepSeek model")
	}
	// An allowlist that names it offers it to any workspace; one that does not, does not.
	c2, tid2, _ := h.register(t, "deepseek-granted@example.test")
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid2, map[string]any{"allowedModels": []string{"test-model", "deepseek-flash"}}, 200)
	if got := models(c2, tid2); got != "test-model,deepseek-flash" {
		t.Fatal("an allowlist naming the DeepSeek model did not offer it", got)
	}
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid2, map[string]any{"allowedModels": []string{"test-model"}}, 200)
	if got := models(c2, tid2); got != "test-model" {
		t.Fatal("an allowlist without the DeepSeek model offered it", got)
	}
}
