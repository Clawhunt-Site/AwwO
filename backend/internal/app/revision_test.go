package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildRevisionOnlyReportsAVerifiedCommit(t *testing.T) {
	original := buildRevision
	t.Cleanup(func() { buildRevision = original })

	// An unset build is honestly unknown rather than an invented value.
	buildRevision = ""
	if BuildRevision() != "unknown" {
		t.Fatalf("unset build reported %q", BuildRevision())
	}

	// Anything that is not a 40-hex commit must not be echoed back as if it were one, so a bad or
	// hostile link-time value cannot masquerade as a verified revision.
	for _, bad := range []string{
		"abc", strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("g", 40),
		"e05d2afd29700b07b918193432b4ba18ad6dd5e ", // trailing junk inside the length
		"../../etc/passwd", "<script>alert(1)</script>",
	} {
		buildRevision = bad
		if got := BuildRevision(); got != "unknown" {
			t.Fatalf("accepted %q as a revision: %q", bad, got)
		}
	}

	// A real commit is reported exactly, case-normalized and whitespace-trimmed.
	buildRevision = "  E05D2AFD29700B07B918193432B4BA18AD6DD5EC\n"
	if got := BuildRevision(); got != "e05d2afd29700b07b918193432b4ba18ad6dd5ec" {
		t.Fatalf("normalization failed: %q", got)
	}
}

func TestHealthFailsClosedWithoutADatabase(t *testing.T) {
	// Health must never claim to be serving when it cannot reach its database, otherwise a
	// deployment check would read "ok" from an instance that cannot do any work.
	// The exact failure status is not pinned: an unreachable pool answers 503 and an unusable one
	// surfaces as 500. What must hold either way is that health never answers 200 / "ok".
	a := New(nil, testConfig())
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/health", nil))
	if w.Code == 200 || strings.Contains(w.Body.String(), "\"status\":\"ok\"") {
		t.Fatalf("reported healthy without a database: %d %s", w.Code, w.Body.String())
	}
}

func TestPostgresHealthReportsTheRunningRevision(t *testing.T) {
	original := buildRevision
	t.Cleanup(func() { buildRevision = original })
	buildRevision = "e05d2afd29700b07b918193432b4ba18ad6dd5ec"

	// Health is the only endpoint reachable without a session, so it is what a deployment check can
	// actually use. Asserted from the real HTTP response, not from a payload built by the test.
	h := newHarness(t, "")
	resp, e := http.Get(h.server.URL + "/api/v1/health")
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("health returned %d", resp.StatusCode)
	}
	var body map[string]any
	if e = json.NewDecoder(resp.Body).Decode(&body); e != nil {
		t.Fatal(e)
	}
	if body["status"] != "ok" || body["revision"] != "e05d2afd29700b07b918193432b4ba18ad6dd5ec" {
		t.Fatalf("health did not report the running revision: %v", body)
	}
}
