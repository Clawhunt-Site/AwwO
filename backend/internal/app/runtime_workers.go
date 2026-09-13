package app

import (
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
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&h) != nil || !h.Ready || h.Model == "" {
		return piHealth{}, errors.New("Runtime provider is not ready")
	}
	if len(h.Models) > 128 {
		return piHealth{}, errors.New("Runtime model catalog exceeds limit")
	}
	seen, hasDefault := map[string]bool{}, false
	for i, m := range h.Models {
		// Legacy Pi catalogs did not publish runtime. Other workers must declare
		// it, so a miswired URL cannot silently route a request to a different SDK.
		if m.Runtime == "" && runtime == runtimePI {
			m.Runtime = runtimePI
		}
		if m.Runtime != runtime || m.ID == "" || len(m.ID) > 200 || len(m.Provider) > 200 || seen[m.ID] {
			return piHealth{}, errors.New("Runtime model catalog is invalid")
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
	a.registerTelemetryModels(runtime, h.Models)
	return h, nil
}

func (a *App) loadRuntime(ctx context.Context, catalog runtimeCatalog, runtime string) (piHealth, error) {
	if h, ok := catalog[runtime]; ok {
		return h, nil
	}
	h, err := a.probeRuntime(ctx, runtime)
	if err == nil {
		catalog[runtime] = h
	}
	return h, err
}

// Freeze effective selectors and per-worker budgets once at admission. No
// worker discovery or model fallback happens after any invocation is accepted.
func (a *App) runtimeSnapshot(ctx context.Context, catalog runtimeCatalog, runtime, model, instructions string, team *nodeTeam) (executionSnapshot, error) {
	runtime = defaultRuntime(runtime)
	if !validRuntime(runtime) {
		return executionSnapshot{}, invalidSetup("Unsupported node runtime")
	}
	if err := validateTeam(team); err != nil {
		return executionSnapshot{}, invalidSetup(err.Error())
	}
	h, err := a.loadRuntime(ctx, catalog, runtime)
	if err != nil {
		return executionSnapshot{}, err
	}
	if model == "" {
		model = h.Model
	}
	budget, overhead, ok := h.modelLimits(model)
	if !ok {
		return executionSnapshot{}, setupError{"model_unavailable", "Node model is unavailable for its runtime"}
	}
	if team != nil {
		for _, m := range team.Members {
			if _, err = a.loadRuntime(ctx, catalog, memberRuntime(team, m)); err != nil {
				return executionSnapshot{}, err
			}
		}
	}
	resolved, err := resolveTeam(team, runtime, model, catalog)
	if err != nil {
		return executionSnapshot{}, invalidSetup(err.Error())
	}
	used := runtimeCatalog{runtime: h}
	if resolved != nil {
		for _, m := range resolved.Members {
			used[m.Runtime] = catalog[m.Runtime]
		}
	}
	return executionSnapshot{Runtime: runtime, Instructions: instructions, Model: model, Budget: budget, Overhead: overhead, Team: resolved, Health: h, RuntimeHealth: used}, nil
}

func resolveTeam(t *nodeTeam, parentRuntime, parentModel string, catalog runtimeCatalog) (*nodeTeam, error) {
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
			m.Model = h.Model
			if m.Runtime == defaultRuntime(parentRuntime) && parentModel != "" {
				m.Model = parentModel
			}
		}
		if _, _, ok := h.modelLimits(m.Model); !ok {
			return nil, errors.New("Member selects an unavailable model for its runtime")
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
	return s.Health, runtime == runtimePI && defaultRuntime(s.Runtime) == runtimePI
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
			return defaultRuntime(n.Runtime) == runtime
		}
	}
	return true // Internal planner sessions have no document node.
}

func (a *App) runtimeAdmissionError(w http.ResponseWriter, err error) {
	var input setupError
	if errors.As(err, &input) {
		status := 400
		if input.code == "model_unavailable" {
			status = 409
		}
		fail(w, status, input.code, input.message)
		return
	}
	fail(w, 503, "runtime_unavailable", err.Error())
}
