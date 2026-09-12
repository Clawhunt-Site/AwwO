package app

import (
	"encoding/json"
	"testing"
)

func TestHTMLDeliverableDocumentShape(t *testing.T) {
	for _, value := range []string{
		`<html><head></head><body>hello</body></html>`,
		`<!DOCTYPE html><html lang="en"><head><style>body{color:red}</style><title>hello</title></head><body><h1>hello</h1></body></html>`,
		"```html\n<html><head></head><body>hello</body></html>\n```",
		`<html data-example="<body>"><head><!-- <body></body> --></head><body><script>const sample="<html><head></head><body>fake</body></html>";</script>visible</body></html>`,
	} {
		if !completeHTMLDocument(value) {
			t.Fatal("valid document rejected", value)
		}
	}
	for _, value := range []string{
		"page.html", `<h1>fragment</h1>`, `<!-- <html><head></head><body>fake</body></html> -->`,
		`<html><body>missing head</body></html>`, `<html><head/><body></body></html>`,
		`<html><head></head><body><script>"</body></html>"`,
		`<html><head></head><body></body></html> trailing prose`,
		`<script><html><head></head><body></body></html></script>`,
		`<html><head></head><body>unfinished</html>`,
	} {
		if completeHTMLDocument(value) {
			t.Fatal("invalid document accepted", value)
		}
	}
}
func TestHTMLGraphContractsValidateRealDocuments(t *testing.T) {
	n := graphNode{ID: "html", Kind: "session", Binding: &struct {
		CompanyID string `json:"companyId"`
		AgentID   string `json:"agentId"`
	}{AgentID: "agent"}, Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "page", Type: "html", Required: true}}}}
	raw, _ := json.Marshal(graphDocument{Nodes: []graphNode{n}, Edges: []graphEdge{}})
	if _, _, e := parseGraph(raw, nil); e != nil {
		t.Fatal(e)
	}
	valid := `<html><head></head><body><h1>result</h1></body></html>`
	for _, out := range []string{valid, `{"page":"` + valid + `"}`} {
		vals, e := graphOutput(n, out)
		if e != nil || vals["page"] != valid {
			t.Fatal(vals, e)
		}
	}
	for _, out := range []string{`page.html`, `{"page":"<h1>fragment</h1>"}`, `{"page":42}`} {
		if _, e := graphOutput(n, out); e == nil {
			t.Fatal("invalid html output accepted", out)
		}
	}
	if fieldType("html") != "text" {
		t.Fatal("HTML ports incompatible with rendered text contract")
	}
}
