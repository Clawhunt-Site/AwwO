package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const defaultRunArchiveMaxBytes int64 = 16 << 20

var runSecretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password)["']?\s*[:=]\s*(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\s,;]+)`),
	// Header values can contain spaces, authentication schemes and multiple
	// cookies. An unfinished quoted value stays redacted through the snapshot.
	regexp.MustCompile(`(?im)["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=][ \t]*(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\r\n]+)`),
	regexp.MustCompile(`(?i)\bBearer[ \t]+[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)`),
	regexp.MustCompile(`(?s)-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----.*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)`),
}

type runRedactionSpan struct{ start, end int }

func runRedactionSpans(text string, secrets []string) []runRedactionSpan {
	spans := []runRedactionSpan{}
	for _, pattern := range runSecretPatterns {
		for _, match := range pattern.FindAllStringIndex(text, -1) {
			spans = append(spans, runRedactionSpan{match[0], match[1]})
		}
	}
	for _, secret := range secrets {
		if len(secret) < 8 {
			continue
		}
		for offset := 0; offset < len(text); {
			at := strings.Index(text[offset:], secret)
			if at < 0 {
				break
			}
			at += offset
			spans = append(spans, runRedactionSpan{at, at + len(secret)})
			offset = at + len(secret)
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	merged := []runRedactionSpan{}
	for _, span := range spans {
		if len(merged) > 0 && span.start <= merged[len(merged)-1].end {
			if span.end > merged[len(merged)-1].end {
				merged[len(merged)-1].end = span.end
			}
		} else {
			merged = append(merged, span)
		}
	}
	return merged
}

// Redaction ranges are computed over the joined delta stream first. A secret
// split across database events is removed from every fragment, not merely the
// first event that contains a recognizable prefix.
func redactRunSegment(text string, offset int, spans []runRedactionSpan) string {
	var out strings.Builder
	end, cursor := offset+len(text), offset
	first := sort.Search(len(spans), func(i int) bool { return spans[i].end > offset })
	for _, span := range spans[first:] {
		if span.start >= end {
			break
		}
		left := max(span.start, offset)
		if left > cursor {
			out.WriteString(text[cursor-offset : left-offset])
		}
		if span.start >= offset {
			out.WriteString("[REDACTED]")
		}
		cursor = min(span.end, end)
	}
	if cursor < end {
		out.WriteString(text[cursor-offset:])
	}
	return out.String()
}

func redactRunText(text string, secrets []string) string {
	return redactRunSegment(text, 0, runRedactionSpans(text, secrets))
}

func (a *App) runArchiveSecrets() []string {
	v := []string{a.cfg.PIToken, a.cfg.OpenAIAgentsToken, a.cfg.SMTPPassword}
	if len(a.cfg.CredentialKey) > 0 {
		v = append(v, base64.StdEncoding.EncodeToString(a.cfg.CredentialKey))
	}
	return v
}

type runArchiveEvent struct {
	ID             int64     `json:"id"`
	CreatedAt      time.Time `json:"createdAt"`
	Type           string    `json:"type"`
	Delta          string    `json:"delta,omitempty"`
	Text           string    `json:"text,omitempty"`
	Code           string    `json:"code,omitempty"`
	PayloadOmitted bool      `json:"payloadOmitted,omitempty"`
	// Planner progress carries counts only. They are pointers so a progress row keeps
	// its zero counts while every other event type serializes exactly as before.
	Stage      string `json:"stage,omitempty"`
	Characters *int   `json:"characters,omitempty"`
	Nodes      *int   `json:"nodes,omitempty"`
	Edges      *int   `json:"edges,omitempty"`
	Reasoning  *int   `json:"reasoning,omitempty"`
	Template   string `json:"template,omitempty"`
	Operation  string `json:"operation,omitempty"`
	Target     string `json:"target,omitempty"`
}

func projectRunArchiveEvent(id int64, at time.Time, raw []byte) runArchiveEvent {
	event := runArchiveEvent{ID: id, CreatedAt: at, Type: "unsupported", PayloadOmitted: true}
	var wire struct {
		Type, Delta, Text, Code, Stage, Template, Operation, Target string
		Characters, Nodes, Edges, Reasoning                         *int
	}
	if json.Unmarshal(raw, &wire) != nil {
		return event
	}
	switch wire.Type {
	case "queued", "running", "cancelled", "interrupted":
		event.Type, event.PayloadOmitted = wire.Type, false
	case "text_delta":
		event.Type, event.Delta, event.PayloadOmitted = wire.Type, wire.Delta, false
	case "completed":
		event.Type, event.Text, event.PayloadOmitted = wire.Type, wire.Text, false
	case "failed":
		event.Type, event.Code, event.PayloadOmitted = wire.Type, wire.Code, false
	case "progress":
		// Only the two stages Go writes, non-negative counts and members of the closed template
		// and operation sets are projected, and a target only beside an operation on one node;
		// a row that is anything else stays an opaque, omitted payload like any unknown type.
		if (wire.Stage == "thinking" || wire.Stage == "streaming") && validCount(wire.Characters) && validCount(wire.Nodes) &&
			validCount(wire.Edges) && validCount(wire.Reasoning) && (wire.Template == "" || slices.Contains(planTemplateIDs, wire.Template)) &&
			(wire.Operation == "" || slices.Contains(planOperationTypes, wire.Operation)) &&
			(wire.Target == "" || (slices.Contains(planNodeOperationTypes, wire.Operation) && slices.Contains(planTemplateIDs, wire.Target))) {
			event.Type, event.Stage, event.PayloadOmitted = wire.Type, wire.Stage, false
			event.Characters, event.Nodes, event.Edges, event.Reasoning = wire.Characters, wire.Nodes, wire.Edges, wire.Reasoning
			event.Template, event.Operation, event.Target = wire.Template, wire.Operation, wire.Target
		}
	}
	// Arbitrary metadata, headers, credentials and worker request objects never
	// cross this projection, including fields added to known event types.
	return event
}

func validCount(n *int) bool { return n != nil && *n >= 0 }

func sanitizeRunArchiveEvents(events []runArchiveEvent, secrets []string) {
	var joined strings.Builder
	for _, event := range events {
		if event.Type == "text_delta" {
			joined.WriteString(event.Delta)
		}
	}
	spans, offset := runRedactionSpans(joined.String(), secrets), 0
	for i := range events {
		event := &events[i]
		if event.Type == "text_delta" {
			length := len(event.Delta)
			event.Delta = redactRunSegment(event.Delta, offset, spans)
			offset += length
		}
		event.Text = redactRunText(event.Text, secrets)
		event.Code = redactRunText(event.Code, secrets)
	}
}

func (a *App) downloadRunArchive(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	tx, err := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var status, output string
	var through, count, retainedBytes int64
	err = tx.QueryRow(r.Context(), `SELECT status,output,
		COALESCE((SELECT max(id) FROM run_events WHERE tenant_id=$1 AND run_id=$2),0),
		(SELECT count(*) FROM run_events WHERE tenant_id=$1 AND run_id=$2),
		COALESCE((SELECT sum(octet_length(data::text)+128) FROM run_events WHERE tenant_id=$1 AND run_id=$2),0)
		FROM runs WHERE tenant_id=$1 AND id=$2`, tid, id).Scan(&status, &output, &through, &count, &retainedBytes)
	if noRows(err) {
		fail(w, 404, "not_found", "Run not found")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	limit := a.cfg.RunArchiveMaxBytes
	if limit == 0 {
		limit = defaultRunArchiveMaxBytes
	}
	if retainedBytes+int64(len(output)) > limit {
		fail(w, 413, "archive_too_large", "Run records exceed the configured download limit")
		return
	}
	rows, err := tx.Query(r.Context(), `SELECT id,created_at,data FROM run_events
		WHERE tenant_id=$1 AND run_id=$2 AND id<=$3 ORDER BY id`, tid, id, through)
	if err != nil {
		a.dbError(w, err)
		return
	}
	var events []runArchiveEvent
	for rows.Next() {
		var eid int64
		var at time.Time
		var raw []byte
		if err = rows.Scan(&eid, &at, &raw); err != nil {
			rows.Close()
			a.dbError(w, err)
			return
		}
		events = append(events, projectRunArchiveEvent(eid, at, raw))
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	if int64(len(events)) != count {
		fail(w, 500, "archive_incomplete", "Run records could not be read completely")
		return
	}
	secrets := a.runArchiveSecrets()
	sanitizeRunArchiveEvents(events, secrets)
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	manifest := map[string]any{"type": "archive", "format": "awwo-run-archive-v1", "runId": id,
		"status": status, "scope": "retained_run_events", "throughEventId": through, "eventCount": count,
		"completeThroughCursor": true, "terminal": status != "queued" && status != "running", "redacted": true,
		"output": redactRunText(output, secrets)}
	if err = encoder.Encode(manifest); err != nil {
		a.dbError(w, err)
		return
	}
	for _, event := range events {
		if err = encoder.Encode(event); err != nil {
			a.dbError(w, err)
			return
		}
	}
	if int64(body.Len()) > limit {
		fail(w, 413, "archive_too_large", "Run records exceed the configured download limit")
		return
	}
	// Recheck current membership and session after reading the snapshot, so a
	// membership revoked while preparing a download cannot release its contents.
	cookie, err := r.Cookie("awwo_session")
	if err != nil {
		fail(w, 401, "unauthorized", "Sign in required")
		return
	}
	// 401 means the session ended; a removed membership is answered like any other non-member.
	var signedIn, member bool
	err = a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=$3 AND user_id=$2 AND expires_at>now()),
		EXISTS(SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role IN ('reader','member','admin','owner'))`, tid, currentUser(r).ID, tokenHash(cookie.Value)).Scan(&signedIn, &member)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if !signedIn {
		fail(w, 401, "unauthorized", "Session expired")
		return
	}
	if !member {
		fail(w, 404, "not_found", "Workspace not found")
		return
	}
	sum := sha256.Sum256(body.Bytes())
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Content-Disposition", contentDisposition("run-"+id+".ndjson"))
	w.Header().Set("Content-Length", strconv.Itoa(body.Len()))
	w.Header().Set("X-AwwO-Archive-SHA256", hex.EncodeToString(sum[:]))
	w.Header().Set("X-AwwO-Archive-Bytes", strconv.Itoa(body.Len()))
	w.Header().Set("X-AwwO-Archive-Through-Event", strconv.FormatInt(through, 10))
	w.Header().Set("X-AwwO-Archive-Complete", "true")
	_, _ = w.Write(body.Bytes())
}
