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
	"sync/atomic"
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

const readTool = `{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}`

func TestRelayCallIsReadAsTheManagedRouteReadsIt(t *testing.T) {
	call, e := parseRelayCall([]byte(`{"model":"bedrock.claude-opus-5-5","stream":true,"temperature":0.2,"stream_options":{"include_usage":true},"store":false,
		"max_tokens":4000,"max_completion_tokens":3000,"reasoning_effort":"none","tool_choice":"auto","parallel_tool_calls":false,"stop":[],
		"tools":[` + readTool + `],
		"messages":[{"role":"system","content":"Be brief <b>"},{"role":"user","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]},
		{"role":"assistant","content":null,"reasoning_content":"hidden","tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a\"}"}},
			{"id":"c2","type":"function","function":{"name":"list","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"c1","content":"done","name":"read"},{"role":"tool","tool_call_id":"c2","content":"a"},
		{"role":"user","content":"thanks","tool_call_id":"ignored"}]}`))
	if e != nil {
		t.Fatal(e)
	}
	if call.Model != "bedrock.claude-opus-5-5" || call.MaxTokens != 3000 || call.Effort != "none" || !call.SingleTool || len(call.Messages) != 6 {
		t.Fatalf("call = %+v", call)
	}
	if *call.Messages[1].Content != "one\ntwo" || call.Messages[2].Content != nil || len(call.Messages[2].ToolCalls) != 2 || call.Messages[3].ToolCallID != "c1" || call.Messages[5].ToolCallID != "" {
		t.Fatal("messages", call.Messages)
	}
	// The tool an earlier message called but this call no longer offers ("list") is defined for the route, as any object.
	if len(call.Tools) != 2 || call.Tools[0].Function.Description != "Read a file" || call.Tools[1].Function.Name != "list" || string(call.Tools[1].Function.Parameters) != `{"type":"object"}` {
		t.Fatal("tools", call.Tools)
	}
	body := string(relayForwardBody("rlx", "tenant", call.Model, call))
	for _, want := range []string{`"runId":"rlx"`, `"sessionId":"rlx"`, `"tenantId":"tenant"`, `"effort":"none"`, `"maxTokens":3000`, `Be brief <b>`, `"name":"list"`} {
		if !strings.Contains(body, want) {
			t.Error("forwarded body lacks", want, body)
		}
	}
	for _, left := range []string{"temperature", "reasoning_effort", "hidden", "store", "ignored", "parallel_tool_calls"} {
		if strings.Contains(body, left) {
			t.Error("forwarded what the route passes over:", left)
		}
	}
	// tools: [] with tool history (as pi-ai sends once its tools are done) defines the tools the history called.
	done, e := parseRelayCall([]byte(`{"model":"m","stream":true,"tools":[],"messages":[{"role":"user","content":"go"},
		{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"c1","content":"x"}]}`))
	if e != nil || len(done.Tools) != 1 || done.Tools[0].Function.Name != "read" {
		t.Fatal("a history's tools", done.Tools, e)
	}
	none, e := parseRelayCall([]byte(`{"model":"m","stream":true,"tool_choice":"none","tools":[` + readTool + `],"messages":[{"role":"user","content":"hi"}]}`))
	if e != nil || len(none.Tools) != 0 || !strings.Contains(string(relayForwardBody("rlx", "t", "m", none)), `"tools":[]`) {
		t.Fatal("tool_choice none sends no tools", none, e)
	}
	refused := map[string]string{
		"a call read whole":       `{"model":"m","messages":[{"role":"user","content":"hi"}]}`,
		"stream false":            `{"model":"m","stream":false,"messages":[{"role":"user","content":"hi"}]}`,
		"a picture":               `{"model":"m","stream":true,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:x"}}]}]}`,
		"a forced tool":           `{"model":"m","stream":true,"tool_choice":"required","messages":[{"role":"user","content":"hi"}]}`,
		"a named tool":            `{"model":"m","stream":true,"tool_choice":{"type":"function","function":{"name":"read"}},"messages":[{"role":"user","content":"hi"}]}`,
		"two choices":             `{"model":"m","stream":true,"n":2,"messages":[{"role":"user","content":"hi"}]}`,
		"a JSON answer":           `{"model":"m","stream":true,"response_format":{"type":"json_object"},"messages":[{"role":"user","content":"hi"}]}`,
		"a stop sequence":         `{"model":"m","stream":true,"stop":["END"],"messages":[{"role":"user","content":"hi"}]}`,
		"a reasoning effort":      `{"model":"m","stream":true,"reasoning_effort":"high","messages":[{"role":"user","content":"hi"}]}`,
		"no model":                `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`,
		"no messages":             `{"model":"m","stream":true,"messages":[]}`,
		"a message's role":        `{"model":"m","stream":true,"messages":[{"content":"hi"}]}`,
		"an unknown role":         `{"model":"m","stream":true,"messages":[{"role":"function","content":"hi"}]}`,
		"a zero limit":            `{"model":"m","stream":true,"max_tokens":0,"messages":[{"role":"user","content":"hi"}]}`,
		"not an object":           `[1]`,
		"none after tool calls":   `{"model":"m","stream":true,"tool_choice":"none","messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"c1","content":"x"}]}`,
		"a result of no call":     `{"model":"m","stream":true,"messages":[{"role":"tool","tool_call_id":"c9","content":"x"}]}`,
		"a call left unanswered":  `{"model":"m","stream":true,"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]}]}`,
		"a message before result": `{"model":"m","stream":true,"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]},{"role":"user","content":"x"},{"role":"tool","tool_call_id":"c1","content":"x"}]}`,
		"a user's tool call":      `{"model":"m","stream":true,"messages":[{"role":"user","content":"x","tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"c1","content":"x"}]}`,
		"arguments not an object": `{"model":"m","stream":true,"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"[1]"}}]},{"role":"tool","tool_call_id":"c1","content":"x"}]}`,
		"a call's id used twice":  `{"model":"m","stream":true,"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}},{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"c1","content":"x"}]}`,
		"a result without text":   `{"model":"m","stream":true,"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"c1","content":null}]}`,
		"a tool without a schema": `{"model":"m","stream":true,"tools":[{"type":"function","function":{"name":"read"}}],"messages":[{"role":"user","content":"hi"}]}`,
		"a tool's array schema":   `{"model":"m","stream":true,"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"array"}}}],"messages":[{"role":"user","content":"hi"}]}`,
		"a tool named twice":      `{"model":"m","stream":true,"tools":[` + readTool + `,` + readTool + `],"messages":[{"role":"user","content":"hi"}]}`,
		"a tool's odd name":       `{"model":"m","stream":true,"tools":[{"type":"function","function":{"name":"read file","parameters":{"type":"object"}}}],"messages":[{"role":"user","content":"hi"}]}`,
	}
	for name, raw := range refused {
		if _, e := parseRelayCall([]byte(raw)); e == nil {
			t.Error("accepted", name)
		}
	}
	if _, e := parseRelayCall([]byte(`{"model":"m","stream":true,"n":1,"response_format":{"type":"text"},"stop":"","tool_calls":null,"messages":[{"role":"user","content":"hi","tool_calls":[]}]}`)); e != nil {
		t.Fatal("one choice, a text answer and no stop sequence are what is answered anyway", e)
	}
	var input relayInputError
	if _, e := parseRelayCall([]byte(refused["a picture"])); !errors.As(e, &input) || input.code != "unsupported_content" {
		t.Fatal("a picture's refusal", e)
	}
	if _, e := parseRelayCall([]byte(refused["a call read whole"])); !errors.As(e, &input) || input.code != "stream_required" {
		t.Fatal("a call read whole's refusal", e)
	}
}

func TestRelayCallIsMeasuredAsTheWorkerMeasuresIt(t *testing.T) {
	call, e := parseRelayCall([]byte(`{"model":"m","stream":true,"tools":[` + readTool + `],"messages":[{"role":"system","content":"Short words here"},{"role":"user","content":"` + strings.Repeat("y", 40) + `"}]}`))
	if e != nil {
		t.Fatal(e)
	}
	completion := string(relayJSON(call.completion()))
	if want := estimateTokens(completion, 3.4) + 64; relayCallTokens(call, 3.4) != want || relayCallTokens(call, 1) != len(completion)+64 {
		t.Fatal("the worker's measure: its completion's JSON at the model's rate, plus 32 a message", relayCallTokens(call, 3.4), want)
	}
	if !strings.Contains(string(relayForwardBody("rlx", "t", "m", call)), completion) {
		t.Fatal("what is measured is what is sent")
	}
}

func TestRelayWorkerFailuresSayWhatTheCallerCanDo(t *testing.T) {
	now := time.Now()
	after := func(d time.Duration) *invocationFacts {
		return &invocationFacts{Admission: "unknown", Sent: now, Ended: now.Add(d)}
	}
	cases := []struct {
		status          int
		body, errCode   string
		code, admission string
		took            time.Duration
	}{
		{413, `{"error":{"code":"CONTEXT_LIMIT"}}`, "context_length_exceeded", "computer_model_failed", "unknown", time.Second},
		{502, `{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:400:context_length_exceeded"}}`, "context_length_exceeded", "computer_model_failed", "rejected_before_start", time.Second},
		{400, `{"error":{"code":"INVALID_INPUT","detail":"completion:tool-name"}}`, "invalid_request", "computer_model_failed", "unknown", time.Second},
		{429, `{"error":{"code":"CAPACITY_EXCEEDED"}}`, "relay_busy", "computer_model_failed", "unknown", time.Second},
		{503, `{"error":{"code":"RUNTIME_UNAVAILABLE"}}`, "relay_unavailable", "computer_model_failed", "unknown", time.Second},
		// Bedrock refusing before its stream began, at once: no work done, never counted.
		{502, `{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:503:ServiceUnavailableException"}}`, "relay_model_failed", "computer_model_provider", "rejected_before_start", time.Second},
		{502, `{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:429:ThrottlingException"}}`, "relay_busy", "computer_model_provider", "rejected_before_start", time.Second},
		// The same after a while, and a failure once the stream began, may follow work.
		{502, `{"error":{"code":"PROVIDER_ERROR","reason":"bedrock:503:ServiceUnavailableException"}}`, "relay_model_failed", "computer_model_provider", "unknown", time.Minute},
		{502, `{"error":{"code":"PROVIDER_ERROR","reason":"stream:error:500:InternalServerException"}}`, "relay_model_failed", "computer_model_provider", "unknown", time.Second},
		{499, `{"error":{"code":"CANCELLED","reason":"timeout"}}`, "relay_model_failed", "computer_model_cut", "unknown", time.Second},
	}
	for _, c := range cases {
		facts := after(c.took)
		f := relayWorkerFailure(c.status, []byte(c.body), nil, false, facts)
		if f.errCode != c.errCode || f.code != c.code || facts.Admission != c.admission {
			t.Errorf("%d %s after %s: %+v, admission %s", c.status, c.body, c.took, f, facts.Admission)
		}
	}
	if f := relayWorkerFailure(400, []byte(`{"error":{"code":"INVALID_INPUT","detail":"completion:tool-name"}}`), nil, false, after(time.Second)); !strings.HasSuffix(f.message, "completion:tool-name") {
		t.Fatal("the worker's check is named", f.message)
	}
	if f := relayWorkerFailure(200, nil, errors.New("broke"), true, after(time.Second)); f.code != "computer_model_cut" || f.errCode != "relay_model_transport" {
		t.Fatal("an answer cut off", f)
	}
}

// relayFrames are a streamed reply's frames: its comment lines, then its data lines.
func relayFrames(body string) []string {
	return strings.Split(strings.TrimSpace(body), "\n\n")
}

func TestRelayReplyStreamsTheAnswerAsChunks(t *testing.T) {
	w := httptest.NewRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	reply := beginRelayReply(ctx, w)
	reply.answer("bedrock.claude-opus-5-5", relayAnswer{ID: "chatcmpl-1", Created: 7, Finish: "tool_calls", Usage: json.RawMessage(`{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}`),
		Message: map[string]json.RawMessage{"role": json.RawMessage(`"assistant"`), "content": json.RawMessage(`null`),
			"tool_calls":        json.RawMessage(`[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}},{"id":"c2","type":"function","function":{"name":"read","arguments":"{}"}}]`),
			"reasoning_details": json.RawMessage(`[{"type":"reasoning.encrypted"}]`)}}, false)
	cancel()
	reply.send(": late\n\n")
	out := w.Body.String()
	if w.Header().Get("Content-Type") != "text/event-stream; charset=utf-8" || !strings.HasPrefix(out, ": awwo relay\n\n") || !strings.HasSuffix(out, "data: [DONE]\n\n") {
		t.Fatalf("stream framing: %q", out)
	}
	if strings.Contains(out, "reasoning") || strings.Contains(out, "late") {
		t.Fatal("nothing past the answer, and nothing the worker keeps for its own executor", out)
	}
	frames := relayFrames(out)
	if len(frames) != 4 {
		t.Fatalf("frames: %q", frames)
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
	if e := json.Unmarshal([]byte(strings.TrimPrefix(frames[1], "data: ")), &chunk); e != nil || chunk.Object != "chat.completion.chunk" || chunk.Model != "bedrock.claude-opus-5-5" ||
		len(chunk.Choices) != 1 || chunk.Choices[0].Delta.Role != "assistant" || chunk.Choices[0].FinishReason != "tool_calls" ||
		len(chunk.Choices[0].Delta.ToolCalls) != 2 || chunk.Choices[0].Delta.ToolCalls[1].Index != 1 || chunk.Choices[0].Delta.ToolCalls[1].ID != "c2" {
		t.Fatalf("answer chunk %s: %+v %v", frames[1], chunk, e)
	}
	if !strings.Contains(frames[2], `"choices":[]`) || !strings.Contains(frames[2], `"total_tokens":5`) {
		t.Fatal("usage chunk", frames[2])
	}
	// One tool call at a time when asked: the first.
	single := httptest.NewRecorder()
	beginRelayReply(context.Background(), single).answer("m", relayAnswer{Finish: "tool_calls", Message: map[string]json.RawMessage{"role": json.RawMessage(`"assistant"`),
		"tool_calls": json.RawMessage(`[{"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}},{"id":"c2","type":"function","function":{"name":"read","arguments":"{}"}}]`)}}, true)
	if !strings.Contains(single.Body.String(), `"id":"c1"`) || strings.Contains(single.Body.String(), `"id":"c2"`) {
		t.Fatal("one tool call", single.Body.String())
	}
	failed := httptest.NewRecorder()
	beginRelayReply(context.Background(), failed).fail("relay_model_failed", "The model could not complete this call")
	if !strings.HasSuffix(failed.Body.String(), `data: {"error":{"code":"relay_model_failed","message":"The model could not complete this call","type":"relay_model_failed"}}`+"\n\n") {
		t.Fatalf("error frame: %q", failed.Body.String())
	}
}

func TestRelayedCallsAreBoundByTheManagedCallLimit(t *testing.T) {
	if requestDeadlineApplies(relayCompletionsRoute) || !requestDeadlineApplies(relayModelsRoute) || !requestDeadlineApplies("/api/v1/auth/relay-keys") {
		t.Fatal("only a relayed call outlives the request deadline")
	}
}

func TestRelayLimitsHoldOffWhatWouldTakeTheSite(t *testing.T) {
	var l relayLimits
	for i := 0; i < relayRequestsPerMinute; i++ {
		if !l.requestAllowed("k") {
			t.Fatal("a request within the minute's allowance refused", i)
		}
	}
	if l.requestAllowed("k") || !l.requestAllowed("other") {
		t.Fatal("past a key's minute, that key alone is held off")
	}
	for i := 0; i <= relayFailuresPerMinute; i++ {
		if !l.lookupAllowed("192.0.2.1") {
			t.Fatal("an address held off early", i)
		}
		l.lookupFailed("192.0.2.1")
	}
	if l.lookupAllowed("192.0.2.1") || !l.lookupAllowed("192.0.2.2") {
		t.Fatal("an address sending keys that are not is held off")
	}
	for i := 0; i < relayPerWorkspace; i++ {
		if !l.enter("w") {
			t.Fatal("a workspace's call within its places refused", i)
		}
	}
	if l.enter("w") {
		t.Fatal("a workspace past its places")
	}
	l.leave("w")
	if !l.enter("w") {
		t.Fatal("a place given back")
	}
	for i := relayPerWorkspace; i < relayOnSite; i++ {
		if !l.enter("w" + string(rune('a'+i%20))) {
			t.Fatal("the site's places", i)
		}
	}
	if l.enter("fresh") {
		t.Fatal("the site past its places")
	}
	for i := 0; i < relayWaiters; i++ {
		if !l.wait() {
			t.Fatal("a waiter within the site's places refused", i)
		}
	}
	if l.wait() {
		t.Fatal("the site past its waiters")
	}
	l.waited()
	if !l.wait() {
		t.Fatal("a waiter's place given back")
	}
}

func TestRelayCatalogIsReadOnceAtATimeAndKept(t *testing.T) {
	var reads atomic.Int32
	release := make(chan struct{})
	healthy := atomic.Bool{}
	healthy.Store(true)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		<-release
		if !healthy.Load() {
			w.WriteHeader(503)
			return
		}
		io.WriteString(w, relayHealth)
	}))
	defer worker.Close()
	c := testConfig()
	c.Relay, c.RelayWorkerURL, c.RelayWorkerToken = true, worker.URL, strings.Repeat("w", 32)
	a := New(nil, c)
	var wg sync.WaitGroup
	results := make([]int, 5)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			models, _ := a.relayCatalog(context.Background())
			results[i] = len(models)
		}()
	}
	// A caller whose own time runs out stops waiting, the read goes on for the others.
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	for reads.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	if _, e := a.relayCatalog(short); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("a waiter's own deadline", e)
	}
	close(release)
	wg.Wait()
	if reads.Load() != 1 || results[0] != 2 || results[4] != 2 {
		t.Fatal("one read for all, its usable models for each", reads.Load(), results)
	}
	// Kept, a failure too, for its own while.
	healthy.Store(false)
	a.relayCatalogCache.at = time.Now().Add(-relayCatalogTTL)
	if _, e := a.relayCatalog(context.Background()); e == nil {
		t.Fatal("a worker not ready")
	}
	if _, e := a.relayCatalog(context.Background()); e == nil || reads.Load() != 2 {
		t.Fatal("a failure is kept for its retry time", reads.Load(), e)
	}
}
