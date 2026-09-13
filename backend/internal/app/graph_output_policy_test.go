package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestGraphOutputPolicyMatchesValidation(t *testing.T) {
	for _, test := range []struct {
		name   string
		fields []graphField
		valid  string
		bad    string
		plain  bool
	}{
		{"single-text", []graphField{{ID: "answer", Type: "text", Required: true}}, "One sentence.", "", true},
		{"single-markdown", []graphField{{ID: "answer", Type: "markdown", Required: true}}, "**One sentence.**", "", true},
		{"optional-text-is-still-multi-field", []graphField{{ID: "result", Type: "markdown", Required: true}, {ID: "followups", Type: "markdown"}}, `{"result":"One sentence."}`, "One sentence.", false},
		{"typed", []graphField{{ID: "count", Type: "number", Required: true}, {ID: "approved", Type: "boolean", Required: true}}, `{"count":0,"approved":false}`, `{"count":"0","approved":false}`, false},
		{"optional-typed", []graphField{{ID: "result", Type: "text", Required: true}, {ID: "count", Type: "number"}}, `{"result":"One sentence."}`, `{"result":"One sentence.","count":"1"}`, false},
		{"single-boolean", []graphField{{ID: "approved", Type: "boolean", Required: true}}, `{"approved":false}`, "false", false},
		{"file", []graphField{{ID: "report", Type: "file", Required: true}}, `{"report":{"name":"answer.txt","content":"Real answer."}}`, `{"report":{"name":"answer.txt","content":123}}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			n := graphNode{Contract: &graphContract{Version: 1, Outputs: test.fields}}
			n.Contract.Outputs[0].Value = "STALE-RESULT-NEVER-REUSE"
			policy := graphOutputPolicy(n)
			if strings.Contains(policy, "may alternatively be returned as plain text") != test.plain || strings.Contains(policy, "STALE-RESULT") {
				t.Fatal("policy differs from field contract", policy)
			}
			if strings.Contains(policy, "For a `file` output") != hasFileOutput(n) {
				t.Fatal("file policy does not match declared fields")
			}
			if _, _, err := graphOutputFiles(n, test.valid); err != nil {
				t.Fatal("valid output rejected", err)
			}
			if _, _, err := graphOutputFiles(n, test.bad); err == nil {
				t.Fatal("validator was weakened", test.bad)
			}
			// The generated example must itself retain the declared JSON types.
			start := strings.Index(policy, "Example shape only (replace example values with actual results): ")
			shape := strings.Split(strings.TrimPrefix(policy[start:], "Example shape only (replace example values with actual results): "), "\n")[0]
			if _, _, err := graphOutputFiles(n, shape); err != nil {
				t.Fatal("generated shape violates contract", shape, err)
			}
			prompt, err := graphPrompt(n, graphDocument{Nodes: []graphNode{n}}, nil)
			if err != nil || !strings.Contains(prompt, policy) {
				t.Fatal("system/user policy drift", err)
			}
		})
	}
	if graphOutputPolicy(graphNode{}) != "" || graphSystemPrompt("UNCHANGED", "") != "UNCHANGED" {
		t.Fatal("legacy contractless run behavior changed")
	}
}

func TestGraphOutputPolicyPreservesPersonaAndBoundsTeamInput(t *testing.T) {
	n := graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "result", Type: "text", Required: true}, {ID: "followups", Type: "text"}}}}
	snap := executionSnapshot{Instructions: "You are 李白. Return only one sentence, no JSON.", OutputPolicy: graphOutputPolicy(n)}
	system := graphSystemPrompt(snap.Instructions, snap.OutputPolicy)
	if !strings.Contains(system, snap.Instructions) || !strings.Contains(system, "takes precedence over any conflicting node or member instruction about response format") || !strings.HasSuffix(system, snap.OutputPolicy) {
		t.Fatal("persona lost or contract not authoritative", system)
	}
	m := fixtureTeam("sequential").Members[1]
	m.Instructions = "You are 王伟. Return only concise text."
	input := teamTurnInput{Task: "Current task", Purpose: "work"}
	_, actual, _, _, err := prepareTeamInput(snap, m, input, 262144, 32)
	if err != nil || !strings.Contains(actual, m.Instructions) || !strings.Contains(actual, "member persona takes precedence") || !strings.HasSuffix(actual, snap.OutputPolicy) {
		t.Fatal("member persona or graph policy lost", actual, err)
	}
	// The former budget fits persona+task, but not the newly mandatory policy.
	budget := len(teamSystemPrompt(snap.Instructions, m)) + len(input.Task) + 32
	if _, _, _, _, err = prepareTeamInput(snap, m, input, budget, 32); err == nil || err.Error() != "context_limit" {
		t.Fatal("output policy silently omitted or excluded from context budget", err)
	}
}

func TestGraphOutputPolicyAllTeamModesAndReviewEnvelope(t *testing.T) {
	n := graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "result", Type: "text", Required: true}, {ID: "followups", Type: "text"}}}}
	const output = `{"result":"Validated content."}`
	for _, mode := range []string{"sequential", "parallel", "debate", "review"} {
		t.Run(mode, func(t *testing.T) {
			team := fixtureTeam(mode)
			snap := executionSnapshot{Instructions: "Return only one sentence.", OutputPolicy: graphOutputPolicy(n), Team: &team}
			result, err := runTeam(context.Background(), team, "TASK", func(_ context.Context, member teamMember, _, _ int, input teamTurnInput) (string, error) {
				_, system, _, _, err := prepareTeamInput(snap, member, input, 262144, 32)
				if err != nil || !strings.Contains(system, member.Instructions) || !strings.Contains(system, snap.OutputPolicy) {
					t.Error("member missed frozen output policy", err)
				}
				if input.Purpose == "review" {
					if !strings.Contains(system, "INSIDE the output string, not to the outer review response") {
						t.Error("graph delivery envelope displaced review protocol")
					}
					verdict, _ := json.Marshal(map[string]any{"approved": true, "output": output, "feedback": ""})
					return string(verdict), err
				}
				if strings.Contains(system, "Server-owned review protocol") {
					t.Error("review protocol leaked to ordinary member call")
				}
				return output, err
			})
			if err != nil || result != output {
				t.Fatal("team result envelope incorrect", result, err)
			}
			if _, err = graphOutput(n, result); err != nil {
				t.Fatal("team final result violates graph contract", err)
			}
		})
	}
}
