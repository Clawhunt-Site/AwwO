package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// A review team's approved verdict replaces the run's whole published text, so it is a
// write boundary and not a stored value being healed. The reader helper is deliberately
// lenient about an unterminated span and about a span that leaves nothing behind, which
// is right when reading an old row and wrong here: it would publish the scratchpad, or
// report a completed run with no deliverable at all.
func TestReviewTeamVerdictRefusesAScratchpadInsteadOfPublishingIt(t *testing.T) {
	const secret = "tenant secret 88123"
	for name, verdict := range map[string]string{
		"unterminated span":          `{"approved":true,"output":"<think>` + secret + `"}`,
		"scratchpad only":            `{"approved":true,"output":"<think>` + secret + `</think>"}`,
		"scratchpad then whitespace": `{"approved":true,"output":"<think>` + secret + `</think>\n  "}`,
		"reopened then unterminated": `{"approved":true,"output":"<think>a</think>\n<think>` + secret + `"}`,
	} {
		out, err := runTeam(context.Background(), fixtureTeam("review"), "TASK",
			func(_ context.Context, m teamMember, _, _ int, _ teamTurnInput) (string, error) {
				if m.ID == "judge" {
					return verdict, nil
				}
				return "draft", nil
			})
		if err == nil || err.Error() != "reasoning_only_output" {
			t.Fatalf("%s: published %q with err %v, want a reasoning_only_output refusal", name, out, err)
		}
		if strings.Contains(out, secret) || out != "" {
			t.Fatalf("%s: returned %q instead of nothing", name, out)
		}
	}
}

// Whitespace ahead of a span is the filter's entry gate, and model output chooses those
// bytes. Anything the gate mistakes for content disables stripping for the whole answer,
// so a single invisible rune must not be a bypass.
func TestAReasoningPreambleBehindInvisibleWhitespaceIsStillRemoved(t *testing.T) {
	const secret = "invisible bypass 88123"
	for name, prefix := range map[string]string{
		"no-break space":    "\u00a0",
		"ideographic space": "\u3000",
		"en quad":           "\u2000",
		"narrow no-break":   "\u202f",
		"zero width space":  "\u200b",
		"byte order mark":   "\ufeff",
		"ascii and unicode": " \t\u00a0\n\u3000",
	} {
		text := prefix + "<think>" + secret + "</think>ANSWER"
		answer := stripReasoningPreamble(text)
		if answer != "ANSWER" {
			t.Fatalf("%s: one-shot returned %q, want ANSWER", name, answer)
		}
		if delivered, ok := reasoningAnswer(text); !ok || delivered != "ANSWER" {
			t.Fatalf("%s: write boundary returned %q ok=%v", name, delivered, ok)
		}
		// The stream may withhold bytes it has not committed to, so what it emits has to
		// be a prefix of the one-shot answer rather than equal to it — that prefix
		// relation is what the completed-event cross-check depends on. What it must never
		// do is emit any part of the scratchpad.
		for split := 1; split < len(text); split++ {
			var stream reasoningStream
			streamed := stream.push(text[:split]) + stream.push(text[split:])
			if !strings.HasPrefix(answer, streamed) {
				t.Fatalf("%s split %d: streamed %q is not a prefix of %q", name, split, streamed, answer)
			}
			if strings.Contains(streamed, secret) || strings.Contains(streamed, "<think") {
				t.Fatalf("%s split %d: streamed the scratchpad: %q", name, split, streamed)
			}
		}
	}
	// The same runes in front of real content are content, and survive byte for byte.
	for _, text := range []string{"\u00a0Hello", "\u3000\u3000table row", "\ufeffdocument", "\u00a0<b>markup</b>"} {
		if got := stripReasoningPreamble(text); got != text {
			t.Fatalf("legitimate leading whitespace was altered: %q -> %q", text, got)
		}
	}
}

// Whitespace after a close tag is discarded rather than withheld, and the streaming filter
// discards it in a different place from the one-shot pass. If the two disagree about which
// runes are discardable, the streamed text stops being a prefix of the one-shot answer and
// the completed event is rejected as inconsistent_runtime_output.
func TestWhitespaceAfterASpanIsDiscardedIdenticallyByBothPasses(t *testing.T) {
	const secret = "trailing bypass 88123"
	for name, gap := range map[string]string{
		"newline":           "\n",
		"no-break space":    "\u00a0",
		"ideographic space": "\u3000",
		"mixed":             " \u00a0\n\u3000\t",
		"none":              "",
	} {
		text := "<think>" + secret + "</think>" + gap + "ANSWER"
		answer := stripReasoningPreamble(text)
		if answer != "ANSWER" {
			t.Fatalf("%s: one-shot returned %q, want ANSWER", name, answer)
		}
		for split := 1; split < len(text); split++ {
			var stream reasoningStream
			streamed := stream.push(text[:split]) + stream.push(text[split:])
			if !strings.HasPrefix(answer, streamed) {
				t.Fatalf("%s split %d: streamed %q is not a prefix of %q", name, split, streamed, answer)
			}
			if strings.Contains(streamed, secret) {
				t.Fatalf("%s split %d: streamed the scratchpad: %q", name, split, streamed)
			}
		}
	}
	// A zero-width joiner after the span belongs to the answer it introduces, so unlike
	// whitespace it must survive: deleting it would corrupt an emoji or an Indic cluster.
	for _, text := range []string{"<think>x</think>\u200djoined", "<think>x</think>\ufeffdocument"} {
		got := stripReasoningPreamble(text)
		want := text[strings.Index(text, "</think>")+len("</think>"):]
		if got != want {
			t.Fatalf("a meaningful zero-width rune after the span was dropped: %q -> %q, want %q", text, got, want)
		}
	}
}

// Re-running part of a canvas projects untouched nodes' saved text as their deliverable.
// A row written before stripping existed may hold nothing but a scratchpad, which heals
// to empty; projecting that would hand a downstream agent an empty operand and settle the
// graph as completed, claiming a deliverable that was never produced.
func TestPostgresCachedScratchpadOnlyNodeIsBlockedRatherThanProjectedEmpty(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		t.Error("a downstream node ran on an empty cached operand")
		completePi(w, "MERGED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-cached-empty@awwo.invalid")
	cid, doc := graphFixture(t, h, c, tid)
	for _, raw := range doc["nodes"].([]any) {
		n := raw.(map[string]any)
		n["lastOutput"] = map[string]any{"text": "<think>cached scratchpad 88123</think>\n \n", "source": "run", "at": 1}
	}
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": "Cached", "document": doc, "version": 1}, 200)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	gid := h.request(t, c, "POST", base, map[string]any{"operationId": "reasoning-cached-empty-op", "scope": []string{"merge"}}, 202)["id"].(string)
	done := awaitGraph(t, h, c, base+"/"+gid, "failed")
	states := map[string]string{}
	for _, raw := range done["nodes"].([]any) {
		n := raw.(map[string]any)
		states[n["nodeId"].(string)] = n["state"].(string)
		if n["output"] != "" {
			t.Fatalf("a node projected output from a scratchpad-only row: %#v", n)
		}
	}
	if states["a"] != "blocked" || states["b"] != "blocked" || states["merge"] == "done" {
		t.Fatalf("a scratchpad-only cached row did not block the run: %v", states)
	}
}

// The review boundary now refuses instead of returning a value, so the refusal has to land
// as a real terminal run: a value return and an error return take different paths through
// turn persistence and accounting, and a run left running or reported completed with
// nothing would be the very state the refusal exists to prevent.
func TestPostgresReviewVerdictRefusalIsATerminalFailureWithNothingStored(t *testing.T) {
	const secret = "verdict scratchpad 88123"
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		if strings.Contains(call.SystemPrompt, "judge") || strings.Contains(call.Prompt, "review") {
			verdict, _ := json.Marshal(map[string]any{"approved": true, "output": "<think>" + secret + "</think>"})
			completePi(w, string(verdict))
			return
		}
		completePi(w, "draft")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "reasoning-review-refusal@awwo.invalid")
	_, _, sid := installTeam(t, h, c, tid, fixtureTeam("review"))
	prefix := "/tenants/" + tid
	id := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": "deliver", "operationId": "reasoning-review-refusal"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "failed")
	if done["output"] != "" {
		t.Fatalf("a refused verdict still published an output: %#v", done)
	}
	// The run must carry a terminal error rather than settling silently; which code depends
	// on how the review loop reports an undeliverable verdict, so accept either the specific
	// refusal or the review path's own exhaustion, but never an empty error.
	if code, _ := done["error"].(string); code == "" {
		t.Fatalf("a refused verdict produced no error code: %#v", done)
	}
	// The deliverable sinks must be clean. The judge's own turn row is deliberately not
	// asserted here: its output is the verdict envelope the member literally produced, and the
	// scratchpad sits inside a JSON field of it. Reaching into that field would be the global
	// rewrite this design refuses, because no rule can tell an embedded scratchpad from an
	// answer that quotes the tag. So the envelope is retained as the member's record while the
	// run refuses to publish it — that boundary is what this test pins.
	assertNoScratchpad(t, secret, map[string]string{
		"runs.output":      scalar(t, h, "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, id),
		"messages.content": scalar(t, h, "SELECT coalesce(string_agg(content,'|'),'') FROM messages WHERE tenant_id=$1 AND run_id=$2", tid, id),
		"run_events.data":  scalar(t, h, "SELECT coalesce(string_agg(data::text,'|'),'') FROM run_events WHERE tenant_id=$1 AND run_id=$2", tid, id),
	})
}
