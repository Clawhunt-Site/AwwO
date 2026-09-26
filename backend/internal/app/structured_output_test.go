package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The worker and Go must accept and reject exactly the same field ids, so both read
// one vector file rather than each restating the grammar. A divergence here would let
// Go freeze a contract the worker refuses, failing a run that was admitted.
func TestStructuredFieldIDMatchesSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "output_contract_v1_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Accept  []string `json:"accept"`
		Reject  []string `json:"reject"`
		Reserve int      `json:"schemaReserveBytes"`
	}
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Accept) == 0 || len(vectors.Reject) == 0 {
		t.Fatal("vector file carries no cases")
	}
	for _, id := range vectors.Accept {
		if !structuredFieldID(id) {
			t.Fatal("shared vector rejected", id)
		}
	}
	for _, id := range vectors.Reject {
		if structuredFieldID(id) {
			t.Fatal("shared vector accepted", id)
		}
	}
	if vectors.Reserve != schemaReserveBytes {
		t.Fatal("context reserve disagrees with the worker", vectors.Reserve, schemaReserveBytes)
	}
}

// A contract is derived from the frozen output fields, never authored, and a shape
// the grammar cannot express falls back instead of narrowing the schema.
func TestGraphOutputContractDerivesOrFallsBack(t *testing.T) {
	wide := make([]graphField, 0, 33)
	for i := 0; i < 33; i++ {
		wide = append(wide, graphField{ID: "f" + string(rune('a'+i%26)) + string(rune('a'+i/26)), Type: "text", Required: true})
	}
	files := make([]graphField, 0, 9)
	for i := 0; i < 9; i++ {
		files = append(files, graphField{ID: "file" + string(rune('a'+i)), Type: "file", Required: true})
	}
	for _, test := range []struct {
		name    string
		fields  []graphField
		outcome string
	}{
		{"no-contract", nil, "none"},
		{"single-text", []graphField{{ID: "answer", Type: "text", Required: true}}, "frozen"},
		{"every-type", []graphField{
			{ID: "a", Type: "text", Required: true}, {ID: "b", Type: "markdown"}, {ID: "c", Type: "html"},
			{ID: "d", Type: "number", Required: true}, {ID: "e", Type: "boolean"}, {ID: "f", Type: "file"},
		}, "frozen"},
		{"max-fields", wide[:32], "frozen"},
		{"max-files", files[:8], "frozen"},
		{"too-many-fields", wide, "fallback_bounds"},
		{"too-many-files", files, "fallback_bounds"},
		{"id-out-of-grammar", []graphField{{ID: "a.b", Type: "text", Required: true}}, "fallback_bounds"},
		{"id-non-ascii", []graphField{{ID: "字段", Type: "text", Required: true}}, "fallback_bounds"},
		{"id-reserved", []graphField{{ID: "__proto__", Type: "text", Required: true}}, "fallback_bounds"},
		{"id-duplicated", []graphField{{ID: "a", Type: "text", Required: true}, {ID: "a", Type: "number"}}, "fallback_bounds"},
		{"type-unknown", []graphField{{ID: "a", Type: "image", Required: true}}, "fallback_bounds"},
	} {
		t.Run(test.name, func(t *testing.T) {
			n := graphNode{}
			if test.fields != nil {
				n.Contract = &graphContract{Version: 1, Outputs: test.fields}
			}
			contract, outcome := graphOutputContract(n)
			if outcome != test.outcome {
				t.Fatal("outcome", outcome, "wanted", test.outcome)
			}
			if (contract != nil) != (test.outcome == "frozen") {
				t.Fatal("contract presence disagrees with the outcome", contract)
			}
			if contract == nil {
				return
			}
			if !validOutputContract(contract) || contract.Version != outputContractVersion || len(contract.Fields) != len(test.fields) {
				t.Fatal("derived contract is not valid or lost a field")
			}
			// Field order, ids, types and requiredness come from the node verbatim, and
			// nothing else does: labels, help, placeholders and saved values never travel.
			for i, f := range contract.Fields {
				if f.ID != test.fields[i].ID || f.Type != test.fields[i].Type || f.Required != test.fields[i].Required {
					t.Fatal("derived field differs from the frozen field", i, f)
				}
			}
			encoded, err := json.Marshal(contract)
			if err != nil {
				t.Fatal(err)
			}
			for _, leak := range []string{"label", "help", "placeholder", "value", "STALE"} {
				if strings.Contains(string(encoded), leak) {
					t.Fatal("contract carries prompt content", leak, string(encoded))
				}
			}
		})
	}
}

// The derived contract must not disagree with what graphOutputFiles enforces: a
// saved label or value on the node changes neither the contract nor its bytes.
func TestGraphOutputContractIgnoresLabelsAndSavedValues(t *testing.T) {
	fields := []graphField{{ID: "answer", Type: "text", Required: true, Label: "Answer", Help: "help", Placeholder: "ph"}}
	bare, _ := graphOutputContract(graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "answer", Type: "text", Required: true}}}})
	decorated, _ := graphOutputContract(graphNode{Contract: &graphContract{Version: 1, Outputs: fields}})
	first, _ := json.Marshal(bare)
	second, _ := json.Marshal(decorated)
	if string(first) != string(second) {
		t.Fatal("decoration changed the contract", string(first), string(second))
	}
}

func TestValidOutputContractRejectsMalformedGrammar(t *testing.T) {
	for _, test := range []struct {
		name string
		c    *outputContract
	}{
		{"nil", nil},
		{"wrong-version", &outputContract{Version: 2, Fields: []outputContractField{{ID: "a", Type: "text"}}}},
		{"no-fields", &outputContract{Version: 1}},
		{"empty-id", &outputContract{Version: 1, Fields: []outputContractField{{ID: "", Type: "text"}}}},
		{"empty-type", &outputContract{Version: 1, Fields: []outputContractField{{ID: "a"}}}},
	} {
		if validOutputContract(test.c) {
			t.Fatal("malformed contract accepted", test.name)
		}
	}
}

// The suffix is derived at send time. Freezing it into OutputPolicy would change the
// stored snapshot and every request byte of a run that carries no contract.
func TestEffectiveOutputPolicyAndReserveAreDerivedNotFrozen(t *testing.T) {
	policy := graphOutputPolicy(graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "answer", Type: "text", Required: true}}}})
	plain := executionSnapshot{OutputPolicy: policy}
	contract := &outputContract{Version: 1, Fields: []outputContractField{{ID: "answer", Type: "text", Required: true}}}
	structured := executionSnapshot{OutputPolicy: policy, OutputContract: contract}
	if effectiveOutputPolicy(plain) != policy || outputContractReserve(plain) != 0 {
		t.Fatal("a snapshot without a contract was altered")
	}
	// A single text field allows plain text in the frozen policy. With a contract frozen the
	// provider enforces JSON, so the allowance is withdrawn and the rest is extended, not replaced.
	if !strings.Contains(policy, plainTextAllowance) {
		t.Fatal("the single-text-field policy lost its plain-text allowance", policy)
	}
	derived := effectiveOutputPolicy(structured)
	if strings.Contains(derived, plainTextAllowance) || !strings.HasPrefix(derived, strings.ReplaceAll(policy, plainTextAllowance, jsonOnlyPolicy)) {
		t.Fatal("the structured policy must withdraw the allowance and extend the rest", derived)
	}
	if outputContractReserve(structured) != schemaReserveBytes {
		t.Fatal("reserve", outputContractReserve(structured))
	}
	if structured.OutputPolicy != policy {
		t.Fatal("the suffix leaked into the snapshot")
	}
	// An empty policy stays empty: there is no envelope to describe.
	if effectiveOutputPolicy(executionSnapshot{OutputContract: contract}) != "" {
		t.Fatal("a suffix was added without a frozen policy")
	}
}

// A durable snapshot is replayed after a restart, so one whose contract contradicts
// its team, runtime, model or grammar must fail closed.
func TestStructuredContractConsistentFailsClosed(t *testing.T) {
	capable := piHealth{Model: "oa", Models: []piModel{{ID: "oa", Runtime: runtimeOpenAIAgents, StructuredOutput: true}, {ID: "plain", Runtime: runtimeOpenAIAgents}}}
	contract := &outputContract{Version: 1, Fields: []outputContractField{{ID: "answer", Type: "text", Required: true}}}
	base := executionSnapshot{Runtime: runtimeOpenAIAgents, Model: "oa", Health: capable, OutputContract: contract}
	if !structuredContractConsistent(base) {
		t.Fatal("a consistent snapshot was refused")
	}
	if !structuredContractConsistent(executionSnapshot{Runtime: runtimePI, Model: "m", Team: &nodeTeam{}}) {
		t.Fatal("a snapshot without a contract must always pass")
	}
	for _, test := range []struct {
		name   string
		mutate func(executionSnapshot) executionSnapshot
	}{
		{"team", func(s executionSnapshot) executionSnapshot { s.Team = &nodeTeam{Version: 1}; return s }},
		{"pi-runtime", func(s executionSnapshot) executionSnapshot { s.Runtime = runtimePI; return s }},
		{"model-not-capable", func(s executionSnapshot) executionSnapshot { s.Model = "plain"; return s }},
		{"model-unknown", func(s executionSnapshot) executionSnapshot { s.Model = "missing"; return s }},
		{"capability-withdrawn", func(s executionSnapshot) executionSnapshot {
			s.Health = piHealth{Model: "oa", Models: []piModel{{ID: "oa", Runtime: runtimeOpenAIAgents}}}
			return s
		}},
		{"out-of-grammar", func(s executionSnapshot) executionSnapshot {
			s.OutputContract = &outputContract{Version: 1, Fields: []outputContractField{{ID: "a.b", Type: "text", Required: true}}}
			return s
		}},
	} {
		if structuredContractConsistent(test.mutate(base)) {
			t.Fatal("inconsistent snapshot accepted", test.name)
		}
	}
}

// A worker that is not openai-agents cannot have this capability. Advertising it is
// meaningless rather than hostile, so the claim is cleared and the catalog still loads.
func TestProbeClearsStructuredOutputForNonOpenAIAgentsRuntime(t *testing.T) {
	catalog := func(runtime string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "m", "provider": "fixture", "models": []map[string]any{
				{"id": "m", "runtime": runtime, "maxContextTextBytes": 262144, "structuredOutput": true},
			}})
		}))
	}
	pi := catalog(runtimePI)
	defer pi.Close()
	oa := catalog(runtimeOpenAIAgents)
	defer oa.Close()
	c := testConfig()
	c.PIURL, c.PIToken = pi.URL, strings.Repeat("p", 32)
	c.OpenAIAgentsURL, c.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	a := New(nil, c)
	health, err := a.probeRuntime(context.Background(), runtimePI)
	if err != nil {
		t.Fatal("pi catalog rejected instead of cleared", err)
	}
	if health.Models[0].StructuredOutput || health.supportsStructuredOutput("m") {
		t.Fatal("pi kept a structured-output claim")
	}
	health, err = a.probeRuntime(context.Background(), runtimeOpenAIAgents)
	if err != nil {
		t.Fatal(err)
	}
	if !health.Models[0].StructuredOutput || !health.supportsStructuredOutput("m") || health.supportsStructuredOutput("other") {
		t.Fatal("openai-agents lost the capability, or an unknown model gained it")
	}
}
