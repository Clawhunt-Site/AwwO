package app

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// A node's skills ride in its runs' system prompt, which may take at most maxSystemPromptUnits UTF-16 code units: the
// workers' systemPromptChars (apps/pi-worker/config.mjs, apps/openai-agents-worker/config.mjs). runs.go and
// graph_runs.go refuse a run past it as context_limit; they leave a node's lessons out first, and the planner's own
// skills (plannerSkills), but never skills a member attached. A node's skills also fit in maxNodeSkillBytes, yet a
// node whose own text is long can pass this line well inside that: a film node (代码影片) carries the film kit's guide,
// about 15,000 units, and with film-looks, film-sound and motion-language its every run was refused (2026-11-09).
// So the skill list tells the skill picker (apps/web NodeSkillsEditor.tsx) what a run sends beside the node's own text:
// each skill's block (skillRecord.Units) and skillPromptRoom's notes, and the picker refuses a skill that would take a
// node's runs past the line.
const maxSystemPromptUnits = 32768

// skillPromptFit is what the skill picker adds to a node's own text (its brief, task requirements and output fields as
// canvasPlan.ts nodePromptUnits counts them, as JSON) and its skills' blocks to tell whether its runs fit Max.
type skillPromptFit struct {
	Max int `json:"max"`
	// Notes is the most a run of a node run by one agent adds beside them, by the kind of outputs the node has
	// (skillPromptKind), over every framing such a run can have (skillPromptFramings): the rest of the output policy or
	// of a collaboration's review policy, the provider contract's sentence, the skills' and the longer memory notes'
	// boundaries and the note naming the model, for a name of up to 40 characters and an id of up to 64 bytes
	// (skillPromptModelName). Not counted, so a node near the line can still have such a run refused: a member's
	// knowledge, upstream files and a direct task's step budget (knowledgeEvidenceBoundary, graphFileDataPolicy,
	// computerStepNote), a longer model name, a model whose own budget is smaller than the line (a personal model
	// without a catalogue), and a team node, whose members' turns team_context.go frames apart (the web counts none).
	Notes map[string]int `json:"notes"`
	// TaskFrame is what task requirements with at least one entry add beside their own JSON (taskFrameSystemPrompt).
	TaskFrame int `json:"taskFrame"`
}

// The note naming the model is counted for a catalog name of 40 runes and an id of 64 bytes, longer than AwwO's own
// ("Claude Opus 5.5", "bedrock.claude-opus-5-5").
var skillPromptModelName, skillPromptModelID = strings.Repeat("M", 40), strings.Repeat("m", 64)

// skillPromptKinds are the kinds of outputs the output policy tells apart (graphOutputPolicy): an html field, a file
// field, both, neither (a text contract), or no contract. The web names a node's kind the same way (skillFit.ts
// skillPromptKind). Each kind lists contracts that reach every variant of its policy: one plain text or html field is
// allowed unwrapped (allowsPlainTextOutput), several are JSON.
var skillPromptKinds = map[string][][]graphField{
	"html":     {{{ID: "a", Type: "html", Required: true}}, {{ID: "a", Type: "html"}, {ID: "b", Type: "markdown"}}},
	"htmlFile": {{{ID: "a", Type: "html"}, {ID: "b", Type: "file"}}},
	"file":     {{{ID: "a", Type: "file", Required: true}}, {{ID: "a", Type: "file"}, {ID: "b", Type: "text"}}},
	"text":     {{{ID: "a", Type: "markdown", Required: true}}, {{ID: "a", Type: "text"}, {ID: "b", Type: "number"}, {ID: "c", Type: "boolean"}}},
	"none":     {nil},
}

// skillPromptKind is the kind of a node's outputs (skillPromptKinds).
func skillPromptKind(outputs []graphField) string {
	html, file := false, false
	for _, f := range outputs {
		html, file = html || f.Type == "html", file || f.Type == "file"
	}
	switch {
	case len(outputs) == 0:
		return "none"
	case html && file:
		return "htmlFile"
	case html:
		return "html"
	case file:
		return "file"
	}
	return "text"
}

// skillPromptFramings are the output policies a run of a node run by one agent can have (graph_runs.go
// admitGraphChild): the graph's, with the provider contract or without it (the contract is frozen only off the
// sandbox), the sandbox's, and a collaboration's review policy, which replaces the node's on a review turn.
func skillPromptFramings(node graphNode) []executionSnapshot {
	return []executionSnapshot{
		{OutputPolicy: graphOutputPolicy(node)},
		{OutputPolicy: graphOutputPolicy(node), OutputContract: &outputContract{}},
		{OutputPolicy: graphWorkspaceOutputPolicy(node)},
		{OutputPolicy: collaborationReviewPolicy},
	}
}

// nodeOwnPromptUnits is a node's own text in its system prompt as canvasPlan.ts nodePromptUnits counts it: its brief
// (graphSystemPrompt), its task requirements (taskFrameSystemPrompt) and its output fields with the example of their
// shape (graphOutputPolicy), each as the JSON the API writes.
func nodeOwnPromptUnits(persona string, frame *taskFrame, outputs []graphField) int {
	raw, _ := json.Marshal(persona)
	units := utf16Len(string(raw))
	if frame != nil {
		raw, _ = json.Marshal(frame)
		units += utf16Len(string(raw))
	}
	if len(outputs) > 0 {
		fields, shape := graphOutputFields(outputs)
		units += utf16Len(string(fields)) + utf16Len(string(shape))
	}
	return units
}

// skillPromptRoom is skillPromptFit measured on the prompt builders themselves, so it follows any change to their text.
var skillPromptRoom = sync.OnceValue(func() skillPromptFit {
	fit := skillPromptFit{Max: maxSystemPromptUnits, Notes: map[string]int{}}
	note := modelIdentityNote(skillPromptModelName, skillPromptModelID, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	memory := &memoryContext{Items: []memoryNote{{KeptBy: "awwo"}}} // the longer of the memory notes' boundaries
	for kind, contracts := range skillPromptKinds {
		for _, outputs := range contracts {
			node := graphNode{}
			if outputs != nil {
				node.Contract = &graphContract{Version: 1, Outputs: outputs}
			}
			own := nodeOwnPromptUnits("x", nil, outputs)
			for _, snap := range skillPromptFramings(node) {
				system := graphSystemPrompt("x", effectiveOutputPolicy(snap))
				system = withPromptNote(memorySystemPrompt(system+"\n\n"+skillsBoundary, memory), note)
				fit.Notes[kind] = max(fit.Notes[kind], utf16Len(system)-own)
			}
		}
	}
	frame := &taskFrame{Version: 1, Source: "manual", Constraints: []string{"x"}, AcceptanceCriteria: []string{}}
	raw, _ := json.Marshal(frame)
	fit.TaskFrame = utf16Len(taskFrameSystemPrompt("x", frame)) - utf16Len("x") - utf16Len(string(raw))
	return fit
})
