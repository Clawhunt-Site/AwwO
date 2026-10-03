package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestPlatformProvidersFromEnv(t *testing.T) {
	for _, test := range []struct {
		value string
		want  []string
	}{
		{"", []string{"llmgate"}}, {"  ", []string{"llmgate"}}, {"llmgate", []string{"llmgate"}},
		{"llmgate,bedrock", []string{"llmgate", "bedrock"}}, {" bedrock , llmgate ", []string{"llmgate", "bedrock"}},
	} {
		got, err := parsePlatformProviders(test.value)
		if err != nil || !slices.Equal(got, test.want) {
			t.Fatal("platform providers", test.value, got, err)
		}
	}
	for _, value := range []string{"bedrock", "llmgate,llmgate", "llmgate,openai", "llmgate,", "LLMGATE", "llmgate;bedrock"} {
		if _, err := parsePlatformProviders(value); err == nil || !strings.Contains(err.Error(), "AWWO_PLATFORM_PROVIDERS") {
			t.Fatal("invalid platform providers accepted", value, err)
		}
	}
	c := testConfig()
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", c.DatabaseURL)
	t.Setenv("AWWO_PLATFORM_PROVIDERS", "llmgate,bedrock")
	if loaded, err := ConfigFromEnv(); err != nil || !slices.Equal(loaded.PlatformProviders, []string{"llmgate", "bedrock"}) {
		t.Fatal("platform providers not loaded", loaded.PlatformProviders, err)
	}
	t.Setenv("AWWO_PLATFORM_PROVIDERS", "bedrock")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("platform providers without llmgate accepted")
	}
}

// A Gate-only API admits a worker that reaches Bedrock only when the worker says so in
// canonical form and the API's own policy allows Bedrock; a Bedrock model behind a
// Gate-only claim is refused whatever the policy.
func TestGateOnlyPlatformWorkerClaims(t *testing.T) {
	type claim struct {
		name   string
		health map[string]any
		ok     bool
	}
	gate := []map[string]any{{"id": "gate-model", "provider": "llmgate", "runtime": runtimeOpenAIAgents}}
	withBedrock := append(append([]map[string]any{}, gate...), map[string]any{"id": "bedrock.glm-5", "name": "GLM-5", "provider": "bedrock", "runtime": runtimeOpenAIAgents})
	health := func(models []map[string]any, extra map[string]any) map[string]any {
		h := map[string]any{"ready": true, "userCredentials": false, "provider": "llmgate", "model": "gate-model", "models": models}
		for key, value := range extra {
			h[key] = value
		}
		return h
	}
	both := []any{"llmgate", "bedrock"}
	for _, policy := range [][]string{nil, {"llmgate"}, {"llmgate", "bedrock"}} {
		bedrockAllowed := slices.Contains(policy, "bedrock")
		claims := []claim{
			{"legacy Gate-only", health(gate, map[string]any{"llmgateOnly": true}), true},
			{"Gate-only claim hiding a Bedrock model", health(withBedrock, map[string]any{"llmgateOnly": true}), false},
			{"declared Bedrock platform", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": both}), bedrockAllowed},
			{"declared platform without Bedrock models", health(gate, map[string]any{"platformOnly": true, "platformProviders": both}), bedrockAllowed},
			{"declared Gate platform only", health(gate, map[string]any{"platformOnly": true, "platformProviders": []any{"llmgate"}}), true},
			{"Bedrock model outside the declared list", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": []any{"llmgate"}}), false},
			{"both claims at once", health(withBedrock, map[string]any{"llmgateOnly": true, "platformOnly": true, "platformProviders": both}), false},
			{"no claim", health(gate, nil), false},
			{"reordered list", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": []any{"bedrock", "llmgate"}}), false},
			{"padded list", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": []any{"llmgate", " bedrock"}}), false},
			{"joined list", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": []any{"llmgate,bedrock"}}), false},
			{"duplicate list", health(gate, map[string]any{"platformOnly": true, "platformProviders": []any{"llmgate", "llmgate"}}), false},
			{"unknown provider", health(gate, map[string]any{"platformOnly": true, "platformProviders": []any{"llmgate", "openai"}}), false},
			{"list without LLM Gate", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": []any{"bedrock"}}), false},
			{"string list", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": "llmgate,bedrock"}), false},
			{"empty list", health(gate, map[string]any{"platformOnly": true, "platformProviders": []any{}}), false},
			{"string flag", health(withBedrock, map[string]any{"platformOnly": "true", "platformProviders": both}), false},
			{"personal worker", health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": both, "userCredentials": true}), false},
		}
		for _, test := range claims {
			t.Run(strings.Join(policy, "+")+"/"+test.name, func(t *testing.T) {
				worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, test.health) }))
				defer worker.Close()
				c := testConfig()
				c.LLMGateOnly, c.UserCredentials, c.PlatformProviders = true, false, policy
				c.OpenAIAgentsURL, c.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
				h, err := New(nil, c).probeRuntime(context.Background(), runtimeOpenAIAgents)
				if (err == nil) != test.ok {
					t.Fatalf("policy %v accepted=%v, want %v (%v)", policy, err == nil, test.ok, err)
				}
				if err == nil && len(h.Models) != len(test.health["models"].([]map[string]any)) {
					t.Fatal("accepted catalog lost models", h.Models)
				}
			})
		}
	}
	// Without Gate-only mode the API never inspects the platform claim.
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, health(withBedrock, map[string]any{"platformOnly": true, "platformProviders": both}))
	}))
	defer worker.Close()
	c := testConfig()
	c.OpenAIAgentsURL, c.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
	if _, err := New(nil, c).probeRuntime(context.Background(), runtimeOpenAIAgents); err != nil {
		t.Fatal("open API rejected a platform worker", err)
	}
}

// Managed execution makes non-streaming completion calls, which the Bedrock bridge does not
// serve, so Bedrock models are never offered there, even as the entitled default.
func TestComputerModelChoicesLeaveOutBedrock(t *testing.T) {
	health := piHealth{Model: "bedrock.glm-5", Models: []piModel{
		{ID: "qwen3.8-27b-p6", Name: "Qwen", Provider: "llmgate", ReasoningEfforts: []string{"low"}},
		{ID: "bedrock.glm-5", Name: "GLM-5", Provider: "bedrock"},
		{ID: "bedrock.claude-opus-5-5", Name: "Claude Opus 5.5", Provider: "bedrock"},
	}}
	got := computerModelChoices(runtimeOpenAIAgents, health)
	if len(got) != 1 || got[0]["id"] != "qwen3.8-27b-p6" || got[0]["label"] != "Qwen" || got[0]["runtime"] != runtimeOpenAIAgents {
		t.Fatalf("choices = %#v", got)
	}
	if efforts := got[0]["efforts"].([]string); !slices.Equal(efforts, []string{"low"}) {
		t.Fatalf("efforts = %#v", efforts)
	}
	// A default model that is not in the advertised list is still offered, as before.
	plain := computerModelChoices(runtimePI, piHealth{Model: "fixture-model"})
	if len(plain) != 1 || plain[0]["id"] != "fixture-model" || plain[0]["label"] != "fixture-model" {
		t.Fatalf("default = %#v", plain)
	}
}
