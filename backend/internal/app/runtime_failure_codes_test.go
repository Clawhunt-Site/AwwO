package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// The worker's failed-event codes that a workspace can act on differently are named;
// everything else, including codes this API has never heard of, stays the generic
// runtime failure. The contract refusal is the one code whose meaning depends on the
// run: without a frozen contract it describes nothing this run sent.
func TestRuntimeFailureCodeTable(t *testing.T) {
	named := map[string]string{
		"MODEL_OUTPUT_LIMIT":   "output_limit",
		"MODEL_REFUSAL":        "model_refused",
		"MODEL_AUTHENTICATION": "provider_auth_failed",
		"MODEL_RATE_LIMIT":     "provider_rate_limited",
		"MODEL_UNAVAILABLE":    "provider_unavailable",
		"DEADLINE_EXCEEDED":    "run_timeout",
	}
	for worker, want := range named {
		for _, contract := range []bool{false, true} {
			if got := runtimeFailureCode(worker, contract); got != want {
				t.Fatal(worker, contract, got, "wanted", want)
			}
		}
	}
	if got := runtimeFailureCode("OUTPUT_CONTRACT_INVALID", true); got != "output_contract_invalid" {
		t.Fatal("contract refusal on a run that carried a contract", got)
	}
	if got := runtimeFailureCode("OUTPUT_CONTRACT_INVALID", false); got != "runtime_failed" {
		t.Fatal("contract refusal on a run without a contract must stay generic", got)
	}
	for _, worker := range []string{"", "MODEL_ERROR", "MODEL_PROTOCOL_ERROR", "MODEL_REQUEST_REJECTED", "TOOL_DENIED", "WORKER_LOST", "SOMETHING_NEW", "model_refusal", "output_limit"} {
		if got := runtimeFailureCode(worker, true); got != "runtime_failed" {
			t.Fatal("unmapped worker code was named", worker, got)
		}
	}
	// The ledger's failure class follows the named code: provider-side outcomes are
	// provider failures, the output cap is a protocol failure and the deadline a timeout,
	// so none of them lands in the validation bucket by omission.
	for code, class := range map[string]string{
		"runtime_failed": "provider", "model_refused": "provider", "provider_auth_failed": "provider",
		"provider_rate_limited": "provider", "provider_unavailable": "provider",
		"output_limit": "protocol", "run_timeout": "timeout", "output_contract_invalid": "validation",
	} {
		if got := invocationFailure("failed", code); got != class {
			t.Fatal("failure class", code, got, "wanted", class)
		}
	}
}

// A fake worker emits each code on a single run; the run's error is the named code, an
// unknown code stays runtime_failed, and a contract refusal without a contract stays
// runtime_failed too. Each failure costs exactly one provider call.
func TestPostgresRunFailureCodesAreNamedFromWorkerCodes(t *testing.T) {
	var current atomic.Value
	current.Store("")
	var calls atomic.Int32
	pi := runtimeProvider(t, runtimePI, func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
		calls.Add(1)
		if call.ContractPresent {
			t.Error("a plain session run sent a contract")
		}
		raw, _ := json.Marshal(map[string]string{"type": "failed", "code": current.Load().(string), "message": "synthetic failure"})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "failure-codes@example.test")
	_, _, sid := h.fixture(t, c, tid)
	for i, test := range []struct{ worker, want string }{
		{"MODEL_OUTPUT_LIMIT", "output_limit"},
		{"MODEL_REFUSAL", "model_refused"},
		{"MODEL_AUTHENTICATION", "provider_auth_failed"},
		{"MODEL_RATE_LIMIT", "provider_rate_limited"},
		{"MODEL_UNAVAILABLE", "provider_unavailable"},
		{"DEADLINE_EXCEEDED", "run_timeout"},
		{"MODEL_ERROR", "runtime_failed"},
		{"NOT_A_KNOWN_CODE", "runtime_failed"},
		{"", "runtime_failed"},
		{"OUTPUT_CONTRACT_INVALID", "runtime_failed"},
	} {
		current.Store(test.worker)
		before := calls.Load()
		run := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "fail with " + test.worker, "operationId": fmt.Sprintf("failure-code-%d", i)}, 202)
		done := h.awaitRun(t, c, tid, run["id"].(string), "failed")
		if done["error"] != test.want {
			t.Fatal(test.worker, "run error", done["error"], "wanted", test.want)
		}
		if calls.Load()-before != 1 {
			t.Fatal(test.worker, "provider calls", calls.Load()-before)
		}
		var stored, class string
		if err := h.db.QueryRow(context.Background(), "SELECT r.error,i.failure_class FROM runs r JOIN model_invocations i ON i.run_id=r.id AND i.tenant_id=r.tenant_id WHERE r.id=$1", run["id"]).Scan(&stored, &class); err != nil {
			t.Fatal(err)
		}
		if stored != test.want || class != invocationFailure("failed", test.want) {
			t.Fatal(test.worker, "persisted", stored, class)
		}
	}
}

// Team member turns parse the worker stream on their own path; a member that fails with
// a named code records that code on its turn and on the parent run, and a contract
// refusal there stays generic because members never carry a contract.
func TestPostgresTeamMemberFailureCodesMatchSingleRuns(t *testing.T) {
	for _, test := range []struct{ worker, want string }{
		{"MODEL_RATE_LIMIT", "provider_rate_limited"},
		{"OUTPUT_CONTRACT_INVALID", "runtime_failed"},
	} {
		t.Run(test.worker, func(t *testing.T) {
			pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, b observedPiCall) {
				if strings.Contains(b.SystemPrompt, "MEMBER-A") {
					raw, _ := json.Marshal(map[string]string{"type": "failed", "code": test.worker, "message": "synthetic failure"})
					fmt.Fprintf(w, "data: %s\n\n", raw)
					return
				}
				completePi(w, "MEMBER-OUTPUT")
			})
			defer pi.Close()
			h := newHarness(t, pi.URL)
			c, tid, _ := h.register(t, "team-failure-"+strings.ToLower(test.worker)+"@example.test")
			_, _, sid := installTeam(t, h, c, tid, fixtureTeam("sequential"))
			rid := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]string{"sessionId": sid, "prompt": "team task", "operationId": "team-failure-" + test.worker}, 202)["id"].(string)
			done := h.awaitRun(t, c, tid, rid, "failed")
			if done["error"] != test.want {
				t.Fatal("parent run error", done["error"], "wanted", test.want)
			}
			awaitSettledTeam(t, h, rid)
			var code string
			if err := h.db.QueryRow(context.Background(), "SELECT error FROM run_turns WHERE run_id=$1 AND status='failed'", rid).Scan(&code); err != nil {
				t.Fatal(err)
			}
			if code != test.want {
				t.Fatal("member turn error", code, "wanted", test.want)
			}
		})
	}
}

// A graph node's detail is the child run's error, so a named worker code on a node reads
// the same as on a single run, and a contract refusal on a node that froze no contract
// stays generic.
func TestPostgresGraphNodeDetailUsesNamedWorkerCodes(t *testing.T) {
	for _, test := range []struct{ worker, want string }{
		{"MODEL_REFUSAL", "model_refused"},
		{"OUTPUT_CONTRACT_INVALID", "runtime_failed"},
	} {
		t.Run(test.worker, func(t *testing.T) {
			var calls atomic.Int32
			pi := runtimeProvider(t, runtimePI, func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
				calls.Add(1)
				if call.ContractPresent {
					t.Error("a Pi node sent a contract")
				}
				raw, _ := json.Marshal(map[string]string{"type": "failed", "code": test.worker, "message": "synthetic failure"})
				fmt.Fprintf(w, "data: %s\n\n", raw)
			})
			defer pi.Close()
			h := newHarness(t, pi.URL)
			h.a.cfg.StructuredContracts = true
			c, tid, _ := h.register(t, "graph-failure-"+strings.ToLower(test.worker)+"@example.test")
			base := structuredCanvas(t, h, c, tid, "Graph failure", runtimePI, "test-model", []graphField{{ID: "result", Type: "markdown", Required: true}}, nil)
			accepted := h.request(t, c, "POST", base, map[string]string{"operationId": "graph-failure-" + test.worker}, 202)
			done := awaitGraph(t, h, c, base+"/"+accepted["id"].(string), "failed")
			node := done["nodes"].([]any)[0].(map[string]any)
			if node["state"] != "failed" || node["detail"] != test.want {
				t.Fatal("node detail", node["state"], node["detail"], "wanted", test.want)
			}
			if calls.Load() != 1 {
				t.Fatal("provider calls", calls.Load())
			}
		})
	}
}
