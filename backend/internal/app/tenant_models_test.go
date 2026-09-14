package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func restrictedModels(ids ...string) modelEntitlement {
	list := append([]string{}, ids...)
	return modelEntitlement{allowed: &list}
}

func TestAllowedModelsNormalizationDistinguishesAbsentNullAndEmpty(t *testing.T) {
	value, set, err := normalizeAllowedModels(nil)
	if !value.unrestricted() || set || err != nil {
		t.Fatal("absent field must leave the entitlement alone", value, set, err)
	}
	if value, set, err = normalizeAllowedModels(json.RawMessage(`null`)); !value.unrestricted() || !set || err != nil {
		t.Fatal("explicit null must clear the restriction", value, set, err)
	}
	if value, set, err = normalizeAllowedModels(json.RawMessage(`[]`)); value.unrestricted() || value.permits("anything") || !set || err != nil {
		t.Fatal("an empty list must be storable and mean blocked", value, set, err)
	}
	if list, ok := value.column().([]string); !ok || len(list) != 0 {
		t.Fatal("an empty list must write an empty array, not NULL", value.column())
	}
	value, _, err = normalizeAllowedModels(json.RawMessage(`["b","a","b"]`))
	if err != nil || fmt.Sprint(value.column()) != "[a b]" {
		t.Fatal("duplicates must collapse into a canonical list", value.column(), err)
	}
	if value, _, err = normalizeAllowedModels(json.RawMessage(`["qwen3:8b","org/model"]`)); err != nil || !value.permits("qwen3:8b") || !value.permits("org/model") {
		t.Fatal("worker ids outside one worker's profile grammar must remain storable", value.column(), err)
	}
	long := strings.Repeat("m", 201)
	many := make([]string, 65)
	for i := range many {
		many[i] = fmt.Sprintf("model-%d", i)
	}
	tooMany, _ := json.Marshal(many)
	for _, raw := range []string{`["a b"]`, `["a,b"]`, `[""]`, `["a\tb"]`, `[1]`, `"a"`, `{}`, `["` + long + `"]`, string(tooMany)} {
		if value, _, err = normalizeAllowedModels(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted an impossible allowlist: %s", raw)
		}
		if value.unrestricted() || value.permits("test-model") {
			t.Fatalf("a rejected allowlist returned an entitlement that permits: %s", raw)
		}
	}
	// A malformed stored list denies, and the returned entitlement is safe even if a
	// caller were to ignore the error.
	entitlement, err := newModelEntitlement(true, []string{"ok", "not ok"})
	if err == nil || entitlement.permits("ok") || entitlement.unrestricted() {
		t.Fatal("a malformed stored allowlist must fail closed", err)
	}
	if entitlement, err = newModelEntitlement(false, nil); err != nil || !entitlement.unrestricted() || !entitlement.permits("anything") {
		t.Fatal("a workspace without a list must stay unrestricted", err)
	}
	if entitlement.column() != nil {
		t.Fatal("an unrestricted entitlement must write NULL", entitlement.column())
	}
}

func TestEntitlementResolvesModelsWithoutFallingBackOutsideIt(t *testing.T) {
	base := piHealth{Model: "house-default", Provider: "test", Limits: map[string]any{"maxContextTextBytes": float64(1024), "messageOverheadBytes": float64(8)},
		Models: []piModel{{ID: "house-default", MaxContextTextBytes: 1024}, {ID: "tenant-only", MaxContextTextBytes: 3000, MessageOverheadBytes: 16}, {ID: "private-kb", MaxContextTextBytes: 4096}}}
	open := modelEntitlement{}.apply(base)
	if open.Allowed != nil || len(open.Models) != 3 || open.defaultModel() != "house-default" {
		t.Fatal("an unrestricted workspace must see the catalog unchanged", open)
	}
	if b, o, ok := open.modelLimits(""); !ok || b != 1024 || o != 8 {
		t.Fatal("unrestricted default resolution changed", b, o, ok)
	}
	// Excluding the worker's own default must redirect to an entitled model with
	// that model's own budget, never silently to the house default.
	narrow := restrictedModels("tenant-only").apply(base)
	if len(narrow.Models) != 1 || narrow.Models[0].ID != "tenant-only" || narrow.defaultModel() != "tenant-only" {
		t.Fatal("catalog was not filtered to the entitlement", narrow)
	}
	if b, o, ok := narrow.modelLimits(""); !ok || b != 3000 || o != 16 {
		t.Fatal("empty selection borrowed the excluded default's budget", b, o, ok)
	}
	for _, model := range []string{"house-default", "private-kb"} {
		if _, _, ok := narrow.modelLimits(model); ok {
			t.Fatal("unentitled model resolved a budget", model)
		}
	}
	blocked := restrictedModels().apply(base)
	if blocked.defaultModel() != "" {
		t.Fatal("an empty entitlement resolved a default model", blocked.defaultModel())
	}
	for _, model := range []string{"", "house-default", "tenant-only"} {
		if _, _, ok := blocked.modelLimits(model); ok {
			t.Fatal("an empty entitlement admitted a model", model)
		}
	}
	// An id the worker no longer advertises is filtered out rather than trusted, so
	// the workspace resolves to nothing instead of to an unpublished model.
	stale := restrictedModels("retired-model").apply(base)
	if len(stale.Models) != 0 || stale.defaultModel() != "" {
		t.Fatal("an unadvertised entitlement produced a runnable model", stale)
	}
	// The entitlement belongs to the workspace, so a catalog a worker sent with one
	// already set cannot restrict or widen anything.
	forged := piHealth{Model: "house-default", Allowed: &[]string{"forged"}, Models: base.Models}
	if (modelEntitlement{}).apply(forged).Allowed != nil {
		t.Fatal("a worker-supplied entitlement survived stamping")
	}
}

func TestSnapshotRestampSurvivesPersistenceAndRefusesLostModels(t *testing.T) {
	catalog := runtimeCatalog{runtimePI: {Model: "test-model", Models: []piModel{{ID: "test-model", MaxContextTextBytes: 262144}, {ID: "alternate", MaxContextTextBytes: 262144}}}}
	team := fixtureTeam("sequential")
	resolved, err := resolveTeam(&team, runtimePI, "test-model", catalog)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := executionSnapshot{Runtime: runtimePI, Model: "test-model", Team: resolved, Health: catalog[runtimePI], RuntimeHealth: catalog}
	raw, _ := json.Marshal(snapshot)
	// Admission always re-reads the stored snapshot, so each case restamps a fresh
	// decode: stamping narrows a catalog and must never be asked to widen one.
	pinned := func() executionSnapshot {
		t.Helper()
		var s executionSnapshot
		if json.Unmarshal(raw, &s) != nil {
			t.Fatal("snapshot did not round-trip")
		}
		return s
	}
	for _, tc := range []struct {
		name    string
		next    modelEntitlement
		refused bool
	}{
		{"unrestricted", modelEntitlement{}, false},
		{"both models entitled", restrictedModels("test-model", "alternate"), false},
		// The critic member selects "alternate": removing it must refuse the whole
		// pinned snapshot even though the node's own model is still entitled.
		{"member model removed", restrictedModels("test-model"), true},
		{"node model removed", restrictedModels("alternate"), true},
		{"everything removed", restrictedModels(), true},
	} {
		s := pinned()
		if err = s.restamp(tc.next); (err != nil) != tc.refused {
			t.Fatalf("%s: refused=%v want %t", tc.name, err, tc.refused)
		}
	}
	// Clearing the restriction must release the pin a restricted admission left.
	s := pinned()
	s.Health = restrictedModels("test-model").apply(s.Health)
	if err = s.restamp(modelEntitlement{}); err != nil || s.Health.Allowed != nil {
		t.Fatal("a cleared entitlement left the snapshot pinned", err, s.Health.Allowed)
	}
}

func TestPostgresAllowlistShapeIsEnforcedByTheDatabase(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	_, tid, _ := h.register(t, "allowlist-shape@example.test")
	ctx := context.Background()
	long := strings.Repeat("m", 200)
	many := make([]string, maxAllowedModels)
	for i := range many {
		many[i] = fmt.Sprintf("model-%d", i)
	}
	for _, sql := range []string{
		"UPDATE tenants SET allowed_models=NULL WHERE id=$1",
		"UPDATE tenants SET allowed_models='{}' WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY['test-model'] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY['qwen3:8b','org/model','a.b_c-1'] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY['" + long + "'] WHERE id=$1",
	} {
		if _, e := h.db.Exec(ctx, sql, tid); e != nil {
			t.Fatalf("rejected a legitimate allowlist: %s: %v", sql, e)
		}
	}
	if _, e := h.db.Exec(ctx, "UPDATE tenants SET allowed_models=$2 WHERE id=$1", tid, many); e != nil {
		t.Fatal("rejected the maximum allowlist size", e)
	}
	for _, sql := range []string{
		// A comma inside one element is what makes the joined-text check ambiguous;
		// the cardinality identity is what rejects it.
		"UPDATE tenants SET allowed_models=ARRAY['a,b'] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY['ok,evil-charset'] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY[''] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY['has space'] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY['a',NULL] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY[NULL]::text[] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY[ARRAY['a'],ARRAY['b']] WHERE id=$1",
		"UPDATE tenants SET allowed_models=ARRAY['" + long + "m'] WHERE id=$1",
	} {
		if _, e := h.db.Exec(ctx, sql, tid); e == nil {
			t.Fatalf("stored an impossible allowlist: %s", sql)
		}
	}
	if _, e := h.db.Exec(ctx, "UPDATE tenants SET allowed_models=$2 WHERE id=$1", tid, append(append([]string{}, many...), "one-too-many")); e == nil {
		t.Fatal("stored an unbounded allowlist")
	}
}

// entitlementPI advertises a shared model plus a private one, and fails the test
// if the private model is ever actually invoked while it is not entitled.
func entitlementPI(t *testing.T, forbidden *atomic.Bool, handle func(http.ResponseWriter, *http.Request, observedPiCall)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{
				{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144},
				{"id": "alternate", "provider": "test", "maxContextTextBytes": 262144},
				{"id": "private-kb", "provider": "test", "maxContextTextBytes": 262144}}})
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
		if forbidden.Load() && b.Model == "private-kb" {
			t.Error("inference reached a model this workspace is not entitled to")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		handle(w, r, b)
	}))
}

func adminTenantRow(t *testing.T, h *harness, admin *http.Cookie, tid string) map[string]any {
	t.Helper()
	for _, raw := range h.request(t, admin, "GET", "/admin/tenants", nil, 200)["items"].([]any) {
		row := raw.(map[string]any)
		if row["id"] == tid {
			return row
		}
	}
	t.Fatal("workspace missing from the platform listing")
	return nil
}

func TestPostgresModelAllowlistIsEnforcedAtEveryEntryPoint(t *testing.T) {
	var forbidden atomic.Bool
	pi := entitlementPI(t, &forbidden, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "OUTPUT") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "allowlist-owner@example.test")
	admin := bootstrapTestAdmin(t, h)
	prefix := "/tenants/" + tid
	tenantRuntime := prefix + "/runtime"

	// There is no unscoped catalogue any more: a stale client gets a plain-text
	// ServeMux 404, which h.request cannot parse, so assert it directly.
	req, _ := http.NewRequest("GET", h.server.URL+"/api/v1/runtime", nil)
	req.AddCookie(c)
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("an unscoped catalogue is still served: %d %s", resp.StatusCode, body)
	}

	models := func(cookie *http.Cookie) []string {
		t.Helper()
		v := h.request(t, cookie, "GET", tenantRuntime, nil, 200)
		ids := []string{}
		for _, raw := range v["models"].([]any) {
			ids = append(ids, raw.(map[string]any)["id"].(string))
		}
		return ids
	}
	if got := models(c); len(got) != 3 {
		t.Fatal("an unrestricted workspace must see every advertised model", got)
	}
	if row := adminTenantRow(t, h, admin, tid); row["allowedModels"] != nil {
		t.Fatal("an unrestricted workspace must report a null entitlement", row["allowedModels"])
	}

	// An Agent may hold the private model while the workspace is unrestricted; the
	// restriction below must then refuse a run on that already stored value.
	cv := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Canvas", "document": map[string]any{"nodes": []map[string]string{{"id": "node-a"}}}}, 201)
	cid := cv["id"].(string)
	private := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Private", "adapterType": "pi", "model": "private-kb", "instructions": "Use plain words"}, 201)["id"].(string)
	sid := h.request(t, c, "POST", prefix+"/sessions", map[string]any{"canvasId": cid, "nodeId": "node-a", "agentId": private, "title": "Thread"}, 201)["id"].(string)

	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model", "test-model", "alternate"}}, 200)
	forbidden.Store(true)
	if row := adminTenantRow(t, h, admin, tid); fmt.Sprint(row["allowedModels"]) != "[alternate test-model]" {
		t.Fatal("the stored entitlement is not canonical", row["allowedModels"])
	}
	if got := models(c); len(got) != 2 || got[0] != "test-model" || got[1] != "alternate" {
		t.Fatal("the catalogue still advertises an unentitled model", got)
	}

	// Agent writes are authorization, so they refuse rather than conflict.
	v := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Forged", "adapterType": "pi", "model": "private-kb"}, 403)
	if v["error"].(map[string]any)["code"] != "model_not_allowed" {
		t.Fatal("agent creation was refused for the wrong reason", v)
	}
	h.request(t, c, "PUT", prefix+"/agents/"+private, map[string]any{"name": "Private", "adapterType": "pi", "model": "private-kb"}, 403)
	h.request(t, c, "PUT", prefix+"/agents/"+private, map[string]any{"name": "Private", "adapterType": "pi", "model": "test-model"}, 200)
	// Restore the stored private model behind the API so run admission is the thing
	// under test rather than the Agent write gate.
	if _, e = h.db.Exec(context.Background(), "UPDATE agents SET model='private-kb' WHERE tenant_id=$1 AND id=$2", tid, private); e != nil {
		t.Fatal(e)
	}
	v = h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "run-private-pinned"}, 409)
	if v["error"].(map[string]any)["code"] != "model_unavailable" {
		t.Fatal("a run on a stored unentitled model was not refused", v)
	}

	// Node setup and graph admission both resolve models, so both must refuse. Each
	// gets its own canvas so the session above keeps its binding and stays usable
	// for the run-admission assertions below.
	setupDoc := map[string]any{"nodes": []map[string]any{{"id": "node-a", "kind": "session", "title": "Node A", "runtime": "pi", "agentKind": "llm", "model": "private-kb"}}, "edges": []any{}}
	setupCanvas := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Setup", "document": setupDoc}, 201)["id"].(string)
	v = h.request(t, c, "POST", prefix+"/canvases/"+setupCanvas+"/initialize", map[string]any{"documentVersion": 1}, 400)
	if v["error"].(map[string]any)["code"] != "invalid_node_setup" {
		t.Fatal("node initialization accepted an unentitled model", v)
	}
	team := fixtureTeam("sequential")
	team.Members[1].Model = "private-kb"
	graphAgent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Graph", "adapterType": "pi", "model": "test-model", "instructions": "Use plain words"}, 201)["id"].(string)
	graphDoc := map[string]any{"nodes": []map[string]any{{"id": "node-a", "kind": "session", "title": "Node A", "runtime": "pi", "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": graphAgent}, "team": team}}, "edges": []any{}}
	graphCanvas := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Graph", "document": graphDoc}, 201)["id"].(string)
	v = h.request(t, c, "POST", prefix+"/canvases/"+graphCanvas+"/graph-runs", map[string]string{"operationId": "graph-private-member"}, 400)
	if v["error"].(map[string]any)["code"] != "invalid_node_setup" {
		t.Fatal("graph admission accepted an unentitled member model", v)
	}

	// An empty entitlement blocks everything, including a run that names no model.
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{}}, 200)
	v = h.request(t, c, "GET", tenantRuntime, nil, 200)
	if len(v["models"].([]any)) != 0 || v["plannerAvailable"] != false || v["reason"] != "No model is available to this workspace" {
		t.Fatal("a blocked workspace was still told planning is available", v)
	}
	if _, e = h.db.Exec(context.Background(), "UPDATE agents SET model='' WHERE tenant_id=$1 AND id=$2", tid, private); e != nil {
		t.Fatal(e)
	}
	h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "run-blocked-default"}, 409)

	// Clearing the restriction restores the worker's own catalogue and lets a run on
	// the previously private model complete.
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": nil}, 200)
	forbidden.Store(false)
	if got := models(c); len(got) != 3 {
		t.Fatal("clearing the restriction did not restore the catalogue", got)
	}
	if _, e = h.db.Exec(context.Background(), "UPDATE agents SET model='private-kb' WHERE tenant_id=$1 AND id=$2", tid, private); e != nil {
		t.Fatal(e)
	}
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "run-after-clearing"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")

	// Malformed operator input is refused, and this is a platform-admin surface.
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"has space"}}, 400)
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": "private-kb"}, 400)
	h.request(t, c, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model"}}, 403)
}

// The database constraint keeps a malformed list out, so schema drift is the only
// way to hold one. Reading it must deny rather than treat it as no restriction.
func TestPostgresMalformedStoredAllowlistDeniesRatherThanAllows(t *testing.T) {
	var forbidden atomic.Bool
	var calls atomic.Int32
	pi := entitlementPI(t, &forbidden, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "OUTPUT")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "allowlist-malformed@example.test")
	prefix := "/tenants/" + tid
	_, _, sid := h.fixture(t, c, tid)
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "ALTER TABLE tenants DROP CONSTRAINT tenants_allowed_models_shape"); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "UPDATE tenants SET allowed_models=ARRAY['test-model','not a model id'] WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	h.request(t, c, "GET", prefix+"/runtime", nil, 500)
	h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "malformed-allowlist"}, 500)
	h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Blocked", "adapterType": "pi", "model": "test-model"}, 500)
	var runs int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1", tid).Scan(&runs); e != nil || runs != 0 || calls.Load() != 0 {
		t.Fatal("a malformed allowlist admitted work", runs, calls.Load(), e)
	}
}

// The internal planner Agent carries no explicit model, so an entitlement that
// excludes the worker's own default must redirect it rather than either reaching
// that default or bricking planning entirely.
func TestPostgresPlannerResolvesADefaultInsideTheEntitlement(t *testing.T) {
	var forbidden atomic.Bool
	forbidden.Store(true)
	observed := make(chan string, 4)
	pi := entitlementPI(t, &forbidden, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		observed <- b.Model
		completePi(w, `{"version":1,"summary":"Ask","operations":[]}`)
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "allowlist-planner@example.test")
	admin := bootstrapTestAdmin(t, h)
	prefix := "/tenants/" + tid
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Empty", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"alternate"}}, 200)
	v := h.request(t, c, "GET", prefix+"/runtime", nil, 200)
	if v["plannerAvailable"] != true {
		t.Fatal("planning was disabled although an entitled model exists", v)
	}
	run := h.request(t, c, "POST", prefix+"/canvases/"+cid+"/plan", map[string]string{"prompt": "Build", "context": "strict", "operationId": "planner-entitlement"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	select {
	case model := <-observed:
		if model != "alternate" {
			t.Fatal("the planner did not resolve a model inside the entitlement", model)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the planner never reached the worker")
	}
}

// Writing the entitlement is not a kill switch: a call already admitted was
// authorized when it started and cannot be un-started, so the write must leave it
// alone rather than invent a cancellation. What it must do is refuse the next
// admission, including one whose snapshot was pinned while the model was still
// permitted and which is only dispatched afterwards.
func TestPostgresEntitlementWriteSparesAdmittedWorkAndRefusesThePinnedNextOne(t *testing.T) {
	var forbidden atomic.Bool
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	pi := entitlementPI(t, &forbidden, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		entered <- struct{}{}
		select {
		case <-release:
			completePi(w, "OUTPUT")
		case <-r.Context().Done():
		}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "allowlist-narrowing@example.test")
	admin := bootstrapTestAdmin(t, h)
	prefix := "/tenants/" + tid
	_, _, sid := h.fixture(t, c, tid)
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "wait", "operationId": "narrowing-run"}, 202)
	rid := run["id"].(string)
	h.awaitRun(t, c, tid, rid, "running")
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the run never reached the worker")
	}
	// The second write withdraws the very model this call is running on, which still
	// must not be reported as a cancellation the operator did not ask for.
	for _, list := range [][]string{{"test-model", "alternate"}, {"alternate"}} {
		h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": list}, 200)
		time.Sleep(100 * time.Millisecond)
		v := h.request(t, c, "GET", prefix+"/runs/"+rid, nil, 200)
		if v["status"] != "running" || v["error"] != "" {
			t.Fatal("an entitlement write disturbed a call it had already admitted", list, v)
		}
	}
	close(release)
	h.awaitRun(t, c, tid, rid, "completed")

	// The snapshot below is what admission would have frozen while private-kb was
	// still permitted. It is dispatched only after the entitlement dropped it, so
	// the invocation gate is the only thing standing between it and the worker.
	forbidden.Store(true)
	snap, _ := json.Marshal(executionSnapshot{Runtime: runtimePI, Model: "private-kb", Budget: 262144,
		Health: piHealth{Model: "test-model", Models: []piModel{{ID: "test-model", MaxContextTextBytes: 262144}, {ID: "private-kb", MaxContextTextBytes: 262144}}}})
	pinned := randomID()
	if _, e := h.db.Exec(context.Background(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,execution_snapshot) VALUES($1,$2,$3,'pinned-operation','pinned-hash','hello','queued',$4)", pinned, tid, sid, snap); e != nil {
		t.Fatal(e)
	}
	h.a.dispatch(tid, pinned, sid, "hello", "Use plain words", "session", 262144, 0)
	if v := h.awaitRun(t, c, tid, pinned, "failed"); v["error"] != "model_not_allowed" {
		t.Fatal("a snapshot pinned before the withdrawal was not refused by the invocation gate", v)
	}
	var invocations int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND run_id=$2", tid, pinned).Scan(&invocations); e != nil || invocations != 0 {
		t.Fatal("a refused run still consumed an admission", invocations, e)
	}
}

func TestPostgresTeamTurnStopsAModelRemovedMidRun(t *testing.T) {
	var forbidden atomic.Bool
	release := make(chan struct{})
	entered := make(chan observedPiCall, 8)
	var seen atomic.Int32
	pi := entitlementPI(t, &forbidden, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		if b.Model == "alternate" {
			t.Error("a team member invoked a model removed from the workspace")
		}
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
	c, tid, _ := h.register(t, "allowlist-team@example.test")
	admin := bootstrapTestAdmin(t, h)
	prefix := "/tenants/" + tid
	// The critic member selects "alternate"; the node itself stays on test-model, so
	// narrowing must not cancel the run and the member gate must stop the turn.
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "TEAM-TASK", "operationId": "team-narrowing"}, 202)
	rid := run["id"].(string)
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the first member never reached the worker")
	}
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model"}}, 200)
	close(release)
	v := h.awaitRun(t, c, tid, rid, "failed")
	if v["error"] != "model_not_allowed" {
		t.Fatal("the run did not fail on the removed member model", v)
	}
	turns := h.request(t, c, "GET", prefix+"/runs/"+rid+"/turns", nil, 200)["items"].([]any)
	stopped := false
	for _, raw := range turns {
		turn := raw.(map[string]any)
		if turn["model"] == "alternate" {
			stopped = turn["status"] == "failed" && turn["error"] == "model_not_allowed"
		}
	}
	if !stopped {
		t.Fatal("the removed member's turn was not stopped with an honest reason", turns)
	}
}

// A graph node that is only blocked when an upstream node fails would still
// dispatch a sibling that has no upstream at all, so the sibling has to be refused
// by its own admission. Its snapshot was frozen with the rest of the graph, before
// the withdrawal, which is exactly the case a snapshot-trusting check would miss.
func TestPostgresNarrowingRefusesAnIndependentGraphSiblingAtItsOwnAdmission(t *testing.T) {
	var forbidden atomic.Bool
	var calls atomic.Int32
	release := make(chan struct{})
	entered := make(chan struct{}, 8)
	pi := entitlementPI(t, &forbidden, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		if calls.Add(1) == 1 {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		completePi(w, "OUTPUT")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "allowlist-sibling@example.test")
	admin := bootstrapTestAdmin(t, h)
	prefix := "/tenants/" + tid
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Graph", "adapterType": "pi", "model": "private-kb", "instructions": "Use plain words"}, 201)["id"].(string)
	nodes := []any{}
	for _, id := range []string{"left", "right"} {
		nodes = append(nodes, map[string]any{"id": id, "kind": "session", "title": id, "runtime": "pi", "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": agent}})
	}
	doc := map[string]any{"nodes": nodes, "edges": []any{}}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Graph", "document": doc}, 201)["id"].(string)
	// One slot, so the sibling cannot be admitted until the first node settles and
	// the withdrawal below is certain to land between the two admissions.
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_concurrent_runs=1 WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	base := prefix + "/canvases/" + cid + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "sibling-operation", "documentVersion": 1}, 202)["id"].(string)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("the first node never reached the worker")
	}
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"allowedModels": []string{"test-model"}}, 200)
	forbidden.Store(true)
	close(release)
	done := awaitGraph(t, h, c, base+"/"+gid, "failed")
	states, details := map[string]string{}, map[string]string{}
	for _, raw := range done["nodes"].([]any) {
		node := raw.(map[string]any)
		id := node["nodeId"].(string)
		states[id], details[id] = node["state"].(string), node["detail"].(string)
	}
	refused := 0
	for id, state := range states {
		if state == "failed" && details[id] == "model_not_allowed" {
			refused++
		} else if state != "done" {
			t.Fatal("a graph node settled in an unexplained state", id, state, details[id])
		}
	}
	if refused != 1 {
		t.Fatal("the sibling was not refused at its own admission", states, details)
	}
	time.Sleep(150 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatal("the sibling node invoked a withdrawn model", calls.Load())
	}
}

func TestPostgresGraphSnapshotPinnedBeforeNarrowingNeverInvokesTheModel(t *testing.T) {
	var forbidden atomic.Bool
	forbidden.Store(true)
	var calls atomic.Int32
	pi := entitlementPI(t, &forbidden, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "OUTPUT")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, actor := h.register(t, "allowlist-graph@example.test")
	prefix := "/tenants/" + tid
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Graph", "adapterType": "pi", "model": "private-kb", "instructions": "Use plain words"}, 201)["id"].(string)
	nodes := []any{}
	for _, id := range []string{"left", "right"} {
		nodes = append(nodes, map[string]any{"id": id, "kind": "session", "title": id, "runtime": "pi", "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": agent}})
	}
	// Deliberately no edge between the two nodes: a graph that only blocks
	// downstream of a failure would still dispatch the independent sibling.
	doc := map[string]any{"nodes": nodes, "edges": []any{}}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Graph", "document": doc}, 201)["id"].(string)
	ctx := context.Background()

	// Freeze both node snapshots on the private model while the workspace still
	// permits it, then narrow the entitlement before the graph is ever dispatched. A
	// queued graph has no child run for a cancellation sweep to reach, so the only
	// thing that can stop it is the check at child admission.
	gid := randomID()
	raw, _ := json.Marshal(doc)
	scope, _ := json.Marshal([]string{"left", "right"})
	if _, e := h.db.Exec(ctx, "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES($1,$2,$3,$4,'pinned-operation','hash',1,$5,$6,'queued')", gid, tid, cid, actor, raw, scope); e != nil {
		t.Fatal(e)
	}
	snap, _ := json.Marshal(executionSnapshot{Runtime: runtimePI, Instructions: "Use plain words", Model: "private-kb", Budget: 262144,
		Health: piHealth{Model: "test-model", Models: []piModel{{ID: "test-model", MaxContextTextBytes: 262144}, {ID: "private-kb", MaxContextTextBytes: 262144}}}})
	for i, id := range []string{"left", "right"} {
		nsid := randomID()
		if _, e := h.db.Exec(ctx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title) VALUES($1,$2,$3,$4,$5,$4)", nsid, tid, cid, id, agent); e != nil {
			t.Fatal(e)
		}
		if _, e := h.db.Exec(ctx, "INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,session_id,execution_snapshot) VALUES($1,$2,$3,$4,'waiting',$5,$6)", tid, gid, id, i, nsid, snap); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := h.db.Exec(ctx, "UPDATE tenants SET allowed_models=ARRAY['test-model'] WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	h.a.dispatchGraph(tid, gid)
	done := awaitGraph(t, h, c, prefix+"/canvases/"+cid+"/graph-runs/"+gid, "failed")
	states := map[string]string{}
	for _, raw := range done["nodes"].([]any) {
		node := raw.(map[string]any)
		states[node["nodeId"].(string)] = node["state"].(string)
	}
	if states["left"] != "failed" || states["right"] != "failed" {
		t.Fatal("a pinned snapshot outlived its entitlement", states)
	}
	if calls.Load() != 0 {
		t.Fatal("a pinned graph node reached the worker after the entitlement narrowed", calls.Load())
	}
	var count int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1", tid).Scan(&count); e != nil || count != 0 {
		t.Fatal("a refused node still created a child run", count, e)
	}
}

// Every caller today propagates the read error, so the denying entitlement returned
// alongside it is defence in depth rather than a live path — which is exactly why it needs
// its own test: an integration test cannot tell the refusal apart from the propagated
// error, so a future caller that logged the error and carried on would silently run
// unrestricted. Ablating deniedModels to an unrestricted value leaves every integration
// test green and fails only here.
func TestAMalformedOrUnreadableAllowlistYieldsAnEntitlementThatPermitsNothing(t *testing.T) {
	entitlement, err := newModelEntitlement(true, []string{"good", "not a model id"})
	if err == nil {
		t.Fatal("a malformed allowlist was accepted")
	}
	if entitlement.unrestricted() || entitlement.permits("good") || entitlement.permits("anything") {
		t.Fatalf("a malformed allowlist produced a permissive entitlement: %#v", entitlement.allowed)
	}
	if entitlement, err = newModelEntitlement(true, make([]string, maxAllowedModels+1)); err == nil || entitlement.permits("") {
		t.Fatalf("an oversized allowlist was accepted or permits a model: %v", err)
	}
	// A read that never reached the row is the same absence, and the admin normalizer must
	// agree: a rejected request body cannot leave a permissive entitlement behind either.
	if denied := deniedModels(); denied.unrestricted() || denied.permits("test-model") {
		t.Fatal("the denying entitlement permits a model")
	}
	for _, raw := range []string{`["ok","not a model id"]`, `"nonsense"`, `[1,2]`, `{}`} {
		entitlement, _, err := normalizeAllowedModels([]byte(raw))
		if err == nil {
			t.Fatalf("%s was accepted as an allowlist", raw)
		}
		if entitlement.unrestricted() || entitlement.permits("ok") {
			t.Fatalf("%s left a permissive entitlement", raw)
		}
	}
}

// The substitute default must not depend on the order a worker advertised its catalog: the
// same workspace admitted twice would otherwise resolve to different models with nothing
// visible to the operator. Advertising the same two models in both orders must resolve the
// same way, and the answer must come from the operator's list rather than the provider's.
func TestASubstituteDefaultIsStableAgainstWorkerCatalogOrder(t *testing.T) {
	entitlement, err := newModelEntitlement(true, []string{"beta", "alpha"})
	if err != nil {
		t.Fatal(err)
	}
	forward := entitlement.apply(piHealth{Model: "house", Models: []piModel{{ID: "beta"}, {ID: "alpha"}, {ID: "house"}}})
	reverse := entitlement.apply(piHealth{Model: "house", Models: []piModel{{ID: "alpha"}, {ID: "beta"}, {ID: "house"}}})
	if forward.defaultModel() != reverse.defaultModel() {
		t.Fatalf("the substitute default followed the worker's order: %q vs %q", forward.defaultModel(), reverse.defaultModel())
	}
	// The stored list is sorted on write, so the choice is the first entitled id in it.
	if forward.defaultModel() != "alpha" {
		t.Fatalf("substitute default %q, want the first entitled id in allowlist order", forward.defaultModel())
	}
	// An entitlement the worker cannot satisfy at all resolves to nothing rather than to
	// the house default, which is what stops an excluded model from running by omission.
	missing := entitlement.apply(piHealth{Model: "house", Models: []piModel{{ID: "house"}}})
	if missing.defaultModel() != "" {
		t.Fatalf("an unsatisfiable entitlement resolved to %q", missing.defaultModel())
	}
}

// The database is the last line: the Go normalizer rejects an empty id, so the column must
// too, or a direct write leaves a row whose empty element would read as a permitted model.
func TestPostgresAllowlistRejectsAnEmptyModelID(t *testing.T) {
	h := newHarness(t, "")
	_, tid, _ := h.register(t, "allowlist-empty-id@example.test")
	for _, value := range []string{`ARRAY['']::text[]`, `ARRAY['ok','']::text[]`, `ARRAY[NULL]::text[]`} {
		if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET allowed_models="+value+" WHERE id=$1", tid); e == nil {
			t.Fatalf("the column accepted %s", value)
		}
	}
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET allowed_models=ARRAY['ok']::text[] WHERE id=$1", tid); e != nil {
		t.Fatalf("a valid single-element allowlist was rejected: %v", e)
	}
}
