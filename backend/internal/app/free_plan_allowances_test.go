package app

import (
	"context"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// After the free plan's end a workspace it holds has no free allowance of any kind (owner 2026-11-11: 「明天暂停试用后，
// 所有用户都必须要购买才能使用awwo，没有任何免费额度」): the two daily allowances that call no model, a render as video and a
// web page read into its knowledge, are refused with 402 free_plan_ended, and nothing is recorded, counted, sent to the
// render worker or fetched for the refusal. Before the end both work; an operation answered before the end still
// answers from its stored result after it; a plan's workspace, the operator's own and one without route limits render
// and read as before; and a subscription that lands opens the workspace at once.
func TestPostgresFreePlanEndClosesRendersAndWebReads(t *testing.T) {
	webSite(t)
	renderer := newFakeRenderer(t)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.RenderURL, h.a.cfg.RenderToken, h.a.cfg.MediaDir = renderer.server.URL, strings.Repeat("r", 32), t.TempDir()
	h.a.cfg.RendersPerDay, h.a.cfg.RendersSitePerDay, h.a.cfg.RenderTimeout = 5, 100, 30*time.Second
	h.a.cfg.MediaMinFreeBytes = 0
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	type space struct {
		c        *http.Cookie
		tid, cid string
	}
	workspace := func(email, routes string) (space, string) {
		c, tid, uid := h.register(t, email)
		execSQL(t, h, "UPDATE tenants SET route_limits=$2::jsonb WHERE id=$1", tid, nullIfEmpty(routes))
		cid, _, _ := h.fixture(t, c, tid)
		return space{c, tid, cid}, uid
	}
	renders := func(s space) string { return "/tenants/" + s.tid + "/canvases/" + s.cid + "/renders" }
	reads := func(s space) string { return "/tenants/" + s.tid + "/knowledge/sources/web" }
	render := func(op string) map[string]any {
		return map[string]any{"operationId": op, "nodeId": "node-a", "html": renderPage, "width": 320, "height": 180, "fps": 12, "seconds": 2}
	}
	read := func(op string) map[string]any {
		return map[string]any{"url": "http://site.test/article?for=" + op, "operationId": op}
	}
	// Both allowances work in s: a render runs to its end (a workspace renders one video at a time), a page is read.
	// readStatus: 201 for a workspace's first read of the page, 200 for a later one (the same text is kept once).
	works := func(name string, s space, op string, readStatus int) (renderID, sourceID string) {
		t.Helper()
		job := h.request(t, s.c, "POST", renders(s), render(op+"-render"), 202)
		awaitRender(t, h, s.c, renders(s)+"/"+job["id"].(string), "completed")
		source := h.request(t, s.c, "POST", reads(s), read(op+"-read"), readStatus)
		if id, _ := source["id"].(string); id == "" {
			t.Fatal(name, source)
		}
		return job["id"].(string), source["id"].(string)
	}
	counts := func(s space) [2]int {
		t.Helper()
		var n [2]int
		if e := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM render_jobs WHERE tenant_id=$1),(SELECT count(*) FROM web_reads WHERE tenant_id=$1)", s.tid).Scan(&n[0], &n[1]); e != nil {
			t.Fatal(e)
		}
		return n
	}

	free, _ := workspace("free-allowance-free@example.test", `{"media":1}`)
	paid, _ := workspace("free-allowance-paid@example.test", planRoutes)
	now := time.Now()
	givePlan(t, h, "free-allowance-paid@example.test", "max", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 10000)
	operator, operatorUser := workspace("free-allowance-operator@example.test", `{"media":1}`)
	makeAdmin(t, h, operatorUser)
	unlimited, _ := workspace("free-allowance-unlimited@example.test", "")

	// Before the end the free workspace renders and reads.
	h.a.cfg.FreePlanUntil = time.Now().Add(time.Hour)
	renderID, sourceID := works("a free workspace before the end", free, "trial", 201)

	// After it, a new render and a new read are refused, and nothing is recorded, counted, sent or fetched for them.
	h.a.cfg.FreePlanUntil = time.Now().Add(-time.Minute)
	before, sent := counts(free), renderer.calls.Load()
	for name, refused := range map[string]map[string]any{
		"a render": h.request(t, free.c, "POST", renders(free), render("ended-render"), 402),
		"a read":   h.request(t, free.c, "POST", reads(free), read("ended-read"), 402),
	} {
		if errorCode(refused) != "free_plan_ended" {
			t.Fatal(name, refused)
		}
	}
	if after := counts(free); after != before || renderer.calls.Load() != sent {
		t.Fatal("a refused render or read was recorded, counted or sent", before, after, sent, renderer.calls.Load())
	}
	// What it started before the end still answers from its stored result, and is neither rendered nor read again.
	if replay := h.request(t, free.c, "POST", renders(free), render("trial-render"), 200); replay["id"] != renderID {
		t.Fatal("the earlier render's replay", replay)
	}
	if replay := h.request(t, free.c, "POST", reads(free), read("trial-read"), 201); replay["id"] != sourceID {
		t.Fatal("the earlier read's replay", replay)
	}
	if after := counts(free); after != before || renderer.calls.Load() != sent {
		t.Fatal("a replay was recorded, counted or sent", before, after, sent, renderer.calls.Load())
	}
	// The workspace's capabilities read both daily numbers as 0, so its panels offer nothing they would refuse; a
	// plan's workspace reads the deployment's numbers, as the free one did before the end.
	perDay := func(s space) [2]any {
		t.Helper()
		v := h.request(t, s.c, "GET", "/tenants/"+s.tid+"/capabilities", nil, 200)
		return [2]any{v["webReader"].(map[string]any)["perDay"], v["render"].(map[string]any)["perDay"]}
	}
	if got := perDay(free); got != [2]any{float64(0), float64(0)} {
		t.Fatal("the held workspace's daily numbers", got)
	}
	if got := perDay(paid); got != [2]any{float64(5), float64(5)} {
		t.Fatal("a plan's workspace's daily numbers", got)
	}
	h.a.cfg.FreePlanUntil = time.Now().Add(time.Hour)
	if got := perDay(free); got != [2]any{float64(5), float64(5)} {
		t.Fatal("the free workspace's daily numbers before the end", got)
	}
	h.a.cfg.FreePlanUntil = time.Now().Add(-time.Minute)
	// Its own renders and sources stay readable: the end closes new work, not what the workspace holds.
	if job := h.request(t, free.c, "GET", renders(free)+"/"+renderID, nil, 200); job["status"] != "completed" {
		t.Fatal("the earlier render", job)
	}
	// A plan's workspace, the operator's own and one without route limits render and read as before.
	for name, s := range map[string]space{"a plan's": paid, "the operator's": operator, "an unlimited": unlimited} {
		works(name, s, "ended", 201)
	}
	// A subscription that lands opens the workspace at its next request.
	givePlan(t, h, "free-allowance-free@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	execSQL(t, h, "UPDATE tenants SET route_limits=$2::jsonb WHERE id=$1", free.tid, planRoutes)
	works("the free workspace once its owner subscribes", free, "subscribed", 200)
}

// GET /billing says when the deployment's free plan ends and whether it has, by the API's clock, to every account (the
// plans page stops describing a trial that is over); nothing where the free plan does not end.
func TestPostgresBillingSaysWhenTheFreePlanEnds(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	c, _, _ := h.register(t, "billing-free-plan@example.test")
	if out := h.request(t, c, "GET", "/billing", nil, 200); out["freePlan"] != nil {
		t.Fatal("unset", out["freePlan"])
	}
	for _, until := range []time.Time{time.Now().Add(time.Hour), time.Now().Add(-time.Minute)} {
		h.a.cfg.FreePlanUntil = until
		want := map[string]any{"until": until.UTC().Format(time.RFC3339Nano), "ended": !time.Now().Before(until)}
		if got := h.request(t, c, "GET", "/billing", nil, 200)["freePlan"]; !reflect.DeepEqual(got, want) {
			t.Fatal(got, want)
		}
	}
}
