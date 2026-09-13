package app

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"
)

func seedUsageRun(t *testing.T, h *harness, tenant string) string {
	t.Helper()
	ctx := context.Background()
	agent, canvas, session, run := randomID(), randomID(), randomID(), randomID()
	queries := []struct {
		sql  string
		args []any
	}{{"INSERT INTO agents(id,tenant_id,name) VALUES($1,$2,'usage agent')", []any{agent, tenant}}, {"INSERT INTO canvases(id,tenant_id,name) VALUES($1,$2,'usage canvas')", []any{canvas, tenant}}, {"INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id) VALUES($1,$2,$3,'node',$4)", []any{session, tenant, canvas, agent}}, {"INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output) VALUES($1,$2,$3,$1,'canary-hash','PRIVATE-USAGE-PROMPT','completed','PRIVATE-USAGE-OUTPUT')", []any{run, tenant, session}}}
	for _, q := range queries {
		if _, e := h.db.Exec(ctx, q.sql, q.args...); e != nil {
			t.Fatal(e)
		}
	}
	return run
}
func usageQuery(from, to time.Time, group string) string {
	return "?" + url.Values{"from": {from.Format(time.RFC3339Nano)}, "to": {to.Format(time.RFC3339Nano)}, "groupBy": {group}}.Encode()
}
func TestUsageAPIIsolationPaginationAndUnknown(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tenant, ownerID := h.register(t, "usage-owner@test.local")
	reader, otherTenant, readerID := h.register(t, "usage-reader@test.local")
	ctx := context.Background()
	run := seedUsageRun(t, h, tenant)
	otherRun := seedUsageRun(t, h, otherTenant)
	base := time.Now().UTC().Add(-time.Minute)
	from, to := base.Add(-time.Hour), time.Now().UTC()
	for i, id := range []string{"usage-a", "usage-b", "usage-c"} {
		version := []string{"v1", "v2", "v3"}[i]
		status := "reported"
		cost := "estimated"
		var input, amount any = int64(0), int64(0)
		if i == 1 {
			input = int64(9007199254740991)
			amount = int64(9007199254740992)
		}
		if i == 2 {
			status = "unknown"
			cost = "unknown"
			input = nil
			amount = nil
		}
		if _, e := h.db.Exec(ctx, `INSERT INTO model_invocations(id,tenant_id,run_id,status,created_at,completed_at,model_id,usage_status,input_tokens,cost_status,estimated_cost_microusd,pricing_version,observability_version) VALUES($1,$2,$3,'completed',$4,$4,'fixture',$5,$6,$7,$8,$9,1)`, id, tenant, run, base, status, input, cost, amount, version); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := h.db.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status,created_at,completed_at,usage_status,input_tokens) VALUES('other-inv',$1,$2,'completed',$3,$3,'reported',123)", otherTenant, otherRun, base); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "UPDATE model_invocations SET completed_xid=pg_current_xact_id() WHERE status<>'running'"); e != nil {
		t.Fatal(e)
	}
	path := "/tenants/" + tenant + "/runs/" + run + "/invocations"
	first := h.request(t, owner, "GET", path+"?pageSize=1", nil, 200)
	items := first["items"].([]any)
	item := items[0].(map[string]any)
	if item["estimatedCostMicrousd"] != "0" || item["usage"].(map[string]any)["inputTokens"] != "0" {
		t.Fatal("explicit zero not decimal string", item)
	}
	if strings.Contains(string(mustUsageJSON(first)), "PRIVATE-USAGE") {
		t.Fatal("content leaked into usage")
	}
	cursor := first["page"].(map[string]any)["nextCursor"].(string)
	if _, e := h.db.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status) VALUES('late-inv',$1,$2,'running')", tenant, run); e != nil {
		t.Fatal(e)
	}
	second := h.request(t, owner, "GET", path+"?pageSize=10&cursor="+url.QueryEscape(cursor), nil, 200)
	items = second["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["estimatedCostMicrousd"] != "9007199254740992" || items[1].(map[string]any)["usage"].(map[string]any)["inputTokens"] != nil {
		t.Fatal("pagination/precision/null mismatch", items)
	}
	h.request(t, owner, "GET", path+"?cursor="+url.QueryEscape(cursor+"x"), nil, 400)
	h.request(t, owner, "GET", "/tenants/"+tenant+"/runs/other-run/invocations?cursor="+url.QueryEscape(cursor), nil, 404)
	h.request(t, reader, "GET", path, nil, 404)
	if _, e := h.db.Exec(ctx, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'reader')", tenant, readerID); e != nil {
		t.Fatal(e)
	}
	for _, role := range []string{"reader", "member"} {
		if _, e := h.db.Exec(ctx, "UPDATE memberships SET role=$1 WHERE tenant_id=$2 AND user_id=$3", role, tenant, readerID); e != nil {
			t.Fatal(e)
		}
		got := h.request(t, reader, "GET", path, nil, 200)
		for _, v := range got["items"].([]any) {
			m := v.(map[string]any)
			for _, key := range []string{"costStatus", "estimatedCostMicrousd", "currency", "pricingVersion", "priceSnapshot"} {
				if _, exists := m[key]; exists {
					t.Fatal("cost field leaked for", role, key)
				}
			}
		}
		h.request(t, reader, "GET", "/tenants/"+tenant+"/usage"+usageQuery(from, to, "model"), nil, 403)
	}
	aggregatePath := "/tenants/" + tenant + "/usage" + usageQuery(from, to, "model") + "&pageSize=1"
	grouped := h.request(t, owner, "GET", aggregatePath, nil, 200)
	g := grouped["items"].([]any)[0].(map[string]any)
	if g["pricingVersion"] != "v1" || g["tokens"].(map[string]any)["input"] != "0" {
		t.Fatal("bad aggregate", g)
	}
	aggCursor := grouped["page"].(map[string]any)["nextCursor"].(string)
	grouped = h.request(t, owner, "GET", aggregatePath+"&cursor="+url.QueryEscape(aggCursor), nil, 200)
	g = grouped["items"].([]any)[0].(map[string]any)
	if g["pricingVersion"] != "v2" || g["knownEstimatedCostMicrousd"] != "9007199254740992" {
		t.Fatal("full pricing key pagination failed", g)
	}
	aggCursor = grouped["page"].(map[string]any)["nextCursor"].(string)
	grouped = h.request(t, owner, "GET", aggregatePath+"&cursor="+url.QueryEscape(aggCursor), nil, 200)
	g = grouped["items"].([]any)[0].(map[string]any)
	if g["pricingVersion"] != "v3" || g["knownEstimatedCostMicrousd"] != nil || g["tokens"].(map[string]any)["input"] != nil || g["usageSamples"].(map[string]any)["unknown"] != "1" {
		t.Fatal("unknown silently counted as zero", g)
	}
	h.request(t, owner, "GET", strings.Replace(aggregatePath, "groupBy=model", "groupBy=runtime", 1)+"&cursor="+url.QueryEscape(aggCursor), nil, 400)
	h.request(t, owner, "GET", "/admin/observability/invocations/usage-a", nil, 403)
	if _, e := h.db.Exec(ctx, "UPDATE users SET platform_role='admin' WHERE id=$1", ownerID); e != nil {
		t.Fatal(e)
	}
	h.request(t, owner, "GET", "/admin/observability/invocations/usage-b", nil, 200)
	summary := h.request(t, owner, "GET", "/admin/observability/summary"+usageQuery(from, to, "model")+"&tenantId="+tenant, nil, 200)
	if summary["summary"].(map[string]any)["protocolVersions"].(map[string]any)["1"] != "3" {
		t.Fatal("protocol version distribution missing", summary)
	}
	h.request(t, owner, "GET", "/admin/observability/summary", nil, 200)
	h.request(t, owner, "GET", "/admin/observability/summary?tenantId=unknown", nil, 404)
	var audits int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor_id=$1 AND action IN ('observability.invocation.read','observability.summary.read')", ownerID).Scan(&audits); e != nil || audits != 2 {
		t.Fatal("admin audit missing", e, audits)
	}
	for _, group := range []string{"day", "agent", "runtime"} {
		h.request(t, owner, "GET", "/tenants/"+tenant+"/usage"+usageQuery(from, to, group), nil, 200)
	}
}
func mustUsageJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func TestUsageAPIValidationRetentionAndDatabaseFailure(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tenant, _ := h.register(t, "usage-validation@test.local")
	run := seedUsageRun(t, h, tenant)
	now := time.Now().UTC()
	path := "/tenants/" + tenant + "/usage"
	valid := usageQuery(now.Add(-time.Hour), now, "runtime")
	for _, tc := range []struct {
		suffix string
		status int
		code   string
	}{{"", 400, "invalid_time_range"}, {usageQuery(now, now, "runtime"), 400, "invalid_time_range"}, {usageQuery(now.Add(-93*24*time.Hour), now, "runtime"), 422, "range_too_large"}, {usageQuery(now.Add(-time.Hour), now.Add(time.Hour), "runtime"), 400, "invalid_time_range"}, {usageQuery(now.Add(-time.Hour), now, "tenant"), 400, "invalid_group_by"}, {valid + "&pageSize=0", 400, "invalid_pagination"}, {valid + "&cursor=", 400, "invalid_cursor"}, {valid + "&from=x", 400, "invalid_time_range"}} {
		got := h.request(t, owner, "GET", path+tc.suffix, nil, tc.status)
		if got["error"].(map[string]any)["code"] != tc.code {
			t.Fatal("wrong error", got)
		}
	}
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO usage_retention_boundaries(tenant_id,retained_from) VALUES($1,$2)", tenant, now.Add(-time.Minute)); e != nil {
		t.Fatal(e)
	}
	got := h.request(t, owner, "GET", path+valid, nil, 422)
	errObj := got["error"].(map[string]any)
	if errObj["code"] != "range_not_retained" || errObj["details"].(map[string]any)["retainedFrom"] == nil {
		t.Fatal("missing retention boundary", got)
	}
	if _, e := h.db.Exec(ctx, "ALTER TABLE model_invocations RENAME TO temporarily_unavailable_invocations"); e != nil {
		t.Fatal(e)
	}
	got = h.request(t, owner, "GET", "/tenants/"+tenant+"/runs/"+run+"/invocations", nil, 503)
	if got["error"].(map[string]any)["code"] != "usage_unavailable" {
		t.Fatal("DB error not controlled", got)
	}
}
func TestUsageCursorBindingAndExpiry(t *testing.T) {
	a := New(nil, testConfig())
	c := usageCursor{Version: 1, Kind: "aggregate", Actor: "actor", Tenant: "tenant", From: "from", To: "to", Group: "model", AsOf: time.Now().UTC(), Snapshot: "10:20:", Issued: time.Now().UTC(), Last: []string{"model", "USD", "v1"}}
	raw := a.signUsageCursor(c)
	if _, e := a.parseUsageCursor(raw, c); e != nil {
		t.Fatal(e)
	}
	oversized := c
	oversized.Last = []string{strings.Repeat("x", 2049), "USD", "v1"}
	if _, e := a.parseUsageCursor(a.signUsageCursor(oversized), oversized); e == nil {
		t.Fatal("oversized cursor key accepted")
	}
	for _, kind := range []string{"actor", "tenant", "from", "to", "group"} {
		want := c
		switch kind {
		case "actor":
			want.Actor = "other"
		case "tenant":
			want.Tenant = "other"
		case "from":
			want.From = "other"
		case "to":
			want.To = "other"
		case "group":
			want.Group = "other"
		}
		if _, e := a.parseUsageCursor(raw, want); e == nil {
			t.Fatal("cursor not bound to", kind)
		}
	}
	c.Issued = time.Now().Add(-25 * time.Hour)
	if _, e := a.parseUsageCursor(a.signUsageCursor(c), c); e == nil {
		t.Fatal("expired cursor accepted")
	}
}

func TestUsageAPIUnicodeGroupCursorRoundTrip(t *testing.T) {
	for _, group := range []string{"agent", "model"} {
		t.Run(group, func(t *testing.T) {
			h := newHarness(t, "http://127.0.0.1:1")
			owner, tenant, _ := h.register(t, "unicode-"+group+"@test.local")
			run := seedUsageRun(t, h, tenant)
			length := 128
			if group == "model" {
				length = 256
			}
			values := []string{strings.Repeat("𠀀", length-1) + "𠀁", strings.Repeat("𠀀", length-1) + "𠀂"}
			at := time.Now().UTC().Add(-time.Minute)
			for i, value := range values {
				agent, model := "member", "selector"
				if group == "agent" {
					agent = value
				} else {
					model = value
				}
				if _, e := h.db.Exec(context.Background(), `INSERT INTO model_invocations(id,tenant_id,run_id,agent_id,model_id,runtime,status,created_at,completed_at,completed_xid) VALUES($1,$2,$3,$4,$5,'openai-agents','completed',$6,$6,pg_current_xact_id())`, randomID(), tenant, run, agent, model, at); e != nil {
					t.Fatal(e)
				}
				if group == "model" {
					values[i] = "openai-agents:" + value
				}
			}
			path := "/tenants/" + tenant + "/usage" + usageQuery(at.Add(-time.Hour), time.Now().UTC(), group) + "&pageSize=1"
			page := h.request(t, owner, "GET", path, nil, 200)
			for i, want := range values {
				items := page["items"].([]any)
				if len(items) != 1 || items[0].(map[string]any)["group"].(map[string]any)["value"] != want {
					t.Fatal("Unicode group omitted or repeated", i, page)
				}
				cursor := page["page"].(map[string]any)["nextCursor"]
				if i == 0 {
					page = h.request(t, owner, "GET", path+"&cursor="+url.QueryEscape(cursor.(string)), nil, 200)
				} else if cursor != nil {
					t.Fatal("unexpected third page")
				}
			}
		})
	}
}

func TestUsageLedgerSurvivesCompletedCanvasDeletion(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tenant, user := h.register(t, "usage-retained@test.local")
	ctx := context.Background()
	run := seedUsageRun(t, h, tenant)
	var canvas string
	if e := h.db.QueryRow(ctx, "SELECT s.canvas_id FROM runs r JOIN node_sessions s ON s.id=r.session_id WHERE r.id=$1", run).Scan(&canvas); e != nil {
		t.Fatal(e)
	}
	at := time.Now().UTC().Add(-time.Minute)
	if _, e := h.db.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status,usage_status,cost_status,completed_at) VALUES('retained-inv',$1,$2,'completed','unknown','unknown',$3)", tenant, run, at); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, "UPDATE model_invocations SET completed_xid=pg_current_xact_id() WHERE id='retained-inv'"); e != nil {
		t.Fatal(e)
	}
	h.request(t, owner, "DELETE", "/tenants/"+tenant+"/canvases/"+canvas, nil, 204)
	var count int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM model_invocations WHERE tenant_id=$1 AND id='retained-inv'", tenant).Scan(&count); e != nil || count != 1 {
		t.Fatal("canvas deletion erased ledger", e, count)
	}
	h.request(t, owner, "GET", "/tenants/"+tenant+"/runs/"+run+"/invocations", nil, 404)
	got := h.request(t, owner, "GET", "/tenants/"+tenant+"/usage"+usageQuery(at.Add(-time.Hour), time.Now().UTC(), "runtime"), nil, 200)
	item := got["items"].([]any)[0].(map[string]any)
	if item["usageSamples"].(map[string]any)["unknown"] != "1" || item["knownEstimatedCostMicrousd"] != nil {
		t.Fatal("deleted run's unknown charge was lost", item)
	}
	if _, e := h.db.Exec(ctx, "UPDATE users SET platform_role='admin' WHERE id=$1", user); e != nil {
		t.Fatal(e)
	}
	h.request(t, owner, "GET", "/admin/observability/invocations/retained-inv", nil, 200)
}

func TestUsageMVCCSnapshotExcludesDelayedCommits(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tenant, _ := h.register(t, "usage-mvcc@test.local")
	run := seedUsageRun(t, h, tenant)
	ctx := context.Background()
	at := time.Now().UTC().Add(-time.Minute)
	for _, id := range []string{"mvcc-a", "mvcc-z"} {
		if _, e := h.db.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status,created_at,completed_at,completed_xid,model_id) VALUES($1,$2,$3,'completed',$4,$4,pg_current_xact_id(),$1)", id, tenant, run, at); e != nil {
			t.Fatal(e)
		}
	}
	// Allocate the timestamp/XID before page one, but defer commit until afterwards.
	pending, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer pending.Rollback(ctx)
	if _, e = pending.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status,created_at,completed_at,completed_xid,model_id) VALUES('mvcc-m',$1,$2,'completed',$3,$3,pg_current_xact_id(),'mvcc-m')", tenant, run, at); e != nil {
		t.Fatal(e)
	}
	aggregatePath := "/tenants/" + tenant + "/usage" + usageQuery(at.Add(-time.Hour), time.Now().UTC(), "model")
	runPath := "/tenants/" + tenant + "/runs/" + run + "/invocations"
	firstAggregate := h.request(t, owner, "GET", aggregatePath+"&pageSize=1", nil, 200)
	firstRun := h.request(t, owner, "GET", runPath+"?pageSize=1", nil, 200)
	aggregateCursor := firstAggregate["page"].(map[string]any)["nextCursor"].(string)
	runCursor := firstRun["page"].(map[string]any)["nextCursor"].(string)
	if e = pending.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	secondAggregate := h.request(t, owner, "GET", aggregatePath+"&cursor="+url.QueryEscape(aggregateCursor), nil, 200)
	secondRun := h.request(t, owner, "GET", runPath+"?cursor="+url.QueryEscape(runCursor), nil, 200)
	if len(secondAggregate["items"].([]any)) != 1 || len(secondRun["items"].([]any)) != 1 || strings.Contains(string(mustUsageJSON(secondRun)), "mvcc-m") || strings.Contains(string(mustUsageJSON(secondAggregate)), "mvcc-m") {
		t.Fatal("late commit entered a frozen page set", secondAggregate, secondRun)
	}
	fresh := h.request(t, owner, "GET", runPath, nil, 200)
	if len(fresh["items"].([]any)) != 3 {
		t.Fatal("new first page failed to include committed row", fresh)
	}
	// A previously committed running row also must not enter the aggregate when
	// its terminal transaction was still in flight at page-one snapshot time.
	if _, e = h.db.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status,created_at,model_id) VALUES('mvcc-n',$1,$2,'running',$3,'mvcc-n')", tenant, run, at); e != nil {
		t.Fatal(e)
	}
	terminal, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer terminal.Rollback(ctx)
	if _, e = terminal.Exec(ctx, "UPDATE model_invocations SET status='completed',completed_at=$1,completed_xid=pg_current_xact_id() WHERE id='mvcc-n'", at); e != nil {
		t.Fatal(e)
	}
	firstAggregate = h.request(t, owner, "GET", aggregatePath+"&pageSize=1", nil, 200)
	aggregateCursor = firstAggregate["page"].(map[string]any)["nextCursor"].(string)
	if e = terminal.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	secondAggregate = h.request(t, owner, "GET", aggregatePath+"&cursor="+url.QueryEscape(aggregateCursor), nil, 200)
	if len(secondAggregate["items"].([]any)) != 2 || strings.Contains(string(mustUsageJSON(secondAggregate)), "mvcc-n") {
		t.Fatal("late terminal transaction entered frozen aggregates", secondAggregate)
	}
}
