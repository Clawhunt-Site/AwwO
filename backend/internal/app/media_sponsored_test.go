package app

import (
	"strings"
	"testing"
)

// The owner, 2026-11-11: two people the operator sponsors get the media in full, without a plan or a platform role
// (AWWO_MEDIA_SPONSORED_WORKSPACES, media_config.go).

func TestMediaSponsoredWorkspacesFromEnv(t *testing.T) {
	t.Setenv("AWWO_MEDIA_SPONSORED_WORKSPACES", " t1 , t2,,")
	c := testConfig()
	if err := c.mediaFromEnv(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(c.MediaSponsoredWorkspaces, ",") != "t1,t2" || !c.mediaSponsored("t2") || c.mediaSponsored("t3") || c.mediaSponsored("") {
		t.Fatal("the list as read", c.MediaSponsoredWorkspaces)
	}
	t.Setenv("AWWO_MEDIA_SPONSORED_WORKSPACES", "")
	if err := c.mediaFromEnv(); err != nil || len(c.MediaSponsoredWorkspaces) != 0 || c.mediaSponsored("t1") {
		t.Fatal("an empty list kept workspaces", c.MediaSponsoredWorkspaces, err)
	}
	for _, bad := range []string{"t1,not a workspace", "t1;t2", strings.Repeat("a", 129)} {
		t.Setenv("AWWO_MEDIA_SPONSORED_WORKSPACES", bad)
		if c.mediaFromEnv() == nil {
			t.Fatal("a list that does not parse was accepted", bad)
		}
	}
	many := make([]string, 65)
	for i := range many {
		many[i] = "w" + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	t.Setenv("AWWO_MEDIA_SPONSORED_WORKSPACES", strings.Join(many, ","))
	if c.mediaFromEnv() == nil {
		t.Fatal("more than 64 workspaces were accepted")
	}
	t.Setenv("AWWO_MEDIA_SPONSORED_WORKSPACES", strings.Join(many[:64], ","))
	if err := c.mediaFromEnv(); err != nil || len(c.MediaSponsoredWorkspaces) != 64 {
		t.Fatal("64 workspaces were refused", err)
	}
}

func mediaRunsPerDayShown(t *testing.T, catalogue map[string]any) float64 {
	t.Helper()
	limits, ok := catalogue["limits"].(map[string]any)
	if !ok {
		t.Fatal("no limits in the media catalogue", catalogue)
	}
	n, ok := limits["runsPerDay"].(float64)
	if !ok {
		t.Fatal("no runsPerDay in the media catalogue", limits)
	}
	return n
}

func TestPostgresSponsoredWorkspaceHasNoFreeMediaAllowanceToRunOutOf(t *testing.T) {
	h, rh := newMediaHarness(t)
	h.a.cfg.MediaUnrestrictedWorkspaces = true
	c, tid, _ := h.register(t, "sponsored-media@example.test")
	other, otherTid, _ := h.register(t, "sponsored-media-other@example.test")
	h.a.cfg.MediaRunsPerDay, h.a.cfg.MediaTotalRunsPerDay = 1, 500
	_, setup := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	img := setupNodeAt(setup, 0)["issueId"].(string)
	run := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, run["id"].(string), "completed")
	if got := h.mediaRun(t, c, tid, img, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("the free daily limit did not hold a workspace before it was sponsored", got)
	}
	if got := mediaRunsPerDayShown(t, h.request(t, c, "GET", "/tenants/"+tid+"/media", nil, 200)); got != 1 {
		t.Fatal("the daily limit shown before the workspace was sponsored", got)
	}
	h.a.cfg.MediaSponsoredWorkspaces = []string{tid}
	again := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, again["id"].(string), "completed")
	// The deployment-wide free ceiling does not stop it either, and still counts it.
	h.a.cfg.MediaTotalRunsPerDay = 2
	third := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
	awaitRunRow(t, h, tid, third["id"].(string), "completed")
	if got := mediaRunsPerDayShown(t, h.request(t, c, "GET", "/tenants/"+tid+"/media", nil, 200)); got != 0 {
		t.Fatal("a sponsored workspace is shown a daily limit", got)
	}
	// Another workspace keeps both limits, and the sponsored generations count towards the deployment's.
	if got := mediaRunsPerDayShown(t, h.request(t, other, "GET", "/tenants/"+otherTid+"/media", nil, 200)); got != 1 {
		t.Fatal("another workspace's daily limit shown", got)
	}
	_, otherSetup := mediaCanvas(t, h, other, otherTid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	otherImg := setupNodeAt(otherSetup, 0)["issueId"].(string)
	if got := h.mediaRun(t, other, otherTid, otherImg, "a dog in a boat", 429); errorCode(got) != "media_capacity_exceeded" {
		t.Fatal("the deployment-wide ceiling did not count the sponsored generations", got)
	}
	h.a.cfg.MediaTotalRunsPerDay = 500
	first := h.mediaRun(t, other, otherTid, otherImg, "a dog in a boat", 202)
	awaitRunRow(t, h, otherTid, first["id"].(string), "completed")
	if got := h.mediaRun(t, other, otherTid, otherImg, "a dog in a boat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("the free daily limit did not hold another workspace", got)
	}
	// Sponsoring one workspace leaves the list's others alone, and an empty list sponsors none.
	h.a.cfg.MediaSponsoredWorkspaces = nil
	if got := h.mediaRun(t, c, tid, img, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("a workspace taken off the list kept no limit", got)
	}
	if submits, _ := rh.counts(); submits != 4 {
		t.Fatal("generations reaching the provider", submits)
	}
}

// The setting lifts the free allowance, not a limit an administrator set on the workspace: its own media route limit
// still holds a sponsored workspace, and a sponsored workspace that limits no route is not held by the free one.
func TestPostgresSponsoredWorkspaceKeepsItsOwnRouteLimits(t *testing.T) {
	h, rh := newMediaHarness(t)
	h.a.cfg.MediaUnrestrictedWorkspaces = true
	c, tid, _ := h.register(t, "sponsored-media-routes@example.test")
	h.a.cfg.MediaRunsPerDay, h.a.cfg.MediaTotalRunsPerDay = 1, 500
	h.a.cfg.MediaSponsoredWorkspaces = []string{tid}
	if _, e := h.db.Exec(t.Context(), `UPDATE tenants SET route_limits='{"media":2}'::jsonb WHERE id=$1`, tid); e != nil {
		t.Fatal(e)
	}
	_, setup := mediaCanvas(t, h, c, tid, mediaNode("img", "image", "rh.seedream-v5-pro", nil))
	img := setupNodeAt(setup, 0)["issueId"].(string)
	for i := 0; i < 2; i++ {
		run := h.mediaRun(t, c, tid, img, "a cat in a hat", 202)
		awaitRunRow(t, h, tid, run["id"].(string), "completed")
	}
	if got := h.mediaRun(t, c, tid, img, "a cat in a hat", 429); errorCode(got) != "media_quota_exceeded" {
		t.Fatal("a sponsored workspace passed its own media route limit", got)
	}
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("generations reaching the provider", submits)
	}
}

func TestPostgresSponsoredWorkspaceRigsAndPassesTheFree3DCaps(t *testing.T) {
	h, _ := newMediaHarness(t)
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "tripo-sponsored@example.test")
	h.a.cfg.TripoFreeRunsPerDay = 1
	_, canvas := mediaCanvas(t, h, c, tid,
		motionNode("hero", "tripo.v3-1", map[string]any{"rig": "biped", "motion": "combat"}),
		motionNode("statue", "tripo.v3-1", map[string]any{}))
	hero, statue := setupNodeAt(canvas, 0)["issueId"].(string), setupNodeAt(canvas, 1)["issueId"].(string)
	if got := h.mediaRun(t, c, tid, hero, "a knight in armour", 402); errorCode(got) != "model3d_motion_plan_required" {
		t.Fatal("a free workspace rigged a model", got)
	}
	run := h.mediaRun(t, c, tid, statue, "a stone statue", 202)
	if status, code := awaitRunRow(t, h, tid, run["id"].(string), "completed", "failed"); status != "completed" {
		t.Fatal("the free statue", status, code)
	}
	if got := h.mediaRun(t, c, tid, statue, "a stone statue", 429); errorCode(got) != "model3d_quota_exceeded" {
		t.Fatal("the free 3D cap did not hold a workspace before it was sponsored", got)
	}
	before := len(f.paths())
	h.a.cfg.MediaSponsoredWorkspaces = []string{tid}
	again := h.mediaRun(t, c, tid, statue, "a stone statue", 202)
	if status, code := awaitRunRow(t, h, tid, again["id"].(string), "completed", "failed"); status != "completed" {
		t.Fatal("a sponsored workspace's statue past the free 3D cap", status, code)
	}
	rigged := h.mediaRun(t, c, tid, hero, "a knight in armour", 202)
	if status, code := awaitRunRow(t, h, tid, rigged["id"].(string), "completed", "failed"); status != "completed" {
		t.Fatal("a sponsored workspace's rigged and animated model", status, code)
	}
	if !slicesContainsPath(f.paths()[before:], "/animations/rig") {
		t.Fatal("the sponsored rig never reached Tripo", f.paths()[before:])
	}
}
