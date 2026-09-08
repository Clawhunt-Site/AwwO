package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestPostgresTenantPagination(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, uid := h.register(t, "tenant-pages-owner@example.test")
	outsider, foreign, _ := h.register(t, "tenant-pages-other@example.test")
	other := h.request(t, owner, "POST", "/tenants", map[string]string{"name": "Second workspace"}, 201)["id"].(string)
	canvas, agent, sid := h.fixture(t, owner, tid)
	h.fixture(t, outsider, foreign)
	p := "/tenants/" + tid
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Same timestamps on more than one full page require the id tie-breaker.
	exec(`INSERT INTO users(id,email,name,password_hash) SELECT 'tp-user-'||g,'tp-'||g||'@example.test','Seed','not-a-credential' FROM generate_series(1,205) g`)
	exec(`INSERT INTO memberships(tenant_id,user_id,role,created_at) SELECT $1,'tp-user-'||g,'reader','2000-01-01'::timestamptz FROM generate_series(1,205) g`, tid)
	exec(`INSERT INTO canvases(id,tenant_id,name,document,created_at) SELECT 'tp-canvas-'||g,$1,'Seed','{}','2000-01-01'::timestamptz FROM generate_series(1,205) g`, tid)
	exec(`INSERT INTO agents(id,tenant_id,name,created_at) SELECT 'tp-agent-'||g,$1,'Seed','2000-01-01'::timestamptz FROM generate_series(1,205) g`, tid)
	exec(`INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,created_at) SELECT 'tp-session-'||g,$1,$2,'node-a',$3,'2000-01-01'::timestamptz FROM generate_series(1,205) g`, tid, canvas, agent)
	exec(`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,created_at) SELECT 'tp-run-'||g,$1,$2,'tp-operation-'||g,'hidden-request-hash','hidden-prompt','completed','2000-01-01'::timestamptz FROM generate_series(1,205) g`, tid, sid)
	exec(`INSERT INTO tenant_invites(id,tenant_id,created_by,role,token_hash,expires_at,created_at) SELECT 'tp-invite-'||g,$1,$2,'reader','hidden-invite-hash-'||g,now()+interval '1 day','2000-01-01'::timestamptz FROM generate_series(1,205) g`, tid, uid)
	exec(`INSERT INTO agents(id,tenant_id,name,internal) VALUES('tp-internal-agent',$1,'Internal',true)`, tid)
	exec(`INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,kind) VALUES('tp-planner',$1,$2,'$planner','tp-internal-agent','planner')`, tid, canvas)
	sources := []struct{ kind, table, id, predicate, query string }{
		{"members", "memberships", "user_id", "true", ""},
		{"canvases", "canvases", "id", "true", ""},
		{"agents", "agents", "id", "NOT internal", ""},
		{"sessions", "node_sessions", "id", "kind='node'", "&canvasId=" + canvas},
		{"runs", "runs", "id", "true", "&sessionId=" + sid},
		{"invites", "tenant_invites", "id", "true", ""},
	}
	for _, source := range sources {
		t.Run(source.kind, func(t *testing.T) {
			rows, err := h.db.Query(ctx, "SELECT "+source.id+" FROM "+source.table+" WHERE tenant_id=$1 AND "+source.predicate+" ORDER BY created_at DESC,"+source.id+" DESC", tid)
			if err != nil {
				t.Fatal(err)
			}
			want := []string{}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				want = append(want, id)
			}
			rows.Close()
			if rows.Err() != nil || len(want) <= 200 {
				t.Fatal("invalid test data", rows.Err(), len(want))
			}
			path := p + "/" + source.kind
			for _, query := range []string{"?limit=0", "?limit=201", "?limit=oops", "?limit=", "?limit=1&limit=2", "?cursor=", "?cursor=bad", "?cursor=a&cursor=b", "?cursor=%"} {
				h.request(t, owner, "GET", path+query, nil, 400)
			}
			h.request(t, outsider, "GET", path, nil, 404)
			first := h.request(t, owner, "GET", path+"?limit=37"+source.query, nil, 200)
			cursor := first["nextCursor"].(string)
			requireCode(t, h.request(t, owner, "GET", "/tenants/"+other+"/"+source.kind+"?cursor="+url.QueryEscape(cursor)+source.query, nil, 400), "invalid_cursor")
			otherKind := "members"
			if source.kind == otherKind {
				otherKind = "canvases"
			}
			h.request(t, owner, "GET", p+"/"+otherKind+"?cursor="+url.QueryEscape(cursor), nil, 400)
			h.request(t, owner, "GET", path+"?cursor="+url.QueryEscape("X"+cursor)+source.query, nil, 400)
			if source.query != "" {
				h.request(t, owner, "GET", path+"?cursor="+url.QueryEscape(cursor), nil, 400)
			}
			// A concurrent autocommit after page one must not extend the boundary.
			// Membership time must be join time, not an already-existing user's age.
			switch source.kind {
			case "members":
				exec(`INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'reader' FROM users WHERE email='tenant-pages-other@example.test'`, tid)
			case "canvases":
				exec(`INSERT INTO canvases(id,tenant_id,name) VALUES('tp-late-canvas',$1,'Late')`, tid)
				exec(`UPDATE canvases SET name='Updated during pagination',updated_at=clock_timestamp() WHERE tenant_id=$1`, tid)
			case "agents":
				exec(`INSERT INTO agents(id,tenant_id,name) VALUES('tp-late-agent',$1,'Late')`, tid)
			case "sessions":
				exec(`INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id) VALUES('tp-late-session',$1,$2,'node-a',$3)`, tid, canvas, agent)
			case "runs":
				exec(`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES('tp-late-run',$1,$2,'tp-late-operation','hash','prompt','completed')`, tid, sid)
			case "invites":
				exec(`INSERT INTO tenant_invites(id,tenant_id,created_by,role,token_hash,expires_at) VALUES('tp-late-invite',$1,$2,'reader','late-hash',now()+interval '1 day')`, tid, uid)
			}
			got := []string{}
			page := first
			for pages := 0; ; pages++ {
				if pages > 20 || page["snapshot"] != first["snapshot"] {
					t.Fatal("unbounded or changing traversal")
				}
				for _, value := range page["items"].([]any) {
					item := value.(map[string]any)
					got = append(got, item["id"].(string))
					for _, forbidden := range []string{"password_hash", "passwordHash", "token_hash", "tokenHash", "token", "inviteUrl", "requestHash", "request_hash", "prompt"} {
						if _, ok := item[forbidden]; ok {
							t.Fatal("sensitive projection", forbidden)
						}
					}
				}
				if page["nextCursor"] == nil {
					break
				}
				page = h.request(t, owner, "GET", path+"?limit=41&cursor="+url.QueryEscape(page["nextCursor"].(string))+source.query, nil, 200)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("missing/duplicated/moved rows: got %d want %d", len(got), len(want))
			}
		})
		// Keep the other account outside this tenant for the next scope test.
		exec(`DELETE FROM memberships WHERE tenant_id=$1 AND user_id=(SELECT id FROM users WHERE email='tenant-pages-other@example.test')`, tid)
	}
	for _, path := range []string{"/sessions?canvasId=a&canvasId=b", "/sessions?sessionId=a&sessionId=b", "/sessions?sessionId=%00", "/sessions?sessionId=%ff", "/runs?sessionId=a&sessionId=b", "/runs?active=", "/runs?active=1", "/runs?active=true&active=false", "/runs?operationId=" + strings.Repeat("x", 201)} {
		h.request(t, owner, "GET", p+path, nil, 400)
	}
	filtered := h.request(t, owner, "GET", p+"/runs?operationId=tp-operation-1&sessionId="+sid, nil, 200)
	if items := filtered["items"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != "tp-run-1" || filtered["nextCursor"] != nil {
		t.Fatal("exact operation lookup changed", filtered)
	}
	exact := h.request(t, owner, "GET", p+"/sessions?canvasId="+canvas+"&sessionId=tp-session-1", nil, 200)
	if items := exact["items"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != "tp-session-1" || exact["nextCursor"] != nil {
		t.Fatal("exact session lookup changed", exact)
	}
	wrongCanvas := h.request(t, owner, "GET", p+"/sessions?canvasId=tp-canvas-1&sessionId=tp-session-1", nil, 200)
	if len(wrongCanvas["items"].([]any)) != 0 {
		t.Fatal("exact session lookup ignored canvas filter")
	}
	exec(`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,created_at) VALUES('tp-active-1',$1,'tp-session-1','tp-active-1','hash','prompt','queued','1999-01-01'),('tp-active-2',$1,'tp-session-2','tp-active-2','hash','prompt','running','1999-01-01')`, tid)
	active := h.request(t, owner, "GET", p+"/runs?active=true&limit=1", nil, 200)
	if active["items"].([]any)[0].(map[string]any)["id"] != "tp-active-2" {
		t.Fatal("active run hidden behind completed history", active)
	}
	activeCursor := url.QueryEscape(active["nextCursor"].(string))
	h.request(t, owner, "GET", p+"/runs?active=false&cursor="+activeCursor, nil, 400)
	active = h.request(t, owner, "GET", p+"/runs?active=true&cursor="+activeCursor, nil, 200)
	if items := active["items"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != "tp-active-1" || active["nextCursor"] != nil {
		t.Fatal("active pagination incomplete", active)
	}
	active = h.request(t, owner, "GET", p+"/runs?active=true&sessionId=tp-session-1", nil, 200)
	if items := active["items"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != "tp-active-1" {
		t.Fatal("active session lookup incorrect", active)
	}
	// Possessing the same tenant's cursor grants no access after removal, and
	// another authorized identity cannot replay the creator's signed traversal.
	h.request(t, owner, "POST", p+"/members", map[string]string{"email": "tenant-pages-other@example.test", "role": "admin"}, 201)
	first := h.request(t, owner, "GET", p+"/canvases?limit=1", nil, 200)
	h.request(t, outsider, "GET", p+"/canvases?cursor="+url.QueryEscape(first["nextCursor"].(string)), nil, 400)
	readerPage := h.request(t, outsider, "GET", p+"/invites?limit=1", nil, 200)
	var outsiderID string
	if err := h.db.QueryRow(ctx, "SELECT id FROM users WHERE email='tenant-pages-other@example.test'").Scan(&outsiderID); err != nil {
		t.Fatal(err)
	}
	h.request(t, owner, "PATCH", p+"/members/"+outsiderID, map[string]string{"role": "reader"}, 204)
	h.request(t, outsider, "GET", p+"/invites?cursor="+url.QueryEscape(readerPage["nextCursor"].(string)), nil, 403)
	readerPage = h.request(t, outsider, "GET", p+"/canvases?limit=1", nil, 200)
	h.request(t, owner, "DELETE", p+"/members/"+outsiderID, nil, 204)
	h.request(t, outsider, "GET", p+"/canvases?cursor="+url.QueryEscape(readerPage["nextCursor"].(string)), nil, 404)
}

func TestPostgresTenantPaginationUpgrade(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, uid := h.register(t, "page-upgrade@example.test")
	// Recreate the pre-005 shape with existing memberships in this owned schema.
	for _, sql := range []string{
		"ALTER TABLE memberships DROP COLUMN created_at",
		"DROP INDEX canvases_page,agents_page,node_sessions_page,node_sessions_canvas_page,runs_page,runs_session_page",
		"DELETE FROM awwo_schema_migrations WHERE version=5",
	} {
		if _, err := h.db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := Migrate(ctx, h.db); err != nil {
			t.Fatal("upgrade/restart migration failed", err)
		}
	}
	var valid bool
	var indexes int
	if err := h.db.QueryRow(ctx, "SELECT created_at IS NOT NULL FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, uid).Scan(&valid); err != nil || !valid {
		t.Fatal("existing membership lost ordering timestamp", err)
	}
	if err := h.db.QueryRow(ctx, "SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('memberships_page','canvases_page','agents_page','node_sessions_page','node_sessions_canvas_page','runs_page','runs_session_page')").Scan(&indexes); err != nil || indexes != 7 {
		t.Fatal("pagination indexes missing", err, indexes)
	}
	page := h.request(t, owner, "GET", "/tenants/"+tid+"/members?limit=1", nil, 200)
	if len(page["items"].([]any)) != 1 || page["nextCursor"] != nil {
		t.Fatal("upgraded membership cannot be listed", page)
	}
}

func TestPostgresCanvasLifecyclePreservesActiveRuns(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, uid := h.register(t, "lifecycle-owner@example.test")
	reader, other, _ := h.register(t, "lifecycle-reader@example.test")
	created := h.request(t, owner, "POST", "/tenants", map[string]string{"name": "New workspace"}, 201)
	if created["role"] != "owner" || created["status"] != "active" || created["name"] != "New workspace" {
		t.Fatal("workspace creation contract", created)
	}
	canvas, _, sid := h.fixture(t, owner, tid)
	p := "/tenants/" + tid
	path := p + "/canvases/" + canvas
	h.request(t, reader, "DELETE", "/tenants/"+other+"/canvases/"+canvas, nil, 404)
	h.request(t, owner, "POST", p+"/members", map[string]string{"email": "lifecycle-reader@example.test", "role": "reader"}, 201)
	current := h.request(t, owner, "GET", path, nil, 200)
	renamed := h.request(t, owner, "PUT", path, map[string]any{"name": "Renamed", "document": current["document"], "version": current["version"]}, 200)
	if renamed["version"] != float64(2) || !reflect.DeepEqual(renamed["document"], current["document"]) {
		t.Fatal("rename changed document or missed CAS increment")
	}
	h.request(t, owner, "PUT", path, map[string]any{"name": "Stale", "document": current["document"], "version": current["version"]}, 409)
	h.request(t, reader, "PUT", path, map[string]any{"name": "Forbidden", "document": current["document"], "version": renamed["version"]}, 403)
	h.request(t, reader, "DELETE", path, nil, 403)
	for _, kind := range []string{"node", "planner"} {
		for _, status := range []string{"queued", "running"} {
			id := fmt.Sprintf("lifecycle-%s-%s", kind, status)
			if _, err := h.db.Exec(ctx, "UPDATE node_sessions SET kind=$2 WHERE id=$1", sid, kind); err != nil {
				t.Fatal(err)
			}
			if _, err := h.db.Exec(ctx, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,$2,$3,$1,'hash','Do not lose this',$4)`, id, tid, sid, status); err != nil {
				t.Fatal(err)
			}
			if _, err := h.db.Exec(ctx, `INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,'{"type":"queued"}')`, tid, id); err != nil {
				t.Fatal(err)
			}
			requireCode(t, h.request(t, owner, "DELETE", path, nil, 409), "resource_in_use")
			var stored, eventCount, deleteAudits int
			if err := h.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM runs WHERE id=$1 AND status=$2),(SELECT count(*) FROM run_events WHERE run_id=$1),(SELECT count(*) FROM audit_events WHERE actor_id=$3 AND resource_id=$4 AND action='canvas.deleted')`, id, status, uid, canvas).Scan(&stored, &eventCount, &deleteAudits); err != nil || stored != 1 || eventCount != 1 || deleteAudits != 0 {
				t.Fatal("active facts changed during rejected delete", err, stored, eventCount, deleteAudits)
			}
			if _, err := h.db.Exec(ctx, "UPDATE runs SET status='completed' WHERE id=$1", id); err != nil {
				t.Fatal(err)
			}
		}
	}
	h.request(t, owner, "DELETE", path, nil, 204)
	h.request(t, owner, "GET", path, nil, 404)
	var remaining, auditCount int
	if err := h.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM node_sessions WHERE canvas_id=$1),(SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='canvas.deleted')`, canvas).Scan(&remaining, &auditCount); err != nil || remaining != 0 || auditCount != 1 {
		t.Fatal("deletion/audit contract", err, remaining, auditCount)
	}
	// A migration applies to existing memberships and remains restart-idempotent.
	var metadata json.RawMessage
	if err := h.db.QueryRow(ctx, "SELECT to_jsonb(m) FROM memberships m WHERE tenant_id=$1 AND user_id=$2", tid, uid).Scan(&metadata); err != nil || !strings.Contains(string(metadata), "created_at") {
		t.Fatal("membership ordering column unavailable", err)
	}
}
