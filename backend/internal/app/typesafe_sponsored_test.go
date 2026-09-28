package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestTypeSafeSponsoredConfigIsExplicitAndBounded(t *testing.T) {
	for _, key := range []string{"AWWO_TYPESAFE_SPONSORED_PLANNING", "AWWO_TYPESAFE_API_KEY", "AWWO_TYPESAFE_MODEL", "AWWO_TYPESAFE_ENABLED_TENANT_IDS", "AWWO_TYPESAFE_TIMEOUT", "AWWO_TYPESAFE_MAX_EVALUATIONS_PER_DAY"} {
		t.Setenv(key, "")
	}
	var c Config
	if err := c.typeSafeFromEnv(); err != nil || c.TypeSafeSponsoredPlanning || c.typeSafeEnabled("tenant-a") || c.typeSafeDailyLimit() != 20 {
		t.Fatal("unsafe default", err)
	}
	c.UserCredentials, c.TypeSafeAPIKey, c.TypeSafeEnabledTenantIDs = true, "synthetic-key", []string{"tenant-a"}
	if c.typeSafeEnabled("tenant-a") {
		t.Fatal("a key and allowlist bypassed personal mode")
	}
	c.TypeSafeSponsoredPlanning = true
	if !c.typeSafeEnabled("tenant-a") || c.typeSafeEnabled("tenant-a-extra") {
		t.Fatal("allowlist was not exact")
	}
	for key, value := range map[string]string{"AWWO_TYPESAFE_SPONSORED_PLANNING": "1", "AWWO_TYPESAFE_ENABLED_TENANT_IDS": "*", "AWWO_TYPESAFE_TIMEOUT": "26s", "AWWO_TYPESAFE_MAX_EVALUATIONS_PER_DAY": "0"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv(key, value)
			var candidate Config
			if candidate.typeSafeFromEnv() == nil {
				t.Fatal("invalid opt-in accepted")
			}
		})
	}
}

func TestPostgresTypeSafeSponsoredPlannerKeepsPersonalEnginesAndDailyBudget(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	owner, tenant, _ := h.register(t, "sponsored-jev-owner@example.test")
	other, otherTenant, _ := h.register(t, "sponsored-jev-other@example.test")
	h.a.cfg.UserCredentials = true
	h.a.cfg.TypeSafeAPIKey = "synthetic-sponsored-key"
	h.a.cfg.TypeSafeEnabledTenantIDs = []string{tenant}
	h.a.cfg.TypeSafeMaxEvaluationsPerDay = 1
	h.server.Close()
	h.server = httptest.NewServer(h.a.Handler())
	prefix := "/tenants/" + tenant + "/typesafe"
	var body any
	json.Unmarshal([]byte(typeSafeFixtureRequest), &body)
	for _, method := range []string{"GET", "POST"} {
		path := prefix
		if method == "POST" {
			path += "/evaluations"
		}
		denied := h.request(t, owner, method, path, body, 403)
		if denied["error"].(map[string]any)["code"] != "typesafe_personal_required" {
			t.Fatal("default guard changed")
		}
	}
	h.a.cfg.TypeSafeSponsoredPlanning = true
	h.server.Close()
	h.server = httptest.NewServer(h.a.Handler())
	var calls atomic.Int64
	transport := typeSafeRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != typeSafeEndpoint || r.Header.Get("Authorization") != "Bearer synthetic-sponsored-key" {
			t.Error("wrong provider authority")
		}
		calls.Add(1)
		return typeSafeHTTPResponse(200, typeSafeFixtureResponse), nil
	})
	h.a.typesafe.client.Transport = transport
	status := h.request(t, owner, "GET", prefix, nil, 200)
	if status["credentialMode"] != "workspace-sponsored" || status["canEvaluate"] != true || status["limits"].(map[string]any)["maxEvaluationsPerDay"] != float64(1) {
		t.Fatal("sponsorship status missing", status)
	}
	if h.request(t, owner, "GET", "/auth/me", nil, 200)["personalCredentialsRequired"] != true {
		t.Fatal("execution silently changed to operator mode")
	}
	if h.request(t, other, "GET", "/tenants/"+otherTenant+"/typesafe", nil, 200)["enabled"] != false {
		t.Fatal("other workspace enabled")
	}
	h.request(t, other, "POST", "/tenants/"+otherTenant+"/typesafe/evaluations", body, 403)
	h.request(t, other, "POST", prefix+"/evaluations", body, 404)
	h.request(t, owner, "POST", prefix+"/evaluations", body, 200)
	// Reset in-memory limits as an API restart would. The admitted attempt's
	// persistent audit must still enforce the daily budget before inference.
	h.a.typesafe = newTypeSafeService(h.a.persistTypeSafeAudit)
	h.a.typesafe.authorize = h.a.verifyTypeSafeAccess
	h.a.typesafe.client.Transport = transport
	denied := h.request(t, owner, "POST", prefix+"/evaluations", body, 429)
	if denied["error"].(map[string]any)["code"] != "typesafe_daily_limit" || calls.Load() != 1 {
		t.Fatal("daily budget reached provider", denied, calls.Load())
	}
}

func TestPostgresTypeSafeSponsoredPlannerClawHuntRevocation(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	f := newIdentityFixture(t, h, "sponsored-sso@example.com", "sponsored-subject")
	h.a.cfg.UserCredentials = true
	h.a.cfg.TypeSafeSponsoredPlanning = true
	h.a.cfg.TypeSafeAPIKey = "synthetic-sponsored-key"
	h.a.cfg.TypeSafeTimeout = 5 * time.Second
	h.server.Close()
	h.server = httptest.NewServer(h.a.Handler())
	cookie := responseCookie(t, completeIdentity(t, h, f, ""), "awwo_session")
	me := h.request(t, cookie, "GET", "/auth/me", nil, 200)
	tenant := me["tenants"].([]any)[0].(map[string]any)["id"].(string)
	h.a.cfg.TypeSafeEnabledTenantIDs = []string{tenant}
	started := make(chan struct{})
	h.a.typesafe.client.Transport = typeSafeRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	r := httptest.NewRequest("POST", "/api/v1/tenants/"+tenant+"/typesafe/evaluations", strings.NewReader(typeSafeFixtureRequest))
	r.AddCookie(cookie)
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	r.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.a.Handler().ServeHTTP(response, r); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("provider did not start")
	}
	f.active.Store(false)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("revoked identity did not cancel provider")
	}
	if response.Code != 403 || !strings.Contains(response.Body.String(), "typesafe_access_revoked") {
		t.Fatal(response.Code, response.Body.String())
	}
	var metadata string
	if err := h.db.QueryRow(context.Background(), "SELECT metadata::text FROM audit_events WHERE tenant_id=$1 AND action='typesafe.evaluation'", tenant).Scan(&metadata); err != nil || !strings.Contains(metadata, "typesafe_access_revoked") {
		t.Fatal("revoked attempt missing audit", err)
	}
}
