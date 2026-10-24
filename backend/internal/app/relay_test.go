package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRelayConfigBelongsToOneEditionEach(t *testing.T) {
	hosted := testConfig()
	hosted.LocalRelay = true
	if e := hosted.Validate(); e != nil {
		t.Fatalf("the hosted site may relay: %v", e)
	}
	personal := hosted
	personal.UserCredentials, personal.CredentialKey = true, make([]byte, 32)
	if personal.Validate() == nil {
		t.Fatal("a relay on personal connections has no operator model to relay to")
	}
	local := testConfig()
	local.Edition, local.UserCredentials, local.CredentialKey, local.RegistrationClosed = editionLocal, true, make([]byte, 32), true
	local.CloudOrigin = "https://awwo.clawhunt.store"
	if e := local.Validate(); e != nil {
		t.Fatalf("the local edition may link to the hosted site: %v", e)
	}
	both := local
	both.LocalRelay = true
	if both.Validate() == nil {
		t.Fatal("the local edition must not serve relayed calls")
	}
	stray := testConfig()
	stray.CloudOrigin = "https://awwo.clawhunt.store"
	if stray.Validate() == nil {
		t.Fatal("the hosted site must not link to itself")
	}
	if got := local.cloudRelayBase(); got != "https://awwo.clawhunt.store/api/v1/relay/v1" {
		t.Fatalf("relay base %q", got)
	}
}

func TestCloudOriginIsAnOriginAlone(t *testing.T) {
	raw, e := os.ReadFile(filepath.Join("..", "..", "..", "apps", "cloud-origin-vectors.json"))
	if e != nil {
		t.Fatal(e)
	}
	var vectors struct {
		Cases []struct {
			Origin   string `json:"origin"`
			Valid    bool   `json:"valid"`
			Loopback bool   `json:"loopback"`
		} `json:"cases"`
	}
	if e = json.Unmarshal(raw, &vectors); e != nil || len(vectors.Cases) < 20 {
		t.Fatalf("vectors: %v", e)
	}
	for _, c := range vectors.Cases {
		if got := validCloudOrigin(c.Origin, true); got != c.Valid {
			t.Errorf("validCloudOrigin(%q, loopback) = %v, want %v", c.Origin, got, c.Valid)
		}
		if got := validCloudOrigin(c.Origin, false); got != (c.Valid && !c.Loopback) {
			t.Errorf("validCloudOrigin(%q) = %v, want %v", c.Origin, got, c.Valid && !c.Loopback)
		}
	}
}

func TestUserCodesAreReadAsTyped(t *testing.T) {
	for i := 0; i < 200; i++ {
		code := newUserCode()
		if !userCodePattern.MatchString(code) {
			t.Fatalf("a new code %q does not match its own pattern", code)
		}
	}
	for raw, want := range map[string]string{"kq7m-3xhd": "KQ7M-3XHD", " KQ7M 3XHD ": "KQ7M-3XHD", "KQ7M3XHD": "KQ7M-3XHD", "KQ7M--3XHD": "KQ7M-3XHD"} {
		if got, ok := normalUserCode(raw); !ok || got != want {
			t.Errorf("normalUserCode(%q) = %q, %v", raw, got, ok)
		}
	}
	for _, raw := range []string{"", "KQ7M-3XH", "KQ7M-3XHDD", "KQ0M-3XHD", "AEIO-UAEI", "KQ7M-3XH😀"} {
		if _, ok := normalUserCode(raw); ok {
			t.Errorf("normalUserCode(%q) accepted", raw)
		}
	}
	if !validDeviceName("AwwO 本地版 · Mac") || validDeviceName("") || validDeviceName(strings.Repeat("名", 81)) || validDeviceName("a\nb") || validDeviceName("a\u200bb") || validDeviceName(string([]byte{0xff})) {
		t.Fatal("device names are 1 to 80 printable characters")
	}
	if !deviceCodePattern.MatchString(randomSecret()) || !linkTokenPattern.MatchString(localLinkTokenPrefix+randomSecret()) {
		t.Fatal("a fresh secret matches the form its readers take")
	}
}

func TestRelayUsageReadsAsThePiWorkerDoes(t *testing.T) {
	read := func(raw string) InvocationUsage { return relayUsage(json.RawMessage(raw)) }
	u := read(`{"prompt_tokens":1200,"completion_tokens":34,"prompt_tokens_details":{"cached_tokens":1000}}`)
	if u.Status != "reported" || u.Source != "provider_raw" || *u.InputTokens != 1200 || *u.OutputTokens != 34 || *u.CachedInputTokens != 1000 || *u.ComputedTotalTokens != 1234 {
		t.Fatalf("reported usage: %+v", u)
	}
	if u := read(`{"prompt_tokens":10}`); u.Status != "partial" || u.Reason != "field_missing" {
		t.Fatalf("partial usage: %+v", u)
	}
	if u := read(`{}`); u.Status != "unavailable" {
		t.Fatalf("no usage: %+v", u)
	}
	for _, raw := range []string{`{"prompt_tokens":10,"completion_tokens":2,"total_tokens":13}`, `{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":11}}`,
		`{"prompt_tokens":-1,"completion_tokens":2}`, `{"prompt_tokens":"10","completion_tokens":2}`} {
		if u := read(raw); u.Status != "invalid" {
			t.Errorf("%s read as %+v", raw, u)
		}
	}
}

func TestRelayRefusalsSayWhatTheLocalWorkersRead(t *testing.T) {
	refusal := func(status int, body string) relayRefusal { return relayWorkerRefusal(status, []byte(body)) }
	// AWS refusing the operator's own access is the service unavailable to the person, never their credentials.
	if got := refusal(403, `{"error":{"code":"PROVIDER_REFUSED","type":"AccessDeniedException","upstream":true}}`); got.status != 503 || got.code != "provider_unavailable" || !got.noWork {
		t.Fatalf("access denied: %+v", got)
	}
	if got := refusal(429, `{"error":{"code":"PROVIDER_REFUSED","type":"ThrottlingException","upstream":true}}`); got.status != 429 || got.code != "provider_rate_limited" || !got.noWork {
		t.Fatalf("throttled: %+v", got)
	}
	if got := refusal(400, `{"error":{"code":"PROVIDER_REFUSED","type":"context_length_exceeded","upstream":true}}`); got.message != "Input is too long for requested model" || got.status != 400 || got.code != "context_limit" {
		t.Fatalf("too large: %+v", got)
	}
	if got := refusal(400, `{"error":{"code":"PROVIDER_REFUSED","type":"invalid_request_error","detail":"seed is not supported by Bedrock Converse"}}`); got.message != "seed is not supported by Bedrock Converse" || got.status != 400 {
		t.Fatalf("bridge refusal: %+v", got)
	}
	if got := refusal(400, `{"error":{"code":"PROVIDER_REFUSED","type":"invalid_request_error","detail":"`+strings.Repeat("x", 301)+`"}}`); len(got.message) > 300 {
		t.Fatal("a refusal's words are bounded")
	}
	// AWS refusing the request itself before any inference is the person's request refused: not asked again, not paid.
	if got := refusal(400, `{"error":{"code":"PROVIDER_REFUSED","type":"ValidationException","upstream":true}}`); got.status != 400 || got.kind != "invalid_request_error" || !got.noWork {
		t.Fatalf("a request AWS refused: %+v", got)
	}
	// After the model's other profile, nothing is free: the first profile's refusal for capacity may follow work.
	if got := refusal(400, `{"error":{"code":"PROVIDER_REFUSED","type":"ValidationException","upstream":true,"fallback":true}}`); got.status != 400 || got.noWork {
		t.Fatalf("a refusal after a fallback: %+v", got)
	}
	if got := refusal(429, `{"error":{"code":"PROVIDER_REFUSED","type":"ThrottlingException","upstream":true,"fallback":true}}`); got.status != 429 || got.noWork {
		t.Fatalf("throttled after a fallback: %+v", got)
	}
	for code, want := range map[string]int{"INVALID_INPUT": 400, "MODEL_NOT_FOUND": 400, "STREAM_REQUIRED": 400, "INVALID_CONTENT_TYPE": 400, "REQUEST_TOO_LARGE": 413} {
		if got := refusal(want, `{"error":{"code":"`+code+`"}}`); got.status != want || !got.noWork {
			t.Errorf("the Pi worker refusing a request (%s): %+v", code, got)
		}
	}
	// An AWS server error may follow work Bedrock did.
	if got := refusal(500, `{"error":{"code":"PROVIDER_REFUSED","type":"InternalServerException","upstream":true}}`); got.status != 503 || got.noWork {
		t.Fatalf("server error: %+v", got)
	}
	// A time limit before any stream may follow work Bedrock did while the model thought: it is not free.
	if got := refusal(504, `{"error":{"code":"TIMEOUT"}}`); got.code != "run_timeout" || got.noWork || got.status != 504 {
		t.Fatalf("timeout: %+v", got)
	}
	if refusal(502, `{"error":{"code":"PROVIDER_ERROR","reason":"child-exit:1"}}`).noWork {
		t.Fatal("a child that died may have sent its request")
	}
	if !refusal(502, `{"error":{"code":"PROVIDER_ERROR","reason":"bridge-error:Error"}}`).noWork {
		t.Fatal("a bridge that refused its settings sent nothing")
	}
	for _, code := range []string{"CAPACITY_EXCEEDED", "RUN_BUSY"} {
		if got := refusal(429, `{"error":{"code":"`+code+`"}}`); got.status != 503 || !got.noWork || got.code != "runtime_rejected" {
			t.Fatalf("a full worker is the service busy: %+v", got)
		}
	}
	if got := refusal(502, `not json`); got.status != 502 || got.noWork {
		t.Fatalf("an unreadable refusal: %+v", got)
	}
	for status, want := range map[int]string{400: "invalid_request_error", 404: "invalid_request_error", 429: "rate_limit_error", 502: "api_error", 503: "api_error", 504: "api_error"} {
		if got := relayErrorType(status); got != want {
			t.Errorf("relayErrorType(%d) = %q", status, got)
		}
	}
	// After the hold window a refusal is a frame of the stream, in the bridge's form.
	raw := relayStreamFrame("The model call reached its time limit", "timeout", 504)
	line := strings.TrimSuffix(strings.TrimPrefix(string(raw), "data: "), "\n\n")
	var v struct {
		Error map[string]any `json:"error"`
	}
	if !strings.HasSuffix(string(raw), "\n\n") || json.Unmarshal([]byte(line), &v) != nil || v.Error["status"] != float64(504) || v.Error["type"] != "timeout" {
		t.Fatalf("not one data frame: %q", raw)
	}
	for kind, want := range map[string]string{"timeout": "run_timeout", "output_limit": "output_limit", "worker_lost": "runtime_failed", "cancelled": "runtime_failed"} {
		if got := relayFrameCode(kind, 504); got != want {
			t.Errorf("relayFrameCode(%q) = %q", kind, got)
		}
	}
	if relayFrameCode("throttlingException", 429) != "provider_rate_limited" || relayFrameCode("api_error", 0) != "inconsistent_runtime_output" || relayFrameCode("internalServerException", 500) != "provider_unavailable" ||
		relayFrameCode("accessDeniedException", 403) != "provider_auth_failed" {
		t.Fatal("stream frame codes")
	}
}

func TestRelayReadsTheStreamForItsRecord(t *testing.T) {
	facts := &invocationFacts{Sent: time.Now().Add(-time.Second)}
	var finish, kind string
	status := -1
	read := func(data string) []byte { return relayRead([]byte(data), facts, &finish, &kind, &status) }
	if read(`{"choices":[{"delta":{"role":"assistant"}}]}`) != nil || !facts.FirstOutput.IsZero() {
		t.Fatal("a role alone is no output")
	}
	read(`{"choices":[{"delta":{"reasoning_content":"想一想"}}]}`)
	if facts.FirstOutput.IsZero() || facts.OutputBytes != int64(len("想一想")) {
		t.Fatalf("reasoning is output the model wrote: %d", facts.OutputBytes)
	}
	read(`{"choices":[{"delta":{"content":"你好"}}]}`)
	read(`{"choices":[{"delta":{"tool_calls":[{"function":{"name":"read","arguments":"{\"p\":1}"}}]}}]}`)
	if facts.OutputBytes != int64(len("想一想")+len("你好")+len("read")+len(`{"p":1}`)) || facts.FirstOutput.IsZero() {
		t.Fatalf("output bytes %d", facts.OutputBytes)
	}
	read(`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`)
	read(`{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	if finish != "tool_calls" || facts.Usage.Status != "reported" || facts.Version == nil || facts.Timing.ProviderMs == nil || facts.Timing.ProviderTtftMs == nil {
		t.Fatalf("finish %q usage %+v", finish, facts.Usage)
	}
	if read(`{"error":{"message":"m","type":"throttlingException","code":"throttlingException","status":429}}`) != nil || kind != "throttlingException" || status != 429 {
		t.Fatalf("a throttled frame: %q %d", kind, status)
	}
	// AWS refusing the operator's credentials mid-stream is the service unavailable, never the person's credentials.
	replaced := read(`{"error":{"message":"denied","type":"accessDeniedException","status":403}}`)
	var v struct {
		Error map[string]any `json:"error"`
	}
	if replaced == nil || json.Unmarshal(bytes.TrimPrefix(replaced, []byte("data: ")), &v) != nil || v.Error["status"] != float64(503) || status != 403 {
		t.Fatalf("a denied frame: %q", replaced)
	}
	if bytes.HasSuffix(replaced, []byte("\n")) {
		t.Fatal("a replaced line carries no line end of its own")
	}
	if read(`not json`) != nil {
		t.Fatal("an unreadable line is passed on as it is")
	}
}

func TestRelayEnvelopeHoldsTheRequestOnce(t *testing.T) {
	envelope := func(body string) ([]byte, string, error) {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", relayChatRoute, strings.NewReader(body))
		return relayEnvelope(w, r, "rinv", "atenant", int64(len(body)))
	}
	body := `{"model":"bedrock.claude-opus-5-5","stream":true,"messages":[{"role":"user","content":"<b>&</b>"}]}`
	raw, model, e := envelope(body)
	if e != nil || model != "bedrock.claude-opus-5-5" {
		t.Fatalf("envelope: %v %q", e, model)
	}
	var v struct {
		RelayID  string          `json:"relayId"`
		TenantID string          `json:"tenantId"`
		Body     json.RawMessage `json:"body"`
		Model    string          `json:"model"`
	}
	if json.Unmarshal(raw, &v) != nil || v.RelayID != "rinv" || v.TenantID != "atenant" || v.Model != model || string(v.Body) != body {
		t.Fatalf("envelope %s", raw)
	}
	if spaced, _, e := envelope("\n  " + body + "\n"); e != nil || !json.Valid(spaced) {
		t.Fatalf("a request with space around it: %v", e)
	}
	for body, want := range map[string]error{
		`{"model":"bedrock.claude-opus-5-5","stream":false}`:           errRelayStream,
		`{"model":"bedrock.claude-opus-5-5"}`:                          errRelayStream,
		`{"model":"gpt-5","stream":true}`:                              errRelayModel,
		`{"model":"bedrock.claude-opus-5-5\",\"x\":\"","stream":true}`: errRelayModel,
		`{"stream":true}`: errRelayModel,
		`[{"model":"bedrock.claude-opus-5-5","stream":true}]`:                 errRelayRequest,
		`{"model":"bedrock.claude-opus-5-5","stream":true},"relayId":"other"`: errRelayRequest,
		`{"model":"bedrock.claude-opus-5-5","stream":"yes"}`:                  errRelayRequest,
		``: errRelayRequest,
	} {
		if _, _, e := envelope(body); !errors.Is(e, want) {
			t.Errorf("%s: %v, want %v", body, e, want)
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", relayChatRoute, strings.NewReader(`{"model":"bedrock.claude-opus-5-5","stream":true,"x":"`+strings.Repeat("x", relayBodyLimit)+`"}`))
	var tooLarge *http.MaxBytesError
	if _, _, e := relayEnvelope(w, r, "rinv", "atenant", 0); !errors.As(e, &tooLarge) {
		t.Fatalf("a request past the limit: %v", e)
	}
}

func TestRelayRequestsNestNoDeeperThanTheirReadersFollow(t *testing.T) {
	nest := func(n int) []byte { return []byte(strings.Repeat(`{"a":`, n) + "1" + strings.Repeat("}", n)) }
	if !jsonDepthWithin(nest(relayJSONDepth), relayJSONDepth) || jsonDepthWithin(nest(relayJSONDepth+1), relayJSONDepth) {
		t.Fatal("the limit is the depth")
	}
	if !jsonDepthWithin([]byte(`{"a":"`+strings.Repeat("{[", 200)+`\"{"}`), 2) {
		t.Fatal("brackets in a string are text")
	}
	if jsonDepthWithin([]byte(`[[[[{"a":[]}]]]]`), 5) {
		t.Fatal("arrays nest too")
	}
	envelope := func(body string) error {
		_, _, e := relayEnvelope(httptest.NewRecorder(), httptest.NewRequest("POST", relayChatRoute, strings.NewReader(body)), "rinv", "atenant", int64(len(body)))
		return e
	}
	deep := `{"model":"bedrock.claude-opus-5-5","stream":true,"x":` + string(nest(relayJSONDepth)) + `}`
	if !errors.Is(envelope(deep), errRelayRequest) || envelope(`{"model":"bedrock.claude-opus-5-5","stream":true,"x":`+string(nest(relayJSONDepth-1))+`}`) != nil {
		t.Fatal("a request nested past the limit is refused, one within it taken")
	}
}

func TestRelayBodyBudgetIsShared(t *testing.T) {
	var b relayBodies
	// One account's share, then the budget as a whole.
	if !b.take("u1", relayBodyPerAccount) || b.take("u1", 1) || !b.take("u2", relayBodyPerAccount) {
		t.Fatal("an account holds its share and no more")
	}
	rest := int64(relayBodyBudget - 2*relayBodyPerAccount)
	if !b.take("u3", rest) || b.take("u4", 1) {
		t.Fatal("the budget holds what it may and no more")
	}
	b.give("u1", relayBodyPerAccount)
	if !b.take("u4", relayBodyPerAccount) || b.take("u1", 1) {
		t.Fatal("what an account gives back is the budget's again")
	}
	b.give("u2", relayBodyPerAccount)
	b.give("u3", rest)
	b.give("u4", relayBodyPerAccount)
	if b.held != 0 || len(b.by) != 0 {
		t.Fatalf("given back, the budget is whole again: %d %v", b.held, b.by)
	}
	var l relayCallLimiter
	for i := 0; i < relayCallsPerLink; i++ {
		if !l.take("l1") {
			t.Fatal("a link's calls up to its limit")
		}
	}
	if l.take("l1") || !l.take("l2") {
		t.Fatal("one link's limit is its own")
	}
	l.give("l1")
	if !l.take("l1") {
		t.Fatal("a call given back frees its place")
	}
	var window ipWindow
	now := time.Now()
	for i := 0; i < 3; i++ {
		if !window.allow(addressKey("2001:db8::1"), 3, now) {
			t.Fatal("within the limit")
		}
	}
	if window.allow(addressKey("2001:db8::ffff"), 3, now) || !window.allow(addressKey("2001:db8:0:1::1"), 3, now) || !window.allow(addressKey("2001:db8::1"), 3, now.Add(time.Minute)) {
		t.Fatal("an IPv6 /64 counts as one address, for one minute")
	}
	if !sameNetwork("203.0.113.5", "203.0.113.5") || sameNetwork("203.0.113.5", "203.0.113.6") || !sameNetwork("2001:db8::1", "2001:db8::2") || sameNetwork("", "") {
		t.Fatal("same network")
	}
}

func TestRelayLinesKeepTheStreamsFraming(t *testing.T) {
	r := bufio.NewReaderSize(strings.NewReader("data: {\"a\":1}\n\n: comment\r\ndata: [DONE]\n\nlast"), 16)
	var got []string
	for {
		line, e := readRelayLine(r)
		if line != nil {
			got = append(got, string(line))
		}
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
	}
	want := []string{`data: {"a":1}`, "", ": comment", "data: [DONE]", "", "last"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("lines %q, want %q", got, want)
	}
	long := bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", relayLineLimit+10)+"\n"), 64<<10)
	if _, e := readRelayLine(long); !errors.Is(e, errRelayLine) {
		t.Fatalf("an endless line: %v", e)
	}
}

func TestRelayRefusesBrowsersAndUnknownTokensBeforeAnyLookup(t *testing.T) {
	a := New(nil, testConfig())
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", relayChatRoute, strings.NewReader("{}"))
	r.Header.Set("Origin", "https://evil.test")
	r.Header.Set("Authorization", "Bearer "+localLinkTokenPrefix+randomSecret())
	if _, ok := a.relayRequestLink(w, r); ok || w.Code != 403 {
		t.Fatalf("a browser's request: %d", w.Code)
	}
	for _, header := range []string{"", "Bearer", "Bearer sk-not-ours", "Basic " + localLinkTokenPrefix + randomSecret(), "Bearer " + localLinkTokenPrefix + "short"} {
		w = httptest.NewRecorder()
		r = httptest.NewRequest("POST", relayChatRoute, strings.NewReader("{}"))
		r.Header.Set("Authorization", header)
		if _, ok := a.relayRequestLink(w, r); ok || w.Code != 401 {
			t.Fatalf("%q answered %d", header, w.Code)
		}
		var body struct {
			Error struct {
				Code, Type string
			} `json:"error"`
		}
		if json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error.Code != "invalid_api_key" || body.Error.Type != "authentication_error" {
			t.Fatalf("OpenAI's error form: %s", w.Body.String())
		}
	}
}

func TestRelayedModelListsKeepTheModelsAWorkerCanHold(t *testing.T) {
	meta := cloudRelayMeta{Models: map[string]cloudRelayModel{
		"bedrock.claude-opus-5-5": {ID: "bedrock.claude-opus-5-5", Tools: true},
		"bedrock.deepseek-r1":     {ID: "bedrock.deepseek-r1"},
	}}
	if got := strings.Join(cloudModelsFor(meta, runtimePI), ","); got != "bedrock.claude-opus-5-5,bedrock.deepseek-r1" {
		t.Fatalf("pi: %s", got)
	}
	if got := strings.Join(cloudModelsFor(meta, runtimeOpenAIAgents), ","); got != "bedrock.claude-opus-5-5" {
		t.Fatalf("agents take models with tools only: %s", got)
	}
}

func TestALinkCancelledOrAskedForAgainIsNotKept(t *testing.T) {
	var f cloudLinkFlows
	now := time.Now()
	f.put("u", cloudLinkFlow{deviceCode: "A", expires: now.Add(time.Minute), interval: time.Second})
	a, found, ask := f.poll("u", now)
	if !found || !ask {
		t.Fatal("a waiting link is asked after")
	}
	if _, _, again := f.poll("u", now.Add(100*time.Millisecond)); again {
		t.Fatal("two asks within the interval ask once")
	}
	// While a question is on its way, a second one waits, past the interval too: the hosted site would answer it as a
	// code already exchanged.
	if _, _, again := f.poll("u", now.Add(2*time.Second)); again {
		t.Fatal("a second question while the first is on its way")
	}
	f.asked("u", "A")
	if _, _, again := f.poll("u", now.Add(2*time.Second)); !again {
		t.Fatal("once answered, the next interval asks again")
	}
	// The person cancelled and asked again while A's grant was on its way: A is not kept.
	f.drop("u", "")
	f.put("u", cloudLinkFlow{deviceCode: "B", expires: now.Add(time.Minute), interval: time.Second})
	if f.claim("u", a.deviceCode) {
		t.Fatal("a superseded link was kept")
	}
	f.slowDown("u", "A")
	if b, _, _ := f.poll("u", now); b.interval != time.Second {
		t.Fatal("a superseded link's slow_down changed the newer one")
	}
	f.drop("u", "A")
	if !f.claim("u", "B") || f.claim("u", "B") {
		t.Fatal("the waiting link is kept once")
	}
}
