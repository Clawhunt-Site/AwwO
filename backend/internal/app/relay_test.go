package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRelaySettingsAreCheckedAtStart(t *testing.T) {
	on := func(edit func(*Config)) error {
		c := testConfig()
		c.Relay, c.RelayWorkerURL, c.RelayWorkerToken = true, "http://127.0.0.1:8099", strings.Repeat("r", 32)
		edit(&c)
		return c.Validate()
	}
	if e := on(func(*Config) {}); e != nil {
		t.Fatal("a loopback relay worker refused", e)
	}
	for name, edit := range map[string]func(*Config){
		"the local edition":    func(c *Config) { c.Edition, c.UserCredentials = editionLocal, true },
		"personal keys":        func(c *Config) { c.UserCredentials = true },
		"a remote worker":      func(c *Config) { c.RelayWorkerURL = "http://10.0.0.5:8099" },
		"https":                func(c *Config) { c.RelayWorkerURL = "https://127.0.0.1:8099" },
		"a path":               func(c *Config) { c.RelayWorkerURL = "http://127.0.0.1:8099/internal" },
		"credentials":          func(c *Config) { c.RelayWorkerURL = "http://user:pw@127.0.0.1:8099" },
		"a short token":        func(c *Config) { c.RelayWorkerToken = "short" },
		"a token with a space": func(c *Config) { c.RelayWorkerToken = strings.Repeat("r", 32) + " x" },
	} {
		if on(edit) == nil {
			t.Error("relay accepted with", name)
		}
	}
	off := testConfig()
	off.RelayWorkerURL = "http://127.0.0.1:8099"
	if off.Validate() == nil {
		t.Fatal("a relay worker without AWWO_RELAY=on accepted")
	}
	t.Setenv("AWWO_RELAY", "yes")
	if (&Config{}).relayFromEnv() == nil {
		t.Fatal("AWWO_RELAY=yes accepted")
	}
	t.Setenv("AWWO_RELAY", "on")
	t.Setenv("AWWO_RELAY_WORKER_URL", "http://127.0.0.1:8099")
	t.Setenv("AWWO_RELAY_WORKER_TOKEN", strings.Repeat("r", 32))
	var c Config
	if e := c.relayFromEnv(); e != nil || !c.Relay || c.RelayWorkerURL != "http://127.0.0.1:8099" || c.RelayWorkerToken != strings.Repeat("r", 32) {
		t.Fatal("relay settings", c.relaySettings, e)
	}
}

func TestRelayCallIsReadAsTheManagedRouteReadsIt(t *testing.T) {
	call, e := parseRelayCall([]byte(`{"model":"bedrock.claude-opus-5-5","stream":true,"temperature":0.2,"stream_options":{"include_usage":true},
		"max_tokens":4000,"max_completion_tokens":3000,"reasoning_effort":"high","tool_choice":"auto","parallel_tool_calls":true,
		"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],
		"messages":[{"role":"system","content":"Be brief <b>"},{"role":"user","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]},
		{"role":"assistant","content":null,"reasoning_content":"hidden","tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"c1","content":"done","name":"read"}]}`))
	if e != nil {
		t.Fatal(e)
	}
	if call.Model != "bedrock.claude-opus-5-5" || !call.Stream || call.MaxTokens != 3000 || len(call.Tools) != 1 || len(call.Messages) != 4 {
		t.Fatalf("call = %+v", call)
	}
	if call.Messages[1]["content"] != "one\ntwo" {
		t.Fatal("text parts are joined", call.Messages[1])
	}
	if _, kept := call.Messages[2]["reasoning_content"]; kept || call.Messages[2]["content"] != nil || call.Messages[2]["tool_calls"] == nil {
		t.Fatal("a message keeps its role, text, tool calls and tool call id alone", call.Messages[2])
	}
	if _, kept := call.Messages[3]["name"]; kept || call.Messages[3]["tool_call_id"] == nil {
		t.Fatal("a tool result", call.Messages[3])
	}
	body := string(relayForwardBody("rlx", "tenant", call.Model, call))
	for _, want := range []string{`"runId":"rlx"`, `"sessionId":"rlx"`, `"tenantId":"tenant"`, `"effort":""`, `"maxTokens":3000`, `Be brief <b>`, `"tools":[`} {
		if !strings.Contains(body, want) {
			t.Error("forwarded body lacks", want, body)
		}
	}
	if strings.Contains(body, "temperature") || strings.Contains(body, "reasoning_effort") || strings.Contains(body, "hidden") {
		t.Fatal("options the route passes over are not forwarded", body)
	}
	none, e := parseRelayCall([]byte(`{"model":"m","tool_choice":"none","tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],"messages":[{"role":"user","content":"hi"}]}`))
	if e != nil || len(none.Tools) != 0 || strings.Contains(string(relayForwardBody("rlx", "t", "m", none)), "tools") {
		t.Fatal("tool_choice none sends no tools", none, e)
	}
	for name, raw := range map[string]string{
		"a picture":        `{"model":"m","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:x"}}]}]}`,
		"a forced tool":    `{"model":"m","tool_choice":"required","messages":[{"role":"user","content":"hi"}]}`,
		"a named tool":     `{"model":"m","tool_choice":{"type":"function","function":{"name":"read"}},"messages":[{"role":"user","content":"hi"}]}`,
		"two choices":      `{"model":"m","n":2,"messages":[{"role":"user","content":"hi"}]}`,
		"a JSON answer":    `{"model":"m","response_format":{"type":"json_object"},"messages":[{"role":"user","content":"hi"}]}`,
		"no model":         `{"messages":[{"role":"user","content":"hi"}]}`,
		"no messages":      `{"model":"m","messages":[]}`,
		"a message's role": `{"model":"m","messages":[{"content":"hi"}]}`,
		"a zero limit":     `{"model":"m","max_tokens":0,"messages":[{"role":"user","content":"hi"}]}`,
		"not an object":    `[1]`,
	} {
		if _, e := parseRelayCall([]byte(raw)); e == nil {
			t.Error("accepted", name)
		}
	}
	if _, e := parseRelayCall([]byte(`{"model":"m","n":1,"response_format":{"type":"text"},"messages":[{"role":"user","content":"hi"}]}`)); e != nil {
		t.Fatal("one choice and a text answer are what is answered anyway", e)
	}
	var input relayInputError
	if _, e := parseRelayCall([]byte(`{"model":"m","messages":[{"role":"user","content":[{"type":"image_url"}]}]}`)); !errors.As(e, &input) || input.code != "unsupported_content" {
		t.Fatal("a picture's refusal", e)
	}
}

func TestRelayWorkerFailuresSayWhatTheCallerCanDo(t *testing.T) {
	now := time.Now()
	quick := func() *invocationFacts {
		return &invocationFacts{Admission: "unknown", Sent: now, Ended: now.Add(time.Second)}
	}
	cases := []struct {
		status          int
		body, errCode   string
		code, admission string
		callerStatus    int
	}{
		{413, `{"error":{"code":"CONTEXT_LIMIT"}}`, "context_length_exceeded", "computer_model_failed", "unknown", 400},
		{502, `{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:400:context_length_exceeded"}}`, "context_length_exceeded", "computer_model_failed", "rejected_before_start", 400},
		{400, `{"error":{"code":"INVALID_INPUT","detail":"completion:tool-name"}}`, "invalid_request", "computer_model_failed", "unknown", 400},
		{429, `{"error":{"code":"CAPACITY_EXCEEDED"}}`, "relay_busy", "computer_model_failed", "unknown", 503},
		{503, `{"error":{"code":"RUNTIME_UNAVAILABLE"}}`, "relay_unavailable", "computer_model_failed", "unknown", 503},
		{502, `{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:503:ServiceUnavailableException"}}`, "relay_model_failed", "computer_model_provider", "unknown", 502},
		{499, `{"error":{"code":"CANCELLED","reason":"timeout"}}`, "relay_model_failed", "computer_model_cut", "unknown", 502},
	}
	for _, c := range cases {
		facts := quick()
		f := relayWorkerFailure(c.status, []byte(c.body), nil, false, facts)
		if f.errCode != c.errCode || f.code != c.code || f.status != c.callerStatus || facts.Admission != c.admission {
			t.Errorf("%d %s: %+v, admission %s", c.status, c.body, f, facts.Admission)
		}
	}
	if f := relayWorkerFailure(400, []byte(`{"error":{"code":"INVALID_INPUT","detail":"completion:tool-name"}}`), nil, false, quick()); !strings.HasSuffix(f.message, "completion:tool-name") {
		t.Fatal("the worker's check is named", f.message)
	}
	if f := relayWorkerFailure(200, nil, errors.New("broke"), true, quick()); f.code != "computer_model_cut" || f.errCode != "relay_model_transport" {
		t.Fatal("an answer cut off", f)
	}
}

func TestRelayReplyStreamsTheAnswerAsChunks(t *testing.T) {
	w := httptest.NewRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	reply := beginRelayReply(ctx, w, true)
	reply.answer("bedrock.claude-opus-5-5", relayAnswer{ID: "chatcmpl-1", Created: 7, Finish: "tool_calls", Usage: json.RawMessage(`{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}`),
		Message: map[string]json.RawMessage{"role": json.RawMessage(`"assistant"`), "content": json.RawMessage(`null`),
			"tool_calls":        json.RawMessage(`[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}},{"id":"c2","type":"function","function":{"name":"read","arguments":"{}"}}]`),
			"reasoning_details": json.RawMessage(`[{"type":"reasoning.encrypted"}]`)}})
	cancel()
	reply.send(": late\n\n")
	out := w.Body.String()
	if w.Header().Get("Content-Type") != "text/event-stream; charset=utf-8" || !strings.HasPrefix(out, ": awwo relay\n\n") || !strings.HasSuffix(out, "data: [DONE]\n\n") {
		t.Fatalf("stream framing: %q", out)
	}
	if strings.Contains(out, "reasoning") || strings.Contains(out, "late") {
		t.Fatal("nothing past the answer, and nothing the worker keeps for its own executor", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n\n")
	if len(lines) != 4 {
		t.Fatalf("frames: %q", lines)
	}
	var chunk struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			Delta struct {
				Role      string `json:"role"`
				ToolCalls []struct {
					Index int    `json:"index"`
					ID    string `json:"id"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if e := json.Unmarshal([]byte(strings.TrimPrefix(lines[1], "data: ")), &chunk); e != nil || chunk.Object != "chat.completion.chunk" || chunk.Model != "bedrock.claude-opus-5-5" ||
		len(chunk.Choices) != 1 || chunk.Choices[0].Delta.Role != "assistant" || chunk.Choices[0].FinishReason != "tool_calls" ||
		len(chunk.Choices[0].Delta.ToolCalls) != 2 || chunk.Choices[0].Delta.ToolCalls[1].Index != 1 || chunk.Choices[0].Delta.ToolCalls[1].ID != "c2" {
		t.Fatalf("answer chunk %s: %+v %v", lines[1], chunk, e)
	}
	if !strings.Contains(lines[2], `"choices":[]`) || !strings.Contains(lines[2], `"total_tokens":5`) {
		t.Fatal("usage chunk", lines[2])
	}
	failed := httptest.NewRecorder()
	beginRelayReply(context.Background(), failed, true).fail(502, "relay_model_failed", "The model could not complete this call")
	if !strings.HasSuffix(failed.Body.String(), `data: {"error":{"code":"relay_model_failed","message":"The model could not complete this call","type":"relay_model_failed"}}`+"\n\n") {
		t.Fatalf("error frame: %q", failed.Body.String())
	}
	whole := httptest.NewRecorder()
	beginRelayReply(context.Background(), whole, false).answer("m", relayAnswer{ID: "chatcmpl-2", Finish: "stop", Message: map[string]json.RawMessage{"role": json.RawMessage(`"assistant"`), "content": json.RawMessage(`"hi"`)}})
	if whole.Code != 200 || !strings.Contains(whole.Body.String(), `"object":"chat.completion"`) || strings.Contains(whole.Body.String(), "usage") {
		t.Fatal("an answer read whole; no usage it was not given", whole.Body.String())
	}
}

func TestRelayedCallsAreBoundByTheManagedCallLimit(t *testing.T) {
	if requestDeadlineApplies(relayCompletionsRoute) || !requestDeadlineApplies(relayModelsRoute) || !requestDeadlineApplies("/api/v1/auth/relay-keys") {
		t.Fatal("only a relayed call outlives the request deadline")
	}
}

// fakeRelayWorker is a relay worker: its health lists models, and its managed-call route answers as answer says, keeping
// every body it was sent.
type fakeRelayWorker struct {
	*httptest.Server
	mu     sync.Mutex
	bodies []map[string]any
	answer func(w http.ResponseWriter, body map[string]any)
}

const relayHealth = `{"ready":true,"computerBedrock":true,"models":[
	{"id":"bedrock.claude-opus-5-5","name":"Claude Opus 5.5","provider":"bedrock","providerModel":"global.anthropic.claude-opus-5-5","protocol":"chat_completions","contextWindow":200000,"maxOutputTokens":32000,"proseBytesPerToken":3.4},
	{"id":"bedrock.glm-5","name":"GLM-5","provider":"bedrock","contextWindow":128000,"maxOutputTokens":16000},
	{"id":"broken","provider":"bedrock","contextWindow":1000,"maxOutputTokens":10}]}`

func relayCompletionReply(text string) string {
	return `{"completion":{"id":"chatcmpl-awwo-1","object":"chat.completion","created":1761300000,"model":"awwo-model","choices":[{"index":0,"message":{"role":"assistant","content":"` + text +
		`"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}},"observability":{"version":1,"usage":{"status":"reported","source":"provider_raw","inputTokens":12,"outputTokens":3,"cachedInputTokens":null,"cacheWriteTokens":null,"reasoningTokens":null,"providerTotalTokens":null,"computedTotalTokens":15},"timing":{"setupMs":0,"providerMs":5,"providerTtftMs":null,"workerTotalMs":6,"workerFirstDeltaMs":null}}}`
}

func newFakeRelayWorker(t *testing.T, token string) *fakeRelayWorker {
	f := &fakeRelayWorker{answer: func(w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, relayCompletionReply("Hello"))
	}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/health" {
			io.WriteString(w, relayHealth)
			return
		}
		if r.Method != "POST" || r.URL.Path != "/internal/computer-model" || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Content-Type") != "application/json" {
			http.Error(w, "unexpected", 418)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.bodies = append(f.bodies, body)
		answer := f.answer
		f.mu.Unlock()
		answer(w, body)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeRelayWorker) answerWith(answer func(w http.ResponseWriter, body map[string]any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answer = answer
}

func (f *fakeRelayWorker) sent() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any{}, f.bodies...)
}

// relayHarness is a site with the relay on, its worker fake, and an account with a key for its workspace.
func relayHarness(t *testing.T) (h *harness, worker *fakeRelayWorker, cookie *http.Cookie, tid, key string) {
	t.Helper()
	token := strings.Repeat("w", 32)
	worker = newFakeRelayWorker(t, token)
	h = newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.Relay, h.a.cfg.RelayWorkerURL, h.a.cfg.RelayWorkerToken = true, worker.URL, token
	cookie, tid, _ = h.register(t, "relay-"+strings.ToLower(randomID()[:8])+"@example.test")
	made := h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"name": "Laptop", "tenantId": tid}, 201)
	return h, worker, cookie, tid, made["key"].(string)
}

// sendRelay sends one relayed call as a program would (no Origin), returning its status and body.
func sendRelay(t *testing.T, h *harness, key, method, path, body string, header ...string) (int, string) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	r, e := http.NewRequest(method, h.server.URL+path, reader)
	if e != nil {
		t.Fatal(e)
	}
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

const relayHello = `{"model":"bedrock.claude-opus-5-5","messages":[{"role":"user","content":"Hello"}]}`

func TestPostgresRelayKeysAreMadeListedAndRevoked(t *testing.T) {
	h, _, cookie, tid, key := relayHarness(t)
	if !relayKeyPattern.MatchString(key) {
		t.Fatal("key form", key)
	}
	list := h.request(t, cookie, "GET", "/auth/relay-keys", nil, 200)
	items := list["items"].([]any)
	if len(items) != 1 || list["limit"] != 5.0 {
		t.Fatal("list", list)
	}
	item := items[0].(map[string]any)
	expires, _ := time.Parse(time.RFC3339Nano, item["expiresAt"].(string))
	if item["name"] != "Laptop" || item["prefix"] != key[:12] || item["tenant"].(map[string]any)["id"] != tid || item["lastUsedAt"] != nil ||
		expires.Before(time.Now().Add(89*24*time.Hour)) || expires.After(time.Now().Add(91*24*time.Hour)) {
		t.Fatal("item", item)
	}
	if strings.Contains(asJSON(t, list), key) {
		t.Fatal("a key is shown once, when it is made")
	}
	var stored string
	if e := h.db.QueryRow(context.Background(), "SELECT key_hash FROM relay_keys WHERE id=$1", item["id"]).Scan(&stored); e != nil || stored != tokenHash(key) {
		t.Fatal("only the key's hash is kept", e)
	}
	// Four more at most, then one has to go.
	for i := 0; i < 4; i++ {
		h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)
	}
	h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 409)
	h.request(t, cookie, "DELETE", "/auth/relay-keys/"+item["id"].(string), nil, 204)
	h.request(t, cookie, "DELETE", "/auth/relay-keys/"+item["id"].(string), nil, 404)
	made := h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)
	if made["item"].(map[string]any)["name"] != "AwwO 本地版" {
		t.Fatal("an unnamed key", made)
	}
	list = h.request(t, cookie, "GET", "/auth/relay-keys", nil, 200)
	if items = list["items"].([]any); len(items) != 6 || items[5].(map[string]any)["revokedAt"] == nil {
		t.Fatal("live keys first, then the revoked ones", items)
	}
	var created, revoked int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FILTER (WHERE action='relay_key.created'),count(*) FILTER (WHERE action='relay_key.revoked') FROM audit_events WHERE tenant_id=$1", tid).Scan(&created, &revoked); e != nil || created != 6 || revoked != 1 {
		t.Fatal("audit", created, revoked, e)
	}
	// Another account's workspace, a workspace it only reads, someone else's key: none of them.
	other, otherTenant, _ := h.register(t, "relay-other@example.test")
	h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": otherTenant}, 404)
	h.request(t, other, "DELETE", "/auth/relay-keys/"+made["item"].(map[string]any)["id"].(string), nil, 404)
	execSQL(t, h, "UPDATE memberships SET role='reader' WHERE tenant_id=$1", otherTenant)
	h.request(t, other, "POST", "/auth/relay-keys", map[string]any{"tenantId": otherTenant}, 404)
	h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid, "name": strings.Repeat("长", 81)}, 400)
	// Off, nothing of it answers.
	h.a.cfg.Relay = false
	h.request(t, cookie, "GET", "/auth/relay-keys", nil, 404)
	if status, _ := sendRelay(t, h, key, "GET", relayModelsRoute, ""); status != 404 {
		t.Fatal("relay off", status)
	}
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	raw, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return string(raw)
}

func TestPostgresRelayKeysWorkOnlyWhileTheirAccountMay(t *testing.T) {
	h, _, cookie, tid, key := relayHarness(t)
	check := func(status int, code string, k string, header ...string) {
		t.Helper()
		got, body := sendRelay(t, h, k, "GET", relayModelsRoute, "", header...)
		if got != status || !strings.Contains(body, `"`+code+`"`) {
			t.Fatalf("got %d %s, want %d %s", got, body, status, code)
		}
	}
	check(200, "list", key)
	check(401, "relay_key_invalid", "")
	check(401, "relay_key_invalid", "awwo_rk_"+strings.Repeat("x", 43))
	check(403, "relay_browser_refused", key, "Origin", h.cfg.PublicOrigin)
	check(403, "invalid_origin", key, "Origin", "https://elsewhere.test")
	var lastUsed *time.Time
	if e := h.db.QueryRow(context.Background(), "SELECT last_used_at FROM relay_keys WHERE key_hash=$1", tokenHash(key)).Scan(&lastUsed); e != nil || lastUsed == nil {
		t.Fatal("when it was last used", e)
	}
	execSQL(t, h, "UPDATE tenants SET status='suspended' WHERE id=$1", tid)
	check(403, "tenant_suspended", key)
	execSQL(t, h, "UPDATE tenants SET status='active' WHERE id=$1", tid)
	execSQL(t, h, "UPDATE memberships SET role='reader' WHERE tenant_id=$1", tid)
	check(403, "relay_key_forbidden", key)
	execSQL(t, h, "UPDATE memberships SET role='owner' WHERE tenant_id=$1", tid)
	execSQL(t, h, "UPDATE relay_keys SET created_at=now()-interval '100 days',expires_at=now()-interval '10 days' WHERE key_hash=$1", tokenHash(key))
	check(401, "relay_key_expired", key)
	made := h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)
	fresh := made["key"].(string)
	check(200, "list", fresh)
	h.request(t, cookie, "DELETE", "/auth/relay-keys/"+made["item"].(map[string]any)["id"].(string), nil, 204)
	check(401, "relay_key_invalid", fresh)
}

func TestPostgresRelayListsTheModelsTheWorkspaceMayUse(t *testing.T) {
	h, _, _, tid, key := relayHarness(t)
	status, body := sendRelay(t, h, key, "GET", relayModelsRoute, "")
	var list struct {
		Object string           `json:"object"`
		Data   []map[string]any `json:"data"`
	}
	if status != 200 || json.Unmarshal([]byte(body), &list) != nil || list.Object != "list" || len(list.Data) != 2 {
		t.Fatalf("%d %s", status, body)
	}
	opus := list.Data[0]
	if opus["id"] != "bedrock.claude-opus-5-5" || opus["name"] != "Claude Opus 5.5" || opus["context_window"] != 200000.0 || opus["max_output_tokens"] != 32000.0 ||
		opus["prose_bytes_per_token"] != 3.4 || list.Data[1]["prose_bytes_per_token"] != 1.0 || list.Data[1]["name"] != "GLM-5" {
		t.Fatal("models", list.Data)
	}
	if strings.Contains(body, "global.anthropic") {
		t.Fatal("the provider's own names stay here", body)
	}
	execSQL(t, h, "UPDATE tenants SET allowed_models='{bedrock.glm-5}' WHERE id=$1", tid)
	_, body = sendRelay(t, h, key, "GET", relayModelsRoute, "")
	if !strings.Contains(body, "bedrock.glm-5") || strings.Contains(body, "opus") {
		t.Fatal("the workspace's entitlement", body)
	}
	if status, body = sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 403 || !strings.Contains(body, "model_not_allowed") {
		t.Fatal("a model the workspace may not use", status, body)
	}
}

func TestPostgresRelayedCallRunsAsOneOfTheWorkspacesCalls(t *testing.T) {
	h, worker, _, tid, key := relayHarness(t)
	status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, `{"model":"bedrock.claude-opus-5-5","max_tokens":500,"temperature":1,
		"messages":[{"role":"system","content":"Be brief"},{"role":"user","content":"Hello"}]}`)
	var answer struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
	}
	if status != 200 || json.Unmarshal([]byte(body), &answer) != nil || answer.Object != "chat.completion" || answer.Model != "bedrock.claude-opus-5-5" ||
		len(answer.Choices) != 1 || answer.Choices[0].Message.Content != "Hello" || answer.Choices[0].FinishReason != "stop" || answer.Usage.TotalTokens != 15 {
		t.Fatalf("%d %s", status, body)
	}
	sent := worker.sent()
	if len(sent) != 1 || sent[0]["runId"] != sent[0]["sessionId"] || !strings.HasPrefix(sent[0]["runId"].(string), "rl") || sent[0]["tenantId"] != tid ||
		sent[0]["model"] != "bedrock.claude-opus-5-5" || sent[0]["effort"] != "" || sent[0]["maxTokens"] != 500.0 {
		t.Fatal("forwarded", sent)
	}
	var runID, statusRow, runtime, usage, keyHash string
	var input, output int
	if e := h.db.QueryRow(context.Background(), `SELECT mi.run_id,mi.status,mi.runtime,mi.usage_status,mi.input_tokens,mi.output_tokens,k.key_hash FROM model_invocations mi
		JOIN relay_keys k ON k.id=mi.relay_key_id WHERE mi.tenant_id=$1`, tid).Scan(&runID, &statusRow, &runtime, &usage, &input, &output, &keyHash); e != nil {
		t.Fatal(e)
	}
	if runID != sent[0]["runId"] || statusRow != "completed" || runtime != runtimePI || usage != "reported" || input != 12 || output != 3 || keyHash != tokenHash(key) {
		t.Fatal("ledger", runID, statusRow, runtime, usage, input, output)
	}
	// A call the worker refuses as larger than its model reads never counts; one its check refuses is the caller's to fix.
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
		w.WriteHeader(413)
		io.WriteString(w, `{"error":{"code":"CONTEXT_LIMIT","message":"The managed model request could not be completed."}}`)
	})
	if status, body = sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 400 || !strings.Contains(body, "context_length_exceeded") {
		t.Fatal("too long", status, body)
	}
	var notIncurred int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND status='failed' AND cost_status='not_incurred'", tid).Scan(&notIncurred); e != nil || notIncurred != 1 {
		t.Fatal("a refusal before any work costs nothing", notIncurred, e)
	}
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
		w.WriteHeader(502)
		io.WriteString(w, `{"error":{"code":"PROVIDER_ERROR","message":"secret provider words","reason":"bedrock:503:ServiceUnavailableException"}}`)
	})
	if status, body = sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 502 || !strings.Contains(body, "relay_model_failed") || strings.Contains(body, "secret") {
		t.Fatal("a provider's failure, by kind alone", status, body)
	}
	// What is refused before admission reaches neither the worker nor the ledger.
	before := len(worker.sent())
	for _, c := range []struct {
		body, code string
		status     int
	}{
		{`{"model":"bedrock.claude-opus-5-5","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"x"}}]}]}`, "unsupported_content", 400},
		{`{"model":"nope","messages":[{"role":"user","content":"hi"}]}`, "model_not_found", 404},
		{`{"model":"broken","messages":[{"role":"user","content":"hi"}]}`, "model_not_found", 404},
		{`{"model":"bedrock.claude-opus-5-5","messages":[{"role":"user","content":"` + strings.Repeat("x", relayBodyLimit) + `"}]}`, "body_too_large", 413},
	} {
		if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, c.body); status != c.status || !strings.Contains(body, c.code) {
			t.Error(c.code, status, body[:min(len(body), 300)])
		}
	}
	var rows int
	h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&rows)
	if len(worker.sent()) != before || rows != 3 {
		t.Fatal("refused before admission", len(worker.sent()), rows)
	}
}

func TestPostgresRelayedCallStreamsWhileTheModelWorks(t *testing.T) {
	h, worker, _, _, key := relayHarness(t)
	saved := relayHeartbeat
	relayHeartbeat = 20 * time.Millisecond
	defer func() { relayHeartbeat = saved }()
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
		time.Sleep(150 * time.Millisecond)
		io.WriteString(w, `{"completion":{"id":"chatcmpl-awwo-2","object":"chat.completion","created":1761300000,"model":"awwo-model","choices":[{"index":0,
			"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a\"}"}}]},"finish_reason":"tool_calls"}]},"observability":null}`)
	})
	status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, `{"model":"bedrock.claude-opus-5-5","stream":true,"stream_options":{"include_usage":true},
		"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],"messages":[{"role":"user","content":"Read a"}]}`)
	if status != 200 || !strings.HasPrefix(body, ": awwo relay\n\n") || !strings.Contains(body, ": keep-alive\n\n") || !strings.HasSuffix(body, "data: [DONE]\n\n") ||
		!strings.Contains(body, `"index":0`) || !strings.Contains(body, `"finish_reason":"tool_calls"`) || strings.Contains(body, `"usage"`) {
		t.Fatalf("%d %q", status, body)
	}
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
		w.WriteHeader(502)
		io.WriteString(w, `{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:500:InternalServerException"}}`)
	})
	status, body = sendRelay(t, h, key, "POST", relayCompletionsRoute, `{"model":"bedrock.claude-opus-5-5","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if status != 200 || !strings.Contains(body, `data: {"error":{"code":"relay_model_failed"`) || strings.Contains(body, "[DONE]") {
		t.Fatalf("a failure once the stream began is its error frame: %d %q", status, body)
	}
}

func TestPostgresRelayedCallsSpendTheWorkspacesAllowance(t *testing.T) {
	h, worker, _, tid, key := relayHarness(t)
	saved := relaySlotWait
	relaySlotWait = 300 * time.Millisecond
	defer func() { relaySlotWait = saved }()
	execSQL(t, h, "UPDATE tenants SET max_runs_per_day=2,max_concurrent_runs=1 WHERE id=$1", tid)
	// One call at once: a second waits for the first, then is refused as busy.
	release, holding := make(chan struct{}), make(chan struct{}, 1)
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
		holding <- struct{}{}
		<-release
		io.WriteString(w, relayCompletionReply("first"))
	})
	done := make(chan string, 1)
	go func() {
		status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello)
		done <- strings.TrimSpace(body) + " " + http.StatusText(status)
	}()
	<-holding
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 429 || !strings.Contains(body, "relay_busy") {
		t.Fatal("a second call at once", status, body)
	}
	close(release)
	if first := <-done; !strings.Contains(first, "first") || !strings.HasSuffix(first, "OK") {
		t.Fatal("the first call", first)
	}
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) { io.WriteString(w, relayCompletionReply("second")) })
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 200 {
		t.Fatal("the day's second call", status, body)
	}
	// Its daily total spent, the next call is refused as the hosted site refuses it.
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 429 || !strings.Contains(body, "quota_exceeded") {
		t.Fatal("past the daily total", status, body)
	}
}

func TestPostgresRelayedCallsTakeThePlansAgentsAtOnce(t *testing.T) {
	h, worker, _, tid, key := relayHarness(t)
	var err error
	if h.a.pricing, err = ParseModelPricing(planPricing); err != nil {
		t.Fatal(err)
	}
	saved := relaySlotWait
	relaySlotWait = 300 * time.Millisecond
	defer func() { relaySlotWait = saved }()
	execSQL(t, h, "UPDATE tenants SET route_limits=$2::jsonb WHERE id=$1", tid, planRoutes)
	var email string
	h.db.QueryRow(context.Background(), "SELECT u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=$1", tid).Scan(&email)
	now := time.Now()
	uid := givePlan(t, h, email, "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	release, holding := make(chan struct{}), make(chan struct{}, 3)
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
		holding <- struct{}{}
		<-release
		io.WriteString(w, relayCompletionReply("held"))
	})
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 200 {
				t.Error("a call within the plan's three at once", status, body)
			}
		}()
	}
	for i := 0; i < 3; i++ {
		<-holding
	}
	if used, e := accountSlotsUsed(context.Background(), h.db, uid); e != nil || used != 3 {
		t.Fatal("the relayed calls running take the plan's agents at once", used, e)
	}
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 429 || !strings.Contains(body, "relay_busy") {
		t.Fatal("a fourth call at once", status, body)
	}
	close(release)
	wg.Wait()
	var billed, reserved int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FILTER (WHERE billed_user_id=$2 AND runtime='openai-agents'),count(*) FILTER (WHERE credit_reserve>0) FROM model_invocations WHERE tenant_id=$1 AND relay_key_id IS NOT NULL", tid, uid).Scan(&billed, &reserved); e != nil || billed != 3 || reserved != 3 {
		t.Fatal("charged to the plan, priced as the site prices the model", billed, reserved, e)
	}
	// A model this site cannot price is refused under a plan rather than guessed at.
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, `{"model":"bedrock.glm-5","messages":[{"role":"user","content":"hi"}]}`); status != 503 || !strings.Contains(body, "model_unpriced") {
		t.Fatal("an unpriced model", status, body)
	}
}
