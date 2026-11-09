package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
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

// The film skills ride on a film node, whose persona already carries the kit guide: both together must fit one node
// and leave a run the room its task frame, lessons and notes take, so a member who attaches them is never refused.
func TestFilmSkillsFitAFilmNode(t *testing.T) {
	// The film template's role, steps, checklist and evidence policy come before the guide (agentTemplates.ts and
	// agentTemplates.en.ts): 1,313 units in English and 437 in Chinese on 2026-11-08. Count 1,600 for either language.
	persona := strings.Repeat("x", 1600) + "\n\n" + filmGuide(t)
	node := graphNode{ID: "film", Kind: "session", Title: "A film", Contract: &graphContract{Version: 1,
		Inputs:  []graphField{{ID: "idea", Label: "Film idea", Type: "markdown", Required: true}, {ID: "style", Label: "Look and sound", Type: "markdown"}},
		Outputs: []graphField{{ID: "film", Label: "Film", Type: "html", Required: true, Help: "Play it in Results with its sound, render it to video, or download it as one web page."}}}}
	skills := &skillContext{Items: []frozenSkill{}}
	total := 0
	for _, name := range []string{"film-looks", "film-sound"} {
		s, ok := builtinSkill(name)
		if !ok {
			t.Fatalf("no built-in skill %s", name)
		}
		total += len(s.Body)
		skills.Items = append(skills.Items, frozenSkill{Ref: s.Ref, Name: s.Name, Title: s.Title, Version: s.Version, Source: s.Source, ContentHash: s.ContentHash, Body: s.Body})
	}
	if total > maxNodeSkillBytes {
		t.Fatalf("the film skills add %d bytes, more than a node takes (%d)", total, maxNodeSkillBytes)
	}
	note := modelIdentityNote("Claude Opus 5.5", "bedrock.claude-opus-5-5", time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC))
	system := withPromptNote(skillsSystemPrompt(graphSystemPrompt(persona, graphOutputPolicy(node)), skills), note)
	units := len(utf16.Encode([]rune(system)))
	if spare := 32768 - units; spare < 4096 {
		t.Fatalf("a film node with both film skills uses %d of 32,768 system prompt units, leaving %d; keep at least 4,096", units, spare)
	}
	t.Logf("film node with film-looks + film-sound: %d skill bytes, %d system prompt units (%d spare)", total, units, 32768-units)
}

// A film the canvas assistant plans carries the motion language (canvasPlan.ts HOSTED_FILM_SKILLS); a member may add one
// of the film skills beside it and still leave a run the room its task frame and notes take. Both film skills beside the
// motion language pass 32,768 units: a member who adds both has chosen three skills, and the run is refused as
// context_limit until one comes off (the API drops only the planner's own set, as for a page). The skills README and
// the CHANGELOG say so; if all three ever fit, drop the last check and those lines with it.
func TestAPlannedFilmTakesOneFilmSkillBesideTheMotionLanguage(t *testing.T) {
	persona := strings.Repeat("x", 1600) + "\n\n" + filmGuide(t)
	node := graphNode{ID: "film", Kind: "session", Title: "A film", Contract: &graphContract{Version: 1,
		Outputs: []graphField{{ID: "film", Label: "Film", Type: "html", Required: true, Help: "Play it in Results with its sound, render it to video, or download it as one web page."}}}}
	note := modelIdentityNote("Claude Opus 5.5", "bedrock.claude-opus-5-5", time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC))
	units := func(names ...string) int {
		skills, err := freezeSkillContext(t.Context(), nil, "", names)
		if err != nil {
			t.Fatal(err)
		}
		return len(utf16.Encode([]rune(withPromptNote(skillsSystemPrompt(graphSystemPrompt(persona, graphOutputPolicy(node)), skills), note))))
	}
	for _, extra := range []string{"builtin:film-looks", "builtin:film-sound"} {
		used := units("builtin:motion-language", extra)
		if spare := 32768 - used; spare < 2048 {
			t.Errorf("a planned film with %s beside the motion language uses %d of 32,768 system prompt units, leaving %d; keep at least 2,048", extra, used, spare)
		}
		t.Logf("a planned film with %s: %d units (%d spare)", extra, used, 32768-used)
	}
	if all := units("builtin:motion-language", "builtin:film-looks", "builtin:film-sound"); all <= 32768 {
		t.Errorf("all three skills on a planned film now fit (%d units): drop this check and the lines that say they do not", all)
	} else {
		t.Logf("with both film skills too: %d units, over 32,768", all)
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
