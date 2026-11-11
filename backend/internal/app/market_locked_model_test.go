package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A market Agent's author may lock a model only a person may choose (the DeepSeek API's, a Claude Fable one). Setup puts
// it on a node only where the node named that model itself: through the market's dialog, which names it first and puts
// it on the node, on the node, or in a canvas imported or saved with it set on the node. A node that keeps the Agent's
// reference without the model (an imported canvas, another client's write) is refused rather than given it.

func TestMarketLockedModelOnlyAPersonMayChooseNeedsTheNodesOwnPick(t *testing.T) {
	h := piHealth{Model: "house", Provider: "llmgate", Models: []piModel{{ID: "house", Provider: "llmgate"},
		{ID: "flash", Provider: "deepseek"}, {ID: "bedrock.claude-fable-5-2", Provider: "bedrock"}}}
	version := func(id string, locked bool) marketVersion {
		return marketVersion{Kind: "llm", Model: marketModel{Runtime: "pi", ID: id, Effort: "", Locked: locked}}
	}
	node := func(model string) map[string]json.RawMessage {
		n := map[string]json.RawMessage{"id": json.RawMessage(`"node-m"`), "kind": json.RawMessage(`"session"`), "runtime": json.RawMessage(`"pi"`)}
		if model != "" {
			putJSON(n, "model", model)
		}
		return n
	}
	for _, tc := range []struct {
		name, locked, nodeModel string
		lock, refused           bool
	}{
		{"a Claude Fable id the node does not name", "bedrock.claude-fable-5-2", "", true, true},
		{"a Claude Fable id without its prefix", "claude-fable-5-2", "", true, true},
		{"a DeepSeek API model the node does not name", "flash", "", true, true},
		{"a node naming another model", "flash", "house", true, true},
		{"a Claude Fable id the node names (the dialog's pick, or an imported canvas's)", "bedrock.claude-fable-5-2", "bedrock.claude-fable-5-2", true, false},
		{"a DeepSeek API model the node names", "flash", "flash", true, false},
		{"a locked model anyone may be given", "house", "", true, false},
		{"an unlocked suggestion only a person may choose", "flash", "", false, false},
	} {
		n := node(tc.nodeModel)
		locked := applyMarketVersion(n, version(tc.locked, tc.lock))
		if (locked != nil) != tc.lock {
			t.Fatalf("%s: the locked model %v", tc.name, locked)
		}
		err := marketLockedModelUnchosen(locked, h)
		var refusal marketError
		if tc.refused != errors.As(err, &refusal) || (tc.refused && (refusal.status != 409 || refusal.code != "market_agent_model_choice_required")) {
			t.Fatalf("%s: refused %v, want %v", tc.name, err, tc.refused)
		}
		if got := rawString(n["model"]); tc.lock && got != tc.locked || !tc.lock && got != tc.nodeModel {
			t.Fatalf("%s: the node's model is %q", tc.name, got)
		}
	}
	// No locked model, no refusal.
	if err := marketLockedModelUnchosen(nil, h); err != nil {
		t.Fatal(err)
	}
}

// The same through the API: an initialization that would put a locked Claude Fable or DeepSeek model on a node that did
// not name it is refused and changes nothing; the node that names it, and a locked ordinary model, are set up.
func TestPostgresMarketLockedModelOnlyAPersonMayChooseIsNotPutOnANodeUnasked(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{
				{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144},
				{"id": "bedrock.claude-fable-5-2", "provider": "bedrock", "maxContextTextBytes": 262144},
				{"id": "flash", "provider": "deepseek", "maxContextTextBytes": 262144}}})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		completePi(w, "done")
	}))
	t.Cleanup(provider.Close)
	h := newHarness(t, provider.URL, func(a *App) {
		a.cfg.MarketEnabled, a.cfg.MarketFeeBps, a.cfg.MarketMaxPrice, a.cfg.MarketHoldDays = true, 2500, 500, 14
	})
	admin, _, uadmin := h.register(t, "admin-lock@example.test")
	makeAdmin(t, h, uadmin)
	caller, tc, _ := h.register(t, "caller-lock@example.test")
	base := "/tenants/" + tc
	setUp := func(agentID, nodeModel string, status int) (map[string]any, map[string]any) {
		t.Helper()
		node := map[string]any{"id": "node-m", "kind": "session", "title": "Page", "runtime": "pi", "agentRef": map[string]any{"source": "market", "agentId": agentID}}
		if nodeModel != "" {
			node["model"] = nodeModel
		}
		cv := h.request(t, caller, "POST", base+"/canvases", map[string]any{"name": "Locked", "document": map[string]any{"nodes": []any{node}, "edges": []any{}}}, 201)
		got := h.request(t, caller, "POST", base+"/canvases/"+cv["id"].(string)+"/initialize", map[string]any{"documentVersion": cv["version"]}, status)
		return cv, got
	}
	for i, model := range []string{"bedrock.claude-fable-5-2", "flash"} {
		author, ta, _ := h.register(t, "author-lock-"+string(rune('a'+i))+"@example.test")
		id := publishMarketAgent(t, h, author, admin, ta, 0, map[string]any{"model": map[string]any{"runtime": "pi", "id": model, "locked": true}})
		cv, refused := setUp(id, "", 409)
		if refused["error"].(map[string]any)["code"] != "market_agent_model_choice_required" {
			t.Fatal(model, refused)
		}
		if again := h.request(t, caller, "GET", base+"/canvases/"+cv["id"].(string), nil, 200); again["version"] != cv["version"] {
			t.Fatal(model, "a refused setup changed the canvas", again)
		}
		if _, refused = setUp(id, "test-model", 409); refused["error"].(map[string]any)["code"] != "market_agent_model_choice_required" {
			t.Fatal(model, "a node naming another model", refused)
		}
		_, done := setUp(id, model, 200)
		if got := done["document"].(map[string]any)["nodes"].([]any)[0].(map[string]any); got["model"] != model || got["issueId"] == nil {
			t.Fatal(model, "the node that names the model is set up on it", got)
		}
	}
	author, ta, _ := h.register(t, "author-lock-plain@example.test")
	id := publishMarketAgent(t, h, author, admin, ta, 0, map[string]any{"model": map[string]any{"runtime": "pi", "id": "test-model", "locked": true}})
	if _, done := setUp(id, "", 200); done["document"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["model"] != "test-model" {
		t.Fatal("a locked ordinary model is put on the node as before", done)
	}
}
