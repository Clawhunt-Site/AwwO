package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestFrozenMessageOutputContractSanitizesAndChecksMachineShape(t *testing.T) {
	frozen, _ := json.Marshal(graphContract{Version: 1, Outputs: []graphField{
		{ID: "result", Label: "本次结果", Type: "markdown", Required: true, Value: "private saved draft", Help: "private guidance"},
	}})
	machine, _ := json.Marshal(outputContract{Version: 1, Fields: []outputContractField{{ID: "result", Type: "markdown", Required: true}}})
	contract, ok := frozenMessageOutputContract(frozen, machine, true)
	if !ok || contract.Version != 1 || len(contract.Inputs) != 0 || len(contract.Outputs) != 1 ||
		contract.Outputs[0].Label != "本次结果" || contract.Outputs[0].Value != "" {
		t.Fatal("frozen contract was not safely projected", contract, ok)
	}
	raw, _ := json.Marshal(contract)
	if !json.Valid(raw) || strings.Contains(string(raw), "private") {
		t.Fatal("saved value or guidance leaked", string(raw))
	}
	for name, test := range map[string]struct {
		frozen, machine json.RawMessage
		machinePresent  bool
	}{
		"missing snapshot":       {frozen: nil},
		"invalid snapshot":       {frozen: json.RawMessage(`{"version":2,"outputs":[]}`)},
		"machine null":           {frozen: frozen, machine: json.RawMessage(`null`), machinePresent: true},
		"machine differs":        {frozen: frozen, machine: json.RawMessage(`{"version":1,"fields":[{"id":"other","type":"markdown","required":true}]}`), machinePresent: true},
		"duplicate output field": {frozen: json.RawMessage(`{"version":1,"outputs":[{"id":"x","type":"text"},{"id":"x","type":"text"}]}`)},
	} {
		t.Run(name, func(t *testing.T) {
			if projected, valid := frozenMessageOutputContract(test.frozen, test.machine, test.machinePresent); valid || projected != nil {
				t.Fatal("untrusted historical shape projected", projected)
			}
		})
	}
	if _, ok := frozenMessageOutputContract(frozen, nil, false); !ok {
		t.Fatal("optional machine schema incorrectly required for a frozen graph contract")
	}
}

func TestMessageOutputStateRequiresCommittedNodeDelivery(t *testing.T) {
	for _, test := range []struct{ run, node, want string }{
		{"completed", "done", "final"},
		{"completed", "running", "streaming"},
		{"completed", "failed", "failed"},
		{"completed", "blocked", "failed"},
		{"running", "done", "streaming"},
		{"failed", "done", "failed"},
		{"cancelled", "running", "failed"},
		{"interrupted", "waiting", "failed"},
	} {
		if got := messageOutputState(test.run, test.node); got != test.want {
			t.Fatalf("run=%s node=%s: got %s, want %s", test.run, test.node, got, test.want)
		}
	}
}

func expectSuppressedGraphPresentation(t *testing.T, message map[string]any) {
	t.Helper()
	value, present := message["presentation"]
	if !present || value != nil {
		t.Fatal("graph-associated turn must explicitly suppress stale local presentation", message)
	}
}

func TestPostgresMessagePresentationUsesFrozenGraphAndRunIdentity(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) { completePi(w, "UNUSED") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, actor := h.register(t, "history-projection@example.test")
	foreign, _, _ := h.register(t, "history-projection-foreign@example.test")
	cid, original := graphFixture(t, h, c, tid)
	agentID := original["nodes"].([]any)[0].(map[string]any)["binding"].(map[string]string)["agentId"]
	ctx := context.Background()
	prefix := "/tenants/" + tid
	sid, otherSID, rid, gid := randomID(), randomID(), randomID(), randomID()
	for _, item := range []struct{ id, node string }{{sid, "a"}, {otherSID, "b"}} {
		if _, err := h.db.Exec(ctx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title) VALUES($1,$2,$3,$4,$5,$4)", item.id, tid, cid, item.node, agentID); err != nil {
			t.Fatal(err)
		}
	}
	frozenDoc := map[string]any{"nodes": []any{map[string]any{"id": "a", "kind": "session", "contract": graphContract{
		Version: 1, Outputs: []graphField{{ID: "result", Label: "冻结结果", Type: "markdown", Required: true, Value: "SAVED-SECRET"}},
	}}}, "edges": []any{}}
	doc, _ := json.Marshal(frozenDoc)
	if _, err := h.db.Exec(ctx, `INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status)
		VALUES($1,$2,$3,$4,$1,'hash',1,$5,'["a"]','completed')`, gid, tid, cid, actor, doc); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,execution_snapshot)
		VALUES($1,$2,$3,$1,'hash','prompt','completed',$4,'{"runtime":"pi"}')`, rid, tid, sid, `{"result":"## 真实交付"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, `INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,session_id,run_id,execution_snapshot)
		VALUES($1,$2,'a',0,'done',$3,$4,'{"runtime":"pi"}')`, tid, gid, sid, rid); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ session, role, content string }{
		{sid, "user", "prompt"}, {sid, "assistant", `{"result":"## 真实交付"}`},
		{otherSID, "assistant", `{"result":"WRONG SESSION"}`},
	} {
		if _, err := h.db.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,$5,$6)", randomID(), tid, item.session, rid, item.role, item.content); err != nil {
			t.Fatal(err)
		}
	}
	path := prefix + "/sessions/" + sid + "/messages"
	h.request(t, foreign, "GET", path, nil, 404)
	items := h.request(t, c, "GET", path, nil, 200)["items"].([]any)
	if len(items) != 2 {
		t.Fatal("expected one user and one assistant turn", items)
	}
	if _, present := items[0].(map[string]any)["presentation"]; present {
		t.Fatal("user input acquired an output contract", items)
	}
	message := items[1].(map[string]any)
	presentation, ok := message["presentation"].(map[string]any)
	if !ok || presentation["runId"] != rid || presentation["sessionId"] != sid || presentation["nodeId"] != "a" || presentation["outputState"] != "final" {
		t.Fatal("missing precise run projection", message)
	}
	contract := presentation["outputContract"].(map[string]any)
	fields := contract["outputs"].([]any)
	if len(fields) != 1 || fields[0].(map[string]any)["label"] != "冻结结果" || fields[0].(map[string]any)["value"] != "" ||
		message["content"] != `{"result":"## 真实交付"}` {
		t.Fatal("history changed raw output or leaked saved form values", message)
	}
	other := h.request(t, c, "GET", prefix+"/sessions/"+otherSID+"/messages", nil, 200)["items"].([]any)
	if len(other) != 1 {
		t.Fatal("wrong-session message missing", other)
	}
	_, otherHasPresentation := other[0].(map[string]any)["presentation"]
	if otherHasPresentation {
		t.Fatal("a run projected onto another session", other)
	}
	// The current canvas is editable; changing it must not change this run's display contract.
	if _, err := h.db.Exec(ctx, `UPDATE canvases SET document='{"nodes":[{"id":"a","kind":"session","contract":{"version":1,"outputs":[{"id":"changed","label":"CURRENT CANVAS","type":"text"}]}}]}' WHERE tenant_id=$1 AND id=$2`, tid, cid); err != nil {
		t.Fatal(err)
	}
	items = h.request(t, c, "GET", path, nil, 200)["items"].([]any)
	if items[1].(map[string]any)["presentation"].(map[string]any)["outputContract"].(map[string]any)["outputs"].([]any)[0].(map[string]any)["label"] != "冻结结果" {
		t.Fatal("current canvas contract overrode run admission", items)
	}
	for name, test := range map[string]struct{ statement, id string }{
		"missing snapshot":  {`UPDATE runs SET execution_snapshot='{}' WHERE id=$1`, rid},
		"machine mismatch":  {`UPDATE runs SET execution_snapshot='{"runtime":"pi","outputContract":{"version":1,"fields":[{"id":"wrong","type":"markdown","required":true}]}}' WHERE id=$1`, rid},
		"wrong node kind":   {`UPDATE graph_runs SET document='{"nodes":[{"id":"a","kind":"form","contract":{"version":1,"outputs":[{"id":"result","type":"markdown"}]}}]}' WHERE id=$1`, gid},
		"duplicate node id": {`UPDATE graph_runs SET document='{"nodes":[{"id":"a","kind":"session","contract":{"version":1,"outputs":[{"id":"result","type":"markdown"}]}},{"id":"a","kind":"session","contract":{"version":1,"outputs":[{"id":"result","type":"markdown"}]}}]}' WHERE id=$1`, gid},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := h.db.Exec(ctx, test.statement, test.id); err != nil {
				t.Fatal(err)
			}
			messages := h.request(t, c, "GET", path, nil, 200)["items"].([]any)
			expectSuppressedGraphPresentation(t, messages[1].(map[string]any))
			if _, err := h.db.Exec(ctx, "UPDATE runs SET execution_snapshot='{\"runtime\":\"pi\"}' WHERE id=$1", rid); err != nil {
				t.Fatal(err)
			}
			if _, err := h.db.Exec(ctx, "UPDATE graph_runs SET document=$2 WHERE id=$1", gid, doc); err != nil {
				t.Fatal(err)
			}
		})
	}
	for status, want := range map[string]string{"failed": "failed", "cancelled": "failed", "running": "streaming"} {
		if _, err := h.db.Exec(ctx, "UPDATE runs SET status=$2 WHERE id=$1", rid, status); err != nil {
			t.Fatal(err)
		}
		message := h.request(t, c, "GET", path, nil, 200)["items"].([]any)[1].(map[string]any)
		if message["presentation"].(map[string]any)["outputState"] != want {
			t.Fatal("run status misrepresented", status, message)
		}
	}
	if _, err := h.db.Exec(ctx, "UPDATE runs SET status='completed' WHERE id=$1", rid); err != nil {
		t.Fatal(err)
	}
	for nodeState, want := range map[string]string{"running": "streaming", "failed": "failed", "done": "final"} {
		if _, err := h.db.Exec(ctx, "UPDATE graph_run_nodes SET state=$2 WHERE graph_id=$1 AND node_id='a'", gid, nodeState); err != nil {
			t.Fatal(err)
		}
		message := h.request(t, c, "GET", path, nil, 200)["items"].([]any)[1].(map[string]any)
		if message["presentation"].(map[string]any)["outputState"] != want {
			t.Fatal("node delivery state misrepresented", nodeState, message)
		}
	}
	if _, err := h.db.Exec(ctx, "UPDATE graph_run_nodes SET state='done' WHERE graph_id=$1 AND node_id='a'", gid); err != nil {
		t.Fatal(err)
	}
	manualID := randomID()
	if _, err := h.db.Exec(ctx, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,execution_snapshot)
		VALUES($1,$2,$3,$1,'hash','manual','completed','{"result":"chat"}','{"runtime":"pi"}')`, manualID, tid, sid); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'assistant',$5)", randomID(), tid, sid, manualID, `{"result":"chat"}`); err != nil {
		t.Fatal(err)
	}
	for _, raw := range h.request(t, c, "GET", path, nil, 200)["items"].([]any) {
		item := raw.(map[string]any)
		if item["runId"] == manualID {
			if _, present := item["presentation"]; present {
				t.Fatal("manual chat inherited graph presentation metadata", item)
			}
		}
	}
	// A collaboration run's candidate and review text are discussion. Only the
	// synthesizer's completed final turn is a graph delivery.
	if _, err := h.db.Exec(ctx, `UPDATE graph_runs SET collaboration='{"goal":"x","rounds":1,"synthesizerNodeId":"a"}' WHERE id=$1`, gid); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, `INSERT INTO graph_collaboration_turns(tenant_id,graph_id,ordinal,node_id,phase,round,state,run_id)
		VALUES($1,$2,1,'a','synthesis',1,'completed',$3)`, tid, gid, rid); err != nil {
		t.Fatal(err)
	}
	readGraphTurn := func(t *testing.T) map[string]any {
		t.Helper()
		for _, raw := range h.request(t, c, "GET", path, nil, 200)["items"].([]any) {
			item := raw.(map[string]any)
			if item["runId"] == rid && item["role"] == "assistant" {
				return item
			}
		}
		t.Fatal("graph assistant turn missing")
		return nil
	}
	if got := readGraphTurn(t)["presentation"].(map[string]any)["outputState"]; got != "final" {
		t.Fatal("completed synthesis not projected", got)
	}
	for _, phase := range []string{"proposal", "review"} {
		if _, err := h.db.Exec(ctx, "UPDATE graph_collaboration_turns SET phase=$2 WHERE graph_id=$1 AND ordinal=1", gid, phase); err != nil {
			t.Fatal(err)
		}
		expectSuppressedGraphPresentation(t, readGraphTurn(t))
	}
	if _, err := h.db.Exec(ctx, "UPDATE graph_collaboration_turns SET phase='synthesis' WHERE graph_id=$1 AND ordinal=1", gid); err != nil {
		t.Fatal(err)
	}
	for _, graphState := range []string{"running", "failed", "cancelled"} {
		if _, err := h.db.Exec(ctx, "UPDATE graph_runs SET status=$2 WHERE id=$1", gid, graphState); err != nil {
			t.Fatal(err)
		}
		expectSuppressedGraphPresentation(t, readGraphTurn(t))
	}
	if _, err := h.db.Exec(ctx, "UPDATE graph_runs SET status='completed' WHERE id=$1", gid); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(ctx, "UPDATE graph_run_nodes SET run_id=$2 WHERE graph_id=$1 AND node_id='a'", gid, manualID); err != nil {
		t.Fatal(err)
	}
	expectSuppressedGraphPresentation(t, readGraphTurn(t))
}
