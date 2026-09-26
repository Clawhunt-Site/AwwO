package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	runtimePI           = "pi"
	runtimeOpenAIAgents = "openai-agents"
)

type runtimeCatalog map[string]piHealth

func validRuntime(runtime string) bool { return runtime == runtimePI || runtime == runtimeOpenAIAgents }
func defaultRuntime(runtime string) string {
	if runtime == "" {
		return runtimeOpenAIAgents
	}
	return runtime
}

// legacyRuntime resolves a persisted (pre-openai-agents-default) snapshot or
// document whose runtime field is empty. Those were written when Pi was the
// only engine, so an empty value means Pi — not the current creation default.
func legacyRuntime(runtime string) string {
	if runtime == "" {
		return runtimePI
	}
	return runtime
}
func memberRuntime(t *nodeTeam, m teamMember) string {
	if m.Runtime != "" {
		return m.Runtime
	}
	return t.Runtime
}
func runtimeTools(runtime string) []string {
	if runtime == runtimeOpenAIAgents {
		return []string{"calculator", "current_time"}
	}
	return []string{}
}
func validRuntimeTools(runtime string, names []string) bool {
	allowed, seen := runtimeTools(runtime), map[string]bool{}
	for _, name := range names {
		ok := false
		for _, candidate := range allowed {
			if candidate == name {
				ok = true
			}
		}
		if !ok || seen[name] {
			return false
		}
		seen[name] = true
	}
	return true
}

func enabledRuntimeTools(h piHealth, runtime string) []string {
	names := []string{}
	for _, tool := range h.Tools {
		if validRuntimeTools(runtime, []string{tool.ID}) && tool.ContextTextBytes > 0 && tool.ContextTextBytes <= 65536 {
			names = append(names, tool.ID)
		}
	}
	return names
}

func (h piHealth) toolBudget(names []string) (int, bool) {
	budget := 0
	for _, name := range names {
		found := false
		for _, tool := range h.Tools {
			if tool.ID == name && tool.ContextTextBytes > 0 && tool.ContextTextBytes <= 65536 {
				budget += tool.ContextTextBytes
				found = true
				break
			}
		}
		if !found {
			return 0, false
		}
	}
	return budget, true
}

// Endpoints and bearer tokens are server configuration only. They never enter
// a canvas, member configuration, execution snapshot, or public catalog.
func (a *App) runtimeEndpoint(runtime string) (string, string, error) {
	var endpoint, token string
	switch runtime {
	case runtimePI:
		endpoint, token = a.cfg.PIURL, a.cfg.PIToken
	case runtimeOpenAIAgents:
		endpoint, token = a.cfg.OpenAIAgentsURL, a.cfg.OpenAIAgentsToken
	default:
		return "", "", errors.New("Unsupported runtime")
	}
	if endpoint == "" || token == "" {
		return "", "", errors.New("Runtime is not configured")
	}
	return strings.TrimRight(endpoint, "/"), token, nil
}

func (a *App) probeRuntime(ctx context.Context, runtime string) (piHealth, error) {
	var h piHealth
	if a.cfg.UserCredentials {
		if err := a.requirePersonalConnection(ctx, runtime); err != nil {
			return h, err
		}
	}
	endpoint, token, err := a.runtimeEndpoint(runtime)
	if err != nil {
		return h, err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint+"/health", nil)
	if err != nil {
		return h, errors.New("Runtime is unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.client.Do(req)
	if err != nil {
		return h, errors.New("Runtime is unavailable")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	if err != nil || len(body) > 65536 {
		return piHealth{}, errors.New("Runtime provider is not ready")
	}
	if a.cfg.UserCredentials {
		var capability struct {
			Ready                bool            `json:"ready"`
			UserCredentials      bool            `json:"userCredentials"`
			LLMGateOnly          bool            `json:"llmgateOnly"`
			UserStructuredOutput json.RawMessage `json:"userStructuredOutput"`
		}
		if resp.StatusCode != 200 || json.Unmarshal(body, &capability) != nil || !capability.Ready || !capability.UserCredentials || (a.cfg.LLMGateOnly && !capability.LLMGateOnly) {
			return piHealth{}, errors.New("Personal-credential worker is unavailable")
		}
		// Whether the worker can bind a user model carrying structuredOutput is the worker's
		// own claim: the JS worker makes it, the Python worker and older builds do not. Only
		// a literal true counts; anything else is a dropped capability, never an outage.
		raw := bytes.TrimSpace(capability.UserStructuredOutput)
		structured := bytes.Equal(raw, []byte("true"))
		if len(raw) > 0 && !structured && !bytes.Equal(raw, []byte("false")) && !bytes.Equal(raw, []byte("null")) {
			a.recordCapabilityCleared(runtime, "user-credentials", "malformed")
		}
		return a.personalRuntime(ctx, runtime, structured)
	}
	if resp.StatusCode != 200 || json.Unmarshal(body, &h) != nil || !h.Ready || h.Model == "" {
		return piHealth{}, errors.New("Runtime provider is not ready")
	}
	if a.cfg.LLMGateOnly {
		var policy struct {
			LLMGateOnly     bool            `json:"llmgateOnly"`
			UserCredentials json.RawMessage `json:"userCredentials"`
		}
		if json.Unmarshal(body, &policy) != nil || !policy.LLMGateOnly || !bytes.Equal(bytes.TrimSpace(policy.UserCredentials), []byte("false")) {
			return piHealth{}, errors.New("Runtime provider is not ready")
		}
	}
	if len(h.Models) > 128 {
		return piHealth{}, errors.New("Runtime model catalog exceeds limit")
	}
	// The entitlement belongs to the workspace, never to the worker: a worker that
	// echoed this field could otherwise narrow or widen what a workspace may run.
	h.Allowed = nil
	seen, hasDefault := map[string]bool{}, false
	type clearing struct{ model, reason string }
	cleared := []clearing{}
	for i, m := range h.Models {
		// Legacy Pi catalogs did not publish runtime. Other workers must declare
		// it, so a miswired URL cannot silently route a request to a different SDK.
		if m.Runtime == "" && runtime == runtimePI {
			m.Runtime = runtimePI
		}
		if m.Runtime != runtime || m.ID == "" || len(m.ID) > 200 || len(m.Provider) > 200 || seen[m.ID] || !validEffortCatalog(m) {
			return piHealth{}, errors.New("Runtime model catalog is invalid")
		}
		// Structured delivery output exists only on the openai-agents worker. Another
		// runtime advertising it, or a value that is not a boolean, gets the claim
		// cleared rather than failing the whole catalog: a text outage is a worse
		// outcome than a dropped capability. The reason is recorded only once the whole
		// catalog is accepted, so a rejected catalog reports no clearing that never applied.
		if m.structuredOutputMalformed {
			cleared = append(cleared, clearing{m.ID, "malformed"})
		}
		if runtime != runtimeOpenAIAgents && m.StructuredOutput {
			m.StructuredOutput = false
			cleared = append(cleared, clearing{m.ID, "wrong_runtime"})
		}
		seen[m.ID], h.Models[i] = true, m
		hasDefault = hasDefault || m.ID == h.Model
	}
	if runtime != runtimePI && !hasDefault {
		return piHealth{}, errors.New("Runtime default model is missing from its catalog")
	}
	toolNames := []string{}
	for _, tool := range h.Tools {
		toolNames = append(toolNames, tool.ID)
	}
	if !validRuntimeTools(runtime, toolNames) {
		return piHealth{}, errors.New("Runtime tool catalog is invalid")
	}
	if _, ok := h.toolBudget(toolNames); !ok {
		return piHealth{}, errors.New("Runtime tool budgets are invalid")
	}
	for _, c := range cleared {
		a.recordCapabilityCleared(runtime, c.model, c.reason)
	}
	a.registerTelemetryModels(runtime, h.Models)
	return h, nil
}

// A probed catalog is entitlement-stamped before it is cached, so everything
// downstream reads an already filtered catalog and no resolution step has to
// consult the allowlist itself.
func (a *App) loadRuntime(ctx context.Context, entitlement modelEntitlement, catalog runtimeCatalog, runtime string) (piHealth, error) {
	if h, ok := catalog[runtime]; ok {
		return h, nil
	}
	h, err := a.probeRuntime(ctx, runtime)
	if err == nil {
		h = entitlement.apply(h)
		catalog[runtime] = h
	}
	return h, err
}

// Freeze effective selectors and per-worker budgets once at admission. No
// worker discovery or model fallback happens after any invocation is accepted.
// The entitlement is a required argument rather than an ambient lookup so a new
// admission path cannot compile without deciding which workspace it admits for.
func (a *App) runtimeSnapshot(ctx context.Context, entitlement modelEntitlement, catalog runtimeCatalog, runtime, model, effort, instructions string, team *nodeTeam) (executionSnapshot, error) {
	runtime = defaultRuntime(runtime)
	if !validRuntime(runtime) {
		return executionSnapshot{}, invalidSetup("Unsupported node runtime")
	}
	if !validEffortLevel(effort) {
		return executionSnapshot{}, invalidSetup("Unsupported node effort")
	}
	if err := validateTeam(team); err != nil {
		return executionSnapshot{}, invalidSetup(err.Error())
	}
	h, err := a.loadRuntime(ctx, entitlement, catalog, runtime)
	if err != nil {
		return executionSnapshot{}, err
	}
	if model == "" {
		model = h.defaultModel()
	}
	budget, overhead, ok := h.modelLimits(model)
	if !ok {
		return executionSnapshot{}, setupError{"model_unavailable", "Node model is unavailable for its runtime or this workspace"}
	}
	// An explicit effort is frozen only when the worker advertises that exact
	// level for the selected model; nothing is substituted or silently dropped.
	if !h.supportsEffort(model, effort) {
		return executionSnapshot{}, setupError{"effort_unsupported", "Node selects a reasoning effort its model does not advertise"}
	}
	if team != nil {
		for _, m := range team.Members {
			if _, err = a.loadRuntime(ctx, entitlement, catalog, memberRuntime(team, m)); err != nil {
				return executionSnapshot{}, err
			}
		}
	}
	resolved, err := resolveTeam(team, runtime, model, effort, catalog)
	if err != nil {
		return executionSnapshot{}, invalidSetup(err.Error())
	}
	used := runtimeCatalog{runtime: h}
	if resolved != nil {
		for _, m := range resolved.Members {
			used[m.Runtime] = catalog[m.Runtime]
		}
	}
	return executionSnapshot{Runtime: runtime, Instructions: instructions, Model: model, Effort: effort, Budget: budget, Overhead: overhead, Team: resolved, Health: h, RuntimeHealth: used}, nil
}

// validEffortLevel accepts the empty string ("no explicit setting") and short
// lowercase identifiers. The vocabulary itself belongs to the worker catalog;
// this only bounds what may be persisted and forwarded.
func validEffortLevel(effort string) bool {
	if effort == "" {
		return true
	}
	if len(effort) > 32 || effort[0] < 'a' || effort[0] > 'z' {
		return false
	}
	for _, c := range effort[1:] {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// A worker may advertise at most a handful of distinct, well-formed levels, and
// its display default must be one of them (or empty when it advertises none).
func validEffortCatalog(m piModel) bool {
	if len(m.ReasoningEfforts) > 8 {
		return false
	}
	seen := map[string]bool{}
	for _, level := range m.ReasoningEfforts {
		if level == "" || !validEffortLevel(level) || seen[level] {
			return false
		}
		seen[level] = true
	}
	if m.DefaultReasoningEffort == "" {
		return true
	}
	return seen[m.DefaultReasoningEffort]
}

func resolveTeam(t *nodeTeam, parentRuntime, parentModel, parentEffort string, catalog runtimeCatalog) (*nodeTeam, error) {
	if err := validateTeam(t); err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil
	}
	resolved := *t
	resolved.Members = append([]teamMember(nil), t.Members...)
	for i := range resolved.Members {
		m := &resolved.Members[i]
		m.Runtime = memberRuntime(t, *m)
		h, ok := catalog[m.Runtime]
		if !ok {
			return nil, errors.New("Member runtime is unavailable")
		}
		if m.Model == "" {
			m.Model = h.defaultModel()
			if m.Runtime == defaultRuntime(parentRuntime) && parentModel != "" {
				// Model and effort are parallel selectors: a member that inherits the node's
				// model inherits the node's explicit effort with it, unless it names its own.
				// A member that falls back to the runtime default model inherits no effort.
				m.Model = parentModel
				if m.Effort == "" {
					m.Effort = parentEffort
				}
			}
		}
		if _, _, ok := h.modelLimits(m.Model); !ok {
			return nil, errors.New("Member selects an unavailable model for its runtime")
		}
		if !h.supportsEffort(m.Model, m.Effort) {
			return nil, errors.New("Member selects a reasoning effort its model does not advertise")
		}
		if _, ok := h.toolBudget(m.Tools); !ok {
			return nil, errors.New("Member selects a tool not enabled by its runtime")
		}
		m.Tools = append([]string{}, m.Tools...)
	}
	return &resolved, nil
}

func (s executionSnapshot) memberHealth(runtime string) (piHealth, bool) {
	if h, ok := s.RuntimeHealth[runtime]; ok {
		return h, true
	}
	// Persisted pre-runtime snapshots contain only Pi health. Never use that
	// legacy budget/model catalog for a newly named worker.
	return s.Health, runtime == runtimePI && legacyRuntime(s.Runtime) == runtimePI
}

func savedRuntimeMatches(raw []byte, nodeID, runtime string) bool {
	var doc struct {
		Nodes []struct{ ID, Runtime string }
	}
	if json.Unmarshal(raw, &doc) != nil {
		return false
	}
	for _, n := range doc.Nodes {
		if n.ID == nodeID {
			return legacyRuntime(n.Runtime) == runtime
		}
	}
	return true // Internal planner sessions have no document node.
}

func (a *App) runtimeAdmissionError(w http.ResponseWriter, err error) {
	var input setupError
	if errors.As(err, &input) {
		status := 400
		if input.code == "model_unavailable" || input.code == "personal_engine_required" {
			status = 409
		}
		fail(w, status, input.code, input.message)
		return
	}
	fail(w, 503, "runtime_unavailable", err.Error())
}
