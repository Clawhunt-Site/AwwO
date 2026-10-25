package app

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// A plan may give an Agent node a collaboration team (set_team): a template's, or members it writes by name, role and
// instructions. The gate admits what the canvas reads (canvasPlan.ts) and refuses anything else, a member's model,
// runtime or tools above all, which only the user chooses.
func teamMembers(names ...string) []any {
	members := make([]any, len(names))
	for i, name := range names {
		members[i] = map[string]any{"name": name, "role": "Contributor"}
	}
	return members
}

func TestPlanGateAdmitsTeams(t *testing.T) {
	eight := make([]string, 8)
	for i := range eight {
		eight[i] = "M" + string(rune('A'+i))
	}
	for name, op := range map[string]map[string]any{
		"template":           {"type": "set_team", "nodeId": "n", "template": "debate-verdict"},
		"every template":     {"type": "set_team", "nodeId": "n", "template": planTeamTemplateIDs[len(planTeamTemplateIDs)-1]},
		"review of two":      {"type": "set_team", "nodeId": "n", "mode": "review", "members": teamMembers("Writer", "Reviewer")},
		"rounds given":       {"type": "set_team", "nodeId": "n", "mode": "debate", "maxRounds": 8, "members": teamMembers("For", "Against", "Judge")},
		"eight in parallel":  {"type": "set_team", "nodeId": "n", "mode": "parallel", "members": teamMembers(eight...)},
		"one in sequence":    {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": teamMembers("Solo")},
		"instructions":       {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{map[string]any{"name": "A", "role": "r", "instructions": strings.Repeat("界", 16000)}}},
		"empty instructions": {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{map[string]any{"name": "A", "role": "r", "instructions": ""}}},
		// Counted in characters, as the canvas counts them: 128 emoji are 256 UTF-16 units and 512 bytes.
		"longest name": {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": teamMembers(strings.Repeat("😀", 128))},
		"longest role": {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{map[string]any{"name": "A", "role": strings.Repeat("r", 512)}}},
	} {
		if !validatePlan(planWith(t, op)) {
			t.Errorf("%s: refused %v", name, op)
		}
	}
}

func TestPlanGateRefusesMalformedTeams(t *testing.T) {
	nine := make([]string, 9)
	for i := range nine {
		nine[i] = "M" + string(rune('A'+i))
	}
	member := func(patch map[string]any) map[string]any {
		m := map[string]any{"name": "A", "role": "r"}
		for k, v := range patch {
			m[k] = v
		}
		return m
	}
	two := func(first map[string]any) []any { return []any{first, map[string]any{"name": "B", "role": "r"}} }
	for name, op := range map[string]map[string]any{
		"node template":       {"type": "set_team", "nodeId": "n", "template": "general"},
		"template id key":     {"type": "set_team", "nodeId": "n", "templateId": "draft-review"},
		"template and team":   {"type": "set_team", "nodeId": "n", "template": "draft-review", "mode": "review", "members": teamMembers("A", "B")},
		"model on the step":   {"type": "set_team", "nodeId": "n", "mode": "review", "members": teamMembers("A", "B"), "model": "default"},
		"model on a member":   {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"model": "default"}))},
		"runtime on a member": {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"runtime": "pi"}))},
		"tools on a member":   {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"tools": []any{"calculator"}}))},
		"effort on a member":  {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"effort": "high"}))},
		"no mode":             {"type": "set_team", "nodeId": "n", "members": teamMembers("A")},
		"unknown mode":        {"type": "set_team", "nodeId": "n", "mode": "swarm", "members": teamMembers("A")},
		"fractional rounds":   {"type": "set_team", "nodeId": "n", "mode": "review", "maxRounds": 1.5, "members": teamMembers("A", "B")},
		"no rounds":           {"type": "set_team", "nodeId": "n", "mode": "review", "maxRounds": 0, "members": teamMembers("A", "B")},
		"nine rounds":         {"type": "set_team", "nodeId": "n", "mode": "review", "maxRounds": 9, "members": teamMembers("A", "B")},
		"rounds as text":      {"type": "set_team", "nodeId": "n", "mode": "review", "maxRounds": "2", "members": teamMembers("A", "B")},
		"no members":          {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{}},
		"members not a list":  {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": "A"},
		"nine members":        {"type": "set_team", "nodeId": "n", "mode": "parallel", "members": teamMembers(nine...)},
		"review of one":       {"type": "set_team", "nodeId": "n", "mode": "review", "members": teamMembers("A")},
		"same name twice":     {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": teamMembers("A", " A ")},
		"blank name":          {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"name": " "}))},
		"blank role":          {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"role": " "}))},
		"no role":             {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{map[string]any{"name": "A"}}},
		"name too long":       {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"name": strings.Repeat("名", 129)}))},
		"role too long":       {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"role": strings.Repeat("r", 513)}))},
		"instructions long":   {"type": "set_team", "nodeId": "n", "mode": "review", "members": two(member(map[string]any{"instructions": strings.Repeat("i", 16001)}))},
		"member not object":   {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{"A"}},
		"bad node":            {"type": "set_team", "nodeId": "has space", "template": "draft-review"},
		"reserved key":        {"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{map[string]any{"name": "A", "role": "r", "constructor": "x"}}},
	} {
		if validatePlan(planWith(t, op)) {
			t.Errorf("%s: admitted %v", name, op)
		}
	}
}

// The gate trims a member's name and role as the canvas's JavaScript trim does (canvasPlan.ts), so the two never
// disagree on a name that is blank or repeated; canvas-node-team-plan.test.ts holds the same cases.
func TestPlanGateTrimsTeamNamesAsTheCanvasDoes(t *testing.T) {
	plan := func(names ...string) string {
		return planWith(t, map[string]any{"type": "set_team", "nodeId": "n", "mode": "sequential", "members": teamMembers(names...)})
	}
	for name, c := range map[string]struct {
		names []string
		admit bool
	}{
		"byte order mark repeats a name": {[]string{"A", "\uFEFFA"}, false},
		"ideographic space is blank":     {[]string{"\u3000"}, false},
		"line separator is blank":        {[]string{"\u2028"}, false},
		"next line is a character":       {[]string{"\u0085"}, true},
		"next line makes another name":   {[]string{"A", "\u0085A"}, true},
		"no-break spaces trim":           {[]string{"A", "\u00a0A\u00a0"}, false},
	} {
		if got := validatePlan(plan(c.names...)); got != c.admit {
			t.Errorf("%s: admitted %v, want %v", name, got, c.admit)
		}
	}
	if jsTrim("\uFEFF\u3000 A\u2029") != "A" || jsTrim("\u0085A") != "\u0085A" {
		t.Error("jsTrim differs from String.prototype.trim")
	}
}

// The execution judges a member's name and role as the plan gate and the canvas do, so a team a plan may give a node is
// a team the API runs: a name of U+0085 alone is a name everywhere, one of U+FEFF or U+3000 alone is blank everywhere.
func TestTeamValidationTrimsAsThePlanGateDoes(t *testing.T) {
	team := func(name, role string) *nodeTeam {
		return &nodeTeam{Version: 1, Mode: "sequential", Runtime: runtimePI, MaxRounds: 2, MaxTurns: 2, TimeoutSeconds: 300,
			Members: []teamMember{{ID: "m1", Name: name, Role: role, Context: "shared", Tools: []string{}}}}
	}
	for name, c := range map[string]struct {
		name, role string
		valid      bool
	}{
		"next line names a member":   {"\u0085", "r", true},
		"next line is a role":        {"A", "\u0085", true},
		"byte order mark is blank":   {"\uFEFF", "r", false},
		"ideographic space is blank": {"\u3000", "r", false},
		"blank role":                 {"A", "\u2028", false},
	} {
		if got := validateTeam(team(c.name, c.role)) == nil; got != c.valid {
			t.Errorf("%s: valid %v, want %v", name, got, c.valid)
		}
		gate := validatePlan(planWith(t, map[string]any{"type": "set_team", "nodeId": "n", "mode": "sequential", "members": []any{map[string]any{"name": c.name, "role": c.role}}}))
		if gate != c.valid {
			t.Errorf("%s: the gate admitted %v, the execution %v", name, gate, c.valid)
		}
	}
}

func TestPlanTeamTemplatesMatchTheCanvas(t *testing.T) {
	source, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "nodeTeamTemplates.ts"))
	if e != nil {
		t.Fatal(e)
	}
	m := regexp.MustCompile(`export const NODE_TEAM_TEMPLATE_IDS = \[([^\]]*)\]`).FindSubmatch(source)
	if m == nil {
		t.Fatal("NODE_TEAM_TEMPLATE_IDS not found in nodeTeamTemplates.ts")
	}
	canvas := []string{}
	for _, q := range regexp.MustCompile(`'([a-z][a-z-]*)'`).FindAllSubmatch(m[1], -1) {
		canvas = append(canvas, string(q[1]))
	}
	if !slices.Equal(canvas, planTeamTemplateIDs) {
		t.Fatalf("team templates %v differ from the canvas's %v", planTeamTemplateIDs, canvas)
	}
}
