package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OpenMaus receives a task-scoped bearer, never a user's provider key. Only the
// already trusted Pi/OpenAI worker receives personalAdmission's ephemeral key.
func validateComputerCompletion(raw []byte, budget int) (map[string]json.RawMessage, bool, error) {
	if len(raw) > budget || len(raw) > 512<<10 {
		return nil, false, errors.New("context_limit")
	}
	var request map[string]json.RawMessage
	if json.Unmarshal(raw, &request) != nil || request == nil {
		return nil, false, errors.New("invalid_completion")
	}
	allowed := map[string]bool{"model": true, "messages": true, "tools": true, "tool_choice": true, "parallel_tool_calls": true, "temperature": true, "top_p": true, "max_tokens": true, "max_completion_tokens": true, "stream": true, "stream_options": true, "stop": true, "response_format": true, "presence_penalty": true, "frequency_penalty": true, "seed": true}
	for key := range request {
		if !allowed[key] {
			return nil, false, errors.New("invalid_completion_field")
		}
	}
	var messages []struct {
		Role       string            `json:"role"`
		Content    json.RawMessage   `json:"content"`
		ToolCalls  []json.RawMessage `json:"tool_calls"`
		ToolCallID string            `json:"tool_call_id"`
	}
	if json.Unmarshal(request["messages"], &messages) != nil || len(messages) < 1 || len(messages) > 128 {
		return nil, false, errors.New("invalid_completion_messages")
	}
	for _, m := range messages {
		switch m.Role {
		case "system", "developer", "user", "assistant", "tool":
		default:
			return nil, false, errors.New("invalid_completion_role")
		}
		if len(m.ToolCalls) > 32 {
			return nil, false, errors.New("invalid_completion_tools")
		}
		if len(m.Content) > 0 && string(m.Content) != "null" {
			var text string
			if json.Unmarshal(m.Content, &text) != nil {
				var parts []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				}
				if json.Unmarshal(m.Content, &parts) != nil || len(parts) > 32 {
					return nil, false, errors.New("invalid_completion_content")
				}
				for _, p := range parts {
					if p.Type != "text" {
						return nil, false, errors.New("computer_text_only")
					}
				}
			}
		}
	}
	if tools := request["tools"]; len(tools) > 0 {
		var defs []struct {
			Type     string `json:"type"`
			Function struct {
				Name       string          `json:"name"`
				Parameters json.RawMessage `json:"parameters"`
			} `json:"function"`
		}
		if json.Unmarshal(tools, &defs) != nil || len(defs) > 64 {
			return nil, false, errors.New("invalid_completion_tools")
		}
		for _, d := range defs {
			if d.Type != "function" || !openMausID.MatchString(d.Function.Name) || len(d.Function.Name) > 64 {
				return nil, false, errors.New("invalid_completion_tool")
			}
		}
	}
	streaming := false
	if raw, ok := request["stream"]; ok && json.Unmarshal(raw, &streaming) != nil {
		return nil, false, errors.New("invalid_completion_stream")
	}
	for _, key := range []string{"max_tokens", "max_completion_tokens"} {
		if value, ok := request[key]; ok {
			var n int
			if json.Unmarshal(value, &n) != nil || n < 1 || n > 8192 {
				return nil, false, errors.New("invalid_completion_limit")
			}
		}
	}
	request["stream"] = json.RawMessage(`false`)
	delete(request, "stream_options")
	return request, streaming, nil
}
func (a *App) settleComputerCall(tid, id, status, code string, facts *invocationFacts) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return a.persistExecutionContext(ctx, func(ctx context.Context) error {
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		after, e := a.settleInvocation(ctx, tx, tid, id, status, code, facts)
		if e != nil {
			return e
		}
		if e = tx.Commit(ctx); e == nil && after != nil {
			after()
		}
		return e
	})
}
func (a *App) computerModelProxy(w http.ResponseWriter, r *http.Request) {
	bearer := r.Header.Get("Authorization")
	if r.Header.Get("Origin") != "" || !strings.HasPrefix(bearer, "Bearer ") || len(bearer) > 256 {
		fail(w, 401, "computer_lease_invalid", "Execution lease unavailable")
		return
	}
	value, ok := a.computerLeases.Load(tokenHash(strings.TrimPrefix(bearer, "Bearer ")))
	if !ok {
		fail(w, 401, "computer_lease_invalid", "Execution lease unavailable")
		return
	}
	lease := value.(*computerLease)
	raw, e := io.ReadAll(io.LimitReader(r.Body, (512<<10)+1))
	if e != nil {
		fail(w, 400, "invalid_completion", "Invalid completion input")
		return
	}
	completion, streaming, e := validateComputerCompletion(raw, lease.snapshot.Budget)
	if e != nil {
		fail(w, 400, e.Error(), "Completion input exceeds its admitted schema or context budget")
		return
	}
	lease.mu.Lock()
	if lease.closed || lease.ctx.Err() != nil || lease.busy || lease.calls >= lease.snapshot.Computer.MaxModelCalls {
		lease.mu.Unlock()
		fail(w, 409, "computer_lease_unavailable", "Task finished, call in progress or model budget exhausted")
		return
	}
	lease.busy = true
	lease.calls++
	index := lease.calls
	lease.mu.Unlock()
	defer func() { lease.mu.Lock(); lease.busy = false; lease.mu.Unlock() }()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(lease.ctx, cancel)
	defer stop()
	snap := lease.snapshot
	facts := invocationMetadata(snap, nil)
	facts.RequirePersonalConnection = a.cfg.UserCredentials
	invocationID := "c" + tokenHash(fmt.Sprintf("%s\x00%s\x00%d", lease.tenantID, lease.runID, index))[:40]
	if e = a.reserveInvocation(ctx, lease.tenantID, lease.runID, invocationID, snap.Model, facts); e != nil {
		fail(w, 403, "computer_admission_denied", "Execution permission, model connection or quota is unavailable")
		return
	}
	status, code := "failed", "computer_model_failed"
	settled := false
	defer func() {
		if !settled {
			_ = a.settleComputerCall(lease.tenantID, invocationID, status, code, facts)
		}
	}()
	if e = a.markInvocationAdmission(ctx, lease.tenantID, invocationID, facts, "unknown"); e != nil {
		fail(w, 503, "computer_accounting_failed", "Could not reserve the model call")
		return
	}
	completion["model"], _ = json.Marshal(snap.Model)
	body, _ := json.Marshal(map[string]any{"runId": lease.runID, "tenantId": lease.tenantID, "sessionId": lease.sessionID, "model": snap.Model, "effort": snap.Effort, "completion": completion})
	if a.cfg.UserCredentials {
		body, e = a.personalAdmission(ctx, snap.Runtime, body)
		if e != nil {
			fail(w, 403, "computer_connection_unavailable", "The selected personal model is unavailable")
			return
		}
	}
	endpoint, token, e := a.runtimeEndpoint(snap.Runtime)
	if e != nil {
		fail(w, 503, "computer_model_unavailable", "Model runtime is unavailable")
		return
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint+"/internal/computer-model", bytes.NewReader(body))
	if e != nil {
		fail(w, 500, "computer_model_unavailable", "Model runtime is unavailable")
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, e := a.client.Do(req)
	if e != nil {
		fail(w, 502, "computer_model_transport", "Model response is unavailable; the call will not be retried")
		return
	}
	defer response.Body.Close()
	data, e := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if e != nil || len(data) > 2<<20 || response.StatusCode != 200 {
		fail(w, 502, "computer_model_failed", "The selected model could not complete this call")
		return
	}
	var result struct {
		Completion    json.RawMessage `json:"completion"`
		Observability json.RawMessage `json:"observability"`
	}
	if json.Unmarshal(data, &result) != nil || !json.Valid(result.Completion) {
		fail(w, 502, "computer_model_protocol", "Model response was invalid")
		return
	}
	var answer struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Model   string `json:"model"`
		Created int64  `json:"created"`
		Choices []struct {
			Index        int             `json:"index"`
			Message      json.RawMessage `json:"message"`
			FinishReason string          `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(result.Completion, &answer) != nil || len(answer.Choices) < 1 || len(answer.Choices) > 4 {
		fail(w, 502, "computer_model_protocol", "Model response was invalid")
		return
	}
	facts.receive(result.Observability, a.cfg.RunTimeout)
	facts.Admission = "accepted"
	status, code = "completed", ""
	if e = a.settleComputerCall(lease.tenantID, invocationID, status, code, facts); e != nil {
		fail(w, 503, "computer_accounting_failed", "Could not save model usage")
		return
	}
	settled = true
	if !streaming {
		writeJSON(w, 200, result.Completion)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	choices := []map[string]any{}
	for _, choice := range answer.Choices {
		var delta map[string]json.RawMessage
		if json.Unmarshal(choice.Message, &delta) != nil || delta == nil {
			delta = map[string]json.RawMessage{}
		}
		// A non-stream completion omits tool-call indices, while streamed clients
		// need them to join each function's argument deltas correctly.
		var toolCalls []map[string]json.RawMessage
		if json.Unmarshal(delta["tool_calls"], &toolCalls) == nil && len(toolCalls) > 0 {
			for index := range toolCalls {
				toolCalls[index]["index"], _ = json.Marshal(index)
			}
			delta["tool_calls"], _ = json.Marshal(toolCalls)
		}
		choices = append(choices, map[string]any{"index": choice.Index, "delta": delta, "finish_reason": choice.FinishReason})
	}
	chunk, _ := json.Marshal(map[string]any{"id": answer.ID, "object": "chat.completion.chunk", "created": answer.Created, "model": answer.Model, "choices": choices, "usage": answer.Usage})
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

// Ensures the computer task cannot continue to publish after role revocation.
func (a *App) computerRunActive(ctx context.Context, tid, rid string) bool {
	var allowed bool
	return a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM runs r JOIN memberships m ON m.tenant_id=r.tenant_id AND m.user_id=r.actor_id JOIN tenants t ON t.id=r.tenant_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.status='running' AND m.role IN ('owner','admin','member') AND t.status='active')`, tid, rid).Scan(&allowed) == nil && allowed
}
