package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestRuleRouteOnlyEverPlansAnExplicitCanvasEdit(t *testing.T) {
	both := []string{routePlan, routeExecute}
	for _, c := range []struct {
		message string
		route   string
	}{
		// A canvas edit in so many words, with no negation in the message, is planned without a model call.
		{"在画布上加一个审核节点", routePlan},
		{"帮我直接在画布上加一个节点", routePlan},
		{"直接帮我加一个审核节点", routePlan},
		{"编排画布：做一个电商落地页", routePlan},
		{"调整一下画布，把设计和文案并行", routePlan},
		{"删除两个节点", routePlan},
		{"把设计节点连到文案节点", routePlan},
		{"Rearrange the canvas so research runs first", routePlan},
		{"Add a new node for QA", routePlan},
		{"connect the nodes in order", routePlan},
		// Execution is never decided by wording: every one of these is the model's to read.
		{"直接执行：写一封给客户的道歉邮件", ""},
		{"不用编排，直接帮我写一份周报", ""},
		{"不要改画布，把成果翻译成英文", ""},
		{"别动画布，先帮我总结一下", ""},
		{"不要调整画布，直接把成果翻译成英文", ""},
		{"Summarize the results, but don't touch the canvas", ""},
		{"Just write the release notes for this week", ""},
		{"马上帮我做一份周报", ""},
		// A negation anywhere makes the wording the model's: it so often turns a phrase into its opposite.
		{"先别直接执行，告诉我你打算怎么做", ""},
		{"不要直接执行，先说说思路", ""},
		{"Please don't do it directly; explain your plan first", ""},
		{"请分别调整画布上的设计和文案两个节点", ""},
		{"分别编排设计和文案两个团队", ""},
		{"这次特别编排一个审核流程", ""},
		{"不要编排太多节点，两个就够", ""},
		{"不用编排得太复杂，搭两个节点就行", ""},
		{"不要修改画布上已有的节点，再加一个审核节点", ""},
		{"Don't change the canvas layout, just add a review node", ""},
		// A request that names neither way, and the ordinary words of a task, are left to the model too.
		{"直接帮我规划一个营销工作流", ""},
		{"直接帮我搭一个写小红书文案的团队", ""},
		{"Just make a workflow with three agents", ""},
		{"好的，直接执行吧", ""},
		{"写一份流程图", ""},
		{"列出项目的关键节点", ""},
		{"做一个电商落地页", ""},
		{"帮我调研一下竞品", ""},
		{"Translate the onboarding page", ""},
	} {
		route, ok := ruleRoute(c.message, both)
		if (c.route == "") == ok || (ok && route != c.route) {
			t.Errorf("%q: got %q %v, want %q", c.message, route, ok, c.route)
		}
	}
	// A rule never chooses a way the client cannot carry out.
	if _, ok := ruleRoute("在画布上加一个节点", []string{routeExecute}); ok {
		t.Fatal("rule chose planning where only execution is available")
	}
}

func TestParseRouteReply(t *testing.T) {
	for _, c := range []struct {
		text  string
		route string
	}{
		{`{"route":"execute"}`, routeExecute},
		{"```json\n{\"route\": \"plan\"}\n```", routePlan},
		{`<think>The user wants it done, so execute.</think>{"route":"plan"}`, routePlan},
		{"plan", routePlan},
		{" Execute. ", routeExecute},
		{"I think plan is best", ""},
		{`{"route":"both"}`, ""},
		{"", ""},
	} {
		route, ok := parseRouteReply(c.text)
		if (c.route == "") == ok || route != c.route {
			t.Errorf("%q: got %q %v, want %q", c.text, route, ok, c.route)
		}
	}
}

func validRouteInput() assistantRouteInput {
	return assistantRouteInput{Message: "做一个电商落地页", Routes: []string{routePlan, routeExecute},
		Canvas: assistantCanvasFacts{Nodes: 2, Titles: []string{"设计", "文案"}, Results: true},
		Recent: []assistantRouteTurn{{Role: "user", Route: routePlan, Text: "先搭一个团队"}, {Role: "assistant", Route: routePlan, Text: "加了两个节点"}}}
}

func TestAssistantRouteInputBounds(t *testing.T) {
	if !validRouteInput().valid() {
		t.Fatal("valid input refused")
	}
	for name, change := range map[string]func(*assistantRouteInput){
		"blank message":    func(in *assistantRouteInput) { in.Message = "  \n" },
		"long message":     func(in *assistantRouteInput) { in.Message = strings.Repeat("字", assistantRouteMessageMax+1) },
		"invalid UTF-8":    func(in *assistantRouteInput) { in.Message = "ok\xff" },
		"no routes":        func(in *assistantRouteInput) { in.Routes = nil },
		"duplicate routes": func(in *assistantRouteInput) { in.Routes = []string{routePlan, routePlan} },
		"unknown route":    func(in *assistantRouteInput) { in.Routes = []string{routePlan, "run"} },
		"three routes":     func(in *assistantRouteInput) { in.Routes = []string{routePlan, routeExecute, routePlan} },
		"negative nodes":   func(in *assistantRouteInput) { in.Canvas.Nodes = -1 },
		"too many titles":  func(in *assistantRouteInput) { in.Canvas.Titles = make([]string, assistantRouteTitles+1) },
		"long title": func(in *assistantRouteInput) {
			in.Canvas.Titles = []string{strings.Repeat("x", assistantRouteTitleMax+1)}
		},
		"too many turns": func(in *assistantRouteInput) { in.Recent = make([]assistantRouteTurn, assistantRouteTurns+1) },
		"unknown role":   func(in *assistantRouteInput) { in.Recent = []assistantRouteTurn{{Role: "system", Text: "x"}} },
		"unknown turn route": func(in *assistantRouteInput) {
			in.Recent = []assistantRouteTurn{{Role: "user", Route: "run", Text: "x"}}
		},
		"long turn": func(in *assistantRouteInput) {
			in.Recent = []assistantRouteTurn{{Role: "user", Text: strings.Repeat("x", assistantRouteTurnMax+1)}}
		},
	} {
		in := validRouteInput()
		change(&in)
		if in.valid() {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestAssistantRouterMessage(t *testing.T) {
	in := validRouteInput()
	in.Canvas.Titles = []string{"设计", "line\nbreak \"quoted\""}
	text := assistantRouterMessage(in)
	for _, want := range []string{`Canvas: 2 nodes: "设计", "line\nbreak \"quoted\"". It has delivered results.`,
		"Recent conversation, oldest first:\nuser (plan): 先搭一个团队\nassistant (plan): 加了两个节点\n", "Message to route:\n做一个电商落地页"} {
		if !strings.Contains(text, want) {
			t.Fatalf("router message lacks %q:\n%s", want, text)
		}
	}
	if !strings.HasSuffix(text, "做一个电商落地页") {
		t.Fatal("the message to route must come last")
	}
	empty := assistantRouterMessage(assistantRouteInput{Message: " hi ", Routes: []string{routePlan, routeExecute}})
	if empty != "Canvas: empty.\nMessage to route:\nhi" {
		t.Fatalf("empty canvas message: %q", empty)
	}
	// The model reads only what tells the two ways apart: a long request costs it no more than a short one.
	long := validRouteInput()
	long.Message = strings.Repeat("字", assistantRouteMessageMax)
	long.Canvas.Titles = make([]string, assistantRouteTitles)
	for i := range long.Canvas.Titles {
		long.Canvas.Titles[i] = strings.Repeat("题", assistantRouteTitleMax)
	}
	long.Recent = make([]assistantRouteTurn, assistantRouteTurns)
	for i := range long.Recent {
		long.Recent[i] = assistantRouteTurn{Role: "user", Text: strings.Repeat("话", assistantRouteTurnMax)}
	}
	clipped := assistantRouterMessage(long)
	if n := utf8.RuneCountInString(clipped); n > assistantRoutePromptMessage+assistantRoutePromptTitles*(assistantRoutePromptTitle+4)+assistantRoutePromptTurns*(assistantRoutePromptTurn+12)+200 {
		t.Fatalf("router prompt is %d runes", n)
	}
	if strings.Count(clipped, "题") != assistantRoutePromptTitles*assistantRoutePromptTitle || strings.Count(clipped, "user: ") != assistantRoutePromptTurns {
		t.Fatal("router prompt not clipped to its titles and turns")
	}
}

// routeWorker is a Pi worker that reports health and answers the router's one-shot completion. Its health
// lists the per-call options the router needs unless options says otherwise, and 4 slots with routeActive in use.
var routeActive = 0

func routeWorker(t *testing.T, reply func(w http.ResponseWriter, body map[string]any), options ...string) (*httptest.Server, *int) {
	t.Helper()
	activeRuns := routeActive
	if options == nil {
		options = []string{"thinking", "maxTokens"}
	}
	listed, _ := json.Marshal(options)
	calls := 0
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("s", 32) {
			t.Errorf("worker called without its token: %q", r.URL.Path)
		}
		switch r.URL.Path {
		case "/health":
			fmt.Fprintf(w, `{"ready":true,"model":"qwen-test","models":[{"id":"qwen-test","runtime":"pi"},{"id":"other","runtime":"pi"}],"completionOptions":%s,"maxConcurrency":4,"activeRuns":%d}`, listed, activeRuns)
		case "/internal/computer-model":
			calls++
			var body map[string]any
			if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json" || json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Errorf("router call: %s %s", r.Method, r.Header.Get("Content-Type"))
			}
			reply(w, body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(worker.Close)
	return worker, &calls
}

func routeApp(worker *httptest.Server) *App {
	cfg := testConfig()
	cfg.PIURL = worker.URL
	return New(nil, cfg)
}

func content(text string) map[string]any {
	return map[string]any{"completion": map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": text}}}}}
}

func TestModelRouteAsksThePlannerDefaultWithThinkingOffAndASmallAnswer(t *testing.T) {
	identifier := regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	worker, calls := routeWorker(t, func(w http.ResponseWriter, body map[string]any) {
		if body["thinking"] != false || body["maxTokens"] != float64(assistantRouteMaxTokens) || body["model"] != "qwen-test" || body["effort"] != "" || body["tenantId"] != "tenant-1" {
			t.Errorf("router call body: %v", body)
		}
		for _, key := range []string{"runId", "sessionId"} {
			if id, _ := body[key].(string); !identifier.MatchString(id) || !strings.HasPrefix(id, "route-") {
				t.Errorf("%s %q is not a worker identifier", key, id)
			}
		}
		messages := body["completion"].(map[string]any)["messages"].([]any)
		system, user := messages[0].(map[string]any), messages[1].(map[string]any)
		if system["role"] != "system" || system["content"] != assistantRouterInstructions || user["role"] != "user" ||
			!strings.HasSuffix(user["content"].(string), "做一个电商落地页") {
			t.Errorf("router messages: %v", messages)
		}
		json.NewEncoder(w).Encode(content(`{"route":"execute"}`))
	})
	route, err := routeApp(worker).modelRoute(t.Context(), "tenant-1", modelEntitlement{}, validRouteInput(), []string{routePlan, routeExecute})
	if err != nil || route != routeExecute || *calls != 1 {
		t.Fatalf("got %q %v after %d calls", route, err, *calls)
	}
	// With free models configured, the planner's default is used when it is one of them.
	free := routeApp(worker)
	free.cfg.RouteFreeModels = []string{"qwen-test"}
	if route, err := free.modelRoute(t.Context(), "tenant-1", modelEntitlement{}, validRouteInput(), []string{routePlan, routeExecute}); err != nil || route != routeExecute {
		t.Fatalf("free default: %q %v", route, err)
	}
}

func TestModelRouteSpendsNothingItShouldNot(t *testing.T) {
	both := []string{routePlan, routeExecute}
	answer := func(w http.ResponseWriter, _ map[string]any) { json.NewEncoder(w).Encode(content("execute")) }
	for name, c := range map[string]struct {
		options     []string
		entitlement modelEntitlement
		free        []string
		personal    bool
		active      int
	}{
		// A worker that would ignore the options would think at length in a shared slot.
		"worker without the options": {options: []string{}},
		"worker with thinking only":  {options: []string{"thinking"}},
		// A workspace limited to other models would get the router on one of them, uncounted.
		"workspace without the planner default": {entitlement: modelEntitlement{allowed: &[]string{"other"}}},
		// A default on a paid route is not called uncounted.
		"default on a paid route": {free: []string{"another-free-model"}},
		// Personal credentials: the platform does not spend a user's engine on routing.
		"personal credentials": {personal: true},
		// A worker with one slot left keeps it for planning.
		"worker nearly full": {active: 3},
	} {
		routeActive = c.active
		worker, calls := routeWorker(t, answer, c.options...)
		routeActive = 0
		a := routeApp(worker)
		a.cfg.RouteFreeModels, a.cfg.UserCredentials = c.free, c.personal
		if route, err := a.modelRoute(t.Context(), "tenant-1", c.entitlement, validRouteInput(), both); err == nil || *calls != 0 {
			t.Errorf("%s: routed to %q after %d model calls", name, route, *calls)
		}
	}
}

func TestModelRouteFailsClosedToTheCaller(t *testing.T) {
	both := []string{routePlan, routeExecute}
	for name, reply := range map[string]func(http.ResponseWriter, map[string]any){
		"worker error":      func(w http.ResponseWriter, _ map[string]any) { w.WriteHeader(502) },
		"unreadable answer": func(w http.ResponseWriter, _ map[string]any) { json.NewEncoder(w).Encode(content("both, probably")) },
		"reasoning cut off": func(w http.ResponseWriter, _ map[string]any) {
			json.NewEncoder(w).Encode(content(`<think>The user wants {"route":"execute"`))
		},
		"null content": func(w http.ResponseWriter, _ map[string]any) {
			io.WriteString(w, `{"completion":{"choices":[{"message":{"content":null}}]}}`)
		},
		"no choices": func(w http.ResponseWriter, _ map[string]any) { io.WriteString(w, `{"completion":{"choices":[]}}`) },
		"not JSON":   func(w http.ResponseWriter, _ map[string]any) { io.WriteString(w, `<html>`) },
	} {
		worker, _ := routeWorker(t, reply)
		if route, err := routeApp(worker).modelRoute(t.Context(), "tenant-1", modelEntitlement{}, validRouteInput(), both); err == nil {
			t.Errorf("%s: routed to %q", name, route)
		}
	}
	// A model that picks a way the client cannot carry out is not obeyed.
	worker, _ := routeWorker(t, func(w http.ResponseWriter, _ map[string]any) {
		json.NewEncoder(w).Encode(content(`{"route":"execute"}`))
	})
	if _, err := routeApp(worker).modelRoute(t.Context(), "tenant-1", modelEntitlement{}, validRouteInput(), []string{routePlan}); err == nil {
		t.Fatal("router obeyed an unavailable route")
	}
	// A slow model is abandoned at the caller's deadline instead of holding the message.
	slow, _ := routeWorker(t, func(w http.ResponseWriter, _ map[string]any) {
		time.Sleep(400 * time.Millisecond)
		json.NewEncoder(w).Encode(content("execute"))
	})
	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := routeApp(slow).modelRoute(ctx, "tenant-1", modelEntitlement{}, validRouteInput(), both); err == nil || time.Since(started) > 350*time.Millisecond {
		t.Fatalf("slow router not abandoned in time: %v after %s", err, time.Since(started))
	}
}

func TestAssistantRouteLimiter(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	var l assistantRouteLimiter
	// One call in flight per user, and the deployment's limit in all.
	releaseA, refused := l.acquire("user-a", now)
	if refused != "" {
		t.Fatal(refused)
	}
	if _, refused = l.acquire("user-a", now); refused != "user_in_flight" {
		t.Fatalf("second call of one user in flight: %q", refused)
	}
	if _, refused = l.acquire("user-b", now); refused != "router_busy" {
		t.Fatalf("call past the deployment limit: %q", refused)
	}
	releaseA()
	releaseA() // A second release frees nothing more.
	releaseB, refused := l.acquire("user-b", now)
	if refused != "" {
		t.Fatalf("freed slot not reused: %q", refused)
	}
	if _, refused = l.acquire("user-c", now); refused != "router_busy" {
		t.Fatalf("a double release freed a second slot: %q", refused)
	}
	releaseB()
	// A user's minute and day budgets.
	minute := assistantRouteLimiter{perMinute: 2, perDay: 3}
	call := func(at time.Time) string {
		release, refused := minute.acquire("user-a", at)
		if release != nil {
			release()
		}
		return refused
	}
	if call(now) != "" || call(now.Add(time.Second)) != "" || call(now.Add(2*time.Second)) != "user_budget" {
		t.Fatal("minute budget not enforced")
	}
	if call(now.Add(time.Minute)) != "" || call(now.Add(time.Minute+time.Second)) != "user_budget" {
		t.Fatal("day budget not enforced across minutes")
	}
	if call(now.Add(24*time.Hour)) != "" {
		t.Fatal("day budget did not reset")
	}
}

func TestPostgresAssistantRoute(t *testing.T) {
	answer := `{"route":"execute"}`
	worker, calls := routeWorker(t, func(w http.ResponseWriter, _ map[string]any) { json.NewEncoder(w).Encode(content(answer)) })
	h := newHarness(t, worker.URL)
	c, tid, _ := h.register(t, "router@example.test")
	prefix := "/tenants/" + tid
	cv := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Routed", "document": map[string]any{"nodes": []any{}}}, 201)
	path := prefix + "/canvases/" + cv["id"].(string) + "/assistant/route"
	route := func(message string, routes []string, status int) map[string]any {
		return h.request(t, c, "POST", path, map[string]any{"message": message, "routes": routes, "canvas": map[string]any{"nodes": 0, "titles": []string{}, "results": false}, "recent": []any{}}, status)
	}
	expect := func(got map[string]any, route, basis string, modelCalls int) {
		t.Helper()
		if got["route"] != route || got["basis"] != basis || *calls != modelCalls {
			t.Fatalf("got %v after %d model calls, want %s by %s after %d", got, *calls, route, basis, modelCalls)
		}
	}
	expect(route("做一个电商落地页", []string{routePlan}, 200), routePlan, "only", 0)
	// Without managed execution configured, the server narrows the client's two ways to one.
	expect(route("做一个电商落地页", []string{routePlan, routeExecute}, 200), routePlan, "only", 0)
	h.a.cfg.OpenMausURL, h.a.cfg.OpenMausToken = "http://127.0.0.1:1", strings.Repeat("m", 32)
	expect(route("在画布上加一个审核节点", []string{routePlan, routeExecute}, 200), routePlan, "rule", 0)
	expect(route("直接执行：写一封道歉邮件", []string{routePlan, routeExecute}, 200), routeExecute, "model", 1)
	answer = "no idea"
	expect(route("帮我调研一下竞品", []string{routePlan, routeExecute}, 200), routePlan, "fallback", 2)
	// A workspace that runs nothing without its owner's paid plan gets no model call while the owner has none, and
	// routes as any other once the plan is there.
	answer = `{"route":"execute"}`
	// (Only a route-limited workspace is ever on a plan, as every new one is.)
	execSQL(t, h, "UPDATE tenants SET requires_plan=true, route_limits=$2 WHERE id=$1", tid, planRoutes)
	expect(route("帮我调研一下竞品", []string{routePlan, routeExecute}, 200), routePlan, "fallback", 2)
	now := time.Now()
	givePlan(t, h, "router@example.test", "pro", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 2000)
	expect(route("帮我调研一下竞品", []string{routePlan, routeExecute}, 200), routeExecute, "model", 3)
	execSQL(t, h, "UPDATE tenants SET requires_plan=false, route_limits=NULL WHERE id=$1", tid)
	// Past the user's budget the message is still routed, by its default and without a model call.
	h.a.routeLimiter.perMinute = 1
	answer = `{"route":"execute"}`
	expect(route("帮我调研一下竞品", []string{routePlan, routeExecute}, 200), routePlan, "fallback", 3)
	// The router's model call is the platform's: it is not recorded against the workspace's allowance.
	var used int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&used); e != nil || used != 0 {
		t.Fatalf("router recorded %d model invocations: %v", used, e)
	}
	// Another workspace's canvas is not found here, and neither is a missing one.
	other, otherTenant, _ := h.register(t, "router-other@example.test")
	foreign := h.request(t, other, "POST", "/tenants/"+otherTenant+"/canvases", map[string]any{"name": "Theirs", "document": map[string]any{"nodes": []any{}}}, 201)
	body := map[string]any{"message": "hi", "routes": []string{routePlan}, "canvas": map[string]any{"nodes": 0}, "recent": []any{}}
	h.request(t, c, "POST", prefix+"/canvases/"+foreign["id"].(string)+"/assistant/route", body, 404)
	h.request(t, c, "POST", prefix+"/canvases/missing/assistant/route", body, 404)
	// Someone outside the workspace cannot route on its canvases, and a reader, who can neither plan nor
	// start a task, cannot either.
	h.request(t, other, "POST", path, body, 404)
	h.request(t, c, "POST", prefix+"/members", map[string]string{"email": "router-other@example.test", "role": "reader"}, 201)
	h.request(t, other, "POST", path, body, 403)
	route(" ", []string{routePlan, routeExecute}, 400)
	route("hi", []string{"run"}, 400)
}

func TestServerRoutesNarrowToWhatIsConfigured(t *testing.T) {
	cfg := testConfig()
	a := New(nil, cfg)
	if got := a.serverRoutes([]string{routePlan, routeExecute}); len(got) != 1 || got[0] != routePlan {
		t.Fatalf("without managed execution: %v", got)
	}
	cfg.OpenMausURL, cfg.OpenMausToken = "http://127.0.0.1:8109", strings.Repeat("m", 32)
	a = New(nil, cfg)
	if got := a.serverRoutes([]string{routeExecute, routePlan}); len(got) != 2 {
		t.Fatalf("with managed execution: %v", got)
	}
	cfg.PIURL = ""
	a = New(nil, cfg)
	if got := a.serverRoutes([]string{routePlan, routeExecute}); len(got) != 1 || got[0] != routeExecute {
		t.Fatalf("without a planner runtime: %v", got)
	}
}
