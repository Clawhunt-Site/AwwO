package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultTypeSafeModel  = "jev-1.13.0"
	typeSafeEndpoint      = "https://api.typesafe.ai/v1/systemone"
	typeSafeRequestLimit  = 65536
	typeSafeResponseLimit = 1 << 20
	typeSafeQuestionLimit = 16
)

var typeSafeModelName = regexp.MustCompile(`^jev-(?:[0-9]+\.[0-9]+\.[0-9]+|latest|preview)$`)
var typeSafeTenantID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func (c *Config) typeSafeFromEnv() error {
	c.TypeSafeAPIKey = os.Getenv("AWWO_TYPESAFE_API_KEY")
	c.TypeSafeModel = env("AWWO_TYPESAFE_MODEL", defaultTypeSafeModel)
	c.TypeSafeTimeout = 10 * time.Second
	c.TypeSafeMaxEvaluationsPerDay = 20
	switch os.Getenv("AWWO_TYPESAFE_SPONSORED_PLANNING") {
	case "", "false":
	case "true":
		c.TypeSafeSponsoredPlanning = true
	default:
		return errors.New("AWWO_TYPESAFE_SPONSORED_PLANNING must be true or false")
	}
	if raw := os.Getenv("AWWO_TYPESAFE_ENABLED_TENANT_IDS"); raw != "" {
		for _, id := range strings.Split(raw, ",") {
			c.TypeSafeEnabledTenantIDs = append(c.TypeSafeEnabledTenantIDs, strings.TrimSpace(id))
		}
	}
	if raw := os.Getenv("AWWO_TYPESAFE_TIMEOUT"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return errors.New("AWWO_TYPESAFE_TIMEOUT must be a positive duration")
		}
		c.TypeSafeTimeout = d
	}
	if raw := os.Getenv("AWWO_TYPESAFE_MAX_EVALUATIONS_PER_DAY"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			return errors.New("AWWO_TYPESAFE_MAX_EVALUATIONS_PER_DAY must be between 1 and 1000")
		}
		c.TypeSafeMaxEvaluationsPerDay = n
	}
	return validateTypeSafeConfig(*c)
}

func validateTypeSafeConfig(c Config) error {
	if c.TypeSafeModel != "" && !typeSafeModelName.MatchString(c.TypeSafeModel) {
		return errors.New("invalid AWWO_TYPESAFE_MODEL")
	}
	if c.TypeSafeTimeout < 0 || c.TypeSafeTimeout > 25*time.Second {
		return errors.New("AWWO_TYPESAFE_TIMEOUT must be positive and at most 25s")
	}
	if c.TypeSafeMaxEvaluationsPerDay < 0 || c.TypeSafeMaxEvaluationsPerDay > 1000 {
		return errors.New("AWWO_TYPESAFE_MAX_EVALUATIONS_PER_DAY must be between 1 and 1000")
	}
	if len(c.TypeSafeAPIKey) > 4096 {
		return errors.New("invalid AWWO_TYPESAFE_API_KEY")
	}
	for _, ch := range c.TypeSafeAPIKey {
		if ch < 33 || ch > 126 {
			return errors.New("invalid AWWO_TYPESAFE_API_KEY")
		}
	}
	if len(c.TypeSafeEnabledTenantIDs) > 256 {
		return errors.New("too many AWWO_TYPESAFE_ENABLED_TENANT_IDS")
	}
	seen := map[string]bool{}
	for _, id := range c.TypeSafeEnabledTenantIDs {
		if !typeSafeTenantID.MatchString(id) || seen[id] {
			return errors.New("invalid AWWO_TYPESAFE_ENABLED_TENANT_IDS")
		}
		seen[id] = true
	}
	return nil
}

func (c Config) typeSafeModel() string {
	if c.TypeSafeModel == "" {
		return defaultTypeSafeModel
	}
	return c.TypeSafeModel
}
func (c Config) typeSafeEnabled(tenant string) bool {
	if c.UserCredentials && !c.TypeSafeSponsoredPlanning {
		return false
	}
	for _, id := range c.TypeSafeEnabledTenantIDs {
		if id == tenant {
			return true
		}
	}
	return false
}
func (c Config) typeSafeDailyLimit() int {
	if c.TypeSafeMaxEvaluationsPerDay == 0 {
		return 20
	}
	return c.TypeSafeMaxEvaluationsPerDay
}

type typeSafeUsage struct {
	InputTokens  *int64 `json:"input_tokens"`
	OutputTokens *int64 `json:"output_tokens"`
}
type typeSafeResponse struct {
	Model   string                    `json:"model"`
	Answers map[string]map[string]any `json:"answers"`
	Usage   typeSafeUsage             `json:"usage"`
}
type typeSafeQuestion struct {
	Type         string `json:"type"`
	Instructions any    `json:"instructions"`
	Criteria     any    `json:"criteria,omitempty"`
}
type typeSafeRequest struct {
	State     any                         `json:"state"`
	Questions map[string]typeSafeQuestion `json:"questions"`
}

// This audit is separate from the text-model ledger. Only metadata is retained.
type typeSafeAuditRecord struct {
	ID, Actor, Tenant, Model, Status string
	Usage                            *typeSafeUsage
	SessionHash                      string `json:"-"`
}
type typeSafeRate struct {
	start         time.Time
	count, active int
}
type typeSafeService struct {
	client    *http.Client
	audit     func(context.Context, typeSafeAuditRecord) error
	authorize func(context.Context, typeSafeAuditRecord) error
	mu        sync.Mutex
	active    int
	rates     map[string]typeSafeRate
}

func newTypeSafeService(audit func(context.Context, typeSafeAuditRecord) error) *typeSafeService {
	return &typeSafeService{
		client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		audit:  audit, rates: map[string]typeSafeRate{},
	}
}

// Limits are intentionally independent of login limits and Pi run accounting.
// The API already enforces a single active server worker for this database.
func (s *typeSafeService) reserve(tenant string, now time.Time) (func(), bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, rate := range s.rates {
		if rate.active == 0 && now.Sub(rate.start) >= time.Minute {
			delete(s.rates, id)
		}
	}
	r, known := s.rates[tenant]
	if now.Sub(r.start) >= time.Minute {
		r.start, r.count = now, 0
	}
	if s.active >= 4 || r.active >= 1 || r.count >= 5 || (len(s.rates) >= 256 && !known) {
		return nil, false
	}
	r.count++
	r.active++
	s.active++
	s.rates[tenant] = r
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		r := s.rates[tenant]
		r.active--
		s.rates[tenant] = r
		s.active--
	}, true
}

func (a *App) typeSafeStatus(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenantId")
	var role, status string
	if err := a.db.QueryRow(r.Context(), "SELECT m.role,t.status FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2", tenant, currentUser(r).ID).Scan(&role, &status); err != nil {
		a.dbError(w, err)
		return
	}
	a.writeTypeSafeStatus(w, tenant, role, status)
}

func (a *App) writeTypeSafeStatus(w http.ResponseWriter, tenant, role, status string) {
	configured, enabled := a.cfg.TypeSafeAPIKey != "", a.cfg.typeSafeEnabled(tenant)
	can := configured && enabled && status == "active" && roleLevel(role) >= 2
	result := map[string]any{"provider": "typesafe", "model": a.cfg.typeSafeModel(), "configured": configured, "enabled": enabled, "canEvaluate": can,
		"questionTypes": []string{"noul", "choice", "score"}, "limits": map[string]int{"maxQuestions": typeSafeQuestionLimit, "maxRequestBytes": typeSafeRequestLimit, "maxEvaluationsPerDay": a.cfg.typeSafeDailyLimit()}}
	result["credentialMode"] = "operator"
	if a.cfg.UserCredentials {
		result["credentialMode"] = "workspace-sponsored"
	}
	switch {
	case !configured:
		result["reason"] = "TypeSafe is not configured"
	case !enabled:
		result["reason"] = "TypeSafe is not enabled for this workspace"
	case status != "active":
		result["reason"] = "Workspace is suspended"
	case roleLevel(role) < 2:
		result["reason"] = "Workspace member permission is required"
	}
	writeJSON(w, 200, result)
}

func (a *App) typeSafeEvaluate(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenantId")
	if !a.cfg.typeSafeEnabled(tenant) {
		fail(w, 403, "typesafe_disabled", "TypeSafe is not enabled for this workspace")
		return
	}
	if a.cfg.TypeSafeAPIKey == "" {
		fail(w, 503, "typesafe_unconfigured", "TypeSafe is not configured")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, 415, "unsupported_media_type", "Use application/json")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, typeSafeRequestLimit))
	if err != nil {
		var size *http.MaxBytesError
		if errors.As(err, &size) {
			fail(w, 413, "body_too_large", "Request body is too large")
		} else {
			fail(w, 400, "invalid_json", "Invalid JSON request")
		}
		return
	}
	input, err := parseTypeSafeRequest(raw)
	if err != nil {
		fail(w, 400, "typesafe_invalid_request", "Use state and 1–16 valid typed questions")
		return
	}
	release, ok := a.typesafe.reserve(tenant, time.Now())
	if !ok {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "typesafe_rate_limited", "TypeSafe evaluation capacity or request limit reached")
		return
	}
	defer release()
	timeout := a.cfg.TypeSafeTimeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	id := randomID()
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		cancel()
		fail(w, 503, "worker_unavailable", "API worker is shutting down")
		return
	}
	a.running["typesafe:"+id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	defer func() { cancel(); a.mu.Lock(); delete(a.running, "typesafe:"+id); a.mu.Unlock(); a.tasks.Done() }()
	audit := typeSafeAuditRecord{ID: id, Actor: currentUser(r).ID, Tenant: tenant, Model: a.cfg.typeSafeModel(), Status: "started"}
	if cookie, err := r.Cookie("awwo_session"); err == nil {
		audit.SessionHash = tokenHash(cookie.Value)
	}
	if err = a.typesafe.audit(ctx, audit); err != nil {
		var access *typeSafeAccessError
		if errors.As(err, &access) {
			fail(w, access.status, access.code, "TypeSafe evaluation permission is unavailable")
			return
		}
		a.dbError(w, err)
		return
	}
	// The sidecar also delegates to the live API here, after body parsing and
	// transaction lock waits. Keep network authorization outside the transaction.
	if err = a.typesafe.authorize(ctx, audit); err != nil {
		audit.Status = "typesafe_access_revoked"
		auditCtx, done := context.WithTimeout(context.Background(), 2*time.Second)
		auditErr := a.typesafe.audit(auditCtx, audit)
		done()
		if auditErr != nil {
			fail(w, 500, "typesafe_audit_failed", "Evaluation outcome could not be recorded; do not automatically retry")
		} else {
			fail(w, 403, "typesafe_access_revoked", "TypeSafe evaluation permission is unavailable")
		}
		return
	}
	// Do not keep a database transaction open across a provider request. Recheck
	// long waits and revoke them if the login, membership or workspace changes.
	var revoked atomic.Bool
	stopWatch, watchDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watchDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopWatch:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				check, done := context.WithTimeout(ctx, time.Second)
				err := a.typesafe.authorize(check, audit)
				done()
				if err != nil && ctx.Err() == nil {
					revoked.Store(true)
					cancel()
					return
				}
			}
		}
	}()
	result, code, status := a.typesafe.evaluate(ctx, a.cfg, input)
	close(stopWatch)
	<-watchDone
	audit.Status = code
	if status == 200 {
		audit.Status, audit.Model, audit.Usage = "completed", result.Model, &result.Usage
	}
	if revoked.Load() || (status == 200 && a.typesafe.authorize(ctx, audit) != nil) {
		code, status, audit.Status = "typesafe_access_revoked", 403, "typesafe_access_revoked"
	}
	// A disconnected caller must not prevent recording the attempt's outcome.
	auditCtx, auditCancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = a.typesafe.audit(auditCtx, audit)
	auditCancel()
	if err != nil {
		fail(w, 500, "typesafe_audit_failed", "Evaluation outcome could not be recorded; do not automatically retry")
		return
	}
	// Persisting an outcome can itself wait on a database lock. Revalidate after
	// that wait as well, immediately before disclosing a successful answer.
	if status == 200 && a.typesafe.authorize(ctx, audit) != nil {
		audit.Status = "typesafe_access_revoked"
		auditCtx, done := context.WithTimeout(context.Background(), 2*time.Second)
		auditErr := a.typesafe.audit(auditCtx, audit)
		done()
		if auditErr != nil {
			fail(w, 500, "typesafe_audit_failed", "Evaluation outcome could not be recorded; do not automatically retry")
		} else {
			fail(w, 403, "typesafe_access_revoked", "TypeSafe evaluation permission is unavailable")
		}
		return
	}
	if status != 200 {
		fail(w, status, code, typeSafeErrorMessage(code))
		return
	}
	writeJSON(w, 200, result)
}

func (a *App) persistTypeSafeAudit(ctx context.Context, record typeSafeAuditRecord) error {
	metadata := map[string]any{"model": record.Model, "status": record.Status}
	if record.Usage != nil {
		metadata["usage"] = record.Usage
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	if record.Status == "started" {
		tx, err := a.db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(context.Background())
		// Follow the existing tenant-first mutation lock order. This check happens
		// after body parsing and lock waits, immediately before recording admission.
		var status, role string
		err = tx.QueryRow(ctx, "SELECT status FROM tenants WHERE id=$1 FOR UPDATE", record.Tenant).Scan(&status)
		if noRows(err) {
			return &typeSafeAccessError{403, "typesafe_access_revoked"}
		}
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT m.role FROM memberships m JOIN auth_sessions s ON s.user_id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND s.token_hash=$3 AND s.expires_at>clock_timestamp() FOR SHARE OF m,s`, record.Tenant, record.Actor, record.SessionHash).Scan(&role)
		if noRows(err) || (err == nil && (roleLevel(role) < 2 || status != "active")) {
			return &typeSafeAccessError{403, "typesafe_access_revoked"}
		}
		if err != nil {
			return err
		}
		// The tenant lock serializes this admission budget across attempts. Every
		// recorded attempt counts, including failures and cancelled requests; an
		// API restart cannot reset the daily limit. No model text is retained.
		var attempts int
		err = tx.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='typesafe.evaluation' AND created_at >= (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')", record.Tenant).Scan(&attempts)
		if err != nil {
			return err
		}
		if attempts >= a.cfg.typeSafeDailyLimit() {
			return &typeSafeAccessError{429, "typesafe_daily_limit"}
		}
		if _, err = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata) VALUES($1,$2,'typesafe.evaluation',$3,$4)", record.Actor, record.Tenant, record.ID, data); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	tag, err := a.db.Exec(ctx, "UPDATE audit_events SET metadata=$4 WHERE actor_id=$1 AND tenant_id=$2 AND action='typesafe.evaluation' AND resource_id=$3", record.Actor, record.Tenant, record.ID, data)
	if err == nil && tag.RowsAffected() != 1 {
		return errors.New("TypeSafe audit record unavailable")
	}
	return err
}

type typeSafeAccessError struct {
	status int
	code   string
}

func (e *typeSafeAccessError) Error() string { return e.code }
func (a *App) verifyTypeSafeAccess(ctx context.Context, record typeSafeAuditRecord) error {
	if !a.cfg.typeSafeEnabled(record.Tenant) {
		return &typeSafeAccessError{403, "typesafe_access_revoked"}
	}
	var issuer, subject string
	var grant []byte
	err := a.db.QueryRow(ctx, `SELECT COALESCE(s.sso_issuer,''),COALESCE(s.sso_subject,''),s.sso_grant FROM memberships m JOIN tenants t ON t.id=m.tenant_id JOIN auth_sessions s ON s.user_id=m.user_id WHERE t.id=$1 AND m.user_id=$2 AND s.token_hash=$3 AND s.expires_at>clock_timestamp() AND t.status='active' AND m.role IN ('member','admin','owner')`, record.Tenant, record.Actor, record.SessionHash).Scan(&issuer, &subject, &grant)
	if noRows(err) {
		return &typeSafeAccessError{403, "typesafe_access_revoked"}
	}
	if err != nil {
		return err
	}
	valid, err := a.verifyClawHuntSessionNow(ctx, record.SessionHash, record.Actor, issuer, subject, grant)
	if err != nil {
		return err
	}
	if !valid {
		return &typeSafeAccessError{403, "typesafe_access_revoked"}
	}
	return nil
}

func typeSafeErrorMessage(code string) string {
	switch code {
	case "typesafe_timeout":
		return "TypeSafe evaluation timed out; the provider may have received the request"
	case "typesafe_cancelled":
		return "TypeSafe evaluation was cancelled"
	case "typesafe_access_revoked":
		return "TypeSafe evaluation permission was revoked"
	case "typesafe_provider_rate_limited":
		return "TypeSafe is temporarily rate limited"
	case "typesafe_provider_unconfigured":
		return "TypeSafe credentials are unavailable or invalid; contact the service administrator"
	case "typesafe_invalid_response":
		return "TypeSafe returned an invalid structured answer"
	default:
		return "TypeSafe evaluation is unavailable"
	}
}
func (s *typeSafeService) evaluate(ctx context.Context, cfg Config, input typeSafeRequest) (typeSafeResponse, string, int) {
	var result typeSafeResponse
	body, _ := json.Marshal(map[string]any{"state": input.State, "questions": input.Questions, "model": cfg.typeSafeModel()})
	req, _ := http.NewRequestWithContext(ctx, "POST", typeSafeEndpoint, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+cfg.TypeSafeAPIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// Do not inherit redirects, retries or model destinations from other runtimes.
	client := *s.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return result, typeSafeTransportError(ctx), typeSafeTransportStatus(ctx)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		switch resp.StatusCode {
		case 401, 403:
			return result, "typesafe_provider_unconfigured", 503
		case 429, 529:
			return result, "typesafe_provider_rate_limited", 503
		default:
			return result, "typesafe_provider_error", 502
		}
	}
	media, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return result, "typesafe_invalid_response", 502
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, typeSafeResponseLimit+1))
	if err != nil {
		return result, typeSafeTransportError(ctx), typeSafeTransportStatus(ctx)
	}
	if len(raw) > typeSafeResponseLimit {
		return result, "typesafe_invalid_response", 502
	}
	result, err = parseTypeSafeResponse(raw, cfg.typeSafeModel(), input.Questions)
	if err != nil {
		return typeSafeResponse{}, "typesafe_invalid_response", 502
	}
	return result, "", 200
}
func typeSafeTransportError(ctx context.Context) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "typesafe_timeout"
	}
	if ctx.Err() != nil {
		return "typesafe_cancelled"
	}
	return "typesafe_provider_error"
}
func typeSafeTransportStatus(ctx context.Context) int {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return 504
	}
	if ctx.Err() != nil {
		return 408
	}
	return 502
}

// Decode once with bounded nesting and duplicate-key rejection. Go's default
// decoder otherwise silently keeps the last duplicate key, obscuring contracts.
func typeSafeJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > 32 {
			return nil, errors.New("JSON depth exceeded")
		}
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if delim, ok := token.(json.Delim); ok {
			switch delim {
			case '{':
				value := map[string]any{}
				for decoder.More() {
					key, err := decoder.Token()
					if err != nil {
						return nil, err
					}
					name, ok := key.(string)
					if !ok {
						return nil, errors.New("invalid JSON key")
					}
					if _, exists := value[name]; exists {
						return nil, errors.New("duplicate JSON key")
					}
					item, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					value[name] = item
				}
				_, err = decoder.Token()
				return value, err
			case '[':
				value := []any{}
				for decoder.More() {
					item, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					value = append(value, item)
				}
				_, err = decoder.Token()
				return value, err
			default:
				return nil, errors.New("invalid JSON delimiter")
			}
		}
		if number, ok := token.(json.Number); ok {
			n, err := number.Float64()
			if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
				return nil, errors.New("invalid JSON number")
			}
		}
		return token, nil
	}
	value, err := read(0)
	if err != nil {
		return nil, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON data")
	}
	return value, nil
}
func typeSafeDescription(value any) bool {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v) != ""
	case map[string]any:
		return len(v) > 0
	case []any:
		return len(v) > 0
	default:
		return false
	}
}
func typeSafeFields(value map[string]any, allowed ...string) bool {
	for name := range value {
		found := false
		for _, candidate := range allowed {
			if name == candidate {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func parseTypeSafeRequest(raw []byte) (typeSafeRequest, error) {
	var result typeSafeRequest
	invalid := errors.New("invalid TypeSafe request")
	if len(raw) > typeSafeRequestLimit {
		return result, invalid
	}
	value, err := typeSafeJSON(raw)
	if err != nil {
		return result, invalid
	}
	object, ok := value.(map[string]any)
	if !ok || !typeSafeFields(object, "state", "questions") || !typeSafeDescription(object["state"]) {
		return result, invalid
	}
	questions, ok := object["questions"].(map[string]any)
	if !ok || len(questions) == 0 || len(questions) > typeSafeQuestionLimit {
		return result, invalid
	}
	result.State, result.Questions = object["state"], map[string]typeSafeQuestion{}
	for id, rawQuestion := range questions {
		if strings.TrimSpace(id) == "" || len(id) > 128 {
			return result, invalid
		}
		question, ok := rawQuestion.(map[string]any)
		if !ok || !typeSafeFields(question, "type", "instructions", "criteria") || !typeSafeDescription(question["instructions"]) {
			return result, invalid
		}
		kind, _ := question["type"].(string)
		criteria, hasCriteria := question["criteria"]
		switch kind {
		case "noul":
			if hasCriteria {
				options, ok := criteria.(map[string]any)
				if !ok || len(options) == 0 || !typeSafeFields(options, "true", "false") {
					return result, invalid
				}
				for _, value := range options {
					if !typeSafeDescription(value) {
						return result, invalid
					}
				}
			}
		case "choice":
			options, ok := criteria.(map[string]any)
			if !ok || len(options) == 0 || len(options) > 255 {
				return result, invalid
			}
			for key, value := range options {
				if strings.TrimSpace(key) == "" || len(key) > 128 || (value != nil && !typeSafeDescription(value)) {
					return result, invalid
				}
			}
		case "score":
			levels, ok := criteria.([]any)
			if !ok || len(levels) < 2 || len(levels) > 10 {
				return result, invalid
			}
			for _, value := range levels {
				if !typeSafeDescription(value) {
					return result, invalid
				}
			}
		default:
			return result, invalid
		}
		result.Questions[id] = typeSafeQuestion{Type: kind, Instructions: question["instructions"], Criteria: criteria}
	}
	return result, nil
}

func typeSafeNumber(value any, min, max float64) (float64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	n, err := number.Float64()
	return n, err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= min && n <= max
}
func parseTypeSafeResponse(raw []byte, requestedModel string, questions map[string]typeSafeQuestion) (typeSafeResponse, error) {
	var result typeSafeResponse
	invalid := errors.New("invalid TypeSafe response")
	value, err := typeSafeJSON(raw)
	if err != nil {
		return result, invalid
	}
	object, ok := value.(map[string]any)
	if !ok {
		return result, invalid
	}
	model, ok := object["model"].(string)
	if !ok || !typeSafeModelName.MatchString(model) || strings.HasSuffix(model, "latest") || strings.HasSuffix(model, "preview") || (requestedModel != "jev-latest" && requestedModel != "jev-preview" && model != requestedModel) {
		return result, invalid
	}
	usage, ok := object["usage"].(map[string]any)
	if !ok {
		return result, invalid
	}
	readUsage := func(name string) (*int64, bool) {
		if usage[name] == nil {
			return nil, true
		}
		n, ok := typeSafeNumber(usage[name], 0, 9007199254740991)
		if !ok || math.Trunc(n) != n {
			return nil, false
		}
		value := int64(n)
		return &value, true
	}
	input, ok := readUsage("input_tokens")
	if !ok {
		return result, invalid
	}
	output, ok := readUsage("output_tokens")
	if !ok {
		return result, invalid
	}
	answers, ok := object["answers"].(map[string]any)
	if !ok || len(answers) != len(questions) {
		return result, invalid
	}
	result = typeSafeResponse{Model: model, Usage: typeSafeUsage{InputTokens: input, OutputTokens: output}, Answers: map[string]map[string]any{}}
	for id, question := range questions {
		answer, ok := answers[id].(map[string]any)
		if !ok || answer["type"] != question.Type {
			return typeSafeResponse{}, invalid
		}
		clean := map[string]any{"type": question.Type}
		if question.Type == "noul" {
			n, ok := typeSafeNumber(answer["noul"], 0, 1)
			if !ok {
				return typeSafeResponse{}, invalid
			}
			clean["noul"] = n
		} else {
			confidence, ok := typeSafeNumber(answer["confidence"], 0, 1)
			if !ok {
				return typeSafeResponse{}, invalid
			}
			clean["confidence"] = confidence
			keys := map[string]bool{}
			if question.Type == "choice" {
				for key := range question.Criteria.(map[string]any) {
					keys[key] = true
				}
			} else {
				for i := range question.Criteria.([]any) {
					keys[strconv.Itoa(i)] = true
				}
			}
			probabilities, ok := answer["probabilities"].(map[string]any)
			if !ok || len(probabilities) != len(keys) {
				return typeSafeResponse{}, invalid
			}
			cleanProbabilities := map[string]float64{}
			sum := 0.0
			for key := range keys {
				n, ok := typeSafeNumber(probabilities[key], 0, 1)
				if !ok {
					return typeSafeResponse{}, invalid
				}
				cleanProbabilities[key] = n
				sum += n
			}
			if math.Abs(sum-1) > 0.05 {
				return typeSafeResponse{}, invalid
			}
			clean["probabilities"] = cleanProbabilities
			if question.Type == "choice" {
				choice, ok := answer["choice"].(string)
				if !ok || !keys[choice] {
					return typeSafeResponse{}, invalid
				}
				for _, n := range cleanProbabilities {
					if n > cleanProbabilities[choice]+0.01 {
						return typeSafeResponse{}, invalid
					}
				}
				clean["choice"] = choice
			} else {
				score, ok := typeSafeNumber(answer["score"], 0, float64(len(keys)-1))
				if !ok {
					return typeSafeResponse{}, invalid
				}
				legend, ok := answer["legend"].(map[string]any)
				if !ok || len(legend) != len(keys) {
					return typeSafeResponse{}, invalid
				}
				for key := range keys {
					if !typeSafeDescription(legend[key]) {
						return typeSafeResponse{}, invalid
					}
				}
				clean["score"], clean["legend"] = score, legend
			}
		}
		result.Answers[id] = clean
	}
	return result, nil
}
