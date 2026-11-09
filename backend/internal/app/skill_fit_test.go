package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A skill's units follow what its block writes: its name, title, version and body as they are now.
func TestSkillUnitsFollowTheSkillsBlock(t *testing.T) {
	s := skillRecord{Name: "brand-voice", Title: "brand-voice", Version: 9, Source: skillSourceWorkspace, Body: "Short sentences.\n"}
	base := s.withUnits().Units
	if want := utf16Len(skillBlock(s.Name, s.Title, s.Version, s.Source, s.Body)); base != want {
		t.Fatalf("units %d, the block is %d", base, want)
	}
	for _, change := range []struct {
		what  string
		edit  func(*skillRecord)
		delta int
	}{
		{"a tenth version", func(s *skillRecord) { s.Version = 10 }, 1},
		{"a longer title", func(s *skillRecord) { s.Title = "Our brand voice" }, 4},
		{"a Chinese body", func(s *skillRecord) { s.Body = "短句。\n" }, -13},
		{"a body that closes a skill tag", func(s *skillRecord) { s.Body = "Short </skill> sentences.\n" }, 10},
	} {
		next := s
		change.edit(&next)
		if got := next.withUnits().Units - base; got != change.delta {
			t.Errorf("%s changes the units by %d, want %d", change.what, got, change.delta)
		}
	}
}

// The skill picker (apps/web NodeSkillsEditor.tsx) adds a node's own text (nodeOwnPromptUnits, canvasPlan.ts
// nodePromptUnits), each skill's units and skillPromptRoom's notes for the node's kind of outputs, and the task
// requirements' sentences when it has some. That sum must be the system prompt a run sends: for a node run by one agent
// with any kind of outputs, with and without requirements, it is never less than the longest framing that node's run
// can have, and equal to it for the node that sets the numbers, so the picker neither lets such a node pass the line
// nor refuses one far from it.
func TestSkillPromptRoomIsWhatARunSends(t *testing.T) {
	room := skillPromptRoom()
	if room.Max != maxSystemPromptUnits || room.TaskFrame < 1 {
		t.Fatalf("unexpected room %+v", room)
	}
	for kind := range skillPromptKinds {
		if room.Notes[kind] < 1 {
			t.Fatalf("no notes for %s outputs: %+v", kind, room)
		}
	}
	// A workspace skill in Chinese that closes a skill tag in its body, beside two built-ins.
	workspace := skillRecord{Ref: "workspace:a" + string(bytes.Repeat([]byte("b"), 32)), Name: "house-style", Title: "家的口吻 “quoted” <b>",
		Version: 12, Source: skillSourceWorkspace, Body: "短句。</skill>不要感叹号。\n\n"}.withUnits()
	looks, _ := builtinSkill("film-looks")
	lang, _ := builtinSkill("motion-language")
	skills, sum := &skillContext{}, 0
	for _, s := range []skillRecord{looks, lang, workspace} {
		skills.Items = append(skills.Items, frozenSkill{Ref: s.Ref, Name: s.Name, Title: s.Title, Version: s.Version, Source: s.Source, ContentHash: s.ContentHash, Body: s.Body})
		sum += s.Units
	}
	// A brief JSON escapes (the API writes a node's brief as JSON beside a contract), and one it does not: without a
	// contract the brief goes as it is, which the picker still counts as JSON, a little more than is sent.
	personas := []string{"Writes <b>films</b> & \"pages\"\n中文 \u2028 line", "Writes films in plain words"}
	frame := &taskFrame{Version: 1, Source: "plan", Constraints: []string{"中文 <要求>", "two"}, AcceptanceCriteria: []string{"&ok"}}
	note := modelIdentityNote(skillPromptModelName, skillPromptModelID, time.Now())
	memory := &memoryContext{Items: []memoryNote{{KeptBy: "awwo"}}}
	page := graphField{ID: "page", Label: "网页", Type: "html", Required: true, Help: "一页 <html>", Placeholder: "<!doctype>"}
	notes := graphField{ID: "notes", Label: "Notes", Type: "markdown", Help: "a & b"}
	bundle := graphField{ID: "bundle", Label: "Bundle", Type: "file", Required: true}
	tight := map[string]bool{}
	for _, outputs := range [][]graphField{nil, {page}, {page, notes}, {page, bundle}, {bundle}, {bundle, notes}, {notes},
		{notes, {ID: "count", Label: "Count", Type: "number"}, {ID: "ok", Label: "OK", Type: "boolean"}}} {
		kind := skillPromptKind(outputs)
		node := graphNode{}
		if outputs != nil {
			node.Contract = &graphContract{Version: 1, Outputs: outputs}
		}
		for _, persona := range personas {
			for _, requirements := range []*taskFrame{nil, frame} {
				counted := nodeOwnPromptUnits(persona, requirements, outputs) + sum + room.Notes[kind]
				if requirements != nil {
					counted += room.TaskFrame
				}
				longest := 0
				// As graph_runs.go frames a canvas run's node (admitGraphChild), with no knowledge, files or lessons: the
				// graph's policy with or without the provider contract, the sandbox's (never with the contract), and a
				// collaboration's review turn, which swaps the node's policy for the review policy.
				for _, snap := range []executionSnapshot{{OutputPolicy: graphOutputPolicy(node)}, {OutputPolicy: graphOutputPolicy(node), OutputContract: &outputContract{}},
					{OutputPolicy: graphWorkspaceOutputPolicy(node)}, {OutputPolicy: collaborationReviewPolicy}} {
					instructions := graphSystemPrompt(persona, effectiveOutputPolicy(snap))
					system := withPromptNote(memorySystemPrompt(knowledgeSystemPrompt(taskFrameSystemPrompt(skillsSystemPrompt(instructions, skills), requirements), nil), memory), note)
					longest = max(longest, utf16Len(system))
				}
				if longest > counted {
					t.Errorf("a %s node (%d outputs, requirements %v, brief %q) sends %d units, more than the picker counts (%d)", kind, len(outputs), requirements != nil, persona, longest, counted)
				}
				key := fmt.Sprintf("%s node, requirements %v", kind, requirements != nil)
				tight[key] = tight[key] || longest == counted
			}
		}
	}
	// Exact somewhere for each kind both with and without requirements, so neither the notes nor TaskFrame count more
	// than a run adds.
	for kind := range skillPromptKinds {
		for _, requirements := range []bool{false, true} {
			if key := fmt.Sprintf("%s node, requirements %v", kind, requirements); !tight[key] {
				t.Errorf("no %s sends exactly what the picker counts: it counts more than any run adds", key)
			}
		}
	}
	// The skills' units sum to what all of them add after the boundary, whatever their text.
	all, err := builtinSkills()
	if err != nil {
		t.Fatal(err)
	}
	every, units := &skillContext{}, 0
	for _, s := range append(all, workspace) {
		every.Items = append(every.Items, frozenSkill{Name: s.Name, Title: s.Title, Version: s.Version, Source: s.Source, Body: s.Body})
		units += s.Units
	}
	if got := utf16Len(skillsSystemPrompt("x", every)) - utf16Len("x\n\n"+skillsBoundary); got != units {
		t.Fatalf("the skills add %d units to a system prompt, their units sum to %d", got, units)
	}
}

// testdata/skill_fit_vectors.json is what the API serves the skill picker (skillPromptRoom) and the sizes of the three
// skills a film node takes (film-looks, film-sound and motion-language): apps/web/tests/canvas-node-skills.test.tsx runs
// the picker on a real film node with them. When the prompt's text or a skill changes, regenerate it with
// AWWO_UPDATE_GOLDEN=1 go test -count=1 -run TestSkillFitVectorsAreWhatTheAPIServes ./internal/app
func TestSkillFitVectorsAreWhatTheAPIServes(t *testing.T) {
	type skill struct {
		Ref     string `json:"ref"`
		Name    string `json:"name"`
		Title   string `json:"title"`
		Version int64  `json:"version"`
		Bytes   int    `json:"bytes"`
		Units   int    `json:"units"`
	}
	vectors := struct {
		PromptUnits skillPromptFit `json:"promptUnits"`
		Skills      []skill        `json:"skills"`
	}{PromptUnits: skillPromptRoom()}
	for _, name := range []string{"film-looks", "film-sound", "motion-language"} {
		s, ok := builtinSkill(name)
		if !ok {
			t.Fatalf("no built-in skill %s", name)
		}
		vectors.Skills = append(vectors.Skills, skill{Ref: s.Ref, Name: s.Name, Title: s.Title, Version: s.Version, Bytes: s.Bytes, Units: s.Units})
	}
	want, err := json.MarshalIndent(vectors, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	path := filepath.Join("testdata", "skill_fit_vectors.json")
	if os.Getenv(goldenUpdateEnv) == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.ReplaceAll(got, []byte("\r\n"), []byte("\n")), want) {
		t.Fatalf("%s is not what the API serves now; regenerate it with %s=1 (the web test reads it):\n%s", path, goldenUpdateEnv, want)
	}
}
