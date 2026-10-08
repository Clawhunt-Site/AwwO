package app

import (
	"strings"
	"testing"
)

// Claude Haiku 4.5 answers the canvas planner with a ```json block and then a note after the closing fence
// (2026-10-08, production shadow check). The gate used to try the block and the note as one JSON text, so every such
// plan ended as invalid_canvas_plan. The note is dropped; everything the gate refused before is still refused.
func TestPlanGateDropsANoteAfterTheClosingFence(t *testing.T) {
	const plan = `{"version":1,"summary":"Create","operations":[{"type":"add_node","ref":"api","templateId":"backend","persona":"Reply with a ` + "```" + `go block."}]}`
	accepted := map[string]string{
		"note after the fence":          "```json\n" + plan + "\n```\n\n说明：如需调整节点，请告诉我。",
		"bare fence and a note":         "```\n" + plan + "\n```\nNote: review the API node first.",
		"note and a second block":       "```json\n" + plan + "\n```\nExample:\n```json\n{\"other\":true}\n```",
		"closing fence right after":     "```json\n" + plan + "```trailing",
		"fenced, no note (unchanged)":   "```json\n" + plan + "\n```",
		"unclosed fence (unchanged)":    "```json\n" + plan,
		"plain JSON (unchanged)":        plan,
		"surrounding space (unchanged)": "\n  " + plan + "\n",
	}
	for name, answer := range accepted {
		if !validatePlan(answer) {
			t.Errorf("%s: plan refused", name)
			continue
		}
		if got := normalizePlanJSON(answer); got != plan {
			t.Errorf("%s: normalized to %q, want the plan alone", name, got)
		}
	}
	refused := map[string]string{
		"text inside the block after the plan": "```json\n" + plan + "\nAnd one more thing.\n```",
		"two values inside the block":          "```json\n" + plan + "\n" + plan + "\n```",
		"unfenced plan with a note":            plan + "\n\nNote: review it.",
		"truncated plan in a block":            "```json\n" + plan[:len(plan)-3] + "\n```\nNote.",
		"note before the block":                "Here is the plan:\n```json\n" + plan + "\n```",
		"schema still enforced":                "```json\n" + strings.Replace(plan, `"version":1`, `"version":2`, 1) + "\n```\nNote.",
	}
	for name, answer := range refused {
		if validatePlan(answer) {
			t.Errorf("%s: plan accepted", name)
		}
	}
}
