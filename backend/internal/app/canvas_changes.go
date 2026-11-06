package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
)

// The canvas change engine (docs/awwo-canvas-live-collaboration.md): a canvas document is changed by ops on paths,
// applied in the server's order. The web app applies the same ops the same way (apps/web/src/canvas/multiplayer/changes.ts);
// apps/canvas-change-vectors.json holds cases both run.

// canvasOp is one edit of a canvas document.
type canvasOp struct {
	Op    string          `json:"op"`
	Path  []string        `json:"path"`
	Value json.RawMessage `json:"value,omitempty"`
	IDs   []string        `json:"ids,omitempty"`
}

const (
	canvasOpSet   = "set"
	canvasOpDel   = "del"
	canvasOpOrder = "order"
)

// The places of a document: its collections of records, which records hold collections of their own, and the keys
// no change carries (each page's own version tag, clock and camera).
var (
	canvasCollectionKey = map[string]string{"nodes": "id", "edges": "id", "displays": "id", "waypoints": "slot"}
	// Records compared and replaced whole: a wire and a saved view are small and have no field of their own to merge.
	canvasWholeRecords = map[string]bool{"edges": true, "waypoints": true}
	// A node's own collections, by id.
	canvasNodeCollections = map[string]bool{"threads": true, "fields": true}
	canvasUnchangedKeys   = map[string]bool{"version": true, "updatedAt": true, "view": true}
)

// canvasPlace is a parsed path.
type canvasPlace struct {
	collection string // "nodes", "edges", "displays", "waypoints"; "" for a document key
	record     string
	sub        string // "threads" or "fields" inside a node
	subRecord  string
	key        string // a field of the record (or sub-record), or the document key
}

// parseCanvasPath reads a path; the op decides which forms it takes.
func parseCanvasPath(path []string) (canvasPlace, error) {
	for _, part := range path {
		if part == "" || len(part) > 200 {
			return canvasPlace{}, errors.New("a path part is empty or longer than 200 characters")
		}
	}
	if len(path) == 0 {
		return canvasPlace{}, errors.New("empty path")
	}
	if path[0] == "doc" {
		if len(path) != 2 || canvasUnchangedKeys[path[1]] || canvasCollectionKey[path[1]] != "" {
			return canvasPlace{}, errors.New("a document path names one key other than a collection, version, updatedAt or view")
		}
		return canvasPlace{key: path[1]}, nil
	}
	if canvasCollectionKey[path[0]] == "" {
		return canvasPlace{}, fmt.Errorf("unknown collection %q", path[0])
	}
	place := canvasPlace{collection: path[0]}
	if len(path) == 1 {
		return place, nil // the collection itself: only an order op
	}
	place.record = path[1]
	if path[0] == "waypoints" {
		if _, err := strconv.Atoi(path[1]); err != nil {
			return canvasPlace{}, errors.New("a waypoint is named by its slot number")
		}
	}
	switch len(path) {
	case 2:
		return place, nil
	case 3:
		if canvasWholeRecords[path[0]] {
			return canvasPlace{}, fmt.Errorf("%s are changed whole", path[0])
		}
		if path[2] == canvasCollectionKey[path[0]] {
			return canvasPlace{}, errors.New("a record's id is not a field")
		}
		if path[0] == "nodes" && canvasNodeCollections[path[2]] {
			place.sub = path[2] // the collection itself: only an order op, or a whole-field set/del
		}
		place.key = path[2]
		return place, nil
	case 4, 5:
		if path[0] != "nodes" || !canvasNodeCollections[path[2]] {
			return canvasPlace{}, errors.New("only a node's threads and fields hold records")
		}
		place.sub, place.subRecord = path[2], path[3]
		if len(path) == 5 {
			if path[4] == "id" {
				return canvasPlace{}, errors.New("a record's id is not a field")
			}
			place.key = path[4]
		}
		return place, nil
	}
	return canvasPlace{}, errors.New("path too long")
}

// decodeCanvasDocument reads a document into maps and slices, keeping numbers as written.
func decodeCanvasDocument(raw []byte) (map[string]any, error) {
	var doc map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, errors.New("a canvas document is a JSON object")
	}
	return doc, nil
}

func decodeCanvasValue(raw json.RawMessage) (any, error) {
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, errors.New("one JSON value expected")
	}
	return v, nil
}

// recordKey is a record's key as a path names it: a string id, or a waypoint's slot as a decimal integer.
func recordKey(record any, keyName string) (string, bool) {
	object, ok := record.(map[string]any)
	if !ok {
		return "", false
	}
	switch value := object[keyName].(type) {
	case string:
		return value, value != ""
	case json.Number:
		if keyName != "slot" {
			return "", false
		}
		if n, err := value.Int64(); err == nil {
			return strconv.FormatInt(n, 10), true
		}
		if f, err := value.Float64(); err == nil && f == float64(int64(f)) {
			return strconv.FormatInt(int64(f), 10), true
		}
	}
	return "", false
}

// findRecord gives the index of the first record with that key, or -1. Later records with the same key are inert:
// every op reaches the first, in the server and in every page alike.
func findRecord(list []any, keyName, key string) int {
	for i, item := range list {
		if k, ok := recordKey(item, keyName); ok && k == key {
			return i
		}
	}
	return -1
}

func collectionOf(holder map[string]any, name string) []any {
	list, _ := holder[name].([]any)
	return list
}

// applyCanvasOp applies one op to the document in place. It reports false when the op had nothing to act on (a field of
// a record that is not there), which is no error: the record went in a change applied before it.
func applyCanvasOp(doc map[string]any, op canvasOp) (bool, error) {
	place, err := parseCanvasPath(op.Path)
	if err != nil {
		return false, err
	}
	var value any
	switch op.Op {
	case canvasOpSet:
		if len(op.Value) == 0 {
			return false, errors.New("set needs a value")
		}
		if value, err = decodeCanvasValue(op.Value); err != nil {
			return false, fmt.Errorf("invalid value: %w", err)
		}
	case canvasOpDel:
	case canvasOpOrder:
		if place.collection == "" || place.record != "" && place.sub == "" || place.subRecord != "" || place.collection == "waypoints" {
			return false, errors.New("order names a collection: nodes, edges, displays, or a node's threads or fields")
		}
		if len(op.IDs) > 4096 {
			return false, errors.New("too many ids to order")
		}
	default:
		return false, fmt.Errorf("unknown op %q", op.Op)
	}
	if place.collection == "" { // a document key
		if op.Op == canvasOpSet {
			doc[place.key] = value
		} else if op.Op == canvasOpDel {
			delete(doc, place.key)
		} else {
			return false, errors.New("order names a collection")
		}
		return true, nil
	}
	keyName := canvasCollectionKey[place.collection]
	list := collectionOf(doc, place.collection)
	if place.record == "" {
		if op.Op != canvasOpOrder {
			return false, errors.New("a collection is changed by its records")
		}
		doc[place.collection] = orderedRecords(list, keyName, op.IDs)
		return true, nil
	}
	index := findRecord(list, keyName, place.record)
	if place.key == "" && place.sub == "" { // the record itself
		next, changed, err := applyToRecord(list, index, keyName, place.record, op.Op, value)
		if err != nil {
			return false, fmt.Errorf("%s/%s: %w", place.collection, place.record, err)
		}
		doc[place.collection] = next
		return changed, nil
	}
	if index < 0 {
		return false, nil // a field of a record that is not there
	}
	record, ok := list[index].(map[string]any)
	if !ok {
		return false, nil
	}
	record = cloneObject(record)
	changed := true
	switch {
	case place.subRecord == "" && op.Op == canvasOpOrder: // a node's threads or fields put in order
		record[place.key] = orderedRecords(collectionOf(record, place.key), "id", op.IDs)
	case place.subRecord == "" && op.Op == canvasOpSet: // a field of the record
		record[place.key] = value
	case place.subRecord == "": // del of a field of the record
		delete(record, place.key)
	default: // inside a node's threads or fields
		subList := collectionOf(record, place.sub)
		subIndex := findRecord(subList, "id", place.subRecord)
		if place.key == "" {
			next, subChanged, err := applyToRecord(subList, subIndex, "id", place.subRecord, op.Op, value)
			if err != nil {
				return false, fmt.Errorf("%s/%s: %w", place.sub, place.subRecord, err)
			}
			record[place.sub], changed = next, subChanged
			break
		}
		subRecord, isObject := any(nil), false
		if subIndex >= 0 {
			subRecord, isObject = subList[subIndex].(map[string]any)
		}
		if !isObject {
			return false, nil // a field of a conversation or form field that is not there
		}
		fields := cloneObject(subRecord.(map[string]any))
		if op.Op == canvasOpSet {
			fields[place.key] = value
		} else {
			delete(fields, place.key)
		}
		next := append([]any{}, subList...)
		next[subIndex] = fields
		record[place.sub] = next
	}
	next := append([]any{}, list...)
	next[index] = record
	doc[place.collection] = next
	return changed, nil
}

// applyToRecord sets or deletes one record of a collection, giving the collection after it.
func applyToRecord(list []any, index int, keyName, key, op string, value any) ([]any, bool, error) {
	if op == canvasOpDel {
		if index < 0 {
			return list, false, nil
		}
		return append(append([]any{}, list[:index]...), list[index+1:]...), true, nil
	}
	if op != canvasOpSet {
		return list, false, errors.New("a record is set or deleted")
	}
	if k, ok := recordKey(value, keyName); !ok || k != key {
		return list, false, fmt.Errorf("a record set here must carry %s %q", keyName, key)
	}
	if index >= 0 {
		next := append([]any{}, list...)
		next[index] = value
		return next, true, nil
	}
	return append(append([]any{}, list...), value), true, nil
}

func cloneObject(object map[string]any) map[string]any {
	out := make(map[string]any, len(object)+1)
	for k, v := range object {
		out[k] = v
	}
	return out
}

// orderedRecords puts the listed records that exist first, in the listed order, then every other record in its order.
func orderedRecords(list []any, keyName string, ids []string) []any {
	out := make([]any, 0, len(list))
	taken := make([]bool, len(list))
	// Each key's first place, as findRecord finds it: one pass, not a search per id.
	index := make(map[string]int, len(list))
	for i, item := range list {
		if k, ok := recordKey(item, keyName); ok {
			if _, dup := index[k]; !dup {
				index[k] = i
			}
		}
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if i, ok := index[id]; ok && !taken[i] {
			out = append(out, list[i])
			taken[i] = true
		}
	}
	for i, item := range list {
		if !taken[i] {
			out = append(out, item)
		}
	}
	return out
}

// diffCanvas gives the ops that turn a into b (docs/awwo-canvas-live-collaboration.md, Diff).
func diffCanvas(a, b map[string]any) []canvasOp {
	ops := []canvasOp{}
	for _, name := range []string{"nodes", "edges", "displays", "waypoints"} {
		ops = append(ops, diffCollection([]string{name}, collectionOf(a, name), collectionOf(b, name), canvasCollectionKey[name], canvasWholeRecords[name], name == "nodes")...)
	}
	keys := map[string]bool{}
	for k := range a {
		keys[k] = true
	}
	for k := range b {
		keys[k] = true
	}
	for _, k := range sortedKeys(keys) {
		if canvasUnchangedKeys[k] || canvasCollectionKey[k] != "" {
			continue
		}
		ops = append(ops, diffValue([]string{"doc", k}, a, b, k)...)
	}
	return ops
}

func diffValue(path []string, a, b map[string]any, key string) []canvasOp {
	av, inA := a[key]
	bv, inB := b[key]
	switch {
	case inA && !inB:
		return []canvasOp{{Op: canvasOpDel, Path: path}}
	case inB && (!inA || !sameCanvasValue(av, bv)):
		return []canvasOp{{Op: canvasOpSet, Path: path, Value: mustCanvasJSON(bv)}}
	}
	return nil
}

// keyedRecords reads a collection as records with distinct keys, in order; ok is false when it is not one (then it is
// compared whole). A record listed twice keeps its first place, as findRecord does.
func keyedRecords(list []any, keyName string) ([]string, map[string]any, bool) {
	keys := make([]string, 0, len(list))
	byKey := make(map[string]any, len(list))
	for _, item := range list {
		k, ok := recordKey(item, keyName)
		if !ok {
			return nil, nil, false
		}
		if _, dup := byKey[k]; dup {
			continue
		}
		keys = append(keys, k)
		byKey[k] = item
	}
	return keys, byKey, true
}

func diffCollection(path []string, a, b []any, keyName string, whole, nodes bool) []canvasOp {
	aKeys, aBy, aOK := keyedRecords(a, keyName)
	bKeys, bBy, bOK := keyedRecords(b, keyName)
	if !aOK || !bOK {
		// Not a collection of records on one side: it is rebuilt record by record from b's readable records.
		aKeys, aBy, bKeys, bBy = nil, map[string]any{}, nil, map[string]any{}
		for _, item := range b {
			if k, ok := recordKey(item, keyName); ok {
				if _, dup := bBy[k]; !dup {
					bKeys = append(bKeys, k)
					bBy[k] = item
				}
			}
		}
		ops := []canvasOp{}
		for _, item := range a {
			if k, ok := recordKey(item, keyName); ok {
				if _, kept := bBy[k]; !kept {
					ops = append(ops, canvasOp{Op: canvasOpDel, Path: append(clonePath(path), k)})
				}
			}
		}
		for _, k := range bKeys {
			ops = append(ops, canvasOp{Op: canvasOpSet, Path: append(clonePath(path), k), Value: mustCanvasJSON(bBy[k])})
		}
		return ops
	}
	ops := []canvasOp{}
	for _, k := range aKeys {
		if _, kept := bBy[k]; !kept {
			ops = append(ops, canvasOp{Op: canvasOpDel, Path: append(clonePath(path), k)})
		}
	}
	for _, k := range bKeys {
		before, existed := aBy[k]
		after := bBy[k]
		recordPath := append(clonePath(path), k)
		if !existed {
			ops = append(ops, canvasOp{Op: canvasOpSet, Path: recordPath, Value: mustCanvasJSON(after)})
			continue
		}
		if sameCanvasValue(before, after) {
			continue
		}
		ao, aObj := before.(map[string]any)
		bo, bObj := after.(map[string]any)
		if whole || !aObj || !bObj {
			ops = append(ops, canvasOp{Op: canvasOpSet, Path: recordPath, Value: mustCanvasJSON(after)})
			continue
		}
		ops = append(ops, diffRecord(recordPath, ao, bo, keyName, nodes)...)
	}
	// The shared records' order, once every add and removal is in: the adds land at the end, as apply puts them. Saved
	// views have no order of their own (the canvas lists them by slot).
	if path[0] == "waypoints" {
		return ops
	}
	if order := changedOrder(aKeys, bKeys, bBy); order != nil {
		ops = append(ops, canvasOp{Op: canvasOpOrder, Path: clonePath(path), IDs: order})
	}
	return ops
}

// changedOrder gives b's keys when applying the adds and removals alone would not leave b's order, else nil.
func changedOrder(aKeys, bKeys []string, bBy map[string]any) []string {
	inB := make(map[string]bool, len(bKeys))
	for _, k := range bKeys {
		inB[k] = true
	}
	inA := make(map[string]bool, len(aKeys))
	expected := make([]string, 0, len(bKeys))
	for _, k := range aKeys {
		inA[k] = true
		if inB[k] {
			expected = append(expected, k)
		}
	}
	for _, k := range bKeys {
		if !inA[k] {
			expected = append(expected, k)
		}
	}
	for i := range expected {
		if expected[i] != bKeys[i] {
			return append([]string{}, bKeys...)
		}
	}
	return nil
}

func diffRecord(path []string, a, b map[string]any, keyName string, node bool) []canvasOp {
	keys := map[string]bool{}
	for k := range a {
		keys[k] = true
	}
	for k := range b {
		keys[k] = true
	}
	ops := []canvasOp{}
	for _, k := range sortedKeys(keys) {
		if k == keyName {
			continue
		}
		if node && canvasNodeCollections[k] {
			al, aList := a[k].([]any)
			bl, bList := b[k].([]any)
			_, _, aKeyed := keyedRecords(al, "id")
			_, _, bKeyed := keyedRecords(bl, "id")
			if aList && bList && aKeyed && bKeyed {
				ops = append(ops, diffCollection(append(clonePath(path), k), al, bl, "id", false, false)...)
				continue
			}
		}
		ops = append(ops, diffValue(append(clonePath(path), k), a, b, k)...)
	}
	return ops
}

func clonePath(path []string) []string { return append(make([]string, 0, len(path)+2), path...) }

func sortedKeys(keys map[string]bool) []string {
	out := make([]string, 0, len(keys))
	for k := range keys {
		out = append(out, k)
	}
	// Go orders strings by their bytes: UTF-8 code point order, as the web engine's compareKeys.
	sort.Strings(out)
	return out
}

// canvasChangeWorkMax bounds canvasChangeWork: a change of 500 ops over a canvas of 400 nodes and 2,000 wires is far
// below it, and a document grown past what the canvas draws (a collection of a hundred thousand records, possible within
// the 8 MiB bound) is refused before the engine spends seconds on it while a save slot waits.
const canvasChangeWorkMax = 4_000_000

// canvasChangeWork says how many records and keys the engine reads to apply ops to doc: each op searches and copies the
// list it names, and an op on a node's field copies that node (and the node's list it names). Worked out in one pass
// over the nodes at most, never a search per op.
func canvasChangeWork(doc map[string]any, ops []canvasOp) int {
	work := 0
	var nodes map[string]map[string]any
	for _, op := range ops {
		if len(op.Path) == 0 {
			continue
		}
		work += len(collectionOf(doc, op.Path[0])) + len(op.IDs)
		if op.Path[0] != "nodes" || len(op.Path) < 3 {
			continue
		}
		if nodes == nil {
			nodes = map[string]map[string]any{}
			for _, item := range collectionOf(doc, "nodes") {
				if node, ok := item.(map[string]any); ok {
					if id, ok := recordKey(node, "id"); ok {
						if _, dup := nodes[id]; !dup {
							nodes[id] = node
						}
					}
				}
			}
		}
		if node := nodes[op.Path[1]]; node != nil {
			work += len(node)
			if sub, ok := node[op.Path[2]].([]any); ok {
				work += len(sub)
			}
		}
	}
	return work
}

// sameCanvasValue compares two decoded values as JSON values: numbers by value, objects regardless of key order.
func sameCanvasValue(a, b any) bool {
	switch av := a.(type) {
	case json.Number:
		bv, ok := b.(json.Number)
		if !ok {
			return false
		}
		if av == bv {
			return true
		}
		af, aerr := av.Float64()
		bf, berr := bv.Float64()
		return aerr == nil && berr == nil && af == bf
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			w, present := bv[k]
			if !present || !sameCanvasValue(v, w) {
				return false
			}
		}
		return true
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !sameCanvasValue(av[i], bv[i]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}

func mustCanvasJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("canvas value cannot be encoded: %v", err))
	}
	return raw
}
