package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Running a relayed call (relay.go): its admission as one of its workspace's calls, the relay worker's managed-call route,
// its settling in the ledger, and its streamed answer.

const (
	// relayBodyLimit is the most of one call this site reads, and the most it forwards: what the worker's managed-call
	// route reads (computerWorkerBodyLimit), less room for the fields this site adds.
	relayBodyLimit = computerWorkerBodyLimit - 8<<10
	// relayTooLong and relayTooLarge refuse a call past its model's window and one past what the relay reads: OpenAI's
	// code, context_length_exceeded, and words a worker reads as the size refusal they are (apps/context-overflow.ts,
	// context-overflow-vectors.json), so AwwO 本地版 settles such a call as too large, never as a provider's fault.
	relayTooLong  = "The call is past this model's maximum context length"
	relayTooLarge = "The call is past the relay's maximum context length: its request is larger than 504 KiB"
)

var (
	// relaySlotWait is how long a call waits for a free place among its workspace's or its plan's calls at once before it
	// is refused: nothing is sent to its caller meanwhile, and the edge in front of this site cuts a silent response at
	// about 100 s. A variable for the tests only, as is relayHeartbeat.
	relaySlotWait = 60 * time.Second
	// relayHeartbeat is how often a streamed call's response shows it is still there while its model works.
	relayHeartbeat = 15 * time.Second
)

// relayRuntime is the runtime a relayed call is recorded and priced as (AWWO_MODEL_PRICING_JSON is keyed runtime:model):
// the one this site prices the model under, the OpenAI Agents runtime first (this site's Bedrock catalog serves most
// models there and a few on Pi), or the relay worker's own, Pi, for a model priced under neither.
func (a *App) relayRuntime(model string) string {
	for _, runtime := range []string{runtimeOpenAIAgents, runtimePI} {
		if _, _, ok := a.creditRates(runtime, model); ok {
			return runtime
		}
	}
	return runtimePI
}

// relayCompletion runs one relayed call: its key, a place among the calls the relay may run at once (relayLimits), its
// request, its admission as one of its workspace's calls, the relay worker's managed-call route, its settling, then its
// streamed answer. The call is registered with the work this process runs from before it is admitted until it is
// settled, so a shutdown settles it, and so does the sweep should its own settling fail (sweepRelayCalls). What a call's
// provider or model failed is said by kind alone, never in their words.
func (a *App) relayCompletion(w http.ResponseWriter, r *http.Request) {
	caller, ok := a.relayAuthenticate(w, r)
	if !ok {
		return
	}
	if !a.relayLimits.refusalsAllowed(caller.keyID) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "relay_rate_limited", "Too many of this connection's calls were refused as sent: check them, then wait a minute")
		return
	}
	worker, e := a.relayCatalog(r.Context())
	if e != nil {
		fail(w, 503, "relay_unavailable", "Cloud models are unavailable right now")
		return
	}
	if !a.relayLimits.enter(caller.tenantID) {
		relayBusy(w)
		return
	}
	defer a.relayLimits.leave(caller.tenantID)
	call, model, ok := a.readRelayCall(w, r, worker.models)
	if !ok {
		return
	}
	id := "rl" + randomID()
	body := relayForwardBody(id, caller.tenantID, model.ID, call)
	if len(body) > relayBodyLimit {
		fail(w, 413, "context_length_exceeded", relayTooLarge)
		return
	}
	// Not the API's 30 s request deadline (requestDeadlineApplies): the bound of a managed call.
	ctx, cancel := context.WithTimeout(r.Context(), computerModelCallTimeout)
	defer cancel()
	if !a.trackRelayCall(id, cancel) {
		fail(w, 503, "worker_unavailable", "API worker is shutting down")
		return
	}
	untrack := sync.OnceFunc(func() { a.untrackRelayCall(id) })
	defer untrack()
	facts := &invocationFacts{Runtime: a.relayRuntime(model.ID), Model: model.ID, Provider: model.Provider, ProviderModel: model.ProviderModel,
		Protocol: model.Protocol, Admission: "not_attempted", Usage: missingUsage("unavailable", "provider_missing"), InputBytes: int64(len(body))}
	admission, admitted := context.WithTimeout(ctx, relaySlotWait)
	e = a.reserveRelayInvocation(admission, caller, id, facts, worker.capacity)
	admitted()
	if e != nil {
		// A commit whose answer was lost may have reserved the call all the same: settle it, as one never sent.
		if !relayRefused(e) {
			_ = a.settleRelayCall(caller.tenantID, id, "failed", "accounting_commit_failed", facts)
		}
		relayRefusal(w, e)
		return
	}
	// The call holds one of the relay worker's places until it ends (relayLimits.take).
	defer a.relayLimits.give(caller.tenantID)
	// end settles the call once and lets its handler go; it comes before anything is written to the caller, whose
	// connection may be slow, so a shutdown never waits on one.
	var once sync.Once
	var settleErr error
	end := func(status, code string) error {
		once.Do(func() { settleErr = a.settleRelayCall(caller.tenantID, id, status, code, facts) })
		untrack()
		return settleErr
	}
	defer end("failed", "computer_model_failed")
	if e = a.markInvocationAdmission(ctx, caller.tenantID, id, facts, "unknown"); e != nil {
		_ = end("failed", "accounting_commit_failed")
		fail(w, 503, "relay_accounting_failed", "Could not reserve the call")
		return
	}
	reply := beginRelayReply(ctx, w)
	defer reply.end("")
	answer, failure := a.forwardRelayCall(ctx, caller, model.ID, body, facts)
	if failure != nil {
		if failure.refused {
			a.relayLimits.refused(caller.keyID)
		}
		_ = end("failed", failure.code)
		reply.fail(failure.errCode, failure.message)
		return
	}
	if end("completed", "") != nil {
		reply.fail("relay_accounting_failed", "Could not record the call's usage")
		return
	}
	reply.answer(model.ID, answer, call.SingleTool)
}

// readRelayCall reads a call's request and the model of the relay worker's catalog it names (the workspace's
// entitlement is its admission's), and refuses a call longer than its model reads, as the worker would after its
// admission, and a Bedrock model's call the worker's Converse bridge would refuse.
func (a *App) readRelayCall(w http.ResponseWriter, r *http.Request, models []relayModel) (relayCall, relayModel, bool) {
	var call relayCall
	if media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type")); e != nil || media != "application/json" {
		fail(w, 415, "unsupported_media_type", "Use application/json")
		return call, relayModel{}, false
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, relayBodyLimit+1))
	switch {
	case e != nil:
		fail(w, 400, "invalid_request", "The call could not be read")
		return call, relayModel{}, false
	case len(raw) > relayBodyLimit:
		fail(w, 413, "context_length_exceeded", relayTooLarge)
		return call, relayModel{}, false
	}
	if call, e = parseRelayCall(raw); e != nil {
		var input relayInputError
		errors.As(e, &input)
		fail(w, 400, input.code, input.message)
		return call, relayModel{}, false
	}
	for _, m := range models {
		if m.ID != call.Model {
			continue
		}
		if why := call.bedrockRefusal(); m.Provider == "bedrock" && why != "" {
			fail(w, 400, "invalid_request", why)
			return call, relayModel{}, false
		}
		if relayCallTokens(call, m.ProseBytesPerToken) > m.ContextWindow-m.MaxOutputTokens-256 {
			fail(w, 400, "context_length_exceeded", relayTooLong)
			return call, relayModel{}, false
		}
		return call, m, true
	}
	fail(w, 404, "model_not_found", "This model is not offered: list them at /models")
	return call, relayModel{}, false
}

// reserveRelayInvocation admits one relayed call as reserveInvocation admits a run's, under the workspace's lock: the key
// still live and its member still one, the workspace's entitlement and a plan-only model's gate, then the owner's plan
// (its agents at once, today's free calls, the period's credits) or the free allowance (the workspace's calls at once and
// its daily total, and the paid routes' allowances). A relayed call belongs to no run, so it never takes a place a run
// already holds: on a plan it needs a free one (accountSlotsUsed counts relayed calls). An admitted call also holds one
// of the relay worker's places (capacity is the worker's calls at once) until it ends. While no place is free it tries
// again, backing off, until ctx ends.
func (a *App) reserveRelayInvocation(ctx context.Context, caller relayCaller, id string, facts *invocationFacts, capacity int) error {
	for wait := 40 * time.Millisecond; ; wait = min(wait*2, 500*time.Millisecond) {
		if admitted, e := a.relayAdmission(ctx, caller, id, facts, capacity); e != nil || admitted {
			return e
		}
		// Waiting for a place backs off from 40 ms to half a second, as reserveInvocation's does.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// relayAdmission is one try at a relayed call's admission, in one of the site's places to be admitted in
// (relayAdmissions), waited for as long as ctx lets it: true once the call is reserved, false while its workspace, its
// plan or the relay worker has no place free. A try holds a database connection, which it gives back before its call
// waits for the next. The relay worker's place is taken only once the try holds its workspace's row, so a call waiting
// for its place to be admitted in, or for that row, holds none; it is kept only if the call is admitted (relayLimits.take).
func (a *App) relayAdmission(ctx context.Context, caller relayCaller, id string, facts *invocationFacts, capacity int) (bool, error) {
	slots := a.relayLimits.admitting()
	select {
	case slots <- struct{}{}:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	defer func() { <-slots }()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(context.Background())
	gate, e := a.openRelayGate(ctx, tx, caller, facts)
	if e != nil {
		return false, e
	}
	if !a.relayLimits.take(caller.tenantID, capacity) {
		return false, nil
	}
	kept := false
	defer func() {
		if !kept {
			a.relayLimits.give(caller.tenantID)
		}
	}()
	admitted, billed := false, (*activePlan)(nil)
	if gate.plan == nil {
		admitted, e = a.admitFreeInvocation(ctx, tx, caller.tenantID, facts.Model, gate.concurrent, gate.daily, gate.routes, false)
	} else {
		billed, e = a.admitPlanRelayInvocation(ctx, tx, caller.tenantID, gate.reserve)
		admitted = billed != nil
	}
	if e != nil || !admitted {
		return false, e
	}
	if e = a.reserveInvocationFacts(ctx, tx, caller.tenantID, id, id, facts, gate.reserve, billed); e != nil {
		return false, e
	}
	if _, e = tx.Exec(ctx, "UPDATE model_invocations SET relay_key_id=$3 WHERE tenant_id=$1 AND id=$2", caller.tenantID, id, caller.keyID); e != nil {
		return false, e
	}
	// The caller leaving now must not lose the commit's answer (the call would be reserved unbeknown), and a commit that
	// stalls must not hold the call past its own bound.
	commit, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if e = tx.Commit(commit); e != nil {
		return true, e
	}
	kept = true
	return true, nil
}

// relayGate is what a relayed call's admission read of its workspace under its row's lock: its free allowance (its calls
// at once, today's calls, the paid routes' allowances), or its owner's plan and the call's credit reserve on it.
type relayGate struct {
	concurrent, daily int
	routes            []byte
	plan              *activePlan
	reserve           *int
}

// openRelayGate locks a relayed call's workspace and refuses the call outright when its key is no longer live or its
// member no longer one, the workspace is suspended, its entitlement leaves the model out, it needs a plan it lacks, a
// plan-only model's gate is closed, or its owner's plan would pay for a model this site cannot price.
func (a *App) openRelayGate(ctx context.Context, tx pgx.Tx, caller relayCaller, facts *invocationFacts) (relayGate, error) {
	var g relayGate
	var status string
	var restricted, needsPlan, live bool
	var allowed []string
	e := tx.QueryRow(ctx, "SELECT status,max_concurrent_runs,max_runs_per_day,allowed_models IS NOT NULL,COALESCE(allowed_models,'{}'),route_limits,requires_plan FROM tenants WHERE id=$1 FOR UPDATE", caller.tenantID).Scan(&status, &g.concurrent, &g.daily, &restricted, &allowed, &g.routes, &needsPlan)
	if e == nil {
		g.daily, g.routes, e = a.todayAllowance(ctx, tx, caller.tenantID, g.daily, g.routes)
	}
	if e == nil {
		g.plan, e = ownerPlan(ctx, tx, caller.tenantID, false)
	}
	if e == nil {
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM relay_keys k JOIN memberships m ON m.tenant_id=k.tenant_id AND m.user_id=k.user_id
			WHERE k.id=$1 AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() AND m.role IN ('owner','admin','member'))`, caller.keyID).Scan(&live)
	}
	if e != nil {
		return g, e
	}
	if status != "active" || !live {
		return g, errRelayRevoked
	}
	if entitlement, invalid := newModelEntitlement(restricted, allowed); invalid != nil || !entitlement.permits(facts.Model) {
		return g, errModelNotAllowed
	}
	if e = requiresPlan(ctx, tx, caller.tenantID, needsPlan, g.plan); e != nil {
		return g, e
	}
	if a.cfg.planOnlyModel(facts.Model) {
		closed, e := a.planOnlyClosed(ctx, tx, caller.tenantID, g.plan)
		if e != nil {
			return g, e
		}
		if closed {
			return g, errRouteQuota
		}
	}
	if g.plan != nil {
		g.reserve, e = a.creditReserve(facts.Runtime, facts.Model, facts.InputBytes)
	}
	return g, e
}

// errRelayRevoked: the key was revoked, expired or lost its member, or its workspace was suspended, after it was read.
var errRelayRevoked = errors.New("relay_key_revoked")

// admitPlanRelayInvocation is admitPlanInvocation for a relayed call, which has no run to hold a place for it: a free one
// among the plan's agents at once, today's free calls for a free model, the period's credits for a paid one. It counts
// without a lock first, then again under the plan row's lock, and returns the locked plan, or nil while no place is free
// (or the plan lapsed meanwhile, and the next try is free).
func (a *App) admitPlanRelayInvocation(ctx context.Context, tx pgx.Tx, tid string, reserve *int) (*activePlan, error) {
	check := func(plan *activePlan) (bool, error) {
		usage, e := accountPlanUsage(ctx, tx, plan.UserID, a.cfg.PlannerModel)
		if e != nil {
			return false, e
		}
		if reserve == nil && usage.FreeToday >= plan.Limits.Daily {
			return false, errInvocationQuota
		}
		used, e := accountSlotsUsed(ctx, tx, plan.UserID)
		return used < plan.Limits.Concurrent, e
	}
	for _, lock := range []bool{false, true} {
		plan, e := ownerPlan(ctx, tx, tid, lock)
		if e != nil || plan == nil {
			return nil, e
		}
		if free, e := check(plan); e != nil || !free {
			return nil, e
		}
		if !lock {
			continue
		}
		if reserve != nil {
			if e = checkCredits(ctx, tx, plan, *reserve); e != nil {
				return nil, e
			}
		}
		return plan, nil
	}
	return nil, nil
}

// relayRefused says whether an admission's error is its refusal, which reserved nothing.
func relayRefused(e error) bool {
	return admissionRefusal(e) != "" || errors.Is(e, errModelNotAllowed) || errors.Is(e, errRelayRevoked)
}

func relayBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	fail(w, 429, "relay_busy", "Every call that may run at once is running: try again shortly")
}

// relayRefusal answers a call whose admission was refused: its plan, allowance and route codes (admissionRefusal) as 429,
// a plan the workspace needs as 402, an unpriced model as 503, the entitlement as 403, no place freed in time as busy. A
// refusal that trying again will not change soon says so (x-should-retry, which OpenAI's clients read).
func relayRefusal(w http.ResponseWriter, e error) {
	code := admissionRefusal(e)
	if code != "" || errors.Is(e, errModelNotAllowed) || errors.Is(e, errRelayRevoked) {
		w.Header().Set("x-should-retry", "false")
	}
	switch {
	case code == "plan_required":
		fail(w, 402, code, "This workspace's owner needs a plan for it")
	case code == "model_unpriced":
		fail(w, 503, code, "This model cannot be charged yet")
	case code != "":
		fail(w, 429, code, "The workspace's allowance for this model is used up for now")
	case errors.Is(e, errModelNotAllowed):
		fail(w, 403, "model_not_allowed", "This workspace may not use this model")
	case errors.Is(e, context.DeadlineExceeded):
		relayBusy(w)
	case errors.Is(e, errRelayRevoked):
		fail(w, 401, "relay_key_invalid", "Invalid connection key")
	default:
		fail(w, 503, "relay_accounting_failed", "Could not admit the call")
	}
}

func (a *App) settleRelayCall(tid, id, status, code string, facts *invocationFacts) error {
	ctx, cancel := context.WithTimeout(context.Background(), computerCallSettleLimit)
	defer cancel()
	return a.persistExecutionContext(ctx, func(ctx context.Context) error {
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		after, e := a.settleInvocation(ctx, tx, tid, id, status, code, facts)
		if e != nil {
			return e
		}
		if e = tx.Commit(ctx); e == nil && after != nil {
			after()
		}
		return e
	})
}

// relayReply streams a relayed call's answer (Server-Sent Events), begun at once so that the edge in front of this site
// never cuts a long call as silent: a comment line every relayHeartbeat while the model works, which every reader of the
// format passes over, then the answer's chunks, or an error frame, as OpenAI's streams carry one.
type relayReply struct {
	w    http.ResponseWriter
	mu   sync.Mutex
	done bool
}

func beginRelayReply(ctx context.Context, w http.ResponseWriter) *relayReply {
	reply := &relayReply{w: w}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	reply.send(": awwo relay\n\n")
	go func() {
		beat := time.NewTicker(relayHeartbeat)
		defer beat.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-beat.C:
				if !reply.send(": keep-alive\n\n") {
					return
				}
			}
		}
	}()
	return reply
}

// send writes text to the reply and flushes it; false once the reply is over or its caller gone.
func (r *relayReply) send(text string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done {
		return false
	}
	_, e := io.WriteString(r.w, text)
	if f, ok := r.w.(http.Flusher); ok {
		f.Flush()
	}
	return e == nil
}

// end writes the reply's last text, after which nothing more is written (the heartbeat included).
func (r *relayReply) end(text string) {
	if text != "" {
		r.send(text)
	}
	r.mu.Lock()
	r.done = true
	r.mu.Unlock()
}

func (r *relayReply) fail(code, message string) {
	frame, _ := json.Marshal(map[string]any{"error": map[string]any{"code": code, "type": code, "message": message}})
	r.end("data: " + string(frame) + "\n\n")
}

// answer writes the call's answer: its message as one chunk, then its usage, then [DONE]. What the worker adds for its
// own executor (reasoning_details) is left out, and so is every tool call after the first where the caller asked for one
// at a time (parallel_tool_calls false): the model calls the next one once it has the first one's result.
func (r *relayReply) answer(model string, a relayAnswer, single bool) {
	delete(a.Message, "reasoning_details")
	// A streamed reader joins each call's argument deltas by its index, which an answer read whole leaves out.
	var toolCalls []map[string]json.RawMessage
	if json.Unmarshal(a.Message["tool_calls"], &toolCalls) == nil && len(toolCalls) > 0 {
		if single {
			toolCalls = toolCalls[:1]
		}
		for i := range toolCalls {
			toolCalls[i]["index"], _ = json.Marshal(i)
		}
		a.Message["tool_calls"], _ = json.Marshal(toolCalls)
	}
	chunk := func(fields map[string]any) string {
		frame := map[string]any{"id": a.ID, "object": "chat.completion.chunk", "created": a.Created, "model": model}
		for k, v := range fields {
			frame[k] = v
		}
		raw, _ := json.Marshal(frame)
		return "data: " + string(raw) + "\n\n"
	}
	text := chunk(map[string]any{"choices": []map[string]any{{"index": 0, "delta": a.Message, "finish_reason": a.Finish}}})
	if len(a.Usage) > 0 && string(a.Usage) != "null" {
		text += chunk(map[string]any{"choices": []any{}, "usage": a.Usage})
	}
	r.end(text + "data: [DONE]\n\n")
}

// relayAnswer is the relay worker's answer to one call: its completion's id, time, message, finish reason and usage.
type relayAnswer struct {
	ID      string
	Created int64
	Message map[string]json.RawMessage
	Finish  string
	Usage   json.RawMessage
}

// relayFailure is how a call failed once it went to the relay worker: the ledger's code, and what its caller is told.
type relayFailure struct {
	code, errCode, message string
	// refused: the worker refused the call as its caller's, before any work (relayWorkerFailure).
	refused bool
}

// forwardRelayCall sends one admitted call to the relay worker and reads its answer, recording on facts what the ledger
// settles it by: when it was sent and ended, its bytes, whether it was refused before any work, its usage.
func (a *App) forwardRelayCall(ctx context.Context, caller relayCaller, model string, body []byte, facts *invocationFacts) (relayAnswer, *relayFailure) {
	var answer relayAnswer
	req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(a.cfg.RelayWorkerURL, "/")+"/internal/computer-model", bytes.NewReader(body))
	if e != nil {
		facts.Admission = "rejected_before_start"
		return answer, &relayFailure{code: "computer_model_transport", errCode: "relay_unavailable", message: "Cloud models are unavailable right now"}
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.RelayWorkerToken)
	req.Header.Set("Content-Type", "application/json")
	// The call's time counts from here should its answer never come (plans.go creditCharge).
	facts.Streamed = time.Now()
	facts.Sent = facts.Streamed
	response, e := a.client.Do(req)
	if e != nil {
		facts.Ended = time.Now()
		if dialFailed(e) {
			facts.Admission = "rejected_before_start"
		}
		failure := &relayFailure{code: computerCallBroke(e, ctx.Err() != nil), errCode: "relay_model_transport", message: "The model's answer did not arrive"}
		a.logRelayCall(caller, model, 0, nil, failure.code, facts)
		return answer, failure
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 400, 401, 409, 413, 415, 422, 429, 503:
		// The worker refused the call before any model work: it never counts (as computerModelProxy).
		facts.Admission = "rejected_before_start"
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	facts.Ended = time.Now()
	facts.OutputBytes = int64(len(data))
	if e != nil || len(data) > 2<<20 || response.StatusCode != 200 {
		failure := relayWorkerFailure(response.StatusCode, data, e, ctx.Err() != nil, facts)
		a.logRelayCall(caller, model, response.StatusCode, data, failure.code, facts)
		return answer, failure
	}
	var result struct {
		Completion    json.RawMessage `json:"completion"`
		Observability json.RawMessage `json:"observability"`
	}
	var completion struct {
		ID      string `json:"id"`
		Created int64  `json:"created"`
		Choices []struct {
			Message      map[string]json.RawMessage `json:"message"`
			FinishReason string                     `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(data, &result) != nil || json.Unmarshal(result.Completion, &completion) != nil || len(completion.Choices) != 1 || completion.Choices[0].Message == nil {
		failure := &relayFailure{code: "computer_model_protocol", errCode: "relay_model_failed", message: "The model's answer was invalid"}
		a.logRelayCall(caller, model, response.StatusCode, nil, failure.code, facts)
		return answer, failure
	}
	facts.receive(result.Observability, a.cfg.RunTimeout)
	facts.Admission = "accepted"
	choice := completion.Choices[0]
	return relayAnswer{ID: completion.ID, Created: completion.Created, Message: choice.Message, Finish: choice.FinishReason, Usage: completion.Usage}, nil
}

// relayWorkerFailure is a call the relay worker answered with an error, or whose answer broke off: the ledger's code (as
// for a direct task's call: computerModelFailure, computerCallBroke), and what its caller is told. A call longer than
// its model reads is context_length_exceeded (OpenAI's code, by which callers shorten a conversation); a worker at
// capacity, or Bedrock throttling, is busy; any other failed. Bedrock refusing the call within moments, before its
// stream began (bedrock:<status>:<type>, never stream:…), for a fault of the platform's side (computerProviderFault:
// its quota, its credentials, its service) did no model work, which AWS does not bill either: the call never counts, as
// one the worker refused. Its refusal of the request itself (a 400) is the call's own and counts, as a direct task's
// does; so does every other failure. What the worker refused as the call's own, before any work (its check of the
// request, the provider's size refusal), counts nowhere, so the key is told (refused) and held off when it keeps
// sending such calls (relayRefusalsPerMinute).
func relayWorkerFailure(status int, data []byte, readErr error, done bool, facts *invocationFacts) *relayFailure {
	if readErr != nil {
		return &relayFailure{code: computerCallBroke(readErr, done), errCode: "relay_model_transport", message: "The model's answer did not arrive"}
	}
	workerCode, reason, detail := computerWorkerError(data)
	failure := &relayFailure{code: computerModelFailure(status, data, false), errCode: "relay_model_failed", message: "The model could not complete this call"}
	quick := facts.sinceSent(facts.Ended) < quickRefusal()
	sized := computerSizeRefusal(status, data)
	platform := status == 502 && workerCode == "PROVIDER_ERROR" && strings.HasPrefix(reason, "bedrock:") && computerProviderFault(reason)
	if (sized || platform) && quick {
		facts.Admission = "rejected_before_start"
	}
	failure.refused = (status == 400 && workerCode == "INVALID_INPUT") || status == 413 || (sized && quick)
	switch {
	case sized || (status == 413 && workerCode == "CONTEXT_LIMIT"):
		failure.errCode, failure.message = "context_length_exceeded", relayTooLong
	case status == 400 && workerCode == "INVALID_INPUT":
		failure.errCode, failure.message = "invalid_request", "The call does not hold: "+detail
	case status == 429 || status == 409 || strings.HasPrefix(reason, "bedrock:429"):
		failure.errCode, failure.message = "relay_busy", "Cloud models are busy: try again shortly"
	case status == 503:
		failure.errCode, failure.message = "relay_unavailable", "Cloud models are unavailable right now"
	}
	return failure
}

// logRelayCall logs a relayed call that failed once it went to the relay worker, by kind alone (as logComputerCall): its
// key, workspace, model, what the worker answered and the ledger's code; never the call's words or the worker's message.
func (a *App) logRelayCall(caller relayCaller, model string, status int, body []byte, code string, facts *invocationFacts) {
	workerCode, reason, detail := computerWorkerError(body)
	a.log.Warn("relayed model call failed", "key", caller.keyID, "tenant", caller.tenantID, "model", model,
		"workerStatus", status, "workerCode", workerCode, "reason", reason, "detail", detail, "code", code, "ms", facts.Ended.Sub(facts.Streamed).Milliseconds())
}
