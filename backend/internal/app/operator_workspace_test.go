package app

import (
	"context"
	"fmt"
	"testing"
)

// The owner, 2026-10-12: 「我是管理员，不要对我有任何模型层面的限制，默认我是最高等级用户」 (operator_workspace.go).

func makePlatformAdmin(t *testing.T, h *harness, uid string) {
	t.Helper()
	if _, err := h.db.Exec(context.Background(), "UPDATE users SET platform_role='admin' WHERE id=$1", uid); err != nil {
		t.Fatal(err)
	}
}

func runLimits(t *testing.T, h *harness, tid string) string {
	t.Helper()
	var concurrent, daily int
	var restricted, routed bool
	if err := h.db.QueryRow(context.Background(), "SELECT max_concurrent_runs,max_runs_per_day,allowed_models IS NOT NULL,route_limits IS NOT NULL FROM tenants WHERE id=$1", tid).Scan(&concurrent, &daily, &restricted, &routed); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%d/%d models restricted=%v routes=%v", concurrent, daily, restricted, routed)
}

func TestPostgresOperatorWorkspaceIsOwnedByAPlatformAdministrator(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tid, uid := h.register(t, "operator-owner@example.test")
	_, other, memberID := h.register(t, "operator-member@example.test")
	h.request(t, owner, "POST", "/tenants/"+tid+"/members", map[string]string{"email": "operator-member@example.test", "role": "admin"}, 201)
	operator := func(tid string) bool {
		t.Helper()
		yes, err := operatorWorkspace(context.Background(), h.db, tid)
		if err != nil {
			t.Fatal(err)
		}
		return yes
	}
	if operator(tid) || operator(other) {
		t.Fatal("a workspace without a platform administrator counted as the operator's")
	}
	// A platform administrator who is only a member does not make the workspace theirs.
	makePlatformAdmin(t, h, memberID)
	if operator(tid) || !operator(other) {
		t.Fatal("membership, not ownership, decided", operator(tid), operator(other))
	}
	makePlatformAdmin(t, h, uid)
	if !operator(tid) {
		t.Fatal("the administrator's own workspace is not the operator's")
	}
}

func TestPostgresAdministratorWorkspaceStartsWithTheOperatorsLimits(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	loadWorkspaceSettings(t, h, "qwen3.8-27b-p6", "50", "")
	admin, _, adminID := h.register(t, "operator-admin@example.test")
	person, _, _ := h.register(t, "operator-person@example.test")
	makePlatformAdmin(t, h, adminID)
	mine := h.request(t, admin, "POST", "/tenants", map[string]string{"name": "Operator"}, 201)
	theirs := h.request(t, person, "POST", "/tenants", map[string]string{"name": "Person"}, 201)
	if got := runLimits(t, h, mine["id"].(string)); got != "100/100000 models restricted=false routes=false" {
		t.Fatal("an administrator's new workspace kept the deployment's defaults", got)
	}
	if got := workspaceRow(t, h, theirs["id"].(string)); got != "[qwen3.8-27b-p6] 50" {
		t.Fatal("another person's new workspace changed", got)
	}
}

func TestPostgresOperatorWorkspaceHasNoFreeMediaAllowanceToRunOutOf(t *testing.T) {
	h, rh := newMediaHarness(t)
	h.a.cfg.MediaUnrestrictedWorkspaces = true
	c, tid, uid := h.register(t, "operator-media@example.test")
	h.a.cfg.MediaRunsPerDay, h.a.cfg.MediaTotalRunsPerDay = 1, 500
	_, setup := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	img := setupNodeAt(setup, 0)["issueId"].(string)
	run := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "completed")
	if got := h.mediaRun(t, c, tid, img, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("the free daily limit did not hold an ordinary workspace", got)
	}
	makePlatformAdmin(t, h, uid)
	again := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, again["id"].(string), "completed")
	// The deployment-wide free ceiling does not stop it either, and still counts it.
	h.a.cfg.MediaTotalRunsPerDay = 1
	third := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, third["id"].(string), "completed")
	if submits, _ := rh.counts(); submits != 3 {
		t.Fatal("generations reaching the provider", submits)
	}
}
