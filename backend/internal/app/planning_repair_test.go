package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Eight canvas plans of 2026-10-09/10 ended as invalid_canvas_plan for slips with one safe reading. Replayed from
// production, all eight pass acceptPlan; these cases stand for them without the users' content.

func decodeCanvasPlan(t *testing.T, plan string) map[string]any {
	t.Helper()
	var p map[string]any
	if e := json.Unmarshal([]byte(plan), &p); e != nil {
		t.Fatalf("accepted plan is not JSON: %v\n%s", e, plan)
	}
	return p
}

func canvasPlanOps(t *testing.T, plan string) []map[string]any {
	t.Helper()
	ops := []map[string]any{}
	for _, item := range decodeCanvasPlan(t, plan)["operations"].([]any) {
		ops = append(ops, item.(map[string]any))
	}
	return ops
}

// Six of the eight: ASCII quotes used as quotation marks inside Chinese text, unescaped, by Haiku and Qwen alike.
func TestPlanGateRepairsUnescapedQuotesInsideStrings(t *testing.T) {
	answers := map[string]string{
		"summary, unfenced": `{"version":1,"summary":"已根据您的要求补充"新建"按钮和"导出"功能","operations":[]}`,
		"persona, fenced, note with quotes after the fence": "```json\n" + `{"version":1,"summary":"设计竞品分析","operations":[{"type":"add_node","ref":"analyst","templateId":"general","persona":"在报告最后单独列出"待确认项"。"}]}` + "\n```\n\n上传资料后点\"运行\"即可。需要继续细化吗？",
		"value with a comma after the inner quote":          `{"version":1,"summary":"脱敏","operations":[{"type":"set_input","nodeId":"n","fieldId":"rules","value":"港名统一为"某某港",公司名统一为"某某公司""}]}`,
		"adjacent quoted phrases and a raw line break":      "{\"version\":1,\"summary\":\"返修\",\"operations\":[{\"type\":\"set_input\",\"nodeId\":\"n\",\"fieldId\":\"criteria\",\"value\":\"- 具体问题（如\"构图过空\"\"颜色偏冷\"）\n- 修改建议\"}]}",
	}
	for name, answer := range answers {
		plan, ok := acceptPlan(answer)
		if !ok {
			t.Errorf("%s: refused", name)
			continue
		}
		p := decodeCanvasPlan(t, plan)
		if name == "summary, unfenced" && p["summary"] != `已根据您的要求补充"新建"按钮和"导出"功能` {
			t.Errorf("%s: summary text changed: %q", name, p["summary"])
		}
		if name == "value with a comma after the inner quote" {
			if v := canvasPlanOps(t, plan)[0]["value"]; v != `港名统一为"某某港",公司名统一为"某某公司"` {
				t.Errorf("%s: value text changed: %q", name, v)
			}
		}
		if name == "adjacent quoted phrases and a raw line break" {
			if v := canvasPlanOps(t, plan)[0]["value"]; v != "- 具体问题（如\"构图过空\"\"颜色偏冷\"）\n- 修改建议" {
				t.Errorf("%s: value text changed: %q", name, v)
			}
		}
	}
	// Valid JSON is never rewritten, and the repair adds no tolerance beyond the quotes (a note before the plan is read
	// since 2026-10-23: TestPlanGateReadsAPlanBehindANote).
	const plain = `{"version":1,"summary":"Plain \"quoted\" text","operations":[]}`
	if plan, ok := acceptPlan(plain); !ok || plan != plain {
		t.Fatalf("valid plan changed: %q %v", plan, ok)
	}
	for name, answer := range map[string]string{
		"unfenced plan with a note":  `{"version":1,"summary":"补充"新建"按钮","operations":[]}` + "\n\nNote: review it.",
		"unknown operation repaired": `{"version":1,"summary":"补充"新建"","operations":[{"type":"exec","command":"whoami"}]}`,
		"truncated":                  `{"version":1,"summary":"补充"新建"按钮","operations":[`,
	} {
		if plan, ok := acceptPlan(answer); ok {
			t.Errorf("%s: accepted as %s", name, plan)
		}
	}
}

func TestPlanGateNormalizesNewFieldValuesAndReservedIDs(t *testing.T) {
	answer := `{"version":1,"summary":"Review","operations":[` +
		`{"type":"add_node","ref":"review","templateId":"review"},` +
		`{"type":"add_field","nodeId":"review","side":"input","field":{"id":"prototype","label":"HTML原型","type":"file","required":true,"value":""}},` +
		`{"type":"add_field","nodeId":"review","side":"input","field":{"id":"criteria","label":"验收标准","type":"markdown","required":true,"value":"- 流畅\n- 合理"}},` +
		`{"type":"add_field","nodeId":"review","side":"input","field":{"id":"brief","label":"Brief","type":"markdown","required":false,"help":"no value key"}},` +
		`{"type":"add_field","nodeId":"review","side":"output","field":{"id":"verdict","label":"Verdict","type":"boolean","required":true,"value":"true"}},` +
		`{"type":"add_node","ref":"constructor","templateId":"frontend"},` +
		`{"type":"connect","fromNode":"constructor","fromField":"delivery","toNode":"review","toField":"prototype"}]}`
	if validatePlan(answer) {
		t.Fatal("the strict gate itself must still refuse these slips")
	}
	plan, ok := acceptPlan(answer)
	if !ok {
		t.Fatal("plan refused")
	}
	ops := canvasPlanOps(t, plan)
	if len(ops) != 8 {
		t.Fatalf("want the 7 operations plus one set_input, got %d: %s", len(ops), plan)
	}
	field := func(i int) map[string]any { return ops[i]["field"].(map[string]any) }
	if field(1)["id"] != "prototype_field" || field(1)["value"] != "" {
		t.Errorf("reserved field id not renamed: %v", field(1))
	}
	if field(2)["value"] != "" || ops[3]["type"] != "set_input" || ops[3]["fieldId"] != "criteria" || ops[3]["value"] != "- 流畅\n- 合理" || ops[3]["nodeId"] != "review" {
		t.Errorf("filled input not moved into set_input: %v %v", field(2), ops[3])
	}
	if field(4)["value"] != "" {
		t.Errorf("missing value not set empty: %v", field(4))
	}
	if field(5)["value"] != "" || ops[6]["type"] != "add_node" {
		t.Errorf("an output value must be dropped, never filled: %v %v", field(5), ops[6])
	}
	if ops[6]["ref"] != "constructor_node" || ops[7]["fromNode"] != "constructor_node" || ops[7]["toField"] != "prototype_field" {
		t.Errorf("reserved names not renamed consistently: %v %v", ops[6], ops[7])
	}
	// A reserved id of an existing node is not this plan's to rename: refused as before.
	if _, ok := acceptPlan(`{"version":1,"summary":"X","operations":[{"type":"remove_node","nodeId":"__proto__"}]}`); ok {
		t.Fatal("reserved existing node id accepted")
	}
}

// 15 of the 31 Qwen plans refused in the 7 days to 2026-10-23 put a note of plain text before the plan, and none of the
// 16 plans behind a note in those days had a brace or a bracket in its note. A note without either is read: the plan
// begins a line at the answer's first brace, its quotes repaired as an answer's own are, and only nothing but white
// space or a closing fence may follow it. Any other answer is still refused, wherever a second plan, a truncated one, a
// list or an object of the note's own is.
func TestPlanGateReadsAPlanBehindANote(t *testing.T) {
	const plan = `{"version":1,"summary":"补充按钮","operations":[{"type":"add_node","ref":"ui","templateId":"frontend","title":"界面"}]}`
	const other = `{"version":1,"summary":"删除","operations":[{"type":"remove_node","nodeId":"existing"}]}`
	var pretty bytes.Buffer
	if e := json.Indent(&pretty, []byte(plan), "", "  "); e != nil {
		t.Fatal(e)
	}
	for name, answer := range map[string]string{
		"a note, then the plan":                     "好的，下面是规划：\n" + plan,
		"a note, then a fenced plan":                "Here is the plan:\n```json\n" + plan + "\n```",
		"a note, then an indented plan":             "Here is the plan:\n    " + plan,
		"a note, then a pretty-printed plan":        "Here is the plan:\n" + pretty.String(),
		"a note, then a pretty-printed fenced plan": "Here is the plan:\n```json\n" + pretty.String() + "\n```\n",
		"a note that quotes the key, then the plan": "Put the steps in \"operations\":\n" + plan,
	} {
		if got, ok := acceptPlan(answer); !ok || got != plan {
			t.Errorf("%s: read as %q (%v)", name, got, ok)
		}
	}
	if got, ok := acceptPlan("Here is the plan:\n```json\n" + `{"version":1,"summary":"补充"新建"","operations":[]}` + "\n```"); !ok ||
		decodeCanvasPlan(t, got)["summary"] != `补充"新建"` {
		t.Errorf("quotes behind a note: read as %q (%v)", got, ok)
	}
	truncatedAround := `{"version":1,"summary":"补充","operations":[{"type":"add_node","ref":"ui","templateId":"frontend","persona":"示例：` + "\n" + other + "\n"
	// A plan whose key is spelt with a JSON escape for one of its letters (a backslash, then u and four digits).
	escaped := func(letters string) string { return strings.Replace(plan, `"operations"`, `"`+letters+`"`, 1) }
	bs := string(rune(92))
	for name, answer := range map[string]string{
		"a note with a brace, then the plan":              "The node reads {brief} from the request; the plan:\n\n" + plan + "\n",
		"a note with an object of its own, then the plan": "The settings stay:\n{\"theme\":\"dark\"}\nThe plan:\n" + plan,
		"a note with a list of its own, then the plan":    "The order:\n[\"brief\", \"draft\"]\nThe plan:\n" + plan,
		"objects of the note's own, then the plan":        strings.Repeat("{\"step\":1}\n", 3) + plan,
		"the plan at the end of the note's line":          "Here: " + plan,
		"a truncated object in the note's line, a plan":   "Note: {\"version\":1,\"summary\":\"first\",\n" + other,
		"one with a middle letter escaped, a second":      escaped("op"+bs+"u0065rations") + "\n" + other,
		"one with its last letter escaped in the line":    "Use " + escaped("operation"+bs+"u0073") + " or:\n" + other,
		"a note after the plan":                           "Here:\n" + plan + "\nRun it when ready.",
		"two plans after a note":                          "First:\n" + plan + "\nOr:\n" + other,
		"two plans, the first at the start":               plan + "\nOr:\n" + other,
		"two bare plans":                                  plan + "\n" + other,
		"a truncated plan":                                "Here:\n" + plan[:len(plan)-10],
		"a plan inside a truncated one":                   "Here:\n" + truncatedAround,
		"a plan inside the note's line":                   "Use " + plan + " as the plan.",
		"an object without operations":                    "Here:\n" + `{"version":1,"summary":"x"}`,
		"an indented plan, then a second":                 "Note:\n  " + plan + "\n" + other,
		"a plan inside an indented one":                   "Here:\n  " + truncatedAround,
		"a plan inside a list":                            "Here:\n[\n" + plan + "\n]",
		"a plan inside a truncated list":                  "Here:\n[1,\n" + plan,
		"a plan inside an indented list":                  "Here:\n  [1,\n" + plan,
		"a bracket line that is no list":                  "[Draft]\n" + plan,
		// A plan that does not begin a line is not read, and a second plan after it is not taken for the answer.
		"one in the note's line, then a second":       "Use " + plan + " or:\n" + other,
		"one after a lone carriage return, a second":  "Note:\r" + plan + "\n" + other,
		"one after an ideographic space, a second":    "Note:\n\u3000" + plan + "\n" + other,
		"one after a no-break space, a second":        "Note:\n\u00a0" + plan + "\n" + other,
		"one after a byte-order mark, a second":       "\ufeff" + plan + "\n" + other,
		"one in a list, then a second":                "Here:\n[\n" + plan + "\n]\n" + other,
		"one with its key's letter escaped, a second": "Note:\n\u3000" + strings.Replace(plan, `"operations"`, `"\u006fperations"`, 1) + "\n" + other,
	} {
		if got, ok := acceptPlan(answer); ok {
			t.Errorf("%s: accepted as %s", name, got)
		}
	}
}

// 8 of the 40 plans of Claude Haiku 4.5 refused in the 7 days to 2026-10-23 gave a new node its inputs on add_node as
// "inputs": its values are read as its inputValues, its field definitions as add_field steps right after it; a
// field's side in the plural (1 plan, which wrote both) and an input field typed as a picture (1) are fixed too. A
// new node's constraints are add_node's own since 2026-10-23 (27 of the 40), and left as given.
func TestPlanGateReadsNewNodeInputsAndFieldSlips(t *testing.T) {
	answer := "```json\n" + `{"version":1,"summary":"Report","operations":[` +
		`{"type":"add_node","ref":"writer","templateId":"general","title":"Writer","constraints":["At most 2,000 words"],"acceptanceCriteria":["Has 3 sections"],"inputs":{"brief":"Write the report"}},` +
		`{"type":"add_node","ref":"reader","templateId":"review","inputs":[{"id":"brief","value":"Check it"},{"id":"rubric","label":"Rubric","type":"markdown","required":true,"value":"- clear"}]},` +
		`{"type":"remove_field","nodeId":"old","side":"inputs","fieldId":"x"},` +
		`{"type":"add_field","nodeId":"reader","side":"inputs","field":{"id":"shot","label":"Shot","type":"image","required":false,"value":""}},` +
		`{"type":"connect","fromNode":"writer","fromField":"delivery","toNode":"reader","toField":"rubric"}]}` + "\n```"
	if validatePlan(answer) {
		t.Fatal("the strict gate itself must still refuse these slips")
	}
	plan, ok := acceptPlan(answer)
	if !ok {
		t.Fatal("plan refused")
	}
	ops := canvasPlanOps(t, plan)
	types := []string{}
	for _, op := range ops {
		types = append(types, op["type"].(string))
	}
	if got := strings.Join(types, " "); got != "add_node add_node add_field set_input remove_field add_field connect" {
		t.Fatalf("steps: %s\n%s", got, plan)
	}
	writer := ops[0]
	if writer["constraints"].([]any)[0] != "At most 2,000 words" || writer["inputValues"].(map[string]any)["brief"] != "Write the report" ||
		len(writer["acceptanceCriteria"].([]any)) != 1 || writer["inputs"] != nil {
		t.Errorf("the writer's add_node: %v", writer)
	}
	reader, rubric, filled := ops[1], ops[2], ops[3]
	if reader["inputValues"].(map[string]any)["brief"] != "Check it" || reader["inputs"] != nil {
		t.Errorf("the reader's add_node: %v", reader)
	}
	if f := rubric["field"].(map[string]any); rubric["nodeId"] != "reader" || rubric["side"] != "input" || f["id"] != "rubric" || f["value"] != "" ||
		filled["fieldId"] != "rubric" || filled["value"] != "- clear" {
		t.Errorf("the rubric field and its value: %v %v", rubric, filled)
	}
	if ops[4]["side"] != "input" || ops[5]["side"] != "input" || ops[5]["field"].(map[string]any)["type"] != "file" {
		t.Errorf("sides and the picture field: %v %v", ops[4], ops[5])
	}
	// What has no one reading is left as it is, and the plan refused as before.
	for name, op := range map[string]string{
		"inputs beside inputValues":           `{"type":"add_node","ref":"a","templateId":"general","inputs":{"brief":"x"},"inputValues":{"brief":"y"}}`,
		"inputs as a list of text":            `{"type":"add_node","ref":"a","templateId":"general","inputs":["brief"]}`,
		"a field definition without required": `{"type":"add_node","ref":"a","templateId":"general","inputs":[{"id":"f","label":"F","type":"text","value":""}]}`,
		"a definition's value not text":       `{"type":"add_node","ref":"a","templateId":"general","inputs":[{"id":"n","label":"N","type":"number","required":true,"value":12}]}`,
		"a field id given twice":              `{"type":"add_node","ref":"a","templateId":"general","inputs":[{"id":"f","value":"1"},{"id":"f","value":"2"}]}`,
		"a model on add_node":                 `{"type":"add_node","ref":"a","templateId":"general","model":"Claude Opus 5.5"}`,
		"an effort on add_node":               `{"type":"add_node","ref":"a","templateId":"general","effort":"high"}`,
		"constraints that are not a list":     `{"type":"add_node","ref":"a","templateId":"general","constraints":"Be brief"}`,
		"an output typed as a picture":        `{"type":"add_field","nodeId":"n","side":"output","field":{"id":"p","label":"P","type":"image","required":false,"value":""}}`,
		"a side of neither kind":              `{"type":"remove_field","nodeId":"n","side":"middle","fieldId":"f"}`,
	} {
		if got, ok := acceptPlan(`{"version":1,"summary":"S","operations":[` + op + `]}`); ok {
			t.Errorf("%s: accepted as %s", name, got)
		}
	}
	// A reserved ref is renamed in the steps made for it too.
	plan, ok = acceptPlan(`{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"constructor","templateId":"general","inputs":[{"id":"x","label":"X","type":"text","required":false}]}]}`)
	if ops = canvasPlanOps(t, plan); !ok || ops[0]["ref"] != "constructor_node" || ops[1]["nodeId"] != "constructor_node" {
		t.Errorf("a reserved ref: %v %v", ok, plan)
	}
}

// The canvas's planning protocol (canvasPlan.ts CANVAS_PLAN_PROTOCOL) offers feedback edges and the review loop, and
// its parser takes them; the gate refused every plan that used one. The gate's operations are pinned to the canvas's.
func TestPlanGateOperationsMatchTheCanvas(t *testing.T) {
	source, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "canvasPlan.ts"))
	if e != nil {
		t.Fatal(e)
	}
	m := regexp.MustCompile(`const OPERATION_TYPES = \[([^\]]*)\]`).FindSubmatch(source)
	if m == nil {
		t.Fatal("OPERATION_TYPES not found in canvasPlan.ts")
	}
	samples := map[string]string{
		"add_node":      `{"type":"add_node","ref":"a","templateId":"general"}`,
		"update_node":   `{"type":"update_node","nodeId":"n","title":"T"}`,
		"set_task":      `{"type":"set_task","nodeId":"n","acceptanceCriteria":["Opens in one file"]}`,
		"set_model":     `{"type":"set_model","nodeId":"n","model":"bedrock.claude-opus-5-5","effort":"high"}`,
		"set_team":      `{"type":"set_team","nodeId":"n","template":"draft-review"}`,
		"set_input":     `{"type":"set_input","nodeId":"n","fieldId":"f","value":"v"}`,
		"add_field":     `{"type":"add_field","nodeId":"n","side":"input","field":{"id":"f","label":"F","type":"text","required":false,"value":""}}`,
		"update_field":  `{"type":"update_field","nodeId":"n","side":"input","fieldId":"f","changes":{"label":"F"}}`,
		"remove_field":  `{"type":"remove_field","nodeId":"n","side":"input","fieldId":"f"}`,
		"remove_node":   `{"type":"remove_node","nodeId":"n"}`,
		"connect":       `{"type":"connect","fromNode":"a","fromField":"out","toNode":"b","toField":"in","kind":"feedback"}`,
		"set_edge_kind": `{"type":"set_edge_kind","edgeId":"e1","kind":"data"}`,
		"set_execution": `{"type":"set_execution","mode":"review","maxRounds":3,"reviewerNodeId":"r","verdictFieldId":"approved"}`,
		"disconnect":    `{"type":"disconnect","edgeId":"e1"}`,
	}
	canvas := regexp.MustCompile(`'([a-z_]+)'`).FindAllSubmatch(m[1], -1)
	if len(canvas) != len(samples) {
		t.Fatalf("canvas has %d operation types, the gate test covers %d", len(canvas), len(samples))
	}
	for _, q := range canvas {
		sample, ok := samples[string(q[1])]
		if !ok {
			t.Fatalf("canvas operation %s has no gate case", q[1])
		}
		if !validatePlan(`{"version":1,"summary":"S","operations":[` + sample + `]}`) {
			t.Errorf("canvas operation %s refused by the gate", q[1])
		}
	}
	if !validatePlan(`{"version":1,"summary":"S","operations":[{"type":"set_execution","mode":"workflow"}]}`) {
		t.Error("workflow mode refused")
	}
	for _, op := range []string{
		`{"type":"connect","fromNode":"a","fromField":"out","toNode":"b","toField":"in","kind":"loop"}`,
		`{"type":"set_edge_kind","edgeId":"e1","kind":"loop"}`,
		`{"type":"set_execution","mode":"review","maxRounds":6,"reviewerNodeId":"r","verdictFieldId":"v"}`,
		`{"type":"set_execution","mode":"review","maxRounds":2.5,"reviewerNodeId":"r","verdictFieldId":"v"}`,
		`{"type":"set_execution","mode":"review","maxRounds":2,"reviewerNodeId":"r"}`,
		`{"type":"set_execution","mode":"workflow","maxRounds":2}`,
		`{"type":"set_execution","mode":"parallel"}`,
	} {
		if validatePlan(`{"version":1,"summary":"S","operations":[` + op + `]}`) {
			t.Errorf("invalid operation accepted: %s", op)
		}
	}
	if !strings.Contains(plannerInstructions, "set_execution") || !strings.Contains(plannerInstructions, "set_edge_kind") {
		t.Error("planner instructions do not list the canvas's operations")
	}
}
