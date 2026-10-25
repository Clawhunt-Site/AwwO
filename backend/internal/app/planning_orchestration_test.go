package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// A plan the canvas assistant writes for a reader who only talks to it sets what developer mode used to set by hand
// (owner request 2026-10-15): a node's task requirements and its model. The gate admits those operations within the
// task frame's own limits and refuses anything else about them.
func planWith(t *testing.T, operations ...map[string]any) string {
	t.Helper()
	raw, e := json.Marshal(map[string]any{"version": 1, "summary": "Adjust", "operations": operations})
	if e != nil {
		t.Fatal(e)
	}
	return string(raw)
}

func TestPlanGateAdmitsTaskRequirementsAndModels(t *testing.T) {
	long := strings.Repeat("界", taskFrameMaxEntryRunes)
	half := strings.Repeat("b", taskFrameMaxEntryRunes)
	overTotal := []any{half, half, half, half, half, half, "c"} // 12,001 runes in all
	for name, op := range map[string]map[string]any{
		"acceptance only":      {"type": "set_task", "nodeId": "n", "acceptanceCriteria": []any{"The page opens", "Every button works"}},
		"constraints only":     {"type": "set_task", "nodeId": "n", "constraints": []any{"@R1", "Write only the layout data"}},
		"both, emptied":        {"type": "set_task", "nodeId": "n", "constraints": []any{}, "acceptanceCriteria": []any{}},
		"longest entry":        {"type": "set_task", "nodeId": "n", "acceptanceCriteria": []any{long}},
		"model":                {"type": "set_model", "nodeId": "n", "model": "bedrock.claude-opus-5-5"},
		"model with effort":    {"type": "set_model", "nodeId": "n", "model": "Claude Opus 5.5", "effort": "high"},
		"model, empty effort":  {"type": "set_model", "nodeId": "n", "model": "default", "effort": ""},
		"new node with checks": {"type": "add_node", "ref": "page", "templateId": "frontend", "acceptanceCriteria": []any{"One complete HTML document"}},
		// Since 2026-10-23 a new node takes constraints too, after the user's request the canvas gives it first.
		"new node with constraints": {"type": "add_node", "ref": "page", "templateId": "frontend", "constraints": []any{"@R1", "At most 2,000 words"}},
		// Over the task frame's 12,000 in all: the canvas leaves the step out with a note, the rest of the plan applies.
		"over the total":        {"type": "set_task", "nodeId": "n", "constraints": overTotal},
		"over the total in two": {"type": "set_task", "nodeId": "n", "constraints": overTotal[:3], "acceptanceCriteria": overTotal[3:]},
	} {
		if !validatePlan(planWith(t, op)) {
			t.Errorf("%s: refused %v", name, op)
		}
	}
}

func TestPlanGateRefusesMalformedTaskRequirementsAndModels(t *testing.T) {
	many := make([]any, taskFrameMaxEntries+1)
	for i := range many {
		many[i] = "check"
	}
	tooLong := strings.Repeat("a", taskFrameMaxEntryRunes+1)
	for name, op := range map[string]map[string]any{
		"no list":                        {"type": "set_task", "nodeId": "n"},
		"not a list":                     {"type": "set_task", "nodeId": "n", "constraints": "one"},
		"not strings":                    {"type": "set_task", "nodeId": "n", "acceptanceCriteria": []any{1}},
		"null entry":                     {"type": "set_task", "nodeId": "n", "acceptanceCriteria": []any{nil}},
		"too many":                       {"type": "set_task", "nodeId": "n", "acceptanceCriteria": many},
		"entry too long":                 {"type": "set_task", "nodeId": "n", "constraints": []any{tooLong}},
		"unknown key":                    {"type": "set_task", "nodeId": "n", "constraints": []any{}, "runtime": "pi"},
		"bad node":                       {"type": "set_task", "nodeId": "has space", "constraints": []any{}},
		"no model":                       {"type": "set_model", "nodeId": "n"},
		"empty model":                    {"type": "set_model", "nodeId": "n", "model": " "},
		"model too long":                 {"type": "set_model", "nodeId": "n", "model": strings.Repeat("m", 201)},
		"runtime named":                  {"type": "set_model", "nodeId": "n", "model": "qwen", "runtime": "pi"},
		"effort not a level":             {"type": "set_model", "nodeId": "n", "model": "qwen", "effort": "HIGH"},
		"effort not text":                {"type": "set_model", "nodeId": "n", "model": "qwen", "effort": 3},
		"new node checks malformed":      {"type": "add_node", "ref": "page", "templateId": "frontend", "acceptanceCriteria": "one"},
		"new node constraints malformed": {"type": "add_node", "ref": "page", "templateId": "frontend", "constraints": "x"},
		"new node constraints too many":  {"type": "add_node", "ref": "page", "templateId": "frontend", "constraints": many},
	} {
		if validatePlan(planWith(t, op)) {
			t.Errorf("%s: admitted %v", name, op)
		}
	}
}

// Progress names the same operations as the canvas (TestPlanGateOperationsMatchTheCanvas pins the gate): an operation
// it does not know is never named while the plan is written. The review-loop operations are the canvas's local-app
// ones, which progress leaves out on purpose.
func TestPlanProgressOperationsMatchTheCanvas(t *testing.T) {
	source, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "canvasPlan.ts"))
	if e != nil {
		t.Fatal(e)
	}
	m := regexp.MustCompile(`const OPERATION_TYPES = \[([^\]]*)\]`).FindSubmatch(source)
	if m == nil {
		t.Fatal("OPERATION_TYPES not found in canvasPlan.ts")
	}
	canvas := []string{}
	for _, q := range regexp.MustCompile(`'([a-z_]+)'`).FindAllSubmatch(m[1], -1) {
		if name := string(q[1]); name != "set_edge_kind" && name != "set_execution" {
			canvas = append(canvas, name)
		}
	}
	gate := slices.Clone(planOperationTypes)
	slices.Sort(canvas)
	slices.Sort(gate)
	if !slices.Equal(canvas, gate) {
		t.Fatalf("progress operations %v differ from the canvas's %v", gate, canvas)
	}
	for _, name := range []string{"set_task", "set_model", "set_team"} {
		if !slices.Contains(planNodeOperationTypes, name) {
			t.Errorf("%s concerns one node but progress cannot name it", name)
		}
		if !strings.Contains(plannerInstructions, name) {
			t.Errorf("the planner is not told it may propose %s", name)
		}
	}
}

// A hosted canvas's frontend node is the page itself (hostedPageOutputs in canvasPlan.ts, shown to the planner in its
// component templates); the planner is told to deliver a page that way rather than to rebuild a template's outputs.
func TestPlannerDeliversAPageWithOneFrontendNode(t *testing.T) {
	source, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "canvasPlan.ts"))
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(source), "HOSTED_PAGE_TEMPLATE_ID = 'frontend'") || !strings.Contains(string(source), "id: 'page'") {
		t.Fatal("canvasPlan.ts no longer makes a hosted frontend node one html page")
	}
	if !strings.Contains(plannerInstructions, "one frontend node") || !strings.Contains(plannerInstructions, "add no fields to it") {
		t.Fatal("the planner is not told to deliver a page with one frontend node")
	}
}
