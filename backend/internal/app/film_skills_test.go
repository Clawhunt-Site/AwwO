package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// filmGuide is the film kit's guide (apps/web/src/canvas/filmKit/film-guide.md), which a film node (代码影片) carries in
// its persona after its role.
func filmGuide(t *testing.T) string {
	t.Helper()
	guide, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "filmKit", "film-guide.md"))
	if err != nil {
		t.Fatal(err)
	}
	return string(guide)
}

// Three skills are made for a film node, whose persona already carries the kit guide: film-looks, film-sound and the
// motion language (the one a film the canvas assistant plans gets, canvasPlan.ts HOSTED_FILM_SKILLS). The skill picker
// (NodeSkillsEditor.tsx) adds a node's own text, each skill's units and the notes a usual run adds (skillPromptRoom,
// which TestSkillPromptRoomIsWhatARunSends checks against the prompt a run sends). Any two of the three fit one film
// node and leave room for task requirements as long as a plan writes, so the picker lets a member attach them; all
// three pass the system prompt's line even without requirements (a film node with them had every run refused on
// 2026-11-09), so the picker refuses the third. The skills README and the CHANGELOG say so; if all three ever fit,
// drop the last check and those lines with it.
func TestFilmSkillsFitAFilmNode(t *testing.T) {
	// The film template's role, steps, checklist and evidence policy come before the guide (agentTemplates.ts and
	// agentTemplates.en.ts): 1,313 units in English and 437 in Chinese on 2026-11-08. Count 1,600 for either language.
	persona := strings.Repeat("x", 1600) + "\n\n" + filmGuide(t)
	outputs := []graphField{{ID: "film", Label: "Film", Type: "html", Required: true, Help: "Play it in Results with its sound, render it to video, or download it as one web page."}}
	room := skillPromptRoom()
	own := nodeOwnPromptUnits(persona, nil, outputs) + room.Notes[skillPromptKind(outputs)]
	size := func(names ...string) (bytes, units int) {
		for _, name := range names {
			s, ok := builtinSkill(name)
			if !ok {
				t.Fatalf("no built-in skill %s", name)
			}
			bytes, units = bytes+s.Bytes, units+s.Units
		}
		return bytes, units
	}
	// The JSON of the task requirements a plan writes for a film: the request it was given and a few checks.
	const requirements = 1024
	for _, pair := range [][]string{{"film-looks", "film-sound"}, {"film-looks", "motion-language"}, {"film-sound", "motion-language"}} {
		bytes, units := size(pair...)
		if bytes > maxNodeSkillBytes {
			t.Errorf("%v add %d bytes, more than a node takes (%d)", pair, bytes, maxNodeSkillBytes)
		}
		if spare := room.Max - own - units - room.TaskFrame; spare < requirements {
			t.Errorf("a film node with %v comes to %d of %d system prompt units with task requirements' sentences, leaving %d for their JSON; keep at least %d",
				pair, own+units+room.TaskFrame, room.Max, spare, requirements)
		} else {
			t.Logf("a film node with %v: %d skill bytes, %d units without requirements (%d spare)", pair, bytes, own+units, room.Max-own-units)
		}
	}
	bytes, units := size("film-looks", "film-sound", "motion-language")
	if bytes > maxNodeSkillBytes {
		t.Fatalf("the three add %d bytes, which the picker refuses before their units (%d)", bytes, maxNodeSkillBytes)
	}
	if own+units <= room.Max {
		t.Errorf("all three skills now fit a film node without task requirements (%d of %d units): the picker lets them be attached; drop this check and the lines that say it refuses the third", own+units, room.Max)
	} else {
		t.Logf("a film node with all three: %d units without requirements, over %d", own+units, room.Max)
	}
}

// The film skills name the kit's own vocabulary: the fonts it can load and the families it has, and no curve
// literals a motion token table would have to own.
func TestFilmSkillsNameWhatTheKitHas(t *testing.T) {
	guide := filmGuide(t)
	for _, name := range []string{"film-looks", "film-sound"} {
		s, ok := builtinSkill(name)
		if !ok {
			t.Fatalf("no built-in skill %s", name)
		}
		if strings.Contains(s.Body, "cubic-bezier") {
			t.Errorf("%s writes a cubic-bezier curve; name the kit's EASE or MOTION helpers instead", name)
		}
	}
	looks, _ := builtinSkill("film-looks")
	for _, family := range []string{"cinematic-realistic", "anime-cel", "pastel-storybook", "claymation", "papercut-collage", "retro-synthwave-vhs", "glossy-commercial", "handmade-ink"} {
		if !strings.Contains(guide, "'"+family+"'") {
			t.Errorf("the guide does not list the kit family %s", family)
		}
	}
	for _, line := range strings.Split(looks.Body, "\n") {
		if !strings.HasPrefix(line, "- **") {
			continue
		}
		base := line[strings.Index(line, "[")+1 : strings.Index(line, "]")]
		if !strings.Contains(guide, "'"+base+"'") {
			t.Errorf("film-looks starts a look from %q, which is not a kit family: %s", base, line)
		}
	}
}

// A film node with the motion language reads two vocabularies: the skill's script names (MOTION.dur, MOTION.film,
// MOTION.ease with its curves, MOTION.spring with its presets) and the film kit's own MOTION helpers. In an A/B of four
// films on 2026-11-09 one page read MOTION.film.m from the kit's MOTION, which has no film, and threw before Film.run.
// The guide now says the kit's MOTION has only its helpers, that the skill's curves map to the kit's eases, and that its
// MOTION.film, .dur and spring presets go in TUNE. So: every member of the kit's MOTION (any top-level key of the
// object, a method or a value as well as an arrow) is one the guide lists; the guide keeps that sentence; the kit's
// MOTION has no film, dur or ease to read the skill's tables from, and its spring is a function, not a table of presets;
// and the skill still prints all four names the sentence answers.
func TestFilmGuideKeepsTheMotionLanguageOffTheKitsMotion(t *testing.T) {
	guide := filmGuide(t)
	kit, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "filmKit", "film-kit.js"))
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)\nconst MOTION = \{\n(.*?)\n\};`).FindSubmatch(kit)
	if block == nil {
		t.Fatal("film-kit.js no longer declares const MOTION = { ... } as this test reads it")
	}
	// The object's own keys are written two spaces in, one per line; a body's lines are deeper.
	members := map[string]string{}
	for _, m := range regexp.MustCompile(`(?m)^  ([A-Za-z_$][\w$]*)\s*(:\s*|\()(.?)`).FindAllSubmatch(block[1], -1) {
		members[string(m[1])] = string(m[2]) + string(m[3])
	}
	if len(members) < 5 {
		t.Fatalf("read only %d members of the kit's MOTION: %v", len(members), members)
	}
	for name := range members {
		if !strings.Contains(guide, "`MOTION."+name+"(") {
			t.Errorf("the kit's MOTION has %s, which the guide does not list", name)
		}
	}
	const bridge = "`MOTION` has only these: motion-language's curves map to these eases, its `MOTION.film`, `.dur` and spring presets go in `TUNE`."
	if !strings.Contains(guide, bridge) {
		t.Fatalf("the guide no longer says that the kit's MOTION has only its helpers:\n%s", bridge)
	}
	for _, name := range []string{"film", "dur", "ease"} {
		if _, has := members[name]; has {
			t.Errorf("the kit's MOTION now has %s: the guide's sentence about motion-language's names is wrong", name)
		}
	}
	// An arrow with parameters (`spring: (tau, ...) =>`) or a method (`spring(tau, ...)`): a function, never a table.
	if spring, has := members["spring"]; !has || (spring != ": (" && !strings.HasPrefix(spring, "(")) || !strings.Contains(guide, "`MOTION.spring(") {
		t.Errorf("the kit's MOTION.spring is no longer a function the guide shows (read %q): the sentence's spring presets need another home", spring)
	}
	skill, ok := builtinSkill("motion-language")
	if !ok {
		t.Fatal("motion-language is missing")
	}
	for _, name := range []string{"film", "dur", "ease", "spring"} {
		if !strings.Contains(skill.Body, "`MOTION."+name+"`") {
			t.Errorf("motion-language no longer names MOTION.%s, which the guide's sentence answers", name)
		}
	}
}

// The API takes the motion language alone as the planner's only on a film node (canvasPlan.ts HOSTED_FILM_SKILLS): alone
// on any other node a member chose it, and beside another skill on a film a member chose the set. The film's mark is
// frozen with its skills, so it reaches a canvas run's node admission through the stored snapshot.
func TestPlannerSkillsTakeTheMotionLanguageOnlyOnAFilm(t *testing.T) {
	freeze := func(template any, refs ...string) *skillContext {
		t.Helper()
		node := map[string]any{"id": "n", "kind": "session", "skills": refs}
		if template != nil {
			node["templateId"] = template
		}
		doc, _ := json.Marshal(map[string]any{"nodes": []any{node}})
		value, err := (&App{}).freezeNodeSkills(t.Context(), nil, "", doc, "n")
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	film, page := "a planned film runs without its motion language", "a planned page runs without its design skills"
	for _, tc := range []struct {
		name     string
		template any
		refs     []string
		note     string // "" when the skills are a member's choice
	}{
		{"a film with the motion language", "film", []string{"builtin:motion-language"}, film},
		{"a page with the design skills", "frontend", []string{"builtin:anti-ai-slop", "builtin:design-craft"}, page},
		{"the design skills on any node, as before", "film", []string{"builtin:design-craft", "builtin:anti-ai-slop"}, page},
		{"the motion language alone on a page", "frontend", []string{"builtin:motion-language"}, ""},
		{"the motion language on a node with no template", nil, []string{"builtin:motion-language"}, ""},
		{"a template id that is not a string", 7, []string{"builtin:motion-language"}, ""},
		{"a film with another skill too", "film", []string{"builtin:motion-language", "builtin:film-looks"}, ""},
		{"a film the member left without skills", "film", nil, ""},
	} {
		value := freeze(tc.template, tc.refs...)
		if got := plannerSkills(value); got != (tc.note != "") {
			t.Errorf("%s: taken as the planner's %v, want %v", tc.name, got, tc.note != "")
		} else if got && plannerSkillsNote(value) != tc.note {
			t.Errorf("%s: logged %q, want %q", tc.name, plannerSkillsNote(value), tc.note)
		}
	}
	raw, _ := json.Marshal(executionSnapshot{Skills: freeze("film", "builtin:motion-language")})
	var stored executionSnapshot
	if err := json.Unmarshal(raw, &stored); err != nil || !plannerSkills(stored.Skills) || !strings.Contains(string(raw), `"filmNode":true`) {
		t.Fatalf("a film's mark does not survive its stored snapshot (%v; filmNode written: %v)", err, strings.Contains(string(raw), `"filmNode":true`))
	}
	// A page's snapshot carries no mark: the field is left out, as before.
	if raw, _ = json.Marshal(executionSnapshot{Skills: freeze("frontend", "builtin:design-craft")}); strings.Contains(string(raw), "filmNode") {
		t.Fatalf("a snapshot that is no film's carries the mark: %s", raw)
	}
	if plannerSkills(nil) {
		t.Fatal("no skills are taken as the planner's")
	}
}
