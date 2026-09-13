package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"go.opentelemetry.io/otel/trace"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
)

// Missing provider facts are SQL NULL. In particular, SDK synthetic zeroes and
// uncertain admissions must never become a zero-token or zero-cost invoice.
type InvocationUsage struct {
	Status              string `json:"status"`
	Source              string `json:"source"`
	Reason              string `json:"reason,omitempty"`
	InputTokens         *int64 `json:"inputTokens"`
	OutputTokens        *int64 `json:"outputTokens"`
	CachedInputTokens   *int64 `json:"cachedInputTokens"`
	CacheWriteTokens    *int64 `json:"cacheWriteTokens"`
	ReasoningTokens     *int64 `json:"reasoningTokens"`
	ProviderTotalTokens *int64 `json:"providerTotalTokens"`
	ComputedTotalTokens *int64 `json:"computedTotalTokens"`
}
type InvocationTiming struct {
	QueueMs            *int64 `json:"queueMs,omitempty"`
	AdmissionMs        *int64 `json:"admissionMs,omitempty"`
	SetupMs            *int64 `json:"setupMs"`
	ProviderMs         *int64 `json:"providerMs"`
	ProviderTtftMs     *int64 `json:"providerTtftMs"`
	WorkerTotalMs      *int64 `json:"workerTotalMs"`
	WorkerFirstDeltaMs *int64 `json:"workerFirstDeltaMs"`
}
type invocationFacts struct {
	Runtime, Model, Provider, ProviderModel, Protocol, TurnID, AgentID string
	Admission                                                          string
	Version                                                            *int
	Terminal                                                           bool
	Usage                                                              InvocationUsage
	Timing                                                             InvocationTiming
}

func int64ptr(n int64) *int64 { return &n }
func missingUsage(status, reason string) InvocationUsage {
	return InvocationUsage{Status: status, Source: "none", Reason: reason}
}

// Parse only the bounded numeric protocol, never retain unknown attributes or
// raw worker/provider diagnostics in telemetry or the accounting ledger.
func parseInvocationObservability(raw json.RawMessage, timeout time.Duration) (InvocationUsage, InvocationTiming) {
	var empty InvocationTiming
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return missingUsage("unavailable", "legacy_worker"), empty
	}
	invalid := func(reason string) (InvocationUsage, InvocationTiming) { return missingUsage("invalid", reason), empty }
	if len(raw) > 8192 {
		return invalid("protocol_invalid")
	}
	var envelope struct {
		Version int              `json:"version"`
		Usage   InvocationUsage  `json:"usage"`
		Timing  InvocationTiming `json:"timing"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&envelope) != nil || envelope.Version != 1 || d.Decode(new(any)) != io.EOF {
		return invalid("protocol_invalid")
	}
	u, tm := envelope.Usage, envelope.Timing
	if u.Source != "none" && u.Source != "provider_raw" && u.Source != "sdk_normalized" {
		return invalid("protocol_invalid")
	}
	switch u.Status {
	case "reported", "partial", "unavailable", "invalid", "unknown":
	default:
		return invalid("protocol_invalid")
	}
	for _, n := range []*int64{u.InputTokens, u.OutputTokens, u.CachedInputTokens, u.CacheWriteTokens, u.ReasoningTokens, u.ProviderTotalTokens, u.ComputedTotalTokens} {
		if n != nil && (*n < 0 || *n > 9007199254740991) {
			return invalid("protocol_invalid")
		}
	}
	limit := (timeout + 30*time.Second).Milliseconds()
	if limit < 30000 {
		limit = 30000
	}
	for _, n := range []*int64{tm.SetupMs, tm.ProviderMs, tm.ProviderTtftMs, tm.WorkerTotalMs, tm.WorkerFirstDeltaMs} {
		if n != nil && (*n < 0 || *n > limit) {
			return invalid("protocol_invalid")
		}
	}
	// Workers cannot supply Go queue/admission times.
	if tm.QueueMs != nil || tm.AdmissionMs != nil {
		return invalid("protocol_invalid")
	}
	for _, pair := range [][2]*int64{{tm.ProviderTtftMs, tm.ProviderMs}, {tm.SetupMs, tm.WorkerTotalMs}, {tm.ProviderMs, tm.WorkerTotalMs}, {tm.WorkerFirstDeltaMs, tm.WorkerTotalMs}} {
		if pair[0] != nil && pair[1] != nil && *pair[0] > *pair[1] {
			return invalid("protocol_invalid")
		}
	}
	if u.CachedInputTokens != nil && u.InputTokens != nil && *u.CachedInputTokens > *u.InputTokens {
		return invalid("total_mismatch")
	}
	if u.ReasoningTokens != nil && u.OutputTokens != nil && *u.ReasoningTokens > *u.OutputTokens {
		return invalid("total_mismatch")
	}
	if u.InputTokens != nil && u.OutputTokens != nil {
		total := *u.InputTokens + *u.OutputTokens
		if total > 9007199254740991 || (u.ProviderTotalTokens != nil && *u.ProviderTotalTokens != total) || (u.ComputedTotalTokens != nil && *u.ComputedTotalTokens != total) {
			return invalid("total_mismatch")
		}
		u.ComputedTotalTokens = int64ptr(total)
	} else if u.ComputedTotalTokens != nil {
		return invalid("protocol_invalid")
	}
	hasAny := u.InputTokens != nil || u.OutputTokens != nil || u.CachedInputTokens != nil || u.CacheWriteTokens != nil || u.ReasoningTokens != nil || u.ProviderTotalTokens != nil
	if (u.Source == "none" && hasAny) || (u.Status == "reported" && (u.InputTokens == nil || u.OutputTokens == nil || u.Source == "none")) {
		return invalid("protocol_invalid")
	}
	switch u.Status {
	case "reported":
		u.Reason = "none"
	case "partial":
		if !hasAny || u.Source == "none" {
			return invalid("protocol_invalid")
		}
		u.Reason = "field_missing"
	case "unavailable":
		if hasAny {
			return invalid("protocol_invalid")
		}
		u = missingUsage("unavailable", "provider_missing")
	case "unknown":
		if hasAny {
			return invalid("protocol_invalid")
		}
		u = missingUsage("unknown", "transport_unknown")
	case "invalid":
		reason := "protocol_invalid"
		if u.Reason == "total_mismatch" {
			reason = u.Reason
		}
		u = missingUsage("invalid", reason)
	}
	return u, tm
}

func (f *invocationFacts) receive(raw json.RawMessage, timeout time.Duration) {
	queue, admission := f.Timing.QueueMs, f.Timing.AdmissionMs
	f.Usage, f.Timing = parseInvocationObservability(raw, timeout)
	f.Timing.QueueMs, f.Timing.AdmissionMs = queue, admission
	f.Terminal = true
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		version := 0
		f.Version = &version
	} else {
		var v struct {
			Version int `json:"version"`
		}
		if json.Unmarshal(raw, &v) == nil && v.Version >= 0 && v.Version <= 2147483647 {
			f.Version = &v.Version
		}
	}
}

func invocationMetadata(s executionSnapshot, member *teamMember) *invocationFacts {
	f := &invocationFacts{Runtime: defaultRuntime(s.Runtime), Model: s.Model, Admission: "not_attempted", Usage: missingUsage("unavailable", "provider_missing")}
	if member != nil {
		f.Runtime, f.Model, f.AgentID = member.Runtime, member.Model, member.ID
	}
	if h, ok := s.memberHealth(f.Runtime); ok {
		f.Provider = h.Provider
		for _, m := range h.Models {
			if m.ID == f.Model {
				f.Provider = m.Provider
				f.ProviderModel, f.Protocol = m.ProviderModel, m.Protocol
				break
			}
		}
	}
	// Older workers may omit provider provenance; preserve unknown values.
	return f
}

func (a *App) reserveInvocationFacts(ctx context.Context, tx pgx.Tx, tid, rid, id string, f *invocationFacts) error {
	if f == nil {
		f = &invocationFacts{Runtime: runtimePI, Admission: "not_attempted"}
	}
	version, snapshot := a.pricing.Freeze(f.Runtime, f.Model)
	requestID, traceID := RequestID(ctx), ""
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		traceID = sc.TraceID().String()
	}
	_, err := tx.Exec(ctx, `INSERT INTO model_invocations(id,tenant_id,run_id,status,turn_id,agent_id,runtime,provider,model_id,provider_model,protocol,admission_status,usage_status,usage_source,usage_reason,cost_status,pricing_version,price_snapshot,queue_ms,request_id,trace_id)
	 VALUES($1,$2,$3,'running',NULLIF($4,''),COALESCE(NULLIF($5,''),(SELECT s.agent_id FROM runs r JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE r.tenant_id=$2 AND r.id=$3)),$6,$7,$8,$9,$10,'not_attempted','unavailable','none','provider_missing','not_incurred',$11,$12,$13,$14,$15)`, id, tid, rid, f.TurnID, f.AgentID, f.Runtime, f.Provider, f.Model, f.ProviderModel, f.Protocol, version, snapshot, f.Timing.QueueMs, requestID, traceID)
	return err
}

// Persist uncertainty before the HTTP POST; a process crash cannot turn an
// already-dispatched model call into not_incurred during restart recovery.
func (a *App) markInvocationAdmission(ctx context.Context, tid, id string, f *invocationFacts, state string) error {
	_, err := a.db.Exec(ctx, `UPDATE model_invocations SET admission_status=$3,admitted_at=CASE WHEN $3='accepted' THEN clock_timestamp() ELSE admitted_at END,admission_ms=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='running'`, tid, id, state, f.Timing.AdmissionMs)
	if err == nil {
		f.Admission = state
	}
	return err
}

func invocationFailure(status, code string) string {
	if status == "completed" {
		return "none"
	}
	if status == "interrupted" {
		return "restart"
	}
	if status == "cancelled" {
		return "cancelled"
	}
	switch code {
	case "run_timeout", "team_timeout":
		return "timeout"
	case "runtime_failed":
		return "provider"
	case "invalid_runtime_event", "inconsistent_runtime_output", "output_limit", "invalid_canvas_plan":
		return "protocol"
	case "runtime_session_busy", "runtime_rejected":
		return "capacity"
	case "runtime_unavailable", "runtime_stream_ended":
		return "transport"
	case "database_unavailable", "event_persistence_failed", "turn_persistence_failed", "accounting_commit_failed":
		return "persistence"
	case "quota_exceeded":
		return "quota"
	default:
		return "validation"
	}
}

// Called inside the same transaction as its run/message/events or team turn.
// Return a metric closure only for the first transition, to run AFTER commit.
func (a *App) settleInvocation(ctx context.Context, tx pgx.Tx, tid, id, status, code string, f *invocationFacts) (func(), error) {
	if f == nil {
		return nil, errors.New("missing invocation facts")
	}
	u := f.Usage
	costStatus := "unavailable"
	if !f.Terminal {
		if f.Admission == "accepted" || f.Admission == "unknown" {
			reason := "transport_unknown"
			if status == "cancelled" {
				reason = "cancelled_after_admission"
			}
			if status == "interrupted" {
				reason = "worker_lost"
			}
			u = missingUsage("unknown", reason)
		} else {
			u = missingUsage("unavailable", "provider_missing")
		}
	}
	var price json.RawMessage
	err := tx.QueryRow(ctx, `SELECT price_snapshot FROM model_invocations WHERE tenant_id=$1 AND id=$2 AND status='running' FOR UPDATE`, tid, id).Scan(&price)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cost *int64
	if f.Admission == "not_attempted" || f.Admission == "rejected_before_start" {
		costStatus = "not_incurred"
	} else if u.Status == "unknown" {
		costStatus = "unknown"
	} else if u.Status == "reported" || u.Status == "partial" {
		cost, _ = EstimateInvocationCost(price, u)
		if cost != nil {
			costStatus = "estimated"
		}
	}
	tm := f.Timing
	tag, err := tx.Exec(ctx, `UPDATE model_invocations SET status=$3,admission_status=$4,usage_status=$5,usage_source=$6,usage_reason=$7,
	 input_tokens=$8,output_tokens=$9,cached_input_tokens=$10,cache_write_tokens=$11,reasoning_tokens=$12,provider_total_tokens=$13,computed_total_tokens=$14,
	 queue_ms=$15,admission_ms=$16,setup_ms=$17,provider_ms=$18,provider_ttft_ms=$19,worker_total_ms=$20,worker_first_delta_ms=$21,
	 cost_status=$22,estimated_cost_microusd=$23,failure_class=$24,completed_at=clock_timestamp(),completed_xid=pg_current_xact_id(),updated_at=clock_timestamp(),observability_version=$25
	 WHERE tenant_id=$1 AND id=$2 AND status='running'`, tid, id, status, f.Admission, u.Status, u.Source, u.Reason, u.InputTokens, u.OutputTokens, u.CachedInputTokens, u.CacheWriteTokens, u.ReasoningTokens, u.ProviderTotalTokens, u.ComputedTotalTokens, tm.QueueMs, tm.AdmissionMs, tm.SetupMs, tm.ProviderMs, tm.ProviderTtftMs, tm.WorkerTotalMs, tm.WorkerFirstDeltaMs, costStatus, cost, invocationFailure(status, code), f.Version)
	if err != nil || tag.RowsAffected() == 0 {
		return nil, err
	}
	return func() {
		a.observeInvocation(f.Runtime, f.Model, status, u.Status, u.Reason, map[string]*int64{"input": u.InputTokens, "output": u.OutputTokens, "cache_read": u.CachedInputTokens, "cache_write": u.CacheWriteTokens, "reasoning": u.ReasoningTokens}, tm.ProviderMs, tm.ProviderTtftMs, cost)
	}, nil
}

func settleAbandonedInvocations(ctx context.Context, tx pgx.Tx, tid, rid, status string) error {
	_, err := tx.Exec(ctx, `UPDATE model_invocations SET status=$3,usage_status=CASE WHEN admission_status IN ('accepted','unknown') THEN 'unknown' ELSE 'unavailable' END,
	 usage_source='none',usage_reason=CASE WHEN admission_status IN ('accepted','unknown') THEN 'worker_lost' ELSE 'provider_missing' END,
	 cost_status=CASE WHEN admission_status IN ('accepted','unknown') THEN 'unknown' ELSE 'not_incurred' END,failure_class='restart',completed_at=clock_timestamp(),completed_xid=pg_current_xact_id(),updated_at=clock_timestamp()
	 WHERE tenant_id=$1 AND run_id=$2 AND status='running'`, tid, rid, status)
	return err
}

func snapshotRuntime(s executionSnapshot) string {
	r := defaultRuntime(s.Runtime)
	if s.Team != nil {
		r = ""
		for _, m := range s.Team.Members {
			if r == "" {
				r = memberRuntime(s.Team, m)
			} else if r != memberRuntime(s.Team, m) {
				return "mixed"
			}
		}
	}
	return r
}
