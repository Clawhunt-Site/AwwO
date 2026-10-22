package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A catalog's maxOutputTokens counts only as a whole number of tokens in bounds; anything else is unknown, and the rest
// of the model reads as before (a malformed limit never fails the catalog).
func TestModelOutputTokensKeepsOnlyAWholeNumber(t *testing.T) {
	for raw, want := range map[string]int{`16384`: 16384, `1`: 1, `1048576`: 1048576, `1048577`: 0, `0`: 0, `-5`: 0,
		`16384.5`: 0, `1e4`: 0, `"16384"`: 0, `null`: 0, `true`: 0, `[]`: 0, `{}`: 0} {
		var m piModel
		if err := json.Unmarshal([]byte(`{"id":"m","maxContextTextBytes":1000,"maxOutputTokens":`+raw+`}`), &m); err != nil ||
			m.MaxOutputTokens != want || m.ID != "m" || m.MaxContextTextBytes != 1000 {
			t.Fatalf("maxOutputTokens %s: %d (%v), want %d", raw, m.MaxOutputTokens, err, want)
		}
	}
	var m piModel
	if err := json.Unmarshal([]byte(`{"id":"m"}`), &m); err != nil || m.MaxOutputTokens != 0 {
		t.Fatal("absent maxOutputTokens", m.MaxOutputTokens, err)
	}
}

func TestDurationText(t *testing.T) {
	for d, want := range map[time.Duration]string{30 * time.Minute: "30 minutes", time.Minute: "1 minute", 90 * time.Second: "1 minute",
		10 * time.Second: "10 seconds", time.Second: "1 second", 700 * time.Millisecond: "1 second"} {
		if got := durationText(d); got != want {
			t.Errorf("durationText(%v) = %q, want %q", d, got, want)
		}
	}
}

// limitsWorker is a model worker of one runtime whose catalog says each model's maxOutputTokens (models: id → limit, a
// non-number for one it says wrongly), whose default is the first, and which answers every run with a valid plan.
func limitsWorker(t *testing.T, runtime string, models func() [][2]any) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			list := []map[string]any{}
			for _, m := range models() {
				list = append(list, map[string]any{"id": m[0], "provider": "test", "runtime": runtime, "maxContextTextBytes": 262144, "maxOutputTokens": m[1]})
			}
			writeJSON(w, 200, map[string]any{"ready": true, "model": models()[0][0], "provider": "test",
				"limits": map[string]any{"maxContextTextBytes": 262144, "messageOverheadBytes": 32}, "models": list})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		raw, _ := json.Marshal(map[string]any{"type": "completed", "text": progressPlan})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}))
	t.Cleanup(server.Close)
	return server
}

// A plan the canvas assistant asks for tells the planner how much one answer of each model the workspace may use
// holds, as the worker that runs it says now (openai-agents where it offers the model, else Pi), the workspace default
// (openai-agents') and the run's time limit; after the canvas context, before the asker's personal settings and the
// request, and after the request's hash: a retry once a limit changed is the same plan. The instructions say how to size
// and split by it.
func TestPostgresPlanTellsThePlannerEachModelsOutputLimit(t *testing.T) {
	var shared atomic.Int64
	shared.Store(32000)
	oa := limitsWorker(t, runtimeOpenAIAgents, func() [][2]any {
		return [][2]any{{"oa-default", 16384}, {"shared", shared.Load()}, {"big", 64000}, {"quiet", nil}, {"hidden", 4096}}
	})
	pi := limitsWorker(t, runtimePI, func() [][2]any {
		return [][2]any{{"pi-default", 8192}, {"shared", 64000}, {"odd", "lots"}, {"big", 32000}, {"quiet", 4096}}
	})
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	h.a.cfg.RunTimeout = 30 * time.Minute
	c, tid, _ := h.register(t, "plan-limits@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['big','oa-default','odd','pi-default','quiet','shared'],max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	h.request(t, c, "PUT", "/auth/preferences", map[string]any{"version": 0, "preferences": map[string]any{"personalization": map[string]any{
		"enabled": true, "aboutMe": "LIMITS-ABOUT"}}}, 200)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(operation string, status int) (string, string, string) {
		t.Helper()
		id := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
			map[string]string{"prompt": "Write a long report", "context": "CANVAS-CONTEXT", "operationId": operation}, status)["id"].(string)
		h.awaitRun(t, c, tid, id, "completed")
		var prompt, instructions string
		if e := h.db.QueryRow(context.Background(), "SELECT prompt,execution_snapshot->>'instructions' FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt, &instructions); e != nil {
			t.Fatal(e)
		}
		return id, prompt, instructions
	}
	// A model both offer takes the least of their limits (a node bound to a workspace Agent keeps that Agent's runtime:
	// shared, big), one that gives it alone takes that (pi-default); a worker that offers a model and gives no limit, or
	// none that is a number, counts as 16,000 for it, which the limits say (quiet, whose limit only Pi gives, so its
	// least is Pi's; odd); one the workspace may not use is not named.
	id, prompt, instructions := plan("plan-limits-1", 202)
	limits := `as its workers call it now (taken as 16,000 where a worker offering the model gives none; "default" is the model a node without one runs on): ` +
		`{"default":16384,"oa-default":16384,"shared":32000,"big":32000,"quiet":4096,"pi-default":8192,"odd":16000}. A node's run also ends after at most 30 minutes.`
	at, about, request := strings.Index(prompt, limits), strings.Index(prompt, "LIMITS-ABOUT"), strings.Index(prompt, "\n\nUser request:\nWrite a long report")
	if !strings.HasPrefix(prompt, "CANVAS-CONTEXT\n\nNode limits: the most one answer of each model holds") || at < 0 || about < at || request < about || strings.Contains(prompt, `"hidden"`) {
		t.Fatalf("the plan's prompt: %q", prompt)
	}
	for _, phrase := range []string{"keep it within half of its model's limit, a sixth for code", "split it by chapter, section, module or batch", "say briefly in summary how you split the work",
		"runs on the model the context names for new nodes", "its share of the user's totals", "stays within its operation limit", "every part pasted in, is still that one node's answer",
		"an @R requirement the context already lists", "by the limit they give every other model, or else by the smallest they give"} {
		if !strings.Contains(instructions, phrase) {
			t.Fatalf("the planner's instructions lack %q", phrase)
		}
	}
	// A limit that changed since is no other request: the same operation is the same plan.
	shared.Store(30000)
	if again := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
		map[string]string{"prompt": "Write a long report", "context": "CANVAS-CONTEXT", "operationId": "plan-limits-1"}, 200)["id"].(string); again != id {
		t.Fatalf("the retry made run %s, not %s", again, id)
	}
	// A workspace whose allowlist leaves out the worker's own default runs the first model it allows there (defaultModel).
	c2, tid2, _ := h.register(t, "plan-limits-allowlist@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET allowed_models=ARRAY['big','pi-default','shared'],max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid2)
	cid2 := h.request(t, c2, "POST", "/tenants/"+tid2+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	other := h.request(t, c2, "POST", "/tenants/"+tid2+"/canvases/"+cid2+"/plan",
		map[string]string{"prompt": "Write a long report", "context": "CANVAS-CONTEXT", "operationId": "plan-limits-allowlist"}, 202)["id"].(string)
	h.awaitRun(t, c2, tid2, other, "completed")
	var allowed string
	// Every model it may use has a limit, so none is taken as 16,000.
	if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid2, other).Scan(&allowed); e != nil ||
		!strings.Contains(allowed, `as its workers call it now ("default" is the model a node without one runs on): {"default":32000,"shared":30000,"big":32000,"pi-default":8192}.`) {
		t.Fatalf("the plan's prompt with the worker's default left out (%v): %q", e, allowed)
	}
	// With openai-agents down every model is Pi's, and no default is named: a node without a model runs there.
	oa.Close()
	if _, prompt, _ = plan("plan-limits-2", 202); !strings.Contains(prompt, `as its workers call it now (taken as 16,000 where a worker offering the model gives none): `+
		`{"pi-default":8192,"shared":64000,"odd":16000,"big":32000,"quiet":4096}.`) || strings.Contains(prompt, `"default"`) {
		t.Fatalf("the plan's prompt without openai-agents: %q", prompt)
	}
}

// The node limits never move a plan off the operator's planner model: where the whole of them would take it past that
// model's input ceiling they go in a few words, where even those would, not at all, and the plan runs on that model; with
// room they are there whole; and a plan past the ceiling without them, which runs on the default model, keeps them.
func TestPostgresPlanLimitsKeepAPlanOnThePlannerModel(t *testing.T) {
	pi := limitsWorker(t, runtimePI, func() [][2]any {
		models := [][2]any{{"pi-default", 8192}, {testPlannerModel, 32000}}
		for i := range 30 {
			models = append(models, [2]any{fmt.Sprintf("m-%02d", i), 16384})
		}
		return models
	})
	h := newHarness(t, pi.URL)
	view, request := "CANVAS-CONTEXT "+strings.Repeat("c", 3000), "Write a long report"
	base := len(view) + len("\n\nUser request:\n") + len(request) + len(plannerInstructions)
	h.a.cfg.PlannerModel, h.a.cfg.PlannerPerWorkspaceDay, h.a.cfg.PlannerTotalPerDay, h.a.cfg.PlannerMaxInputBytes = testPlannerModel, 20, 100, base+20
	c, tid, _ := h.register(t, "plan-limits-ceiling@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(operation string) (string, string) {
		t.Helper()
		id := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]string{"prompt": request, "context": view, "operationId": operation}, 202)["id"].(string)
		h.awaitRun(t, c, tid, id, "completed")
		var prompt string
		if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt); e != nil {
			t.Fatal(e)
		}
		return id, prompt
	}
	id, prompt := plan("plan-limits-ceiling-1")
	if model, paid, _ := runCall(t, h, tid, id); strings.Contains(prompt, "Node limits") || model != testPlannerModel || !paid {
		t.Fatalf("a plan the limits alone would take past the ceiling: on %q (operator-paid %v), limits there %v", model, paid, strings.Contains(prompt, "Node limits"))
	}
	h.a.cfg.PlannerMaxInputBytes = base + 400
	id, prompt = plan("plan-limits-ceiling-2")
	if model, paid, _ := runCall(t, h, tid, id); !strings.Contains(prompt, "Node limits, shortened to fit: take every model's limit as 8192 output tokens") ||
		strings.Contains(prompt, `"m-00"`) || model != testPlannerModel || !paid {
		t.Fatalf("a plan with room for the limits in a few words: on %q (operator-paid %v): %q", model, paid, prompt)
	}
	h.a.cfg.PlannerMaxInputBytes = base + 5000
	id, prompt = plan("plan-limits-ceiling-3")
	if model, paid, _ := runCall(t, h, tid, id); !strings.Contains(prompt, `"pi-default":8192`) || model != testPlannerModel || !paid {
		t.Fatalf("a plan with room for the limits: on %q (operator-paid %v): %q", model, paid, prompt)
	}
	h.a.cfg.PlannerMaxInputBytes = base - 100
	id, prompt = plan("plan-limits-ceiling-4")
	if model, paid, _ := runCall(t, h, tid, id); !strings.Contains(prompt, `"pi-default":8192`) || model == testPlannerModel || paid {
		t.Fatalf("a plan past the ceiling without the limits: on %q (operator-paid %v): %q", model, paid, prompt)
	}
}

// The limits name at most a hundred models and the least any other one holds, the smallest of all past the hundredth
// too, never one with the id "default" (the workspace default's own key), and stay out of a prompt they would take past
// its bound, which is then planned without them rather than refused.
func TestPostgresPlanLimitsAreBounded(t *testing.T) {
	pi := limitsWorker(t, runtimePI, func() [][2]any {
		models := [][2]any{{"pi-default", 8192}, {"default", 1}}
		for i := range 120 {
			models = append(models, [2]any{fmt.Sprintf("m-%03d", i), 16384})
		}
		return append(models, [2]any{"tiny", 2048})
	})
	h := newHarness(t, pi.URL)
	c, tid, uid := h.register(t, "plan-limits-bounded@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	plan := func(view, request, operation string) string {
		t.Helper()
		id := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]string{"prompt": request, "context": view, "operationId": operation}, 202)["id"].(string)
		h.awaitRun(t, c, tid, id, "completed")
		var prompt string
		if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt); e != nil {
			t.Fatal(e)
		}
		return prompt
	}
	prompt := plan("CANVAS-CONTEXT", "Write a long report", "plan-limits-bounded-1")
	if n := strings.Count(prompt, ":16384"); n != 99 || !strings.Contains(prompt, `{"pi-default":8192,"m-000":16384,`) || strings.Contains(prompt, `"default":`) ||
		strings.Contains(prompt, `"m-099"`) || strings.Contains(prompt, `"tiny"`) || !strings.Contains(prompt, `"m-098":16384}. Take every other model's limit as 2048.`) {
		t.Fatalf("%d models of 16,384 named (want the 99 after pi-default, then the least of the others): %q", n, prompt)
	}
	// Context, personal settings and request at the prompt's own bound: planned with the settings, without the limits.
	h.request(t, c, "PUT", "/auth/preferences", map[string]any{"version": 0, "preferences": map[string]any{"personalization": map[string]any{
		"enabled": true, "aboutMe": "BOUND-ABOUT"}}}, 200)
	personal := h.a.plannerPersonalization(context.Background(), uid)
	view, request := strings.Repeat("a", maxPlanContextUnits), strings.Repeat("r", maxRunPromptUnits-maxPlanContextUnits-len("\n\nUser request:\n")-utf16Len(personal)-8)
	if prompt = plan(view, request, "plan-limits-bounded-2"); strings.Contains(prompt, "Node limits") || !strings.Contains(prompt, "BOUND-ABOUT") || utf16Len(prompt) > maxRunPromptUnits {
		t.Fatalf("a plan at the prompt's bound: %d units, limits there %v, settings there %v", utf16Len(prompt), strings.Contains(prompt, "Node limits"), strings.Contains(prompt, "BOUND-ABOUT"))
	}
}

// In a few words the limits name the default, also under its own id, and the models whose limit is lower, smallest
// first, and the least every other model holds; a plan whose prompt has room for those and not for the whole carries
// them.
func TestPostgresPlanLimitsInAFewWords(t *testing.T) {
	oa := limitsWorker(t, runtimeOpenAIAgents, func() [][2]any {
		models := [][2]any{{"oa-default", 16384}, {"small-b", 8192}, {"big", 64000}, {"small-a", 4096}}
		for i := range 40 {
			models = append(models, [2]any{fmt.Sprintf("f-%02d", i), 32000})
		}
		return models
	})
	pi := limitsWorker(t, runtimePI, func() [][2]any { return [][2]any{{"pi-default", 8192}} })
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	c, tid, _ := h.register(t, "plan-limits-compact@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	full, compact := h.a.plannerNodeLimits(context.Background(), tid)
	want := `included, on the default model ("default", the model a node without one runs on) and on the models whose limit is lower: ` +
		`{"default":16384,"oa-default":16384,"small-a":4096,"small-b":8192,"pi-default":8192}. Take every other model's limit as 32000.`
	if !strings.HasPrefix(compact, "\n\nNode limits, shortened to fit: ") || !strings.Contains(compact, want) || len(compact) >= len(full)/2 ||
		!strings.Contains(full, `"f-39":32000,"pi-default":8192}.`) || strings.Contains(full, "every other model") || strings.Contains(full+compact, "taken as 16,000") {
		t.Fatalf("the limits in a few words: %q (whole: %q)", compact, full)
	}
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	view := strings.Repeat("a", maxPlanContextUnits)
	request := strings.Repeat("r", maxRunPromptUnits-maxPlanContextUnits-len("\n\nUser request:\n")-utf16Len(compact)-4)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan", map[string]string{"prompt": request, "context": view, "operationId": "plan-limits-compact"}, 202)["id"].(string)
	h.awaitRun(t, c, tid, id, "completed")
	var prompt string
	if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt); e != nil || !strings.Contains(prompt, want) || strings.Contains(prompt, `"f-00"`) {
		t.Fatalf("a plan with room for the limits in a few words (%v): %d units", e, utf16Len(prompt))
	}
}

// A model a worker offers without saying its limit is never sized past what is assumed of it: the default whose limit
// is unsaid while another model's is 64,000 is 16,000 (it was the least of the said ones), a model one worker says
// 64,000 of and the other nothing is 16,000, the limits say so, in the whole and in a few words; with no limit said
// by any worker there are none.
func TestPostgresPlanLimitsTakeAnUnsaidLimitAs16000(t *testing.T) {
	var piModels atomic.Value
	piModels.Store([][2]any{{"pi-default", 8192}})
	oa := limitsWorker(t, runtimeOpenAIAgents, func() [][2]any { return [][2]any{{"oa-default", nil}, {"big", 64000}} })
	pi := limitsWorker(t, runtimePI, func() [][2]any { return piModels.Load().([][2]any) })
	h := newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	h.a.cfg.RunTimeout = 0
	_, tid, _ := h.register(t, "plan-limits-unsaid@awwo.invalid")
	note := `(taken as 16,000 where a worker offering the model gives none`
	full, compact := h.a.plannerNodeLimits(context.Background(), tid)
	if want := note + `; "default" is the model a node without one runs on): {"default":16000,"oa-default":16000,"big":64000,"pi-default":8192}.`; !strings.HasSuffix(full, want) {
		t.Fatalf("the default's limit unsaid: %q", full)
	}
	if want := `holds, in output tokens with the model's thinking included ` + note + `), on the default model ("default", the model a node without one runs on) ` +
		`and on the models whose limit is lower: {"default":16000,"oa-default":16000,"pi-default":8192}. Take every other model's limit as 64000.`; !strings.HasSuffix(compact, want) {
		t.Fatalf("the default's limit unsaid, in a few words: %q", compact)
	}
	piModels.Store([][2]any{{"pi-default", 8192}, {"big", nil}})
	if full, compact = h.a.plannerNodeLimits(context.Background(), tid); !strings.HasSuffix(full, `{"default":16000,"oa-default":16000,"big":16000,"pi-default":8192}.`) ||
		!strings.HasSuffix(compact, `{"default":16000,"oa-default":16000,"pi-default":8192}. Take every other model's limit as 16000.`) {
		t.Fatalf("a model one worker says nothing of: %q, in a few words %q", full, compact)
	}
	oa.Close()
	piModels.Store([][2]any{{"pi-default", nil}, {"big", "lots"}})
	if full, compact = h.a.plannerNodeLimits(context.Background(), tid); full != "" || compact != "" {
		t.Fatalf("no limit said: %q, %q", full, compact)
	}
}

// A worker that says no model's limit leaves the plan's prompt as it was.
func TestPostgresPlanWithoutWorkerLimitsSaysNone(t *testing.T) {
	var budget atomic.Int64
	budget.Store(100000)
	h := newHarness(t, plannerBudgetWorker(t, &budget).URL)
	c, tid, _ := h.register(t, "plan-no-limits@awwo.invalid")
	execSQL(t, h, `UPDATE tenants SET max_runs_per_day=100,max_concurrent_runs=10 WHERE id=$1`, tid)
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Plan", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/canvases/"+cid+"/plan",
		map[string]string{"prompt": "Write a long report", "context": "CANVAS-CONTEXT", "operationId": "plan-no-limits-1"}, 202)["id"].(string)
	h.awaitRun(t, c, tid, id, "completed")
	var prompt string
	if e := h.db.QueryRow(context.Background(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&prompt); e != nil || prompt != "CANVAS-CONTEXT\n\nUser request:\nWrite a long report" {
		t.Fatalf("the plan's prompt: %q (%v)", prompt, e)
	}
}
