package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const plannerInstructions = `You are the Awwo canvas planner. Return one JSON object only: {"version":1,"summary":"...","operations":[...]}. Follow the structural protocol supplied in the user context. Only propose add_node, update_node, set_input, add_field, update_field, remove_field, remove_node, connect, set_edge_kind, set_execution, disconnect operations. Never change execution bindings, runtime settings, credentials, model configuration or outputs. Node personas define identity, responsibilities and field content, while declared output contracts define serialization. Do not instruct a persona to bypass its template's output contract: a one-sentence or plain-text requirement describes content inside the output fields, not the outer response format. If exactly one raw text output is required, explicitly propose the supported field operations to make the output contract one text/markdown field instead of relying on a persona override. Preserve user quantities, budgets, durations and prohibitions in every relevant author and reviewer instruction. Distinguish exactly, at least and at most; never relax a specified count into a minimum. Never execute tools or claim work was executed. If context is insufficient return an empty operations array and ask in summary. Maximum 100 operations. The caller will validate and explicitly apply the proposal.`

func (a *App) planCanvas(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Prompt               string   `json:"prompt"`
		Context              string   `json:"context"`
		OperationID          string   `json:"operationId"`
		KnowledgeRevisionIDs []string `json:"knowledgeRevisionIds,omitempty"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	prompt := b.Context + "\n\nUser request:\n" + b.Prompt
	if strings.TrimSpace(b.Prompt) == "" || len(b.Prompt) > 8000 || len(b.Context) > 120000 || len(prompt) > 128000 || len(b.OperationID) < 8 || len(b.OperationID) > 200 {
		fail(w, 400, "invalid_input", "Planner requires bounded prompt, context and operationId")
		return
	}
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var canvas string
	e = tx.QueryRow(r.Context(), "SELECT id FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, cid).Scan(&canvas)
	if noRows(e) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	var sid string
	e = tx.QueryRow(r.Context(), "SELECT id FROM node_sessions WHERE tenant_id=$1 AND canvas_id=$2 AND kind='planner'", tid, cid).Scan(&sid)
	if noRows(e) {
		sid = randomID()
		aid := randomID()
		if _, e = tx.Exec(r.Context(), "INSERT INTO agents(id,tenant_id,name,role,instructions,internal) VALUES($1,$2,'Canvas planner','planner',$3,true)", aid, tid, plannerInstructions); e != nil {
			a.dbError(w, e)
			return
		}
		if _, e = tx.Exec(r.Context(), "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title,kind) VALUES($1,$2,$3,'$planner',$4,'Canvas planning','planner')", sid, tid, cid, aid); e != nil {
			a.dbError(w, e)
			return
		}
		if e = audit(r.Context(), tx, currentUser(r).ID, tid, "planner.created", sid); e != nil {
			a.dbError(w, e)
			return
		}
	} else if e != nil {
		a.dbError(w, e)
		return
	}
	// Planner instructions are server-owned. Existing canvas sessions must use
	// the current protocol too; already accepted runs retain their snapshots.
	if _, e = tx.Exec(r.Context(), "UPDATE agents a SET instructions=$3 FROM node_sessions s WHERE s.tenant_id=$1 AND s.id=$2 AND s.kind='planner' AND a.tenant_id=s.tenant_id AND a.id=s.agent_id AND a.internal", tid, sid, plannerInstructions); e != nil {
		a.dbError(w, e)
		return
	}
	if !a.workerAvailable(w) {
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	data, _ := json.Marshal(runInput{SessionID: sid, Prompt: prompt, OperationID: b.OperationID, KnowledgeRevisionIDs: b.KnowledgeRevisionIDs})
	// Only this request may run on the operator's planner model (planner_model.go).
	next := withPlannerRequest(r)
	next.Body = io.NopCloser(bytes.NewReader(data))
	next.ContentLength = int64(len(data))
	next.Header.Set("Content-Type", "application/json")
	a.createRun(w, next)
}

// planFieldTypes are the field types a plan may add or change to: the canvas's own (FIELD_TYPES in
// apps/web/src/canvas/canvasPlan.ts, which the planner is told it may use), html included.
var planFieldTypes = []string{"text", "markdown", "html", "number", "boolean", "file"}

// This gate validates the transport schema. Frontend applyCanvasPlan separately
// validates references, field compatibility, cycles and the currently loaded graph.
func validatePlan(raw string) bool {
	raw = planJSONBody(raw)
	if utf8.RuneCountInString(raw) > 120000 {
		return false
	}
	var p map[string]any
	if json.Unmarshal([]byte(raw), &p) != nil || !planKeys(p, "version", "summary", "operations") || p["version"] != float64(1) || !planText(p["summary"], 1000, false) {
		return false
	}
	ops, ok := p["operations"].([]any)
	if !ok || len(ops) > 100 {
		return false
	}
	refs := map[string]bool{}
	for _, item := range ops {
		op, ok := item.(map[string]any)
		if !ok {
			return false
		}
		typ, _ := op["type"].(string)
		switch typ {
		case "add_node":
			if !planKeys(op, "type", "ref", "templateId", "title", "persona", "inputValues") || !planID(op["ref"]) || !oneOf(op["templateId"], planTemplateIDs...) {
				return false
			}
			ref := op["ref"].(string)
			if refs[ref] {
				return false
			}
			refs[ref] = true
			if !optionalPlanText(op, "title", 200, false) || !optionalPlanText(op, "persona", 8000, true) {
				return false
			}
			if v, ok := op["inputValues"]; ok {
				m, ok := v.(map[string]any)
				if !ok || len(m) > 64 {
					return false
				}
				for k, v := range m {
					if !planID(k) || !planText(v, 16000, true) {
						return false
					}
				}
			}
		case "update_node":
			if !planKeys(op, "type", "nodeId", "title", "persona") || !planID(op["nodeId"]) || !optionalPlanText(op, "title", 200, false) || !optionalPlanText(op, "persona", 8000, true) {
				return false
			}
			if _, a := op["title"]; !a {
				if _, b := op["persona"]; !b {
					return false
				}
			}
		case "set_input":
			if !planKeys(op, "type", "nodeId", "fieldId", "value") || !planID(op["nodeId"]) || !planID(op["fieldId"]) || !planText(op["value"], 16000, true) {
				return false
			}
		case "add_field":
			if !planKeys(op, "type", "nodeId", "side", "field") || !planID(op["nodeId"]) || !oneOf(op["side"], "input", "output") {
				return false
			}
			f, ok := op["field"].(map[string]any)
			if !ok || !planKeys(f, "id", "label", "type", "required", "value", "help", "placeholder") || !planID(f["id"]) || f["value"] != "" || !planText(f["label"], 200, false) || !oneOf(f["type"], planFieldTypes...) {
				return false
			}
			if _, ok = f["required"].(bool); !ok {
				return false
			}
			if !optionalPlanText(f, "help", 2000, true) || !optionalPlanText(f, "placeholder", 2000, true) {
				return false
			}
		case "update_field":
			if !planKeys(op, "type", "nodeId", "side", "fieldId", "changes") || !planID(op["nodeId"]) || !planID(op["fieldId"]) || !oneOf(op["side"], "input", "output") {
				return false
			}
			f, ok := op["changes"].(map[string]any)
			if !ok || len(f) == 0 || !planKeys(f, "label", "type", "required", "help", "placeholder") || !optionalPlanText(f, "label", 200, false) || !optionalPlanText(f, "help", 2000, true) || !optionalPlanText(f, "placeholder", 2000, true) {
				return false
			}
			if v, ok := f["type"]; ok && !oneOf(v, planFieldTypes...) {
				return false
			}
			if v, ok := f["required"]; ok {
				if _, valid := v.(bool); !valid {
					return false
				}
			}
		case "remove_field":
			if !planKeys(op, "type", "nodeId", "side", "fieldId") || !planID(op["nodeId"]) || !planID(op["fieldId"]) || !oneOf(op["side"], "input", "output") {
				return false
			}
		case "remove_node":
			if !planKeys(op, "type", "nodeId") || !planID(op["nodeId"]) {
				return false
			}
		case "connect":
			if !planKeys(op, "type", "fromNode", "fromField", "toNode", "toField", "kind") || !planID(op["fromNode"]) || !planID(op["fromField"]) || !planID(op["toNode"]) || !planID(op["toField"]) {
				return false
			}
			if v, ok := op["kind"]; ok && !oneOf(v, "data", "feedback") {
				return false
			}
		case "set_edge_kind":
			if !planKeys(op, "type", "edgeId", "kind") || !planText(op["edgeId"], 600, false) || !oneOf(op["kind"], "data", "feedback") {
				return false
			}
		case "set_execution":
			switch op["mode"] {
			case "workflow":
				if !planKeys(op, "type", "mode") {
					return false
				}
			case "review":
				rounds, ok := op["maxRounds"].(float64)
				if !planKeys(op, "type", "mode", "maxRounds", "reviewerNodeId", "verdictFieldId") || !ok || rounds != float64(int(rounds)) || rounds < 1 || rounds > 5 || !planID(op["reviewerNodeId"]) || !planID(op["verdictFieldId"]) {
					return false
				}
			default:
				return false
			}
		case "disconnect":
			if !planKeys(op, "type", "edgeId") || !planText(op["edgeId"], 600, false) {
				return false
			}
		default:
			return false
		}
	}
	return true
}
func planKeys(m map[string]any, allowed ...string) bool {
	if m == nil {
		return false
	}
	for k := range m {
		if k == "__proto__" || k == "prototype" || k == "constructor" {
			return false
		}
		found := false
		for _, a := range allowed {
			if k == a {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func planText(v any, max int, empty bool) bool {
	s, ok := v.(string)
	return ok && utf8.RuneCountInString(s) <= max && (empty || strings.TrimSpace(s) != "")
}
func optionalPlanText(m map[string]any, k string, max int, empty bool) bool {
	v, ok := m[k]
	return !ok || planText(v, max, empty)
}
func planID(v any) bool {
	if !planText(v, 128, false) {
		return false
	}
	s := v.(string)
	if s == "__proto__" || s == "prototype" || s == "constructor" {
		return false
	}
	for _, r := range s {
		if unicode.IsSpace(r) || r < 32 {
			return false
		}
	}
	return true
}
func oneOf(v any, values ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, a := range values {
		if a == s {
			return true
		}
	}
	return false
}

// planJSONBody is the plan's JSON text inside the planner's answer: the whole answer, or the body of a ```json (or
// bare ```) block. Some models (Claude Haiku 4.5 on 2026-10-08) close the block and then add a note after it. The
// note is not part of the plan, so the block ends at its closing fence, found after the first JSON value so a fence
// inside a string cannot end it early. Only whitespace may separate that value from the closing fence, and an
// answer without a fence is returned whole, so anything else after the plan still fails the schema gate.
func planJSONBody(raw string) string {
	body := planJSONText(raw)
	if json.Valid([]byte(body)) {
		return body
	}
	// Models writing Chinese use ASCII double quotes as quotation marks inside a string (点击"新建") without escaping
	// them, which ended 6 of the 8 failed plans of 2026-10-09/10 as invalid_canvas_plan. Such quotes are escaped
	// (repairPlanQuotes) and the answer is read again; a repair that still is not one JSON value changes nothing.
	trimmed := strings.TrimSpace(raw)
	if repaired := repairPlanQuotes(trimmed); repaired != trimmed {
		if fixed := planJSONText(repaired); json.Valid([]byte(fixed)) {
			return fixed
		}
	}
	return body
}

// planJSONText is planJSONBody without the quote repair.
func planJSONText(raw string) string {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, "```") {
		return raw
	}
	body := strings.TrimPrefix(strings.TrimPrefix(raw, "```"), "json")
	d := json.NewDecoder(strings.NewReader(body))
	var value json.RawMessage
	if d.Decode(&value) != nil {
		return body
	}
	end := int(d.InputOffset())
	if rest := strings.TrimSpace(body[end:]); rest == "" || strings.HasPrefix(rest, "```") {
		return body[:end]
	}
	return body
}

// repairPlanQuotes escapes, inside the first JSON object of an answer, the double quotes that cannot end the string
// they are in, and the raw line breaks and tabs inside strings. A quote ends its string only when what follows it
// continues the JSON: optional white space and then ':' (it closed a key), '}' or ']', the end of the text, or ','
// followed by the start of a next key or value. Text before the object and after its closing brace is kept as it is,
// so a fence and a note after it still read the way planJSONText expects.
func repairPlanQuotes(s string) string {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 16)
	b.WriteString(s[:start])
	depth, inString := 0, false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inString {
			switch c {
			case '\\':
				b.WriteByte(c)
				if i+1 < len(s) {
					i++
					b.WriteByte(s[i])
				}
			case '"':
				if planQuoteCloses(s[i+1:]) {
					inString = false
					b.WriteByte(c)
				} else {
					b.WriteString(`\"`)
				}
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				b.WriteByte(c)
			}
			continue
		}
		b.WriteByte(c)
		switch c {
		case '"':
			inString = true
		case '{', '[':
			depth++
		case '}', ']':
			depth--
			if depth == 0 {
				b.WriteString(s[i+1:])
				return b.String()
			}
		}
	}
	return b.String()
}

// planQuoteCloses reports whether a double quote followed by rest can end the JSON string it is in.
func planQuoteCloses(rest string) bool {
	rest = strings.TrimLeft(rest, " \t\r\n")
	if rest == "" {
		return true
	}
	switch rest[0] {
	case ':', '}', ']':
		return true
	case ',':
		next := strings.TrimLeft(rest[1:], " \t\r\n")
		return next == "" || strings.IndexByte(`"{[]}-0123456789tfn`, next[0]) >= 0
	}
	return false
}

// acceptPlan is the planner's answer as the canvas receives it: its JSON (planJSONBody) with the slips a model makes
// that have one safe reading normalized (normalizePlanOperations), when that passes the schema gate. Anything else
// fails as before.
func acceptPlan(raw string) (string, bool) {
	body := planJSONBody(raw)
	var compact bytes.Buffer
	if json.Compact(&compact, []byte(body)) == nil && validatePlan(compact.String()) {
		return compact.String(), true
	}
	var p map[string]any
	if json.Unmarshal([]byte(body), &p) != nil {
		return "", false
	}
	if ops, ok := p["operations"].([]any); ok {
		p["operations"] = normalizePlanOperations(ops)
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(p) != nil {
		return "", false
	}
	plan := strings.TrimSpace(buffer.String())
	if !validatePlan(plan) {
		return "", false
	}
	return plan, true
}

// planReservedIDs are the names the canvas refuses as ids (canvasPlan.ts RESERVED: they are JavaScript object keys).
var planReservedIDs = map[string]bool{"__proto__": true, "prototype": true, "constructor": true}

// normalizePlanOperations fixes, in place, the slips that turned whole plans into invalid_canvas_plan:
//   - a new field's value left out, or filled: the protocol has new fields start empty, so value is "", and a filled
//     input becomes the set_input that fills it right after the field is added (an output is never filled);
//   - a new node ref or new field id the canvas refuses (prototype, constructor, __proto__): renamed, with every
//     reference in the plan, to <name>_node or <name>_field. A canvas never holds such an id, so only names this
//     plan introduces are renamed.
func normalizePlanOperations(ops []any) []any {
	nodes, fields := map[string]string{}, map[string]string{}
	taken := map[string]bool{}
	for _, item := range ops {
		if op, ok := item.(map[string]any); ok {
			if ref, ok := op["ref"].(string); ok {
				taken[ref] = true
			}
			if f, ok := op["field"].(map[string]any); ok {
				if id, ok := f["id"].(string); ok {
					taken[id] = true
				}
			}
		}
	}
	fresh := func(base string) string {
		name := base
		for n := 2; taken[name]; n++ {
			name = base + "_" + strconv.Itoa(n)
		}
		taken[name] = true
		return name
	}
	for _, item := range ops {
		op, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if ref, ok := op["ref"].(string); ok && op["type"] == "add_node" && planReservedIDs[ref] {
			if _, done := nodes[ref]; !done {
				nodes[ref] = fresh(ref + "_node")
			}
		}
		if f, ok := op["field"].(map[string]any); ok && op["type"] == "add_field" {
			if id, ok := f["id"].(string); ok && planReservedIDs[id] {
				if _, done := fields[id]; !done {
					fields[id] = fresh(id + "_field")
				}
			}
		}
	}
	rename := func(op map[string]any, names map[string]string, keys ...string) {
		for _, key := range keys {
			if v, ok := op[key].(string); ok {
				if to, ok := names[v]; ok {
					op[key] = to
				}
			}
		}
	}
	out := make([]any, 0, len(ops))
	for _, item := range ops {
		op, ok := item.(map[string]any)
		if !ok {
			out = append(out, item)
			continue
		}
		rename(op, nodes, "ref", "nodeId", "fromNode", "toNode", "reviewerNodeId")
		rename(op, fields, "fieldId", "fromField", "toField", "verdictFieldId")
		out = append(out, op)
		f, ok := op["field"].(map[string]any)
		if !ok || op["type"] != "add_field" {
			continue
		}
		rename(f, fields, "id")
		value, isText := f["value"].(string)
		f["value"] = ""
		if isText && value != "" && op["side"] == "input" {
			out = append(out, map[string]any{"type": "set_input", "nodeId": op["nodeId"], "fieldId": f["id"], "value": value})
		}
	}
	return out
}

func normalizePlanJSON(raw string) string {
	raw = planJSONBody(raw)
	var buffer bytes.Buffer
	if json.Compact(&buffer, []byte(raw)) == nil {
		return buffer.String()
	}
	return raw
}
