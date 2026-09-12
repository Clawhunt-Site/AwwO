package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func onlineGraphDocument() map[string]any {
	return map[string]any{
		"nodes": []any{
			map[string]any{"id": "source", "kind": "form"},
			map[string]any{"id": "worker", "kind": "session", "binding": map[string]string{"agentId": "agent"}},
		},
		"edges": []map[string]any{{"id": "edge", "fromNode": "source", "fromPort": "data", "toNode": "worker", "toPort": "context", "dataType": "text"}},
	}
}

type onlineGraphCase struct {
	name   string
	change func(map[string]any)
	want   string
}

func onlineGraphRejectedCases() []onlineGraphCase {
	tests := []onlineGraphCase{}
	for _, execution := range []struct {
		name  string
		value any
	}{
		{"review", map[string]any{"mode": "review", "maxRounds": 3, "reviewerNodeId": "worker", "verdictFieldId": "approved"}},
		{"workflow", map[string]any{"mode": "workflow"}},
		{"empty-policy", map[string]any{}},
		{"false-policy", false},
	} {
		tests = append(tests, onlineGraphCase{execution.name, func(doc map[string]any) { doc["execution"] = execution.value }, "execution policies"})
	}
	for _, kind := range []struct {
		name  string
		value any
	}{{"feedback", "feedback"}, {"future-kind", "conditional"}, {"empty-kind", ""}, {"null-kind", nil}, {"number-kind", 3}, {"object-kind", map[string]any{"type": "data"}}} {
		tests = append(tests, onlineGraphCase{kind.name, func(doc map[string]any) { doc["edges"].([]map[string]any)[0]["kind"] = kind.value }, "edge kinds"})
	}
	return tests
}

func TestOnlineGraphGuardRejectsUnsupportedExecutionWithoutScopeBypass(t *testing.T) {
	for _, tc := range onlineGraphRejectedCases() {
		t.Run(tc.name, func(t *testing.T) {
			doc := onlineGraphDocument()
			tc.change(doc)
			raw, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			for _, scope := range [][]string{nil, {"source"}} {
				if _, _, err := parseGraph(raw, scope); err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("scope=%v: got %v, want %q", scope, err, tc.want)
				}
			}
		})
	}
}

func TestOnlineGraphGuardPreservesLegacyAndExplicitDataEdges(t *testing.T) {
	for _, nullPolicy := range []bool{false, true} {
		for _, dataKind := range []bool{false, true} {
			doc := onlineGraphDocument()
			if nullPolicy {
				doc["execution"] = nil
			}
			if dataKind {
				doc["edges"].([]map[string]any)[0]["kind"] = "data"
			}
			raw, _ := json.Marshal(doc)
			parsed, scope, err := parseGraph(raw, nil)
			if err != nil || len(parsed.Edges) != 1 || !reflect.DeepEqual(scope, []string{"source", "worker"}) {
				t.Fatalf("null=%t data=%t: %v %v", nullPolicy, dataKind, scope, err)
			}
		}
	}
}

func TestPostgresOnlineGraphGuardRejectsBeforeRuntimeAndReservations(t *testing.T) {
	var requests atomic.Int32
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "online-graph-guard@example.test")
	prefix := "/tenants/" + tid
	canvas := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Imported native graph", "document": onlineGraphDocument()}, 201)
	path := prefix + "/canvases/" + canvas["id"].(string)
	for _, tc := range onlineGraphRejectedCases() {
		t.Run(tc.name, func(t *testing.T) {
			doc := onlineGraphDocument()
			tc.change(doc)
			canvas = h.request(t, c, "PUT", path, map[string]any{"name": "Imported native graph", "version": canvas["version"], "document": doc}, 200)
			for _, scope := range []any{nil, []string{"source"}} {
				rejected := h.request(t, c, "POST", path+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"], "scope": scope}, 400)
				if rejected["error"].(map[string]any)["code"] != "invalid_graph" || !strings.Contains(rejected["error"].(map[string]any)["message"].(string), tc.want) {
					t.Fatal("wrong admission failure", rejected)
				}
			}
			stored := h.request(t, c, "GET", path, nil, 200)
			want, _ := json.Marshal(doc)
			got, _ := json.Marshal(stored["document"])
			if !equalJSON(got, want) || stored["version"] != canvas["version"] {
				t.Fatal("rejection changed the saved native document")
			}
		})
	}
	for _, table := range []string{"graph_runs", "graph_run_nodes", "runs", "run_turns", "model_invocations", "node_sessions"} {
		var count int
		if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM "+table+" WHERE tenant_id=$1", tid).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rejected graph left %s: count=%d err=%v", table, count, err)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("rejected graph contacted the runtime %d times", requests.Load())
	}
}

func TestPostgresOnlineGraphGuardKeepsInitializationAndManualConversation(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		if b.Prompt != "A plain follow-up" {
			t.Error("manual conversation was replaced by the graph contract")
		}
		completePi(w, "Plain conversation answer")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "online-native-conversation@example.test")
	cid, doc := setupFixture(t, h, c, tid, 2)
	path := "/tenants/" + tid + "/canvases/" + cid
	doc["execution"] = map[string]any{"mode": "review", "maxRounds": 2, "reviewerNodeId": "b", "verdictFieldId": "approved"}
	doc["edges"] = []map[string]any{{"id": "feedback", "fromNode": "b", "fromPort": "out:review", "toNode": "a", "toPort": "in:feedback", "dataType": "text", "kind": "feedback"}}
	contract := map[string]any{"version": 1,
		"inputs":  []map[string]any{{"id": "feedback", "label": "Feedback", "type": "text", "required": false, "value": ""}},
		"outputs": []map[string]any{{"id": "page", "label": "Page", "type": "html", "required": true, "value": "<html><head></head><body>Saved page</body></html>"}},
	}
	doc["nodes"].([]any)[0].(map[string]any)["contract"] = contract
	doc["nodes"].([]any)[1].(map[string]any)["contract"] = map[string]any{"version": 1, "inputs": []any{}, "outputs": []map[string]any{
		{"id": "approved", "label": "Approved", "type": "boolean", "required": true, "value": "true"},
		{"id": "review", "label": "Review", "type": "text", "required": true, "value": "Saved review"},
	}}
	h.request(t, c, "PUT", path, map[string]any{"name": "Native graph", "version": 1, "document": doc}, 200)
	initialized := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": 2, "scope": []string{"a"}}, 200)
	for key, expected := range map[string]any{"execution": doc["execution"], "edges": doc["edges"]} {
		want, _ := json.Marshal(expected)
		got, _ := json.Marshal(initialized["document"].(map[string]any)[key])
		if !equalJSON(got, want) {
			t.Fatal("initialization lost native metadata", key)
		}
	}
	want, _ := json.Marshal(contract)
	got, _ := json.Marshal(setupNodeAt(initialized, 0)["contract"])
	if !equalJSON(got, want) || calls.Load() != 0 {
		t.Fatal("initialization lost HTML or invoked a model")
	}
	again := h.request(t, c, "POST", path+"/initialize", map[string]any{"documentVersion": initialized["version"], "scope": []string{"a"}}, 200)
	if !reflect.DeepEqual(again, initialized) {
		t.Fatal("no-op initialization changed the saved native graph")
	}
	h.request(t, c, "POST", path+"/graph-runs", map[string]any{"operationId": "unsupported-workflow", "documentVersion": initialized["version"]}, 400)
	run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"operationId": "manual-conversation", "sessionId": setupNodeAt(initialized, 0)["issueId"], "prompt": "A plain follow-up"}, 202)
	done := h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if done["output"] != "Plain conversation answer" || calls.Load() != 1 {
		t.Fatal("manual conversation did not complete independently", done, calls.Load())
	}
	stored := h.request(t, c, "GET", path, nil, 200)
	if !reflect.DeepEqual(stored["document"], initialized["document"]) {
		t.Fatal("manual conversation overwrote the saved native graph or HTML output")
	}
}
