package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type requestGate struct {
	reached chan struct{}
	release chan struct{}
	arrive  sync.Once
	leave   sync.Once
}

func newRequestGate(t *testing.T) *requestGate {
	g := &requestGate{reached: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(g.open)
	return g
}
func (g *requestGate) wait() { g.arrive.Do(func() { close(g.reached); <-g.release }) }
func (g *requestGate) open() { g.leave.Do(func() { close(g.release) }) }
func awaitTestSignal(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for request boundary")
	}
}

type gatedRequestBody struct {
	io.Reader
	gate *requestGate
}

func (b *gatedRequestBody) Read(p []byte) (int, error) { b.gate.wait(); return b.Reader.Read(p) }
func (b *gatedRequestBody) Close() error               { return nil }

func TestPostgresMutationRechecksAuthorizationAfterBodyWait(t *testing.T) {
	for _, revocation := range []string{"membership_removed", "membership_downgraded", "tenant_suspended"} {
		t.Run(revocation, func(t *testing.T) {
			var providerCalls atomic.Int32
			pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				providerCalls.Add(1)
				writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model"})
			}))
			defer pi.Close()
			h := newHarness(t, pi.URL)
			owner, tid, _ := h.register(t, "slow-owner@example.test")
			member, _, mid := h.register(t, "slow-member@example.test")
			h.request(t, owner, "POST", "/tenants/"+tid+"/members", map[string]string{"email": "slow-member@example.test", "role": "member"}, 201)
			platform := bootstrapTestAdmin(t, h)
			canvas, agent, session := h.fixture(t, owner, tid)
			prefix := "/tenants/" + tid
			inputs := []struct {
				method, path string
				body         any
			}{
				{"POST", "/canvases", map[string]any{"name": "Late create", "document": map[string]any{"nodes": []any{}}}},
				{"PUT", "/canvases/" + canvas, map[string]any{"name": "Late update", "document": map[string]any{"nodes": []any{}}, "version": 1}},
				{"POST", "/agents", map[string]string{"name": "Late agent", "model": "test-model"}},
				{"PUT", "/agents/" + agent, map[string]string{"name": "Late agent update", "model": "test-model"}},
				{"PUT", "/agents/" + agent + "/instructions", map[string]string{"content": "Late instructions"}},
				{"POST", "/sessions", map[string]string{"canvasId": canvas, "nodeId": "node-a", "agentId": agent}},
				{"POST", "/runs", map[string]string{"sessionId": session, "prompt": "Late run", "operationId": "late-run-operation"}},
				{"POST", "/canvases/" + canvas + "/plan", map[string]string{"prompt": "Late plan", "context": "Empty plan", "operationId": "late-plan-operation"}},
			}
			type pending struct {
				gate     *requestGate
				response *httptest.ResponseRecorder
				done     chan struct{}
			}
			requests := make([]pending, len(inputs))
			for i, in := range inputs {
				data, _ := json.Marshal(in.body)
				g := newRequestGate(t)
				req := httptest.NewRequest(in.method, "/api/v1"+prefix+in.path, &gatedRequestBody{strings.NewReader(string(data)), g})
				req.AddCookie(member)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", h.cfg.PublicOrigin)
				p := pending{g, httptest.NewRecorder(), make(chan struct{})}
				requests[i] = p
				go func() { defer close(p.done); h.a.Handler().ServeHTTP(p.response, req) }()
				awaitTestSignal(t, g.reached)
			}
			// All eight handlers have passed middleware and are waiting on JSON.
			// Complete revocation first, then release every request concurrently.
			want := 403
			switch revocation {
			case "membership_removed":
				h.request(t, owner, "DELETE", prefix+"/members/"+mid, nil, 204)
				want = 404
			case "membership_downgraded":
				h.request(t, owner, "PATCH", prefix+"/members/"+mid, map[string]string{"role": "reader"}, 204)
			case "tenant_suspended":
				h.request(t, platform, "PATCH", "/admin/tenants/"+tid, map[string]string{"status": "suspended"}, 200)
			}
			for _, p := range requests {
				p.gate.open()
			}
			for i, p := range requests {
				awaitTestSignal(t, p.done)
				if p.response.Code != want {
					t.Errorf("%s %s after %s: got HTTP %d, want %d: %s", inputs[i].method, inputs[i].path, revocation, p.response.Code, want, p.response.Body.String())
				}
			}
			var canvases, agents, sessions, runs int
			if e := h.db.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM canvases WHERE tenant_id=$1),(SELECT count(*) FROM agents WHERE tenant_id=$1),(SELECT count(*) FROM node_sessions WHERE tenant_id=$1),(SELECT count(*) FROM runs WHERE tenant_id=$1)`, tid).Scan(&canvases, &agents, &sessions, &runs); e != nil {
				t.Fatal(e)
			}
			if canvases != 1 || agents != 1 || sessions != 1 || runs != 0 || providerCalls.Load() != 0 {
				t.Fatalf("revoked write leaked effects: canvases=%d agents=%d sessions=%d runs=%d providerCalls=%d", canvases, agents, sessions, runs, providerCalls.Load())
			}
			if want != 404 {
				h.request(t, member, "GET", prefix+"/canvases/"+canvas, nil, 200)
				h.request(t, member, "GET", prefix+"/sessions/"+session+"/messages", nil, 200)
			}
		})
	}
}

func TestPostgresBodylessMutationRechecksAuthorization(t *testing.T) {
	for _, revocation := range []string{"membership_removed", "membership_downgraded", "tenant_suspended"} {
		t.Run(revocation, func(t *testing.T) {
			h := newHarness(t, "")
			owner, tid, _ := h.register(t, "delete-owner@example.test")
			member, _, mid := h.register(t, "delete-member@example.test")
			h.request(t, owner, "POST", "/tenants/"+tid+"/members", map[string]string{"email": "delete-member@example.test", "role": "member"}, 201)
			platform := bootstrapTestAdmin(t, h)
			canvas, agent, sid := h.fixture(t, owner, tid)
			rid := randomID()
			if _, e := h.db.Exec(context.Background(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,'cancel-operation','hash','test','completed')", rid, tid, sid); e != nil {
				t.Fatal(e)
			}
			operations := []struct {
				id      string
				handler http.HandlerFunc
			}{
				{canvas, h.a.deleteCanvas},
				{agent, h.a.deleteAgent},
				{rid, h.a.cancelRun},
			}
			type pending struct {
				gate     *requestGate
				response *httptest.ResponseRecorder
				done     chan struct{}
			}
			requests := []pending{}
			for _, op := range operations {
				g := newRequestGate(t)
				req := httptest.NewRequest("POST", "/", nil)
				req.AddCookie(member)
				req.SetPathValue("tenantId", tid)
				req.SetPathValue("id", op.id)
				p := pending{g, httptest.NewRecorder(), make(chan struct{})}
				requests = append(requests, p)
				// Pause after the real authorization middleware, modelling a handler
				// scheduled or waiting for a connection after the initial role read.
				handler := h.a.tenant(func(w http.ResponseWriter, r *http.Request) { g.wait(); op.handler(w, r) }, 2)
				go func() { defer close(p.done); handler(p.response, req) }()
				awaitTestSignal(t, g.reached)
			}
			want := 403
			switch revocation {
			case "membership_removed":
				h.request(t, owner, "DELETE", "/tenants/"+tid+"/members/"+mid, nil, 204)
				want = 404
			case "membership_downgraded":
				h.request(t, owner, "PATCH", "/tenants/"+tid+"/members/"+mid, map[string]string{"role": "reader"}, 204)
			case "tenant_suspended":
				h.request(t, platform, "PATCH", "/admin/tenants/"+tid, map[string]string{"status": "suspended"}, 200)
			}
			for _, p := range requests {
				p.gate.open()
			}
			for i, p := range requests {
				awaitTestSignal(t, p.done)
				if p.response.Code != want {
					t.Errorf("bodyless mutation %d after %s got %d, want %d: %s", i, revocation, p.response.Code, want, p.response.Body.String())
				}
			}
		})
	}
}
