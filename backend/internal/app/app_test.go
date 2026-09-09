package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testConfig() Config {
	return Config{Env: "development", DatabaseURL: "postgres://localhost/test", ListenAddr: "127.0.0.1:0", PublicOrigin: "http://localhost:5189", PIURL: "http://localhost:8097", PIToken: strings.Repeat("s", 32), SessionTTL: time.Hour, RunTimeout: 10 * time.Second, MaxBodyBytes: 2 << 20, AuthRequestsPerMinute: 100}
}
func TestPasswordHash(t *testing.T) {
	a, b := hashPassword("correct password!"), hashPassword("correct password!")
	if a == b || strings.Contains(a, "correct") || !checkPassword("correct password!", a) || checkPassword("wrong", a) || checkPassword("x", "$argon2id$v=19$m=1,t=1,p=1$x$x") {
		t.Fatal("password hashing invariant failed")
	}
}
func TestConfigRequiresSecureDeployment(t *testing.T) {
	c := testConfig()
	if e := c.Validate(); e != nil {
		t.Fatal(e)
	}
	c.Env = "production"
	if c.Validate() == nil {
		t.Fatal("accepted non-HTTPS production origin")
	}
	c.PublicOrigin = "https://awwo.test"
	if e := c.Validate(); e != nil {
		t.Fatal(e)
	}
	c.PIToken = "short"
	if c.Validate() == nil {
		t.Fatal("accepted weak sidecar token")
	}
}
func TestSecurityAndRateLimit(t *testing.T) {
	c := testConfig()
	c.AuthRequestsPerMinute = 2
	a := New(nil, c)
	handler := a.security(a.authRate(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	req := func(origin string) int {
		r := httptest.NewRequest("POST", "/", nil)
		r.RemoteAddr = "192.0.2.1:1000"
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	if req("https://evil.test") != 403 || req(c.PublicOrigin) != 204 || req(c.PublicOrigin) != 204 || req(c.PublicOrigin) != 429 {
		t.Fatal("origin/rate limit failed")
	}
	a.leaseLost.Store(true)
	if req(c.PublicOrigin) != 503 {
		t.Fatal("lost lease must fail closed")
	}
}
func TestTrustedProxyIP(t *testing.T) {
	a := New(nil, testConfig())
	r := httptest.NewRequest("POST", "/", nil)
	r.RemoteAddr = "192.0.2.1:3000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if a.clientIP(r) != "192.0.2.1" {
		t.Fatal("untrusted forwarded header accepted")
	}
	a.cfg.TrustedProxyCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	r.RemoteAddr = "127.0.0.1:3000"
	if a.clientIP(r) != "203.0.113.9" {
		t.Fatal("trusted proxy IP not extracted")
	}
	r.Header.Set("X-Forwarded-For", "forged, 203.0.113.9")
	if a.clientIP(r) != "203.0.113.9" {
		t.Fatal("trusted chain interpretation failed")
	}
}

type harness struct {
	a      *App
	server *httptest.Server
	db     *pgxpool.Pool
	cfg    Config
}

func newHarness(t *testing.T, piURL string) *harness {
	t.Helper()
	dsn := os.Getenv("AWWO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("AWWO_TEST_DATABASE_URL absent; PostgreSQL integration not executed")
	}
	ctx := context.Background()
	base, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	schema := "awwo_test_" + strings.ToLower(strings.ReplaceAll(randomID(), "-", "_"))
	if _, e = base.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); e != nil {
		base.Close()
		t.Fatal(e)
	}
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	if e = Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	if e = Migrate(ctx, db); e != nil {
		t.Fatal("migration idempotence", e)
	}
	c := testConfig()
	c.PIURL = piURL
	a := New(db, c)
	if e = a.Start(ctx); e != nil {
		t.Fatal(e)
	}
	h := &harness{a: a, server: httptest.NewServer(a.Handler()), db: db, cfg: c}
	t.Cleanup(func() {
		h.server.Close()
		h.a.Close()
		db.Close()
		_, e := base.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
		if e != nil {
			t.Error(e)
		}
	})
	return h
}
func (h *harness) request(t *testing.T, cookie *http.Cookie, method, path string, body any, status int) map[string]any {
	t.Helper()
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	r, e := http.NewRequest(method, h.server.URL+"/api/v1"+path, bytes.NewReader(data))
	if e != nil {
		t.Fatal(e)
	}
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Fatalf("%s %s got %d want %d: %s", method, path, resp.StatusCode, status, raw)
	}
	out := map[string]any{}
	if len(raw) > 0 {
		if e = json.Unmarshal(raw, &out); e != nil {
			t.Fatalf("invalid json: %s", raw)
		}
	}
	return out
}
func (h *harness) register(t *testing.T, email string) (*http.Cookie, string, string) {
	t.Helper()
	raw, _ := json.Marshal(map[string]string{"email": email, "password": "Strong password 123!", "name": "Test", "tenantName": "Workspace"})
	r, _ := http.NewRequest("POST", h.server.URL+"/api/v1/auth/register", bytes.NewReader(raw))
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	r.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	var v struct {
		User    User `json:"user"`
		Tenants []struct {
			ID string `json:"id"`
		} `json:"tenants"`
	}
	if e = json.NewDecoder(resp.Body).Decode(&v); e != nil || resp.StatusCode != 201 {
		t.Fatalf("register status %d: %v", resp.StatusCode, e)
	}
	cookies := resp.Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("secure cookie attributes missing")
	}
	return cookies[0], v.Tenants[0].ID, v.User.ID
}
func (h *harness) login(t *testing.T, email string) *http.Cookie {
	t.Helper()
	raw, _ := json.Marshal(map[string]string{"email": email, "password": "Strong password 123!"})
	r, _ := http.NewRequest("POST", h.server.URL+"/api/v1/auth/login", bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		data, _ := io.ReadAll(resp.Body)
		t.Fatalf("login %d: %s", resp.StatusCode, data)
	}
	return resp.Cookies()[0]
}
func (h *harness) fixture(t *testing.T, c *http.Cookie, tid string) (canvas, agent, session string) {
	t.Helper()
	prefix := "/tenants/" + tid
	doc := map[string]any{"nodes": []map[string]string{{"id": "node-a"}}}
	cv := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Canvas", "document": doc}, 201)
	ag := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Writer", "adapterType": "pi", "adapterConfig": map[string]string{"model": "test-model"}, "instructions": "Use plain words"}, 201)
	ss := h.request(t, c, "POST", prefix+"/sessions", map[string]any{"canvasId": cv["id"], "nodeId": "node-a", "agentId": ag["id"], "title": "Thread"}, 201)
	return cv["id"].(string), ag["id"].(string), ss["id"].(string)
}
func (h *harness) awaitRun(t *testing.T, c *http.Cookie, tid, id, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		v := h.request(t, c, "GET", "/tenants/"+tid+"/runs/"+id, nil, 200)
		if v["status"] == want {
			return v
		}
		if v["terminal"] == true {
			t.Fatalf("unexpected terminal: %#v", v)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("run timeout waiting for " + want)
	return nil
}

func TestPostgresTenancyAuthenticationAndCAS(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	a, ta, ua := h.register(t, "owner-a@example.test")
	b, tb, ub := h.register(t, "owner-b@example.test")
	prefix := "/tenants/" + ta
	canvas, agent, session := h.fixture(t, a, ta)
	h.request(t, b, "GET", prefix+"/canvases/"+canvas, nil, 404)
	h.request(t, b, "GET", "/tenants/"+tb+"/canvases/"+canvas, nil, 404)
	h.request(t, b, "GET", "/tenants/"+tb+"/sessions/"+session+"/messages", nil, 404)
	h.request(t, a, "GET", "/admin/summary", nil, 403)
	h.request(t, b, "POST", "/tenants/"+tb+"/sessions", map[string]string{"canvasId": canvas, "nodeId": "node-a", "agentId": agent}, 404)
	h.request(t, a, "POST", prefix+"/sessions", map[string]string{"canvasId": canvas, "nodeId": "missing", "agentId": agent}, 404)
	doc := map[string]any{"nodes": []map[string]string{{"id": "node-a"}}, "custom": "persisted"}
	v := h.request(t, a, "PUT", prefix+"/canvases/"+canvas, map[string]any{"name": "Updated", "document": doc, "version": 1}, 200)
	if v["version"] != float64(2) {
		t.Fatal("version not incremented")
	}
	h.request(t, a, "PUT", prefix+"/canvases/"+canvas, map[string]any{"name": "stale", "document": doc, "version": 1}, 409)
	v = h.request(t, a, "GET", prefix+"/canvases/"+canvas, nil, 200)
	if v["document"].(map[string]any)["custom"] != "persisted" {
		t.Fatal("document not persisted")
	}
	h.request(t, a, "POST", prefix+"/members", map[string]string{"email": "owner-b@example.test", "role": "reader"}, 201)
	h.request(t, b, "GET", prefix+"/canvases/"+canvas, nil, 200)
	h.request(t, b, "PUT", prefix+"/canvases/"+canvas, map[string]any{"name": "no", "document": doc, "version": 2}, 403)
	h.request(t, b, "POST", prefix+"/members", map[string]string{"email": "owner-b@example.test", "role": "owner"}, 403)
	h.request(t, a, "PATCH", prefix+"/members/"+ua, map[string]string{"role": "member"}, 403)
	h.request(t, a, "PATCH", prefix+"/members/"+ub, map[string]string{"role": "admin"}, 204)
	h.request(t, b, "PATCH", prefix+"/members/"+ua, map[string]string{"role": "member"}, 403)
	h.request(t, a, "DELETE", prefix+"/members/"+ub, nil, 204)
	h.request(t, b, "GET", prefix+"/canvases", nil, 404)
	h.request(t, a, "POST", prefix+"/runs", map[string]string{"sessionId": session, "prompt": "hello", "operationId": "op-no-provider"}, 503)
	var stored string
	if e := h.db.QueryRow(context.Background(), "SELECT token_hash FROM auth_sessions WHERE user_id=$1", ua).Scan(&stored); e != nil || stored == a.Value || stored != tokenHash(a.Value) {
		t.Fatal("session token not hashed")
	}
	if e := h.db.QueryRow(context.Background(), "SELECT password_hash FROM users WHERE id=$1", ua).Scan(&stored); e != nil || !strings.HasPrefix(stored, "$argon2id$") {
		t.Fatal("password hash storage invalid")
	}
	h.request(t, nil, "POST", "/auth/register", map[string]string{"email": "evil@example.test", "password": "Strong password 123!", "name": "X", "tenantName": "X", "platformRole": "admin"}, 400)
	h.request(t, nil, "POST", "/auth/login", map[string]string{"email": "owner-a@example.test", "password": "incorrect"}, 401)
	h.request(t, a, "POST", "/auth/logout", nil, 204)
	h.request(t, a, "GET", "/auth/me", nil, 401)
	a = h.login(t, "owner-a@example.test")
	if _, e := h.db.Exec(context.Background(), "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", tokenHash(a.Value)); e != nil {
		t.Fatal(e)
	}
	h.request(t, a, "GET", "/auth/me", nil, 401)
}

func TestPostgresRunsSSEIdempotencyCancellationAndAdmin(t *testing.T) {
	var calls atomic.Int32
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("s", 32) {
			t.Error("missing Pi token")
			w.WriteHeader(401)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		calls.Add(1)
		var b struct {
			Prompt       string            `json:"prompt"`
			SystemPrompt string            `json:"systemPrompt"`
			Messages     []json.RawMessage `json:"messages"`
		}
		if e := json.NewDecoder(r.Body).Decode(&b); e != nil {
			t.Error(e)
		}
		if b.SystemPrompt != "Use plain words" {
			t.Error("saved agent instructions missing")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		if b.Prompt == "wait" {
			<-r.Context().Done()
			return
		}
		fmt.Fprint(w, "data: {\"type\":\"text_delta\",\"delta\":\"Hello\"}\n\ndata: {\"type\":\"completed\",\"text\":\"Hello\"}\n\n")
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	a, tid, _ := h.register(t, "runs@example.test")
	b, tb, _ := h.register(t, "outsider@example.test")
	canvas, _, sid := h.fixture(t, a, tid)
	prefix := "/tenants/" + tid
	body := map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "operation-1"}
	v := h.request(t, a, "POST", prefix+"/runs", body, 202)
	id := v["id"].(string)
	out := h.awaitRun(t, a, tid, id, "completed")
	if out["output"] != "Hello" || out["outputAvailable"] != true {
		t.Fatal("output not persisted")
	}
	v = h.request(t, a, "POST", prefix+"/runs", body, 200)
	if v["id"] != id || calls.Load() != 1 {
		t.Fatal("idempotency duplicated execution")
	}
	body["prompt"] = "different"
	h.request(t, a, "POST", prefix+"/runs", body, 409)
	v = h.request(t, a, "GET", prefix+"/runs?operationId=operation-1", nil, 200)
	if len(v["items"].([]any)) != 1 {
		t.Fatal("operation lookup failed")
	}
	h.request(t, b, "GET", "/tenants/"+tb+"/runs/"+id, nil, 404)
	h.request(t, b, "GET", "/tenants/"+tb+"/runs/"+id+"/events", nil, 404)
	msgs := h.request(t, a, "GET", prefix+"/sessions/"+sid+"/messages", nil, 200)["items"].([]any)
	if len(msgs) != 2 {
		t.Fatal("message persistence failed")
	}
	req, _ := http.NewRequest("GET", h.server.URL+"/api/v1"+prefix+"/runs/"+id+"/events", nil)
	req.AddCookie(a)
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	events, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !bytes.Contains(events, []byte(`"type": "completed"`)) || !bytes.Contains(events, []byte(`"delta": "Hello"`)) {
		t.Fatalf("missing durable events: %s", events)
	}
	var first int64
	fmt.Sscanf(string(events), "id: %d", &first)
	req, _ = http.NewRequest("GET", h.server.URL+"/api/v1"+prefix+"/runs/"+id+"/events", nil)
	req.AddCookie(a)
	req.Header.Set("Last-Event-ID", fmt.Sprint(first))
	resp, e = http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	events, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if bytes.HasPrefix(events, []byte(fmt.Sprintf("id: %d\n", first))) {
		t.Fatal("SSE replay repeated cursor")
	}
	waiting := map[string]string{"sessionId": sid, "prompt": "wait", "operationId": "operation-cancel"}
	v = h.request(t, a, "POST", prefix+"/runs", waiting, 202)
	waitID := v["id"].(string)
	h.awaitRun(t, a, tid, waitID, "running")
	h.request(t, a, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "second", "operationId": "operation-busy"}, 409)
	h.request(t, a, "DELETE", prefix+"/canvases/"+canvas, nil, 409)
	v = h.request(t, a, "POST", prefix+"/runs/"+waitID+"/cancel", nil, 200)
	if v["status"] != "cancelled" {
		t.Fatal("cancel not persisted")
	}
	h.awaitRun(t, a, tid, waitID, "cancelled")
	h.a.cfg.AdminEmail = "runs@example.test"
	h.a.cfg.AdminPassword = "Strong password 123!"
	if h.a.BootstrapAdmin(context.Background()) == nil {
		t.Fatal("bootstrap elevated existing customer")
	}
	h.a.cfg.AdminEmail = "admin@example.test"
	if e = h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	admin := h.login(t, "admin@example.test")
	h.request(t, admin, "GET", "/admin/summary", nil, 200)
	for _, kind := range []string{"tenants", "users", "runs", "audit"} {
		h.request(t, admin, "GET", "/admin/"+kind, nil, 200)
	}
	waiting["operationId"] = "operation-suspend"
	v = h.request(t, a, "POST", prefix+"/runs", waiting, 202)
	suspendID := v["id"].(string)
	h.awaitRun(t, a, tid, suspendID, "running")
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]string{"status": "suspended"}, 200)
	h.awaitRun(t, a, tid, suspendID, "cancelled")
	h.request(t, a, "POST", prefix+"/agents", map[string]string{"name": "new"}, 403)
	h.request(t, a, "GET", prefix+"/canvases", nil, 200)
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]any{"status": "active", "maxRunsPerDay": 1}, 200)
	waiting["operationId"] = "operation-quota"
	h.request(t, a, "POST", prefix+"/runs", waiting, 429)
	// Simulate a crashed worker: durable queued rows must become interrupted on restart.
	queued := randomID()
	_, e = h.db.Exec(context.Background(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,'operation-restart','hash','pending','queued')", queued, tid, sid)
	if e != nil {
		t.Fatal(e)
	}
	h.server.Close()
	h.a.Close()
	h.a = New(h.db, h.cfg)
	if e = h.a.Start(context.Background()); e != nil {
		t.Fatal(e)
	}
	h.server = httptest.NewServer(h.a.Handler())
	h.awaitRun(t, a, tid, queued, "interrupted")
	h.request(t, a, "GET", prefix+"/canvases/"+canvas, nil, 200)
}

func TestPlanSchemaAndHistoryBounds(t *testing.T) {
	valid := []string{`{"version":1,"summary":"Create","operations":[{"type":"add_node","ref":"api","templateId":"backend"}]}`, `{"version":1,"summary":"Ask","operations":[]}`, "```json\n{\"version\":1,\"summary\":\"Ask\",\"operations\":[]}\n```"}
	for _, v := range valid {
		if !validatePlan(v) {
			t.Fatalf("valid plan rejected: %s", v)
		}
	}
	invalid := []string{`{"version":1,"summary":"X","operations":[{"type":"add_node","ref":"api","templateId":"backend","binding":{"agentId":"hack"}}]}`, `{"version":1,"summary":"X","operations":[{"type":"exec","command":"whoami"}]}`, `{"version":1,"summary":"X","operations":[{"type":"add_field","nodeId":"n","side":"output","field":{"id":"a","label":"A","type":"text","required":false,"value":"fake output"}}]}`, `{"version":1,"summary":"X","operations":[{"type":"remove_node","nodeId":"__proto__"}]}`, `{"version":1,"summary":"X","operations":[{"type":"add_node","ref":"api","templateId":"backend"},{"type":"add_node","ref":"api","templateId":"backend"}]}`}
	for _, v := range invalid {
		if validatePlan(v) {
			t.Fatalf("unsafe plan accepted: %s", v)
		}
	}
	h := []json.RawMessage{json.RawMessage(`{"role":"user","content":"old"}`), json.RawMessage(`{"role":"assistant","content":"old reply"}`), json.RawMessage(`{"role":"user","content":"new"}`), json.RawMessage(`{"role":"assistant","content":"new reply"}`)}
	kept := boundedHistory(h, 262144-12)
	if len(kept) != 2 || !bytes.Contains(kept[0], []byte("new")) {
		t.Fatal("history must retain latest complete pair within budget")
	}
	if len(boundedHistory(h, 262144)) != 0 {
		t.Fatal("history budget exceeded")
	}
}
func TestPostgresPlannerAndConcurrentIdempotency(t *testing.T) {
	var calls atomic.Int32
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		calls.Add(1)
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		plan := `{"version":1,"summary":"Create backend","operations":[{"type":"add_node","ref":"api","templateId":"backend"}]}`
		if strings.Contains(b["prompt"].(string), "unsafe") {
			plan = `{"version":1,"summary":"X","operations":[{"type":"exec","command":"no"}]}`
		}
		event, _ := json.Marshal(map[string]string{"type": "completed", "text": plan})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", event)
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "planner@example.test")
	prefix := "/tenants/" + tid
	cv := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Empty", "document": map[string]any{"nodes": []any{}}}, 201)
	cid := cv["id"].(string)
	path := prefix + "/canvases/" + cid + "/plan"
	body := map[string]string{"prompt": "Build API", "context": "strict schema", "operationId": "planner-operation"}
	v := h.request(t, c, "POST", path, body, 202)
	id := v["id"].(string)
	h.awaitRun(t, c, tid, id, "completed")
	v = h.request(t, c, "POST", path, body, 200)
	if v["id"] != id || calls.Load() != 1 {
		t.Fatal("planner replay duplicated execution")
	}
	body["prompt"] = "unsafe"
	body["operationId"] = "planner-invalid"
	v = h.request(t, c, "POST", path, body, 202)
	v = h.awaitRun(t, c, tid, v["id"].(string), "failed")
	if v["error"] != "invalid_canvas_plan" {
		t.Fatal("invalid plan was not gated")
	}
	v = h.request(t, c, "GET", prefix+"/sessions", nil, 200)
	if len(v["items"].([]any)) != 0 {
		t.Fatal("internal planner sessions exposed in user list")
	}
	v = h.request(t, c, "GET", prefix+"/agents", nil, 200)
	if len(v["items"].([]any)) != 0 {
		t.Fatal("internal planner agent exposed in list")
	}
	v = h.request(t, c, "GET", prefix+"/canvases/"+cid, nil, 200)
	if len(v["document"].(map[string]any)["nodes"].([]any)) != 0 {
		t.Fatal("planner mutated graph before explicit apply")
	}
	body["prompt"] = "Build API"
	body["operationId"] = "concurrent-planning"
	type result struct {
		code int
		id   string
	}
	results := make(chan result, 4)
	for i := 0; i < 4; i++ {
		go func() {
			data, _ := json.Marshal(body)
			r, _ := http.NewRequest("POST", h.server.URL+"/api/v1"+path, bytes.NewReader(data))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", h.cfg.PublicOrigin)
			r.AddCookie(c)
			resp, e := http.DefaultClient.Do(r)
			if e != nil {
				results <- result{code: 0}
				return
			}
			defer resp.Body.Close()
			var v map[string]any
			json.NewDecoder(resp.Body).Decode(&v)
			id, _ := v["id"].(string)
			results <- result{resp.StatusCode, id}
		}()
	}
	same := ""
	for i := 0; i < 4; i++ {
		v := <-results
		if v.code != 200 && v.code != 202 {
			t.Fatalf("concurrent operation status %d", v.code)
		}
		if same == "" {
			same = v.id
		}
		if same == "" || same != v.id {
			t.Fatal("concurrent operation generated multiple run IDs")
		}
	}
	h.awaitRun(t, c, tid, same, "completed")
	if calls.Load() != 3 {
		t.Fatalf("concurrent operation executed more than once: %d", calls.Load())
	}
}

func TestPostgresRunFailuresAndStreamRevocation(t *testing.T) {
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		if b["prompt"] == "too large" {
			w.WriteHeader(413)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		if b["prompt"] == "wait" {
			<-r.Context().Done()
		} else if b["prompt"] == "inconsistent" {
			fmt.Fprint(w, "data: {\"type\":\"text_delta\",\"delta\":\"first\"}\n\ndata: {\"type\":\"completed\",\"text\":\"different\"}\n\n")
		}
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	h.a.reauthEvery = 20 * time.Millisecond
	c, tid, _ := h.register(t, "stream-owner@example.test")
	reader, _, rid := h.register(t, "stream-reader@example.test")
	_, _, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	for _, tc := range []struct{ prompt, code string }{{"too large", "context_limit"}, {"ends without completion", "runtime_stream_ended"}, {"inconsistent", "inconsistent_runtime_output"}} {
		v := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": tc.prompt, "operationId": randomID()}, 202)
		v = h.awaitRun(t, c, tid, v["id"].(string), "failed")
		if v["error"] != tc.code {
			t.Fatalf("failure classification: %#v", v)
		}
	}
	h.request(t, c, "POST", prefix+"/members", map[string]string{"email": "stream-reader@example.test", "role": "reader"}, 201)
	v := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "wait", "operationId": randomID()}, 202)
	runID := v["id"].(string)
	h.awaitRun(t, c, tid, runID, "running")
	req, _ := http.NewRequest("GET", h.server.URL+"/api/v1"+prefix+"/runs/"+runID+"/events", nil)
	req.AddCookie(reader)
	client := &http.Client{Timeout: time.Second}
	resp, e := client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	h.request(t, c, "DELETE", prefix+"/members/"+rid, nil, 204)
	_, e = io.ReadAll(resp.Body)
	resp.Body.Close()
	if e != nil {
		t.Fatal("SSE did not close when membership was revoked", e)
	}
	h.request(t, c, "POST", prefix+"/runs/"+runID+"/cancel", nil, 200)
}

func TestProviderContextBudgetAndUTF16History(t *testing.T) {
	health := piHealth{Limits: map[string]any{"maxContextTextBytes": float64(28416), "messageOverheadBytes": float64(32)}}
	budget, overhead := health.contextLimits()
	if budget != 28416 || overhead != 32 {
		t.Fatal("provider limits ignored")
	}
	history := []json.RawMessage{json.RawMessage(`{"role":"user","content":"previous"}`), json.RawMessage(`{"role":"assistant","content":"answer"}`)}
	if len(boundedHistoryWithLimits(history, 28416-32-63, budget, overhead)) != 0 {
		t.Fatal("message framing budget ignored")
	}
	if len(boundedHistoryWithLimits(history, 28416-32-100, budget, overhead)) != 2 {
		t.Fatal("valid recent pair discarded")
	}
	huge, _ := json.Marshal(map[string]string{"role": "assistant", "content": strings.Repeat("😀", 20000)})
	history[1] = huge
	if len(boundedHistoryWithLimits(history, 0, 262144, 0)) != 0 {
		t.Fatal("UTF-16 message size boundary not enforced")
	}
	raw := "```json\n{\"version\":1,\"summary\":\"Ask\",\"operations\":[]}\n```"
	if normalizePlanJSON(raw) != `{"version":1,"summary":"Ask","operations":[]}` {
		t.Fatal("planner JSON normalization failed")
	}
}

func TestPostgresContextLimitRejectsBeforeExecution(t *testing.T) {
	var calls atomic.Int32
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "limits": map[string]int{"maxContextTextBytes": 100, "messageOverheadBytes": 32}})
			return
		}
		calls.Add(1)
		w.WriteHeader(500)
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "budget@example.test")
	_, _, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	v := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": strings.Repeat("x", 100), "operationId": "budget-rejection"}, 413)
	if v["error"].(map[string]any)["code"] != "context_limit" || calls.Load() != 0 {
		t.Fatal("over-budget request was executed")
	}
	v = h.request(t, c, "GET", prefix+"/runs", nil, 200)
	if len(v["items"].([]any)) != 0 {
		t.Fatal("rejected run consumed quota")
	}
}

func TestPIAdmissionRetriesOnlyExplicitUnacceptedSession(t *testing.T) {
	for _, tc := range []struct {
		name, code           string
		status, wantAttempts int
	}{{"cleanup", "SESSION_BUSY", 409, 3}, {"duplicate-run", "RUN_BUSY", 409, 1}, {"unknown-conflict", "OTHER", 409, 1}, {"capacity", "CAPACITY_EXCEEDED", 429, 1}, {"accepted", "", 200, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			body := []byte(`{"runId":"same-run","sessionId":"same-session","prompt":"once"}`)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := calls.Add(1)
				got, _ := io.ReadAll(r.Body)
				if !bytes.Equal(got, body) {
					t.Error("retry changed the request")
				}
				if tc.code == "SESSION_BUSY" && n == 3 {
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(200)
					return
				}
				writeJSON(w, tc.status, map[string]any{"error": map[string]string{"code": tc.code}})
			}))
			defer server.Close()
			cfg := testConfig()
			cfg.PIURL = server.URL
			cfg.PIAdmissionWait = time.Second
			a := &App{cfg: cfg, client: server.Client()}
			resp, e := a.admitPI(context.Background(), body)
			if e != nil {
				t.Fatal(e)
			}
			resp.Body.Close()
			if int(calls.Load()) != tc.wantAttempts {
				t.Fatalf("attempts %d want %d", calls.Load(), tc.wantAttempts)
			}
		})
	}
}
func TestPIAdmissionWaitIsBoundedAndCancellable(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, 409, map[string]any{"error": map[string]string{"code": "SESSION_BUSY"}})
	}))
	defer server.Close()
	cfg := testConfig()
	cfg.PIURL = server.URL
	cfg.PIAdmissionWait = 110 * time.Millisecond
	a := &App{cfg: cfg, client: server.Client()}
	_, e := a.admitPI(context.Background(), []byte(`{}`))
	if !errors.Is(e, errSessionBusy) || calls.Load() != 2 {
		t.Fatalf("unbounded admission: %v attempts=%d", e, calls.Load())
	}
	before := calls.Load()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e = a.admitPI(ctx, []byte(`{}`))
	if !errors.Is(e, context.Canceled) || calls.Load() != before {
		t.Fatal("cancelled context retried")
	}
	var networkCalls int
	a.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		networkCalls++
		return nil, errors.New("uncertain network failure")
	})}
	_, e = a.admitPI(context.Background(), []byte(`{}`))
	if e == nil || networkCalls != 1 {
		t.Fatal("uncertain network request must never retry")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
