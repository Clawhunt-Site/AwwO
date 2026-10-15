package app

import (
	"context"
	"net/http"
	"reflect"
	"testing"
)

func TestPostgresRouteUsageAndUpgradeInterest(t *testing.T) {
	provider := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { completePi(w, "done") })
	defer provider.Close()
	h := newHarness(t, provider.URL)
	h.a.cfg.RouteFreeModels = []string{"qwen3.8-27b-p6"}
	ca, ta, _ := h.register(t, "usage-a@example.test")
	cb, tb, _ := h.register(t, "usage-b@example.test")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := h.db.Exec(context.Background(), sql, args...); e != nil {
			t.Fatal(sql, e)
		}
	}
	ra := routeHarnessRun(t, h, ca, ta, `{"gate":3,"bedrock":1,"media":1}`)
	exec("UPDATE tenants SET max_runs_per_day=30 WHERE id=$1", ta)
	reserve := func(models ...string) {
		t.Helper()
		for _, model := range models {
			if e := reserveModel(h, ta, ra, model); e != nil {
				t.Fatal(model, e)
			}
		}
	}
	reserve("qwen3.8-27b-p6", "qwen3.8-27b-p6", "claude-sonnet-5", "bedrock.claude-opus-5-5")
	usage := func(c *http.Cookie, tid string) map[string]any {
		t.Helper()
		return h.request(t, c, "GET", "/tenants/"+tid+"/route-usage", nil, 200)
	}
	allowance := func(limit, used float64) map[string]any { return map[string]any{"limit": limit, "used": used} }
	u := usage(ca, ta)
	if u["limited"] != true || u["interested"] != false || !reflect.DeepEqual(u["daily"], allowance(30, 4)) ||
		!reflect.DeepEqual(u["routes"], map[string]any{"gate": allowance(3, 1), "bedrock": allowance(1, 1), "media": allowance(1, 0)}) || u["resetsAt"] == nil {
		t.Fatal("route usage", u)
	}
	// A workspace without route limits reports only its daily allowance.
	if u = usage(cb, tb); u["limited"] != false || u["routes"] != nil {
		t.Fatal("unlimited workspace", u)
	}

	interest := func(c *http.Cookie, body map[string]any, status int) map[string]any {
		t.Helper()
		return h.request(t, c, "POST", "/tenants/"+ta+"/upgrade-interest", body, status)
	}
	stored := func() string {
		t.Helper()
		var routes string
		if e := h.db.QueryRow(context.Background(), "SELECT routes::text FROM upgrade_interests i JOIN users u ON u.id=i.user_id WHERE i.tenant_id=$1 AND u.email='usage-a@example.test'", ta).Scan(&routes); e != nil {
			t.Fatal(e)
		}
		return routes
	}
	// The server records what was used up when the person asked: Bedrock only, not the other routes.
	if v := interest(ca, map[string]any{}, 200); v["recorded"] != true || v["clicks"] != 1.0 {
		t.Fatal("first interest", v)
	}
	if r := stored(); r != "{bedrock}" {
		t.Fatal("recorded routes", r)
	}
	if u = usage(ca, ta); u["interested"] != true {
		t.Fatal("interest not reflected in the meter", u)
	}
	// The meter counts as admission does: a call that cost nothing gives its route allowance back but
	// still spent the daily total.
	exec("UPDATE model_invocations SET status='failed',cost_status='not_incurred' WHERE tenant_id=$1 AND model_id LIKE 'bedrock.%'", ta)
	if u = usage(ca, ta); !reflect.DeepEqual(u["routes"].(map[string]any)["bedrock"], allowance(1, 0)) || !reflect.DeepEqual(u["daily"], allowance(30, 4)) {
		t.Fatal("not_incurred call", u)
	}
	// A second press within ten minutes is the same request, but it adds what has run out since.
	reserve("claude-sonnet-5", "claude-sonnet-5")
	if v := interest(ca, map[string]any{}, 200); v["clicks"] != 1.0 {
		t.Fatal("double click counted", v)
	}
	if r := stored(); r != "{bedrock,gate}" {
		t.Fatal("routes after the gate ran out", r)
	}
	// A later occasion counts; a spent daily total is recorded, a route closed with 0 never is.
	exec("UPDATE upgrade_interests SET last_at=last_at-interval '11 minutes' WHERE tenant_id=$1", ta)
	exec(`UPDATE tenants SET max_runs_per_day=6,route_limits='{"gate":3,"bedrock":1,"media":0}'::jsonb WHERE id=$1`, ta)
	if v := interest(ca, map[string]any{}, 200); v["clicks"] != 2.0 {
		t.Fatal("a later occasion not counted", v)
	}
	if r := stored(); r != "{bedrock,daily,gate}" {
		t.Fatal("routes after the daily total ran out", r)
	}
	interest(ca, map[string]any{"route": "gate"}, 400)
	// Another workspace's meter and interest are not reachable.
	h.request(t, cb, "GET", "/tenants/"+ta+"/route-usage", nil, 404)
	h.request(t, cb, "POST", "/tenants/"+ta+"/upgrade-interest", map[string]any{}, 404)

	h.a.cfg.AdminEmail, h.a.cfg.AdminPassword = "admin@example.test", "Strong password 123!"
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	admin := h.login(t, "admin@example.test")
	page := h.request(t, admin, "GET", "/admin/interests?limit=10", nil, 200)
	items := page["items"].([]any)
	if len(items) != 1 {
		t.Fatal("interest listing", page)
	}
	row := items[0].(map[string]any)
	if row["email"] != "usage-a@example.test" || row["tenantId"] != ta || row["tenantName"] == "" || row["clicks"] != 2.0 ||
		!reflect.DeepEqual(row["routes"], []any{"bedrock", "daily", "gate"}) || row["createdAt"] == nil || row["lastAt"] == nil {
		t.Fatal("interest row", row)
	}
	h.request(t, ca, "GET", "/admin/interests", nil, 403)

	// A reader may read the meter and ask for more; a second row pages through the joined listing.
	cr, _, _ := h.register(t, "usage-reader@example.test")
	exec("INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'reader' FROM users WHERE email='usage-reader@example.test'", ta)
	usage(cr, ta)
	interest(cr, map[string]any{}, 200)
	first := h.request(t, admin, "GET", "/admin/interests?limit=1", nil, 200)
	cursor, _ := first["nextCursor"].(string)
	if len(first["items"].([]any)) != 1 || cursor == "" {
		t.Fatal("first page", first)
	}
	second := h.request(t, admin, "GET", "/admin/interests?limit=1&cursor="+cursor, nil, 200)
	if items := second["items"].([]any); len(items) != 1 || second["nextCursor"] != nil ||
		items[0].(map[string]any)["id"] == first["items"].([]any)[0].(map[string]any)["id"] {
		t.Fatal("second page", second)
	}
	// A generation its provider accepted counts in the media route and the daily total, even on a closed route.
	exec("INSERT INTO media_generations(run_id,tenant_id,model,provider_accepted) VALUES($1,$2,'rh.seedream-v5-pro',true)", randomID(), ta)
	if u = usage(ca, ta); !reflect.DeepEqual(u["routes"].(map[string]any)["media"], allowance(0, 1)) || !reflect.DeepEqual(u["daily"], allowance(6, 7)) {
		t.Fatal("generation in the meter", u)
	}
	// A suspended workspace still shows its meter but takes no interest.
	exec("UPDATE tenants SET status='suspended' WHERE id=$1", ta)
	usage(ca, ta)
	interest(ca, map[string]any{}, 403)
}
