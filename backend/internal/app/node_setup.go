package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type setupBinding struct {
	CompanyID string `json:"companyId"`
	AgentID   string `json:"agentId"`
	AgentName string `json:"agentName"`
}

type setupConfiguration struct {
	Name      string    `json:"name"`
	AgentKind string    `json:"agentKind"`
	Runtime   string    `json:"runtime"`
	Model     string    `json:"model"`
	Persona   string    `json:"persona"`
	Team      *nodeTeam `json:"team,omitempty"`
}

type setupError struct{ code, message string }

func (e setupError) Error() string      { return e.message }
func invalidSetup(message string) error { return setupError{"invalid_node_setup", message} }
func missingSetupReference() error {
	return setupError{"not_found", "Node Agent or conversation does not belong to this canvas and workspace"}
}

func rawString(v json.RawMessage) string {
	var s string
	_ = json.Unmarshal(v, &s)
	return s
}
func putJSON(m map[string]json.RawMessage, key string, value any) {
	m[key], _ = json.Marshal(value)
}
func equalJSON(a, b json.RawMessage) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && reflect.DeepEqual(left, right)
}

// initializeCanvas admits no model calls. The saved document, tenant membership,
// Agent/session rows, and returned canvas version form one committed transaction.
func (a *App) initializeCanvas(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DocumentVersion int64           `json:"documentVersion"`
		Scope           json.RawMessage `json:"scope"`
	}
	if !a.decode(w, r, &body) {
		return
	}
	if body.DocumentVersion < 1 {
		fail(w, 400, "invalid_input", "Current documentVersion is required")
		return
	}
	var scope []string
	if len(body.Scope) != 0 {
		if json.Unmarshal(body.Scope, &scope) != nil || len(scope) == 0 || len(scope) > 200 {
			fail(w, 400, "invalid_scope", "Scope must contain 1 to 200 distinct session node IDs")
			return
		}
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid, cid := r.PathValue("tenantId"), r.PathValue("id")
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var version int64
	var raw json.RawMessage
	if e = tx.QueryRow(r.Context(), "SELECT version,document FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, cid).Scan(&version, &raw); noRows(e) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	} else if e != nil {
		a.dbError(w, e)
		return
	}
	if version != body.DocumentVersion {
		fail(w, 409, "version_conflict", "Canvas changed; reload before initializing")
		return
	}
	var busy bool
	e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM node_sessions s JOIN runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.id WHERE s.tenant_id=$1 AND s.canvas_id=$2 AND r.status IN ('queued','running')) OR EXISTS(SELECT 1 FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND status IN ('queued','running'))", tid, cid).Scan(&busy)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if busy {
		fail(w, 409, "resource_in_use", "Stop active canvas, node and planner runs before initializing")
		return
	}
	var doc map[string]json.RawMessage
	var nodes []json.RawMessage
	if json.Unmarshal(raw, &doc) != nil || doc == nil || (len(doc["nodes"]) != 0 && json.Unmarshal(doc["nodes"], &nodes) != nil) || len(nodes) > 200 {
		fail(w, 400, "invalid_document", "Canvas nodes must be an array of at most 200 nodes")
		return
	}
	selected, e := setupScope(nodes, scope)
	if e != nil {
		fail(w, 400, "invalid_scope", e.Error())
		return
	}
	catalog := runtimeCatalog{}
	changed := false
	for i, original := range nodes {
		if !selected[i] {
			continue
		}
		var selection struct{ Runtime, Model, Persona string }
		if json.Unmarshal(original, &selection) != nil {
			fail(w, 400, "invalid_node_setup", "Invalid node configuration")
			return
		}
		var identity struct{ ID string }
		_ = json.Unmarshal(original, &identity)
		team, err := savedNodeTeam(raw, identity.ID)
		if err != nil {
			fail(w, 400, "invalid_node_setup", err.Error())
			return
		}
		if _, err = a.runtimeSnapshot(r.Context(), catalog, selection.Runtime, selection.Model, selection.Persona, team); err != nil {
			var input setupError
			if errors.As(err, &input) {
				fail(w, 400, "invalid_node_setup", input.message)
				return
			}
			a.runtimeAdmissionError(w, err)
			return
		}
		updated, err := a.initializeNode(r.Context(), tx, tid, cid, original, catalog)
		if err != nil {
			var input setupError
			if errors.As(err, &input) {
				status := 400
				if input.code == "not_found" {
					status = 404
				}
				fail(w, status, input.code, input.message)
			} else {
				a.dbError(w, err)
			}
			return
		}
		if !equalJSON(original, updated) {
			nodes[i], changed = updated, true
		}
	}
	if changed {
		putJSON(doc, "nodes", nodes)
		document, _ := json.Marshal(doc)
		if _, e = tx.Exec(r.Context(), "UPDATE canvases SET document=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", tid, cid, document); e != nil {
			a.dbError(w, e)
			return
		}
		if e = audit(r.Context(), tx, currentUser(r).ID, tid, "canvas.initialized", cid); e != nil {
			a.dbError(w, e)
			return
		}
	}
	v, e := oneJSON(r.Context(), tx, "SELECT "+canvasJSON+" FROM canvases WHERE tenant_id=$1 AND id=$2", tid, cid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, v)
}

func setupScope(nodes []json.RawMessage, scope []string) (map[int]bool, error) {
	ids := map[string]int{}
	kinds := map[string]string{}
	for i, raw := range nodes {
		var n struct{ ID, Kind string }
		if json.Unmarshal(raw, &n) != nil || strings.TrimSpace(n.ID) == "" || len(n.ID) > 200 {
			return nil, errors.New("Every node must have a valid ID")
		}
		if _, exists := ids[n.ID]; exists {
			return nil, errors.New("Node IDs must be unique")
		}
		ids[n.ID], kinds[n.ID] = i, n.Kind
	}
	selected := map[int]bool{}
	if scope == nil {
		for id, kind := range kinds {
			if kind == "session" {
				selected[ids[id]] = true
			}
		}
		return selected, nil
	}
	for _, id := range scope {
		index, exists := ids[id]
		if !exists || kinds[id] != "session" || selected[index] {
			return nil, errors.New("Scope must reference distinct saved session nodes")
		}
		selected[index] = true
	}
	return selected, nil
}

func setupConfig(raw json.RawMessage, catalog runtimeCatalog) (setupConfiguration, error) {
	var n struct{ ID, Title, Runtime, Model, Persona, AgentKind, Effort string }
	if json.Unmarshal(raw, &n) != nil {
		return setupConfiguration{}, invalidSetup("Node configuration contains invalid field types")
	}
	if n.Runtime == "" {
		n.Runtime = "pi"
	}
	if n.AgentKind == "" {
		n.AgentKind = "llm"
	}
	if !validRuntime(n.Runtime) || (n.AgentKind != "llm" && n.AgentKind != "coding") || n.Effort != "" {
		return setupConfiguration{}, invalidSetup("Only supported runtime text/coding nodes without an explicit effort setting are supported")
	}
	health, ok := catalog[n.Runtime]
	if !ok {
		return setupConfiguration{}, invalidSetup("Node runtime is unavailable")
	}
	if n.Model == "" {
		n.Model = health.Model
	}
	if n.Model == "" {
		return setupConfiguration{}, invalidSetup("Runtime has no default model configured")
	}
	if _, _, ok := health.modelLimits(n.Model); !ok {
		return setupConfiguration{}, invalidSetup("Node selects an unavailable model")
	}
	name := strings.TrimSpace(n.Title)
	if name == "" {
		name = "Agent " + n.ID
	}
	if !cleanName(name) || len(n.Persona) > 32000 || len(n.Model) > 200 {
		return setupConfiguration{}, invalidSetup("Node name, model or persona exceeds the Agent limits")
	}
	document, _ := json.Marshal(map[string]any{"nodes": []json.RawMessage{raw}})
	team, err := savedNodeTeam(document, n.ID)
	if err != nil {
		return setupConfiguration{}, invalidSetup(err.Error())
	}
	team, err = resolveTeam(team, n.Runtime, n.Model, catalog)
	if err != nil {
		return setupConfiguration{}, invalidSetup(err.Error())
	}
	return setupConfiguration{Name: name, AgentKind: n.AgentKind, Runtime: n.Runtime, Model: n.Model, Persona: n.Persona, Team: team}, nil
}

func (a *App) initializeNode(ctx context.Context, tx pgx.Tx, tid, cid string, raw json.RawMessage, catalog runtimeCatalog) (json.RawMessage, error) {
	config, err := setupConfig(raw, catalog)
	if err != nil {
		return nil, err
	}
	var node map[string]json.RawMessage
	_ = json.Unmarshal(raw, &node)
	nid, sid := rawString(node["id"]), rawString(node["issueId"])
	var old *setupBinding
	if v := node["binding"]; len(v) > 0 && string(v) != "null" {
		if json.Unmarshal(v, &old) != nil || old == nil || old.AgentID == "" || (old.CompanyID != "" && old.CompanyID != tid) {
			return nil, missingSetupReference()
		}
	}
	oldConfig := setupConfiguration{Runtime: "pi"}
	if old != nil {
		if err = tx.QueryRow(ctx, "SELECT name,model,instructions,runtime FROM agents WHERE tenant_id=$1 AND id=$2 AND NOT internal", tid, old.AgentID).Scan(&oldConfig.Name, &oldConfig.Model, &oldConfig.Persona, &oldConfig.Runtime); noRows(err) {
			return nil, missingSetupReference()
		} else if err != nil {
			return nil, err
		}
		if oldConfig.Model == "" {
			oldConfig.Model = catalog[oldConfig.Runtime].Model
		}
		old.CompanyID, old.AgentName = tid, oldConfig.Name
	}
	var priorSnapshot json.RawMessage
	if sid != "" {
		var aid string
		if err = tx.QueryRow(ctx, "SELECT agent_id,setup_snapshot FROM node_sessions WHERE tenant_id=$1 AND id=$2 AND canvas_id=$3 AND node_id=$4 AND kind='node'", tid, sid, cid, nid).Scan(&aid, &priorSnapshot); noRows(err) || (err == nil && (old == nil || aid != old.AgentID)) {
			return nil, missingSetupReference()
		} else if err != nil {
			return nil, err
		}
	}
	threads, active, err := setupThreads(ctx, tx, tid, cid, nid, node)
	if err != nil {
		return nil, err
	}
	currentExists := len(threads[active]) > 0
	if storedSID := rawString(threads[active]["issueId"]); storedSID != "" && storedSID != sid {
		return nil, invalidSetup("Active thread and node conversation must agree before initialization")
	}
	configRaw, _ := json.Marshal(config)
	changed := old != nil && (oldConfig.Runtime != config.Runtime || oldConfig.Name != config.Name || oldConfig.Model != config.Model || oldConfig.Persona != config.Persona)
	if sid != "" {
		if len(priorSnapshot) > 0 {
			changed = changed || !equalJSON(priorSnapshot, configRaw)
		} else if config.Team != nil {
			changed = true
		}
	}
	binding := old
	if old == nil || changed {
		binding = &setupBinding{CompanyID: tid, AgentID: randomID(), AgentName: config.Name}
		if _, err = tx.Exec(ctx, "INSERT INTO agents(id,tenant_id,name,model,instructions,runtime) VALUES($1,$2,$3,$4,$5,$6)", binding.AgentID, tid, config.Name, config.Model, config.Persona, config.Runtime); err != nil {
			return nil, err
		}
	}
	if changed {
		// Save the old active thread using the actual old Agent configuration,
		// not the just-edited persona/model on the node draft.
		prior := snapshotSetupThread(node, threads[active], active, old, sid, oldConfig)
		threads[active] = prior
		active = randomID()
		threads[active] = map[string]json.RawMessage{}
		putJSON(threads[active], "id", active)
		putJSON(threads[active], "title", fmt.Sprintf("Session %d", len(threads)))
		putJSON(threads[active], "createdAt", time.Now().UnixMilli())
		putJSON(threads[active], "draft", "")
		putJSON(node, "preview", "")
		putJSON(node, "lastOutput", nil)
		clearSetupOutputValues(node)
		sid = ""
	}
	if sid == "" {
		sid = randomID()
		if _, err = tx.Exec(ctx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title,setup_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)", sid, tid, cid, nid, binding.AgentID, config.Name, configRaw); err != nil {
			return nil, err
		}
	} else if len(priorSnapshot) == 0 {
		if _, err = tx.Exec(ctx, "UPDATE node_sessions SET setup_snapshot=$3 WHERE tenant_id=$1 AND id=$2", tid, sid, configRaw); err != nil {
			return nil, err
		}
	}
	if !changed && currentExists {
		// Initialization owns execution identities, not transcript projection.
		// Unchanged setup must not bump the canvas just to copy a newer preview
		// or publication into an otherwise unchanged current thread.
		configureSetupThread(threads[active], binding, sid, config)
	} else {
		threads[active] = snapshotSetupThread(node, threads[active], active, binding, sid, config)
	}
	// Preserve historical thread order and append only newly created identities.
	var ordered []map[string]json.RawMessage
	var stored []map[string]json.RawMessage
	_ = json.Unmarshal(node["threads"], &stored)
	seen := map[string]bool{}
	for _, thread := range stored {
		id := rawString(thread["id"])
		ordered = append(ordered, threads[id])
		seen[id] = true
	}
	oldActive := rawString(node["activeThreadId"])
	if oldActive == "" {
		oldActive = "default"
	}
	for _, id := range []string{oldActive, active} {
		if !seen[id] {
			ordered = append(ordered, threads[id])
			seen[id] = true
		}
	}
	putJSON(node, "runtime", config.Runtime)
	putJSON(node, "model", config.Model)
	putJSON(node, "binding", binding)
	putJSON(node, "bindAttempt", nil)
	putJSON(node, "issueId", sid)
	putJSON(node, "activeThreadId", active)
	putJSON(node, "threads", ordered)
	return json.Marshal(node)
}

func setupThreads(ctx context.Context, tx pgx.Tx, tid, cid, nid string, node map[string]json.RawMessage) (map[string]map[string]json.RawMessage, string, error) {
	var list []map[string]json.RawMessage
	if raw := node["threads"]; len(raw) != 0 && json.Unmarshal(raw, &list) != nil {
		return nil, "", invalidSetup("Node threads must be an array")
	}
	threads := map[string]map[string]json.RawMessage{}
	for _, thread := range list {
		id := rawString(thread["id"])
		if id == "" || threads[id] != nil {
			return nil, "", invalidSetup("Thread IDs must be nonempty and unique")
		}
		var binding *setupBinding
		if raw := thread["binding"]; len(raw) != 0 && string(raw) != "null" {
			if json.Unmarshal(raw, &binding) != nil || binding == nil || binding.AgentID == "" || (binding.CompanyID != "" && binding.CompanyID != tid) {
				return nil, "", missingSetupReference()
			}
			var exists bool
			if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM agents WHERE tenant_id=$1 AND id=$2 AND NOT internal)", tid, binding.AgentID).Scan(&exists); e != nil {
				return nil, "", e
			} else if !exists {
				return nil, "", missingSetupReference()
			}
		}
		if sid := rawString(thread["issueId"]); sid != "" {
			var aid string
			if e := tx.QueryRow(ctx, "SELECT agent_id FROM node_sessions WHERE tenant_id=$1 AND id=$2 AND canvas_id=$3 AND node_id=$4 AND kind='node'", tid, sid, cid, nid).Scan(&aid); noRows(e) || (e == nil && binding != nil && aid != binding.AgentID) {
				return nil, "", missingSetupReference()
			} else if e != nil {
				return nil, "", e
			}
		}
		threads[id] = thread
	}
	active := rawString(node["activeThreadId"])
	if active == "" {
		active = "default"
	}
	if threads[active] == nil {
		threads[active] = map[string]json.RawMessage{}
	}
	return threads, active, nil
}

func snapshotSetupThread(node, prior map[string]json.RawMessage, id string, binding *setupBinding, sid string, config setupConfiguration) map[string]json.RawMessage {
	thread := map[string]json.RawMessage{}
	for key, value := range prior {
		thread[key] = value
	}
	putJSON(thread, "id", id)
	if rawString(thread["title"]) == "" {
		putJSON(thread, "title", "Session 1")
	}
	if len(thread["createdAt"]) == 0 {
		putJSON(thread, "createdAt", 0)
	}
	if len(thread["draft"]) == 0 {
		putJSON(thread, "draft", "")
	}
	configureSetupThread(thread, binding, sid, config)
	putJSON(thread, "preview", rawString(node["preview"]))
	var previous, current struct {
		Text string
		At   float64
	}
	_ = json.Unmarshal(thread["lastOutput"], &previous)
	_ = json.Unmarshal(node["lastOutput"], &current)
	if current.Text != "" && (previous.Text == "" || current.At >= previous.At) {
		thread["lastOutput"] = node["lastOutput"]
	}
	var contract struct{ Outputs []struct{ ID, Value string } }
	if json.Unmarshal(node["contract"], &contract) == nil {
		values := map[string]string{}
		for _, output := range contract.Outputs {
			values[output.ID] = output.Value
		}
		putJSON(thread, "outputValues", values)
	}
	return thread
}

func configureSetupThread(thread map[string]json.RawMessage, binding *setupBinding, sid string, config setupConfiguration) {
	putJSON(thread, "binding", binding)
	putJSON(thread, "issueId", sid)
	putJSON(thread, "runtime", config.Runtime)
	putJSON(thread, "model", config.Model)
	putJSON(thread, "persona", config.Persona)
	putJSON(thread, "effort", "")
}

func clearSetupOutputValues(node map[string]json.RawMessage) {
	var contract map[string]json.RawMessage
	var outputs []map[string]json.RawMessage
	if json.Unmarshal(node["contract"], &contract) == nil && contract != nil && json.Unmarshal(contract["outputs"], &outputs) == nil {
		for _, field := range outputs {
			putJSON(field, "value", "")
		}
		putJSON(contract, "outputs", outputs)
		putJSON(node, "contract", contract)
	}
}
