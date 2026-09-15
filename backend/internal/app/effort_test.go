package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEffortLevelAndCatalogValidation(t *testing.T) {
	for level, ok := range map[string]bool{"": true, "low": true, "x-high_2": true, "High": false, "1low": false, "lo w": false, strings.Repeat("a", 33): false} {
		if validEffortLevel(level) != ok {
			t.Fatal("effort level", level, ok)
		}
	}
	for _, tc := range []struct {
		m  piModel
		ok bool
	}{
		{piModel{}, true},
		{piModel{ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: "low"}, true},
		{piModel{ReasoningEfforts: []string{"low", "high"}}, true},
		{piModel{ReasoningEfforts: []string{"low", "low"}}, false},
		{piModel{ReasoningEfforts: []string{"low"}, DefaultReasoningEffort: "high"}, false},
		{piModel{DefaultReasoningEffort: "high"}, false},
		{piModel{ReasoningEfforts: []string{"Bad"}}, false},
		{piModel{ReasoningEfforts: []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}}, false},
	} {
		if validEffortCatalog(tc.m) != tc.ok {
			t.Fatal("effort catalog", tc.m, tc.ok)
		}
	}
	h := piHealth{Model: "m", Models: []piModel{{ID: "m", ReasoningEfforts: []string{"low", "high"}}, {ID: "plain"}}}
	if !h.supportsEffort("m", "") || !h.supportsEffort("m", "high") || h.supportsEffort("m", "medium") || h.supportsEffort("plain", "low") || !h.supportsEffort("plain", "") || h.supportsEffort("missing", "low") || !h.supportsEffortSelection() {
		t.Fatal("per-model effort support")
	}
	if (piHealth{Models: []piModel{{ID: "plain"}}}).supportsEffortSelection() {
		t.Fatal("selection advertised without levels")
	}
	// A worker whose catalog contradicts itself is rejected as a whole rather than
	// having its efforts silently dropped: nothing downstream may guess.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ready": true, "model": "oa-default", "provider": "fixture", "models": []map[string]any{{"id": "oa-default", "runtime": runtimeOpenAIAgents, "maxContextTextBytes": 262144, "reasoningEfforts": []string{"low"}, "defaultReasoningEffort": "high"}}})
	}))
	defer bad.Close()
	c := testConfig()
	c.OpenAIAgentsURL, c.OpenAIAgentsToken = bad.URL, strings.Repeat("o", 32)
	if _, err := New(nil, c).probeRuntime(context.Background(), runtimeOpenAIAgents); err == nil || err.Error() != "Runtime model catalog is invalid" {
		t.Fatal("contradictory effort catalog accepted", err)
	}
}

// Effort is admitted per model from the worker catalog, frozen with the model at
// initialization, and forwarded verbatim to the worker that advertised it.
func TestPostgresEffortIsFrozenPerModelAndForwarded(t *testing.T) {
	var mu sync.Mutex
	calls := []runtimeCall{}
	handle := func(w http.ResponseWriter, r *http.Request, c runtimeCall) {
		mu.Lock()
		calls = append(calls, c)
		mu.Unlock()
		completePi(w, c.Runtime+"-result")
	}
	pi := runtimeProvider(t, runtimePI, handle)
	defer pi.Close()
	oa := runtimeProvider(t, runtimeOpenAIAgents, handle)
	defer oa.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	c, tid, _ := h.register(t, "effort@example.test")
	prefix := "/tenants/" + tid

	// The catalogue advertises effort per runtime and per model, as a closed enum.
	catalogue := h.request(t, c, "GET", prefix+"/runtime", nil, 200)
	for _, raw := range catalogue["runtimes"].([]any) {
		runtime := raw.(map[string]any)
		if runtime["supportsEffortSelection"] != (runtime["id"] == runtimeOpenAIAgents) || runtime["effortInputMode"] != "select" {
			t.Fatal("runtime effort advertisement", runtime)
		}
	}
	efforts := map[string][]any{}
	for _, raw := range catalogue["models"].([]any) {
		m := raw.(map[string]any)
		efforts[m["id"].(string)] = m["reasoningEfforts"].([]any)
		if m["id"] == "oa-default" && m["defaultReasoningEffort"] != "low" {
			t.Fatal("default effort lost", m)
		}
	}
	if len(efforts["oa-default"]) != 2 || len(efforts["oa-only"]) != 0 || len(efforts["test-model"]) != 0 {
		t.Fatal("per-model efforts", efforts)
	}

	cid, doc := setupFixture(t, h, c, tid, 1)
	base := prefix + "/canvases/" + cid
	var fixtureNode map[string]any
	raw, _ := json.Marshal(doc["nodes"].([]any)[0])
	_ = json.Unmarshal(raw, &fixtureNode)
	version := 1
	// configure edits a copy of from (the fixture node, or the canonical node the
	// server last returned, so thread pointers survive) and initializes it.
	configure := func(from map[string]any, fields map[string]any, status int) map[string]any {
		var n map[string]any
		copied, _ := json.Marshal(from)
		_ = json.Unmarshal(copied, &n)
		for k, v := range fields {
			n[k] = v
		}
		doc["nodes"] = []any{n}
		h.request(t, c, "PUT", base, map[string]any{"name": "Effort", "document": doc, "version": version}, 200)
		version++
		v := h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": version}, status)
		if status == 200 {
			version = int(v["version"].(float64))
		}
		return v
	}
	refused := func(fields map[string]any) {
		t.Helper()
		v := configure(fixtureNode, fields, 400)
		failure, _ := v["error"].(map[string]any)
		if failure["code"] != "invalid_node_setup" || !strings.Contains(strings.ToLower(failure["message"].(string)), "effort") {
			t.Fatal("refused for a reason other than effort", fields, v)
		}
	}
	// Refused: a level the model does not advertise, a model with no levels, a
	// runtime whose catalog has no levels at all, and a malformed level. Each is
	// refused for the effort itself, and nothing is created for any of them.
	refused(map[string]any{"runtime": runtimeOpenAIAgents, "model": "oa-default", "effort": "medium"})
	refused(map[string]any{"runtime": runtimeOpenAIAgents, "model": "oa-only", "effort": "high"})
	refused(map[string]any{"runtime": runtimePI, "effort": "high"})
	refused(map[string]any{"runtime": runtimeOpenAIAgents, "model": "oa-default", "effort": "High"})
	if agents, sessions := setupCounts(t, h, tid); agents != 0 || sessions != 0 {
		t.Fatal("rejected effort created resources", agents, sessions)
	}
	// Accepted: an advertised level is frozen on the Agent and echoed on the thread.
	v := configure(fixtureNode, map[string]any{"runtime": runtimeOpenAIAgents, "model": "oa-default", "effort": "high"}, 200)
	node := setupNodeAt(v, 0)
	sid := node["issueId"].(string)
	var stored string
	if e := h.db.QueryRow(context.Background(), "SELECT effort FROM agents WHERE tenant_id=$1 AND id=$2", tid, node["binding"].(map[string]any)["agentId"]).Scan(&stored); e != nil || stored != "high" {
		t.Fatal("effort not persisted", stored, e)
	}
	threads := node["threads"].([]any)
	if len(threads) == 0 || threads[len(threads)-1].(map[string]any)["effort"] != "high" {
		t.Fatal("thread effort not echoed", threads)
	}
	agent := h.request(t, c, "GET", prefix+"/agents/"+node["binding"].(map[string]any)["agentId"].(string), nil, 200)
	if agent["effort"] != "high" || agent["adapterConfig"].(map[string]any)["effort"] != "high" {
		t.Fatal("agent effort not exposed", agent)
	}
	run := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "operationId": "effort-operation-1", "prompt": "TASK"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	mu.Lock()
	captured := append([]runtimeCall{}, calls...)
	mu.Unlock()
	if len(captured) != 1 || captured[0].Runtime != runtimeOpenAIAgents || captured[0].Model != "oa-default" || captured[0].Effort != "high" || !captured[0].EffortPresent {
		t.Fatal("effort not forwarded", captured)
	}
	// Changing only the effort is a configuration change: a fresh Agent is created
	// rather than the frozen one being edited in place.
	before, _ := setupCounts(t, h, tid)
	v = configure(node, map[string]any{"effort": "low"}, 200)
	if after, _ := setupCounts(t, h, tid); after != before+1 {
		t.Fatal("effort change did not fork the Agent", before, after)
	}
	if forked := setupNodeAt(v, 0); forked["issueId"] == sid || forked["binding"].(map[string]any)["agentId"] == node["binding"].(map[string]any)["agentId"] {
		t.Fatal("effort change reused the frozen conversation", forked)
	}
	// Clearing the effort sends no level at all: the worker sees no effort field.
	node = setupNodeAt(v, 0)
	v = configure(node, map[string]any{"effort": ""}, 200)
	node = setupNodeAt(v, 0)
	run = h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": node["issueId"].(string), "operationId": "effort-operation-2", "prompt": "TASK"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	mu.Lock()
	captured = append([]runtimeCall{}, calls...)
	mu.Unlock()
	if len(captured) != 2 || captured[1].EffortPresent {
		t.Fatal("cleared effort still forwarded", captured)
	}
	snapshot := func() []runtimeCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]runtimeCall{}, calls...)
	}
	// Graph runs freeze and forward the same effort as manual runs.
	graphRun := func(operation string) {
		t.Helper()
		g := h.request(t, c, "POST", base+"/graph-runs", map[string]any{"operationId": operation, "documentVersion": version}, 202)
		path := base + "/graph-runs/" + g["id"].(string)
		for i := 0; i < 400; i++ {
			if status := h.request(t, c, "GET", path, nil, 200)["status"]; status != "queued" && status != "running" {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("graph run did not settle")
	}
	graphRun("effort-graph-cleared")
	if captured = snapshot(); len(captured) != 3 || captured[2].EffortPresent {
		t.Fatal("graph run forwarded a cleared effort", captured)
	}
	v = configure(node, map[string]any{"effort": "high"}, 200)
	node = setupNodeAt(v, 0)
	graphRun("effort-graph-high")
	if captured = snapshot(); len(captured) != 4 || captured[3].Effort != "high" || !captured[3].EffortPresent || captured[3].Model != "oa-default" {
		t.Fatal("graph run dropped the frozen effort", captured)
	}

	// A team on an effortful node: members that inherit the node model inherit its
	// effort too, so an accepted node effort is never silently dropped.
	inherit := fixtureTeam("sequential")
	inherit.Runtime = runtimeOpenAIAgents
	for i := range inherit.Members {
		inherit.Members[i].Model = ""
	}
	v = configure(node, map[string]any{"team": inherit}, 200)
	node = setupNodeAt(v, 0)
	start := len(snapshot())
	run = h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": node["issueId"].(string), "operationId": "effort-team-inherit", "prompt": "TEAM-TASK"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if captured = snapshot(); len(captured)-start != len(inherit.Members) {
		t.Fatal("inheriting team call count", len(captured)-start)
	}
	for _, call := range captured[start:] {
		if call.Runtime != runtimeOpenAIAgents || call.Model != "oa-default" || call.Effort != "high" || !call.EffortPresent {
			t.Fatal("member did not inherit the node effort with the node model", call)
		}
	}
	// A member with its own model uses only its own level, validated at initialize.
	bad := inherit
	bad.Members = append([]teamMember(nil), inherit.Members...)
	bad.Members[1].Model, bad.Members[1].Effort = "oa-only", "high"
	failure, _ := configure(node, map[string]any{"team": bad}, 400)["error"].(map[string]any)
	if failure["code"] != "invalid_node_setup" || !strings.Contains(strings.ToLower(failure["message"].(string)), "effort") {
		t.Fatal("member effort unsupported by its own model was not refused for the effort", failure)
	}

	// Team members carry their own effort, validated against their own runtime's
	// catalog, and forwarded only on that member's request.
	team := fixtureTeam("sequential")
	team.Members[1].Runtime, team.Members[1].Model, team.Members[1].Effort = runtimeOpenAIAgents, "oa-default", "high"
	_, _, teamSID := installTeam(t, h, c, tid, team)
	start = len(snapshot())
	run = h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": teamSID, "operationId": "effort-team-1", "prompt": "TEAM-TASK"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if captured = snapshot(); len(captured)-start != 3 {
		t.Fatal("team call count", len(captured)-start)
	}
	for _, call := range captured[start:] {
		if (call.Runtime == runtimeOpenAIAgents) != (call.Effort == "high" && call.EffortPresent) {
			t.Fatal("member effort leaked or lost", call)
		}
	}
	team.Members[1].Effort = "medium"
	_, _, badSID := installTeam(t, h, c, tid, team)
	before = len(snapshot())
	refusal, _ := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": badSID, "operationId": "effort-team-2", "prompt": "TEAM-TASK"}, 400)["error"].(map[string]any)
	if !strings.Contains(strings.ToLower(refusal["message"].(string)), "effort") || len(snapshot()) != before {
		t.Fatal("unsupported member effort not refused before any model call", refusal)
	}

	// The Agent API keeps model and effort as parallel persisted fields.
	created := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Effortful", "model": "oa-default", "adapterType": runtimeOpenAIAgents, "effort": "low"}, 201)
	if created["effort"] != "low" {
		t.Fatal("agent create lost effort", created)
	}
	updated := h.request(t, c, "PUT", prefix+"/agents/"+created["id"].(string), map[string]any{"name": "Effortful", "model": "oa-default", "adapterConfig": map[string]string{"model": "oa-default", "effort": "high"}}, 200)
	if updated["effort"] != "high" {
		t.Fatal("agent update lost effort", updated)
	}
	// An update that does not mention effort keeps the stored level; an explicit "" clears it.
	if kept := h.request(t, c, "PUT", prefix+"/agents/"+created["id"].(string), map[string]any{"name": "Effortful renamed", "model": "oa-default"}, 200); kept["effort"] != "high" {
		t.Fatal("omitted effort cleared the stored level", kept)
	}
	if cleared := h.request(t, c, "PUT", prefix+"/agents/"+created["id"].(string), map[string]any{"name": "Effortful", "model": "oa-default", "effort": ""}, 200); cleared["effort"] != "" {
		t.Fatal("explicit empty effort did not clear", cleared)
	}
	// The Agent API is shape-only, like model entitlement: a well-formed level the model
	// does not advertise is stored, then refused at admission before any model call.
	unadvertised := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Unadvertised", "model": "oa-default", "adapterType": runtimeOpenAIAgents, "effort": "medium"}, 201)["id"].(string)
	solo := map[string]any{"nodes": []any{map[string]any{"id": "solo", "kind": "session", "title": "solo", "runtime": runtimeOpenAIAgents, "agentKind": "llm", "binding": map[string]string{"companyId": tid, "agentId": unadvertised}}}, "edges": []any{}}
	soloCanvas := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Unadvertised effort", "document": solo}, 201)["id"].(string)
	before = len(snapshot())
	graphRefusal, _ := h.request(t, c, "POST", prefix+"/canvases/"+soloCanvas+"/graph-runs", map[string]any{"operationId": "effort-graph-unadvertised", "documentVersion": 1}, 400)["error"].(map[string]any)
	if graphRefusal["code"] != "effort_unsupported" || len(snapshot()) != before {
		t.Fatal("unadvertised stored effort reached a worker", graphRefusal)
	}
	h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Broken", "model": "oa-default", "adapterType": runtimeOpenAIAgents, "effort": "Not Valid"}, 400)
}
