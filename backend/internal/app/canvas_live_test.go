package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode"
)

// 多人同屏 against PostgreSQL (docs/awwo-canvas-live-collaboration.md): changes from several writers, the save rules, the
// fence of running nodes, canvas agent tokens and their rules, the live stream and the MCP endpoint.

func liveCanvasDocument() map[string]any {
	session := func(id, title string, x float64) map[string]any {
		return map[string]any{"id": id, "kind": "session", "agentKind": "llm", "runtime": "", "model": "", "effort": "", "persona": "",
			"binding": nil, "bindAttempt": nil, "issueId": nil, "preview": "", "title": title, "x": x, "y": 0, "w": 340, "h": 260}
	}
	return map[string]any{"version": 2, "updatedAt": 1, "nodes": []any{session("n1", "Plan", 0), session("n2", "Build", 400),
		map[string]any{"id": "f1", "kind": "form", "title": "Brief", "x": -400, "y": 0, "w": 300, "h": 200, "fields": []any{map[string]any{"id": "q", "label": "Goal", "value": ""}}}},
		"edges":     []any{map[string]any{"id": "n1:result->n2:context", "fromNode": "n1", "fromPort": "result", "toNode": "n2", "toPort": "context", "dataType": "text"}},
		"waypoints": []any{}, "view": nil}
}

// liveTeam is a workspace with a canvas and two people on it: its owner and a member.
type liveTeam struct {
	h                *harness
	owner, member    *http.Cookie
	tid, cid, prefix string
	memberID         string
}

func newLiveTeam(t *testing.T, before ...func(*App)) liveTeam {
	t.Helper()
	h := newHarness(t, "http://127.0.0.1:1", before...)
	owner, tid, _ := h.register(t, "live-owner@example.test")
	member, _, memberID := h.register(t, "live-member@example.test")
	h.request(t, owner, "POST", "/tenants/"+tid+"/members", map[string]string{"email": "live-member@example.test", "role": "member"}, 201)
	cv := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Live", "document": liveCanvasDocument()}, 201)
	cid := cv["id"].(string)
	return liveTeam{h: h, owner: owner, member: member, tid: tid, cid: cid, prefix: "/tenants/" + tid + "/canvases/" + cid, memberID: memberID}
}

func (lt liveTeam) patch(t *testing.T, who *http.Cookie, base float64, ops []map[string]any, status int, extra ...map[string]any) map[string]any {
	t.Helper()
	body := map[string]any{"baseVersion": base, "clientId": "page-" + fmt.Sprint(who.Value[:6]), "ops": ops}
	for _, e := range extra {
		for k, v := range e {
			body[k] = v
		}
	}
	return lt.h.request(t, who, "PATCH", lt.prefix, body, status)
}

func (lt liveTeam) document(t *testing.T) (map[string]any, float64) {
	t.Helper()
	cv := lt.h.request(t, lt.owner, "GET", lt.prefix, nil, 200)
	return cv["document"].(map[string]any), cv["version"].(float64)
}

func liveNode(doc map[string]any, id string) map[string]any {
	for _, n := range doc["nodes"].([]any) {
		if node := n.(map[string]any); node["id"] == id {
			return node
		}
	}
	return nil
}

func set(path []string, value any) map[string]any {
	return map[string]any{"op": "set", "path": path, "value": value}
}
func del(path []string) map[string]any { return map[string]any{"op": "del", "path": path} }

func TestPostgresCanvasChangesMergeWritersInServerOrder(t *testing.T) {
	lt := newLiveTeam(t)
	// The owner's change from version 1.
	out := lt.patch(t, lt.owner, 1, []map[string]any{set([]string{"nodes", "n1", "title"}, "Plan A")}, 200)
	if out["version"] != 2.0 || fmt.Sprint(out["results"]) != "[ok]" || len(out["changes"].([]any)) != 1 {
		t.Fatalf("first change: %v", out)
	}
	// The member's change, also from version 1: it applies to version 2 and is answered with both changes.
	out = lt.patch(t, lt.member, 1, []map[string]any{set([]string{"nodes", "n2", "persona"}, "Write the API")}, 200)
	changes := out["changes"].([]any)
	if out["version"] != 3.0 || len(changes) != 2 || changes[0].(map[string]any)["version"] != 2.0 || changes[1].(map[string]any)["version"] != 3.0 {
		t.Fatalf("second change: %v", out)
	}
	if actor := changes[0].(map[string]any)["actor"].(map[string]any); actor["kind"] != "human" || actor["name"] != "Test" {
		t.Fatalf("actor: %v", actor)
	}
	doc, version := lt.document(t)
	if liveNode(doc, "n1")["title"] != "Plan A" || liveNode(doc, "n2")["persona"] != "Write the API" || version != 3 {
		t.Fatalf("both edits kept: %v", doc)
	}
	// The same field from a stale base: the later change at the server stays.
	lt.patch(t, lt.member, 1, []map[string]any{set([]string{"nodes", "n1", "title"}, "Plan B")}, 200)
	doc, _ = lt.document(t)
	if liveNode(doc, "n1")["title"] != "Plan B" {
		t.Fatal("the later write did not win")
	}
	// A field of a node that is gone does nothing; deleting a node takes its wires.
	out = lt.patch(t, lt.owner, 4, []map[string]any{del([]string{"nodes", "n1"}), set([]string{"nodes", "n1", "title"}, "late")}, 200)
	if fmt.Sprint(out["results"]) != "[ok gone]" {
		t.Fatalf("results: %v", out["results"])
	}
	last := out["changes"].([]any)[0].(map[string]any)
	if !strings.Contains(fmt.Sprint(last["ops"]), "n1:result->n2:context") {
		t.Fatalf("the wire's removal is in the change: %v", last["ops"])
	}
	doc, version = lt.document(t)
	if len(doc["edges"].([]any)) != 0 || liveNode(doc, "n1") != nil || version != 5 {
		t.Fatalf("after the deletion: %v", doc)
	}
	// The log: every change after a version; a version before the log's first is read as the document.
	log := lt.h.request(t, lt.owner, "GET", lt.prefix+"/changes?after=2", nil, 200)
	if len(log["changes"].([]any)) != 3 || log["version"] != 5.0 {
		t.Fatalf("log: %v", log)
	}
	if reset := lt.h.request(t, lt.owner, "GET", lt.prefix+"/changes?after=0", nil, 200); reset["reset"] != true || reset["document"] == nil {
		t.Fatalf("reset: %v", reset)
	}
	if none := lt.h.request(t, lt.owner, "GET", lt.prefix+"/changes?after=5", nil, 200); len(none["changes"].([]any)) != 0 {
		t.Fatalf("nothing after the current version: %v", none)
	}
	// A whole-document save keeps its compare-and-swap (AWWO-LAW-026) and is logged as a change.
	doc["nodes"].([]any)[0].(map[string]any)["title"] = "Saved whole"
	lt.h.request(t, lt.owner, "PUT", lt.prefix, map[string]any{"name": "Live", "document": doc, "version": 4}, 409)
	lt.h.request(t, lt.owner, "PUT", lt.prefix, map[string]any{"name": "Live", "document": doc, "version": 5}, 200)
	saved := lt.h.request(t, lt.owner, "GET", lt.prefix+"/changes?after=5", nil, 200)["changes"].([]any)
	if len(saved) != 1 || saved[0].(map[string]any)["label"] != "save" || !strings.Contains(fmt.Sprint(saved[0].(map[string]any)["ops"]), "Saved whole") {
		t.Fatalf("the save's change: %v", saved)
	}
}

func TestPostgresCanvasChangeIsAppliedOnceAndChecked(t *testing.T) {
	lt := newLiveTeam(t)
	op := []map[string]any{set([]string{"nodes", "n1", "title"}, "Once")}
	first := lt.patch(t, lt.owner, 1, op, 200, map[string]any{"changeId": "change-0001"})
	again := lt.patch(t, lt.owner, 1, op, 200, map[string]any{"changeId": "change-0001"})
	if first["version"] != 2.0 || again["version"] != 2.0 || again["duplicate"] != true {
		t.Fatalf("a resend is answered, not applied again: %v / %v", first, again)
	}
	// A change that changes nothing makes no version.
	if same := lt.patch(t, lt.owner, 2, op, 200); same["version"] != 2.0 {
		t.Fatalf("no-op change: %v", same)
	}
	for _, bad := range [][]map[string]any{
		{set([]string{"doc", "view"}, nil)},
		{set([]string{"edges", "x", "toPort"}, "context")},
		{set([]string{"nodes", "n9"}, map[string]any{"id": "other"})},
		{{"op": "move", "path": []string{"nodes", "n1"}}},
	} {
		lt.patch(t, lt.owner, 2, bad, 400)
	}
	lt.patch(t, lt.owner, 0, op, 400)
	lt.patch(t, lt.owner, 9, op, 409)
	// A reader may watch, never write.
	reader, _, _ := lt.h.register(t, "live-reader@example.test")
	lt.h.request(t, lt.owner, "POST", "/tenants/"+lt.tid+"/members", map[string]string{"email": "live-reader@example.test", "role": "reader"}, 201)
	lt.patch(t, reader, 2, op, 403)
	lt.h.request(t, reader, "GET", lt.prefix+"/changes?after=1", nil, 200)
	// Another workspace's canvas is not found (AWWO-LAW-001).
	stranger, _, _ := lt.h.register(t, "live-stranger@example.test")
	lt.patch(t, stranger, 2, op, 404)
}

func TestPostgresCanvasChangeKeepsTheSaveRules(t *testing.T) {
	lt := newLiveTeam(t)
	frame := map[string]any{"version": 1, "source": "manual", "constraints": []any{"Keep it short"}, "acceptanceCriteria": []any{}}
	lt.patch(t, lt.owner, 1, []map[string]any{set([]string{"nodes", "n1", "taskFrame"}, frame)}, 200)
	// A task frame's key left out is kept, as for a whole-document save from an older page.
	out := lt.patch(t, lt.owner, 2, []map[string]any{del([]string{"nodes", "n1", "taskFrame"})}, 200)
	doc, version := lt.document(t)
	if liveNode(doc, "n1")["taskFrame"] == nil || version != 2 || out["version"] != 2.0 {
		t.Fatalf("the task frame is preserved: %v", liveNode(doc, "n1"))
	}
	lt.patch(t, lt.owner, 2, []map[string]any{set([]string{"nodes", "n1", "taskFrame"}, map[string]any{"version": 9})}, 400)
	// A canvas holds at most 400 nodes.
	ops := []map[string]any{}
	for i := 0; i < maxGraphNodes; i++ {
		id := fmt.Sprintf("bulk-%d", i)
		ops = append(ops, set([]string{"nodes", id}, map[string]any{"id": id, "kind": "form", "title": "x", "fields": []any{}}))
		if len(ops) == maxCanvasChangeOps || i == maxGraphNodes-1 {
			status := 200
			if i == maxGraphNodes-1 {
				status = 409
			}
			_, version = lt.document(t)
			lt.patch(t, lt.owner, version, ops, status)
			ops = ops[:0]
		}
	}
}

// A whole-document save from an older page can hold what the change model refuses (here a node id over 200 bytes): its
// change goes in the log as a reset, so pages and agents read the canvas whole instead of stopping at it.
func TestPostgresCanvasSaveThatNoChangeCanCarryIsAReset(t *testing.T) {
	lt := newLiveTeam(t)
	doc, version := lt.document(t)
	long := strings.Repeat("x", 210)
	nodes := append(doc["nodes"].([]any), map[string]any{"id": long, "kind": "form", "title": "Long", "x": 0, "y": 600, "w": 300, "h": 200, "fields": []any{}})
	doc["nodes"] = nodes
	saved := lt.h.request(t, lt.owner, "PUT", lt.prefix, map[string]any{"name": "Live", "version": version, "document": doc}, 200)
	changes := lt.h.request(t, lt.owner, "GET", lt.prefix+"/changes?after="+fmt.Sprint(version), nil, 200)
	if changes["reset"] != true || changes["document"] == nil || saved["version"] != version+1 {
		t.Fatalf("a save no change can carry: %v", changes)
	}
	var label string
	if err := lt.h.db.QueryRow(context.Background(), "SELECT label FROM canvas_changes WHERE tenant_id=$1 AND canvas_id=$2 AND version=$3", lt.tid, lt.cid, version+1).Scan(&label); err != nil || label != "reset" {
		t.Fatalf("its log entry: %q %v", label, err)
	}
	// What comes after it is listed again.
	lt.patch(t, lt.member, version+1, []map[string]any{set([]string{"nodes", "n1", "title"}, "After")}, 200)
	if after := lt.h.request(t, lt.owner, "GET", lt.prefix+"/changes?after="+fmt.Sprint(version+1), nil, 200); after["reset"] == true || len(after["changes"].([]any)) != 1 {
		t.Fatalf("the change after it: %v", after)
	}
}

func TestPostgresCanvasChangeFencesRunningNodes(t *testing.T) {
	lt := newLiveTeam(t)
	ctx := context.Background()
	var ownerID string
	if err := lt.h.db.QueryRow(ctx, "SELECT id FROM users WHERE email='live-owner@example.test'").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	// The owner's canvas run holds n1.
	if _, err := lt.h.db.Exec(ctx, `INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status)
		VALUES('graph-fence',$1,$2,$3,'op-fence','hash',1,'{}','["n1"]','running')`, lt.tid, lt.cid, ownerID); err != nil {
		t.Fatal(err)
	}
	out := lt.patch(t, lt.member, 1, []map[string]any{
		set([]string{"nodes", "n1", "persona"}, "changed mid-run"),
		set([]string{"nodes", "n1", "x"}, 50),
		set([]string{"nodes", "n1", "lastOutput"}, map[string]any{"text": "result", "at": 1, "source": "run"}),
		set([]string{"nodes", "n2", "persona"}, "free node"),
		set([]string{"edges", "f1:data->n1:context"}, map[string]any{"id": "f1:data->n1:context", "fromNode": "f1", "fromPort": "data", "toNode": "n1", "toPort": "context", "dataType": "text"}),
	}, 200)
	if fmt.Sprint(out["results"]) != "[node_running ok ok ok node_running]" {
		t.Fatalf("results: %v", out["results"])
	}
	// The person who started the run may change it.
	if own := lt.patch(t, lt.owner, 2, []map[string]any{set([]string{"nodes", "n1", "persona"}, "mine")}, 200); fmt.Sprint(own["results"]) != "[ok]" {
		t.Fatalf("the starter's edit: %v", own)
	}
	if _, err := lt.h.db.Exec(ctx, "UPDATE graph_runs SET status='completed' WHERE id='graph-fence'"); err != nil {
		t.Fatal(err)
	}
	if after := lt.patch(t, lt.member, 3, []map[string]any{set([]string{"nodes", "n1", "persona"}, "after the run")}, 200); fmt.Sprint(after["results"]) != "[ok]" {
		t.Fatalf("after the run: %v", after)
	}
}

// bearer sends a request with a canvas agent token.
func (lt liveTeam) bearer(t *testing.T, token, method, path string, body any, status int, origin string) map[string]any {
	t.Helper()
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	r, _ := http.NewRequest(method, lt.h.server.URL+"/api/v1"+path, bytes.NewReader(data))
	r.Header.Set("Authorization", "Bearer "+token)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Fatalf("%s %s got %d want %d: %s", method, path, resp.StatusCode, status, raw)
	}
	out := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func (lt liveTeam) token(t *testing.T, who *http.Cookie, name, scope string) (string, string) {
	t.Helper()
	out := lt.h.request(t, who, "POST", lt.prefix+"/agent-tokens", map[string]any{"name": name, "scope": scope, "days": 7}, 201)
	token := out["token"].(string)
	if !canvasAgentTokenPattern.MatchString(token) {
		t.Fatalf("token %q", token)
	}
	return token, out["item"].(map[string]any)["id"].(string)
}

func TestPostgresCanvasAgentTokensActWithinTheirRules(t *testing.T) {
	lt := newLiveTeam(t)
	token, id := lt.token(t, lt.member, "Claude Code", "edit")
	list := lt.h.request(t, lt.owner, "GET", lt.prefix+"/agent-tokens", nil, 200)["items"].([]any)
	if len(list) != 1 || strings.Contains(fmt.Sprint(list), token) || list[0].(map[string]any)["prefix"] != "awwo_ct_"+id {
		t.Fatalf("the list never holds the secret: %v", list)
	}
	// A token reads its canvas, never from a page, never another canvas.
	lt.bearer(t, token, "GET", lt.prefix, nil, 200, "")
	lt.bearer(t, token, "GET", lt.prefix, nil, 403, lt.h.cfg.PublicOrigin)
	other := lt.h.request(t, lt.owner, "POST", "/tenants/"+lt.tid+"/canvases", map[string]any{"name": "Other", "document": liveCanvasDocument()}, 201)
	lt.bearer(t, token, "GET", "/tenants/"+lt.tid+"/canvases/"+other["id"].(string), nil, 404, "")
	lt.bearer(t, "awwo_ct_0123456789abcdef_"+strings.Repeat("A", 43), "GET", lt.prefix, nil, 401, "")
	patch := func(token string, ops []map[string]any, status int) map[string]any {
		return lt.bearer(t, token, "PATCH", lt.prefix, map[string]any{"baseVersion": 1, "clientId": "ignored-id", "ops": ops}, status, "")
	}
	out := patch(token, []map[string]any{
		set([]string{"nodes", "agent-1"}, map[string]any{"id": "agent-1", "kind": "session", "title": "Agent's node", "persona": "Review"}),
		set([]string{"nodes", "n1", "model"}, "gpt-x"),
		set([]string{"nodes", "n1", "title"}, "Retitled by an agent"),
		set([]string{"nodes", "n2", "lastOutput"}, map[string]any{"text": "Done by the agent", "source": "run", "at": 5}),
		set([]string{"nodes", "agent-2"}, map[string]any{"id": "agent-2", "kind": "session", "binding": map[string]any{"companyId": "c", "agentId": "a"}}),
		set([]string{"edges", "f1:data->agent-1:context"}, map[string]any{"id": "f1:data->agent-1:context", "fromNode": "f1", "fromPort": "data", "toNode": "agent-1", "toPort": "context", "dataType": "image"}),
		set([]string{"edges", "f1:data->agent-1:reference"}, map[string]any{"id": "f1:data->agent-1:reference", "fromNode": "f1", "fromPort": "data", "toNode": "agent-1", "toPort": "reference"}),
	}, 200)
	if fmt.Sprint(out["results"]) != "[ok forbidden ok ok forbidden ok forbidden]" {
		t.Fatalf("results: %v", out["results"])
	}
	doc, _ := lt.document(t)
	made := liveNode(doc, "agent-1")
	if made["runtime"] != "" || made["model"] != "" || made["binding"] != nil || made["persona"] != "Review" {
		t.Fatalf("an agent's node starts with nothing chosen: %v", made)
	}
	result := liveNode(doc, "n2")["lastOutput"].(map[string]any)
	if result["source"] != "manual" || result["by"].(map[string]any)["name"] != "Claude Code" || result["at"] == 5.0 {
		t.Fatalf("an agent's result is a handed-in one: %v", result)
	}
	var wire map[string]any
	for _, e := range doc["edges"].([]any) {
		if e.(map[string]any)["id"] == "f1:data->agent-1:context" {
			wire = e.(map[string]any)
		}
	}
	if wire == nil || wire["dataType"] != "text" {
		t.Fatalf("the wire takes its source's type: %v", doc["edges"])
	}
	var claimed int
	if err := lt.h.db.QueryRow(context.Background(), "SELECT count(*) FROM canvas_claims WHERE tenant_id=$1 AND token_id=$2", lt.tid, id).Scan(&claimed); err != nil || claimed < 3 {
		t.Fatalf("the agent's writes took its nodes: %d %v", claimed, err)
	}
	// A second agent finds them taken; a person does not.
	second, _ := lt.token(t, lt.owner, "Codex", "edit")
	if out := patch(second, []map[string]any{set([]string{"nodes", "n1", "title"}, "Codex's")}, 200); fmt.Sprint(out["results"]) != "[claimed]" {
		t.Fatalf("a held node: %v", out)
	}
	lt.patch(t, lt.owner, 2, []map[string]any{set([]string{"nodes", "n1", "title"}, "A person's edit")}, 200)
	// A read token watches only.
	reader, _ := lt.token(t, lt.owner, "Watcher", "read")
	patch(reader, []map[string]any{set([]string{"nodes", "n2", "title"}, "x")}, 403)
	lt.bearer(t, reader, "GET", lt.prefix+"/changes?after=1", nil, 200, "")
	// Only its maker or a workspace admin revokes a token; revoked, it ends at once and its claims go.
	secondID := lt.h.request(t, lt.owner, "GET", lt.prefix+"/agent-tokens", nil, 200)["items"].([]any)
	for _, item := range secondID {
		if item.(map[string]any)["name"] == "Codex" {
			lt.h.request(t, lt.member, "DELETE", lt.prefix+"/agent-tokens/"+item.(map[string]any)["id"].(string), nil, 403)
		}
	}
	lt.h.request(t, lt.member, "DELETE", lt.prefix+"/agent-tokens/"+id, nil, 204)
	lt.bearer(t, token, "GET", lt.prefix, nil, 401, "")
	if err := lt.h.db.QueryRow(context.Background(), "SELECT count(*) FROM canvas_claims WHERE tenant_id=$1 AND token_id=$2", lt.tid, id).Scan(&claimed); err != nil || claimed != 0 {
		t.Fatalf("the revoked token's claims: %d %v", claimed, err)
	}
	// A member made a reader loses their tokens; so does a password change.
	third, _ := lt.token(t, lt.member, "Cursor", "edit")
	members := lt.h.request(t, lt.owner, "GET", "/tenants/"+lt.tid+"/members", nil, 200)["items"].([]any)
	for _, m := range members {
		if m.(map[string]any)["email"] == "live-member@example.test" {
			lt.h.request(t, lt.owner, "PATCH", "/tenants/"+lt.tid+"/members/"+m.(map[string]any)["id"].(string), map[string]string{"role": "reader"}, 204)
		}
	}
	lt.bearer(t, third, "GET", lt.prefix, nil, 401, "")
}

// liveEvents reads a live stream's events.
type liveEvents struct {
	events chan [2]string
}

func (lt liveTeam) openLive(t *testing.T, cookie *http.Cookie, token, query string) *liveEvents {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", lt.h.server.URL+"/api/v1"+lt.prefix+"/live/events?"+query, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		t.Fatalf("live status %d: %s", resp.StatusCode, raw)
	}
	out := &liveEvents{events: make(chan [2]string, 64)}
	t.Cleanup(func() { cancel(); resp.Body.Close() })
	go func() {
		defer close(out.events)
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1<<20), 8<<20)
		event := ""
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "event: ") {
				event = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				out.events <- [2]string{event, strings.TrimPrefix(line, "data: ")}
			}
		}
	}()
	return out
}

// next waits for an event of a name, skipping others, and gives its data.
func (l *liveEvents) next(t *testing.T, name string) map[string]any {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case e, ok := <-l.events:
			if !ok {
				t.Fatalf("the stream ended before %s", name)
			}
			if e[0] == name {
				out := map[string]any{}
				_ = json.Unmarshal([]byte(e[1]), &out)
				return out
			}
		case <-deadline:
			t.Fatalf("no %s event", name)
		}
	}
}

func TestPostgresCanvasLiveStreamCarriesEverything(t *testing.T) {
	lt := newLiveTeam(t, func(a *App) { a.reauthEvery = 300 * time.Millisecond })
	owner := lt.openLive(t, lt.owner, "", "after=1&client=owner-page-1")
	hello := owner.next(t, "hello")
	if hello["version"] != 1.0 || len(hello["participants"].([]any)) != 1 || hello["you"].(map[string]any)["id"] != "owner-page-1" {
		t.Fatalf("hello: %v", hello)
	}
	// Someone else's change reaches the stream.
	lt.patch(t, lt.member, 1, []map[string]any{set([]string{"nodes", "n2", "title"}, "Live title")}, 200)
	change := owner.next(t, "changes")
	if change["version"] != 2.0 || change["actor"].(map[string]any)["kind"] != "human" {
		t.Fatalf("change: %v", change)
	}
	// Someone else coming in, and their state.
	member := lt.openLive(t, lt.member, "", "after=2&client=member-page-1")
	member.next(t, "hello")
	came := owner.next(t, "presence")
	if came["participant"].(map[string]any)["id"] != "member-page-1" {
		t.Fatalf("presence: %v", came)
	}
	lt.h.request(t, lt.member, "POST", lt.prefix+"/live/presence", map[string]any{"clientId": "member-page-1", "state": map[string]any{"selection": []string{"n2"}, "cursor": map[string]any{"x": 10, "y": 20}}}, 204)
	state := owner.next(t, "presence")["participant"].(map[string]any)["state"].(map[string]any)
	if fmt.Sprint(state["selection"]) != "[n2]" || state["cursor"] == nil {
		t.Fatalf("state: %v", state)
	}
	// An agent's claim and a message.
	token, id := lt.token(t, lt.owner, "Claude Code", "edit")
	claim := lt.bearer(t, token, "POST", lt.prefix+"/live/claims", map[string]any{"clientId": "ignored-id", "nodeIds": []string{"n1"}, "ttlSeconds": 60, "note": "drafting"}, 200, "")
	if len(claim["claims"].([]any)) != 1 || len(claim["refused"].([]any)) != 0 {
		t.Fatalf("claim: %v", claim)
	}
	claims := owner.next(t, "claims")["claims"].([]any)
	if len(claims) != 1 || claims[0].(map[string]any)["name"] != "Claude Code" {
		t.Fatalf("claims: %v", claims)
	}
	if refused := lt.h.request(t, lt.member, "POST", lt.prefix+"/live/claims", map[string]any{"clientId": "member-page-1", "nodeIds": []string{"n1"}}, 200); len(refused["refused"].([]any)) != 1 {
		t.Fatalf("a held node is refused: %v", refused)
	}
	lt.bearer(t, token, "POST", lt.prefix+"/live/messages", map[string]any{"clientId": "ignored-id", "text": "I take Plan", "nodeId": "n1"}, 200, "")
	message := owner.next(t, "message")["message"].(map[string]any)
	if message["text"] != "I take Plan" || message["authorKind"] != "agent" || message["participantId"] != "t_"+id {
		t.Fatalf("message: %v", message)
	}
	if list := lt.h.request(t, lt.member, "GET", lt.prefix+"/live/messages", nil, 200)["items"].([]any); len(list) != 1 {
		t.Fatalf("messages: %v", list)
	}
	// A reconnect from before the log's first change is told to read the canvas again.
	late := lt.openLive(t, lt.owner, "", "after=1&client=owner-page-2")
	late.next(t, "hello")
	if c := late.next(t, "changes"); c["version"] != 2.0 {
		t.Fatalf("catch-up: %v", c)
	}
	if _, err := lt.h.db.Exec(context.Background(), "DELETE FROM canvas_changes WHERE tenant_id=$1 AND canvas_id=$2", lt.tid, lt.cid); err != nil {
		t.Fatal(err)
	}
	gone := lt.openLive(t, lt.owner, "", "after=1&client=owner-page-3")
	gone.next(t, "hello")
	if reset := gone.next(t, "reset"); reset["version"] != 2.0 {
		t.Fatalf("reset: %v", reset)
	}
	// A revoked token's stream ends; the API stopping ends every stream.
	agent := lt.openLive(t, nil, token, "")
	agent.next(t, "hello")
	lt.h.request(t, lt.owner, "DELETE", lt.prefix+"/agent-tokens/"+id, nil, 204)
	if bye := agent.next(t, "bye"); bye["reason"] != "revoked" {
		t.Fatalf("bye: %v", bye)
	}
	lt.h.a.multiplayer.shutdown()
	if bye := owner.next(t, "bye"); bye["reason"] != "restart" {
		t.Fatalf("bye: %v", bye)
	}
}

// A page names itself, and every participant sees the names: another member who copies one is someone else, never a
// second tab of its owner, and no page passes for an agent.
func TestPostgresCanvasLiveParticipantsAreTheirOwn(t *testing.T) {
	lt := newLiveTeam(t)
	owner := lt.openLive(t, lt.owner, "", "after=1&client=owner-page-7")
	owner.next(t, "hello")
	streamStatus := func(cookie *http.Cookie, query string) int {
		req, _ := http.NewRequest("GET", lt.h.server.URL+"/api/v1"+lt.prefix+"/live/events?"+query, nil)
		req.AddCookie(cookie)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := streamStatus(lt.member, "after=1&client=owner-page-7"); got != 409 {
		t.Fatalf("a copied page id's stream: %d", got)
	}
	// Presence sent under the owner's page id by the member moves nothing.
	lt.h.request(t, lt.member, "POST", lt.prefix+"/live/presence", map[string]any{"clientId": "owner-page-7", "state": map[string]any{"status": "Pretending"}}, 204)
	if p, ok := lt.h.a.multiplayer.participant(lt.tid, lt.cid, "owner-page-7"); !ok || p.State.Status != nil || p.UserID == lt.memberID {
		t.Fatalf("the owner's presence after the member's: %+v", p)
	}
	// The owner's own presence still goes.
	lt.h.request(t, lt.owner, "POST", lt.prefix+"/live/presence", map[string]any{"clientId": "owner-page-7", "state": map[string]any{"status": "Reviewing"}}, 204)
	if p, _ := lt.h.a.multiplayer.participant(lt.tid, lt.cid, "owner-page-7"); p.State.Status == nil || *p.State.Status != "Reviewing" {
		t.Fatalf("the owner's own presence: %+v", p)
	}
	// A claim the owner's page holds is not renewed, taken or released under its id by the member.
	if held := lt.h.request(t, lt.owner, "POST", lt.prefix+"/live/claims", map[string]any{"clientId": "owner-page-7", "nodeIds": []string{"n1"}}, 200); len(held["refused"].([]any)) != 0 {
		t.Fatalf("the owner's claim: %v", held)
	}
	if copied := lt.h.request(t, lt.member, "POST", lt.prefix+"/live/claims", map[string]any{"clientId": "owner-page-7", "nodeIds": []string{"n1"}}, 200); len(copied["refused"].([]any)) != 1 {
		t.Fatalf("a claim under a copied page id: %v", copied)
	}
	lt.h.request(t, lt.member, "DELETE", lt.prefix+"/live/claims", map[string]any{"clientId": "owner-page-7"}, 200)
	var holder string
	if err := lt.h.db.QueryRow(context.Background(), "SELECT user_id FROM canvas_claims WHERE tenant_id=$1 AND canvas_id=$2 AND node_id='n1'", lt.tid, lt.cid).Scan(&holder); err != nil || holder == lt.memberID {
		t.Fatalf("the owner's claim after the member's: %q %v", holder, err)
	}
	// Nor is a change taken under it: it would pass on the owner's page for its own.
	out := lt.patch(t, lt.member, 1, []map[string]any{set([]string{"nodes", "n2", "title"}, "Under a copied id")}, 409, map[string]any{"clientId": "owner-page-7"})
	if out["error"].(map[string]any)["code"] != "client_taken" {
		t.Fatalf("a change under a copied page id: %v", out)
	}
	lt.patch(t, lt.owner, 1, []map[string]any{set([]string{"nodes", "n2", "title"}, "The owner's own")}, 200, map[string]any{"clientId": "owner-page-7"})
	// A message's before is a message id (the MCP tool's too).
	lt.h.request(t, lt.owner, "GET", lt.prefix+"/live/messages?before=not%20an%20id", nil, 400)
	// No page passes for an agent: "t_" ids are the tokens'.
	_, id := lt.token(t, lt.owner, "Claude Code", "edit")
	if got := streamStatus(lt.member, "after=1&client=t_"+id); got != 400 {
		t.Fatalf("a page under a token's id: %d", got)
	}
	lt.patch(t, lt.member, 1, []map[string]any{set([]string{"nodes", "n2", "title"}, "x")}, 400, map[string]any{"clientId": "t_" + id})
	lt.h.request(t, lt.member, "POST", lt.prefix+"/live/messages", map[string]any{"clientId": "t_" + id, "text": "I am Claude"}, 400)
}

func TestPostgresCanvasLiveStreamEndsWhenAccessEnds(t *testing.T) {
	lt := newLiveTeam(t, func(a *App) { a.reauthEvery = 200 * time.Millisecond })
	member := lt.openLive(t, lt.member, "", "client=member-page-9")
	member.next(t, "hello")
	members := lt.h.request(t, lt.owner, "GET", "/tenants/"+lt.tid+"/members", nil, 200)["items"].([]any)
	for _, m := range members {
		if m.(map[string]any)["email"] == "live-member@example.test" {
			lt.h.request(t, lt.owner, "DELETE", "/tenants/"+lt.tid+"/members/"+m.(map[string]any)["id"].(string), nil, 204)
		}
	}
	if bye := member.next(t, "bye"); bye["reason"] != "access" {
		t.Fatalf("bye: %v", bye)
	}
}

func (lt liveTeam) mcp(t *testing.T, token string, message map[string]any, status int) map[string]any {
	t.Helper()
	message["jsonrpc"] = "2.0"
	return lt.bearer(t, token, "POST", "/mcp", message, status, "")
}

func mcpStructured(t *testing.T, reply map[string]any) map[string]any {
	t.Helper()
	result, ok := reply["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", reply)
	}
	return result["structuredContent"].(map[string]any)
}

func TestPostgresCanvasMCPLetsAnAgentWorkOnTheCanvas(t *testing.T) {
	lt := newLiveTeam(t)
	token, _ := lt.token(t, lt.owner, "Claude Code", "edit")
	started := lt.mcp(t, token, map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test"}}}, 200)
	if started["result"].(map[string]any)["protocolVersion"] != "2025-06-18" || !strings.Contains(started["result"].(map[string]any)["instructions"].(string), "Claude Code") {
		t.Fatalf("initialize: %v", started)
	}
	lt.bearer(t, token, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, 202, "")
	tools := lt.mcp(t, token, map[string]any{"id": 2, "method": "tools/list"}, 200)["result"].(map[string]any)["tools"].([]any)
	if len(tools) < 10 {
		t.Fatalf("tools: %v", tools)
	}
	call := func(id int, name string, args map[string]any) map[string]any {
		return lt.mcp(t, token, map[string]any{"id": id, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}}, 200)
	}
	overview := mcpStructured(t, call(3, "canvas_overview", map[string]any{}))
	if len(overview["nodes"].([]any)) != 3 || overview["you"].(map[string]any)["name"] != "Claude Code" {
		t.Fatalf("overview: %v", overview)
	}
	added := mcpStructured(t, call(4, "canvas_add_node", map[string]any{"kind": "session", "title": "Security review", "persona": "Find the holes", "result": "First notes"}))
	nodeID, _ := added["nodeId"].(string)
	if nodeID == "" || fmt.Sprint(added["results"]) != "[ok ok]" {
		t.Fatalf("add: %v", added)
	}
	connected := mcpStructured(t, call(5, "canvas_connect", map[string]any{"fromNodeId": "f1", "toNodeId": nodeID}))
	if fmt.Sprint(connected["results"]) != "[ok]" {
		t.Fatalf("connect: %v", connected)
	}
	updated := mcpStructured(t, call(6, "canvas_update_node", map[string]any{"nodeId": nodeID, "result": "Final notes", "x": 900}))
	if fmt.Sprint(updated["results"]) != "[ok ok]" {
		t.Fatalf("update: %v", updated)
	}
	if refused := call(7, "canvas_update_node", map[string]any{"nodeId": "n1"}); refused["result"].(map[string]any)["isError"] != true {
		t.Fatalf("nothing to change: %v", refused)
	}
	version := updated["version"].(float64)
	// A person's change while the agent waits.
	go func() {
		time.Sleep(300 * time.Millisecond)
		body, _ := json.Marshal(map[string]any{"baseVersion": version, "clientId": "owner-page-1", "ops": []map[string]any{set([]string{"nodes", "n2", "title"}, "Seen by the agent")}})
		r, _ := http.NewRequest("PATCH", lt.h.server.URL+"/api/v1"+lt.prefix, bytes.NewReader(body))
		r.Header.Set("Origin", lt.h.cfg.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(lt.owner)
		if resp, err := http.DefaultClient.Do(r); err == nil {
			resp.Body.Close()
		}
	}()
	// Waiting from before its own last change: that change does not end the wait (the agent made it), the
	// person's does, and the answer lists both.
	began := time.Now()
	waited := mcpStructured(t, call(8, "canvas_wait", map[string]any{"afterVersion": version - 1, "seconds": 5}))
	if !strings.Contains(fmt.Sprint(waited["changes"]), "Seen by the agent") || !strings.Contains(fmt.Sprint(waited["changes"]), "Final notes") || time.Since(began) < 250*time.Millisecond {
		t.Fatalf("wait: %v after %v", waited, time.Since(began))
	}
	said := mcpStructured(t, call(9, "canvas_say", map[string]any{"text": "Review is in"}))
	if said["message"] == nil {
		t.Fatalf("say: %v", said)
	}
	// Its own message and its own claim, made while it waits, are no news to it either: the wait runs to its end.
	go func() {
		time.Sleep(200 * time.Millisecond)
		for i, name := range []string{"canvas_say", "canvas_claim"} {
			body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 20 + i, "method": "tools/call", "params": map[string]any{"name": name,
				"arguments": map[string]any{"text": "Still on it", "nodeIds": []string{nodeID}}}})
			r, _ := http.NewRequest("POST", lt.h.server.URL+"/api/v1/mcp", bytes.NewReader(body))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Content-Type", "application/json")
			if resp, err := http.DefaultClient.Do(r); err == nil {
				resp.Body.Close()
			}
		}
	}()
	began = time.Now()
	quiet := mcpStructured(t, call(13, "canvas_wait", map[string]any{"afterVersion": waited["version"], "seconds": 1.5}))
	if time.Since(began) < 1400*time.Millisecond || len(quiet["messages"].([]any)) != 0 || len(quiet["changes"].([]any)) != 0 || quiet["note"] == nil {
		t.Fatalf("a wait with nothing from anyone else: %v after %v", quiet, time.Since(began))
	}
	if messages := lt.h.request(t, lt.owner, "GET", "/tenants/"+lt.tid+"/canvases/"+lt.cid+"/live/messages", nil, 200); !strings.Contains(fmt.Sprint(messages["items"]), "Still on it") {
		t.Fatalf("the message said while waiting: %v", messages)
	}
	status := mcpStructured(t, call(10, "canvas_set_status", map[string]any{"status": "Reviewing", "focusNodeId": nodeID}))
	if status["ok"] != true {
		t.Fatalf("status: %v", status)
	}
	doc, _ := lt.document(t)
	if out := liveNode(doc, nodeID)["lastOutput"].(map[string]any); out["text"] != "Final notes" || out["source"] != "manual" {
		t.Fatalf("the agent's result: %v", out)
	}
	if unknown := lt.mcp(t, token, map[string]any{"id": 11, "method": "nope"}, 200); unknown["error"] == nil {
		t.Fatalf("unknown method: %v", unknown)
	}
	lt.bearer(t, token, "POST", "/mcp", []any{map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}}, 200, "")
	lt.h.request(t, nil, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}, 401)
	// A message too large for the hosted edge is answered in JSON-RPC, saying where a larger result goes.
	big := lt.mcp(t, token, map[string]any{"id": 30, "method": "tools/call", "params": map[string]any{"name": "canvas_update_node",
		"arguments": map[string]any{"nodeId": nodeID, "result": strings.Repeat("x", mcpMaxBody)}}}, 200)
	if failure, _ := big["error"].(map[string]any); failure == nil || !strings.Contains(fmt.Sprint(failure["message"]), "PATCH") {
		t.Fatalf("a message over 1.9 MB: %v", big)
	}
	// A wait in progress when the API stops ends at once (it would hold the restart up).
	go func() {
		time.Sleep(300 * time.Millisecond)
		lt.h.a.multiplayer.shutdown()
	}()
	began = time.Now()
	stopped := lt.mcp(t, token, map[string]any{"id": 31, "method": "tools/call", "params": map[string]any{"name": "canvas_wait", "arguments": map[string]any{"seconds": 10}}}, 200)
	if result := stopped["result"].(map[string]any); time.Since(began) > 3*time.Second || result["structuredContent"].(map[string]any)["restart"] != true {
		t.Fatalf("a wait when the API stops: %v after %v", stopped, time.Since(began))
	}
}

// Each tool carries MCP's annotations, every hint sent rather than left to a client's default (a client takes a tool
// it is told nothing of as destructive and open-world), and the descriptions say where a refusal's reason is and which
// ports a wire joins.
func TestPostgresCanvasMCPToolsCarryTheirHints(t *testing.T) {
	lt := newLiveTeam(t)
	token, _ := lt.token(t, lt.owner, "Codex", "edit")
	started := lt.mcp(t, token, map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}}, 200)
	instructions := started["result"].(map[string]any)["instructions"].(string)
	for _, want := range []string{"results, one code per op", "reasons says", "forbidden (a rule of what an agent may change)", "gone (what it names", "canvas_connect names the ports"} {
		if !strings.Contains(instructions, want) {
			t.Fatalf("the instructions lack %q: %s", want, instructions)
		}
	}
	// readOnly, destructive, idempotent.
	want := map[string][3]bool{
		"canvas_overview": {true, false, true}, "canvas_read_node": {true, false, true}, "canvas_wait": {true, false, true}, "canvas_messages": {true, false, true},
		"canvas_add_node": {false, false, false}, "canvas_update_node": {false, true, false}, "canvas_delete_node": {false, true, true},
		"canvas_connect": {false, false, true}, "canvas_disconnect": {false, true, true}, "canvas_claim": {false, false, false},
		"canvas_release": {false, false, true}, "canvas_set_status": {false, false, true}, "canvas_say": {false, false, false},
		"canvas_apply": {false, true, false},
	}
	tools := lt.mcp(t, token, map[string]any{"id": 2, "method": "tools/list"}, 200)["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(want) {
		t.Fatalf("%d tools, %d expected", len(tools), len(want))
	}
	descriptions := map[string]string{}
	for _, item := range tools {
		tool := item.(map[string]any)
		name := tool["name"].(string)
		hints, known := want[name]
		annotations, _ := tool["annotations"].(map[string]any)
		if !known || annotations == nil {
			t.Fatalf("%s: no hints expected or sent: %v", name, tool)
		}
		for _, key := range []string{"readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"} {
			if _, sent := annotations[key].(bool); !sent {
				t.Fatalf("%s: %s is not sent: %v", name, key, annotations)
			}
		}
		got := [3]bool{annotations["readOnlyHint"] == true, annotations["destructiveHint"] == true, annotations["idempotentHint"] == true}
		if got != hints || annotations["openWorldHint"] != false || annotations["title"] != tool["title"] || tool["title"] == "" {
			t.Fatalf("%s: annotations %v, want readOnly/destructive/idempotent %v, a closed world and its title", name, annotations, hints)
		}
		descriptions[name] = tool["description"].(string)
	}
	// The tools that change the canvas by ops say where a refused op's reason is; the others make no ops.
	for name, description := range descriptions {
		changes := !want[name][0] && name != "canvas_claim" && name != "canvas_release" && name != "canvas_set_status" && name != "canvas_say"
		if changes != strings.Contains(description, "in reasons one sentence") {
			t.Fatalf("%s: reasons in its description is %v: %s", name, !changes, description)
		}
	}
	for _, port := range []string{"a form's data", "result", "context", "reference", "audio of a video session", "in:<field id>", "out:<field id>", "timeline, clips, sounds and pictures"} {
		if !strings.Contains(descriptions["canvas_connect"], port) {
			t.Fatalf("canvas_connect does not name %q: %s", port, descriptions["canvas_connect"])
		}
	}
}

// Every op the canvas refuses an agent says why beside its code, which stays as it was: what the op would have changed,
// the rule, and what to do instead.
func TestPostgresCanvasMCPRefusalsSayWhy(t *testing.T) {
	lt := newLiveTeam(t)
	ctx := context.Background()
	// A person's image session and a node with a contract of one text input.
	_, version := lt.document(t)
	lt.patch(t, lt.owner, version, []map[string]any{
		set([]string{"nodes", "img1"}, map[string]any{"id": "img1", "kind": "session", "agentKind": "image", "title": "Picture", "x": 0, "y": 400, "w": 340, "h": 260}),
		set([]string{"nodes", "c1"}, map[string]any{"id": "c1", "kind": "session", "agentKind": "llm", "title": "Writer", "x": 400, "y": 400, "w": 340, "h": 260,
			"contract": map[string]any{"version": 1, "inputs": []any{map[string]any{"id": "brief", "label": "Brief", "type": "text"}}, "outputs": []any{}}}),
	}, 200)
	token, _ := lt.token(t, lt.owner, "Claude Code", "edit")
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		return mcpStructured(t, lt.mcp(t, token, map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}}, 200))
	}
	// expect checks a tool's answer: its codes, and a reason for each refused op (none for an op done) holding each part
	// asked for that op (a part marked ^ begins it).
	expect := func(name string, args map[string]any, codes string, parts ...[]string) map[string]any {
		t.Helper()
		out := call(name, args)
		results, _ := out["results"].([]any)
		if fmt.Sprint(results) != codes {
			t.Fatalf("%s %v: results %v, want %s (%v)", name, args, results, codes, out)
		}
		reasons, _ := out["reasons"].([]any)
		if codes == "[ok]" {
			if _, sent := out["reasons"]; sent {
				t.Fatalf("%s: reasons for a change done whole: %v", name, out)
			}
			return out
		}
		if len(reasons) != len(results) {
			t.Fatalf("%s: reasons %v for results %v", name, reasons, results)
		}
		for i, result := range results {
			reason, _ := reasons[i].(string)
			if (result == "ok") != (reason == "") {
				t.Fatalf("%s op %d (%v): reason %q", name, i, result, reason)
			}
			if i < len(parts) {
				for _, part := range parts[i] {
					if found := strings.Contains(reason, part); strings.HasPrefix(part, "^") && !strings.HasPrefix(reason, part[1:]) || !strings.HasPrefix(part, "^") && !found {
						t.Fatalf("%s op %d: reason %q lacks %q", name, i, reason, part)
					}
				}
			}
		}
		return out
	}
	// A title over 200 bytes (66 Chinese characters fit, 67 do not); w and h under 40, beside a change that is done.
	expect("canvas_update_node", map[string]any{"nodeId": "n1", "title": strings.Repeat("规", 67)}, "[forbidden]", []string{"node n1's title: ", "at most 200 bytes", "shorten it"})
	expect("canvas_update_node", map[string]any{"nodeId": "n1", "title": strings.Repeat("规", 66), "w": 39}, "[ok forbidden]", nil, []string{"node n1's w: ", "at least 40"})
	// A form field id outside [A-Za-z0-9_.:-]{1,80}; a field the node's kind lacks; one no agent sets; a kind no agent adds.
	expect("canvas_update_node", map[string]any{"nodeId": "f1", "fields": []any{map[string]any{"id": "goal one", "label": "Goal"}}}, "[forbidden]",
		[]string{"node f1's fields: ", "1 to 80 ASCII letters, digits, _ . : or -", `which "goal one" is not`, "rename the field"})
	expect("canvas_update_node", map[string]any{"nodeId": "f1", "fields": []any{map[string]any{"id": "目标", "label": "Goal"}}}, "[forbidden]", []string{`ASCII letters, digits, _ . : or -, which "目标" is not`})
	// A value that is no text is told so (not to shorten it); an order of a form's fields, which agents do not reorder;
	// a set on the node list itself.
	expect("canvas_apply", map[string]any{"ops": []any{set([]string{"nodes", "n1", "title"}, 5)}}, "[forbidden]", []string{"node n1's title: a title is text (a JSON string)"})
	expect("canvas_apply", map[string]any{"ops": []any{map[string]any{"op": "order", "path": []string{"nodes", "f1", "fields"}, "ids": []string{"q"}}}}, "[forbidden]",
		[]string{"node f1's fields: an agent does not reorder a form's fields"})
	expect("canvas_apply", map[string]any{"ops": []any{map[string]any{"op": "order", "path": []string{"nodes", "f1", "fields", "q"}, "ids": []string{"q"}}}}, "[forbidden]",
		[]string{"field q of node f1: order takes a list, not one record, and the one list an agent puts in order is the nodes (path nodes)"})
	expect("canvas_apply", map[string]any{"ops": []any{set([]string{"nodes"}, []any{})}}, "[forbidden]", []string{"^the nodes: an agent adds, changes and deletes nodes one by one"})
	expect("canvas_update_node", map[string]any{"nodeId": "f1", "persona": "Be brief"}, "[forbidden]", []string{"node f1's persona: a form has no persona (only a session does)"})
	expect("canvas_apply", map[string]any{"ops": []any{set([]string{"nodes", "n1", "model"}, "gpt-x")}}, "[forbidden]", []string{"node n1's model: it is not open to agents", "a session's persona", "a person chooses the rest"})
	expect("canvas_add_node", map[string]any{"kind": "edit", "title": "Cut"}, "[forbidden]", []string{"session and form nodes only, not an edit node"})
	expect("canvas_apply", map[string]any{"ops": []any{set([]string{"nodes", "agent-x"}, map[string]any{"id": "agent-x", "kind": "session", "model": "gpt-x"})}}, "[forbidden]",
		[]string{"node agent-x: it cannot carry model", "a person chooses its runtime and model"})
	// Ports: one a node lacks (an input of a form, which has none), types that do not fit, a single input already wired,
	// a wire into its own node.
	expect("canvas_connect", map[string]any{"fromNodeId": "f1", "toNodeId": "n2", "fromPort": "answers"}, "[forbidden]", []string{"wire f1:answers->n2:context: node f1 has no output answers (its outputs: data; name one of them)"})
	expect("canvas_connect", map[string]any{"fromNodeId": "n2", "toNodeId": "c1", "toPort": "context"}, "[forbidden]", []string{"node c1 has no input context (its inputs: in:brief"})
	expect("canvas_connect", map[string]any{"fromNodeId": "n1", "toNodeId": "f1"}, "[forbidden]", []string{"node f1 has no input context (a form has no inputs)"})
	expect("canvas_connect", map[string]any{"fromNodeId": "f1", "toNodeId": "img1", "toPort": "reference"}, "[forbidden]", []string{"node f1's data gives text and node img1's reference takes image", "join an output and an input of one type"})
	wired := expect("canvas_connect", map[string]any{"fromNodeId": "f1", "toNodeId": "c1"}, "[ok]")
	if again := expect("canvas_connect", map[string]any{"fromNodeId": "f1", "toNodeId": "c1"}, "[ok]"); again["version"] != wired["version"] {
		t.Fatalf("connecting the same wire again changed the canvas: %v then %v", wired, again)
	}
	expect("canvas_connect", map[string]any{"fromNodeId": "n1", "toNodeId": "c1"}, "[forbidden]", []string{"node c1's in:brief takes one wire and has one already (f1:data->c1:in:brief)", "wire another input or, if that wire may go, remove it first"})
	expect("canvas_connect", map[string]any{"fromNodeId": "n1", "toNodeId": "n1"}, "[forbidden]", []string{"a wire joins two different nodes", "back into itself"})
	// What is no longer there: a node to wire from, a node to delete, a field of a node deleted earlier in the change.
	expect("canvas_connect", map[string]any{"fromNodeId": "ghost", "toNodeId": "n2"}, "[forbidden]", []string{"node ghost is not on the canvas", "read the canvas again"})
	expect("canvas_delete_node", map[string]any{"nodeId": "ghost"}, "[gone]", []string{"node ghost: it is not on the canvas, so there is nothing to delete"})
	scratch := expect("canvas_add_node", map[string]any{"kind": "form", "title": "Scratch"}, "[ok]")["nodeId"].(string)
	expect("canvas_apply", map[string]any{"ops": []any{del([]string{"nodes", scratch}), set([]string{"nodes", scratch, "title"}, "Late")}}, "[ok gone]", nil,
		[]string{"node " + scratch + "'s title: node " + scratch + " is not on the canvas (deleted meanwhile, or never there)"})
	// Someone else's claim, named as the claims name it.
	codex, _ := lt.token(t, lt.owner, "Codex", "edit")
	lt.bearer(t, codex, "POST", lt.prefix+"/live/claims", map[string]any{"nodeIds": []string{"n2"}, "ttlSeconds": 300}, 200, "")
	expect("canvas_update_node", map[string]any{"nodeId": "n2", "title": "Mine now"}, "[claimed]", []string{"node n2's title: Codex (an agent) holds node n2 until ", " UTC; pick another node, or ask them in a message"})
	// A node AwwO runs: its place stays free, its instructions and its wires wait for the run's end.
	var ownerID string
	if err := lt.h.db.QueryRow(ctx, "SELECT id FROM users WHERE email='live-owner@example.test'").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := lt.h.db.Exec(ctx, `INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status)
		VALUES('graph-why',$1,$2,$3,'op-why','hash',1,'{}','["img1"]','running')`, lt.tid, lt.cid, ownerID); err != nil {
		t.Fatal(err)
	}
	expect("canvas_update_node", map[string]any{"nodeId": "img1", "persona": "Brighter", "x": 20}, "[node_running ok]",
		[]string{"node img1's persona: node img1 is in a run of AwwO (running or queued)", "try again once it has ended"})
	expect("canvas_connect", map[string]any{"fromNodeId": "f1", "toNodeId": "img1"}, "[node_running]", []string{"wire f1:data->img1:context: it leads into node img1, which is in a run of AwwO"})
	// Connecting only adds: a wire already there is left as it is, here a person's feedback wire with the id a
	// connection of those ports makes, which setting it again would have turned into a data wire.
	_, version = lt.document(t)
	feedback := map[string]any{"id": "n2:result->n1:context", "fromNode": "n2", "fromPort": "result", "toNode": "n1", "toPort": "context", "dataType": "text", "kind": "feedback"}
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"edges", "n2:result->n1:context"}, feedback)}, 200)
	expect("canvas_connect", map[string]any{"fromNodeId": "n2", "toNodeId": "n1"}, "[forbidden]",
		[]string{"^wire n2:result->n1:context: a feedback wire joins these ports already, and connecting only adds; it is left as it is"})
	// Another wire whose ends spell the same id (node ids and ports may hold ":") is not taken for this one, nor
	// replaced by it.
	_, version = lt.document(t)
	lt.patch(t, lt.owner, version, []map[string]any{
		set([]string{"nodes", "p"}, map[string]any{"id": "p", "kind": "session", "agentKind": "llm", "title": "Source", "x": 0, "y": 800, "w": 340, "h": 260,
			"contract": map[string]any{"version": 1, "inputs": []any{}, "outputs": []any{map[string]any{"id": "result", "label": "Result", "type": "text"}}}}),
		set([]string{"nodes", "p:out"}, map[string]any{"id": "p:out", "kind": "session", "agentKind": "llm", "title": "Other", "x": 400, "y": 800, "w": 340, "h": 260}),
		set([]string{"edges", "p:out:result->n1:context"}, map[string]any{"id": "p:out:result->n1:context", "fromNode": "p", "fromPort": "out:result", "toNode": "n1", "toPort": "context", "dataType": "text"}),
	}, 200)
	expect("canvas_connect", map[string]any{"fromNodeId": "p:out", "toNodeId": "n1"}, "[forbidden]",
		[]string{"^wire p:out:result->n1:context: another wire on the canvas has this id, and connecting only adds; canvas_apply can add this one under an id of its own"})
	clashed, _ := lt.document(t)
	for _, e := range clashed["edges"].([]any) {
		if e.(map[string]any)["id"] == "p:out:result->n1:context" && e.(map[string]any)["fromNode"] != "p" {
			t.Fatalf("the other wire after the refused connection: %v", e)
		}
	}
	wires, _ := lt.document(t)
	kinds := []any{}
	for _, e := range wires["edges"].([]any) {
		if e.(map[string]any)["id"] == "n2:result->n1:context" {
			kinds = append(kinds, e.(map[string]any)["kind"])
		}
	}
	if fmt.Sprint(kinds) != "[feedback]" {
		t.Fatalf("the feedback wire after a connection of its ports: %v", kinds)
	}
	// The text content carries the reasons too, a wire's id as written (not HTML-escaped for a model to read).
	reply := lt.mcp(t, token, map[string]any{"id": 9, "method": "tools/call", "params": map[string]any{"name": "canvas_connect", "arguments": map[string]any{"fromNodeId": "n1", "toNodeId": "c1"}}}, 200)
	if text := reply["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string); !strings.Contains(text, `"reasons"`) ||
		!strings.Contains(text, "wire n1:result->c1:in:brief: node c1's in:brief takes one wire") || strings.Contains(text, "\\"+"u003e") {
		t.Fatalf("the text content: %s", text)
	}
	// Over HTTP the same, beside results, only when an op is refused; a change sent again under its id is answered with
	// what its codes meant (the particular rule is not kept).
	_, version = lt.document(t)
	body := map[string]any{"baseVersion": version, "changeId": "why-change-0001", "ops": []map[string]any{set([]string{"nodes", "f1", "title"}, "Brief v2"), set([]string{"nodes", "f1", "persona"}, "x")}}
	first := lt.bearer(t, token, "PATCH", lt.prefix, body, 200, "")
	again := lt.bearer(t, token, "PATCH", lt.prefix, body, 200, "")
	if fmt.Sprint(first["results"]) != "[ok forbidden]" || fmt.Sprint(first["reasons"]) != "[ node f1's persona: a form has no persona (only a session does)]" {
		t.Fatalf("a change's answer over HTTP: %v", first)
	}
	if reasons, _ := again["reasons"].([]any); again["duplicate"] != true || fmt.Sprint(again["results"]) != "[ok forbidden]" || len(reasons) != 2 || reasons[0] != "" ||
		reasons[1] != "node f1's persona: when this change was first sent, a rule of what an agent may change refused it" {
		t.Fatalf("a change sent again: %v", again)
	}
	if done := lt.bearer(t, token, "PATCH", lt.prefix, map[string]any{"baseVersion": version, "ops": []map[string]any{set([]string{"nodes", "f1", "title"}, "Brief v3")}}, 200, ""); fmt.Sprint(done["results"]) != "[ok]" || done["reasons"] != nil {
		t.Fatalf("a change done whole: %v", done)
	}
	// A person's op is told why too (here a node someone deleted).
	if out := lt.patch(t, lt.owner, version, []map[string]any{set([]string{"nodes", "ghost", "title"}, "x")}, 200); fmt.Sprint(out["results"]) != "[gone]" ||
		fmt.Sprint(out["reasons"]) != "[node ghost's title: node ghost is not on the canvas (deleted meanwhile, or never there); read the canvas again]" {
		t.Fatalf("a person's op on a node gone: %v", out)
	}
}

// The sentences that say what an agent may set name every field the rules let it set, and a new node's names none it
// cannot carry; a refusal's list of a node's ports is the port rules' own.
func TestCanvasAgentReasonsFollowTheRules(t *testing.T) {
	// names says whether a sentence names a field as a word of its own (an "h" inside "the" is none).
	names := func(sentence, key string) bool {
		for _, word := range strings.FieldsFunc(sentence, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
			if word == key {
				return true
			}
		}
		return false
	}
	clauses := strings.FieldsFunc(agentFieldsRule, func(r rune) bool { return r == ',' || r == ';' })
	for key, kinds := range agentNodeFields {
		if !names(agentFieldsRule, key) {
			t.Fatalf("agentFieldsRule does not name %s", key)
		}
		// A field of one kind of node is named in the clause of that kind ("a session's persona").
		for owner := range kinds {
			paired := false
			for _, clause := range clauses {
				paired = paired || strings.Contains(clause, kindPhrase(owner)+"'s ") && names(clause, key)
			}
			if !paired {
				t.Fatalf("agentFieldsRule does not give %s its %s", kindPhrase(owner), key)
			}
		}
		for _, kind := range []string{"session", "form"} {
			if carries := kinds == nil || kinds[kind]; carries != names(agentNewNodeRule(kind), key) {
				t.Fatalf("the new %s rule and %s: carries %v, named %v", kind, key, carries, !carries)
			}
		}
	}
	contract := &graphContract{Version: 1, Inputs: []graphField{{ID: "brief", Type: "text"}}, Outputs: []graphField{{ID: "page", Type: "html"}}}
	ports := []string{"data", "result", "context", "reference", "audio", "timeline", "clips", "sounds", "pictures", "in:brief", "out:page"}
	for _, n := range []graphNode{{ID: "f", Kind: "form"}, {ID: "e", Kind: "edit"}, {ID: "s", Kind: "session", AgentKind: "llm"}, {ID: "i", Kind: "session", AgentKind: "image"},
		{ID: "v", Kind: "session", AgentKind: mediaKindVideo}, {ID: "m", Kind: "session", AgentKind: mediaKindModel3D}, {ID: "a", Kind: "session", AgentKind: mediaKindAudio},
		{ID: "c", Kind: "session", Contract: contract}, {ID: "x", Kind: "assemble", Contract: contract}} {
		for _, input := range []bool{true, false} {
			names, _ := nodePortNames(n, input)
			for _, port := range ports {
				_, has := nodePort(n, port, input)
				if listed := strings.Contains(" "+strings.Join(names, " ")+" ", " "+port+" "); has != listed {
					t.Fatalf("node %s (%s %s), input %v: port %s is a port %v, listed %v (%v)", n.ID, n.Kind, n.AgentKind, input, port, has, listed, names)
				}
			}
		}
	}
	// A contract of many fields: twelve names, each whole as a wire names it, and a pointer to the rest; a name no
	// wire's id can hold is left out. Read in one pass over the side asked for: tens of thousands of fields on the other
	// side cost nothing (a pass over each side for each name took minutes).
	many := &graphContract{Version: 1}
	for i := 0; i < 40000; i++ {
		many.Inputs = append(many.Inputs, graphField{ID: fmt.Sprintf("input-%05d-%s", i, strings.Repeat("a", 68)), Type: "text"})
		many.Outputs = append(many.Outputs, graphField{ID: fmt.Sprintf("output-%05d", i), Type: "text"})
	}
	began := time.Now()
	reason := portReason(graphNode{ID: "big", Kind: "session", Contract: many}, "out:nope", false)
	if took := time.Since(began); took > 2*time.Second {
		t.Fatalf("a refusal on a node of 40,000 fields took %v", took)
	}
	if !strings.Contains(reason, "its outputs: out:output-00000, ") || !strings.Contains(reason, "out:output-00011 and more (read the node to see them all); name one of them") ||
		strings.Contains(reason, "out:output-00012") {
		t.Fatalf("the outputs of a node of many fields: %s", reason)
	}
	if reason := portReason(graphNode{ID: "big", Kind: "session", Contract: many}, "in:nope", true); !strings.Contains(reason, "in:input-00000-"+strings.Repeat("a", 68)+", ") {
		t.Fatalf("a field id of 80 characters is named whole: %s", reason)
	}
	long := &graphContract{Version: 1, Inputs: []graphField{{ID: strings.Repeat("x", 200), Type: "text"}, {ID: "brief", Type: "text"}}}
	if reason := portReason(graphNode{ID: "c", Kind: "session", Contract: long}, "in:nope", true); !strings.Contains(reason, "its inputs: in:brief and more (read the node") || strings.Contains(reason, "xxxx") {
		t.Fatalf("a port too long for a wire's id: %s", reason)
	}
	if reason := portReason(graphNode{ID: "c", Kind: "session", Contract: &graphContract{Version: 1}}, "in:nope", true); !strings.Contains(reason, "(its contract has no inputs)") {
		t.Fatalf("a contract with no inputs: %s", reason)
	}
	// A part of a reason is read no further than its 80 characters, so a string a document holds at any length (an id,
	// a contract field's type) costs a refusal nothing more, and a cut never splits a character.
	huge := strings.Repeat("规", 4<<20)
	began = time.Now()
	for i := 0; i < 500; i++ {
		_ = reasonBit(huge)
	}
	if took := time.Since(began); took > 2*time.Second || reasonBit(huge) != strings.Repeat("规", 80)+"…" || reasonBit("short") != "short" {
		t.Fatalf("reasonBit: %v for 500 cuts, %q", took, reasonBit(huge)[:12])
	}
	typed := map[string]any{"nodes": []any{map[string]any{"id": "f", "kind": "form"}, map[string]any{"id": "c", "kind": "session",
		"contract": map[string]any{"version": 1, "inputs": []any{map[string]any{"id": "b", "type": strings.Repeat("t", 1<<20)}}, "outputs": []any{}}}}}
	_, why := agentEdge("f:data->c:in:b", mustCanvasJSON(map[string]string{"id": "f:data->c:in:b", "fromNode": "f", "fromPort": "data", "toNode": "c", "toPort": "in:b"}), typed)
	if len(why) > 600 || !strings.Contains(why, "node c's in:b takes "+strings.Repeat("t", 80)+"…;") {
		t.Fatalf("a type of a megabyte in a reason (%d bytes): %.300s", len(why), why)
	}
}

// canvas_connect's change only adds wires, under the canvas row's lock: a wire saved between the tool's read of the
// canvas and its write is not replaced. A change without that mark (a page's, canvas_apply's, an agent's over HTTP) sets
// a wire as it did.
func TestPostgresCanvasConnectNeverReplacesAWire(t *testing.T) {
	lt := newLiveTeam(t)
	ctx := context.Background()
	_, version := lt.document(t)
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"edges", "n2:result->n1:context"},
		map[string]any{"id": "n2:result->n1:context", "fromNode": "n2", "fromPort": "result", "toNode": "n1", "toPort": "context", "dataType": "text", "kind": "feedback"})}, 200)
	_, tokenID := lt.token(t, lt.owner, "Codex", "edit")
	var ownerID string
	if err := lt.h.db.QueryRow(ctx, "SELECT id FROM users WHERE email='live-owner@example.test'").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	actor := canvasActor{Kind: "agent", UserID: ownerID, TokenID: tokenID, ClientID: "t_" + tokenID, Name: "Codex", Port: "mcp"}
	wire := canvasOp{Op: canvasOpSet, Path: []string{"edges", "n2:result->n1:context"},
		Value: mustCanvasJSON(map[string]string{"id": "n2:result->n1:context", "fromNode": "n2", "fromPort": "result", "toNode": "n1", "toPort": "context"})}
	apply := func(ctx context.Context) appliedCanvasChange {
		t.Helper()
		tx, err := lt.h.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		var saved []byte
		if err := tx.QueryRow(ctx, "SELECT document FROM canvases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", lt.tid, lt.cid).Scan(&saved); err != nil {
			t.Fatal(err)
		}
		applied, err := lt.h.a.applyCanvasChange(ctx, tx, lt.tid, lt.cid, saved, []canvasOp{wire}, actor)
		if err != nil {
			t.Fatal(err)
		}
		return applied
	}
	addOnly := context.WithValue(ctx, canvasAddOnlyWires{}, true)
	if got := apply(addOnly); fmt.Sprint(got.results) != "[forbidden]" || len(got.effective) != 0 ||
		got.reasons[0] != "wire n2:result->n1:context: a feedback wire joins these ports already, and connecting only adds; it is left as it is" {
		t.Fatalf("an add-only change over a feedback wire: %v %q %v", got.results, got.reasons, got.effective)
	}
	if got := apply(ctx); fmt.Sprint(got.results) != "[ok]" || len(got.effective) == 0 {
		t.Fatalf("an unmarked set over a wire: %v %v", got.results, got.effective)
	}
	// The same data wire already there: done, nothing changed.
	_, version = lt.document(t)
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"edges", "n2:result->n1:context"},
		map[string]any{"id": "n2:result->n1:context", "fromNode": "n2", "fromPort": "result", "toNode": "n1", "toPort": "context", "dataType": "text"})}, 200)
	if got := apply(addOnly); fmt.Sprint(got.results) != "[ok]" || len(got.effective) != 0 || got.reasons[0] != "" {
		t.Fatalf("an add-only change over the same data wire: %v %q %v", got.results, got.reasons, got.effective)
	}
}

// The server keeps each wire as a page reads it and a canvas run checks it, whoever's change left it otherwise: here a
// node turned into an image node under a wire typed text (a page's own re-typing of the wire refused, or not sent).
func TestPostgresCanvasChangeKeepsWiresTyped(t *testing.T) {
	lt := newLiveTeam(t)
	lt.patch(t, lt.member, 1, []map[string]any{set([]string{"nodes", "n1", "agentKind"}, "image")}, 200)
	doc, _ := lt.document(t)
	edges := doc["edges"].([]any)
	if len(edges) != 1 || edges[0].(map[string]any)["dataType"] != "image" {
		t.Fatalf("the wire out of the image node: %v", edges)
	}
	// A wire into a contract field the node no longer has goes; one the rules cannot judge stays.
	contract := map[string]any{"version": 1, "inputs": []any{map[string]any{"id": "brief", "label": "Brief", "type": "text"}}, "outputs": []any{}}
	_, version := lt.document(t)
	lt.patch(t, lt.owner, version, []map[string]any{
		set([]string{"nodes", "n2", "contract"}, contract),
		set([]string{"edges", "f1:data->n2:in:brief"}, map[string]any{"id": "f1:data->n2:in:brief", "fromNode": "f1", "fromPort": "data", "toNode": "n2", "toPort": "in:brief", "dataType": "text"}),
		set([]string{"edges", "f1:data->n1:mystery"}, map[string]any{"id": "f1:data->n1:mystery", "fromNode": "f1", "fromPort": "data", "toNode": "n1", "toPort": "mystery", "dataType": "text"}),
	}, 200)
	_, version = lt.document(t)
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"nodes", "n2", "contract", "inputs"}, []any{})}, 400)
	lt.patch(t, lt.owner, version, []map[string]any{set([]string{"nodes", "n2", "contract"}, map[string]any{"version": 1, "inputs": []any{}, "outputs": []any{}})}, 200)
	doc, _ = lt.document(t)
	ids := []string{}
	for _, e := range doc["edges"].([]any) {
		ids = append(ids, e.(map[string]any)["id"].(string))
	}
	if strings.Contains(strings.Join(ids, " "), "in:brief") || !strings.Contains(strings.Join(ids, " "), "f1:data->n1:mystery") {
		t.Fatalf("wires after the field went: %v", ids)
	}
}

// An agent's write never shortens its own claim or blanks its note; a change sent again under its id is answered with
// its own results, and the same id asking something else is refused.
func TestPostgresCanvasChangeClaimsAndIdsHold(t *testing.T) {
	lt := newLiveTeam(t)
	token, _ := lt.token(t, lt.owner, "Claude Code", "edit")
	lt.bearer(t, token, "POST", lt.prefix+"/live/claims", map[string]any{"nodeIds": []string{"n1"}, "ttlSeconds": 600, "note": "writing the backend"}, 200, "")
	_, version := lt.document(t)
	lt.bearer(t, token, "PATCH", lt.prefix, map[string]any{"baseVersion": version, "ops": []map[string]any{set([]string{"nodes", "n1", "title"}, "Plan by the agent")}}, 200, "")
	var left float64
	var note string
	if err := lt.h.db.QueryRow(context.Background(), "SELECT extract(epoch FROM expires_at-clock_timestamp()),note FROM canvas_claims WHERE tenant_id=$1 AND canvas_id=$2 AND node_id='n1'", lt.tid, lt.cid).Scan(&left, &note); err != nil || left < 500 || note != "writing the backend" {
		t.Fatalf("the agent's claim after its write: %.0f s, %q, %v", left, note, err)
	}
	_, version = lt.document(t)
	first := lt.patch(t, lt.member, version, []map[string]any{set([]string{"nodes", "n2", "title"}, "Once")}, 200, map[string]any{"changeId": "change-0001"})
	again := lt.patch(t, lt.member, version, []map[string]any{set([]string{"nodes", "n2", "title"}, "Once")}, 200, map[string]any{"changeId": "change-0001"})
	if again["duplicate"] != true || fmt.Sprint(again["results"]) != fmt.Sprint(first["results"]) || again["version"] != first["version"] {
		t.Fatalf("a change sent again: %v (first %v)", again, first)
	}
	other := lt.patch(t, lt.member, version, []map[string]any{set([]string{"nodes", "n2", "title"}, "Something else")}, 409, map[string]any{"changeId": "change-0001"})
	if other["error"].(map[string]any)["code"] != "idempotency_conflict" {
		t.Fatalf("the same id asking something else: %v", other)
	}
}
