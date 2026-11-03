package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// newEvolutionPi is a Pi worker with reasoning efforts whose replies a test decides by node, the effort the node runs at
// and its call (counted for each node).
func newEvolutionPi(t *testing.T, reply func(node, effort string, call int) piReply) *httptest.Server {
	var mu sync.Mutex
	counts := map[string]int{}
	model := map[string]any{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144, "reasoningEfforts": []string{"low", "medium", "high"}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{model}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var call struct {
			observedPiCall
			Effort string `json:"effort"`
		}
		if e := json.NewDecoder(r.Body).Decode(&call); e != nil {
			t.Error(e)
		}
		node, _, _ := strings.Cut(strings.TrimPrefix(call.Prompt, "【工作流节点】"), "\n")
		mu.Lock()
		counts[node]++
		n := counts[node]
		mu.Unlock()
		answer := reply(node, call.Effort, n)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		if answer.failed != "" {
			failWorker(w, answer.failed)
			return
		}
		completePi(w, answer.text)
	}))
	t.Cleanup(server.Close)
	return server
}

// evolutionCanvas is effortCanvas with a third node, "side", that depends on neither.
func evolutionCanvas(t *testing.T, h *harness, c *http.Cookie, tid string) (string, string) {
	t.Helper()
	prefix := "/tenants/" + tid
	agent := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Effort worker", "adapterType": "pi", "model": "test-model", "effort": "medium", "instructions": "Work"}, 201)["id"].(string)
	binding := map[string]string{"companyId": tid, "agentId": agent}
	doc := map[string]any{"nodes": []any{
		map[string]any{"id": "up", "kind": "session", "title": "up", "runtime": "pi", "agentKind": "llm", "binding": binding},
		map[string]any{"id": "down", "kind": "session", "title": "down", "runtime": "pi", "agentKind": "llm", "binding": binding, "x": 320},
		map[string]any{"id": "side", "kind": "session", "title": "side", "runtime": "pi", "agentKind": "llm", "binding": binding, "x": 640},
	}, "edges": []map[string]string{{"id": "up-down", "fromNode": "up", "fromPort": "result", "toNode": "down", "toPort": "context", "dataType": "text"}}}
	return h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Evolving", "document": doc}, 201)["id"].(string), agent
}

// setNodeEffort saves canvas cid with node's own reasoning effort set ("" removes it, as a plan back to the model's
// default leaves none), as a person's own edit saves it (the page takes away the mark of the change of the canvas's
// evolution that set the effort before), and the nodes' Agent at that effort, as initializing the node sets it for its
// runs.
func setNodeEffort(t *testing.T, h *harness, c *http.Cookie, tid, cid, agent, node, effort string) {
	t.Helper()
	canvas := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid, nil, 200)
	doc := canvas["document"].(map[string]any)
	for _, raw := range doc["nodes"].([]any) {
		if n := raw.(map[string]any); n["id"] == node {
			if n["effort"] != effort {
				delete(n, "evolution")
			}
			n["effort"] = effort
		}
	}
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": canvas["name"], "document": doc, "version": canvas["version"]}, 200)
	effortAgent(t, h, c, tid, agent, effort)
}

// applyChange saves canvas cid as the canvas page makes a claimed change (CanvasSurface's applyEvolution): node's own
// reasoning effort set, the node carrying the change's mark, and the nodes' Agent at that effort, as setNodeEffort does.
func applyChange(t *testing.T, h *harness, c *http.Cookie, tid, cid, agent, node, effort string, change any) {
	t.Helper()
	canvas := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid, nil, 200)
	doc := canvas["document"].(map[string]any)
	for _, raw := range doc["nodes"].([]any) {
		if n := raw.(map[string]any); n["id"] == node {
			n["effort"] = effort
			n["evolution"] = map[string]any{"change": change}
		}
	}
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": canvas["name"], "document": doc, "version": canvas["version"]}, 200)
	effortAgent(t, h, c, tid, agent, effort)
}

// runCanvas runs canvas cid's nodes (all of them, or scope) as operation op, and waits for the run to end as want.
func runCanvas(t *testing.T, h *harness, c *http.Cookie, tid, cid, op string, scope []string, want string) string {
	t.Helper()
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	body := map[string]any{"operationId": op}
	if scope != nil {
		body["scope"] = scope
	}
	gid := h.request(t, c, "POST", base, body, 202)["id"].(string)
	awaitGraph(t, h, c, base+"/"+gid, want)
	return gid
}

// awaitEvolution waits until the canvas's evolution names canvas run gid as its latest, learnt from.
func awaitEvolution(t *testing.T, h *harness, c *http.Cookie, path, gid string) map[string]any {
	t.Helper()
	for deadline := time.Now().Add(6 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		view := h.request(t, c, "GET", path, nil, 200)
		if latest, _ := view["latestRun"].(map[string]any); latest != nil && latest["id"] == gid && latest["learnt"] == true {
			return view
		}
	}
	t.Fatalf("canvas run %s was never learnt from", gid)
	return nil
}

func pendingOf(view map[string]any, key string) []any {
	list, _ := view["pending"].(map[string]any)[key].([]any)
	return list
}

func rerunOf(view map[string]any) map[string]any {
	rerun, _ := view["pending"].(map[string]any)["rerun"].(map[string]any)
	return rerun
}

func switchOf(view map[string]any, name string) map[string]any { return view[name].(map[string]any) }

func logEntry(t *testing.T, view map[string]any, kind string) map[string]any {
	t.Helper()
	for _, raw := range view["log"].([]any) {
		if entry := raw.(map[string]any); entry["kind"] == kind {
			return entry
		}
	}
	t.Fatalf("no %s in the log: %v", kind, view["log"])
	return nil
}

func logByID(t *testing.T, view map[string]any, id any) map[string]any {
	t.Helper()
	for _, raw := range view["log"].([]any) {
		if entry := raw.(map[string]any); entry["id"] == id {
			return entry
		}
	}
	t.Fatalf("no entry %v in the log: %v", id, view["log"])
	return nil
}

// claim claims a change of the canvas's evolution: its entry and the evolution, on success.
func claim(t *testing.T, h *harness, c *http.Cookie, path string, body map[string]any, status int) (map[string]any, map[string]any) {
	t.Helper()
	got := h.request(t, c, "POST", path+"/changes", body, status)
	change, _ := got["change"].(map[string]any)
	view, _ := got["evolution"].(map[string]any)
	return change, view
}

func failureCode(t *testing.T, got map[string]any) string {
	t.Helper()
	failure, _ := got["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

// A canvas evolves by itself only once a member turns it on, and only from runs that end after: a node that failed at its
// output limit takes its lesson's lower effort, claimed first (the server names the efforts) and done once the canvas as
// saved holds it, and the run's unfinished nodes run once more, as their own canvas run, once the change is settled.
// Only a node a plan may change, whose failure in that run wrote the open suggestion, not changed lately, is changed.
// A person can take a change back while it stands, and readers can only read.
func TestPostgresACanvasEvolvesByItselfOnceItsSwitchesAreOn(t *testing.T) {
	server := newEvolutionPi(t, func(node, effort string, call int) piReply {
		if node == "up" && effort != "low" {
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT-" + node}
	})
	h := newHarness(t, server.URL)
	h.a.cfg.GraphNodeRetries = 0
	c, tid, _ := h.register(t, "evolve@example.test")
	cid, agent := effortCanvas(t, h, c, tid, "medium")
	path := "/tenants/" + tid + "/canvases/" + cid + "/evolution"
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}

	view := h.request(t, c, "GET", path, nil, 200)
	if switchOf(view, "autoApply")["on"] != false || switchOf(view, "autoRerun")["on"] != false || view["latestRun"] != nil ||
		len(pendingOf(view, "apply")) != 0 || len(pendingOf(view, "revert")) != 0 || rerunOf(view) != nil || len(view["log"].([]any)) != 0 {
		t.Fatal("a canvas's evolution before anything", view)
	}

	// A run that ended before the switches were on asks for nothing.
	first := runCanvas(t, h, c, tid, cid, "evolve-run-1", nil, "failed")
	awaitEvolution(t, h, c, path, first)
	h.request(t, c, "PUT", path, map[string]any{}, 400)
	view = h.request(t, c, "PUT", path, map[string]any{"autoApply": true, "autoRerun": true}, 200)
	since := switchOf(view, "autoApply")["since"]
	if switchOf(view, "autoApply")["on"] != true || switchOf(view, "autoRerun")["on"] != true || since == nil || len(pendingOf(view, "apply")) != 0 || rerunOf(view) != nil {
		t.Fatal("switched on after a run ended", view)
	}
	// On again, a switch keeps when it was turned on, and each switch is audited once.
	if again := h.request(t, c, "PUT", path, map[string]any{"autoApply": true}, 200); switchOf(again, "autoApply")["since"] != since || switchOf(again, "autoRerun")["on"] != true {
		t.Fatal("a switch turned on again", again)
	}
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action IN ('canvas_evolution.apply_on','canvas_evolution.rerun_on')", tid, cid); n != 2 {
		t.Fatal("switch audits", n)
	}

	// The next failure asks for its lesson's lower effort, from the node's own effort (it names none: its Agent's is
	// medium), and a rerun of what did not finish.
	second := runCanvas(t, h, c, tid, cid, "evolve-run-2", nil, "failed")
	view = awaitEvolution(t, h, c, path, second)
	lesson := nodeLessons(t, h, tid, cid, "up")[0]
	apply := pendingOf(view, "apply")
	if len(apply) != 1 {
		t.Fatal("changes due", view["pending"])
	}
	if step := apply[0].(map[string]any); step["lessonId"] != lesson.id || step["nodeId"] != "up" || step["nodeTitle"] != "up" || step["from"] != "" ||
		step["effort"] != "low" || step["model"] != "test-model" || step["kind"] != "output_limit" || step["proposal"] != "lower_effort" {
		t.Fatal("the change due", step)
	}
	if rerun := rerunOf(view); rerun == nil || rerun["graphId"] != second || rerun["operationId"] != "autorerun:"+second || fmt.Sprint(rerun["scope"]) != "[up down]" {
		t.Fatal("the rerun due", rerun)
	}

	// Only a node a plan may change, at another effort, whose open suggestion its failure there wrote, takes it.
	due := func() int {
		t.Helper()
		return len(pendingOf(h.request(t, c, "GET", path, nil, 200), "apply"))
	}
	for _, change := range []struct{ name, change, restore string }{
		{"a workspace Agent's node", `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,agentRef}','"market"') WHERE id=$1`, `UPDATE canvases SET document=document #- '{nodes,0,agentRef}' WHERE id=$1`},
		{"a team", `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,team}','{"members":[]}') WHERE id=$1`, `UPDATE canvases SET document=document #- '{nodes,0,team}' WHERE id=$1`},
		{"a media node", `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,agentKind}','"image"') WHERE id=$1`, `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,agentKind}','"llm"') WHERE id=$1`},
		{"a node at low already", `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,effort}','"low"') WHERE id=$1`, `UPDATE canvases SET document=document #- '{nodes,0,effort}' WHERE id=$1`},
		{"a node no longer on the canvas", `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,id}','"elsewhere"') WHERE id=$1`, `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,id}','"up"') WHERE id=$1`},
	} {
		exec(change.change, cid)
		if n := due(); n != 0 {
			t.Errorf("%s: %d changes due", change.name, n)
		}
		exec(change.restore, cid)
	}
	for _, change := range []struct{ name, change, restore string }{
		{"a dismissed suggestion", "UPDATE canvas_lessons SET proposal_state='dismissed' WHERE id=$1", "UPDATE canvas_lessons SET proposal_state='open' WHERE id=$1"},
		{"a retired lesson", "UPDATE canvas_lessons SET status='retired' WHERE id=$1", "UPDATE canvas_lessons SET status='active' WHERE id=$1"},
		{"effort tuning's", "UPDATE canvas_lessons SET kind='effort_tuning' WHERE id=$1", "UPDATE canvas_lessons SET kind='output_limit' WHERE id=$1"},
		// The newest evidence is the second run's: without it, the lesson is the first run's alone.
		{"a lesson the run did not write", "UPDATE canvas_lessons SET evidence=evidence-0 WHERE id=$1", ""},
	} {
		exec(change.change, lesson.id)
		if n := due(); n != 0 {
			t.Errorf("%s: %d changes due", change.name, n)
		}
		// A step not due is not claimed either.
		if _, got := claim(t, h, c, path, map[string]any{"graphId": second, "nodeId": "up", "lessonId": lesson.id}, 409); got != nil {
			t.Errorf("%s: claimed", change.name)
		}
		if change.restore == "" {
			exec("UPDATE canvas_lessons SET evidence=jsonb_build_array(jsonb_build_object('graphId',$2::text))||evidence WHERE id=$1", lesson.id, second)
		} else {
			exec(change.restore, lesson.id)
		}
	}
	if n := due(); n != 1 {
		t.Fatal("the change is not due once each case is put back", n)
	}
	// A node changed in the last day is not changed again, nor one changed twice in a week; a change claimed long ago
	// and never settled counts for neither.
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,from_effort,to_effort,created_at,done_at)
		VALUES('cap-1',$1,$2,'effort','up',$3,'low','high',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour')`, tid, cid, first)
	if n := due(); n != 0 {
		t.Error("a node changed an hour ago is due again", n)
	}
	exec("UPDATE canvas_evolution_log SET done_at=NULL,created_at=clock_timestamp()-interval '31 minutes' WHERE id='cap-1'")
	if n := due(); n != 1 {
		t.Error("a claim let go counts as a change", n)
	}
	if entry := logByID(t, h.request(t, c, "GET", path, nil, 200), "cap-1"); entry["state"] != "expired" || entry["standing"] != false {
		t.Error("a claim never settled, as the log shows it", entry)
	}
	exec("UPDATE canvas_evolution_log SET created_at=clock_timestamp()-interval '2 days',done_at=clock_timestamp()-interval '2 days' WHERE id='cap-1'")
	if n := due(); n != 1 {
		t.Error("a node changed two days ago is not due", n)
	}
	// The day and the week count from when a change was made, not from its claim.
	exec("UPDATE canvas_evolution_log SET done_at=clock_timestamp()-interval '1 hour' WHERE id='cap-1'")
	if n := due(); n != 0 {
		t.Error("a node changed an hour ago, claimed two days ago, is due again", n)
	}
	exec("UPDATE canvas_evolution_log SET done_at=clock_timestamp()-interval '2 days' WHERE id='cap-1'")
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,reverts_id,from_effort,to_effort,created_at,done_at)
		VALUES('cap-2',$1,$2,'revert','up',$3,'cap-1','high','low',clock_timestamp()-interval '8 days',clock_timestamp()-interval '30 hours')`, tid, cid, first)
	if n := due(); n != 0 {
		t.Error("a node changed twice this week is due again", n)
	}
	exec("DELETE FROM canvas_evolution_log WHERE id IN ('cap-2','cap-1')")
	// A claim of another node, long ago and never settled, is let go as the next claim is made.
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,from_effort,to_effort,created_at)
		VALUES('stale',$1,$2,'effort','down',$3,'','low',clock_timestamp()-interval '31 minutes')`, tid, cid, first)

	// A claim names no effort: the server says from what to what. One of a run not the latest, one naming both a lesson
	// and a change, and a person's lesson change are refused.
	for _, invalid := range []map[string]any{
		{"graphId": second, "nodeId": "up", "lessonId": lesson.id, "from": "high"},
		{"graphId": second, "nodeId": "up", "lessonId": lesson.id, "revertsId": "cap-1"},
		{"graphId": second, "nodeId": "up"},
		{"graphId": second, "nodeId": "up", "lessonId": lesson.id, "auto": false},
	} {
		h.request(t, c, "POST", path+"/changes", invalid, 400)
	}
	if _, got := claim(t, h, c, path, map[string]any{"graphId": first, "nodeId": "up", "lessonId": lesson.id}, 409); got != nil {
		t.Fatal("a change of an older run was claimed")
	}
	change, view := claim(t, h, c, path, map[string]any{"graphId": second, "nodeId": "up", "lessonId": lesson.id}, 200)
	if change["kind"] != "effort" || change["state"] != "claimed" || change["auto"] != true || change["from"] != "" || change["to"] != "low" ||
		change["lessonId"] != lesson.id || change["graphId"] != second || change["standing"] != false || len(pendingOf(view, "apply")) != 0 {
		t.Fatal("the change claimed", change, view["pending"])
	}
	if stale := logByID(t, view, "stale"); stale["kind"] != "skip" || stale["reason"] != "" || stale["state"] != "done" {
		t.Fatal("a claim let go", stale)
	}
	// Claimed once; and the rerun waits for it to be settled.
	if _, got := claim(t, h, c, path, map[string]any{"graphId": second, "nodeId": "up", "lessonId": lesson.id}, 409); got != nil {
		t.Fatal("claimed twice")
	}
	if rerunOf(view) != nil {
		t.Fatal("a rerun is due while its run's change is under way", view["pending"])
	}
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	rerunBody := map[string]any{"operationId": "autorerun:" + second, "scope": []string{"up", "down"}}
	if code := failureCode(t, h.request(t, c, "POST", base, rerunBody, 409)); code != "auto_rerun_pending" {
		t.Fatal("a rerun while its run's change is under way:", code)
	}
	// Done only once the canvas as saved holds it, and once.
	settle := path + "/changes/" + change["id"].(string)
	h.request(t, c, "POST", settle, map[string]any{"done": true}, 409)
	h.request(t, c, "POST", settle, map[string]any{}, 400)
	h.request(t, c, "POST", settle, map[string]any{"done": true, "skipped": "Busy"}, 400)
	h.request(t, c, "POST", path+"/changes/no-such-change", map[string]any{"done": true}, 404)
	applyChange(t, h, c, tid, cid, agent, "up", "low", change["id"])
	view = h.request(t, c, "POST", settle, map[string]any{"done": true}, 200)
	if done := logByID(t, view, change["id"]); done["state"] != "done" || done["standing"] != true || done["reverted"] != false || done["nodeTitle"] != "up" {
		t.Fatal("the change done", done)
	}
	if l := nodeLessons(t, h, tid, cid, "up")[0]; l.state != "applied" {
		t.Fatalf("the suggestion taken: %+v", l)
	}
	// The same settle again (its answer lost) is answered as it was; a skip of a change done is refused.
	if again := h.request(t, c, "POST", settle, map[string]any{"done": true}, 200); logByID(t, again, change["id"])["state"] != "done" {
		t.Fatal("a settle replayed", again)
	}
	h.request(t, c, "POST", settle, map[string]any{"skipped": "Busy"}, 409)
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='canvas_evolution.effort' AND resource_id=$2", tid, change["id"]); n != 1 {
		t.Fatal("a settle replayed is audited again", n)
	}

	// The rerun runs the unfinished nodes, at the new effort, once; a rerun of it is not due.
	if rerun := rerunOf(view); rerun == nil || rerun["operationId"] != "autorerun:"+second {
		t.Fatal("the rerun due once the change is done", view["pending"])
	}
	rerunID := h.request(t, c, "POST", base, rerunBody, 202)["id"].(string)
	awaitGraph(t, h, c, base+"/"+rerunID, "completed")
	if again := h.request(t, c, "POST", base, rerunBody, 200); again["id"] != rerunID {
		t.Fatal("the same rerun asked for again", again)
	}
	view = awaitEvolution(t, h, c, path, rerunID)
	if view["latestRun"].(map[string]any)["autoRerun"] != true || rerunOf(view) != nil || len(pendingOf(view, "apply")) != 0 || len(pendingOf(view, "revert")) != 0 ||
		view["limits"].(map[string]any)["rerunsLastDay"] != float64(1) {
		t.Fatal("after the rerun", view)
	}
	if entry := logEntry(t, view, "rerun"); entry["graphId"] != second || entry["rerunGraphId"] != rerunID || entry["nodeId"] != "" || entry["state"] != "done" {
		t.Fatal("the rerun recorded", entry)
	}
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action IN ('canvas_evolution.effort','canvas_evolution.rerun')", tid); n != 2 {
		t.Fatal("change audits", n)
	}

	// Readers read it; other workspaces do not see it.
	reader, _, readerID := h.register(t, "evolve-reader@example.test")
	exec("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'reader')", tid, readerID)
	h.request(t, reader, "GET", path, nil, 200)
	h.request(t, reader, "PUT", path, map[string]any{"autoApply": false}, 403)
	h.request(t, reader, "POST", path+"/changes", map[string]any{"graphId": second, "nodeId": "up", "revertsId": change["id"], "auto": false}, 403)
	h.request(t, reader, "POST", settle, map[string]any{"done": true}, 403)
	other, otherTenant, _ := h.register(t, "evolve-other@example.test")
	h.request(t, other, "GET", "/tenants/"+otherTenant+"/canvases/"+cid+"/evolution", nil, 404)
	h.request(t, other, "PUT", "/tenants/"+otherTenant+"/canvases/"+cid+"/evolution", map[string]any{"autoApply": true}, 404)
	h.request(t, other, "POST", "/tenants/"+otherTenant+"/canvases/"+cid+"/evolution/changes", map[string]any{"graphId": second, "nodeId": "up", "revertsId": change["id"], "auto": false}, 404)

	// A person takes the change back while it stands: not once the node was changed since, and only to the effort it had.
	takeBack := map[string]any{"graphId": second, "nodeId": "up", "revertsId": change["id"], "auto": false}
	exec(`UPDATE canvases SET document=jsonb_set(document,'{nodes,0,effort}','"high"') WHERE id=$1`, cid)
	if entry := logByID(t, h.request(t, c, "GET", path, nil, 200), change["id"]); entry["standing"] != false {
		t.Fatal("a change the node no longer holds stands", entry)
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes", takeBack, 409)); code != "evolution_changed" {
		t.Fatal("a change taken back after the node changed:", code)
	}
	exec(`UPDATE canvases SET document=jsonb_set(document,'{nodes,0,effort}','"low"') WHERE id=$1`, cid)
	// Back at the change's effort by a person's own edit (the mark gone): theirs, not the change's.
	exec(`UPDATE canvases SET document=document #- '{nodes,0,evolution}' WHERE id=$1`, cid)
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes", takeBack, 409)); code != "evolution_changed" {
		t.Fatal("a change taken back that a person took over:", code)
	}
	if entry := logByID(t, h.request(t, c, "GET", path, nil, 200), change["id"]); entry["standing"] != false {
		t.Fatal("a change a person took over stands", entry)
	}
	exec(`UPDATE canvases SET document=jsonb_set(document,'{nodes,0,evolution}',jsonb_build_object('change',$2::text)) WHERE id=$1`, cid, change["id"])
	h.request(t, c, "POST", path+"/changes", map[string]any{"graphId": first, "nodeId": "up", "revertsId": change["id"], "auto": false}, 409)
	back, _ := claim(t, h, c, path, takeBack, 200)
	if back["kind"] != "revert" || back["auto"] != false || back["from"] != "low" || back["to"] != "" || back["revertsId"] != change["id"] || back["state"] != "claimed" {
		t.Fatal("the change taken back, claimed", back)
	}
	if entry := logByID(t, h.request(t, c, "GET", path, nil, 200), change["id"]); entry["standing"] != false || entry["reverted"] != false {
		t.Fatal("a change being taken back", entry)
	}
	h.request(t, c, "POST", path+"/changes", takeBack, 409)
	settleBack := path + "/changes/" + back["id"].(string)
	h.request(t, c, "POST", settleBack, map[string]any{"done": true}, 409)
	applyChange(t, h, c, tid, cid, agent, "up", "", back["id"])
	view = h.request(t, c, "POST", settleBack, map[string]any{"done": true}, 200)
	if entry := logByID(t, view, change["id"]); entry["reverted"] != true || entry["standing"] != false || logByID(t, view, back["id"])["state"] != "done" {
		t.Fatal("the change taken back", view["log"])
	}
	if l := nodeLessons(t, h, tid, cid, "up")[0]; l.state != "dismissed" {
		t.Fatalf("the suggestion behind a change taken back: %+v", l)
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes", takeBack, 409)); code != "evolution_reverted" {
		t.Fatal("a change taken back twice:", code)
	}

	// Switched off, the canvas claims nothing of its own.
	view = h.request(t, c, "PUT", path, map[string]any{"autoApply": false, "autoRerun": false}, 200)
	if switchOf(view, "autoApply")["on"] != false || switchOf(view, "autoApply")["since"] != nil || switchOf(view, "autoRerun")["on"] != false {
		t.Fatal("switched off", view)
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes", map[string]any{"graphId": rerunID, "nodeId": "up", "lessonId": lesson.id}, 409)); code != "auto_apply_off" {
		t.Fatal("a claim switched off:", code)
	}
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action IN ('canvas_evolution.apply_off','canvas_evolution.rerun_off')", tid, cid); n != 2 {
		t.Fatal("switch-off audits", n)
	}

	// The evolution goes with its canvas.
	h.request(t, c, "DELETE", "/tenants/"+tid+"/canvases/"+cid, nil, 204)
	if n := h.rows(t, "SELECT (SELECT count(*) FROM canvas_auto_evolution WHERE tenant_id=$1)+(SELECT count(*) FROM canvas_evolution_log WHERE tenant_id=$1)", tid); n != 0 {
		t.Fatal("evolution rows outlived their canvas", n)
	}
}

// An auto rerun is admitted only while its switch is on, of the canvas's latest run once it failed and was learnt from
// after the switch was turned on, once, of its unfinished nodes alone, never of a rerun or a run a person stopped part
// of, and at most three a day.
func TestPostgresAnAutoRerunIsAdmittedOnlyAsItsRulesAllow(t *testing.T) {
	server := newEvolutionPi(t, func(node, effort string, call int) piReply {
		if node == "up" {
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT-" + node}
	})
	h := newHarness(t, server.URL)
	h.a.cfg.GraphNodeRetries = 0
	c, tid, _ := h.register(t, "evolve-rerun@example.test")
	cid, _ := evolutionCanvas(t, h, c, tid)
	path := "/tenants/" + tid + "/canvases/" + cid + "/evolution"
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	rerun := func(parent string, scope []string, status int, code string) map[string]any {
		t.Helper()
		got := h.request(t, c, "POST", base, map[string]any{"operationId": "autorerun:" + parent, "scope": scope}, status)
		if code != "" && failureCode(t, got) != code {
			t.Fatalf("rerun of %s: %v, want %s", parent, got, code)
		}
		return got
	}

	first := runCanvas(t, h, c, tid, cid, "rerun-run-1", nil, "failed")
	awaitEvolution(t, h, c, path, first)
	rerun(first, []string{"up", "down"}, 409, "auto_rerun_off")
	h.request(t, c, "PUT", path, map[string]any{"autoRerun": true}, 200)
	rerun(first, []string{"up", "down"}, 409, "auto_rerun_stale")

	second := runCanvas(t, h, c, tid, cid, "rerun-run-2", nil, "failed")
	view := awaitEvolution(t, h, c, path, second)
	if due := rerunOf(view); due == nil || fmt.Sprint(due["scope"]) != "[up down]" || len(pendingOf(view, "apply")) != 0 {
		t.Fatal("the rerun due leaves out a node that finished, and auto apply is off", view["pending"])
	}
	h.request(t, c, "POST", base, map[string]any{"operationId": "autorerun:", "scope": []string{"up"}}, 400)
	h.request(t, c, "POST", base, map[string]any{"operationId": "autorerun:not a run", "scope": []string{"up"}}, 400)
	rerun(second, []string{"side"}, 409, "auto_rerun_scope")
	rerun(second, []string{"up", "side"}, 409, "auto_rerun_scope")
	rerun(first, []string{"up"}, 409, "auto_rerun_stale")
	// A run in which a person stopped a node is not rerun.
	exec("UPDATE graph_run_nodes SET state='cancelled' WHERE graph_id=$1 AND node_id='side'", second)
	if view = h.request(t, c, "GET", path, nil, 200); rerunOf(view) != nil {
		t.Fatal("a run a person stopped part of is due a rerun", view["pending"])
	}
	rerun(second, []string{"up"}, 409, "auto_rerun_scope")
	exec("UPDATE graph_run_nodes SET state='done' WHERE graph_id=$1 AND node_id='side'", second)

	// A subset of the unfinished nodes may rerun; once; and the rerun's own failures are not rerun.
	rerunID := rerun(second, []string{"up"}, 202, "")["id"].(string)
	awaitGraph(t, h, c, base+"/"+rerunID, "failed")
	view = awaitEvolution(t, h, c, path, rerunID)
	if rerunOf(view) != nil || view["latestRun"].(map[string]any)["autoRerun"] != true {
		t.Fatal("a rerun's failures are due a rerun", view)
	}
	rerun(rerunID, []string{"up"}, 409, "auto_rerun_chained")
	if again := rerun(second, []string{"up"}, 200, ""); again["id"] != rerunID {
		t.Fatal("the same rerun asked for again", again)
	}

	// Three a day: the fourth waits until one of them is a day old.
	third := runCanvas(t, h, c, tid, cid, "rerun-run-3", nil, "failed")
	awaitEvolution(t, h, c, path, third)
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,graph_id,rerun_graph_id,done_at) VALUES('limit-1',$1,$2,'rerun',$3,'elsewhere-1',clock_timestamp()),
		('limit-2',$1,$2,'rerun',$4,'elsewhere-2',clock_timestamp())`, tid, cid, first, rerunID)
	if view = h.request(t, c, "GET", path, nil, 200); rerunOf(view) != nil || view["limits"].(map[string]any)["rerunsLastDay"] != float64(3) {
		t.Fatal("a fourth rerun in a day is due", view)
	}
	rerun(third, []string{"up", "down"}, 409, "auto_rerun_limit")
	exec("UPDATE canvas_evolution_log SET created_at=clock_timestamp()-interval '25 hours' WHERE id='limit-1'")
	if view = h.request(t, c, "GET", path, nil, 200); rerunOf(view) == nil {
		t.Fatal("a rerun is not due once one of the day's is older", view)
	}
	// A change the canvas holds, marked, whose recording failed (its claim long let go): recorded as the rerun is admitted.
	exec(`UPDATE canvases SET document=jsonb_set(jsonb_set(document,'{nodes,2,effort}','"high"'),'{nodes,2,evolution}','{"change":"unrecorded"}') WHERE id=$1`, cid)
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,from_effort,to_effort,created_at)
		VALUES('unrecorded',$1,$2,'effort','side',$3,'','high',clock_timestamp()-interval '31 minutes')`, tid, cid, third)
	last := rerun(third, []string{"up", "down"}, 202, "")["id"].(string)
	if n := h.rows(t, "SELECT count(*) FROM canvas_evolution_log WHERE id='unrecorded' AND kind='effort' AND done_at IS NOT NULL"); n != 1 {
		t.Fatal("a change the canvas holds is not recorded before its run's rerun", n)
	}
	// The rerun is admitted after it: a node of it refused at admission takes the rerun's time, which comes after.
	if n := h.rows(t, "SELECT count(*) FROM graph_runs g, canvas_evolution_log e WHERE g.id=$1 AND e.id='unrecorded' AND g.created_at>e.done_at", last); n != 1 {
		t.Fatal("a rerun admitted before the change recorded for it", n)
	}
	awaitGraph(t, h, c, base+"/"+last, "failed")
	if n := h.rows(t, "SELECT count(*) FROM canvas_evolution_log WHERE tenant_id=$1 AND kind='rerun' AND id NOT LIKE 'limit-%'", tid); n != 2 {
		t.Fatal("reruns recorded", n)
	}
}

// A change of effort that did not help is reverted: once the node's first two runs after it, of those its effort could
// fail (not an outage), both failed, and it is still at the effort the change left it, without waiting a day; never
// one a person changed again. Its suggestion is set aside, and the node, changed twice this week, is left alone. A
// change the page could not make is skipped with why, once for the run's end.
func TestPostgresAnAutoChangeThatDidNotHelpIsReverted(t *testing.T) {
	server := newEvolutionPi(t, func(node, effort string, call int) piReply {
		if node == "up" {
			if effort == "low" && call == 2 {
				return piReply{failed: "MODEL_UNAVAILABLE"}
			}
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT-" + node}
	})
	h := newHarness(t, server.URL)
	h.a.cfg.GraphNodeRetries = 0
	c, tid, user := h.register(t, "evolve-revert@example.test")
	cid, agent := effortCanvas(t, h, c, tid, "medium")
	path := "/tenants/" + tid + "/canvases/" + cid + "/evolution"
	h.request(t, c, "PUT", path, map[string]any{"autoApply": true}, 200)
	ctx := context.Background()

	first := runCanvas(t, h, c, tid, cid, "revert-run-1", nil, "failed")
	view := awaitEvolution(t, h, c, path, first)
	if len(pendingOf(view, "apply")) != 1 {
		t.Fatal("the change due", view["pending"])
	}
	step := pendingOf(view, "apply")[0].(map[string]any)
	change, _ := claim(t, h, c, path, map[string]any{"graphId": first, "nodeId": "up", "lessonId": step["lessonId"]}, 200)
	applyChange(t, h, c, tid, cid, agent, "up", "low", change["id"])
	h.request(t, c, "POST", path+"/changes/"+change["id"].(string), map[string]any{"done": true}, 200)
	// A run of the node at another effort since (a person's, at medium and back) judges nothing of the change.
	for _, sql := range []string{
		`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status,lessons_at,outcomes_at)
			VALUES('at-medium',$1,$2,$3,'at-medium','synthetic',1,'{}','["up"]','failed',clock_timestamp(),clock_timestamp())`,
		`INSERT INTO node_outcomes(tenant_id,canvas_id,graph_id,node_id,effort,state,code,ran_at) VALUES($1,$2,'at-medium','up','medium','failed','output_limit',clock_timestamp())`,
	} {
		args := []any{tid, cid}
		if strings.Contains(sql, "$3") {
			args = append(args, user)
		}
		if _, e := h.db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}

	// An outage judges nothing; one failure at low is not two.
	atLow := []string{}
	for i, op := range []string{"revert-run-2", "revert-run-3"} {
		gid := runCanvas(t, h, c, tid, cid, op, nil, "failed")
		atLow = append(atLow, gid)
		if view = awaitEvolution(t, h, c, path, gid); len(pendingOf(view, "revert")) != 0 || len(pendingOf(view, "apply")) != 0 {
			t.Fatalf("after run %d at low: %v", i+2, view["pending"])
		}
	}
	fourth := runCanvas(t, h, c, tid, cid, "revert-run-4", nil, "failed")
	view = awaitEvolution(t, h, c, path, fourth)
	revert := pendingOf(view, "revert")
	if len(revert) != 1 || len(pendingOf(view, "apply")) != 0 {
		t.Fatal("the revert due", view["pending"])
	}
	// A run of the node since the change whose outcome is not recorded (yet, or ever) may be among its first: the revert
	// waits for it, and for any canvas run under way. A run stopped, a run of the node before the change, a collaboration,
	// or a node run that records no outcome (blocked, or done without a run) judges nothing; once the outcome is there,
	// the revert is due again.
	if _, e := h.db.Exec(ctx, `INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status,created_at)
		VALUES('unrecorded',$1,$2,$3,'unrecorded','synthetic',1,'{}','["up"]','failed',(SELECT created_at-interval '1 millisecond' FROM graph_runs WHERE id=$4))`,
		tid, cid, user, fourth); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state) VALUES($1,'unrecorded','up',0,'failed')", tid); e != nil {
		t.Fatal(e)
	}
	changedAt := "(SELECT done_at FROM canvas_evolution_log WHERE id='" + change["id"].(string) + "')"
	since := "(SELECT created_at-interval '1 millisecond' FROM graph_runs WHERE id='" + fourth + "')"
	for _, c2 := range []struct {
		run, node string
		due       int
	}{
		{"status='failed'", "state='failed'", 0}, {"status='interrupted'", "state='failed'", 0}, {"status='running'", "state='failed'", 0},
		{"status='cancelled'", "state='failed'", 1}, {"status='failed'", "state='blocked'", 1}, {"status='failed'", "state='done'", 1},
		{"status='failed',created_at=" + changedAt + "-interval '2 seconds'", "state='failed'", 1},
		{"status='failed',collaboration='{\"rounds\":1}',created_at=" + since, "state='failed'", 1},
		{"status='failed',collaboration=NULL", "state='failed'", 0},
	} {
		if _, e := h.db.Exec(ctx, "UPDATE graph_runs SET "+c2.run+" WHERE id='unrecorded'"); e != nil {
			t.Fatal(c2.run, e)
		}
		if _, e := h.db.Exec(ctx, "UPDATE graph_run_nodes SET "+c2.node+" WHERE graph_id='unrecorded'"); e != nil {
			t.Fatal(c2.node, e)
		}
		if got := len(pendingOf(h.request(t, c, "GET", path, nil, 200), "revert")); got != c2.due {
			t.Fatalf("a run of the node since the change, %s, %s: %d reverts due", c2.run, c2.node, got)
		}
	}
	if _, e := h.db.Exec(ctx, `INSERT INTO node_outcomes(tenant_id,canvas_id,graph_id,node_id,effort,state,code,ran_at)
		VALUES($1,$2,'unrecorded','up','low','failed','output_limit',(SELECT created_at FROM graph_runs WHERE id='unrecorded'))`, tid, cid); e != nil {
		t.Fatal(e)
	}
	if got := len(pendingOf(h.request(t, c, "GET", path, nil, 200), "revert")); got != 1 {
		t.Fatalf("a run of the node since the change, recorded: %d reverts due", got)
	}
	if step := revert[0].(map[string]any); step["revertsId"] != change["id"] || step["nodeId"] != "up" || step["from"] != "low" || step["effort"] != "" ||
		step["model"] != "test-model" || step["kind"] != "revert" {
		t.Fatal("the revert", step)
	}
	// A node changed twice this week is reverted no more (an earlier change, made three days ago, here, though claimed
	// eight days ago); a revert waits for no day.
	if _, e := h.db.Exec(ctx, `INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,from_effort,to_effort,created_at,done_at)
		VALUES('week-1',$1,$2,'effort','up',$3,'high','',clock_timestamp()-interval '8 days',clock_timestamp()-interval '3 days')`, tid, cid, atLow[0]); e != nil {
		t.Fatal(e)
	}
	if view = h.request(t, c, "GET", path, nil, 200); len(pendingOf(view, "revert")) != 0 {
		t.Fatal("a third change this week is due", view["pending"])
	}
	if _, e := h.db.Exec(ctx, "DELETE FROM canvas_evolution_log WHERE id='week-1'"); e != nil {
		t.Fatal(e)
	}
	// A node a person changed again is theirs.
	if _, e := h.db.Exec(ctx, `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,effort}','"high"') WHERE id=$1`, cid); e != nil {
		t.Fatal(e)
	}
	if view = h.request(t, c, "GET", path, nil, 200); len(pendingOf(view, "revert")) != 0 {
		t.Fatal("a node a person changed again is reverted", view["pending"])
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes", map[string]any{"graphId": fourth, "nodeId": "up", "revertsId": change["id"]}, 409)); code != "evolution_not_due" {
		t.Fatal("a revert of a node a person changed again, claimed:", code)
	}
	if _, e := h.db.Exec(ctx, `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,effort}','"low"') WHERE id=$1`, cid); e != nil {
		t.Fatal(e)
	}
	// A person who sets the node away and back, through the page, takes the change over: its mark goes, and it is
	// reverted no more.
	setNodeEffort(t, h, c, tid, cid, agent, "up", "high")
	setNodeEffort(t, h, c, tid, cid, agent, "up", "low")
	if view = h.request(t, c, "GET", path, nil, 200); len(pendingOf(view, "revert")) != 0 || logByID(t, view, change["id"])["standing"] != false {
		t.Fatal("a change a person took over is due its revert", view["pending"])
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes", map[string]any{"graphId": fourth, "nodeId": "up", "revertsId": change["id"]}, 409)); code != "evolution_not_due" {
		t.Fatal("a revert of a change a person took over, claimed:", code)
	}
	if _, e := h.db.Exec(ctx, `UPDATE canvases SET document=jsonb_set(document,'{nodes,0,evolution}',jsonb_build_object('change',$2::text)) WHERE id=$1`, cid, change["id"]); e != nil {
		t.Fatal(e)
	}
	// A change of the node under way (a person's take-back, here) holds the revert back; one let go (its page closed
	// before it made it) does not.
	taking, _ := claim(t, h, c, path, map[string]any{"graphId": first, "nodeId": "up", "revertsId": change["id"], "auto": false}, 200)
	if len(pendingOf(h.request(t, c, "GET", path, nil, 200), "revert")) != 0 {
		t.Fatal("a revert is due while a change of its node is under way")
	}
	if _, e := h.db.Exec(ctx, "UPDATE canvas_evolution_log SET created_at=clock_timestamp()-interval '31 minutes' WHERE id=$1", taking["id"]); e != nil {
		t.Fatal(e)
	}
	if len(pendingOf(h.request(t, c, "GET", path, nil, 200), "revert")) != 1 {
		t.Fatal("a take-back let go holds the revert back")
	}
	if _, e := h.db.Exec(ctx, "DELETE FROM canvas_evolution_log WHERE id=$1", taking["id"]); e != nil {
		t.Fatal(e)
	}
	// A change taken back (a person's, done) whose take-back was then undone, its mark back on the node: not due again.
	if _, e := h.db.Exec(ctx, `INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,auto,node_id,graph_id,reverts_id,from_effort,to_effort,done_at)
		VALUES('undone-back',$1,$2,'revert',false,'up',$3,$4,'low','',clock_timestamp())`, tid, cid, first, change["id"]); e != nil {
		t.Fatal(e)
	}
	if len(pendingOf(h.request(t, c, "GET", path, nil, 200), "revert")) != 0 {
		t.Fatal("a change taken back is due its revert again")
	}
	if _, e := h.db.Exec(ctx, "DELETE FROM canvas_evolution_log WHERE id='undone-back'"); e != nil {
		t.Fatal(e)
	}

	back, _ := claim(t, h, c, path, map[string]any{"graphId": fourth, "nodeId": "up", "revertsId": change["id"]}, 200)
	if back["kind"] != "revert" || back["auto"] != true || back["from"] != "low" || back["to"] != "" || back["graphId"] != fourth {
		t.Fatal("the revert claimed", back)
	}
	settle := path + "/changes/" + back["id"].(string)
	h.request(t, c, "POST", settle, map[string]any{"done": true}, 409)
	applyChange(t, h, c, tid, cid, agent, "up", "", back["id"])
	view = h.request(t, c, "POST", settle, map[string]any{"done": true}, 200)
	if logByID(t, view, change["id"])["reverted"] != true || logByID(t, view, back["id"])["state"] != "done" || len(pendingOf(view, "revert")) != 0 {
		t.Fatal("the revert done", view)
	}
	if l := nodeLessons(t, h, tid, cid, "up"); l[0].kind != "output_limit" || l[0].state != "dismissed" {
		t.Fatalf("the suggestion behind a change that did not help: %+v", l)
	}

	// The same failure at the model's default again: its suggestion stays set aside, and nothing more is due.
	fifth := runCanvas(t, h, c, tid, cid, "revert-run-5", nil, "failed")
	if view = awaitEvolution(t, h, c, path, fifth); len(pendingOf(view, "apply")) != 0 || len(pendingOf(view, "revert")) != 0 {
		t.Fatal("after the revert", view["pending"])
	}
	// A page that could not make a change says why, once for the run's end. (The lesson, which failed three runs it was
	// given, has retired itself by now: it is restored here, as a person could; the changes of the week are cleared.)
	if _, e := h.db.Exec(ctx, "UPDATE canvas_lessons SET proposal_state='open',status='active' WHERE tenant_id=$1 AND canvas_id=$2 AND node_id='up' AND kind='output_limit'", tid, cid); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "DELETE FROM canvas_evolution_log WHERE tenant_id=$1", tid); e != nil {
		t.Fatal(e)
	}
	apply := pendingOf(h.request(t, c, "GET", path, nil, 200), "apply")
	if len(apply) != 1 {
		t.Fatal("the change due once its limits are clear", apply)
	}
	skip, _ := claim(t, h, c, path, map[string]any{"graphId": fifth, "nodeId": "up", "lessonId": apply[0].(map[string]any)["lessonId"]}, 200)
	h.request(t, c, "POST", path+"/changes/"+skip["id"].(string), map[string]any{"skipped": strings.Repeat("x", 301)}, 400)
	view = h.request(t, c, "POST", path+"/changes/"+skip["id"].(string), map[string]any{"skipped": " A plan is under way "}, 200)
	if entry := logByID(t, view, skip["id"]); entry["kind"] != "skip" || entry["reason"] != "A plan is under way" || entry["state"] != "done" || len(pendingOf(view, "apply")) != 0 {
		t.Fatal("the skip recorded", view)
	}
	h.request(t, c, "POST", path+"/changes/"+skip["id"].(string), map[string]any{"done": true}, 409)
	h.request(t, c, "POST", path+"/changes/"+skip["id"].(string), map[string]any{"skipped": "A plan is under way"}, 200)
	h.request(t, c, "POST", path+"/changes/"+skip["id"].(string), map[string]any{"skipped": "Another reason"}, 409)
	if l := nodeLessons(t, h, tid, cid, "up"); l[0].state != "open" {
		t.Fatalf("a skipped suggestion: %+v", l)
	}
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='canvas_evolution.skip' AND resource_id=$2", tid, skip["id"]); n != 1 {
		t.Fatal("skip audits", n)
	}
}

// A change whose first runs after it did well is kept, whatever its later runs do: the runs it is judged by are the
// first after it, not the latest.
func TestPostgresAChangeWhoseFirstRunsDidWellIsKept(t *testing.T) {
	server := newEvolutionPi(t, func(node, effort string, call int) piReply {
		if node == "up" && (effort != "low" || call >= 4) {
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT-" + node}
	})
	h := newHarness(t, server.URL)
	h.a.cfg.GraphNodeRetries = 0
	c, tid, _ := h.register(t, "evolve-kept@example.test")
	cid, agent := effortCanvas(t, h, c, tid, "medium")
	path := "/tenants/" + tid + "/canvases/" + cid + "/evolution"
	h.request(t, c, "PUT", path, map[string]any{"autoApply": true}, 200)
	first := runCanvas(t, h, c, tid, cid, "kept-run-1", nil, "failed")
	view := awaitEvolution(t, h, c, path, first)
	if len(pendingOf(view, "apply")) != 1 {
		t.Fatal("the change due", view["pending"])
	}
	change, _ := claim(t, h, c, path, map[string]any{"graphId": first, "nodeId": "up", "lessonId": pendingOf(view, "apply")[0].(map[string]any)["lessonId"]}, 200)
	applyChange(t, h, c, tid, cid, agent, "up", "low", change["id"])
	h.request(t, c, "POST", path+"/changes/"+change["id"].(string), map[string]any{"done": true}, 200)
	// Two runs at low that finish, then two that fail.
	for i, want := range []string{"completed", "completed", "failed", "failed"} {
		gid := runCanvas(t, h, c, tid, cid, fmt.Sprintf("kept-run-%d", i+2), nil, want)
		if view = awaitEvolution(t, h, c, path, gid); len(pendingOf(view, "revert")) != 0 {
			t.Fatalf("after run %d: a change whose first runs did well is reverted: %v", i+2, view["pending"])
		}
	}
}

// A person's revert claimed and never settled is let go, and may be claimed again, as often as it is let go.
func TestPostgresAClaimNeverSettledIsLetGoAndClaimedAgain(t *testing.T) {
	h := newHarness(t, "")
	c, tid, user := h.register(t, "evolve-expire@example.test")
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO canvases(id,tenant_id,name,document) VALUES('expire-canvas',$1,'Expire','{"nodes":[{"id":"up","kind":"session","title":"up","effort":"low","evolution":{"change":"expire-change"}}],"edges":[]}')`,
		`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status,lessons_at)
			VALUES('expire-graph',$1,'expire-canvas',$2,'expire-op','synthetic',1,'{}','["up"]','failed',clock_timestamp())`,
		`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,from_effort,to_effort,done_at)
			VALUES('expire-change',$1,'expire-canvas','effort','up','expire-graph','','low',clock_timestamp())`,
	} {
		args := []any{tid}
		if strings.Contains(sql, "$2") {
			args = append(args, user)
		}
		if _, e := h.db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	path := "/tenants/" + tid + "/canvases/expire-canvas/evolution"
	takeBack := map[string]any{"graphId": "expire-graph", "nodeId": "up", "revertsId": "expire-change", "auto": false}
	for round := 0; round < 3; round++ {
		back, _ := claim(t, h, c, path, takeBack, 200)
		if back["from"] != "low" || back["to"] != "" {
			t.Fatal("the change taken back", back)
		}
		// Claimed and under way: not claimed twice.
		h.request(t, c, "POST", path+"/changes", takeBack, 409)
		if _, e := h.db.Exec(ctx, "UPDATE canvas_evolution_log SET created_at=clock_timestamp()-interval '31 minutes' WHERE id=$1", back["id"]); e != nil {
			t.Fatal(e)
		}
	}
	if n := h.rows(t, "SELECT count(*) FROM canvas_evolution_log WHERE tenant_id=$1 AND kind='skip' AND reason='' AND done_at IS NOT NULL", tid); n != 2 {
		t.Fatal("claims let go", n)
	}
	// The third, claimed long ago and settled now, is refused and let go: its run's rerun may have gone without it.
	var third string
	if e := h.db.QueryRow(ctx, "SELECT id FROM canvas_evolution_log WHERE tenant_id=$1 AND kind='revert' AND done_at IS NULL", tid).Scan(&third); e != nil {
		t.Fatal(e)
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes/"+third, map[string]any{"done": true}, 409)); code != "evolution_expired" {
		t.Fatal("a claim settled after it was let go:", code)
	}
	if n := h.rows(t, "SELECT count(*) FROM canvas_evolution_log WHERE tenant_id=$1 AND id=$2 AND kind='skip' AND done_at IS NOT NULL", tid, third); n != 1 {
		t.Fatal("a claim settled after it was let go is not let go", n)
	}
	// A claim refused keeps what its settling recorded: here a change the canvas holds, marked, whose recording failed.
	for _, sql := range []string{
		`UPDATE canvases SET document=jsonb_set(document,'{nodes}',document->'nodes'||'[{"id":"down","kind":"session","title":"down","effort":"high","evolution":{"change":"repaired"}}]')
			WHERE id='expire-canvas'`,
		`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,from_effort,to_effort,created_at)
			VALUES('repaired',$1,'expire-canvas','effort','down','expire-graph','','high',clock_timestamp()-interval '31 minutes')`,
	} {
		args := []any{}
		if strings.Contains(sql, "$1") {
			args = append(args, tid)
		}
		if _, e := h.db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes", map[string]any{"graphId": "expire-graph", "nodeId": "down", "lessonId": "none"}, 409)); code != "auto_apply_off" {
		t.Fatal("an auto claim with auto apply off:", code)
	}
	if n := h.rows(t, "SELECT count(*) FROM canvas_evolution_log WHERE id='repaired' AND kind='effort' AND done_at IS NOT NULL"); n != 1 {
		t.Fatal("a refused claim undid what its settling recorded", n)
	}
}

// A change claimed is done with the canvas save that makes it (the node at its effort, carrying its mark), whether or
// not its page lives to say so: as of the save, audited as the saver's, its suggestion applied; its page's settle after
// is answered as done, and a skip of it refused. A save that does not hold a change under way leaves it to its page, and
// so does a person's own edit to the same effort, which carries no mark. A claim let go that the canvas does not hold
// (another effort, no mark, a node gone) is a skip; one the canvas holds (its document written by hand, which settles
// nothing) is done, by no one.
func TestPostgresAChangeIsDoneWithTheSaveThatMakesIt(t *testing.T) {
	server := newEvolutionPi(t, func(node, effort string, call int) piReply {
		if node == "up" && effort != "low" {
			return piReply{failed: "MODEL_OUTPUT_LIMIT"}
		}
		return piReply{text: "RESULT-" + node}
	})
	h := newHarness(t, server.URL)
	h.a.cfg.GraphNodeRetries = 0
	c, tid, user := h.register(t, "evolve-saved@example.test")
	cid, agent := effortCanvas(t, h, c, tid, "medium")
	path := "/tenants/" + tid + "/canvases/" + cid + "/evolution"
	h.request(t, c, "PUT", path, map[string]any{"autoApply": true}, 200)
	ctx := context.Background()
	audits := func(id any, actor string) int64 {
		t.Helper()
		if actor == "" {
			return h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND actor_id IS NULL", tid, id)
		}
		return h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND actor_id=$3", tid, id, actor)
	}

	first := runCanvas(t, h, c, tid, cid, "saved-run-1", nil, "failed")
	view := awaitEvolution(t, h, c, path, first)
	if len(pendingOf(view, "apply")) != 1 {
		t.Fatal("the change due", view["pending"])
	}
	change, _ := claim(t, h, c, path, map[string]any{"graphId": first, "nodeId": "up", "lessonId": pendingOf(view, "apply")[0].(map[string]any)["lessonId"]}, 200)
	// A save that does not hold it (the canvas renamed) leaves it under way.
	canvas := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid, nil, 200)
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": "Renamed", "document": canvas["document"], "version": canvas["version"]}, 200)
	if entry := logByID(t, h.request(t, c, "GET", path, nil, 200), change["id"]); entry["state"] != "claimed" {
		t.Fatal("a change under way, after a save that does not hold it", entry)
	}
	// A person sets the node at the same effort themselves: not the change, which the page has not made.
	setNodeEffort(t, h, c, tid, cid, agent, "up", "low")
	if entry := logByID(t, h.request(t, c, "GET", path, nil, 200), change["id"]); entry["state"] != "claimed" {
		t.Fatal("a change under way, after a person's own edit to its effort", entry)
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes/"+change["id"].(string), map[string]any{"done": true}, 409)); code != "evolution_unsaved" {
		t.Fatal("a change settled on a person's own edit:", code)
	}
	applyChange(t, h, c, tid, cid, agent, "up", "low", change["id"])
	view = h.request(t, c, "GET", path, nil, 200)
	if entry := logByID(t, view, change["id"]); entry["kind"] != "effort" || entry["state"] != "done" || entry["standing"] != true {
		t.Fatal("a change its save made", entry)
	}
	if l := nodeLessons(t, h, tid, cid, "up"); l[0].kind != "output_limit" || l[0].state != "applied" {
		t.Fatalf("the suggestion of a change its save made: %+v", l)
	}
	if audits(change["id"], user) != 1 {
		t.Fatal("a change its save made is not audited as the saver's")
	}
	h.request(t, c, "POST", path+"/changes/"+change["id"].(string), map[string]any{"done": true}, 200)
	if audits(change["id"], user) != 1 {
		t.Fatal("a change its save made is audited again by its page's settle")
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes/"+change["id"].(string), map[string]any{"skipped": "The page left"}, 409)); code != "evolution_settled" {
		t.Fatal("a skip of a change its save made:", code)
	}

	// A person's take-back, saved and never said: done with its save, the change taken back, its suggestion set aside.
	back, _ := claim(t, h, c, path, map[string]any{"graphId": first, "nodeId": "up", "revertsId": change["id"], "auto": false}, 200)
	applyChange(t, h, c, tid, cid, agent, "up", "", back["id"])
	view = h.request(t, c, "GET", path, nil, 200)
	if logByID(t, view, back["id"])["state"] != "done" || logByID(t, view, back["id"])["kind"] != "revert" || logByID(t, view, change["id"])["reverted"] != true {
		t.Fatal("a take-back its save made", view["log"])
	}
	if l := nodeLessons(t, h, tid, cid, "up"); l[0].state != "dismissed" {
		t.Fatalf("the suggestion behind a change taken back with a save: %+v", l)
	}
	if audits(back["id"], user) != 1 {
		t.Fatal("a take-back its save made is not audited as the saver's")
	}

	// Claims let go: of a node at another effort, of one at the effort but without the mark (up, marked by the take-back),
	// of a node gone, and of one the canvas holds, written by hand with its mark. A late settle of one lets them all go.
	second := runCanvas(t, h, c, tid, cid, "saved-run-2", nil, "failed")
	if _, e := h.db.Exec(ctx, `UPDATE canvases SET document=jsonb_set(jsonb_set(document,'{nodes,1,effort}','"high"'),'{nodes,1,evolution}','{"change":"held"}')
		WHERE id=$1`, cid); e != nil {
		t.Fatal(e)
	}
	for _, claimed := range []struct{ id, node, graph, from, to string }{
		{"not-held", "down", first, "medium", "low"}, {"unmarked", "up", second, "low", ""}, {"gone", "gone", second, "", ""}, {"held", "down", second, "", "high"},
	} {
		if _, e := h.db.Exec(ctx, `INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,node_id,graph_id,from_effort,to_effort,created_at)
			VALUES($1,$2,$3,'effort',$4,$5,$6,$7,clock_timestamp()-interval '31 minutes')`, claimed.id, tid, cid, claimed.node, claimed.graph, claimed.from, claimed.to); e != nil {
			t.Fatal(e)
		}
	}
	if code := failureCode(t, h.request(t, c, "POST", path+"/changes/not-held", map[string]any{"done": true}, 409)); code != "evolution_expired" {
		t.Fatal("a late settle of a claim the canvas does not hold:", code)
	}
	view = h.request(t, c, "GET", path, nil, 200)
	for _, id := range []string{"not-held", "unmarked", "gone"} {
		if entry := logByID(t, view, id); entry["kind"] != "skip" || entry["state"] != "done" || entry["reason"] != "" {
			t.Fatalf("a claim let go that the canvas does not hold, %s: %v", id, entry)
		}
		if audits(id, "") != 0 {
			t.Fatalf("a skip let go is audited: %s", id)
		}
	}
	if entry := logByID(t, view, "held"); entry["kind"] != "effort" || entry["state"] != "done" {
		t.Fatal("a claim let go that the canvas holds", entry)
	}
	if audits("held", "") != 1 {
		t.Fatal("a claim let go that the canvas holds is not audited as no one's")
	}
}

// A claim let go that a later save makes after all (its page made it and could not save it then, or a draft of it was
// restored) is done with that save, its node at its effort carrying its mark, though a later attempt of the same change
// was let go after it. A person's own edit to that effort, which carries no mark, revives nothing, nor does a skip the
// page made with a reason; and a change whose place another of its kind holds by now stays let go, the save going
// through.
func TestPostgresAClaimLetGoThatASaveMakesAfterAllIsDone(t *testing.T) {
	server := newEvolutionPi(t, func(node, effort string, call int) piReply { return piReply{text: "RESULT-" + node} })
	h := newHarness(t, server.URL)
	c, tid, user := h.register(t, "evolve-revive@example.test")
	cid, _ := evolutionCanvas(t, h, c, tid)
	path := "/tenants/" + tid + "/canvases/" + cid + "/evolution"
	ctx := context.Background()
	save := func(efforts, marks map[string]string) {
		t.Helper()
		canvas := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid, nil, 200)
		doc := canvas["document"].(map[string]any)
		for _, raw := range doc["nodes"].([]any) {
			n := raw.(map[string]any)
			if effort, ok := efforts[n["id"].(string)]; ok {
				n["effort"] = effort
			}
			if mark, ok := marks[n["id"].(string)]; ok {
				n["evolution"] = map[string]any{"change": mark}
			}
		}
		h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": canvas["name"], "document": doc, "version": canvas["version"]}, 200)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	save(map[string]string{"up": "medium", "down": "medium", "side": "medium"}, nil)
	gid := runCanvas(t, h, c, tid, cid, "revive-run", nil, "completed")
	for _, row := range []string{
		`'let-go','skip','up','medium','low','',clock_timestamp()-interval '40 minutes',clock_timestamp()-interval '9 minutes'`,
		`'retry','skip','up','medium','low','The page left the canvas before it made this change.',clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '4 minutes'`,
		`'own-skip','skip','down','medium','low','The canvas did not take this change.',clock_timestamp()-interval '40 minutes',clock_timestamp()-interval '39 minutes'`,
		`'unmarked','skip','side','medium','low','',clock_timestamp()-interval '40 minutes',clock_timestamp()-interval '9 minutes'`,
	} {
		exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,graph_id,kind,node_id,from_effort,to_effort,reason,created_at,done_at)
			VALUES(`+strings.Replace(row, ",", ",$1,$2,$3,", 1)+`)`, tid, cid, gid)
	}
	// The page's draft comes back: up made by let-go's attempt, down marked by a change the page skipped; side, a person's.
	save(map[string]string{"up": "low", "down": "low", "side": "low"}, map[string]string{"up": "let-go", "down": "own-skip"})
	view := h.request(t, c, "GET", path, nil, 200)
	if entry := logByID(t, view, "let-go"); entry["kind"] != "effort" || entry["state"] != "done" || entry["standing"] != true {
		t.Fatal("a claim let go that a save makes after all", entry)
	}
	for _, id := range []string{"retry", "own-skip", "unmarked"} {
		if entry := logByID(t, view, id); entry["kind"] != "skip" {
			t.Fatalf("a skip a save does not make, %s: %v", id, entry)
		}
	}
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id='let-go' AND action='canvas_evolution.effort' AND actor_id=$2", tid, user); n != 1 {
		t.Fatal("a claim a save made after all, audited", n)
	}
	// A change of side let go, whose place another change of side at the same run's end holds by now: it stays let go,
	// and the save that carries its mark goes through, making the change under way it carries too.
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,graph_id,kind,node_id,from_effort,to_effort,created_at,done_at)
		VALUES('holder',$1,$2,$3,'effort','side','medium','high',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '3 minutes')`, tid, cid, gid)
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,graph_id,kind,node_id,from_effort,to_effort,created_at,done_at)
		VALUES('blocked',$1,$2,$3,'skip','side','low','high',clock_timestamp()-interval '40 minutes',clock_timestamp()-interval '9 minutes')`, tid, cid, gid)
	exec(`INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,graph_id,kind,node_id,from_effort,to_effort)
		VALUES('fresh',$1,$2,$3,'effort','down','low','high')`, tid, cid, gid)
	save(map[string]string{"side": "high", "down": "high"}, map[string]string{"side": "blocked", "down": "fresh"})
	view = h.request(t, c, "GET", path, nil, 200)
	if entry := logByID(t, view, "blocked"); entry["kind"] != "skip" {
		t.Fatal("a claim let go whose place another holds", entry)
	}
	if entry := logByID(t, view, "fresh"); entry["kind"] != "effort" || entry["state"] != "done" {
		t.Fatal("a change made by the same save", entry)
	}
}

// A canvas run's time is taken as it is admitted, under its locks: one that waited for them (another write held them)
// comes after what went before it, so that the canvas's latest run is the one admitted last.
func TestPostgresACanvasRunTakesItsTimeAsItIsAdmitted(t *testing.T) {
	server := newEvolutionPi(t, func(node, effort string, call int) piReply { return piReply{text: "RESULT-" + node} })
	h := newHarness(t, server.URL)
	c, tid, _ := h.register(t, "evolve-admitted@example.test")
	cid, _ := evolutionCanvas(t, h, c, tid)
	ctx := context.Background()
	lock, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer lock.Rollback(ctx)
	if _, e = lock.Exec(ctx, "SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", tid); e != nil {
		t.Fatal(e)
	}
	answer := make(chan [2]string, 1)
	go func() {
		r, _ := http.NewRequest("POST", h.server.URL+"/api/v1/tenants/"+tid+"/canvases/"+cid+"/graph-runs", strings.NewReader(`{"operationId":"waited-run"}`))
		r.Header.Set("Origin", h.cfg.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(c)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			answer <- [2]string{"error", err.Error()}
			return
		}
		defer resp.Body.Close()
		var got map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&got)
		id, _ := got["id"].(string)
		answer <- [2]string{fmt.Sprint(resp.StatusCode), id}
	}()
	time.Sleep(500 * time.Millisecond)
	var released time.Time
	if e = lock.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&released); e != nil {
		t.Fatal(e)
	}
	if e = lock.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	got := <-answer
	if got[0] != "202" {
		t.Fatal("the canvas run that waited", got)
	}
	var created time.Time
	if e = h.db.QueryRow(ctx, "SELECT created_at FROM graph_runs WHERE id=$1", got[1]).Scan(&created); e != nil {
		t.Fatal(e)
	}
	if !created.After(released) {
		t.Fatalf("a canvas run admitted after %v took the time %v of its transaction's start", released, created)
	}
	awaitGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs/"+got[1], "completed")
}

// The switches, the claims and the settles check the person's role in the transaction that writes, after the request's
// body came in.
func TestPostgresACanvasEvolutionWriteChecksTheRoleAsItWrites(t *testing.T) {
	h := newHarness(t, "")
	_, tid, _ := h.register(t, "evolve-role@example.test")
	_, _, member := h.register(t, "evolve-role-member@example.test")
	cid := "evolve-role-canvas"
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO canvases(id,tenant_id,name) VALUES($1,$2,'Role')", cid, tid); e != nil {
		t.Fatal(e)
	}
	write := func(handler http.HandlerFunc, body string) int {
		t.Helper()
		req := httptest.NewRequest("POST", "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.SetPathValue("tenantId", tid)
		req.SetPathValue("canvasId", cid)
		req.SetPathValue("changeId", "none")
		req = req.WithContext(context.WithValue(req.Context(), userKey{}, User{ID: member}))
		rec := httptest.NewRecorder()
		handler(rec, req)
		return rec.Code
	}
	for _, c := range []struct {
		role                 string
		put, claimed, settle int
	}{{"reader", 403, 403, 403}, {"", 404, 404, 404}, {"member", 200, 409, 404}} {
		if _, e := h.db.Exec(ctx, "DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, member); e != nil {
			t.Fatal(e)
		}
		if c.role != "" {
			if _, e := h.db.Exec(ctx, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", tid, member, c.role); e != nil {
				t.Fatal(e)
			}
		}
		if got := write(h.a.updateCanvasEvolution, `{"autoRerun":true}`); got != c.put {
			t.Errorf("%q: switch %d, want %d", c.role, got, c.put)
		}
		// A member's claim, with auto apply off, is refused for that; a settle names no change of the canvas.
		if got := write(h.a.claimCanvasEvolution, `{"graphId":"none","nodeId":"up","lessonId":"none"}`); got != c.claimed {
			t.Errorf("%q: claim %d, want %d", c.role, got, c.claimed)
		}
		if got := write(h.a.settleCanvasEvolution, `{"done":true}`); got != c.settle {
			t.Errorf("%q: settle %d, want %d", c.role, got, c.settle)
		}
	}
}

func TestAutoRerunParentReadsOnlyARunsID(t *testing.T) {
	for _, c := range []struct {
		id, parent string
		auto       bool
	}{
		{"autorerun:aBc-_9", "aBc-_9", true}, {"autorerun:", "", true}, {"autorerun:a b", "", true}, {"autorerun:a:b", "", true},
		{"autorerun:" + strings.Repeat("a", 101), "", true}, {"rerun:abc", "", false}, {"3f2a9c1e-uuid", "", false},
	} {
		if parent, auto := autoRerunParent(c.id); parent != c.parent || auto != c.auto {
			t.Errorf("%q: %q %v", c.id, parent, auto)
		}
	}
}
