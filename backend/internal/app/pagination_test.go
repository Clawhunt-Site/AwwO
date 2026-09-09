package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAdminCursorScopeAndRestart(t *testing.T) {
	a := &App{cursorKey: []byte(randomID() + randomID())}
	now := time.Now().UTC()
	c := adminCursor{Version: 1, Kind: "users", Actor: "administrator-one", Snapshot: now, LastTime: now.Add(-time.Second), LastID: "user-one"}
	raw := a.encodeCursor(c)
	if _, e := a.decodeCursor(raw, c.Kind, c.Actor); e != nil {
		t.Fatal("valid cursor rejected", e)
	}
	for _, pair := range [][2]string{{"tenants", c.Actor}, {c.Kind, "administrator-two"}} {
		if _, e := a.decodeCursor(raw, pair[0], pair[1]); e == nil {
			t.Fatal("cursor scope not enforced")
		}
	}
	a.cursorKey = []byte(randomID() + randomID())
	if _, e := a.decodeCursor(raw, c.Kind, c.Actor); e == nil {
		t.Fatal("old instance cursor remained valid")
	}
}

func TestPostgresPaginationMigrationCompatibility(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	// Earlier local development applied these indexes as part of migration 003.
	// Keep the indexes while simulating that pre-split migration ledger.
	if _, e := h.db.Exec(ctx, "DELETE FROM awwo_schema_migrations WHERE version=4"); e != nil {
		t.Fatal(e)
	}
	if e := Migrate(ctx, h.db); e != nil {
		t.Fatal("migration 004 did not tolerate existing local indexes", e)
	}
	var indexes, versions int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('admin_tenants_page','admin_users_page','admin_runs_page','admin_audit_page')").Scan(&indexes); e != nil || indexes != 4 {
		t.Fatal("pagination indexes missing", indexes, e)
	}
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM awwo_schema_migrations WHERE version=4").Scan(&versions); e != nil || versions != 1 {
		t.Fatal("migration ledger missing", versions, e)
	}
}
func TestPostgresAdminPaginationAndQuotaUpdates(t *testing.T) {
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		<-r.Context().Done()
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	ctx := context.Background()
	owner, tid, uid := h.register(t, "pagination-owner@example.test")
	admin := bootstrapTestAdmin(t, h)
	canvas, agent, sid := h.fixture(t, owner, tid)
	p := "/tenants/" + tid
	sid2 := h.request(t, owner, "POST", p+"/sessions", map[string]string{"canvasId": canvas, "nodeId": "node-a", "agentId": agent}, 201)["id"].(string)
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]int{"maxConcurrentRuns": 1}, 200)
	start := func(session, operation string, status int) map[string]any {
		return h.request(t, owner, "POST", p+"/runs", map[string]string{"sessionId": session, "prompt": "wait", "operationId": operation}, status)
	}
	one := start(sid, "quota-first-run", 202)["id"].(string)
	h.awaitRun(t, owner, tid, one, "running")
	requireCode(t, start(sid2, "quota-second-run", 429), "quota_exceeded")
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]int{"maxConcurrentRuns": 2}, 200)
	two := start(sid2, "quota-second-run", 202)["id"].(string)
	h.awaitRun(t, owner, tid, two, "running")
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]int{"maxConcurrentRuns": 1, "maxRunsPerDay": 2}, 200)
	h.request(t, owner, "POST", p+"/runs/"+one+"/cancel", nil, 200)
	h.request(t, owner, "POST", p+"/runs/"+two+"/cancel", nil, 200)
	requireCode(t, start(sid, "quota-third-run", 429), "quota_exceeded")
	h.request(t, admin, "PATCH", "/admin/tenants/"+tid, map[string]int{"maxRunsPerDay": 3}, 200)
	three := start(sid, "quota-third-run", 202)["id"].(string)
	h.request(t, owner, "POST", p+"/runs/"+three+"/cancel", nil, 200)
	// Equal timestamps across hundreds of records exercise the stable tie-breaker.
	for _, sql := range []string{
		`INSERT INTO users(id,email,name,password_hash) SELECT 'page-user-'||g,'page-'||g||'@example.test','Seed','secret-password-hash' FROM generate_series(1,205) g`,
		`INSERT INTO tenants(id,name) SELECT 'page-tenant-'||g,'Seed' FROM generate_series(1,205) g`,
	} {
		if _, e := h.db.Exec(ctx, sql); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := h.db.Exec(ctx, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) SELECT 'page-run-'||g,$1,$2,'page-operation-'||g,'secret-request-hash','private-prompt','completed' FROM generate_series(1,205) g`, tid, sid); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, `INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata) SELECT $1,$2,'test.page',g::text,'{"secret":"hidden"}'::jsonb FROM generate_series(1,205) g`, uid, tid); e != nil {
		t.Fatal(e)
	}
	tables := map[string]string{"tenants": "tenants", "users": "users", "runs": "runs", "audit": "audit_events"}
	for _, kind := range []string{"tenants", "users", "runs", "audit"} {
		var expected int
		if e := h.db.QueryRow(ctx, "SELECT count(*) FROM "+tables[kind]).Scan(&expected); e != nil {
			t.Fatal(e)
		}
		h.request(t, owner, "GET", "/admin/"+kind, nil, 403)
		for _, query := range []string{"?limit=0", "?limit=201", "?limit=x", "?limit=1&limit=2", "?cursor=", "?cursor=bad"} {
			h.request(t, admin, "GET", "/admin/"+kind+query, nil, 400)
		}
		v := h.request(t, admin, "GET", "/admin/"+kind+"?limit=1", nil, 200)
		seen := map[string]bool{}
		snapshot := v["snapshot"]
		firstCursor := v["nextCursor"].(string)
		otherKind := "users"
		if kind == otherKind {
			otherKind = "tenants"
		}
		h.request(t, admin, "GET", "/admin/"+otherKind+"?cursor="+url.QueryEscape(firstCursor), nil, 400)
		parts := strings.Split(firstCursor, ".")
		parts[0] = "X" + parts[0][1:]
		h.request(t, admin, "GET", "/admin/"+kind+"?cursor="+url.QueryEscape(strings.Join(parts, ".")), nil, 400)
		// Inserts after the initial page must not extend this traversal.
		var insertErr error
		switch kind {
		case "users":
			_, insertErr = h.db.Exec(ctx, "INSERT INTO users(id,email,name,password_hash) VALUES('post-snapshot-user','post-snapshot@example.test','Late','hash')")
		case "tenants":
			_, insertErr = h.db.Exec(ctx, "INSERT INTO tenants(id,name) VALUES('post-snapshot-tenant','Late')")
		case "runs":
			_, insertErr = h.db.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES('post-snapshot-run',$1,$2,'post-snapshot-operation','hash','prompt','completed')", tid, sid)
		case "audit":
			_, insertErr = h.db.Exec(ctx, "INSERT INTO audit_events(action,resource_id) VALUES('test.late','late')")
		}
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		pages := 0
		for {
			if v["snapshot"] != snapshot {
				t.Fatal("snapshot changed")
			}
			for _, item := range v["items"].([]any) {
				row := item.(map[string]any)
				key := fmt.Sprint(row["id"])
				if seen[key] {
					t.Fatal("duplicate pagination record", kind, key)
				}
				seen[key] = true
				for _, forbidden := range []string{"password_hash", "passwordHash", "token_hash", "tokenHash", "request_hash", "requestHash", "prompt", "metadata"} {
					if _, ok := row[forbidden]; ok {
						t.Fatal("sensitive field exposed", kind, forbidden)
					}
				}
			}
			pages++
			if pages > 10 {
				t.Fatal("cursor did not terminate")
			}
			if v["nextCursor"] == nil {
				break
			}
			v = h.request(t, admin, "GET", "/admin/"+kind+"?limit=100&cursor="+url.QueryEscape(v["nextCursor"].(string)), nil, 200)
		}
		if len(seen) != expected {
			t.Fatalf("%s got %d records, want %d", kind, len(seen), expected)
		}
	}
}
