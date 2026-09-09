package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type adminCursor struct {
	Version  int       `json:"v"`
	Kind     string    `json:"kind"`
	Actor    string    `json:"actor"`
	Snapshot time.Time `json:"snapshot"`
	LastTime time.Time `json:"lastTime"`
	LastID   string    `json:"lastId"`
}

func (a *App) encodeCursor(c adminCursor) string {
	b, _ := json.Marshal(c)
	m := hmac.New(sha256.New, a.cursorKey)
	m.Write(b)
	return base64.RawURLEncoding.EncodeToString(b) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
func (a *App) decodeCursor(raw, kind, actor string) (adminCursor, error) {
	var c adminCursor
	bad := errors.New("invalid pagination cursor")
	if len(raw) > 2048 {
		return c, bad
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return c, bad
	}
	b, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return c, bad
	}
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return c, bad
	}
	m := hmac.New(sha256.New, a.cursorKey)
	m.Write(b)
	if !hmac.Equal(sig, m.Sum(nil)) || json.Unmarshal(b, &c) != nil || c.Version != 1 || c.Kind != kind || c.Actor != actor || c.Snapshot.IsZero() || c.LastTime.IsZero() || c.LastTime.After(c.Snapshot) || c.LastID == "" || len(c.LastID) > 200 {
		return adminCursor{}, bad
	}
	return c, nil
}
func (a *App) adminList(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 200
		if raw, ok := r.URL.Query()["limit"]; ok {
			var e error
			if len(raw) != 1 {
				fail(w, 400, "invalid_pagination", "Limit must be an integer from 1 to 200")
				return
			}
			limit, e = strconv.Atoi(raw[0])
			if e != nil || limit < 1 || limit > 200 {
				fail(w, 400, "invalid_pagination", "Limit must be an integer from 1 to 200")
				return
			}
		}
		c := adminCursor{Version: 1, Kind: kind, Actor: currentUser(r).ID}
		raw, provided := r.URL.Query()["cursor"]
		if provided {
			if len(raw) != 1 || raw[0] == "" {
				fail(w, 400, "invalid_cursor", "Invalid pagination cursor; restart the listing")
				return
			}
			var e error
			c, e = a.decodeCursor(raw[0], kind, c.Actor)
			if e != nil {
				fail(w, 400, "invalid_cursor", "Invalid pagination cursor; restart the listing")
				return
			}
		} else {
			if e := a.db.QueryRow(r.Context(), "SELECT clock_timestamp()").Scan(&c.Snapshot); e != nil {
				a.dbError(w, e)
				return
			}
		}
		type source struct{ table, projection, id string }
		s := map[string]source{
			"tenants": {"tenants t", tenantJSON, "t.id"},
			"users":   {"users u", "jsonb_build_object('id',id,'email',email,'name',name,'platformRole',platform_role,'createdAt',created_at)", "u.id"},
			"runs":    {"runs r", runJSON, "r.id"},
			"audit":   {"audit_events a", "jsonb_build_object('id',id,'actorId',actor_id,'tenantId',tenant_id,'action',action,'resourceId',resource_id,'createdAt',created_at)", "a.id"},
		}[kind]
		// The immutable ordering pair prevents duplicate/omitted rows with equal
		// timestamps. The fixed boundary is an upper limit on created_at; an older
		// transaction that commits later can still become visible. Values are read
		// at each page's request time, not from a consistent archival DB snapshot.
		where := "created_at <= $1"
		args := []any{c.Snapshot}
		if provided {
			cast := "::text"
			if kind == "audit" {
				cast = "::bigint"
				if _, e := strconv.ParseInt(c.LastID, 10, 64); e != nil {
					fail(w, 400, "invalid_cursor", "Invalid pagination cursor")
					return
				}
			}
			where += " AND (created_at," + s.id + ") < ($2,$3" + cast + ")"
			args = append(args, c.LastTime, c.LastID)
		}
		args = append(args, limit+1)
		rows, e := a.db.Query(r.Context(), "SELECT "+s.projection+",created_at,"+s.id+"::text FROM "+s.table+" WHERE "+where+" ORDER BY created_at DESC,"+s.id+" DESC LIMIT $"+strconv.Itoa(len(args)), args...)
		if e != nil {
			a.dbError(w, e)
			return
		}
		defer rows.Close()
		items := []json.RawMessage{}
		more := false
		for rows.Next() {
			var v json.RawMessage
			var at time.Time
			var id string
			if e = rows.Scan(&v, &at, &id); e != nil {
				a.dbError(w, e)
				return
			}
			if len(items) == limit {
				more = true
				break
			}
			items = append(items, v)
			c.LastTime = at
			c.LastID = id
		}
		if e = rows.Err(); e != nil {
			a.dbError(w, e)
			return
		}
		var next any
		if more {
			next = a.encodeCursor(c)
		}
		writeJSON(w, 200, map[string]any{"items": items, "nextCursor": next, "snapshot": c.Snapshot})
	}
}
