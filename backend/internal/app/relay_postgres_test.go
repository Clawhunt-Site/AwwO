package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRelayWorker is a relay worker: its health lists models and its calls at once (capacity, 16 unless set before its
// health is first read), and its managed-call route answers as answer says, keeping every body it was sent.
type fakeRelayWorker struct {
	*httptest.Server
	mu       sync.Mutex
	bodies   []map[string]any
	answer   func(w http.ResponseWriter, body map[string]any)
	capacity atomic.Int32
}

// relayHealth is a Pi worker's health as the relay worker's: its own default model first (an LLM Gate one, as a Pi
// worker's default always is), then its Bedrock models.
const relayHealth = `{"ready":true,"computerBedrock":true,"models":[
	{"id":"qwen3.8-27b-p6","name":"Qwen 3.8","provider":"llmgate","protocol":"chat_completions","contextWindow":131072,"maxOutputTokens":16384},
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
	f.capacity.Store(16)
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/health" {
			io.WriteString(w, strings.Replace(relayHealth, `"ready":true,`, `"ready":true,"maxConcurrency":`+strconv.Itoa(int(f.capacity.Load()))+`,`, 1))
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

const relayHello = `{"model":"bedrock.claude-opus-5-5","stream":true,"messages":[{"role":"user","content":"Hello"}]}`

// relayStreamed reads a streamed reply: the text its answer carried, its tool calls, its error frame's code, and whether
// it ended with [DONE].
func relayStreamed(t *testing.T, body string) (text string, tools int, errCode string, done bool) {
	t.Helper()
	for _, frame := range relayFrames(body) {
		data, ok := strings.CutPrefix(frame, "data: ")
		if !ok {
			continue
		}
		if data == "[DONE]" {
			done = true
			continue
		}
		var chunk struct {
			Error *struct {
				Code string `json:"code"`
			} `json:"error"`
			Choices []struct {
				Delta struct {
					Content   *string           `json:"content"`
					ToolCalls []json.RawMessage `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if e := json.Unmarshal([]byte(data), &chunk); e != nil {
			t.Fatalf("a frame that is not JSON: %q", data)
		}
		if chunk.Error != nil {
			errCode = chunk.Error.Code
		}
		for _, c := range chunk.Choices {
			if c.Delta.Content != nil {
				text += *c.Delta.Content
			}
			tools += len(c.Delta.ToolCalls)
		}
	}
	return text, tools, errCode, done
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	raw, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return string(raw)
}

func (h *harness) relayCount(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if e := h.db.QueryRow(context.Background(), sql, args...).Scan(&n); e != nil {
		t.Fatal(sql, e)
	}
	return n
}

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
	if h.relayCount(t, "SELECT count(*) FROM relay_keys WHERE id=$1 AND key_hash=$2", item["id"], tokenHash(key)) != 1 {
		t.Fatal("only the key's hash is kept")
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
	if h.relayCount(t, "SELECT count(*) FILTER (WHERE action='relay_key.created') FROM audit_events WHERE tenant_id=$1", tid) != 6 ||
		h.relayCount(t, "SELECT count(*) FILTER (WHERE action='relay_key.revoked') FROM audit_events WHERE tenant_id=$1", tid) != 1 {
		t.Fatal("audit")
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
	if h.relayCount(t, "SELECT count(*) FROM relay_keys WHERE key_hash=$1 AND last_used_at IS NOT NULL", tokenHash(key)) != 1 {
		t.Fatal("when it was last used")
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
	fresh := made["item"].(map[string]any)
	check(200, "list", made["key"].(string))
	// A key past its minute's requests is held off; so is an address that keeps sending keys that are not.
	for i := 0; i < relayRequestsPerMinute; i++ {
		h.a.relayLimits.requestAllowed(fresh["id"].(string))
	}
	check(429, "relay_rate_limited", made["key"].(string))
	h.a.relayLimits.keys = nil
	for i := 0; i <= relayFailuresPerMinute; i++ {
		h.a.relayLimits.lookupFailed("127.0.0.1")
	}
	check(429, "relay_rate_limited", made["key"].(string))
	h.a.relayLimits.failures = nil
	h.request(t, cookie, "DELETE", "/auth/relay-keys/"+fresh["id"].(string), nil, 204)
	check(401, "relay_key_invalid", made["key"].(string))
	// A revoked key a program still sends is refused, and never held against its address as a guess.
	for i := 0; i <= relayFailuresPerMinute+5; i++ {
		sendRelay(t, h, made["key"].(string), "GET", relayModelsRoute, "")
	}
	again := h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)
	check(200, "list", again["key"].(string))
}

func TestPostgresRelayKeyIsNeverMadeOnASessionThatEnded(t *testing.T) {
	h, _, cookie, tid, _ := relayHarness(t)
	var uid string
	if e := h.db.QueryRow(context.Background(), "SELECT user_id FROM auth_sessions WHERE token_hash=$1", tokenHash(cookie.Value)).Scan(&uid); e != nil {
		t.Fatal(e)
	}
	// The session ended after the request was let in (a password changed meanwhile, revoking the account's keys).
	execSQL(t, h, "DELETE FROM auth_sessions WHERE token_hash=$1", tokenHash(cookie.Value))
	r := httptest.NewRequest("POST", "/api/v1/auth/relay-keys", strings.NewReader(`{"tenantId":"`+tid+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(cookie)
	r = r.WithContext(context.WithValue(r.Context(), userKey{}, User{ID: uid}))
	w := httptest.NewRecorder()
	h.a.createRelayKey(w, r)
	if w.Code != 401 || h.relayCount(t, "SELECT count(*) FROM relay_keys WHERE user_id=$1", uid) != 1 {
		t.Fatal("a key made on a session that ended", w.Code, w.Body.String())
	}
}

func TestPostgresAKeyWhoseCallsKeepBeingRefusedIsHeldOff(t *testing.T) {
	h, worker, _, tid, key := relayHarness(t)
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"code":"INVALID_INPUT","detail":"completion:tool-name"}}`)
	})
	for i := 0; i <= relayRefusalsPerMinute; i++ {
		status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello)
		if _, _, errCode, _ := relayStreamed(t, body); status != 200 || errCode != "invalid_request" {
			t.Fatal("a call the worker refuses", i, status, body)
		}
	}
	if h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND cost_status='not_incurred'", tid) != relayRefusalsPerMinute+1 {
		t.Fatal("refused calls count nowhere")
	}
	sent := len(worker.sent())
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 429 || !strings.Contains(body, "relay_rate_limited") || len(worker.sent()) != sent {
		t.Fatal("a key whose calls keep being refused", status, body)
	}
	// It may still list its models.
	if status, _ := sendRelay(t, h, key, "GET", relayModelsRoute, ""); status != 200 {
		t.Fatal("the key's models", status)
	}
}

func TestPostgresRelayKeysEndWithTheirMembershipAndPassword(t *testing.T) {
	h, _, owner, tid, _ := relayHarness(t)
	member, _, _ := h.register(t, "relay-member@example.test")
	h.request(t, owner, "POST", "/tenants/"+tid+"/members", map[string]any{"email": "relay-member@example.test", "role": "member"}, 201)
	var memberID string
	h.db.QueryRow(context.Background(), "SELECT id FROM users WHERE email='relay-member@example.test'").Scan(&memberID)
	key := h.request(t, member, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)["key"].(string)
	if status, _ := sendRelay(t, h, key, "GET", relayModelsRoute, ""); status != 200 {
		t.Fatal("a member's key", status)
	}
	// Only reading now, then a member again: the key stays revoked.
	h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+memberID, map[string]any{"role": "reader"}, 204)
	h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+memberID, map[string]any{"role": "member"}, 204)
	if status, body := sendRelay(t, h, key, "GET", relayModelsRoute, ""); status != 401 || !strings.Contains(body, "relay_key_invalid") {
		t.Fatal("a member's key after reading only", status, body)
	}
	key = h.request(t, member, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)["key"].(string)
	h.request(t, owner, "DELETE", "/tenants/"+tid+"/members/"+memberID, nil, 204)
	if h.relayCount(t, "SELECT count(*) FROM relay_keys WHERE user_id=$1 AND revoked_at IS NULL", memberID) != 0 {
		t.Fatal("a member who leaves loses the workspace's keys")
	}
	// A password changed revokes every key of the account.
	ownKey := h.request(t, owner, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)["key"].(string)
	h.request(t, owner, "POST", "/auth/password", map[string]any{"currentPassword": "Strong password 123!", "newPassword": "Another strong password 456!"}, 204)
	if status, _ := sendRelay(t, h, ownKey, "GET", relayModelsRoute, ""); status != 401 {
		t.Fatal("a key after the password changed", status)
	}
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
		opus["prose_bytes_per_token"] != 3.4 || list.Data[1]["prose_bytes_per_token"] != 1.0 || list.Data[1]["name"] != "GLM-5" || len(opus["reasoning_efforts"].([]any)) != 0 {
		t.Fatal("models", list.Data)
	}
	if strings.Contains(body, "global.anthropic") {
		t.Fatal("the provider's own names stay here", body)
	}
	if strings.Contains(body, "qwen") {
		t.Fatal("the worker's own default model, which is not a Bedrock one, offered", body)
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
	status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, `{"model":"bedrock.claude-opus-5-5","stream":true,"max_tokens":500,"temperature":1,
		"messages":[{"role":"system","content":"Be brief"},{"role":"user","content":"Hello"}]}`)
	if text, _, errCode, done := relayStreamed(t, body); status != 200 || text != "Hello" || errCode != "" || !done || !strings.Contains(body, `"total_tokens":15`) {
		t.Fatalf("%d %q", status, body)
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
	if tracked, _ := h.a.trackedRelayCalls(); len(tracked) != 0 {
		t.Fatal("a call settled is let go")
	}
	// Refused by the worker as larger than its model reads, or by Bedrock at once for its own side: never counted. Its
	// refusal of the request, and a failure once the stream began, count.
	for _, c := range []struct{ answer, code, cost string }{
		{`{"error":{"code":"CONTEXT_LIMIT"}}`, "context_length_exceeded", "not_incurred"},
		{`{"error":{"code":"PROVIDER_ERROR","message":"secret provider words","reason":"bedrock:503:ServiceUnavailableException"}}`, "relay_model_failed", "not_incurred"},
		{`{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:400:ValidationException"}}`, "relay_model_failed", "unknown"},
		{`{"error":{"code":"PROVIDER_ERROR","reason":"stream:error:500:InternalServerException"}}`, "relay_model_failed", "unknown"},
	} {
		worker.answerWith(func(w http.ResponseWriter, _ map[string]any) {
			if strings.Contains(c.answer, "CONTEXT_LIMIT") {
				w.WriteHeader(413)
			} else {
				w.WriteHeader(502)
			}
			io.WriteString(w, c.answer)
		})
		status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello)
		if _, _, errCode, done := relayStreamed(t, body); status != 200 || errCode != c.code || done || strings.Contains(body, "secret") {
			t.Fatalf("%s: %d %q", c.answer, status, body)
		}
		if h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND status='failed' AND cost_status=$2", tid, c.cost) < 1 {
			t.Fatal("ledger of", c.answer)
		}
	}
	// What is refused before admission reaches neither the worker nor the ledger.
	before, rows := len(worker.sent()), h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid)
	for _, c := range []struct {
		body, code string
		status     int
	}{
		{`{"model":"bedrock.claude-opus-5-5","stream":true,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"x"}}]}]}`, "unsupported_content", 400},
		{`{"model":"bedrock.claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`, "stream_required", 400},
		{`{"model":"bedrock.claude-opus-5-5","stream":true,"messages":[{"role":"tool","tool_call_id":"c1","content":"x"}]}`, "invalid_request", 400},
		// What the worker's Converse bridge would refuse of a Bedrock model's call.
		{`{"model":"bedrock.claude-opus-5-5","stream":true,"tools":[{"type":"function","function":{"name":"fs.read","parameters":{"type":"object"}}}],"messages":[{"role":"user","content":"hi"}]}`, "invalid_request", 400},
		{`{"model":"bedrock.claude-opus-5-5","stream":true,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"there"}]}`, "invalid_request", 400},
		{`{"model":"nope","stream":true,"messages":[{"role":"user","content":"hi"}]}`, "model_not_found", 404},
		{`{"model":"broken","stream":true,"messages":[{"role":"user","content":"hi"}]}`, "model_not_found", 404},
		// The worker's own default model: not a Bedrock one, so never sent on.
		{`{"model":"qwen3.8-27b-p6","stream":true,"messages":[{"role":"user","content":"hi"}]}`, "model_not_found", 404},
		{`{"model":"bedrock.glm-5","stream":true,"messages":[{"role":"user","content":"` + strings.Repeat("x", 120000) + `"}]}`, "context_length_exceeded", 400},
		{`{"model":"bedrock.claude-opus-5-5","stream":true,"messages":[{"role":"user","content":"` + strings.Repeat("x", relayBodyLimit) + `"}]}`, "maximum context length: its request is larger than 504 KiB", 413},
	} {
		if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, c.body); status != c.status || !strings.Contains(body, c.code) {
			t.Error(c.code, status, body[:min(len(body), 300)])
		}
	}
	if len(worker.sent()) != before || h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid) != rows {
		t.Fatal("refused before admission")
	}
}

func TestPostgresRelayedCallStreamsWhileTheModelWorks(t *testing.T) {
	h, worker, _, _, key := relayHarness(t)
	saved := relayHeartbeat
	relayHeartbeat = 20 * time.Millisecond
	defer func() { relayHeartbeat = saved }()
	worker.answerWith(func(w http.ResponseWriter, body map[string]any) {
		time.Sleep(150 * time.Millisecond)
		io.WriteString(w, `{"completion":{"id":"chatcmpl-awwo-2","object":"chat.completion","created":1761300000,"model":"awwo-model","choices":[{"index":0,
			"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a\"}"}},
			{"id":"c2","type":"function","function":{"name":"read","arguments":"{\"path\":\"b\"}"}}]},"finish_reason":"tool_calls"}]},"observability":null}`)
	})
	call := func(parallel string) string {
		status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, `{"model":"bedrock.claude-opus-5-5","stream":true,"stream_options":{"include_usage":true},`+parallel+`
			"tools":[`+readTool+`],"messages":[{"role":"user","content":"Read a and b"}]}`)
		if status != 200 || !strings.HasPrefix(body, ": awwo relay\n\n") || !strings.Contains(body, ": keep-alive\n\n") || !strings.HasSuffix(body, "data: [DONE]\n\n") ||
			!strings.Contains(body, `"index":0`) || !strings.Contains(body, `"finish_reason":"tool_calls"`) || strings.Contains(body, `"usage"`) {
			t.Fatalf("%d %q", status, body)
		}
		return body
	}
	if _, tools, _, _ := relayStreamed(t, call("")); tools != 2 {
		t.Fatal("both tool calls", tools)
	}
	// The agents worker asks for one tool call at a time, and refuses an answer with two.
	if _, tools, _, _ := relayStreamed(t, call(`"parallel_tool_calls":false,`)); tools != 1 {
		t.Fatal("one tool call at a time", tools)
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
		_, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello)
		done <- body
	}()
	<-holding
	if tracked, _ := h.a.trackedRelayCalls(); len(tracked) != 1 || h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE id=$1 AND status='running'", tracked[0]) != 1 {
		t.Fatal("the call running is registered with this process's work", tracked)
	}
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 429 || !strings.Contains(body, "relay_busy") {
		t.Fatal("a second call at once", status, body)
	}
	close(release)
	if text, _, _, _ := relayStreamed(t, <-done); text != "first" {
		t.Fatal("the first call", text)
	}
	worker.answerWith(func(w http.ResponseWriter, _ map[string]any) { io.WriteString(w, relayCompletionReply("second")) })
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 200 || !strings.Contains(body, "second") {
		t.Fatal("the day's second call", status, body)
	}
	// Its daily total spent, the next call is refused as the hosted site refuses it, and told not to try again.
	r, _ := http.NewRequest("POST", h.server.URL+relayCompletionsRoute, strings.NewReader(relayHello))
	r.Header.Set("Authorization", "Bearer "+key)
	r.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 429 || !strings.Contains(string(raw), "quota_exceeded") || resp.Header.Get("x-should-retry") != "false" {
		t.Fatal("past the daily total", resp.StatusCode, string(raw), resp.Header)
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
			if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 200 || !strings.Contains(body, "held") {
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
	if h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND relay_key_id IS NOT NULL AND billed_user_id=$2 AND runtime='openai-agents' AND credit_reserve>0", tid, uid) != 3 {
		t.Fatal("charged to the plan, priced as the site prices the model")
	}
	// A model this site cannot price is refused under a plan rather than guessed at.
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, `{"model":"bedrock.glm-5","stream":true,"messages":[{"role":"user","content":"hi"}]}`); status != 503 || !strings.Contains(body, "model_unpriced") {
		t.Fatal("an unpriced model", status, body)
	}
}

func TestPostgresRelayedCallsAreHeldToWhatTheSiteCanTake(t *testing.T) {
	h, worker, _, tid, key := relayHarness(t)
	busy := func(why string) {
		t.Helper()
		if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 429 || !strings.Contains(body, "relay_busy") {
			t.Fatal(why, status, body)
		}
	}
	// A workspace past its relayed calls at once is refused at once, before it reaches the database.
	for i := 0; i < relayPerWorkspace; i++ {
		h.a.relayLimits.enter(tid)
	}
	busy("past the workspace's calls at once")
	for i := 0; i < relayPerWorkspace; i++ {
		h.a.relayLimits.leave(tid)
	}
	saved := relaySlotWait
	relaySlotWait = 300 * time.Millisecond
	defer func() { relaySlotWait = saved }()
	// No call is admitted past the relay worker's own calls at once (its health's maxConcurrency): it waits for one of
	// them, and is refused as busy when none frees in time, never reserved.
	capacity := int(worker.capacity.Load())
	for i := 0; i < capacity; i++ {
		h.a.relayLimits.take("elsewhere-"+strconv.Itoa(i), capacity)
	}
	busy("past the worker's calls at once")
	if len(worker.sent()) != 0 || h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid) != 0 {
		t.Fatal("a call admitted past the worker's calls at once")
	}
	// A workspace whose allowance is spent is told so at once, worker full or not, and told not to try again: its one call
	// of the day made while the worker was free, then the worker full again.
	for i := 0; i < capacity; i++ {
		h.a.relayLimits.give("elsewhere-" + strconv.Itoa(i))
	}
	execSQL(t, h, "UPDATE tenants SET max_runs_per_day=1 WHERE id=$1", tid)
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 200 || !strings.Contains(body, "Hello") {
		t.Fatal("the day's one call", status, body)
	}
	for i := 0; i < capacity; i++ {
		h.a.relayLimits.take("elsewhere-"+strconv.Itoa(i), capacity)
	}
	started := time.Now()
	r, _ := http.NewRequest("POST", h.server.URL+relayCompletionsRoute, strings.NewReader(relayHello))
	r.Header.Set("Authorization", "Bearer "+key)
	r.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 429 || !strings.Contains(string(raw), "quota_exceeded") || resp.Header.Get("x-should-retry") != "false" || time.Since(started) > relaySlotWait/2 {
		t.Fatal("a spent allowance while the worker is full", resp.StatusCode, string(raw), time.Since(started))
	}
	execSQL(t, h, "UPDATE tenants SET max_runs_per_day=1000 WHERE id=$1", tid)
	for i := 0; i < capacity; i++ {
		h.a.relayLimits.give("elsewhere-" + strconv.Itoa(i))
	}
	// A call waits for one of the site's places to be admitted in, which holds no database connection meanwhile, and is
	// refused as busy when none is free in time, never reserved.
	slots := h.a.relayLimits.admitting()
	for i := 0; i < relayAdmissions; i++ {
		slots <- struct{}{}
	}
	sent, rows := len(worker.sent()), h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid)
	started = time.Now()
	busy("no place to be admitted in")
	if time.Since(started) < relaySlotWait || len(worker.sent()) != sent || h.relayCount(t, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid) != rows {
		t.Fatal("a call that waited for its admission", time.Since(started))
	}
	<-slots
	if status, body := sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello); status != 200 || !strings.Contains(body, "Hello") {
		t.Fatal("a place freed", status, body)
	}
	for i := 1; i < relayAdmissions; i++ {
		<-slots
	}
}

func TestPostgresCallsWaitingForTheirWorkspaceLeaveTheWorkerToOthers(t *testing.T) {
	h, worker, _, first, firstKey := relayHarness(t)
	// A worker taking four calls at once, and two workspaces that run one call at once each: its first call holds the
	// worker, two more wait for it. Before, a waiting call held a place too, and the two filled the worker.
	worker.capacity.Store(4)
	saved := relaySlotWait
	relaySlotWait = 2 * time.Second
	defer func() { relaySlotWait = saved }()
	workspace := func() (string, string) {
		cookie, tid, _ := h.register(t, "relay-ws-"+strings.ToLower(randomID()[:6])+"@example.test")
		return tid, h.request(t, cookie, "POST", "/auth/relay-keys", map[string]any{"tenantId": tid}, 201)["key"].(string)
	}
	second, secondKey := workspace()
	third, thirdKey := workspace()
	for _, tid := range []string{first, second} {
		execSQL(t, h, "UPDATE tenants SET max_concurrent_runs=1 WHERE id=$1", tid)
	}
	release, holding := make(chan struct{}), make(chan struct{}, 2)
	var released sync.Once
	open := func() { released.Do(func() { close(release) }) }
	defer open() // a failure lets the calls held go, or the server's close would wait on them
	worker.answerWith(func(w http.ResponseWriter, body map[string]any) {
		if body["tenantId"] != third {
			// Told of the first two; those after the release go through.
			select {
			case holding <- struct{}{}:
			default:
			}
			<-release
		}
		io.WriteString(w, relayCompletionReply("answered"))
	})
	var calls sync.WaitGroup
	call := func(key string) {
		calls.Add(1)
		go func() { defer calls.Done(); sendRelay(t, h, key, "POST", relayCompletionsRoute, relayHello) }()
	}
	call(firstKey)
	call(secondKey)
	<-holding
	<-holding
	for i := 0; i < 2; i++ {
		call(firstKey)
		call(secondKey)
	}
	time.Sleep(300 * time.Millisecond)
	// A third workspace's call finds the worker free: the calls waiting for theirs hold none of its places.
	if status, body := sendRelay(t, h, thirdKey, "POST", relayCompletionsRoute, relayHello); status != 200 || !strings.Contains(body, "answered") {
		t.Fatal("another workspace's call while two wait for their own", status, body)
	}
	open()
	calls.Wait()
	h.a.relayLimits.mu.Lock()
	admitted, total := h.a.relayLimits.admitted, h.a.relayLimits.total
	h.a.relayLimits.mu.Unlock()
	if admitted != 0 || total != 0 {
		t.Fatal("every place given back", admitted, total)
	}
}

func TestPostgresTheSweepSettlesRelayedCallsLeftRunning(t *testing.T) {
	h, _, _, tid, _ := relayHarness(t)
	var keyID string
	h.db.QueryRow(context.Background(), "SELECT id FROM relay_keys WHERE tenant_id=$1", tid).Scan(&keyID)
	insert := func(id, key string, age string) {
		execSQL(t, h, `INSERT INTO model_invocations(id,tenant_id,run_id,status,admission_status,relay_key_id,created_at) VALUES($1,$2,$1,'running','unknown',NULLIF($3,''),now()-$4::interval)`, id, tid, key, age)
	}
	insert("rl-left", keyID, "5 minutes")
	insert("rl-young", keyID, "1 second")
	insert("rl-handled", keyID, "5 minutes")
	insert("run-call", "", "5 minutes")
	cancel := func() {}
	if !h.a.trackRelayCall("rl-handled", cancel) {
		t.Fatal("track")
	}
	defer h.a.untrackRelayCall("rl-handled")
	if e := h.a.sweepRelayCalls(context.Background()); e != nil {
		t.Fatal(e)
	}
	states := map[string]string{}
	rows, _ := h.db.Query(context.Background(), "SELECT id,status FROM model_invocations WHERE tenant_id=$1", tid)
	for rows.Next() {
		var id, status string
		rows.Scan(&id, &status)
		states[id] = status
	}
	rows.Close()
	if states["rl-left"] != "interrupted" || states["rl-young"] != "running" || states["rl-handled"] != "running" || states["run-call"] != "running" {
		t.Fatal("only a relayed call no handler holds, old enough, is settled", states)
	}
	// Only while this process holds the worker lock: a lock lost unseen, or seen, leaves the calls running to their own.
	insert("rl-later", keyID, "5 minutes")
	later := func() string {
		var status string
		h.db.QueryRow(context.Background(), "SELECT status FROM model_invocations WHERE id='rl-later'").Scan(&status)
		return status
	}
	held := h.a.leasePID
	h.a.leasePID = 0
	if e := h.a.sweepRelayCalls(context.Background()); e != nil || later() != "running" {
		t.Fatal("a sweep by a process whose connection does not hold the lock", e, later())
	}
	h.a.leasePID = held
	h.a.leaseLost.Store(true)
	if e := h.a.sweepRelayCalls(context.Background()); e != nil || later() != "running" {
		t.Fatal("a sweep by a process that lost its lock", e, later())
	}
	h.a.leaseLost.Store(false)
	if e := h.a.sweepRelayCalls(context.Background()); e != nil || later() != "interrupted" {
		t.Fatal("the lock held again", e, later())
	}
}

func TestRelayCallsAreRegisteredWithTheAPIsWork(t *testing.T) {
	a := New(nil, testConfig())
	stopped := false
	tracked := func() int {
		ids, running := a.trackedRelayCalls()
		if !running {
			t.Fatal("running")
		}
		return len(ids)
	}
	if !a.trackRelayCall("rl-1", func() { stopped = true }) || tracked() != 1 || a.running["relay:rl-1"] == nil {
		t.Fatal("registered")
	}
	a.running["relay:rl-1"]()
	a.untrackRelayCall("rl-1")
	if !stopped || tracked() != 0 {
		t.Fatal("cut and let go")
	}
	a.leaseLost.Store(true)
	if _, running := a.trackedRelayCalls(); running {
		t.Fatal("a process that lost its database lock is not running")
	}
	a.closed = true
	if a.trackRelayCall("rl-2", func() {}) {
		t.Fatal("a closing API takes no relayed call")
	}
}

func TestPostgresTheWebIsToldWhetherTheSiteRelays(t *testing.T) {
	h, _, cookie, _, _ := relayHarness(t)
	if me := h.request(t, cookie, "GET", "/auth/me", nil, 200); me["relay"] != true {
		t.Fatal("a relaying site says so", me["relay"])
	}
	h.a.cfg.Relay = false
	if me := h.request(t, cookie, "GET", "/auth/me", nil, 200); me["relay"] != nil {
		t.Fatal("a site that does not relay says nothing", me["relay"])
	}
}
