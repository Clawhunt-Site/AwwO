package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPreferenceValidation(t *testing.T) {
	ok := userPreferences{Personalization: preferencePersonal{Enabled: true, AboutMe: " 产品经理\r\n做 SaaS ", Instructions: "用中文\t回答"}, DefaultModel: &preferenceModel{Runtime: " pi ", Model: "opus"}}
	if !validPreferences(&ok) || ok.Personalization.AboutMe != "产品经理\n做 SaaS" || ok.DefaultModel.Runtime != "pi" {
		t.Fatal("valid settings were rejected or not normalized", ok)
	}
	for name, bad := range map[string]userPreferences{
		"about too long":      {Personalization: preferencePersonal{AboutMe: strings.Repeat("长", maxAboutMeRunes+1)}},
		"instructions length": {Personalization: preferencePersonal{Instructions: strings.Repeat("x", maxInstructionsRunes+1)}},
		"control character":   {Personalization: preferencePersonal{Instructions: "a\x00b"}},
		"direction override":  {Personalization: preferencePersonal{AboutMe: "a\u202eb"}},
		"isolate":             {Personalization: preferencePersonal{AboutMe: "a\u2067b"}},
		"zero-width space":    {Personalization: preferencePersonal{AboutMe: "a\u200bb"}},
		"tag character":       {Personalization: preferencePersonal{Instructions: "a\U000E0041b"}},
		"byte order mark":     {Personalization: preferencePersonal{Instructions: "\ufeffa"}},
		"line separator":      {Personalization: preferencePersonal{Instructions: "a\u2028b"}},
		"empty model":         {DefaultModel: &preferenceModel{Runtime: "pi"}},
		"model newline":       {DefaultModel: &preferenceModel{Runtime: "pi", Model: "a\nb"}},
		"model length":        {DefaultModel: &preferenceModel{Runtime: "pi", Model: strings.Repeat("m", 257)}},
	} {
		if validPreferences(&bad) {
			t.Error(name, "accepted")
		}
	}
	if !validPreferences(&userPreferences{Personalization: preferencePersonal{AboutMe: strings.Repeat("长", maxAboutMeRunes)}}) {
		t.Fatal("the limit itself was rejected")
	}
	if !validPreferences(&userPreferences{Personalization: preferencePersonal{AboutMe: "family 👨\u200d👩\u200d👧 ok"}}) {
		t.Fatal("an emoji joined with ZWJ was rejected")
	}
}

func TestAccountExportLimits(t *testing.T) {
	var e accountExports
	now := time.Date(2026, 10, 18, 8, 0, 0, 0, time.UTC)
	first, ok := e.begin("a", now)
	if !ok {
		t.Fatal("first export refused")
	}
	if _, ok := e.begin("a", now); ok {
		t.Fatal("a second export of the same account ran at once")
	}
	first()
	for i := 1; i < exportsPerHour; i++ {
		release, ok := e.begin("a", now.Add(time.Duration(i)*time.Minute))
		if !ok {
			t.Fatal("export", i, "refused")
		}
		release()
	}
	if _, ok := e.begin("a", now.Add(10*time.Minute)); ok {
		t.Fatal("more than the hourly number ran")
	}
	if release, ok := e.begin("a", now.Add(61*time.Minute)); !ok {
		t.Fatal("the hour did not roll over")
	} else {
		release()
	}
	var held []func()
	for _, uid := range []string{"b", "c", "d", "e"} {
		release, ok := e.begin(uid, now)
		if !ok {
			t.Fatal("account", uid, "refused under the service limit")
		}
		held = append(held, release)
	}
	if _, ok := e.begin("f", now); ok {
		t.Fatal("more exports than the service allows at once")
	}
	held[0]()
	if release, ok := e.begin("f", now); !ok {
		t.Fatal("a released slot was not reused")
	} else {
		release()
	}
}

func TestPostgresPreferences(t *testing.T) {
	h := newHarness(t, "")
	owner, _, _ := h.register(t, "prefs-owner@example.test")
	other, _, _ := h.register(t, "prefs-other@example.test")
	empty := h.request(t, owner, "GET", "/auth/preferences", nil, 200)
	if empty["version"] != float64(0) || empty["preferences"].(map[string]any)["defaultModel"] != nil {
		t.Fatal("a new account has stored settings", empty)
	}
	body := map[string]any{"version": 0, "preferences": map[string]any{
		"notifications":   map[string]any{"browser": true, "sound": false},
		"personalization": map[string]any{"enabled": true, "aboutMe": "Designer", "instructions": "Short answers"},
		"defaultModel":    map[string]any{"runtime": "pi", "model": "test-model"},
	}}
	saved := h.request(t, owner, "PUT", "/auth/preferences", body, 200)
	if saved["version"] != float64(1) {
		t.Fatal(saved)
	}
	// The same version twice is a lost race, never a silent overwrite.
	requireCode(t, h.request(t, owner, "PUT", "/auth/preferences", body, 409), "preferences_version_conflict")
	body["version"] = 1
	body["preferences"].(map[string]any)["notifications"] = map[string]any{"browser": false, "sound": true}
	if h.request(t, owner, "PUT", "/auth/preferences", body, 200)["version"] != float64(2) {
		t.Fatal("update did not advance the version")
	}
	read := h.request(t, owner, "GET", "/auth/preferences", nil, 200)
	prefs := read["preferences"].(map[string]any)
	if read["version"] != float64(2) || prefs["notifications"].(map[string]any)["sound"] != true || prefs["personalization"].(map[string]any)["aboutMe"] != "Designer" || prefs["defaultModel"].(map[string]any)["model"] != "test-model" {
		t.Fatal("settings were not kept", read)
	}
	if h.request(t, other, "GET", "/auth/preferences", nil, 200)["version"] != float64(0) {
		t.Fatal("cross-account settings leak")
	}
	h.request(t, nil, "GET", "/auth/preferences", nil, 401)
	for _, invalid := range []string{
		`{"preferences":{}}`,
		`{"version":2}`,
		`{"version":-1,"preferences":{}}`,
		`{"version":2,"preferences":{"unknown":true}}`,
		`{"version":2,"preferences":{"personalization":{"aboutMe":"a\u202eb"}}}`,
	} {
		r, _ := http.NewRequest("PUT", h.server.URL+"/api/v1/auth/preferences", strings.NewReader(invalid))
		r.Header.Set("Origin", h.cfg.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(owner)
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatal(invalid, resp.StatusCode)
		}
	}
	if h.request(t, owner, "GET", "/auth/preferences", nil, 200)["version"] != float64(2) {
		t.Fatal("a rejected write changed the settings")
	}
}

func TestPostgresAccountDeletionRequest(t *testing.T) {
	h := newHarness(t, "")
	owner, _, uid := h.register(t, "delete-me@example.test")
	other, _, _ := h.register(t, "keep-me@example.test")
	if h.request(t, owner, "GET", "/auth/deletion-request", nil, 200)["request"] != nil {
		t.Fatal("a new account has a deletion request")
	}
	requireCode(t, h.request(t, owner, "DELETE", "/auth/deletion-request", nil, 404), "not_found")
	created := h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": "  No longer needed  "}, 201)["request"].(map[string]any)
	if created["status"] != "pending" || created["reason"] != "No longer needed" {
		t.Fatal(created)
	}
	// Asking again answers with the pending request instead of making a second one.
	again := h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": "again"}, 200)["request"].(map[string]any)
	if again["id"] != created["id"] || again["reason"] != "No longer needed" {
		t.Fatal("a second pending request was made", again)
	}
	if h.request(t, other, "GET", "/auth/deletion-request", nil, 200)["request"] != nil {
		t.Fatal("another account sees the request")
	}
	requireCode(t, h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": strings.Repeat("x", maxDeletionReason+1)}, 400), "invalid_input")
	// Nothing is deleted: the account still signs in and reads its workspace.
	h.request(t, owner, "GET", "/auth/me", nil, 200)
	var audits int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM audit_events WHERE actor_id=$1 AND action='account.deletion_requested'", uid).Scan(&audits); e != nil || audits != 1 {
		t.Fatal("request not audited once", audits, e)
	}
	withdrawn := h.request(t, owner, "DELETE", "/auth/deletion-request", nil, 200)["request"].(map[string]any)
	if withdrawn["status"] != "withdrawn" || withdrawn["withdrawnAt"] == nil {
		t.Fatal(withdrawn)
	}
	renewed := h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": ""}, 201)["request"].(map[string]any)
	if renewed["id"] == created["id"] {
		t.Fatal("a withdrawn request was reused")
	}
	// Asking and withdrawing in a loop stops after a few a day; a pending one is still answered.
	// created is the first withdrawn one today; renewed is pending.
	for i := 1; i < maxDeletionDaily-1; i++ {
		h.request(t, owner, "DELETE", "/auth/deletion-request", nil, 200)
		h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": ""}, 201)
	}
	h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": ""}, 200)
	h.request(t, owner, "DELETE", "/auth/deletion-request", nil, 200)
	requireCode(t, h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": ""}, 429), "rate_limited")
	if _, e := h.db.Exec(t.Context(), "UPDATE account_deletion_requests SET created_at=created_at - interval '2 days' WHERE user_id=$1 AND id NOT IN ($2,$3)", uid, created["id"], renewed["id"]); e != nil {
		t.Fatal(e)
	}
	h.request(t, owner, "POST", "/auth/deletion-request", map[string]string{"reason": "after a day"}, 201)
	// Back to the two requests the admin list below expects: created (withdrawn) and renewed (pending).
	if _, e := h.db.Exec(t.Context(), "DELETE FROM account_deletion_requests WHERE user_id=$1 AND id NOT IN ($2,$3)", uid, created["id"], renewed["id"]); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(t.Context(), "UPDATE account_deletion_requests SET status='pending', withdrawn_at=NULL WHERE id=$1", renewed["id"]); e != nil {
		t.Fatal(e)
	}
	// The operator sees both requests in the admin list, newest first.
	if _, e := h.db.Exec(t.Context(), "UPDATE users SET platform_role='admin' WHERE email='keep-me@example.test'"); e != nil {
		t.Fatal(e)
	}
	listed := h.request(t, other, "GET", "/admin/deletions", nil, 200)["items"].([]any)
	if len(listed) != 2 || listed[0].(map[string]any)["status"] != "pending" || listed[0].(map[string]any)["email"] != "delete-me@example.test" || listed[1].(map[string]any)["status"] != "withdrawn" {
		t.Fatal("admin list", listed)
	}
	requireCode(t, h.request(t, owner, "GET", "/admin/deletions", nil, 403), "forbidden")
	// Deleting an account keeps the record of its request, without the account. (An account with workspaces is
	// deleted by an operator together with its memberships; a bare one shows the foreign key on its own.)
	bare := randomID()
	if _, e := h.db.Exec(t.Context(), "INSERT INTO users(id,email,name,password_hash) VALUES($1,'bare@example.test','Bare','x')", bare); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(t.Context(), "INSERT INTO account_deletion_requests(id,user_id,email,name) VALUES($1,$2,'bare@example.test','Bare')", randomID(), bare); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(t.Context(), "DELETE FROM users WHERE id=$1", bare); e != nil {
		t.Fatal(e)
	}
	var kept int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM account_deletion_requests WHERE user_id IS NULL AND email='bare@example.test' AND status='pending'").Scan(&kept); e != nil || kept != 1 {
		t.Fatal("deleting the account dropped its request", kept, e)
	}
	// That request is no longer the account's pending one: a new account under the same id could ask again.
	if _, e := h.db.Exec(t.Context(), "INSERT INTO users(id,email,name,password_hash) VALUES($1,'bare2@example.test','Bare','x')", bare); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(t.Context(), "INSERT INTO account_deletion_requests(id,user_id,email,name) VALUES($1,$2,'bare2@example.test','Bare')", randomID(), bare); e != nil {
		t.Fatal("a cleared request still blocks a new one", e)
	}
}

func TestPostgresAccountExport(t *testing.T) {
	h := newHarness(t, "")
	owner, tid, uid := h.register(t, "export-owner@example.test")
	stranger, otherTenant, _ := h.register(t, "export-stranger@example.test")
	h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": "Mine", "document": map[string]any{"nodes": []any{}, "marker": "OWN-CANVAS"}}, 201)
	h.request(t, stranger, "POST", "/tenants/"+otherTenant+"/canvases", map[string]any{"name": "Theirs", "document": map[string]any{"nodes": []any{}, "marker": "FOREIGN-CANVAS"}}, 201)
	h.request(t, owner, "PUT", "/auth/preferences", map[string]any{"version": 0, "preferences": map[string]any{"personalization": map[string]any{"enabled": true, "aboutMe": "EXPORTED-ABOUT"}}}, 200)
	r, _ := http.NewRequest("GET", h.server.URL+"/api/v1/auth/export", nil)
	r.Header.Set("Origin", h.cfg.PublicOrigin)
	r.AddCookie(owner)
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Disposition"), "awwo-account-export.json") {
		t.Fatal(resp.StatusCode, resp.Header)
	}
	var out struct {
		Kind       string            `json:"kind"`
		Complete   bool              `json:"complete"`
		User       User              `json:"user"`
		Workspaces []json.RawMessage `json:"workspaces"`
		Canvases   []struct {
			Name     string         `json:"name"`
			TenantID string         `json:"tenantId"`
			Document map[string]any `json:"document"`
		} `json:"canvases"`
		Preferences userPreferences `json:"preferences"`
	}
	if e = json.Unmarshal(raw, &out); e != nil {
		t.Fatalf("export is not one JSON document: %v %s", e, raw)
	}
	if out.Kind != "awwo.account-export" || !out.Complete || out.User.ID != uid || len(out.Workspaces) != 1 || out.Preferences.Personalization.AboutMe != "EXPORTED-ABOUT" {
		t.Fatal("incomplete export", string(raw))
	}
	if len(out.Canvases) != 1 || out.Canvases[0].Name != "Mine" || out.Canvases[0].TenantID != tid || out.Canvases[0].Document["marker"] != "OWN-CANVAS" {
		t.Fatal("export canvases", out.Canvases)
	}
	if bytes.Contains(raw, []byte("FOREIGN-CANVAS")) || bytes.Contains(raw, []byte("password")) {
		t.Fatal("export holds another workspace's canvas or a credential field")
	}
	h.request(t, nil, "GET", "/auth/export", nil, 401)
	cross, _ := http.NewRequest("GET", h.server.URL+"/api/v1/auth/export", nil)
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	cross.AddCookie(owner)
	if resp, e := http.DefaultClient.Do(cross); e != nil || resp.StatusCode != 403 {
		t.Fatal("an export started from another site was not refused", e)
	} else {
		resp.Body.Close()
	}
}

func TestPostgresPlannerReadsPersonalization(t *testing.T) {
	seen := make(chan observedPiCall, 4)
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		seen <- call
		completePi(w, `{"version":1,"summary":"Keep the current canvas","operations":[]}`)
	})
	defer pi.Close()
	h := newHarness(t, pi.URL)
	owner, tid, _ := h.register(t, "planner-prefs@example.test")
	canvas, _ := graphFixture(t, h, owner, tid)
	path := "/tenants/" + tid + "/canvases/" + canvas + "/plan"
	plan := h.request(t, owner, "POST", path, map[string]any{"prompt": "Plan it", "context": "Current graph", "operationId": "plain-planner"}, 202)
	h.awaitRun(t, owner, tid, plan["id"].(string), "completed")
	if call := <-seen; strings.Contains(call.Prompt, "standing preferences") {
		t.Fatal("a plan without settings carries a personalization block")
	}
	settings := map[string]any{"version": 0, "preferences": map[string]any{"personalization": map[string]any{"enabled": true, "aboutMe": "ABOUT-MARKER", "instructions": "INSTRUCTIONS-MARKER"}}}
	h.request(t, owner, "PUT", "/auth/preferences", settings, 200)
	plan = h.request(t, owner, "POST", path, map[string]any{"prompt": "Plan it again", "context": "Current graph", "operationId": "personal-planner"}, 202)
	h.awaitRun(t, owner, tid, plan["id"].(string), "completed")
	call := <-seen
	about, request := strings.Index(call.Prompt, "ABOUT-MARKER"), strings.Index(call.Prompt, "User request:\nPlan it again")
	if about < 0 || request < about || !strings.Contains(call.Prompt, "INSTRUCTIONS-MARKER") || strings.Contains(call.SystemPrompt, "ABOUT-MARKER") {
		t.Fatal("planner prompt lacks the settings before the request", call.Prompt)
	}
	// A retry of that plan after the settings changed is still the same request, answered with the same run.
	settings["version"] = 1
	settings["preferences"].(map[string]any)["personalization"].(map[string]any)["instructions"] = "CHANGED-MARKER"
	h.request(t, owner, "PUT", "/auth/preferences", settings, 200)
	retry := h.request(t, owner, "POST", path, map[string]any{"prompt": "Plan it again", "context": "Current graph", "operationId": "personal-planner"}, 200)
	if retry["id"] != plan["id"] {
		t.Fatal("a retry made a second plan", retry, plan)
	}
	// Turned off, the settings stay saved but no longer reach the planner.
	settings["version"] = 2
	settings["preferences"].(map[string]any)["personalization"].(map[string]any)["enabled"] = false
	h.request(t, owner, "PUT", "/auth/preferences", settings, 200)
	plan = h.request(t, owner, "POST", path, map[string]any{"prompt": "Plan it a third time", "context": "Current graph", "operationId": "disabled-planner"}, 202)
	h.awaitRun(t, owner, tid, plan["id"].(string), "completed")
	if call := <-seen; strings.Contains(call.Prompt, "ABOUT-MARKER") {
		t.Fatal("disabled settings reached the planner")
	}
}
