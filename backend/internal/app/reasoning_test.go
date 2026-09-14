package app

import (
	"math/rand"
	"strings"
	"testing"
)

// Anything a deliverable may legitimately contain must survive byte for byte.
// Over-stripping is the failure mode that silently corrupts a document about
// reasoning tags, code carrying the literal string, or an HTML page with a
// <think> element, so these cases are pinned first.
func TestReasoningPreambleKeepsLegitimateContent(t *testing.T) {
	for name, text := range map[string]string{
		"documented after prose":  "Reasoning models mark scratchpads like this:\n\n```\n<think>hidden</think>\n```\n\nKeep it.",
		"tag mid sentence":        "The model emits <think> before its answer and </think> after it.",
		"code containing the tag": "const OPEN = \"<think>\";\nfunction strip(s) { return s.replace(OPEN, \"\"); }",
		"fenced first":            "```html\n<think>example</think>\n```",
		"html document":           "<!DOCTYPE html><html><head><title>t</title></head><body><think>element</think></body></html>",
		"similar element":         "<think-piece>An essay</think-piece>",
		"similar attribute":       "<thinking about it>not a tag</thinking about it>",
		"unrelated markup":        "<p>hello</p>",
		"json deliverable":        `{"result":"done"}`,
		"plain answer":            "The answer is 4.",
		"span after content":      "The answer is 4.\n<think>a later note</think>",
		"span after one word":     "Answer: <think>a</think>4",
		"leading newline":         "\nThe answer is 4.",
		"empty":                   "",
		"whitespace only":         "  \n\t",
		"bare open bracket":       "<",
		"partial tag only":        "<thin",
		"orphan close mid text":   "I reasoned about it.</think>\nThe answer is 4.",
		// Whole deliverables, not snippets: a corrupted document is the failure mode
		// that would ship silently, and it only shows up on realistic text where the
		// tag appears in prose, in code and inside markup at once.
		"guide about reasoning tags": "# Reasoning models\n\nQwen and R1 wrap a scratchpad in `<think>` ... `</think>`.\n\n" +
			"To strip it:\n\n```go\nif strings.HasPrefix(s, \"<think>\") { /* ... */ }\n```\n\nA `</think>` may also arrive alone.\n",
		"source file naming the tag": "OPEN = \"<think>\"\nCLOSE = \"</think>\"\n\n\ndef strip(text: str) -> str:\n" +
			"    if text.startswith(OPEN):\n        return text.split(CLOSE, 1)[-1]\n    return text\n",
		"page documenting the tag": "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"><title>Think tags</title></head>\n" +
			"<body>\n<h1>The &lt;think&gt; tag</h1>\n<pre><think>hidden</think></pre>\n</body>\n</html>\n",
		"json carrying both tags": `{"open":"<think>","close":"</think>","note":"<think>not a preamble</think>"}`,
		"quoted tag opens a line": "\"<think>\" is how it starts.",
	} {
		if got, verdict := classifyReasoning(text); got != text || verdict != reasoningAbsent {
			t.Errorf("%s: rewrote legitimate content to %q (verdict %d)", name, got, verdict)
		}
		if got := stripReasoningPreamble(text); got != text {
			t.Errorf("%s: stripReasoningPreamble rewrote %q to %q", name, text, got)
		}
	}
}

func TestReasoningPreambleRemovesLeadingSpan(t *testing.T) {
	for name, c := range map[string]struct{ in, want string }{
		"simple":              {"<think>scratch</think>The answer is 4.", "The answer is 4."},
		"newline after close": {"<think>scratch</think>\n\nThe answer is 4.", "The answer is 4."},
		"indented":            {"  \n<think>scratch</think>\nThe answer is 4.", "The answer is 4."},
		"long form tag":       {"<thinking>scratch</thinking>\nThe answer is 4.", "The answer is 4."},
		"mixed case":          {"<THINK>scratch</Think>\nThe answer is 4.", "The answer is 4."},
		"empty span":          {"<think></think>The answer is 4.", "The answer is 4."},
		"false close inside":  {"<think>I will not write </thin yet</think>\nThe answer is 4.", "The answer is 4."},
		"tag inside span":     {"<think>consider <think> nesting</think>\nThe answer is 4.", "The answer is 4."},
		"json deliverable":    {"<think>plan the shape</think>\n{\"result\":\"the real answer\"}", `{"result":"the real answer"}`},
		"fenced deliverable":  {"<think>plan</think>\n```json\n{\"a\":1}\n```", "```json\n{\"a\":1}\n```"},
		"html deliverable":    {"<think>plan</think>\n<!DOCTYPE html><html><head></head><body>x</body></html>", "<!DOCTYPE html><html><head></head><body>x</body></html>"},
		"answer mentions tag": {"<think>scratch</think>\nUse <think> to open a scratchpad.", "Use <think> to open a scratchpad."},
		"prefilled open tag":  {"</think>\nThe answer is 4.", "The answer is 4."},
		"prefilled long form": {"</thinking>The answer is 4.", "The answer is 4."},
		"indented prefilled":  {"\n </think>\n\nThe answer is 4.", "The answer is 4."},
		// A chat template that reopens thinking has still produced only preamble, so
		// every span before the first content byte goes. Keeping just the first one
		// would publish the rest and make this normalization non-idempotent.
		"reopened span":       {"<think>a</think><think>secret 88123</think>The answer is 4.", "The answer is 4."},
		"reopened after gap":  {"  <think>a</think>\n \t<thinking>b</thinking>\n\nThe answer is 4.", "The answer is 4."},
		"prefilled then span": {"</think>\n<think>b</think>4", "4"},
		"three spans":         {"<think>a</think><think>b</think><think>c</think>4", "4"},
	} {
		got, verdict := classifyReasoning(c.in)
		if got != c.want || verdict != reasoningRemoved {
			t.Errorf("%s: got %q (verdict %d), want %q", name, got, verdict, c.want)
		}
		// Normalization has to be idempotent: several readers apply it to the same
		// stored text, and an answer that itself opens with a tag must not lose more.
		if again := stripReasoningPreamble(got); again != got {
			t.Errorf("%s: not idempotent, %q became %q", name, got, again)
		}
	}
}

// An unterminated span proves nothing, so the pure pass must never eat the text.
// Refusing to publish it is a separate, explicit policy decision.
func TestReasoningNeverEatsAnUnterminatedSpan(t *testing.T) {
	for _, in := range []string{
		"<think>I will never close this tag and the stream just ends.",
		"<thinking>truncated",
		"  <think>",
		"<think>a </thin b </thinkin c",
	} {
		got, verdict := classifyReasoning(in)
		if got != in || verdict != reasoningOpenEnded {
			t.Fatalf("unterminated span altered: %q became %q (verdict %d)", in, got, verdict)
		}
		if got := stripReasoningPreamble(in); got != in {
			t.Fatalf("stripReasoningPreamble discarded %q as %q", in, got)
		}
		if answer, delivered := reasoningAnswer(in); delivered || answer != "" {
			t.Fatalf("unterminated span was publishable: %q -> %q, %v", in, answer, delivered)
		}
	}
	// A closed span followed by an unterminated one: the closed span is proven
	// scratchpad and goes, the open one is kept for a further pass rather than
	// guessed at, and either way nothing is publishable.
	for in, want := range map[string]string{
		"<think>a</think><think>b never closed":   "<think>b never closed",
		"<think>a</think>\n  <thinking>truncated": "<thinking>truncated",
		"</think>\n<think>":                       "<think>",
	} {
		got, verdict := classifyReasoning(in)
		if got != want || verdict != reasoningOpenEnded {
			t.Fatalf("reopened unterminated span: %q became %q (verdict %d), want %q", in, got, verdict, want)
		}
		if again := stripReasoningPreamble(got); again != got {
			t.Fatalf("not idempotent, %q became %q", got, again)
		}
		if answer, delivered := reasoningAnswer(in); delivered || answer != "" {
			t.Fatalf("reopened unterminated span was publishable: %q -> %q, %v", in, answer, delivered)
		}
	}
}

func TestReasoningAnswerRefusesScratchpadOnlyOutput(t *testing.T) {
	for _, in := range []string{"<think>only reasoning</think>", "<think>only reasoning</think>\n\n  ", "</think>", "<thinking>x</thinking>\t"} {
		if answer, delivered := reasoningAnswer(in); delivered || answer != "" {
			t.Fatalf("scratchpad-only output was publishable: %q -> %q, %v", in, answer, delivered)
		}
	}
	// An answer is publishable even when the runtime sent nothing, which is the
	// pre-existing empty-completion behaviour and must not change.
	for _, in := range []string{"", "   ", "The answer is 4.", "<think>x</think>\n4"} {
		answer, delivered := reasoningAnswer(in)
		if !delivered {
			t.Fatalf("refused a real answer: %q", in)
		}
		if want := stripReasoningPreamble(in); answer != want {
			t.Fatalf("answer %q does not match normalization %q", answer, want)
		}
	}
}

// Indentation is withheld together with the span it precedes, so it has to be
// buffered; the bound that keeps the streaming buffer O(1) must apply to the
// one-shot pass too, or the two disagree and the prefix invariant below breaks.
func TestReasoningIndentBoundIsSharedByBothPasses(t *testing.T) {
	atLimit := strings.Repeat(" ", maxReasoningIndent) + "<think>x</think>answer"
	if got, verdict := classifyReasoning(atLimit); got != "answer" || verdict != reasoningRemoved {
		t.Fatalf("span at the indent limit not removed: %q (verdict %d)", got, verdict)
	}
	past := strings.Repeat(" ", maxReasoningIndent+1) + "<think>x</think>answer"
	if got, verdict := classifyReasoning(past); got != past || verdict != reasoningAbsent {
		t.Fatalf("span past the indent limit was removed: %q (verdict %d)", got, verdict)
	}
	var s reasoningStream
	if got := s.push(past); got != past {
		t.Fatalf("streamed pass disagreed past the indent limit: %q", got)
	}
}

func reasoningCases() []string {
	return []string{
		"",
		"The answer is 4.",
		"<think>scratch</think>The answer is 4.",
		"<think>scratch</think>\n\nThe answer is 4.",
		"  \n<think>tenant billing id 88123, do not reveal.</think>\n{\"summary\":\"done\"}",
		"<thinking>Let me reason. 2+2=4.</thinking>\nThe answer is 4.",
		"<THINK>upper</THINK>lower",
		"<think></think>x",
		"<think>a </thin b</think>c",
		"<think>never closed and the stream ends here",
		"</think>\nThe answer is 4.",
		"</thinking>4",
		"Reasoning models mark scratchpads like this:\n\n```\n<think>x</think>\n```\n\nKeep it.",
		"<!DOCTYPE html><html><head></head><body><think>element</think></body></html>",
		"<think-piece>essay</think-piece>",
		"<thinking about it>not a tag</thinking about it>",
		"<p>hello</p>",
		"<",
		"<t",
		"<thi",
		"</thi",
		"   ",
		"\n\n\n",
		strings.Repeat(" ", maxReasoningIndent) + "<think>x</think>answer",
		strings.Repeat(" ", maxReasoningIndent+2) + "plain",
		"<think>" + strings.Repeat("scratchpad ", 400) + "</think>\nfinal",
		"I reasoned.</think>\nThe answer is 4.",
		"<think>a</think><think>b</think>The answer is 4.",
		"  <think>a</think>\n \t<thinking>b</thinking>\n\nThe answer is 4.",
		"</think>\n<think>b</think>4",
		"<think>a</think><think>b never closed",
		"<think>a</think>Hello<think>later</think>",
		"The answer is 4.\n<think>a later note</think>",
		// Whole deliverables, with and without a real leak in front of them, so the
		// chunking invariants below are exercised on documents rather than snippets.
		"# Reasoning\n\nQwen wraps a scratchpad in `<think>` ... `</think>`.\n\n```go\ns := \"<think>\"\n```\n",
		"<think>plan the page</think>\n<!DOCTYPE html>\n<html><body><pre><think>x</think></pre></body></html>\n",
		"</think>\nOPEN = \"<think>\"\nCLOSE = \"</think>\"\n",
		`{"open":"<think>","close":"</think>"}`,
	}
}

func chunk(text string, size int) []string {
	if size <= 0 {
		return []string{text}
	}
	parts := []string{}
	for i := 0; i < len(text); i += size {
		end := i + size
		if end > len(text) {
			end = len(text)
		}
		parts = append(parts, text[i:end])
	}
	return parts
}

// This is the invariant the whole design rests on: whatever the stream emits is
// always a prefix of the one-shot result, so the completed-event HasPrefix checks
// in execute and executeTeamTurn keep holding for every possible delta split, and
// the browser never has to withdraw a character it already showed.
func TestReasoningStreamStaysAPrefixOfTheOneShotPass(t *testing.T) {
	for _, text := range reasoningCases() {
		want, verdict := classifyReasoning(text)
		// Several readers normalize the same stored text in sequence, so a second
		// pass must be a no-op or the contract validator and the artifact writer
		// would disagree about what the node actually delivered.
		if again := stripReasoningPreamble(want); again != want {
			t.Fatalf("normalizing %q twice gave %q then %q", text, want, again)
		}
		for _, size := range []int{1, 2, 3, 5, 7, 11, 64, len(text) + 1} {
			var s reasoningStream
			var streamed strings.Builder
			for _, part := range chunk(text, size) {
				streamed.WriteString(s.push(part))
			}
			got := streamed.String()
			if !strings.HasPrefix(want, got) {
				t.Fatalf("chunk %d of %q streamed %q which is not a prefix of %q", size, text, got, want)
			}
			switch s.phase {
			case reasoningPassing:
				// The stream committed to the answer, so both passes must agree.
				if got != want {
					t.Fatalf("chunk %d of %q streamed %q, want %q", size, text, got, want)
				}
			case reasoningInside:
				// Still inside a span the text never closed: nothing may have leaked,
				// and the terminal event decides what happens to it.
				if got != "" || verdict != reasoningOpenEnded {
					t.Fatalf("chunk %d of %q leaked %q from an open span (verdict %d)", size, text, got, verdict)
				}
			default:
				// Still holding back a possible tag, or trailing whitespace after a
				// close tag. Only the bounded buffer may lag behind the one-shot pass.
				if len(want)-len(got) > maxReasoningIndent+maxReasoningTag {
					t.Fatalf("chunk %d of %q withheld %d bytes in phase %d", size, text, len(want)-len(got), s.phase)
				}
			}
		}
	}
}

// Every byte-level split has to behave, including ones that cut a multi-byte rune
// or land inside an opening tag: a real provider split "<think>" as "<th"+"ink>".
func TestReasoningStreamHandlesSplitTagsAndRunes(t *testing.T) {
	deltas := []string{"<th", "ink>", "The user wants a summary", ". Internal note: tenant ", "billing id 88123, do not", " reveal.</think", ">\n{\"summa", "ry\":\"Local stub finished", " the task.\"}"}
	var s reasoningStream
	var out strings.Builder
	for _, d := range deltas {
		out.WriteString(s.push(d))
	}
	if got := out.String(); got != `{"summary":"Local stub finished the task."}` {
		t.Fatalf("split opening tag leaked or corrupted output: %q", got)
	}
	if strings.Contains(out.String(), "88123") {
		t.Fatal("scratchpad reached the emitted stream")
	}
	// Splitting a multi-byte rune must not change the decision either.
	text := "<think>思考</think>答案是四。"
	for _, size := range []int{1, 2, 3, 4} {
		var s reasoningStream
		var got strings.Builder
		for _, part := range chunk(text, size) {
			got.WriteString(s.push(part))
		}
		if got.String() != "答案是四。" {
			t.Fatalf("byte split %d corrupted multi-byte output: %q", size, got.String())
		}
	}
}

// The curated cases above encode what we expect a provider to send. This one attacks
// the same invariants with text nobody wrote on purpose, because the failure that
// matters — a rewrite in the middle of a deliverable — would not announce itself. The
// seed is fixed so a failure is reproducible.
func TestReasoningNeverRewritesAnythingButALeadingSpan(t *testing.T) {
	pieces := []string{"<", ">", "/", "think", "thinking", "<think>", "</think>", "<THINK>", "</Thinking>", " ", "\n", "\t", "a", "答", "```", `{"r":1}`, "<p>", "thin", "<thi", "</thin", "<think", "!"}
	rng := rand.New(rand.NewSource(20260914))
	for range 20000 {
		var b strings.Builder
		for n := rng.Intn(9); n >= 0; n-- {
			b.WriteString(pieces[rng.Intn(len(pieces))])
		}
		text := b.String()
		got, verdict := classifyReasoning(text)
		// Only a prefix may ever be dropped, so the result is always a suffix of the
		// input. This is the property that makes corrupting a document impossible.
		if !strings.HasSuffix(text, got) {
			t.Fatalf("%q was rewritten into %q, which is not a suffix of it", text, got)
		}
		if verdict == reasoningAbsent && got != text {
			t.Fatalf("%q reported no span but changed to %q", text, got)
		}
		if again, _ := classifyReasoning(got); again != got {
			t.Fatalf("%q normalized to %q and then to %q", text, got, again)
		}
		if answer, delivered := reasoningAnswer(text); delivered && (answer != got || verdict == reasoningOpenEnded || (verdict == reasoningRemoved && strings.TrimSpace(got) == "")) {
			t.Fatalf("%q published %q (verdict %d)", text, answer, verdict)
		}
		for _, size := range []int{1, 2, 3, 7} {
			var s reasoningStream
			var out strings.Builder
			for _, part := range chunk(text, size) {
				out.WriteString(s.push(part))
			}
			if !strings.HasPrefix(got, out.String()) {
				t.Fatalf("chunk %d of %q streamed %q, which is not a prefix of %q", size, text, out.String(), got)
			}
			if s.phase == reasoningPassing && out.String() != got {
				t.Fatalf("chunk %d of %q committed %q, want %q", size, text, out.String(), got)
			}
			if s.phase == reasoningInside && out.Len() != 0 {
				t.Fatalf("chunk %d of %q leaked %q from an open span", size, text, out.String())
			}
			if len(s.head) > maxReasoningIndent+maxReasoningTag || len(s.carry) >= maxReasoningTag {
				t.Fatalf("chunk %d of %q buffered head=%d carry=%d", size, text, len(s.head), len(s.carry))
			}
		}
	}
}

// Discarding a scratchpad must not buffer it. Without this bound a model that
// reasons for megabytes would hold all of it in the API's memory.
func TestReasoningStreamDiscardsWithoutBuffering(t *testing.T) {
	var s reasoningStream
	if got := s.push("<think>"); got != "" {
		t.Fatalf("opening tag leaked %q", got)
	}
	for range 512 {
		if got := s.push(strings.Repeat("noise ", 1024)); got != "" {
			t.Fatalf("scratchpad body leaked %q", got)
		}
		if len(s.carry) >= maxReasoningTag || len(s.head) != 0 {
			t.Fatalf("buffer grew while discarding: carry %d head %d", len(s.carry), len(s.head))
		}
	}
	if got := s.push("</think>\nfinal"); got != "final" {
		t.Fatalf("answer after a long scratchpad was %q", got)
	}
}
