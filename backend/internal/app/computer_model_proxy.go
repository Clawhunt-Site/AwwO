package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// computerModelCallTimeout bounds one managed-execution model call through the proxy: the workers stop a call
// themselves at their own per-call limit (AWWO_PI_TIMEOUT_MS, 10 minutes in production), the OpenMaus core waits as
// long for the answer (CORE_MODEL_IDLE_TIMEOUT_MS in apps/openmaus-worker/runtime.ts), and the task's lease ends it
// sooner when the task stops. Thinking models routinely need more than the 30 s an ordinary API request gets.
const computerModelCallTimeout = 10 * time.Minute

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

// withoutReferenceBlock is the completion request with every copy of block cut out of its message texts, or false when
// none holds one or the request is not one JSON object. Only message texts are searched (string content and the text
// of content parts, found by reading the request's structure), for the block as the OpenMaus core's JSON.stringify
// writes it or as Go writes it; only those bytes go, everything else stays exactly as sent (no re-encoding), and the
// caller validates the result again.
func withoutReferenceBlock(raw []byte, block string) ([]byte, bool) {
	if block == "" {
		return nil, false
	}
	spans, ok := messageTextSpans(raw)
	if !ok {
		return nil, false
	}
	for _, form := range jsonStringForms(block) {
		var cuts [][2]int
		for _, span := range spans {
			for from := span[0]; ; {
				i := bytes.Index(raw[from:span[1]], form)
				if i < 0 {
					break
				}
				i += from
				// A match right after an odd run of backslashes starts inside an escape, not at a character.
				if n := i - span[0] - len(bytes.TrimRight(raw[span[0]:i], `\`)); n%2 == 1 {
					from = i + 1
					continue
				}
				cuts = append(cuts, [2]int{i, i + len(form)})
				from = i + len(form)
			}
		}
		if len(cuts) == 0 {
			continue
		}
		out, at := make([]byte, 0, len(raw)), 0
		for _, cut := range cuts {
			out, at = append(out, raw[at:cut[0]]...), cut[1]
		}
		return append(out, raw[at:]...), true
	}
	return nil, false
}

// messageTextSpans are the byte ranges, inside their quotes, of a completion request's message texts: each message's
// "content" when it is a string, and each content part's "text". False when raw is not one JSON object.
func messageTextSpans(raw []byte) ([][2]int, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var spans [][2]int
	// value reads a value's first token; a string's span is recorded when record says so (only blanks and ':' come
	// between the key and the opening quote).
	value := func(record bool) (json.Token, error) {
		from := int(decoder.InputOffset())
		token, e := decoder.Token()
		if _, text := token.(string); e == nil && text && record {
			spans = append(spans, [2]int{from + bytes.IndexByte(raw[from:], '"') + 1, int(decoder.InputOffset()) - 1})
		}
		return token, e
	}
	// skip reads the rest of a value whose first token was read.
	skip := func(token json.Token) error {
		if token != json.Delim('{') && token != json.Delim('[') {
			return nil
		}
		for depth := 1; depth > 0; {
			t, e := decoder.Token()
			if e != nil {
				return e
			}
			switch t {
			case json.Delim('{'), json.Delim('['):
				depth++
			case json.Delim('}'), json.Delim(']'):
				depth--
			}
		}
		return nil
	}
	// members calls each with every key of the object whose '{' was read, then reads its '}'.
	members := func(each func(key string) error) error {
		for decoder.More() {
			key, e := decoder.Token()
			if e != nil {
				return e
			}
			if e = each(key.(string)); e != nil {
				return e
			}
		}
		_, e := decoder.Token()
		return e
	}
	// elements calls each with the first token of every element of the array whose '[' was read, then reads its ']'.
	elements := func(each func(first json.Token) error) error {
		for decoder.More() {
			first, e := decoder.Token()
			if e != nil {
				return e
			}
			if e = each(first); e != nil {
				return e
			}
		}
		_, e := decoder.Token()
		return e
	}
	part := func(first json.Token) error {
		if first != json.Delim('{') {
			return skip(first)
		}
		return members(func(key string) error {
			token, e := value(key == "text")
			if e != nil {
				return e
			}
			return skip(token)
		})
	}
	message := func(first json.Token) error {
		if first != json.Delim('{') {
			return skip(first)
		}
		return members(func(key string) error {
			token, e := value(key == "content")
			if e == nil && key == "content" && token == json.Delim('[') {
				return elements(part)
			}
			if e != nil {
				return e
			}
			return skip(token)
		})
	}
	if first, e := decoder.Token(); e != nil || first != json.Delim('{') {
		return nil, false
	}
	e := members(func(key string) error {
		token, e := value(false)
		if e == nil && key == "messages" && token == json.Delim('[') {
			return elements(message)
		}
		if e != nil {
			return e
		}
		return skip(token)
	})
	if e != nil {
		return nil, false
	}
	if _, e = decoder.Token(); e != io.EOF {
		return nil, false
	}
	return spans, true
}

// jsonStringForms are the ways common encoders write s inside a JSON string: JavaScript's JSON.stringify (the OpenMaus
// core; U+2028 and HTML characters stay literal), Go's encoder without HTML escaping, and Go's json.Marshal.
func jsonStringForms(s string) [][]byte {
	var js bytes.Buffer
	for _, r := range s {
		switch r {
		case '"':
			js.WriteString(`\"`)
		case '\\':
			js.WriteString(`\\`)
		case '\b':
			js.WriteString(`\b`)
		case '\f':
			js.WriteString(`\f`)
		case '\n':
			js.WriteString(`\n`)
		case '\r':
			js.WriteString(`\r`)
		case '\t':
			js.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&js, `\u%04x`, r)
			} else {
				js.WriteRune(r)
			}
		}
	}
	var plain bytes.Buffer
	encoder := json.NewEncoder(&plain)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(s)
	marshalled, _ := json.Marshal(s)
	forms := [][]byte{js.Bytes()}
	for _, quoted := range [][]byte{bytes.TrimRight(plain.Bytes(), "\n"), marshalled} {
		if f := quoted[1 : len(quoted)-1]; !slices.ContainsFunc(forms, func(have []byte) bool { return bytes.Equal(have, f) }) {
			forms = append(forms, f)
		}
	}
	return forms
}

// computerWorkerError is the worker's refusal of a model call as labels (reject in apps/computer-model.ts): its code,
// what failed (reason: a provider's status, the network, the model's answer, a cut) and which check an answer or a
// request failed (detail). The rest of the body, its message among it, is dropped, and so is a field that is not a label.
func computerWorkerError(body []byte) (code, reason, detail string) {
	var reply struct {
		Error struct {
			Code   string `json:"code"`
			Reason string `json:"reason"`
			Detail string `json:"detail"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &reply)
	return computerWorkerCode(reply.Error.Code), computerWorkerLabel(reply.Error.Reason), computerWorkerLabel(reply.Error.Detail)
}

// computerWorkerLabel keeps a failure label as the worker writes them (letters, digits and _.:-, as its LABEL), or "".
func computerWorkerLabel(s string) string {
	if len(s) > 120 {
		return ""
	}
	for _, c := range s {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && !strings.ContainsRune("_.:-", c) {
			return ""
		}
	}
	return s
}

// computerModelFailure is the ledger's code for a model call the worker answered with an error (apps/computer-model.ts):
// lost with the worker (cancelled because it was stopping: a release or a restart); cut off (499, the worker's own time
// limit, its caller leaving, a cancel); cut by a time limit on its way (computerPlatformTimeout); the provider or the
// call's machinery failing otherwise (computerProviderFault); the model's own answer not holding (reason answer, or
// stream: a Bedrock answer the model's output broke, such as too many tool calls at once or a malformed tool call); or not
// known (computer_model_failed, among them a request the provider refused before any work). The first and the provider's
// are the platform's faults, which give back a task's calls; a time limit on the way is the platform's too, but gives back
// only the call it cut (invocationFailure, direct_task_refund.go; security reviews 2026-10-16 and 2026-10-18). With
// personal credentials the provider, its key and its quota are the user's own, so its failures are never the platform's.
func computerModelFailure(status int, body []byte, personal bool) string {
	code, reason, _ := computerWorkerError(body)
	switch {
	case code == "CANCELLED" && reason == "stopping":
		return "computer_model_transport"
	case status == 499 || code == "CANCELLED":
		return "computer_model_cut"
	case code == "PROVIDER_ERROR" && personal && (strings.HasPrefix(reason, "provider:") || strings.HasPrefix(reason, "network") || reason == "body" || strings.HasPrefix(reason, "stream:")):
		return "computer_model_failed"
	case code == "PROVIDER_ERROR" && computerProviderFault(reason) && computerPlatformTimeout(reason):
		return "computer_model_timeout"
	case code == "PROVIDER_ERROR" && computerProviderFault(reason):
		return "computer_model_provider"
	case code == "PROVIDER_ERROR" && (reason == "answer" || reason == "stream" || strings.HasPrefix(reason, "stream:")):
		return "computer_model_answer"
	}
	return "computer_model_failed"
}

// computerProviderFault says whether a call's failure label (apps/computer-model.ts, apps/pi-worker/bedrock-call.mjs,
// runner.mjs) is the platform's side (security reviews 2026-10-16 and 2026-10-17; the owner's rule of 2026-10-17 for the
// time limits on the way):
//   - a Bedrock call refused or failed before its stream began (bedrock:<status>:<type> with 401, 403, 404, 408, 424, 429
//     or 5xx), or the call's machinery (bridge-error:…, credentials, child…);
//   - an AWS outage after the stream began (stream:error:<status>:<type> naming one of computerAWSOutages), never a model
//     whose own output broke the stream (ModelStreamErrorException, ModelErrorException) nor the bridge's refusal of
//     what the model sent;
//   - a provider behind LLM Gate refusing our key or our quota, missing the model, throttling, out of service or out of
//     the edge's reach (provider:<401|404|429|503|529> and Cloudflare's 521, 522, 523, 525, 526 and 530; a 403 only with
//     a kind in computerGateRefusals; an error inside a 200, a streamed call's error frame among them, only with a kind
//     in computerCapacityKinds or computerGateRefusals), whenever it comes, never a bare 403 (a firewall rule on the
//     task's words can give one), another 5xx nor a refusal of the request (400 and the like);
//   - a Gate call cut by a time limit on its way: a 408, an edge's 504 or 524 (Cloudflare cuts a call that answers
//     nothing for about 100 s, and a call that is not streamed answers nothing until its last token) or the worker's HTTP
//     client's header or body limit. The owner, 2026-10-17: the platform's timeouts, not the user's or the task's;
//   - a streamed Gate call whose stream closed after it had sent nothing for the edge's idle limit (stream:closed:idle),
//     the same edge's cut as a 524 of a call sent whole: the refund session's reading of the owner's rule, 2026-10-17.
//     Any other close (stream:closed) is not: a provider or a gateway closing at once, which a task's own words can bring
//     about (a moderation stop). The worker answers 499 for a call its own side cut and the API classes a call it gave
//     up on as a cut, so neither is ever ours;
//   - the provider out of reach before the request was sent (network:<one of computerConnectFailures>), a 2xx answer
//     that is not JSON (body), or the worker failing on an answer it already held (worker).
func computerProviderFault(reason string) bool {
	if rest, ok := strings.CutPrefix(reason, "bedrock:"); ok {
		code, _, _ := strings.Cut(rest, ":")
		n, err := strconv.Atoi(code)
		return err == nil && (n >= 500 || n == 401 || n == 403 || n == 404 || n == 408 || n == 424 || n == 429)
	}
	if reason == "stream:closed:idle" {
		return true
	}
	if rest, ok := strings.CutPrefix(reason, "stream:error:"); ok {
		_, kind, _ := strings.Cut(rest, ":")
		return computerAWSOutages[strings.ToLower(kind)]
	}
	if rest, ok := strings.CutPrefix(reason, "provider:"); ok {
		status, kind, _ := strings.Cut(rest, ":")
		return slices.Contains([]string{"401", "404", "408", "429", "503", "504", "524", "529", "521", "522", "523", "525", "526", "530"}, status) ||
			status == "403" && computerGateRefusals[kind] || status == "200" && (computerCapacityKinds[kind] || computerGateRefusals[kind])
	}
	if code, ok := strings.CutPrefix(reason, "network:"); ok {
		return computerConnectFailures[code] || code == "UND_ERR_HEADERS_TIMEOUT" || code == "UND_ERR_BODY_TIMEOUT"
	}
	return reason == "credentials" || reason == "body" || reason == "worker" || strings.HasPrefix(reason, "bridge-error:") || strings.HasPrefix(reason, "child")
}

// computerCallBroke is the ledger's code for a model call whose worker never answered in full (e: no answer, or one that
// broke off; done: the call's own context ended). Cut by its own limit (computerModelCallTimeout), by its caller giving up
// on it (the task's own idle limit, a stop) or by its task ending: not the platform failing, as a task's own time limit is
// not (security review 2026-10-16). Cut by this API's HTTP client's own time limit (its Timeout, AWWO_RUN_TIMEOUT): a time
// limit on the way, as computerPlatformTimeout's, which gives back only itself; a task could otherwise reach it on purpose
// and have its every call back where that limit is the shorter one (security review 2026-10-19). A worker that cannot be
// reached or drops the connection is the platform's transport.
func computerCallBroke(e error, done bool) string {
	var limit interface{ Timeout() bool }
	switch {
	case done:
		return "computer_model_cut"
	case !dialFailed(e) && errors.As(e, &limit) && limit.Timeout():
		return "computer_model_timeout"
	}
	return "computer_model_transport"
}

// computerPlatformTimeout says whether a platform fault (computerProviderFault) is a time limit on the call's way: a Gate
// call's 408, an edge's 504 or 524, the worker's HTTP client's header or body limit, a streamed Gate call's stream closed
// after a silence as long as the edge's idle limit, a Bedrock call's 408 or 504 or its model's own time limit after the stream
// began (ModelTimeoutException). A task can run into one on purpose, with a call made to run long, so such a call gives
// back itself, never its task's other calls (security review 2026-10-18, and the owner's 「Refund only the cut call」 of
// the same day: refundedCutCall in direct_task_refund.go).
func computerPlatformTimeout(reason string) bool {
	if reason == "stream:closed:idle" {
		return true
	}
	if rest, ok := strings.CutPrefix(reason, "bedrock:"); ok {
		code, _, _ := strings.Cut(rest, ":")
		return code == "408" || code == "504"
	}
	if rest, ok := strings.CutPrefix(reason, "stream:error:"); ok {
		_, kind, _ := strings.Cut(rest, ":")
		return strings.EqualFold(kind, "ModelTimeoutException")
	}
	if rest, ok := strings.CutPrefix(reason, "provider:"); ok {
		status, _, _ := strings.Cut(rest, ":")
		return status == "408" || status == "504" || status == "524"
	}
	code, ok := strings.CutPrefix(reason, "network:")
	return ok && (code == "UND_ERR_HEADERS_TIMEOUT" || code == "UND_ERR_BODY_TIMEOUT")
}

// computerAWSOutages are the AWS exceptions after a Bedrock stream began that are the service's own trouble, as the
// bridge names them (apps/bedrock-bridge.ts: the stream's own exception members and the SDK's exception names), the
// model service's own time limit among them (the owner, 2026-10-17).
var computerAWSOutages = map[string]bool{"throttlingexception": true, "servicequotaexceededexception": true, "serviceunavailableexception": true,
	"internalserverexception": true, "modelnotreadyexception": true, "modeltimeoutexception": true}

// computerCapacityKinds are the kinds of an error inside a 200 (a streamed call's error frame, or a gateway's error in a
// 200 read whole) that name the provider's capacity: Anthropic's overloaded_error and rate_limit_error, OpenAI's
// rate_limit_exceeded and insufficient_quota, the failures whose statuses (529, 429) are the platform's whenever they
// come. With computerGateRefusals they keep the owner's rule from depending on whether the call streamed (the refund
// session, 2026-10-17). A server error (server_error, api_error), the Gate's catch-all bad_response_status_code and a
// moderation code are not, as another 5xx is not.
var computerCapacityKinds = map[string]bool{"overloaded_error": true, "rate_limit_error": true, "rate_limit_exceeded": true, "insufficient_quota": true}

// computerGateRefusals are the kinds of a 403 behind LLM Gate that refuse the operator's access, never the task's words:
// the gateway's balance run out (new-api's insufficient_user_quota) and a key without the right (Anthropic's
// permission_error).
var computerGateRefusals = map[string]bool{"insufficient_user_quota": true, "permission_error": true}

// computerConnectFailures are the socket errors that come before a request is sent (Node's and undici's codes): the
// provider out of reach, whatever the task asked.
var computerConnectFailures = map[string]bool{"ECONNREFUSED": true, "ENOTFOUND": true, "EAI_AGAIN": true, "EHOSTUNREACH": true, "ENETUNREACH": true,
	"UND_ERR_CONNECT_TIMEOUT": true, "CERT_HAS_EXPIRED": true, "UNABLE_TO_VERIFY_LEAF_SIGNATURE": true, "DEPTH_ZERO_SELF_SIGNED_CERT": true,
	"SELF_SIGNED_CERT_IN_CHAIN": true, "ERR_TLS_CERT_ALTNAME_INVALID": true}

// logComputerCall logs a direct task's model call that failed once it went to its worker: the call's place in its task,
// its model, what the worker answered (its status, and its error's labels: computerWorkerError) and the ledger's code.
// Never the call's messages or the worker's message, so a refused call can be told apart in the API's own log.
func (a *App) logComputerCall(lease *computerLease, call, status int, body []byte, code string, facts *invocationFacts) {
	workerCode, reason, detail := computerWorkerError(body)
	a.log.Warn("managed model call failed", "run", lease.runID, "call", call, "runtime", lease.snapshot.Runtime, "model", lease.snapshot.Model,
		"workerStatus", status, "workerCode", workerCode, "reason", reason, "detail", detail, "code", code, "ms", facts.Ended.Sub(facts.Streamed).Milliseconds())
}

// computerWorkerBodyLimit is what the worker reads of one call's body (MAX_BYTES in apps/computer-model.ts).
const computerWorkerBodyLimit = 512 << 10

// computerForwardBody is the body this proxy sends the worker for one validated call.
func computerForwardBody(lease *computerLease, completion map[string]json.RawMessage) []byte {
	snap := lease.snapshot
	completion["model"], _ = json.Marshal(snap.Model)
	body, _ := json.Marshal(map[string]any{"runId": lease.runID, "tenantId": lease.tenantID, "sessionId": lease.sessionID, "model": snap.Model, "effort": snap.Effort, "completion": completion})
	return body
}

// computerCallFits says whether a validated call should also pass the worker's own admission (apps/computer-model.ts):
// its context measure, the JSON of the call plus 32 bytes a message, within the model's budget (estimated from above
// from the request as sent), and the body this proxy sends, with room for a personal key, within what the worker reads.
func computerCallFits(raw []byte, completion map[string]json.RawMessage, lease *computerLease) bool {
	var messages, tools []json.RawMessage
	_ = json.Unmarshal(completion["messages"], &messages)
	_ = json.Unmarshal(completion["tools"], &tools)
	if len(raw)+32*len(messages)+32*len(tools)+256 > lease.snapshot.Budget {
		return false
	}
	return len(computerForwardBody(lease, completion))+4096 <= computerWorkerBodyLimit
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
		// A call a time limit on its way cut (computerPlatformTimeout) is noted with its settling, as the ledger now holds
		// it, so that its task ending for the platform's sake gives back this call alone (refundedCutCall).
		if code == "computer_model_timeout" {
			if _, e = tx.Exec(ctx, `INSERT INTO refunded_calls(tenant_id,invocation_id,reason) SELECT tenant_id,id,'timeout' FROM model_invocations
				WHERE tenant_id=$1 AND id=$2 AND status='failed' AND failure_class='timeout' ON CONFLICT DO NOTHING`, tid, id); e != nil {
				return e
			}
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
	// The reference blocks executeComputer added to the task's words come after admission: a call they push over the
	// model's budget, here or in the worker's own admission, goes without them, the earlier tasks first. Never for a
	// body the read limit cut short.
	whole := len(raw) <= 512<<10
	for _, block := range lease.blocks {
		if !whole || (e != nil && e.Error() != "context_limit") || (e == nil && computerCallFits(raw, completion, lease)) {
			break
		}
		if trimmed, ok := withoutReferenceBlock(raw, block); ok {
			raw = trimmed
			completion, streaming, e = validateComputerCompletion(raw, lease.snapshot.Budget)
		}
	}
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
	// Not the API's 30 s request deadline (requestDeadlineApplies): its own bound, and the task's lease.
	ctx, cancel := context.WithTimeout(r.Context(), computerModelCallTimeout)
	defer cancel()
	stop := context.AfterFunc(lease.ctx, cancel)
	defer stop()
	snap := lease.snapshot
	facts := invocationMetadata(snap, nil)
	facts.RequirePersonalConnection = a.cfg.UserCredentials
	// The request's size is known before the reservation, which holds it.
	facts.InputBytes = int64(len(raw))
	invocationID := "c" + tokenHash(fmt.Sprintf("%s\x00%s\x00%d", lease.tenantID, lease.runID, index))[:40]
	if e = a.reserveInvocation(ctx, lease.tenantID, lease.runID, invocationID, snap.Model, facts); e != nil {
		if code := admissionRefusal(e); code != "" {
			lease.mu.Lock()
			lease.refusal = code
			lease.mu.Unlock()
		}
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
	body := computerForwardBody(lease, completion)
	facts.InputBytes = int64(len(body))
	// The failures before the request is sent leave nothing to pay for.
	if a.cfg.UserCredentials {
		body, e = a.personalAdmission(ctx, snap.Runtime, body)
		if e != nil {
			facts.Admission = "rejected_before_start"
			fail(w, 403, "computer_connection_unavailable", "The selected personal model is unavailable")
			return
		}
	}
	endpoint, token, e := a.runtimeEndpoint(snap.Runtime)
	if e != nil {
		facts.Admission = "rejected_before_start"
		fail(w, 503, "computer_model_unavailable", "Model runtime is unavailable")
		return
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint+"/internal/computer-model", bytes.NewReader(body))
	if e != nil {
		facts.Admission = "rejected_before_start"
		fail(w, 500, "computer_model_unavailable", "Model runtime is unavailable")
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	// The call's time counts from here should its answer never come (plans.go creditCharge).
	facts.Streamed = time.Now()
	response, e := a.client.Do(req)
	if e != nil {
		facts.Ended = time.Now()
		if dialFailed(e) {
			facts.Admission = "rejected_before_start"
		}
		code = computerCallBroke(e, ctx.Err() != nil)
		a.logComputerCall(lease, index, 0, nil, code, facts)
		fail(w, 502, "computer_model_transport", "Model response is unavailable; the call will not be retried")
		return
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 400, 401, 409, 413, 415, 422, 429, 503:
		// The worker or the provider refused the call before any model work (409: the worker already holds a call of
		// this run or session): it never reached a model, so it never counts (owner 2026-10-16).
		facts.Admission = "rejected_before_start"
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	facts.Ended = time.Now()
	facts.OutputBytes = int64(len(data))
	if e != nil || len(data) > 2<<20 || response.StatusCode != 200 {
		switch {
		case e != nil:
			code = computerCallBroke(e, ctx.Err() != nil) // the worker's answer broke off, or was cut
		default:
			code = computerModelFailure(response.StatusCode, data, a.cfg.UserCredentials)
		}
		a.logComputerCall(lease, index, response.StatusCode, data, code, facts)
		fail(w, 502, "computer_model_failed", "The selected model could not complete this call")
		return
	}
	var result struct {
		Completion    json.RawMessage `json:"completion"`
		Observability json.RawMessage `json:"observability"`
	}
	if json.Unmarshal(data, &result) != nil || !json.Valid(result.Completion) {
		code = "computer_model_protocol"
		a.logComputerCall(lease, index, response.StatusCode, nil, code, facts)
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
		code = "computer_model_protocol"
		a.logComputerCall(lease, index, response.StatusCode, nil, code, facts)
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
