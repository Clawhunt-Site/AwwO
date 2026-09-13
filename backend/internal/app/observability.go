package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

var httpBuckets = []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30}
var admissionBuckets = []float64{.01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30}
var modelBuckets = []float64{.1, .25, .5, 1, 2.5, 5, 10, 20, 30, 60, 120, 180, 300, 600}
var dbBuckets = []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}

type observability struct {
	registry   *prometheus.Registry
	counters   map[string]*prometheus.CounterVec
	histograms map[string]*prometheus.HistogramVec
	gauges     map[string]*prometheus.GaugeVec
	mu         sync.RWMutex
	models     map[string]bool
	tracer     trace.Tracer
	shutdown   func(context.Context) error
	server     *http.Server
	listener   net.Listener
	cancel     context.CancelFunc
	tasks      sync.WaitGroup
	closeOnce  sync.Once
}

func newObservability(a *App) *observability {
	o := &observability{registry: prometheus.NewRegistry(), counters: map[string]*prometheus.CounterVec{}, histograms: map[string]*prometheus.HistogramVec{}, gauges: map[string]*prometheus.GaugeVec{}, models: map[string]bool{}, tracer: noop.NewTracerProvider().Tracer("awwo-api")}
	counter := func(name string, labels ...string) {
		v := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "awwo_" + name, Help: "AwwO " + strings.ReplaceAll(name, "_", " ") + "."}, labels)
		o.registry.MustRegister(v)
		o.counters[name] = v
	}
	hist := func(name string, buckets []float64, labels ...string) {
		v := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "awwo_" + name, Help: "AwwO " + strings.ReplaceAll(name, "_", " ") + ".", Buckets: buckets}, labels)
		o.registry.MustRegister(v)
		o.histograms[name] = v
	}
	gauge := func(name string, labels ...string) {
		v := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "awwo_" + name, Help: "AwwO " + strings.ReplaceAll(name, "_", " ") + "."}, labels)
		o.registry.MustRegister(v)
		o.gauges[name] = v
	}
	counter("http_requests_total", "route", "method", "status_class", "stream")
	hist("http_request_duration_seconds", httpBuckets, "route", "method", "status_class", "stream")
	hist("sse_handshake_duration_seconds", admissionBuckets, "route", "status_class")
	gauge("http_requests_in_flight", "method")
	counter("runs_total", "kind", "runtime", "outcome")
	hist("run_queue_duration_seconds", []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 120}, "kind", "outcome")
	counter("runtime_admissions_total", "runtime", "outcome")
	hist("runtime_admission_duration_seconds", admissionBuckets, "runtime", "outcome")
	counter("model_invocations_total", "runtime", "model", "outcome")
	counter("model_tokens_total", "runtime", "model", "direction")
	counter("model_usage_missing_total", "runtime", "reason")
	counter("model_estimated_cost_usd_total", "runtime", "model")
	hist("model_time_to_first_token_seconds", modelBuckets, "runtime", "model")
	hist("model_duration_seconds", modelBuckets, "runtime", "model", "outcome")
	counter("ledger_commits_total", "operation", "outcome")
	hist("db_query_duration_seconds", dbBuckets, "operation", "outcome")
	counter("graph_runs_total", "outcome")
	counter("graph_nodes_total", "state")
	gauge("graph_runs_active", "state")
	gauge("graph_nodes_active", "state")
	hist("graph_node_duration_seconds", modelBuckets, "runtime", "outcome")
	counter("team_turns_total", "purpose", "runtime", "outcome")
	hist("team_turn_duration_seconds", modelBuckets, "purpose", "runtime", "outcome")
	gauge("team_members_active", "runtime")
	counter("telemetry_export_errors_total")
	counter("telemetry_snapshot_errors_total")
	if a.db != nil {
		for _, state := range []string{"acquired", "idle", "total", "max"} {
			s := state
			o.registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "awwo_db_pool_connections", Help: "Current PostgreSQL pool connections.", ConstLabels: prometheus.Labels{"state": s}}, func() float64 {
				p := a.db.Stat()
				switch s {
				case "acquired":
					return float64(p.AcquiredConns())
				case "idle":
					return float64(p.IdleConns())
				case "total":
					return float64(p.TotalConns())
				default:
					return float64(p.MaxConns())
				}
			}))
		}
		o.registry.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{Name: "awwo_db_pool_wait_seconds_total", Help: "Cumulative wait for a pool connection."}, func() float64 { return a.db.Stat().EmptyAcquireWaitTime().Seconds() }))
		o.registry.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{Name: "awwo_db_pool_wait_events_total", Help: "Cumulative waits for a pool connection."}, func() float64 { return float64(a.db.Stat().EmptyAcquireCount()) }))
	}
	return o
}

// StartObservability must be called before accepting requests. Exporters never
// hold up business work; an unsafe or occupied management address fails startup.
func (a *App) StartObservability(ctx context.Context) error {
	if err := a.cfg.validateObservability(); err != nil {
		return err
	}
	if err := a.startTracing(ctx); err != nil {
		return err
	}
	if !a.cfg.MetricsEnabled {
		return nil
	}
	listener, err := net.Listen("tcp", a.cfg.MetricsListenAddr)
	if err != nil {
		return errors.New("cannot bind the loopback metrics listener")
	}
	a.obs.listener = listener
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(a.obs.registry, promhttp.HandlerOpts{Timeout: 3 * time.Second, MaxRequestsInFlight: 2, DisableCompression: true}))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	a.obs.server = &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 4096}
	a.obs.tasks.Add(1)
	go func() {
		defer a.obs.tasks.Done()
		if err := a.obs.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			a.log.Error("metrics listener stopped")
			a.obs.counters["telemetry_export_errors_total"].WithLabelValues().Inc()
		}
	}()
	watch, cancel := context.WithCancel(context.Background())
	a.obs.cancel = cancel
	if a.db != nil {
		a.startUsageAggregation(watch)
		a.obs.tasks.Add(1)
		go func() {
			defer a.obs.tasks.Done()
			tick := time.NewTicker(15 * time.Second)
			defer tick.Stop()
			for {
				a.refreshActiveMetrics(watch)
				select {
				case <-watch.Done():
					return
				case <-tick.C:
				}
			}
		}()
	}
	return nil
}
func (a *App) closeObservability() {
	if a.obs == nil {
		return
	}
	a.obs.closeOnce.Do(func() {
		if a.obs.cancel != nil {
			a.obs.cancel()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if a.obs.server != nil {
			_ = a.obs.server.Shutdown(ctx)
		}
		a.obs.tasks.Wait()
		if a.obs.shutdown != nil {
			_ = a.obs.shutdown(ctx)
		}
	})
}

func (a *App) refreshActiveMetrics(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, time.Second)
	defer cancel()
	rows, err := a.db.Query(ctx, `SELECT 'graph',status,count(*) FROM graph_runs WHERE status IN ('queued','running') GROUP BY status UNION ALL SELECT 'node',state,count(*) FROM graph_run_nodes WHERE state IN ('waiting','running') GROUP BY state UNION ALL SELECT 'member',COALESCE(NULLIF(config->>'runtime',''),'pi'),count(*) FROM run_turns WHERE status='running' GROUP BY COALESCE(NULLIF(config->>'runtime',''),'pi')`)
	if err != nil {
		if parent.Err() == nil {
			a.obs.counters["telemetry_snapshot_errors_total"].WithLabelValues().Inc()
		}
		return
	}
	defer rows.Close()
	type active struct {
		kind, state string
		count       float64
	}
	var found []active
	for rows.Next() {
		var f active
		if err := rows.Scan(&f.kind, &f.state, &f.count); err != nil {
			return
		}
		found = append(found, f)
	}
	if rows.Err() != nil {
		return
	}
	for _, state := range []string{"queued", "running"} {
		a.obs.gauges["graph_runs_active"].WithLabelValues(state).Set(0)
	}
	for _, state := range []string{"waiting", "running"} {
		a.obs.gauges["graph_nodes_active"].WithLabelValues(state).Set(0)
	}
	for _, runtime := range []string{runtimePI, runtimeOpenAIAgents} {
		a.obs.gauges["team_members_active"].WithLabelValues(runtime).Set(0)
	}
	for _, f := range found {
		switch f.kind {
		case "graph":
			a.obs.gauges["graph_runs_active"].WithLabelValues(enum(f.state, "queued", "running")).Set(f.count)
		case "node":
			a.obs.gauges["graph_nodes_active"].WithLabelValues(enum(f.state, "waiting", "running")).Set(f.count)
		case "member":
			a.obs.gauges["team_members_active"].WithLabelValues(metricRuntime(f.state, false)).Set(f.count)
		}
	}
}

func enum(s string, values ...string) string {
	for _, v := range values {
		if s == v {
			return v
		}
	}
	return "unknown"
}
func metricRuntime(s string, mixed bool) string {
	if validRuntime(s) {
		return s
	}
	if mixed && s == "mixed" {
		return s
	}
	return "unknown"
}
func metricOutcome(s string) string {
	return enum(s, "completed", "failed", "cancelled", "interrupted")
}
func metricKind(s string) string {
	if s == "node" {
		return "direct"
	}
	return enum(s, "direct", "planner", "team", "graph")
}
func (a *App) telemetryOn() bool { return a.obs != nil && a.cfg.MetricsEnabled }
func (a *App) registerTelemetryModels(runtime string, models []piModel) {
	if a.obs == nil || !validRuntime(runtime) {
		return
	}
	a.obs.mu.Lock()
	defer a.obs.mu.Unlock()
	for _, m := range models {
		if len(a.obs.models) >= 128 {
			return
		}
		if m.ID != "" && len(m.ID) <= 128 && !strings.ContainsAny(m.ID, "\r\n\t") {
			a.obs.models[runtime+":"+m.ID] = true
		}
	}
}
func (a *App) telemetryModel(runtime, model string) string {
	if a.obs == nil {
		return "unknown"
	}
	a.obs.mu.RLock()
	defer a.obs.mu.RUnlock()
	if a.obs.models[runtime+":"+model] {
		return model
	}
	return "unknown"
}
func (a *App) observeAdmission(runtime, outcome string, d time.Duration) {
	if !a.telemetryOn() {
		return
	}
	runtime = metricRuntime(runtime, false)
	outcome = enum(outcome, "accepted", "session_busy", "rejected_busy", "rejected_capacity", "rejected_invalid", "transport_unknown", "timeout", "cancelled")
	a.obs.counters["runtime_admissions_total"].WithLabelValues(runtime, outcome).Inc()
	a.obs.histograms["runtime_admission_duration_seconds"].WithLabelValues(runtime, outcome).Observe(d.Seconds())
}
func (a *App) observeRun(kind, runtime, outcome string) {
	if a.telemetryOn() {
		a.obs.counters["runs_total"].WithLabelValues(metricKind(kind), metricRuntime(runtime, true), metricOutcome(outcome)).Inc()
	}
}
func (a *App) observeQueue(kind, outcome string, d time.Duration) {
	if a.telemetryOn() {
		a.obs.histograms["run_queue_duration_seconds"].WithLabelValues(metricKind(kind), enum(outcome, "started", "failed", "cancelled", "interrupted")).Observe(d.Seconds())
	}
}
func (a *App) observeGraph(outcome string) {
	if a.telemetryOn() {
		a.obs.counters["graph_runs_total"].WithLabelValues(metricOutcome(outcome)).Inc()
	}
}
func (a *App) observeGraphNodeState(state string) {
	if a.telemetryOn() {
		a.obs.counters["graph_nodes_total"].WithLabelValues(enum(state, "waiting", "running", "done", "failed", "blocked", "cancelled", "cached")).Inc()
	}
}
func (a *App) observeGraphNode(runtime, outcome string, d time.Duration) {
	if a.telemetryOn() {
		a.obs.histograms["graph_node_duration_seconds"].WithLabelValues(metricRuntime(runtime, true), enum(outcome, "done", "failed", "blocked", "cancelled", "cached")).Observe(d.Seconds())
	}
}
func (a *App) observeTeamTurn(purpose, runtime, outcome string, d time.Duration) {
	if !a.telemetryOn() {
		return
	}
	labels := []string{enum(purpose, "work", "aggregate", "review", "revise"), metricRuntime(runtime, false), metricOutcome(outcome)}
	a.obs.counters["team_turns_total"].WithLabelValues(labels...).Inc()
	a.obs.histograms["team_turn_duration_seconds"].WithLabelValues(labels...).Observe(d.Seconds())
}
func (a *App) observeLedger(operation, outcome string) {
	if a.telemetryOn() {
		a.obs.counters["ledger_commits_total"].WithLabelValues(enum(operation, "run_terminal_commit", "invocation_terminal_commit"), enum(outcome, "committed", "retryable_error", "permanent_error")).Inc()
	}
}
func (a *App) observeDB(operation, outcome string, d time.Duration) {
	if a.telemetryOn() {
		a.obs.histograms["db_query_duration_seconds"].WithLabelValues(enum(operation, "auth_lookup", "tenant_authorize", "run_create", "run_read", "run_event_append", "run_terminal_commit", "invocation_reserve", "invocation_terminal_commit", "graph_schedule", "usage_query", "usage_snapshot", "migration", "health", "other"), enum(outcome, "success", "error", "timeout", "cancelled")).Observe(d.Seconds())
	}
}
func (a *App) observeInvocation(runtime, model, outcome, usageStatus, usageReason string, tokens map[string]*int64, providerMs, ttftMs, costMicrousd *int64) {
	if !a.telemetryOn() {
		return
	}
	model = a.telemetryModel(runtime, model)
	runtime = metricRuntime(runtime, false)
	outcome = metricOutcome(outcome)
	a.obs.counters["model_invocations_total"].WithLabelValues(runtime, model, outcome).Inc()
	if usageStatus == "reported" || usageStatus == "partial" {
		for _, direction := range []string{"input", "output", "cache_read", "cache_write", "reasoning"} {
			if v := tokens[direction]; v != nil && *v >= 0 {
				a.obs.counters["model_tokens_total"].WithLabelValues(runtime, model, direction).Add(float64(*v))
			}
		}
	}
	if usageStatus != "reported" {
		a.obs.counters["model_usage_missing_total"].WithLabelValues(runtime, enum(usageReason, "legacy_worker", "provider_missing", "transport_unknown", "protocol_invalid", "worker_lost", "partial_usage")).Inc()
	}
	if providerMs != nil && *providerMs >= 0 {
		a.obs.histograms["model_duration_seconds"].WithLabelValues(runtime, model, outcome).Observe(float64(*providerMs) / 1000)
	}
	if ttftMs != nil && *ttftMs >= 0 {
		a.obs.histograms["model_time_to_first_token_seconds"].WithLabelValues(runtime, model).Observe(float64(*ttftMs) / 1000)
	}
	if costMicrousd != nil && *costMicrousd >= 0 {
		a.obs.counters["model_estimated_cost_usd_total"].WithLabelValues(runtime, model).Add(float64(*costMicrousd) / 1e6)
	}
}

type requestIDKey struct{}

func requestIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(requestIDKey{}).(string)
	return v
}
func RequestID(ctx context.Context) string { return requestIDFromContext(ctx) }
func newRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("secure request identity unavailable")
	}
	return hex.EncodeToString(bytes[:])
}
func requestRoute(mux *http.ServeMux, r *http.Request) (string, bool) {
	_, pattern := mux.Handler(r)
	if pattern == "" {
		return "unmatched", false
	}
	_, path, ok := strings.Cut(pattern, " ")
	if !ok {
		path = pattern
	}
	return path, path == "/api/v1/tenants/{tenantId}/runs/{id}/events"
}
func statusClass(status int, cancelled bool) string {
	if cancelled {
		return "cancelled"
	}
	switch {
	case status >= 500:
		return "5xx"
	case status >= 400:
		return "4xx"
	case status >= 300:
		return "3xx"
	default:
		return "2xx"
	}
}

type telemetryResponse struct {
	http.ResponseWriter
	status      int
	committedAt time.Time
}

func (w *telemetryResponse) WriteHeader(status int) {
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if w.status != 0 {
		return
	}
	w.status = status
	w.committedAt = time.Now()
	w.ResponseWriter.WriteHeader(status)
}
func (w *telemetryResponse) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(b)
}
func (w *telemetryResponse) Flush() { _ = w.FlushError() }
func (w *telemetryResponse) FlushError() error {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}
func (w *telemetryResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (a *App) observeHTTP(mux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		route, stream := requestRoute(mux, r)
		method := enum(r.Method, "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD")
		if method == "unknown" {
			method = "OTHER"
		}
		// Incoming correlation and W3C headers are untrusted even behind a proxy.
		requestID := newRequestID()
		ctx := context.WithValue(r.Context(), requestIDKey{}, requestID)
		ctx, span := a.obs.tracer.Start(ctx, "http.server", trace.WithNewRoot(), trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attribute.String("http.route", route), attribute.String("http.request.method", method)))
		r = r.WithContext(ctx)
		r.Header = r.Header.Clone()
		for _, header := range []string{"traceparent", "tracestate", "baggage", "X-Request-ID"} {
			r.Header.Del(header)
		}
		w.Header().Set("X-Request-ID", requestID)
		rec := &telemetryResponse{ResponseWriter: w}
		if a.telemetryOn() {
			a.obs.gauges["http_requests_in_flight"].WithLabelValues(method).Inc()
		}
		defer func() {
			if rec.status == 0 {
				rec.WriteHeader(http.StatusOK)
			}
			outcome := statusClass(rec.status, r.Context().Err() != nil)
			span.SetAttributes(attribute.Int("http.response.status_code", rec.status))
			span.End()
			if a.telemetryOn() {
				s := "false"
				if stream {
					s = "true"
				}
				labels := []string{route, method, outcome, s}
				a.obs.counters["http_requests_total"].WithLabelValues(labels...).Inc()
				a.obs.histograms["http_request_duration_seconds"].WithLabelValues(labels...).Observe(time.Since(start).Seconds())
				a.obs.gauges["http_requests_in_flight"].WithLabelValues(method).Dec()
				if stream {
					a.obs.histograms["sse_handshake_duration_seconds"].WithLabelValues(route, outcome).Observe(rec.committedAt.Sub(start).Seconds())
				}
			}
		}()
		next.ServeHTTP(rec, r)
	})
}
