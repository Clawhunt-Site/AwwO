package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

const plannerInstructions = `You are the Awwo canvas planner. Return one JSON object only: {"version":1,"summary":"...","operations":[...]}. Follow the structural protocol supplied in the user context. Only propose add_node, update_node, set_input, add_field, update_field, remove_field, remove_node, connect, disconnect operations. Never change execution bindings, runtime settings, credentials, model configuration or outputs. Never execute tools or claim work was executed. If context is insufficient return an empty operations array and ask in summary. Maximum 100 operations. The caller will validate and explicitly apply the proposal.`

func (a *App) planCanvas(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Prompt      string `json:"prompt"`
		Context     string `json:"context"`
		OperationID string `json:"operationId"`
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
	if !a.workerAvailable(w) {
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	data, _ := json.Marshal(runInput{SessionID: sid, Prompt: prompt, OperationID: b.OperationID})
	next := r.Clone(r.Context())
	next.Body = io.NopCloser(bytes.NewReader(data))
	next.ContentLength = int64(len(data))
	next.Header.Set("Content-Type", "application/json")
	a.createRun(w, next)
}

// This gate validates the transport schema. Frontend applyCanvasPlan separately
// validates references, field compatibility, cycles and the currently loaded graph.
func validatePlan(raw string) bool {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```json") {
		raw = strings.TrimPrefix(raw, "```json")
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
	} else if strings.HasPrefix(raw, "```") {
		raw = strings.TrimPrefix(raw, "```")
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
	}
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
			if !planKeys(op, "type", "ref", "templateId", "title", "persona", "inputValues") || !planID(op["ref"]) || !oneOf(op["templateId"], "general", "frontend", "backend", "data", "users", "materials", "review") {
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
			if !ok || !planKeys(f, "id", "label", "type", "required", "value", "help", "placeholder") || !planID(f["id"]) || f["value"] != "" || !planText(f["label"], 200, false) || !oneOf(f["type"], "text", "markdown", "number", "boolean", "file") {
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
			if v, ok := f["type"]; ok && !oneOf(v, "text", "markdown", "number", "boolean", "file") {
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
			if !planKeys(op, "type", "fromNode", "fromField", "toNode", "toField") || !planID(op["fromNode"]) || !planID(op["fromField"]) || !planID(op["toNode"]) || !planID(op["toField"]) {
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

func normalizePlanJSON(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```json") {
		raw = strings.TrimPrefix(raw, "```json")
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
	} else if strings.HasPrefix(raw, "```") {
		raw = strings.TrimPrefix(raw, "```")
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
	}
	var buffer bytes.Buffer
	if json.Compact(&buffer, []byte(raw)) == nil {
		return buffer.String()
	}
	return raw
}
