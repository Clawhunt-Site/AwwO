package app

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type tenantPageSource struct {
	table, projection, tenant, timestamp, id, predicate string
	filters                                             []string
}

// Ordinary lists use immutable creation order. In particular, updating a canvas
// must not move it across the cursor and hide or repeat it in a later page.
func (a *App) tenantList(w http.ResponseWriter, r *http.Request, kind string) {
	s := map[string]tenantPageSource{
		"members":  {"memberships m JOIN users u ON u.id=m.user_id", "jsonb_build_object('id',u.id,'userId',u.id,'email',u.email,'name',u.name,'role',m.role)", "m.tenant_id", "m.created_at", "m.user_id", "", nil},
		"canvases": {"canvases", canvasJSON, "tenant_id", "created_at", "id", "", nil},
		"agents":   {"agents", agentJSON, "tenant_id", "created_at", "id", "NOT internal", nil},
		"sessions": {"node_sessions", sessionJSON, "tenant_id", "created_at", "id", "kind='node'", []string{"canvasId", "sessionId"}},
		"runs":     {"runs", runJSON, "tenant_id", "created_at", "id", "", []string{"sessionId", "operationId", "active"}},
		"invites":  {"tenant_invites i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN memberships m ON m.tenant_id=i.tenant_id AND m.user_id=i.created_by", "jsonb_build_object('id',i.id,'role',i.role,'createdBy',i.created_by,'createdAt',i.created_at,'expiresAt',i.expires_at,'status'," + inviteStatusSQL + ",'acceptedBy',i.accepted_by,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at)", "i.tenant_id", "i.created_at", "i.id", "", nil},
	}[kind]
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		fail(w, 400, "invalid_pagination", "Invalid list query")
		return
	}
	limit := 200
	if values, present := query["limit"]; present {
		var err error
		if len(values) == 1 {
			limit, err = strconv.Atoi(values[0])
		}
		if len(values) != 1 || err != nil || limit < 1 || limit > 200 {
			fail(w, 400, "invalid_pagination", "Limit must be an integer from 1 to 200")
			return
		}
	}
	filters := make([]string, len(s.filters))
	for i, name := range s.filters {
		values := query[name]
		if len(values) > 1 || (len(values) == 1 && (len(values[0]) > 200 || !utf8.ValidString(values[0]) || strings.ContainsRune(values[0], 0))) {
			fail(w, 400, "invalid_pagination", "Invalid list filter")
			return
		}
		filters[i] = query.Get(name)
		if name == "active" && len(values) == 1 {
			if values[0] != "true" && values[0] != "false" {
				fail(w, 400, "invalid_pagination", "Active filter must be true or false")
				return
			}
			if values[0] == "false" {
				filters[i] = ""
			}
		}
	}
	// Reuse the administrator cursor signature and actor binding, with a distinct
	// namespace that also binds tenant, resource and normalized filter values.
	// Changing a page size is safe; changing the set being traversed is not.
	tid := r.PathValue("tenantId")
	scope, _ := json.Marshal(struct {
		Tenant  string
		Filters []string
	}{tid, filters})
	cursorKind := "tenant:" + kind + ":" + tokenHash(string(scope))
	c := adminCursor{Version: 1, Kind: cursorKind, Actor: currentUser(r).ID}
	values, provided := query["cursor"]
	if provided {
		if len(values) != 1 || values[0] == "" {
			fail(w, 400, "invalid_cursor", "Invalid pagination cursor; restart the listing")
			return
		}
		var err error
		c, err = a.decodeCursor(values[0], cursorKind, c.Actor)
		if err != nil {
			fail(w, 400, "invalid_cursor", "Invalid pagination cursor; restart the listing")
			return
		}
	} else if err := a.db.QueryRow(r.Context(), "SELECT clock_timestamp()").Scan(&c.Snapshot); err != nil {
		a.dbError(w, err)
		return
	}
	// As in admin pagination, this is a creation-time boundary, not an archival
	// transaction snapshot: late commits of older transactions may become visible.
	where := s.tenant + "=$1 AND " + s.timestamp + " <= $2"
	args := []any{tid, c.Snapshot}
	if s.predicate != "" {
		where += " AND " + s.predicate
	}
	columns := map[string]string{"canvasId": "canvas_id", "sessionId": "session_id", "operationId": "operation_id"}
	if kind == "sessions" {
		columns["sessionId"] = "id"
	}
	for i, value := range filters {
		if value != "" {
			if s.filters[i] == "active" {
				where += " AND status IN ('queued','running')"
				continue
			}
			args = append(args, value)
			where += " AND " + columns[s.filters[i]] + "=$" + strconv.Itoa(len(args))
		}
	}
	if provided {
		args = append(args, c.LastTime, c.LastID)
		where += " AND (" + s.timestamp + "," + s.id + ") < ($" + strconv.Itoa(len(args)-1) + ",$" + strconv.Itoa(len(args)) + ")"
	}
	args = append(args, limit+1)
	rows, err := a.db.Query(r.Context(), "SELECT "+s.projection+","+s.timestamp+","+s.id+" FROM "+s.table+" WHERE "+where+" ORDER BY "+s.timestamp+" DESC,"+s.id+" DESC LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer rows.Close()
	items := []json.RawMessage{}
	more := false
	for rows.Next() {
		var item json.RawMessage
		var at time.Time
		var id string
		if err = rows.Scan(&item, &at, &id); err != nil {
			a.dbError(w, err)
			return
		}
		if len(items) == limit {
			more = true
			break
		}
		items = append(items, item)
		c.LastTime, c.LastID = at, id
	}
	if err = rows.Err(); err != nil {
		a.dbError(w, err)
		return
	}
	var next any
	if more {
		next = a.encodeCursor(c)
	}
	writeJSON(w, 200, map[string]any{"items": items, "nextCursor": next, "snapshot": c.Snapshot})
}
