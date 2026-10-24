package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// The cloud relay: AwwO 本地版 has this site make its model calls (owner 2026-10-24: 「本地连接云端服务器再发送到
// bedrock」). A local install cannot reach every model itself (Anthropic's on Bedrock refuse streamed calls from some
// countries, and this site's AWS credentials work from its own host alone), so it sends each call here with a key its
// member made on 设置 → 本机版连接 for one of their workspaces. The call runs on this site's relay worker (a Pi worker
// whose catalog is the models offered: AWWO_RELAY_WORKER_URL) through its managed-call route, and is admitted, recorded
// and charged as one of that workspace's model calls: its owner's plan and credits, or its free allowance and paid-route
// allowances, as the owner chose (「计入线上账号」). Nothing of a call's words is kept: the ledger records its usage, as
// for any call.

// relaySettings are the relay's switches: AWWO_RELAY=on, and its worker's URL and token. Off unless AWWO_RELAY=on.
type relaySettings struct {
	Relay                            bool
	RelayWorkerURL, RelayWorkerToken string
}

func (c *Config) relayFromEnv() error {
	switch os.Getenv("AWWO_RELAY") {
	case "", "off":
	case "on":
		c.Relay = true
	default:
		return errors.New("AWWO_RELAY must be on or off")
	}
	c.RelayWorkerURL, c.RelayWorkerToken = os.Getenv("AWWO_RELAY_WORKER_URL"), os.Getenv("AWWO_RELAY_WORKER_TOKEN")
	return nil
}

// validateRelay checks the relay's settings: with the relay on, a loopback worker origin and its token; never on the
// local edition or with personal keys, whose calls are their person's own.
func (c Config) validateRelay() error {
	if !c.Relay {
		if c.RelayWorkerURL != "" || c.RelayWorkerToken != "" {
			return errors.New("AWWO_RELAY_WORKER_URL and AWWO_RELAY_WORKER_TOKEN need AWWO_RELAY=on")
		}
		return nil
	}
	if c.Edition == editionLocal || c.UserCredentials {
		return errors.New("AWWO_RELAY=on serves this site's own models: not with AWWO_EDITION=local or AWWO_CREDENTIAL_MODE=user")
	}
	u, e := url.Parse(c.RelayWorkerURL)
	if e != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") ||
		(u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" && u.Hostname() != "localhost") {
		return errors.New("AWWO_RELAY_WORKER_URL must be a loopback HTTP origin")
	}
	if len(c.RelayWorkerToken) < 32 || strings.ContainsAny(c.RelayWorkerToken, " \t\r\n") {
		return errors.New("AWWO_RELAY_WORKER_TOKEN must be at least 32 characters without spaces")
	}
	return nil
}

const (
	relayModelsRoute      = "/api/v1/relay/v1/models"
	relayCompletionsRoute = "/api/v1/relay/v1/chat/completions"
	// relayKeyLimit is how many live keys one account may hold, and relayKeyLife how long a key works: a sign-in here is
	// checked with ClawHunt again and again, a key never is, so a member whose ClawHunt access ends keeps a key at most
	// that long.
	relayKeyLimit = 5
	relayKeyLife  = "90 days"
	// relayBodyLimit is the most of one call this site reads, and the most it forwards: what the worker's managed-call
	// route reads (computerWorkerBodyLimit), less room for the fields this site adds.
	relayBodyLimit = computerWorkerBodyLimit - 8<<10
	// relayCatalogTTL is how long the relay worker's catalog is reused.
	relayCatalogTTL = 30 * time.Second
)

var (
	// relaySlotWait is how long a call waits for a free place among its workspace's or its plan's calls at once before it
	// is refused: nothing is sent to its caller meanwhile, and the edge in front of this site cuts a silent response at
	// about 100 s. A variable for the tests only, as is relayHeartbeat.
	relaySlotWait = 60 * time.Second
	// relayHeartbeat is how often a streamed call's response shows it is still there while its model works.
	relayHeartbeat = 15 * time.Second
)

var relayKeyPattern = regexp.MustCompile(`^awwo_rk_[A-Za-z0-9_-]{43}$`)

// newRelayKey is a key and what this site keeps of it: its SHA-256 and the prefix its member sees.
func newRelayKey() (key, hash, prefix string) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	key = "awwo_rk_" + base64.RawURLEncoding.EncodeToString(b)
	return key, tokenHash(key), key[:len("awwo_rk_")+4]
}

func (a *App) registerRelayRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/auth/relay-keys", a.auth(a.listRelayKeys))
	m.HandleFunc("POST /api/v1/auth/relay-keys", a.auth(a.authRate(a.createRelayKey)))
	m.HandleFunc("DELETE /api/v1/auth/relay-keys/{id}", a.auth(a.revokeRelayKey))
	m.HandleFunc("GET "+relayModelsRoute, a.relayModels)
	m.HandleFunc("POST "+relayCompletionsRoute, a.relayCompletion)
}

func (a *App) relayAvailable(w http.ResponseWriter) bool {
	if !a.cfg.Relay {
		fail(w, 404, "relay_unavailable", "Connections for AwwO 本地版 are not offered here")
		return false
	}
	return true
}

const relayKeyJSON = `jsonb_build_object('id',k.id,'name',k.name,'prefix',k.prefix,'tenant',jsonb_build_object('id',t.id,'name',t.name),
	'createdAt',k.created_at,'expiresAt',k.expires_at,'lastUsedAt',k.last_used_at,'revokedAt',k.revoked_at)`

// listRelayKeys lists the account's keys: the live ones and the twenty it revoked last, newest first. An expired key is
// listed as it is (expiresAt in the past) until it is revoked.
func (a *App) listRelayKeys(w http.ResponseWriter, r *http.Request) {
	if !a.relayAvailable(w) {
		return
	}
	items, e := rowsJSON(r.Context(), a.db, `SELECT `+relayKeyJSON+` FROM relay_keys k JOIN tenants t ON t.id=k.tenant_id
		WHERE k.user_id=$1 AND (k.revoked_at IS NULL OR k.id IN (SELECT id FROM relay_keys WHERE user_id=$1 AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 20))
		ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC, k.id`, currentUser(r).ID)
	if e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "limit": relayKeyLimit})
}

// createRelayKey makes a key for one of the member's workspaces, one it may run calls in (as a member, an admin or its
// owner, while it is active). The key itself is in this answer alone.
func (a *App) createRelayKey(w http.ResponseWriter, r *http.Request) {
	if !a.relayAvailable(w) {
		return
	}
	var b struct {
		Name     string `json:"name"`
		TenantID string `json:"tenantId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" {
		b.Name = "AwwO 本地版"
	}
	if len([]rune(b.Name)) > 80 || strings.ContainsAny(b.Name, "\r\n\x00") || b.TenantID == "" || len(b.TenantID) > 200 {
		fail(w, 400, "invalid_relay_key", "Name the key (at most 80 characters) and choose one of your workspaces")
		return
	}
	uid := currentUser(r).ID
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	// The account's row serializes its keys, so two made at once cannot pass the limit together.
	var member bool
	var live int
	if _, e = tx.Exec(r.Context(), "SELECT 1 FROM users WHERE id=$1 FOR UPDATE", uid); e == nil {
		e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
			WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin','member') AND t.status='active'),
			(SELECT count(*) FROM relay_keys WHERE user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp())`, b.TenantID, uid).Scan(&member, &live)
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !member {
		fail(w, 404, "tenant_not_found", "Workspace not found")
		return
	}
	if live >= relayKeyLimit {
		fail(w, 409, "relay_key_limit", fmt.Sprintf("At most %d connection keys at once: revoke one first", relayKeyLimit))
		return
	}
	key, hash, prefix := newRelayKey()
	id := randomID()
	if _, e = tx.Exec(r.Context(), "INSERT INTO relay_keys(id,user_id,tenant_id,key_hash,prefix,name,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7::interval)",
		id, uid, b.TenantID, hash, prefix, b.Name, relayKeyLife); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, uid, b.TenantID, "relay_key.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	item, e := oneJSON(r.Context(), tx, `SELECT `+relayKeyJSON+` FROM relay_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.id=$1`, id)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 201, map[string]any{"key": key, "item": item})
}

func (a *App) revokeRelayKey(w http.ResponseWriter, r *http.Request) {
	if !a.relayAvailable(w) {
		return
	}
	uid, id := currentUser(r).ID, r.PathValue("id")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	var tenant string
	e = tx.QueryRow(r.Context(), "UPDATE relay_keys SET revoked_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING tenant_id", id, uid).Scan(&tenant)
	if noRows(e) {
		fail(w, 404, "not_found", "Connection key not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, uid, tenant, "relay_key.revoked", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}

// relayCaller is who a relayed call is from: its key, the key's member and the workspace it counts in.
type relayCaller struct{ keyID, userID, tenantID string }

// relayAuthenticate reads a relayed call's key: a live key of a member of an active workspace, sent by a program, never
// by a page (a request with any Origin is refused, so a key pasted into a site cannot be used from it).
func (a *App) relayAuthenticate(w http.ResponseWriter, r *http.Request) (relayCaller, bool) {
	var c relayCaller
	if !a.relayAvailable(w) {
		return c, false
	}
	if r.Header.Get("Origin") != "" {
		fail(w, 403, "relay_browser_refused", "Connection keys are for AwwO 本地版, not for web pages")
		return c, false
	}
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !relayKeyPattern.MatchString(key) {
		fail(w, 401, "relay_key_invalid", "Invalid connection key")
		return c, false
	}
	var expired bool
	var role, status string
	e := a.db.QueryRow(r.Context(), `SELECT k.id,k.user_id,k.tenant_id,k.expires_at<=clock_timestamp(),COALESCE(m.role,''),t.status FROM relay_keys k
		JOIN tenants t ON t.id=k.tenant_id LEFT JOIN memberships m ON m.tenant_id=k.tenant_id AND m.user_id=k.user_id
		WHERE k.key_hash=$1 AND k.revoked_at IS NULL`, tokenHash(key)).Scan(&c.keyID, &c.userID, &c.tenantID, &expired, &role, &status)
	switch {
	case noRows(e):
		fail(w, 401, "relay_key_invalid", "Invalid connection key")
	case e != nil:
		a.dbError(w, e)
	case expired:
		fail(w, 401, "relay_key_expired", "This connection key has expired: make a new one on 设置 → 本机版连接")
	case roleLevel(role) < roleLevel("member"):
		fail(w, 403, "relay_key_forbidden", "This key's account can no longer run calls in its workspace")
	case status != "active":
		fail(w, 403, "tenant_suspended", "Workspace is suspended")
	default:
		// When it was last used, written at most once a minute.
		_, _ = a.db.Exec(r.Context(), "UPDATE relay_keys SET last_used_at=clock_timestamp() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute')", c.keyID)
		return c, true
	}
	return c, false
}

// relayModel is one model of the relay worker's catalog, as its health lists it (apps/pi-worker/config.mjs publicHealth).
type relayModel struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Provider           string  `json:"provider"`
	ProviderModel      string  `json:"providerModel"`
	Protocol           string  `json:"protocol"`
	ContextWindow      int     `json:"contextWindow"`
	MaxOutputTokens    int     `json:"maxOutputTokens"`
	ProseBytesPerToken float64 `json:"proseBytesPerToken"`
}

type relayCatalogCache struct {
	mu     sync.Mutex
	at     time.Time
	models []relayModel
}

// relayCatalog is the relay worker's catalog, read from its health and reused for relayCatalogTTL: the models its
// managed-call route serves (a Bedrock one through the worker's Bedrock call, which it claims as computerBedrock), with
// limits a call can be sized by.
func (a *App) relayCatalog(ctx context.Context) ([]relayModel, error) {
	c := &a.relayCatalogCache
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.models != nil && time.Since(c.at) < relayCatalogTTL {
		return c.models, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(a.cfg.RelayWorkerURL, "/")+"/health", nil)
	if e != nil {
		return nil, e
	}
	resp, e := a.client.Do(req)
	if e != nil {
		return nil, errors.New("relay worker unavailable")
	}
	defer resp.Body.Close()
	body, e := io.ReadAll(io.LimitReader(resp.Body, maxRuntimeHealthBytes+1))
	var health struct {
		Ready           bool         `json:"ready"`
		ComputerBedrock bool         `json:"computerBedrock"`
		Models          []relayModel `json:"models"`
	}
	if e != nil || len(body) > maxRuntimeHealthBytes || resp.StatusCode != 200 || json.Unmarshal(body, &health) != nil || !health.Ready || len(health.Models) > maxRuntimeModels {
		return nil, errors.New("relay worker not ready")
	}
	models, seen := make([]relayModel, 0, len(health.Models)), map[string]bool{}
	for _, m := range health.Models {
		if m.ID == "" || len(m.ID) > 200 || seen[m.ID] || (m.Provider == "bedrock" && !health.ComputerBedrock) ||
			m.ContextWindow < 4096 || m.MaxOutputTokens < 1 || m.MaxOutputTokens+256 >= m.ContextWindow {
			continue
		}
		m.ProseBytesPerToken = max(1, m.ProseBytesPerToken)
		seen[m.ID] = true
		models = append(models, m)
	}
	c.models, c.at = models, time.Now()
	return models, nil
}

// relayRuntime is the runtime a relayed call is recorded and priced as (AWWO_MODEL_PRICING_JSON is keyed runtime:model):
// the one this site prices the model under, the OpenAI Agents runtime first (this site's Bedrock catalog serves most
// models there and a few on Pi), or the relay worker's own, Pi, for a model priced under neither.
func (a *App) relayRuntime(model string) string {
	for _, runtime := range []string{runtimeOpenAIAgents, runtimePI} {
		if _, _, ok := a.creditRates(runtime, model); ok {
			return runtime
		}
	}
	return runtimePI
}

// relayModels lists the models a key's workspace may have this site run: the relay worker's catalog as its entitlement
// permits, with what a caller needs to size its calls (AwwO's fields beside OpenAI's): a call may hold
// context_window - max_output_tokens - 256 tokens, counted at prose_bytes_per_token bytes a token of its JSON plus 32 a
// message, as the worker counts it.
func (a *App) relayModels(w http.ResponseWriter, r *http.Request) {
	caller, ok := a.relayAuthenticate(w, r)
	if !ok {
		return
	}
	models, e := a.relayCatalog(r.Context())
	if e != nil {
		fail(w, 503, "relay_unavailable", "Cloud models are unavailable right now")
		return
	}
	var restricted bool
	var allowed []string
	if e = a.db.QueryRow(r.Context(), "SELECT allowed_models IS NOT NULL,COALESCE(allowed_models,'{}') FROM tenants WHERE id=$1", caller.tenantID).Scan(&restricted, &allowed); e != nil {
		a.dbError(w, e)
		return
	}
	entitlement, e := newModelEntitlement(restricted, allowed)
	if e != nil {
		fail(w, 503, "relay_unavailable", "Cloud models are unavailable right now")
		return
	}
	data := []map[string]any{}
	for _, m := range models {
		if !entitlement.permits(m.ID) {
			continue
		}
		name := m.Name
		if name == "" {
			name = m.ID
		}
		data = append(data, map[string]any{"id": m.ID, "object": "model", "owned_by": "awwo", "name": name,
			"context_window": m.ContextWindow, "max_output_tokens": m.MaxOutputTokens, "prose_bytes_per_token": m.ProseBytesPerToken})
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": data})
}

// relayCall is a relayed call as this site forwards it: its model, its messages and tools (as the worker's managed-call
// route reads them), whether its caller reads the answer streamed, and the output limit it asked for (0: the model's).
type relayCall struct {
	Model     string
	Messages  []map[string]any
	Tools     []json.RawMessage
	Stream    bool
	MaxTokens int
}

type relayInputError struct{ code, message string }

func (e relayInputError) Error() string { return e.code }

// parseRelayCall reads a Chat Completions request. It keeps what this site's models act on (model, messages, tools,
// stream, max_tokens or max_completion_tokens: the lower of the two) and passes over sampling, reasoning and reporting
// options, as the managed-call route passes them over. It refuses what it would answer otherwise than asked: more than
// one choice, a forced tool, a response format, or a picture (the route takes text alone). Text sent as content parts is
// joined into one text, as the route reads it; a message keeps its role, text, tool calls and tool call id.
func parseRelayCall(raw []byte) (relayCall, error) {
	var c relayCall
	var request map[string]json.RawMessage
	if json.Unmarshal(raw, &request) != nil || request == nil {
		return c, relayInputError{"invalid_request", "The request is not one JSON object"}
	}
	given := func(key string) (json.RawMessage, bool) {
		v, ok := request[key]
		return v, ok && string(v) != "null"
	}
	if json.Unmarshal(request["model"], &c.Model) != nil || c.Model == "" || len(c.Model) > 200 {
		return c, relayInputError{"invalid_model", "Name a model from /models"}
	}
	if v, ok := given("stream"); ok && json.Unmarshal(v, &c.Stream) != nil {
		return c, relayInputError{"invalid_request", "stream must be true or false"}
	}
	for _, key := range []string{"max_tokens", "max_completion_tokens"} {
		if v, ok := given(key); ok {
			var n int
			if json.Unmarshal(v, &n) != nil || n < 1 || n > 1_000_000 {
				return c, relayInputError{"invalid_request", key + " must be a whole number from 1"}
			}
			if c.MaxTokens == 0 || n < c.MaxTokens {
				c.MaxTokens = n
			}
		}
	}
	if v, ok := given("n"); ok && string(v) != "1" {
		return c, relayInputError{"unsupported_request", "One choice a call"}
	}
	if v, ok := given("response_format"); ok {
		var format struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(v, &format) != nil || format.Type != "text" {
			return c, relayInputError{"unsupported_request", "Cloud models answer in text here: no response_format"}
		}
	}
	tools := true
	if v, ok := given("tool_choice"); ok {
		var choice string
		if json.Unmarshal(v, &choice) != nil || (choice != "auto" && choice != "none") {
			return c, relayInputError{"unsupported_request", "tool_choice may be auto or none"}
		}
		tools = choice == "auto"
	}
	if v, ok := given("tools"); ok && tools {
		if json.Unmarshal(v, &c.Tools) != nil || len(c.Tools) > 64 {
			return c, relayInputError{"invalid_request", "tools must be a list of at most 64"}
		}
	}
	var messages []map[string]json.RawMessage
	if json.Unmarshal(request["messages"], &messages) != nil || len(messages) < 1 || len(messages) > 256 {
		return c, relayInputError{"invalid_request", "Between 1 and 256 messages"}
	}
	for _, m := range messages {
		var role string
		if m == nil || json.Unmarshal(m["role"], &role) != nil {
			return c, relayInputError{"invalid_request", "Every message needs a role"}
		}
		text, e := relayText(m["content"])
		if e != nil {
			return c, e
		}
		out := map[string]any{"role": role, "content": text}
		for _, key := range []string{"tool_calls", "tool_call_id"} {
			if v, ok := m[key]; ok && string(v) != "null" {
				out[key] = v
			}
		}
		c.Messages = append(c.Messages, out)
	}
	return c, nil
}

// relayText is a message's content as the managed-call route reads it: a text, or nil. Content parts are joined when
// every one is text; a picture or any other part is refused.
func relayText(raw json.RawMessage) (any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text, nil
	}
	var parts []struct {
		Type string  `json:"type"`
		Text *string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil || len(parts) > 64 {
		return nil, relayInputError{"invalid_request", "A message's content must be text"}
	}
	texts := make([]string, 0, len(parts))
	for _, p := range parts {
		if p.Type != "text" || p.Text == nil {
			return nil, relayInputError{"unsupported_content", "Cloud models take text here: no pictures or files"}
		}
		texts = append(texts, *p.Text)
	}
	return strings.Join(texts, "\n"), nil
}

// relayForwardBody is the body this site sends the relay worker's managed-call route for one call: the call's own id as
// its run and its session (one call each), its workspace, model and output limit, and the model's own reasoning default.
// HTML characters are written as they are, so that the body grows no larger than what the caller sent for them.
func relayForwardBody(id, tenantID, model string, call relayCall) []byte {
	completion := map[string]any{"messages": call.Messages}
	if len(call.Tools) > 0 {
		completion["tools"] = call.Tools
	}
	forward := map[string]any{"runId": id, "tenantId": tenantID, "sessionId": id, "model": model, "effort": "", "completion": completion}
	if call.MaxTokens > 0 {
		forward["maxTokens"] = call.MaxTokens
	}
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(forward)
	return bytes.TrimRight(body.Bytes(), "\n")
}

// reserveRelayInvocation admits one relayed call as reserveInvocation admits a run's, under the workspace's lock: the key
// still live and its member still one, the workspace's entitlement and a plan-only model's gate, then the owner's plan
// (its agents at once, today's free calls, the period's credits) or the free allowance (the workspace's calls at once and
// its daily total, and the paid routes' allowances). A relayed call belongs to no run, so it never takes a place a run
// already holds: on a plan it needs a free one (accountSlotsUsed counts relayed calls). It waits for one until ctx ends.
func (a *App) reserveRelayInvocation(ctx context.Context, caller relayCaller, id string, facts *invocationFacts) error {
	model, wait := facts.Model, 40*time.Millisecond
	for {
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		var status string
		var concurrent, daily int
		var restricted, needsPlan, live bool
		var allowed []string
		var routes []byte
		e = tx.QueryRow(ctx, "SELECT status,max_concurrent_runs,max_runs_per_day,allowed_models IS NOT NULL,COALESCE(allowed_models,'{}'),route_limits,requires_plan FROM tenants WHERE id=$1 FOR UPDATE", caller.tenantID).Scan(&status, &concurrent, &daily, &restricted, &allowed, &routes, &needsPlan)
		if e == nil {
			daily, routes, e = a.todayAllowance(ctx, tx, caller.tenantID, daily, routes)
		}
		var plan *activePlan
		if e == nil {
			plan, e = ownerPlan(ctx, tx, caller.tenantID, false)
		}
		if e == nil {
			e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM relay_keys k JOIN memberships m ON m.tenant_id=k.tenant_id AND m.user_id=k.user_id
				WHERE k.id=$1 AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() AND m.role IN ('owner','admin','member'))`, caller.keyID).Scan(&live)
		}
		if e == nil && (status != "active" || !live) {
			e = errRelayRevoked
		}
		if e == nil {
			entitlement, entitlementErr := newModelEntitlement(restricted, allowed)
			if entitlementErr != nil || !entitlement.permits(model) {
				e = errModelNotAllowed
			}
		}
		if e == nil {
			e = requiresPlan(ctx, tx, caller.tenantID, needsPlan, plan)
		}
		if e == nil && a.cfg.planOnlyModel(model) {
			var closed bool
			if closed, e = a.planOnlyClosed(ctx, tx, caller.tenantID, plan); e == nil && closed {
				e = errRouteQuota
			}
		}
		var reserve *int
		if e == nil && plan != nil {
			reserve, e = a.creditReserve(facts.Runtime, model, facts.InputBytes)
		}
		if e != nil {
			tx.Rollback(context.Background())
			return e
		}
		admitted, billed := false, (*activePlan)(nil)
		if plan == nil {
			admitted, e = a.admitFreeInvocation(ctx, tx, caller.tenantID, model, concurrent, daily, routes, false)
		} else {
			billed, e = a.admitPlanRelayInvocation(ctx, tx, caller.tenantID, reserve)
			admitted = billed != nil
		}
		if e == nil && admitted {
			if e = a.reserveInvocationFacts(ctx, tx, caller.tenantID, id, id, facts, reserve, billed); e == nil {
				if _, e = tx.Exec(ctx, "UPDATE model_invocations SET relay_key_id=$3 WHERE tenant_id=$1 AND id=$2", caller.tenantID, id, caller.keyID); e == nil {
					return tx.Commit(ctx)
				}
			}
		}
		tx.Rollback(context.Background())
		if e != nil {
			return e
		}
		// Waiting for a place backs off from 40 ms to half a second, as reserveInvocation's does.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, 500*time.Millisecond)
	}
}

// errRelayRevoked: the key was revoked, expired or lost its member, or its workspace was suspended, after it was read.
var errRelayRevoked = errors.New("relay_key_revoked")

// admitPlanRelayInvocation is admitPlanInvocation for a relayed call, which has no run to hold a place for it: a free one
// among the plan's agents at once, today's free calls for a free model, the period's credits for a paid one. It counts
// without a lock first, then again under the plan row's lock, and returns the locked plan, or nil while no place is free
// (or the plan lapsed meanwhile, and the next try is free).
func (a *App) admitPlanRelayInvocation(ctx context.Context, tx pgx.Tx, tid string, reserve *int) (*activePlan, error) {
	check := func(plan *activePlan) (bool, error) {
		usage, e := accountPlanUsage(ctx, tx, plan.UserID, a.cfg.PlannerModel)
		if e != nil {
			return false, e
		}
		if reserve == nil && usage.FreeToday >= plan.Limits.Daily {
			return false, errInvocationQuota
		}
		used, e := accountSlotsUsed(ctx, tx, plan.UserID)
		return used < plan.Limits.Concurrent, e
	}
	for _, lock := range []bool{false, true} {
		plan, e := ownerPlan(ctx, tx, tid, lock)
		if e != nil || plan == nil {
			return nil, e
		}
		if free, e := check(plan); e != nil || !free {
			return nil, e
		}
		if !lock {
			continue
		}
		if reserve != nil {
			if e = checkCredits(ctx, tx, plan, *reserve); e != nil {
				return nil, e
			}
		}
		return plan, nil
	}
	return nil, nil
}

// relayRefusal answers a call whose admission was refused: its plan, allowance and route codes (admissionRefusal) as 429,
// a plan the workspace needs as 402, an unpriced model as 503, the entitlement as 403, no place freed in time as 429.
func relayRefusal(w http.ResponseWriter, e error) {
	switch code := admissionRefusal(e); {
	case code == "plan_required":
		fail(w, 402, code, "This workspace's owner needs a plan for it")
	case code == "model_unpriced":
		fail(w, 503, code, "This model cannot be charged yet")
	case code != "":
		fail(w, 429, code, "The workspace's allowance for this model is used up for now")
	case errors.Is(e, errModelNotAllowed):
		fail(w, 403, "model_not_allowed", "This workspace may not use this model")
	case errors.Is(e, context.DeadlineExceeded):
		fail(w, 429, "relay_busy", "Every call this workspace may run at once is running: try again shortly")
	case errors.Is(e, errRelayRevoked):
		fail(w, 401, "relay_key_invalid", "Invalid connection key")
	default:
		fail(w, 503, "relay_accounting_failed", "Could not admit the call")
	}
}

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

// relayReply answers a relayed call as its caller asked: read whole (one JSON body, whose status is the outcome's), or
// streamed (Server-Sent Events, begun at once so that the edge in front of this site never cuts a long call as silent: a
// comment line every relayHeartbeat while the model works, which every reader of the format passes over, then the
// answer's chunks, or an error frame, as OpenAI's streams carry one).
type relayReply struct {
	w      http.ResponseWriter
	stream bool
	mu     sync.Mutex
	done   bool
}

func beginRelayReply(ctx context.Context, w http.ResponseWriter, stream bool) *relayReply {
	reply := &relayReply{w: w, stream: stream}
	if !stream {
		return reply
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	reply.send(": awwo relay\n\n")
	go func() {
		beat := time.NewTicker(relayHeartbeat)
		defer beat.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-beat.C:
				if !reply.send(": keep-alive\n\n") {
					return
				}
			}
		}
	}()
	return reply
}

// send writes text to a streamed reply and flushes it; false once the reply is over or its caller gone.
func (r *relayReply) send(text string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done {
		return false
	}
	_, e := io.WriteString(r.w, text)
	if f, ok := r.w.(http.Flusher); ok {
		f.Flush()
	}
	return e == nil
}

// end writes a streamed reply's last text, after which nothing more is written (the heartbeat included).
func (r *relayReply) end(text string) {
	if text != "" {
		r.send(text)
	}
	r.mu.Lock()
	r.done = true
	r.mu.Unlock()
}

func (r *relayReply) fail(status int, code, message string) {
	if !r.stream {
		fail(r.w, status, code, message)
		return
	}
	frame, _ := json.Marshal(map[string]any{"error": map[string]any{"code": code, "type": code, "message": message}})
	r.end("data: " + string(frame) + "\n\n")
}

// answer writes the call's answer: one completion read whole, or its message as one chunk, then its usage, then [DONE].
// What the worker adds for its own executor (reasoning_details) is left out.
func (r *relayReply) answer(model string, a relayAnswer) {
	delete(a.Message, "reasoning_details")
	usage := len(a.Usage) > 0 && string(a.Usage) != "null"
	if !r.stream {
		out := map[string]any{"id": a.ID, "object": "chat.completion", "created": a.Created, "model": model,
			"choices": []map[string]any{{"index": 0, "message": a.Message, "finish_reason": a.Finish}}}
		if usage {
			out["usage"] = a.Usage
		}
		writeJSON(r.w, 200, out)
		return
	}
	// A streamed reader joins each call's argument deltas by its index, which an answer read whole leaves out.
	var toolCalls []map[string]json.RawMessage
	if json.Unmarshal(a.Message["tool_calls"], &toolCalls) == nil && len(toolCalls) > 0 {
		for i := range toolCalls {
			toolCalls[i]["index"], _ = json.Marshal(i)
		}
		a.Message["tool_calls"], _ = json.Marshal(toolCalls)
	}
	chunk := func(fields map[string]any) string {
		frame := map[string]any{"id": a.ID, "object": "chat.completion.chunk", "created": a.Created, "model": model}
		for k, v := range fields {
			frame[k] = v
		}
		raw, _ := json.Marshal(frame)
		return "data: " + string(raw) + "\n\n"
	}
	text := chunk(map[string]any{"choices": []map[string]any{{"index": 0, "delta": a.Message, "finish_reason": a.Finish}}})
	if usage {
		text += chunk(map[string]any{"choices": []any{}, "usage": a.Usage})
	}
	r.end(text + "data: [DONE]\n\n")
}

// relayAnswer is the relay worker's answer to one call: its completion's id, time, message, finish reason and usage.
type relayAnswer struct {
	ID      string
	Created int64
	Message map[string]json.RawMessage
	Finish  string
	Usage   json.RawMessage
}

// relayFailure is how a call failed once it went to the relay worker: the ledger's code, and what its caller is told.
type relayFailure struct {
	code, errCode, message string
	status                 int
}

// relayCompletion runs one relayed call: its key, its request, its admission as one of its workspace's calls, the relay
// worker's managed-call route, its settling, then its answer. What a call's provider or model failed is said by kind
// alone, never in their words.
func (a *App) relayCompletion(w http.ResponseWriter, r *http.Request) {
	caller, ok := a.relayAuthenticate(w, r)
	if !ok {
		return
	}
	call, model, ok := a.readRelayCall(w, r)
	if !ok {
		return
	}
	id := "rl" + randomID()
	body := relayForwardBody(id, caller.tenantID, model.ID, call)
	if len(body) > relayBodyLimit {
		fail(w, 413, "body_too_large", "The call is larger than a relayed call may be")
		return
	}
	// Not the API's 30 s request deadline (requestDeadlineApplies): the bound of a managed call.
	ctx, cancel := context.WithTimeout(r.Context(), computerModelCallTimeout)
	defer cancel()
	facts := &invocationFacts{Runtime: a.relayRuntime(model.ID), Model: model.ID, Provider: model.Provider, ProviderModel: model.ProviderModel,
		Protocol: model.Protocol, Admission: "not_attempted", Usage: missingUsage("unavailable", "provider_missing"), InputBytes: int64(len(body))}
	admission, admitted := context.WithTimeout(ctx, relaySlotWait)
	e := a.reserveRelayInvocation(admission, caller, id, facts)
	admitted()
	if e != nil {
		relayRefusal(w, e)
		return
	}
	status, code, settled := "failed", "computer_model_failed", false
	defer func() {
		if !settled {
			_ = a.settleRelayCall(caller.tenantID, id, status, code, facts)
		}
	}()
	if e = a.markInvocationAdmission(ctx, caller.tenantID, id, facts, "unknown"); e != nil {
		fail(w, 503, "relay_accounting_failed", "Could not reserve the call")
		return
	}
	reply := beginRelayReply(ctx, w, call.Stream)
	defer reply.end("")
	answer, failure := a.forwardRelayCall(ctx, caller, model.ID, body, facts)
	if failure != nil {
		code = failure.code
		reply.fail(failure.status, failure.errCode, failure.message)
		return
	}
	status, code = "completed", ""
	if e = a.settleRelayCall(caller.tenantID, id, status, code, facts); e != nil {
		reply.fail(503, "relay_accounting_failed", "Could not record the call's usage")
		return
	}
	settled = true
	reply.answer(model.ID, answer)
}

// readRelayCall reads a call's request and the catalog's model it names (the workspace's entitlement is its admission's).
func (a *App) readRelayCall(w http.ResponseWriter, r *http.Request) (relayCall, relayModel, bool) {
	var call relayCall
	if media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type")); e != nil || media != "application/json" {
		fail(w, 415, "unsupported_media_type", "Use application/json")
		return call, relayModel{}, false
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, relayBodyLimit+1))
	switch {
	case e != nil:
		fail(w, 400, "invalid_request", "The call could not be read")
		return call, relayModel{}, false
	case len(raw) > relayBodyLimit:
		fail(w, 413, "body_too_large", "The call is larger than a relayed call may be")
		return call, relayModel{}, false
	}
	if call, e = parseRelayCall(raw); e != nil {
		var input relayInputError
		errors.As(e, &input)
		fail(w, 400, input.code, input.message)
		return call, relayModel{}, false
	}
	models, e := a.relayCatalog(r.Context())
	if e != nil {
		fail(w, 503, "relay_unavailable", "Cloud models are unavailable right now")
		return call, relayModel{}, false
	}
	for _, m := range models {
		if m.ID == call.Model {
			return call, m, true
		}
	}
	fail(w, 404, "model_not_found", "This model is not offered: list them at /models")
	return call, relayModel{}, false
}

// forwardRelayCall sends one admitted call to the relay worker and reads its answer, recording on facts what the ledger
// settles it by: when it was sent and ended, its bytes, whether it was refused before any work, its usage.
func (a *App) forwardRelayCall(ctx context.Context, caller relayCaller, model string, body []byte, facts *invocationFacts) (relayAnswer, *relayFailure) {
	var answer relayAnswer
	req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(a.cfg.RelayWorkerURL, "/")+"/internal/computer-model", bytes.NewReader(body))
	if e != nil {
		facts.Admission = "rejected_before_start"
		return answer, &relayFailure{code: "computer_model_transport", status: 503, errCode: "relay_unavailable", message: "Cloud models are unavailable right now"}
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.RelayWorkerToken)
	req.Header.Set("Content-Type", "application/json")
	// The call's time counts from here should its answer never come (plans.go creditCharge).
	facts.Streamed = time.Now()
	facts.Sent = facts.Streamed
	response, e := a.client.Do(req)
	if e != nil {
		facts.Ended = time.Now()
		if dialFailed(e) {
			facts.Admission = "rejected_before_start"
		}
		failure := &relayFailure{code: computerCallBroke(e, ctx.Err() != nil), status: 502, errCode: "relay_model_transport", message: "The model's answer did not arrive"}
		a.logRelayCall(caller, model, 0, nil, failure.code, facts)
		return answer, failure
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 400, 401, 409, 413, 415, 422, 429, 503:
		// The worker refused the call before any model work: it never counts (as computerModelProxy).
		facts.Admission = "rejected_before_start"
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	facts.Ended = time.Now()
	facts.OutputBytes = int64(len(data))
	if e != nil || len(data) > 2<<20 || response.StatusCode != 200 {
		failure := relayWorkerFailure(response.StatusCode, data, e, ctx.Err() != nil, facts)
		a.logRelayCall(caller, model, response.StatusCode, data, failure.code, facts)
		return answer, failure
	}
	var result struct {
		Completion    json.RawMessage `json:"completion"`
		Observability json.RawMessage `json:"observability"`
	}
	var completion struct {
		ID      string `json:"id"`
		Created int64  `json:"created"`
		Choices []struct {
			Message      map[string]json.RawMessage `json:"message"`
			FinishReason string                     `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(data, &result) != nil || json.Unmarshal(result.Completion, &completion) != nil || len(completion.Choices) != 1 || completion.Choices[0].Message == nil {
		failure := &relayFailure{code: "computer_model_protocol", status: 502, errCode: "relay_model_failed", message: "The model's answer was invalid"}
		a.logRelayCall(caller, model, response.StatusCode, nil, failure.code, facts)
		return answer, failure
	}
	facts.receive(result.Observability, a.cfg.RunTimeout)
	facts.Admission = "accepted"
	choice := completion.Choices[0]
	return relayAnswer{ID: completion.ID, Created: completion.Created, Message: choice.Message, Finish: choice.FinishReason, Usage: completion.Usage}, nil
}

// relayWorkerFailure is a call the relay worker answered with an error, or whose answer broke off: the ledger's code (as
// for a direct task's call: computerModelFailure, computerCallBroke), and what its caller is told. A call longer than
// its model reads is context_length_exceeded (OpenAI's code, by which callers shorten a conversation), one the worker's
// own check refused is an invalid request (with the check's label), a worker at capacity is busy, any other failed.
func relayWorkerFailure(status int, data []byte, readErr error, done bool, facts *invocationFacts) *relayFailure {
	if readErr != nil {
		return &relayFailure{code: computerCallBroke(readErr, done), status: 502, errCode: "relay_model_transport", message: "The model's answer did not arrive"}
	}
	workerCode, _, detail := computerWorkerError(data)
	failure := &relayFailure{code: computerModelFailure(status, data, false), status: 502, errCode: "relay_model_failed", message: "The model could not complete this call"}
	sized := computerSizeRefusal(status, data)
	if sized && facts.sinceSent(facts.Ended) < quickRefusal() {
		facts.Admission = "rejected_before_start"
	}
	switch {
	case sized || (status == 413 && workerCode == "CONTEXT_LIMIT"):
		failure.status, failure.errCode, failure.message = 400, "context_length_exceeded", "The call is longer than the model can read"
	case status == 400 && workerCode == "INVALID_INPUT":
		failure.status, failure.errCode, failure.message = 400, "invalid_request", "The call does not hold: "+detail
	case status == 429 || status == 409:
		failure.status, failure.errCode, failure.message = 503, "relay_busy", "Cloud models are busy: try again shortly"
	case status == 503:
		failure.status, failure.errCode, failure.message = 503, "relay_unavailable", "Cloud models are unavailable right now"
	}
	return failure
}

// logRelayCall logs a relayed call that failed once it went to the relay worker, by kind alone (as logComputerCall): its
// key, workspace, model, what the worker answered and the ledger's code; never the call's words or the worker's message.
func (a *App) logRelayCall(caller relayCaller, model string, status int, body []byte, code string, facts *invocationFacts) {
	workerCode, reason, detail := computerWorkerError(body)
	a.log.Warn("relayed model call failed", "key", caller.keyID, "tenant", caller.tenantID, "model", model,
		"workerStatus", status, "workerCode", workerCode, "reason", reason, "detail", detail, "code", code, "ms", facts.Ended.Sub(facts.Streamed).Milliseconds())
}
