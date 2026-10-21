package app

import (
	"math"
	"unicode/utf8"
)

// How many input tokens a text can take, from its characters: what every input budget compares with a model's context
// window. The Go twin of apps/context-estimate.ts (see there for the 2026-10-21 measurements behind it), which the
// workers count with; apps/context-estimate-vectors.json holds the cases all three implementations agree on.
//
// A word is a run of code points that are neither ASCII whitespace nor CJK, the whitespace before it going with it. A
// word longer than 32 code points, or one holding an ASCII digit, counts byte for byte (strict) with its whitespace; in
// any other word a non-ASCII code point (or an invalid byte) is strict and the rest is prose; a CJK character, and the
// whitespace before one, is prose. The estimate is strict + ceil(prose / rate), where rate is the model's measured
// bytes of prose per token: len(text) at a rate of 1, the byte rule before 2026-10-21.
const (
	proseRateMin      = 1.0
	proseRateMax      = 4.0
	estimateLongWords = 32
)

func estimateCJK(r rune) bool {
	return (r >= 0x2e80 && r <= 0x9fff) || (r >= 0xac00 && r <= 0xd7af) || (r >= 0xf900 && r <= 0xfaff) || (r >= 0xff00 && r <= 0xffef)
}

// textCost is a text's strict and prose bytes; strict+prose == len(text).
func textCost(text string) (strict, prose int) {
	space, wordBytes, wordASCII, wordLen, wordDigit := 0, 0, 0, 0, false
	flush := func() {
		if wordLen > estimateLongWords || wordDigit {
			strict += space + wordBytes
		} else {
			prose += space + wordASCII
			strict += wordBytes - wordASCII
		}
		space, wordBytes, wordASCII, wordLen, wordDigit = 0, 0, 0, 0, false
	}
	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		i += size
		switch {
		case r == ' ' || (r >= '\t' && r <= '\r'):
			if wordLen > 0 {
				flush()
			}
			space++
		case estimateCJK(r):
			flush()
			prose += size
		default:
			wordBytes += size
			if r < utf8.RuneSelf {
				wordASCII++
				if r >= '0' && r <= '9' {
					wordDigit = true
				}
			}
			wordLen++
		}
	}
	flush()
	return strict, prose
}

// estimateTokens is a text's estimated input tokens at a model's prose rate (at most len(text); exactly that at 1).
func estimateTokens(text string, rate float64) int {
	strict, prose := textCost(text)
	if !(rate > proseRateMin) {
		return strict + prose
	}
	return strict + int(math.Ceil(float64(prose)/math.Min(rate, proseRateMax)))
}

// validProseRate is whether a worker's published rate may loosen a budget: 1 to 4 in steps of 0.05, as the workers
// accept it from a catalogue. Anything else counts as none (the byte rule).
func validProseRate(rate float64) bool {
	return rate >= proseRateMin && rate <= proseRateMax && math.Abs(rate*20-math.Round(rate*20)) <= 1e-9
}
