package app

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
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

// The canvas holds a team's bounds, modes and the runtime of a node without one in nodeTeam.ts (NODE_TEAM_LIMITS,
// NODE_TEAM_MODES, DEFAULT_NODE_RUNTIME); the plan gate and the API's own team check must hold the same, at each bound.
func TestTeamBoundsMatchTheCanvas(t *testing.T) {
	source, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "nodeTeam.ts"))
	if e != nil {
		t.Fatal(e)
	}
	limits := map[string]int{}
	block := regexp.MustCompile(`export const NODE_TEAM_LIMITS = \{([^}]*)\}`).FindSubmatch(source)
	if block == nil {
		t.Fatal("NODE_TEAM_LIMITS not found in nodeTeam.ts")
	}
	for _, kv := range regexp.MustCompile(`(\w+): (\d+)`).FindAllSubmatch(block[1], -1) {
		n, _ := strconv.Atoi(string(kv[2]))
		limits[string(kv[1])] = n
	}
	for _, key := range []string{"members", "rounds", "calls", "minSeconds", "maxSeconds", "id", "name", "role", "instructions", "model"} {
		if _, ok := limits[key]; !ok {
			t.Fatalf("NODE_TEAM_LIMITS has no %s: %v", key, limits)
		}
	}
	modes := regexp.MustCompile(`export const NODE_TEAM_MODES[^=]*= \[([^\]]*)\]`).FindSubmatch(source)
	runtime := regexp.MustCompile(`export const DEFAULT_NODE_RUNTIME[^=]*= '([a-z-]+)'`).FindSubmatch(source)
	if modes == nil || runtime == nil {
		t.Fatal("NODE_TEAM_MODES or DEFAULT_NODE_RUNTIME not found in nodeTeam.ts")
	}
	if got := defaultRuntime(""); got != string(runtime[1]) {
		t.Errorf("the API runs a node without a runtime on %q, the canvas puts its team on %q", got, runtime[1])
	}

	text := func(n int) string { return strings.Repeat("界", n) }
	members := func(n int) []any {
		out := make([]any, n)
		for i := range out {
			out[i] = map[string]any{"name": fmt.Sprintf("M%d", i), "role": "r"}
		}
		return out
	}
	gate := func(patch map[string]any) bool {
		op := map[string]any{"type": "set_team", "nodeId": "n", "mode": "parallel", "members": members(2), "maxRounds": 2}
		for key, value := range patch {
			op[key] = value
		}
		return validatePlan(planWith(t, op))
	}
	team := func(patch func(*nodeTeam)) error {
		tm := &nodeTeam{Version: 1, Mode: "sequential", Runtime: runtimePI, MaxRounds: 2, MaxTurns: 8, TimeoutSeconds: 300,
			Members: []teamMember{{ID: "m0", Name: "A", Role: "r", Context: "shared", Tools: []string{}}, {ID: "m1", Name: "B", Role: "r", Context: "shared", Tools: []string{}}}}
		patch(tm)
		return validateTeam(tm)
	}
	crowd := func(n int) []teamMember {
		out := make([]teamMember, n)
		for i := range out {
			out[i] = teamMember{ID: fmt.Sprintf("m%d", i), Name: fmt.Sprintf("M%d", i), Role: "r", Context: "shared", Tools: []string{}}
		}
		return out
	}
	canvasModes := []string{}
	for _, q := range regexp.MustCompile(`'([a-z]+)'`).FindAllSubmatch(modes[1], -1) {
		canvasModes = append(canvasModes, string(q[1]))
	}
	if !slices.Equal(canvasModes, teamModes) {
		t.Errorf("team modes %v differ from the canvas's %v", teamModes, canvasModes)
	}
	for _, mode := range canvasModes {
		if !gate(map[string]any{"mode": mode}) || team(func(tm *nodeTeam) { tm.Mode = mode }) != nil {
			t.Errorf("the canvas's mode %q is refused by the gate or by the API", mode)
		}
	}
	// Each bound is admitted, and one past it refused, by the gate and by the API.
	for name, c := range map[string]struct {
		limit int
		gate  func(n int) map[string]any
		team  func(n int) func(*nodeTeam)
	}{
		"members": {limits["members"], func(n int) map[string]any { return map[string]any{"members": members(n)} },
			func(n int) func(*nodeTeam) {
				return func(tm *nodeTeam) { tm.Members = crowd(n); tm.MaxTurns = 64 }
			}},
		"rounds": {limits["rounds"], func(n int) map[string]any { return map[string]any{"mode": "debate", "maxRounds": n} },
			func(n int) func(*nodeTeam) { return func(tm *nodeTeam) { tm.MaxRounds = n } }},
		"name": {limits["name"], func(n int) map[string]any {
			return map[string]any{"members": []any{map[string]any{"name": text(n), "role": "r"}, map[string]any{"name": "B", "role": "r"}}}
		},
			func(n int) func(*nodeTeam) { return func(tm *nodeTeam) { tm.Members[0].Name = text(n) } }},
		"role": {limits["role"], func(n int) map[string]any {
			return map[string]any{"members": []any{map[string]any{"name": "A", "role": text(n)}, map[string]any{"name": "B", "role": "r"}}}
		},
			func(n int) func(*nodeTeam) { return func(tm *nodeTeam) { tm.Members[0].Role = text(n) } }},
		"instructions": {limits["instructions"], func(n int) map[string]any {
			return map[string]any{"members": []any{map[string]any{"name": "A", "role": "r", "instructions": text(n)}, map[string]any{"name": "B", "role": "r"}}}
		},
			func(n int) func(*nodeTeam) { return func(tm *nodeTeam) { tm.Members[0].Instructions = text(n) } }},
		"calls":      {limits["calls"], nil, func(n int) func(*nodeTeam) { return func(tm *nodeTeam) { tm.MaxTurns = n } }},
		"maxSeconds": {limits["maxSeconds"], nil, func(n int) func(*nodeTeam) { return func(tm *nodeTeam) { tm.TimeoutSeconds = n } }},
		"id":         {limits["id"], nil, func(n int) func(*nodeTeam) { return func(tm *nodeTeam) { tm.Members[0].ID = text(n) } }},
		"model": {limits["model"], nil, func(n int) func(*nodeTeam) {
			return func(tm *nodeTeam) { tm.Members[0].Model = strings.Repeat("m", n) }
		}},
	} {
		if c.gate != nil && (!gate(c.gate(c.limit)) || gate(c.gate(c.limit+1))) {
			t.Errorf("%s: the gate does not take the canvas's bound %d", name, c.limit)
		}
		if team(c.team(c.limit)) != nil || team(c.team(c.limit+1)) == nil {
			t.Errorf("%s: the API does not take the canvas's bound %d", name, c.limit)
		}
	}
	if team(func(tm *nodeTeam) { tm.TimeoutSeconds = limits["minSeconds"] }) != nil || team(func(tm *nodeTeam) { tm.TimeoutSeconds = limits["minSeconds"] - 1 }) == nil {
		t.Errorf("the API does not take the canvas's shortest timeout %d", limits["minSeconds"])
	}
}
