package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestOpenMausExclusiveTenantConfiguration(t *testing.T) {
	valid := openMausConnection{TenantID: "tenant-a", URL: "https://maus.example.test", Token: strings.Repeat("x", 32)}
	if err := validateOpenMausConnections([]openMausConnection{valid}); err != nil {
		t.Fatal(err)
	}
	for name, connections := range map[string][]openMausConnection{
		"duplicate origin": {valid, {TenantID: "tenant-b", URL: "https://MAUS.example.test:443/", Token: strings.Repeat("y", 32)}},
		"duplicate tenant": {valid, {TenantID: "tenant-a", URL: "https://other.example.test", Token: strings.Repeat("y", 32)}},
		"plaintext remote": {{TenantID: "tenant-a", URL: "http://maus.example.test", Token: valid.Token}},
		"userinfo":         {{TenantID: "tenant-a", URL: "https://secret@maus.example.test", Token: valid.Token}},
		"query token":      {{TenantID: "tenant-a", URL: "https://maus.example.test?token=x", Token: valid.Token}},
		"path injection":   {{TenantID: "tenant-a", URL: "https://maus.example.test/api/other", Token: valid.Token}},
		"no token":         {{TenantID: "tenant-a", URL: "http://127.0.0.1:1234"}},
		"header injection": {{TenantID: "tenant-a", URL: valid.URL, Token: valid.Token + "\r\nX:test"}},
	} {
		t.Run(name, func(t *testing.T) {
			if validateOpenMausConnections(connections) == nil {
				t.Fatal("unsafe connection accepted")
			}
		})
	}
	if origin, err := openMausOrigin("http://[::1]:80/"); err != nil || origin != "http://[::1]" {
		t.Fatal("IPv6 origin normalization", origin, err)
	}
}

func TestPostgresOpenMausProjectionDispatchAndImport(t *testing.T) {
	var writes atomic.Int32
	var busy, unknown atomic.Bool
	token := strings.Repeat("s", 32)
	maus := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("paired token absent")
			w.WriteHeader(403)
			return
		}
		switch r.URL.Path {
		case "/api/health":
			writeJSON(w, 200, map[string]any{"app": "openmausbot", "private": "hidden-config"})
		case "/api/bots":
			groups := []map[string]any{}
			if busy.Load() {
				groups = append(groups, map[string]any{"id": "channel-a", "busyBotId": "bot-a"})
			}
			writeJSON(w, 200, map[string]any{"bots": []map[string]any{{"id": "bot-a", "name": "Researcher", "threadId": "task-a", "tasks": []map[string]any{{"threadId": "task-a", "title": "Current"}, {"threadId": "task-b", "title": "Previous"}}, "apiKey": "MUST-NOT-LEAK", "approvalMode": "automatic"}}, "groups": groups})
		case "/api/threads/task-a/messages":
			writeJSON(w, 200, map[string]any{"messages": []map[string]any{{"id": "answer-a", "role": "assistant", "kind": "text", "text": "实际完成的资料摘录。", "at": 12345, "tool": map[string]any{"arguments": "SECRET-ARGUMENT"}}, {"id": "approval-a", "role": "assistant", "kind": "card", "text": "Needs approval", "card": map[string]any{"requestId": "SECRET-APPROVAL", "answered": false}, "secret": map[string]any{"value": "SECRET-VALUE"}}, {"id": "answered-card", "role": "assistant", "kind": "card", "text": "Previously answered", "card": map[string]any{"answered": "allow"}}}, "hasMore": false})
		case "/api/bots/bot-a/messages":
			writes.Add(1)
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if len(body) != 2 || body["threadId"] != "task-a" || body["text"] != "Analyze this explicit task" {
				t.Error("write body changed", body)
			}
			if unknown.Load() {
				w.WriteHeader(500)
				return
			}
			writeJSON(w, 202, map[string]any{"ok": true})
		default:
			t.Error("unexpected upstream action", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer maus.Close()
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tid, _ := h.register(t, "maus-owner@example.test")
	outsider, otherTenant, _ := h.register(t, "maus-outsider@example.test")
	base := "/tenants/" + tid + "/openmaus"
	h.a.cfg.OpenMausConnections = []openMausConnection{{TenantID: tid, URL: maus.URL, Token: token}}
	status := h.request(t, owner, "GET", base+"/status", nil, 200)
	if status["available"] != true {
		t.Fatal(status)
	}
	otherStatus := h.request(t, outsider, "GET", "/tenants/"+otherTenant+"/openmaus/status", nil, 200)
	if otherStatus["configured"] != false {
		t.Fatal("tenant allowlist ignored")
	}
	h.request(t, outsider, "GET", base+"/bots", nil, 404)
	fleet := h.request(t, owner, "GET", base+"/bots", nil, 200)
	encoded, _ := json.Marshal(fleet)
	if strings.Contains(string(encoded), "MUST-NOT-LEAK") || strings.Contains(string(encoded), "approvalMode") {
		t.Fatal("service configuration leaked", fleet)
	}
	bot := fleet["bots"].([]any)[0].(map[string]any)
	if bot["activeTaskId"] != "task-a" || len(bot["tasks"].([]any)) != 2 {
		t.Fatal("task projection lost", bot)
	}
	page := h.request(t, owner, "GET", base+"/bots/bot-a/messages?taskId=task-a", nil, 200)
	encoded, _ = json.Marshal(page)
	if strings.Contains(string(encoded), "SECRET-") || page["messages"].([]any)[1].(map[string]any)["needsInput"] != true {
		t.Fatal("sensitive message fields leaked", page)
	}
	if page["messages"].([]any)[2].(map[string]any)["needsInput"] != false {
		t.Fatal("upstream string answer treated as pending")
	}
	h.request(t, owner, "GET", base+"/bots/bot-a/messages?taskId=foreign-task", nil, 404)
	body := map[string]string{"botId": "bot-a", "taskId": "task-a", "text": "Analyze this explicit task", "operationId": "maus-send-once"}
	sent := h.request(t, owner, "POST", base+"/tasks", body, 202)
	if sent["status"] != "sent" || writes.Load() != 1 {
		t.Fatal("task not dispatched once", sent, writes.Load())
	}
	h.request(t, owner, "POST", base+"/tasks", body, 202)
	if writes.Load() != 1 {
		t.Fatal("idempotent retry repeated external action")
	}
	body["text"] = "Different task"
	h.request(t, owner, "POST", base+"/tasks", body, 409)
	body["text"] = "Analyze this explicit task"
	busy.Store(true)
	body["operationId"] = "maus-channel-busy"
	h.request(t, owner, "POST", base+"/tasks", body, 409)
	if writes.Load() != 1 {
		t.Fatal("busy channel still received task")
	}
	busy.Store(false)
	unknown.Store(true)
	body["operationId"] = "maus-unknown-send"
	uncertain := h.request(t, owner, "POST", base+"/tasks", body, 202)
	if uncertain["status"] != "unknown" {
		t.Fatal("uncertain write reported failure/success", uncertain)
	}
	h.request(t, owner, "POST", base+"/tasks", body, 202)
	if writes.Load() != 2 {
		t.Fatal("uncertain write was repeated")
	}
	receipt := h.request(t, owner, "GET", base+"/tasks/maus-unknown-send", nil, 200)
	if receipt["status"] != "unknown" {
		t.Fatal("unknown receipt lost")
	}
	h.request(t, outsider, "GET", "/tenants/"+otherTenant+"/openmaus/tasks/maus-unknown-send", nil, 404)
	imported := h.request(t, owner, "POST", base+"/imports", map[string]string{"botId": "bot-a", "taskId": "task-a", "messageId": "answer-a", "title": "Maus结果", "operationId": "maus-import-result"}, 201)
	if imported["content"] != "实际完成的资料摘录。" || imported["provenance"].(map[string]any)["messageId"] != "answer-a" {
		t.Fatal("import not grounded in actual message", imported)
	}
	duplicate := h.request(t, owner, "POST", "/tenants/"+tid+"/knowledge/sources", map[string]string{"title": "另一个来源", "content": "实际完成的资料摘录。", "sourceUri": "https://example.test/original", "operationId": "maus-shared-bytes-source"}, 200)
	if duplicate["id"] != imported["id"] || duplicate["provenance"].(map[string]any)["originCount"] != float64(2) {
		t.Fatal("OpenMaus duplicate origin was lost")
	}
	mausDuplicate := h.request(t, owner, "POST", base+"/imports", map[string]string{"botId": "bot-a", "taskId": "task-a", "messageId": "answer-a", "title": "第二次摘录", "operationId": "maus-second-title-import"}, 200)
	if mausDuplicate["provenance"].(map[string]any)["originCount"] != float64(3) {
		t.Fatal("OpenMaus duplicate import skipped provenance")
	}
	h.request(t, owner, "POST", base+"/imports", map[string]string{"botId": "bot-a", "taskId": "task-a", "messageId": "approval-a", "title": "Approval", "operationId": "maus-import-approval"}, 400)
	// The copied source remains available without reading the external instance.
	h.a.cfg.OpenMausConnections = nil
	copy := h.request(t, owner, "GET", "/tenants/"+tid+"/knowledge/documents/"+imported["id"].(string), nil, 200)
	if copy["content"] != imported["content"] {
		t.Fatal("external source was only a pointer")
	}
	if _, err := h.db.Exec(context.Background(), "UPDATE openmaus_dispatches SET status='sending',updated_at=now()-interval '1 minute' WHERE tenant_id=$1 AND operation_id='maus-unknown-send'", tid); err != nil {
		t.Fatal(err)
	}
	receipt = h.request(t, owner, "GET", base+"/tasks/maus-unknown-send", nil, 200)
	if receipt["status"] != "unknown" {
		t.Fatal("abandoned dispatch remained falsely active")
	}
}

func TestOpenMausRejectsRedirectAndWrongService(t *testing.T) {
	var hits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(w, 200, map[string]string{"app": "openmausbot"})
	}))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/api/health", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	a := New(nil, testConfig())
	connection := openMausConnection{TenantID: "tenant-a", URL: origin.URL, Token: strings.Repeat("x", 32)}
	if _, err := a.openMausFleet(context.Background(), connection); err == nil || hits.Load() != 0 {
		t.Fatal("bridge followed a redirect with credentials")
	}
}
