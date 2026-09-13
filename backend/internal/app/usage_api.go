package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type usageCursor struct {
	Version  int       `json:"v"`
	Kind     string    `json:"kind"`
	Actor    string    `json:"actor"`
	Tenant   string    `json:"tenant"`
	Run      string    `json:"run,omitempty"`
	From     string    `json:"from,omitempty"`
	To       string    `json:"to,omitempty"`
	Group    string    `json:"group,omitempty"`
	AsOf     time.Time `json:"asOf"`
	Snapshot string    `json:"snapshot"`
	Issued   time.Time `json:"issued"`
	Last     []string  `json:"last"`
}

func (a *App) signUsageCursor(c usageCursor) string {
	b, _ := json.Marshal(c)
	h := hmac.New(sha256.New, a.cursorKey)
	h.Write(b)
	return base64.RawURLEncoding.EncodeToString(b) + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func (a *App) parseUsageCursor(raw string, want usageCursor) (usageCursor, error) {
	bad := errors.New("invalid usage cursor")
	if len(raw) > 16384 {
		return want, bad
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return want, bad
	}
	b, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return want, bad
	}
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return want, bad
	}
	h := hmac.New(sha256.New, a.cursorKey)
	h.Write(b)
	var c usageCursor
	if !hmac.Equal(sig, h.Sum(nil)) || json.Unmarshal(b, &c) != nil || c.Version != 1 || c.Kind != want.Kind || c.Actor != want.Actor || c.Tenant != want.Tenant || c.Run != want.Run || c.From != want.From || c.To != want.To || c.Group != want.Group || c.AsOf.IsZero() || c.Snapshot == "" || len(c.Snapshot) > 8192 || c.Issued.IsZero() || c.Issued.After(time.Now().Add(time.Minute)) || time.Since(c.Issued) > 24*time.Hour {
		return want, bad
	}
	expected := 3
	if c.Kind == "run" {
		expected = 2
	}
	if len(c.Last) != expected {
		return want, bad
	}
	for _, s := range c.Last {
		// Valid selectors contain up to 256 Unicode code points plus the runtime
		// prefix; their UTF-8 encoding can exceed 1 KiB. Bound bytes without
		// rejecting cursors generated from accepted model/member configuration.
		if len(s) > 2048 {
			return want, bad
		}
	}
	return c, nil
}
func usageFailure(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "requestId": w.Header().Get("X-Request-ID"), "details": details}})
}
func usageUnavailable(w http.ResponseWriter, r *http.Request) {
	usageFailure(w, r, 503, "usage_unavailable", "Usage records are temporarily unavailable", nil)
}
func usagePageSize(w http.ResponseWriter, r *http.Request) (int, bool) {
	n := 50
	if values, ok := r.URL.Query()["pageSize"]; ok {
		if len(values) != 1 {
			usageFailure(w, r, 400, "invalid_pagination", "pageSize must be between 1 and 100", nil)
			return 0, false
		}
		var e error
		n, e = strconv.Atoi(values[0])
		if e != nil || n < 1 || n > 100 {
			usageFailure(w, r, 400, "invalid_pagination", "pageSize must be between 1 and 100", nil)
			return 0, false
		}
	}
	return n, true
}
func usageRange(w http.ResponseWriter, r *http.Request) (time.Time, time.Time, bool) {
	q := r.URL.Query()
	from, e1 := time.Parse(time.RFC3339Nano, q.Get("from"))
	to, e2 := time.Parse(time.RFC3339Nano, q.Get("to"))
	if len(q["from"]) != 1 || len(q["to"]) != 1 || e1 != nil || e2 != nil || !strings.HasSuffix(q.Get("from"), "Z") || !strings.HasSuffix(q.Get("to"), "Z") || !from.Before(to) || to.After(time.Now().Add(time.Minute)) {
		usageFailure(w, r, 400, "invalid_time_range", "A UTC from and to range is required", nil)
		return from, to, false
	}
	if to.Sub(from) > 92*24*time.Hour {
		usageFailure(w, r, 422, "range_too_large", "Usage ranges may not exceed 92 days", nil)
		return from, to, false
	}
	return from, to, true
}
func (a *App) usageTransaction(ctx context.Context, writable bool) (pgx.Tx, error) {
	mode := pgx.ReadOnly
	if writable {
		mode = pgx.ReadWrite
	}
	tx, e := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: mode})
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, "SET LOCAL statement_timeout='3000ms'"); e != nil {
		tx.Rollback(ctx)
		return nil, e
	}
	return tx, nil
}
func usageRetainedFrom(ctx context.Context, tx pgx.Tx, tenant string) (time.Time, error) {
	var at time.Time
	e := tx.QueryRow(ctx, "SELECT COALESCE((SELECT retained_from FROM usage_retention_boundaries WHERE tenant_id=$1),'1970-01-01T00:00:00Z'::timestamptz)", tenant).Scan(&at)
	return at, e
}
func (a *App) registerUsageRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/tenants/{tenantId}/usage", a.tenant(a.tenantUsage, 3))
	mux.HandleFunc("GET /api/v1/tenants/{tenantId}/runs/{id}/invocations", a.tenant(a.runInvocations, 1))
	mux.HandleFunc("GET /api/v1/admin/observability/summary", a.admin(a.adminUsageSummary))
	mux.HandleFunc("GET /api/v1/admin/observability/invocations/{id}", a.admin(a.adminInvocation))
}

const usageAggregateProjection = `jsonb_build_object('group',jsonb_build_object('type',$5::text,'value',group_value),'currency',currency,'pricingVersion',pricing_version,
 'invocations',jsonb_build_object('completed',count(*) FILTER(WHERE status='completed')::text,'failed',count(*) FILTER(WHERE status='failed')::text,'cancelled',count(*) FILTER(WHERE status='cancelled')::text,'interrupted',count(*) FILTER(WHERE status='interrupted')::text),
 'usageSamples',jsonb_build_object('reported',count(*) FILTER(WHERE usage_status='reported')::text,'partial',count(*) FILTER(WHERE usage_status='partial')::text,'unavailable',count(*) FILTER(WHERE usage_status='unavailable')::text,'invalid',count(*) FILTER(WHERE usage_status='invalid')::text,'unknown',count(*) FILTER(WHERE usage_status='unknown')::text),
 'tokens',jsonb_build_object('input',sum(input_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::text,'output',sum(output_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::text,'cachedInput',sum(cached_input_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::text,'cacheWrite',sum(cache_write_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::text,'reasoning',sum(reasoning_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::text),
 'knownEstimatedCostMicrousd',sum(estimated_cost_microusd) FILTER(WHERE cost_status IN ('estimated','reconciled'))::text,
 'costSamples',jsonb_build_object('notIncurred',count(*) FILTER(WHERE cost_status='not_incurred')::text,'estimated',count(*) FILTER(WHERE cost_status='estimated')::text,'unavailable',count(*) FILTER(WHERE cost_status='unavailable')::text,'unknown',count(*) FILTER(WHERE cost_status='unknown')::text,'reconciled',count(*) FILTER(WHERE cost_status='reconciled')::text))`

func (a *App) tenantUsage(w http.ResponseWriter, r *http.Request) {
	from, to, ok := usageRange(w, r)
	if !ok {
		return
	}
	size, ok := usagePageSize(w, r)
	if !ok {
		return
	}
	group := r.URL.Query().Get("groupBy")
	groupSQL := map[string]string{"day": "to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD')", "agent": "COALESCE(agent_id,'')", "model": "runtime||':'||model_id", "runtime": "runtime"}[group]
	if groupSQL == "" || len(r.URL.Query()["groupBy"]) != 1 {
		usageFailure(w, r, 400, "invalid_group_by", "groupBy must be day, agent, model or runtime", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	tx, e := a.usageTransaction(ctx, false)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	defer tx.Rollback(ctx)
	retained, e := usageRetainedFrom(ctx, tx, r.PathValue("tenantId"))
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	if from.Before(retained) {
		usageFailure(w, r, 422, "range_not_retained", "Requested records are outside the retained range", map[string]any{"retainedFrom": retained})
		return
	}
	c := usageCursor{Version: 1, Kind: "aggregate", Actor: currentUser(r).ID, Tenant: r.PathValue("tenantId"), From: from.Format(time.RFC3339Nano), To: to.Format(time.RFC3339Nano), Group: group, Issued: time.Now().UTC(), Last: []string{"", "", ""}}
	if raw, provided := r.URL.Query()["cursor"]; provided {
		if len(raw) != 1 {
			usageFailure(w, r, 400, "invalid_cursor", "Invalid usage cursor", nil)
			return
		}
		c, e = a.parseUsageCursor(raw[0], c)
		if e != nil {
			usageFailure(w, r, 400, "invalid_cursor", "Invalid usage cursor", nil)
			return
		}
	} else {
		if e = tx.QueryRow(ctx, "SELECT clock_timestamp(),pg_current_snapshot()::text").Scan(&c.AsOf, &c.Snapshot); e != nil || len(c.Snapshot) > 8192 {
			usageUnavailable(w, r)
			return
		}
		if to.Before(c.AsOf) {
			c.AsOf = to
		}
	}
	sql := `WITH source AS (SELECT *,(` + groupSQL + `) COLLATE "C" AS group_value FROM model_invocations WHERE tenant_id=$1 AND completed_at >= $2 AND completed_at < $3 AND completed_at <= $4 AND status<>'running' AND pg_visible_in_snapshot(completed_xid,$10::pg_snapshot)), grouped AS (SELECT ` + usageAggregateProjection + ` AS item,group_value,currency COLLATE "C" AS currency,pricing_version COLLATE "C" AS pricing_version FROM source GROUP BY group_value,currency,pricing_version) SELECT item,group_value,currency,pricing_version FROM grouped WHERE (group_value,currency,pricing_version)>($6::text COLLATE "C",$7::text COLLATE "C",$8::text COLLATE "C") ORDER BY group_value,currency,pricing_version LIMIT $9`
	rows, e := tx.Query(ctx, sql, c.Tenant, from, to, c.AsOf, group, c.Last[0], c.Last[1], c.Last[2], size+1, c.Snapshot)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	items := []json.RawMessage{}
	more := false
	for rows.Next() {
		var item json.RawMessage
		last := make([]string, 3)
		if e = rows.Scan(&item, &last[0], &last[1], &last[2]); e != nil {
			break
		}
		if len(items) == size {
			more = true
			break
		}
		items = append(items, item)
		c.Last = last
	}
	rowErr := rows.Err()
	rows.Close()
	if e != nil || rowErr != nil {
		usageUnavailable(w, r)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		usageUnavailable(w, r)
		return
	}
	var next any
	if more {
		next = a.signUsageCursor(c)
	}
	writeJSON(w, 200, map[string]any{"items": items, "page": map[string]any{"nextCursor": next}, "freshness": map[string]any{"source": "ledger", "asOf": c.AsOf, "retainedFrom": retained, "completeForRequestedRange": true, "stale": false}})
}

const invocationPublicProjection = `jsonb_build_object('id',id,'runId',run_id,'turnId',turn_id,'agentId',agent_id,'runtime',runtime,'provider',provider,'modelId',model_id,'providerModel',provider_model,'protocol',protocol,'status',status,'admissionStatus',admission_status,'usageStatus',usage_status,'usageSource',usage_source,'usageReason',usage_reason,
 'usage',jsonb_build_object('inputTokens',input_tokens::text,'outputTokens',output_tokens::text,'cachedInputTokens',cached_input_tokens::text,'cacheWriteTokens',cache_write_tokens::text,'reasoningTokens',reasoning_tokens::text,'providerTotalTokens',provider_total_tokens::text,'computedTotalTokens',computed_total_tokens::text),
 'timingMs',jsonb_build_object('queue',queue_ms,'admission',admission_ms,'setup',setup_ms,'provider',provider_ms,'providerTtft',provider_ttft_ms,'workerTotal',worker_total_ms,'workerFirstDelta',worker_first_delta_ms),'failureClass',failure_class,'createdAt',created_at,'admittedAt',admitted_at,'completedAt',completed_at)`
const invocationCostProjection = `jsonb_build_object('costStatus',cost_status,'estimatedCostMicrousd',estimated_cost_microusd::text,'currency',currency,'pricingVersion',pricing_version,'priceSnapshot',price_snapshot)`

func (a *App) runInvocations(w http.ResponseWriter, r *http.Request) {
	size, ok := usagePageSize(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	tx, e := a.usageTransaction(ctx, false)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	defer tx.Rollback(ctx)
	tenant, run := r.PathValue("tenantId"), r.PathValue("id")
	var role string
	e = tx.QueryRow(ctx, `SELECT m.role FROM runs r JOIN memberships m ON m.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.id=$2 AND m.user_id=$3`, tenant, run, currentUser(r).ID).Scan(&role)
	if noRows(e) {
		usageFailure(w, r, 404, "not_found", "Run not found", nil)
		return
	}
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	c := usageCursor{Version: 1, Kind: "run", Actor: currentUser(r).ID, Tenant: tenant, Run: run, Issued: time.Now().UTC(), Last: []string{"1970-01-01T00:00:00Z", ""}}
	if raw, provided := r.URL.Query()["cursor"]; provided {
		if len(raw) != 1 {
			usageFailure(w, r, 400, "invalid_cursor", "Invalid usage cursor", nil)
			return
		}
		c, e = a.parseUsageCursor(raw[0], c)
		if e != nil {
			usageFailure(w, r, 400, "invalid_cursor", "Invalid usage cursor", nil)
			return
		}
	} else {
		if e = tx.QueryRow(ctx, "SELECT clock_timestamp(),pg_current_snapshot()::text").Scan(&c.AsOf, &c.Snapshot); e != nil || len(c.Snapshot) > 8192 {
			usageUnavailable(w, r)
			return
		}
	}
	lastTime, e := time.Parse(time.RFC3339Nano, c.Last[0])
	if e != nil || lastTime.After(c.AsOf) {
		usageFailure(w, r, 400, "invalid_cursor", "Invalid usage cursor", nil)
		return
	}
	projection := invocationPublicProjection
	if roleLevel(role) >= 3 {
		projection += " || " + invocationCostProjection
	}
	rows, e := tx.Query(ctx, "SELECT "+projection+",created_at,id FROM model_invocations WHERE tenant_id=$1 AND run_id=$2 AND created_at <= $3 AND (created_at,id)>($4,$5) AND pg_visible_in_snapshot(created_xid,$7::pg_snapshot) ORDER BY created_at,id LIMIT $6", tenant, run, c.AsOf, lastTime, c.Last[1], size+1, c.Snapshot)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	items := []json.RawMessage{}
	more := false
	for rows.Next() {
		var item json.RawMessage
		var at time.Time
		var id string
		if e = rows.Scan(&item, &at, &id); e != nil {
			break
		}
		if len(items) == size {
			more = true
			break
		}
		items = append(items, item)
		c.Last = []string{at.Format(time.RFC3339Nano), id}
	}
	rowErr := rows.Err()
	rows.Close()
	if e != nil || rowErr != nil {
		usageUnavailable(w, r)
		return
	}
	retained, e := usageRetainedFrom(ctx, tx, tenant)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		usageUnavailable(w, r)
		return
	}
	var next any
	if more {
		next = a.signUsageCursor(c)
	}
	writeJSON(w, 200, map[string]any{"items": items, "page": map[string]any{"nextCursor": next}, "freshness": map[string]any{"source": "ledger", "asOf": c.AsOf, "retainedFrom": retained}})
}
func (a *App) adminInvocation(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	tx, e := a.usageTransaction(ctx, true)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var item json.RawMessage
	var tenant string
	e = tx.QueryRow(ctx, "SELECT "+invocationPublicProjection+" || "+invocationCostProjection+",tenant_id FROM model_invocations WHERE id=$1", r.PathValue("id")).Scan(&item, &tenant)
	if noRows(e) {
		usageFailure(w, r, 404, "not_found", "Invocation not found", nil)
		return
	}
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	if e = audit(ctx, tx, currentUser(r).ID, tenant, "observability.invocation.read", r.PathValue("id")); e != nil {
		usageUnavailable(w, r)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		usageUnavailable(w, r)
		return
	}
	writeJSON(w, 200, map[string]any{"invocation": item})
}
func (a *App) adminUsageSummary(w http.ResponseWriter, r *http.Request) {
	to := time.Now().UTC()
	from := to.Add(-24 * time.Hour)
	if r.URL.Query().Has("from") || r.URL.Query().Has("to") {
		var ok bool
		from, to, ok = usageRange(w, r)
		if !ok {
			return
		}
	}
	tenant := r.URL.Query().Get("tenantId")
	if len(tenant) > 200 || len(r.URL.Query()["tenantId"]) > 1 {
		usageFailure(w, r, 400, "invalid_input", "Invalid tenant filter", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	tx, e := a.usageTransaction(ctx, tenant != "")
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var asOf time.Time
	if e = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&asOf); e != nil {
		usageUnavailable(w, r)
		return
	}
	if to.Before(asOf) {
		asOf = to
	}
	retained := time.Unix(0, 0).UTC()
	if tenant != "" {
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM tenants WHERE id=$1)", tenant).Scan(&exists); e != nil {
			usageUnavailable(w, r)
			return
		}
		if !exists {
			usageFailure(w, r, 404, "not_found", "Workspace not found", nil)
			return
		}
		retained, e = usageRetainedFrom(ctx, tx, tenant)
	} else {
		e = tx.QueryRow(ctx, "SELECT COALESCE(max(retained_from),'1970-01-01'::timestamptz) FROM usage_retention_boundaries").Scan(&retained)
	}
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	if from.Before(retained) {
		usageFailure(w, r, 422, "range_not_retained", "Requested records are outside the retained range", map[string]any{"retainedFrom": retained})
		return
	}
	item, e := oneJSON(ctx, tx, `SELECT jsonb_build_object('invocations',count(*)::text,'failed',count(*) FILTER(WHERE status IN ('failed','interrupted'))::text,'unknownUsage',count(*) FILTER(WHERE usage_status='unknown')::text,'errorRate',CASE WHEN count(*)=0 THEN NULL ELSE count(*) FILTER(WHERE status IN ('failed','interrupted'))::numeric/count(*) END,'meanProviderMs',avg(provider_ms),'meanProviderTtftMs',avg(provider_ttft_ms)) FROM model_invocations WHERE ($1::text='' OR tenant_id=$1) AND completed_at >= $2 AND completed_at < $3 AND completed_at <= $4 AND status<>'running'`, tenant, from, to, asOf)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	versions, e := oneJSON(ctx, tx, `SELECT COALESCE(jsonb_object_agg(version,samples),'{}'::jsonb) FROM (SELECT COALESCE(observability_version::text,'unavailable') AS version,count(*)::text AS samples FROM model_invocations WHERE ($1::text='' OR tenant_id=$1) AND completed_at >= $2 AND completed_at < $3 AND completed_at <= $4 AND status<>'running' GROUP BY observability_version) versions`, tenant, from, to, asOf)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	var summary map[string]json.RawMessage
	if json.Unmarshal(item, &summary) != nil {
		usageUnavailable(w, r)
		return
	}
	summary["protocolVersions"] = versions
	if tenant != "" {
		if e = audit(ctx, tx, currentUser(r).ID, tenant, "observability.summary.read", tenant); e != nil {
			usageUnavailable(w, r)
			return
		}
	}
	if e = tx.Commit(ctx); e != nil {
		usageUnavailable(w, r)
		return
	}
	writeJSON(w, 200, map[string]any{"summary": summary, "freshness": map[string]any{"source": "ledger", "asOf": asOf, "retainedFrom": retained, "stale": false}})
}
