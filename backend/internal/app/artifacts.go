package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"strings"
)

// storeArtifacts persists a node's file deliverables and rewrites their field values into stable
// references. It returns the output to record for the node: unchanged when the node produced no
// files, so an existing single-field text contract keeps its exact original text.
//
// Storage happens in one transaction with the same tenant/canvas scope the run already holds, so a
// partially written deliverable set is never observable.
func (a *App) storeArtifacts(ctx context.Context, tid, canvasID, runID, nodeID, output string,
	vals map[string]string, files []pendingArtifact) (string, error) {
	if len(files) == 0 {
		return output, nil
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	refs := make(map[string]string, len(files))
	for _, file := range files {
		sum := sha256.Sum256([]byte(file.Content))
		id := artifactID(tid, runID, nodeID, file.FieldID)
		// Recording a node's state can fail transiently, after which the executor re-reads the same
		// completed child. A derived id plus upsert makes a repeat store converge on one row with
		// one reference, instead of accumulating orphaned duplicates of the same deliverable.
		if _, e = tx.Exec(ctx,
			"INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)"+
				" ON CONFLICT (id) DO UPDATE SET canvas_id=EXCLUDED.canvas_id,name=EXCLUDED.name,size=EXCLUDED.size,sha256=EXCLUDED.sha256,content=EXCLUDED.content,created_at=now()",
			id, tid, canvasID, runID, nodeID, file.FieldID, file.Name, len(file.Content), hex.EncodeToString(sum[:]), []byte(file.Content)); e != nil {
			return "", e
		}
		refs[file.FieldID] = artifactRefPrefix + id
	}
	// Only the file fields change; every other validated value is recorded exactly as parsed.
	recorded := make(map[string]string, len(vals))
	for id, value := range vals {
		if ref, ok := refs[id]; ok {
			recorded[id] = ref
			continue
		}
		recorded[id] = value
	}
	encoded, e := json.Marshal(recorded)
	if e != nil {
		return "", e
	}
	if e = tx.Commit(ctx); e != nil {
		return "", e
	}
	return string(encoded), nil
}

// artifactID derives a deliverable's identity from the run, node and field that produced it, so
// storing the same deliverable twice targets one row. The tenant is mixed in so an id is never
// meaningful outside it, and the value is unguessable in practice because run ids are random.
func artifactID(tid, runID, nodeID, fieldID string) string {
	sum := sha256.Sum256([]byte(tid + "\x00" + runID + "\x00" + nodeID + "\x00" + fieldID))
	return "a" + base64.RawURLEncoding.EncodeToString(sum[:24])
}

// contentDisposition builds an attachment header that is safe for any model-chosen name: an ASCII
// fallback plus the exact name as RFC 5987 UTF-8. It is always `attachment`, never `inline`.
func contentDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '"' || r == '\\' || r > 0x7e {
			return '_'
		}
		return r
	}, name)
	if strings.TrimSpace(ascii) == "" {
		ascii = "deliverable"
	}
	base := mime.FormatMediaType("attachment", map[string]string{"filename": ascii})
	if base == "" {
		// Never emit a header fragment that starts with a bare parameter.
		base = `attachment; filename="deliverable"`
	}
	return base + "; filename*=UTF-8''" + escapeExtendedFilename(name)
}

func escapeExtendedFilename(name string) string {
	const safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_~"
	var b strings.Builder
	for _, c := range []byte(name) {
		if strings.IndexByte(safe, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// downloadArtifact returns one stored deliverable to any member of its tenant.
//
// The bytes are model-produced, so they are never served with a guessed content type and never
// inline: an HTML or SVG deliverable rendered in the site's origin would be stored XSS. Always
// application/octet-stream plus an attachment disposition (the router already sends nosniff).
func (a *App) downloadArtifact(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	var name string
	var content []byte
	e := a.db.QueryRow(r.Context(), "SELECT name,content FROM artifacts WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&name, &content)
	if noRows(e) {
		fail(w, 404, "not_found", "File not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(name))
	w.Header().Set("Content-Length", fmt.Sprint(len(content)))
	w.WriteHeader(200)
	_, _ = w.Write(content)
}

const artifactListLimit = 500

// listArtifacts reports a canvas's stored deliverables without their bytes, so a member can see
// what exists and how large it is before downloading. One row beyond the limit is read only to
// state whether the listing is complete: a silently truncated list would misreport what the
// workspace holds.
func (a *App) listArtifacts(w http.ResponseWriter, r *http.Request) {
	tid, canvasID := r.PathValue("tenantId"), r.PathValue("id")
	rows, e := rowsJSON(r.Context(), a.db,
		"SELECT jsonb_build_object('id',id,'name',name,'size',size,'sha256',sha256,'runId',run_id,'nodeId',node_id,'fieldId',field_id,'createdAt',created_at) FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 ORDER BY created_at DESC, id LIMIT $3",
		tid, canvasID, artifactListLimit+1)
	if e != nil {
		a.dbError(w, e)
		return
	}
	truncated := len(rows) > artifactListLimit
	if truncated {
		rows = rows[:artifactListLimit]
	}
	items := make([]json.RawMessage, 0, len(rows))
	for _, row := range rows {
		items = append(items, json.RawMessage(row))
	}
	writeJSON(w, 200, map[string]any{"items": items, "truncated": truncated})
}
