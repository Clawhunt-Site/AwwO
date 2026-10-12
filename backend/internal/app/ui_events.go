package app

import "net/http"

// A few canvas buttons the server cannot otherwise see used, so the operator can count them: the finished-run note's
// 「看下一步」 after a review did not pass, 「查看验收报告」 in the canvas assistant's next steps, and a question the
// assistant answered on the page instead of spending a call. Each press is one audit event on its canvas (action
// ui.<name>, resource the canvas id) with no content and no metadata. A second press of the same button by the same
// person on the same canvas within two seconds is the same press (a double click, a retry).
var uiEventActions = map[string]string{
	"review.next_steps":      "ui.review.next_steps",
	"review.open_report":     "ui.review.open_report",
	"assistant.local_answer": "ui.assistant.local_answer",
}

// recordUIEvent answers POST /tenants/{tenantId}/canvases/{id}/ui-events for a member: 200 {recorded} (false for a
// repeat within two seconds, or when the membership ended while the request was read), 400 for a name not listed
// above, 404 for a canvas outside the workspace.
func (a *App) recordUIEvent(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name string `json:"name"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	action, ok := uiEventActions[b.Name]
	if !ok {
		fail(w, 400, "invalid_event", "Unknown event name")
		return
	}
	tid, cid, uid := r.PathValue("tenantId"), r.PathValue("id"), currentUser(r).ID
	var exists bool
	if e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2)", tid, cid).Scan(&exists); e != nil {
		a.dbError(w, e)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	// Membership is checked again as the row is written, as other writes do once their body is read (a person
	// removed meanwhile records nothing), and the repeat check reads the last two seconds of the audit log through
	// its created_at index. No lock is taken: a press is not worth holding up the workspace for.
	tag, e := a.db.Exec(r.Context(), `INSERT INTO audit_events(actor_id,tenant_id,action,resource_id)
		SELECT $1::text,$2::text,$3::text,$4::text
		WHERE EXISTS (SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
		 WHERE m.tenant_id=$2::text AND m.user_id=$1::text AND m.role IN ('member','admin','owner') AND t.status='active')
		AND NOT EXISTS (SELECT 1 FROM audit_events
		 WHERE created_at>clock_timestamp()-interval '2 seconds' AND actor_id=$1::text AND action=$3::text AND resource_id=$4::text)`,
		uid, tid, action, cid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"recorded": tag.RowsAffected() == 1})
}
