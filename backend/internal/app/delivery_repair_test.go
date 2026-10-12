package app

import (
	"encoding/json"
	"strings"
	"testing"
)

// The delivery a frontend node returned twice on 2026-10-11 (qwen3.8-27b-p6), reduced: pretty-printed, a complete
// page in the file field whose content string never closed, followed by the two closing braces it needed.
const unquotedGameDelivery = "{\n  \"checks\": \"验证步骤：\\n1. 打开 index.html\",\n  \"delivery\": \"实现页面：解谜游戏\",\n" +
	"  \"preview\": {\n    \"name\": \"index.html\",\n    \"content\": \"<!DOCTYPE html>\\n<html lang=\\\"zh\\\">\\n<body>\\n<script>\\n" +
	"window.addEventListener('resize', () => {\\n  canvas.width = width;\\n});\\n</script>\\n</body>\\n</html>\\n  }\n}"

const unquotedGamePage = "<!DOCTYPE html>\n<html lang=\"zh\">\n<body>\n<script>\nwindow.addEventListener('resize', () => {\n  canvas.width = width;\n});\n</script>\n</body>\n</html>\n"

func TestGraphOutputFilesAcceptsGameWhoseContentLacksItsClosingQuote(t *testing.T) {
	n := gameDeliveryNode()
	vals, files, err := graphOutputFiles(n, unquotedGameDelivery)
	if err != nil {
		t.Fatal("a complete delivery missing only its final quote was rejected:", err)
	}
	if vals["delivery"] != "实现页面：解谜游戏" || vals["checks"] != "验证步骤：\n1. 打开 index.html" || vals["preview"] != "index.html" {
		t.Fatalf("values %v", vals)
	}
	if len(files) != 1 || files[0].Name != "index.html" || files[0].Content != unquotedGamePage {
		t.Fatalf("files %+v", files)
	}
	// Every reader agrees: the transcript projection reads the same object.
	if projected, changed := projectFileDelivery(unquotedGameDelivery, nil); !changed || strings.Contains(projected, "addEventListener") {
		t.Fatalf("file bytes stayed in the transcript: changed=%v %s", changed, projected)
	}
}

func TestRepairDeliveryJSONReadsEachSlipOneWay(t *testing.T) {
	for _, test := range []struct {
		name, in string
		want     map[string]any
	}{
		{"final quote, compact", `{"a":"x","f":{"name":"i.html","content":"<p>{}</p>}}`,
			map[string]any{"a": "x", "f": map[string]any{"name": "i.html", "content": "<p>{}</p>"}}},
		{"final quote, list", `{"a":["x","y]}`, map[string]any{"a": []any{"x", "y"}}},
		{"final quote, one level", `{"a":"done` + "\n}", map[string]any{"a": "done"}},
		{"raw line break and tab", "{\"a\":\"line1\nline2\tend\"}", map[string]any{"a": "line1\nline2\tend"}},
		{"other control character", "{\"a\":\"x\x01y\"}", map[string]any{"a": "x\x01y"}},
		{"backslash that starts no escape", `{"code":"var s = 'It\'s'; /\d+/.test(s)"}`, map[string]any{"code": `var s = 'It\'s'; /\d+/.test(s)`}},
		{"code point escape of JavaScript", `{"code":"'\u{1F600}'"}`, map[string]any{"code": `'\u{1F600}'`}},
		{"valid escapes kept", "{\"a\":\"\\u0041\\\"\\\\\\/\nB\"}", map[string]any{"a": "A\"\\/\nB"}},
		{"quotation marks in Chinese", `{"delivery":"点击"开始游戏"进入","checks":"ok"}`, map[string]any{"delivery": `点击"开始游戏"进入`, "checks": "ok"}},
		{"unescaped attributes in a page", `{"preview":{"name":"index.html","content":"<div class="game" id="g"><b>"hi"</b></div>"}}`,
			map[string]any{"preview": map[string]any{"name": "index.html", "content": `<div class="game" id="g"><b>"hi"</b></div>`}}},
		{"final quote and a bad escape", `{"page":"<script>/\d/</script>}`, map[string]any{"page": `<script>/\d/</script>`}},
		{"missing closers and a raw line break", "{\"a\":\"x\ny\"", map[string]any{"a": "x\ny"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := repairDeliveryJSON(test.in)
			var value map[string]any
			if err := json.Unmarshal([]byte(got), &value); err != nil {
				t.Fatalf("repairDeliveryJSON(%q) = %q, not JSON: %v", test.in, got, err)
			}
			want, _ := json.Marshal(test.want)
			have, _ := json.Marshal(value)
			if string(want) != string(have) {
				t.Fatalf("repairDeliveryJSON(%q) read %s, want %s", test.in, have, want)
			}
			if again := repairDeliveryJSON(got); again != got {
				t.Fatalf("not idempotent: %q then %q", got, again)
			}
		})
	}
}

func TestRepairDeliveryJSONLeavesOtherDefectsFailing(t *testing.T) {
	for _, in := range []string{
		`{"a":"x"}`, // valid: returned as written
		`{"delivery":"x","preview":{"name":"index.html","content":"<!doctype html><html><body><script>if (ready) {`, // cut inside its content
		`{"a":"unfinished`,   // ends inside a string with no closer after it
		`{"a":"x"} trailing`, // a note after the object
		`{"a":"x"}{"b":"y"}`, // two objects
		`["x"`,               // not an object
		`Done.`,              // plain text
		`{"a":"x","b"`,       // ends after a key
		`{"a":"x",`,          // ends after a separator
		`{"a":1 "b":2}`,      // a missing comma has no single reading
		`{"a":"x"]`,          // mismatched closer
		`{"a":"x}]`,          // the closers after the string are not the open ones
		`{"a":{"b":"x}`,      // one closer short
		`{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":"x}}}}}}}}}`, // deeper than a delivery nests
	} {
		if got := repairDeliveryJSON(in); got != in {
			t.Fatalf("repairDeliveryJSON(%q) changed it to %q", in, got)
		}
	}
	// A repair only ever makes one object; the contract is still checked on it.
	if _, _, err := graphOutputFiles(gameDeliveryNode(), `{"preview":{"name":"index.html","content":"<p>x</p>}}`); err == nil {
		t.Fatal("a repaired delivery without its required field was accepted")
	}
}

func TestTextOnlyNodePolicyForbidsPointingAtFiles(t *testing.T) {
	text := graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "result", Type: "markdown", Required: true}, {ID: "followups", Type: "markdown"}}}}
	if policy := graphOutputPolicy(text); !strings.HasSuffix(policy, textOnlyDeliveryPolicy) || !strings.Contains(policy, "/workspace/output") {
		t.Fatal("a text-only node may still point the reader at a file path", policy)
	}
	single := graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "answer", Type: "text", Required: true}}}}
	if policy := graphOutputPolicy(single); !strings.Contains(policy, textOnlyDeliveryPolicy) || !strings.Contains(policy, plainTextAllowance) {
		t.Fatal("the single-field policy lost the text-only rule or its plain-text allowance", policy)
	}
	for name, n := range map[string]graphNode{
		"file": gameDeliveryNode(),
		"html": {Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "page", Type: "html", Required: true}}}},
	} {
		if strings.Contains(graphOutputPolicy(n), textOnlyDeliveryPolicy) {
			t.Fatalf("a node with a %s output was told it delivers only text", name)
		}
	}
}
