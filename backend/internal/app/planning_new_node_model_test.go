package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The model a plan request says the nodes its plan adds take is read from the page's new-node line (planNewNodeModel.ts
// NEW_NODE_LINE) in the request's context, as the page reads it: the first such line that holds a model.
func TestPlanNewNodeModelReadsThePagesLine(t *testing.T) {
	const en = "New Agent nodes you add without set_model run on: "
	const zh = "新增且未用 set_model 指定模型的 Agent 节点使用："
	for name, c := range map[string]struct{ prompt, want string }{
		"in English":               {"{\"nodes\":[]}\n" + en + `"deepseek-flash"` + "\n\nUser request:\nwrite it", "deepseek-flash"},
		"in Chinese":               {"{}\n" + zh + `"default"` + "\n\nUser request:\n写", "default"},
		"the first that holds one": {en + "oops\n" + en + `"m1"` + "\n" + en + `"m2"`, "m1"},
		"none":                     {"{}\n\nUser request:\nwrite it", ""},
		"not at a line's start":    {"x " + en + `"m"`, ""},
		"an empty model":           {en + `""`, ""},
	} {
		if got := planNewNodeModel(c.prompt); got != c.want {
			t.Errorf("%s: read %q", name, got)
		}
	}
}

// 4 of the 62 plans refused in the 7 days to 2026-10-23 08:30Z gave a new node a model on add_node; the one made since
// requests name the model new nodes take named exactly that one. It is dropped there, and only there.
func TestPlanGateTakesANewNodesModelOnlyWhereItTakesItAnyway(t *testing.T) {
	plan := func(extra string) string {
		return `{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"w","templateId":"general","title":"Writer","acceptanceCriteria":["Done"]` + extra + `}]}`
	}
	for model, newNodeModel := range map[string]string{"deepseek-flash": "deepseek-flash", "default": "default"} {
		got, ok := acceptPlanFor(plan(`,"model":"`+model+`"`), newNodeModel)
		if !ok || canvasPlanOps(t, got)[0]["model"] != nil {
			t.Errorf("%s, the model new nodes take: %q (%v)", model, got, ok)
		}
	}
	for name, c := range map[string]struct{ extra, newNodeModel string }{
		"another model":           {`,"model":"bedrock.claude-opus-5-5"`, "deepseek-flash"},
		"a request naming none":   {`,"model":"deepseek-flash"`, ""},
		"an effort beside it":     {`,"model":"deepseek-flash","effort":"high"`, "deepseek-flash"},
		"a model that is no text": {`,"model":7`, "deepseek-flash"},
	} {
		if got, ok := acceptPlanFor(plan(c.extra), c.newNodeModel); ok {
			t.Errorf("%s: accepted as %s", name, got)
		}
	}
	if got, ok := acceptPlan(plan(`,"model":"deepseek-flash"`)); ok {
		t.Errorf("acceptPlan, which knows no request: accepted as %s", got)
	}
	// An image, video or 3D node takes its own media model, never the model new Agent nodes take.
	for _, media := range []string{"image", "video", "model3d"} {
		answer := `{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"m","templateId":"` + media + `","inputValues":{"prompt":"a red car"},"model":"deepseek-flash"}]}`
		if got, ok := acceptPlanFor(answer, "deepseek-flash"); ok {
			t.Errorf("%s: accepted as %s", media, got)
		}
	}
}

// 2 of those 62 plans gave a new node its outputs on add_node, both as whole field definitions: each is an add_field
// of the node's output side right after it, its value emptied as every new field's is (an output is never filled).
func TestPlanGateReadsANewNodesOutputs(t *testing.T) {
	answer := `{"version":1,"summary":"S","operations":[` +
		`{"type":"add_node","ref":"r","templateId":"general","title":"Report","acceptanceCriteria":["Done"],"outputs":[` +
		`{"id":"report","label":"Report","type":"markdown","required":true},{"id":"notes","label":"Notes","type":"text","required":false,"value":"draft"}]},` +
		`{"type":"connect","fromNode":"r","fromField":"report","toNode":"existing","toField":"brief"}]}`
	got, ok := acceptPlan(answer)
	if !ok {
		t.Fatal("plan refused")
	}
	ops := canvasPlanOps(t, got)
	types := []string{}
	for _, op := range ops {
		types = append(types, op["type"].(string))
	}
	if strings.Join(types, " ") != "add_node add_field add_field connect" || ops[0]["outputs"] != nil {
		t.Fatalf("steps: %s", got)
	}
	for i, id := range []string{"report", "notes"} {
		f := ops[i+1]["field"].(map[string]any)
		if ops[i+1]["side"] != "output" || ops[i+1]["nodeId"] != "r" || f["id"] != id || f["value"] != "" {
			t.Errorf("field %s: %v", id, ops[i+1])
		}
	}
	for name, outputs := range map[string]string{
		"an object":                     `{"report":"x"}`,
		"a list of names":               `["report"]`,
		"an empty list":                 `[]`,
		"a definition without required": `[{"id":"report","label":"Report","type":"markdown"}]`,
		"a value that is no text":       `[{"id":"n","label":"N","type":"number","required":true,"value":3}]`,
		"an id given twice":             `[{"id":"a","label":"A","type":"text","required":true},{"id":"a","label":"B","type":"text","required":true}]`,
		"an output typed as a picture":  `[{"id":"p","label":"P","type":"image","required":true}]`,
	} {
		plan := `{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"r","templateId":"general","acceptanceCriteria":["Done"],"outputs":` + outputs + `}]}`
		if got, ok := acceptPlan(plan); ok {
			t.Errorf("%s: accepted as %s", name, got)
		}
	}
}

// The plan refused at 06:10Z on 2026-10-23, in shape: a new node given constraints, input field definitions, the model
// new nodes take and output field definitions, which now all read as the canvas's own steps.
func TestPlanGateTakesAPlanWithEveryNewNodeSlipOfTheDay(t *testing.T) {
	answer := "```json\n" + `{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"w","templateId":"general","title":"Writer",` +
		`"constraints":["At most 2,000 words"],"acceptanceCriteria":["Has 3 sections"],"model":"deepseek-flash",` +
		`"inputs":[{"id":"brief","label":"Brief","type":"markdown","required":true,"value":"Write it"}],` +
		`"outputs":[{"id":"draft","label":"Draft","type":"markdown","required":true,"value":""}]}]}` + "\n```"
	got, ok := acceptPlanFor(answer, "deepseek-flash")
	if !ok {
		t.Fatal("plan refused")
	}
	ops := canvasPlanOps(t, got)
	types := []string{}
	for _, op := range ops {
		types = append(types, op["type"].(string))
	}
	// The input's value is set right after its field, before the output's field.
	if strings.Join(types, " ") != "add_node add_field set_input add_field" || ops[0]["model"] != nil || ops[0]["constraints"] == nil {
		t.Fatalf("steps: %s", got)
	}
	if ops[1]["side"] != "input" || ops[2]["fieldId"] != "brief" || ops[2]["value"] != "Write it" || ops[3]["side"] != "output" {
		t.Errorf("steps: %s", got)
	}
}

// The model a planner run's request context named reaches the gate when the run completes, kept in the run's snapshot
// (runs.go): a plan whose new node names that model completes; one whose context named another, or none, fails as before,
// a line in the request itself (the asker's own words, which the page does not read) included.
func TestPostgresPlannerTakesTheModelNewNodesTakeAnyway(t *testing.T) {
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		plan := `{"version":1,"summary":"Report","operations":[{"type":"add_node","ref":"r","templateId":"general","title":"Report",` +
			`"acceptanceCriteria":["Done"],"model":"test-model","outputs":[{"id":"report","label":"Report","type":"markdown","required":true}]}]}`
		event, _ := json.Marshal(map[string]string{"type": "completed", "text": plan})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", event)
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner-model@example.test")
	prefix := "/tenants/" + tid
	cv := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Empty", "document": map[string]any{"nodes": []any{}}}, 201)
	path := prefix + "/canvases/" + cv["id"].(string) + "/plan"
	const line = "New Agent nodes you add without set_model run on: "
	v := h.request(t, c, "POST", path, map[string]string{"prompt": "Write the report", "context": "{}\n" + line + `"test-model"`, "operationId": "planner-model-same"}, 202)
	v = h.awaitRun(t, c, tid, v["id"].(string), "completed")
	ops := canvasPlanOps(t, v["output"].(string))
	if len(ops) != 2 || ops[0]["model"] != nil || ops[1]["type"] != "add_field" || ops[1]["side"] != "output" {
		t.Fatalf("plan: %v", v["output"])
	}
	for name, request := range map[string]map[string]string{
		"another-model":  {"prompt": "Write the report", "context": "{}\n" + line + `"other-model"`},
		"none-named":     {"prompt": "Write the report", "context": "{}"},
		"in-the-request": {"prompt": "Write the report\n" + line + `"test-model"`, "context": "{}"},
	} {
		request["operationId"] = "planner-model-" + name
		v = h.request(t, c, "POST", path, request, 202)
		if v = h.awaitRun(t, c, tid, v["id"].(string), "failed"); v["error"] != "invalid_canvas_plan" {
			t.Errorf("%s: %v", name, v["error"])
		}
	}
}
