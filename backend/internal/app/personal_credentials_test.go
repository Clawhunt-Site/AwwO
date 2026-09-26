package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type personalTransport func(*http.Request) (*http.Response, error)

func (f personalTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCredentialVaultBindingAndConfig(t *testing.T) {
	c := testConfig()
	c.UserCredentials = true
	if c.Validate() == nil {
		t.Fatal("user mode accepted without vault key")
	}
	c.CredentialKey = bytes.Repeat([]byte{7}, 32)
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	a := New(nil, c)
	sealed, err := a.sealCredential("owner", "connection", "synthetic-personal-secret")
	if err != nil || bytes.Contains(sealed, []byte("synthetic-personal-secret")) {
		t.Fatal("not encrypted", err)
	}
	plain, err := a.openCredential("owner", "connection", sealed)
	if err != nil || plain != "synthetic-personal-secret" {
		t.Fatal("decrypt", err)
	}
	for _, pair := range [][2]string{{"other", "connection"}, {"owner", "other"}} {
		if _, err = a.openCredential(pair[0], pair[1], sealed); err == nil {
			t.Fatal("credential movable across identities")
		}
	}
	sealed[len(sealed)-1] ^= 1
	if _, err = a.openCredential("owner", "connection", sealed); err == nil {
		t.Fatal("tampered vault record accepted")
	}
}

func mockPersonalDiscovery(t *testing.T, h *harness) {
	t.Helper()
	h.a.cfg.UserCredentials = true
	h.a.cfg.CredentialKey = bytes.Repeat([]byte{3}, 32)
	h.a.client.Transport = personalTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.clawhunt.site" {
			return http.DefaultTransport.RoundTrip(r)
		}
		if r.URL.Path != "/v1/models" {
			t.Errorf("unexpected provider path %s", r.URL.Path)
		}
		status, body := 200, `{"data":[{"id":"test-chat-model"},{"id":"text-embedding-small"}]}`
		if r.Header.Get("Authorization") != "Bearer synthetic-personal-secret" {
			status = 401
			body = `{"error":"synthetic-personal-secret"}`
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
}

func TestPostgresLLMGateOnlyHidesAndRejectsDirectProviders(t *testing.T) {
	var gateClaim atomic.Bool
	gateClaim.Store(true)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("unexpected worker call %s", r.URL.Path)
			return
		}
		writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true, "llmgateOnly": gateClaim.Load()})
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.LLMGateOnly = true
	owner, _, uid := h.register(t, "gate-only@example.test")
	list := h.request(t, owner, "GET", "/auth/connections", nil, 200)
	providers := list["providers"].([]any)
	if len(providers) != 1 || providers[0].(map[string]any)["id"] != "llmgate" {
		t.Fatal("direct providers remained selectable", providers)
	}
	h.request(t, owner, "POST", "/auth/connections", map[string]any{
		"provider": "openai", "runtime": runtimeOpenAIAgents,
		"name": "Direct", "apiKey": "synthetic-personal-secret",
	}, 400)
	id := addPersonalConnection(t, h, owner)
	if _, err := h.db.Exec(context.Background(), "UPDATE user_connections SET provider='openai' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	list = h.request(t, owner, "GET", "/auth/connections", nil, 200)
	if len(list["items"].([]any)) != 1 {
		t.Fatal("legacy direct connection cannot be listed for deletion")
	}
	ctx := context.WithValue(context.Background(), userKey{}, User{ID: uid})
	var missing setupError
	if _, err := h.a.probeRuntime(ctx, runtimePI); !errors.As(err, &missing) || missing.code != "personal_engine_required" {
		t.Fatal("legacy direct connection satisfied Gate-only admission", err)
	}
	if _, err := h.db.Exec(context.Background(), "UPDATE user_connections SET provider='llmgate' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	if catalog, err := h.a.probeRuntime(ctx, runtimePI); err != nil || len(catalog.Models) == 0 || catalog.Models[0].Provider != "llmgate" {
		t.Fatal("Gate connection was not admitted", catalog, err)
	}
	gateClaim.Store(false)
	if _, err := h.a.probeRuntime(ctx, runtimePI); err == nil || !strings.Contains(err.Error(), "worker is unavailable") {
		t.Fatal("API accepted a worker without the Gate-only policy", err)
	}
}

func TestPostgresNodeSetupWithoutPersonalConnectionNamesMissingEngine(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		t.Errorf("unexpected worker call %s", r.URL.Path)
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	mockPersonalDiscovery(t, h)
	owner, tid, _ := h.register(t, "missing-engine@example.test")
	cid, _ := setupFixture(t, h, owner, tid, 1)
	rejected := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 409)
	if rejected["error"].(map[string]any)["code"] != "personal_engine_required" {
		t.Fatal("node setup did not identify the missing personal connection", rejected)
	}
}

func TestPostgresEmptySavedPersonalCatalogIsModelUnavailable(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		t.Errorf("unexpected worker call %s", r.URL.Path)
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	mockPersonalDiscovery(t, h)
	owner, _, uid := h.register(t, "empty-catalog@example.test")
	id := addPersonalConnection(t, h, owner)
	if _, err := h.db.Exec(t.Context(), "UPDATE user_connections SET models='[]'::jsonb WHERE id=$1 AND user_id=$2", id, uid); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), userKey{}, User{ID: uid})
	_, err := h.a.probeRuntime(ctx, runtimePI)
	input, ok := err.(setupError)
	if !ok || input.code != "model_unavailable" {
		t.Fatal("an existing connection with no models was mistaken for no connection", err)
	}
}

func TestPostgresMissingPersonalConnectionPrecedesWorkerOutage(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	mockPersonalDiscovery(t, h)
	_, _, uid := h.register(t, "missing-engine-worker-down@example.test")
	ctx := context.WithValue(t.Context(), userKey{}, User{ID: uid})
	_, err := h.a.probeRuntime(ctx, runtimePI)
	input, ok := err.(setupError)
	if !ok || input.code != "personal_engine_required" {
		t.Fatal("worker outage hid the missing personal connection", err)
	}
}

func TestPostgresPersonalConnectionNeverTransmitsAccountPassword(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	mockPersonalDiscovery(t, h)
	owner, _, uid := h.register(t, "autofill@example.test")
	password := "SyntheticAccountPassword123"
	if _, err := h.db.Exec(t.Context(), "UPDATE users SET password_hash=$2 WHERE id=$1", uid, hashPassword(password)); err != nil {
		t.Fatal(err)
	}
	h.a.client.Transport = personalTransport(func(r *http.Request) (*http.Response, error) {
		t.Error("account password reached a provider")
		return nil, nil
	})
	result := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "llmgate", "runtime": "pi", "apiKey": password}, 400)
	if result["error"].(map[string]any)["code"] != "account_password_as_key" {
		t.Fatal("missing account password guard", result)
	}
}
func addPersonalConnection(t *testing.T, h *harness, c *http.Cookie) string {
	t.Helper()
	v := h.request(t, c, "POST", "/auth/connections", map[string]any{"provider": "llmgate", "runtime": "pi", "apiKey": "synthetic-personal-secret", "name": "Work"}, 201)
	raw, _ := json.Marshal(v)
	if bytes.Contains(raw, []byte("synthetic-personal-secret")) {
		t.Fatal("response exposed key")
	}
	return v["id"].(string)
}

func TestPostgresPersonalCredentialsIsolationAndDispatch(t *testing.T) {
	received := make(chan map[string]any, 4)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid worker body")
		}
		received <- body
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"type\":\"completed\",\"text\":\"OK\"}\n\n")
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	mockPersonalDiscovery(t, h)
	owner, tid, uid := h.register(t, "personal-owner@example.test")
	other, _, _ := h.register(t, "personal-other@example.test")
	h.request(t, nil, "GET", "/auth/connections", nil, 401)
	h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "llmgate", "runtime": "pi", "apiKey": "wrong-personal-key"}, 422)
	h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "llmgate", "runtime": "pi", "apiKey": "synthetic-personal-secret", "baseURL": "http://127.0.0.1"}, 400)
	id := addPersonalConnection(t, h, owner)
	otherList := h.request(t, other, "GET", "/auth/connections", nil, 200)
	if len(otherList["items"].([]any)) != 0 {
		t.Fatal("cross-account catalog")
	}
	h.request(t, other, "DELETE", "/auth/connections/"+id, nil, 404)
	ctx := context.WithValue(context.Background(), userKey{}, User{ID: uid})
	health, err := h.a.probeRuntime(ctx, runtimePI)
	if err != nil || len(health.Models) != 1 {
		t.Fatal("personal catalog", health, err)
	}
	if _, err = h.a.probeRuntime(context.Background(), runtimePI); err == nil {
		t.Fatal("global credentials fell back")
	}
	selector := health.Models[0].ID
	addPersonalConnection(t, h, owner)
	catalog := h.request(t, owner, "GET", "/tenants/"+tid+"/runtime", nil, 200)["models"].([]any)
	if len(catalog) != 2 || catalog[0].(map[string]any)["label"] == catalog[1].(map[string]any)["label"] {
		t.Fatal("identically named paid connections are indistinguishable")
	}
	for _, v := range catalog {
		m := v.(map[string]any)
		if m["name"] != "test-chat-model" || !strings.Contains(m["label"].(string), "Work · llmgate /") {
			t.Fatal("provider identity or connection label lost")
		}
	}
	cv, doc := setupFixture(t, h, owner, tid, 1)
	doc["nodes"].([]any)[0].(map[string]any)["model"] = selector
	path := "/tenants/" + tid + "/canvases/" + cv
	h.request(t, owner, "PUT", path, map[string]any{"version": 1, "name": "Personal", "document": doc}, 200)
	initialized := h.request(t, owner, "POST", path+"/initialize", map[string]any{"documentVersion": 2}, 200)
	sid := setupNodeAt(initialized, 0)["issueId"].(string)
	run := h.request(t, owner, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "hello", "operationId": "personal-run-1"}, 202)
	h.awaitRun(t, owner, tid, run["id"].(string), "completed")
	select {
	case body := <-received:
		profile := body["userModel"].(map[string]any)
		if profile["apiKey"] != "synthetic-personal-secret" || profile["model"] != "test-chat-model" {
			t.Fatal("wrong worker credential")
		}
	case <-time.After(time.Second):
		t.Fatal("worker never called")
	}
	var stored []byte
	if err = h.db.QueryRow(context.Background(), "SELECT execution_snapshot FROM runs WHERE id=$1", run["id"]).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("synthetic-personal-secret")) || bytes.Contains(stored, []byte("userModel")) {
		t.Fatal("key persisted in snapshot")
	}
	request := map[string]any{"runId": run["id"], "tenantId": tid, "sessionId": sid, "model": selector}
	raw, _ := json.Marshal(request)
	if _, err = h.a.personalAdmission(context.Background(), runtimePI, raw); err != nil {
		t.Fatal("background admission depends on HTTP session", err)
	}
	request["sessionId"] = "other-session"
	invalid, _ := json.Marshal(request)
	if _, err = h.a.personalAdmission(context.Background(), runtimePI, invalid); err == nil {
		t.Fatal("mismatched session admitted")
	}
	otherID := addPersonalConnection(t, h, other)
	request["sessionId"] = sid
	request["model"] = connectionModelID(otherID, "test-chat-model")
	invalid, _ = json.Marshal(request)
	if _, err = h.a.personalAdmission(context.Background(), runtimePI, invalid); err == nil {
		t.Fatal("run actor could use another account's connection")
	}
	// Team turns have different persisted IDs and derived sessions. Verify real
	// async dispatch resolves all three to the parent's owner without HTTP context.
	team := fixtureTeam("sequential")
	for i := range team.Members {
		team.Members[i].Model = selector
	}
	teamDoc := initialized["document"].(map[string]any)
	teamDoc["nodes"].([]any)[0].(map[string]any)["team"] = team
	h.request(t, owner, "PUT", path, map[string]any{"name": "Personal", "version": initialized["version"], "document": teamDoc}, 200)
	teamCanvas := h.request(t, owner, "POST", path+"/initialize", map[string]any{"documentVersion": 4}, 200)
	teamSID := setupNodeAt(teamCanvas, 0)["issueId"].(string)
	teamRun := h.request(t, owner, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": teamSID, "prompt": "team task", "operationId": "personal-team-1"}, 202)
	h.awaitRun(t, owner, tid, teamRun["id"].(string), "completed")
	for range team.Members {
		select {
		case body := <-received:
			if body["userModel"].(map[string]any)["apiKey"] != "synthetic-personal-secret" || !strings.HasPrefix(body["sessionId"].(string), teamSID+"_") {
				t.Fatal("team credential/identity mismatch")
			}
		case <-time.After(time.Second):
			t.Fatal("team did not execute every member")
		}
	}
	h.request(t, owner, "DELETE", "/auth/connections/"+id, nil, 204)
	if _, err = h.a.personalAdmission(context.Background(), runtimePI, raw); err == nil {
		t.Fatal("removed key admitted")
	}
	rejected := h.request(t, owner, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": teamSID, "prompt": "hello again", "operationId": "personal-stale-model"}, 409)
	if rejected["error"].(map[string]any)["code"] != "model_unavailable" {
		t.Fatal("stale selector was not kept distinct from missing personal connections", rejected)
	}
	staleCanvas, staleDoc := setupFixture(t, h, owner, tid, 1)
	staleDoc["nodes"].([]any)[0].(map[string]any)["model"] = selector
	stalePath := "/tenants/" + tid + "/canvases/" + staleCanvas
	h.request(t, owner, "PUT", stalePath, map[string]any{"version": 1, "name": "Stale", "document": staleDoc}, 200)
	initialization := h.request(t, owner, "POST", stalePath+"/initialize", map[string]any{"documentVersion": 2}, 409)
	if initialization["error"].(map[string]any)["code"] != "model_unavailable" {
		t.Fatal("stale node selector was hidden as invalid setup", initialization)
	}
}

func TestPostgresPersonalAccountPasswordAndSessionRevocation(t *testing.T) {
	h := newHarness(t, "")
	c, _, _ := h.register(t, "password-owner@example.test")
	second := h.login(t, "password-owner@example.test")
	other, _, _ := h.register(t, "password-other@example.test")
	list := h.request(t, c, "GET", "/auth/sessions", nil, 200)["items"].([]any)
	if len(list) != 2 {
		t.Fatal("session inventory")
	}
	var otherSession string
	for _, v := range list {
		item := v.(map[string]any)
		if item["current"] == false {
			otherSession = item["id"].(string)
		}
	}
	h.request(t, other, "DELETE", "/auth/sessions/"+otherSession, nil, 404)
	h.request(t, c, "DELETE", "/auth/sessions/"+otherSession, nil, 204)
	h.request(t, second, "GET", "/auth/me", nil, 401)
	h.request(t, c, "POST", "/auth/password", map[string]string{"currentPassword": "incorrect", "newPassword": "New strong password 456!"}, 401)
	h.request(t, c, "POST", "/auth/password", map[string]string{"currentPassword": "Strong password 123!", "newPassword": "New strong password 456!"}, 204)
	h.request(t, c, "GET", "/auth/me", nil, 401)
	h.request(t, nil, "POST", "/auth/login", map[string]string{"email": "password-owner@example.test", "password": "Strong password 123!"}, 401)
	h.request(t, nil, "POST", "/auth/login", map[string]string{"email": "password-owner@example.test", "password": "New strong password 456!"}, 200)
}

func TestPostgresPasswordRecoveryIsSingleUseAndNoEmailEnumeration(t *testing.T) {
	h := newHarness(t, "")
	c, _, _ := h.register(t, "recovery@example.test")
	h.request(t, nil, "POST", "/auth/forgot-password", map[string]string{"email": "recovery@example.test"}, 503)
	links := make(chan string, 2)
	h.a.sendReset = func(ctx context.Context, email, link string) error { links <- link; return nil }
	known := h.request(t, nil, "POST", "/auth/forgot-password", map[string]string{"email": "recovery@example.test"}, 200)
	unknown := h.request(t, nil, "POST", "/auth/forgot-password", map[string]string{"email": "unknown@example.test"}, 200)
	if known["message"] != unknown["message"] {
		t.Fatal("email enumeration")
	}
	var link string
	select {
	case link = <-links:
	case <-time.After(time.Second):
		t.Fatal("no email")
	}
	parsed, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	token := parsed.Query().Get("reset")
	h.request(t, nil, "POST", "/auth/forgot-password", map[string]string{"email": "recovery@example.test"}, 200)
	select {
	case <-links:
		t.Fatal("email throttle failed")
	default:
	}
	h.request(t, nil, "POST", "/auth/reset-password", map[string]string{"token": token, "password": "New recovery password 456!"}, 204)
	h.request(t, c, "GET", "/auth/me", nil, 401)
	h.request(t, nil, "POST", "/auth/reset-password", map[string]string{"token": token, "password": "Another password 789!"}, 400)
	h.request(t, nil, "POST", "/auth/login", map[string]string{"email": "recovery@example.test", "password": "New recovery password 456!"}, 200)
}
