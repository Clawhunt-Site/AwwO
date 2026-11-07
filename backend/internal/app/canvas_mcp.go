package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"time"
)

// AwwO's MCP endpoint for agents on a canvas (docs/awwo-canvas-live-collaboration.md, Ports): POST /api/v1/mcp, MCP's
// Streamable HTTP transport answered with JSON, a canvas agent token as the bearer. Every tool goes through the same
// handlers a page's request does (in this process), so an agent is held to exactly the rules of the API: the fence of
// running nodes, the claims, what an agent may change, the checks of every write.

const (
	mcpLatestProtocol = "2025-11-25"
	// Below the hosted edge's 2 MB on /api/v1/mcp, so an agent is answered in JSON-RPC, never by the edge's 413.
	mcpMaxBody     = 1_900_000
	mcpWaitDefault = 20 * time.Second
	mcpWaitMax     = 25 * time.Second
	mcpTextExcerpt = 500
)

var mcpProtocols = map[string]bool{"2025-11-25": true, "2025-06-18": true, "2025-03-26": true, "2024-11-05": true}

const mcpInstructions = `You are on one AwwO canvas (多人同屏 / Multiplayer): people and other agents may be working on it at this very moment.
- Start with canvas_overview: the nodes (each an Agent session, a form, an assembly or an edit), the wires between them, who is here and which nodes are held.
- Before you change an existing node, take it with canvas_claim; a node you add with canvas_add_node is yours at once. A node someone else holds is refused "claimed": pick another, or ask in canvas_say.
- While AwwO runs a node, its place, size and result stay free; anything else of it is refused "node_running" until the run ends.
- A change answers results, one code per op it makes: ok, or claimed, node_running, forbidden (a rule of what an agent may change) or gone (what it names is no longer there). When one is refused, reasons says in one sentence per op what it would have changed, the rule and what to do instead: follow it rather than sending the same op again.
- A wire joins an output port of one node to an input port of another, of one type: canvas_connect names the ports.
- Call canvas_wait to see what others change and say, and canvas_set_status to tell them what you are doing.
- Put your work into a node with canvas_update_node {result}: it is shown as handed in by you, never as AwwO's engine's result. A message (a tool call) is at most 1.9 MB; a larger result goes by PATCH on the canvas's URL with the same token.
- You cannot run nodes, choose models or spend credits: ask a person in canvas_say.`

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// canvasMCPGet answers GET and DELETE on the endpoint: it offers no server stream and keeps no session.
func (a *App) canvasMCPGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "POST")
	fail(w, 405, "method_not_allowed", "POST JSON-RPC messages to this endpoint")
}

// canvasMCP answers one JSON-RPC message.
func (a *App) canvasMCP(w http.ResponseWriter, r *http.Request) {
	token, ok := bearerCanvasToken(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="awwo-canvas"`)
		fail(w, 401, "unauthorized", "A canvas agent token is required: Authorization: Bearer awwo_ct_...")
		return
	}
	ctx, ok := a.admitCanvasToken(w, r, token, 1, "mcp")
	if !ok {
		return
	}
	r = r.WithContext(ctx)
	raw, err := io.ReadAll(io.LimitReader(r.Body, mcpMaxBody+1))
	if err != nil || len(raw) > mcpMaxBody {
		mcpReply(w, nil, nil, &mcpError{-32600, "An MCP message is at most 1.9 MB: hand a larger result in with PATCH on the canvas's own URL (/api/v1/tenants/{tenantId}/canvases/{canvasId}, ops [{\"op\":\"set\",\"path\":[\"nodes\",<node id>,\"lastOutput\"],\"value\":{\"text\":...}}]) with the same token"})
		return
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		mcpReply(w, nil, nil, &mcpError{-32600, "Batches are not supported; send one message per request"})
		return
	}
	var req mcpRequest
	if json.Unmarshal(trimmed, &req) != nil || req.JSONRPC != "2.0" || req.Method == "" {
		mcpReply(w, nil, nil, &mcpError{-32700, "Not a JSON-RPC 2.0 message"})
		return
	}
	if len(req.ID) == 0 || string(req.ID) == "null" {
		w.WriteHeader(202) // a notification (notifications/initialized and the like) has no answer
		return
	}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := mcpLatestProtocol
		if mcpProtocols[p.ProtocolVersion] {
			version = p.ProtocolVersion
		}
		agent := agentOf(r)
		mcpReply(w, req.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "awwo-canvas", "title": "AwwO 多人同屏", "version": BuildRevision()},
			"instructions":    mcpInstructions + "\nYou are \"" + agent.Name + "\" (scope: " + agent.Scope + ").",
		}, nil)
	case "ping":
		mcpReply(w, req.ID, map[string]any{}, nil)
	case "tools/list":
		mcpReply(w, req.ID, map[string]any{"tools": mcpTools()}, nil)
	case "tools/call":
		var p struct {
			Name      string                     `json:"name"`
			Arguments map[string]json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(req.Params, &p) != nil || p.Name == "" {
			mcpReply(w, req.ID, nil, &mcpError{-32602, "tools/call needs a name and arguments"})
			return
		}
		result, failure := a.mcpTool(r, p.Name, p.Arguments)
		if failure != nil {
			mcpReply(w, req.ID, nil, failure)
			return
		}
		mcpReply(w, req.ID, result, nil)
	default:
		mcpReply(w, req.ID, nil, &mcpError{-32601, "Unknown method " + req.Method})
	}
}

func mcpReply(w http.ResponseWriter, id json.RawMessage, result any, failure *mcpError) {
	out := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage("null")}
	if len(id) > 0 {
		out["id"] = id
	}
	if failure != nil {
		out["error"] = failure
	} else {
		out["result"] = result
	}
	writeJSON(w, 200, out)
}

// mcpToolResult is a tool's answer: its JSON as text and as structured content; isError when the canvas refused it. The
// text is the JSON as a model reads it: a wire's id (n1:result->n2:context) and a path's placeholder (nodes/<id>) as
// written, never the Unicode escapes json.Marshal writes for < and > (meant for HTML).
func mcpToolResult(value any, isError bool) map[string]any {
	var text bytes.Buffer
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", " ")
	_ = encoder.Encode(value)
	return map[string]any{"content": []map[string]any{{"type": "text", "text": strings.TrimSuffix(text.String(), "\n")}}, "structuredContent": value, "isError": isError}
}

// mcpInvoke runs one of the API's handlers in this process, as the agent: same rules, same answers.
func (a *App) mcpInvoke(r *http.Request, method, path string, values map[string]string, body any, handler http.HandlerFunc) (int, map[string]any) {
	var reader io.Reader = http.NoBody
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader).WithContext(r.Context())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range values {
		req.SetPathValue(k, v)
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	out := map[string]any{}
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	return rec.Code, out
}

func mcpRandomID(prefix string) string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b)
}

// mcpArgs reads a tool's arguments.
type mcpArgs map[string]json.RawMessage

func (m mcpArgs) str(key string) (string, bool) {
	var s string
	raw, ok := m[key]
	return s, ok && json.Unmarshal(raw, &s) == nil
}
func (m mcpArgs) num(key string) (float64, bool) {
	var f float64
	raw, ok := m[key]
	return f, ok && json.Unmarshal(raw, &f) == nil
}
func (m mcpArgs) list(key string) ([]string, bool) {
	var l []string
	raw, ok := m[key]
	return l, ok && json.Unmarshal(raw, &l) == nil
}

// mcpCanvas is the canvas the agent's token reaches, as GET .../canvases/{id} answers it.
type mcpCanvas struct {
	Version  int64
	Name     string
	Document map[string]any
}

func (a *App) mcpRead(r *http.Request) (mcpCanvas, *mcpError) {
	agent := agentOf(r)
	code, out := a.mcpInvoke(r, "GET", "/api/v1/tenants/"+agent.TenantID+"/canvases/"+agent.CanvasID, map[string]string{"tenantId": agent.TenantID, "id": agent.CanvasID}, nil, a.getCanvas)
	if code != 200 {
		return mcpCanvas{}, &mcpError{-32603, fmt.Sprintf("The canvas cannot be read (%d)", code)}
	}
	raw, _ := json.Marshal(out["document"])
	doc, err := decodeCanvasDocument(raw)
	if err != nil {
		doc = map[string]any{}
	}
	version, _ := out["version"].(float64)
	name, _ := out["name"].(string)
	return mcpCanvas{Version: int64(version), Name: name, Document: doc}, nil
}

// mcpChange sends ops as the agent's change, on the canvas's current version.
func (a *App) mcpChange(r *http.Request, ops []canvasOp) (map[string]any, *mcpError) {
	canvas, failure := a.mcpRead(r)
	if failure != nil {
		return nil, failure
	}
	agent := agentOf(r)
	body := map[string]any{"baseVersion": canvas.Version, "changeId": mcpRandomID("mcp_"), "clientId": "t_" + agent.TokenID, "ops": ops}
	code, out := a.mcpInvoke(r, "PATCH", "/api/v1/tenants/"+agent.TenantID+"/canvases/"+agent.CanvasID, map[string]string{"tenantId": agent.TenantID, "id": agent.CanvasID}, body, a.patchCanvas)
	if code != 200 {
		return mcpToolResult(map[string]any{"refused": out}, true), nil
	}
	results, _ := out["results"].([]any)
	refused := false
	for _, result := range results {
		if result != "ok" {
			refused = true
		}
	}
	answer := map[string]any{"version": out["version"], "results": results}
	if reasons, ok := out["reasons"]; ok {
		answer["reasons"] = reasons
	}
	return mcpToolResult(answer, refused), nil
}

// mcpTool runs one tool.
func (a *App) mcpTool(r *http.Request, name string, args mcpArgs) (map[string]any, *mcpError) {
	agent := agentOf(r)
	values := map[string]string{"tenantId": agent.TenantID, "id": agent.CanvasID}
	base := "/api/v1/tenants/" + agent.TenantID + "/canvases/" + agent.CanvasID
	switch name {
	case "canvas_overview":
		canvas, failure := a.mcpRead(r)
		if failure != nil {
			return nil, failure
		}
		return mcpToolResult(a.mcpOverview(r, canvas), false), nil
	case "canvas_read_node":
		id, _ := args.str("nodeId")
		canvas, failure := a.mcpRead(r)
		if failure != nil {
			return nil, failure
		}
		i := findRecord(collectionOf(canvas.Document, "nodes"), "id", id)
		if i < 0 {
			return mcpToolResult(map[string]any{"error": "No node " + id}, true), nil
		}
		return mcpToolResult(map[string]any{"version": canvas.Version, "node": collectionOf(canvas.Document, "nodes")[i]}, false), nil
	case "canvas_wait":
		return a.mcpWait(r, args)
	case "canvas_add_node":
		kind, _ := args.str("kind")
		if kind == "" {
			kind = "session"
		}
		canvas, failure := a.mcpRead(r)
		if failure != nil {
			return nil, failure
		}
		id := mcpRandomID("agent-")
		node := map[string]any{"id": id, "kind": kind}
		x, y := freePlace(canvas.Document)
		if v, ok := args.num("x"); ok {
			x = v
		}
		if v, ok := args.num("y"); ok {
			y = v
		}
		node["x"], node["y"] = x, y
		if title, ok := args.str("title"); ok {
			node["title"] = title
		}
		if persona, ok := args.str("persona"); ok && kind == "session" {
			node["persona"] = persona
		}
		if kind == "form" {
			if fields, ok := mcpFormFields(args); ok {
				node["fields"] = fields
			}
		}
		ops := []canvasOp{{Op: canvasOpSet, Path: []string{"nodes", id}, Value: mustCanvasJSON(node)}}
		if result, ok := args.str("result"); ok && result != "" {
			ops = append(ops, canvasOp{Op: canvasOpSet, Path: []string{"nodes", id, "lastOutput"}, Value: mustCanvasJSON(map[string]string{"text": result})})
		}
		out, failure := a.mcpChange(r, ops)
		if failure == nil {
			out["structuredContent"].(map[string]any)["nodeId"] = id
			out = mcpToolResult(out["structuredContent"], out["isError"].(bool))
		}
		return out, failure
	case "canvas_update_node":
		id, _ := args.str("nodeId")
		if id == "" {
			return mcpToolResult(map[string]any{"error": "nodeId is required"}, true), nil
		}
		ops := []canvasOp{}
		for _, key := range []string{"title", "persona", "template", "fileName", "timeline"} {
			if v, ok := args.str(key); ok {
				ops = append(ops, canvasOp{Op: canvasOpSet, Path: []string{"nodes", id, key}, Value: mustCanvasJSON(v)})
			}
		}
		for _, key := range []string{"x", "y", "w", "h"} {
			if v, ok := args.num(key); ok {
				ops = append(ops, canvasOp{Op: canvasOpSet, Path: []string{"nodes", id, key}, Value: mustCanvasJSON(v)})
			}
		}
		if fields, ok := mcpFormFields(args); ok {
			ops = append(ops, canvasOp{Op: canvasOpSet, Path: []string{"nodes", id, "fields"}, Value: mustCanvasJSON(fields)})
		}
		if result, ok := args.str("result"); ok {
			if result == "" {
				ops = append(ops, canvasOp{Op: canvasOpDel, Path: []string{"nodes", id, "lastOutput"}})
			} else {
				ops = append(ops, canvasOp{Op: canvasOpSet, Path: []string{"nodes", id, "lastOutput"}, Value: mustCanvasJSON(map[string]string{"text": result})})
			}
		}
		if len(ops) == 0 {
			return mcpToolResult(map[string]any{"error": "Nothing to change"}, true), nil
		}
		return a.mcpChange(r, ops)
	case "canvas_delete_node":
		id, _ := args.str("nodeId")
		return a.mcpChange(r, []canvasOp{{Op: canvasOpDel, Path: []string{"nodes", id}}})
	case "canvas_connect":
		from, _ := args.str("fromNodeId")
		to, _ := args.str("toNodeId")
		canvas, failure := a.mcpRead(r)
		if failure != nil {
			return nil, failure
		}
		fromPort, ok := args.str("fromPort")
		if !ok || fromPort == "" {
			fromPort = defaultOutputPort(canvas.Document, from)
		}
		toPort, ok := args.str("toPort")
		if !ok || toPort == "" {
			toPort = defaultInputPort(canvas.Document, to)
		}
		edge := map[string]string{"id": from + ":" + fromPort + "->" + to + ":" + toPort, "fromNode": from, "fromPort": fromPort, "toNode": to, "toPort": toPort}
		// Connecting only adds: a wire with this id already on the canvas is left as it is, judged in the change itself
		// under the canvas's lock (canvasAddOnlyWires), so a wire saved between this read and the write is safe too.
		r = r.WithContext(context.WithValue(r.Context(), canvasAddOnlyWires{}, true))
		return a.mcpChange(r, []canvasOp{{Op: canvasOpSet, Path: []string{"edges", edge["id"]}, Value: mustCanvasJSON(edge)}})
	case "canvas_disconnect":
		canvas, failure := a.mcpRead(r)
		if failure != nil {
			return nil, failure
		}
		edgeID, _ := args.str("edgeId")
		from, _ := args.str("fromNodeId")
		to, _ := args.str("toNodeId")
		ops := []canvasOp{}
		for _, e := range collectionOf(canvas.Document, "edges") {
			edge, _ := e.(map[string]any)
			id, _ := edge["id"].(string)
			if (edgeID != "" && id == edgeID) || (edgeID == "" && from != "" && to != "" && edge["fromNode"] == from && edge["toNode"] == to) {
				ops = append(ops, canvasOp{Op: canvasOpDel, Path: []string{"edges", id}})
			}
		}
		if len(ops) == 0 {
			return mcpToolResult(map[string]any{"error": "No such wire"}, true), nil
		}
		return a.mcpChange(r, ops)
	case "canvas_claim":
		ids, _ := args.list("nodeIds")
		body := map[string]any{"clientId": "t_" + agent.TokenID, "nodeIds": ids}
		if seconds, ok := args.num("seconds"); ok {
			body["ttlSeconds"] = seconds
		}
		if note, ok := args.str("note"); ok {
			body["note"] = note
		}
		code, out := a.mcpInvoke(r, "POST", base+"/live/claims", values, body, a.canvasLiveClaim)
		refused, _ := out["refused"].([]any)
		return mcpToolResult(out, code != 200 || len(refused) > 0), nil
	case "canvas_release":
		ids, _ := args.list("nodeIds")
		code, out := a.mcpInvoke(r, "DELETE", base+"/live/claims", values, map[string]any{"clientId": "t_" + agent.TokenID, "nodeIds": ids}, a.canvasLiveRelease)
		return mcpToolResult(out, code != 200), nil
	case "canvas_set_status":
		state := map[string]any{}
		if status, ok := args.str("status"); ok {
			state["status"] = status
		}
		if focus, ok := args.str("focusNodeId"); ok {
			if focus == "" {
				state["focus"] = nil
			} else {
				state["focus"] = focus
			}
		}
		if selection, ok := args.list("selection"); ok {
			state["selection"] = selection
		}
		code, out := a.mcpInvoke(r, "POST", base+"/live/presence", values, map[string]any{"clientId": "t_" + agent.TokenID, "state": state}, a.canvasLivePresence)
		if code == 204 {
			out = map[string]any{"ok": true}
		}
		return mcpToolResult(out, code != 204), nil
	case "canvas_say":
		text, _ := args.str("text")
		body := map[string]any{"clientId": "t_" + agent.TokenID, "text": text}
		if node, ok := args.str("nodeId"); ok {
			body["nodeId"] = node
		}
		code, out := a.mcpInvoke(r, "POST", base+"/live/messages", values, body, a.canvasLiveSay)
		return mcpToolResult(out, code != 200), nil
	case "canvas_messages":
		path := base + "/live/messages"
		if before, ok := args.str("before"); ok && before != "" {
			if !liveMessageIDPattern.MatchString(before) {
				return mcpToolResult(map[string]any{"error": "before is the id of a message"}, true), nil
			}
			path += "?" + url.Values{"before": {before}}.Encode()
		}
		code, out := a.mcpInvoke(r, "GET", path, values, nil, a.canvasLiveMessages)
		return mcpToolResult(out, code != 200), nil
	case "canvas_apply":
		var ops []canvasOp
		if raw, ok := args["ops"]; !ok || json.Unmarshal(raw, &ops) != nil || len(ops) == 0 {
			return mcpToolResult(map[string]any{"error": "ops is a list of {op, path, value?, ids?}"}, true), nil
		}
		return a.mcpChange(r, ops)
	}
	return nil, &mcpError{-32602, "Unknown tool " + name}
}

func mcpFormFields(args mcpArgs) ([]map[string]string, bool) {
	raw, ok := args["fields"]
	if !ok {
		return nil, false
	}
	var given []struct {
		ID    string `json:"id"`
		Label string `json:"label"`
		Value string `json:"value"`
	}
	if json.Unmarshal(raw, &given) != nil {
		return nil, false
	}
	out := make([]map[string]string, 0, len(given))
	for _, f := range given {
		id := f.ID
		if id == "" {
			id = mcpRandomID("f")
		}
		out = append(out, map[string]string{"id": id, "label": f.Label, "value": f.Value})
	}
	return out, true
}

// freePlace is a spot to the right of everything on the canvas, where a new node covers none.
func freePlace(doc map[string]any) (float64, float64) {
	right, top, seen := 0.0, 0.0, false
	for _, n := range collectionOf(doc, "nodes") {
		node, ok := n.(map[string]any)
		if !ok {
			continue
		}
		x, _ := toFloat(node["x"])
		y, _ := toFloat(node["y"])
		w, _ := toFloat(node["w"])
		if w <= 0 {
			w = 340
		}
		if !seen || x+w > right {
			right = x + w
		}
		if !seen || y < top {
			top = y
		}
		seen = true
	}
	if !seen {
		return 0, 0
	}
	return right + 80, top
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	}
	return 0, false
}

func nodeOf(doc map[string]any, id string) graphNode {
	nodes := collectionOf(doc, "nodes")
	var n graphNode
	if i := findRecord(nodes, "id", id); i >= 0 {
		_ = json.Unmarshal(mustCanvasJSON(nodes[i]), &n)
	}
	return n
}

// defaultOutputPort and defaultInputPort are the ports a wire uses when an agent names none (ports.ts portsFor).
func defaultOutputPort(doc map[string]any, id string) string {
	n := nodeOf(doc, id)
	switch {
	case n.Kind == "form":
		return "data"
	case n.Contract != nil && len(n.Contract.Outputs) > 0:
		return "out:" + n.Contract.Outputs[0].ID
	}
	return "result"
}

func defaultInputPort(doc map[string]any, id string) string {
	n := nodeOf(doc, id)
	switch {
	case n.Kind == "edit":
		return "timeline"
	case n.Contract != nil && len(n.Contract.Inputs) > 0:
		return "in:" + n.Contract.Inputs[0].ID
	}
	return "context"
}

func excerpt(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// mcpOverview summarises the canvas for an agent.
func (a *App) mcpOverview(r *http.Request, canvas mcpCanvas) map[string]any {
	agent := agentOf(r)
	ctx := r.Context()
	claims, _ := listCanvasClaims(ctx, a.db, agent.TenantID, agent.CanvasID)
	holder := map[string]string{}
	for _, c := range claims {
		holder[c.NodeID] = c.Name + " (" + c.ParticipantID + ")"
	}
	awwo, _ := liveAwwoAgents(ctx, a.db, agent.TenantID, agent.CanvasID)
	running := map[string]bool{}
	for _, p := range awwo {
		if p.State.Focus != nil {
			running[*p.State.Focus] = true
		}
	}
	nodes := []map[string]any{}
	for _, raw := range collectionOf(canvas.Document, "nodes") {
		node, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		out := map[string]any{}
		for _, key := range []string{"id", "kind", "title", "x", "y", "w", "h", "agentKind", "model", "runtime"} {
			if v, ok := node[key]; ok && v != "" {
				out[key] = v
			}
		}
		if persona, ok := node["persona"].(string); ok && persona != "" {
			out["persona"] = excerpt(persona, mcpTextExcerpt)
		}
		for _, key := range []string{"template", "timeline"} {
			if text, ok := node[key].(string); ok && text != "" {
				out[key] = excerpt(text, mcpTextExcerpt)
			}
		}
		if fields, ok := node["fields"].([]any); ok {
			out["fields"] = fields
		}
		if output, ok := node["lastOutput"].(map[string]any); ok {
			text, _ := output["text"].(string)
			out["result"] = map[string]any{"source": output["source"], "chars": len([]rune(text)), "start": excerpt(text, mcpTextExcerpt), "by": output["by"]}
		}
		id, _ := node["id"].(string)
		if running[id] {
			out["running"] = true
		}
		if h := holder[id]; h != "" {
			out["heldBy"] = h
		}
		nodes = append(nodes, out)
	}
	edges := []map[string]any{}
	for _, raw := range collectionOf(canvas.Document, "edges") {
		if edge, ok := raw.(map[string]any); ok {
			edges = append(edges, map[string]any{"id": edge["id"], "from": edge["fromNode"], "fromPort": edge["fromPort"], "to": edge["toNode"], "toPort": edge["toPort"], "dataType": edge["dataType"]})
		}
	}
	participants := []map[string]any{}
	for _, p := range append(a.multiplayer.participants(agent.TenantID, agent.CanvasID), awwo...) {
		participants = append(participants, map[string]any{"id": p.ID, "name": p.Name, "kind": p.Kind, "port": p.Port, "status": p.State.Status, "focus": p.State.Focus, "selection": p.State.Selection})
	}
	sort.SliceStable(nodes, func(i, j int) bool {
		yi, _ := toFloat(nodes[i]["y"])
		yj, _ := toFloat(nodes[j]["y"])
		return yi < yj
	})
	return map[string]any{"canvas": canvas.Name, "version": canvas.Version, "you": map[string]any{"id": "t_" + agent.TokenID, "name": agent.Name, "scope": agent.Scope},
		"nodes": nodes, "edges": edges, "participants": participants, "claims": claims}
}

// mcpWait waits for someone else to change the canvas, say something or take or give back a claim, after a version;
// at most 25 s. What the agent did itself does not end the wait (it knows), but the answer lists its own changes too,
// so the version it gives back covers everything up to it.
func (a *App) mcpWait(r *http.Request, args mcpArgs) (map[string]any, *mcpError) {
	agent := agentOf(r)
	ctx := r.Context()
	self := "t_" + agent.TokenID
	after := int64(-1)
	if v, ok := args.num("afterVersion"); ok {
		after = int64(v)
	}
	wait := mcpWaitDefault
	if s, ok := args.num("seconds"); ok && s >= 0 {
		wait = time.Duration(s * float64(time.Second))
	}
	if wait > mcpWaitMax {
		wait = mcpWaitMax
	}
	a.multiplayer.touch(agent.TenantID, agent.CanvasID, liveJoin{actor: canvasActorOf(r, "")})
	stream, stop := a.multiplayer.watch(agent.TenantID, agent.CanvasID, agent.TokenID)
	defer stop()
	// Who else holds what: the agent's own claims coming and going are no news to it.
	othersClaims := func() string {
		claims, err := activeCanvasClaims(ctx, a.db, agent.TenantID, agent.CanvasID)
		if err != nil {
			return "?"
		}
		held := []string{}
		for node, c := range claims {
			if c.participant != self {
				held = append(held, node+"="+c.participant)
			}
		}
		sort.Strings(held)
		return strings.Join(held, ",")
	}
	claimsAtStart := othersClaims()
	closing := a.multiplayer.closed()
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	messages := []any{}
	claimsChanged, timedOut := false, false
	// checked is the newest version known to hold nothing but the agent's own changes since after.
	checked := after
	for {
		var version int64
		if err := a.db.QueryRow(ctx, "SELECT version FROM canvases WHERE tenant_id=$1 AND id=$2", agent.TenantID, agent.CanvasID).Scan(&version); err != nil {
			return nil, &mcpError{-32603, "The canvas cannot be read"}
		}
		if after < 0 {
			after, checked = version, version
		}
		others := len(messages) > 0 || claimsChanged
		var changes []canvasChangeOut
		reset := false
		if version > checked || ((others || timedOut) && version > after) {
			var err error
			if changes, reset, err = canvasChangesAfter(ctx, a.db, agent.TenantID, agent.CanvasID, after, version); err != nil {
				return nil, &mcpError{-32603, "The changes cannot be read"}
			}
			for _, c := range changes {
				others = others || c.Actor.TokenID != agent.TokenID
			}
			others, checked = others || reset, version
		}
		if others || timedOut {
			// What it says came after the wait began: the token must still be live to be told.
			if allowed, err := a.liveAccess(r, agent.TenantID, agent.CanvasID); err != nil {
				return mcpToolResult(map[string]any{"error": "The canvas could not be checked; call canvas_wait again"}, true), nil
			} else if !allowed {
				return mcpToolResult(map[string]any{"error": "This token no longer reaches the canvas"}, true), nil
			}
			out := map[string]any{"version": version, "changes": []any{}, "messages": messages}
			if reset {
				out["reset"] = true
				out["note"] = "Too much changed to list: read the canvas again with canvas_overview"
			} else if len(changes) > 0 {
				out["changes"] = mcpChangeLines(changes)
			}
			if claimsChanged {
				claims, _ := listCanvasClaims(ctx, a.db, agent.TenantID, agent.CanvasID)
				out["claims"] = claims
			}
			if !others {
				out["note"] = "Nothing from anyone else yet; call canvas_wait again with this version"
			}
			return mcpToolResult(out, false), nil
		}
		select {
		case <-ctx.Done():
			return nil, &mcpError{-32603, "Cancelled"}
		case <-closing:
			// The API stops (a release): no wait holds it up.
			return mcpToolResult(map[string]any{"restart": true, "error": "AwwO is restarting; call canvas_wait again in a few seconds"}, true), nil
		case <-deadline.C:
			timedOut = true
		case <-stream.wake:
			if reason := a.multiplayer.takeBye(stream); reason != "" {
				return mcpToolResult(map[string]any{"error": "The wait ended: " + reason}, true), nil
			}
		case event := <-stream.events:
			if event.name == "bye" {
				data, _ := event.data.(map[string]any)
				reason, _ := data["reason"].(string)
				return mcpToolResult(map[string]any{"error": "The wait ended: " + reason}, true), nil
			}
			if event.name == "message" {
				if data, ok := event.data.(map[string]any); ok {
					if said, ok := data["message"].(liveMessage); !ok || said.ParticipantID != self {
						messages = append(messages, data["message"])
					}
				}
			}
			if event.name == "claims" && othersClaims() != claimsAtStart {
				claimsChanged = true
			}
		}
	}
}

// mcpChangeLines describes changes for an agent: who, what, and each op in one line (long values cut).
func mcpChangeLines(changes []canvasChangeOut) []map[string]any {
	out := []map[string]any{}
	for _, c := range changes {
		var ops []canvasOp
		_ = json.Unmarshal(c.Ops, &ops)
		lines := []string{}
		for i, op := range ops {
			if i == 40 {
				lines = append(lines, fmt.Sprintf("… and %d more", len(ops)-40))
				break
			}
			line := op.Op + " " + strings.Join(op.Path, "/")
			if op.Op == canvasOpSet {
				line += " = " + excerpt(string(op.Value), 200)
			}
			if op.Op == canvasOpOrder {
				line += " " + strings.Join(op.IDs, ",")
			}
			lines = append(lines, line)
		}
		out = append(out, map[string]any{"version": c.Version, "by": c.Actor.Name, "kind": c.Actor.Kind, "label": c.Label, "ops": lines})
	}
	return out
}

func mcpTools() []map[string]any {
	str := map[string]any{"type": "string"}
	num := map[string]any{"type": "number"}
	ids := map[string]any{"type": "array", "items": str}
	obj := func(props map[string]any, required ...string) map[string]any {
		s := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
		if len(required) > 0 {
			s["required"] = required
		}
		return s
	}
	fields := map[string]any{"type": "array", "items": obj(map[string]any{"id": str, "label": str, "value": str}, "label")}
	// MCP's tool annotations, the hints a client weighs when it decides what to ask a person before a call (docs, Ports):
	// a read changes nothing; a destructive tool can lose what someone made (a node, a wire, a field's or a result's
	// earlier text), where the others only add or touch the caller's own claims, status and messages (the server's own
	// retention, the change log's and the 200 messages kept, is no update of the caller's); an idempotent call changes
	// nothing more when repeated with the same arguments (any other write renews the writer's claim, adds again or stamps
	// its result anew); and every tool works on this one canvas alone, a closed world.
	type hints struct{ readOnly, destructive, idempotent bool }
	read := hints{readOnly: true, idempotent: true}
	tool := func(name, title, description string, h hints, schema map[string]any) map[string]any {
		return map[string]any{"name": name, "title": title, "description": description, "inputSchema": schema, "annotations": map[string]any{
			"title": title, "readOnlyHint": h.readOnly, "destructiveHint": h.destructive, "idempotentHint": h.idempotent, "openWorldHint": false}}
	}
	const refusals = " A refused op says why: its code in results, and in reasons one sentence naming the rule and what to do instead."
	return []map[string]any{
		tool("canvas_overview", "Canvas overview", "The canvas now: its nodes (kind, title, place, a brief, the start of each result, who holds it, whether AwwO runs it), its wires, who is here, the claims, and its version.", read, obj(map[string]any{})),
		tool("canvas_read_node", "Read a node", "One node of the canvas in full (a contract's inputs and outputs are its ports in:<field id> and out:<field id>).", read, obj(map[string]any{"nodeId": str}, "nodeId")),
		tool("canvas_wait", "Wait for others", "Waits up to 25 seconds for someone else to change the canvas after afterVersion, send a live message or take or give back a claim, and says what happened (your own changes since afterVersion are listed too, but do not end the wait). Call it again with the version it gives.", read, obj(map[string]any{"afterVersion": num, "seconds": num})),
		tool("canvas_add_node", "Add a node", "Adds an Agent session node (kind session: a person picks its model before it runs) or a form (kind form, with fields), held by you at once. Optionally with a result you wrote."+refusals, hints{}, obj(map[string]any{"kind": map[string]any{"type": "string", "enum": []string{"session", "form"}}, "title": str, "persona": str, "x": num, "y": num, "fields": fields, "result": str})),
		tool("canvas_update_node", "Change a node", "Sets fields of a node you hold or nobody holds: title (at most 200 bytes), persona (a session's instructions), place and size (w and h at least 40), a form's fields (ids of ASCII letters, digits, _ . : -), an assembly's template, an edit's timeline, or result (your work, shown as handed in by you; empty clears it). A call is at most 1.9 MB."+refusals, hints{destructive: true}, obj(map[string]any{"nodeId": str, "title": str, "persona": str, "x": num, "y": num, "w": num, "h": num, "fields": fields, "template": str, "fileName": str, "timeline": str, "result": str}, "nodeId")),
		tool("canvas_delete_node", "Delete a node", "Deletes a node you hold or nobody holds, with its wires."+refusals, hints{destructive: true, idempotent: true}, obj(map[string]any{"nodeId": str}, "nodeId")),
		tool("canvas_connect", "Connect two nodes", "Wires an output port of one node into an input port of another, checked against their ports and types. Outputs: a form's data; a session's or an edit's result; out:<field id> of a node with a contract. Inputs: a session's context; reference (a picture) of an image, video or 3D session; audio of a video session; in:<field id> of a node with a contract; an edit's timeline, clips, sounds and pictures. Left out, the ports are the node's first output and the other's first input (a session's context). An output feeds an input of its own type, and an image, video, audio or 3D result also a text input. An input takes one wire, except context, a video's reference and audio, and an edit's clips, sounds and pictures. A wire already there is left as it is, and one whose id another wire has is refused."+refusals, hints{idempotent: true}, obj(map[string]any{"fromNodeId": str, "toNodeId": str, "fromPort": str, "toPort": str}, "fromNodeId", "toNodeId")),
		tool("canvas_disconnect", "Remove a wire", "Removes a wire, by its id or by the two nodes it joins."+refusals, hints{destructive: true, idempotent: true}, obj(map[string]any{"edgeId": str, "fromNodeId": str, "toNodeId": str})),
		tool("canvas_claim", "Take nodes", "Holds nodes for you for a while (15 to 600 seconds, 120 by default; claim again to renew), so other agents leave them to you. People still can edit them. refused lists the nodes someone else holds (with who, their note and until when), missing the nodes not on the canvas.", hints{}, obj(map[string]any{"nodeIds": ids, "seconds": num, "note": str}, "nodeIds")),
		tool("canvas_release", "Let go of nodes", "Lets go of the nodes named, or of all you hold.", hints{idempotent: true}, obj(map[string]any{"nodeIds": ids})),
		tool("canvas_set_status", "Say what you do", "Your one-line status (at most 140 characters), the node you work in and the nodes you look at, shown to everyone on the canvas.", hints{idempotent: true}, obj(map[string]any{"status": str, "focusNodeId": str, "selection": ids})),
		tool("canvas_say", "Write a message", "Writes one line to everyone on the canvas, optionally about a node.", hints{}, obj(map[string]any{"text": str, "nodeId": str}, "text")),
		tool("canvas_messages", "Read messages", "The canvas's live messages, the newest first, 50 at a time (before: a message id to read older ones).", read, obj(map[string]any{"before": str})),
		tool("canvas_apply", "Apply raw ops", "Applies ops of the canvas change format (docs: set/del/order on paths such as [\"nodes\", id, \"title\"]), with the same rules as the other tools."+refusals, hints{destructive: true}, obj(map[string]any{"ops": map[string]any{"type": "array", "items": map[string]any{"type": "object"}}}, "ops")),
	}
}
