package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPostgresLeaseLossRejectsInflightRun(t *testing.T) {
	for _, boundary := range []string{"body_wait", "provider_health_wait"} {
		t.Run(boundary, func(t *testing.T) {
			gate := newRequestGate(t)
			var executions atomic.Int32
			pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/health" {
					if boundary == "provider_health_wait" {
						gate.wait()
					}
					writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model"})
					return
				}
				executions.Add(1)
				w.WriteHeader(503)
			}))
			defer pi.Close()
			h := newHarness(t, pi.URL)
			owner, tid, _ := h.register(t, "lease-owner@example.test")
			_, _, sid := h.fixture(t, owner, tid)
			data, _ := json.Marshal(runInput{SessionID: sid, Prompt: "Must not run after lease loss", OperationID: "lost-lease-operation"})
			req := httptest.NewRequest("POST", "/api/v1/tenants/"+tid+"/runs", strings.NewReader(string(data)))
			if boundary == "body_wait" {
				req.Body = &gatedRequestBody{strings.NewReader(string(data)), gate}
			}
			req.AddCookie(owner)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", h.cfg.PublicOrigin)
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); h.a.Handler().ServeHTTP(w, req) }()
			awaitTestSignal(t, gate.reached)

			// PID comes directly from this test App's dedicated lease connection.
			// Terminate no server process, pool peer, shared API, or foreign lease.
			pid := h.a.lease.Conn().PgConn().PID()
			var ownPID uint32
			var terminated bool
			if e := h.db.QueryRow(context.Background(), "SELECT pid FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user", pid).Scan(&ownPID); e != nil || ownPID != pid {
				gate.open()
				t.Fatalf("could not verify owned lease connection: %v", e)
			}
			if e := h.db.QueryRow(context.Background(), "SELECT pg_terminate_backend($1)", ownPID).Scan(&terminated); e != nil || !terminated {
				gate.open()
				t.Fatalf("could not terminate owned lease connection: %v", e)
			}
			deadline := time.Now().Add(5 * time.Second)
			for !h.a.leaseLost.Load() && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			gate.open()
			awaitTestSignal(t, done)
			if !h.a.leaseLost.Load() {
				t.Fatal("worker did not detect lease loss")
			}
			var runs, messages int
			if e := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM runs WHERE tenant_id=$1),(SELECT count(*) FROM messages WHERE tenant_id=$1)", tid).Scan(&runs, &messages); e != nil {
				t.Fatal(e)
			}
			if w.Code != 503 || runs != 0 || messages != 0 || executions.Load() != 0 {
				t.Fatalf("lease loss at %s: HTTP=%d runs=%d messages=%d providerExecutions=%d; want 503 and no admission", boundary, w.Code, runs, messages, executions.Load())
			}
		})
	}
}
