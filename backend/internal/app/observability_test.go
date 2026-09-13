package app

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

func metricText(t *testing.T, a *App) string {
	t.Helper()
	w := httptest.NewRecorder()
	promhttp.HandlerFor(a.obs.registry, promhttp.HandlerOpts{}).ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	if w.Code != 200 {
		t.Fatalf("metrics status %d: %s", w.Code, w.Body.String())
	}
	return w.Body.String()
}

func TestObservabilityTraceHelpersWithoutInitialization(t *testing.T) {
	a := &App{}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), requestIDKey{}, "server-request"))
	cancel()
	for _, tc := range []struct {
		name  string
		start func(context.Context) (context.Context, func(string))
	}{
		{"internal", func(ctx context.Context) (context.Context, func(string)) {
			return a.startInternalTrace(ctx, "pi", "fixture")
		}},
		{"team", func(ctx context.Context) (context.Context, func(string)) {
			return a.startTeamTrace(ctx, "work", "pi", 1)
		}},
		{"graph", func(ctx context.Context) (context.Context, func(string)) { return a.startGraphNodeTrace(ctx, "pi") }},
		{"database", func(ctx context.Context) (context.Context, func(string)) { return a.startDBTrace(ctx, "run_read") }},
		{"ledger", func(ctx context.Context) (context.Context, func(string)) {
			return a.startLedgerTrace(ctx, "run_terminal_commit")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, end := tc.start(parent)
			if ctx.Err() != context.Canceled || RequestID(ctx) != "server-request" || trace.SpanFromContext(ctx).IsRecording() {
				t.Fatal("disabled tracing changed business context")
			}
			end("cancelled")
		})
	}
	ctx, end := a.startAsyncTrace(parent, "awwo.run.execute", "direct", "pi")
	if ctx.Err() != nil || RequestID(ctx) != "server-request" || trace.SpanFromContext(ctx).IsRecording() {
		t.Fatal("disabled async tracing changed background execution context")
	}
	end("completed")
	a.cfg.OTelEnabled = true
	if err := a.startTracing(context.Background()); err != nil || a.obs != nil {
		t.Fatal("tracing initialized for a caller without observability", err)
	}
}

func TestObservabilityManagementIsSeparateAndDisabledByDefault(t *testing.T) {
	a := New(nil, Config{Env: "development"})
	defer a.Close()
	if err := a.StartObservability(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.obs.listener != nil {
		t.Fatal("default mode opened metrics port")
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	if w.Code != 404 || len(w.Header().Get("X-Request-ID")) != 32 {
		t.Fatalf("public metrics=%d request identity=%q", w.Code, w.Header().Get("X-Request-ID"))
	}
	b := New(nil, Config{Env: "development", MetricsEnabled: true, MetricsListenAddr: "127.0.0.1:0"})
	defer b.Close()
	if err := b.StartObservability(context.Background()); err != nil {
		t.Fatal(err)
	}
	for path, status := range map[string]int{"/metrics": 200, "/healthz": 204, "/api/v1/health": 404} {
		res, err := http.Get("http://" + b.obs.listener.Addr().String() + path)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != status {
			t.Fatalf("management %s: %d", path, res.StatusCode)
		}
		if res.Header.Get("Access-Control-Allow-Origin") != "" || res.Header.Get("Set-Cookie") != "" {
			t.Fatal("management endpoint acquired browser authorization surface")
		}
	}
	w = httptest.NewRecorder()
	b.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	if w.Code != 404 {
		t.Fatal("business metrics must stay 404 even when management is enabled")
	}
}

func TestObservabilityLoopbackAndConfigBoundaries(t *testing.T) {
	for _, address := range []string{"0.0.0.0:9101", "[::]:9101", "localhost:9101", "127.0.0.1.evil:9101", "192.168.1.5:9101", "127.0.0.1:65536", "127.0.0.1:-1", "127.0.0.1"} {
		if loopbackAddress(address) {
			t.Errorf("accepted unsafe address %s", address)
		}
	}
	for _, address := range []string{"127.0.0.1:9101", "[::1]:9101", "127.0.0.2:0"} {
		if !loopbackAddress(address) {
			t.Errorf("rejected loopback address %s", address)
		}
	}
	for _, c := range []Config{{Env: "production", OTelEnabled: true, OTelEndpoint: "https://provider.example/v1/traces"}, {Env: "staging", OTelEnabled: true, OTelEndpoint: "http://collector.internal:4318"}, {Env: "development", OTelEnabled: true, OTelEndpoint: "http://127.0.0.1:4318?key=secret"}, {Env: "development", OTelResourceAttributes: "tenant.id=secret"}, {UsageRetentionDays: 30}, {OTelSampleRatio: 1.1}, {OTelSampler: "always_on"}} {
		if c.validateObservability() == nil {
			t.Errorf("accepted unsafe config: env=%s", c.Env)
		}
	}
	for _, c := range []Config{{Env: "production", OTelEnabled: true, OTelEndpoint: "http://127.0.0.1:4318", OTelSampleRatio: .05}, {Env: "production", OTelEnabled: true, OTelEndpoint: "https://collector.internal:4318", OTelSampleRatio: .05}, {Env: "development", UsageRetentionDays: 180}} {
		if err := c.validateObservability(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestObservabilityHTTPIdentityRoutesAndSSE(t *testing.T) {
	a := New(nil, Config{MetricsEnabled: true})
	defer a.Close()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	a.obs.tracer = provider.Tracer("test")
	mux := http.NewServeMux()
	const pattern = "/api/v1/tenants/{tenantId}/runs/{id}/events"
	mux.HandleFunc("GET "+pattern, func(w http.ResponseWriter, r *http.Request) {
		if RequestID(r.Context()) == "spoofed-private-id" || RequestID(r.Context()) == "" {
			t.Error("client controls request id")
		}
		for _, key := range []string{"traceparent", "tracestate", "baggage", "X-Request-ID"} {
			if r.Header.Get(key) != "" {
				t.Errorf("untrusted %s reached handler", key)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		time.Sleep(25 * time.Millisecond)
		io.WriteString(w, "data: private-response\n\n")
	})
	h := a.observeHTTP(mux, mux)
	req := httptest.NewRequest("GET", "/api/v1/tenants/private-tenant/runs/private-run/events?secret=query", nil)
	req.Header.Set("X-Request-ID", "spoofed-private-id")
	req.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	req.Header.Set("baggage", "password=do-not-export")
	req.Header.Set("tracestate", "vendor=private-state")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "private-response") {
		t.Fatal("SSE response changed")
	}
	for i := 0; i < 3; i++ {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/not-found/private-dynamic-id", nil))
	}
	metrics := metricText(t, a)
	for _, secret := range []string{"private-tenant", "private-run", "private-response", "private-dynamic-id", "secret=query", "spoofed-private-id", "password", "22222222"} {
		if strings.Contains(metrics, secret) {
			t.Errorf("metrics leaked %s", secret)
		}
	}
	if !strings.Contains(metrics, `route="`+pattern+`"`) || !strings.Contains(metrics, `stream="true"`) || !strings.Contains(metrics, "awwo_sse_handshake_duration_seconds_count") || !strings.Contains(metrics, `route="unmatched"`) {
		t.Fatal("route or SSE metrics missing")
	}
	spans := recorder.Ended()
	if len(spans) != 4 {
		t.Fatalf("spans=%d", len(spans))
	}
	if spans[0].Parent().IsValid() || spans[0].SpanContext().TraceID().String() == "11111111111111111111111111111111" {
		t.Fatal("public W3C parent was trusted")
	}
	families, _ := a.obs.registry.Gather()
	var duration, handshake float64
	for _, f := range families {
		if f.GetName() == "awwo_sse_handshake_duration_seconds" {
			handshake = f.Metric[0].Histogram.GetSampleSum()
		}
		if f.GetName() == "awwo_http_request_duration_seconds" {
			for _, m := range f.Metric {
				for _, label := range m.Label {
					if label.GetName() == "stream" && label.GetValue() == "true" {
						duration = m.Histogram.GetSampleSum()
					}
				}
			}
		}
	}
	if duration < .02 || handshake >= duration {
		t.Fatalf("SSE timings do not separate headers and lifetime: %f/%f", handshake, duration)
	}
}

func TestObservabilitySSERejectedHandshakeAndNoContent(t *testing.T) {
	a := New(nil, Config{MetricsEnabled: true})
	defer a.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/tenants/{tenantId}/runs/{id}/events", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) })
	h := a.observeHTTP(mux, mux)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/v1/tenants/t/runs/r/events", nil))
	metrics := metricText(t, a)
	if !strings.Contains(metrics, `status_class="4xx",stream="true"`) || !strings.Contains(metrics, "awwo_sse_handshake_duration_seconds_count") {
		t.Fatal("failed SSE lost registered stream identity")
	}
	mux.HandleFunc("GET /empty", func(w http.ResponseWriter, r *http.Request) {})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/empty", nil))
	if w.Code != 200 {
		t.Fatal("implicit header commit changed")
	}
}

func TestObservabilityInvocationUsesBoundedCatalogAndNullUsage(t *testing.T) {
	a := New(nil, Config{MetricsEnabled: true})
	defer a.Close()
	a.registerTelemetryModels("pi", []piModel{{ID: "safe-model"}})
	n := int64(12)
	zero := int64(0)
	a.observeInvocation("pi", "safe-model", "completed", "reported", "", map[string]*int64{"input": &n, "output": &zero}, nil, nil, nil)
	a.observeInvocation("pi", "private-unregistered-model", "failed", "unknown", "raw-sensitive-error", nil, nil, nil, nil)
	metrics := metricText(t, a)
	if strings.Contains(metrics, "private-unregistered-model") || strings.Contains(metrics, "raw-sensitive-error") {
		t.Fatal("unbounded labels leaked")
	}
	if !strings.Contains(metrics, `direction="input",model="safe-model",runtime="pi"} 12`) || !strings.Contains(metrics, `direction="output",model="safe-model",runtime="pi"} 0`) {
		t.Fatal("explicit usage zero or input missing")
	}
	if strings.Contains(metrics, "awwo_model_time_to_first_token_seconds_count") || strings.Contains(metrics, "awwo_model_estimated_cost_usd_total{") {
		t.Fatal("unknown timing/cost became zero")
	}
}

func TestObservabilityAsyncLinkAndInternalPropagation(t *testing.T) {
	a := New(nil, Config{PIURL: "http://127.0.0.1:8097", PIToken: strings.Repeat("x", 32)})
	defer a.Close()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	a.obs.tracer = provider.Tracer("test")
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), requestIDKey{}, "server-request"))
	parent, span := a.obs.tracer.Start(parent, "http.server")
	parentSC := span.SpanContext()
	span.End()
	cancel()
	ctx, end := a.startAsyncTrace(parent, "awwo.run.execute", "direct", "pi")
	if ctx.Err() != nil {
		t.Fatal("async task inherited completed request cancellation")
	}
	admission, finish := a.startInternalTrace(ctx, "pi", "secret-model")
	req, _ := http.NewRequestWithContext(admission, "POST", a.cfg.PIURL+"/internal/runs", nil)
	req.Header.Set("Authorization", "Bearer "+a.cfg.PIToken)
	req.Header.Set("baggage", "sensitive")
	req.Header.Set("tracestate", "sensitive")
	a.injectWorkerTrace(req, "pi")
	if req.Header.Get("traceparent") == "" || req.Header.Get("X-Request-ID") != "server-request" || req.Header.Get("baggage") != "" || req.Header.Get("tracestate") != "" {
		t.Fatal("internal trace boundary broken")
	}
	external, _ := http.NewRequestWithContext(admission, "POST", "https://provider.example/internal/runs", nil)
	external.Header.Set("traceparent", req.Header.Get("traceparent"))
	a.injectWorkerTrace(external, "pi")
	if external.Header.Get("traceparent") != "" {
		t.Fatal("trace crossed the configured internal endpoint")
	}
	finish("accepted")
	end("completed")
	spans := recorder.Ended()
	run := spans[len(spans)-1]
	if run.Parent().IsValid() || len(run.Links()) != 1 || run.Links()[0].SpanContext.TraceID() != parentSC.TraceID() {
		t.Fatal("async trace is not a new root linked to admission")
	}
	if run.SpanContext().TraceID() == parentSC.TraceID() {
		t.Fatal("async task reused HTTP trace")
	}
}

func TestObservabilityActualOTLPExportIsContentFree(t *testing.T) {
	var mu sync.Mutex
	var received []*collectortrace.ExportTraceServiceRequest
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bytes, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		var message collectortrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(bytes, &message); err != nil {
			t.Error(err)
		}
		if r.URL.Path != "/v1/traces" {
			t.Errorf("wrong OTLP path %s", r.URL.Path)
		}
		mu.Lock()
		received = append(received, &message)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(200)
	}))
	defer collector.Close()
	a := New(nil, Config{Env: "development", OTelEnabled: true, OTelEndpoint: collector.URL, OTelSampleRatio: 1})
	if err := a.StartObservability(context.Background()); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /test/{id}", func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		io.WriteString(w, "private-output-marker")
	})
	r := httptest.NewRequest("POST", "/test/private-business-id?secret=private-query", strings.NewReader("private-prompt-marker"))
	r.Header.Set("Authorization", "Bearer private-provider-key")
	r.Header.Set("Cookie", "private-cookie")
	r.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	a.observeHTTP(mux, mux).ServeHTTP(httptest.NewRecorder(), r)
	a.Close()
	mu.Lock()
	defer mu.Unlock()
	if len(received) == 0 {
		t.Fatal("collector received no actual OTLP request")
	}
	for _, message := range received {
		b, _ := proto.Marshal(message)
		for _, secret := range []string{"private-prompt", "private-output", "private-business", "private-query", "private-provider", "private-cookie", "1111111111111111"} {
			if strings.Contains(string(b), secret) {
				t.Fatalf("OTLP leaked %s", secret)
			}
		}
	}
}

func TestObservabilityExporterFailureDoesNotBlockRequests(t *testing.T) {
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
		io.WriteString(w, "private-collector-error")
	}))
	defer collector.Close()
	a := New(nil, Config{Env: "development", MetricsEnabled: true, MetricsListenAddr: "127.0.0.1:0", OTelEnabled: true, OTelEndpoint: collector.URL, OTelSampleRatio: 1})
	if err := a.StartObservability(context.Background()); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ok", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	h := a.observeHTTP(mux, mux)
	start := time.Now()
	for i := 0; i < 1200; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/ok", nil))
		if w.Code != 204 {
			t.Fatal("collector failure changed request")
		}
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("request path waited for bounded exporter queue")
	}
	a.Close()
	metrics := metricText(t, a)
	if !strings.Contains(metrics, "awwo_telemetry_export_errors_total 1") && !strings.Contains(metrics, "awwo_telemetry_export_errors_total ") {
		t.Fatal("export failure was not counted")
	}
	if strings.Contains(metrics, "private-collector-error") {
		t.Fatal("raw collector error leaked")
	}
}

func TestObservabilityTraceReferenceUsesIndependentKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "trace-key")
	key := []byte(strings.Repeat("z", 32))
	if err := os.WriteFile(path, []byte(base64.RawURLEncoding.EncodeToString(key)), 0600); err != nil {
		t.Fatal(err)
	}
	parsed, err := readTraceKey(path, "v1")
	if err != nil {
		t.Fatal(err)
	}
	a := New(nil, Config{TraceRefKey: parsed, TraceRefVersion: "v1"})
	defer a.Close()
	attrs := a.traceReference("run", "secret-id")
	if len(attrs) != 2 || len(attrs[0].Value.AsString()) != 32 || strings.Contains(attrs[0].Value.AsString(), "secret-id") {
		t.Fatal("HMAC trace ref invalid")
	}
	if len(a.traceReference("tenant", "secret-id")) != 0 {
		t.Fatal("unapproved ref type accepted")
	}
	if _, err = readTraceKey(path, ""); err == nil {
		t.Fatal("unversioned key accepted")
	}
	if trace.SpanContextFromContext(context.Background()).IsValid() {
		t.Fatal("unexpected root")
	}
}

func TestObservabilityWorkerRedirectDoesNotForwardCredentials(t *testing.T) {
	calls := 0
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer other.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 302) }))
	defer source.Close()
	a := New(nil, Config{RunTimeout: time.Second})
	defer a.Close()
	req, _ := http.NewRequest("GET", source.URL, nil)
	req.Header.Set("Authorization", "Bearer private-token")
	res, err := a.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 302 || calls != 0 {
		t.Fatal("internal redirects followed")
	}
}
