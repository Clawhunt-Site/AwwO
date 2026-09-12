package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type App struct {
	db          *pgxpool.Pool
	cfg         Config
	log         *slog.Logger
	client      *http.Client
	dummyHash   string
	cursorKey   []byte
	mu          sync.Mutex
	running     map[string]context.CancelFunc
	limits      map[string]rateEntry
	tasks       sync.WaitGroup
	closed      bool
	lease       *pgxpool.Conn
	leaseCancel context.CancelFunc
	leaseLost   atomic.Bool
	authSlots   chan struct{}
	reauthEvery time.Duration
}
type rateEntry struct {
	start time.Time
	count int
}

func New(db *pgxpool.Pool, c Config) *App {
	if c.PIAdmissionWait == 0 {
		c.PIAdmissionWait = 5 * time.Second
	}
	return &App{db: db, cfg: c, log: slog.Default(), client: &http.Client{Timeout: c.RunTimeout}, dummyHash: hashPassword(randomID()), cursorKey: []byte(randomID() + randomID()), running: map[string]context.CancelFunc{}, limits: map[string]rateEntry{}, authSlots: make(chan struct{}, 4), reauthEvery: 15 * time.Second}
}

// A dedicated advisory lock makes the first release explicitly single-worker.
// Horizontal deployment must first replace this with durable worker leases.
func (a *App) Start(ctx context.Context) error {
	conn, e := a.db.Acquire(ctx)
	if e != nil {
		return e
	}
	var locked bool
	if e = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema(),84321002))").Scan(&locked); e != nil || !locked {
		conn.Release()
		if e != nil {
			return e
		}
		return errors.New("another Awwo API worker owns this database")
	}
	a.lease = conn
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, "UPDATE runs SET status='interrupted',error='API restarted before completion',updated_at=now() WHERE status IN ('queued','running') RETURNING tenant_id,id")
	if e != nil {
		return e
	}
	type pair struct{ t, id string }
	ids := []pair{}
	for rows.Next() {
		var p pair
		if e = rows.Scan(&p.t, &p.id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, p)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	for _, p := range ids {
		if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", p.t, p.id, `{"type":"interrupted"}`); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, "UPDATE run_turns SET status='interrupted',error='API restarted before completion',updated_at=now() WHERE status IN ('queued','running')"); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "UPDATE model_invocations SET status='interrupted',updated_at=now() WHERE status='running'"); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	watch, cancel := context.WithCancel(context.Background())
	a.leaseCancel = cancel
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-watch.Done():
				return
			case <-tick.C:
				probe, done := context.WithTimeout(watch, 2*time.Second)
				_, err := conn.Exec(probe, "SELECT 1")
				done()
				if err != nil {
					if watch.Err() != nil {
						return
					}
					a.leaseLost.Store(true)
					a.mu.Lock()
					a.closed = true
					for _, stop := range a.running {
						stop()
					}
					a.mu.Unlock()
					a.log.Error("database worker lock connection lost; restart required")
					return
				}
			}
		}
	}()
	return a.recoverGraphs(ctx)
}
func (a *App) Close() {
	if a.leaseCancel != nil {
		a.leaseCancel()
	}
	a.mu.Lock()
	a.closed = true
	for _, cancel := range a.running {
		cancel()
	}
	a.mu.Unlock()
	a.tasks.Wait()
	if a.lease != nil {
		_, _ = a.lease.Exec(context.Background(), "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || current_schema(),84321002))")
		a.lease.Release()
		a.lease = nil
	}
}
func (a *App) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if e := a.db.Ping(ctx); e != nil {
			fail(w, 503, "database_unavailable", "Database unavailable")
			return
		}
		writeJSON(w, 200, map[string]any{"status": "ok", "environment": a.cfg.Env})
	})
	m.HandleFunc("GET /api/v1/runtime", a.auth(a.runtime))
	m.HandleFunc("POST /api/v1/auth/register", a.authRate(a.register))
	m.HandleFunc("POST /api/v1/auth/login", a.authRate(a.login))
	m.HandleFunc("POST /api/v1/auth/logout", a.auth(a.logout))
	m.HandleFunc("PATCH /api/v1/auth/profile", a.auth(a.updateProfile))
	m.HandleFunc("GET /api/v1/appearance", a.auth(a.appearance))
	m.HandleFunc("PUT /api/v1/appearance", a.auth(a.updateAppearance))
	m.HandleFunc("GET /api/v1/appearance/export", a.auth(a.exportAppearance))
	m.HandleFunc("GET /api/v1/invites/{token}", a.auth(a.previewInvite))
	m.HandleFunc("POST /api/v1/invites/{token}/accept", a.auth(a.acceptInvite))
	m.HandleFunc("GET /api/v1/auth/me", a.auth(func(w http.ResponseWriter, r *http.Request) { a.meResponse(w, r, currentUser(r), 200) }))
	m.HandleFunc("GET /api/v1/tenants", a.auth(a.tenants))
	m.HandleFunc("POST /api/v1/tenants", a.auth(a.createTenant))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/members", a.tenant(a.members, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/members", a.tenant(a.addMember, 3))
	m.HandleFunc("PATCH /api/v1/tenants/{tenantId}/members/{id}", a.tenant(a.updateMember, 3))
	m.HandleFunc("DELETE /api/v1/tenants/{tenantId}/members/{id}", a.tenant(a.removeMember, 3))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/invites", a.tenant(a.listInvites, 3))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/invites", a.tenant(a.createInvite, 3))
	m.HandleFunc("DELETE /api/v1/tenants/{tenantId}/invites/{id}", a.tenant(a.revokeInvite, 3))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/canvases", a.tenant(a.listCanvases, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases", a.tenant(a.createCanvas, 2))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases/{id}/plan", a.tenant(a.planCanvas, 2))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases/{id}/initialize", a.tenant(a.initializeCanvas, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/canvases/{id}", a.tenant(a.getCanvas, 1))
	m.HandleFunc("PUT /api/v1/tenants/{tenantId}/canvases/{id}", a.tenant(a.updateCanvas, 2))
	m.HandleFunc("DELETE /api/v1/tenants/{tenantId}/canvases/{id}", a.tenant(a.deleteCanvas, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/canvases/{id}/artifacts", a.tenant(a.listArtifacts, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/artifacts/{id}", a.tenant(a.downloadArtifact, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/agents", a.tenant(a.listAgents, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/agents", a.tenant(a.createAgent, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/agents/{id}", a.tenant(a.getAgent, 1))
	m.HandleFunc("PUT /api/v1/tenants/{tenantId}/agents/{id}", a.tenant(a.updateAgent, 2))
	m.HandleFunc("PUT /api/v1/tenants/{tenantId}/agents/{id}/instructions", a.tenant(a.agentInstructions, 2))
	m.HandleFunc("DELETE /api/v1/tenants/{tenantId}/agents/{id}", a.tenant(a.deleteAgent, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/sessions", a.tenant(a.listSessions, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/sessions", a.tenant(a.createSession, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/sessions/{id}", a.tenant(a.getSession, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/sessions/{id}/messages", a.tenant(a.messages, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/runs", a.tenant(a.listRuns, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/runs", a.tenant(a.createRun, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/runs/{id}", a.tenant(a.getRun, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/runs/{id}/cancel", a.tenant(a.cancelRun, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/runs/{id}/events", a.tenant(a.events, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/runs/{id}/turns", a.tenant(a.runTurns, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases/{canvasId}/graph-runs", a.tenant(a.createGraphRun, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/canvases/{canvasId}/graph-runs", a.tenant(a.listGraphRuns, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/canvases/{canvasId}/graph-runs/{id}", a.tenant(a.getGraphRun, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases/{canvasId}/graph-runs/{id}/cancel", a.tenant(a.cancelGraphRun, 2))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases/{canvasId}/graph-runs/operations/{operationId}/cancel", a.tenant(a.cancelGraphOperation, 2))
	m.HandleFunc("GET /api/v1/admin/summary", a.admin(a.adminSummary))
	for _, kind := range []string{"tenants", "users", "runs", "audit"} {
		m.HandleFunc("GET /api/v1/admin/"+kind, a.admin(a.adminList(kind)))
	}
	m.HandleFunc("PATCH /api/v1/admin/tenants/{id}", a.admin(a.adminTenant))
	return a.security(m)
}

func (a *App) workerAvailable(w http.ResponseWriter) bool {
	a.mu.Lock()
	closed := a.closed
	a.mu.Unlock()
	if closed {
		fail(w, 503, "worker_unavailable", "API worker is shutting down")
		return false
	}
	if a.leaseLost.Load() {
		fail(w, 503, "worker_unavailable", "Database worker lock was lost; restart required")
		return false
	}
	return true
}
func (a *App) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.workerAvailable(w) {
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/events") {
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if a.cfg.Env == "staging" {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			origin := r.Header.Get("Origin")
			if (origin != "" && origin != a.cfg.PublicOrigin) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				fail(w, 403, "invalid_origin", "Request origin is not allowed")
				return
			}
		}
		// Reject cross-origin reads too, and never grant wildcard credentials.
		if o := r.Header.Get("Origin"); o != "" && o != a.cfg.PublicOrigin {
			fail(w, 403, "invalid_origin", "Request origin is not allowed")
			return
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		defer func() {
			if x := recover(); x != nil {
				a.log.Error("request panic", "route", r.Pattern)
				fail(w, 500, "internal_error", "Request failed")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
func (a *App) authRate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := a.clientIP(r)
		now := time.Now()
		a.mu.Lock()
		if _, known := a.limits[ip]; !known && len(a.limits) >= 10000 {
			for k, x := range a.limits {
				if now.Sub(x.start) > time.Minute {
					delete(a.limits, k)
				}
			}
			if len(a.limits) >= 10000 {
				a.mu.Unlock()
				fail(w, 429, "rate_limited", "Authentication is busy")
				return
			}
		}
		v := a.limits[ip]
		if now.Sub(v.start) >= time.Minute {
			v = rateEntry{start: now}
		}
		v.count++
		a.limits[ip] = v
		if len(a.limits) > 10000 {
			for k, x := range a.limits {
				if now.Sub(x.start) > time.Minute {
					delete(a.limits, k)
				}
			}
		}
		allowed := v.count <= a.cfg.AuthRequestsPerMinute
		a.mu.Unlock()
		if !allowed {
			w.Header().Set("Retry-After", "60")
			fail(w, 429, "rate_limited", "Too many authentication attempts")
			return
		}
		select {
		case a.authSlots <- struct{}{}:
			defer func() { <-a.authSlots }()
		default:
			fail(w, 429, "rate_limited", "Authentication is busy")
			return
		}
		next(w, r)
	}
}

func (a *App) clientIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return host
	}
	trusted := func(ip netip.Addr) bool {
		for _, p := range a.cfg.TrustedProxyCIDRs {
			if p.Contains(ip) {
				return true
			}
		}
		return false
	}
	if !trusted(peer) {
		return peer.String()
	}
	chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(chain) - 1; i >= 0; i-- {
		ip, e := netip.ParseAddr(strings.TrimSpace(chain[i]))
		if e != nil {
			return peer.String()
		}
		if !trusted(ip) || i == 0 {
			return ip.String()
		}
	}
	return peer.String()
}
func (a *App) decode(w http.ResponseWriter, r *http.Request, b any) bool {
	media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || media != "application/json" {
		fail(w, 415, "unsupported_media_type", "Use application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, a.cfg.MaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if e = dec.Decode(b); e != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(e, &tooLarge) {
			fail(w, 413, "body_too_large", "Request body is too large")
		} else {
			fail(w, 400, "invalid_json", "Invalid JSON request")
		}
		return false
	}
	if e = dec.Decode(&struct{}{}); !errors.Is(e, io.EOF) {
		fail(w, 400, "invalid_json", "Expected a single JSON object")
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func (a *App) dbError(w http.ResponseWriter, e error) {
	a.log.Error("database operation failed", "error", e)
	fail(w, 500, "internal_error", "Could not complete the request")
}
func (a *App) replyOne(w http.ResponseWriter, v json.RawMessage, e error, status int) {
	if noRows(e) {
		fail(w, 404, "not_found", "Resource not found")
	} else if e != nil {
		a.dbError(w, e)
	} else {
		writeJSON(w, status, v)
	}
}
func (a *App) replyList(w http.ResponseWriter, v []json.RawMessage, e error) {
	if e != nil {
		a.dbError(w, e)
	} else {
		writeJSON(w, 200, map[string]any{"items": v})
	}
}
func cleanName(v string) bool { return strings.TrimSpace(v) != "" && len(v) <= 200 }
