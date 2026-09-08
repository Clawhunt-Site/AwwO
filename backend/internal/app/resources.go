package app

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (a *App) tenants(w http.ResponseWriter, r *http.Request) {
	v, e := rowsJSON(r.Context(), a.db, "SELECT "+tenantJSON+" || jsonb_build_object('role',m.role) FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 ORDER BY t.created_at", currentUser(r).ID)
	a.replyList(w, v, e)
}
func (a *App) createTenant(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name string `json:"name"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if !cleanName(b.Name) {
		fail(w, 400, "invalid_input", "Workspace name required")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	id := randomID()
	if _, e = tx.Exec(r.Context(), "INSERT INTO tenants(id,name) VALUES($1,$2)", id, b.Name); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", id, currentUser(r).ID); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, id, "tenant.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	v, e := oneJSON(r.Context(), tx, "SELECT "+tenantJSON+" || jsonb_build_object('role','owner') FROM tenants t WHERE t.id=$1", id)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 201, v)
}
func (a *App) members(w http.ResponseWriter, r *http.Request) {
	a.tenantList(w, r, "members")
}
func (a *App) addMember(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Role != "reader" && b.Role != "member" && b.Role != "admin" {
		fail(w, 400, "invalid_role", "Role must be reader, member or admin")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid := r.PathValue("tenantId")
	actorRole, ok := a.managementRole(w, r, tx, tid)
	if !ok {
		return
	}
	if b.Role == "admin" && actorRole != "owner" {
		fail(w, 403, "forbidden", "Only owners may appoint admins")
		return
	}
	var uid string
	if e = tx.QueryRow(r.Context(), "SELECT id FROM users WHERE email=$1", strings.ToLower(strings.TrimSpace(b.Email))).Scan(&uid); noRows(e) {
		fail(w, 404, "not_found", "Registered user not found")
		return
	} else if e != nil {
		a.dbError(w, e)
		return
	}
	tag, e := tx.Exec(r.Context(), "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", tid, uid, b.Role)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, 409, "already_member", "User is already a member")
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "member.added", uid); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 201, map[string]string{"id": uid, "userId": uid, "role": b.Role})
}
func (a *App) updateMember(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Role string `json:"role"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Role != "reader" && b.Role != "member" && b.Role != "admin" {
		fail(w, 400, "invalid_role", "Role must be reader, member or admin")
		return
	}
	a.changeMember(w, r, b.Role)
}
func (a *App) removeMember(w http.ResponseWriter, r *http.Request) { a.changeMember(w, r, "") }
func (a *App) changeMember(w http.ResponseWriter, r *http.Request, role string) {
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	actor, ok := a.managementRole(w, r, tx, tid)
	if !ok {
		return
	}
	var old string
	e = tx.QueryRow(r.Context(), "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE", tid, id).Scan(&old)
	if noRows(e) {
		fail(w, 404, "not_found", "Member not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if old == "owner" || (actor != "owner" && (old == "admin" || role == "admin")) {
		fail(w, 403, "forbidden", "This membership is protected")
		return
	}
	action := "member.updated"
	if role == "" {
		action = "member.removed"
		_, e = tx.Exec(r.Context(), "DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, id)
	} else {
		_, e = tx.Exec(r.Context(), "UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2", tid, id, role)
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, action, id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}

func (a *App) listCanvases(w http.ResponseWriter, r *http.Request) {
	a.tenantList(w, r, "canvases")
}
func (a *App) getCanvas(w http.ResponseWriter, r *http.Request) {
	v, e := oneJSON(r.Context(), a.db, "SELECT "+canvasJSON+" FROM canvases WHERE tenant_id=$1 AND id=$2", r.PathValue("tenantId"), r.PathValue("id"))
	a.replyOne(w, v, e, 200)
}
func validDocument(v json.RawMessage) bool {
	var o map[string]json.RawMessage
	return len(v) > 0 && json.Unmarshal(v, &o) == nil && o != nil
}
func (a *App) createCanvas(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name     string          `json:"name"`
		Document json.RawMessage `json:"document"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if !cleanName(b.Name) || !validDocument(b.Document) {
		fail(w, 400, "invalid_input", "Name and JSON document object required")
		return
	}
	a.mutateObject(w, r, "canvas.created", randomID(), 201, func(tx pgx.Tx, id string) (json.RawMessage, error) {
		return oneJSON(r.Context(), tx, "INSERT INTO canvases(id,tenant_id,name,document) VALUES($1,$2,$3,$4) RETURNING "+canvasJSON, id, r.PathValue("tenantId"), b.Name, b.Document)
	})
}
func (a *App) updateCanvas(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name     string          `json:"name"`
		Document json.RawMessage `json:"document"`
		Version  int64           `json:"version"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if !cleanName(b.Name) || !validDocument(b.Document) || b.Version < 1 {
		fail(w, 400, "invalid_input", "Name, document and current version required")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	var version int64
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	e = tx.QueryRow(r.Context(), "SELECT version FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, id).Scan(&version)
	if noRows(e) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if version != b.Version {
		fail(w, 409, "version_conflict", "Canvas changed; reload before saving")
		return
	}
	v, e := oneJSON(r.Context(), tx, "UPDATE canvases SET name=$3,document=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING "+canvasJSON, tid, id, b.Name, b.Document)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "canvas.updated", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, v)
}
func (a *App) deleteCanvas(w http.ResponseWriter, r *http.Request) {
	a.deleteObject(w, r, "canvases", "canvas.deleted")
}

type agentInput struct {
	Name          string `json:"name"`
	Role          string `json:"role"`
	Title         string `json:"title"`
	Model         string `json:"model"`
	AdapterType   string `json:"adapterType"`
	AdapterConfig struct {
		Model string `json:"model"`
	} `json:"adapterConfig"`
	Instructions string `json:"instructions"`
}

func (b *agentInput) valid() bool {
	if b.Model == "" {
		b.Model = b.AdapterConfig.Model
	}
	return cleanName(b.Name) && len(b.Role) <= 200 && len(b.Title) <= 200 && len(b.Model) <= 200 && len(b.Instructions) <= 32000 && (b.AdapterType == "" || b.AdapterType == "pi")
}
func (a *App) listAgents(w http.ResponseWriter, r *http.Request) {
	a.tenantList(w, r, "agents")
}
func (a *App) getAgent(w http.ResponseWriter, r *http.Request) {
	v, e := oneJSON(r.Context(), a.db, "SELECT "+agentJSON+" FROM agents WHERE tenant_id=$1 AND id=$2 AND NOT internal", r.PathValue("tenantId"), r.PathValue("id"))
	a.replyOne(w, v, e, 200)
}
func (a *App) createAgent(w http.ResponseWriter, r *http.Request) {
	var b agentInput
	if !a.decode(w, r, &b) {
		return
	}
	if !b.valid() {
		fail(w, 400, "invalid_input", "Invalid Pi agent definition")
		return
	}
	a.mutateObject(w, r, "agent.created", randomID(), 201, func(tx pgx.Tx, id string) (json.RawMessage, error) {
		return oneJSON(r.Context(), tx, "INSERT INTO agents(id,tenant_id,name,role,title,model,instructions) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING "+agentJSON, id, r.PathValue("tenantId"), b.Name, b.Role, b.Title, b.Model, b.Instructions)
	})
}
func (a *App) updateAgent(w http.ResponseWriter, r *http.Request) {
	var b agentInput
	if !a.decode(w, r, &b) {
		return
	}
	if !b.valid() {
		fail(w, 400, "invalid_input", "Invalid Pi agent definition")
		return
	}
	a.mutateObject(w, r, "agent.updated", r.PathValue("id"), 200, func(tx pgx.Tx, id string) (json.RawMessage, error) {
		return oneJSON(r.Context(), tx, "UPDATE agents SET name=$3,role=$4,title=$5,model=$6,instructions=$7 WHERE tenant_id=$1 AND id=$2 AND NOT internal RETURNING "+agentJSON, r.PathValue("tenantId"), id, b.Name, b.Role, b.Title, b.Model, b.Instructions)
	})
}
func (a *App) agentInstructions(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Content string `json:"content"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if len(b.Content) > 32000 {
		fail(w, 400, "invalid_input", "Instructions exceed 32000 bytes")
		return
	}
	a.mutateObject(w, r, "agent.instructions.updated", r.PathValue("id"), 200, func(tx pgx.Tx, id string) (json.RawMessage, error) {
		return oneJSON(r.Context(), tx, "UPDATE agents SET instructions=$3 WHERE tenant_id=$1 AND id=$2 AND NOT internal RETURNING "+agentJSON, r.PathValue("tenantId"), id, b.Content)
	})
}
func (a *App) deleteAgent(w http.ResponseWriter, r *http.Request) {
	a.deleteObject(w, r, "agents", "agent.deleted")
}
func (a *App) mutateObject(w http.ResponseWriter, r *http.Request, action, id string, status int, f func(pgx.Tx, string) (json.RawMessage, error)) {
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, r.PathValue("tenantId"), 2); !ok {
		return
	}
	v, e := f(tx, id)
	if noRows(e) {
		fail(w, 404, "not_found", "Resource not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, r.PathValue("tenantId"), action, id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, status, v)
}
func (a *App) deleteObject(w http.ResponseWriter, r *http.Request, table, action string) {
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	var exists string
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	filter := ""
	if table == "agents" {
		filter = " AND NOT internal"
	}
	e = tx.QueryRow(r.Context(), "SELECT id FROM "+table+" WHERE tenant_id=$1 AND id=$2"+filter+" FOR UPDATE", tid, id).Scan(&exists)
	if noRows(e) {
		fail(w, 404, "not_found", "Resource not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	var busy bool
	sql := "SELECT EXISTS(SELECT 1 FROM node_sessions s JOIN runs r ON r.session_id=s.id WHERE s.tenant_id=$1 AND s.canvas_id=$2 AND r.status IN ('queued','running')) OR EXISTS(SELECT 1 FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 AND status IN ('queued','running'))"
	if table == "agents" {
		sql = "SELECT EXISTS(SELECT 1 FROM node_sessions WHERE tenant_id=$1 AND agent_id=$2)"
	}
	if e = tx.QueryRow(r.Context(), sql, tid, id).Scan(&busy); e != nil {
		a.dbError(w, e)
		return
	}
	if busy {
		fail(w, 409, "resource_in_use", "Resource has linked sessions or active runs")
		return
	}
	if _, e = tx.Exec(r.Context(), "DELETE FROM "+table+" WHERE tenant_id=$1 AND id=$2", tid, id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, action, id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}
func (a *App) listSessions(w http.ResponseWriter, r *http.Request) {
	a.tenantList(w, r, "sessions")
}
func (a *App) getSession(w http.ResponseWriter, r *http.Request) {
	v, e := oneJSON(r.Context(), a.db, "SELECT "+sessionJSON+" FROM node_sessions WHERE tenant_id=$1 AND id=$2", r.PathValue("tenantId"), r.PathValue("id"))
	a.replyOne(w, v, e, 200)
}
func (a *App) createSession(w http.ResponseWriter, r *http.Request) {
	var b struct {
		CanvasID string `json:"canvasId"`
		NodeID   string `json:"nodeId"`
		AgentID  string `json:"agentId"`
		Title    string `json:"title"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.CanvasID == "" || b.NodeID == "" || b.AgentID == "" || len(b.Title) > 200 {
		fail(w, 400, "invalid_input", "Canvas, node and agent are required")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	tid := r.PathValue("tenantId")
	var exists bool
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM canvases c JOIN agents a ON a.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2 AND a.id=$3 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) n WHERE n->>'id'=$4))", tid, b.CanvasID, b.AgentID, b.NodeID).Scan(&exists)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Canvas, node or agent not found in workspace")
		return
	}
	id := randomID()
	v, e := oneJSON(r.Context(), tx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title) VALUES($1,$2,$3,$4,$5,$6) RETURNING "+sessionJSON, id, tid, b.CanvasID, b.NodeID, b.AgentID, b.Title)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "session.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 201, v)
}
func (a *App) messages(w http.ResponseWriter, r *http.Request) {
	var exists bool
	e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM node_sessions WHERE tenant_id=$1 AND id=$2)", r.PathValue("tenantId"), r.PathValue("id")).Scan(&exists)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Session not found")
		return
	}
	v, e := rowsJSON(r.Context(), a.db, "SELECT jsonb_build_object('id',id,'sessionId',session_id,'role',role,'content',content,'runId',run_id,'createdAt',created_at) FROM messages WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at,id", r.PathValue("tenantId"), r.PathValue("id"))
	a.replyList(w, v, e)
}
