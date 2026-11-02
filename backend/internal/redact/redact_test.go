package redact

import (
	"strings"
	"testing"
)

// What a secret looks like, and each value the caller names, becomes [REDACTED]; a secret split across segments is
// removed from each of them.
func TestTextRedactsSecretsAndNamedValues(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"api_key: sk-abcdefghijklmnop and more", "[REDACTED] and more"},
		{`password="hunter 22"; next`, "[REDACTED]; next"},
		{"Authorization: Bearer abc.def\nsafe", "[REDACTED]\nsafe"},
		{"token ghp_abcdefghijklmnopqrstuv here", "token [REDACTED] here"},
		{"-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\nafter", "[REDACTED]\nafter"},
		{"nothing secret", "nothing secret"},
	} {
		if got := Text(c.in, nil); got != c.want {
			t.Errorf("%q: %q, want %q", c.in, got, c.want)
		}
	}
	if got := Text("the worker token is internal-worker-token-1 twice: internal-worker-token-1", []string{"internal-worker-token-1", "short"}); got != "the worker token is [REDACTED] twice: [REDACTED]" {
		t.Fatal(got)
	}
	if got := Text("a short value stays", []string{"short"}); got != "a short value stays" {
		t.Fatal("a value under 8 bytes was redacted:", got)
	}
	whole := "before sk-abcdefghijklmnop after"
	spans := Spans(whole, nil)
	cut := strings.Index(whole, "efgh")
	if got := Segment(whole[:cut], 0, spans) + "|" + Segment(whole[cut:], cut, spans); got != "before [REDACTED]|"+" after" {
		t.Fatal("split across segments:", got)
	}
}

// The shapes added for the learning export, which a run's archive takes too; ordinary words around them stay.
func TestTextRedactsMoreSecretShapes(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"key sk_live_abcdefghijklmnop end", "key [REDACTED] end"},
		{"db postgres://app:Pa55word@db.internal/prod", "db [REDACTED]db.internal/prod"},
		{"aws_secret_access_key=wJalrXUtnFEMIabcdef and", "[REDACTED] and"},
		{`{"secretAccessKey":"wJalrXUtnFEMI"}`, `{[REDACTED]}`},
		{"token=abc123def456 next", "[REDACTED] next"},
		{"secret: s3cr3t-value", "[REDACTED]"},
		{"slack xoxb-1234567890-abcdefghij", "slack [REDACTED]"},
		{"google AIzaSyA-abcdefghijklmnopqrstuvwxyz01234", "google [REDACTED]"},
		{"gitlab glpat-abcdefghijklmnopqrst", "gitlab [REDACTED]"},
		{"hf hf_abcdefghijklmnopqrstuvwxyz0123456789", "hf [REDACTED]"},
		{"-----BEGIN PGP PRIVATE KEY BLOCK-----\nxx\n-----END PGP PRIVATE KEY BLOCK-----\nafter", "[REDACTED]\nafter"},
		{"账号 a，密码：hunter22 好", "账号 a，[REDACTED] 好"},
		{`{"密码":"alpha beta"}`, `{[REDACTED]}`},
		{`密码："alpha beta" 之后`, `[REDACTED] 之后`},
		{"cache redis://:syntheticPassword@localhost:6379/0", "cache [REDACTED]localhost:6379/0"},
		// Words that only look like labels stay, and typed code.
		{"max_token: 4096 and maxTokens=10", "max_token: 4096 and maxTokens=10"},
		{"a token of thanks", "a token of thanks"},
		{"function parse(token: Token): AST { return next(); }", "function parse(token: Token): AST { return next(); }"},
		{"pwd=p@ssw0rd! next", "[REDACTED] next"},
		{"secret=s3cr3t!value", "[REDACTED]"},
		{"server http://localhost:3000/path", "server http://localhost:3000/path"},
	} {
		if got := Text(c.in, nil); got != c.want {
			t.Errorf("%q: %q, want %q", c.in, got, c.want)
		}
	}
}

// Personal contact details read as such, ordinary numbers not.
func TestPersonalSpansFindContactDetails(t *testing.T) {
	text := "写信到 ada@example.com 或打 13812345678，也可 +44 20 7946 0958；订单 20261102 共 3 件"
	got := Segment(text, 0, Merge(PersonalSpans(text)))
	if want := "写信到 [REDACTED] 或打 [REDACTED]，也可 [REDACTED]；订单 20261102 共 3 件"; got != want {
		t.Fatalf("%q, want %q", got, want)
	}
}
