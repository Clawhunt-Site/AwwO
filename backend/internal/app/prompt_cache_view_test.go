package app

import (
	"context"
	"testing"
)

// The prompt cache by path: a path is the runtime, the kind of the run's own session and the model; this window's calls
// and read share beside the window before; the share only of the calls whose cache read was reported; a path whose
// share fell by 20 points or more, on 20 such calls or more in both windows, marked falling; only for platform admins.
func TestPostgresAdminPromptCacheView(t *testing.T) {
	h := newHarness(t, "")
	c, tid, user := h.register(t, "cache-admin@example.test")
	_, other, _ := h.register(t, "cache-other@example.test")
	ctx := context.Background()
	h.request(t, c, "GET", "/admin/observability/cache", nil, 403)
	if _, e := h.db.Exec(ctx, "UPDATE users SET platform_role='admin' WHERE id=$1", user); e != nil {
		t.Fatal(e)
	}
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(sql, e)
		}
	}
	// A run in a session of each kind, in this workspace, and one in another workspace.
	session := func(tenant, kind string) string {
		t.Helper()
		cid, aid, sid, rid := randomID(), randomID(), randomID(), randomID()
		mustExec("INSERT INTO canvases(id,tenant_id,name) VALUES($1,$2,'Canvas')", cid, tenant)
		mustExec("INSERT INTO agents(id,tenant_id,name,role,instructions,internal,runtime,model,effort) VALUES($1,$2,'a','r','x',false,'pi','m','')", aid, tenant)
		mustExec("INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title,kind) VALUES($1,$2,$3,'n',$4,'s',$5)", sid, tenant, cid, aid, kind)
		mustExec("INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$1,'h','p','completed')", rid, tenant, sid)
		return rid
	}
	nodeRun, computerRun, otherRun := session(tid, "node"), session(tid, "computer"), session(other, "planner")
	// n calls of runtime and model on run, ago, each of 1000 prompt tokens, cached of them read (-1: not reported).
	insert := func(run, runtime, model string, n, cached int, ago string) {
		t.Helper()
		mustExec(`INSERT INTO model_invocations(id,tenant_id,run_id,status,runtime,model_id,admission_status,usage_status,usage_source,usage_reason,
			input_tokens,output_tokens,cached_input_tokens,cache_write_tokens,created_at)
			SELECT gen_random_uuid()::text,$1,$2,'completed',$3,$4,'accepted','reported','provider_raw','none',1000,100,NULLIF($5,-1),50,now()-$6::interval FROM generate_series(1,$7)`,
			tid, run, runtime, model, cached, ago, n)
	}
	insert(computerRun, "pi", "loop-model", 30, 800, "1 day")
	insert(computerRun, "pi", "loop-model", 30, 900, "8 days")
	insert(nodeRun, "openai-agents", "single-model", 25, 100, "2 days")
	insert(nodeRun, "openai-agents", "single-model", 25, 600, "9 days")
	// One model on two kinds of session is two paths.
	insert(nodeRun, "pi", "shared-model", 4, 0, "1 day")
	insert(computerRun, "pi", "shared-model", 6, 0, "1 day")
	// Half its calls report no cache read: its share is of the other half, and it has too few to be judged.
	insert(nodeRun, "pi", "gate-model", 10, 800, "1 day")
	insert(nodeRun, "pi", "gate-model", 10, -1, "1 day")
	insert(nodeRun, "pi", "gate-model", 20, 800, "8 days")
	// Exactly 20 points down on exactly 20 calls in each window is falling.
	insert(computerRun, "pi", "edge-model", 20, 400, "1 day")
	insert(computerRun, "pi", "edge-model", 20, 600, "8 days")
	// A call whose run is gone, and one naming another workspace's run, belong to no session of theirs.
	insert("gone-run", "pi", "orphan-model", 3, 0, "1 day")
	insert(otherRun, "pi", "cross-model", 3, 0, "1 day")
	insert(computerRun, "pi", "rare-model", 5, 0, "1 day")
	insert(computerRun, "pi", "rare-model", 30, 900, "9 days")
	insert(computerRun, "pi", "gone-model", 10, 500, "20 days")
	view := h.request(t, c, "GET", "/admin/observability/cache", nil, 200)
	if view["days"] != float64(7) {
		t.Fatal(view)
	}
	paths := map[string]map[string]any{}
	for _, raw := range view["paths"].([]any) {
		p := raw.(map[string]any)
		paths[p["runtime"].(string)+"/"+p["kind"].(string)+"/"+p["model"].(string)] = p
	}
	want := []string{"pi/computer/loop-model", "openai-agents/node/single-model", "pi/node/shared-model", "pi/computer/shared-model", "pi/node/gate-model",
		"pi/computer/edge-model", "pi//orphan-model", "pi//cross-model", "pi/computer/rare-model"}
	if len(paths) != len(want) {
		t.Fatalf("paths %v", cachePathKeys(paths))
	}
	for _, key := range want {
		if paths[key] == nil {
			t.Fatalf("no path %s in %v", key, cachePathKeys(paths))
		}
	}
	steady, falling, gate, edge, rare := paths["pi/computer/loop-model"], paths["openai-agents/node/single-model"], paths["pi/node/gate-model"],
		paths["pi/computer/edge-model"], paths["pi/computer/rare-model"]
	if steady["calls"] != float64(30) || steady["cacheKnownCalls"] != float64(30) || steady["inputTokens"] != "30000" || steady["cachedInputTokens"] != "24000" ||
		steady["cacheWriteTokens"] != "1500" || steady["outputTokens"] != "3000" || steady["readShare"] != 0.8 ||
		steady["previous"].(map[string]any)["readShare"] != 0.9 || steady["previous"].(map[string]any)["calls"] != float64(30) || steady["falling"] != false {
		t.Fatal("steady", steady)
	}
	if falling["falling"] != true || falling["readShare"] != 0.1 || falling["previous"].(map[string]any)["calls"] != float64(25) {
		t.Fatal("falling", falling)
	}
	if gate["calls"] != float64(20) || gate["cacheKnownCalls"] != float64(10) || gate["readShare"] != 0.8 || gate["inputTokens"] != "20000" || gate["falling"] != false {
		t.Fatal("unreported cache reads", gate)
	}
	if edge["falling"] != true || edge["readShare"] != 0.4 || edge["previous"].(map[string]any)["readShare"] != 0.6 {
		t.Fatal("exactly twenty points", edge)
	}
	if rare["falling"] != false || rare["calls"] != float64(5) {
		t.Fatal("too few calls to say", rare)
	}
	// The path that sent the most prompt tokens first.
	if first := view["paths"].([]any)[0].(map[string]any); first["model"] != "loop-model" {
		t.Fatal("order", view["paths"])
	}
	wide := h.request(t, c, "GET", "/admin/observability/cache?days=30", nil, 200)
	if len(wide["paths"].([]any)) != len(want)+1 {
		t.Fatal("thirty days", wide)
	}
	for _, query := range []string{"?days=0", "?days=31", "?days=abc", "?days=7&days=8", "?days=", "?days"} {
		h.request(t, c, "GET", "/admin/observability/cache"+query, nil, 400)
	}
}

// cachePathKeys are the paths of a prompt cache view, as runtime/kind/model.
func cachePathKeys(m map[string]map[string]any) []string {
	out := []string{}
	for key := range m {
		out = append(out, key)
	}
	return out
}
