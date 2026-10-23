package app

import (
	"context"
	"fmt"
	"testing"
	"time"
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

// AwwO 本地版 runs without AWWO_MEDIA_UNRESTRICTED_WORKSPACES: its owner gets the media models in their own workspaces
// because a platform administrator owns them (mediaEntitled). A node's own run and a canvas run admit a media node
// under an entitlement they build from the allowlist read with their quota row (workspaceEntitlement), so each must read
// the owner too, or the model the node was set up with is refused when it runs.
func TestPostgresOperatorsOwnWorkspaceRunsMediaWithoutTheSwitch(t *testing.T) {
	h, rh := newMediaHarness(t)
	h.a.cfg.MediaUnrestrictedWorkspaces = false
	c, tid, uid := h.register(t, "operator-media-switch@example.test")
	makePlatformAdmin(t, h, uid)
	base := "/tenants/" + tid
	nodes := []any{mediaDraftNode("send", "rh.seedream-v5-pro", "a cat in a hat"), mediaDraftNode("graph", "rh.seedream-v5-pro", "a dog in a boat")}
	v := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Operator media", "document": map[string]any{"nodes": nodes, "edges": []any{}}}, 201)
	cid := v["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	// The node's own run (createRun, then createMediaRun).
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "completed")
	// A canvas run (createGraphRun, then each child's admission, admitGraphChild).
	graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"], "scope": []string{"graph"}}, 202)
	awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "completed", 15*time.Second)
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("generations that reached the provider", submits)
	}
	// Another person's unrestricted workspace still needs the switch: to set a media node up, and to run one set up
	// while the switch was on, by its own run and by a canvas run.
	other, otherTid, _ := h.register(t, "operator-media-switch-other@example.test")
	otherBase := "/tenants/" + otherTid
	w := h.request(t, other, "POST", otherBase+"/canvases", map[string]any{"name": "Other media", "document": map[string]any{"nodes": nodes, "edges": []any{}}}, 201)
	if got := h.request(t, other, "POST", otherBase+"/canvases/"+w["id"].(string)+"/initialize", map[string]any{"documentVersion": 1}, 400); errorCode(got) != "invalid_node_setup" {
		t.Fatal("another person's workspace set up a media node without the switch", got)
	}
	h.a.cfg.MediaUnrestrictedWorkspaces = true
	otherCanvas := h.request(t, other, "POST", otherBase+"/canvases/"+w["id"].(string)+"/initialize", map[string]any{"documentVersion": 1}, 200)
	h.a.cfg.MediaUnrestrictedWorkspaces = false
	if got := h.mediaRun(t, other, otherTid, setupNodeAt(otherCanvas, 0)["issueId"].(string), "a cat in a hat", 403); errorCode(got) != "model_not_allowed" {
		t.Fatal("another person's workspace ran a media node without the switch", got)
	}
	if got := h.request(t, other, "POST", otherBase+"/canvases/"+w["id"].(string)+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": otherCanvas["version"], "scope": []string{"graph"}}, 403); errorCode(got) != "model_not_allowed" {
		t.Fatal("another person's workspace ran a canvas of media nodes without the switch", got)
	}
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("another person's refused runs reached the provider", submits)
	}
}
