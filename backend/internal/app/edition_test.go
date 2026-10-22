package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"awwo/backend/internal/webread"
)

// The local edition's settings as the local runtime gives them (scripts/awwo-local-lib.mjs serviceEnvironments).
func setLocalEditionEnv(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", "development")
	t.Setenv("AWWO_DATABASE_URL", testConfig().DatabaseURL)
	t.Setenv("AWWO_CREDENTIAL_MODE", "user")
	t.Setenv("AWWO_CREDENTIAL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("AWWO_EDITION", "local")
	t.Setenv("AWWO_REGISTRATION", "closed")
	t.Setenv("AWWO_LOCAL_STATE_DIR", filepath.Join(t.TempDir(), "state"))
}

func TestLocalEditionLoadsFromEnv(t *testing.T) {
	setLocalEditionEnv(t)
	c, err := ConfigFromEnv()
	if err != nil || c.Edition != editionLocal || !c.RegistrationClosed || c.LocalStateDir == "" || c.editionName() != "local" {
		t.Fatal("the local edition's settings must load", err, c.Edition, c.RegistrationClosed, c.LocalStateDir)
	}
	for name, change := range map[string][2]string{
		"another edition":           {"AWWO_EDITION", "desktop"},
		"another registration word": {"AWWO_REGISTRATION", "off"},
		"a reset that is not an id": {"AWWO_BOOTSTRAP_ADMIN_RESET", "true"},
		"a reset id with a space":   {"AWWO_BOOTSTRAP_ADMIN_RESET", "abcdefgh ijklmnop"},
		"a relative data folder":    {"AWWO_LOCAL_STATE_DIR", "state"},
		"a window it does not know": {"AWWO_LOCAL_SHELL", "mac"},
	} {
		t.Run(name, func(t *testing.T) {
			setLocalEditionEnv(t)
			t.Setenv(change[0], change[1])
			if _, err := ConfigFromEnv(); err == nil {
				t.Fatal("accepted", change[0], "=", change[1])
			}
		})
	}
	setLocalEditionEnv(t)
	t.Setenv("AWWO_LOCAL_SHELL", "windows")
	if c, err := ConfigFromEnv(); err != nil || c.LocalShell != "windows" {
		t.Fatal("the Windows window's start must load", err, c.LocalShell)
	}
}

// The edition's own refusals, each on a configuration that passes every other check, so it is this rule that refuses.
func TestLocalEditionRefusesWhatItCannotBe(t *testing.T) {
	local := func() Config {
		c := testConfig()
		c.Edition, c.UserCredentials, c.LocalStateDir = editionLocal, true, filepath.Join(t.TempDir(), "state")
		c.AdminEmail, c.AdminPassword = "owner@awwo.local", "a long enough password"
		return c
	}
	if err := local().validateEdition(); err != nil {
		t.Fatal("the local edition's own settings must pass", err)
	}
	for name, change := range map[string]func(*Config){
		"operator keys":          func(c *Config) { c.UserCredentials = false },
		"ClawHunt sign-in":       func(c *Config) { c.ClawHuntURL = "https://clawhunt.example" },
		"a relative data folder": func(c *Config) { c.LocalStateDir = "state" },
		// Checkout already refuses personal keys (validateBilling); the edition refuses it as well, on its own.
		"checkout": func(c *Config) { c.BillingCheckoutEnabled = true },
		"a reset with no administrator": func(c *Config) {
			c.AdminPasswordReset, c.AdminEmail, c.AdminPassword = "reset-0123456789abcdef", "", ""
		},
	} {
		t.Run(name, func(t *testing.T) {
			c := local()
			change(&c)
			if c.validateEdition() == nil {
				t.Fatal("accepted")
			}
		})
	}
	hosted := testConfig()
	hosted.AdminPasswordReset = "reset-0123456789abcdef"
	if hosted.validateEdition() == nil {
		t.Fatal("a password reset at start is the local edition's alone")
	}
	windowed := testConfig()
	windowed.LocalShell = "windows"
	if windowed.validateEdition() == nil {
		t.Fatal("a window of the local edition's is the local edition's alone")
	}
	reset := local()
	reset.AdminPasswordReset = "reset-0123456789abcdef"
	if reset.validateEdition() != nil {
		t.Fatal("the local edition may reset its administrator's password")
	}
}

func TestPostgresLocalEditionResetsItsAdministratorsPassword(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	old := bootstrapTestAdmin(t, h)
	h.request(t, old, http.MethodGet, "/auth/me", nil, 200)
	login := func(password string, status int) {
		t.Helper()
		h.request(t, nil, http.MethodPost, "/auth/login", map[string]string{"email": h.a.cfg.AdminEmail, "password": password}, status)
	}
	h.a.cfg.Edition, h.a.cfg.AdminPasswordReset, h.a.cfg.AdminPassword = editionLocal, "reset-first-0123456789", "A brand new password 456!"
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	// The old session and the old password no longer open the account; the new password does.
	h.request(t, old, http.MethodGet, "/auth/me", nil, 401)
	login("Strong password 123!", 401)
	login("A brand new password 456!", 200)
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE action='admin.password_reset' AND resource_id='reset-first-0123456789'"); n != 1 {
		t.Fatal("the reset is recorded once, by its id", n)
	}
	// The person then changes their password. A start that still carries the same reset (the runtime could not mark it
	// done) does not undo that.
	if _, e := h.db.Exec(context.Background(), "UPDATE users SET password_hash=$2 WHERE email=$1", h.a.cfg.AdminEmail, hashPassword("Chosen by the person 000!")); e != nil {
		t.Fatal(e)
	}
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	login("Chosen by the person 000!", 200)
	login("A brand new password 456!", 401)
	// Without the setting a start leaves the password alone; a new reset applies again.
	h.a.cfg.AdminPasswordReset, h.a.cfg.AdminPassword = "", "Yet another password 789!"
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	login("Chosen by the person 000!", 200)
	h.a.cfg.AdminPasswordReset = "reset-second-0123456789"
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	login("Yet another password 789!", 200)
	if n := h.rows(t, "SELECT count(*) FROM audit_events WHERE action='admin.password_reset'"); n != 2 {
		t.Fatal("two resets, each once", n)
	}
}

func TestPostgresAResetAskedBeforeTheAccountExistedIsNotAppliedAgain(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.Edition, h.a.cfg.AdminEmail, h.a.cfg.AdminPassword = editionLocal, "owner@awwo.local", "Made with the reset 111!"
	h.a.cfg.AdminPasswordReset = "reset-at-creation-0123456789"
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	login := func(password string, status int) {
		t.Helper()
		h.request(t, nil, http.MethodPost, "/auth/login", map[string]string{"email": h.a.cfg.AdminEmail, "password": password}, status)
	}
	login("Made with the reset 111!", 200)
	if _, e := h.db.Exec(context.Background(), "UPDATE users SET password_hash=$2 WHERE email=$1", h.a.cfg.AdminEmail, hashPassword("Chosen by the person 000!")); e != nil {
		t.Fatal(e)
	}
	// The runtime could not mark the reset done: a later start carries the same id, and the person's password stays.
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	login("Chosen by the person 000!", 200)
	login("Made with the reset 111!", 401)
}

func TestPostgresLocalPageIsForThePlatformAdministratorAlone(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.Edition, h.a.cfg.LocalStateDir = editionLocal, filepath.Join(t.TempDir(), "state")
	member, _, _ := h.register(t, "someone@example.test")
	h.request(t, member, http.MethodGet, "/local", nil, 403)
	h.request(t, nil, http.MethodGet, "/local", nil, 401)
	admin := bootstrapTestAdmin(t, h)
	if out := h.request(t, admin, http.MethodGet, "/local", nil, 200); out["dataFolder"] != h.a.cfg.LocalStateDir {
		t.Fatal("the administrator reads the local page", out)
	}
}

func TestHostedSiteNamesNoDataFolderAndStaysOpen(t *testing.T) {
	c := testConfig()
	if c.editionName() != "hosted" || c.RegistrationClosed {
		t.Fatal("unset is the hosted site, with registration open")
	}
	c.LocalStateDir = filepath.Join(t.TempDir(), "state")
	if c.validateEdition() == nil {
		t.Fatal("a data folder is the local edition's alone")
	}
	c.LocalStateDir = ""
	c.RegistrationClosed = true
	if c.validateEdition() != nil {
		t.Fatal("any deployment with local sign-in may close registration")
	}
	c.ClawHuntURL = "https://clawhunt.example"
	if c.validateEdition() == nil {
		t.Fatal("closed registration cannot stop ClawHunt first sign-ins, so it is refused beside them")
	}
}

func TestClosedRegistrationRefusesNewAccounts(t *testing.T) {
	a := &App{cfg: Config{editionSettings: editionSettings{RegistrationClosed: true}}}
	w := httptest.NewRecorder()
	a.register(w, httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"a@example.com","password":"long enough password","name":"A","tenantName":"W"}`)))
	if w.Code != 403 || !strings.Contains(w.Body.String(), "registration_closed") {
		t.Fatal("registration must be refused while closed", w.Code, w.Body.String())
	}
}

func TestLocalComputerAnswersInTheLocalEditionOnly(t *testing.T) {
	read := func(c Config) (int, map[string]any) {
		w := httptest.NewRecorder()
		(&App{cfg: c}).localComputer(w, httptest.NewRequest(http.MethodGet, "/api/v1/local", nil))
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if code, _ := read(testConfig()); code != 404 {
		t.Fatal("the hosted site has no local page", code)
	}
	dir := filepath.Join(t.TempDir(), "state")
	c := testConfig()
	c.Edition, c.LocalStateDir, c.WebReaderEnabled, c.OpenMausURL = editionLocal, dir, true, "http://127.0.0.1:18109"
	c.WebReaderProxy, c.LocalShell = "http://127.0.0.1:7897", "windows"
	code, out := read(c)
	if code != 200 || out["dataFolder"] != dir || out["providersFile"] != filepath.Join(dir, "providers.env") ||
		out["managedExecution"] != true || out["render"] != false || out["webReader"] != true || out["media"] != false ||
		out["webReaderProxy"] != "http://127.0.0.1:7897" || out["shell"] != "windows" {
		t.Fatal("the local page tells where the data is, what runs and the window that started it", code, out)
	}
	for key := range out {
		if strings.Contains(strings.ToLower(key), "key") || strings.Contains(strings.ToLower(key), "token") {
			t.Fatal("no secret or key name reaches the page", key)
		}
	}
}

func TestWebReaderProxyIsALoopbackDevelopmentSetting(t *testing.T) {
	setLocalEditionEnv(t)
	t.Setenv("AWWO_WEB_READER_PROXY", "http://127.0.0.1:7897")
	c, err := ConfigFromEnv()
	if err != nil || c.webReaderProxy() == nil || c.webReaderProxy().Host != "127.0.0.1:7897" {
		t.Fatal("a proxy on this computer must load", err, c.WebReaderProxy)
	}
	if New(nil, c).registry.proxy == nil {
		t.Fatal("the skill registry must read through it too")
	}
	for _, value := range []string{"http://localhost:7897", "https://127.0.0.1:7897", "http://10.0.0.2:3128", "http://127.0.0.1", "http://user:pass@127.0.0.1:7897",
		"http://127.0.0.1:7897/path", "socks5://127.0.0.1:7897", "http://127.0.0.1:0", "http://127.0.0.1:07897", "http://127.0.0.1:65536"} {
		t.Run(value, func(t *testing.T) {
			setLocalEditionEnv(t)
			t.Setenv("AWWO_WEB_READER_PROXY", value)
			if _, err := ConfigFromEnv(); err == nil {
				t.Fatal("accepted", value)
			}
		})
	}
	c = testConfig()
	c.Env, c.WebReaderProxy = "production", "http://127.0.0.1:7897"
	if c.validateCapabilities() == nil {
		t.Fatal("a production deployment never reads through a proxy")
	}
	if testConfig().webReaderProxy() != nil {
		t.Fatal("unset reads directly")
	}
}

func TestSkillRegistrySaysWhenThisComputerCouldNotReachIt(t *testing.T) {
	code := func(err error) string {
		var se skillError
		if !errors.As(err, &se) {
			t.Fatalf("not a skill error: %v", err)
		}
		return se.code
	}
	// In the local edition a refusal of the web reader's own (here through a proxy on this computer) says so: trying
	// again later does not help. The hosted site keeps its answer.
	refused := &url.Error{Op: "Get", URL: "https://skills.sh/api/search", Err: &webread.Error{Code: "blocked_address", Message: "This computer resolves names to its proxy's stand-in addresses (fake-IP), so the site's address could not be checked"}}
	if got := code(registryTransportFailure(context.Background(), refused, true)); got != "skill_registry_network" {
		t.Fatal("got", got)
	}
	if got := code(registryTransportFailure(context.Background(), refused, false)); got != "skill_registry_upstream" {
		t.Fatal("the hosted site changed its answer:", got)
	}
	if got := code(registryTransportFailure(context.Background(), errors.New("connection reset by peer"), true)); got != "skill_registry_upstream" {
		t.Fatal("got", got)
	}
	// A proxy that did not answer in time is a timeout, as any other.
	slow := &url.Error{Op: "Get", URL: "https://skills.sh/api/search", Err: &webread.Error{Code: "timeout", Message: "The proxy on this computer did not answer in time"}}
	for _, local := range []bool{true, false} {
		if got := code(registryTransportFailure(context.Background(), slow, local)); got != "skill_registry_timeout" {
			t.Fatal("got", got)
		}
	}
	localConfig := testConfig()
	localConfig.Edition = editionLocal
	if !New(nil, localConfig).registry.local || New(nil, testConfig()).registry.local {
		t.Fatal("the registry knows the local edition, and only it")
	}
}

func TestAuthOptionsTellTheEditionAndWhetherAccountsCanBeMade(t *testing.T) {
	read := func(c Config) map[string]any {
		w := httptest.NewRecorder()
		(&App{cfg: c}).authOptions(w, httptest.NewRequest(http.MethodGet, "/api/v1/auth/options", nil))
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	hosted := read(Config{})
	if hosted["edition"] != "hosted" || hosted["registration"] != true || hosted["localAuth"] != true {
		t.Fatal("the hosted site with local sign-in takes new accounts", hosted)
	}
	local := read(Config{editionSettings: editionSettings{Edition: editionLocal, RegistrationClosed: true}})
	if local["edition"] != "local" || local["registration"] != false || local["localAuth"] != true {
		t.Fatal("the local edition signs its person in and takes no new accounts", local)
	}
	if _, named := hosted["shell"]; named {
		t.Fatal("the hosted site's answer names no window", hosted)
	}
	if _, named := local["shell"]; named {
		t.Fatal("a local edition started from a checkout names no window", local)
	}
	if windowed := read(Config{editionSettings: editionSettings{Edition: editionLocal, RegistrationClosed: true, LocalShell: "windows"}}); windowed["shell"] != "windows" {
		t.Fatal("the Windows window's local edition says so, for the sign-in page to name its menu", windowed)
	}
	if sso := read(Config{ClawHuntURL: "https://clawhunt.example"}); sso["registration"] != false {
		t.Fatal("with ClawHunt sign-in no local account is made here", sso)
	}
}
