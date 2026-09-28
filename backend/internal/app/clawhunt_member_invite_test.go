package app

import (
	"context"
	"testing"
)

func TestPostgresClawHuntEmailCannotGrantMembershipButInviteCan(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	f := newIdentityFixture(t, h, "unverified-target@example.invalid", "target-subject")
	// The main site truthfully marks this address unverified. It is still a
	// valid subject for SSO, but its email cannot be trusted as an invitation.
	if f.id.EmailVerified {
		t.Fatal("fixture must exercise an unverified email")
	}
	target := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	targetUser := h.request(t, target, "GET", "/auth/me", nil, 200)["user"].(map[string]any)
	targetID := targetUser["id"].(string)

	f.id.Subject = "owner-subject"
	f.id.Email = "sso-owner@example.invalid"
	owner := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	ownerMe := h.request(t, owner, "GET", "/auth/me", nil, 200)
	tenantID := ownerMe["tenants"].([]any)[0].(map[string]any)["id"].(string)
	prefix := "/tenants/" + tenantID

	denied := h.request(t, owner, "POST", prefix+"/members", map[string]string{
		"email": "unverified-target@example.invalid", "role": "admin",
	}, 403)
	requireCode(t, denied, "clawhunt_invite_required")
	var memberships int
	if err := h.db.QueryRow(context.Background(),
		"SELECT count(*) FROM memberships WHERE tenant_id=$1 AND user_id=$2",
		tenantID, targetID).Scan(&memberships); err != nil || memberships != 0 {
		t.Fatalf("email direct-add created membership: count=%d err=%v", memberships, err)
	}

	issued := h.request(t, owner, "POST", prefix+"/invites", map[string]string{"role": "admin"}, 201)
	token := issued["token"].(string)
	if token == "" {
		t.Fatal("missing one-time invitation")
	}
	f.id.Subject = "target-subject"
	f.id.Email = "unverified-target@example.invalid"
	preview := h.request(t, target, "GET", "/invites/"+token, nil, 200)
	if preview["tenantId"] != tenantID || preview["status"] != "active" {
		t.Fatal("invitation not available to the intended signed-in subject", preview)
	}
	accepted := h.request(t, target, "POST", "/invites/"+token+"/accept", nil, 200)
	if accepted["tenantId"] != tenantID || accepted["role"] != "admin" {
		t.Fatal("explicit invitation did not grant the selected role", accepted)
	}
	var role string
	if err := h.db.QueryRow(context.Background(),
		"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2",
		tenantID, targetID).Scan(&role); err != nil || role != "admin" {
		t.Fatalf("invitation membership missing: role=%q err=%v", role, err)
	}
}
