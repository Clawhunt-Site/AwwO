package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// Each refusal names the first check of the plan gate the answer fails, after the slips the gate repairs, and nothing
// of the answer's text; an answer the gate takes names nothing.
func TestPlanRefusalReasonNamesTheFirstCheckAPlanFails(t *testing.T) {
	plan := func(ops ...string) string {
		return `{"version":1,"summary":"Plan","operations":[` + strings.Join(ops, ",") + `]}`
	}
	node := func(ref string) string {
		return `{"type":"add_node","ref":"` + ref + `","templateId":"general","title":"A"}`
	}
	remove := `{"type":"remove_node","nodeId":"n"}`
	many := make([]string, 101)
	for i := range many {
		many[i] = remove
	}
	// A new node's outputs on add_node, and the model the request said new nodes take: slips the gate repairs.
	slips := plan(`{"type":"add_node","ref":"r","templateId":"general","title":"Report","acceptanceCriteria":["Done"],"model":"test-model",` +
		`"outputs":[{"id":"report","label":"Report","type":"markdown","required":true}]}`)
	for _, c := range []struct{ name, raw, newNodeModel, want string }{
		{"taken", plan(node("a"), remove), "", ""},
		{"taken in a fence", "```json\n" + plan(node("a")) + "\n```", "", ""},
		{"slips repaired", slips, "test-model", ""},
		{"a model the request did not name", slips, "", "operation:add_node"},
		{"too long", plan(`{"type":"update_node","nodeId":"n","title":"` + strings.Repeat("x", 120001) + `"}`), "", "too_long"},
		{"cut off", `{"version":1,"summary":"Plan","operations":[`, "", "not_json"},
		{"prose", "Here is the plan you asked for.", "", "not_json"},
		{"another version", `{"version":2,"summary":"Plan","operations":[]}`, "", "shape"},
		{"another key", `{"version":1,"summary":"Plan","operations":[],"notes":"x"}`, "", "shape"},
		{"operations not a list", `{"version":1,"summary":"Plan","operations":{}}`, "", "shape"},
		{"no summary", `{"version":1,"summary":"","operations":[]}`, "", "summary"},
		{"too many", plan(many...), "", "too_many_operations"},
		{"not an object", plan(`1`), "", "operation_shape"},
		{"an invented type", plan(`{"type":"explode"}`), "", "unknown_operation"},
		{"an unknown key", plan(`{"type":"add_node","ref":"a","templateId":"general","color":"red"}`), "", "operation:add_node"},
		{"rounds out of range", plan(`{"type":"set_execution","mode":"review","maxRounds":9,"reviewerNodeId":"r","verdictFieldId":"v"}`), "", "operation:set_execution"},
		{"half a connection", plan(node("a"), `{"type":"connect","fromNode":"a"}`), "", "operation:connect"},
		{"one ref twice", plan(node("a"), node("a")), "", "references"},
		// The gate stops at its first failure: the second add_node, before the invented third operation.
		{"one ref twice, then an invented type", plan(node("a"), node("a"), `{"type":"explode"}`), "", "references"},
		// Measured as the gate measures it: without the answer's own spacing.
		{"spaced out", "{\"version\":1,\"summary\":\"Plan\",\"operations\":[" + strings.Repeat(" \n", 61000) + `{"type":"remove_node"}]}`, "", "operation:remove_node"},
	} {
		if got := planRefusalReason(c.raw, c.newNodeModel); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
		_, taken := acceptPlanFor(c.raw, c.newNodeModel)
		if taken != (c.want == "") {
			t.Errorf("%s: the gate takes it: %v, but the reason is %q", c.name, taken, c.want)
		}
	}
}

// A plan within the bound until the gate repairs it (a filled input becomes an add_field and a set_input) is too long,
// not a plan that gives one ref twice.
func TestPlanRefusalReasonCountsARepairedPlansLength(t *testing.T) {
	filled := `{"type":"add_field","nodeId":"n","side":"input","field":{"id":"f","label":"F","type":"text","required":false,"value":"` + strings.Repeat("v", 15000) + `"}}`
	ops := []string{filled}
	for range 13 {
		ops = append(ops, `{"type":"update_node","nodeId":"n","persona":"`+strings.Repeat("p", 8000)+`"}`)
	}
	build := func(summary string) string {
		return `{"version":1,"summary":"` + summary + `","operations":[` + strings.Join(ops, ",") + `]}`
	}
	pad := 119990 - utf8.RuneCountInString(build("S"))
	if pad < 0 || pad > 990 {
		t.Fatalf("the plan is %d runes off its target", pad)
	}
	raw := build("S" + strings.Repeat("s", pad))
	if n := utf8.RuneCountInString(raw); n > 120000 {
		t.Fatalf("the answer itself is too long: %d", n)
	}
	if _, taken := acceptPlanFor(raw, ""); taken {
		t.Fatal("the gate took a plan its repair made too long")
	}
	if got := planRefusalReason(raw, ""); got != "too_long" {
		t.Fatalf("named %q", got)
	}
}

// Every reason has a sentence, a word the table takes, and a place in the list; every operation the gate takes is
// checked as itself, never as an invented one.
func TestPlannerHintsCoverEveryReason(t *testing.T) {
	word := regexp.MustCompile(`^[a-z_]{1,32}(:[a-z_]{1,32})?$`)
	reasons := append([]string{}, planWholeReasons...)
	for _, typ := range planGateOperations {
		reasons = append(reasons, "operation:"+typ)
	}
	if len(reasons) != len(plannerHints) {
		t.Fatalf("%d reasons, %d sentences", len(reasons), len(plannerHints))
	}
	for i, reason := range reasons {
		if !word.MatchString(reason) || plannerHints[reason] == "" || plannerHintRank(reason) != i {
			t.Errorf("%s: %q at %d", reason, plannerHints[reason], plannerHintRank(reason))
		}
	}
	for _, typ := range planOperationTypes {
		if !slices.Contains(planGateOperations, typ) {
			t.Errorf("progress names %s, which the gate does not take", typ)
		}
	}
	for _, typ := range planGateOperations {
		if got := planRefusalReason(`{"version":1,"summary":"Plan","operations":[{"type":"`+typ+`","bogus":true}]}`, ""); got != "operation:"+typ {
			t.Errorf("%s: %q", typ, got)
		}
	}
}

// The most frequent reasons are named, in a fixed order whatever their counts, so a planner's instructions change
// only when a mistake comes or goes.
func TestPlannerHintTextNamesTheMostFrequentInAFixedOrder(t *testing.T) {
	if got := plannerHintText(nil); got != "" {
		t.Fatalf("none: %q", got)
	}
	want := "\n\n" + plannerHintHeading + "\n- " + plannerHints["not_json"] + "\n- " + plannerHints["shape"] + "\n- " + plannerHints["operation:connect"]
	for _, order := range [][]plannerReason{
		{{"shape", 9}, {"operation:connect", 5}, {"not_json", 3}},
		{{"not_json", 30}, {"operation:connect", 3}, {"shape", 4}},
	} {
		if got := plannerHintText(order); got != want {
			t.Errorf("%v:\n%q\nwant\n%q", order, got, want)
		}
	}
	// Eight come back: the six most frequent are named; of two equal counts, the earlier in the list.
	got := plannerHintText([]plannerReason{{"operation:disconnect", 2}, {"operation:add_node", 9}, {"summary", 4}, {"references", 4},
		{"shape", 5}, {"not_json", 7}, {"operation:set_model", 3}, {"operation:connect", 3}})
	named := []string{}
	for _, line := range strings.Split(got, "\n- ")[1:] {
		for reason, sentence := range plannerHints {
			if line == sentence {
				named = append(named, reason)
			}
		}
	}
	if want := []string{"not_json", "shape", "summary", "references", "operation:add_node", "operation:set_model"}; !slices.Equal(named, want) {
		t.Fatalf("named %v, want %v", named, want)
	}
}

// A plan the gate refuses records why, in one word and with the model that planned it, never a word of the plan; once
// a reason comes back often enough, later planners are told of it. A record that cannot be written leaves the
// refusal as it was, and instructions that cannot be read are the ones read last.
func TestPostgresARefusedPlansReasonIsNamedToLaterPlanners(t *testing.T) {
	var mu sync.Mutex
	var systems []string
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var call observedPiCall
		if e := json.NewDecoder(r.Body).Decode(&call); e != nil {
			t.Error(e)
		}
		mu.Lock()
		systems = append(systems, call.SystemPrompt)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		completePi(w, `{"version":1,"summary":"Report","operations":[{"type":"add_node","ref":"r","templateId":"general","title":"Report","color":"secret-plan-word"}]}`)
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	type workspace struct {
		cookie    *http.Cookie
		tid, path string
	}
	join := func(email string) workspace {
		c, tid, _ := h.register(t, email)
		cv := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Empty", "document": map[string]any{"nodes": []any{}}}, 201)
		return workspace{c, tid, "/tenants/" + tid + "/canvases/" + cv["id"].(string) + "/plan"}
	}
	first, second := join("planner-lessons@example.test"), join("planner-lessons-2@example.test")
	refuse := func(w workspace, op string) {
		t.Helper()
		v := h.request(t, w.cookie, "POST", w.path, map[string]string{"prompt": "Write the report", "context": "{}", "operationId": "planner-lessons-" + op}, 202)
		if v = h.awaitRun(t, w.cookie, w.tid, v["id"].(string), "failed"); v["error"] != "invalid_canvas_plan" {
			t.Fatalf("%s: %v", op, v["error"])
		}
	}
	forget := func() {
		h.a.plannerHints.mu.Lock()
		h.a.plannerHints.at = time.Time{}
		h.a.plannerHints.mu.Unlock()
	}
	ctx := context.Background()
	for i := range plannerHintMinimum {
		refuse(first, "first-"+string(rune('a'+i)))
	}
	var rows, matching int
	if e := h.db.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE tenant_id=$1 AND reason='operation:add_node' AND model=(SELECT execution_snapshot->>'model' FROM runs
		WHERE error='invalid_canvas_plan' LIMIT 1)) FROM planner_refusals`, first.tid).Scan(&rows, &matching); e != nil || rows != plannerHintMinimum || matching != rows {
		t.Fatalf("refusals %d, %d recorded as the gate refused them: %v", rows, matching, e)
	}
	var leaked bool
	if e := h.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM planner_refusals p WHERE row_to_json(p)::text LIKE '%secret-plan-word%')`).Scan(&leaked); e != nil || leaked {
		t.Fatalf("a refusal kept the plan's text: %v", e)
	}
	// One workspace's mistakes, however often, are not named to every planner.
	forget()
	refuse(first, "one-workspace")
	// Read within plannerHintRefresh, the instructions stay as they were; read again once a second workspace's plan
	// was refused the same way, they name the mistake, to every workspace.
	refuse(second, "cached")
	forget()
	refuse(second, "warned")
	mu.Lock()
	seen := append([]string{}, systems...)
	mu.Unlock()
	if len(seen) != plannerHintMinimum+3 {
		t.Fatalf("%d planner calls", len(seen))
	}
	for i, system := range seen {
		warned := strings.Contains(system, plannerHintHeading+"\n- "+plannerHints["operation:add_node"])
		if warned != (i == len(seen)-1) || !strings.HasPrefix(system, plannerInstructions) {
			t.Errorf("call %d: warned %v", i, warned)
		}
	}
	// A workspace deleted takes its refusals with it (one holding nothing else, so its row can go).
	for _, statement := range []string{"INSERT INTO tenants(id,name) VALUES('bare','Bare')", "INSERT INTO planner_refusals(tenant_id,reason) VALUES('bare','shape')",
		"DELETE FROM tenants WHERE id='bare'"} {
		if _, e := h.db.Exec(ctx, statement); e != nil {
			t.Fatal(statement, e)
		}
	}
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM planner_refusals WHERE tenant_id='bare'").Scan(&rows); e != nil || rows != 0 {
		t.Fatalf("%d refusals outlived their workspace: %v", rows, e)
	}
	// Without the table, a refused plan is refused as before, and planners keep the warnings read last.
	if _, e := h.db.Exec(ctx, "DROP TABLE planner_refusals"); e != nil {
		t.Fatal(e)
	}
	forget()
	refuse(first, "unrecorded")
	mu.Lock()
	last := systems[len(systems)-1]
	mu.Unlock()
	if !strings.Contains(last, plannerHints["operation:add_node"]) {
		t.Fatal("the warnings read last were dropped")
	}
}
