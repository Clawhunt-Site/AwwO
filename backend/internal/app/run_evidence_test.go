package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestRunArchiveRedactsEverySecretSplitAndOmitsUnknownPayload(t *testing.T) {
	for _, secret := range []string{
		"api_key=sk-0123456789ABCDEFGHIJKLMNOP",
		"Bearer synthetic-secret-token",
		`"password": "a secret with spaces"`,
		"-----BEGIN PRIVATE KEY-----\nsynthetic private material\n-----END PRIVATE KEY-----",
		"nonstandard-configured-secret",
	} {
		for split := 1; split < len(secret); split++ {
			events := []runArchiveEvent{{Type: "text_delta", Delta: "前缀 " + secret[:split]},
				{Type: "running"}, {Type: "text_delta", Delta: secret[split:] + " 安全后缀"}}
			sanitizeRunArchiveEvents(events, []string{"nonstandard-configured-secret"})
			got := events[0].Delta + events[2].Delta
			if got != "前缀 [REDACTED] 安全后缀" {
				t.Fatalf("split %d: %q", split, got)
			}
		}
	}
	for _, source := range []string{
		"Authorization: Basic c3ludGhldGljOmZpeHR1cmU=",
		"Authorization: Bearer synthetic-secret-token",
		"Cookie: session=syntheticA; csrf=syntheticB",
		"Set-Cookie: session=syntheticA; HttpOnly; Secure",
		`"password": "synthetic secret phrase`,
		`client_secret='synthetic secret phrase`,
		`"Authorization": "Basic c3ludGhldGljOmZpeHR1cmU=`,
	} {
		for split := 1; split < len(source); split++ {
			events := []runArchiveEvent{{Type: "text_delta", Delta: "safe\n" + source[:split]},
				{Type: "text_delta", Delta: source[split:]}}
			sanitizeRunArchiveEvents(events, nil)
			if got := events[0].Delta + events[1].Delta; got != "safe\n[REDACTED]" {
				t.Fatalf("header/unfinished quote split %d: %q", split, got)
			}
		}
	}
	if got := redactRunText("Cookie: session=a; csrf=b\nsafe output", nil); got != "[REDACTED]\nsafe output" {
		t.Fatalf("redaction did not respect header boundary: %q", got)
	}
	event := projectRunArchiveEvent(7, time.Now(), []byte(`{"type":"text_delta","delta":"safe","headers":{"Authorization":"secret"},"token":"private"}`))
	raw, _ := json.Marshal(event)
	if strings.Contains(string(raw), "private") || strings.Contains(string(raw), "headers") {
		t.Fatal("unapproved fields exported", string(raw))
	}
	unknown := projectRunArchiveEvent(8, time.Now(), []byte(`{"type":"future","password":"private","text":"hidden"}`))
	if unknown.Type != "unsupported" || !unknown.PayloadOmitted || unknown.Text != "" {
		t.Fatal("unknown event payload released", unknown)
	}
}

func TestRunEvidenceIsObservationalAndPreviewIsUTF8Bounded(t *testing.T) {
	snapshot := []byte(`{"taskFrame":{"version":1,"source":"manual","constraints":["引用原文"],"acceptanceCriteria":["人工核对"]},"outputContract":{"version":1,"fields":[{"id":"count","type":"number","required":true}]}}`)
	claim := observeRun("r", "completed", `I verified every requirement`, snapshot, 0, nil)
	if !claim.OutputPresent || !claim.ManualAcceptance.Required || claim.ManualAcceptance.Verified || claim.Contract.Validated {
		t.Fatal("model self-report became acceptance evidence", claim)
	}
	valid := observeRun("r", "completed", `{"count":2}`, snapshot, 1, nil)
	if !valid.Contract.Validated || len(valid.EvidenceSources) != 3 || valid.ManualAcceptance.Verified {
		t.Fatal("facts lost or acceptance invented", valid)
	}
	empty := observeRun("r", "completed", "", []byte(`{}`), 0, nil)
	if empty.OutputPresent || len(empty.EvidenceSources) != 0 || !empty.Observational {
		t.Fatal("status counted as evidence", empty)
	}
	text := strings.Repeat("中", 2000) + " api_key=sk-synthetic-secret-123456789"
	preview := observeRun("r", "failed", text, []byte(`{}`), 0, nil)
	if !preview.PreviewTruncated || len(preview.Preview) > runEvidencePreviewBytes || !utf8.ValidString(preview.Preview) || preview.OutputBytes != len(text) {
		t.Fatal("preview changed archive size or split UTF-8", preview)
	}
}

func TestRunArchiveRedactsEveryQuotedPrefixAndSplit(t *testing.T) {
	for _, test := range []struct {
		name, key, value string
	}{
		{"password", `"password": "`, `synthetic secret phrase\with\"escaped quote"`},
		{"client secret", `client_secret='`, `synthetic secret phrase\with\'escaped quote'`},
		{"authorization", `"Authorization": "`, `Basic synthetic secret\with\"escaped quote"`},
		{"cookie", `Cookie: '`, `session=synthetic secret; csrf=value\with\'escaped quote'`},
		{"escaped newline", `"password": "`, "synthetic secret phrase\\\ncontinued secret\""},
	} {
		t.Run(test.name, func(t *testing.T) {
			// A live snapshot may end anywhere in a quoted secret, including
			// immediately after the backslash of an unfinished escape sequence.
			for prefix := 0; prefix <= len(test.value); prefix++ {
				source := test.key + test.value[:prefix]
				if got := redactRunText("safe\n"+source, nil); got != "safe\n[REDACTED]" {
					t.Fatalf("prefix %d leaked quoted secret: %q", prefix, got)
				}
				for split := 0; split <= len(source); split++ {
					events := []runArchiveEvent{{Type: "text_delta", Delta: "safe\n" + source[:split]},
						{Type: "running"}, {Type: "text_delta", Delta: source[split:]}}
					sanitizeRunArchiveEvents(events, nil)
					if got := events[0].Delta + events[2].Delta; got != "safe\n[REDACTED]" {
						t.Fatalf("prefix %d split %d leaked quoted secret: %q", prefix, split, got)
					}
				}
			}
		})
	}
}

func TestRunEvidenceMachineContractRejectsLegacyFallbacks(t *testing.T) {
	for _, test := range []struct {
		name, fieldType, output string
		required, valid         bool
	}{
		{"missing text field", "text", `{"other":"not the required field"}`, true, false},
		{"extra field", "number", `{"value":2,"undeclared":true}`, true, false},
		{"empty optional delivery", "text", `{}`, false, false},
		{"null optional delivery", "text", `{"value":null}`, false, false},
		{"empty optional text", "text", `{"value":""}`, false, false},
		{"blank optional text", "text", `{"value":" \t\n\u2003"}`, false, false},
		{"blank optional markdown", "markdown", `{"value":"   "}`, false, false},
		{"blank optional html", "html", `{"value":"   "}`, false, false},
		{"null required", "text", `{"value":null}`, true, false},
		{"numeric text", "number", `{"value":"2"}`, true, false},
		{"wrong boolean", "boolean", `{"value":"true"}`, true, false},
		{"legacy file reference", "file", `{"value":"awwo-file:existing-reference"}`, true, false},
		{"file extra key", "file", `{"value":{"name":"result.txt","content":"data","path":"/tmp"}}`, true, false},
		{"file missing content", "file", `{"value":{"name":"result.txt"}}`, true, false},
		{"blank required text", "text", `{"value":"   "}`, true, false},
		{"incomplete html", "html", `{"value":"<p>fragment</p>"}`, true, false},
		{"unsafe file name", "file", `{"value":{"name":"../escape","content":"data"}}`, true, false},
		{"valid text", "text", `{"value":"deliverable"}`, true, true},
		{"valid optional", "text", `{"value":"deliverable"}`, false, true},
		{"valid optional markdown", "markdown", `{"value":"# Deliverable"}`, false, true},
		{"valid optional html", "html", `{"value":"<!doctype html><html><head><title>Delivery</title></head><body>Complete</body></html>"}`, false, true},
		{"valid number", "number", `{"value":2}`, true, true},
		{"valid boolean", "boolean", `{"value":false}`, true, true},
		{"valid file", "file", `{"value":{"name":"result.txt","content":"data"}}`, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, _ := json.Marshal(executionSnapshot{OutputContract: &outputContract{Version: 1, Fields: []outputContractField{{ID: "value", Type: test.fieldType, Required: test.required}}}})
			evidence := observeRun("r", "completed", test.output, snapshot, 0, nil)
			if evidence.Contract.Validated != test.valid {
				t.Fatalf("contract validation = %v, want %v", evidence.Contract.Validated, test.valid)
			}
			if evidence.ManualAcceptance.Verified {
				t.Fatal("machine proof became manual acceptance")
			}
			if failed := observeRun("r", "failed", test.output, snapshot, 0, nil); failed.Contract.Validated {
				t.Fatal("failed run counted as validated")
			}
		})
	}
}

func TestRunEvidenceBlankOptionalFieldWithOtherDelivery(t *testing.T) {
	for _, fieldType := range []string{"text", "markdown", "html"} {
		t.Run(fieldType, func(t *testing.T) {
			contract := &outputContract{Version: 1, Fields: []outputContractField{
				{ID: "empty", Type: fieldType},
				{ID: "zero", Type: "number"},
				{ID: "false", Type: "boolean"},
			}}
			for _, output := range []string{`{"empty":"   ","zero":0}`, `{"empty":"   ","false":false}`} {
				if !verifiedRunOutputContract(contract, output) {
					t.Fatalf("blank optional field hid a valid delivery: %s", output)
				}
			}
			contract.Fields[0].Required = true
			if verifiedRunOutputContract(contract, `{"empty":"   ","zero":0}`) {
				t.Fatal("another delivery hid a blank required field")
			}
		})
	}
}

func TestRunArchiveLimitConfiguration(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", "postgres://localhost/test")
	t.Setenv("AWWO_CREDENTIAL_MODE", "operator")
	for _, value := range []string{"0", "-1", "1024", "268435457", "invalid"} {
		t.Setenv("AWWO_RUN_ARCHIVE_MAX_BYTES", value)
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AWWO_RUN_ARCHIVE_MAX_BYTES") {
			t.Fatalf("accepted %q: %v", value, err)
		}
	}
	t.Setenv("AWWO_RUN_ARCHIVE_MAX_BYTES", "1048576")
	config, err := ConfigFromEnv()
	if err != nil || config.RunArchiveMaxBytes != 1<<20 {
		t.Fatal(config.RunArchiveMaxBytes, err)
	}
}

func TestPostgresRunEvidenceArchiveIsCompleteScopedRedactedAndReadOnly(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	cookie, tid, user := h.register(t, "archive-owner@example.test")
	other, otherTenant, _ := h.register(t, "archive-outsider@example.test")
	_, _, sid := h.fixture(t, cookie, tid)
	id, ctx := randomID(), context.Background()
	output := "prefix sk-synthetic-secret-123456789 suffix " + strings.Repeat("中文", 2500)
	snapshot := `{"taskFrame":{"version":1,"source":"manual","constraints":[],"acceptanceCriteria":["人工核对"]}}`
	if _, err := h.db.Exec(ctx, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,execution_snapshot)
		VALUES($1,$2,$3,$1,'fixture','fixture','completed',$4,$5)`, id, tid, sid, output, snapshot); err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{`{"type":"queued"}`, `{"type":"text_delta","delta":"prefix sk-synthetic-"}`,
		`{"type":"text_delta","delta":"secret-123456789 suffix"}`, `{"type":"future","token":"must-not-export"}`} {
		if _, err := h.db.Exec(ctx, `INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)`, tid, id, data); err != nil {
			t.Fatal(err)
		}
	}
	base := "/tenants/" + tid + "/runs/" + id
	evidence := h.request(t, cookie, "GET", base+"/evidence", nil, 200)
	if evidence["previewTruncated"] != true || strings.Contains(evidence["preview"].(string), "synthetic-secret") {
		t.Fatal(evidence)
	}
	if evidence["manualAcceptance"].(map[string]any)["verified"] != false {
		t.Fatal("invented acceptance")
	}
	for _, endpoint := range []string{"/evidence", "/archive"} {
		h.request(t, nil, "GET", base+endpoint, nil, 401)
		h.request(t, other, "GET", base+endpoint, nil, 404)
		h.request(t, other, "GET", "/tenants/"+otherTenant+"/runs/"+id+endpoint, nil, 404)
	}
	readArchive := func() ([]byte, http.Header) {
		t.Helper()
		req, _ := http.NewRequest("GET", h.server.URL+"/api/v1"+base+"/archive", nil)
		req.AddCookie(cookie)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("archive %d: %s %v", resp.StatusCode, body, err)
		}
		return body, resp.Header
	}
	body, headers := readArchive()
	if strings.Contains(string(body), "synthetic-") || strings.Contains(string(body), "must-not-export") || !strings.Contains(string(body), "[REDACTED]") {
		t.Fatal("secret fragment escaped archive")
	}
	if len(body) <= runEvidencePreviewBytes || headers.Get("X-AwwO-Archive-Complete") != "true" {
		t.Fatal("preview cap truncated archive")
	}
	sum := sha256.Sum256(body)
	if headers.Get("X-AwwO-Archive-SHA256") != hex.EncodeToString(sum[:]) || headers.Get("X-AwwO-Archive-Bytes") != strconv.Itoa(len(body)) {
		t.Fatal("incorrect archive digest/bytes")
	}
	if !strings.HasPrefix(headers.Get("Content-Disposition"), "attachment;") || !strings.HasPrefix(headers.Get("Content-Type"), "application/x-ndjson") {
		t.Fatal("unsafe download headers")
	}
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	if len(lines) != 5 {
		t.Fatalf("missing retained events: %d", len(lines))
	}
	var manifest map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["eventCount"] != float64(4) || manifest["completeThroughCursor"] != true || manifest["terminal"] != true {
		t.Fatal(manifest)
	}
	var stored, status string
	var count int
	if err := h.db.QueryRow(ctx, "SELECT output,status,(SELECT count(*) FROM run_events WHERE tenant_id=$1 AND run_id=$2) FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&stored, &status, &count); err != nil {
		t.Fatal(err)
	}
	if stored != output || status != "completed" || count != 4 {
		t.Fatal("read-only observation changed source records")
	}
	h.a.cfg.RunArchiveMaxBytes = 512
	h.request(t, cookie, "GET", base+"/archive", nil, 413)
	if _, err := h.db.Exec(ctx, "DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, user); err != nil {
		t.Fatal(err)
	}
	h.request(t, cookie, "GET", base+"/archive", nil, 404)
}
