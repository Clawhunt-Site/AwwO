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

const plannerInstructions = `You are the Awwo canvas planner. Return one JSON object only: {"version":1,"summary":"...","operations":[...]}. Follow the structural protocol supplied in the user context. Only propose add_node, update_node, set_task, set_model, set_team, set_input, add_field, update_field, remove_field, remove_node, connect, set_edge_kind, set_execution, disconnect operations. Never change execution bindings, runtime settings, credentials or output values. Change a node's model only with set_model, only to a model the context lists, and only when the user asks for it or the node failed because of its model; the runtime is chosen by Awwo. Name a model as the context's model list names it (Claude Opus 5.5, for example), never by a name you remember: every model in that list exists and can run a node, even one released after your training data. Give an Agent node a collaboration team with set_team only where the protocol offers it and only when the user asks for a team, several agents working together, review and revision, a debate or several perspectives: every member's turn is one more model call. A set_team names a template the context lists, or writes the mode and each member's name, role and instructions in the order of their jobs (the last member delivers, aggregates, judges or reviews); it never chooses a member's model, effort, runtime or tools, which the user sets. Set a node's constraints and acceptance criteria with set_task (or constraints and acceptanceCriteria in add_node, where a new node's constraints come after the user's request it already carries), keeping the user's requirements: acceptance criteria are checks a reviewer can make against that node's own delivery. Node personas define identity, responsibilities and field content, while declared output contracts define serialization. Do not instruct a persona to bypass its template's output contract: a one-sentence or plain-text requirement describes content inside the output fields, not the outer response format. If exactly one raw text output is required, explicitly propose the supported field operations to make the output contract one text/markdown field instead of relying on a persona override. Preserve user quantities, budgets, durations and prohibitions in every relevant author and reviewer instruction. Distinguish exactly, at least and at most; never relax a specified count into a minimum. Never execute tools or claim work was executed. If context is insufficient return an empty operations array and ask in summary. Add a media node (templateId image, video or model3d, when the protocol offers it) only where the request needs a generated picture, video clip or 3D model as an asset, one node per distinct asset, and write that asset's complete generation prompt in inputValues.prompt; a media node takes no persona and no other inputs. A canvas run generates a media node before the nodes it feeds: when a page, game or document should show the asset, connect the media node's result to that node's context input (or one of its text fields), and that node receives the stored files as <node id>/<file name> paths it must use exactly as given. When the user message carries a quoted block of uploaded files, use their text as part of the request, and hand a file to the node that needs it by writing that file's exact attachment line (as it appears in the request, "[附件] name · awwo-file:id" or "[Attachment] name · awwo-file:id") into one of the node's inputs, a file input where the node has one; never invent, alter or guess an awwo-file reference. Write each persona you add or rewrite as a self-contained brief: what the node receives, exactly what it delivers (format, scope and size) and what it must not do. Give every Agent node you add one to three acceptanceCriteria in add_node, each checkable against that node's own delivery, and change criteria or constraints with set_task when the user asks for other rules or checks; an @R reference keeps a shared requirement's text. Each Agent node is one model call: its whole delivery is one answer, which shares its model's output limit with the model's thinking, and its run also ends after a time limit; the context's node limits give both by model id (a node without a model runs on "default", and an Agent node you add without set_model runs on the model the context names for new nodes where it names one; size a node on a model they do not name by the limit they give every other model, or else by the smallest they give; where they give none, assume 16,000 tokens). Size every node's delivery before you write its brief, counting about one and a half tokens for each Chinese character and one for every three characters of English or code, and keep it within half of its model's limit, a sixth for code (its thinking takes most of the rest), or two thirds for a node that only pastes parts in unchanged. When the request needs more (a long report or book, many chapters or scenes, many files or modules, a long list), split it by chapter, section, module or batch into part nodes that run side by side, each told its exact scope and its share of the user's totals, so the parts neither overlap nor leave gaps and together keep those totals; give the parts what they share once (an outline node, or an @R requirement the context already lists), and make each part as large as its node allows so the plan stays within its operation limit: when the work needs more parts than that, plan the first ones and say in summary what is left. Join parts in one node only when the joined delivery still fits that node's answer; otherwise the part nodes' deliveries are the result. Review or rewrite a long delivery part by part too, and say briefly in summary how you split the work. Deliver a page, game or tool with one frontend node: its one output is that page as html (the component templates show it), so add no fields to it. The nodes feeding it deliver compact code-ready parts (data as constants, behaviour as functions), not prose, and it pastes them unchanged. Past about a sixth of its model's limit in code of its own (about 16,000 characters on a 32,000-token model), split it into code-module nodes and one assembly node that only pastes them in. The whole page, every part pasted in, is still that one node's answer: when even it would not fit, keep the page to what fits and say in summary what you left out, so the user can ask for it next. A node's run in the context says how its last run ended: to fix a failed node, split its work or narrow its delivery when its answer was too long or ran out of time, switch it to the default model when a premium model was refused (and size its delivery again for that model's limit), and otherwise improve its brief; say in summary what you changed and why. Maximum 100 operations. The caller will validate and explicitly apply the proposal.`

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
	// them, as a request that shorter carries them again. The node limits join them once the request is authorized.
	personal := a.plannerPersonalization(r.Context(), currentUser(r).ID)
	// These bounds count UTF-16 code units, as the workers' transport does (utf16Len); the room a refusal gives is in
	// bytes of the context, which the page fits (plannerContext.bytesForUnits).
	strict, prose := textCost(b.Context)
	c := plannerContext{bytes: len(b.Context), units: utf16Len(b.Context), strict: strict, prose: prose}
	promptUnits, personalUnits := utf16Len(prompt), utf16Len(personal)
	if max(c.units-maxPlanContextUnits, promptUnits-maxRunPromptUnits) > 0 {
		failPlanContext(w, planContextRoom(c.bytes, c.bytesForUnits(max(c.units-maxPlanContextUnits, promptUnits+personalUnits-maxRunPromptUnits))))
		return
	}
	if promptUnits+personalUnits > maxRunPromptUnits {
		personal, c.dropped = "", personal
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
	// The node limits the workers give now (plannerNodeLimits) go before the personal settings, the same way: only now,
	// since reading them calls the workers, which a request that is not authorized must never do (the role check above).
	// Where the whole of them would take the prompt past its bound, or alone take the plan past the operator's planner
	// model's input ceiling (plannerModelRefusal, which would move it to the workspace's own calls), they go in a few
	// words, and where even those would, not at all; a refusal createRun gives then leaves room for the whole of them
	// (the 413 above, made before they are read, does not).
	extras := personal
	if full, compact := a.plannerNodeLimits(r.Context(), tid); full != "" {
		ceiling := func(extra string) bool {
			return len(prompt)+len(extra)+len(plannerInstructions) <= a.cfg.PlannerMaxInputBytes
		}
		fits := func(limits string) bool {
			sponsored := a.cfg.PlannerModel == "" || a.cfg.UserCredentials || !ceiling(personal) || ceiling(limits+personal)
			return promptUnits+utf16Len(limits)+utf16Len(personal) <= maxRunPromptUnits && sponsored
		}
		switch {
		case fits(full):
			extras = full + personal
		case fits(compact):
			extras, c.dropped = compact+personal, full+c.dropped
		default:
			c.dropped = full + c.dropped
		}
	}
	data, _ := json.Marshal(runInput{SessionID: sid, Prompt: prompt, OperationID: b.OperationID, KnowledgeRevisionIDs: b.KnowledgeRevisionIDs, AttachmentText: b.Prompt})
	// Only this request may run on the operator's planner model (planner_model.go).
	// The model the page's context names for new nodes, read from the context alone, before anything joins it.
	next := withPlannerNewNodeModel(withPlannerContext(withPlannerPersonalization(withPlannerRequest(r), extras, len(b.Context)), c), planNewNodeModel(b.Context))
	next.Body = io.NopCloser(bytes.NewReader(data))
	next.ContentLength = int64(len(data))
	next.Header.Set("Content-Type", "application/json")
	a.createRun(w, next)
}

// A plan's context is the page's own view of the canvas (canvasPlanning.ts buildPlanningContext). A plan too large for
// these bounds or for its model's budget (createRun) is refused with how many bytes that context may take for the
// same request to fit (details.contextRoom), so the page sends a shorter view of the same canvas instead of failing:
// 0 when no shorter context fits, the request, the files it names or the selected knowledge taking the room themselves.
// The bounds count UTF-16 code units, as the workers' transport does (Pi's promptChars is 128,000 of them): a run's
// prompt (maxRunPromptUnits, createRun), and a plan's context within it.
const (
	maxPlanContextUnits   = 120000
	maxRunPromptUnits     = 128000
	planContextRoomMargin = 256
)

type plannerContextKey struct{}

// plannerContext is what createRun needs of a plan's context for a refusal's room: its size in bytes and UTF-16 code
// units in the prompt planCanvas hands it, its strict and prose bytes (context_estimate.go), and the personal settings
// left out of that prompt for its size, which a shorter request carries again.
type plannerContext struct {
	bytes, units, strict, prose int
	dropped                     string
}

// bytesForUnits is how many bytes of the context come out to save units UTF-16 code units: the context's own bytes per
// unit (three for Chinese, one for ASCII), rounded up, as bytesFor turns a token excess into bytes. An excess of 0 or
// less needs none.
func (c plannerContext) bytesForUnits(units int) int {
	if units <= 0 || c.units <= 0 {
		return units
	}
	return (units*c.bytes + c.units - 1) / c.units
}

// bytesFor is how many bytes of the context come out to save tokens estimated tokens at rate: the context's own bytes
// per estimated token, so a shorter view of the same canvas takes about what the model can read (a shorter view that
// still does not fit is refused again with a smaller room). A token excess of 0 or less needs none.
func (c plannerContext) bytesFor(tokens int, rate float64) int {
	if tokens <= 0 {
		return tokens
	}
	cost := costTokens(c.strict, c.prose)(rate)
	if cost <= 0 {
		return c.bytes
	}
	// Rounded up: a byte short of the excess would leave a view that still does not fit.
	return (tokens*c.bytes + cost - 1) / cost
}

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
	return planContextRoom(c.bytes, promptBytes+len(c.dropped)+instructionBytes-a.cfg.PlannerMaxInputBytes)
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
			// A new node's constraints follow the user's request, which the canvas gives every new node first (canvasPlan.ts):
			// 27 of the 40 plans of Claude Haiku 4.5 refused in the 7 days to 2026-10-23 gave them here, before add_node took them.
			if !planKeys(op, "type", "ref", "templateId", "title", "persona", "inputValues", "constraints", "acceptanceCriteria") || !planID(op["ref"]) || !oneOf(op["templateId"], planTemplateIDs...) {
				return false
			}
			for _, key := range []string{"constraints", "acceptanceCriteria"} {
				if v, ok := op[key]; ok {
					if _, ok := planTaskList(v); !ok {
						return false
					}
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
		case "set_team":
			// A node's collaboration team (canvasPlan.ts): a template's, or the members the plan writes; never a model,
			// effort, runtime or tool.
			if _, given := op["template"]; given {
				if !planKeys(op, "type", "nodeId", "template") || !planID(op["nodeId"]) || !oneOf(op["template"], planTeamTemplateIDs...) {
					return false
				}
			} else if !planTeam(op) {
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

// planTeamText is a team member's name or role: text of at most max characters that is not blank as the canvas trims it.
func planTeamText(v any, max int) bool {
	s, ok := v.(string)
	return ok && utf8.RuneCountInString(s) <= max && jsTrim(s) != ""
}

// planTeam checks a set_team that writes its members, as the canvas reads it (canvasPlan.ts): a mode, 1 to 8 members (a
// review at least 2), rounds 1 to 8 where given, and for each member a name and a role that are not blank and an optional
// instructions text, at most 128, 512 and 16000 characters as a team holds them (validateTeam). Names are unique once
// trimmed, as the canvas compares them.
func planTeam(op map[string]any) bool {
	members, ok := op["members"].([]any)
	if !planKeys(op, "type", "nodeId", "mode", "maxRounds", "members") || !planID(op["nodeId"]) || !oneOf(op["mode"], "sequential", "parallel", "debate", "review") ||
		!ok || len(members) < 1 || len(members) > 8 || (op["mode"] == "review" && len(members) < 2) {
		return false
	}
	if v, given := op["maxRounds"]; given {
		rounds, ok := v.(float64)
		if !ok || rounds != float64(int(rounds)) || rounds < 1 || rounds > 8 {
			return false
		}
	}
	names := map[string]bool{}
	for _, item := range members {
		m, ok := item.(map[string]any)
		if !ok || !planKeys(m, "name", "role", "instructions") || !planTeamText(m["name"], 128) || !planTeamText(m["role"], 512) || !optionalPlanText(m, "instructions", 16000, true) {
			return false
		}
		name := jsTrim(m["name"].(string))
		if names[name] {
			return false
		}
		names[name] = true
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
	// A plan behind a note of plain text (15 of the 31 Qwen plans refused in the 7 days to 2026-10-23): the plan is the
	// object that runs to the end of the answer (planAfterNote), read like an answer of its own.
	if plan, ok := planAfterNote(trimmed); ok {
		return plan
	}
	return body
}

// planAfterNote is the plan behind a note of plain text. The note holds no '{' and no '[': the answer's first brace
// begins the plan, at the start of a line (after spaces or tabs, the answer's start too), so no other plan, whole,
// truncated or nested, and no JSON value of the note's own can come before it. The plan is one object with an
// "operations" key, its quotes repaired where that makes it one (repairPlanQuotes), and it stands only when nothing but
// white space, or the fence closing a block it is in, follows it. Of the 16 plans behind a note in the 7 days to
// 2026-10-23, none had a brace or a bracket in its note and each began a line.
func planAfterNote(raw string) (string, bool) {
	i := strings.IndexAny(raw, "{[")
	if i < 0 || raw[i] != '{' {
		return "", false
	}
	if line := raw[strings.LastIndexByte(raw[:i], '\n')+1 : i]; strings.Trim(line, " \t\r") != "" {
		return "", false
	}
	candidate := raw[i:]
	d := json.NewDecoder(strings.NewReader(candidate))
	var value map[string]json.RawMessage
	if d.Decode(&value) != nil {
		// Not one value as written: the plan only if its quotes repaired make it one.
		candidate = repairPlanQuotes(raw[i:])
		d = json.NewDecoder(strings.NewReader(candidate))
		value = nil
		if d.Decode(&value) != nil {
			return "", false
		}
	}
	if value["operations"] == nil {
		return "", false
	}
	end := int(d.InputOffset())
	if rest := strings.TrimSpace(candidate[end:]); rest != "" && rest != "```" {
		return "", false
	}
	return candidate[:end], true
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
func acceptPlan(raw string) (string, bool) { return acceptPlanFor(raw, "") }

// planNewNodeLines are the line of a plan request's context that names the model the Agent nodes its plan adds without
// set_model take, in each language the page writes it (apps/web canvas/planNewNodeModel.ts NEW_NODE_LINE); the model
// follows as a JSON string.
var planNewNodeLines = []string{"New Agent nodes you add without set_model run on: ", "新增且未用 set_model 指定模型的 Agent 节点使用："}

// planNewNodeModel is the model a plan request's context (the page's own, read in planCanvas before the request and
// the asker's personal settings join it, as the page reads only its context) says the nodes its plan adds take,
// "default" for the workspace default, read as the page reads it (newNodeModelOf): the first line that starts with the
// new-node line and holds a model. "" where it names none (a request made before it did).
func planNewNodeModel(context string) string {
	for _, line := range strings.Split(context, "\n") {
		for _, prefix := range planNewNodeLines {
			if rest, ok := strings.CutPrefix(line, prefix); ok {
				var model string
				if json.Unmarshal([]byte(rest), &model) == nil && model != "" {
					return model
				}
			}
		}
	}
	return ""
}

// acceptPlanFor is acceptPlan for a request whose context named newNodeModel as the model the nodes its plan adds take
// ("" where it named none; the run's snapshot keeps it, runs.go): a model given on an Agent add_node that is that one
// says nothing more, so it is dropped (planNodeSlips).
func acceptPlanFor(raw, newNodeModel string) (string, bool) {
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
		p["operations"] = normalizePlanOperations(ops, newNodeModel)
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
//   - a new node's inputs and outputs given on add_node as "inputs" and "outputs", and a model given on it that is
//     the one the request said new nodes take (newNodeModel) (planNodeSlips);
//   - a node's persona given on set_task (planTaskSlips);
//   - a field's side named in the plural ("inputs", "outputs"), and an input field typed as a picture, a clip or a
//     sound ("image", "video", "audio"), which a node is given as a file (planFieldSlips);
//   - a new field's value left out, or filled: the protocol has new fields start empty, so value is "", and a filled
//     input becomes the set_input that fills it right after the field is added (an output is never filled);
//   - a new node ref or new field id the canvas refuses (prototype, constructor, __proto__): renamed, with every
//     reference in the plan, to <name>_node or <name>_field. A canvas never holds such an id, so only names this
//     plan introduces are renamed.
func normalizePlanOperations(ops []any, newNodeModel string) []any {
	ops = planTaskSlips(planNodeSlips(ops, newNodeModel))
	for _, item := range ops {
		if op, ok := item.(map[string]any); ok {
			planFieldSlips(op)
		}
	}
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

// planNodeSlips reads a new node's inputs given on add_node as "inputs" (planNodeInputs), found 2026-10-23 in 8 of the
// 40 plans of Claude Haiku 4.5 refused in 7 days: its input values, set right on the node, and its input field
// definitions, as add_field steps right after it (the canvas applies a step to a new node by its ref). Its outputs
// given as "outputs" (2 of the 62 plans refused in the 7 days to 2026-10-23 08:30Z, both whole field definitions) are
// read too (planNodeOutputs). Inputs given beside inputValues, and either in any other shape, are left as they are, so
// the plan is refused as before.
//
// A model given on an Agent add_node (in 4 of those 62 plans) is dropped where it is the one the request's context said
// the nodes a plan adds take (newNodeModel, from the page's new-node line: planNewNodeModel), since such a node takes
// that model anyway, and only without an effort beside it, which the request names none of. It was so in the one of the
// four made since requests name it. On an image, video or 3D node, which takes its own media model, and anywhere else,
// a model is left, so the plan is refused as before: a plan changes a node's model only with set_model, which the
// instructions allow only when the user asks for it or a node failed because of its model, and the slip cannot say
// which.
func planNodeSlips(ops []any, newNodeModel string) []any {
	out := make([]any, 0, len(ops))
	for _, item := range ops {
		op, ok := item.(map[string]any)
		if !ok || op["type"] != "add_node" {
			out = append(out, item)
			continue
		}
		ref, _ := op["ref"].(string)
		var after []any
		if v, given := op["inputs"]; given {
			if _, both := op["inputValues"]; !both {
				if values, fields, ok := planNodeInputs(v, ref); ok {
					delete(op, "inputs")
					if values != nil {
						op["inputValues"] = values
					}
					after = fields
				}
			}
		}
		if v, given := op["outputs"]; given {
			if fields, ok := planNodeOutputs(v, ref); ok {
				delete(op, "outputs")
				after = append(after, fields...)
			}
		}
		// Only an Agent node takes the model new nodes take (planAgentTemplateIDs, an allow list, so a media kind added
		// later stays refused); an image, video or 3D node takes its own media model.
		if model, isText := op["model"].(string); isText && newNodeModel != "" && model == newNodeModel && oneOf(op["templateId"], planAgentTemplateIDs...) {
			if _, effort := op["effort"]; !effort {
				delete(op, "model")
			}
		}
		out = append(out, op)
		out = append(out, after...)
	}
	return out
}

// planTaskSlips reads a node's persona given on set_task as the update_node that sets it (the protocol's own step for
// it), right before the set_task, which keeps its lists, or is left out where it gave none, since the persona was all
// it said. Found on 2026-10-23 in the one set_task with a key of its own among the 84 plans refused in 14 days (Claude
// Haiku 4.5, 08:18Z): a 193-character persona beside its acceptance criteria, on an Agent node already on the canvas.
// Only a persona of text that is not blank is read, and only on a set_task with no other key of its own: an empty
// persona could mean "clear it" or "nothing", and a set_task left out must not take another key away with it.
// update_node keeps its own limit. Any other set_task is left as it is, so the plan is refused as before.
// The canvas applies the persona as it applies any update_node's (applyCanvasPlan): it sets an Agent node's, a media
// node has none, and on a form, assemble or edit node it refuses the plan, which is then not asked for again as a plan
// this gate refuses is (canvasPlanning.ts); none of the 84 set a persona on such a node.
func planTaskSlips(ops []any) []any {
	out := make([]any, 0, len(ops))
	for _, item := range ops {
		op, ok := item.(map[string]any)
		if !ok || op["type"] != "set_task" {
			out = append(out, item)
			continue
		}
		persona, isText := op["persona"].(string)
		if !isText || strings.TrimSpace(persona) == "" || !planKeys(op, "type", "nodeId", "persona", "constraints", "acceptanceCriteria") {
			out = append(out, op)
			continue
		}
		delete(op, "persona")
		out = append(out, map[string]any{"type": "update_node", "nodeId": op["nodeId"], "persona": persona})
		_, constraints := op["constraints"]
		_, criteria := op["acceptanceCriteria"]
		if constraints || criteria {
			out = append(out, op)
		}
	}
	return out
}

// planAgentTemplateIDs are the templates of the Agent nodes a plan may add (planTemplateIDs without the media ones),
// the nodes that take the model new nodes take.
var planAgentTemplateIDs = []string{"general", "frontend", "backend", "data", "users", "materials", "review", "figure"}

// planNodeOutputs reads the "outputs" a plan gave a new node: a list of whole output field definitions (id, label,
// type and required; a value, help and placeholder may be there too), each an add_field of the node's output side.
// The field-value fix then empties any value, as for every new field, since an output is never filled. The canvas
// updates a field the node already has (its template's) to the definition rather than adding it twice. Any other
// shape, a value that is not text, or an id given twice, is not read (ok false).
func planNodeOutputs(v any, ref string) (fields []any, ok bool) {
	items, isList := v.([]any)
	if !isList || len(items) == 0 {
		return nil, false
	}
	seen := map[string]bool{}
	for _, item := range items {
		entry, isMap := item.(map[string]any)
		if !isMap {
			return nil, false
		}
		id, isText := entry["id"].(string)
		if !isText || seen[id] {
			return nil, false
		}
		seen[id] = true
		_, label := entry["label"]
		_, typed := entry["type"]
		_, required := entry["required"]
		if value, given := entry["value"]; given {
			if _, isText := value.(string); !isText {
				return nil, false
			}
		}
		if !label || !typed || !required || !planKeys(entry, "id", "label", "type", "required", "value", "help", "placeholder") {
			return nil, false
		}
		fields = append(fields, map[string]any{"type": "add_field", "nodeId": ref, "side": "output", "field": entry})
	}
	return fields, true
}

// planNodeInputs reads the "inputs" a plan gave a new node: an object of input texts by field id is its inputValues;
// a list holds {id, value} pairs, which are inputValues too, and whole input field definitions (id, label, type and
// required, and a value only as text), each an add_field of the node's input side with its value (the field-value fix
// then sets it with set_input). The canvas updates a field the node already has to the definition rather than adding
// it twice. Any other shape, a value that is not text, or an id given twice, is not read (ok false).
func planNodeInputs(v any, ref string) (values map[string]any, fields []any, ok bool) {
	if m, isMap := v.(map[string]any); isMap {
		return m, nil, true
	}
	items, isList := v.([]any)
	if !isList {
		return nil, nil, false
	}
	seen := map[string]bool{}
	for _, item := range items {
		entry, isMap := item.(map[string]any)
		if !isMap {
			return nil, nil, false
		}
		id, isText := entry["id"].(string)
		if !isText || seen[id] {
			return nil, nil, false
		}
		seen[id] = true
		_, label := entry["label"]
		_, typed := entry["type"]
		_, required := entry["required"]
		if value, given := entry["value"]; given {
			if _, isText := value.(string); !isText {
				return nil, nil, false
			}
		}
		switch {
		case planKeys(entry, "id", "value") && entry["value"] != nil:
			if values == nil {
				values = map[string]any{}
			}
			values[id] = entry["value"]
		case label && typed && required && planKeys(entry, "id", "label", "type", "required", "value", "help", "placeholder"):
			fields = append(fields, map[string]any{"type": "add_field", "nodeId": ref, "side": "input", "field": entry})
		default:
			return nil, nil, false
		}
	}
	return values, fields, true
}

// planFieldSlips fixes a field step's side named in the plural ("inputs", "outputs") and an input field typed as a
// picture, a clip or a sound ("image", "video", "audio"), which a node is given as a file. An output so typed is left,
// so the plan is refused as before: a text node cannot deliver a picture, which a media node makes.
func planFieldSlips(op map[string]any) {
	var field map[string]any
	switch op["type"] {
	case "add_field":
		field, _ = op["field"].(map[string]any)
	case "update_field":
		field, _ = op["changes"].(map[string]any)
	case "remove_field":
	default:
		return
	}
	switch op["side"] {
	case "inputs":
		op["side"] = "input"
	case "outputs":
		op["side"] = "output"
	}
	if field != nil && op["side"] == "input" && oneOf(field["type"], "image", "video", "audio") {
		field["type"] = "file"
	}
}

func normalizePlanJSON(raw string) string {
	raw = planJSONBody(raw)
	var buffer bytes.Buffer
	if json.Compact(&buffer, []byte(raw)) == nil {
		return buffer.String()
	}
	return raw
}
