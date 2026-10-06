package app

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"
)

// The planner is told it may use every field type the canvas has. A type the gate refused turned the
// whole plan into invalid_canvas_plan (html, the type of a page deliverable, was refused until
// 2026-10-06), so the gate's list is pinned to the canvas's.
func TestPlanFieldTypesMatchTheCanvas(t *testing.T) {
	source, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "canvasPlan.ts"))
	if e != nil {
		t.Fatal(e)
	}
	m := regexp.MustCompile(`const FIELD_TYPES = \[([^\]]*)\]`).FindSubmatch(source)
	if m == nil {
		t.Fatal("FIELD_TYPES not found in canvasPlan.ts")
	}
	canvas := []string{}
	for _, q := range regexp.MustCompile(`'([a-z]+)'`).FindAllSubmatch(m[1], -1) {
		canvas = append(canvas, string(q[1]))
	}
	if !slices.Equal(canvas, planFieldTypes) {
		t.Fatalf("plan gate types %v differ from the canvas's %v", planFieldTypes, canvas)
	}
	add := func(typ string) string {
		return fmt.Sprintf(`{"version":1,"summary":"Add","operations":[{"type":"add_field","nodeId":"n","side":"output","field":{"id":"page","label":"Page","type":%q,"required":false,"value":""}}]}`, typ)
	}
	update := func(typ string) string {
		return fmt.Sprintf(`{"version":1,"summary":"Change","operations":[{"type":"update_field","nodeId":"n","side":"output","fieldId":"page","changes":{"type":%q}}]}`, typ)
	}
	for _, typ := range planFieldTypes {
		if !validatePlan(add(typ)) || !validatePlan(update(typ)) {
			t.Errorf("plan with a %s field refused", typ)
		}
	}
	if validatePlan(add("video")) || validatePlan(update("video")) {
		t.Fatal("plan with an unknown field type accepted")
	}
}
