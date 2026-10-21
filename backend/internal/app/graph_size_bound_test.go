package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// sizedGraph is a document of one session node and count-1 form nodes, with edges wires from the first form node to the
// session node (only their number matters to the bound, which is read before any wire is checked).
func sizedGraph(t *testing.T, count, edges int) []byte {
	t.Helper()
	nodes := []any{map[string]any{"id": "worker", "kind": "session", "agentKind": "llm", "title": "Worker", "binding": map[string]string{"agentId": "a"}}}
	for i := 1; i < count; i++ {
		nodes = append(nodes, map[string]any{"id": fmt.Sprintf("form-%d", i), "kind": "form", "fields": []any{}})
	}
	wires := []any{}
	for i := 0; i < edges; i++ {
		wires = append(wires, map[string]any{"id": fmt.Sprintf("wire-%d", i), "fromNode": "form-1", "fromPort": "data", "toNode": "worker", "toPort": "context", "dataType": "text"})
	}
	raw, err := json.Marshal(map[string]any{"nodes": nodes, "edges": wires})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// A canvas holds up to 400 nodes (2026-10-21; it was 200): a graph run reads a 400-node document, and refuses one node
// more or one wire past 2000, saying the bound. A collaboration reads the same bound.
func TestGraphHoldsUpTo400Nodes(t *testing.T) {
	if maxGraphNodes != 400 || maxGraphEdges != 2000 {
		t.Fatal("the bound moved", maxGraphNodes, maxGraphEdges)
	}
	d, scope, err := parseGraph(sizedGraph(t, 400, 0), nil)
	if err != nil || len(d.Nodes) != 400 || len(scope) != 400 {
		t.Fatal("a 400-node canvas was not read whole", len(d.Nodes), len(scope), err)
	}
	if _, _, err := parseGraph(sizedGraph(t, 401, 0), nil); err == nil || err.Error() != "Graph requires 1–400 nodes and at most 2000 edges" {
		t.Fatal("a 401-node canvas was not refused with the bound", err)
	}
	if _, _, err := parseGraph(sizedGraph(t, 400, 2001), nil); err == nil || !strings.Contains(err.Error(), "at most 2000 edges") {
		t.Fatal("2001 wires were not refused", err)
	}
	policy := &collaborationPolicy{Goal: "Agree on one plan", Rounds: 1}
	if _, _, _, err := parseCollaborationGraph(sizedGraph(t, 401, 0), []string{"worker", "form-1"}, policy); err == nil || err.Error() != "Invalid collaboration canvas" {
		t.Fatal("a collaboration read a 401-node canvas", err)
	}
	// 400 nodes pass the bound: the refusal that follows is about the scope (a form node is no collaborator).
	if _, _, _, err := parseCollaborationGraph(sizedGraph(t, 400, 0), []string{"worker", "form-1"}, policy); err == nil || err.Error() != "Collaboration scope must contain distinct Session nodes" {
		t.Fatal("a collaboration refused a 400-node canvas by its size", err)
	}
}

// Admission hands each node's checks a document holding that node alone (savedNodeDocuments): every lookup reads the
// same node, in the same bytes, as from the whole canvas, a node listed twice keeping its first entry.
func TestSavedNodeDocumentsAnswerEveryLookupAsTheWholeCanvas(t *testing.T) {
	team, _ := json.Marshal(fixtureTeam("sequential"))
	raw := []byte(`{"version":3,"nodes":[
	 {"id":"clip","kind":"session","agentKind":"video","model":"rh.seedance-2-multimodal","mediaParams":{"duration":"6","ratio":"21:9"},"runtime":""},
	 {"id":"writer","kind":"session","agentKind":"llm","runtime":"pi","team":` + string(team) + `,
	  "taskFrame":{"version":1,"source":"manual","constraints":["Quote the script"],"acceptanceCriteria":["Checked by hand"]},
	  "skills":["builtin:research","builtin:summarize"]},
	 {"id":"editor","kind":"session","agentKind":"llm","runtime":"openai-agents","agentRef":{"source":"workspace","agentId":"agent-editor"}},
	 {"id":"brief","kind":"form","fields":[{"id":"f","label":"Goal","value":"a film"}]},
	 {"id":"clip","kind":"session","agentKind":"image","model":"rh.nano-banana-pro","mediaParams":{"resolution":"2k"}}
	],"edges":[{"id":"e","fromNode":"brief","fromPort":"data","toNode":"writer","toPort":"context","dataType":"text"}]}`)
	docs := savedNodeDocuments(raw)
	if len(docs) != 4 || savedNodeDocuments([]byte("not json")) != nil {
		t.Fatal("documents", len(docs))
	}
	if want := `{"nodes":[{"id":"clip","kind":"session","agentKind":"video","model":"rh.seedance-2-multimodal","mediaParams":{"duration":"6","ratio":"21:9"},"runtime":""}]}`; string(docs["clip"]) != want {
		t.Fatal("the first clip entry is not kept in its bytes", string(docs["clip"]))
	}
	answers := func(doc []byte, id string) string {
		kind, model, params, err := savedMediaNode(doc, id)
		team, teamErr := savedNodeTeam(doc, id)
		frame, frameErr := savedNodeTaskFrame(doc, id)
		skills, skillErr := savedNodeSkillRefs(doc, id)
		ref, refErr := savedWorkspaceAgentReference(doc, id)
		return fmt.Sprint(kind, model, string(params), err, team, teamErr, frame, frameErr, skills, skillErr, ref, refErr,
			savedRuntimeMatches(doc, id, "pi"), savedRuntimeMatches(doc, id, runtimeOpenAIAgents))
	}
	for _, id := range []string{"clip", "writer", "editor", "brief"} {
		if whole, alone := answers(raw, id), answers(docs[id], id); whole != alone {
			t.Errorf("%s: alone %q, whole %q", id, alone, whole)
		}
	}
	// The fixture carries real values for every lookup, so the comparison above is not nil against nil.
	if team, err := savedNodeTeam(docs["writer"], "writer"); err != nil || team == nil || len(team.Members) != 3 {
		t.Fatal("team", team, err)
	}
	if frame, err := savedNodeTaskFrame(docs["writer"], "writer"); err != nil || frame == nil {
		t.Fatal("task frame", frame, err)
	}
	if skills, err := savedNodeSkillRefs(docs["writer"], "writer"); err != nil || len(skills) != 2 {
		t.Fatal("skills", skills, err)
	}
	if ref, err := savedWorkspaceAgentReference(docs["editor"], "editor"); err != nil || ref == nil || ref.AgentID != "agent-editor" {
		t.Fatal("agent reference", ref, err)
	}
}

// Initialize reads a 400-node canvas and refuses 401 nodes, or a scope of 401 ids, saying the bound.
func TestPostgresInitializeHoldsUpTo400Nodes(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) { t.Error("unexpected model call") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "initialize-400@example.test")
	forms := func(count int) []any {
		nodes := []any{}
		for i := 0; i < count; i++ {
			nodes = append(nodes, map[string]any{"id": fmt.Sprintf("form-%d", i), "kind": "form", "fields": []any{}})
		}
		return nodes
	}
	doc := map[string]any{"nodes": forms(400), "edges": []any{}}
	cid := h.request(t, c, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Four hundred", "document": doc}, 201)["id"].(string)
	base := "/tenants/" + tid + "/canvases/" + cid
	h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 1}, 200)
	ids := []string{}
	for i := 0; i < 401; i++ {
		ids = append(ids, fmt.Sprintf("form-%d", i))
	}
	if got := h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 1, "scope": ids}, 400); errorCode(got) != "invalid_scope" ||
		!strings.Contains(fmt.Sprint(got["error"]), "1 to 400 distinct") {
		t.Fatal("a 401-id scope was not refused with the bound", got)
	}
	doc["nodes"] = forms(401)
	h.request(t, c, "PUT", base, map[string]any{"name": "Four hundred and one", "document": doc, "version": 1}, 200)
	if got := h.request(t, c, "POST", base+"/initialize", map[string]any{"documentVersion": 2}, 400); errorCode(got) != "invalid_document" ||
		!strings.Contains(fmt.Sprint(got["error"]), "at most 400 nodes") {
		t.Fatal("a 401-node canvas was not refused with the bound", got)
	}
	if agents, sessions := setupCounts(t, h, tid); agents != 0 || sessions != 0 {
		t.Fatal("initializing forms created resources", agents, sessions)
	}
}
