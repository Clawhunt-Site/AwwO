package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// The deployment switch is read strictly: only "true" turns contracts on, and a value
// an operator might have meant either way stops startup instead of being guessed.
func TestStructuredContractsSwitchFromEnv(t *testing.T) {
	c := testConfig()
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", c.DatabaseURL)
	for _, test := range []struct {
		value string
		want  bool
	}{{"", false}, {"false", false}, {"true", true}} {
		t.Setenv("AWWO_STRUCTURED_DELIVERY_CONTRACTS", test.value)
		loaded, err := ConfigFromEnv()
		if err != nil || loaded.StructuredContracts != test.want {
			t.Fatal("switch value", test.value, loaded.StructuredContracts, err)
		}
	}
	for _, value := range []string{"1", "TRUE", "yes", " true", "on"} {
		t.Setenv("AWWO_STRUCTURED_DELIVERY_CONTRACTS", value)
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AWWO_STRUCTURED_DELIVERY_CONTRACTS") {
			t.Fatal("an ambiguous switch value was accepted", value, err)
		}
	}
}

func TestLLMGateOnlySwitchFromEnv(t *testing.T) {
	c := testConfig()
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", c.DatabaseURL)
	t.Setenv("AWWO_CREDENTIAL_MODE", "user")
	t.Setenv("AWWO_CREDENTIAL_ENCRYPTION_KEY", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=")
	for _, test := range []struct {
		value string
		want  bool
	}{{"", false}, {"false", false}, {"true", true}} {
		t.Setenv("AWWO_LLMGATE_ONLY", test.value)
		loaded, err := ConfigFromEnv()
		if err != nil || loaded.LLMGateOnly != test.want {
			t.Fatal("Gate-only switch", test.value, loaded.LLMGateOnly, err)
		}
	}
	for _, value := range []string{"1", "TRUE", "yes", " true"} {
		t.Setenv("AWWO_LLMGATE_ONLY", value)
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AWWO_LLMGATE_ONLY") {
			t.Fatal("ambiguous Gate-only switch accepted", value, err)
		}
	}
	t.Setenv("AWWO_LLMGATE_ONLY", "true")
	t.Setenv("AWWO_CREDENTIAL_MODE", "operator")
	if loaded, err := ConfigFromEnv(); err != nil || !loaded.LLMGateOnly || loaded.UserCredentials {
		t.Fatal("Gate-only switch rejected operator mode", loaded, err)
	}
}

func TestLLMGateOnlyOperatorWorkerClaim(t *testing.T) {
	c := testConfig()
	c.LLMGateOnly = true
	c.UserCredentials = false
	if err := c.Validate(); err != nil {
		t.Fatal("Gate-only operator configuration rejected", err)
	}
	for _, runtime := range []string{runtimePI, runtimeOpenAIAgents} {
		t.Run(runtime, func(t *testing.T) {
			var claim any
			var workerPersonal any = false
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, 200, map[string]any{
					"ready": true, "llmgateOnly": claim, "userCredentials": workerPersonal,
					"provider": "llmgate", "model": "gate-model",
					"models": []map[string]any{{"id": "gate-model", "provider": "llmgate", "runtime": runtime}},
				})
			}))
			defer worker.Close()
			c.PIURL, c.OpenAIAgentsURL = worker.URL, worker.URL
			c.PIToken, c.OpenAIAgentsToken = strings.Repeat("p", 32), strings.Repeat("o", 32)
			a := New(nil, c)
			for _, value := range []any{nil, false, "true"} {
				claim = value
				if _, err := a.probeRuntime(context.Background(), runtime); err == nil {
					t.Fatalf("Gate-only operator accepted worker claim %v", value)
				}
			}
			claim = true
			for _, mode := range []any{nil, true, "false"} {
				workerPersonal = mode
				if _, err := a.probeRuntime(context.Background(), runtime); err == nil {
					t.Fatalf("Gate-only operator accepted mismatched worker mode %v", mode)
				}
			}
			workerPersonal = false
			if _, err := a.probeRuntime(context.Background(), runtime); err != nil {
				t.Fatal("Gate-only operator rejected matching worker", err)
			}
		})
	}
}

// One malformed capability value must not take down a runtime's whole catalog, and every
// clearing records its reason. A boolean false, null or an absent key clears nothing.
func TestProbeClearsMalformedStructuredOutputWithoutFailingTheCatalog(t *testing.T) {
	for _, test := range []struct {
		name    string
		runtime string
		value   any
		absent  bool
		reason  string
	}{
		{"string", runtimeOpenAIAgents, "true", false, "malformed"},
		{"number", runtimeOpenAIAgents, 1, false, "malformed"},
		{"object", runtimeOpenAIAgents, map[string]any{}, false, "malformed"},
		{"pi-string", runtimePI, "true", false, "malformed"},
		{"wrong-runtime", runtimePI, true, false, "wrong_runtime"},
		{"false", runtimeOpenAIAgents, false, false, ""},
		{"null", runtimeOpenAIAgents, nil, false, ""},
		{"absent", runtimeOpenAIAgents, nil, true, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			model := map[string]any{"id": "m", "runtime": test.runtime, "maxContextTextBytes": 262144}
			if !test.absent {
				model["structuredOutput"] = test.value
			}
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, 200, map[string]any{"ready": true, "model": "m", "provider": "fixture", "models": []map[string]any{model}})
			}))
			defer worker.Close()
			c := testConfig()
			c.MetricsEnabled = true
			if test.runtime == runtimePI {
				c.PIURL, c.PIToken = worker.URL, strings.Repeat("p", 32)
			} else {
				c.OpenAIAgentsURL, c.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
			}
			a := New(nil, c)
			health, err := a.probeRuntime(context.Background(), test.runtime)
			if err != nil {
				t.Fatal("the catalog failed instead of clearing one capability", err)
			}
			if health.supportsStructuredOutput("m") {
				t.Fatal("a capability that is not a literal true on openai-agents survived")
			}
			for _, reason := range []string{"malformed", "wrong_runtime"} {
				want := float64(0)
				if reason == test.reason {
					want = 1
				}
				if got := collaborationMetric(t, a, "awwo_runtime_capabilities_cleared_total", "reason", reason); got != want {
					t.Fatal("cleared capability counter", reason, got, "wanted", want)
				}
			}
		})
	}
	// A catalog rejected for another reason reports no clearing, because none took effect.
	for name, models := range map[string][]map[string]any{
		"duplicate-id":    {{"id": "m", "runtime": runtimeOpenAIAgents, "structuredOutput": "true"}, {"id": "m", "runtime": runtimeOpenAIAgents}},
		"missing-default": {{"id": "other", "runtime": runtimeOpenAIAgents, "structuredOutput": "true"}},
	} {
		t.Run("rejected-"+name, func(t *testing.T) {
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, 200, map[string]any{"ready": true, "model": "m", "provider": "fixture", "models": models})
			}))
			defer worker.Close()
			c := testConfig()
			c.MetricsEnabled = true
			c.OpenAIAgentsURL, c.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
			a := New(nil, c)
			if _, err := a.probeRuntime(context.Background(), runtimeOpenAIAgents); err == nil {
				t.Fatal("an invalid catalog was accepted")
			}
			if got := collaborationMetric(t, a, "awwo_runtime_capabilities_cleared_total", "reason", "malformed"); got != 0 {
				t.Fatal("a rejected catalog counted a clearing", got)
			}
		})
	}
}

// Withdrawing the plain-text allowance rewrites only the server-owned policy block. An
// input value that quotes the allowance sentence reaches the model exactly as given.
func TestPromptAllowanceWithdrawalLeavesUserTextAlone(t *testing.T) {
	quoted := strings.TrimPrefix(plainTextAllowance, "\n")
	n := graphNode{ID: "only", Kind: "session", Title: "Only", Contract: &graphContract{Version: 1,
		Inputs:  []graphField{{ID: "brief", Label: "Brief", Type: "text", Value: quoted, Help: quoted}},
		Outputs: []graphField{{ID: "result", Type: "markdown", Required: true}}}}
	prompt, err := graphPrompt(n, graphDocument{Nodes: []graphNode{n}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	marker := strings.LastIndex(prompt, outputFormatMarker)
	if marker < 0 || strings.Count(prompt[:marker], plainTextAllowance) != 2 || !strings.Contains(prompt[marker:], plainTextAllowance) {
		t.Fatal("fixture does not quote the allowance in user text and in the policy", prompt)
	}
	withdrawn := withdrawPromptAllowance(prompt)
	cut := strings.LastIndex(withdrawn, outputFormatMarker)
	if withdrawn[:cut] != prompt[:marker] {
		t.Fatal("user text before the policy block was rewritten", withdrawn)
	}
	if strings.Contains(withdrawn[cut:], plainTextAllowance) || !strings.Contains(withdrawn[cut:], jsonOnlyPolicy) {
		t.Fatal("the policy block still allows plain text", withdrawn[cut:])
	}
	// A prompt without a policy block, such as a review turn, is returned unchanged.
	if withdrawPromptAllowance("plain"+plainTextAllowance) != "plain"+plainTextAllowance {
		t.Fatal("a prompt without a policy block was rewritten")
	}
}

// A snapshot that froze no contract, of a catalog without the capability, encodes no
// key for either. The rollback drain queries count exactly those keys, so a regression
// here would make every unconfigured in-flight run look contracted.
func TestSnapshotEncodingOmitsAbsentContractAndCapability(t *testing.T) {
	// Runtime is set explicitly: the decoder normalizes an absent runtime to Pi, so only an
	// explicit value round-trips byte for byte.
	snap := executionSnapshot{Runtime: runtimePI, Model: "m", Health: piHealth{Model: "m", Models: []piModel{{ID: "m"}}}}
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`"outputContract"`)) || bytes.Contains(raw, []byte(`"structuredOutput"`)) {
		t.Fatal("an unconfigured snapshot gained a contract or capability key", string(raw))
	}
	// A frozen capability survives a durable round trip through the lenient decoder
	// and re-encodes byte for byte.
	snap.Health.Models[0].StructuredOutput = true
	snap.OutputContract = &outputContract{Version: 1, Fields: []outputContractField{{ID: "answer", Type: "text", Required: true}}}
	raw, _ = json.Marshal(snap)
	var back executionSnapshot
	if err = json.Unmarshal(raw, &back); err != nil || !back.Health.supportsStructuredOutput("m") || back.OutputContract == nil {
		t.Fatal("a frozen snapshot did not survive decoding", err)
	}
	again, _ := json.Marshal(back)
	if !bytes.Equal(raw, again) {
		t.Fatal("a frozen snapshot re-encoded differently", string(raw), string(again))
	}
}

// The deployment switch, not the worker capability alone, decides whether a contract is
// frozen. Off, a capable model gets exactly the textual policy, including the plain-text
// allowance of a single text field. On, the allowance is withdrawn from the instructions
// and from the node prompt that repeats the policy.
func TestPostgresGraphStructuredOutputDeploymentSwitch(t *testing.T) {
	single := []graphField{{ID: "result", Type: "markdown", Required: true}}
	for _, test := range []struct {
		name     string
		on       bool
		reply    string
		contract bool
	}{
		{"switch-off", false, "DELIVERED", false},
		{"switch-on", true, `{"result":"DELIVERED"}`, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var mu sync.Mutex
			calls := []runtimeCall{}
			handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				mu.Lock()
				calls = append(calls, call)
				mu.Unlock()
				completePi(w, test.reply)
			}
			pi := runtimeProvider(t, runtimePI, handle)
			defer pi.Close()
			oa := structuredWorker(t, 0, handle)
			defer oa.Close()
			h := newHarness(t, pi.URL)
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
			h.a.cfg.StructuredContracts = test.on
			h.a.cfg.MetricsEnabled = true
			c, tid, _ := h.register(t, "structured-switch-"+test.name+"@example.test")
			base := structuredCanvas(t, h, c, tid, "Structured switch "+test.name, runtimeOpenAIAgents, "oa-default", single, nil)
			accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "structured-switch-" + test.name}, 202)
			awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "completed")
			want := float64(0)
			if test.on {
				want = 1
			}
			if got := collaborationMetric(t, h.a, "awwo_graph_output_contracts_total", "outcome", "frozen"); got != want {
				t.Fatal("frozen contract counter", got, "wanted", want)
			}
			var frozen int
			if err := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM runs WHERE tenant_id=$1 AND execution_snapshot ? 'outputContract')+(SELECT count(*) FROM graph_run_nodes WHERE tenant_id=$1 AND execution_snapshot ? 'outputContract')", tid).Scan(&frozen); err != nil {
				t.Fatal(err)
			}
			if (frozen > 0) != test.on {
				t.Fatal("snapshots carrying a contract", frozen, "switch", test.on)
			}
			mu.Lock()
			captured := append([]runtimeCall{}, calls...)
			mu.Unlock()
			if len(captured) != 1 {
				t.Fatal("expected exactly one worker call", len(captured))
			}
			call := captured[0]
			if call.ContractPresent != test.contract {
				t.Fatal("output contract presence", call.ContractPresent, "wanted", test.contract)
			}
			for field, text := range map[string]string{"system prompt": call.SystemPrompt, "prompt": call.Prompt} {
				if !strings.Contains(text, "Frozen graph output contract") {
					t.Fatal("the textual policy is missing from the "+field, text)
				}
				if strings.Contains(text, plainTextAllowance) == test.contract {
					t.Fatal("the plain-text allowance disagrees with the contract in the "+field, text)
				}
				if test.contract && !strings.Contains(text, jsonOnlyPolicy) {
					t.Fatal("the withdrawn allowance was not replaced by the JSON-only sentence in the "+field, text)
				}
			}
		})
	}
}

// personalWorker stands in for a personal-credential worker on either runtime: its
// health declares userCredentials so Go builds the catalogue from user_connections, and
// every admitted request body is kept verbatim so the userModel bytes can be compared.
type personalWorker struct {
	*httptest.Server
	mu     sync.Mutex
	bodies [][]byte
}

// newPersonalWorker stands in for a user-credential worker. flag is the raw JSON of its
// userStructuredOutput health claim, or "" for a worker that makes none (the Python worker
// and builds before the claim existed).
func newPersonalWorker(t *testing.T, reply, flag string) *personalWorker {
	t.Helper()
	p := &personalWorker{}
	health := `{"ready":true,"userCredentials":true}`
	if flag != "" {
		health = `{"ready":true,"userCredentials":true,"userStructuredOutput":` + flag + `}`
	}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, health)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		p.mu.Lock()
		p.bodies = append(p.bodies, raw)
		p.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		completePi(w, reply)
	}))
	return p
}

// take returns the single body admitted since the last call; more or fewer is a failure,
// because every scenario here must cost exactly one provider call.
func (p *personalWorker) take(t *testing.T) []byte {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.bodies) != 1 {
		t.Fatal("worker calls since the last check", len(p.bodies))
	}
	body := p.bodies[0]
	p.bodies = nil
	return body
}

// mockPersonalProviders answers model discovery for the three providers this test
// connects, each on its own host and credential header, so the connections are real
// rows in user_connections rather than fixtures.
func mockPersonalProviders(t *testing.T, h *harness, key string) {
	t.Helper()
	h.a.cfg.UserCredentials = true
	h.a.cfg.CredentialKey = bytes.Repeat([]byte{3}, 32)
	h.a.client.Transport = personalTransport(func(r *http.Request) (*http.Response, error) {
		var body, credential string
		switch r.URL.Host {
		case "api.openai.com":
			body, credential = `{"data":[{"id":"gpt-test"}]}`, r.Header.Get("Authorization")
		case "api.clawhunt.site":
			body, credential = `{"data":[{"id":"gpt-test"},{"id":"test-chat-model"}]}`, r.Header.Get("Authorization")
		case "generativelanguage.googleapis.com":
			body, credential = `{"models":[{"name":"models/gemini-test","supportedGenerationMethods":["generateContent"]}]}`, "Bearer "+r.Header.Get("x-goog-api-key")
		default:
			return http.DefaultTransport.RoundTrip(r)
		}
		status := 200
		if credential != "Bearer "+key {
			status, body = 401, `{"error":"rejected"}`
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
}

// In personal-credential mode the capability follows the connection's provider, and the
// API switch still decides whether anything is frozen. Off, every connection sends the
// same ten-field userModel it always has and nothing carries a contract. On, only an
// OpenAI connection freezes a contract and declares the eleventh field; a gateway or
// another vendor, even on the responses protocol, still freezes nothing and sends the
// ten fields. The runtime catalogue never shows the capability either way.
func TestPostgresPersonalStructuredDeliveryFollowsProviderAndSwitch(t *testing.T) {
	const key = "synthetic-personal-secret"
	single := []graphField{{ID: "result", Type: "markdown", Required: true}}
	type connection struct {
		provider, model, baseURL, protocol string
		capable                            bool
	}
	connections := []connection{
		{"openai", "gpt-test", "https://api.openai.com/v1", "responses", true},
		{"llmgate", "gpt-test", "https://api.clawhunt.site/v1", "responses", false},
		{"llmgate", "test-chat-model", "https://api.clawhunt.site/v1", "chat_completions", false},
		{"google", "gemini-test", "https://generativelanguage.googleapis.com/v1beta/openai", "chat_completions", false},
	}
	// The capability needs the switch, the worker's own claim and the provider. A worker that
	// makes no claim (the Python worker) or a malformed one leaves the switch inert: nothing is
	// frozen and the node runs as text instead of being refused at the worker.
	for _, mode := range []struct {
		name, flag string
		on         bool
	}{
		{"switch-off", "true", false},
		{"switch-on", "true", true},
		{"switch-on-worker-without-claim", "", true},
		{"switch-on-malformed-claim", `"yes"`, true},
	} {
		on, claimed := mode.on, mode.flag == "true"
		t.Run(mode.name, func(t *testing.T) {
			worker := newPersonalWorker(t, `{"result":"DELIVERED"}`, mode.flag)
			defer worker.Close()
			h := newHarness(t, worker.URL)
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
			h.a.cfg.StructuredContracts = on
			mockPersonalProviders(t, h, key)
			c, tid, _ := h.register(t, "personal-structured-"+mode.name+"@example.test")
			ids := map[string]string{}
			for _, provider := range []string{"openai", "llmgate", "google"} {
				v := h.request(t, c, "POST", "/auth/connections", map[string]any{"provider": provider, "runtime": runtimeOpenAIAgents, "apiKey": key, "name": "Work"}, 201)
				ids[provider] = v["id"].(string)
			}
			catalogue, _ := json.Marshal(h.request(t, c, "GET", "/tenants/"+tid+"/runtime", nil, 200))
			if bytes.Contains(catalogue, []byte("structuredOutput")) {
				t.Fatal("the runtime catalogue exposed the capability", string(catalogue))
			}
			ctx := context.Background()
			frozenSoFar := 0
			for i, conn := range connections {
				selector := connectionModelID(ids[conn.provider], conn.model)
				frozen := on && claimed && conn.capable
				base := structuredCanvas(t, h, c, tid, fmt.Sprintf("Personal %s %s", conn.provider, conn.model), runtimeOpenAIAgents, selector, single, nil)
				accepted := h.request(t, c, "POST", base, map[string]string{"operationId": fmt.Sprintf("personal-structured-%s-%d", mode.name, i)}, 202)
				awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "completed")
				var request map[string]json.RawMessage
				if err := json.Unmarshal(worker.take(t), &request); err != nil {
					t.Fatal(err)
				}
				if _, contract := request["outputContract"]; contract != frozen {
					t.Fatal(conn.provider, conn.model, "switch", on, "contract sent", contract, "wanted", frozen)
				}
				// The ten fields, in the byte order json.Marshal gives a map, exactly as every
				// personal run sent them before the capability existed.
				want := fmt.Sprintf(`{"apiKey":%q,"baseURL":%q,"contextWindow":32768,"defaultReasoningEffort":"","id":%q,"maxTokens":4096,"model":%q,"protocol":%q,"provider":%q,"reasoningEfforts":[]}`, key, conn.baseURL, selector, conn.model, conn.protocol, conn.provider)
				if frozen {
					want = strings.TrimSuffix(want, "}") + `,"structuredOutput":true}`
				}
				if got := string(request["userModel"]); got != want {
					t.Fatalf("%s %s switch %v userModel\n got %s\nwant %s", conn.provider, conn.model, on, got, want)
				}
				if frozen {
					frozenSoFar++
				}
				var nodes, runs int
				if err := h.db.QueryRow(ctx, "SELECT (SELECT count(*) FROM graph_run_nodes WHERE tenant_id=$1 AND execution_snapshot ? 'outputContract'),(SELECT count(*) FROM runs WHERE tenant_id=$1 AND execution_snapshot ? 'outputContract')", tid).Scan(&nodes, &runs); err != nil {
					t.Fatal(err)
				}
				if nodes != frozenSoFar || runs != frozenSoFar {
					t.Fatal(conn.provider, conn.model, "switch", on, "frozen snapshots", nodes, runs, "wanted", frozenSoFar)
				}
				// Every snapshot freezes the caller's whole catalogue, so unless the capability
				// holds no stored snapshot may carry the key at all: that is what keeps an
				// unconfigured deployment byte-identical.
				var capableNodes, capableRuns, total int
				if err := h.db.QueryRow(ctx, "SELECT (SELECT count(*) FROM graph_run_nodes WHERE tenant_id=$1 AND execution_snapshot::text LIKE '%structuredOutput%'),(SELECT count(*) FROM runs WHERE tenant_id=$1 AND execution_snapshot::text LIKE '%structuredOutput%'),(SELECT count(*) FROM runs WHERE tenant_id=$1)", tid).Scan(&capableNodes, &capableRuns, &total); err != nil {
					t.Fatal(err)
				}
				if _, noted := h.a.capabilityNotes.Load(runtimeOpenAIAgents + "\x00user-credentials\x00malformed"); noted != (mode.flag == `"yes"`) {
					t.Fatal(mode.name, "malformed worker claim recorded", noted)
				}
				if on && claimed {
					if capableRuns != total || capableNodes != total {
						t.Fatal(mode.name, "snapshots without the capability", capableNodes, capableRuns, "of", total)
					}
				} else if capableNodes != 0 || capableRuns != 0 {
					t.Fatal(mode.name, "a snapshot carried structuredOutput without the capability", capableNodes, capableRuns)
				}
				var leaked int
				if err := h.db.QueryRow(ctx, "SELECT count(*) FROM runs WHERE tenant_id=$1 AND (execution_snapshot::text LIKE '%userModel%' OR execution_snapshot::text LIKE '%'||$2||'%')", tid, key).Scan(&leaked); err != nil {
					t.Fatal(err)
				}
				if leaked != 0 {
					t.Fatal("a personal key or userModel reached a snapshot")
				}
			}
		})
	}
}

// personalAdmission declares the capability only on a request that already carries a
// contract, and only for a provider that has it: the same connection sends ten fields
// on a plain request and eleven on a frozen one, while a gateway connection sends ten
// even when a contract is present, leaving the worker to refuse it.
func TestPersonalAdmissionDeclaresCapabilityOnlyWithAFrozenContract(t *testing.T) {
	const key = "synthetic-personal-secret"
	worker := newPersonalWorker(t, "OK", "true")
	defer worker.Close()
	h := newHarness(t, worker.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = worker.URL, strings.Repeat("o", 32)
	mockPersonalProviders(t, h, key)
	c, tid, uid := h.register(t, "personal-admission@example.test")
	openai := h.request(t, c, "POST", "/auth/connections", map[string]any{"provider": "openai", "runtime": runtimeOpenAIAgents, "apiKey": key}, 201)["id"].(string)
	gateway := h.request(t, c, "POST", "/auth/connections", map[string]any{"provider": "llmgate", "runtime": runtimeOpenAIAgents, "apiKey": key}, 201)["id"].(string)
	cv, doc := setupFixture(t, h, c, tid, 1)
	doc["nodes"].([]any)[0].(map[string]any)["model"] = connectionModelID(openai, "gpt-test")
	doc["nodes"].([]any)[0].(map[string]any)["runtime"] = runtimeOpenAIAgents
	path := "/tenants/" + tid + "/canvases/" + cv
	h.request(t, c, "PUT", path, map[string]any{"version": 1, "name": "Personal", "document": doc}, 200)
	initialized := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 2}, 200)
	sid := setupNodeAt(initialized, 0)["issueId"].(string)
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "hello", "operationId": "personal-admission-1"}, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	worker.take(t)
	_ = uid
	contract := json.RawMessage(`{"version":1,"fields":[{"id":"result","type":"text","required":true}]}`)
	for _, test := range []struct {
		name       string
		connection string
		model      string
		contract   bool
		declared   bool
	}{
		{"openai-plain", openai, "gpt-test", false, false},
		{"openai-frozen", openai, "gpt-test", true, true},
		{"gateway-plain", gateway, "gpt-test", false, false},
		{"gateway-frozen", gateway, "gpt-test", true, false},
	} {
		request := map[string]any{"runId": run["id"], "tenantId": tid, "sessionId": sid, "model": connectionModelID(test.connection, test.model)}
		if test.contract {
			request["outputContract"] = contract
		}
		raw, _ := json.Marshal(request)
		admitted, err := h.a.personalAdmission(context.Background(), runtimeOpenAIAgents, raw)
		if err != nil {
			t.Fatal(test.name, err)
		}
		var fields map[string]json.RawMessage
		var userModel map[string]json.RawMessage
		if json.Unmarshal(admitted, &fields) != nil || json.Unmarshal(fields["userModel"], &userModel) != nil {
			t.Fatal(test.name, "unreadable admission", string(admitted))
		}
		if _, kept := fields["outputContract"]; kept != test.contract {
			t.Fatal(test.name, "contract key was added or dropped by admission")
		}
		value, declared := userModel["structuredOutput"]
		if declared != test.declared || (declared && string(value) != "true") {
			t.Fatal(test.name, "structuredOutput declared", declared, string(value), "wanted", test.declared)
		}
		if want := map[bool]int{false: 10, true: 11}[test.declared]; len(userModel) != want {
			t.Fatal(test.name, "userModel fields", len(userModel), "wanted", want)
		}
	}
}
