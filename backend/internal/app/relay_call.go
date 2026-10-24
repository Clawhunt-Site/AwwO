package app

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// Reading a relayed call (relay.go): a Chat Completions request, refused here, before it is admitted, when the relay
// worker's managed-call route would refuse it (apps/computer-model.ts validateComputerCompletion and its size check).
// A call refused there costs nothing and counts nowhere, so letting it through would only fill the ledger.

// relayCall is a relayed call as this site forwards it: its model, its messages and tools as the managed-call route
// reads them, its output limit (0: the model's), its reasoning effort ("" for the model's own), and whether its answer
// may carry one tool call only (parallel_tool_calls false).
type relayCall struct {
	Model      string
	Messages   []relayMessage
	Tools      []relayTool
	MaxTokens  int
	Effort     string
	SingleTool bool
}

// relayMessage is one message as the route reads it: its role, its text (or none), and an assistant's tool calls or a
// tool's result's call id.
type relayMessage struct {
	Role       string          `json:"role"`
	Content    *string         `json:"content"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	ToolCalls  []relayToolCall `json:"tool_calls,omitempty"`
}

type relayToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// relayTool is a tool's definition as the route keeps it: its name, its description ("" for none) and its parameters,
// a JSON schema of an object.
type relayTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type relayInputError struct{ code, message string }

func (e relayInputError) Error() string { return e.code }

func relayInvalid(message string) error { return relayInputError{"invalid_request", message} }

// relayToolName is a tool's name as the route takes it.
var relayToolName = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

// parseRelayCall reads a Chat Completions request. It keeps what this site's models act on and passes over sampling and
// reporting options, as the managed-call route passes them over. It refuses what it would answer otherwise than asked:
// a call read whole (the edge in front of this site cuts a response silent for about 100 s, so only a streamed one
// can last), more than one choice, a forced tool, a response format, stop sequences, a reasoning effort, or a picture
// (the route takes text alone). parallel_tool_calls false is kept by answering with the first tool call only. Text sent
// as content parts is joined into one text, as the route reads it.
func parseRelayCall(raw []byte) (relayCall, error) {
	var c relayCall
	var request map[string]json.RawMessage
	if json.Unmarshal(raw, &request) != nil || request == nil {
		return c, relayInvalid("The request is not one JSON object")
	}
	given := func(key string) (json.RawMessage, bool) {
		v, ok := request[key]
		return v, ok && string(v) != "null"
	}
	unsupported := func(message string) (relayCall, error) {
		return c, relayInputError{"unsupported_request", message}
	}
	if json.Unmarshal(request["model"], &c.Model) != nil || c.Model == "" || len(c.Model) > 200 {
		return c, relayInputError{"invalid_model", "Name a model from /models"}
	}
	var stream bool
	if v, ok := given("stream"); ok && json.Unmarshal(v, &stream) != nil {
		return c, relayInvalid("stream must be true or false")
	}
	if !stream {
		return c, relayInputError{"stream_required", "This relay answers streamed calls only: set stream to true"}
	}
	for _, key := range []string{"max_tokens", "max_completion_tokens"} {
		if v, ok := given(key); ok {
			var n int
			if json.Unmarshal(v, &n) != nil || n < 1 || n > 1_000_000 {
				return c, relayInvalid(key + " must be a whole number from 1")
			}
			if c.MaxTokens == 0 || n < c.MaxTokens {
				c.MaxTokens = n
			}
		}
	}
	if v, ok := given("n"); ok && string(v) != "1" {
		return unsupported("One choice a call")
	}
	if v, ok := given("response_format"); ok {
		var format struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(v, &format) != nil || format.Type != "text" {
			return unsupported("Cloud models answer in text here: no response_format")
		}
	}
	if v, ok := given("stop"); ok && string(v) != `""` && string(v) != "[]" {
		return unsupported("Stop sequences are not supported here")
	}
	if v, ok := given("reasoning_effort"); ok {
		if json.Unmarshal(v, &c.Effort) != nil || (c.Effort != "" && c.Effort != "none") {
			return unsupported("These models take no reasoning effort here")
		}
	}
	if v, ok := given("parallel_tool_calls"); ok {
		var parallel bool
		if json.Unmarshal(v, &parallel) != nil {
			return c, relayInvalid("parallel_tool_calls must be true or false")
		}
		c.SingleTool = !parallel
	}
	noTools := false
	if v, ok := given("tool_choice"); ok {
		var choice string
		if json.Unmarshal(v, &choice) != nil || (choice != "auto" && choice != "none") {
			return unsupported("tool_choice may be auto or none")
		}
		noTools = choice == "none"
	}
	if v, ok := given("tools"); ok && !noTools {
		var e error
		if c.Tools, e = relayTools(v); e != nil {
			return c, e
		}
	}
	var e error
	if c.Messages, e = relayMessages(request["messages"]); e != nil {
		return c, e
	}
	// The route needs a definition for every tool an earlier message called (Bedrock does too, for any conversation with
	// tool use), which a caller may leave out (one sending tools: [] once its tools are done): those are defined, by
	// name, as taking any object. tool_choice none cannot be kept so: the model would be offered the tools it is not to call.
	known := map[string]bool{}
	for _, t := range c.Tools {
		known[t.Function.Name] = true
	}
	for _, m := range c.Messages {
		for _, call := range m.ToolCalls {
			if noTools {
				return unsupported("tool_choice none cannot follow earlier tool calls here")
			}
			if !known[call.Function.Name] {
				known[call.Function.Name] = true
				stub := relayTool{Type: "function"}
				stub.Function.Name, stub.Function.Parameters = call.Function.Name, json.RawMessage(`{"type":"object"}`)
				c.Tools = append(c.Tools, stub)
			}
		}
	}
	if len(c.Tools) > 64 {
		return c, relayInvalid("At most 64 tools")
	}
	return c, nil
}

// relayTools reads a call's tool definitions: functions with distinct names and an object's schema as their parameters.
func relayTools(raw json.RawMessage) ([]relayTool, error) {
	var tools []relayTool
	if json.Unmarshal(raw, &tools) != nil || len(tools) > 64 {
		return nil, relayInvalid("tools must be a list of at most 64 function definitions")
	}
	names := map[string]bool{}
	for _, t := range tools {
		var schema map[string]json.RawMessage
		var kind string
		if t.Type != "function" || !relayToolName.MatchString(t.Function.Name) || names[t.Function.Name] ||
			json.Unmarshal(t.Function.Parameters, &schema) != nil || schema == nil || json.Unmarshal(schema["type"], &kind) != nil || kind != "object" {
			return nil, relayInvalid("Each tool must be a function with its own name and an object's schema as its parameters")
		}
		names[t.Function.Name] = true
	}
	return tools, nil
}

// relayMessages reads a call's messages as the route checks them: known roles, text or nothing, an assistant's tool
// calls (each with its own id, a name and an object's JSON as its arguments) each answered by a tool's result before
// the next other message, and a tool's result answering one of them.
func relayMessages(raw json.RawMessage) ([]relayMessage, error) {
	var items []map[string]json.RawMessage
	if json.Unmarshal(raw, &items) != nil || len(items) < 1 || len(items) > 256 {
		return nil, relayInvalid("Between 1 and 256 messages")
	}
	out := make([]relayMessage, 0, len(items))
	pending, seen := map[string]bool{}, map[string]bool{}
	for _, item := range items {
		var m relayMessage
		if item == nil || json.Unmarshal(item["role"], &m.Role) != nil {
			return nil, relayInvalid("Every message needs a role")
		}
		switch m.Role {
		case "system", "developer", "user", "assistant", "tool":
		default:
			return nil, relayInvalid("A message's role must be system, developer, user, assistant or tool")
		}
		text, e := relayText(item["content"])
		if e != nil {
			return nil, e
		}
		m.Content = text
		if m.Role == "tool" {
			if json.Unmarshal(item["tool_call_id"], &m.ToolCallID) != nil || !pending[m.ToolCallID] || m.Content == nil {
				return nil, relayInvalid("A tool's result must answer an earlier tool call, with text")
			}
			delete(pending, m.ToolCallID)
		} else if len(pending) > 0 {
			return nil, relayInvalid("Every tool call needs its result before the next message")
		}
		if v, ok := item["tool_calls"]; ok && string(v) != "null" && string(v) != "[]" {
			if m.Role != "assistant" || json.Unmarshal(v, &m.ToolCalls) != nil || len(m.ToolCalls) > 32 {
				return nil, relayInvalid("Only an assistant's message has tool calls, at most 32")
			}
			for _, call := range m.ToolCalls {
				var arguments map[string]json.RawMessage
				if call.ID == "" || len(call.ID) > 256 || seen[call.ID] || call.Type != "function" || !relayToolName.MatchString(call.Function.Name) ||
					json.Unmarshal([]byte(call.Function.Arguments), &arguments) != nil || arguments == nil {
					return nil, relayInvalid("Each tool call needs its own id, a tool's name and an object's JSON as its arguments")
				}
				pending[call.ID], seen[call.ID] = true, true
			}
		}
		out = append(out, m)
	}
	if len(pending) > 0 {
		return nil, relayInvalid("Every tool call needs its result")
	}
	return out, nil
}

// relayText is a message's content as the managed-call route reads it: a text, or nil. Content parts are joined when
// every one is text; a picture or any other part is refused.
func relayText(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return &text, nil
	}
	var parts []struct {
		Type string  `json:"type"`
		Text *string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil || len(parts) > 64 {
		return nil, relayInvalid("A message's content must be text")
	}
	texts := make([]string, 0, len(parts))
	for _, p := range parts {
		if p.Type != "text" || p.Text == nil {
			return nil, relayInputError{"unsupported_content", "Cloud models take text here: no pictures or files"}
		}
		texts = append(texts, *p.Text)
	}
	joined := strings.Join(texts, "\n")
	return &joined, nil
}

// relayJSON writes v as the relay worker reads it, HTML characters as they are, so a forwarded call grows no larger
// than what its caller sent for them.
func relayJSON(v any) []byte {
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(v)
	return bytes.TrimRight(body.Bytes(), "\n")
}

// completion is the call's messages and tools as the route reads and measures them.
func (c relayCall) completion() map[string]any {
	tools := c.Tools
	if tools == nil {
		tools = []relayTool{}
	}
	return map[string]any{"messages": c.Messages, "tools": tools}
}

// relayCallTokens is the call's size as the route measures it against its model: its messages and tools written as JSON,
// at the model's prose rate, plus 32 a message. A call may hold the model's window less its output limit and 256.
func relayCallTokens(c relayCall, rate float64) int {
	return estimateTokens(string(relayJSON(c.completion())), rate) + 32*len(c.Messages)
}

// relayForwardBody is the body this site sends the relay worker's managed-call route for one call: the call's own id as
// its run and its session (one call each), its workspace, model, effort and output limit.
func relayForwardBody(id, tenantID, model string, call relayCall) []byte {
	forward := map[string]any{"runId": id, "tenantId": tenantID, "sessionId": id, "model": model, "effort": call.Effort, "completion": call.completion()}
	if call.MaxTokens > 0 {
		forward["maxTokens"] = call.MaxTokens
	}
	return relayJSON(forward)
}
