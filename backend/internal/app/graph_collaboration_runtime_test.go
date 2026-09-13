package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// Exercise the merge boundary: selected-node discussion uses both runtimes,
// freezes HTML delivery policy, and records every proposal/review/synthesis.
func TestPostgresCollaborationMixedRuntimeFrozenHTMLPolicy(t *testing.T) {
	const html = "<html><head></head><body>FINAL-HTML</body></html>"
	var mu sync.Mutex
	var calls []runtimeCall
	var h *harness
	var tid, author string
	handle := func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
		mu.Lock()
		calls = append(calls, call)
		count := len(calls)
		mu.Unlock()
		review := strings.HasPrefix(call.Prompt, "[AwwO collaboration review ")
		if review {
			if !strings.Contains(call.SystemPrompt, "Return Markdown critique only") || strings.Contains(call.SystemPrompt, "Frozen graph output contract") {
				t.Error("delivery envelope overrode discussion", call.SystemPrompt)
			}
		} else if !strings.Contains(call.SystemPrompt, "Frozen graph output contract") || !strings.Contains(call.SystemPrompt, "complete HTML document") {
			t.Error("proposal or synthesis lost HTML delivery policy", call.SystemPrompt)
		}
		marker := "AUTHOR-PERSONA"
		if call.Runtime == runtimeOpenAIAgents {
			marker = "REVIEWER-PERSONA"
		}
		if !strings.Contains(call.SystemPrompt, marker) || strings.Contains(call.SystemPrompt, "MUTATED-PERSONA") {
			t.Error("frozen runtime persona lost", call.SystemPrompt)
		}
		if count == 1 {
			// Later turns must keep the admission snapshot after configuration edits.
			if _, err := h.db.Exec(r.Context(), "UPDATE agents SET instructions='MUTATED-PERSONA' WHERE tenant_id=$1 AND id=$2", tid, author); err != nil {
				t.Error(err)
			}
		}
		if review {
			completePi(w, "Markdown critique: retain the validated HTML.")
		} else {
			completePi(w, html)
		}
	}
	pi := runtimeProvider(t, runtimePI, handle)
	defer pi.Close()
	oa := runtimeProvider(t, runtimeOpenAIAgents, handle)
	defer oa.Close()
	h = newHarness(t, pi.URL)
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = oa.URL, strings.Repeat("o", 32)
	c, tenantID, _ := h.register(t, "merge-collaboration-runtime@example.test")
	tid = tenantID
	prefix := "/tenants/" + tid
	nodes := []any{}
	for i, runtime := range []string{runtimePI, runtimeOpenAIAgents} {
		id, model, persona := "author", "test-model", "AUTHOR-PERSONA"
		if i == 1 {
			id, model, persona = "reviewer", "oa-default", "REVIEWER-PERSONA"
		}
		aid := h.request(t, c, "POST", prefix+"/agents", map[string]string{"name": id, "adapterType": runtime, "model": model, "instructions": persona + ": Return concise text, no JSON."}, 201)["id"].(string)
		if i == 0 {
			author = aid
		}
		nodes = append(nodes, map[string]any{"id": id, "kind": "session", "title": id, "runtime": runtime, "binding": map[string]string{"companyId": tid, "agentId": aid}, "contract": graphContract{Version: 1, Outputs: []graphField{{ID: "page", Type: "html", Required: true}}}})
	}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Merge regression", "document": map[string]any{"nodes": nodes, "edges": []any{}}}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	accepted := h.request(t, c, "POST", base, map[string]any{"operationId": "merge-mixed-collaboration", "scope": []string{"author", "reviewer"}, "collaboration": collaborationPolicy{Goal: "Validate a complete HTML deliverable", Rounds: 1, SynthesizerNodeID: "author"}}, 202)
	gid := accepted["id"].(string)
	done := awaitGraph(t, h, c, base+"/"+gid, "completed")
	turns := done["collaboration"].(map[string]any)["turns"].([]any)
	if len(turns) != 5 {
		t.Fatal("unexpected collaboration plan", turns)
	}
	for _, v := range turns {
		turn := v.(map[string]any)
		if turn["status"] != "completed" {
			t.Fatal("incomplete phase", turn)
		}
		var snap executionSnapshot
		var raw []byte
		if err := h.db.QueryRow(context.Background(), "SELECT execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", tid, turn["runId"]).Scan(&raw); err != nil || json.Unmarshal(raw, &snap) != nil {
			t.Fatal("missing durable turn snapshot", err)
		}
		if strings.Contains(snap.OutputPolicy, "collaboration review policy") != (turn["phase"] == "review") {
			t.Fatal("phase policy not persisted", turn, snap.OutputPolicy)
		}
	}
	for _, v := range done["nodes"].([]any) {
		n := v.(map[string]any)
		if n["output"] != html || n["partial"] != (n["nodeId"] != "author") {
			t.Fatal("critique published as final deliverable", n)
		}
	}
	var total, piCalls, oaCalls int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*),count(*) FILTER(WHERE runtime='pi'),count(*) FILTER(WHERE runtime='openai-agents') FROM model_invocations WHERE tenant_id=$1", tid).Scan(&total, &piCalls, &oaCalls); err != nil || total != 5 || piCalls != 3 || oaCalls != 2 {
		t.Fatal("collaboration invocation ledger missing or duplicated", total, piCalls, oaCalls, err)
	}
}
