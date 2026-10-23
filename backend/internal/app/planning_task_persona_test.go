package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func planStepTypes(ops []map[string]any) string {
	types := []string{}
	for _, op := range ops {
		types = append(types, op["type"].(string))
	}
	return strings.Join(types, " ")
}

// The one set_task with a key of its own among the 84 plans refused in the 14 days to 2026-10-23 (08:18Z, Claude Haiku
// 4.5), in shape: a 193-character persona beside its acceptance criteria, on an Agent node already on the canvas. The
// persona is the update_node that sets it, right before the set_task, which keeps its list; the other steps stay where
// they were.
func TestPlanGateReadsAPersonaGivenOnSetTask(t *testing.T) {
	persona := strings.Repeat("Brief. ", 27) + "Cite"
	if len(persona) != 193 {
		t.Fatalf("persona of %d characters", len(persona))
	}
	encoded, _ := json.Marshal(persona)
	answer := `{"version":1,"summary":"S","operations":[` +
		`{"type":"add_node","ref":"w","templateId":"general","title":"Writer","acceptanceCriteria":["Done"]},` +
		`{"type":"set_task","nodeId":"n1","persona":` + string(encoded) + `,"acceptanceCriteria":["Lists every source"]},` +
		`{"type":"connect","fromNode":"n1","fromField":"result","toNode":"w","toField":"brief"}]}`
	got, ok := acceptPlan(answer)
	if !ok {
		t.Fatal("plan refused")
	}
	ops := canvasPlanOps(t, got)
	if planStepTypes(ops) != "add_node update_node set_task connect" {
		t.Fatalf("steps: %s", got)
	}
	if ops[1]["nodeId"] != "n1" || ops[1]["persona"] != persona || len(ops[1]) != 3 {
		t.Errorf("update_node: %v", ops[1])
	}
	if ops[2]["nodeId"] != "n1" || ops[2]["persona"] != nil || ops[2]["acceptanceCriteria"].([]any)[0] != "Lists every source" {
		t.Errorf("set_task: %v", ops[2])
	}
}

// A set_task that gave the persona alone is that update_node only; on a node the same plan adds, by its ref, after it.
func TestPlanGateReadsAPersonaAloneAndOnANewNode(t *testing.T) {
	got, ok := acceptPlan(`{"version":1,"summary":"S","operations":[{"type":"set_task","nodeId":"n1","persona":"Review the draft"}]}`)
	if !ok {
		t.Fatal("persona alone: refused")
	}
	if ops := canvasPlanOps(t, got); planStepTypes(ops) != "update_node" || ops[0]["nodeId"] != "n1" || ops[0]["persona"] != "Review the draft" {
		t.Errorf("persona alone: %s", got)
	}
	got, ok = acceptPlan(`{"version":1,"summary":"S","operations":[` +
		`{"type":"add_node","ref":"r","templateId":"review","title":"Reviewer","acceptanceCriteria":["Done"]},` +
		`{"type":"set_task","nodeId":"r","persona":"Check every claim","constraints":["Quote the line"]}]}`)
	if !ok {
		t.Fatal("new node: refused")
	}
	ops := canvasPlanOps(t, got)
	if planStepTypes(ops) != "add_node update_node set_task" || ops[1]["nodeId"] != "r" || ops[2]["constraints"] == nil {
		t.Errorf("new node: %s", got)
	}
}

// Any other persona, and any other key of a set_task, is left, so the plan is refused as before: a blank persona could
// mean "clear it" or "nothing"; update_node keeps its own limit (8,000 characters).
func TestPlanGateRefusesEveryOtherPersonaOnSetTask(t *testing.T) {
	long, _ := json.Marshal(strings.Repeat("x", 8001))
	for name, step := range map[string]string{
		"an empty persona":          `{"type":"set_task","nodeId":"n1","persona":"","acceptanceCriteria":["Done"]}`,
		"a blank persona":           `{"type":"set_task","nodeId":"n1","persona":" \n ","acceptanceCriteria":["Done"]}`,
		"a persona that is a list":  `{"type":"set_task","nodeId":"n1","persona":["Brief"],"acceptanceCriteria":["Done"]}`,
		"a persona that is a map":   `{"type":"set_task","nodeId":"n1","persona":{"role":"Brief"}}`,
		"a persona that is a count": `{"type":"set_task","nodeId":"n1","persona":7}`,
		"a persona past the limit":  `{"type":"set_task","nodeId":"n1","persona":` + string(long) + `}`,
		"another key beside it":     `{"type":"set_task","nodeId":"n1","persona":"Brief","title":"Writer","acceptanceCriteria":["Done"]}`,
		// With no list, the set_task is left out once its persona is read: another key must not go with it.
		"another key, no list":   `{"type":"set_task","nodeId":"n1","persona":"Brief","title":"Writer"}`,
		"a runtime key, no list": `{"type":"set_task","nodeId":"n1","persona":"Brief","runtime":"pi"}`,
		"no node":                `{"type":"set_task","persona":"Brief","acceptanceCriteria":["Done"]}`,
		"a list that is no list": `{"type":"set_task","nodeId":"n1","persona":"Brief","constraints":"Quote the line"}`,
	} {
		answer := `{"version":1,"summary":"S","operations":[` + step + `]}`
		if got, ok := acceptPlan(answer); ok {
			t.Errorf("%s: accepted as %s", name, got)
		}
	}
}
