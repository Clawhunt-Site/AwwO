package app

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// A reasoning-capable chat template emits its scratchpad inline in the answer
// whenever the provider does not split it into a separate field, and neither worker
// removes it: a worker SDK only lifts reasoning out of the content when the provider
// sends a distinct reasoning field, so an inline span arrives as ordinary text. That
// makes it a deliverable, a contract value, a downstream agent's prompt and a
// tenant-visible transcript at once. It is removed here rather than in a worker
// because the runtime stream loops are the one place every run of every kind crosses,
// whichever worker served it, so there is a single implementation to keep correct.
//
// The rule is narrow so that it cannot corrupt a deliverable: nothing is ever
// removed once a single byte of real content has been seen. Only spans that precede
// all content are dropped, so a document about reasoning tags, code containing the
// literal string, or an answer that mentions the tag after its first word is
// returned byte for byte. There is deliberately no global search and replace.
//
// Consecutive leading spans are all removed, because a chat template that reopens
// thinking has still produced nothing but preamble. Stopping after the first one
// would both publish the second and make this normalization non-idempotent, which
// the readers below rely on to keep validation and storage reading the same text.

const (
	// Indentation ahead of a span is withheld together with it, so it has to be
	// buffered. Bounding it is what keeps the streaming filter O(1) in memory
	// against an adversarial provider; the one-shot pass honours the same bound so
	// the two can never disagree on any input.
	maxReasoningIndent = 64
	maxReasoningTag    = len("</thinking>")
)

var (
	reasoningOpenTags  = []string{"<think>", "<thinking>"}
	reasoningCloseTags = []string{"</think>", "</thinking>"}
)

// Tags are ASCII and matched byte-wise, but the whitespace ahead of a span is not: it
// is the filter's entry gate, so anything it mistakes for content disables stripping
// for the whole answer. Model output chooses those bytes freely, so a single U+00A0 or
// an ideographic space before the tag would otherwise ship the scratchpad. Invisible
// formatting characters are admitted here too — a reader never sees them, so they cannot
// be the content that proves the answer has begun — and admitting them costs nothing here,
// because indentation at this gate is only withheld: it is written back out unchanged when
// no tag follows.
func isReasoningGateSpace(r rune) bool {
	// Written as escapes because these characters are invisible in a source file and a
	// reviewer has to see exactly which ones are in the set.
	switch r {
	case '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff':
		return true
	}
	return unicode.IsSpace(r)
}

// Whitespace that FOLLOWS a close tag is discarded rather than withheld, so its set has to
// be narrower: a zero-width joiner carries meaning inside an emoji or an Indic cluster, and
// deleting it would corrupt the deliverable it introduces. Only real whitespace is safe to
// drop, and both passes must use the same predicate in the same position or the streamed
// text stops being a prefix of the one-shot answer.
func leadingSpace(s string) (n int, partial bool) { return leadingSpaceFunc(s, isReasoningGateSpace) }
func leadingDiscardableSpace(s string) (n int, partial bool) {
	return leadingSpaceFunc(s, unicode.IsSpace)
}

// leadingSpaceFunc reports the byte length of a leading whitespace rune. It reports partial
// when the bytes so far are only the start of a rune, which is what lets the streaming filter
// reach the same decision as the one-shot pass across any delta boundary. UTF-8 caps an
// incomplete prefix at three bytes and reports an invalid sequence as complete, so a caller
// that buffers on partial cannot be made to grow without bound.
func leadingSpaceFunc(s string, isSpace func(rune) bool) (n int, partial bool) {
	if s == "" || !utf8.FullRuneInString(s) {
		return 0, true
	}
	r, size := utf8.DecodeRuneInString(s)
	if r == utf8.RuneError && size <= 1 {
		return 0, false
	}
	if isSpace(r) {
		return size, false
	}
	return 0, false
}

func trimReasoningSpace(s string) string {
	return strings.TrimLeftFunc(s, unicode.IsSpace)
}

// foldEqual compares s against an all-lowercase ASCII tag without allocating and
// without UTF-8 semantics, so the streamed and one-shot passes stay identical.
func foldEqual(s, tag string) bool {
	if len(s) != len(tag) {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != tag[i] {
			return false
		}
	}
	return true
}

// matchReasoningTag returns the length of the tag s starts with, or zero.
func matchReasoningTag(s string, tags []string) int {
	for _, tag := range tags {
		if len(s) >= len(tag) && foldEqual(s[:len(tag)], tag) {
			return len(tag)
		}
	}
	return 0
}

// partialReasoningTag reports whether s could still grow into one of the tags.
// This is what lets the filter hold back an opening tag that a provider splits
// across two deltas instead of leaking its first bytes.
func partialReasoningTag(s string, groups ...[]string) bool {
	for _, group := range groups {
		for _, tag := range group {
			if len(s) < len(tag) && foldEqual(s, tag[:len(s)]) {
				return true
			}
		}
	}
	return false
}

// indexReasoningTag finds the earliest occurrence of any tag. Scanning for '<'
// needs no allocation and no rune decoding: '<' is ASCII, so it can never appear
// inside a multi-byte rune.
func indexReasoningTag(s string, tags []string) (int, int) {
	for i := 0; i < len(s); i++ {
		if s[i] != '<' {
			continue
		}
		if n := matchReasoningTag(s[i:], tags); n > 0 {
			return i, n
		}
	}
	return -1, 0
}

type reasoningVerdict int

const (
	reasoningAbsent    reasoningVerdict = iota // no leading span; text is unchanged
	reasoningRemoved                           // every closed leading span was removed
	reasoningOpenEnded                         // a leading span opened and never closed
)

// classifyReasoning removes the leading scratchpad spans and reports what it found.
// An unterminated span is never destroyed: what it holds is not proven to be a
// scratchpad, so the text is returned and whether to publish it is a policy
// decision left to reasoningAnswer.
func classifyReasoning(text string) (string, reasoningVerdict) {
	// Indentation ahead of the first span is content until a tag proves otherwise, so
	// it is withheld rather than dropped. Whitespace between spans needs no such care:
	// a span has already proven the text so far is preamble.
	indent := 0
	for indent < len(text) {
		n, _ := leadingSpace(text[indent:])
		if n == 0 {
			break
		}
		indent += n
	}
	if indent > maxReasoningIndent {
		return text, reasoningAbsent
	}
	rest, removed := text[indent:], false
	for {
		// A prompt that pre-fills the opening tag makes the completion start with the
		// closing one. No deliverable opens with a closing reasoning tag, so dropping
		// it needs no configuration and cannot be wrong.
		if n := matchReasoningTag(rest, reasoningCloseTags); n > 0 {
			rest, removed = trimReasoningSpace(rest[n:]), true
			continue
		}
		n := matchReasoningTag(rest, reasoningOpenTags)
		if n == 0 {
			break
		}
		end, size := indexReasoningTag(rest[n:], reasoningCloseTags)
		if end < 0 {
			if removed {
				return rest, reasoningOpenEnded
			}
			return text, reasoningOpenEnded
		}
		rest, removed = trimReasoningSpace(rest[n+end+size:]), true
	}
	if !removed {
		return text, reasoningAbsent
	}
	return rest, reasoningRemoved
}

// stripReasoningPreamble normalises text that may already be stored. It heals a
// leaked preamble without rejecting or shortening anything else, so re-reading a
// node written by an earlier release cannot turn a delivered canvas into a
// permanent failure. It is idempotent, which is why every reader can apply it.
func stripReasoningPreamble(text string) string {
	answer, _ := classifyReasoning(text)
	return answer
}

// reasoningAnswer is the publishable form of a completed runtime answer, and
// reports whether the model produced one at all. A scratchpad that never closed,
// or one that left nothing behind, is not a deliverable: the caller must fail
// rather than store model internals or report success with an empty result.
func reasoningAnswer(text string) (string, bool) {
	answer, verdict := classifyReasoning(text)
	if verdict == reasoningOpenEnded {
		return "", false
	}
	if verdict == reasoningRemoved && strings.TrimSpace(answer) == "" {
		return "", false
	}
	return answer, true
}

// reasoningStream removes the leading scratchpad spans from a streamed answer, one
// delta at a time. Whatever it emits is always a prefix of classifyReasoning over the
// same complete text, whatever the provider's chunk boundaries are, so the
// completed-event prefix checks in execute and executeTeamTurn keep holding and the
// browser never has to withdraw a character it already showed. While inside a span it
// emits nothing, because those bytes are dropped if the span closes and kept if it
// does not; the terminal event decides which.
type reasoningStream struct {
	phase  int
	indent int    // leading whitespace bytes currently held in head
	head   []byte // indentation plus a possible tag, held only while deciding
	carry  []byte // trailing bytes kept so a close tag may straddle two deltas
}

const (
	reasoningDeciding = iota // withholding what could still become an opening tag
	reasoningInside          // inside the span; discarding
	reasoningTrailing        // discarding the whitespace that followed the close tag
	reasoningPassing         // committed to the answer; never inspect again
)

func (s *reasoningStream) push(delta string) string {
	var out strings.Builder
	for delta != "" {
		switch s.phase {
		case reasoningPassing:
			out.WriteString(delta)
			delta = ""
		case reasoningDeciding:
			delta = s.decide(delta, &out)
		case reasoningInside:
			delta = s.skipSpan(delta)
		default:
			// Trailing. Any other value would be a phase this switch forgot, and
			// treating it as trailing still consumes the delta instead of spinning.
			delta = s.skipTrailing(delta)
		}
	}
	return out.String()
}

// release commits to the answer, flushing everything that was held back.
func (s *reasoningStream) release(out *strings.Builder, rest string) string {
	out.Write(s.head)
	out.WriteString(rest)
	s.head, s.indent, s.phase = nil, 0, reasoningPassing
	return ""
}

func (s *reasoningStream) decide(delta string, out *strings.Builder) string {
	for i := 0; i < len(delta); i++ {
		s.head = append(s.head, delta[i])
		pending := string(s.head[s.indent:])
		// A whitespace rune may be multi-byte and may straddle two deltas, so decide on
		// the decoded rune rather than the byte: buffering an incomplete one is what makes
		// this reach the same answer as the one-shot pass at every possible split.
		if n, partial := leadingSpace(pending); n > 0 {
			if s.indent+n > maxReasoningIndent {
				// Whitespace alone is never a scratchpad, and holding more of it
				// back would make this buffer unbounded.
				s.head = s.head[:len(s.head)-1]
				return s.release(out, delta[i:])
			}
			s.indent += n
			continue
		} else if partial {
			continue
		}
		tag := pending
		if matchReasoningTag(tag, reasoningOpenTags) == len(tag) {
			s.head, s.indent, s.phase = nil, 0, reasoningInside
			return delta[i+1:]
		}
		if matchReasoningTag(tag, reasoningCloseTags) == len(tag) {
			s.head, s.indent, s.phase = nil, 0, reasoningTrailing
			return delta[i+1:]
		}
		if !partialReasoningTag(tag, reasoningOpenTags, reasoningCloseTags) {
			return s.release(out, delta[i+1:])
		}
	}
	return ""
}

func (s *reasoningStream) skipSpan(delta string) string {
	// A close tag may straddle two deltas, so re-examine the last few bytes along
	// with the new ones. Keeping one byte less than the longest tag is exactly
	// enough, which is what makes discarding an arbitrarily long scratchpad O(1).
	work := string(s.carry) + delta
	if end, size := indexReasoningTag(work, reasoningCloseTags); end >= 0 {
		s.carry, s.phase = nil, reasoningTrailing
		return work[end+size:]
	}
	if keep := maxReasoningTag - 1; len(work) > keep {
		work = work[len(work)-keep:]
	}
	s.carry = []byte(work)
	return ""
}

// skipTrailing discards the whitespace a close tag left behind, then hands the next
// byte back to decide: a template that reopens thinking has produced no content yet,
// so the span that follows is still preamble.
func (s *reasoningStream) skipTrailing(delta string) string {
	// Rune-aware for the same reason as decide, and additionally because the one-shot
	// pass trims this whitespace: if the stream kept a multi-byte space the one-shot
	// removed, the streamed text would stop being a prefix of it and the completed-event
	// cross-check would report the runtime as inconsistent. Only a partial rune is ever
	// buffered here, so this stays bounded.
	for i := 0; i < len(delta); i++ {
		s.head = append(s.head, delta[i])
		pending := string(s.head)
		if n, partial := leadingDiscardableSpace(pending); n > 0 {
			s.head = s.head[:0]
			continue
		} else if partial {
			continue
		}
		s.head, s.phase = nil, reasoningDeciding
		return pending + delta[i+1:]
	}
	return ""
}
