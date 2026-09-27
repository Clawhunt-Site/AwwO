package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testTaskFrame() *taskFrame {
	return &taskFrame{Version: 1, Source: "manual", Constraints: []string{"  保留原文\nEXACT-CONSTRAINT 😀  "}, AcceptanceCriteria: []string{"Provide actual evidence, not a success claim."}}
}

func TestTaskFrameStrictParsingAndExactText(t *testing.T) {
	frame := testTaskFrame()
	frame.Constraints = append(frame.Constraints, " \t\n")
	raw, _ := json.Marshal(frame)
	parsed, err := parseTaskFrame(raw)
	if err != nil || len(parsed.Constraints) != 1 || parsed.Constraints[0] != frame.Constraints[0] {
		t.Fatal("authored text changed", parsed, err)
	}
	for _, invalid := range []string{
		`null`, `[]`, `{}`, `{"version":2,"source":"manual","constraints":[],"acceptanceCriteria":[]}`,
		`{"version":1,"source":"model","constraints":[],"acceptanceCriteria":[]}`,
		`{"version":1,"source":"manual","constraints":null,"acceptanceCriteria":[]}`,
		`{"version":1,"source":"manual","constraints":[null],"acceptanceCriteria":[]}`,
		`{"version":1,"source":"manual","constraints":[42],"acceptanceCriteria":[]}`,
		`{"version":1,"source":"manual","constraints":[],"acceptanceCriteria":[],"approved":true}`,
	} {
		if _, err := parseTaskFrame([]byte(invalid)); err == nil {
			t.Errorf("accepted invalid frame %s", invalid)
		}
	}
	for _, count := range []int{2000, 2001} {
		frame := testTaskFrame()
		frame.Constraints = []string{strings.Repeat("😀", count)}
		raw, _ := json.Marshal(frame)
		_, err := parseTaskFrame(raw)
		if (err == nil) != (count == 2000) {
			t.Errorf("Unicode item bound %d: %v", count, err)
		}
	}
	for _, count := range []int{20, 21} {
		frame := testTaskFrame()
		frame.Constraints = make([]string, count)
		for i := range frame.Constraints {
			frame.Constraints[i] = "nonblank"
		}
		raw, _ := json.Marshal(frame)
		_, err := parseTaskFrame(raw)
		if (err == nil) != (count == 20) {
			t.Errorf("list bound %d: %v", count, err)
		}
	}
	for _, extra := range []string{"", "x"} {
		frame := &taskFrame{Version: 1, Source: "manual", Constraints: []string{}, AcceptanceCriteria: []string{extra}}
		for i := 0; i < 6; i++ {
			frame.Constraints = append(frame.Constraints, strings.Repeat("中", 2000))
		}
		raw, _ := json.Marshal(frame)
		_, err := parseTaskFrame(raw)
		if (err == nil) != (extra == "") {
			t.Errorf("total bound: %v", err)
		}
	}
}

func TestTaskFramePreservesLegacyAndSnapshot(t *testing.T) {
	if taskFrameSystemPrompt("unchanged", nil) != "unchanged" {
		t.Fatal("legacy prompt changed")
	}
	if taskFrameSystemPrompt("unchanged", &taskFrame{Version: 1, Source: "manual", Constraints: []string{}, AcceptanceCriteria: []string{}}) != "unchanged" {
		t.Fatal("cleared requirements added prompt overhead")
	}
	legacy, _ := json.Marshal(executionSnapshot{})
	if strings.Contains(string(legacy), "taskFrame") {
		t.Fatal("legacy snapshot gained field")
	}
	frame := testTaskFrame()
	raw, _ := json.Marshal(executionSnapshot{TaskFrame: frame})
	var frozen executionSnapshot
	if err := json.Unmarshal(raw, &frozen); err != nil {
		t.Fatal(err)
	}
	frame.Constraints[0] = "MUTATED"
	if frozen.TaskFrame.Constraints[0] == "MUTATED" {
		t.Fatal("snapshot shares mutable state")
	}
	system := taskFrameSystemPrompt("persona", frozen.TaskFrame)
	if !strings.Contains(system, "not evidence of completion") || !strings.Contains(system, "EXACT-CONSTRAINT") {
		t.Fatal(system)
	}
	team := fixtureTeam("sequential")
	snap := executionSnapshot{Instructions: "persona", TaskFrame: frozen.TaskFrame}
	input := teamTurnInput{Task: "task", Purpose: "work"}
	_, system, _, _, err := prepareTeamInput(snap, team.Members[0], input, 262144, 32)
	if err != nil || strings.Count(system, "Manual task requirements") != 1 {
		t.Fatal("team frame missing/duplicated", err, system)
	}
	if _, _, _, _, err = prepareTeamInput(snap, team.Members[0], input, len(system)+len(input.Task)+31, 32); err == nil {
		t.Fatal("team frame escaped budget")
	}
}

func TestTaskFrameOldClientPreservation(t *testing.T) {
	frame, _ := json.Marshal(testTaskFrame())
	saved := json.RawMessage(`{"nodes":[{"id":"n","kind":"session","taskFrame":` + string(frame) + `}],"extra":"keep"}`)
	oldClient := json.RawMessage(`{"nodes":[{"id":"n","kind":"session","title":"changed"}],"extra":"keep"}`)
	merged := preserveCanvasTaskFrames(saved, oldClient)
	got, err := savedNodeTaskFrame(merged, "n")
	if err != nil || got == nil || got.Constraints[0] != testTaskFrame().Constraints[0] {
		t.Fatal("legacy save lost frame", string(merged), err)
	}
	empty := json.RawMessage(`{"nodes":[{"id":"n","kind":"session","taskFrame":{"version":1,"source":"manual","constraints":[],"acceptanceCriteria":[]}}]}`)
	cleared, err := savedNodeTaskFrame(preserveCanvasTaskFrames(saved, empty), "n")
	if err != nil || len(cleared.Constraints) != 0 {
		t.Fatal("explicit clear ignored", err)
	}
	deleted := json.RawMessage(`{"nodes":[]}`)
	if string(preserveCanvasTaskFrames(saved, deleted)) != string(deleted) {
		t.Fatal("deleted node resurrected")
	}
}

func TestPostgresTaskFrameSavedAdmissionAndFrozenDispatch(t *testing.T) {
	for _, mode := range []string{"single", "team", "graph", "graph-team"} {
		t.Run(mode, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var once, releaseOnce sync.Once
			pi := runtimeProvider(t, runtimePI, func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				if strings.Count(call.SystemPrompt, "Manual task requirements") != 1 || !strings.Contains(call.SystemPrompt, "EXACT-CONSTRAINT") || strings.Contains(call.SystemPrompt, "MUTATED") {
					t.Error("worker lost frozen task frame", call.SystemPrompt)
				}
				_, framed := splitTaskFramePrompt(call.SystemPrompt)
				var received taskFrame
				if err := json.Unmarshal([]byte(framed), &received); err != nil || len(received.Constraints) != 1 || received.Constraints[0] != testTaskFrame().Constraints[0] {
					t.Error("actual worker request changed authored whitespace or Unicode", framed, err)
				}
				once.Do(func() { close(entered) })
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				completePi(w, "delivered result")
			})
			defer pi.Close()
			h := newHarness(t, pi.URL)
			defer releaseOnce.Do(func() { close(release) })
			cookie, tid, _ := h.register(t, mode+"-frame@example.test")
			cid, aid, sid := h.fixture(t, cookie, tid)
			base := "/tenants/" + tid
			node := map[string]any{"id": "node-a", "kind": "session", "title": "task", "runtime": runtimePI, "binding": map[string]string{"companyId": tid, "agentId": aid}, "issueId": sid, "taskFrame": testTaskFrame()}
			if strings.Contains(mode, "team") {
				team := fixtureTeam("sequential")
				for i := range team.Members {
					team.Members[i].Model = ""
				}
				node["team"] = team
			}
			doc := map[string]any{"nodes": []any{node}, "edges": []any{}}
			h.request(t, cookie, "PUT", base+"/canvases/"+cid, map[string]any{"name": "framed", "version": 1, "document": doc}, 200)
			var rid, gid string
			if strings.HasPrefix(mode, "graph") {
				gid = h.request(t, cookie, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": "task-frame-graph", "documentVersion": 2}, 202)["id"].(string)
			} else {
				rid = h.request(t, cookie, "POST", base+"/runs", map[string]any{"sessionId": sid, "prompt": "Follow the requirements", "operationId": "task-frame-manual"}, 202)["id"].(string)
			}
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("worker did not start")
			}
			node["taskFrame"] = &taskFrame{Version: 1, Source: "manual", Constraints: []string{"MUTATED"}, AcceptanceCriteria: []string{}}
			h.request(t, cookie, "PUT", base+"/canvases/"+cid, map[string]any{"name": "changed", "version": 2, "document": doc}, 200)
			releaseOnce.Do(func() { close(release) })
			if strings.HasPrefix(mode, "graph") {
				awaitGraph(t, h, cookie, base+"/canvases/"+cid+"/graph-runs/"+gid, "completed")
				if err := h.db.QueryRow(context.Background(), "SELECT run_id FROM graph_run_nodes WHERE graph_id=$1", gid).Scan(&rid); err != nil {
					t.Fatal(err)
				}
			} else {
				h.awaitRun(t, cookie, tid, rid, "completed")
			}
			var raw []byte
			if err := h.db.QueryRow(context.Background(), "SELECT execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", tid, rid).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var snap executionSnapshot
			if json.Unmarshal(raw, &snap) != nil || snap.TaskFrame == nil || snap.TaskFrame.Constraints[0] != testTaskFrame().Constraints[0] {
				t.Fatal("run snapshot mutated", string(raw))
			}
		})
	}
}

func splitTaskFramePrompt(system string) (string, string) {
	before, suffix, _ := strings.Cut(system, "Manual task requirements (JSON; preserve the authored requirements):\n")
	raw, _, _ := strings.Cut(suffix, "\nFollow the constraints")
	return before, raw
}

func TestPostgresTaskFrameSaveValidationAndLegacyCAS(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	cookie, tid, _ := h.register(t, "frame-save@example.test")
	base := "/tenants/" + tid + "/canvases"
	invalid := map[string]any{"nodes": []any{map[string]any{"id": "n", "kind": "session", "taskFrame": map[string]any{"version": 2, "source": "manual", "constraints": []string{}, "acceptanceCriteria": []string{}}}}}
	h.request(t, cookie, "POST", base, map[string]any{"name": "invalid", "document": invalid}, 400)
	doc := map[string]any{"nodes": []any{map[string]any{"id": "n", "kind": "session", "taskFrame": testTaskFrame()}}}
	cid := h.request(t, cookie, "POST", base, map[string]any{"name": "valid", "document": doc}, 201)["id"].(string)
	old := map[string]any{"nodes": []any{map[string]any{"id": "n", "kind": "session", "title": "rename"}}}
	result := h.request(t, cookie, "PUT", base+"/"+cid, map[string]any{"name": "old client", "version": 1, "document": old}, 200)
	raw, _ := json.Marshal(result["document"])
	frame, err := savedNodeTaskFrame(raw, "n")
	if err != nil || frame == nil || frame.Constraints[0] != testTaskFrame().Constraints[0] {
		t.Fatal("legacy save dropped requirements", result, err)
	}
	h.request(t, cookie, "PUT", base+"/"+cid, map[string]any{"name": "stale", "version": 1, "document": old}, 409)
	h.request(t, cookie, "PUT", base+"/"+cid, map[string]any{"name": "invalid", "version": 2, "document": invalid}, 400)
}

func TestPostgresTaskFrameBudgetRejectsBeforeInvocation(t *testing.T) {
	for _, mode := range []string{"single", "team", "graph", "graph-team"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/health" {
					writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "limits": map[string]int{"maxContextTextBytes": 2500}, "models": []map[string]any{{"id": "test-model", "maxContextTextBytes": 2500}}})
					return
				}
				if r.Method == "DELETE" {
					w.WriteHeader(202)
					return
				}
				calls.Add(1)
				w.WriteHeader(500)
			}))
			defer pi.Close()
			h := newHarness(t, pi.URL)
			cookie, tid, _ := h.register(t, mode+"-budget-frame@example.test")
			cid, aid, sid := h.fixture(t, cookie, tid)
			frame := &taskFrame{Version: 1, Source: "manual", Constraints: []string{strings.Repeat("中", 2000)}, AcceptanceCriteria: []string{}}
			node := map[string]any{"id": "node-a", "kind": "session", "title": "task", "runtime": runtimePI, "binding": map[string]string{"companyId": tid, "agentId": aid}, "issueId": sid, "taskFrame": frame}
			if strings.Contains(mode, "team") {
				team := fixtureTeam("sequential")
				team.Members = team.Members[:1]
				node["team"] = team
			}
			base := "/tenants/" + tid
			h.request(t, cookie, "PUT", base+"/canvases/"+cid, map[string]any{"name": "budget", "version": 1, "document": map[string]any{"nodes": []any{node}, "edges": []any{}}}, 200)
			if strings.HasPrefix(mode, "graph") {
				path := base + "/canvases/" + cid + "/graph-runs"
				gid := h.request(t, cookie, "POST", path, map[string]any{"operationId": "frame-budget-graph"}, 202)["id"].(string)
				done := awaitGraph(t, h, cookie, path+"/"+gid, "failed")
				if done["nodes"].([]any)[0].(map[string]any)["detail"] != "context_limit" {
					t.Fatal("missing graph budget failure", done)
				}
			} else if mode == "single" {
				result := h.request(t, cookie, "POST", base+"/runs", map[string]any{"sessionId": sid, "prompt": "task", "operationId": "frame-budget-run"}, 413)
				if result["error"].(map[string]any)["code"] != "context_limit" {
					t.Fatal(result)
				}
			} else {
				rid := h.request(t, cookie, "POST", base+"/runs", map[string]any{"sessionId": sid, "prompt": "task", "operationId": "frame-budget-run"}, 202)["id"].(string)
				if done := h.awaitRun(t, cookie, tid, rid, "failed"); done["error"] != "context_limit" {
					t.Fatal(done)
				}
			}
			var invocations int
			if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM model_invocations WHERE tenant_id=$1", tid).Scan(&invocations); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 0 || invocations != 0 {
				t.Fatal("oversized task frame reached provider", calls.Load(), invocations)
			}
		})
	}
}
