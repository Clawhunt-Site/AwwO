package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func collaborationFixtureDocument() []byte {
	return []byte(`{"execution":{"mode":"review"},"nodes":[{"id":"a","kind":"session","title":"Author","runtime":"pi","binding":{"agentId":"agent-a"}},{"id":"b","kind":"session","title":"Reviewer","runtime":"pi","binding":{"agentId":"agent-b"}},{"id":"outside","kind":"session","title":"Untouched"}],"edges":[{"id":"feedback","kind":"feedback","fromNode":"b","fromPort":"result","toNode":"a","toPort":"context","dataType":"text"}]}`)
}
func TestCollaborationPolicyScopeAndNativeGuard(t *testing.T) {
	raw := collaborationFixtureDocument()
	p := collaborationPolicy{Goal: "Compare approaches", Rounds: 2, SynthesizerNodeID: "a"}
	d, scope, seeds, e := parseCollaborationGraph(raw, []string{"a", "b"}, &p)
	if e != nil || len(d.Nodes) != 2 || len(scope) != 2 || len(seeds) != 2 {
		t.Fatal(d, scope, seeds, e)
	}
	if _, _, e = parseGraph(raw, []string{"a", "b"}); e == nil {
		t.Fatal("ordinary DAG bypassed native policy guard")
	}
	for _, scope := range [][]string{nil, {"a"}, {"a", "a"}, {"a", "outside"}, {"a", "missing"}} {
		if _, _, _, e = parseCollaborationGraph(raw, scope, &p); e == nil {
			t.Fatal("invalid scope accepted", scope)
		}
	}
	for _, change := range []func(*collaborationPolicy){func(p *collaborationPolicy) { p.Rounds = 0 }, func(p *collaborationPolicy) { p.Rounds = 4 }, func(p *collaborationPolicy) { p.SynthesizerNodeID = "outside" }, func(p *collaborationPolicy) { p.Goal = " " }, func(p *collaborationPolicy) { p.Goal = strings.Repeat("x", 8001) }} {
		bad := p
		change(&bad)
		if _, _, _, e = parseCollaborationGraph(raw, []string{"a", "b"}, &bad); e == nil {
			t.Fatal("invalid policy accepted", bad)
		}
	}
	var obj map[string]any
	_ = json.Unmarshal(raw, &obj)
	obj["nodes"].([]any)[0].(map[string]any)["team"] = fixtureTeam("debate")
	nested, _ := json.Marshal(obj)
	if _, _, _, e = parseCollaborationGraph(nested, []string{"a", "b"}, &p); e == nil {
		t.Fatal("nested paid calls accepted")
	}
}
func TestCollaborationRequiredInputsAreFrozenAndNeverInvented(t *testing.T) {
	raw := []byte(`{"nodes":[{"id":"a","kind":"session","binding":{"agentId":"agent"},"contract":{"version":1,"inputs":[{"id":"brief","type":"text","required":true}],"outputs":[]}},{"id":"b","kind":"session","binding":{"agentId":"agent"}},{"id":"source","kind":"session","lastOutput":{"text":"SAVED-BRIEF","partial":false}}],"edges":[{"id":"input","fromNode":"source","fromPort":"result","toNode":"a","toPort":"in:brief","dataType":"text"}]}`)
	p := collaborationPolicy{Goal: "Goal is not a substitute for missing data", Rounds: 1, SynthesizerNodeID: "a"}
	_, _, seeds, e := parseCollaborationGraph(raw, []string{"a", "b"}, &p)
	if e != nil || !strings.Contains(seeds["a"], "SAVED-BRIEF") {
		t.Fatal(seeds, e)
	}
	incomplete := strings.Replace(string(raw), `"partial":false`, `"partial":true`, 1)
	if _, _, _, e = parseCollaborationGraph([]byte(incomplete), []string{"a", "b"}, &p); e == nil {
		t.Fatal("partial cache admitted")
	}
	if !strings.Contains(string(raw), `"required":true`) || strings.Contains(string(raw), `"value"`) {
		t.Fatal("original document mutated")
	}
}
func TestCollaborationPlanIDsAndRoundBarriers(t *testing.T) {
	p := collaborationPolicy{Goal: "GOAL", Rounds: 3, SynthesizerNodeID: "b"}
	turns := collaborationPlan([]string{"a", "b"}, &p)
	if len(turns) != 13 {
		t.Fatal(len(turns))
	}
	ids := map[string]bool{}
	for i, turn := range turns {
		op := collaborationOperationID("graph", turn)
		if ids[op] || turn.Ordinal != i+1 {
			t.Fatal("duplicate phase identity", turn)
		}
		ids[op] = true
	}
	turns[0].State = "completed"
	turns[0].Output = "CANDIDATE-A"
	turns[1].State = "completed"
	turns[1].Output = "CANDIDATE-B"
	prompt, e := collaborationPrompt(p, turns[2], "OUTPUT-CONTRACT", turns)
	if e != nil || !strings.Contains(prompt, "CANDIDATE-A") || !strings.Contains(prompt, "CANDIDATE-B") || strings.Contains(prompt, "OUTPUT-CONTRACT") {
		t.Fatal(prompt, e)
	}
	turns[1].State = "running"
	if _, e = collaborationPrompt(p, turns[2], "", turns); e == nil {
		t.Fatal("review read unfinished round")
	}
	turns[2].State = "completed"
	turns[2].Output = "CRITIQUE-A"
	turns[3].State = "completed"
	turns[3].Output = "CRITIQUE-B"
	prompt, e = collaborationPrompt(p, turns[4], "ORIGINAL-CONTRACT", turns)
	if e != nil || !strings.Contains(prompt, "CRITIQUE-A") || !strings.Contains(prompt, "CRITIQUE-B") || !strings.Contains(prompt, "ORIGINAL-CONTRACT") || strings.Contains(prompt, "CANDIDATE-A") {
		t.Fatal(prompt, e)
	}
}

func TestPostgresCollaborationSessionsEvidenceAndFinalBoundary(t *testing.T) {
	var calls atomic.Int32
	var mu sync.Mutex
	observed := []observedPiCall{}
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		n := calls.Add(1)
		mu.Lock()
		observed = append(observed, b)
		mu.Unlock()
		completePi(w, fmt.Sprintf("OUTPUT-%d", n))
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "collaboration@example.test")
	other, _, _ := h.register(t, "foreign-collaboration@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	ctx := context.Background()
	// Existing per-node Sessions must be reused through proposal, critique and synthesis.
	sessions := map[string]string{}
	for _, v := range doc["nodes"].([]any) {
		n := v.(map[string]any)
		nid := n["id"].(string)
		if nid == "merge" {
			continue
		}
		sid := randomID()
		aid := n["binding"].(map[string]string)["agentId"]
		if _, e := h.db.Exec(ctx, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,title) VALUES($1,$2,$3,$4,$5,$4)", sid, tid, cid, nid, aid); e != nil {
			t.Fatal(e)
		}
		n["issueId"] = sid
		sessions[nid] = sid
	}
	h.request(t, c, "PUT", "/tenants/"+tid+"/canvases/"+cid, map[string]any{"name": "Graph", "version": 1, "document": doc}, 200)
	base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
	p := collaborationPolicy{Goal: "GOAL-MARKER", Rounds: 2, SynthesizerNodeID: "a"}
	body := map[string]any{"operationId": "collaborate-existing-sessions", "scope": []string{"a", "b"}, "documentVersion": 2, "collaboration": p}
	admitted := h.request(t, c, "POST", base, body, 202)
	path := base + "/" + admitted["id"].(string)
	h.request(t, other, "GET", path, nil, 404)
	if replay := h.request(t, c, "POST", base, body, 200); replay["id"] != admitted["id"] {
		t.Fatal("operation replay created graph")
	}
	conflict := map[string]any{"operationId": body["operationId"], "scope": body["scope"], "documentVersion": 2, "collaboration": collaborationPolicy{Goal: "different", Rounds: 2, SynthesizerNodeID: "a"}}
	h.request(t, c, "POST", base, conflict, 409)
	done := awaitGraph(t, h, c, path, "completed")
	collab := done["collaboration"].(map[string]any)
	if calls.Load() != 9 || collab["maxModelCalls"] != float64(9) {
		t.Fatal(calls.Load(), collab)
	}
	turns := collab["turns"].([]any)
	seen := map[string]bool{}
	for _, v := range turns {
		turn := v.(map[string]any)
		nid := turn["nodeId"].(string)
		rid := turn["runId"].(string)
		if turn["status"] != "completed" || turn["sessionId"] != sessions[nid] || seen[rid] || turn["output"] == "" {
			t.Fatal("turn identity/evidence", turn)
		}
		seen[rid] = true
	}
	for _, v := range done["nodes"].([]any) {
		n := v.(map[string]any)
		if n["nodeId"] == "merge" {
			t.Fatal("unselected node touched")
		}
		if n["nodeId"] == "a" {
			if n["partial"] != false || n["output"] != "OUTPUT-9" {
				t.Fatal("synthesis not published", n)
			}
		} else if n["partial"] != true || n["output"] != "OUTPUT-6" {
			t.Fatal("critique overwrote candidate", n)
		}
	}
	var count int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM node_sessions WHERE tenant_id=$1", tid).Scan(&count); e != nil || count != 2 {
		t.Fatal("sessions cloned", count, e)
	}
	saved := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid, nil, 200)
	frozen, _ := json.Marshal(doc)
	actual, _ := json.Marshal(saved["document"])
	if string(frozen) != string(actual) {
		t.Fatal("canvas changed")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(observed[0].Messages) != 0 || len(observed[2].Messages) != 2 || len(observed[4].Messages) != 4 || len(observed[8].Messages) != 8 {
		t.Fatal("per-Session discussion history not retained", observed)
	}
	if !strings.Contains(observed[2].Prompt, "OUTPUT-1") || !strings.Contains(observed[2].Prompt, "OUTPUT-2") || !strings.Contains(observed[4].Prompt, "OUTPUT-3") || !strings.Contains(observed[4].Prompt, "OUTPUT-4") {
		t.Fatal("round evidence missing")
	}
	for _, call := range observed {
		if call.SystemPrompt != "ORIGINAL-INSTRUCTIONS" {
			t.Fatal("persona changed", call.SystemPrompt)
		}
	}
}

func TestPostgresCollaborationCancellationAndNoReplay(t *testing.T) {
	for _, operation := range []bool{false, true} {
		t.Run(fmt.Sprint(operation), func(t *testing.T) {
			entered := make(chan struct{}, 1)
			var calls atomic.Int32
			pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
				calls.Add(1)
				entered <- struct{}{}
				<-r.Context().Done()
			})
			defer pi.Close()
			h := newHarness(t, pi.URL)
			c, tid, _ := h.register(t, "collaboration-cancel@example.test")
			cid, _ := graphFixture(t, h, c, tid)
			base := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs"
			body := map[string]any{"operationId": "cancel-collaboration", "scope": []string{"a", "b"}, "collaboration": collaborationPolicy{Goal: "Stop this owned scenario", Rounds: 3, SynthesizerNodeID: "a"}}
			admitted := h.request(t, c, "POST", base, body, 202)
			gid := admitted["id"].(string)
			path := base + "/" + gid
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Fatal("first proposal did not start")
			}
			// The other selected Session is reserved even before its first model turn.
			nodes := admitted["nodes"].([]any)
			secondSID := nodes[1].(map[string]any)["sessionId"].(string)
			rejected := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": secondSID, "prompt": "interleaved manual message", "operationId": "manual-during-collaboration"}, 409)
			if rejected["error"].(map[string]any)["code"] != "resource_in_use" {
				t.Fatal("wrong Session reservation error", rejected)
			}
			if operation {
				h.request(t, c, "POST", base+"/operations/cancel-collaboration/cancel", map[string]any{}, 200)
			} else {
				h.request(t, c, "POST", path+"/cancel", map[string]any{}, 200)
			}
			done := awaitGraph(t, h, c, path, "cancelled")
			for _, v := range done["nodes"].([]any) {
				n := v.(map[string]any)
				if n["partial"] != true || n["state"] != "cancelled" {
					t.Fatal(n)
				}
			}
			h.a.dispatchGraph(tid, gid)
			time.Sleep(100 * time.Millisecond)
			if calls.Load() != 1 {
				t.Fatal("cancelled collaboration replayed", calls.Load())
			}
			for _, v := range done["collaboration"].(map[string]any)["turns"].([]any) {
				if v.(map[string]any)["status"] != "cancelled" {
					t.Fatal("unsettled turn", v)
				}
			}
		})
	}
}

func TestPostgresCollaborationContractFailureAndMissingInputZeroDispatch(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "INVALID-NUMBER")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "collaboration-contract@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	first := doc["nodes"].([]any)[0].(map[string]any)
	contract := graphContract{Version: 1, Inputs: []graphField{{ID: "required", Type: "text", Required: true}}, Outputs: []graphField{{ID: "number", Type: "number", Required: true}}}
	first["contract"] = contract
	canvas := "/tenants/" + tid + "/canvases/" + cid
	h.request(t, c, "PUT", canvas, map[string]any{"name": "Graph", "version": 1, "document": doc}, 200)
	body := map[string]any{"operationId": "missing-collaboration-input", "scope": []string{"a", "b"}, "collaboration": collaborationPolicy{Goal: "Cannot replace required input", Rounds: 1, SynthesizerNodeID: "a"}}
	h.request(t, c, "POST", canvas+"/graph-runs", body, 400)
	if calls.Load() != 0 {
		t.Fatal("missing input dispatched")
	}
	var count int
	_ = h.db.QueryRow(context.Background(), "SELECT count(*) FROM graph_runs WHERE tenant_id=$1", tid).Scan(&count)
	if count != 0 {
		t.Fatal("invalid graph persisted")
	}
	contract.Inputs[0].Value = "INPUT"
	first["contract"] = contract
	h.request(t, c, "PUT", canvas, map[string]any{"name": "Graph", "version": 2, "document": doc}, 200)
	body["operationId"] = "invalid-collaboration-output"
	v := h.request(t, c, "POST", canvas+"/graph-runs", body, 202)
	done := awaitGraph(t, h, c, canvas+"/graph-runs/"+v["id"].(string), "failed")
	if calls.Load() != 1 {
		t.Fatal("failed output did not stop collaboration", calls.Load())
	}
	for _, v := range done["nodes"].([]any) {
		if v.(map[string]any)["partial"] != true {
			t.Fatal("invalid output published", v)
		}
	}
}

func TestPostgresCollaborationRestartDoesNotReplayAcceptedTurn(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "UNEXPECTED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, actor := h.register(t, "collaboration-restart@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	gid, ids := seedUnprojectedGraph(t, h, tid, cid, actor, doc, map[string]string{"a": "running"})
	ctx := context.Background()
	p := collaborationPolicy{Goal: "Uncertain accepted request", Rounds: 1, SynthesizerNodeID: "a"}
	raw, _ := json.Marshal(p)
	tx, e := h.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "UPDATE graph_runs SET collaboration=$3,scope='[\"a\",\"b\"]' WHERE tenant_id=$1 AND id=$2", tid, gid, raw); e != nil {
		t.Fatal(e)
	}
	if e = seedCollaboration(ctx, tx, tid, gid, []string{"a", "b"}, &p, map[string]string{"a": "A", "b": "B"}); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, "UPDATE graph_collaboration_turns SET state='running',run_id=$3 WHERE tenant_id=$1 AND graph_id=$2 AND ordinal=1", tid, gid, ids["a"]); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	h.a.dispatchGraph(tid, gid)
	done := awaitGraph(t, h, c, "/tenants/"+tid+"/canvases/"+cid+"/graph-runs/"+gid, "interrupted")
	if calls.Load() != 0 {
		t.Fatal("uncertain provider call replayed")
	}
	turn := done["collaboration"].(map[string]any)["turns"].([]any)[0].(map[string]any)
	if turn["status"] != "interrupted" || turn["runId"] != ids["a"] {
		t.Fatal(turn)
	}
	before := done
	h.a.recoverGraphs(ctx)
	after := h.request(t, c, "GET", "/tenants/"+tid+"/canvases/"+cid+"/graph-runs/"+gid, nil, 200)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("refresh changed recovered evidence")
	}
}

func TestPostgresCollaborationLegacyMissingCacheDoesNotDispatch(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		completePi(w, "UNEXPECTED")
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "collaboration-legacy-input@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	canvas := "/tenants/" + tid + "/canvases/" + cid
	for _, partial := range []bool{false, true} {
		if partial {
			doc["nodes"].([]any)[0].(map[string]any)["lastOutput"] = map[string]any{"text": "INCOMPLETE", "partial": true}
			h.request(t, c, "PUT", canvas, map[string]any{"name": "Graph", "version": 1, "document": doc}, 200)
		}
		h.request(t, c, "POST", canvas+"/graph-runs", map[string]any{"operationId": randomID(), "scope": []string{"a", "merge"}, "collaboration": collaborationPolicy{Goal: "No missing dependency shortcut", Rounds: 1, SynthesizerNodeID: "merge"}}, 400)
	}
	var graphs, sessions int
	if e := h.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM graph_runs WHERE tenant_id=$1),(SELECT count(*) FROM node_sessions WHERE tenant_id=$1)", tid).Scan(&graphs, &sessions); e != nil || graphs != 0 || sessions != 0 || calls.Load() != 0 {
		t.Fatal(graphs, sessions, calls.Load(), e)
	}
}

func TestPostgresCollaborationSynthesisFileCommitsWithGraph(t *testing.T) {
	var calls atomic.Int32
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
		calls.Add(1)
		if strings.HasPrefix(b.Prompt, "[AwwO collaboration review") {
			completePi(w, "# Critique\nCompare the evidence.")
		} else {
			completePi(w, `{"artifact":{"name":"plan.md","content":"# Final plan"},"score":42,"approved":true}`)
		}
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "collaboration-file-commit@example.test")
	cid, doc := graphFixture(t, h, c, tid)
	contract := graphContract{Version: 1, Outputs: []graphField{{ID: "artifact", Type: "file", Required: true}, {ID: "score", Type: "number", Required: true}, {ID: "approved", Type: "boolean", Required: true}}}
	for _, v := range doc["nodes"].([]any) {
		n := v.(map[string]any)
		if n["id"] != "merge" {
			n["contract"] = contract
		}
	}
	canvas := "/tenants/" + tid + "/canvases/" + cid
	h.request(t, c, "PUT", canvas, map[string]any{"name": "Graph", "version": 1, "document": doc}, 200)
	ctx := context.Background()
	for _, sql := range []string{
		"CREATE SEQUENCE collaboration_commit_attempt",
		"CREATE FUNCTION fail_collaboration_commit_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.collaboration IS NOT NULL AND NEW.status='completed' AND nextval('collaboration_commit_attempt')=1 THEN RAISE EXCEPTION 'injected final commit failure'; END IF; RETURN NEW; END $$",
		"CREATE TRIGGER collaboration_commit_failure BEFORE UPDATE ON graph_runs FOR EACH ROW EXECUTE FUNCTION fail_collaboration_commit_once()",
	} {
		if _, e := h.db.Exec(ctx, sql); e != nil {
			t.Fatal(e)
		}
	}
	v := h.request(t, c, "POST", canvas+"/graph-runs", map[string]any{"operationId": "atomic-file-collaboration", "scope": []string{"a", "b"}, "collaboration": collaborationPolicy{Goal: "Synthesize a file and typed verdict", Rounds: 1, SynthesizerNodeID: "a"}}, 202)
	path := canvas + "/graph-runs/" + v["id"].(string)
	observedRollback := false
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		var called bool
		var attempt int
		if e := h.db.QueryRow(ctx, "SELECT is_called,last_value FROM collaboration_commit_attempt").Scan(&called, &attempt); e != nil {
			t.Fatal(e)
		}
		if called && attempt == 1 {
			var count int
			if e := h.db.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE tenant_id=$1", tid).Scan(&count); e != nil {
				t.Fatal(e)
			}
			if count != 0 {
				t.Fatal("artifact published before whole-graph success", count)
			}
			observedRollback = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !observedRollback {
		t.Fatal("did not observe the interrupted final transaction")
	}
	done := awaitGraph(t, h, c, path, "completed")
	if calls.Load() != 5 {
		t.Fatal("persistence retry repeated model calls", calls.Load())
	}
	var count int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE tenant_id=$1", tid).Scan(&count); e != nil || count != 1 {
		t.Fatal("candidate artifacts were published", count, e)
	}
	for _, v := range done["nodes"].([]any) {
		n := v.(map[string]any)
		if n["nodeId"] == "a" {
			if _, e := graphOutput(graphNode{Contract: &contract}, n["output"].(string)); e != nil {
				t.Fatal("final mixed output contract", e)
			}
			if n["partial"] != false {
				t.Fatal("synthesis not final", n)
			}
		}
	}
	stopped := h.request(t, c, "POST", path+"/cancel", map[string]any{}, 200)
	if stopped["status"] != "completed" {
		t.Fatal("Stop rewrote committed final synthesis")
	}
}

func TestPostgresCollaborationTerminalRetainsCandidateNotCritique(t *testing.T) {
	for _, phase := range []string{"proposal", "review", "synthesis"} {
		for _, state := range []string{"running", "completed", "failed", "interrupted"} {
			t.Run(phase+"/"+state, func(t *testing.T) {
				h := newHarness(t, "http://127.0.0.1:1")
				c, tid, actor := h.register(t, "collaboration-partial@example.test")
				cid, doc := graphFixture(t, h, c, tid)
				gid, ids := seedUnprojectedGraph(t, h, tid, cid, actor, doc, map[string]string{"a": state})
				ctx := context.Background()
				p := collaborationPolicy{Goal: "Retain candidate", Rounds: 1, SynthesizerNodeID: "a"}
				raw, _ := json.Marshal(p)
				tx, e := h.db.Begin(ctx)
				if e != nil {
					t.Fatal(e)
				}
				defer tx.Rollback(ctx)
				if _, e = tx.Exec(ctx, "UPDATE graph_runs SET collaboration=$3,scope='[\"a\",\"b\"]' WHERE tenant_id=$1 AND id=$2", tid, gid, raw); e != nil {
					t.Fatal(e)
				}
				if e = seedCollaboration(ctx, tx, tid, gid, []string{"a", "b"}, &p, map[string]string{"a": "A", "b": "B"}); e != nil {
					t.Fatal(e)
				}
				if _, e = tx.Exec(ctx, "UPDATE graph_collaboration_turns SET state='running',phase=$4,run_id=$3 WHERE tenant_id=$1 AND graph_id=$2 AND ordinal=1", tid, gid, ids["a"], phase); e != nil {
					t.Fatal(e)
				}
				if _, e = tx.Exec(ctx, "UPDATE graph_run_nodes SET output='EARLIER-CANDIDATE' WHERE tenant_id=$1 AND graph_id=$2 AND node_id='a'", tid, gid); e != nil {
					t.Fatal(e)
				}
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				path := "/tenants/" + tid + "/canvases/" + cid + "/graph-runs/" + gid
				var done map[string]any
				wantStatus := "cancelled"
				if state == "failed" || state == "interrupted" {
					wantStatus = state
					h.a.dispatchGraph(tid, gid)
					done = awaitGraph(t, h, c, path, state)
				} else {
					done = h.request(t, c, "POST", path+"/cancel", map[string]any{}, 200)
				}
				if done["status"] != wantStatus {
					t.Fatal("unfinished phases reported complete", done)
				}
				for _, v := range done["nodes"].([]any) {
					n := v.(map[string]any)
					if n["nodeId"] != "a" {
						continue
					}
					want := "SAVED-a"
					if phase == "review" {
						want = "EARLIER-CANDIDATE"
					}
					if n["output"] != want || n["partial"] != true {
						t.Fatal("candidate lost or critique published", n)
					}
				}
				turns := done["collaboration"].(map[string]any)["turns"].([]any)
				if turns[0].(map[string]any)["output"] != "SAVED-a" {
					t.Fatal("partial native run evidence lost")
				}
			})
		}
	}
}
