package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const plannerInstructions = `You are the Awwo canvas planner. Return one JSON object only: {"version":1,"summary":"...","operations":[...]}. Follow the structural protocol supplied in the user context. Only propose add_node, update_node, set_task, set_model, set_input, add_field, update_field, remove_field, remove_node, connect, set_edge_kind, set_execution, disconnect operations. Never change execution bindings, runtime settings, credentials or output values. Change a node's model only with set_model, only to a model the context lists, and only when the user asks for it or the node failed because of its model; the runtime is chosen by Awwo. Name a model as the context's model list names it (Claude Opus 5.5, for example), never by a name you remember: every model in that list exists and can run a node, even one released after your training data. Set a node's constraints and acceptance criteria with set_task (or acceptanceCriteria in add_node), keeping the user's requirements: acceptance criteria are checks a reviewer can make against that node's own delivery. Node personas define identity, responsibilities and field content, while declared output contracts define serialization. Do not instruct a persona to bypass its template's output contract: a one-sentence or plain-text requirement describes content inside the output fields, not the outer response format. If exactly one raw text output is required, explicitly propose the supported field operations to make the output contract one text/markdown field instead of relying on a persona override. Preserve user quantities, budgets, durations and prohibitions in every relevant author and reviewer instruction. Distinguish exactly, at least and at most; never relax a specified count into a minimum. Never execute tools or claim work was executed. If context is insufficient return an empty operations array and ask in summary. Add a media node (templateId image, video or model3d, when the protocol offers it) only where the request needs a generated picture, video clip or 3D model as an asset, one node per distinct asset, and write that asset's complete generation prompt in inputValues.prompt; a media node takes no persona and no other inputs. A canvas run generates a media node before the nodes it feeds: when a page, game or document should show the asset, connect the media node's result to that node's context input (or one of its text fields), and that node receives the stored files as <node id>/<file name> paths it must use exactly as given. When the user message carries a quoted block of uploaded files, use their text as part of the request, and hand a file to the node that needs it by writing that file's exact attachment line (as it appears in the request, "[附件] name · awwo-file:id" or "[Attachment] name · awwo-file:id") into one of the node's inputs, a file input where the node has one; never invent, alter or guess an awwo-file reference. Write each persona you add or rewrite as a self-contained brief: what the node receives, exactly what it delivers (format, scope and size) and what it must not do. Give every Agent node you add one to three acceptanceCriteria in add_node, each checkable against that node's own delivery, and change criteria or constraints with set_task when the user asks for other rules or checks; an @R reference keeps a shared requirement's text. Each Agent node is one model call and its thinking counts against the output limit, so give every node a task one answer can finish. Deliver a page, game or tool with one frontend node: its one output is that page as html (the component templates show it), so add no fields to it. The nodes feeding it deliver compact code-ready parts (data as constants, behaviour as functions), not prose, and it pastes them unchanged. Past about 16,000 characters of its own code, split it into code-module nodes and one assembly node that only pastes them in. A node's run in the context says how its last run ended: to fix a failed node, split its work or narrow its delivery when its answer was too long or ran out of time, switch it to the default model when a premium model was refused, and otherwise improve its brief; say in summary what you changed and why. Maximum 100 operations. The caller will validate and explicitly apply the proposal.`

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
	if strings.TrimSpace(b.Prompt) == "" || len(b.Prompt) > 8000 || len(b.OperationID) < 8 || len(b.OperationID) > 200 {
		fail(w, 400, "invalid_input", "Planner requires bounded prompt, context and operationId")
		return
	}
	// The asker's own standing preferences (设置 → 个性化) go before the request, added by createRun after it hashes
	// the request, so a retry still matches its first attempt when the settings changed between them. A request already
	// near the run's size limit is planned without them rather than refused; the room a refusal gives leaves space for
	// them, as a request that shorter carries them again.
	personal := a.plannerPersonalization(r.Context(), currentUser(r).ID)
	if max(len(b.Context)-maxPlanContextBytes, len(prompt)-maxRunPromptBytes) > 0 {
		failPlanContext(w, planContextRoom(len(b.Context), max(len(b.Context)-maxPlanContextBytes, len(prompt)+len(personal)-maxRunPromptBytes)))
		return
	}
	dropped := 0
	if len(prompt)+len(personal) > maxRunPromptBytes {
		personal, dropped = "", len(personal)
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
	data, _ := json.Marshal(runInput{SessionID: sid, Prompt: prompt, OperationID: b.OperationID, KnowledgeRevisionIDs: b.KnowledgeRevisionIDs, AttachmentText: b.Prompt})
	// Only this request may run on the operator's planner model (planner_model.go).
	next := withPlannerContext(withPlannerPersonalization(withPlannerRequest(r), personal, len(b.Context)), plannerContext{len(b.Context), dropped})
	next.Body = io.NopCloser(bytes.NewReader(data))
	next.ContentLength = int64(len(data))
	next.Header.Set("Content-Type", "application/json")
	a.createRun(w, next)
}

// A plan's context is the page's own view of the canvas (canvasPlanning.ts buildPlanningContext). A plan too large for
// these bounds or for its model's budget (createRun) is refused with how many bytes that context may take for the
// same request to fit (details.contextRoom), so the page sends a shorter view of the same canvas instead of failing:
// 0 when no shorter context fits, the request, the files it names or the selected knowledge taking the room themselves.
const (
	maxPlanContextBytes   = 120000
	maxRunPromptBytes     = 128000
	planContextRoomMargin = 256
)

type plannerContextKey struct{}

// plannerContext is what createRun needs of a plan's context for a refusal's room: its size in the prompt planCanvas
// hands it, and the personal settings left out of that prompt for its size, which a shorter request carries again.
type plannerContext struct{ bytes, droppedPersonal int }

func withPlannerContext(r *http.Request, c plannerContext) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), plannerContextKey{}, c))
}

func plannerContextOf(r *http.Request) plannerContext {
	c, _ := r.Context().Value(plannerContextKey{}).(plannerContext)
	return c
}

// planContextRoom is how many bytes a context of contextBytes may keep once excess bytes too many come out of it.
func planContextRoom(contextBytes, excess int) int {
	return max(0, contextBytes-excess-planContextRoomMargin)
}

// plannerModelRoom is the room of a plan the operator's planner model was refused for its size alone (planner_model.go):
// a context short enough for its input bound runs on it, whose budget may take what the default model cannot. promptBytes
// and instructionBytes are the refused request's, with its personal settings.
func (a *App) plannerModelRoom(c plannerContext, promptBytes, instructionBytes int) int {
	return planContextRoom(c.bytes, promptBytes+c.droppedPersonal+instructionBytes-a.cfg.PlannerMaxInputBytes)
}

func failPlanContext(w http.ResponseWriter, room int) {
	failDetails(w, 413, "context_limit", "The canvas context is too large for this plan", map[string]any{"contextRoom": room})
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
			if !planKeys(op, "type", "ref", "templateId", "title", "persona", "inputValues", "acceptanceCriteria") || !planID(op["ref"]) || !oneOf(op["templateId"], planTemplateIDs...) {
				return false
			}
			if v, ok := op["acceptanceCriteria"]; ok {
				if _, ok := planTaskList(v); !ok {
					return false
				}
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
		case "set_task":
			// A node's task requirements, within the task frame's entry limits (task_frame.go): each list given replaces
			// that list, so at least one is given. Their total is the canvas's to judge (applyCanvasPlan): it depends on
			// the list the step leaves in place and on the shared requirements an @R name expands to, and a step over it
			// is left out there with a note, where refusing it here would lose the whole plan.
			if !planKeys(op, "type", "nodeId", "constraints", "acceptanceCriteria") || !planID(op["nodeId"]) {
				return false
			}
			given := 0
			for _, key := range []string{"constraints", "acceptanceCriteria"} {
				if v, ok := op[key]; ok {
					if _, valid := planTaskList(v); !valid {
						return false
					}
					given++
				}
			}
			if given == 0 {
				return false
			}
		case "set_model":
			// The model a node runs, named as the context lists it; the canvas checks it against the workspace's catalogue
			// and picks the runtime itself.
			if !planKeys(op, "type", "nodeId", "model", "effort") || !planID(op["nodeId"]) || !planText(op["model"], 200, false) {
				return false
			}
			if v, ok := op["effort"]; ok {
				effort, isText := v.(string)
				if !isText || (effort != "" && !validEffortLevel(effort)) {
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

// The task frame's limits (task_frame.go, taskFrame.ts): a plan that sets requirements is held to them here too.
const (
	taskFrameMaxEntries    = 20
	taskFrameMaxEntryRunes = 2000
)

// planTaskList checks one task-requirement list of a plan: at most taskFrameMaxEntries strings of at most
// taskFrameMaxEntryRunes each. It returns the list's length in runes.
func planTaskList(v any) (int, bool) {
	items, ok := v.([]any)
	if !ok || len(items) > taskFrameMaxEntries {
		return 0, false
	}
	total := 0
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return 0, false
		}
		size := utf8.RuneCountInString(text)
		if size > taskFrameMaxEntryRunes {
			return 0, false
		}
		total += size
	}
	return total, true
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
