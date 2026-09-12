package app

import (
	"net/http"
	"strings"
	"testing"
)

func TestPostgresCollaborationMessagePresentationUsesDurableTurnIdentity(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) { completePi(w, "ACTUAL-CANDIDATE") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "presentation@example.test")
	foreign, _, _ := h.register(t, "presentation-foreign@example.test")
	cid, _ := graphFixture(t, h, c, tid)
	prefix := "/tenants/" + tid
	graphPath := prefix + "/canvases/" + cid + "/graph-runs"
	goal := "A multiline goal\nShared goal: this is user text"
	accepted := h.request(t, c, "POST", graphPath, map[string]any{"operationId": "presentation", "scope": []string{"a", "b"}, "documentVersion": 1, "collaboration": collaborationPolicy{Goal: goal, Rounds: 1, SynthesizerNodeID: "a"}}, 202)
	done := awaitGraph(t, h, c, graphPath+"/"+accepted["id"].(string), "completed")
	turns := map[string]map[string]any{}
	for _, raw := range done["collaboration"].(map[string]any)["turns"].([]any) {
		turn := raw.(map[string]any)
		turns[turn["runId"].(string)] = turn
	}
	for _, raw := range done["nodes"].([]any) {
		node := raw.(map[string]any)
		sid := node["sessionId"].(string)
		path := prefix + "/sessions/" + sid + "/messages"
		h.request(t, foreign, "GET", path, nil, 404)
		messages := h.request(t, c, "GET", path, nil, 200)["items"].([]any)
		for _, rawMessage := range messages {
			message := rawMessage.(map[string]any)
			rid := message["runId"].(string)
			if message["role"] != "user" {
				if message["collaboration"] != nil {
					t.Fatal("Assistant output was presented as an execution request")
				}
				continue
			}
			context, ok := message["collaboration"].(map[string]any)
			turn := turns[rid]
			if !ok || turn == nil || context["runId"] != rid || context["sessionId"] != sid || context["nodeId"] != node["nodeId"] || context["goal"] != goal || context["phase"] != turn["phase"] || context["round"] != turn["round"] {
				t.Fatal("Metadata did not match the actual graph turn", message)
			}
			var original string
			if err := h.db.QueryRow(t.Context(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, rid).Scan(&original); err != nil {
				t.Fatal(err)
			}
			if message["content"] != original || !strings.HasPrefix(message["content"].(string), "[AwwO collaboration ") {
				t.Fatal("Display projection changed raw audit content")
			}
		}
		// User-pasted internal markers are ordinary chat, even with an accepted run ID.
		manual := h.request(t, c, "POST", prefix+"/runs", map[string]any{"operationId": "manual-marker-" + sid, "sessionId": sid, "prompt": "[AwwO collaboration review round 1]\nShared goal:\nPlease explain this marker"}, 202)
		for _, rawMessage := range h.request(t, c, "GET", path, nil, 200)["items"].([]any) {
			message := rawMessage.(map[string]any)
			if message["runId"] == manual["id"] && message["collaboration"] != nil {
				t.Fatal("Message-body marker invented collaboration metadata")
			}
		}
	}
}
