package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

// The canvas list's summary view returns each canvas's outline, exactly what a list card's thumbnail draws (the first 60
// nodes with a string id, the edges between two of them, and the count of all such nodes), never its document; its
// other fields are the full view's; the full view is as it was; both page the same set; any other view is refused.
func TestPostgresCanvasListSummary(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "canvas-outline-owner@example.test")
	outsider, _, _ := h.register(t, "canvas-outline-other@example.test")
	insert := func(id string, at string, document any) {
		t.Helper()
		raw, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := h.db.Exec(ctx, `INSERT INTO canvases(id,tenant_id,name,document,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz + interval '1 hour')`,
			id, tid, "Canvas "+id, raw, len(id), at); err != nil {
			t.Fatal(err)
		}
	}
	output := strings.Repeat("published output that a card never draws ", 2000)
	insert("co-full", "2001-01-05", map[string]any{"version": 2,
		"nodes": []any{
			map[string]any{"id": "a", "x": 10, "y": 20, "w": 340, "h": 260, "kind": "session", "title": "Alpha", "instructions": "secret instructions", "lastOutput": map[string]any{"text": output}},
			"not a node",
			map[string]any{"x": 1, "title": "no id"},
			map[string]any{"id": 5, "x": 2},
			map[string]any{"id": "5", "x": 3},
			map[string]any{"id": "b", "x": 400.5, "y": -20, "kind": "session", "lastOutput": map[string]any{"text": output}},
		},
		"edges": []any{
			map[string]any{"id": "e1", "fromNode": "a", "toNode": "b", "kind": "data", "label": "hidden label"},
			7,
			map[string]any{"fromNode": "a", "toNode": "nowhere"},
			map[string]any{"fromNode": 5, "toNode": "b"},
			map[string]any{"fromNode": "5", "toNode": "a"},
			map[string]any{"fromNode": "a", "toNode": 5},
		},
		"execution": map[string]any{"reviewerNodeId": "b"}})
	// A junk element first: the 60 boxes are the first 60 nodes with a string id, not the first 60 positions.
	many := []any{"junk"}
	edges := []any{}
	for i := 0; i < 70; i++ {
		many = append(many, map[string]any{"id": fmt.Sprintf("n%d", i), "x": i * 10, "y": 0})
	}
	// 450 edges from n0, to n1..n69 in turn: those to n60..n69 end at a node the thumbnail does not draw.
	drawnEdges := 0
	for i := 0; i < 450; i++ {
		to := 1 + i%69
		if to < 60 {
			drawnEdges++
		}
		edges = append(edges, map[string]any{"fromNode": "n0", "toNode": fmt.Sprintf("n%d", to)})
	}
	insert("co-many", "2001-01-04", map[string]any{"nodes": many, "edges": edges})
	insert("co-odd", "2001-01-03", map[string]any{"nodes": map[string]any{"a": 1}, "edges": "x"})
	insert("co-empty", "2001-01-02", map[string]any{})
	insert("co-array", "2001-01-01", []any{1, 2})
	path := "/tenants/" + tid + "/canvases"

	summary := h.request(t, owner, "GET", path+"?view=summary", nil, 200)
	full := h.request(t, owner, "GET", path, nil, 200)
	items := map[string]map[string]any{}
	order := []string{}
	for _, value := range summary["items"].([]any) {
		item := value.(map[string]any)
		id := item["id"].(string)
		items[id] = item
		order = append(order, id)
		if _, ok := item["document"]; ok {
			t.Fatalf("%s: a summary item carries its document", id)
		}
	}
	// Every field but the document is the full view's, in the same order.
	fullOrder := []string{}
	for _, value := range full["items"].([]any) {
		item := value.(map[string]any)
		id := item["id"].(string)
		fullOrder = append(fullOrder, id)
		if _, ok := item["outline"]; ok {
			t.Fatal("a full item carries an outline")
		}
		for _, key := range []string{"id", "tenantId", "name", "version", "createdAt", "updatedAt"} {
			if !reflect.DeepEqual(item[key], items[id][key]) {
				t.Fatalf("%s: %s is %v in the summary, %v in the full view", id, key, items[id][key], item[key])
			}
		}
		if id == "co-full" {
			text := item["document"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["lastOutput"].(map[string]any)["text"]
			if text != output {
				t.Fatal("the full view lost a node's output")
			}
		}
	}
	if !reflect.DeepEqual(order, fullOrder) {
		t.Fatalf("summary order %v, full order %v", order, fullOrder)
	}
	raw, _ := json.Marshal(summary)
	for _, hidden := range []string{"published output", "secret instructions", "hidden label", "reviewerNodeId", "Alpha", "no id", "nowhere"} {
		if strings.Contains(string(raw), hidden) {
			t.Fatalf("the summary list leaks %q", hidden)
		}
	}
	outline := func(id string) (nodes, edges []any, count float64) {
		o := items[id]["outline"].(map[string]any)
		return o["nodes"].([]any), o["edges"].([]any), o["nodeCount"].(float64)
	}
	nodes, links, count := outline("co-full")
	wantNodes := []any{map[string]any{"id": "a", "x": 10.0, "y": 20.0, "w": 340.0, "h": 260.0}, map[string]any{"id": "5", "x": 3.0},
		map[string]any{"id": "b", "x": 400.5, "y": -20.0}}
	wantLinks := []any{map[string]any{"fromNode": "a", "toNode": "b"}, map[string]any{"fromNode": "5", "toNode": "a"}}
	if !reflect.DeepEqual(nodes, wantNodes) || !reflect.DeepEqual(links, wantLinks) || count != 3 {
		t.Fatalf("outline of co-full: %v %v count %v", nodes, links, count)
	}
	nodes, links, count = outline("co-many")
	if len(nodes) != 60 || nodes[59].(map[string]any)["id"] != "n59" || len(links) != drawnEdges || count != 70 {
		t.Fatalf("co-many: %d nodes (last %v), %d edges, count %v; want 60, %d and 70", len(nodes), nodes[len(nodes)-1], len(links), count, drawnEdges)
	}
	for _, link := range links {
		if to := link.(map[string]any)["toNode"].(string); to >= "n6" && len(to) == 3 {
			t.Fatalf("co-many: an edge to %s, which the thumbnail does not draw", to)
		}
	}
	for _, id := range []string{"co-odd", "co-empty", "co-array"} {
		if nodes, links, count := outline(id); len(nodes) != 0 || len(links) != 0 || count != 0 {
			t.Fatalf("%s: %v %v count %v; want empty", id, nodes, links, count)
		}
	}

	// Pages: the same set in the same order, and a cursor serves either view (only the projection differs).
	first := h.request(t, owner, "GET", path+"?view=summary&limit=2", nil, 200)
	cursor := first["nextCursor"].(string)
	second := h.request(t, owner, "GET", path+"?view=summary&limit=2&cursor="+url.QueryEscape(cursor), nil, 200)
	paged := []string{}
	for _, page := range []map[string]any{first, second} {
		for _, value := range page["items"].([]any) {
			paged = append(paged, value.(map[string]any)["id"].(string))
		}
	}
	rest := h.request(t, owner, "GET", path+"?limit=2&cursor="+url.QueryEscape(cursor), nil, 200)
	if second["items"].([]any)[0].(map[string]any)["id"] != rest["items"].([]any)[0].(map[string]any)["id"] {
		t.Fatal("a cursor from the summary view does not continue the full view at the same place")
	}
	if !reflect.DeepEqual(paged, order[:4]) {
		t.Fatalf("paged summary %v, want %v", paged, order[:4])
	}

	for _, query := range []string{"?view=", "?view=full", "?view=Summary", "?view=summary&view=summary"} {
		requireCode(t, h.request(t, owner, "GET", path+query, nil, 400), "invalid_pagination")
	}
	h.request(t, outsider, "GET", path+"?view=summary", nil, 404)
	// Other lists ignore the parameter, as they ignore any other.
	h.request(t, owner, "GET", "/tenants/"+tid+"/agents?view=summary", nil, 200)
}
