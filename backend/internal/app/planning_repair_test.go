package app

import (
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
	// Valid JSON is never rewritten, and the repair adds no tolerance beyond the quotes.
	const plain = `{"version":1,"summary":"Plain \"quoted\" text","operations":[]}`
	if plan, ok := acceptPlan(plain); !ok || plan != plain {
		t.Fatalf("valid plan changed: %q %v", plan, ok)
	}
	for name, answer := range map[string]string{
		"unfenced plan with a note":  `{"version":1,"summary":"补充"新建"按钮","operations":[]}` + "\n\nNote: review it.",
		"note before the block":      "Here is the plan:\n```json\n" + `{"version":1,"summary":"补充"新建"","operations":[]}` + "\n```",
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
