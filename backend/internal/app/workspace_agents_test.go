package app

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestWorkspaceAgentReferenceValidation(t *testing.T) {
	for _, raw := range []string{`{}`, `{"source":"market","agentId":"a"}`, `{"source":"workspace","agentId":""}`, `{"source":"workspace","agentId":" a"}`, `{"source":"workspace","agentId":"a","tenantId":"other"}`, `{"source":"workspace","agentId":3}`} {
		if _, err := parseWorkspaceAgentReference(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted invalid reference %s", raw)
		}
	}
	for _, raw := range []string{`{"nodes":[{"id":"a","agentRef":{"source":"workspace","agentId":"other"}}]}`, `{"nodes":[{"id":"a","agentRef":{"source":"workspace","agentId":"agent"},"team":{}}]}`} {
		if validateSavedWorkspaceAgent(json.RawMessage(raw), "a", "agent") == nil {
			t.Fatal("uninitialized selection or inline team accepted")
		}
	}
}

func TestPostgresWorkspaceAgentReferenceIdentityAndExecution(t *testing.T) {
	var mu sync.Mutex
	var seen []observedPiCall
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		mu.Lock()
		seen = append(seen, b)
		mu.Unlock()
		completePi(w, "ACTUAL-AGENT-ANSWER")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	cookie, tid, _ := h.register(t, "agent-reference@example.test")
	base := "/tenants/" + tid
	instructions := "AUTHORITATIVE-" + strings.Repeat("x", 19000)
	create := func(name, instructions string) string {
		return h.request(t, cookie, "POST", base+"/agents", map[string]any{"name": name, "adapterType": "pi", "model": "alternate", "instructions": instructions}, 201)["id"].(string)
	}
	aid := create("Real Agent", instructions)
	cid, doc := setupFixture(t, h, cookie, tid, 2)
	path := base + "/canvases/" + cid
	for _, item := range doc["nodes"].([]any) {
		n := item.(map[string]any)
		n["agentRef"] = map[string]any{"source": "workspace", "agentId": aid}
		// Preview values are untrusted; they must neither select a different
		// worker/model nor overwrite the selected shared Agent's instructions.
		n["runtime"], n["model"], n["persona"], n["effort"] = "invented-runtime", "invented-model", "FORGED-INSTRUCTIONS", "invented-effort"
	}
	h.request(t, cookie, "PUT", path, map[string]any{"name": "References", "document": doc, "version": 1}, 200)
	v := h.request(t, cookie, "POST", path+"/initialize", map[string]any{"documentVersion": 2}, 200)
	a, b := setupNodeAt(v, 0), setupNodeAt(v, 1)
	if a["binding"].(map[string]any)["agentId"] != aid || b["binding"].(map[string]any)["agentId"] != aid || a["issueId"] == b["issueId"] || a["persona"] != instructions || a["model"] != "alternate" || a["runtime"] != "pi" || a["effort"] != "" || a["title"] != "Worker a" {
		t.Fatal("selected identity/configuration was not preserved")
	}
	if agents, sessions := setupCounts(t, h, tid); agents != 1 || sessions != 2 {
		t.Fatal("selection cloned the Agent", agents, sessions)
	}
	again := h.request(t, cookie, "POST", path+"/initialize", map[string]any{"documentVersion": v["version"]}, 200)
	if !reflect.DeepEqual(v, again) {
		t.Fatal("reference initialization is not idempotent")
	}
	run := h.request(t, cookie, "POST", base+"/runs", map[string]string{"sessionId": a["issueId"].(string), "prompt": "Return answer", "operationId": "workspace-agent-proof"}, 202)
	h.awaitRun(t, cookie, tid, run["id"].(string), "completed")
	mu.Lock()
	if len(seen) != 1 || seen[0].Model != "alternate" || seen[0].SystemPrompt != instructions || seen[0].SessionID != a["issueId"] {
		t.Fatal("execution did not use the real selected Agent")
	}
	mu.Unlock()
	// Switching to another Agent with identical config must still change the
	// real identity and conversation, while retaining the previous reference.
	bid := create("Real Agent", instructions)
	oldSID := a["issueId"]
	a["agentRef"] = map[string]any{"source": "workspace", "agentId": bid}
	saved := h.request(t, cookie, "PUT", path, map[string]any{"name": "References", "document": v["document"], "version": v["version"]}, 200)
	h.request(t, cookie, "POST", base+"/runs", map[string]any{"sessionId": oldSID, "prompt": "must not run old Agent", "operationId": "uninitialized-agent-switch"}, 409)
	h.request(t, cookie, "POST", path+"/graph-runs", map[string]any{"operationId": "uninitialized-graph-agent", "scope": []string{"a"}}, 409)
	v = h.request(t, cookie, "POST", path+"/initialize", map[string]any{"documentVersion": saved["version"], "scope": []string{"a"}}, 200)
	a = setupNodeAt(v, 0)
	if a["binding"].(map[string]any)["agentId"] != bid || a["issueId"] == oldSID || setupNodeAt(v, 1)["binding"].(map[string]any)["agentId"] != aid {
		t.Fatal("switch changed shared identity or reused old conversation")
	}
	history := a["threads"].([]any)[0].(map[string]any)
	if history["issueId"] != oldSID || history["agentRef"].(map[string]any)["agentId"] != aid || history["persona"] != instructions {
		t.Fatal("original Agent history lost", history["issueId"])
	}
	// Refreshing a changed authoritative definition forks only its session.
	newSID := a["issueId"]
	h.request(t, cookie, "PUT", base+"/agents/"+bid, map[string]any{"name": "Real Agent", "adapterType": "pi", "model": "alternate", "instructions": "UPDATED-REAL-INSTRUCTIONS"}, 200)
	h.request(t, cookie, "POST", base+"/runs", map[string]any{"sessionId": newSID, "prompt": "must not mix definitions", "operationId": "uninitialized-agent-edit"}, 409)
	h.request(t, cookie, "POST", path+"/graph-runs", map[string]any{"operationId": "uninitialized-graph-edit", "scope": []string{"a"}}, 409)
	v = h.request(t, cookie, "POST", path+"/initialize", map[string]any{"documentVersion": v["version"], "scope": []string{"a"}}, 200)
	a = setupNodeAt(v, 0)
	if a["binding"].(map[string]any)["agentId"] != bid || a["issueId"] == newSID || a["persona"] != "UPDATED-REAL-INSTRUCTIONS" {
		t.Fatal("definition refresh cloned the Agent or kept stale config")
	}
	if agents, sessions := setupCounts(t, h, tid); agents != 2 || sessions != 4 {
		t.Fatal("reference refresh created an Agent", agents, sessions)
	}
	previous := a["threads"].([]any)[1].(map[string]any)
	if previous["persona"] != instructions {
		t.Fatal("refresh overwrote historical persona")
	}
	// Detaching creates an independent custom Agent without editing the source.
	delete(a, "agentRef")
	saved = h.request(t, cookie, "PUT", path, map[string]any{"name": "References", "document": v["document"], "version": v["version"]}, 200)
	h.request(t, cookie, "POST", base+"/runs", map[string]any{"sessionId": a["issueId"], "prompt": "must detach first", "operationId": "uninitialized-agent-detach"}, 409)
	h.request(t, cookie, "POST", path+"/graph-runs", map[string]any{"operationId": "uninitialized-graph-detach", "scope": []string{"a"}}, 409)
	v = h.request(t, cookie, "POST", path+"/initialize", map[string]any{"documentVersion": saved["version"], "scope": []string{"a"}}, 200)
	if setupNodeAt(v, 0)["binding"].(map[string]any)["agentId"] == bid {
		t.Fatal("detaching still edits a shared Agent")
	}
	stored := h.request(t, cookie, "GET", base+"/agents/"+aid, nil, 200)
	if stored["instructions"] != instructions {
		t.Fatal("selection changed the shared definition")
	}
}

func TestPostgresWorkspaceAgentReferenceAuthorization(t *testing.T) {
	var calls atomic.Int64
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "UNEXPECTED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	owner, tid, _ := h.register(t, "agent-owner@example.test")
	reader, _, _ := h.register(t, "agent-reader@example.test")
	other, otherTenant, _ := h.register(t, "agent-other@example.test")
	base := "/tenants/" + tid
	aid := h.request(t, owner, "POST", base+"/agents", map[string]any{"name": "Allowed", "adapterType": "pi", "model": "test-model"}, 201)["id"].(string)
	foreign := h.request(t, other, "POST", "/tenants/"+otherTenant+"/agents", map[string]any{"name": "Foreign", "adapterType": "pi"}, 201)["id"].(string)
	h.request(t, owner, "POST", base+"/members", map[string]string{"email": "agent-reader@example.test", "role": "reader"}, 201)
	cid, doc := setupFixture(t, h, owner, tid, 1)
	path := base + "/canvases/" + cid
	n := doc["nodes"].([]any)[0].(map[string]any)
	version := float64(1)
	for _, test := range []struct {
		name   string
		ref    any
		team   any
		status int
	}{
		{"foreign", map[string]any{"source": "workspace", "agentId": foreign}, nil, 404},
		{"missing", map[string]any{"source": "workspace", "agentId": "missing"}, nil, 404},
		{"unknown", map[string]any{"source": "market", "agentId": aid}, nil, 400},
		{"inline-team", map[string]any{"source": "workspace", "agentId": aid}, fixtureTeam("sequential"), 400},
	} {
		n["agentRef"], n["team"] = test.ref, test.team
		saved := h.request(t, owner, "PUT", path, map[string]any{"name": "Authorization", "document": doc, "version": version}, 200)
		version = saved["version"].(float64)
		h.request(t, owner, "POST", path+"/initialize", map[string]any{"documentVersion": version}, test.status)
	}
	n["agentRef"], n["team"] = map[string]any{"source": "workspace", "agentId": aid}, nil
	saved := h.request(t, owner, "PUT", path, map[string]any{"name": "Authorization", "document": doc, "version": version}, 200)
	h.request(t, reader, "POST", path+"/initialize", map[string]any{"documentVersion": saved["version"]}, 403)
	h.request(t, other, "POST", path+"/initialize", map[string]any{"documentVersion": saved["version"]}, 404)
	if _, err := h.db.Exec(context.Background(), "UPDATE agents SET internal=true WHERE tenant_id=$1 AND id=$2", tid, aid); err != nil {
		t.Fatal(err)
	}
	h.request(t, owner, "POST", path+"/initialize", map[string]any{"documentVersion": saved["version"]}, 404)
	if agents, sessions := setupCounts(t, h, tid); agents != 1 || sessions != 0 || calls.Load() != 0 {
		t.Fatal("rejected selection created work", agents, sessions, calls.Load())
	}
}
