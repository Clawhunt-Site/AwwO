package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestCloseUnterminatedJSONObjectRestoresOnlyMissingClosers(t *testing.T) {
	for _, test := range []struct{ name, in, want string }{
		{"one closer", `{"a":"x"`, `{"a":"x"}`},
		{"file object", `{"a":"x","f":{"name":"index.html","content":"<html></html>"}`, `{"a":"x","f":{"name":"index.html","content":"<html></html>"}}`},
		{"list then object", `{"a":["x","y"]`, `{"a":["x","y"]}`},
		{"three levels", `{"a":[{"b":"c"`, `{"a":[{"b":"c"}]}`},
		{"escaped quote", `{"a":"say \"hi\""`, `{"a":"say \"hi\""}`},
		{"escaped backslash", `{"a":"C:\\"`, `{"a":"C:\\"}`},
		{"braces inside strings", `{"code":"if (a) { b(); } else { c[0]; }"`, `{"code":"if (a) { b(); } else { c[0]; }"}`},
		{"trailing whitespace", "{\"a\":\"x\"\n  ", `{"a":"x"}`},
		{"already valid", `{"a":"x"}`, `{"a":"x"}`},
		// Everything below is a different defect and must stay a failure.
		{"ends inside a string", `{"a":"unfinished`, `{"a":"unfinished`},
		{"ends after a separator", `{"a":"x",`, `{"a":"x",`},
		{"ends after a colon", `{"a":`, `{"a":`},
		{"ends after a key", `{"a":"x","b"`, `{"a":"x","b"`},
		{"ends after a number", `{"n":12`, `{"n":12`},
		{"ends after a literal", `{"b":true`, `{"b":true`},
		{"mismatched closer", `{"a":[}`, `{"a":[}`},
		{"closes early", `{"a":"x"} trailing`, `{"a":"x"} trailing`},
		{"not an object", `["x"`, `["x"`},
		{"plain text", `Done.`, `Done.`},
		{"too deep", `{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":"x"`, `{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":"x"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := closeUnterminatedJSONObject(test.in)
			if got != test.want {
				t.Fatalf("closeUnterminatedJSONObject(%q) = %q, want %q", test.in, got, test.want)
			}
			if again := closeUnterminatedJSONObject(got); again != got {
				t.Fatalf("not idempotent: %q then %q", got, again)
			}
		})
	}
}

// The shape a coding node delivered on 2026-10-10: a complete game in a file field,
// with only the final closing brace of the outer object missing.
func gameDeliveryNode() graphNode {
	return graphNode{ID: "game", Kind: "session", Contract: &graphContract{Version: 1, Outputs: []graphField{
		{ID: "delivery", Type: "markdown", Required: true},
		{ID: "preview", Type: "file"},
		{ID: "checks", Type: "markdown"},
	}}}
}

const gamePage = "<!doctype html><html><head><title>Game</title></head><body><script>if (ready) { start({ hp: [100] }); }</script></body></html>"

func TestGraphOutputFilesAcceptsDeliveryMissingFinalBrace(t *testing.T) {
	n := gameDeliveryNode()
	body := `{"delivery":"实现页面：\n1. 主菜单","preview":{"name":"index.html","content":` + mustJSON(gamePage) + `}`
	for name, output := range map[string]string{
		"bare":   body,
		"fenced": "```json\n" + body + "\n```",
		"spaced": "\n" + body + "\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			vals, files, err := graphOutputFiles(n, output)
			if err != nil {
				t.Fatal("delivery missing only its final brace was rejected:", err)
			}
			if vals["delivery"] != "实现页面：\n1. 主菜单" || vals["preview"] != "index.html" {
				t.Fatalf("values %v", vals)
			}
			if len(files) != 1 || files[0].Name != "index.html" || files[0].Content != gamePage || files[0].FieldID != "preview" {
				t.Fatalf("files %+v", files)
			}
		})
	}
	// A delivery cut off inside its content is still incomplete and must not be stored as a file.
	cut := `{"delivery":"x","preview":{"name":"index.html","content":"<!doctype html><html><head></head><body><script>if (ready) {`
	if _, _, err := graphOutputFiles(n, cut); err == nil {
		t.Fatal("a delivery truncated inside its content was accepted")
	}
	missingRequired := `{"preview":{"name":"index.html","content":` + mustJSON(gamePage) + `}`
	if _, _, err := graphOutputFiles(n, missingRequired); err == nil {
		t.Fatal("restoring a closer must not waive a missing required field")
	}
}

func TestSingleFieldDeliveryMissingFinalBraceUsesTheField(t *testing.T) {
	page := "<html><head></head><body>Result</body></html>"
	n := graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "page", Type: "html", Required: true}}}}
	vals, _, err := graphOutputFiles(n, `{"page":`+mustJSON(page))
	if err != nil || vals["page"] != page {
		t.Fatalf("single html field read %q, %v", vals["page"], err)
	}
	// Plain text that merely starts with a brace is still the field's whole value.
	text := graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "answer", Type: "markdown", Required: true}}}}
	if vals, _, err := graphOutputFiles(text, `{"other":"x"`); err != nil || vals["answer"] != `{"other":"x"` {
		t.Fatalf("plain text answer changed: %q, %v", vals["answer"], err)
	}
}

func TestProjectFileDeliveryReadsDeliveryMissingFinalBrace(t *testing.T) {
	output := `{"delivery":"done","preview":{"name":"index.html","content":` + mustJSON(gamePage) + `}`
	projected, changed := projectFileDelivery(output, nil)
	if !changed || strings.Contains(projected, "start({") {
		t.Fatalf("file bytes stayed in the transcript: changed=%v %s", changed, projected)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(projected), &fields); err != nil || string(fields["delivery"]) != `"done"` {
		t.Fatalf("projection is not the delivery object: %s (%v)", projected, err)
	}
}

func TestPostgresArtifactStoredFromDeliveryMissingFinalBrace(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "owner-unclosed@awwo.invalid")
	canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Game",
		"document": map[string]any{"nodes": []any{map[string]any{"id": "game", "kind": "form", "fields": []any{}}}, "edges": []any{}}}, 201)
	cid := canvas["id"].(string)

	n := gameDeliveryNode()
	raw := `{"delivery":"playable build","preview":{"name":"index.html","content":` + mustJSON(gamePage) + `}`
	vals, files, e := graphOutputFiles(n, raw)
	if e != nil {
		t.Fatal(e)
	}
	recorded, e := h.a.storeArtifacts(ctx, tid, cid, "run-unclosed", "game", raw, vals, files)
	if e != nil {
		t.Fatal("storage disagreed with validation:", e)
	}
	var out map[string]string
	if e = json.Unmarshal([]byte(recorded), &out); e != nil {
		t.Fatalf("recorded output is not a JSON object: %s", recorded)
	}
	if out["delivery"] != "playable build" || !strings.HasPrefix(out["preview"], artifactRefPrefix) || strings.Contains(recorded, "start({") {
		t.Fatalf("recorded %s", recorded)
	}
	// What was recorded reads back as a valid delivery for downstream nodes.
	if again, _, e := graphOutputFiles(n, recorded); e != nil || again["preview"] != out["preview"] {
		t.Fatalf("recorded output no longer satisfies the contract: %v %v", again, e)
	}
	_, body := h.readRaw(t, owner, "/tenants/"+tid+"/artifacts/"+strings.TrimPrefix(out["preview"], artifactRefPrefix), 200)
	if string(body) != gamePage {
		t.Fatalf("stored page differs: %q", body)
	}
}
