package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPostgresPersonalOpenAIPlannerUsesActorCredential(t *testing.T) {
	received := make(chan map[string]any, 2)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "userCredentials": true})
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid worker body")
		}
		received <- body
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"type\":\"completed\",\"text\":\"{\\\"version\\\":1,\\\"summary\\\":\\\"No changes\\\",\\\"operations\\\":[]}\"}\n\n")
	}))
	defer worker.Close()
	h := newHarness(t, worker.URL)
	mockPersonalDiscovery(t, h)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = worker.URL, h.cfg.PIToken
	owner, tid, _ := h.register(t, "openai-planner@example.test")
	connection := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "llmgate", "runtime": runtimeOpenAIAgents, "apiKey": "synthetic-personal-secret"}, 201)
	catalog := h.request(t, owner, "GET", "/tenants/"+tid+"/runtime", nil, 200)
	if catalog["plannerAvailable"] != true || catalog["plannerRuntime"] != runtimeOpenAIAgents {
		t.Fatal("OpenAI-only planning unavailable", catalog)
	}
	cid, _ := setupFixture(t, h, owner, tid, 1)
	run := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]any{"prompt": "prepare a plan", "context": "", "operationId": "personal-openai-plan"}, 202)
	h.awaitRun(t, owner, tid, run["id"].(string), "completed")
	select {
	case body := <-received:
		if body["runtime"] != runtimeOpenAIAgents || body["model"] != connectionModelID(connection["id"].(string), "test-chat-model") {
			t.Fatal("wrong planner engine or owner", body["runtime"], body["model"])
		}
		if body["userModel"].(map[string]any)["apiKey"] != "synthetic-personal-secret" {
			t.Fatal("wrong planner key")
		}
	case <-time.After(time.Second):
		t.Fatal("planner never invoked")
	}
	var model string
	if err := h.db.QueryRow(t.Context(), "SELECT model FROM agents WHERE tenant_id=$1 AND internal", tid).Scan(&model); err != nil || model != "" {
		t.Fatal("personal selector persisted into shared planner", err)
	}
	// Revoking the only connection makes both discovery and direct submission fail closed.
	h.request(t, owner, "DELETE", "/auth/connections/"+connection["id"].(string), nil, 204)
	catalog = h.request(t, owner, "GET", "/tenants/"+tid+"/runtime", nil, 200)
	if catalog["plannerAvailable"] != false {
		t.Fatal("revoked planner remained available")
	}
	h.request(t, owner, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]any{"prompt": "prepare a plan", "context": "", "operationId": "personal-revoked-plan"}, 409)
}

func TestPostgresPersonalJevCannotUseOperatorCredentials(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	mockPersonalDiscovery(t, h)
	h.server.Close()
	h.server = httptest.NewServer(h.a.Handler())
	owner, tid, _ := h.register(t, "personal-jev@example.test")
	for _, endpoint := range []struct{ method, path string }{{"GET", "/typesafe"}, {"POST", "/typesafe/evaluations"}} {
		result := h.request(t, owner, endpoint.method, "/tenants/"+tid+endpoint.path, nil, 403)
		if result["error"].(map[string]any)["code"] != "typesafe_personal_required" {
			t.Fatal("unexpected guard response", result)
		}
	}
}
