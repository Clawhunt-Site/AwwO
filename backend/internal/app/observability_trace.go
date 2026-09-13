package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

// The SDK never receives a provider payload or a raw error. Export failures are
// reduced to a fixed error, including collector response bodies and credentials.
type safeTraceExporter struct {
	sdktrace.SpanExporter
	app *App
}

func (e safeTraceExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if err := e.SpanExporter.ExportSpans(ctx, spans); err != nil {
		e.app.obs.counters["telemetry_export_errors_total"].WithLabelValues().Inc()
		return errors.New("AwwO trace export unavailable")
	}
	return nil
}
func (a *App) startTracing(ctx context.Context) error {
	if a.obs == nil || !a.cfg.OTelEnabled {
		return nil
	}
	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(a.cfg.OTelEndpoint), otlptracehttp.WithHeaders(map[string]string{}), otlptracehttp.WithTimeout(2*time.Second), otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}), otlptracehttp.WithHTTPClient(&http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}))
	if err != nil {
		return errors.New("cannot initialize AwwO trace exporter")
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", "awwo-api"), attribute.String("deployment.environment.name", a.cfg.Env), attribute.String("service.version", BuildRevision()))), sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(a.cfg.OTelSampleRatio))), sdktrace.WithBatcher(safeTraceExporter{exporter, a}, sdktrace.WithMaxQueueSize(1024), sdktrace.WithMaxExportBatchSize(128), sdktrace.WithBatchTimeout(time.Second), sdktrace.WithExportTimeout(2*time.Second)))
	a.obs.tracer = provider.Tracer("awwo-api")
	a.obs.shutdown = provider.Shutdown
	return nil
}

// Lightweight callers may construct App without observability initialization.
// Tracing must remain optional for the business operation in that case.
func (a *App) telemetryTracer() trace.Tracer {
	if a.obs != nil && a.obs.tracer != nil {
		return a.obs.tracer
	}
	return noop.NewTracerProvider().Tracer("awwo-api")
}

// startAsyncTrace retains only a link and a server-generated request identity.
// Caller cancellation never becomes background execution cancellation.
func (a *App) startAsyncTrace(parent context.Context, name, kind, runtime string) (context.Context, func(string)) {
	ctx := context.WithValue(context.Background(), requestIDKey{}, requestIDFromContext(parent))
	name = enum(name, "awwo.run.execute", "awwo.graph.execute")
	if name == "unknown" {
		name = "awwo.run.execute"
	}
	options := []trace.SpanStartOption{trace.WithNewRoot(), trace.WithAttributes(attribute.String("awwo.kind", metricKind(kind)), attribute.String("awwo.runtime", metricRuntime(runtime, true)))}
	if sc := trace.SpanContextFromContext(parent); sc.IsValid() {
		options = append(options, trace.WithLinks(trace.Link{SpanContext: sc}))
	} else {
		options = append(options, trace.WithAttributes(attribute.Bool("awwo.recovery", true)))
	}
	ctx, span := a.telemetryTracer().Start(ctx, name, options...)
	return ctx, func(outcome string) { endTelemetrySpan(span, metricOutcome(outcome)) }
}
func (a *App) startInternalTrace(ctx context.Context, runtime, model string) (context.Context, func(string)) {
	ctx, span := a.telemetryTracer().Start(ctx, "awwo.runtime.admit", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(attribute.String("awwo.runtime", metricRuntime(runtime, false)), attribute.String("awwo.model", a.telemetryModel(runtime, model))))
	return ctx, func(outcome string) {
		endTelemetrySpan(span, enum(outcome, "accepted", "session_busy", "rejected_busy", "rejected_capacity", "rejected_invalid", "transport_unknown", "timeout", "cancelled"))
	}
}
func (a *App) startTeamTrace(ctx context.Context, purpose, runtime string, round int) (context.Context, func(string)) {
	attrs := []attribute.KeyValue{attribute.String("awwo.purpose", enum(purpose, "work", "aggregate", "review", "revise")), attribute.String("awwo.runtime", metricRuntime(runtime, false))}
	if round >= 0 && round <= 100 {
		attrs = append(attrs, attribute.Int("awwo.round", round))
	}
	ctx, span := a.telemetryTracer().Start(ctx, "awwo.team.member_turn", trace.WithAttributes(attrs...))
	return ctx, func(outcome string) { endTelemetrySpan(span, metricOutcome(outcome)) }
}
func (a *App) startGraphNodeTrace(ctx context.Context, runtime string) (context.Context, func(string)) {
	ctx, span := a.telemetryTracer().Start(ctx, "awwo.graph.node", trace.WithAttributes(attribute.String("awwo.runtime", metricRuntime(runtime, true))))
	return ctx, func(outcome string) {
		endTelemetrySpan(span, enum(outcome, "done", "failed", "blocked", "cancelled", "cached"))
	}
}
func endTelemetrySpan(span trace.Span, outcome string) {
	span.SetAttributes(attribute.String("awwo.outcome", outcome))
	if outcome == "failed" || outcome == "interrupted" || outcome == "transport_unknown" || outcome == "timeout" {
		span.SetStatus(codes.Error, "operation failed")
	}
	span.End()
}

func (a *App) injectWorkerTrace(req *http.Request, runtime string) {
	for _, header := range []string{"traceparent", "tracestate", "baggage", "X-Request-ID"} {
		req.Header.Del(header)
	}
	endpoint, token, err := a.runtimeEndpoint(runtime)
	if err != nil || req.URL.String() != strings.TrimRight(endpoint, "/")+"/internal/runs" || req.Header.Get("Authorization") != "Bearer "+token {
		return
	}
	// Only W3C tracecontext is propagated; baggage and tracestate are never copied.
	sc := trace.SpanContextFromContext(req.Context())
	if sc.IsValid() {
		clean := trace.NewSpanContext(trace.SpanContextConfig{TraceID: sc.TraceID(), SpanID: sc.SpanID(), TraceFlags: sc.TraceFlags()})
		propagation.TraceContext{}.Inject(trace.ContextWithSpanContext(req.Context(), clean), propagation.HeaderCarrier(req.Header))
	}
	if id := requestIDFromContext(req.Context()); id != "" {
		req.Header.Set("X-Request-ID", id)
	}
}

func (a *App) traceReference(kind, id string) []attribute.KeyValue {
	if len(a.cfg.TraceRefKey) != 32 || a.cfg.TraceRefVersion == "" || id == "" || enum(kind, "request", "run", "invocation", "graph", "node", "member") == "unknown" {
		return nil
	}
	hash := hmac.New(sha256.New, a.cfg.TraceRefKey)
	hash.Write([]byte(a.cfg.TraceRefVersion + "\x00" + kind + "\x00" + id))
	return []attribute.KeyValue{attribute.String("awwo."+kind+"_ref", hex.EncodeToString(hash.Sum(nil)[:16])), attribute.String("awwo.ref_key_version", a.cfg.TraceRefVersion)}
}

func (a *App) startDBTrace(ctx context.Context, operation string) (context.Context, func(string)) {
	operation = enum(operation, "auth_lookup", "tenant_authorize", "run_create", "run_read", "run_event_append", "run_terminal_commit", "invocation_reserve", "invocation_terminal_commit", "graph_schedule", "usage_query", "usage_snapshot", "migration", "health", "other")
	started := time.Now()
	ctx, span := a.telemetryTracer().Start(ctx, "db.query", trace.WithAttributes(attribute.String("awwo.operation", operation)))
	return ctx, func(outcome string) {
		outcome = enum(outcome, "success", "error", "timeout", "cancelled")
		a.observeDB(operation, outcome, time.Since(started))
		endTelemetrySpan(span, outcome)
	}
}
func (a *App) startLedgerTrace(ctx context.Context, operation string) (context.Context, func(string)) {
	operation = enum(operation, "run_terminal_commit", "invocation_terminal_commit")
	ctx, span := a.telemetryTracer().Start(ctx, "awwo.ledger.commit", trace.WithAttributes(attribute.String("awwo.operation", operation)))
	return ctx, func(outcome string) {
		endTelemetrySpan(span, enum(outcome, "committed", "retryable_error", "permanent_error"))
	}
}
