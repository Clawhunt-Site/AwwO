package app

import (
	"encoding/json"
	"net/http"
)

func (a *App) adminSummary(w http.ResponseWriter, r *http.Request) {
	v, e := oneJSON(r.Context(), a.db, `SELECT jsonb_build_object('tenantCount',(SELECT count(*) FROM tenants),'userCount',(SELECT count(*) FROM users),'activeRuns',(SELECT count(*) FROM runs WHERE status IN ('queued','running')),'completedRuns',(SELECT count(*) FROM runs WHERE status='completed'),'failedRuns',(SELECT count(*) FROM runs WHERE status IN ('failed','interrupted')))`)
	a.replyOne(w, v, e, 200)
}
func (a *App) adminTenant(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Status     *string `json:"status"`
		Concurrent *int    `json:"maxConcurrentRuns"`
		Daily      *int    `json:"maxRunsPerDay"`
		// Raw JSON, because a *[]string cannot tell "field absent" from an explicit
		// null and the operator needs both: leave the entitlement alone versus
		// remove the restriction entirely.
		Allowed json.RawMessage `json:"allowedModels"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	next, setAllowed, allowedErr := normalizeAllowedModels(b.Allowed)
	if allowedErr != nil {
		fail(w, 400, "invalid_input", allowedErr.Error())
		return
	}
	if (b.Status == nil && b.Concurrent == nil && b.Daily == nil && !setAllowed) || (b.Status != nil && *b.Status != "active" && *b.Status != "suspended") || (b.Concurrent != nil && (*b.Concurrent < 1 || *b.Concurrent > 100)) || (b.Daily != nil && (*b.Daily < 1 || *b.Daily > 100000)) {
		fail(w, 400, "invalid_input", "Invalid tenant status or quota")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	id := r.PathValue("id")
	// COALESCE cannot express "set to NULL", so the flag decides whether the column
	// is written at all. Narrowing the entitlement deliberately cancels nothing:
	// every model decision is re-authorized against the live row at the next
	// admission, so a withdrawn model cannot be reached again, and revoking calls
	// already admitted under the previous entitlement is what suspension is for.
	v, e := oneJSON(r.Context(), tx, "UPDATE tenants t SET status=COALESCE($2,status),max_concurrent_runs=COALESCE($3,max_concurrent_runs),max_runs_per_day=COALESCE($4,max_runs_per_day),allowed_models=CASE WHEN $5 THEN $6::text[] ELSE allowed_models END WHERE id=$1 RETURNING "+adminTenantJSON, id, b.Status, b.Concurrent, b.Daily, setAllowed, next.column())
	if noRows(e) {
		fail(w, 404, "not_found", "Workspace not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	ids := []string{}
	if b.Status != nil && *b.Status == "suspended" {
		rows, e := tx.Query(r.Context(), "UPDATE runs SET status='cancelled',error='tenant_suspended',updated_at=now() WHERE tenant_id=$1 AND status IN ('queued','running') RETURNING id", id)
		if e != nil {
			a.dbError(w, e)
			return
		}
		for rows.Next() {
			var rid string
			if e = rows.Scan(&rid); e != nil {
				rows.Close()
				a.dbError(w, e)
				return
			}
			ids = append(ids, rid)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			a.dbError(w, e)
			return
		}
		for _, rid := range ids {
			data, _ := json.Marshal(map[string]string{"type": "cancelled", "code": "tenant_suspended"})
			if _, e = tx.Exec(r.Context(), "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", id, rid, data); e != nil {
				a.dbError(w, e)
				return
			}
		}
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, id, "tenant.updated", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	for _, rid := range ids {
		a.cancelExecution(rid)
	}
	writeJSON(w, 200, v)
}
