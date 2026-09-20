package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func setupFixture(t *testing.T, h *harness, c *http.Cookie, tid string, count int) (string, map[string]any) {
	nodes := []any{}
	for i := 0; i < count; i++ {
		id := string(rune('a' + i))
		nodes = append(nodes, map[string]any{"id": id, "kind": "session", "agentKind": "coding", "title": "Worker " + id, "runtime": "pi", "model": "", "persona": "PERSONA-" + id, "effort": "", "binding": nil, "issueId": nil, "preview": "", "threads": []any{}, "custom": map[string]any{"keep": true}})
	}
	doc := map[string]any{"nodes": nodes, "edges": []any{}, "viewport": map[string]any{"zoom": 1}}
	v := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Initialize", "document": doc}, 201)
	return v["id"].(string), doc
}
func setupNodeAt(v map[string]any, index int) map[string]any {
	return v["document"].(map[string]any)["nodes"].([]any)[index].(map[string]any)
}
func setupCounts(t *testing.T, h *harness, tid string) (int, int) {
	t.Helper()
	var agents, sessions int
	if e := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM agents WHERE tenant_id=$1),(SELECT count(*) FROM node_sessions WHERE tenant_id=$1)", tid).Scan(&agents, &sessions); e != nil {
		t.Fatal(e)
	}
	return agents, sessions
}

func TestPostgresInitializeCanonicalScopeAndIdempotency(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "UNEXPECTED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "initialize@example.test")
	cid, doc := setupFixture(t, h, c, tid, 2)
	path := "/tenants/" + tid + "/canvases/" + cid
	originalB, _ := json.Marshal(doc["nodes"].([]any)[1])
	v := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 1, "scope": []string{"a"}}, 200)
	if v["version"] != float64(2) || v["id"] != cid || v["tenantId"] != tid || v["name"] != "Initialize" || v["createdAt"] == nil || v["updatedAt"] == nil {
		t.Fatal("not canonical canvas", v)
	}
	n := setupNodeAt(v, 0)
	if n["runtime"] != "pi" || n["model"] != "test-model" || n["issueId"] == "" || n["custom"].(map[string]any)["keep"] != true {
		t.Fatal("defaults or unrelated fields lost", n)
	}
	newB, _ := json.Marshal(setupNodeAt(v, 1))
	if !equalJSON(originalB, newB) {
		t.Fatal("out-of-scope node was changed")
	}
	binding := n["binding"].(map[string]any)
	agent := h.request(t, c, "GET", "/tenants/"+tid+"/agents/"+binding["agentId"].(string), nil, 200)
	if agent["name"] != "Worker a" || agent["model"] != "test-model" || agent["instructions"] != "PERSONA-a" || agent["adapterType"] != "pi" {
		t.Fatal("real Agent differs from node", agent)
	}
	thread := n["threads"].([]any)[0].(map[string]any)
	if thread["id"] != n["activeThreadId"] || thread["issueId"] != n["issueId"] || !reflect.DeepEqual(thread["binding"], n["binding"]) {
		t.Fatal("current thread not synchronized", n)
	}
	// Simulate a lost successful response: old CAS rejects, GET recovers the
	// exact committed identities, and a new-version retry is a strict no-op.
	h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 1}, 409)
	got := h.request(t, c, "GET", path, nil, 200)
	if !reflect.DeepEqual(got, v) {
		t.Fatal("GET cannot recover committed initialization")
	}
	again := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 2, "scope": []string{"a"}}, 200)
	if !reflect.DeepEqual(again, v) {
		t.Fatal("compatible initialization changed version or identity", again)
	}
	if agents, sessions := setupCounts(t, h, tid); agents != 1 || sessions != 1 || calls.Load() != 0 {
		t.Fatal("initialization repeated work or inferred", agents, sessions, calls.Load())
	}
	v = h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 2}, 200)
	if v["version"] != float64(3) || setupNodeAt(v, 0)["issueId"] != n["issueId"] {
		t.Fatal("default scope did not reuse existing node", v)
	}
	if agents, sessions := setupCounts(t, h, tid); agents != 2 || sessions != 2 {
		t.Fatal("wrong initialized counts", agents, sessions)
	}
	for _, scope := range []any{[]string{}, nil, []string{"a", "a"}, []string{"missing"}} {
		h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 3, "scope": scope}, 400)
	}
	setupNodeAt(v, 0)["preview"] = "NEW-TRANSCRIPT-PROJECTION"
	updated := h.request(t, c, "PUT", path, map[string]any{"name": "Initialize", "document": v["document"], "version": 3}, 200)
	again = h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 4}, 200)
	if !reflect.DeepEqual(again, updated) {
		t.Fatal("unrelated transcript projection caused initialization to change version")
	}
}

func TestPostgresInitializeConfigurationForkPreservesSharedAgentAndHistory(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { t.Error("initialization inferred") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "initialize-history@example.test")
	cid, _ := setupFixture(t, h, c, tid, 1)
	path := "/tenants/" + tid + "/canvases/" + cid
	v := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 1}, 200)
	n := setupNodeAt(v, 0)
	oldSID := n["issueId"].(string)
	oldAID := n["binding"].(map[string]any)["agentId"].(string)
	oldThread := n["activeThreadId"].(string)
	ctx := context.Background()
	rid := randomID()
	if _, e := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output) VALUES($1,$2,$3,$1,'hash','OLD-QUESTION','completed','OLD-ANSWER')", rid, tid, oldSID); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'assistant','OLD-ANSWER')", randomID(), tid, oldSID, rid); e != nil {
		t.Fatal(e)
	}
	// A second node deliberately shares the Agent. Its own session must remain
	// attached to that immutable Agent when the first node changes configuration.
	secondRaw, _ := json.Marshal(n)
	var second map[string]any
	_ = json.Unmarshal(secondRaw, &second)
	second["id"], second["issueId"], second["threads"] = "b", nil, []any{}
	doc := v["document"].(map[string]any)
	doc["nodes"] = append(doc["nodes"].([]any), second)
	h.request(t, c, "PUT", path, map[string]any{"name": "Initialize", "document": doc, "version": 2}, 200)
	v = h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 3, "scope": []string{"b"}}, 200)
	if agents, sessions := setupCounts(t, h, tid); agents != 1 || sessions != 2 {
		t.Fatal("compatible shared Agent was not reused", agents, sessions)
	}
	n = setupNodeAt(v, 0)
	n["persona"], n["model"], n["preview"] = "NEW-PERSONA", "alternate", "OLD-ANSWER"
	n["lastOutput"] = map[string]any{"text": "OLD-ANSWER", "at": 10, "source": "run"}
	n["contract"] = map[string]any{"version": 1, "inputs": []any{}, "outputs": []any{map[string]any{"id": "answer", "type": "text", "value": "OLD-ANSWER"}}}
	n["threads"].([]any)[0].(map[string]any)["draft"] = "KEEP-DRAFT"
	n["threads"].([]any)[0].(map[string]any)["lastOutput"] = nil
	n["threads"].([]any)[0].(map[string]any)["outputValues"] = map[string]any{"answer": "OLDER-ANSWER"}
	h.request(t, c, "PUT", path, map[string]any{"name": "Initialize", "document": v["document"], "version": 4}, 200)
	v = h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 5, "scope": []string{"a"}}, 200)
	n = setupNodeAt(v, 0)
	newSID := n["issueId"].(string)
	if newSID == oldSID || n["activeThreadId"] == oldThread || n["binding"].(map[string]any)["agentId"] == oldAID || n["preview"] != "" || n["lastOutput"] != nil {
		t.Fatal("changed configuration reused current execution identity or stale output", n)
	}
	if setupNodeAt(v, 1)["binding"].(map[string]any)["agentId"] != oldAID {
		t.Fatal("shared node binding mutated")
	}
	history := n["threads"].([]any)[0].(map[string]any)
	if history["issueId"] != oldSID || history["model"] != "test-model" || history["persona"] != "PERSONA-a" || history["draft"] != "KEEP-DRAFT" || history["lastOutput"].(map[string]any)["text"] != "OLD-ANSWER" {
		t.Fatal("old current thread lost its historical configuration or output", history)
	}
	if history["outputValues"].(map[string]any)["answer"] != "OLD-ANSWER" {
		t.Fatal("old current thread lost its latest contract output", history)
	}
	oldAgent := h.request(t, c, "GET", "/tenants/"+tid+"/agents/"+oldAID, nil, 200)
	if oldAgent["instructions"] != "PERSONA-a" || oldAgent["model"] != "test-model" {
		t.Fatal("shared historical Agent overwritten")
	}
	var content string
	if e := h.db.QueryRow(ctx, "SELECT content FROM messages WHERE tenant_id=$1 AND session_id=$2", tid, oldSID).Scan(&content); e != nil || content != "OLD-ANSWER" {
		t.Fatal("historical messages lost", content, e)
	}
	// Team-only changes also fork, even though the primary Agent prompt/model
	// remain identical. Retrying the now-effective team is a strict no-op.
	n["team"] = fixtureTeam("review")
	h.request(t, c, "PUT", path, map[string]any{"name": "Initialize", "document": v["document"], "version": 6}, 200)
	v = h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 7, "scope": []string{"a"}}, 200)
	if setupNodeAt(v, 0)["issueId"] == newSID || len(setupNodeAt(v, 0)["threads"].([]any)) != 3 {
		t.Fatal("team change did not create separate current history")
	}
	again := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 8, "scope": []string{"a"}}, 200)
	if !reflect.DeepEqual(again, v) {
		t.Fatal("team setup retry was not a no-op")
	}
}

func TestSetupThreadSnapshotKeepsNewestDeliverable(t *testing.T) {
	for _, tc := range []struct {
		name, previous, want string
	}{
		{"null", `null`, "CURRENT"},
		{"older", `{"text":"OLDER","at":1}`, "CURRENT"},
		{"newer", `{"text":"NEWER","at":20}`, "NEWER"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node := map[string]json.RawMessage{
				"lastOutput": json.RawMessage(`{"text":"CURRENT","at":10}`),
				"contract":   json.RawMessage(`{"outputs":[{"id":"answer","value":"CURRENT"}]}`),
			}
			prior := map[string]json.RawMessage{
				"lastOutput":   json.RawMessage(tc.previous),
				"outputValues": json.RawMessage(`{"answer":"STALE"}`),
			}
			thread := snapshotSetupThread(node, prior, "thread", nil, "session", setupConfiguration{})
			var output struct{ Text string }
			var values map[string]string
			if e := json.Unmarshal(thread["lastOutput"], &output); e != nil || output.Text != tc.want {
				t.Fatal("newest deliverable lost", string(thread["lastOutput"]), e)
			}
			if e := json.Unmarshal(thread["outputValues"], &values); e != nil || values["answer"] != "CURRENT" {
				t.Fatal("current contract output lost", string(thread["outputValues"]), e)
			}
		})
	}
}

func TestPostgresInitializeConcurrentCASAndAtomicFailure(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { t.Error("unexpected model call") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "initialize-cas@example.test")
	cid, _ := setupFixture(t, h, c, tid, 1)
	path := "/api/v1/tenants/" + tid + "/canvases/" + cid + "/initialize"
	responses := [2]*httptest.ResponseRecorder{}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range responses {
		responses[i] = httptest.NewRecorder()
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			req := httptest.NewRequest("POST", path, strings.NewReader(`{"documentVersion":1}`))
			req.AddCookie(c)
			req.Header.Set("Origin", h.cfg.PublicOrigin)
			req.Header.Set("Content-Type", "application/json")
			h.a.Handler().ServeHTTP(responses[i], req)
		}(i)
	}
	close(start)
	wg.Wait()
	if !((responses[0].Code == 200 && responses[1].Code == 409) || (responses[0].Code == 409 && responses[1].Code == 200)) {
		t.Fatal("concurrent CAS did not select exactly one writer", responses[0].Code, responses[1].Code)
	}
	if agents, sessions := setupCounts(t, h, tid); agents != 1 || sessions != 1 {
		t.Fatal("concurrent initialization duplicated rows", agents, sessions)
	}
	// A later invalid node rolls back earlier row creation in the same request.
	cid, doc := setupFixture(t, h, c, tid, 2)
	doc["nodes"].([]any)[1].(map[string]any)["model"] = "UNSUPPORTED"
	base := "/tenants/" + tid + "/canvases/" + cid
	h.request(t, c, "PUT", base, map[string]any{"name": "Invalid", "document": doc, "version": 1}, 200)
	h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 2}, 400)
	if agents, sessions := setupCounts(t, h, tid); agents != 1 || sessions != 1 {
		t.Fatal("partial initialization survived validation rollback", agents, sessions)
	}
	// A real SQL failure after Agent insertion must also roll back all rows.
	if _, e := h.db.Exec(context.Background(), "CREATE FUNCTION fail_setup_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected session insert failure'; END $$"); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(context.Background(), "CREATE TRIGGER fail_setup_session BEFORE INSERT ON node_sessions FOR EACH ROW EXECUTE FUNCTION fail_setup_session()"); e != nil {
		t.Fatal(e)
	}
	h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 2, "scope": []string{"a"}}, 500)
	if agents, sessions := setupCounts(t, h, tid); agents != 1 || sessions != 1 {
		t.Fatal("partial initialization survived database rollback", agents, sessions)
	}
	if current := h.request(t, c, "GET", base, nil, 200); current["version"] != float64(2) || setupNodeAt(current, 0)["binding"] != nil {
		t.Fatal("failed transaction changed canvas", current)
	}
}

func TestPostgresInitializeRejectsUnauthorizedAndUnsupportedNodes(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { t.Error("unexpected model call") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "initialize-owner@example.test")
	other, otherTid, _ := h.register(t, "initialize-other@example.test")
	reader, _, _ := h.register(t, "initialize-reader@example.test")
	h.request(t, c, "POST", "/tenants/"+tid+"/members", map[string]string{"email": "initialize-reader@example.test", "role": "reader"}, 201)
	_, foreignAID, foreignSID := h.fixture(t, other, otherTid)
	cid, doc := setupFixture(t, h, c, tid, 1)
	base := "/tenants/" + tid + "/canvases/" + cid
	h.request(t, other, "POST", base+"/initialize", map[string]any{"documentVersion": 1}, 404)
	h.request(t, reader, "POST", base+"/initialize", map[string]any{"documentVersion": 1}, 403)
	tests := []struct {
		key    string
		value  any
		status int
	}{
		{"runtime", "shell", 400}, {"model", "foreign-model", 400}, {"effort", "high", 400}, {"agentKind", "image", 400},
		{"binding", map[string]string{"companyId": otherTid, "agentId": foreignAID}, 404},
		{"binding", map[string]string{"companyId": tid, "agentId": foreignAID}, 404},
		{"issueId", foreignSID, 404},
		{"threads", []any{map[string]any{"id": "history", "issueId": foreignSID}}, 404},
	}
	badTeam := fixtureTeam("sequential")
	badTeam.Members[0].Tools = []string{"shell"}
	tests = append(tests, struct {
		key    string
		value  any
		status int
	}{"team", badTeam, 400})
	version := 1
	original, _ := json.Marshal(doc["nodes"].([]any)[0])
	for _, test := range tests {
		var n map[string]any
		_ = json.Unmarshal(original, &n)
		n[test.key] = test.value
		doc["nodes"] = []any{n}
		h.request(t, c, "PUT", base, map[string]any{"name": "Invalid", "document": doc, "version": version}, 200)
		version++
		h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": version}, test.status)
	}
	if agents, sessions := setupCounts(t, h, tid); agents != 0 || sessions != 0 {
		t.Fatal("rejected setup created resources", agents, sessions)
	}
}

func TestPostgresInitializeBusyCanvasAndFormOnlyNoop(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { t.Error("unexpected model call") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, actor := h.register(t, "initialize-busy@example.test")
	cid, _ := setupFixture(t, h, c, tid, 1)
	base := "/tenants/" + tid + "/canvases/" + cid
	v := h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 1}, 200)
	sid := setupNodeAt(v, 0)["issueId"].(string)
	ctx := context.Background()
	for _, kind := range []string{"node", "planner", "graph"} {
		id := randomID()
		if kind == "graph" {
			if _, e := h.db.Exec(ctx, "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES($1,$2,$3,$4,$1,'hash',2,'{}','[]','queued')", id, tid, cid, actor); e != nil {
				t.Fatal(e)
			}
		} else {
			activeSID := sid
			if kind == "planner" {
				activeSID = randomID()
				aid := setupNodeAt(v, 0)["binding"].(map[string]any)["agentId"]
				if _, e := h.db.Exec(ctx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title,kind) VALUES($1,$2,$3,'planner',$4,'Planner','planner')", activeSID, tid, cid, aid); e != nil {
					t.Fatal(e)
				}
			}
			if _, e := h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$1,'hash','active','queued')", id, tid, activeSID); e != nil {
				t.Fatal(e)
			}
		}
		h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 2}, 409)
		if kind == "graph" {
			if _, e := h.db.Exec(ctx, "UPDATE graph_runs SET status='cancelled' WHERE id=$1", id); e != nil {
				t.Fatal(e)
			}
		} else if _, e := h.db.Exec(ctx, "UPDATE runs SET status='cancelled' WHERE id=$1", id); e != nil {
			t.Fatal(e)
		}
	}
	// No session nodes is a canonical no-op and needs no Pi connectivity.
	h.a.cfg.PIURL = "http://127.0.0.1:1"
	form := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Form", "document": map[string]any{"nodes": []any{map[string]any{"id": "form", "kind": "form", "fields": []any{}}}, "edges": []any{}}}, 201)
	formPath := "/tenants/" + tid + "/canvases/" + form["id"].(string)
	again := h.request(t, c, "POST", formPath+"/initialize", map[string]any{"documentVersion": 1}, 200)
	if !reflect.DeepEqual(again, form) {
		t.Fatal("form-only setup was not canonical no-op", again)
	}
	h.request(t, c, "POST", formPath+"/initialize", map[string]any{"documentVersion": 1, "scope": []string{"form"}}, 400)
	h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 2}, 503)
}
