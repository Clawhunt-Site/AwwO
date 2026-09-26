package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// Request characterization goldens.
//
// These tests pin, byte for byte, what the control plane sends to the workers and
// what it records about it today: every worker request body, the runs, run_turns
// and model_invocations rows it writes, and the API projections later milestones
// build on (runtime catalogue, turns, artifacts, admin tenant, usage, refusals).
// A later change that keeps its feature gate closed must leave every golden
// byte-identical.
//
// Goldens are regenerated only deliberately, and the diff is reviewed before it is
// committed:
//
//	AWWO_UPDATE_GOLDEN=1 AWWO_TEST_DATABASE_URL=... go test -count=1 -p 1 -run RequestCharacterization ./internal/app
//
// Without the switch any difference fails with a line diff; nothing is rewritten
// implicitly. Generated identities, timestamps and measured durations are replaced
// by named placeholders, so a golden depends on neither randomness, the clock,
// goroutine scheduling nor test order.

const goldenUpdateEnv = "AWWO_UPDATE_GOLDEN"

// Marks the one graph agent whose fake reply is a file deliverable.
const characterizationFilePersona = "FILE-DELIVERY-PERSONA"

func goldenPath(name string) string { return filepath.Join("testdata", "golden", name) }

// encodeGolden is the single canonical form: generic maps (so keys are sorted at
// every level), two-space indentation, no HTML escaping and a trailing newline.
func encodeGolden(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// decodeGolden keeps numbers as their exact literal so re-encoding never changes them.
func decodeGolden(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data after JSON value")
	}
	return v, nil
}

func goldenTree(t *testing.T, raw []byte) any {
	t.Helper()
	v, err := decodeGolden(raw)
	if err != nil {
		t.Fatalf("invalid JSON (%v): %s", err, raw)
	}
	return v
}

// compareGolden is the only comparison path. It never writes, so a difference can
// only be accepted by running the explicit update switch.
func compareGolden(name string, got []byte) error {
	want, err := os.ReadFile(goldenPath(name))
	if err != nil {
		return fmt.Errorf("golden %s cannot be read (%v); generate it deliberately with %s=1", goldenPath(name), err, goldenUpdateEnv)
	}
	if bytes.Equal(want, got) {
		return nil
	}
	return fmt.Errorf("golden %s differs from the current output; if the change is intended, regenerate deliberately with %s=1 and review the diff:\n%s", goldenPath(name), goldenUpdateEnv, lineDiff(string(want), string(got)))
}

func assertGolden(t *testing.T, name string, v any) {
	t.Helper()
	got, err := encodeGolden(v)
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv(goldenUpdateEnv) == "1" {
		if err = os.MkdirAll(filepath.Dir(goldenPath(name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(goldenPath(name), got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("updated golden %s", goldenPath(name))
		return
	}
	if err = compareGolden(name, got); err != nil {
		t.Fatal(err)
	}
}

type diffOp struct {
	kind byte
	text string
}

// lineDiff renders a unified-style line diff of two canonical goldens. Long lines
// (system prompts are single JSON strings) are clipped around their first change.
func lineDiff(want, got string) string {
	const diffContext, maxLines = 3, 400
	a, b := strings.Split(want, "\n"), strings.Split(got, "\n")
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix && a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	ma, mb := a[prefix:len(a)-suffix], b[prefix:len(b)-suffix]
	ops := []diffOp{}
	if len(ma)*len(mb) > 4000000 {
		for _, line := range ma {
			ops = append(ops, diffOp{'-', line})
		}
		for _, line := range mb {
			ops = append(ops, diffOp{'+', line})
		}
	} else {
		lcs := make([][]int, len(ma)+1)
		for i := range lcs {
			lcs[i] = make([]int, len(mb)+1)
		}
		for i := len(ma) - 1; i >= 0; i-- {
			for j := len(mb) - 1; j >= 0; j-- {
				switch {
				case ma[i] == mb[j]:
					lcs[i][j] = lcs[i+1][j+1] + 1
				case lcs[i+1][j] >= lcs[i][j+1]:
					lcs[i][j] = lcs[i+1][j]
				default:
					lcs[i][j] = lcs[i][j+1]
				}
			}
		}
		i, j := 0, 0
		for i < len(ma) || j < len(mb) {
			switch {
			case i < len(ma) && j < len(mb) && ma[i] == mb[j]:
				ops = append(ops, diffOp{' ', ma[i]})
				i, j = i+1, j+1
			case j == len(mb) || (i < len(ma) && lcs[i+1][j] >= lcs[i][j+1]):
				ops = append(ops, diffOp{'-', ma[i]})
				i++
			default:
				ops = append(ops, diffOp{'+', mb[j]})
				j++
			}
		}
	}
	var out strings.Builder
	lines := 0
	write := func(kind byte, text string, column int) {
		if lines == maxLines {
			out.WriteString("... diff truncated ...\n")
		}
		lines++
		if lines > maxLines {
			return
		}
		out.WriteByte(kind)
		out.WriteString(clipDiffLine(text, column))
		out.WriteByte('\n')
	}
	start := max(prefix-diffContext, 0)
	fmt.Fprintf(&out, "--- golden\n+++ current\n@@ golden line %d @@\n", start+1)
	for _, line := range a[start:prefix] {
		write(' ', line, -1)
	}
	for k := 0; k < len(ops); k++ {
		if ops[k].kind == ' ' {
			end := k
			for end < len(ops) && ops[end].kind == ' ' {
				end++
			}
			if end-k > 2*diffContext {
				for _, op := range ops[k : k+diffContext] {
					write(' ', op.text, -1)
				}
				write(' ', fmt.Sprintf("... %d unchanged lines ...", end-k-2*diffContext), -1)
				for _, op := range ops[end-diffContext : end] {
					write(' ', op.text, -1)
				}
			} else {
				for _, op := range ops[k:end] {
					write(' ', op.text, -1)
				}
			}
			k = end - 1
			continue
		}
		column := -1
		if ops[k].kind == '-' && k+1 < len(ops) && ops[k+1].kind == '+' {
			column = firstDifference(ops[k].text, ops[k+1].text)
		}
		if ops[k].kind == '+' && k > 0 && ops[k-1].kind == '-' {
			column = firstDifference(ops[k-1].text, ops[k].text)
		}
		write(ops[k].kind, ops[k].text, column)
	}
	for _, line := range a[len(a)-suffix:][:min(diffContext, suffix)] {
		write(' ', line, -1)
	}
	return out.String()
}

func firstDifference(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	i := 0
	for i < len(ra) && i < len(rb) && ra[i] == rb[i] {
		i++
	}
	return i
}

func clipDiffLine(line string, column int) string {
	runes := []rune(line)
	if len(runes) <= 240 {
		return string(runes)
	}
	from, to := 0, 240
	if column >= 0 {
		from = max(column-80, 0)
		to = min(column+160, len(runes))
	}
	clipped := string(runes[from:to])
	if from > 0 {
		clipped = "…" + clipped
	}
	if to < len(runes) {
		clipped += "…"
	}
	if column >= 0 {
		return fmt.Sprintf("%s  (first change at column %d of %d)", clipped, column, len(runes))
	}
	return fmt.Sprintf("%s  (%d characters)", clipped, len(runes))
}

var (
	// randomID's shape: "a" followed by 32 base64url characters.
	generatedIDShape = regexp.MustCompile(`(?:^|[^A-Za-z0-9])(a[A-Za-z0-9_-]{32})(?:[^A-Za-z0-9]|$)`)
	timestampShape   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`)
	// Values volatile by position rather than by shape. A null or empty value is kept,
	// so a golden still pins whether the field is populated.
	goldenVolatileKeys = map[string]string{
		"requestId":    "<request-id>",
		"request_id":   "<request-id>",
		"traceId":      "<trace-id>",
		"trace_id":     "<trace-id>",
		"nextCursor":   "<cursor>",
		"queue_ms":     "<measured-ms>",
		"admission_ms": "<measured-ms>",
	}
)

func goldenVolatile(parent, key string) (string, bool) {
	// Queue and admission time are measured by Go, not reported by the fake worker.
	if parent == "timingMs" && (key == "queue" || key == "admission") {
		return "<measured-ms>", true
	}
	placeholder, ok := goldenVolatileKeys[key]
	return placeholder, ok
}

// goldenScrubber replaces generated identities with semantic placeholders. Names
// derive from durable facts (operation IDs, node IDs, ordinals), never from the
// order in which values happen to be observed.
type goldenScrubber struct {
	names  map[string]string
	owners map[string]string
	order  []string
	leaks  map[string]bool
}

func newGoldenScrubber() *goldenScrubber {
	return &goldenScrubber{names: map[string]string{}, owners: map[string]string{}, leaks: map[string]bool{}}
}

func (s *goldenScrubber) name(raw, placeholder string) error {
	if raw == "" {
		return fmt.Errorf("empty identity for %s", placeholder)
	}
	if prior, ok := s.names[raw]; ok {
		if prior != placeholder {
			return fmt.Errorf("identity named both %s and %s", prior, placeholder)
		}
		return nil
	}
	if prior, ok := s.owners[placeholder]; ok && prior != raw {
		return fmt.Errorf("placeholder %s would name two identities", placeholder)
	}
	s.names[raw], s.owners[placeholder] = placeholder, raw
	s.order = append(s.order, raw)
	sort.Slice(s.order, func(i, j int) bool {
		if len(s.order[i]) != len(s.order[j]) {
			return len(s.order[i]) > len(s.order[j])
		}
		return s.order[i] < s.order[j]
	})
	return nil
}

func (s *goldenScrubber) text(v string) string {
	for _, raw := range s.order {
		v = strings.ReplaceAll(v, raw, s.names[raw])
	}
	for _, match := range generatedIDShape.FindAllStringSubmatch(v, -1) {
		s.leaks[match[1]] = true
	}
	return v
}

func (s *goldenScrubber) scrub(v any) any { return s.walk("", "", v) }

func (s *goldenScrubber) walk(parent, key string, v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, child := range x {
			out[s.text(k)] = s.walk(key, k, child)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, child := range x {
			out[i] = s.walk(parent, key, child)
		}
		return out
	case string:
		if placeholder, ok := goldenVolatile(parent, key); ok && x != "" {
			return placeholder
		}
		// Every timestamp is masked, the epoch included: Go renders a scanned
		// timestamptz in the process time zone, so keeping any literal instant would
		// make a golden depend on the machine it was generated on.
		if timestampShape.MatchString(x) {
			return "<timestamp>"
		}
		return s.text(x)
	case json.Number:
		if placeholder, ok := goldenVolatile(parent, key); ok {
			return placeholder
		}
		return x
	default:
		return x
	}
}

func (s *goldenScrubber) unnamed() []string {
	out := []string{}
	for id := range s.leaks {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func (s *goldenScrubber) requireNamed(t *testing.T) {
	t.Helper()
	if leaks := s.unnamed(); len(leaks) > 0 {
		t.Fatalf("generated identities would leak into goldens unnamed: %v", leaks)
	}
}

// registerDatabase names every generated identity in the test's isolated schema.
func (s *goldenScrubber) registerDatabase(t *testing.T, h *harness) {
	t.Helper()
	ctx := context.Background()
	load := func(columns int, query string) [][]string {
		t.Helper()
		rows, err := h.db.Query(ctx, query)
		if err != nil {
			t.Fatalf("characterization identity query: %v", err)
		}
		defer rows.Close()
		out := [][]string{}
		for rows.Next() {
			values := make([]string, columns)
			targets := make([]any, columns)
			for i := range values {
				targets[i] = &values[i]
			}
			if err = rows.Scan(targets...); err != nil {
				t.Fatal(err)
			}
			out = append(out, values)
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}
	named := func(raw, placeholder string) {
		t.Helper()
		if err := s.name(raw, placeholder); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range load(2, "SELECT id, split_part(email,'@',1) FROM users") {
		named(r[0], "<user:"+r[1]+">")
	}
	for _, r := range load(2, "SELECT t.id, COALESCE((SELECT split_part(u.email,'@',1) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='owner' ORDER BY u.email LIMIT 1),'unowned') FROM tenants t") {
		named(r[0], "<tenant:"+r[1]+">")
	}
	for _, r := range load(2, "SELECT id, name FROM canvases") {
		named(r[0], "<canvas:"+r[1]+">")
	}
	for _, r := range load(2, "SELECT id, name FROM agents") {
		named(r[0], "<agent:"+r[1]+">")
	}
	for _, r := range load(2, "SELECT id, node_id FROM node_sessions") {
		named(r[0], "<session:"+r[1]+">")
	}
	for _, r := range load(2, "SELECT id, operation_id FROM graph_runs") {
		named(r[0], "<graph:"+r[1]+">")
	}
	labels := map[string]string{}
	for _, r := range load(2, `SELECT r.id, COALESCE(
		(SELECT format('collab-%s-%s-%s', lpad(c.ordinal::text,2,'0'), c.phase, c.node_id) FROM graph_collaboration_turns c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id),
		(SELECT 'graph-'||n.node_id FROM graph_run_nodes n JOIN graph_runs g ON g.tenant_id=n.tenant_id AND g.id=n.graph_id WHERE n.tenant_id=r.tenant_id AND n.run_id=r.id AND g.collaboration IS NULL),
		r.operation_id) FROM runs r`) {
		labels[r[0]] = r[1]
		named(r[0], "<run:"+r[1]+">")
	}
	for _, r := range load(3, "SELECT id, run_id, lpad(ordinal::text,2,'0') FROM run_turns") {
		named(r[0], "<turn:"+labels[r[1]]+":"+r[2]+">")
	}
	for _, r := range load(2, "SELECT id, node_id||':'||field_id FROM artifacts") {
		named(r[0], "<artifact:"+r[1]+">")
	}
}

// Explicit column lists: an additive migration must not change these projections.
const (
	characterizationRunsSQL  = `SELECT jsonb_build_object('id',id,'session_id',session_id,'actor_id',actor_id,'operation_id',operation_id,'status',status,'prompt',prompt,'output',output,'error',error) FROM runs WHERE tenant_id=$1`
	characterizationTurnsSQL = `SELECT jsonb_build_object('id',id,'tenant_id',tenant_id,'run_id',run_id,'member_id',member_id,'member_name',member_name,'role',role,'round',round,'ordinal',ordinal,'config',config,'status',status,
		'prompt',prompt,'output',output,'error',error,'system_prompt',system_prompt,'messages',messages,'context',context,'created_at',created_at,'updated_at',updated_at) FROM run_turns WHERE tenant_id=$1`
	characterizationInvocationsSQL = `SELECT jsonb_build_object('id',id,'tenant_id',tenant_id,'run_id',run_id,'turn_id',turn_id,'agent_id',agent_id,'status',status,
		'runtime',runtime,'provider',provider,'model_id',model_id,'provider_model',provider_model,'protocol',protocol,
		'admission_status',admission_status,'usage_status',usage_status,'usage_source',usage_source,'usage_reason',usage_reason,'observability_version',observability_version,
		'input_tokens',input_tokens,'output_tokens',output_tokens,'cached_input_tokens',cached_input_tokens,'cache_write_tokens',cache_write_tokens,
		'reasoning_tokens',reasoning_tokens,'provider_total_tokens',provider_total_tokens,'computed_total_tokens',computed_total_tokens)
	 || jsonb_build_object('queue_ms',queue_ms,'admission_ms',admission_ms,'setup_ms',setup_ms,'provider_ms',provider_ms,'provider_ttft_ms',provider_ttft_ms,
		'worker_total_ms',worker_total_ms,'worker_first_delta_ms',worker_first_delta_ms,
		'pricing_version',pricing_version,'price_snapshot',price_snapshot,'estimated_cost_microusd',estimated_cost_microusd,'cost_status',cost_status,'currency',currency,
		'failure_class',failure_class,'request_id',request_id,'trace_id',trace_id,
		'created_at',created_at,'updated_at',updated_at,'admitted_at',admitted_at,'completed_at',completed_at,
		'created_xid_present',created_xid IS NOT NULL,'completed_xid_present',completed_xid IS NOT NULL) FROM model_invocations WHERE tenant_id=$1`
)

func (s *goldenScrubber) rows(t *testing.T, h *harness, query string, args ...any) []any {
	t.Helper()
	raw, err := rowsJSON(context.Background(), h.db, query, args...)
	if err != nil {
		t.Fatalf("characterization projection: %v", err)
	}
	out := make([]any, 0, len(raw))
	for _, row := range raw {
		out = append(out, s.scrub(goldenTree(t, row)))
	}
	return out
}

// ledger projects a tenant's durable execution records, ordered by semantic keys so
// that neither insertion timing nor parallelism can reorder a golden.
func (s *goldenScrubber) ledger(t *testing.T, h *harness, tid string) map[string]any {
	t.Helper()
	runs := s.rows(t, h, characterizationRunsSQL, tid)
	sortGoldenRows(runs, "id")
	turns := s.rows(t, h, characterizationTurnsSQL, tid)
	sortGoldenRows(turns, "run_id", "ordinal")
	invocations := s.rows(t, h, characterizationInvocationsSQL, tid)
	sortGoldenRows(invocations, "run_id", "turn_id")
	// The projections above do not read execution snapshots, and nothing is configured
	// here, so no snapshot may carry a contract or capability key. These are the keys the
	// rollback drain queries count.
	var keyed int
	if err := h.db.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM runs WHERE tenant_id=$1 AND (execution_snapshot ? 'outputContract' OR execution_snapshot::text LIKE '%"structuredOutput"%'))
		+ (SELECT count(*) FROM graph_run_nodes WHERE tenant_id=$1 AND (execution_snapshot ? 'outputContract' OR execution_snapshot::text LIKE '%"structuredOutput"%'))`, tid).Scan(&keyed); err != nil {
		t.Fatalf("characterization snapshot keys: %v", err)
	}
	if keyed != 0 {
		t.Fatalf("%d unconfigured snapshots carry a structured contract or capability key", keyed)
	}
	return map[string]any{"runs": runs, "runTurns": turns, "modelInvocations": invocations}
}

func sortGoldenRows(rows []any, keys ...string) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, _ := rows[i].(map[string]any)
		b, _ := rows[j].(map[string]any)
		for _, key := range keys {
			if c := compareGoldenValue(a[key], b[key]); c != 0 {
				return c < 0
			}
		}
		ea, _ := encodeGolden(a)
		eb, _ := encodeGolden(b)
		return string(ea) < string(eb)
	})
}

func compareGoldenValue(a, b any) int {
	if a == nil || b == nil {
		switch {
		case a == nil && b == nil:
			return 0
		case a == nil:
			return -1
		default:
			return 1
		}
	}
	if na, ok := a.(json.Number); ok {
		if nb, ok := b.(json.Number); ok {
			fa, _ := na.Float64()
			fb, _ := nb.Float64()
			switch {
			case fa < fb:
				return -1
			case fa > fb:
				return 1
			}
			return 0
		}
	}
	return strings.Compare(fmt.Sprint(a), fmt.Sprint(b))
}

type characterizedResponse struct {
	status int
	body   []byte
}

func characterizationExchange(t *testing.T, h *harness, c *http.Cookie, method, path string, body any) characterizedResponse {
	t.Helper()
	var reader io.Reader = http.NoBody
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	r, err := http.NewRequest(method, h.server.URL+"/api/v1"+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if c != nil {
		r.AddCookie(c)
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return characterizedResponse{status: resp.StatusCode, body: raw}
}

// characterizationCall is an exchange whose status is part of the test's setup.
func characterizationCall(t *testing.T, h *harness, c *http.Cookie, method, path string, body any, status int) characterizedResponse {
	t.Helper()
	got := characterizationExchange(t, h, c, method, path, body)
	if got.status != status {
		t.Fatalf("%s %s got %d want %d: %s", method, path, got.status, status, got.body)
	}
	return got
}

func (s *goldenScrubber) response(t *testing.T, r characterizedResponse) any {
	t.Helper()
	out := map[string]any{"status": r.status}
	if len(bytes.TrimSpace(r.body)) > 0 {
		out["body"] = s.scrub(goldenTree(t, r.body))
	}
	return out
}

type characterizedCall struct {
	runtime, method, path, contentType string
	body                               []byte
}

// characterizationWorkers records the exact requests each fake worker receives and
// delegates to runtimeProvider, so the fixture catalog, bearer checks and Pi request
// assertions stay the single shared definition.
type characterizationWorkers struct {
	mu      sync.Mutex
	calls   []characterizedCall
	replies map[string]int
	pi, oa  *httptest.Server
}

func newCharacterizationWorkers(t *testing.T) *characterizationWorkers {
	t.Helper()
	w := &characterizationWorkers{replies: map[string]int{}}
	w.pi, w.oa = w.server(t, runtimePI), w.server(t, runtimeOpenAIAgents)
	t.Cleanup(func() {
		w.pi.Close()
		w.oa.Close()
	})
	return w
}

func (w *characterizationWorkers) server(t *testing.T, runtime string) *httptest.Server {
	t.Helper()
	inner := runtimeProvider(t, runtime, w.reply)
	handler := inner.Config.Handler
	inner.Close()
	return httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if (r.Method == http.MethodPost && r.URL.Path == "/internal/runs") || r.Method == http.MethodDelete {
			raw, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				rw.WriteHeader(400)
				return
			}
			w.mu.Lock()
			w.calls = append(w.calls, characterizedCall{runtime: runtime, method: r.Method, path: r.URL.Path, contentType: r.Header.Get("Content-Type"), body: raw})
			w.mu.Unlock()
			r.Body = io.NopCloser(bytes.NewReader(raw))
		}
		handler.ServeHTTP(rw, r)
	}))
}

// Replies are numbered per tenant in arrival order. Every characterized flow is
// sequential, so the numbering is deterministic and each prompt that quotes an
// earlier reply is too.
func (w *characterizationWorkers) reply(rw http.ResponseWriter, _ *http.Request, call runtimeCall) {
	w.mu.Lock()
	w.replies[call.TenantID]++
	n := w.replies[call.TenantID]
	w.mu.Unlock()
	text := fmt.Sprintf("%s reply %d from %s", call.Runtime, n, call.Model)
	if strings.HasPrefix(call.Prompt, "[AwwO collaboration review ") {
		text = fmt.Sprintf("Critique %d from %s: keep the strongest evidence.", n, call.Runtime)
	} else if strings.Contains(call.SystemPrompt, characterizationFilePersona) {
		deliverable, _ := json.Marshal(map[string]any{"summary": fmt.Sprintf("Summary %d from %s.", n, call.Runtime), "artifact": map[string]string{"name": "report.md", "content": fmt.Sprintf("# Report\n\nReply %d from %s.\n", n, call.Runtime)}})
		text = string(deliverable)
	}
	completed := map[string]any{"type": "completed", "text": text}
	if call.Runtime == runtimeOpenAIAgents {
		delta, _ := json.Marshal(map[string]string{"type": "text_delta", "delta": text})
		fmt.Fprintf(rw, "data: %s\n\n", delta)
		completed["observability"] = map[string]any{
			"version": 1,
			"usage":   map[string]any{"status": "reported", "source": "provider_raw", "inputTokens": 120, "outputTokens": 30, "cachedInputTokens": 20, "cacheWriteTokens": nil, "reasoningTokens": 5, "providerTotalTokens": 150},
			"timing":  map[string]any{"setupMs": 4, "providerMs": 20, "providerTtftMs": 7, "workerTotalMs": 30, "workerFirstDeltaMs": 8},
		}
	}
	event, _ := json.Marshal(completed)
	fmt.Fprintf(rw, "data: %s\n\n", event)
}

func (w *characterizationWorkers) snapshot() []characterizedCall {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]characterizedCall(nil), w.calls...)
}

func (w *characterizationWorkers) enableOpenAIAgents(h *harness) {
	h.a.cfg.OpenAIAgentsURL, h.a.cfg.OpenAIAgentsToken = w.oa.URL, strings.Repeat("o", 32)
}

func (s *goldenScrubber) workerRequests(t *testing.T, calls []characterizedCall) []any {
	t.Helper()
	out := make([]any, 0, len(calls))
	for _, c := range calls {
		entry := map[string]any{"runtime": c.runtime, "method": c.method, "path": s.text(c.path), "contentType": c.contentType}
		if len(bytes.TrimSpace(c.body)) > 0 {
			entry["body"] = s.scrub(goldenTree(t, c.body))
		}
		out = append(out, entry)
	}
	return out
}

func newCharacterizationHarness(t *testing.T, openAIAgents bool) (*harness, *characterizationWorkers) {
	t.Helper()
	if os.Getenv("AWWO_TEST_DATABASE_URL") == "" {
		t.Skip("AWWO_TEST_DATABASE_URL absent; PostgreSQL integration not executed")
	}
	// Workers are created first so their cleanup runs after the App has stopped.
	workers := newCharacterizationWorkers(t)
	h := newHarness(t, workers.pi.URL)
	// Outcomes are pinned, latency is not: a shared loaded host must not turn a slow
	// run into a timeout that reads as a changed contract. No golden contains this value.
	h.a.cfg.RunTimeout = time.Minute
	if openAIAgents {
		workers.enableOpenAIAgents(h)
	}
	return h, workers
}

func requireWorkerCalls(t *testing.T, calls []characterizedCall, want int) {
	t.Helper()
	if len(calls) != want {
		t.Fatalf("worker calls %d want %d", len(calls), want)
	}
}

// Characterization pins outcomes, not latency. The shared harness helpers allow 5-6s,
// which a loaded host can exceed for a multi-turn run, so these waits allow a minute
// and still fail at once on any terminal status other than the expected one.
const characterizationSettle = time.Minute

// awaitCharacterizedRun waits for a terminal run; want "" accepts any terminal status.
func awaitCharacterizedRun(t *testing.T, h *harness, c *http.Cookie, tid, id, want string) {
	t.Helper()
	deadline := time.Now().Add(characterizationSettle)
	for time.Now().Before(deadline) {
		v := h.request(t, c, "GET", "/tenants/"+tid+"/runs/"+id, nil, 200)
		if v["terminal"] == true {
			if want != "" && v["status"] != want {
				t.Fatalf("run %s settled as %v, want %s: %v", id, v["status"], want, v)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("run %s did not settle within %s", id, characterizationSettle)
}

// awaitCharacterizedGraph waits for a terminal graph; want "" accepts any terminal status.
func awaitCharacterizedGraph(t *testing.T, h *harness, c *http.Cookie, path, want string) {
	t.Helper()
	deadline := time.Now().Add(characterizationSettle)
	for time.Now().Before(deadline) {
		v := h.request(t, c, "GET", path, nil, 200)
		if status := v["status"]; status != "queued" && status != "running" {
			if want != "" && status != want {
				t.Fatalf("graph %s settled as %v, want %s: %v", path, status, want, v)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("graph %s did not settle within %s", path, characterizationSettle)
}

func usageWindow() url.Values {
	now := time.Now().UTC()
	return url.Values{"from": {now.Add(-time.Hour).Format(time.RFC3339Nano)}, "to": {now.Add(time.Second).Format(time.RFC3339Nano)}}
}

// Team member turns on both runtimes: a Pi member without tools that inherits the
// node model, an OpenAI Agents member with tools and an explicit effort, and an
// OpenAI Agents member with neither. The second run carries completed history.
func TestPostgresRequestCharacterizationTeamMemberTurns(t *testing.T) {
	h, workers := newCharacterizationHarness(t, true)
	c, tid, _ := h.register(t, "team-owner@example.test")
	reader, _, _ := h.register(t, "team-reader@example.test")
	prefix := "/tenants/" + tid
	h.request(t, c, "POST", prefix+"/members", map[string]string{"email": "team-reader@example.test", "role": "reader"}, 201)
	team := nodeTeam{Version: 1, Mode: "sequential", Runtime: runtimePI, MaxRounds: 2, MaxTurns: 20, TimeoutSeconds: 120, Members: []teamMember{
		{ID: "author", Name: "Author", Role: "author", Instructions: "MEMBER-AUTHOR: draft the answer", Context: "shared", Tools: []string{}},
		{ID: "critic", Name: "Critic", Role: "critic", Instructions: "MEMBER-CRITIC: check every number", Runtime: runtimeOpenAIAgents, Model: "oa-default", Effort: "high", Context: "shared", Tools: []string{"calculator", "current_time"}},
		{ID: "judge", Name: "Judge", Role: "reviewer", Instructions: "MEMBER-JUDGE: decide", Runtime: runtimeOpenAIAgents, Context: "task", Tools: []string{}},
	}}
	_, _, sid := installTeam(t, h, c, tid, team)
	runs := []string{}
	for _, step := range []struct{ operation, prompt string }{{"team-run-one", "TEAM-TASK-ONE: outline the launch plan"}, {"team-run-two", "TEAM-TASK-TWO: tighten the launch plan"}} {
		accepted := h.request(t, c, "POST", prefix+"/runs", map[string]string{"sessionId": sid, "prompt": step.prompt, "operationId": step.operation}, 202)
		id := accepted["id"].(string)
		awaitCharacterizedRun(t, h, c, tid, id, "completed")
		runs = append(runs, id)
	}
	calls := workers.snapshot()
	requireWorkerCalls(t, calls, 6)
	completed := []characterizedResponse{}
	turns := []characterizedResponse{}
	for _, id := range runs {
		completed = append(completed, characterizationCall(t, h, c, "GET", prefix+"/runs/"+id, nil, 200))
		turns = append(turns, characterizationCall(t, h, c, "GET", prefix+"/runs/"+id+"/turns", nil, 200))
	}
	ownerInvocations := characterizationCall(t, h, c, "GET", prefix+"/runs/"+runs[0]+"/invocations", nil, 200)
	readerInvocations := characterizationCall(t, h, reader, "GET", prefix+"/runs/"+runs[0]+"/invocations", nil, 200)
	aggregates := map[string]characterizedResponse{}
	for _, group := range []string{"agent", "model", "runtime"} {
		query := usageWindow()
		query.Set("groupBy", group)
		aggregates[group] = characterizationCall(t, h, c, "GET", prefix+"/usage?"+query.Encode(), nil, 200)
	}

	s := newGoldenScrubber()
	s.registerDatabase(t, h)
	record := s.ledger(t, h, tid)
	record["workerRequests"] = s.workerRequests(t, calls)
	record["completedRuns"] = []any{s.response(t, completed[0]), s.response(t, completed[1])}
	turnsAPI := map[string]any{"teamRunOne": s.response(t, turns[0]), "teamRunTwo": s.response(t, turns[1])}
	usageAPI := map[string]any{
		"runInvocationsOwner":  s.response(t, ownerInvocations),
		"runInvocationsReader": s.response(t, readerInvocations),
		"usageByAgent":         s.response(t, aggregates["agent"]),
		"usageByModel":         s.response(t, aggregates["model"]),
		"usageByRuntime":       s.response(t, aggregates["runtime"]),
	}
	s.requireNamed(t)
	assertGolden(t, "team_member_turns.json", record)
	assertGolden(t, "api_run_turns.json", turnsAPI)
	assertGolden(t, "api_usage.json", usageAPI)
}

// Two single-agent graph nodes executed through execute(): a Pi node without effort
// feeds an OpenAI Agents node with an explicit effort and a file deliverable contract.
func TestPostgresRequestCharacterizationGraphSingleAgentNodes(t *testing.T) {
	h, workers := newCharacterizationHarness(t, true)
	c, tid, _ := h.register(t, "graph-owner@example.test")
	prefix := "/tenants/" + tid
	research := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Graph researcher", "adapterType": runtimePI, "model": "test-model", "instructions": "RESEARCH-PERSONA: gather the facts"}, 201)["id"].(string)
	report := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Graph reporter", "adapterType": runtimeOpenAIAgents, "model": "oa-default", "effort": "high", "instructions": characterizationFilePersona + ": write the report"}, 201)["id"].(string)
	doc := map[string]any{
		"nodes": []any{
			map[string]any{"id": "research", "kind": "session", "title": "Research", "runtime": runtimePI, "agentKind": "llm", "x": 0, "y": 0, "binding": map[string]string{"companyId": tid, "agentId": research}},
			map[string]any{"id": "report", "kind": "session", "title": "Report", "runtime": runtimeOpenAIAgents, "agentKind": "llm", "x": 320, "y": 0, "binding": map[string]string{"companyId": tid, "agentId": report},
				"contract": map[string]any{"version": 1,
					"inputs":  []any{map[string]any{"id": "brief", "label": "Brief", "type": "text", "required": true}},
					"outputs": []any{map[string]any{"id": "summary", "label": "Summary", "type": "markdown", "required": true, "help": "Two sentences"}, map[string]any{"id": "artifact", "label": "Report file", "type": "file", "required": true}}}},
		},
		"edges": []any{map[string]any{"id": "research-report", "fromNode": "research", "fromPort": "result", "toNode": "report", "toPort": "in:brief", "dataType": "text"}},
	}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Graph characterization", "document": doc}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	accepted := characterizationCall(t, h, c, "POST", base, map[string]any{"operationId": "graph-characterization", "documentVersion": 1}, 202)
	var admitted struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(accepted.body, &admitted); err != nil {
		t.Fatal(err)
	}
	awaitCharacterizedGraph(t, h, c, base+"/"+admitted.ID, "completed")
	graphRun := characterizationCall(t, h, c, "GET", base+"/"+admitted.ID, nil, 200)
	artifacts := characterizationCall(t, h, c, "GET", prefix+"/canvases/"+cid+"/artifacts", nil, 200)
	calls := workers.snapshot()
	requireWorkerCalls(t, calls, 2)

	s := newGoldenScrubber()
	s.registerDatabase(t, h)
	record := s.ledger(t, h, tid)
	record["workerRequests"] = s.workerRequests(t, calls)
	record["accepted"] = s.response(t, accepted)
	record["graphRun"] = s.response(t, graphRun)
	artifactsAPI := s.response(t, artifacts)
	s.requireNamed(t)
	assertGolden(t, "graph_single_agent_nodes.json", record)
	assertGolden(t, "api_canvas_artifacts.json", artifactsAPI)
}

// Manual createRun on initialized nodes: Pi, OpenAI Agents without effort (twice, so
// the second request carries history) and OpenAI Agents with an explicit effort.
func TestPostgresRequestCharacterizationManualCreateRun(t *testing.T) {
	h, workers := newCharacterizationHarness(t, true)
	c, tid, _ := h.register(t, "manual-owner@example.test")
	prefix := "/tenants/" + tid
	node := func(id, title, runtime, persona, effort string) map[string]any {
		return map[string]any{"id": id, "kind": "session", "agentKind": "llm", "title": title, "runtime": runtime, "model": "", "persona": persona, "effort": effort, "binding": nil, "issueId": nil, "threads": []any{}}
	}
	doc := map[string]any{"nodes": []any{
		node("pi-node", "Manual Pi", runtimePI, "MANUAL-PI-PERSONA", ""),
		node("oa-node", "Manual OA", runtimeOpenAIAgents, "MANUAL-OA-PERSONA", ""),
		node("oa-effort-node", "Manual OA effort", runtimeOpenAIAgents, "MANUAL-OA-EFFORT-PERSONA", "low"),
	}, "edges": []any{}}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Manual characterization", "document": doc}, 201)["id"].(string)
	initialized := h.request(t, c, "POST", prefix+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	sessions := map[string]string{}
	for i := range 3 {
		n := setupNodeAt(initialized, i)
		sessions[n["id"].(string)] = n["issueId"].(string)
	}
	accepted, completed := []characterizedResponse{}, []characterizedResponse{}
	for _, step := range []struct{ node, operation, prompt string }{
		{"pi-node", "manual-pi-run", "MANUAL-PI-QUESTION"},
		{"oa-node", "manual-oa-run-one", "MANUAL-OA-QUESTION-ONE"},
		{"oa-node", "manual-oa-run-two", "MANUAL-OA-QUESTION-TWO"},
		{"oa-effort-node", "manual-oa-effort-run", "MANUAL-OA-EFFORT-QUESTION"},
	} {
		response := characterizationCall(t, h, c, "POST", prefix+"/runs", map[string]string{"sessionId": sessions[step.node], "prompt": step.prompt, "operationId": step.operation}, 202)
		var run struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(response.body, &run); err != nil {
			t.Fatal(err)
		}
		awaitCharacterizedRun(t, h, c, tid, run.ID, "completed")
		accepted = append(accepted, response)
		completed = append(completed, characterizationCall(t, h, c, "GET", prefix+"/runs/"+run.ID, nil, 200))
	}
	calls := workers.snapshot()
	requireWorkerCalls(t, calls, 4)

	s := newGoldenScrubber()
	s.registerDatabase(t, h)
	record := s.ledger(t, h, tid)
	record["workerRequests"] = s.workerRequests(t, calls)
	acceptedRecords, completedRecords := []any{}, []any{}
	for i := range accepted {
		acceptedRecords = append(acceptedRecords, s.response(t, accepted[i]))
		completedRecords = append(completedRecords, s.response(t, completed[i]))
	}
	record["accepted"], record["completedRuns"] = acceptedRecords, completedRecords
	s.requireNamed(t)
	assertGolden(t, "manual_create_run.json", record)
}

// Collaboration proposal, review and synthesis turns across both runtimes.
func TestPostgresRequestCharacterizationCollaborationTurns(t *testing.T) {
	h, workers := newCharacterizationHarness(t, true)
	c, tid, _ := h.register(t, "collaboration-owner@example.test")
	prefix := "/tenants/" + tid
	author := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Collaboration author", "adapterType": runtimePI, "model": "test-model", "instructions": "AUTHOR-PERSONA: propose a plan"}, 201)["id"].(string)
	reviewer := h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": "Collaboration reviewer", "adapterType": runtimeOpenAIAgents, "model": "oa-default", "instructions": "REVIEWER-PERSONA: find the risks"}, 201)["id"].(string)
	doc := map[string]any{"nodes": []any{
		map[string]any{"id": "author", "kind": "session", "title": "Author", "runtime": runtimePI, "agentKind": "llm", "x": 0, "y": 0, "binding": map[string]string{"companyId": tid, "agentId": author}},
		map[string]any{"id": "reviewer", "kind": "session", "title": "Reviewer", "runtime": runtimeOpenAIAgents, "agentKind": "llm", "x": 320, "y": 0, "binding": map[string]string{"companyId": tid, "agentId": reviewer}},
	}, "edges": []any{}}
	cid := h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": "Collaboration characterization", "document": doc}, 201)["id"].(string)
	base := prefix + "/canvases/" + cid + "/graph-runs"
	accepted := characterizationCall(t, h, c, "POST", base, map[string]any{"operationId": "collaboration-characterization", "documentVersion": 1, "scope": []string{"author", "reviewer"}, "collaboration": collaborationPolicy{Goal: "Agree on one launch plan", Rounds: 1, SynthesizerNodeID: "author"}}, 202)
	var admitted struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(accepted.body, &admitted); err != nil {
		t.Fatal(err)
	}
	awaitCharacterizedGraph(t, h, c, base+"/"+admitted.ID, "completed")
	graphRun := characterizationCall(t, h, c, "GET", base+"/"+admitted.ID, nil, 200)
	calls := workers.snapshot()
	requireWorkerCalls(t, calls, 5)

	s := newGoldenScrubber()
	s.registerDatabase(t, h)
	record := s.ledger(t, h, tid)
	record["workerRequests"] = s.workerRequests(t, calls)
	record["accepted"] = s.response(t, accepted)
	record["graphRun"] = s.response(t, graphRun)
	s.requireNamed(t)
	assertGolden(t, "collaboration_turns.json", record)
}

// GET /tenants/{tid}/runtime with only Pi configured, with both runtimes (per-model
// effort advertised and absent), under a restricted allowlist and under an empty one.
func TestPostgresRequestCharacterizationRuntimeCatalogue(t *testing.T) {
	h, workers := newCharacterizationHarness(t, false)
	c, tid, _ := h.register(t, "catalogue-owner@example.test")
	path := "/tenants/" + tid + "/runtime"
	piOnly := characterizationCall(t, h, c, "GET", path, nil, 200)
	workers.enableOpenAIAgents(h)
	both := characterizationCall(t, h, c, "GET", path, nil, 200)
	ctx := context.Background()
	if _, err := h.db.Exec(ctx, "UPDATE tenants SET allowed_models=$2::text[] WHERE id=$1", tid, []string{"oa-only", "test-model"}); err != nil {
		t.Fatal(err)
	}
	restricted := characterizationCall(t, h, c, "GET", path, nil, 200)
	if _, err := h.db.Exec(ctx, "UPDATE tenants SET allowed_models='{}' WHERE id=$1", tid); err != nil {
		t.Fatal(err)
	}
	empty := characterizationCall(t, h, c, "GET", path, nil, 200)
	requireWorkerCalls(t, workers.snapshot(), 0)

	s := newGoldenScrubber()
	s.registerDatabase(t, h)
	catalogue := map[string]any{"piOnly": s.response(t, piOnly), "bothRuntimes": s.response(t, both), "restrictedAllowlist": s.response(t, restricted), "emptyAllowlist": s.response(t, empty)}
	s.requireNamed(t)
	assertGolden(t, "api_runtime_catalogue.json", catalogue)
}

// The platform-admin tenant projection from PATCH and from the tenant listing.
func TestPostgresRequestCharacterizationAdminTenant(t *testing.T) {
	h, _ := newCharacterizationHarness(t, true)
	_, tid, _ := h.register(t, "admin-target@example.test")
	admin, _, adminID := h.register(t, "platform-admin@example.test")
	if _, err := h.db.Exec(context.Background(), "UPDATE users SET platform_role='admin' WHERE id=$1", adminID); err != nil {
		t.Fatal(err)
	}
	record := map[string]any{}
	steps := []struct {
		name string
		body any
	}{
		{"quota", map[string]any{"maxConcurrentRuns": 3, "maxRunsPerDay": 250}},
		{"allowlist", map[string]any{"allowedModels": []string{"test-model", "oa-default", "test-model"}}},
		{"allowlistCleared", map[string]any{"allowedModels": nil}},
		{"suspended", map[string]any{"status": "suspended"}},
		{"reactivated", map[string]any{"status": "active"}},
		{"invalidQuota", map[string]any{"maxRunsPerDay": 0}},
		{"invalidAllowlist", map[string]any{"allowedModels": []string{"has space"}}},
		{"emptyPatch", map[string]any{}},
	}
	responses := make([]characterizedResponse, len(steps))
	for i, step := range steps {
		responses[i] = characterizationExchange(t, h, admin, "PATCH", "/admin/tenants/"+tid, step.body)
	}
	missing := characterizationExchange(t, h, admin, "PATCH", "/admin/tenants/missing-workspace", map[string]any{"status": "active"})
	listing := characterizationCall(t, h, admin, "GET", "/admin/tenants?limit=200", nil, 200)

	s := newGoldenScrubber()
	s.registerDatabase(t, h)
	for i, step := range steps {
		record[step.name] = s.response(t, responses[i])
	}
	record["missingWorkspace"] = s.response(t, missing)
	record["listing"] = s.response(t, listing)
	s.requireNamed(t)
	assertGolden(t, "api_admin_tenant.json", record)
}

// Current status, code and message for an image node at initialize, createRun and
// createGraphRun, plus the effort refusals added with per-model effort. Where a path
// accepts today, the golden records the acceptance and what it then sends.
func TestPostgresRequestCharacterizationErrorShapes(t *testing.T) {
	h, workers := newCharacterizationHarness(t, true)
	c, tid, _ := h.register(t, "errors-owner@example.test")
	prefix := "/tenants/" + tid
	record := map[string]any{}
	responses := map[string]characterizedResponse{}
	setupNode := func(id, agentKind, runtime, model, effort string) map[string]any {
		return map[string]any{"id": id, "kind": "session", "agentKind": agentKind, "title": id, "runtime": runtime, "model": model, "persona": "PERSONA-" + id, "effort": effort, "binding": nil, "issueId": nil, "threads": []any{}}
	}
	canvas := func(name string, nodes ...any) string {
		t.Helper()
		return h.request(t, c, "POST", prefix+"/canvases", map[string]any{"name": name, "document": map[string]any{"nodes": nodes, "edges": []any{}}}, 201)["id"].(string)
	}
	agent := func(name, runtime, model, effort string) string {
		t.Helper()
		return h.request(t, c, "POST", prefix+"/agents", map[string]any{"name": name, "adapterType": runtime, "model": model, "effort": effort, "instructions": "PERSONA-" + name}, 201)["id"].(string)
	}
	bound := func(id, agentKind, runtime, agentID string) map[string]any {
		return map[string]any{"id": id, "kind": "session", "agentKind": agentKind, "title": id, "runtime": runtime, "binding": map[string]string{"companyId": tid, "agentId": agentID}}
	}
	runID := func(r characterizedResponse) string {
		t.Helper()
		var v struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(r.body, &v); err != nil || v.ID == "" {
			t.Fatalf("accepted response without id: %s", r.body)
		}
		return v.ID
	}

	// Image node at initialize.
	imageSetup := canvas("Image initialize", setupNode("image-setup", "image", runtimePI, "", ""))
	responses["imageNodeInitialize"] = characterizationExchange(t, h, c, "POST", prefix+"/canvases/"+imageSetup+"/initialize", map[string]any{"documentVersion": 1})

	// Image node at createRun, through a session created for that node.
	imageManualAgent := agent("Image manual agent", runtimePI, "test-model", "")
	imageManual := canvas("Image manual", map[string]any{"id": "image-manual", "kind": "session", "agentKind": "image", "title": "image-manual", "runtime": runtimePI})
	imageSession := h.request(t, c, "POST", prefix+"/sessions", map[string]any{"canvasId": imageManual, "nodeId": "image-manual", "agentId": imageManualAgent, "title": "Image thread"}, 201)["id"].(string)
	responses["imageNodeCreateRun"] = characterizationExchange(t, h, c, "POST", prefix+"/runs", map[string]string{"sessionId": imageSession, "prompt": "IMAGE-MANUAL-PROMPT: a red kite", "operationId": "image-manual-run"})
	if responses["imageNodeCreateRun"].status == 202 {
		id := runID(responses["imageNodeCreateRun"])
		awaitCharacterizedRun(t, h, c, tid, id, "")
		responses["imageNodeCreateRunSettled"] = characterizationCall(t, h, c, "GET", prefix+"/runs/"+id, nil, 200)
	}

	// Image node at createGraphRun.
	imageGraphAgent := agent("Image graph agent", runtimePI, "test-model", "")
	imageGraph := canvas("Image graph", bound("image-graph", "image", runtimePI, imageGraphAgent))
	graphBase := prefix + "/canvases/" + imageGraph + "/graph-runs"
	responses["imageNodeCreateGraphRun"] = characterizationExchange(t, h, c, "POST", graphBase, map[string]any{"operationId": "image-graph-run", "documentVersion": 1})
	if responses["imageNodeCreateGraphRun"].status == 202 {
		path := graphBase + "/" + runID(responses["imageNodeCreateGraphRun"])
		awaitCharacterizedGraph(t, h, c, path, "")
		responses["imageNodeCreateGraphRunSettled"] = characterizationCall(t, h, c, "GET", path, nil, 200)
	}

	// Effort a model does not advertise, at initialize, createRun and createGraphRun.
	effortSetup := canvas("Effort initialize", setupNode("effort-setup", "llm", runtimeOpenAIAgents, "oa-only", "high"))
	responses["unadvertisedEffortInitialize"] = characterizationExchange(t, h, c, "POST", prefix+"/canvases/"+effortSetup+"/initialize", map[string]any{"documentVersion": 1})
	unadvertised := agent("Unadvertised effort agent", runtimeOpenAIAgents, "oa-default", "medium")
	effortManual := canvas("Effort manual", map[string]any{"id": "effort-manual", "kind": "session", "agentKind": "llm", "title": "effort-manual", "runtime": runtimeOpenAIAgents})
	effortSession := h.request(t, c, "POST", prefix+"/sessions", map[string]any{"canvasId": effortManual, "nodeId": "effort-manual", "agentId": unadvertised, "title": "Effort thread"}, 201)["id"].(string)
	responses["unadvertisedEffortCreateRun"] = characterizationExchange(t, h, c, "POST", prefix+"/runs", map[string]string{"sessionId": effortSession, "prompt": "EFFORT-PROMPT", "operationId": "effort-manual-run"})
	effortGraph := canvas("Effort graph", bound("effort-graph", "llm", runtimeOpenAIAgents, unadvertised))
	responses["unadvertisedEffortCreateGraphRun"] = characterizationExchange(t, h, c, "POST", prefix+"/canvases/"+effortGraph+"/graph-runs", map[string]any{"operationId": "effort-graph-run", "documentVersion": 1})
	calls := workers.snapshot()

	s := newGoldenScrubber()
	s.registerDatabase(t, h)
	names := make([]string, 0, len(responses))
	for name := range responses {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		record[name] = s.response(t, responses[name])
	}
	ledger := s.ledger(t, h, tid)
	ledger["workerRequests"] = s.workerRequests(t, calls)
	record["acceptedExecution"] = ledger
	s.requireNamed(t)
	assertGolden(t, "api_error_shapes.json", record)
}

// The goldens only protect anything if a difference is actually reported. This
// perturbs one worker request key of a real golden and requires the comparison to
// fail with a diff naming the change. It reads the golden directly, so a missing or
// unreadable file fails rather than skips.
func TestRequestCharacterizationGoldenComparisonDetectsPerturbation(t *testing.T) {
	const name = "team_member_turns.json"
	raw, err := os.ReadFile(goldenPath(name))
	if err != nil {
		t.Fatalf("golden %s must be readable: %v", goldenPath(name), err)
	}
	doc, err := decodeGolden(raw)
	if err != nil {
		t.Fatal(err)
	}
	// The stored file must already be canonical, or regeneration would rewrite it.
	canonical, err := encodeGolden(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err = compareGolden(name, canonical); err != nil {
		t.Fatalf("golden is not in canonical form: %v", err)
	}
	record, _ := doc.(map[string]any)
	requests, _ := record["workerRequests"].([]any)
	if len(requests) == 0 {
		t.Fatal("golden holds no worker requests to perturb")
	}
	first, _ := requests[0].(map[string]any)
	body, _ := first["body"].(map[string]any)
	model, _ := body["model"].(string)
	if model == "" {
		t.Fatal("golden worker request has no model key")
	}
	body["model"] = model + "-perturbed"
	changed, err := encodeGolden(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err = compareGolden(name, changed); err == nil || !strings.Contains(err.Error(), "-perturbed") {
		t.Fatalf("a changed request value was not reported: %v", err)
	}
	body["model"] = model
	system := body["systemPrompt"]
	delete(body, "systemPrompt")
	removed, err := encodeGolden(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err = compareGolden(name, removed); err == nil || !strings.Contains(err.Error(), `"systemPrompt"`) {
		t.Fatalf("a removed request key was not reported: %v", err)
	}
	body["systemPrompt"] = system
	body["effort"] = "perturbed-effort"
	added, err := encodeGolden(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err = compareGolden(name, added); err == nil || !strings.Contains(err.Error(), "perturbed-effort") {
		t.Fatalf("an added request key was not reported: %v", err)
	}
}

func TestRequestCharacterizationScrubberNamesEveryGeneratedIdentity(t *testing.T) {
	s := newGoldenScrubber()
	named, unnamed := randomID(), randomID()
	if err := s.name(named, "<run:one>"); err != nil {
		t.Fatal(err)
	}
	if s.name(named, "<run:two>") == nil || s.name(unnamed, "<run:one>") == nil {
		t.Fatal("conflicting placeholder accepted")
	}
	got := s.scrub(map[string]any{
		"runId":        named,
		"sessionId":    unnamed + "_0123456789abcdef",
		"createdAt":    "2026-09-15T01:02:03.456789+00:00",
		"retainedFrom": "1970-01-01T08:00:00+08:00",
		"requestId":    "",
		"trace_id":     "4bf92f3577b34da6a3ce929d0e0e4736",
		"timingMs":     map[string]any{"queue": json.Number("3"), "setup": json.Number("4"), "admission": nil},
	})
	want := map[string]any{
		"runId":        "<run:one>",
		"sessionId":    unnamed + "_0123456789abcdef",
		"createdAt":    "<timestamp>",
		"retainedFrom": "<timestamp>",
		"requestId":    "",
		"trace_id":     "<trace-id>",
		"timingMs":     map[string]any{"queue": "<measured-ms>", "setup": json.Number("4"), "admission": nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scrubbed %#v", got)
	}
	if leaks := s.unnamed(); len(leaks) != 1 || leaks[0] != unnamed {
		t.Fatal("unnamed generated identity not reported", leaks)
	}
}
