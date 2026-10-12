package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostgresUIEvents(t *testing.T) {
	h := newHarness(t, "")
	ca, ta, ua := h.register(t, "events-a@example.test")
	cb, tb, _ := h.register(t, "events-b@example.test")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(context.Background(), sql, args...); e != nil {
			t.Fatal(sql, e)
		}
	}
	canvas := h.request(t, ca, "POST", "/tenants/"+ta+"/canvases", map[string]any{"name": "Review", "document": map[string]any{}}, 201)["id"].(string)
	theirs := h.request(t, cb, "POST", "/tenants/"+tb+"/canvases", map[string]any{"name": "Theirs", "document": map[string]any{}}, 201)["id"].(string)
	press := func(c *http.Cookie, tid, cid string, body map[string]any, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/ui-events", body, status)
	}
	count := func(action string) int {
		t.Helper()
		var n int
		if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE action=$1 AND tenant_id=$2 AND resource_id=$3",
			action, ta, canvas).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}

	// One press is one audit event on its canvas; the same press again at once is the same press.
	if v := press(ca, ta, canvas, map[string]any{"name": "review.next_steps"}, 200); v["recorded"] != true {
		t.Fatal("first press", v)
	}
	if v := press(ca, ta, canvas, map[string]any{"name": "review.next_steps"}, 200); v["recorded"] != false {
		t.Fatal("double click counted", v)
	}
	if n := count("ui.review.next_steps"); n != 1 {
		t.Fatal("presses after a double click", n)
	}
	// A later press counts again, and each button is its own event.
	exec("UPDATE audit_events SET created_at=created_at-interval '3 seconds' WHERE action LIKE 'ui.%'")
	for _, name := range []string{"review.next_steps", "review.open_report", "assistant.local_answer"} {
		if v := press(ca, ta, canvas, map[string]any{"name": name}, 200); v["recorded"] != true {
			t.Fatal(name, v)
		}
	}
	if count("ui.review.next_steps") != 2 || count("ui.review.open_report") != 1 || count("ui.assistant.local_answer") != 1 {
		t.Fatal("presses by button", count("ui.review.next_steps"), count("ui.review.open_report"), count("ui.assistant.local_answer"))
	}
	// The event names who pressed, and nothing about what the canvas holds.
	var actors, metadata int
	if e := h.db.QueryRow(context.Background(), `SELECT count(*) FILTER (WHERE actor_id<>$2), count(*) FILTER (WHERE metadata<>'{}'::jsonb)
		FROM audit_events WHERE action LIKE 'ui.%' AND tenant_id=$1`, ta, ua).Scan(&actors, &metadata); e != nil {
		t.Fatal(e)
	}
	if actors != 0 || metadata != 0 {
		t.Fatal("event rows", actors, metadata)
	}

	// Only the listed names, as the only field.
	press(ca, ta, canvas, map[string]any{"name": "canvas.deleted"}, 400)
	press(ca, ta, canvas, map[string]any{"name": "review.next_steps", "detail": "the review text"}, 400)
	// Only this workspace's canvases, by its members.
	press(ca, ta, theirs, map[string]any{"name": "review.next_steps"}, 404)
	press(cb, ta, canvas, map[string]any{"name": "review.next_steps"}, 404)
	// A reader is never offered these buttons, and a suspended workspace takes no events.
	cr, _, _ := h.register(t, "events-reader@example.test")
	exec("INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'reader' FROM users WHERE email='events-reader@example.test'", ta)
	press(cr, ta, canvas, map[string]any{"name": "review.open_report"}, 403)
	// A member removed while the request was still being read records nothing.
	cm, _, um := h.register(t, "events-member@example.test")
	h.request(t, ca, "POST", "/tenants/"+ta+"/members", map[string]string{"email": "events-member@example.test", "role": "member"}, 201)
	gate := newRequestGate(t)
	late := httptest.NewRequest("POST", "/api/v1/tenants/"+ta+"/canvases/"+canvas+"/ui-events",
		&gatedRequestBody{strings.NewReader(`{"name":"review.open_report"}`), gate})
	late.AddCookie(cm)
	late.Header.Set("Content-Type", "application/json")
	late.Header.Set("Origin", h.cfg.PublicOrigin)
	recorder, finished := httptest.NewRecorder(), make(chan struct{})
	go func() { defer close(finished); h.a.Handler().ServeHTTP(recorder, late) }()
	awaitTestSignal(t, gate.reached)
	h.request(t, ca, "DELETE", "/tenants/"+ta+"/members/"+um, nil, 204)
	gate.open()
	awaitTestSignal(t, finished)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"recorded":false`) {
		t.Fatal("press after removal", recorder.Code, recorder.Body.String())
	}
	exec("UPDATE tenants SET status='suspended' WHERE id=$1", ta)
	press(ca, ta, canvas, map[string]any{"name": "review.open_report"}, 403)
	if n := count("ui.review.open_report"); n != 1 {
		t.Fatal("refused presses recorded", n)
	}

	// The platform's audit listing shows them.
	h.a.cfg.AdminEmail, h.a.cfg.AdminPassword = "admin@example.test", "Strong password 123!"
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	admin := h.login(t, "admin@example.test")
	found := map[string]bool{}
	for _, item := range h.request(t, admin, "GET", "/admin/audit?limit=50", nil, 200)["items"].([]any) {
		row := item.(map[string]any)
		if row["resourceId"] == canvas && row["tenantId"] == ta {
			found[row["action"].(string)] = true
		}
	}
	if !found["ui.review.next_steps"] || !found["ui.review.open_report"] || !found["ui.assistant.local_answer"] {
		t.Fatal("audit listing", found)
	}
}
