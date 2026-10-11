package app

import (
	"strings"
	"testing"
)

// A plan may add an image, video or 3D model node (2026-10-11): the gate admits the three media templates with
// their prompt as an input value, progress names the node while it is written, and any other template is still
// refused.
func TestPlansMayDeclareMediaNodes(t *testing.T) {
	for _, kind := range []string{"image", "video", "model3d"} {
		plan := `{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"asset","templateId":"` + kind +
			`","title":"Asset","inputValues":{"prompt":"a knight in silver armour"}},{"type":"set_input","nodeId":"asset","fieldId":"prompt","value":"again"}]}`
		if !validatePlan(plan) {
			t.Fatalf("%s: a media node plan was refused", kind)
		}
		if accepted, ok := acceptPlan("```json\n" + plan + "\n```"); !ok || accepted != plan {
			t.Fatalf("%s: accepted %v %q", kind, ok, accepted)
		}
		var p plannerProgress
		p.write(plan[:strings.Index(plan, `"title"`)])
		if p.operation != "add_node" || p.target != kind {
			t.Fatalf("%s: progress operation %q target %q", kind, p.operation, p.target)
		}
		p.write(plan[strings.Index(plan, `"title"`):])
		if p.operation != "set_input" || p.target != kind || p.template != kind {
			t.Fatalf("%s: progress after the plan: operation %q target %q template %q", kind, p.operation, p.target, p.template)
		}
	}
	if validatePlan(`{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"a","templateId":"audio"}]}`) {
		t.Fatal("an unknown template was accepted")
	}
	if !strings.Contains(plannerInstructions, "inputValues.prompt") || !strings.Contains(plannerInstructions, "model3d") {
		t.Fatal("the planner is not told how to add a media node")
	}
}

// Users see media models, never which service makes them (owner decision 2026-10-11).
func TestMediaModelNamesNeverNameTheirProvider(t *testing.T) {
	seen := 0
	for _, m := range builtinMediaCatalog.List() {
		if m.Provider != mediaProviderXtasy && m.Provider != mediaProviderTripo {
			continue
		}
		seen++
		if name := strings.ToLower(m.Name); strings.Contains(name, "xtasy") || strings.Contains(name, "x-tasy") || strings.Contains(name, "tripo") {
			t.Errorf("%s is shown as %q", m.ID, m.Name)
		}
	}
	if seen != len(xtasyModels())+len(tripoModels()) {
		t.Fatalf("checked %d models", seen)
	}
}
