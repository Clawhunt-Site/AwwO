package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// The provider that produced this leak split its opening tag across two events
// ("<th" then "ink>"), so a per-delta filter would have missed it. Splitting the
// closing tag too keeps both boundaries exercised on every path below, and reopening
// thinking after the first span keeps every path proving that stopping at one span
// is not enough: the second one would otherwise be published verbatim.
func leakedDeltas(scratchpad, answer string) []string {
	return []string{"<th", "ink>", scratchpad + "</thi", "nk>\n<think>reopened " + scratchpad, "</think>\n" + answer}
}

func leakedText(scratchpad, answer string) string {
	return strings.Join(leakedDeltas(scratchpad, answer), "")
}

func streamLeaked(w http.ResponseWriter, scratchpad, answer string) {
	for _, delta := range leakedDeltas(scratchpad, answer) {
		raw, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": delta})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}
	completePi(w, leakedText(scratchpad, answer))
}

func scalar(t *testing.T, h *harness, query string, args ...any) string {
	t.Helper()
	var value string
	if e := h.db.QueryRow(context.Background(), query, args...).Scan(&value); e != nil {
		t.Fatal(e)
	}
	return value
}

// A scratchpad must not survive in any durable sink or in the replay the browser
// reads. There is deliberately no audit copy of the raw text: the admin runs
// endpoint exposes run output across tenants, so persisting it would be the leak.
func assertNoScratchpad(t *testing.T, secret string, sinks map[string]string) {
	t.Helper()
	for name, text := range sinks {
		if strings.Contains(text, secret) || strings.Contains(strings.ToLower(text), "think") {
			t.Fatalf("%s retained the scratchpad: %s", name, text)
		}
	}
}

func TestPostgresReasoningPreambleNeverReachesAStoredRun(t *testing.T) {
	const secret = "tenant billing id 88123, do not reveal"
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		streamLeaked(w, "Let me reason. "+secret+".", "The answer is 4.")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-run@awwo.invalid")
	_, _, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "hello", "operationId": "reasoning-run"}, 202)["id"].(string)
	if done := h.awaitRun(t, c, tid, id, "completed"); done["output"] != "The answer is 4." {
		t.Fatalf("stored output is not the answer: %#v", done["output"])
	}
	_, replay := h.readRaw(t, c, prefix+"/runs/"+id+"/events", 200)
	messages := scalar(t, h, "SELECT coalesce(string_agg(content,'|'),'') FROM messages WHERE tenant_id=$1 AND run_id=$2", tid, id)
	assertNoScratchpad(t, secret, map[string]string{
		"runs.output":      scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
		"run_events.data":  scalar(t, h, "SELECT coalesce(string_agg(data::text,'|'),'') FROM run_events WHERE tenant_id=$1 AND run_id=$2", tid, id),
		"messages.content": messages,
		"events replay":    string(replay),
	})
	// Withholding the scratchpad must not withhold the answer as well.
	if !strings.Contains(messages, "The answer is 4.") || !strings.Contains(string(replay), "The answer is 4.") {
		t.Fatalf("the answer was lost with the scratchpad: %q / %q", messages, replay)
	}
}

// A plan behind a preamble used to fail as invalid_canvas_plan, because the schema
// gate only tolerates a leading fence. Stripping at the runtime boundary fixes the
// planner without adding an unreachable guard inside validatePlan.
func TestPostgresPlannerAcceptsAPlanBehindAReasoningPreamble(t *testing.T) {
	const plan = `{"version":1,"summary":"Create backend","operations":[{"type":"add_node","ref":"api","templateId":"backend"}]}`
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		streamLeaked(w, "decide the shape 88123", plan)
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-planner@awwo.invalid")
	prefix := "/tenants/" + tid
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Planner", "document": map[string]any{"nodes": []any{}}}, 201)["id"].(string)
	id := h.request(t, c, "POST", prefix+"/canvases/"+cid+"/plan", map[string]string{"prompt": "Build API", "context": "schema", "operationId": "reasoning-plan"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "completed")
	if done["output"] != plan {
		t.Fatalf("plan not recovered from behind the preamble: %#v", done["output"])
	}
	assertNoScratchpad(t, "88123", map[string]string{
		"runs.output": scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
	})
}

// Stripping lives at the Go stream boundary rather than inside a worker, so both
// workers are covered by one implementation. Running the same leak through each
// runtime is what substantiates that claim.
func TestPostgresGraphContractAndFileArtifactDropTheReasoningPreamble(t *testing.T) {
	for _, runtime := range []string{runtimePI, runtimeOpenAIAgents} {
		t.Run(runtime, func(t *testing.T) {
			const secret = "internal note 88123"
			const deliverable = `{"summary":"built the module","artifact":{"name":"main.go","content":"package main\n"}}`
			handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				streamLeaked(w, secret, deliverable)
			}
			pi := runtimeProvider(t, runtimePI, handle)
			defer pi.Close()
			oa := runtimeProvider(t, runtimeOpenAIAgents, handle)
			defer oa.Close()
			h := newHarness(t, pi.URL)
			h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
			c, tid, _ := h.register(t, "reasoning-graph-"+runtime+"@awwo.invalid")
			prefix := "/tenants/" + tid
			model := "test-model"
			if runtime == runtimeOpenAIAgents {
				model = "oa-default"
			}
			aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": "Coder", "adapterType": runtime, "model": model, "instructions": "Deliver the module."}, 201)["id"].(string)
			node := map[string]any{"id": "coder", "kind": "session", "title": "coder", "runtime": runtime,
				"binding": map[string]string{"companyId": tid, "agentId": aid}, "contract": fileNode(true).Contract}
			cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Delivery", "document": map[string]any{"nodes": []any{node}, "edges": []any{}}}, 201)["id"].(string)
			base := prefix + "/canvases/" + cid + "/graph-runs"
			gid := h.request(t, c, "POST", base, map[string]any{"operationId": "reasoning-graph-operation", "documentVersion": 1}, 202)["id"].(string)
			done := awaitGraph(t, h, c, base+"/"+gid, "completed")
			settled := done["nodes"].([]any)[0].(map[string]any)
			if settled["state"] != "done" {
				t.Fatalf("node did not deliver: %#v", settled)
			}
			var recorded map[string]string
			if e := json.Unmarshal([]byte(settled["output"].(string)), &recorded); e != nil {
				t.Fatalf("node output is not the validated contract: %v (%v)", settled["output"], e)
			}
			if recorded["summary"] != "built the module" || !strings.HasPrefix(recorded["artifact"], artifactRefPrefix) {
				t.Fatalf("contract fields lost: %#v", recorded)
			}
			_, body := h.readRaw(t, c, prefix+"/artifacts/"+strings.TrimPrefix(recorded["artifact"], artifactRefPrefix), 200)
			if string(body) != "package main\n" {
				t.Fatalf("stored artifact content: %q", body)
			}
			assertNoScratchpad(t, secret, map[string]string{
				"graph_run_nodes.output": settled["output"].(string),
				"runs.output":            scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, settled["runId"].(string)),
				"artifacts.content":      string(body),
			})
		})
	}
}

func TestPostgresTeamTurnsDropTheReasoningPreamble(t *testing.T) {
	const secret = "member scratchpad 88123"
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		streamLeaked(w, secret, "MEMBER-ANSWER")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-team@awwo.invalid")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	prefix := "/tenants/" + tid
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "deliver", "operationId": "reasoning-team-operation"}, 202)["id"].(string)
	if done := h.awaitRun(t, c, tid, id, "completed"); done["output"] != "MEMBER-ANSWER" {
		t.Fatalf("team result is not the answer: %#v", done["output"])
	}
	turns := scalar(t, h, "SELECT coalesce(string_agg(output,'|'),'') FROM run_turns WHERE tenant_id=$1 AND run_id=$2", tid, id)
	if !strings.Contains(turns, "MEMBER-ANSWER") {
		t.Fatalf("member turns lost their answer: %q", turns)
	}
	assertNoScratchpad(t, secret, map[string]string{
		"run_turns.output": turns,
		"runs.output":      scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
	})
}

// An answer made only of a scratchpad is not a deliverable. Publishing it would
// leak model internals and reporting success would claim a result that does not
// exist, so the run fails and nothing is stored — including the truncated case,
// where the pure pass deliberately keeps the text but this policy will not ship it.
func TestPostgresReasoningOnlyOutputFailsWithoutStoringTheScratchpad(t *testing.T) {
	const secret = "88123"
	cases := map[string]string{
		"closed span with no answer": "<think>only reasoning " + secret + "</think>\n  ",
		"never closed":               "<think>truncated before the answer " + secret,
		"prefilled open tag only":    "</think>",
	}
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		text := cases[strings.TrimPrefix(call.Prompt, "case:")]
		raw, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": text})
		fmt.Fprintf(w, "data: %s\n\n", raw)
		completeObserved(w, text, observationFixture(17, 5))
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-only@awwo.invalid")
	_, _, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	for name := range cases {
		id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "case:" + name, "operationId": "reasoning-only-" + name}, 202)["id"].(string)
		done := h.awaitRun(t, c, tid, id, "failed")
		if done["error"] != "reasoning_only_output" || done["output"] != "" {
			t.Fatalf("%s: %#v", name, done)
		}
		assertNoScratchpad(t, secret, map[string]string{
			name + " runs.output":     scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
			name + " run_events.data": scalar(t, h, "SELECT coalesce(string_agg(data::text,'|'),'') FROM run_events WHERE tenant_id=$1 AND run_id=$2", tid, id),
		})
		// A protocol failure, so accounting classifies it like the other ones.
		if got := invocationFailure("failed", "reasoning_only_output"); got != "protocol" {
			t.Fatalf("failure class %q", got)
		}
		// Withholding the text must not withhold the accounting. Tokens were really
		// spent producing that scratchpad, and usage comes from what the worker
		// reported rather than from the published text, so it is recorded in full.
		var in, out int64
		var usage string
		if e := h.db.QueryRow(context.Background(), "SELECT input_tokens,output_tokens,usage_status FROM model_invocations WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&in, &out, &usage); e != nil {
			t.Fatal(e)
		}
		if in != 17 || out != 5 || usage != "reported" {
			t.Fatalf("%s: reported usage lost with the scratchpad: %d/%d %s", name, in, out, usage)
		}
	}
}

// The member stream is a second, independent loop with its own cap and its own
// terminal event, so both decisions have to be proven there too and not only on the
// single-run path.
func TestPostgresTeamMemberReasoningOnlyOutputFailsTheRun(t *testing.T) {
	const secret = "member scratchpad 88123"
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		calls.Add(1)
		text := "<think>" + secret
		raw, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": text})
		fmt.Fprintf(w, "data: %s\n\n", raw)
		completePi(w, text)
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-team-only@awwo.invalid")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	prefix := "/tenants/" + tid
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "deliver", "operationId": "reasoning-team-only"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "failed")
	if done["error"] != "reasoning_only_output" || done["output"] != "" {
		t.Fatalf("%#v", done)
	}
	// A member with no deliverable stops the team, so the scratchpad never becomes an
	// operand: no later member is invoked at all.
	if calls.Load() != 1 {
		t.Fatalf("aggregation continued past a member that delivered nothing: %d calls", calls.Load())
	}
	assertNoScratchpad(t, secret, map[string]string{
		"run_turns.output": scalar(t, h, "SELECT coalesce(string_agg(output,'|'),'') FROM run_turns WHERE tenant_id=$1 AND run_id=$2", tid, id),
		"runs.output":      scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
	})
}

func TestPostgresTeamMemberReasoningVolumeStillCountsAgainstTheOutputLimit(t *testing.T) {
	block := strings.Repeat("n", 64*1024)
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		open, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": "<think>"})
		fmt.Fprintf(w, "data: %s\n\n", open)
		body, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": block})
		for range 40 {
			if r.Context().Err() != nil {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", body)
			_ = http.NewResponseController(w).Flush()
		}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-team-limit@awwo.invalid")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
	prefix := "/tenants/" + tid
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "flood", "operationId": "reasoning-team-limit"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "failed")
	if done["error"] != "output_limit" || done["output"] != "" {
		t.Fatalf("an unbounded member scratchpad was not stopped: %#v", done)
	}
}

// The output cap is the bound on what a provider may produce. Counting only the
// text that survives stripping would silently remove it, letting a runaway
// reasoner stream without limit until the run deadline instead.
func TestPostgresReasoningVolumeStillCountsAgainstTheOutputLimit(t *testing.T) {
	block := strings.Repeat("n", 64*1024)
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		open, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": "<think>"})
		fmt.Fprintf(w, "data: %s\n\n", open)
		body, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": block})
		for range 40 {
			if r.Context().Err() != nil {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", body)
			_ = http.NewResponseController(w).Flush()
		}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-limit@awwo.invalid")
	_, _, sid := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "flood", "operationId": "reasoning-limit-operation"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "failed")
	if done["error"] != "output_limit" || done["output"] != "" {
		t.Fatalf("unbounded scratchpad was not stopped: %#v", done)
	}
}

// Upstream text reaches the next agent's prompt verbatim when the source node has
// no contract, so those two injection points need the same normalization as the
// contract reader.
func TestReasoningPreambleNeverReachesADownstreamPrompt(t *testing.T) {
	const secret = "upstream scratchpad 88123"
	leaked := "<think>" + secret + "</think>\nUPSTREAM-ANSWER"

	up := graphNode{ID: "up", Kind: "session", Title: "upstream"}
	down := graphNode{ID: "down", Kind: "session", Title: "downstream"}
	d := graphDocument{Nodes: []graphNode{up, down},
		Edges: []graphEdge{{ID: "e", FromNode: "up", FromPort: "result", ToNode: "down", ToPort: "context", DataType: "text"}}}
	prompt, err := graphPrompt(down, d, map[string]string{"up": leaked})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(prompt, secret) || strings.Contains(prompt, "<think>") || !strings.Contains(prompt, "UPSTREAM-ANSWER") {
		t.Fatalf("graph prompt carried the scratchpad: %s", prompt)
	}

	raw := []byte(`{"nodes":[{"id":"a","kind":"session","title":"a","binding":{"agentId":"agent"}},{"id":"b","kind":"session","title":"b","binding":{"agentId":"agent"}},{"id":"source","kind":"session","title":"source","lastOutput":{"text":` +
		mustJSON(leaked) + `,"partial":false}}],"edges":[{"id":"input","fromNode":"source","fromPort":"result","toNode":"a","toPort":"context","dataType":"text"}]}`)
	_, _, seeds, e := parseCollaborationGraph(raw, []string{"a", "b"}, &collaborationPolicy{Goal: "goal", Rounds: 1, SynthesizerNodeID: "a"})
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(seeds["a"], secret) || strings.Contains(seeds["a"], "<think>") || !strings.Contains(seeds["a"], "UPSTREAM-ANSWER") {
		t.Fatalf("collaboration seed carried the scratchpad: %s", seeds["a"])
	}
}

func mustJSON(v string) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

// A cached upstream whose whole text was a scratchpad has no usable input left, so it
// is reported as missing instead of seeding the next agent with an empty operand.
func TestScratchpadOnlyCachedInputIsReportedMissing(t *testing.T) {
	raw := []byte(`{"nodes":[{"id":"a","kind":"session","title":"a","binding":{"agentId":"agent"}},{"id":"b","kind":"session","title":"b","binding":{"agentId":"agent"}},{"id":"source","kind":"session","title":"source","lastOutput":{"text":` +
		mustJSON("<think>only reasoning 88123</think>\n \n") + `,"partial":false}}],"edges":[{"id":"input","fromNode":"source","fromPort":"result","toNode":"a","toPort":"context","dataType":"text"}]}`)
	_, _, seeds, e := parseCollaborationGraph(raw, []string{"a", "b"}, &collaborationPolicy{Goal: "goal", Rounds: 1, SynthesizerNodeID: "a"})
	if e == nil || !strings.Contains(e.Error(), "Missing completed cached input") {
		t.Fatalf("a scratchpad-only cached input was accepted as %#v (%v)", seeds, e)
	}
}

// Operator-authored text is not model output and is never normalized. A form node's
// projected text always opens with its field label, which is what keeps the
// leading-span rule from ever reaching a value the operator typed.
func TestFormInputWithAReasoningTagReachesTheDownstreamPromptVerbatim(t *testing.T) {
	const typed = "<think>example</think> keep every byte"
	raw := `{"nodes":[{"id":"brief","kind":"form","title":"Brief","fields":[{"id":"scope","label":"Scope","value":` + mustJSON(typed) +
		`}]},{"id":"down","kind":"session","title":"downstream"}],"edges":[{"id":"e","fromNode":"brief","fromPort":"result","toNode":"down","toPort":"context","dataType":"text"}]}`
	var d graphDocument
	if e := json.Unmarshal([]byte(raw), &d); e != nil {
		t.Fatal(e)
	}
	prompt, e := graphPrompt(d.Nodes[1], d, map[string]string{"brief": formOutput(d.Nodes[0])})
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(prompt, "Scope: "+typed) {
		t.Fatalf("form input was rewritten on the way into the prompt: %s", prompt)
	}
}

// Normalizing a cached input folded the form branch into the shared emptiness check,
// which is only safe because a form's projection is never empty. Pin that: an empty
// form still seeds a collaboration instead of being reported as a missing input.
func TestEmptyFormNodeStillSeedsACollaboration(t *testing.T) {
	for name, fields := range map[string]string{"no fields": `[]`, "unlabelled and unfilled": `[{"id":"f","label":"","value":""}]`} {
		var d graphDocument
		if e := json.Unmarshal([]byte(`{"nodes":[{"id":"brief","kind":"form","title":"Brief","fields":`+fields+`}],"edges":[]}`), &d); e != nil {
			t.Fatal(e)
		}
		if strings.TrimSpace(formOutput(d.Nodes[0])) == "" {
			t.Fatalf("%s: a form projected nothing, so an operator's node would read as missing", name)
		}
		raw := []byte(`{"nodes":[{"id":"a","kind":"session","title":"a","binding":{"agentId":"agent"}},{"id":"b","kind":"session","title":"b","binding":{"agentId":"agent"}},{"id":"brief","kind":"form","title":"Brief","fields":` + fields +
			`}],"edges":[{"id":"input","fromNode":"brief","fromPort":"data","toNode":"a","toPort":"context","dataType":"text"}]}`)
		_, _, seeds, e := parseCollaborationGraph(raw, []string{"a", "b"}, &collaborationPolicy{Goal: "goal", Rounds: 1, SynthesizerNodeID: "a"})
		if e != nil || !strings.Contains(seeds["a"], "Brief") {
			t.Fatalf("%s: empty form rejected as a collaboration input: %#v (%v)", name, seeds, e)
		}
	}
}

// Normalization runs before the fence unwrap, deliberately. A fence is content, so a
// deliverable that opens with a fenced example of a reasoning tag is not a preamble and
// keeps every byte. A real leak precedes any fence the model then writes, and that shape
// is covered above, so refusing to look inside a fence misses nothing.
func TestFencedReasoningExampleSurvivesTheContractReader(t *testing.T) {
	single := graphNode{ID: "writer", Kind: "session", Contract: &graphContract{Version: 1,
		Outputs: []graphField{{ID: "result", Type: "markdown", Required: true}}}}
	for _, doc := range []string{
		"```\n<think>example</think>\n```",
		"```html\n<think>example</think>\n```",
		"Reasoning models mark scratchpads like this:\n\n```\n<think>x</think>\n```",
	} {
		vals, _, err := graphOutputFiles(single, doc)
		if err != nil || vals["result"] != doc {
			t.Fatalf("documentation deliverable rewritten to %q (%v)", vals["result"], err)
		}
	}
}

// A review team publishes the reviewer's approved string as the entire run output, so
// that nested value becomes a deliverable without crossing the runtime boundary itself:
// the boundary only saw the verdict envelope around it.
func TestReviewTeamVerdictIsNormalizedWithoutRewritingLegitimateContent(t *testing.T) {
	for name, c := range map[string]struct{ verdict, want string }{
		"scratchpad inside the verdict": {`{"approved":true,"output":"<think>hidden 88123</think>\nAPPROVED"}`, "APPROVED"},
		"legitimate mention":            {`{"approved":true,"output":"Use <think> to mark a scratchpad."}`, "Use <think> to mark a scratchpad."},
	} {
		out, e := runTeam(context.Background(), fixtureTeam("review"), "TASK", func(_ context.Context, m teamMember, _, _ int, _ teamTurnInput) (string, error) {
			if m.ID == "judge" {
				return c.verdict, nil
			}
			return "draft", nil
		})
		if e != nil || out != c.want {
			t.Fatalf("%s: got %q (%v), want %q", name, out, e, c.want)
		}
	}
}

// Re-running only part of a canvas projects the untouched nodes' saved text as their
// own deliverable for this run. A document saved before stripping existed still
// carries a preamble there, so it is healed on the way in and not only where a
// contract reads it.
func TestPostgresCachedGraphNodeOutputIsHealedBeforeItIsProjected(t *testing.T) {
	const secret = "cached scratchpad 88123"
	prompts := make(chan string, 4)
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		prompts <- call.Prompt
		completePi(w, "MERGED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-cached@awwo.invalid")
	cid, doc := graphFixture(t, h, c, tid)
	for _, raw := range doc["nodes"].([]any) {
		n := raw.(map[string]any)
		n["lastOutput"] = map[string]any{"text": "<think>" + secret + "</think>\nCACHE-" + n["id"].(string), "source": "run", "at": 1}
	}
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": "Cached", "document": doc, "version": 1}, 200)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "reasoning-cached-operation", "scope": []string{"merge"}}, 202)["id"].(string)
	done := awaitGraph(t, h, c, base+"/"+gid, "completed")
	for _, raw := range done["nodes"].([]any) {
		n := raw.(map[string]any)
		nid := n["nodeId"].(string)
		if nid == "merge" {
			continue
		}
		if n["state"] != "cached" || n["output"] != "CACHE-"+nid {
			t.Fatalf("cached node projected its scratchpad: %#v", n)
		}
		assertNoScratchpad(t, secret, map[string]string{
			nid + " graph_run_nodes.output": scalar(t, h, "SELECT output FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3", tid, gid, nid),
		})
	}
	select {
	case prompt := <-prompts:
		if strings.Contains(prompt, secret) || strings.Contains(prompt, "<think>") || !strings.Contains(prompt, "CACHE-a") {
			t.Fatalf("downstream prompt carried the scratchpad: %s", prompt)
		}
	default:
		t.Fatal("the downstream node never ran")
	}
}

// Cancelling a graph whose child already committed projects that child's stored run
// output. The contract check there reads a normalized copy, so the recorded
// deliverable must be normalized too or the two disagree about what was delivered.
func TestPostgresCancelledGraphHealsAStoredChildOutput(t *testing.T) {
	const secret = "child scratchpad 88123"
	h := newHarness(t, "http://127.0.0.1:1")
	c, tid, actor := h.register(t, "reasoning-reconcile@awwo.invalid")
	cid, doc := graphFixture(t, h, c, tid)
	gid, ids := seedUnprojectedGraph(t, h, tid, cid, actor, doc, map[string]string{"a": "completed"})
	if _, e := h.db.Exec(context.Background(), "UPDATE runs SET output=$3 WHERE tenant_id=$1 AND id=$2", tid, ids["a"], "<think>"+secret+"</think>\nCHILD-ANSWER"); e != nil {
		t.Fatal(e)
	}
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	h.request(t, c, "POST", base+"/"+gid+"/cancel", map[string]any{}, 200)
	done := awaitGraph(t, h, c, base+"/"+gid, "cancelled")
	for _, raw := range done["nodes"].([]any) {
		n := raw.(map[string]any)
		if n["nodeId"] != "a" {
			continue
		}
		if n["state"] != "done" || n["output"] != "CHILD-ANSWER" {
			t.Fatalf("reconciled child kept its scratchpad: %#v", n)
		}
	}
	assertNoScratchpad(t, secret, map[string]string{
		"graph_run_nodes.output": scalar(t, h, "SELECT output FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id='a'", tid, gid),
	})
}

// A collaboration turn's text becomes an operand inside the next agent's prompt, and
// it is read straight from the child run rather than from the node output the
// executor already healed.
func TestPostgresCollaborationTurnOperandsAreHealed(t *testing.T) {
	const secret = "candidate scratchpad 88123"
	h := newHarness(t, "http://127.0.0.1:1")
	c, tid, actor := h.register(t, "reasoning-operand@awwo.invalid")
	cid, doc := graphFixture(t, h, c, tid)
	gid, ids := seedUnprojectedGraph(t, h, tid, cid, actor, doc, map[string]string{"a": "completed", "b": "completed"})
	ctx := context.Background()
	p := collaborationPolicy{Goal: "Heal the operands", Rounds: 1, SynthesizerNodeID: "a"}
	raw, _ := json.Marshal(p)
	tx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "UPDATE graph_runs SET collaboration=$3,scope='[\"a\",\"b\"]' WHERE tenant_id=$1 AND id=$2", tid, gid, raw); e != nil {
		t.Fatal(e)
	}
	if e = seedCollaboration(ctx, tx, tid, gid, []string{"a", "b"}, &p, map[string]string{"a": "A", "b": "B"}); e != nil {
		t.Fatal(e)
	}
	for _, nid := range []string{"a", "b"} {
		if _, e = tx.Exec(ctx, "UPDATE graph_collaboration_turns SET state='completed',run_id=$3 WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$4 AND phase='proposal'", tid, gid, ids[nid], nid); e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, "UPDATE runs SET output=$3 WHERE tenant_id=$1 AND id=$2", tid, ids[nid], "<think>"+secret+"</think>\nCANDIDATE-"+nid); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	turns, e := h.a.collaborationTurns(ctx, tid, gid)
	if e != nil {
		t.Fatal(e)
	}
	review := collaborationTurn{}
	for _, turn := range turns {
		if turn.Phase == "proposal" && turn.Output != "CANDIDATE-"+turn.NodeID {
			t.Fatalf("candidate kept its scratchpad: %#v", turn)
		}
		if turn.Phase == "review" {
			review = turn
		}
	}
	prompt, e := collaborationPrompt(p, review, "seed", turns)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(prompt, secret) || strings.Contains(prompt, "<think>") || !strings.Contains(prompt, "CANDIDATE-a") {
		t.Fatalf("review prompt carried the scratchpad: %s", prompt)
	}
}

// Output written before this change keeps its preamble. Every reader of it applies
// the same normalization so that healing it cannot make the contract validator and
// the artifact writer disagree, and so re-reading a delivered node cannot turn a
// settled canvas into a permanent failure.
func TestStoredReasoningPreambleIsHealedByEveryContractReader(t *testing.T) {
	single := graphNode{ID: "writer", Kind: "session", Contract: &graphContract{Version: 1,
		Outputs: []graphField{{ID: "result", Type: "markdown", Required: true}}}}
	for name, c := range map[string]struct{ output, want string }{
		// The plain-text fallback recorded the whole leaked string as the deliverable.
		"single text fallback": {"<think>scratch 88123</think>\nThe answer is 4.", "The answer is 4."},
		// The fence unwrap requires position zero, so a fenced payload was missed.
		"fenced json":          {"<think>scratch</think>\n```json\n{\"result\":\"4\"}\n```", "4"},
		"fenced bare":          {"<think>scratch</think>\n```\n{\"result\":\"4\"}\n```", "4"},
		"prefilled open tag":   {"</think>\nThe answer is 4.", "The answer is 4."},
		"reopened span":        {"<think>a</think>\n<think>scratch 88123</think>\nThe answer is 4.", "The answer is 4."},
		"no preamble":          {"The answer is 4.", "The answer is 4."},
		"legitimate tag later": {"Use <think> to open a scratchpad.", "Use <think> to open a scratchpad."},
	} {
		vals, _, err := graphOutputFiles(single, c.output)
		if err != nil || vals["result"] != c.want {
			t.Fatalf("%s: got %q (%v), want %q", name, vals["result"], err, c.want)
		}
	}

	// An html field rejects a fragment, so a preamble used to fail the whole node.
	page := graphNode{ID: "page", Kind: "session", Contract: &graphContract{Version: 1,
		Outputs: []graphField{{ID: "page", Type: "html", Required: true}}}}
	const document = "<!DOCTYPE html><html><head></head><body>ok</body></html>"
	if vals, _, err := graphOutputFiles(page, "<think>plan</think>\n"+document); err != nil || vals["page"] != document {
		t.Fatalf("html deliverable behind a preamble: %q (%v)", vals["page"], err)
	}

	// Validation and storage read the same text, so both must accept it.
	files := fileNode(true)
	leaked := "<think>plan the file 88123</think>\n" + `{"summary":"done","artifact":{"name":"main.go","content":"package main\n"}}`
	vals, pending, err := graphOutputFiles(files, leaked)
	if err != nil || len(pending) != 1 || pending[0].Content != "package main\n" || vals["summary"] != "done" {
		t.Fatalf("file contract behind a preamble: %#v %#v %v", vals, pending, err)
	}
}
