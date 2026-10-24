package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// The cloud relay (docs/awwo-cloud-relay.md): AwwO 本地版's workers call the hosted site's Bedrock models here with a
// link's token (local_links.go), in the OpenAI Chat Completions wire format they already speak. Each call is admitted
// and recorded as a model invocation of the link's workspace (relay_admission.go), sent to the Pi worker's
// /internal/relay-model (apps/pi-worker/relay.mjs), which makes it through the Converse bridge in an isolated child,
// and streamed back as it comes; the API reads the stream's usage to settle the call. The person's computer never
// holds an AWS credential and never reaches Bedrock: the hosted site's Bedrock account admits its host alone.

const (
	relayChatRoute = "/api/v1/relay/v1/chat/completions"
	// relayBodyLimit is the largest relayed request: a long conversation and a few pictures (each at most 3.75 MiB as
	// the bridge takes them). nginx gives the relay's path its own body limit to match (deploy/saas/nginx.conf).
	relayBodyLimit = 16 << 20
	// relayKeepalive is how long the relay lets its stream send nothing before it sends a comment line: Cloudflare cuts
	// a response that sends nothing for about 100 s, and a thinking model sends nothing until it has thought.
	relayKeepalive = 15 * time.Second
	// relayLineLimit bounds one line of the worker's stream (a chunk, never a whole answer).
	relayLineLimit = 4 << 20
	// relayCallLimit is the API's own bound on one relayed call; the Pi worker's (AWWO_PI_RELAY_TIMEOUT_MS, at most 30
	// minutes) ends it first.
	relayCallLimit = 31 * time.Minute
	// relayCatalogTTL is how long the Pi worker's relayable models are kept between reads of its /health, and
	// relayCatalogRetry how long a failed read stands before the next one, so an outage costs one wait at a time.
	relayCatalogTTL   = 30 * time.Second
	relayCatalogRetry = 5 * time.Second
	// relayCallsPerLink bounds one link's relayed calls at once, besides the workspace's and the plan's own limits.
	relayCallsPerLink = 4
	// relayWriteLimit is the longest one write to the person's computer may take: a reader that stopped reading ends its
	// call rather than hold its slot, its body's memory and its worker for the call's whole limit.
	relayWriteLimit = 30 * time.Second
	// relayJSONDepth bounds how deeply a relayed request nests: a Chat Completions request with tool schemas nests a few
	// levels, and every reader after this one (the Pi worker writes the request out again) has a limit of its own.
	relayJSONDepth = 64
)

// relayHoldWindow is how long the relay waits for the Pi worker's answer before it answers the person's computer: an
// answer within it, a refusal included, goes on with its own HTTP status; past it the relay answers 200 and sends
// keep-alives while the model thinks, and a refusal after that is a frame of the stream. Well inside the ~100 s that
// Cloudflare lets a response send nothing. A variable so tests can shorten it.
var relayHoldWindow = 20 * time.Second

var relayModelPattern = regexp.MustCompile(`^bedrock\.[a-z0-9][a-z0-9-]{0,62}$`)

// relayModel is one model the relay offers, as the Pi worker's /health lists it.
type relayModel struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Provider           string   `json:"provider"`
	ProviderModel      string   `json:"providerModel"`
	ContextWindow      int      `json:"contextWindow"`
	MaxOutputTokens    int      `json:"maxOutputTokens"`
	Input              []string `json:"input"`
	Tools              bool     `json:"tools"`
	ProseBytesPerToken float64  `json:"proseBytesPerToken,omitempty"`
}

type relayCatalogCache struct {
	mu     sync.Mutex
	at     time.Time
	models []relayModel
	failed bool
}

var errRelayUnavailable = errors.New("relay_unavailable")

// relayModels are the Pi worker's Bedrock models it relays to (its /health: relayBedrock, and each model's limits and
// tools). The API's own platform policy must allow Bedrock too, as it must for any worker's Bedrock model.
func (a *App) relayModels(ctx context.Context) ([]relayModel, error) {
	if a.cfg.LLMGateOnly && !slices.Contains(a.cfg.PlatformProviders, "bedrock") {
		return nil, errRelayUnavailable
	}
	c := &a.relayCatalog
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && c.failed && time.Since(c.at) < relayCatalogRetry {
		return nil, errRelayUnavailable
	}
	if c.models != nil && !c.failed && time.Since(c.at) < relayCatalogTTL {
		return c.models, nil
	}
	models, e := a.readRelayModels(ctx)
	c.at, c.failed = time.Now(), e != nil
	if e != nil {
		return nil, e
	}
	c.models = models
	return models, nil
}

func (a *App) readRelayModels(ctx context.Context) ([]relayModel, error) {
	endpoint, token, e := a.runtimeEndpoint(runtimePI)
	if e != nil {
		return nil, errRelayUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", endpoint+"/health", nil)
	if e != nil {
		return nil, errRelayUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, e := a.client.Do(req)
	if e != nil {
		return nil, errRelayUnavailable
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, maxRuntimeHealthBytes+1))
	var health struct {
		Ready        bool         `json:"ready"`
		RelayBedrock bool         `json:"relayBedrock"`
		Models       []relayModel `json:"models"`
	}
	if e != nil || len(raw) > maxRuntimeHealthBytes || resp.StatusCode != 200 || json.Unmarshal(raw, &health) != nil || !health.Ready || !health.RelayBedrock {
		return nil, errRelayUnavailable
	}
	models := []relayModel{}
	for _, m := range health.Models {
		if m.Provider != "bedrock" || !relayModelPattern.MatchString(m.ID) || m.ContextWindow < 4096 || m.MaxOutputTokens < 1 || m.MaxOutputTokens+256 >= m.ContextWindow ||
			!slices.Contains(m.Input, "text") || len(m.Input) > 2 || (len(m.Input) == 2 && !slices.Contains(m.Input, "image")) || m.ProseBytesPerToken < 0 || m.ProseBytesPerToken > 8 {
			continue
		}
		if len([]rune(m.Name)) == 0 || len([]rune(m.Name)) > 80 {
			m.Name = m.ID
		}
		models = append(models, m)
	}
	return models, nil
}

// relayFail answers a relayed request in OpenAI's error form, which the local edition's SDKs read.
func relayFail(w http.ResponseWriter, status int, code, kind, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "type": kind, "code": code, "requestId": w.Header().Get("X-Request-ID")}})
}

// relayRequestLink reads a relay request's link, or answers it. Requests a browser could make (they carry an Origin)
// are refused: the token belongs to the local edition's own services.
func (a *App) relayRequestLink(w http.ResponseWriter, r *http.Request) (relayLink, bool) {
	if r.Header.Get("Origin") != "" {
		relayFail(w, 403, "origin_not_allowed", "permission_error", "The relay takes no browser requests")
		return relayLink{}, false
	}
	link, e := a.relayLinkFor(r.Context(), r.Header.Get("Authorization"))
	switch {
	case e == nil:
		return link, true
	case errors.Is(e, errRelayUnauthorized):
		relayFail(w, 401, "invalid_api_key", "authentication_error", "This AwwO connection is not valid any more; connect again in AwwO 本地版")
	case errors.Is(e, errRelayWorkspace):
		relayFail(w, 403, "workspace_unavailable", "permission_error", "The connected workspace can no longer be used by this account")
	default:
		a.log.Warn("relay link lookup failed", "error_type", errorType(e))
		relayFail(w, 503, "relay_unavailable", "api_error", "The relay is unavailable; try again shortly")
	}
	return relayLink{}, false
}

func errorType(e error) string { return fmt.Sprintf("%T", e) }

// relayEntitlement is the link's workspace's allowlist, read for its model list.
func (a *App) relayEntitlement(ctx context.Context, tid string) (modelEntitlement, error) {
	var restricted bool
	var allowed []string
	if e := a.db.QueryRow(ctx, "SELECT allowed_models IS NOT NULL,COALESCE(allowed_models,'{}') FROM tenants WHERE id=$1", tid).Scan(&restricted, &allowed); e != nil {
		return modelEntitlement{}, e
	}
	return newModelEntitlement(restricted, allowed)
}

// relayModelList answers GET /relay/v1/models: the models the link's workspace may use through the relay, with each one's
// limits as the hosted site holds them (its budget for a call, its output per call, whether it sees pictures and takes
// tools), the workspace and when the link ends.
func (a *App) relayModelList(w http.ResponseWriter, r *http.Request) {
	link, ok := a.relayRequestLink(w, r)
	if !ok {
		return
	}
	models, e := a.relayModels(r.Context())
	if e != nil {
		relayFail(w, 503, "relay_unavailable", "api_error", "The hosted models are unavailable; try again shortly")
		return
	}
	entitlement, e := a.relayEntitlement(r.Context(), link.TenantID)
	if e != nil {
		a.dbError(w, e)
		return
	}
	data := []map[string]any{}
	for _, m := range models {
		if !entitlement.permits(m.ID) {
			continue
		}
		limits := map[string]any{"contextWindow": m.ContextWindow, "maxOutputTokens": m.MaxOutputTokens, "input": m.Input, "tools": m.Tools}
		if m.ProseBytesPerToken > 1 {
			limits["proseBytesPerToken"] = m.ProseBytesPerToken
		}
		data = append(data, map[string]any{"id": m.ID, "object": "model", "created": 0, "owned_by": "awwo", "name": m.Name, "awwo": limits})
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": data, "workspace": map[string]string{"id": link.TenantID, "name": link.TenantName}, "expiresAt": link.ExpiresAt})
}

// relayRevokeSelf answers DELETE /relay/v1/link: the local edition ends its own link when its person removes the
// connection there. The token alone is asked for, so a link to a suspended workspace, or of a person no longer its
// member, still ends here rather than come back when the workspace does.
func (a *App) relayRevokeSelf(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		relayFail(w, 403, "origin_not_allowed", "permission_error", "The relay takes no browser requests")
		return
	}
	link, e := a.relayTokenLink(r.Context(), r.Header.Get("Authorization"))
	if errors.Is(e, errRelayUnauthorized) {
		relayFail(w, 401, "invalid_api_key", "authentication_error", "This AwwO connection is not valid any more; connect again in AwwO 本地版")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(context.Background())
	if e = lockLinkOwners(ctx, tx, link.TenantID, link.UserID); e == nil {
		_, e = tx.Exec(ctx, `UPDATE local_links SET status='revoked',revoked_at=now() WHERE id=$1 AND status='issued'`, link.ID)
	}
	if e == nil {
		e = audit(ctx, tx, link.UserID, link.TenantID, "local_link.revoked_by_device", link.ID)
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}

// relayAdmissionFailure answers a relayed call its admission refused, with a status the local edition's workers read
// for what it is (apps/openai-agents-worker/errors.mjs: 401/403 its credentials, 429 a limit, 4xx a request refused).
func (a *App) relayAdmissionFailure(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, errRelayUnauthorized):
		relayFail(w, 401, "invalid_api_key", "authentication_error", "This AwwO connection is not valid any more; connect again in AwwO 本地版")
	case errors.Is(e, errRelayWorkspace):
		relayFail(w, 403, "workspace_unavailable", "permission_error", "The connected workspace can no longer be used by this account")
	case errors.Is(e, errModelNotAllowed):
		relayFail(w, 400, "model_not_allowed", "invalid_request_error", "The connected workspace may not use this model")
	case errors.Is(e, errPlanRequired):
		relayFail(w, 402, "plan_required", "invalid_request_error", "The connected workspace needs its owner's plan")
	case errors.Is(e, errModelUnpriced):
		relayFail(w, 400, "model_unpriced", "invalid_request_error", "This model has no price for the workspace's plan")
	case errors.Is(e, errCreditsExhausted):
		relayFail(w, 429, "credits_exhausted", "insufficient_quota", "The plan's credits for this period are used up")
	case errors.Is(e, errInvocationQuota):
		relayFail(w, 429, "quota_exceeded", "insufficient_quota", "The workspace's calls for today are used up")
	case errors.Is(e, errRouteQuota):
		relayFail(w, 429, "premium_quota_exceeded", "insufficient_quota", "The workspace's calls of this model for today are used up")
	case errors.Is(e, errRouteCapacity), errors.Is(e, errFreeCapacity):
		relayFail(w, 429, strings.TrimSpace(e.Error()), "insufficient_quota", "Today's calls of this model are used up across AwwO; try again tomorrow")
	case errors.Is(e, errRelayClosing):
		relayFail(w, 503, "worker_unavailable", "api_error", "The relay is restarting; try again shortly")
	case errors.Is(e, errRelayBusy), errors.Is(e, errPlanBusy):
		w.Header().Set("Retry-After", "30")
		relayFail(w, 429, "relay_busy", "rate_limit_error", "The workspace is running as many calls as it may at once; try again shortly")
	case errors.Is(e, context.Canceled), errors.Is(e, context.DeadlineExceeded):
		// The person's computer went away while the call waited.
	default:
		a.log.Warn("relayed call admission failed", "error_type", errorType(e))
		relayFail(w, 503, "relay_unavailable", "api_error", "The relay is unavailable; try again shortly")
	}
}

// relayStreamFrame is one SSE error frame of a relayed call that already answered 200, in the bridge's own form: the
// local edition's workers read its status as an error of a call that began (apps/bedrock-bridge.ts errorBody).
func relayStreamFrame(message, kind string, status int) []byte {
	frame, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "type": kind, "code": kind, "status": status}})
	return append(append([]byte("data: "), frame...), '\n', '\n')
}

// relayRefusal is the Pi worker's refusal of a relayed call before any stream (apps/pi-worker/relay.mjs), as the person's
// computer gets it: an HTTP status, an error type and words for it, the ledger's code, and whether the refusal itself
// says the call reached no model (quickRefusal still decides: a refusal after a while may follow work).
type relayRefusal struct {
	status        int
	kind, message string
	code          string
	noWork        bool
}

// relayErrorType is OpenAI's error type for a refusal's HTTP status.
func relayErrorType(status int) string {
	switch {
	case status == 429:
		return "rate_limit_error"
	case status >= 400 && status < 500:
		return "invalid_request_error"
	}
	return "api_error"
}

func relayWorkerRefusal(status int, body []byte) relayRefusal {
	var reply struct {
		Error struct {
			Code     string `json:"code"`
			Type     string `json:"type"`
			Upstream bool   `json:"upstream"`
			Fallback bool   `json:"fallback"`
			Detail   string `json:"detail"`
			Reason   string `json:"reason"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &reply)
	kind := computerWorkerLabel(reply.Error.Type)
	switch reply.Error.Code {
	case "PROVIDER_REFUSED":
		why := relayProviderRefusal(status, kind, reply.Error.Detail)
		if reply.Error.Fallback {
			// A refusal from the model's other profile follows its first profile's refusal for capacity: two requests, so
			// never one made before any work, whatever the second one says (the bridge's rule, bedrock-bridge.ts).
			why.noWork, why.code = false, afterFallback(why.code)
		}
		return why
	case "TIMEOUT":
		return relayRefusal{504, "timeout", "The model call reached its time limit", "run_timeout", false}
	case "INVALID_INPUT", "MODEL_NOT_FOUND", "STREAM_REQUIRED", "INVALID_CONTENT_TYPE":
		// The Pi worker refusing the request before any child: nothing was sent.
		return relayRefusal{400, "invalid_request_error", "The hosted model service cannot take this request", "runtime_rejected", true}
	case "REQUEST_TOO_LARGE":
		return relayRefusal{413, "request_too_large", "The request is larger than the relay takes (16 MiB)", "runtime_rejected", true}
	case "CAPACITY_EXCEEDED", "RUN_BUSY":
		return relayRefusal{503, "server_busy", "The hosted model service is busy; try again shortly", "runtime_rejected", true}
	case "MODEL_AUTHENTICATION", "RUNTIME_UNAVAILABLE":
		return relayRefusal{503, "api_error", "The hosted model service is unavailable", "provider_unavailable", true}
	case "PROVIDER_ERROR":
		// A child that died may have sent the request; a machinery failure before it did (the bridge refusing its
		// settings, the child not starting) reached nothing.
		reason := computerWorkerLabel(reply.Error.Reason)
		return relayRefusal{502, "api_error", "The hosted model service failed", "runtime_failed", !strings.HasPrefix(reason, "child-exit")}
	}
	return relayRefusal{502, "api_error", "The hosted model service failed", "runtime_failed", false}
}

// relayProviderRefusal is the bridge's refusal of a relayed call before any stream (PROVIDER_REFUSED), by its status and
// kind, as the person's computer gets it.
func relayProviderRefusal(status int, kind, detail string) relayRefusal {
	switch {
	case kind == "context_length_exceeded":
		// The bridge's own words, which the workers read as a refusal of the request's size (context-overflow.ts).
		return relayRefusal{400, "context_length_exceeded", "Input is too long for requested model", "context_limit", true}
	case kind == "invalid_request_error":
		message := detail
		if message == "" || len(message) > 300 {
			message = "The model service cannot take this request"
		}
		return relayRefusal{400, "invalid_request_error", message, "runtime_rejected", true}
	case status == 400:
		// AWS refusing the request itself (a ValidationException, such as a picture it cannot read) before any
		// inference: the person's request, which asking again would only repeat.
		return relayRefusal{400, "invalid_request_error", "The model service refused the request", "runtime_rejected", true}
	case status == 429:
		return relayRefusal{429, kind, "The model service is rate limited", "provider_rate_limited", true}
	}
	// AWS refusing the operator's own access, quota or service: the hosted site's trouble, never the person's
	// credentials, so the local edition reads it as the service unavailable. A server error may follow work.
	return relayRefusal{503, kind, "The model service is unavailable", "provider_unavailable", status == 401 || status == 403 || status == 404 || status == 503}
}

// afterFallback is a refusal's ledger code once the call went to the model's other profile: a rate limit or an
// authentication refusal is otherwise taken as one that came before any work, and given back (plans.go
// refusedBeforeOutput).
func afterFallback(code string) string {
	if code == "provider_rate_limited" || code == "provider_auth_failed" {
		return "provider_unavailable"
	}
	return code
}

// relayFrameCode is the ledger's code for a relayed call whose stream ended on an error frame: the bridge's (an AWS
// failure after the stream began, by its status) or the Pi worker's own (timeout, output_limit, worker_lost…).
func relayFrameCode(kind string, status int) string {
	switch {
	case kind == "timeout":
		return "run_timeout"
	case kind == "output_limit":
		return "output_limit"
	case kind == "worker_lost" || kind == "worker_error" || kind == "cancelled" || kind == "stopping":
		return "runtime_failed"
	case status == 429:
		return "provider_rate_limited"
	case status == 401 || status == 403:
		return "provider_auth_failed"
	case status == 0:
		// The bridge's refusal of what the model sent (no AWS status): the model's own answer did not hold.
		return "inconsistent_runtime_output"
	}
	return "provider_unavailable"
}

// relayUsage reads a chunk's usage as the Pi worker's usage reader does a Chat Completions call's (apps/pi-worker/usage.mjs
// normalizeUsage): prompt and completion tokens, cached prompt tokens and reasoning tokens where given.
func relayUsage(raw json.RawMessage) InvocationUsage {
	var u struct {
		Prompt     *int64 `json:"prompt_tokens"`
		Completion *int64 `json:"completion_tokens"`
		Total      *int64 `json:"total_tokens"`
		PromptInfo *struct {
			Cached *int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CompletionInfo *struct {
			Reasoning *int64 `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	}
	if json.Unmarshal(raw, &u) != nil {
		return missingUsage("invalid", "protocol_invalid")
	}
	out := InvocationUsage{Source: "provider_raw", InputTokens: u.Prompt, OutputTokens: u.Completion, ProviderTotalTokens: u.Total}
	if u.PromptInfo != nil {
		out.CachedInputTokens = u.PromptInfo.Cached
	}
	if u.CompletionInfo != nil {
		out.ReasoningTokens = u.CompletionInfo.Reasoning
	}
	for _, n := range []*int64{out.InputTokens, out.OutputTokens, out.ProviderTotalTokens, out.CachedInputTokens, out.ReasoningTokens} {
		if n != nil && (*n < 0 || *n > 9007199254740991) {
			return missingUsage("invalid", "protocol_invalid")
		}
	}
	if out.InputTokens == nil && out.OutputTokens == nil {
		return missingUsage("unavailable", "provider_missing")
	}
	if out.InputTokens == nil || out.OutputTokens == nil {
		out.Status, out.Reason = "partial", "field_missing"
		return out
	}
	total := *out.InputTokens + *out.OutputTokens
	if (out.ProviderTotalTokens != nil && *out.ProviderTotalTokens != total) || (out.CachedInputTokens != nil && *out.CachedInputTokens > *out.InputTokens) ||
		(out.ReasoningTokens != nil && *out.ReasoningTokens > *out.OutputTokens) {
		return missingUsage("invalid", "total_mismatch")
	}
	out.ComputedTotalTokens = int64ptr(total)
	out.Status, out.Reason = "reported", "none"
	return out
}

// relayEvent is one thing the worker's side of a relayed call says: its refusal, that its stream began, a line of it,
// its end, or a failure.
type relayEvent struct {
	status   int
	body     []byte
	began    bool
	fallback bool // the stream that began is the model's other profile's (x-awwo-relay-fallback)
	line     []byte
	done     bool
	err      error
	unsent   bool // it failed before it reached the worker
}

// relayEnvelope reads a relayed request's body straight into the envelope the Pi worker takes, so the API holds one copy
// of it: {"relayId":…,"tenantId":…,"body":<the request>,"model":…}. It returns the envelope and the request's model.
func relayEnvelope(w http.ResponseWriter, r *http.Request, invID, tid string, size int64) ([]byte, string, error) {
	prefix := `{"relayId":"` + invID + `","tenantId":"` + tid + `","body":`
	buf := bytes.NewBuffer(make([]byte, 0, len(prefix)+int(size)+1024))
	buf.WriteString(prefix)
	if _, e := buf.ReadFrom(http.MaxBytesReader(w, r.Body, relayBodyLimit)); e != nil {
		return nil, "", e
	}
	raw := buf.Bytes()[len(prefix):]
	var head struct {
		Model  string `json:"model"`
		Stream *bool  `json:"stream"`
	}
	if trimmed := bytes.TrimSpace(raw); json.Unmarshal(raw, &head) != nil || !json.Valid(raw) || len(trimmed) == 0 || trimmed[0] != '{' || !jsonDepthWithin(raw, relayJSONDepth) {
		return nil, "", errRelayRequest
	}
	if !relayModelPattern.MatchString(head.Model) {
		return nil, "", errRelayModel
	}
	if head.Stream == nil || !*head.Stream {
		return nil, "", errRelayStream
	}
	buf.WriteString(`,"model":"` + head.Model + `"}`)
	return buf.Bytes(), head.Model, nil
}

// jsonDepthWithin reports whether valid JSON nests its objects and arrays no deeper than limit.
func jsonDepthWithin(raw []byte, limit int) bool {
	depth, quoted, escaped := 0, false, false
	for _, c := range raw {
		switch {
		case quoted:
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
		case c == '"':
			quoted = true
		case c == '{' || c == '[':
			if depth++; depth > limit {
				return false
			}
		case c == '}' || c == ']':
			depth--
		}
	}
	return true
}

var (
	errRelayRequest = errors.New("invalid_request")
	errRelayModel   = errors.New("model_not_found")
	errRelayStream  = errors.New("stream_required")
)

// relayChat answers POST /relay/v1/chat/completions.
func (a *App) relayChat(w http.ResponseWriter, r *http.Request) {
	link, ok := a.relayRequestLink(w, r)
	if !ok {
		return
	}
	if media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type")); e != nil || media != "application/json" {
		relayFail(w, 415, "unsupported_media_type", "invalid_request_error", "Use application/json")
		return
	}
	if r.ContentLength > relayBodyLimit {
		relayFail(w, 413, "request_too_large", "invalid_request_error", "The request is larger than the relay takes (16 MiB)")
		return
	}
	// The link's slot and the body's share of the API's memory come before the body is read: a burst of large requests
	// waits on neither, and is refused before it takes any memory.
	if !a.relayCalls.take(link.ID) {
		w.Header().Set("Retry-After", "10")
		relayFail(w, 429, "relay_busy", "rate_limit_error", "This connection is making as many calls as it may at once")
		return
	}
	defer a.relayCalls.give(link.ID)
	held := r.ContentLength
	if held < 0 {
		held = relayBodyLimit // a request without its length holds the most it may send
	}
	if !a.relayHeld.take(link.UserID, held) {
		w.Header().Set("Retry-After", "10")
		relayFail(w, 429, "relay_busy", "rate_limit_error", "The relay is busy; try again shortly")
		return
	}
	// Given back once the Pi worker has the body, or when the call ends before.
	release := sync.OnceFunc(func() { a.relayHeld.give(link.UserID, held) })
	defer release()
	invID := "r" + randomID()[1:]
	envelope, model, e := relayEnvelope(w, r, invID, link.TenantID, max(0, r.ContentLength))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(e, &tooLarge):
		relayFail(w, 413, "request_too_large", "invalid_request_error", "The request is larger than the relay takes (16 MiB)")
		return
	case errors.Is(e, errRelayModel):
		relayFail(w, 404, "model_not_found", "invalid_request_error", "The model does not exist or the relay does not offer it")
		return
	case errors.Is(e, errRelayStream):
		relayFail(w, 400, "stream_required", "invalid_request_error", "The relay answers streaming requests only (stream: true)")
		return
	case e != nil:
		relayFail(w, 400, "invalid_request", "invalid_request_error", "The request body must be a JSON object")
		return
	}
	models, e := a.relayModels(r.Context())
	if e != nil {
		relayFail(w, 503, "relay_unavailable", "api_error", "The hosted models are unavailable; try again shortly")
		return
	}
	i := slices.IndexFunc(models, func(m relayModel) bool { return m.ID == model })
	if i < 0 {
		relayFail(w, 404, "model_not_found", "invalid_request_error", "The model does not exist or the relay does not offer it")
		return
	}
	facts := &invocationFacts{Runtime: runtimePI, Model: model, Provider: "bedrock", ProviderModel: models[i].ProviderModel, Protocol: "chat_completions",
		Admission: "not_attempted", Usage: missingUsage("unavailable", "provider_missing"), InputBytes: int64(len(envelope))}
	// From its admission until it is settled the call is the API's own work, as a run is: an API that closes, or that
	// lost its database lease (Start), stops it with its runs, and Close waits for it to be settled before it lets the
	// lease go. Its database work runs under ctx, so a wait for a lock ends with it too.
	ctx, cancel := context.WithTimeout(r.Context(), relayCallLimit)
	defer cancel()
	key := "relay:" + invID
	a.mu.Lock()
	closing := a.closed
	if !closing {
		a.running[key] = cancel
		a.tasks.Add(1)
	}
	a.mu.Unlock()
	if closing {
		relayFail(w, 503, "worker_unavailable", "api_error", "The relay is restarting; try again shortly")
		return
	}
	defer func() {
		a.mu.Lock()
		delete(a.running, key)
		a.mu.Unlock()
		a.tasks.Done()
	}()
	// The admission's own deadline holds a single try blocked on a lock too.
	admit, admitted := context.WithTimeout(ctx, relayAdmissionWait+5*time.Second)
	e = a.reserveRelayInvocation(admit, link, invID, model, facts)
	admitted()
	if e != nil {
		switch {
		case r.Context().Err() != nil:
			// The person's computer went away while the call waited.
		case a.relayClosing():
			relayFail(w, 503, "worker_unavailable", "api_error", "The relay is restarting; try again shortly")
		case errors.Is(e, context.DeadlineExceeded):
			a.relayAdmissionFailure(w, errRelayBusy)
		default:
			a.relayAdmissionFailure(w, e)
		}
		return
	}
	status, code := "failed", "runtime_failed"
	defer func() { a.settleRelayCallOrRetry(link, invID, status, code, facts) }()
	// Uncertainty is recorded before the call is sent: a crash from here on can no longer turn it into not_incurred.
	if e = a.markInvocationAdmission(ctx, link.TenantID, invID, facts, "unknown"); e != nil {
		facts.Admission = "rejected_before_start"
		relayFail(w, 503, "relay_unavailable", "api_error", "Could not record the model call; try again")
		return
	}
	events := make(chan relayEvent, 16)
	stopped := make(chan struct{})
	defer close(stopped)
	facts.Sent = time.Now()
	facts.Streamed = facts.Sent
	go a.relayWorkerCall(ctx, envelope, release, events, stopped)
	envelope = nil
	s := relayStream{w: w, rc: http.NewResponseController(w)}
	hold := time.NewTimer(relayHoldWindow)
	defer hold.Stop()
	ticker := time.NewTicker(relayKeepalive / 3)
	defer ticker.Stop()
	var finish, frameKind string
	frameStatus := -1
	fellBack := false
	// concluded: the stream said how the call ended ([DONE], or an error frame), so what comes after (the person's
	// computer leaving before the worker's stream closes) changes nothing.
	concluded := false
	conclude := func() {
		if concluded {
			return
		}
		concluded = true
		facts.Ended = time.Now()
		facts.Terminal = true
		if frameStatus >= 0 {
			status, code = "failed", relayFrameCode(frameKind, frameStatus)
			if fellBack {
				code = afterFallback(code)
			}
		} else {
			status, code = "completed", ""
		}
	}
	gone := func() {
		if !concluded {
			facts.Ended = time.Now()
			status, code = "cancelled", "cancelled"
		}
	}
	refused := func(why relayRefusal) {
		facts.Ended = time.Now()
		if why.noWork && facts.sinceSent(facts.Ended) < quickRefusal() {
			facts.Admission = "rejected_before_start"
		}
		status, code = "failed", why.code
		if s.answered {
			s.write(relayStreamFrame(why.message, why.kind, why.status))
			return
		}
		if why.status == 429 || why.status == 503 {
			w.Header().Set("Retry-After", "10")
		}
		relayFail(w, why.status, why.kind, relayErrorType(why.status), why.message)
	}
	// ended: the call's context ended (its own limit, the person's computer leaving, or the API stopping it: the
	// registration above), whichever way this loop hears of it first.
	ended := func() {
		switch {
		case r.Context().Err() != nil:
			gone()
		case concluded:
		case a.relayClosing():
			facts.Ended = time.Now()
			status, code = "interrupted", ""
			if s.answered {
				s.write(relayStreamFrame("The relay is restarting; try again shortly", "api_error", 503))
			} else {
				relayFail(w, 503, "worker_unavailable", "api_error", "The relay is restarting; try again shortly")
			}
		default:
			refused(relayRefusal{504, "timeout", "The model call reached its time limit", "run_timeout", false})
		}
	}
	for {
		select {
		case <-r.Context().Done():
			gone()
			return
		case <-ctx.Done():
			ended()
			return
		case <-hold.C:
			// The worker has not answered within the hold window: answer now, so nothing stays silent for long.
			if s.answered {
				continue
			}
			if !s.write([]byte(": awwo relay\n\n")) {
				gone()
				return
			}
		case <-ticker.C:
			if s.answered && time.Since(s.last) >= relayKeepalive && !s.write([]byte(": keepalive\n\n")) {
				gone()
				return
			}
		case ev := <-events:
			switch {
			case ev.err != nil:
				switch {
				case concluded:
				case ctx.Err() != nil:
					ended()
				case ev.unsent:
					refused(relayRefusal{503, "api_error", "The hosted model service is unavailable", "runtime_unavailable", true})
				default:
					refused(relayRefusal{502, "api_error", "The hosted model service failed", "runtime_unavailable", false})
				}
				return
			case ev.status != 0:
				refused(relayWorkerRefusal(ev.status, ev.body))
				return
			case ev.began:
				facts.Admission = "accepted"
				fellBack = ev.fallback
				if !s.answer() {
					gone()
					return
				}
			case ev.line != nil:
				line := ev.line
				if len(line) > 0 && line[0] == ':' {
					continue // the worker's comments: this stream sends its own
				}
				if data, isData := bytes.CutPrefix(line, []byte("data:")); isData {
					data = bytes.TrimSpace(data)
					if bytes.Equal(data, []byte("[DONE]")) {
						if finish != "" || frameStatus >= 0 {
							conclude()
						}
					} else if replacement := relayRead(data, facts, &finish, &frameKind, &frameStatus); replacement != nil {
						line = replacement
					}
					if frameStatus >= 0 {
						conclude() // an error frame is the call's last word, whatever follows it
					}
				}
				if !s.write(append(line, '\n')) {
					gone()
					return
				}
			case ev.done:
				switch {
				case concluded:
				case finish != "":
					conclude()
				default:
					facts.Ended = time.Now()
					s.write(relayStreamFrame("The model's answer ended before it was complete", "api_error", 502))
					status, code = "failed", "runtime_stream_ended"
				}
				return
			}
		}
	}
}

// relayClosing tells whether the API is closing (Close, or a lost database lease).
func (a *App) relayClosing() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closed
}

// relayStream writes a relayed call's answer to the person's computer: the headers once, then each piece flushed at
// once, each write within relayWriteLimit.
type relayStream struct {
	w        http.ResponseWriter
	rc       *http.ResponseController
	answered bool
	last     time.Time
}

func (s *relayStream) answer() bool {
	if s.answered {
		return true
	}
	s.answered = true
	s.w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	s.w.Header().Set("Cache-Control", "no-cache")
	s.w.Header().Set("X-Accel-Buffering", "no")
	_ = s.rc.SetWriteDeadline(time.Now().Add(relayWriteLimit))
	s.w.WriteHeader(200)
	s.last = time.Now()
	return s.rc.Flush() == nil
}

func (s *relayStream) write(b []byte) bool {
	if !s.answer() {
		return false
	}
	_ = s.rc.SetWriteDeadline(time.Now().Add(relayWriteLimit))
	if _, e := s.w.Write(b); e != nil {
		return false
	}
	s.last = time.Now()
	return s.rc.Flush() == nil
}

// relayRead reads one data line of a relayed stream for the call's record: its first output, what the model wrote
// (its reasoning included), its finish reason, its usage, or the error frame it ended on. It returns a line to write in
// place of this one, or nil: AWS refusing the operator's own credentials after the stream began is the service
// unavailable to the person's computer, as it is before (relayWorkerRefusal), never their own credentials refused.
func relayRead(data []byte, facts *invocationFacts, finish, frameKind *string, frameStatus *int) []byte {
	var chunk struct {
		Error *struct {
			Type   string `json:"type"`
			Code   string `json:"code"`
			Status int    `json:"status"`
		} `json:"error"`
		Choices []struct {
			Delta struct {
				Content   *string `json:"content"`
				Reasoning *string `json:"reasoning_content"`
				ToolCalls []struct {
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(data, &chunk) != nil {
		return nil
	}
	if chunk.Error != nil {
		*frameKind = computerWorkerLabel(chunk.Error.Type)
		*frameStatus = max(0, chunk.Error.Status)
		if chunk.Error.Status == 401 || chunk.Error.Status == 403 {
			return bytes.TrimRight(relayStreamFrame("The model service is unavailable", *frameKind, 503), "\n")
		}
		return nil
	}
	for _, choice := range chunk.Choices {
		// What the model wrote, as an answer read whole counts it (plans.go creditCharge estimates from it), never the
		// chunks' framing. Reasoning is output the model was paid to write, and shows it did work: a refusal after it
		// is no refusal before output (refusedBeforeOutput).
		written := 0
		if choice.Delta.Content != nil {
			written += len(*choice.Delta.Content)
		}
		if choice.Delta.Reasoning != nil {
			written += len(*choice.Delta.Reasoning)
		}
		for _, call := range choice.Delta.ToolCalls {
			written += len(call.Function.Name) + len(call.Function.Arguments)
		}
		if written > 0 {
			if facts.FirstOutput.IsZero() {
				facts.FirstOutput = time.Now()
			}
			facts.OutputBytes += int64(written)
		}
		if choice.FinishReason != nil && *choice.FinishReason != "" {
			*finish = *choice.FinishReason
		}
	}
	if len(chunk.Usage) > 0 && !bytes.Equal(chunk.Usage, []byte("null")) {
		facts.Usage = relayUsage(chunk.Usage)
		version := 1
		facts.Version = &version
		provider := time.Since(facts.Sent).Milliseconds()
		facts.Timing.ProviderMs = int64ptr(provider)
		if !facts.FirstOutput.IsZero() {
			facts.Timing.ProviderTtftMs = int64ptr(min(provider, facts.FirstOutput.Sub(facts.Sent).Milliseconds()))
		}
	}
	return nil
}

// sentBody is a relayed call's body as the worker's request sends it: once all of it has gone, it lets go of the bytes
// and calls sent. Read alone, so the transport copies through it (a bytes.Reader's WriteTo would pass it by).
type sentBody struct {
	r    *bytes.Reader
	sent func()
}

func (b *sentBody) Read(p []byte) (int, error) {
	if b.r == nil {
		return 0, io.EOF
	}
	n, e := b.r.Read(p)
	if b.r.Len() == 0 {
		b.r = nil
		b.sent()
	}
	return n, e
}

// relayWorkerCall sends one relayed call to the Pi worker and says what comes back on events, until stopped closes.
// sent is called once the worker has the whole body.
func (a *App) relayWorkerCall(ctx context.Context, body []byte, sent func(), events chan<- relayEvent, stopped <-chan struct{}) {
	say := func(ev relayEvent) bool {
		select {
		case events <- ev:
			return true
		case <-stopped:
			return false
		}
	}
	endpoint, token, e := a.runtimeEndpoint(runtimePI)
	if e != nil {
		say(relayEvent{err: e, unsent: true})
		return
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint+"/internal/relay-model", &sentBody{bytes.NewReader(body), sent})
	if e != nil {
		say(relayEvent{err: e, unsent: true})
		return
	}
	req.ContentLength = int64(len(body))
	body = nil
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, e := a.relayClient().Do(req)
	if e != nil {
		say(relayEvent{err: e, unsent: dialFailed(e)})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		say(relayEvent{status: resp.StatusCode, body: data})
		return
	}
	if !say(relayEvent{began: true, fallback: resp.Header.Get("X-Awwo-Relay-Fallback") == "1"}) {
		return
	}
	reader := bufio.NewReaderSize(resp.Body, 64<<10)
	for {
		line, e := readRelayLine(reader)
		if line != nil && !say(relayEvent{line: line}) {
			return
		}
		if errors.Is(e, io.EOF) {
			say(relayEvent{done: true})
			return
		}
		if e != nil {
			say(relayEvent{err: e})
			return
		}
	}
}

var errRelayLine = errors.New("relay stream line too long")

// readRelayLine reads one line without its line end, at most relayLineLimit long.
func readRelayLine(r *bufio.Reader) ([]byte, error) {
	// Never nil for a line read, an empty one included: an empty line ends an SSE event.
	line := make([]byte, 0, 256)
	for {
		part, more, e := r.ReadLine()
		line = append(line, part...)
		if len(line) > relayLineLimit {
			return nil, errRelayLine
		}
		if e != nil {
			if len(line) > 0 && errors.Is(e, io.EOF) {
				return line, nil
			}
			return nil, e
		}
		if !more {
			return line, nil
		}
	}
}

// relayClient is the API's HTTP client for relayed calls: the worker's own limit and the call's context bound them, not
// the client's overall timeout (AWWO_RUN_TIMEOUT), which a long call may outlast.
func (a *App) relayClient() *http.Client {
	return &http.Client{Transport: a.client.Transport, CheckRedirect: a.client.CheckRedirect}
}

// settleRelayCall settles one relayed call in its own transaction, retried as a direct task's calls are.
func (a *App) settleRelayCall(tid, id, status, code string, facts *invocationFacts) error {
	ctx, cancel := context.WithTimeout(context.Background(), computerCallSettleLimit)
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

// settleRelayCallOrRetry settles a relayed call, and keeps trying in the background for a few minutes when the database
// will not take it: until then the call holds its workspace's slot and its credit reserve (settleStaleRelayCalls is the
// last resort, as an API restart is). A closing API stops trying: its next start settles every call still running.
func (a *App) settleRelayCallOrRetry(link relayLink, id, status, code string, facts *invocationFacts) {
	if e := a.settleRelayCall(link.TenantID, id, status, code, facts); e == nil {
		return
	}
	a.log.Warn("relayed call settlement failed; retrying", "link", link.ID, "invocation", id)
	closing := func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return a.closed
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		wait := time.Second
		for attempt := 0; attempt < 8; attempt++ {
			for slept := time.Duration(0); slept < wait; slept += 100 * time.Millisecond {
				if closing() {
					return
				}
				time.Sleep(100 * time.Millisecond)
			}
			if e := a.settleRelayCall(link.TenantID, id, status, code, facts); e == nil {
				return
			}
			wait = min(wait*2, 30*time.Second)
		}
		a.log.Error("relayed call settlement failed", "link", link.ID, "invocation", id)
	}()
}
