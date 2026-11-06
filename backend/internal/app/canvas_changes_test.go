package app

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// The cases both the API and the web app run (apps/canvas-change-vectors.json).
type canvasChangeVectors struct {
	Apply []struct {
		Name    string          `json:"name"`
		Before  json.RawMessage `json:"before"`
		Ops     []canvasOp      `json:"ops"`
		After   json.RawMessage `json:"after"`
		Applied []bool          `json:"applied"`
		Error   *int            `json:"error"`
	} `json:"apply"`
	Diff []struct {
		Name string          `json:"name"`
		A    json.RawMessage `json:"a"`
		B    json.RawMessage `json:"b"`
		Ops  []canvasOp      `json:"ops"`
	} `json:"diff"`
}

func readCanvasChangeVectors(t *testing.T) canvasChangeVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "canvas-change-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v canvasChangeVectors
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Apply) == 0 || len(v.Diff) == 0 {
		t.Fatal("no cases")
	}
	return v
}

func mustDecodeDocument(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	doc, err := decodeCanvasDocument(raw)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestCanvasChangeVectorsApply(t *testing.T) {
	for _, c := range readCanvasChangeVectors(t).Apply {
		t.Run(c.Name, func(t *testing.T) {
			doc := mustDecodeDocument(t, c.Before)
			applied := []bool{}
			for i, op := range c.Ops {
				ok, err := applyCanvasOp(doc, op)
				if err != nil {
					if c.Error == nil || *c.Error != i {
						t.Fatalf("op %d: unexpected error %v", i, err)
					}
					return
				}
				applied = append(applied, ok)
			}
			if c.Error != nil {
				t.Fatalf("op %d should have been refused", *c.Error)
			}
			if !sameCanvasValue(any(doc), any(mustDecodeDocument(t, c.After))) {
				t.Fatalf("after = %s", mustCanvasJSON(doc))
			}
			if fmt.Sprint(applied) != fmt.Sprint(c.Applied) {
				t.Fatalf("applied = %v, want %v", applied, c.Applied)
			}
		})
	}
}

func TestCanvasChangeVectorsDiff(t *testing.T) {
	for _, c := range readCanvasChangeVectors(t).Diff {
		t.Run(c.Name, func(t *testing.T) {
			a, b := mustDecodeDocument(t, c.A), mustDecodeDocument(t, c.B)
			got := diffCanvas(a, b)
			if !sameOps(got, c.Ops) {
				t.Fatalf("ops = %s\nwant %s", mustCanvasJSON(got), mustCanvasJSON(c.Ops))
			}
			// And the ops do turn a into b.
			for _, op := range got {
				if _, err := applyCanvasOp(a, op); err != nil {
					t.Fatal(err)
				}
			}
			if !sameDocuments(a, b) {
				t.Fatalf("applied diff = %s", mustCanvasJSON(a))
			}
		})
	}
}

func sameOps(a, b []canvasOp) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Op != b[i].Op || fmt.Sprint(a[i].Path) != fmt.Sprint(b[i].Path) || fmt.Sprint(a[i].IDs) != fmt.Sprint(b[i].IDs) {
			return false
		}
		if (len(a[i].Value) == 0) != (len(b[i].Value) == 0) {
			return false
		}
		if len(a[i].Value) > 0 {
			av, err1 := decodeCanvasValue(a[i].Value)
			bv, err2 := decodeCanvasValue(b[i].Value)
			if err1 != nil || err2 != nil || !sameCanvasValue(av, bv) {
				return false
			}
		}
	}
	return true
}

// sameDocuments compares two documents leaving out the keys no change carries; an empty collection is no collection
// (deleting a collection's last record leaves it empty, and the canvas reads both as none).
func sameDocuments(a, b map[string]any) bool {
	strip := func(doc map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range doc {
			if list, ok := v.([]any); ok && len(list) == 0 && canvasCollectionKey[k] != "" {
				continue
			}
			if k == "waypoints" { // listed by slot, so their order is no part of the canvas
				if list, ok := v.([]any); ok {
					sorted := append([]any{}, list...)
					key := func(i int) string { s, _ := recordKey(sorted[i], "slot"); return s }
					for i := 1; i < len(sorted); i++ {
						for j := i; j > 0 && key(j) < key(j-1); j-- {
							sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
						}
					}
					v = sorted
				}
			}
			if !canvasUnchangedKeys[k] {
				out[k] = v
			}
		}
		return out
	}
	return sameCanvasValue(any(strip(a)), any(strip(b)))
}

// randomCanvas makes a canvas-like document from a seeded source: nodes with conversations and form fields, wires,
// waypoints, displays and a document key, with ids drawn from a small pool so two documents share records.
func randomCanvas(r *rand.Rand) map[string]any {
	ids := func(prefix string, n int) []string {
		pool := []string{}
		for i := 0; i < n; i++ {
			if r.Intn(3) > 0 {
				pool = append(pool, prefix+strconv.Itoa(i))
			}
		}
		r.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
		return pool
	}
	value := func() any {
		switch r.Intn(6) {
		case 0:
			return json.Number(strconv.Itoa(r.Intn(5)))
		case 1:
			return "t" + strconv.Itoa(r.Intn(4))
		case 2:
			return nil
		case 3:
			return r.Intn(2) == 0
		case 4:
			return []any{json.Number("1"), "x"}
		default:
			return map[string]any{"k": json.Number(strconv.Itoa(r.Intn(3)))}
		}
	}
	record := func(id string, keys ...string) map[string]any {
		out := map[string]any{"id": id}
		for _, k := range keys {
			if r.Intn(3) > 0 {
				out[k] = value()
			}
		}
		return out
	}
	nodes := []any{}
	for _, id := range ids("n", 6) {
		node := record(id, "title", "x", "y", "persona", "lastOutput")
		switch r.Intn(4) {
		case 0:
			threads := []any{}
			for _, tid := range ids("t", 3) {
				threads = append(threads, record(tid, "draft", "preview"))
			}
			node["threads"] = threads
		case 1:
			fields := []any{}
			for _, fid := range ids("f", 3) {
				fields = append(fields, record(fid, "label", "value"))
			}
			node["fields"] = fields
		case 2:
			node["threads"] = "not a list"
		}
		nodes = append(nodes, node)
	}
	edges := []any{}
	for _, id := range ids("e", 4) {
		edges = append(edges, record(id, "fromNode", "toPort"))
	}
	waypoints := []any{}
	for i, slot := range r.Perm(4) {
		if i < r.Intn(4) {
			waypoints = append(waypoints, map[string]any{"slot": json.Number(strconv.Itoa(slot + 1)), "label": value()})
		}
	}
	doc := map[string]any{"version": json.Number("2"), "nodes": nodes, "edges": edges, "waypoints": waypoints,
		"updatedAt": json.Number(strconv.Itoa(r.Intn(100))), "view": value()}
	if r.Intn(2) == 0 {
		displays := []any{}
		for _, id := range ids("d", 3) {
			displays = append(displays, record(id, "x", "nodeId"))
		}
		doc["displays"] = displays
	}
	if r.Intn(2) == 0 {
		doc["execution"] = value()
	}
	return doc
}

func copyCanvas(t *testing.T, doc map[string]any) map[string]any {
	t.Helper()
	return mustDecodeDocument(t, mustCanvasJSON(doc))
}

func TestCanvasDiffAppliedGivesTheTarget(t *testing.T) {
	r := rand.New(rand.NewSource(20261106))
	for i := 0; i < 500; i++ {
		a, b := randomCanvas(r), randomCanvas(r)
		ops := diffCanvas(a, b)
		got := copyCanvas(t, a)
		for _, op := range ops {
			// Each op goes through JSON, as it does between the API and a page.
			var wire canvasOp
			if err := json.Unmarshal(mustCanvasJSON(op), &wire); err != nil {
				t.Fatal(err)
			}
			if _, err := applyCanvasOp(got, wire); err != nil {
				t.Fatalf("case %d: %v\nops %s", i, err, mustCanvasJSON(ops))
			}
		}
		if !sameDocuments(got, b) {
			t.Fatalf("case %d:\na %s\nb %s\nops %s\ngot %s", i, mustCanvasJSON(a), mustCanvasJSON(b), mustCanvasJSON(ops), mustCanvasJSON(got))
		}
		if again := diffCanvas(got, b); len(again) != 0 {
			t.Fatalf("case %d: a second diff is not empty: %s", i, mustCanvasJSON(again))
		}
	}
}

func TestCanvasApplyLeavesTheOtherRecordsAlone(t *testing.T) {
	doc := mustDecodeDocument(t, []byte(`{"version":2,"nodes":[{"id":"a","title":"A","x":1},{"id":"b","title":"B"}],"edges":[]}`))
	before := mustCanvasJSON(doc["nodes"].([]any)[1])
	if _, err := applyCanvasOp(doc, canvasOp{Op: canvasOpSet, Path: []string{"nodes", "a", "title"}, Value: json.RawMessage(`"A2"`)}); err != nil {
		t.Fatal(err)
	}
	if string(mustCanvasJSON(doc["nodes"].([]any)[1])) != string(before) {
		t.Fatal("another node changed")
	}
	if doc["nodes"].([]any)[0].(map[string]any)["x"] != json.Number("1") {
		t.Fatal("another field changed")
	}
}

func TestCanvasPathsAreChecked(t *testing.T) {
	for _, path := range [][]string{{}, {"nope"}, {"nodes", ""}, {"doc", "view"}, {"doc", "nodes"}, {"doc"}, {"waypoints", "x"},
		{"edges", "e", "toPort"}, {"nodes", "a", "id"}, {"nodes", "a", "title", "x"}, {"nodes", "a", "threads", "t", "id"},
		{"nodes", "a", "threads", "t", "draft", "more"}, {"displays", "d", "x", "y"}} {
		if _, err := parseCanvasPath(path); err == nil {
			t.Fatalf("%v should be refused", path)
		}
	}
	long := make([]byte, 201)
	for i := range long {
		long[i] = 'a'
	}
	if _, err := parseCanvasPath([]string{"nodes", string(long)}); err == nil {
		t.Fatal("a 201-character id should be refused")
	}
}

// A document grown far past what the canvas draws (possible within the 8 MiB bound) is diffed and ordered in about
// linear time, and a change over it is bounded before the engine works on it.
func TestCanvasEngineStaysFastOnLargeDocuments(t *testing.T) {
	a, b := map[string]any{}, map[string]any{}
	for i := 0; i < 200_000; i++ {
		key := "k" + strconv.Itoa(i)
		a[key] = json.Number("1")
		b[key] = json.Number("2")
	}
	began := time.Now()
	if ops := diffCanvas(a, b); len(ops) != 200_000 {
		t.Fatalf("ops: %d", len(ops))
	}
	if took := time.Since(began); took > 5*time.Second {
		t.Fatalf("diffing 200k keys took %v", took)
	}
	list := make([]any, 0, 50_000)
	for i := 0; i < 50_000; i++ {
		list = append(list, map[string]any{"id": "d" + strconv.Itoa(i)})
	}
	ids := make([]string, 0, 4096)
	for i := 0; i < 4096; i++ {
		ids = append(ids, "missing"+strconv.Itoa(i))
	}
	began = time.Now()
	if out := orderedRecords(list, "id", ids); len(out) != len(list) {
		t.Fatalf("ordered: %d", len(out))
	}
	if took := time.Since(began); took > 2*time.Second {
		t.Fatalf("ordering by 4096 ids over 50k records took %v", took)
	}
	doc := map[string]any{"displays": list, "nodes": []any{map[string]any{"id": "n1"}}}
	ops := make([]canvasOp, 0, 500)
	for i := 0; i < 500; i++ {
		ops = append(ops, canvasOp{Op: canvasOpDel, Path: []string{"displays", "gone" + strconv.Itoa(i)}})
	}
	if work := canvasChangeWork(doc, ops); work <= canvasChangeWorkMax {
		t.Fatalf("500 ops over 50k displays: work %d is under the bound", work)
	}
	if work := canvasChangeWork(doc, ops[:10]); work > canvasChangeWorkMax {
		t.Fatalf("10 ops: work %d", work)
	}
	one := map[string]any{"nodes": []any{map[string]any{"id": "n1", "title": "x"}}}
	if work := canvasChangeWork(one, []canvasOp{{Op: canvasOpSet, Path: []string{"nodes", "n1", "title"}, Value: json.RawMessage(`"y"`)}}); work != 3 {
		t.Fatalf("one op on one node: work %d", work)
	}
}
