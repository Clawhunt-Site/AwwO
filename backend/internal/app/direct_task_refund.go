package app

import "strconv"

// A direct task (直接执行) that the platform failed gives back the model calls it made to the workspace's daily total
// (owner 2026-10-16: 「平台原因失败退还」): it did not finish, though files it already delivered are kept. It is recorded in
// refunded_runs as it ends (finishOnce; app.go Start for a crash): interrupted by an API restart or shutdown, or failed
// by the execution service (computer_execution_failed, computer_stream_ended: computerRefundable). A stream the service
// dropped (reason dropped; past its output limit it is computer_output_limit) is its doing; a task that otherwise failed
// gives its calls back only when one of its calls failed for the platform's sake (refundEvidence), so a task that failed
// of its own doing gets nothing back: its own limits have their own codes (computer_task_timeout, computer_call_budget, computer_tool_budget,
// computer_output_limit), and a call refused before any work (context_limit) or whose own answer did not hold (its
// output cap, a refusal) is no fault of the platform (security review 2026-10-16). The user's cancel, an allowance or
// plan running out, an invalid event or file are not recorded. At most refundedCallsPerDay calls a day come back to a
// workspace (to an account for a plan's free calls).
//
// A call that a time limit on its way cut (computer_model_timeout: an edge's 504 or 524, a stream the edge closed when
// silent, the provider's own time limit; computerPlatformTimeout) is the platform's fault too, but a task can run into one
// on purpose with a call made to run long, so it gives back only itself, never the task's other calls (security review
// 2026-10-18; the owner, the same day: 「Refund only the cut call」). It is noted in refunded_calls as it settles, and
// comes back once its task ended for the platform's sake (refunded_runs), as the task's calls would.
//
// A refund is the daily total's only: route allowances and the deployment-wide ceilings still count the calls, as the
// operator paid for them; credits are not touched.
//
// Any model call its worker cut for silence before it returned anything (stalledBeforeOutput: the Python worker's Bedrock
// read timeout) is the platform's cut too, and is given back by itself, in any run (owner 2026-10-25, to the proposal
// that such a call not be charged, as above: 「那就按照你的建议往下执行吧」). It is noted in refunded_calls with the reason
// stalled as it settles, while its workspace has had fewer than refundedCallsPerDay such calls that day (noteStalledCall),
// and then costs no credits either (settleInvocation). Route allowances and the ceilings count it, as above.

// refundedCallsPerDay is how many refunded calls a day a workspace's daily total gives back, and how many calls cut for
// silence a day it gives back (settleInvocation).
const refundedCallsPerDay = 32

// refundEvidence matches, for the run rr (alias rr of refunded_runs), what makes its ending the platform's: an
// interruption, a stream the execution service dropped, or a call that failed for the platform's sake (failure_class
// transport: the worker unreachable or dropping the connection; provider: the provider's own trouble or the call's
// machinery; computerModelFailure and invocationFailure). Not a call the model's own answer failed (protocol: its output
// cap, a refusal, too many or malformed tool calls), one refused before any work (validation, quota), one cut by its
// own limit, its caller or its task ending (timeout), nor one left open when the run ended (restart): a model cannot
// reach a refund on purpose that way (security review 2026-10-16). A call a time limit on its way cut is a timeout as
// well: it gives back only itself (refundedCutCall).
const refundEvidence = `(rr.reason IN ('interrupted','dropped') OR EXISTS(SELECT 1 FROM model_invocations f WHERE f.tenant_id=rr.tenant_id AND f.run_id=rr.run_id
	AND f.status IN ('failed','interrupted') AND f.failure_class IN ('transport','provider')))`

// refundedRun matches a run (alias r) whose calls are given back.
const refundedRun = `EXISTS(SELECT 1 FROM refunded_runs rr WHERE rr.tenant_id=r.tenant_id AND rr.run_id=r.id AND ` + refundEvidence + `)`

// refundedDirectTaskCall matches a ledger row (alias mi) of a run whose calls are given back.
const refundedDirectTaskCall = `EXISTS(SELECT 1 FROM refunded_runs rr WHERE rr.tenant_id=mi.tenant_id AND rr.run_id=mi.run_id AND ` + refundEvidence + `)`

// refundedCutCall matches a ledger row (alias call) that a time limit on its way cut (refunded_calls, reason timeout) in
// a run that ended for the platform's sake (refunded_runs): that call is given back, whatever its run's other calls do.
func refundedCutCall(call string) string {
	return `EXISTS(SELECT 1 FROM refunded_calls rc JOIN refunded_runs rr ON rr.tenant_id=rc.tenant_id AND rr.run_id=` + call +
		`.run_id WHERE rc.tenant_id=` + call + `.tenant_id AND rc.invocation_id=` + call + `.id AND rc.reason='timeout')`
}

// refundedStalledCall matches a ledger row (alias call) that its worker cut for silence before it returned anything
// (refunded_calls, reason stalled): that call is given back, whatever its run.
func refundedStalledCall(call string) string {
	return `EXISTS(SELECT 1 FROM refunded_calls rs WHERE rs.tenant_id=` + call + `.tenant_id AND rs.invocation_id=` + call +
		`.id AND rs.reason='stalled')`
}

// dailyCalls is the SQL count, over ledger rows (alias mi) the query already selects, of the calls in window that spend
// a daily allowance (countsTowardsDaily; p holds the planner model), less the refunded ones (refundedDirectTaskCall,
// refundedCutCall, refundedStalledCall), up to refundedCallsPerDay. A query that selects only today's rows passes window
// "true", keeping the day in its WHERE for the index.
func dailyCalls(p, window string) string {
	counted := window + ` AND ` + countsTowardsDaily(p)
	refunded := `(` + refundedDirectTaskCall + ` OR ` + refundedCutCall("mi") + ` OR ` + refundedStalledCall("mi") + `)`
	return `(count(*) FILTER (WHERE ` + counted + `) - LEAST(count(*) FILTER (WHERE ` + counted + ` AND ` + refunded + `), ` +
		strconv.Itoa(refundedCallsPerDay) + `))`
}

// computerRefundable says whether a direct task that failed with code failed for the execution service's sake.
func computerRefundable(code string) bool {
	return code == "computer_execution_failed" || code == "computer_stream_ended"
}
