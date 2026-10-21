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

// The DeepSeek API's models (userChosenProvider) are offered to every workspace its allowlist permits, like any other
// model, but run only where someone chose them: never as an empty selection's default, a picture's switch, the planner.

func TestDeepSeekModelsAreOfferedLikeAnyOtherModel(t *testing.T) {
	base := piHealth{Model: "house", Provider: "llmgate", Models: []piModel{{ID: "house", Provider: "llmgate"},
		{ID: "flash", Provider: "deepseek"}, {ID: "alpha", Provider: "bedrock"}}}
	ids := func(h piHealth) string {
		out := []string{}
		for _, m := range h.Models {
			out = append(out, m.ID)
		}
		return strings.Join(out, ",")
	}
	// Unrestricted, read for a workspace or not, an administrator's or not: the catalogue is the worker's.
	for name, e := range map[string]modelEntitlement{"no workspace": {}, "a workspace": {tenant: "t"}} {
		if h := e.apply(base); h.Allowed != nil || ids(h) != "house,flash,alpha" {
			t.Fatalf("%s: the catalogue changed: %s %v", name, ids(h), h.Allowed)
		}
	}
	if h := (modelEntitlement{allowed: &[]string{"flash", "house"}, tenant: "t"}).apply(base); ids(h) != "house,flash" {
		t.Fatal("an allowlist naming the DeepSeek model did not offer it", ids(h))
	}
	if h := (modelEntitlement{allowed: &[]string{"alpha", "house"}, tenant: "t"}).apply(base); ids(h) != "house,alpha" {
		t.Fatal("an allowlist without the DeepSeek model offered it", ids(h))
	}
}

func TestAnEmptySelectionNeverResolvesToADeepSeekModel(t *testing.T) {
	models := []piModel{{ID: "a-flash", Provider: "deepseek"}, {ID: "b-house", Provider: "llmgate"}, {ID: "c-other", Provider: "bedrock"}}
	for _, tc := range []struct {
		name    string
		h       piHealth
		allowed *[]string
		want    string
	}{
		{"an ordinary default", piHealth{Model: "b-house", Provider: "llmgate", Models: models}, nil, "b-house"},
		{"a DeepSeek default, unrestricted", piHealth{Model: "a-flash", Provider: "deepseek", Models: models}, nil, ""},
		{"a DeepSeek default the Pi worker leaves out of its list", piHealth{Model: "z-flash", Provider: "deepseek", Models: models[1:]}, nil, ""},
		{"a DeepSeek default, an allowlist naming it", piHealth{Model: "a-flash", Provider: "deepseek", Models: models}, &[]string{"a-flash", "b-house"}, "b-house"},
		{"a DeepSeek default, an allowlist of it alone", piHealth{Model: "a-flash", Provider: "deepseek", Models: models}, &[]string{"a-flash"}, ""},
		// A Pi catalogue may list its own default without a provider: the catalogue's provider is the default's.
		{"a DeepSeek default listed without a provider", piHealth{Model: "a-flash", Provider: "deepseek",
			Models: []piModel{{ID: "a-flash"}, models[1]}}, &[]string{"a-flash", "b-house"}, "b-house"},
		{"a DeepSeek default listed without a provider, alone", piHealth{Model: "a-flash", Provider: "deepseek",
			Models: []piModel{{ID: "a-flash"}, models[1]}}, &[]string{"a-flash"}, ""},
		// The substitute is taken in allowlist order, and a DeepSeek model sorted first is passed over.
		{"a substitute after a DeepSeek model", piHealth{Model: "b-house", Provider: "llmgate", Models: models}, &[]string{"a-flash", "c-other"}, "c-other"},
	} {
		e := modelEntitlement{allowed: tc.allowed, tenant: "t"}
		stamped := e.apply(tc.h)
		if got := stamped.defaultModel(); got != tc.want {
			t.Fatalf("%s: the empty selection resolved to %q, want %q", tc.name, got, tc.want)
		}
		// An empty model sent as it is asks the worker for its own default: it has a budget only where that is not DeepSeek.
		if _, _, ok := stamped.modelLimits(""); ok != (tc.want != "") {
			t.Fatalf("%s: an empty model resolved a budget: %v", tc.name, ok)
		}
	}
}

// The page makes choices of its own too (a task's first model, Jev's assignments, a plan's model list), so every listing
// marks a model only a user may choose, the worker's own default listed without a provider included.
func TestManagedExecutionChoicesMarkTheModelsOnlyAUserMayChoose(t *testing.T) {
	h := piHealth{Model: "bare", Provider: "deepseek", Models: []piModel{{ID: "house", Provider: "llmgate"}, {ID: "flash", Provider: "deepseek"}, {ID: "bare"}}}
	marked := map[string]any{}
	for _, m := range computerModelChoices(runtimePI, h) {
		marked[m["id"].(string)] = m["userChosen"]
	}
	if marked["flash"] != true || marked["bare"] != true || marked["house"] != nil {
		t.Fatalf("the managed-execution choices marked %v", marked)
	}
	// A DeepSeek default the worker leaves out of its list is still offered to pick, marked, and never as the default.
	unlisted := piHealth{Model: "z-flash", Provider: "deepseek", Models: []piModel{{ID: "house", Provider: "llmgate"}}}
	choices := computerModelChoices(runtimePI, unlisted)
	if len(choices) != 2 || choices[1]["id"] != "z-flash" || choices[1]["userChosen"] != true || unlisted.defaultModel() != "" {
		t.Fatalf("an unlisted DeepSeek default was offered as %v (default %q)", choices, unlisted.defaultModel())
	}
}

func TestASnapshotPinnedOnADeepSeekModelFollowsTheAllowlist(t *testing.T) {
	catalog := runtimeCatalog{runtimePI: {Model: "house", Provider: "llmgate", Models: []piModel{
		{ID: "house", Provider: "llmgate", MaxContextTextBytes: 262144}, {ID: "flash", Provider: "deepseek", MaxContextTextBytes: 262144}}}}
	for _, tc := range []struct {
		name    string
		next    modelEntitlement
		refused bool
	}{
		{"unrestricted", modelEntitlement{tenant: "t"}, false},
		{"an allowlist naming it", modelEntitlement{allowed: &[]string{"flash"}, tenant: "t"}, false},
		{"an allowlist without it", modelEntitlement{allowed: &[]string{"house"}, tenant: "t"}, true},
	} {
		raw, _ := json.Marshal(executionSnapshot{Runtime: runtimePI, Model: "flash", Health: catalog[runtimePI], RuntimeHealth: catalog})
		var s executionSnapshot
		if json.Unmarshal(raw, &s) != nil {
			t.Fatal("snapshot did not round-trip")
		}
		if err := s.restamp(tc.next); (err != nil) != tc.refused {
			t.Fatalf("%s: refused=%v want %t", tc.name, err, tc.refused)
		}
	}
}

// A Pi worker that serves a DeepSeek model besides test-model, def being its own default; reached records a call on the
// DeepSeek model, and handle answers every call (nil: at once).
func deepseekPI(t *testing.T, def string, reached *atomic.Bool, handle func(http.ResponseWriter, *http.Request, observedPiCall)) *httptest.Server {
	t.Helper()
	provider := map[string]string{"test-model": "test", "deepseek-flash": "deepseek"}[def]
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": def, "provider": provider, "models": []map[string]any{
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

// The model taken off a workspace's allowlist mid-run stops the run's next call on it: each reservation reads the row
// again (reserveInvocation).
func TestPostgresADeepSeekModelTakenOffTheAllowlistStopsTheRunsNextCallOnIt(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan observedPiCall, 8)
	var seen atomic.Int32
	var reached atomic.Bool
	pi := deepseekPI(t, "test-model", &reached, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
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
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model"}}, 200)
	close(release)
	if v := h.awaitRun(t, c, tid, rid, "failed"); v["error"] != "model_not_allowed" || reached.Load() {
		t.Fatal("a DeepSeek call ran after the model left the allowlist", v, reached.Load())
	}
}

// The per-call gate holds a DeepSeek call to the workspace's allowlist like any other call, an administrator's workspace
// or not, and refuses one admitted as the operator's own (an operator-paid planner call skips the allowlist): AwwO never
// plans on a DeepSeek model.
func TestPostgresTheLastGateHoldsDeepSeekCallsToTheAllowlistAndNeverAsTheOperators(t *testing.T) {
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
		{"unrestricted, no administrator", user, nil, true},
		{"unrestricted, the operator's own", mine, nil, true},
		{"an allowlist naming it", user, []string{"test-model", "deepseek-flash"}, true},
		{"an allowlist without it, no administrator", user, []string{"test-model"}, false},
		{"an allowlist without it, the operator's own", mine, []string{"test-model"}, false},
	} {
		allow(tc.tid, tc.allowed...)
		if e := reserve(tc.tid, false); (e == nil) != tc.ok || (e != nil && !errors.Is(e, errModelNotAllowed)) {
			t.Fatalf("%s: %v, want admitted=%v", tc.name, e, tc.ok)
		}
		if e := reserve(tc.tid, true); !errors.Is(e, errModelNotAllowed) {
			t.Fatalf("%s: a DeepSeek call admitted as the operator's own was not refused: %v", tc.name, e)
		}
	}
	// A Pi catalogue may list its own default without a provider: the call's facts still say only a user may choose it
	// (invocationMetadata), its provider recorded as the worker gave it, and the gate refuses it as the operator's own.
	allow(user)
	s := executionSnapshot{Runtime: runtimePI, Model: "deepseek-flash", OperatorPaid: true, Health: piHealth{Model: "deepseek-flash",
		Provider: "deepseek", Models: []piModel{{ID: "deepseek-flash"}, {ID: "test-model", Provider: "test"}}}}
	facts := invocationMetadata(s, nil)
	if facts.Provider != "" || !facts.UserChosen || !facts.OperatorPaid {
		t.Fatalf("a providerless DeepSeek default's facts: %+v", facts)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e := h.a.reserveInvocation(ctx, user, runs[user], randomID(), "deepseek-flash", facts); !errors.Is(e, errModelNotAllowed) {
		t.Fatalf("a providerless DeepSeek default admitted as the operator's own was not refused: %v", e)
	}
	if facts := invocationMetadata(executionSnapshot{Runtime: runtimePI, Model: "test-model", Health: s.Health}, nil); facts.UserChosen {
		t.Fatalf("an ordinary model's facts say only a user may choose it: %+v", facts)
	}
}

// Graph admission and each graph child's own admission offer a DeepSeek node to any workspace its allowlist permits: an
// unrestricted workspace nobody of the operator's owns runs it to the end; one whose allowlist leaves it out is refused
// before any call.
func TestPostgresAGraphNodeOnDeepSeekRunsWhereTheAllowlistPermitsIt(t *testing.T) {
	var reached atomic.Bool
	pi := deepseekPI(t, "test-model", &reached, nil)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	admin := bootstrapTestAdmin(t, h)
	graph := func(c *http.Cookie, tid string) string {
		t.Helper()
		prefix := "/tenants/" + tid
		agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Flash", "adapterType": "pi", "model": "deepseek-flash", "instructions": "Use plain words"}, 201)["id"].(string)
		node := map[string]any{"id": "only", "kind": "session", "title": "only", "runtime": "pi", "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": agent}}
		cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Graph", "document": map[string]any{"nodes": []any{node}, "edges": []any{}}}, 201)["id"].(string)
		return prefix + "/canvases/" + cid + "/graph-runs"
	}
	c, tid, _ := h.register(t, "deepseek-graph-user@example.test")
	base := graph(c, tid)
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "deepseek-graph", "documentVersion": 1}, 202)["id"].(string)
	awaitGraph(t, h, c, base+"/"+gid, "completed")
	if !reached.Load() {
		t.Fatal("an unrestricted workspace's graph node never reached the DeepSeek model")
	}
	reached.Store(false)
	// The Agent keeps the model it stored while unrestricted; the allowlist then leaves it out.
	c2, tid2, _ := h.register(t, "deepseek-graph-listed@example.test")
	base2 := graph(c2, tid2)
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid2, map[string]any{"allowedModels": []string{"test-model"}}, 200)
	v := h.request(t, c2, "POST", base2, map[string]any{"operationId": "deepseek-graph-listed", "documentVersion": 1}, 409)
	if v["error"].(map[string]any)["code"] != "model_unavailable" || reached.Load() {
		t.Fatal("a graph on a DeepSeek model its allowlist leaves out was admitted", v, reached.Load())
	}
}

// The operator's planner model is the operator's choice, never a user's, so a DeepSeek one never plans: every canvas plan
// runs on the default model, as for any other planner refusal, the operator's own and an allowlist naming it included.
func TestPostgresACanvasPlanNeverRunsOnADeepSeekPlannerModel(t *testing.T) {
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
	cg, granted, _ := h.register(t, "deepseek-planner-granted@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['test-model','deepseek-flash'] WHERE id=$1`, granted)
	co, mine, adminID := h.register(t, "deepseek-planner-operator@awwo.invalid")
	makePlatformAdmin(t, h, adminID)
	for _, tc := range []struct {
		name string
		c    *http.Cookie
		tid  string
	}{{"unrestricted", cu, user}, {"allowlisted with it", cg, granted}, {"operator", co, mine}} {
		if m, paid, _ := plannedOn(t, h, tc.c, tc.tid, "deepseek-plan-"+strings.ReplaceAll(tc.name, " ", "-")); m != "test-model" || paid {
			t.Fatalf("%s: planned on %q (operator-paid %v), want the default model", tc.name, m, paid)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(asked, []string{"test-model", "test-model", "test-model"}) {
		t.Fatalf("the worker was asked for %v", asked)
	}
}

// A picture never moves a run onto a DeepSeek model, wherever the workspace may use one: the run moves to another model
// that sees, or stays where it was.
func TestPostgresAPictureNeverMovesARunOntoADeepSeekModel(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	_, user, _ := h.register(t, "deepseek-vision-user@example.test")
	_, mine, adminID := h.register(t, "deepseek-vision-operator@example.test")
	makePlatformAdmin(t, h, adminID)
	_, granted, _ := h.register(t, "deepseek-vision-granted@example.test")
	execSQL(t, h, "UPDATE tenants SET allowed_models=ARRAY['text-only','deepseek-flash','gate-vision'] WHERE id=$1", granted)
	both := piHealth{ImageInput: true, Model: "text-only", Provider: "llmgate", Models: []piModel{
		{ID: "text-only", Provider: "llmgate", Input: []string{"text"}},
		{ID: "deepseek-flash", Provider: "deepseek", Input: []string{"text", "image"}},
		{ID: "gate-vision", Provider: "llmgate", Input: []string{"text", "image"}},
	}}
	only := piHealth{ImageInput: true, Model: "text-only", Provider: "llmgate", Models: both.Models[:2]}
	picture := uploadAttachment{Kind: uploadKindImage, ContentType: "image/png", storagePath: "u/p.png", Size: 10,
		SHA256: strings.Repeat("a", 64), pixels: 100}
	switched := func(tid string, health piHealth) string {
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
	for _, tid := range []string{user, mine, granted} {
		if got := switched(tid, both); got != "gate-vision" {
			t.Fatalf("a picture moved the run to %q, want gate-vision", got)
		}
		if got := switched(tid, only); got != "text-only" {
			t.Fatalf("a picture moved the run to %q with only a DeepSeek model seeing, want it to stay", got)
		}
	}
}

// listed is a model listing's ids as a client asking with marks (modelMarksHeader, "" for none) is shown them; every
// listed DeepSeek model, and only it, is marked userChosen, and the reply varies with the header.
func listed(t *testing.T, h *harness, cookie *http.Cookie, path, marks string) string {
	t.Helper()
	r, e := http.NewRequest("GET", h.server.URL+"/api/v1"+path, nil)
	if e != nil {
		t.Fatal(e)
	}
	r.AddCookie(cookie)
	if marks != "" {
		r.Header.Set(modelMarksHeader, marks)
	}
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	var v struct {
		Models []map[string]any `json:"models"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&v) != nil || !strings.Contains(strings.Join(resp.Header.Values("Vary"), ","), modelMarksHeader) {
		t.Fatalf("GET %s: %d, Vary %v", path, resp.StatusCode, resp.Header.Values("Vary"))
	}
	ids := []string{}
	for _, m := range v.Models {
		id, _ := m["id"].(string)
		if (m["userChosen"] == true) != (id == "deepseek-flash") {
			t.Fatalf("GET %s marked %s %v", path, id, m["userChosen"])
		}
		ids = append(ids, id)
	}
	return strings.Join(ids, ",")
}

func TestPostgresDeepSeekModelsAreOfferedToEveryWorkspaceItsAllowlistPermits(t *testing.T) {
	var reached atomic.Bool
	pi := deepseekPI(t, "test-model", &reached, nil)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "deepseek-offered@example.test")
	admin := bootstrapTestAdmin(t, h)
	// As the page asks (apps/web saas/api.ts): it never picks a userChosen model by itself (canvas/userChosenModels.ts).
	models := func(cookie *http.Cookie, tid string) string {
		t.Helper()
		return listed(t, h, cookie, "/tenants/"+tid+"/runtime", "userChosen")
	}
	if got := models(c, tid); got != "test-model,deepseek-flash" {
		t.Fatal("an unrestricted workspace nobody of the operator's owns was not offered the DeepSeek model", got)
	}
	// A client that does not say it honours the mark, a page of an earlier release still open in a tab among them,
	// might pick the model by itself, so neither listing shows it one; one that says so among other marks is shown it.
	for _, path := range []string{"/runtime", "/computer-runtime"} {
		if got := listed(t, h, c, "/tenants/"+tid+path, ""); got != "test-model" {
			t.Fatalf("%s showed a client that does not honour the mark %s", path, got)
		}
		if got := listed(t, h, c, "/tenants/"+tid+path, "other"); got != "test-model" {
			t.Fatalf("%s showed a client of other marks %s", path, got)
		}
		if got := listed(t, h, c, "/tenants/"+tid+path, "other, userChosen"); got != "test-model,deepseek-flash" {
			t.Fatalf("%s showed the page %s", path, got)
		}
	}
	prefix := "/tenants/" + tid
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Canvas", "document": map[string]any{"nodes": []map[string]string{{"id": "node-a"}}}}, 201)["id"].(string)
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Flash", "adapterType": "pi", "model": "deepseek-flash", "instructions": "Use plain words"}, 201)["id"].(string)
	sid := h.request(t, c, "POST", prefix+"/sessions", map[string]any{"canvasId": cid, "nodeId": "node-a", "agentId": agent, "title": "Thread"}, 201)["id"].(string)
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "deepseek-offered"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if !reached.Load() {
		t.Fatal("the run never reached the DeepSeek model")
	}
	// An allowlist that names it offers it; one that does not, does not.
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model", "deepseek-flash"}}, 200)
	if got := models(c, tid); got != "test-model,deepseek-flash" {
		t.Fatal("an allowlist naming the DeepSeek model did not offer it", got)
	}
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model"}}, 200)
	if got := models(c, tid); got != "test-model" {
		t.Fatal("an allowlist without the DeepSeek model offered it", got)
	}
}

// A worker whose own default is a DeepSeek model gives an empty selection no default where nothing else is entitled,
// and another entitled model where one is: a run without a model never lands on DeepSeek.
func TestPostgresARunWithoutAModelNeverLandsOnADeepSeekDefault(t *testing.T) {
	var reached atomic.Bool
	pi := deepseekPI(t, "deepseek-flash", &reached, nil)
	defer pi.Close()
	h := newHarness(t, pi.URL)
	admin := bootstrapTestAdmin(t, h)
	run := func(c *http.Cookie, tid, operation string, status int) map[string]any {
		t.Helper()
		prefix := "/tenants/" + tid
		cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Canvas", "document": map[string]any{"nodes": []map[string]string{{"id": "node-a"}}}}, 201)["id"].(string)
		agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Plain", "adapterType": "pi", "instructions": "Use plain words"}, 201)["id"].(string)
		sid := h.request(t, c, "POST", prefix+"/sessions", map[string]any{"canvasId": cid, "nodeId": "node-a", "agentId": agent, "title": "Thread"}, 201)["id"].(string)
		return h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": operation}, status)
	}
	c, tid, _ := h.register(t, "deepseek-default-open@example.test")
	if v := run(c, tid, "deepseek-default-open", 409); v["error"].(map[string]any)["code"] != "model_unavailable" || reached.Load() {
		t.Fatal("an empty selection was not refused on a worker whose default is a DeepSeek model", v, reached.Load())
	}
	c2, tid2, _ := h.register(t, "deepseek-default-listed@example.test")
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid2, map[string]any{"allowedModels": []string{"deepseek-flash", "test-model"}}, 200)
	v := run(c2, tid2, "deepseek-default-listed", 202)
	h.awaitRun(t, c2, tid2, v["id"].(string), "completed")
	if model, _, _ := runCall(t, h, tid2, v["id"].(string)); model != "test-model" || reached.Load() {
		t.Fatal("an empty selection ran on", model, reached.Load())
	}
}
