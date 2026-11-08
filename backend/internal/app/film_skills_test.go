package app

import (
	"os"
	"path/filepath"
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
