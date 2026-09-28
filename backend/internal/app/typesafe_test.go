package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const typeSafeFixtureRequest = `{"state":"private-state-marker","questions":{"urgent":{"type":"noul","instructions":"Is this urgent?"},"route":{"type":"choice","instructions":"Pick route","criteria":{"billing":null,"technical":{"description":"Software issue"}}},"severity":{"type":"score","instructions":"Rate severity","criteria":[{"description":"low"},["high"]]}}}`
const typeSafeFixtureResponse = `{"model":"jev-1.13.0","answers":{"urgent":{"type":"noul","noul":0.9},"route":{"type":"choice","choice":"technical","probabilities":{"billing":0.1,"technical":0.9},"confidence":0.8},"severity":{"type":"score","score":0.75,"probabilities":{"0":0.25,"1":0.75},"confidence":0.5,"legend":{"0":{"description":"low"},"1":["high"]}}},"usage":{"input_tokens":347,"output_tokens":38}}`

type typeSafeRoundTripFunc func(*http.Request) (*http.Response, error)

func (f typeSafeRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func typeSafeHTTPResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}
func typeSafeFixture(t *testing.T) typeSafeRequest {
	t.Helper()
	request, err := parseTypeSafeRequest([]byte(typeSafeFixtureRequest))
	if err != nil {
		t.Fatal(err)
	}
	return request
}
func typeSafeTestConfig() Config {
	c := testConfig()
	c.TypeSafeAPIKey = "test-private-key"
	c.TypeSafeModel = defaultTypeSafeModel
	c.TypeSafeEnabledTenantIDs = []string{"tenant-a"}
	return c
}
func TestTypeSafeConfiguration(t *testing.T) {
	c := typeSafeTestConfig()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, alter := range map[string]func(*Config){
		"URL model":        func(c *Config) { c.TypeSafeModel = "https://private-key.invalid" },
		"header injection": func(c *Config) { c.TypeSafeAPIKey = "private-key\r\nInjected: true" },
		"space key":        func(c *Config) { c.TypeSafeAPIKey = "private key" },
		"wildcard":         func(c *Config) { c.TypeSafeEnabledTenantIDs = []string{"*"} },
		"blank tenant":     func(c *Config) { c.TypeSafeEnabledTenantIDs = []string{""} },
		"duplicate tenant": func(c *Config) { c.TypeSafeEnabledTenantIDs = []string{"a", "a"} },
		"timeout":          func(c *Config) { c.TypeSafeTimeout = 26 * time.Second },
	} {
		t.Run(name, func(t *testing.T) {
			value := c
			alter(&value)
			err := value.Validate()
			if err == nil || strings.Contains(err.Error(), "private-key") {
				t.Fatalf("bad validation: %v", err)
			}
		})
	}
	c.TypeSafeAPIKey, c.TypeSafeModel, c.TypeSafeEnabledTenantIDs = "", "", nil
	if err := c.Validate(); err != nil || c.typeSafeEnabled("tenant-a") || c.typeSafeModel() != defaultTypeSafeModel {
		t.Fatal("disabled defaults failed", err)
	}
}

func TestTypeSafeInputContract(t *testing.T) {
	valid := []string{
		typeSafeFixtureRequest,
		`{"state":{"records":[1,true,null,"a"]},"questions":{"x":{"type":"noul","instructions":{"question":"Present?"},"criteria":{"true":"present","false":"absent"}}}}`,
		`{"state":["a"],"questions":{"x":{"type":"choice","instructions":["choose"],"criteria":{"only":null}}}}`,
	}
	for _, value := range valid {
		if _, err := parseTypeSafeRequest([]byte(value)); err != nil {
			t.Fatalf("rejected valid input: %v", err)
		}
	}
	bad := []string{
		`null`, `{}`, `{"state":null,"questions":{}}`, `{"state":42,"questions":{}}`,
		`{"state":"x","questions":{}}`,
		strings.Replace(typeSafeFixtureRequest, `"state":`, `"apiKey":"private-key","state":`, 1),
		strings.Replace(typeSafeFixtureRequest, `"state":`, `"baseURL":"https://evil.invalid","state":`, 1),
		strings.Replace(typeSafeFixtureRequest, `"state":`, `"model":"jev-latest","state":`, 1),
		strings.Replace(typeSafeFixtureRequest, `"state":`, `"state":"duplicate","state":`, 1),
		strings.Replace(typeSafeFixtureRequest, `"type":"noul"`, `"type":"noul","type":"choice"`, 1),
		strings.Replace(typeSafeFixtureRequest, `"Is this urgent?"`, `""`, 1),
		strings.Replace(typeSafeFixtureRequest, `"type":"noul"`, `"type":"text"`, 1),
		strings.Replace(typeSafeFixtureRequest, `"type":"noul"`, `"type":"noul","key":"private-key"`, 1),
		strings.Replace(typeSafeFixtureRequest, `"criteria":[{"description":"low"},["high"]]`, `"criteria":["low"]`, 1),
		strings.Replace(typeSafeFixtureRequest, `"billing":null`, `"billing":true`, 1),
		typeSafeFixtureRequest + ` {}`, strings.Repeat(" ", typeSafeRequestLimit) + typeSafeFixtureRequest,
		`{"state":` + strings.Repeat("[", 34) + `"deep"` + strings.Repeat("]", 34) + `,"questions":{"x":{"type":"noul","instructions":"x"}}}`,
	}
	for index, value := range bad {
		if _, err := parseTypeSafeRequest([]byte(value)); err == nil {
			t.Fatalf("accepted invalid input %d", index)
		}
	}
	questions := map[string]any{}
	for i := range 17 {
		questions[fmt.Sprint(i)] = map[string]any{"type": "noul", "instructions": "x"}
	}
	value, _ := json.Marshal(map[string]any{"state": "x", "questions": questions})
	if _, err := parseTypeSafeRequest(value); err == nil {
		t.Fatal("accepted too many questions")
	}
	options := map[string]any{}
	for i := range 256 {
		options[fmt.Sprint(i)] = nil
	}
	value, _ = json.Marshal(map[string]any{"state": "x", "questions": map[string]any{"x": map[string]any{"type": "choice", "instructions": "choose", "criteria": options}}})
	if _, err := parseTypeSafeRequest(value); err == nil {
		t.Fatal("accepted too many choices")
	}
}

func TestTypeSafeAnswerContract(t *testing.T) {
	input := typeSafeFixture(t)
	result, err := parseTypeSafeResponse([]byte(typeSafeFixtureResponse), defaultTypeSafeModel, input.Questions)
	if err != nil || result.Usage.InputTokens == nil || *result.Usage.InputTokens != 347 {
		t.Fatal("valid response", err)
	}
	// Unknown provider metadata is not returned, and unavailable usage is not zero.
	extra := strings.Replace(typeSafeFixtureResponse, `"model":`, `"debug":"private-key","model":`, 1)
	extra = strings.Replace(extra, `"input_tokens":347,"output_tokens":38`, `"input_tokens":null,"new_field":1`, 1)
	result, err = parseTypeSafeResponse([]byte(extra), "jev-latest", input.Questions)
	encoded, _ := json.Marshal(result)
	if err != nil || result.Usage.InputTokens != nil || result.Usage.OutputTokens != nil || strings.Contains(string(encoded), "private-key") {
		t.Fatal("metadata/usage projection failed", err)
	}
	for name, value := range map[string]string{
		"wrong version":         strings.Replace(typeSafeFixtureResponse, "jev-1.13.0", "jev-1.12.0", 1),
		"unknown answer":        strings.Replace(typeSafeFixtureResponse, `"urgent":`, `"other":`, 1),
		"missing answer":        strings.Replace(typeSafeFixtureResponse, `"urgent":{"type":"noul","noul":0.9},`, "", 1),
		"wrong type":            strings.Replace(typeSafeFixtureResponse, `"type":"noul"`, `"type":"choice"`, 1),
		"null probability":      strings.Replace(typeSafeFixtureResponse, `"noul":0.9`, `"noul":null`, 1),
		"oversized probability": strings.Replace(typeSafeFixtureResponse, `"noul":0.9`, `"noul":1.1`, 1),
		"infinite probability":  strings.Replace(typeSafeFixtureResponse, `"noul":0.9`, `"noul":1e999`, 1),
		"negative probability":  strings.Replace(typeSafeFixtureResponse, `"billing":0.1`, `"billing":-0.1`, 1),
		"distribution":          strings.Replace(typeSafeFixtureResponse, `"billing":0.1`, `"billing":0.5`, 1),
		"unknown choice":        strings.Replace(typeSafeFixtureResponse, `"choice":"technical"`, `"choice":"other"`, 1),
		"wrong choice":          strings.Replace(typeSafeFixtureResponse, `"choice":"technical"`, `"choice":"billing"`, 1),
		"confidence":            strings.Replace(typeSafeFixtureResponse, `"confidence":0.8`, `"confidence":2`, 1),
		"missing confidence":    strings.Replace(typeSafeFixtureResponse, `,"confidence":0.8`, "", 1),
		"negative usage":        strings.Replace(typeSafeFixtureResponse, `"input_tokens":347`, `"input_tokens":-1`, 1),
		"fractional usage":      strings.Replace(typeSafeFixtureResponse, `"input_tokens":347`, `"input_tokens":1.5`, 1),
		"score range":           strings.Replace(typeSafeFixtureResponse, `"score":0.75`, `"score":1.1`, 1),
		"legend":                strings.Replace(typeSafeFixtureResponse, `"0":{"description":"low"}`, `"unknown":{"description":"low"}`, 1),
		"duplicate":             strings.Replace(typeSafeFixtureResponse, `"noul":0.9`, `"noul":0.1,"noul":0.9`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseTypeSafeResponse([]byte(value), defaultTypeSafeModel, input.Questions); err == nil {
				t.Fatal("accepted invalid answer")
			}
		})
	}
}

func TestTypeSafeTransportIsolation(t *testing.T) {
	input := typeSafeFixture(t)
	for _, status := range []int{200, 301, 302, 307, 401, 403, 422, 429, 500, 529} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			s := newTypeSafeService(nil)
			s.client.CheckRedirect = func(*http.Request, []*http.Request) error { t.Fatal("inherited redirect policy"); return nil }
			s.client.Transport = typeSafeRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.String() != typeSafeEndpoint || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer test-private-key" {
					t.Fatal("request escaped fixed provider contract")
				}
				raw, _ := io.ReadAll(r.Body)
				if strings.Contains(string(raw), "test-private-key") || !strings.Contains(string(raw), `"model":"jev-1.13.0"`) {
					t.Fatal("bad provider body")
				}
				body := typeSafeFixtureResponse
				if status != 200 {
					body = `{"error":"test-private-key private-state-marker"}`
				}
				resp := typeSafeHTTPResponse(status, body)
				resp.Header.Set("Location", "https://attacker.invalid/collect")
				return resp, nil
			})
			result, code, gotStatus := s.evaluate(context.Background(), typeSafeTestConfig(), input)
			if calls != 1 {
				t.Fatalf("redirect or retry occurred: %d", calls)
			}
			if status == 200 && (gotStatus != 200 || result.Model != defaultTypeSafeModel) {
				t.Fatal("valid evaluation failed", gotStatus, code)
			}
			if status != 200 && (gotStatus == 200 || strings.Contains(typeSafeErrorMessage(code), "private")) {
				t.Fatal("failure leaked or was accepted", gotStatus, code)
			}
		})
	}
}

func TestTypeSafeTransportFailures(t *testing.T) {
	input := typeSafeFixture(t)
	for name, body := range map[string]string{"malformed": "secret-private-key", "oversized": strings.Repeat("x", typeSafeResponseLimit+1), "invalid-answer": strings.Replace(typeSafeFixtureResponse, `"noul":0.9`, `"noul":3`, 1)} {
		t.Run(name, func(t *testing.T) {
			s := newTypeSafeService(nil)
			s.client.Transport = typeSafeRoundTripFunc(func(*http.Request) (*http.Response, error) { return typeSafeHTTPResponse(200, body), nil })
			_, code, status := s.evaluate(context.Background(), typeSafeTestConfig(), input)
			if status != 502 || code != "typesafe_invalid_response" {
				t.Fatal(status, code)
			}
		})
	}
	for _, timeout := range []bool{false, true} {
		t.Run(fmt.Sprint(timeout), func(t *testing.T) {
			s := newTypeSafeService(nil)
			s.client.Transport = typeSafeRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				<-r.Context().Done()
				return nil, errors.New("private-key upstream error")
			})
			var ctx context.Context
			var cancel context.CancelFunc
			if timeout {
				ctx, cancel = context.WithTimeout(context.Background(), 5*time.Millisecond)
			} else {
				ctx, cancel = context.WithCancel(context.Background())
				cancel()
			}
			defer cancel()
			_, code, status := s.evaluate(ctx, typeSafeTestConfig(), input)
			if timeout && (code != "typesafe_timeout" || status != 504) {
				t.Fatal(status, code)
			}
			if !timeout && (code != "typesafe_cancelled" || status != 408) {
				t.Fatal(status, code)
			}
		})
	}
}

func TestTypeSafeLimits(t *testing.T) {
	s := newTypeSafeService(nil)
	now := time.Now()
	release, ok := s.reserve("tenant", now)
	if !ok {
		t.Fatal("first reservation")
	}
	if _, ok := s.reserve("tenant", now); ok {
		t.Fatal("concurrent tenant request")
	}
	release()
	for range 4 {
		release, ok = s.reserve("tenant", now)
		if !ok {
			t.Fatal("premature rate limit")
		}
		release()
	}
	if _, ok := s.reserve("tenant", now); ok {
		t.Fatal("rate limit absent")
	}
	release, ok = s.reserve("tenant", now.Add(time.Minute))
	if !ok {
		t.Fatal("window did not reset")
	}
	release()
	var releases []func()
	for i := range 4 {
		release, ok := s.reserve(fmt.Sprint(i), now)
		if !ok {
			t.Fatal("global slot")
		}
		releases = append(releases, release)
	}
	if _, ok := s.reserve("overflow", now); ok {
		t.Fatal("global limit absent")
	}
	for _, done := range releases {
		done()
	}
}

func TestTypeSafeHandlerAuditAndErrors(t *testing.T) {
	a := New(nil, typeSafeTestConfig())
	a.typesafe.authorize = func(context.Context, typeSafeAuditRecord) error { return nil }
	var audits []typeSafeAuditRecord
	calls := 0
	a.typesafe.audit = func(_ context.Context, value typeSafeAuditRecord) error { audits = append(audits, value); return nil }
	a.typesafe.client.Transport = typeSafeRoundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return typeSafeHTTPResponse(200, typeSafeFixtureResponse), nil
	})
	request := func(tenant, body string, media string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.SetPathValue("tenantId", tenant)
		r.Header.Set("Content-Type", media)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, User{ID: "user"}))
		w := httptest.NewRecorder()
		a.typeSafeEvaluate(w, r)
		return w
	}
	if w := request("tenant-a", typeSafeFixtureRequest, "application/json"); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if calls != 1 || len(audits) != 2 || audits[0].Status != "started" || audits[1].Status != "completed" || audits[1].Usage == nil || audits[0].ID != audits[1].ID {
		t.Fatal("incorrect attempt audit")
	}
	raw, _ := json.Marshal(audits)
	if strings.Contains(string(raw), "private-state-marker") || strings.Contains(string(raw), "test-private-key") {
		t.Fatal("secret in audit")
	}
	for _, tc := range []struct {
		tenant, body, media string
		status              int
	}{
		{"other", typeSafeFixtureRequest, "application/json", 403},
		{"tenant-a", typeSafeFixtureRequest, "text/plain", 415},
		{"tenant-a", strings.Repeat("x", typeSafeRequestLimit+1), "application/json", 413},
		{"tenant-a", `{"model":"jev-latest"}`, "application/json", 400},
	} {
		if w := request(tc.tenant, tc.body, tc.media); w.Code != tc.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls != 1 {
		t.Fatal("invalid requests reached provider")
	}
	a.typesafe.audit = func(context.Context, typeSafeAuditRecord) error { return errors.New("private-key") }
	w := request("tenant-a", typeSafeFixtureRequest, "application/json")
	if w.Code != 500 || calls != 1 || strings.Contains(w.Body.String(), "private-key") {
		t.Fatal("audit admission was not fail closed")
	}
	a.Close()
}

func TestTypeSafeAuthenticationWithoutDatabase(t *testing.T) {
	a := New(nil, typeSafeTestConfig())
	defer a.Close()
	for _, method := range []string{"GET", "POST"} {
		path := "/api/v1/tenants/tenant-a/typesafe"
		if method == "POST" {
			path += "/evaluations"
		}
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest(method, path, nil))
		if w.Code != 401 {
			t.Fatal("missing session not rejected", method, w.Code)
		}
	}
}

func TestTypeSafeTenantAuthorizationIntegration(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tenant, _ := h.register(t, "typesafe-owner@example.invalid")
	reader, _, _ := h.register(t, "typesafe-reader@example.invalid")
	other, _, _ := h.register(t, "typesafe-other@example.invalid")
	h.a.cfg.TypeSafeAPIKey = "test-private-key"
	h.a.cfg.TypeSafeEnabledTenantIDs = []string{tenant}
	var calls atomic.Int64
	h.a.typesafe.client.Transport = typeSafeRoundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return typeSafeHTTPResponse(200, typeSafeFixtureResponse), nil
	})
	prefix := "/tenants/" + tenant + "/typesafe"
	h.request(t, owner, "POST", "/tenants/"+tenant+"/members", map[string]string{"email": "typesafe-reader@example.invalid", "role": "reader"}, 201)
	status := h.request(t, owner, "GET", prefix, nil, 200)
	if status["canEvaluate"] != true || status["configured"] != true || status["enabled"] != true {
		t.Fatal(status)
	}
	status = h.request(t, reader, "GET", prefix, nil, 200)
	if status["canEvaluate"] != false {
		t.Fatal("reader can evaluate")
	}
	h.request(t, other, "GET", prefix, nil, 404)
	var body any
	_ = json.Unmarshal([]byte(typeSafeFixtureRequest), &body)
	h.request(t, reader, "POST", prefix+"/evaluations", body, 403)
	h.request(t, other, "POST", prefix+"/evaluations", body, 404)
	h.request(t, owner, "POST", prefix+"/evaluations", body, 200)
	var metadata string
	var count int
	if err := h.db.QueryRow(context.Background(), "SELECT metadata::text FROM audit_events WHERE tenant_id=$1 AND action='typesafe.evaluation'", tenant).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(metadata, "private-state-marker") || strings.Contains(metadata, "test-private-key") || !strings.Contains(metadata, "completed") {
		t.Fatal("unsafe audit metadata")
	}
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tenant).Scan(&count); err != nil || count != 0 {
		t.Fatal("polluted chat accounting", err)
	}
	h.a.cfg.TypeSafeEnabledTenantIDs = nil
	h.request(t, owner, "POST", prefix+"/evaluations", body, 403)
	if calls.Load() != 1 {
		t.Fatal("authorization reached provider")
	}
}

type typeSafeBlockingBody struct {
	entered, release chan struct{}
	reader           io.Reader
	first            bool
}

func (b *typeSafeBlockingBody) Read(p []byte) (int, error) {
	if !b.first {
		b.first = true
		close(b.entered)
		<-b.release
	}
	return b.reader.Read(p)
}
func (b *typeSafeBlockingBody) Close() error { return nil }

func TestTypeSafeRevocationIntegration(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tenant, ownerID := h.register(t, "typesafe-revoke-owner@example.invalid")
	member, _, memberID := h.register(t, "typesafe-revoke-member@example.invalid")
	h.request(t, owner, "POST", "/tenants/"+tenant+"/members", map[string]string{"email": "typesafe-revoke-member@example.invalid", "role": "member"}, 201)
	h.a.cfg.TypeSafeAPIKey = "test-private-key"
	h.a.cfg.TypeSafeEnabledTenantIDs = []string{tenant}
	var calls atomic.Int64
	h.a.typesafe.client.Transport = typeSafeRoundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return typeSafeHTTPResponse(200, typeSafeFixtureResponse), nil
	})
	request := func(body io.Reader) *http.Request {
		r := httptest.NewRequest("POST", "/api/v1/tenants/"+tenant+"/typesafe/evaluations", body)
		r.AddCookie(member)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", h.cfg.PublicOrigin)
		return r
	}
	body := &typeSafeBlockingBody{entered: make(chan struct{}), release: make(chan struct{}), reader: strings.NewReader(typeSafeFixtureRequest)}
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); h.a.Handler().ServeHTTP(w, request(body)) }()
	select {
	case <-body.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("body was not read")
	}
	h.request(t, owner, "PATCH", "/tenants/"+tenant+"/members/"+memberID, map[string]string{"role": "reader"}, 204)
	close(body.release)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not finish")
	}
	if w.Code != 403 || calls.Load() != 0 {
		t.Fatal("stale upload authorization accepted", w.Code, calls.Load())
	}
	h.request(t, owner, "PATCH", "/tenants/"+tenant+"/members/"+memberID, map[string]string{"role": "member"}, 204)
	if _, err := h.db.Exec(context.Background(), "UPDATE users SET platform_role='admin' WHERE id=$1", ownerID); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	h.a.typesafe.client.Transport = typeSafeRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		close(started)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	w = httptest.NewRecorder()
	done = make(chan struct{})
	go func() {
		defer close(done)
		h.a.Handler().ServeHTTP(w, request(strings.NewReader(typeSafeFixtureRequest)))
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("provider not started")
	}
	h.request(t, owner, "PATCH", "/admin/tenants/"+tenant, map[string]string{"status": "suspended"}, 200)
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("suspension did not cancel provider")
	}
	if w.Code != 403 || !strings.Contains(w.Body.String(), "typesafe_access_revoked") || calls.Load() != 1 {
		t.Fatal("revoked result delivered", w.Code, w.Body.String())
	}
	var status string
	if err := h.db.QueryRow(context.Background(), "SELECT metadata->>'status' FROM audit_events WHERE tenant_id=$1 AND action='typesafe.evaluation'", tenant).Scan(&status); err != nil || status != "typesafe_access_revoked" {
		t.Fatal("revocation audit", status, err)
	}
	h.request(t, owner, "PATCH", "/admin/tenants/"+tenant, map[string]string{"status": "active"}, 200)
	started = make(chan struct{})
	w = httptest.NewRecorder()
	done = make(chan struct{})
	go func() {
		defer close(done)
		h.a.Handler().ServeHTTP(w, request(strings.NewReader(typeSafeFixtureRequest)))
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("second provider not started")
	}
	h.request(t, member, "POST", "/auth/logout", nil, 204)
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("logout did not cancel provider")
	}
	if w.Code != 403 || calls.Load() != 2 {
		t.Fatal("revoked session received a result", w.Code)
	}
}

func TestTypeSafeShutdownCancelsAndCleansUp(t *testing.T) {
	a := New(nil, typeSafeTestConfig())
	a.typesafe.authorize = func(context.Context, typeSafeAuditRecord) error { return nil }
	var audits []typeSafeAuditRecord
	a.typesafe.audit = func(_ context.Context, record typeSafeAuditRecord) error { audits = append(audits, record); return nil }
	started := make(chan struct{})
	a.typesafe.client.Transport = typeSafeRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	r := httptest.NewRequest("POST", "/", strings.NewReader(typeSafeFixtureRequest))
	r.SetPathValue("tenantId", "tenant-a")
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(context.WithValue(r.Context(), userKey{}, User{ID: "user"}))
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); a.typeSafeEvaluate(w, r) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("provider not started")
	}
	a.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not finish")
	}
	if w.Code != 408 || len(a.running) != 0 || a.typesafe.active != 0 || len(audits) != 2 || audits[1].Status != "typesafe_cancelled" {
		t.Fatal("shutdown leaked call or audit", w.Code)
	}
}
