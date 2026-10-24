package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The cloud relay end to end on PostgreSQL (docs/awwo-cloud-relay.md): a hosted site with AWWO_LOCAL_RELAY=on, a fake
// Pi worker that serves /health and /internal/relay-model as apps/pi-worker/relay.mjs does, and, for the last test, an
// AwwO 本地版 API that links to that hosted site.

// fakeRelayPi answers as the Pi worker does: its health lists two Bedrock models, and a relayed call streams `chunks`,
// or refuses with `refuse` (status and body) before any stream, or hangs until its caller leaves. delay holds its answer
// back; failMid, an error frame, ends the stream after its first text.
type fakeRelayPi struct {
	refuse    func() (int, string)
	delay     atomic.Int64
	hang      atomic.Bool
	failMid   atomic.Value
	holdAfter atomic.Bool  // keep the stream open after [DONE] until its caller leaves
	failFirst atomic.Value // an error frame sent as the stream's only line
	fallback  atomic.Bool  // the stream is the model's other profile's (x-awwo-relay-fallback)
	calls     atomic.Int64
	lastRaw   atomic.Value
}

func (f *fakeRelayPi) server(t *testing.T) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("s", 32) {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/health":
			writeJSON(w, 200, map[string]any{"ready": true, "status": "ready", "relayBedrock": true, "model": "default", "models": []map[string]any{
				{"id": "bedrock.claude-opus-5-5", "name": "Claude Opus 5.5", "provider": "bedrock", "providerModel": "global.anthropic.claude-opus-5-5", "runtime": "pi",
					"contextWindow": 200000, "maxOutputTokens": 64000, "input": []string{"text", "image"}, "tools": true, "proseBytesPerToken": 2.15},
				{"id": "bedrock.deepseek-r1", "name": "DeepSeek R1", "provider": "bedrock", "providerModel": "us.deepseek.r1-v1:0", "runtime": "pi",
					"contextWindow": 128000, "maxOutputTokens": 32000, "input": []string{"text"}, "tools": false},
				{"id": "default", "name": "Default", "provider": "openai", "runtime": "pi", "contextWindow": 32768, "maxOutputTokens": 4096, "input": []string{"text"}},
			}})
		case "/internal/relay-model":
			f.calls.Add(1)
			raw, _ := io.ReadAll(r.Body)
			f.lastRaw.Store(raw)
			if d := f.delay.Load(); d > 0 {
				time.Sleep(time.Duration(d))
			}
			if f.refuse != nil {
				status, body := f.refuse()
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				io.WriteString(w, body)
				return
			}
			if f.hang.Load() {
				<-r.Context().Done()
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			if f.fallback.Load() {
				w.Header().Set("X-Awwo-Relay-Fallback", "1")
			}
			w.WriteHeader(200)
			if first, _ := f.failFirst.Load().(string); first != "" {
				fmt.Fprintf(w, "data: %s\n\n", first)
				return
			}
			for _, frame := range []string{
				`{"id":"x","object":"chat.completion.chunk","model":"global.anthropic.claude-opus-5-5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
				`{"id":"x","object":"chat.completion.chunk","model":"global.anthropic.claude-opus-5-5","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}`,
				`{"id":"x","object":"chat.completion.chunk","model":"global.anthropic.claude-opus-5-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
				`{"id":"x","object":"chat.completion.chunk","model":"global.anthropic.claude-opus-5-5","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":34,"prompt_tokens_details":{"cached_tokens":1000}}}`,
				`[DONE]`,
			} {
				if mid, _ := f.failMid.Load().(string); mid != "" && strings.HasSuffix(frame, `"finish_reason":"stop"}]}`) {
					fmt.Fprintf(w, "data: %s\n\n", mid)
					return
				}
				fmt.Fprintf(w, "data: %s\n\n", frame)
				w.(http.Flusher).Flush()
			}
			if f.holdAfter.Load() {
				<-r.Context().Done()
			}
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func relayHarness(t *testing.T, pi *fakeRelayPi) *harness {
	t.Helper()
	// Skipped before the fake worker listens, as newHarness would skip after it.
	if os.Getenv("AWWO_TEST_DATABASE_URL") == "" {
		t.Skip("AWWO_TEST_DATABASE_URL absent; PostgreSQL integration not executed")
	}
	interval := localLinkInterval
	localLinkInterval = 200 * time.Millisecond
	t.Cleanup(func() { localLinkInterval = interval })
	return newHarness(t, pi.server(t).URL, func(a *App) { a.cfg.LocalRelay = true })
}

// relayCall sends a request with no Origin, as AwwO 本地版's own services do.
func relayCall(t *testing.T, base, method, path, token string, body any, headers ...string) (*http.Response, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	r, e := http.NewRequest(method, base+"/api/v1"+path, reader)
	if e != nil {
		t.Fatal(e)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func relayErrorCode(t *testing.T, data []byte) string {
	t.Helper()
	var v struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &v) != nil {
		t.Fatalf("not an error body: %s", data)
	}
	return v.Error.Code
}

// linkFor runs a whole link for the owner of tid: start, approve, exchange. It returns the token and the link's id.
func linkFor(t *testing.T, h *harness, owner *http.Cookie, tid string) (string, string) {
	t.Helper()
	resp, data := relayCall(t, h.server.URL, "POST", "/local-links/start", "", map[string]string{"deviceName": "AwwO 本地版 · Mac"})
	if resp.StatusCode != 201 {
		t.Fatalf("start %d: %s", resp.StatusCode, data)
	}
	var started struct{ DeviceCode, UserCode, VerificationURL string }
	_ = json.Unmarshal(data, &started)
	h.request(t, owner, "POST", "/local-links/approve", map[string]any{"userCode": started.UserCode, "tenantId": tid, "confirmed": true}, 200)
	resp, data = relayCall(t, h.server.URL, "POST", "/local-links/token", "", map[string]string{"deviceCode": started.DeviceCode})
	if resp.StatusCode != 200 {
		t.Fatalf("token %d: %s", resp.StatusCode, data)
	}
	var grant struct{ Token, LinkID string }
	_ = json.Unmarshal(data, &grant)
	return grant.Token, grant.LinkID
}

func TestPostgresLocalLinkGrantsOneWorkspaceOnce(t *testing.T) {
	h := relayHarness(t, &fakeRelayPi{})
	a, ta, _ := h.register(t, "owner-a@example.test")
	b, _, _ := h.register(t, "other-b@example.test")
	resp, data := relayCall(t, h.server.URL, "POST", "/local-links/start", "", map[string]string{"deviceName": "AwwO 本地版 · Mac"})
	if resp.StatusCode != 201 {
		t.Fatalf("start %d: %s", resp.StatusCode, data)
	}
	var started struct {
		DeviceCode, UserCode, VerificationURL string
		ExpiresIn, Interval                   int
	}
	_ = json.Unmarshal(data, &started)
	if !deviceCodePattern.MatchString(started.DeviceCode) || !userCodePattern.MatchString(started.UserCode) || started.VerificationURL != h.cfg.PublicOrigin+"/?link="+started.UserCode || started.ExpiresIn != 900 {
		t.Fatalf("start answer: %s", data)
	}
	// Only hashes are kept.
	var kept int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM local_links WHERE device_hash=$1 AND token_hash IS NULL", tokenHash(started.DeviceCode)).Scan(&kept); e != nil || kept != 1 {
		t.Fatalf("stored link: %d %v", kept, e)
	}
	poll := func() (int, string) {
		resp, data := relayCall(t, h.server.URL, "POST", "/local-links/token", "", map[string]string{"deviceCode": started.DeviceCode})
		if resp.StatusCode == 200 {
			return 200, string(data)
		}
		return resp.StatusCode, relayErrorCode(t, data)
	}
	if status, code := poll(); status != 400 || code != "authorization_pending" {
		t.Fatalf("pending: %d %s", status, code)
	}
	if _, code := poll(); code != "slow_down" {
		t.Fatalf("a poll faster than the interval: %s", code)
	}
	waiting := h.request(t, a, "GET", "/local-links/pending/"+strings.ToLower(strings.ReplaceAll(started.UserCode, "-", "")), nil, 200)
	// The person sees the address that asked beside theirs: here one computer, so one network.
	if waiting["deviceName"] != "AwwO 本地版 · Mac" || waiting["requestIP"] != "127.0.0.1" || waiting["yourIP"] != "127.0.0.1" || waiting["sameNetwork"] != true || waiting["signInAgain"] != false {
		t.Fatalf("pending view: %v", waiting)
	}
	approve := func(c *http.Cookie, confirmed bool, status int) map[string]any {
		return h.request(t, c, "POST", "/local-links/approve", map[string]any{"userCode": started.UserCode, "tenantId": ta, "confirmed": confirmed}, status)
	}
	// The person confirms the code is their own computer's; another account cannot grant a workspace it is not a
	// member of; nor may a code be approved twice.
	if refused := approve(a, false, 400); refused["error"].(map[string]any)["code"] != "link_unconfirmed" {
		t.Fatalf("an unconfirmed approval: %v", refused)
	}
	approve(b, true, 404)
	approve(a, true, 200)
	approve(a, true, 404)
	var address *string
	if e := h.db.QueryRow(context.Background(), "SELECT request_ip FROM local_links WHERE device_hash=$1", tokenHash(started.DeviceCode)).Scan(&address); e != nil || address != nil {
		t.Fatalf("the address outlived the decision: %v %v", address, e)
	}
	time.Sleep(localLinkInterval)
	status, body := poll()
	if status != 200 {
		t.Fatalf("token: %d %s", status, body)
	}
	var grant struct {
		Token, LinkID string
		Workspace     struct{ ID, Name string }
	}
	_ = json.Unmarshal([]byte(body), &grant)
	if !linkTokenPattern.MatchString(grant.Token) || grant.Workspace.ID != ta {
		t.Fatalf("grant: %s", body)
	}
	time.Sleep(localLinkInterval)
	if _, code := poll(); code != "expired_token" {
		t.Fatalf("a second exchange: %s", code)
	}
	resp, data = relayCall(t, h.server.URL, "GET", "/relay/v1/models", grant.Token, nil)
	var list struct {
		Data []struct {
			ID   string `json:"id"`
			Awwo struct {
				ContextWindow, MaxOutputTokens int
				Tools                          bool
			} `json:"awwo"`
		} `json:"data"`
	}
	if resp.StatusCode != 200 || json.Unmarshal(data, &list) != nil || len(list.Data) != 2 || list.Data[0].ID != "bedrock.claude-opus-5-5" || !list.Data[0].Awwo.Tools || list.Data[0].Awwo.MaxOutputTokens != 64000 {
		t.Fatalf("models %d: %s", resp.StatusCode, data)
	}
	// The workspace's allowlist narrows what the relay offers it.
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET allowed_models=ARRAY['bedrock.claude-opus-5-5'] WHERE id=$1", ta); e != nil {
		t.Fatal(e)
	}
	_, data = relayCall(t, h.server.URL, "GET", "/relay/v1/models", grant.Token, nil)
	if strings.Contains(string(data), "deepseek") {
		t.Fatalf("a model the workspace may not use is offered: %s", data)
	}
	if resp, _ := relayCall(t, h.server.URL, "GET", "/relay/v1/models", grant.Token, nil, "Origin", h.cfg.PublicOrigin); resp.StatusCode != 403 {
		t.Fatalf("a browser's request with a token: %d", resp.StatusCode)
	}
	listed := h.request(t, a, "GET", "/local-links", nil, 200)
	if items := listed["items"].([]any); len(items) != 1 {
		t.Fatalf("listed: %v", listed)
	}
	h.request(t, b, "DELETE", "/local-links/"+grant.LinkID, nil, 404)
	h.request(t, a, "DELETE", "/local-links/"+grant.LinkID, nil, 204)
	if resp, data := relayCall(t, h.server.URL, "GET", "/relay/v1/models", grant.Token, nil); resp.StatusCode != 401 || relayErrorCode(t, data) != "invalid_api_key" {
		t.Fatalf("a revoked token: %d %s", resp.StatusCode, data)
	}
}

func TestPostgresLocalLinksEndWithTheMembershipAndThePassword(t *testing.T) {
	h := relayHarness(t, &fakeRelayPi{})
	owner, tid, _ := h.register(t, "owner@example.test")
	member, _, memberID := h.register(t, "member@example.test")
	join := func() {
		t.Helper()
		if _, e := h.db.Exec(context.Background(), "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", tid, memberID); e != nil {
			t.Fatal(e)
		}
	}
	join()
	token, _ := linkFor(t, h, member, tid)
	if resp, _ := relayCall(t, h.server.URL, "GET", "/relay/v1/models", token, nil); resp.StatusCode != 200 {
		t.Fatalf("a member's link: %d", resp.StatusCode)
	}
	// A membership gone by any way stops the link at its next call.
	if _, e := h.db.Exec(context.Background(), "DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, memberID); e != nil {
		t.Fatal(e)
	}
	if resp, data := relayCall(t, h.server.URL, "GET", "/relay/v1/models", token, nil); resp.StatusCode != 403 || relayErrorCode(t, data) != "workspace_unavailable" {
		t.Fatalf("a removed member's link: %d %s", resp.StatusCode, data)
	}
	// Removing a member, or making them a reader, ends their links to the workspace for good: a role given back later
	// gives no link back.
	join()
	removed, _ := linkFor(t, h, member, tid)
	h.request(t, owner, "DELETE", "/tenants/"+tid+"/members/"+memberID, nil, 204)
	join()
	if resp, data := relayCall(t, h.server.URL, "GET", "/relay/v1/models", removed, nil); resp.StatusCode != 401 || relayErrorCode(t, data) != "invalid_api_key" {
		t.Fatalf("a removed member's link came back: %d %s", resp.StatusCode, data)
	}
	reader, _ := linkFor(t, h, member, tid)
	h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+memberID, map[string]string{"role": "reader"}, 204)
	h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+memberID, map[string]string{"role": "member"}, 204)
	if resp, _ := relayCall(t, h.server.URL, "GET", "/relay/v1/models", reader, nil); resp.StatusCode != 401 {
		t.Fatalf("a member made a reader keeps a link: %d", resp.StatusCode)
	}
	// Making a member an admin keeps their link.
	kept, _ := linkFor(t, h, member, tid)
	h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+memberID, map[string]string{"role": "admin"}, 204)
	if resp, _ := relayCall(t, h.server.URL, "GET", "/relay/v1/models", kept, nil); resp.StatusCode != 200 {
		t.Fatalf("a member made an admin lost a link: %d", resp.StatusCode)
	}
	ownToken, _ := linkFor(t, h, owner, tid)
	h.request(t, owner, "POST", "/auth/password", map[string]string{"currentPassword": "Strong password 123!", "newPassword": "Another strong password 456!"}, 204)
	if resp, _ := relayCall(t, h.server.URL, "GET", "/relay/v1/models", ownToken, nil); resp.StatusCode != 401 {
		t.Fatalf("a changed password signs every device out, its links too: %d", resp.StatusCode)
	}
}

func TestPostgresLocalLinkApprovalNeedsAFreshSignInAndCanBeUndoneAtOnce(t *testing.T) {
	h := relayHarness(t, &fakeRelayPi{})
	owner, tid, uid := h.register(t, "owner@example.test")
	first, _ := linkFor(t, h, owner, tid)
	second, _ := linkFor(t, h, owner, tid)
	// A session someone took over long ago may not make a link that outlives it by months.
	if _, e := h.db.Exec(context.Background(), "UPDATE auth_sessions SET created_at=now()-interval '1 hour' WHERE user_id=$1", uid); e != nil {
		t.Fatal(e)
	}
	resp, data := relayCall(t, h.server.URL, "POST", "/local-links/start", "", map[string]string{"deviceName": "AwwO 本地版 · Windows"})
	if resp.StatusCode != 201 {
		t.Fatalf("start %d: %s", resp.StatusCode, data)
	}
	var started struct{ UserCode string }
	_ = json.Unmarshal(data, &started)
	if waiting := h.request(t, owner, "GET", "/local-links/pending/"+started.UserCode, nil, 200); waiting["signInAgain"] != true {
		t.Fatalf("a stale session is told to sign in again: %v", waiting)
	}
	refused := h.request(t, owner, "POST", "/local-links/approve", map[string]any{"userCode": started.UserCode, "tenantId": tid, "confirmed": true}, 403)
	if refused["error"].(map[string]any)["code"] != "sign_in_again" {
		t.Fatalf("a stale session's approval: %v", refused)
	}
	fresh := h.login(t, "owner@example.test")
	// A password change holding the account's row while an approval waits for it ends the approval with the session.
	tx, e := h.db.Begin(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(context.Background(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", uid); e != nil {
		t.Fatal(e)
	}
	approval := make(chan int, 1)
	go func() {
		raw, _ := json.Marshal(map[string]any{"userCode": started.UserCode, "tenantId": tid, "confirmed": true})
		r, _ := http.NewRequest("POST", h.server.URL+"/api/v1/local-links/approve", bytes.NewReader(raw))
		r.Header.Set("Origin", h.cfg.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(fresh)
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			approval <- 0
			return
		}
		resp.Body.Close()
		approval <- resp.StatusCode
	}()
	time.Sleep(300 * time.Millisecond)
	if _, e = tx.Exec(context.Background(), "DELETE FROM auth_sessions WHERE user_id=$1", uid); e == nil {
		e = revokeLocalLinks(context.Background(), tx, uid)
	}
	if e == nil {
		e = tx.Commit(context.Background())
	}
	if e != nil {
		t.Fatal(e)
	}
	if status := <-approval; status != 401 {
		t.Fatalf("an approval that waited for a password change: %d", status)
	}
	if h.rows(t, "SELECT count(*) FROM local_links WHERE user_code=$1 AND status='pending'", started.UserCode) != 1 {
		t.Fatal("the code was approved by an ended session")
	}
	fresh = h.login(t, "owner@example.test")
	h.request(t, fresh, "POST", "/local-links/approve", map[string]any{"userCode": started.UserCode, "tenantId": tid, "confirmed": true}, 200)
	// Disconnecting every computer at once ends every link, approved or issued. first and second were ended with the
	// sessions above; a third, ended by its own computer while its workspace is suspended, does not come back with it.
	third, _ := linkFor(t, h, fresh, tid)
	if _, e = h.db.Exec(context.Background(), "UPDATE tenants SET status='suspended' WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	if resp, data := relayCall(t, h.server.URL, "DELETE", "/relay/v1/link", third, nil); resp.StatusCode != 204 {
		t.Fatalf("a link to a suspended workspace ending itself: %d %s", resp.StatusCode, data)
	}
	if _, e = h.db.Exec(context.Background(), "UPDATE tenants SET status='active' WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	if resp, _ := relayCall(t, h.server.URL, "GET", "/relay/v1/models", third, nil); resp.StatusCode != 401 {
		t.Fatalf("a link ended while its workspace was suspended came back: %d", resp.StatusCode)
	}
	h.request(t, fresh, "DELETE", "/local-links", nil, 204)
	for _, token := range []string{first, second} {
		if resp, _ := relayCall(t, h.server.URL, "GET", "/relay/v1/models", token, nil); resp.StatusCode != 401 {
			t.Fatalf("a link outlived disconnecting every computer: %d", resp.StatusCode)
		}
	}
	var open int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM local_links WHERE user_id=$1 AND status IN ('approved','issued')", uid).Scan(&open); e != nil || open != 0 {
		t.Fatalf("links left: %d %v", open, e)
	}
}

// readRelayStream reads a relayed call's SSE answer: its data lines, and whether it held a comment line.
func readRelayStream(t *testing.T, body []byte) (data []string, comments int) {
	t.Helper()
	s := bufio.NewScanner(bytes.NewReader(body))
	for s.Scan() {
		line := s.Text()
		switch {
		case strings.HasPrefix(line, ":"):
			comments++
		case strings.HasPrefix(line, "data: "):
			data = append(data, strings.TrimPrefix(line, "data: "))
		}
	}
	return data, comments
}

func TestPostgresRelayedCallIsTheWorkspacesOwnInvocation(t *testing.T) {
	pi := &fakeRelayPi{}
	h := relayHarness(t, pi)
	owner, tid, _ := h.register(t, "owner@example.test")
	token, linkID := linkFor(t, h, owner, tid)
	request := map[string]any{"model": "bedrock.claude-opus-5-5", "stream": true, "max_tokens": 900, "messages": []map[string]string{{"role": "user", "content": "Say OK"}}}
	resp, body := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("relayed call %d: %s", resp.StatusCode, body)
	}
	data, _ := readRelayStream(t, body)
	if len(data) != 5 || data[4] != "[DONE]" || !strings.Contains(data[1], `"content":"OK"`) {
		t.Fatalf("stream: %q", data)
	}
	var sent struct {
		RelayID, TenantID, Model string
		Body                     map[string]any
	}
	_ = json.Unmarshal(pi.lastRaw.Load().([]byte), &sent)
	if sent.TenantID != tid || sent.Model != "bedrock.claude-opus-5-5" || sent.Body["max_tokens"] != float64(900) {
		t.Fatalf("what the worker got: %+v", sent)
	}
	var status, runID, provider, admission, usage string
	var in, out, cached int64
	var link *string
	if e := h.db.QueryRow(context.Background(), `SELECT status,run_id,provider,admission_status,usage_status,input_tokens,output_tokens,cached_input_tokens,relay_link_id
		FROM model_invocations WHERE tenant_id=$1 AND id=$2`, tid, sent.RelayID).Scan(&status, &runID, &provider, &admission, &usage, &in, &out, &cached, &link); e != nil {
		t.Fatal(e)
	}
	if status != "completed" || runID != "relay-"+linkID || provider != "bedrock" || admission != "accepted" || usage != "reported" || in != 1200 || out != 34 || cached != 1000 || link == nil || *link != linkID {
		t.Fatalf("ledger: %s %s %s %s %s %d %d %d %v", status, runID, provider, admission, usage, in, out, cached, link)
	}
	newest := func() (status, admission, cost, failure string) {
		t.Helper()
		if e := h.db.QueryRow(context.Background(), `SELECT status,admission_status,cost_status,failure_class FROM model_invocations WHERE tenant_id=$1 AND relay_link_id=$2 ORDER BY created_at DESC LIMIT 1`, tid, linkID).
			Scan(&status, &admission, &cost, &failure); e != nil {
			t.Fatal(e)
		}
		return
	}
	// A refusal within the hold window answers with its own status, in OpenAI's error form, and costs nothing.
	pi.refuse = func() (int, string) {
		return 429, `{"error":{"code":"PROVIDER_REFUSED","type":"ThrottlingException","upstream":true}}`
	}
	resp, body = relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request)
	var refusal struct {
		Error struct{ Code, Type string } `json:"error"`
	}
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" || json.Unmarshal(body, &refusal) != nil || refusal.Error.Type != "rate_limit_error" || refusal.Error.Code != "ThrottlingException" {
		t.Fatalf("throttled: %d %s", resp.StatusCode, body)
	}
	if status, admission, cost, _ := newest(); status != "failed" || admission != "rejected_before_start" || cost != "not_incurred" {
		t.Fatalf("a refused call's ledger: %s %s %s", status, admission, cost)
	}
	// Past the hold window the relay has answered 200 and kept the line alive: a refusal is a frame of the stream.
	hold := relayHoldWindow
	relayHoldWindow = 100 * time.Millisecond
	pi.delay.Store(int64(400 * time.Millisecond))
	resp, body = relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request)
	relayHoldWindow = hold
	pi.delay.Store(0)
	data, comments := readRelayStream(t, body)
	if resp.StatusCode != 200 || comments == 0 || len(data) != 1 || !strings.Contains(data[0], `"status":429`) {
		t.Fatalf("throttled after the hold window: %d %s", resp.StatusCode, body)
	}
	if status, admission, cost, _ := newest(); status != "failed" || admission != "rejected_before_start" || cost != "not_incurred" {
		t.Fatalf("a call refused in moments costs nothing either way: %s %s %s", status, admission, cost)
	}
	pi.refuse = nil
	// AWS refusing the operator's own credentials mid-stream is the service unavailable to the person's computer.
	pi.failMid.Store(`{"error":{"message":"The security token included in the request is invalid","type":"unrecognizedClientException","code":"unrecognizedClientException","status":403}}`)
	resp, body = relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request)
	pi.failMid.Store("")
	data, _ = readRelayStream(t, body)
	if resp.StatusCode != 200 || len(data) != 3 || !strings.Contains(data[2], `"status":503`) || strings.Contains(string(body), "security token") {
		t.Fatalf("a denied stream: %d %q", resp.StatusCode, data)
	}
	if status, admission, _, failure := newest(); status != "failed" || admission != "accepted" || failure != "provider" {
		t.Fatalf("a denied stream's ledger: %s %s %s", status, admission, failure)
	}
	// AWS refusing the request itself before any inference is the person's request refused: 400, and not paid for.
	pi.refuse = func() (int, string) {
		return 400, `{"error":{"code":"PROVIDER_REFUSED","type":"ValidationException","upstream":true}}`
	}
	resp, body = relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request)
	if resp.StatusCode != 400 || json.Unmarshal(body, &refusal) != nil || refusal.Error.Type != "invalid_request_error" {
		t.Fatalf("a request AWS refused: %d %s", resp.StatusCode, body)
	}
	if status, admission, cost, _ := newest(); status != "failed" || admission != "rejected_before_start" || cost != "not_incurred" {
		t.Fatalf("a request AWS refused costs nothing: %s %s %s", status, admission, cost)
	}
	pi.refuse = nil
	// A person's computer that leaves after the answer's [DONE] but before the worker's stream closes leaves a
	// completed call, paid for by its reported usage.
	pi.holdAfter.Store(true)
	raw, _ := json.Marshal(request)
	r, _ := http.NewRequest("POST", h.server.URL+"/api/v1/relay/v1/chat/completions", bytes.NewReader(raw))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	answer, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	lines := bufio.NewScanner(answer.Body)
	for lines.Scan() && lines.Text() != "data: [DONE]" {
	}
	answer.Body.Close()
	pi.holdAfter.Store(false)
	settled := func() (string, string) {
		t.Helper()
		var status, usage string
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if e := h.db.QueryRow(context.Background(), `SELECT status,usage_status FROM model_invocations WHERE tenant_id=$1 AND relay_link_id=$2 ORDER BY created_at DESC LIMIT 1`, tid, linkID).Scan(&status, &usage); e != nil {
				t.Fatal(e)
			}
			if status != "running" {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		return status, usage
	}
	if status, usage := settled(); status != "completed" || usage != "reported" {
		t.Fatalf("a call its reader left after [DONE]: %s %s", status, usage)
	}
	// The body's share of the API's memory is given back once the worker has it, though the call goes on.
	pi.hang.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	// Before the harness closes its server, which waits for this call.
	t.Cleanup(func() { cancel(); pi.hang.Store(false) })
	large := map[string]any{"model": "bedrock.claude-opus-5-5", "stream": true, "messages": []map[string]string{{"role": "user", "content": strings.Repeat("x", 1<<20)}}}
	raw, _ = json.Marshal(large)
	before := pi.calls.Load()
	go func() {
		r, _ := http.NewRequestWithContext(ctx, "POST", h.server.URL+"/api/v1/relay/v1/chat/completions", bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		if resp, e := http.DefaultClient.Do(r); e == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	}()
	for i := 0; i < 200 && pi.calls.Load() == before; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	held := func() int64 {
		h.a.relayHeld.mu.Lock()
		defer h.a.relayHeld.mu.Unlock()
		return h.a.relayHeld.held
	}
	for i := 0; i < 100 && held() != 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if n := held(); n != 0 {
		t.Fatalf("a running call still holds its body: %d bytes", n)
	}
	cancel()
	pi.hang.Store(false)
	if status, _ := settled(); status != "cancelled" {
		t.Fatalf("a call its reader left before any answer: %s", status)
	}
	// What the relay does not take is refused before admission, so the ledger never sees it.
	for _, bad := range []map[string]any{{"model": "bedrock.claude-opus-5-5", "stream": false, "messages": []any{}}, {"model": "gpt-5.5", "stream": true}, {"model": "bedrock.unknown", "stream": true}} {
		before := pi.calls.Load()
		if resp, data := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, bad); resp.StatusCode < 400 || pi.calls.Load() != before {
			t.Fatalf("%v answered %d: %s", bad, resp.StatusCode, data)
		}
	}
	// The workspace's daily calls hold relayed calls as they hold its own: the one that reached the model counts, the one
	// refused before it started does not (reachedCall).
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_runs_per_day=1 WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	if resp, data := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request); resp.StatusCode != 429 || relayErrorCode(t, data) != "quota_exceeded" {
		t.Fatalf("over today's calls: %d %s", resp.StatusCode, data)
	}
}

func TestPostgresRelayedCallsWaitForASlotAndGiveUp(t *testing.T) {
	pi := &fakeRelayPi{}
	h := relayHarness(t, pi)
	owner, tid, _ := h.register(t, "owner@example.test")
	token, _ := linkFor(t, h, owner, tid)
	wait := relayAdmissionWait
	relayAdmissionWait = 300 * time.Millisecond
	t.Cleanup(func() { relayAdmissionWait = wait })
	if _, e := h.db.Exec(context.Background(), "UPDATE tenants SET max_concurrent_runs=1 WHERE id=$1", tid); e != nil {
		t.Fatal(e)
	}
	pi.hang.Store(true)
	request := map[string]any{"model": "bedrock.claude-opus-5-5", "stream": true, "messages": []map[string]string{{"role": "user", "content": "Think long"}}}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan struct{})
	go func() {
		defer close(first)
		raw, _ := json.Marshal(request)
		r, _ := http.NewRequestWithContext(ctx, "POST", h.server.URL+"/api/v1/relay/v1/chat/completions", bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		if resp, e := http.DefaultClient.Do(r); e == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	}()
	for i := 0; i < 100 && pi.calls.Load() == 0; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if resp, data := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request); resp.StatusCode != 429 || relayErrorCode(t, data) != "relay_busy" || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("a call past the workspace's calls at once: %d %s", resp.StatusCode, data)
	}
	cancel()
	<-first
	// The caller left: its call settles as cancelled, and the slot is free again.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var running int
		if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND status='running'", tid).Scan(&running); e != nil {
			t.Fatal(e)
		}
		if running == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the abandoned call never settled")
}

func TestPostgresLocalEditionLinksThroughTheHostedSite(t *testing.T) {
	pi := &fakeRelayPi{}
	hosted := relayHarness(t, pi)
	owner, tid, _ := hosted.register(t, "owner@example.test")
	local := newHarness(t, "http://127.0.0.1:1", func(a *App) {
		a.cfg.Edition, a.cfg.UserCredentials, a.cfg.CredentialKey, a.cfg.LocalShell = editionLocal, true, bytes.Repeat([]byte{7}, 32), "macos"
		a.cfg.CloudOrigin = hosted.server.URL
	})
	person, _, uid := local.register(t, "person@awwo.local")
	view := local.request(t, person, "GET", "/auth/connections", nil, 200)
	if providers := view["providers"].([]any); providers[0].(map[string]any)["id"] != "awwo" || providers[0].(map[string]any)["link"] != true {
		t.Fatalf("「AwwO 线上」 leads the providers: %v", providers)
	}
	local.request(t, person, "POST", "/auth/connections", map[string]string{"provider": "awwo", "runtime": "pi", "apiKey": "awwo_lk_" + strings.Repeat("x", 43)}, 400)
	started := local.request(t, person, "POST", "/auth/cloud-link", nil, 201)
	code := started["userCode"].(string)
	if started["verificationURL"] != hosted.server.URL+"/?link="+code {
		t.Fatalf("start: %v", started)
	}
	waiting := hosted.request(t, owner, "GET", "/local-links/pending/"+code, nil, 200)
	if waiting["deviceName"] != "AwwO 本地版 · Mac" {
		t.Fatalf("the hosted site names the computer: %v", waiting)
	}
	hosted.request(t, owner, "POST", "/local-links/approve", map[string]any{"userCode": code, "tenantId": tid, "confirmed": true}, 200)
	connect := func() map[string]any {
		t.Helper()
		var answer map[string]any
		for i := 0; i < 40; i++ {
			time.Sleep(localLinkInterval)
			if answer = local.request(t, person, "POST", "/auth/cloud-link/poll", nil, 200); answer["status"] != "pending" {
				break
			}
		}
		return answer
	}
	if answer := connect(); answer["status"] != "connected" || answer["models"] != float64(2) {
		t.Fatalf("poll: %v", answer)
	}
	view = local.request(t, person, "GET", "/auth/connections", nil, 200)
	items := view["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("one connection for each engine: %v", items)
	}
	runtimes := map[string][]any{}
	for _, raw := range items {
		item := raw.(map[string]any)
		runtimes[item["runtime"].(string)] = item["models"].([]any)
		if item["provider"] != "awwo" || item["relay"].(map[string]any)["workspace"].(map[string]any)["id"] != tid {
			t.Fatalf("connection: %v", item)
		}
	}
	if len(runtimes["pi"]) != 2 || len(runtimes["openai-agents"]) != 1 {
		t.Fatalf("the agents engine takes the models with tools alone: %v", runtimes)
	}
	// A run's catalog carries each model's own limits on the hosted site.
	ctx := context.WithValue(context.Background(), userKey{}, User{ID: uid})
	h, e := local.a.personalRuntime(ctx, runtimePI, false)
	if e != nil {
		t.Fatal(e)
	}
	var opus *piModel
	for i := range h.Models {
		if h.Models[i].ProviderModel == "bedrock.claude-opus-5-5" {
			opus = &h.Models[i]
		}
	}
	if opus == nil || opus.MaxOutputTokens != 64000 || opus.MaxContextTextBytes != 200000-64000-256 || len(opus.Input) != 2 || opus.ProseBytesPerToken != 2.15 {
		t.Fatalf("relayed model in the catalog: %+v", opus)
	}
	var origin string
	if e := local.db.QueryRow(context.Background(), "SELECT DISTINCT relay->>'origin' FROM user_connections WHERE user_id=$1", uid).Scan(&origin); e != nil || origin != hosted.server.URL {
		t.Fatalf("the connection keeps the hosted site that granted it: %q %v", origin, e)
	}
	awaitRevoked := func(want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			var revoked int
			if e := hosted.db.QueryRow(context.Background(), "SELECT count(*) FROM local_links WHERE tenant_id=$1 AND status='revoked'", tid).Scan(&revoked); e != nil {
				t.Fatal(e)
			}
			if revoked == want {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("the hosted links ended are not %d", want)
	}
	// Connecting again replaces the link in place: each engine keeps its connection id, so an agent that chose a relayed
	// model keeps it, and the earlier link's token ends on the hosted site.
	ids := func() map[string]string {
		out := map[string]string{}
		for _, raw := range local.request(t, person, "GET", "/auth/connections", nil, 200)["items"].([]any) {
			item := raw.(map[string]any)
			out[item["runtime"].(string)] = item["id"].(string)
		}
		return out
	}
	before := ids()
	again := local.request(t, person, "POST", "/auth/cloud-link", nil, 201)
	fresh := hosted.login(t, "owner@example.test")
	hosted.request(t, fresh, "POST", "/local-links/approve", map[string]any{"userCode": again["userCode"], "tenantId": tid, "confirmed": true}, 200)
	if answer := connect(); answer["status"] != "connected" {
		t.Fatalf("connecting again: %v", answer)
	}
	if after := ids(); len(after) != 2 || after["pi"] != before["pi"] || after["openai-agents"] != before["openai-agents"] {
		t.Fatalf("connection ids changed: %v → %v", before, after)
	}
	awaitRevoked(1)
	// A link granted by another hosted site, from before AWWO_CLOUD_ORIGIN changed, sends its token nowhere.
	local.a.cfg.CloudOrigin = "https://elsewhere.awwo.example"
	if _, e := local.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("a link of another hosted site still offers its models")
	}
	local.request(t, person, "POST", "/auth/connections/"+before["pi"]+"/refresh", nil, 409)
	local.a.cfg.CloudOrigin = hosted.server.URL
	// Removing the engine removes both connections and ends the token on the hosted site.
	local.request(t, person, "DELETE", "/auth/connections/"+before["pi"], nil, 204)
	if left := local.request(t, person, "GET", "/auth/connections", nil, 200)["items"].([]any); len(left) != 0 {
		t.Fatalf("left: %v", left)
	}
	awaitRevoked(2)
}

func TestPostgresRelayedCallsSpendTheOwnersPlan(t *testing.T) {
	pi := &fakeRelayPi{}
	h := relayHarness(t, pi)
	var err error
	if h.a.pricing, err = ParseModelPricing(planPricing); err != nil {
		t.Fatal(err)
	}
	owner, tid, _ := h.register(t, "plan-owner@example.test")
	execSQL(t, h, "UPDATE tenants SET max_concurrent_runs=100,max_runs_per_day=1000,route_limits=$2::jsonb WHERE id=$1", tid, planRoutes)
	now := time.Now()
	uid := givePlan(t, h, "plan-owner@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	token, linkID := linkFor(t, h, owner, tid)
	request := map[string]any{"model": "bedrock.claude-opus-5-5", "stream": true, "messages": []map[string]string{{"role": "user", "content": "Say OK"}}}
	// Three calls, past the free Bedrock route's one a day: the plan's credits pay for them, each its reported usage.
	for i := 0; i < 3; i++ {
		if resp, body := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request); resp.StatusCode != 200 {
			t.Fatalf("call %d on the plan: %d %s", i, resp.StatusCode, body)
		}
	}
	rows, err := h.db.Query(context.Background(), "SELECT status,billed_user_id,credit_reserve,credit_charge FROM model_invocations WHERE tenant_id=$1 AND relay_link_id=$2", tid, linkID)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	for rows.Next() {
		var status string
		var billed *string
		var reserve, charge *int
		if e := rows.Scan(&status, &billed, &reserve, &charge); e != nil {
			t.Fatal(e)
		}
		if status != "completed" || billed == nil || *billed != uid || reserve == nil || *reserve <= 0 || charge == nil || *charge < 1 || *charge >= *reserve {
			t.Fatalf("a call on the plan: %s %v %v %v", status, billed, reserve, charge)
		}
		calls++
	}
	rows.Close()
	if calls != 3 {
		t.Fatalf("calls on the plan: %d", calls)
	}
	// A rate limit before any output is given back, unless it came from the model's other profile after its first one
	// refused the call for capacity: two requests, which may have followed work.
	newestCharge := func() int {
		t.Helper()
		var charge *int
		if e := h.db.QueryRow(context.Background(), "SELECT credit_charge FROM model_invocations WHERE tenant_id=$1 AND relay_link_id=$2 ORDER BY created_at DESC LIMIT 1", tid, linkID).Scan(&charge); e != nil || charge == nil {
			t.Fatalf("charge: %v %v", charge, e)
		}
		return *charge
	}
	pi.failFirst.Store(`{"error":{"message":"The Bedrock stream reported an error","type":"throttlingException","code":"throttlingException","status":429}}`)
	if resp, body := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request); resp.StatusCode != 200 || !strings.Contains(string(body), `"status":429`) {
		t.Fatalf("throttled at once: %d %s", resp.StatusCode, body)
	}
	if charge := newestCharge(); charge != 0 {
		t.Fatalf("a rate limit before any output was charged %d", charge)
	}
	pi.fallback.Store(true)
	relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request)
	if charge := newestCharge(); charge == 0 {
		t.Fatal("a rate limit after the model's other profile was given back")
	}
	pi.fallback.Store(false)
	pi.failFirst.Store("")
	// The plan's agents at once count relayed calls running: Pro runs three.
	wait := relayAdmissionWait
	relayAdmissionWait = 300 * time.Millisecond
	t.Cleanup(func() { relayAdmissionWait = wait })
	pi.hang.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{}, 3)
	before := pi.calls.Load()
	for i := 0; i < 3; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			raw, _ := json.Marshal(request)
			r, _ := http.NewRequestWithContext(ctx, "POST", h.server.URL+"/api/v1/relay/v1/chat/completions", bytes.NewReader(raw))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Content-Type", "application/json")
			if resp, e := http.DefaultClient.Do(r); e == nil {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
		}()
	}
	for i := 0; i < 200 && pi.calls.Load() < before+3; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if resp, data := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, request); resp.StatusCode != 429 || relayErrorCode(t, data) != "relay_busy" {
		t.Fatalf("a fourth call at once on Pro: %d %s", resp.StatusCode, data)
	}
	cancel()
	for i := 0; i < 3; i++ {
		<-done
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var running int
		if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE billed_user_id=$1 AND status='running'", uid).Scan(&running); e != nil {
			t.Fatal(e)
		}
		if running == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the abandoned calls never settled")
}

func TestPostgresAnApprovalWaitsForAMembershipChange(t *testing.T) {
	h := relayHarness(t, &fakeRelayPi{})
	_, tid, _ := h.register(t, "owner@example.test")
	member, _, memberID := h.register(t, "member@example.test")
	execSQL(t, h, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", tid, memberID)
	resp, data := relayCall(t, h.server.URL, "POST", "/local-links/start", "", map[string]string{"deviceName": "AwwO 本地版 · Mac"})
	if resp.StatusCode != 201 {
		t.Fatalf("start %d: %s", resp.StatusCode, data)
	}
	var started struct{ UserCode string }
	_ = json.Unmarshal(data, &started)
	// An administrator making the member a reader holds the membership row (resources.go changeMember) while the
	// member's approval of a waiting code comes in: the approval waits for it and then sees the reader.
	ctx := context.Background()
	tx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	// As changeMember does: the workspace's row, and only then the membership's.
	if _, e = tx.Exec(ctx, "SELECT status FROM tenants WHERE id=$1 FOR UPDATE", tid); e != nil {
		t.Fatal(e)
	}
	approval := make(chan int, 1)
	go func() {
		raw, _ := json.Marshal(map[string]any{"userCode": started.UserCode, "tenantId": tid, "confirmed": true})
		r, _ := http.NewRequest("POST", h.server.URL+"/api/v1/local-links/approve", bytes.NewReader(raw))
		r.Header.Set("Origin", h.cfg.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(member)
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			approval <- 0
			return
		}
		resp.Body.Close()
		approval <- resp.StatusCode
	}()
	time.Sleep(300 * time.Millisecond)
	if _, e = tx.Exec(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE", tid, memberID); e == nil {
		_, e = tx.Exec(ctx, "UPDATE memberships SET role='reader' WHERE tenant_id=$1 AND user_id=$2", tid, memberID)
	}
	if e == nil {
		e = revokeMemberLinks(ctx, tx, tid, memberID)
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		t.Fatal(e)
	}
	if status := <-approval; status != 403 {
		t.Fatalf("an approval that waited for the member's demotion: %d", status)
	}
	if h.rows(t, "SELECT count(*) FROM local_links WHERE user_code=$1 AND status='pending'", started.UserCode) != 1 {
		t.Fatal("a reader's approval was taken")
	}
}

func TestPostgresAClosingAPIStopsAndSettlesItsRelayedCalls(t *testing.T) {
	pi := &fakeRelayPi{}
	h := relayHarness(t, pi)
	owner, tid, _ := h.register(t, "owner@example.test")
	token, linkID := linkFor(t, h, owner, tid)
	pi.hang.Store(true)
	t.Cleanup(func() { pi.hang.Store(false) })
	answer := make(chan int, 1)
	go func() {
		raw, _ := json.Marshal(map[string]any{"model": "bedrock.claude-opus-5-5", "stream": true, "messages": []map[string]string{{"role": "user", "content": "Think long"}}})
		r, _ := http.NewRequest("POST", h.server.URL+"/api/v1/relay/v1/chat/completions", bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			answer <- 0
			return
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		answer <- resp.StatusCode
	}()
	for i := 0; i < 200 && pi.calls.Load() == 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	// As a lost database lease does (Start): the API closes and stops its work, relayed calls among it.
	h.a.mu.Lock()
	h.a.closed = true
	for _, stop := range h.a.running {
		stop()
	}
	h.a.mu.Unlock()
	if status := <-answer; status != 503 {
		t.Fatalf("a relayed call the API stopped: %d", status)
	}
	var status string
	if e := h.db.QueryRow(context.Background(), "SELECT status FROM model_invocations WHERE tenant_id=$1 AND relay_link_id=$2", tid, linkID).Scan(&status); e != nil || status != "interrupted" {
		t.Fatalf("a relayed call the API stopped is settled as a restart's: %s %v", status, e)
	}
	// Nothing new is admitted once it closes.
	if resp, _ := relayCall(t, h.server.URL, "POST", "/relay/v1/chat/completions", token, map[string]any{"model": "bedrock.claude-opus-5-5", "stream": true}); resp.StatusCode != 503 {
		t.Fatalf("a call to a closing API: %d", resp.StatusCode)
	}
}

func TestPostgresALinkAskedJustBeforeItsCodeEndsIsKept(t *testing.T) {
	if os.Getenv("AWWO_TEST_DATABASE_URL") == "" {
		t.Skip("AWWO_TEST_DATABASE_URL absent; PostgreSQL integration not executed")
	}
	// A hosted site whose token answer is held until released: the grant is issued, and on its way.
	release, asked := make(chan struct{}), make(chan struct{}, 1)
	var revoked atomic.Int64
	hosted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/local-links/start":
			writeJSON(w, 201, map[string]any{"deviceCode": randomSecret(), "userCode": "BCDF-GHJK", "verificationURL": "ignored", "expiresIn": 900, "interval": 1})
		case "/api/v1/local-links/token":
			asked <- struct{}{}
			<-release
			writeJSON(w, 200, map[string]any{"token": localLinkTokenPrefix + randomSecret(), "linkId": "link-1", "expiresAt": time.Now().Add(90 * 24 * time.Hour),
				"workspace": map[string]string{"id": "tenant-1", "name": "Workspace"}})
		case "/api/v1/relay/v1/models":
			writeJSON(w, 200, map[string]any{"object": "list", "data": []any{}})
		case "/api/v1/relay/v1/link":
			revoked.Add(1)
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(hosted.Close)
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	local := newHarness(t, "http://127.0.0.1:1", func(a *App) {
		a.cfg.Edition, a.cfg.UserCredentials, a.cfg.CredentialKey, a.cfg.LocalShell = editionLocal, true, bytes.Repeat([]byte{7}, 32), "macos"
		a.cfg.CloudOrigin = hosted.URL
	})
	person, _, uid := local.register(t, "person@awwo.local")
	local.request(t, person, "POST", "/auth/cloud-link", nil, 201)
	first := make(chan string, 1)
	go func() {
		r, _ := http.NewRequest("POST", local.server.URL+"/api/v1/auth/cloud-link/poll", nil)
		r.Header.Set("Origin", local.cfg.PublicOrigin)
		r.AddCookie(person)
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			first <- e.Error()
			return
		}
		defer resp.Body.Close()
		var v struct{ Status string }
		_ = json.NewDecoder(resp.Body).Decode(&v)
		first <- v.Status
	}()
	<-asked
	// The code ends here while that question is on its way: a second poll waits for it rather than end the link.
	local.a.cloudLinks.mu.Lock()
	flow := local.a.cloudLinks.flows[uid]
	flow.expires = time.Now().Add(-time.Second)
	local.a.cloudLinks.flows[uid] = flow
	local.a.cloudLinks.mu.Unlock()
	if second := local.request(t, person, "POST", "/auth/cloud-link/poll", nil, 200); second["status"] != "pending" {
		t.Fatalf("a poll while a question is on its way: %v", second)
	}
	once.Do(func() { close(release) })
	if status := <-first; status != "connected" {
		t.Fatalf("the grant on its way: %s", status)
	}
	if items := local.request(t, person, "GET", "/auth/connections", nil, 200)["items"].([]any); len(items) != 2 || revoked.Load() != 0 {
		t.Fatalf("the granted link was not kept: %d connections, %d revoked", len(items), revoked.Load())
	}
}
