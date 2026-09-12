package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func fileNode(required bool) graphNode {
	return graphNode{ID: "coder", Kind: "session", Contract: &graphContract{Version: 1,
		Outputs: []graphField{{ID: "summary", Type: "text", Required: true}, {ID: "artifact", Type: "file", Required: required}}}}
}

func TestFileOutputAcceptsRealContentAndRejectsUnsafeClaims(t *testing.T) {
	n := fileNode(true)

	// A file output carrying real content becomes a pending artifact; the field keeps a usable
	// value so a pure validation caller never sees an empty required field.
	vals, files, e := graphOutputFiles(n, `{"summary":"done","artifact":{"name":"main.go","content":"package main\n"}}`)
	if e != nil {
		t.Fatal(e)
	}
	if len(files) != 1 || files[0].FieldID != "artifact" || files[0].Name != "main.go" || files[0].Content != "package main\n" {
		t.Fatalf("pending artifact not parsed: %+v", files)
	}
	if vals["artifact"] != "main.go" || vals["summary"] != "done" {
		t.Fatalf("values %+v", vals)
	}

	// A plain string stays a caller-owned reference and produces no stored bytes.
	vals, files, e = graphOutputFiles(n, `{"summary":"done","artifact":"./existing/path.txt"}`)
	if e != nil || len(files) != 0 || vals["artifact"] != "./existing/path.txt" {
		t.Fatalf("reference form broken: %+v %+v %v", vals, files, e)
	}

	for name, output := range map[string]string{
		"missing content":  `{"summary":"s","artifact":{"name":"a.txt"}}`,
		"missing name":     `{"summary":"s","artifact":{"content":"body"}}`,
		"non string body":  `{"summary":"s","artifact":{"name":"a.txt","content":42}}`,
		"extra key":        `{"summary":"s","artifact":{"name":"a.txt","content":"b","path":"/etc/passwd"}}`,
		"absolute path":    `{"summary":"s","artifact":{"name":"/etc/passwd","content":"b"}}`,
		"relative escape":  `{"summary":"s","artifact":{"name":"../../secret","content":"b"}}`,
		"windows path":     `{"summary":"s","artifact":{"name":"dir\\file.txt","content":"b"}}`,
		"dot name":         `{"summary":"s","artifact":{"name":"..","content":"b"}}`,
		"blank name":       `{"summary":"s","artifact":{"name":"   ","content":"b"}}`,
		"control char":     `{"summary":"s","artifact":{"name":"a\nb.txt","content":"b"}}`,
		"array not object": `{"summary":"s","artifact":["a.txt"]}`,
	} {
		if _, _, err := graphOutputFiles(n, output); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}

	// The size cap is enforced on content, not on the whole response.
	oversize, _ := json.Marshal(map[string]any{"summary": "s",
		"artifact": map[string]any{"name": "big.txt", "content": strings.Repeat("x", maxArtifactBytes+1)}})
	if _, _, err := graphOutputFiles(n, string(oversize)); err == nil {
		t.Fatal("accepted an oversize file")
	}
	atLimit, _ := json.Marshal(map[string]any{"summary": "s",
		"artifact": map[string]any{"name": "big.txt", "content": strings.Repeat("x", maxArtifactBytes)}})
	if _, files, err := graphOutputFiles(n, string(atLimit)); err != nil || len(files) != 1 {
		t.Fatalf("rejected a file exactly at the limit: %v", err)
	}
}

func TestFileOutputCountIsBounded(t *testing.T) {
	outputs := make([]graphField, 0, maxArtifactsPerNode+1)
	payload := map[string]any{}
	for i := 0; i <= maxArtifactsPerNode; i++ {
		id := "f" + string(rune('a'+i))
		outputs = append(outputs, graphField{ID: id, Type: "file"})
		payload[id] = map[string]any{"name": id + ".txt", "content": "body"}
	}
	n := graphNode{ID: "many", Kind: "session", Contract: &graphContract{Version: 1, Outputs: outputs}}
	raw, _ := json.Marshal(payload)
	if _, _, e := graphOutputFiles(n, string(raw)); e == nil {
		t.Fatalf("accepted more than %d files", maxArtifactsPerNode)
	}
}

func TestFileOutputGuidanceOnlyWhenDeclared(t *testing.T) {
	withFile := fileNode(true)
	d := graphDocument{Nodes: []graphNode{withFile}}
	prompt, e := graphPrompt(withFile, d, map[string]string{})
	if e != nil {
		t.Fatal(e)
	}
	// Without this instruction the model cannot know how to deliver real content.
	if !strings.Contains(prompt, `{"name":"<filename>","content":"<the complete file text>"}`) {
		t.Fatalf("file guidance absent: %s", prompt)
	}
	textOnly := graphNode{ID: "writer", Kind: "session", Contract: &graphContract{Version: 1,
		Outputs: []graphField{{ID: "summary", Type: "text", Required: true}}}}
	prompt, e = graphPrompt(textOnly, graphDocument{Nodes: []graphNode{textOnly}}, map[string]string{})
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(prompt, "downloadable") {
		t.Fatalf("file guidance leaked into a text-only contract: %s", prompt)
	}
}

func TestContentDispositionIsAlwaysASafeAttachment(t *testing.T) {
	for _, name := range []string{`report"; drop=1.txt`, "line\nbreak.txt", "设计说明.md", strings.Repeat("n", 200)} {
		got := contentDisposition(name)
		if !strings.HasPrefix(got, "attachment;") {
			t.Fatalf("not an attachment for %q: %s", name, got)
		}
		// A quote or newline in the ASCII fallback would let the name break out of the header.
		fallback := strings.SplitN(strings.TrimPrefix(got, "attachment; "), "; filename*=", 2)[0]
		if strings.ContainsAny(fallback, "\n\r") {
			t.Fatalf("header injection possible for %q: %s", name, got)
		}
		if strings.Contains(got, "inline") {
			t.Fatalf("inline disposition for %q", name)
		}
	}
	if !strings.Contains(contentDisposition("设计说明.md"), "filename*=UTF-8''%E8%AE%BE") {
		t.Fatal("non-ASCII name not encoded per RFC 5987")
	}
	if !strings.Contains(contentDisposition("   "), "deliverable") {
		t.Fatal("blank name has no usable fallback")
	}
}

// readRaw performs a non-JSON request so a download's bytes and headers can be asserted exactly.
func (h *harness) readRaw(t *testing.T, cookie *http.Cookie, path string, status int) (http.Header, []byte) {
	t.Helper()
	r, e := http.NewRequest("GET", h.server.URL+"/api/v1"+path, nil)
	if e != nil {
		t.Fatal(e)
	}
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Fatalf("GET %s got %d want %d: %s", path, resp.StatusCode, status, body)
	}
	return resp.Header, body
}

func TestPostgresArtifactsAreStoredScopedAndDownloadable(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "owner-artifacts@awwo.invalid")
	canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Delivery",
		"document": map[string]any{"nodes": []any{map[string]any{"id": "coder", "kind": "form", "fields": []any{}}}, "edges": []any{}}}, 201)
	cid := canvas["id"].(string)

	n := fileNode(true)
	raw := `{"summary":"built the module","artifact":{"name":"设计 说明.md","content":"# Title\nreal body\n"}}`
	vals, files, e := graphOutputFiles(n, raw)
	if e != nil {
		t.Fatal(e)
	}
	recorded, e := h.a.storeArtifacts(ctx, tid, cid, "run-1", "coder", raw, vals, files)
	if e != nil {
		t.Fatal(e)
	}

	// The recorded output references the stored file instead of repeating its content, so a
	// downstream node and the canvas never carry the payload twice.
	var out map[string]string
	if e = json.Unmarshal([]byte(recorded), &out); e != nil {
		t.Fatal(e)
	}
	if !strings.HasPrefix(out["artifact"], artifactRefPrefix) || strings.Contains(recorded, "real body") {
		t.Fatalf("output not normalized: %s", recorded)
	}
	if out["summary"] != "built the module" {
		t.Fatalf("non-file value altered: %s", recorded)
	}
	id := strings.TrimPrefix(out["artifact"], artifactRefPrefix)

	// The bytes come back exactly, as a non-executable attachment.
	header, body := h.readRaw(t, owner, "/tenants/"+tid+"/artifacts/"+id, 200)
	if string(body) != "# Title\nreal body\n" {
		t.Fatalf("content round-trip failed: %q", body)
	}
	if header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("served with a guessable type: %s", header.Get("Content-Type"))
	}
	if !strings.HasPrefix(header.Get("Content-Disposition"), "attachment;") {
		t.Fatalf("not an attachment: %s", header.Get("Content-Disposition"))
	}

	// Listing exposes metadata for review without shipping the bytes.
	listed := h.request(t, owner, "GET", "/tenants/"+tid+"/canvases/"+cid+"/artifacts", nil, 200)
	items := listed["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("listing %v", items)
	}
	item := items[0].(map[string]any)
	if item["name"] != "设计 说明.md" || item["size"].(float64) != float64(len("# Title\nreal body\n")) {
		t.Fatalf("metadata %v", item)
	}
	if _, present := item["content"]; present {
		t.Fatal("listing leaked file content")
	}
	// A complete listing says so, so a caller can tell "all of them" from "the first page".
	if listed["truncated"] != false {
		t.Fatalf("completeness not reported: %v", listed["truncated"])
	}

	// A second tenant must not reach another tenant's deliverable, even with a valid session.
	// Both a wrong-tenant path and a non-member request answer 404, so membership is enforced
	// without disclosing that the workspace or the file exists.
	other, otherTid, _ := h.register(t, "other-artifacts@awwo.invalid")
	h.readRaw(t, other, "/tenants/"+otherTid+"/artifacts/"+id, 404)
	h.readRaw(t, other, "/tenants/"+tid+"/artifacts/"+id, 404)
	h.request(t, other, "GET", "/tenants/"+tid+"/canvases/"+cid+"/artifacts", nil, 404)
	h.readRaw(t, nil, "/tenants/"+tid+"/artifacts/"+id, 401)

	// Deleting the canvas must not leave the bytes behind.
	h.request(t, owner, "DELETE", "/tenants/"+tid+"/canvases/"+cid, nil, 204)
	var remaining int
	if e = h.db.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE tenant_id=$1", tid).Scan(&remaining); e != nil {
		t.Fatal(e)
	}
	if remaining != 0 {
		t.Fatalf("%d artifacts survived their canvas", remaining)
	}
}

func TestPostgresArtifactsRetainMixedContractTypes(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "artifact-types@example.test")
	canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Typed files", "document": map[string]any{}}, 201)
	n := fileNode(true)
	n.Contract.Outputs = append(n.Contract.Outputs, graphField{ID: "score", Type: "number", Required: true}, graphField{ID: "approved", Type: "boolean", Required: true})
	raw := "```json\n{\"summary\":\"A plan\",\"artifact\":{\"name\":\"plan.md\",\"content\":\"# Plan\"},\"score\":42,\"approved\":true}\n```"
	vals, files, e := graphOutputFiles(n, raw)
	if e != nil {
		t.Fatal(e)
	}
	stored, e := h.a.storeArtifacts(ctx, tid, canvas["id"].(string), "typed-run", "node", raw, vals, files)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = graphOutput(n, stored); e != nil {
		t.Fatal("stored artifact broke its own output contract", stored, e)
	}
	var values map[string]any
	if e = json.Unmarshal([]byte(stored), &values); e != nil {
		t.Fatal(e)
	}
	if values["score"] != float64(42) || values["approved"] != true {
		t.Fatal("typed fields stringified", values)
	}
}

func TestPostgresArtifactStorageIsIdempotentPerNodeField(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "repeat-artifacts@awwo.invalid")
	canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Repeat",
		"document": map[string]any{"nodes": []any{map[string]any{"id": "coder", "kind": "form", "fields": []any{}}}, "edges": []any{}}}, 201)
	cid := canvas["id"].(string)

	n := fileNode(true)
	store := func(body string) string {
		vals, files, e := graphOutputFiles(n, body)
		if e != nil {
			t.Fatal(e)
		}
		recorded, e := h.a.storeArtifacts(ctx, tid, cid, "run-1", "coder", body, vals, files)
		if e != nil {
			t.Fatal(e)
		}
		return recorded
	}

	// Recording a node's state can fail transiently and the executor then re-reads the same
	// completed child. Re-storing must converge on one row and one reference, not pile up orphans.
	first := store(`{"summary":"s","artifact":{"name":"a.txt","content":"first"}}`)
	second := store(`{"summary":"s","artifact":{"name":"a.txt","content":"second"}}`)
	if first != second {
		t.Fatalf("reference changed across a repeat store: %s vs %s", first, second)
	}
	var count int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE tenant_id=$1", tid).Scan(&count); e != nil {
		t.Fatal(e)
	}
	if count != 1 {
		t.Fatalf("expected one row after a repeat store, got %d", count)
	}

	var out map[string]string
	if e := json.Unmarshal([]byte(second), &out); e != nil {
		t.Fatal(e)
	}
	// The surviving row holds the latest content, so the reference never resolves to stale bytes.
	_, body := h.readRaw(t, owner, "/tenants/"+tid+"/artifacts/"+strings.TrimPrefix(out["artifact"], artifactRefPrefix), 200)
	if string(body) != "second" {
		t.Fatalf("stale content after repeat store: %q", body)
	}

	// A different field of the same node is a different deliverable.
	if artifactID(tid, "run-1", "coder", "artifact") == artifactID(tid, "run-1", "coder", "other") {
		t.Fatal("field identity not part of the artifact id")
	}
	if artifactID(tid, "run-1", "coder", "artifact") == artifactID("other-tenant", "run-1", "coder", "artifact") {
		t.Fatal("tenant not part of the artifact id")
	}
}

func TestPostgresArtifactStorageLeavesNoPartialSetOnFailure(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "partial-artifacts@awwo.invalid")

	// A canvas that does not exist violates the composite foreign key, so the whole set must roll
	// back: a node reporting success with a half-stored deliverable would be a false delivery.
	n := graphNode{ID: "coder", Kind: "session", Contract: &graphContract{Version: 1, Outputs: []graphField{
		{ID: "first", Type: "file"}, {ID: "second", Type: "file"}}}}
	raw := `{"first":{"name":"a.txt","content":"A"},"second":{"name":"b.txt","content":"B"}}`
	vals, files, e := graphOutputFiles(n, raw)
	if e != nil || len(files) != 2 {
		t.Fatalf("setup %v %+v", e, files)
	}
	if _, e = h.a.storeArtifacts(ctx, tid, "missing-canvas", "run-1", "coder", raw, vals, files); e == nil {
		t.Fatal("stored a deliverable against a canvas that does not exist")
	}
	var count int
	if e = h.db.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE tenant_id=$1", tid).Scan(&count); e != nil {
		t.Fatal(e)
	}
	if count != 0 {
		t.Fatalf("%d rows left behind by a failed set", count)
	}
	_ = owner
}
