package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestPostgresProfileAndInvitations(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, uid := h.register(t, "invite-owner@example.test")
	admin, other, aid := h.register(t, "invite-admin@example.test")
	member, _, mid := h.register(t, "invite-member@example.test")
	outsider, _, oid := h.register(t, "invite-outsider@example.test")
	p := "/tenants/" + tid
	h.request(t, nil, "PATCH", "/auth/profile", map[string]string{"name": "New"}, 401)
	for _, name := range []string{"  ", strings.Repeat("中", 121)} {
		requireCode(t, h.request(t, owner, "PATCH", "/auth/profile", map[string]string{"name": name}, 400), "invalid_input")
	}
	h.request(t, owner, "PATCH", "/auth/profile", map[string]string{"name": "New", "id": oid}, 400)
	h.request(t, owner, "PATCH", "/auth/profile", map[string]any{"name": "New", "isPlatformAdmin": true}, 400)
	v := h.request(t, owner, "PATCH", "/auth/profile", map[string]string{"name": "  新名字  "}, 200)
	if v["id"] != uid || v["name"] != "新名字" || v["email"] != "invite-owner@example.test" || v["isPlatformAdmin"] != false {
		t.Fatal(v)
	}
	if h.request(t, owner, "GET", "/auth/me", nil, 200)["user"].(map[string]any)["name"] != "新名字" {
		t.Fatal("profile not persisted")
	}
	if h.request(t, outsider, "GET", "/auth/me", nil, 200)["user"].(map[string]any)["name"] != "Test" {
		t.Fatal("another profile changed")
	}
	h.request(t, owner, "POST", p+"/members", map[string]string{"email": "invite-admin@example.test", "role": "admin"}, 201)
	h.request(t, owner, "POST", p+"/members", map[string]string{"email": "invite-member@example.test", "role": "reader"}, 201)
	h.request(t, outsider, "GET", p+"/invites", nil, 404)
	h.request(t, member, "GET", p+"/invites", nil, 403)
	h.request(t, member, "POST", p+"/invites", map[string]string{"role": "member"}, 403)
	for _, body := range []any{map[string]string{"role": "owner"}, map[string]any{"role": "member", "expiresInHours": 0}, map[string]any{"role": "member", "expiresInHours": 169}, map[string]any{"role": "member", "expiresInHours": 1.5}} {
		h.request(t, owner, "POST", p+"/invites", body, 400)
	}
	h.request(t, admin, "POST", p+"/invites", map[string]string{"role": "admin"}, 403)
	create := func(c *http.Cookie, role string) map[string]any {
		return h.request(t, c, "POST", p+"/invites", map[string]string{"role": role}, 201)
	}
	first := create(owner, "admin")
	token := first["token"].(string)
	id := first["id"].(string)
	if len(token) < 64 || first["inviteUrl"] != h.cfg.PublicOrigin+"/?invite="+token {
		t.Fatal("invalid invitation link")
	}
	var stored string
	var hours float64
	if e := h.db.QueryRow(ctx, "SELECT token_hash,extract(epoch FROM (expires_at-created_at))/3600 FROM tenant_invites WHERE id=$1", id).Scan(&stored, &hours); e != nil || stored != tokenHash(token) || stored == token || hours < 72 || hours > 72.01 {
		t.Fatalf("token/expiry invariant: %v", e)
	}
	raw, _ := json.Marshal(h.request(t, owner, "GET", p+"/invites", nil, 200))
	if strings.Contains(string(raw), token) || strings.Contains(string(raw), stored) || strings.Contains(string(raw), "token") {
		t.Fatal("list exposed invitation secret")
	}
	h.request(t, nil, "GET", "/invites/"+token, nil, 401)
	h.request(t, outsider, "GET", "/invites/not-a-valid-token", nil, 404)
	preview := h.request(t, outsider, "GET", "/invites/"+token, nil, 200)
	if preview["status"] != "active" || preview["tenantId"] != tid || preview["role"] != "admin" {
		t.Fatal(preview)
	}
	h.request(t, admin, "DELETE", p+"/invites/"+id, nil, 403)
	h.request(t, admin, "DELETE", "/tenants/"+other+"/invites/"+id, nil, 404)
	accepted := h.request(t, outsider, "POST", "/invites/"+token+"/accept", nil, 200)
	if accepted["role"] != "admin" {
		t.Fatal(accepted)
	}
	h.request(t, outsider, "POST", "/invites/"+token+"/accept", nil, 200)
	if _, e := h.db.Exec(ctx, "UPDATE tenant_invites SET expires_at=now()-interval '1 second' WHERE id=$1", id); e != nil {
		t.Fatal(e)
	}
	// An accepted invitation has finished its job; expiry cannot undo a claim.
	h.request(t, outsider, "POST", "/invites/"+token+"/accept", nil, 200)
	h.request(t, owner, "PATCH", p+"/members/"+oid, map[string]string{"role": "reader"}, 204)
	if h.request(t, outsider, "POST", "/invites/"+token+"/accept", nil, 200)["role"] != "reader" {
		t.Fatal("repeated claim restored an old privileged role")
	}
	requireCode(t, h.request(t, member, "POST", "/invites/"+token+"/accept", nil, 409), "invite_used")
	h.request(t, owner, "DELETE", p+"/invites/"+id, nil, 409)
	// Existing roles are never changed by claiming invitations, in either direction.
	for _, pair := range []struct {
		cookie     *http.Cookie
		role, want string
	}{{member, "admin", "reader"}, {owner, "reader", "owner"}, {admin, "reader", "admin"}} {
		invite := create(owner, pair.role)
		v = h.request(t, pair.cookie, "POST", "/invites/"+invite["token"].(string)+"/accept", nil, 200)
		if v["role"] != pair.want {
			t.Fatal("invitation changed existing membership", v)
		}
	}
	// A consumed token never recreates a subsequently removed membership.
	h.request(t, owner, "DELETE", p+"/members/"+oid, nil, 204)
	requireCode(t, h.request(t, outsider, "POST", "/invites/"+token+"/accept", nil, 409), "invite_membership_removed")
	for _, kind := range []string{"expired", "revoked"} {
		invite := create(admin, "member")
		invID := invite["id"].(string)
		invToken := invite["token"].(string)
		if kind == "expired" {
			if _, e := h.db.Exec(ctx, "UPDATE tenant_invites SET expires_at=now()-interval '1 second' WHERE id=$1", invID); e != nil {
				t.Fatal(e)
			}
		} else {
			h.request(t, admin, "DELETE", p+"/invites/"+invID, nil, 204)
			h.request(t, admin, "DELETE", p+"/invites/"+invID, nil, 204)
		}
		if h.request(t, outsider, "GET", "/invites/"+invToken, nil, 200)["status"] != kind {
			t.Fatal("incorrect invitation status")
		}
		requireCode(t, h.request(t, outsider, "POST", "/invites/"+invToken+"/accept", nil, 410), "invite_"+kind)
	}
	// Downgrade/removal of the issuer invalidates their unused authority.
	for _, remove := range []bool{false, true} {
		invite := create(admin, "member")
		if remove {
			h.request(t, owner, "DELETE", p+"/members/"+aid, nil, 204)
		} else {
			h.request(t, owner, "PATCH", p+"/members/"+aid, map[string]string{"role": "member"}, 204)
		}
		invToken := invite["token"].(string)
		if h.request(t, outsider, "GET", "/invites/"+invToken, nil, 200)["status"] != "unavailable" {
			t.Fatal("issuer revocation not reflected")
		}
		requireCode(t, h.request(t, outsider, "POST", "/invites/"+invToken+"/accept", nil, 403), "invite_unavailable")
		if !remove {
			h.request(t, owner, "PATCH", p+"/members/"+aid, map[string]string{"role": "admin"}, 204)
		}
	}
	platform := bootstrapTestAdmin(t, h)
	invite := create(owner, "member")
	invToken := invite["token"].(string)
	h.request(t, platform, "PATCH", "/admin/tenants/"+tid, map[string]string{"status": "suspended"}, 200)
	if h.request(t, outsider, "GET", "/invites/"+invToken, nil, 200)["status"] != "suspended" {
		t.Fatal("suspension preview missing")
	}
	requireCode(t, h.request(t, outsider, "POST", "/invites/"+invToken+"/accept", nil, 403), "tenant_suspended")
	h.request(t, owner, "POST", p+"/invites", map[string]string{"role": "reader"}, 403)
	var count int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action='profile.updated' AND actor_id=$1 AND resource_id=$1", uid).Scan(&count); e != nil || count != 1 {
		t.Fatal("missing profile audit", e, count)
	}
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action='invite.accepted' AND resource_id=$1", id).Scan(&count); e != nil || count != 1 {
		t.Fatal("duplicate or missing acceptance audit", e, count)
	}
	if e := h.db.QueryRow(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, mid).Scan(&stored); e != nil || stored != "reader" {
		t.Fatal("member role changed")
	}
}

func TestPostgresInvitationConcurrentConsumption(t *testing.T) {
	h := newHarness(t, "")
	owner, tid, _ := h.register(t, "concurrent-owner@example.test")
	first, _, _ := h.register(t, "concurrent-first@example.test")
	second, _, _ := h.register(t, "concurrent-second@example.test")
	create := func() string {
		return h.request(t, owner, "POST", "/tenants/"+tid+"/invites", map[string]string{"role": "member"}, 201)["token"].(string)
	}
	run := func(token string, cookies []*http.Cookie) []int {
		results := make(chan int, len(cookies))
		start := make(chan struct{})
		for _, cookie := range cookies {
			go func(c *http.Cookie) {
				<-start
				req, _ := http.NewRequest("POST", h.server.URL+"/api/v1/invites/"+token+"/accept", nil)
				req.AddCookie(c)
				req.Header.Set("Origin", h.cfg.PublicOrigin)
				res, e := http.DefaultClient.Do(req)
				if e != nil {
					results <- 0
					return
				}
				res.Body.Close()
				results <- res.StatusCode
			}(cookie)
		}
		close(start)
		statuses := []int{}
		for range cookies {
			statuses = append(statuses, <-results)
		}
		return statuses
	}
	result := run(create(), []*http.Cookie{first, second})
	if !((result[0] == 200 && result[1] == 409) || (result[0] == 409 && result[1] == 200)) {
		t.Fatal("invitation consumed by multiple identities", result)
	}
	token := create()
	result = run(token, []*http.Cookie{first, first, first, first, first, first, first, first})
	for _, status := range result {
		if status != 200 {
			t.Fatal("same consumer not idempotent", result)
		}
	}
	var count int
	if e := h.db.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE action='invite.accepted' AND resource_id=(SELECT id FROM tenant_invites WHERE token_hash=$1)", tokenHash(token)).Scan(&count); e != nil || count != 1 {
		t.Fatal("concurrent acceptance not atomic", e, count)
	}
}
