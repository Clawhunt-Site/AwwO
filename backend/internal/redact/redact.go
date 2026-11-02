// Package redact removes secrets from text a run produced before it leaves AwwO's database: a run's archive (the API's
// run_archive.go), its evidence, and the learning data the operator exports (operator/learning.go). What is removed is
// what a secret looks like (keys, tokens, passwords, authorization headers, private keys, a URL's password) and the
// values the caller names as secrets; each becomes [REDACTED]. The learning export also removes what personal contact
// details look like (PersonalSpans: emails and phone numbers).
package redact

import (
	"regexp"
	"sort"
	"strings"
)

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password)["']?\s*[:=]\s*(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\s,;]+)`),
	// Header values can contain spaces, authentication schemes and multiple
	// cookies. An unfinished quoted value stays redacted through the snapshot.
	regexp.MustCompile(`(?im)["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=][ \t]*(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\r\n]+)`),
	regexp.MustCompile(`(?i)\bBearer[ \t]+[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)`),
	regexp.MustCompile(`(?s)-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----.*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)`),
	regexp.MustCompile(`(?s)-----BEGIN PGP PRIVATE KEY BLOCK-----.*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)`),
	// A secret named by a compound label, wherever it starts.
	regexp.MustCompile(`(?i)["']?(?:(?:aws_)?secret[-_]?access[-_]?key|api[-_]?secret|private[-_]?key)["']?\s*[:=]\s*(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\s,;]+)`),
	// A secret named by a bare label standing as a word of its own, before a quoted value or one with a digit in it:
	// typed code (token: Token) is no secret.
	regexp.MustCompile(`(?i)["']?\b(?:secret|token|passwd|pwd)["']?\s*[:=]\s*(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\s,;]*\d[^\s,;]*)`),
	// The same in Chinese, its label and value quoted or not.
	regexp.MustCompile(`["'“]?(?:密码|口令|密钥|秘钥|令牌)["'”]?\s*[:：=]\s*(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|“[^”]*(?:”|$)|[^\s,;，；]+)`),
	// Keys of well-known services: Stripe's secret and restricted keys, Slack's, Google's, GitLab's and Hugging Face's.
	regexp.MustCompile(`\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,})`),
	// A URL's user and password (scheme://user:password@host, or :password@ with no user): the host stays.
	regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s:/@]*:[^\s@/]+@`),
}

// personalPatterns are what personal contact details look like: an email address, and a phone number (a Chinese mobile
// number, or an international one written with its +).
var personalPatterns = []*regexp.Regexp{
	regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`),
	regexp.MustCompile(`(?:\+?86[- ]?)?\b1[3-9]\d{9}\b|\+\d[\d -]{7,16}\d`),
}

// PersonalSpans are the ranges of text that read as personal contact details (personalPatterns), to add to Spans' for
// text that leaves AwwO for learning.
func PersonalSpans(text string) []Span {
	spans := []Span{}
	for _, pattern := range personalPatterns {
		for _, match := range pattern.FindAllStringIndex(text, -1) {
			spans = append(spans, Span{match[0], match[1]})
		}
	}
	return spans
}

// Merge sorts spans and merges those that overlap or touch.
func Merge(spans []Span) []Span {
	sort.Slice(spans, func(i, j int) bool { return spans[i].Start < spans[j].Start })
	merged := []Span{}
	for _, span := range spans {
		if len(merged) > 0 && span.Start <= merged[len(merged)-1].End {
			if span.End > merged[len(merged)-1].End {
				merged[len(merged)-1].End = span.End
			}
		} else {
			merged = append(merged, span)
		}
	}
	return merged
}

// Span is a byte range of text to redact.
type Span struct{ Start, End int }

// Spans are the ranges of text to redact, sorted and merged: what a secret looks like, and every copy of each of
// secrets at least 8 bytes long.
func Spans(text string, secrets []string) []Span { return SpansAtLeast(text, secrets, 8) }

// SpansAtLeast is Spans with every copy of each of secrets at least shortest bytes long (the learning export names
// shorter deployment secrets than a run's archive, which redacts what an 8-byte floor keeps from common words).
func SpansAtLeast(text string, secrets []string, shortest int) []Span {
	spans := []Span{}
	for _, pattern := range secretPatterns {
		for _, match := range pattern.FindAllStringIndex(text, -1) {
			spans = append(spans, Span{match[0], match[1]})
		}
	}
	for _, secret := range secrets {
		if len(secret) < shortest || secret == "" {
			continue
		}
		for offset := 0; offset < len(text); {
			at := strings.Index(text[offset:], secret)
			if at < 0 {
				break
			}
			at += offset
			spans = append(spans, Span{at, at + len(secret)})
			offset = at + len(secret)
		}
	}
	return Merge(spans)
}

// Segment redacts text, which starts at offset of the whole the spans were computed over. Redaction ranges are
// computed over the joined delta stream first: a secret split across database events is removed from every fragment,
// not merely the first event that contains a recognizable prefix.
func Segment(text string, offset int, spans []Span) string {
	var out strings.Builder
	end, cursor := offset+len(text), offset
	first := sort.Search(len(spans), func(i int) bool { return spans[i].End > offset })
	for _, span := range spans[first:] {
		if span.Start >= end {
			break
		}
		left := max(span.Start, offset)
		if left > cursor {
			out.WriteString(text[cursor-offset : left-offset])
		}
		if span.Start >= offset {
			out.WriteString("[REDACTED]")
		}
		cursor = min(span.End, end)
	}
	if cursor < end {
		out.WriteString(text[cursor-offset:])
	}
	return out.String()
}

// Text is text with its secrets redacted.
func Text(text string, secrets []string) string {
	return Segment(text, 0, Spans(text, secrets))
}
