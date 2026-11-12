package app

import (
	"errors"
	"strings"
	"testing"

	"awwo/backend/internal/webread"
)

func TestCheckModelReadURLAcceptsOrdinaryPages(t *testing.T) {
	for raw, want := range map[string]string{
		"https://www.remotion.dev/docs/the-fundamentals":           "https://www.remotion.dev/docs/the-fundamentals",
		"https://github.com/remotion-dev/remotion/releases":        "https://github.com/remotion-dev/remotion/releases",
		"https://en.wikipedia.org/wiki/Remotion#History":           "https://en.wikipedia.org/wiki/Remotion",
		"  HTTPS://Example.COM/a/b  ":                              "https://example.com/a/b",
		"https://docs.djangoproject.com/en/5.0/ref/contrib/admin/": "https://docs.djangoproject.com/en/5.0/ref/contrib/admin/",
		"http://example.com:80/robots-policy.html":                 "http://example.com:80/robots-policy.html",
	} {
		u, err := checkModelReadURL(raw)
		if err != nil {
			t.Fatalf("%q refused: %v", raw, err)
		}
		if u.String() != want {
			t.Fatalf("%q normalized to %q, want %q", raw, u.String(), want)
		}
	}
}

func TestCheckModelReadURLRefusesWhatCarriesOrProbes(t *testing.T) {
	for raw, code := range map[string]string{
		"https://example.com/" + strings.Repeat("a", modelReadURLBytes):  "model_url_too_long",
		"https://example.com/" + strings.Repeat("a", modelReadPathBytes): "model_url_too_long",
		// Labels stay under DNS's 63 bytes, so the host's own length is what refuses it.
		"https://" + strings.Repeat("a", 60) + "." + strings.Repeat("b", 40) + ".example.com/": "model_host",
		"https://a.b.c.d.example.com/":            "model_host",
		"https://example.com/p?q=1":               "model_query",
		"https://example.com/p?":                  "model_query",
		"https://example.com/.env":                "model_probe_path",
		"https://example.com/.git/config":         "model_probe_path",
		"https://example.com/%2egit/config":       "model_probe_path",
		"https://example.com/a/%2e%2e/%2e%2e/etc": "model_probe_path",
		"https://example.com/a%2F..%2Fsecret":     "model_probe_path",
		"https://example.com/wp-admin/":           "model_probe_path",
		"https://example.com/WP-LOGIN.PHP":        "model_probe_path",
		"https://example.com/cgi-bin/test.cgi":    "model_probe_path",
		"https://example.com/actuator/env":        "model_probe_path",
		"https://example.com/backup/site.sql":     "model_probe_path",
		"https://example.com/keys/server.PEM":     "model_probe_path",
		"https://example.com/.well-known/openid":  "model_probe_path",
		// Path parameters could hide a segment on servers that drop them as they route.
		"https://example.com/actuator;v=1/env": "model_probe_path",
		"https://example.com/a%3Bb/page":       "model_probe_path",
		// The reader's own refusals come through unchanged.
		"ftp://example.com/file":       "blocked_scheme",
		"https://example.com:8443/":    "blocked_port",
		"https://127.0.0.1/":           "blocked_host",
		"https://localhost/":           "blocked_host",
		"https://user:pw@example.com/": "invalid_url",
		"not a url":                    "invalid_url",
	} {
		_, err := checkModelReadURL(raw)
		var refusal *webread.Error
		if !errors.As(err, &refusal) || refusal.Code != code {
			t.Fatalf("%q: got %v, want %s", raw, err, code)
		}
	}
}

// The limits are the point of the check: a path and a host just within them still read.
func TestCheckModelReadURLLimitsAreInclusive(t *testing.T) {
	base := "https://example.com"
	if _, err := checkModelReadURL(base + "/" + strings.Repeat("a", modelReadPathBytes-1)); err != nil {
		t.Fatalf("a path of exactly %d bytes was refused: %v", modelReadPathBytes, err)
	}
	if _, err := checkModelReadURL("https://a.b.c.example.com/"); err != nil {
		t.Fatalf("a host of exactly %d labels was refused: %v", modelReadHostLabels, err)
	}
	host := strings.Repeat("a", 60) + "." + strings.Repeat("b", modelReadHostBytes-61-len(".example.com")) + ".example.com"
	if len(host) != modelReadHostBytes {
		t.Fatalf("test host is %d bytes, want %d", len(host), modelReadHostBytes)
	}
	if _, err := checkModelReadURL("https://" + host + "/"); err != nil {
		t.Fatalf("a host of exactly %d bytes was refused: %v", modelReadHostBytes, err)
	}
}
