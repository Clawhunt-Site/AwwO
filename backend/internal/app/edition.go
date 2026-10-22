package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

// The local edition (AwwO 本地版, scripts/awwo-local.mjs) is this API run on one person's computer with their own model
// keys and no plans: AWWO_EDITION=local. The API says so to the web (authOptions, meResponse), which then leaves out what
// only the hosted site has (plans and billing, upgrade prompts, ClawHunt invites, the operator's pages) and shows the
// computer's own settings. AWWO_REGISTRATION=closed refuses new accounts: the local edition's person is its bootstrap
// administrator. The hosted site sets neither and is unchanged.
type editionSettings struct {
	// Edition is "" for the hosted site or "local".
	Edition string
	// RegistrationClosed refuses POST /auth/register (AWWO_REGISTRATION=closed).
	RegistrationClosed bool
	// LocalStateDir is the local edition's data folder (AWWO_LOCAL_STATE_DIR), named in its settings; the local
	// edition alone takes it.
	LocalStateDir string
	// AdminPasswordReset names one reset of the bootstrap administrator's password (AWWO_BOOTSTRAP_ADMIN_RESET=<id>, the
	// local edition only): the first start that carries it sets AWWO_BOOTSTRAP_ADMIN_PASSWORD and ends the account's
	// sessions; a later one with the same id does nothing, so a reset the runtime could not mark done never undoes a
	// password changed since. Its person has no mail to recover a forgotten password by; the runtime's --reset-password
	// gives them a new one. "" for none.
	AdminPasswordReset string
	// LocalShell names the window that started the local edition (AWWO_LOCAL_SHELL, the local edition only): "windows"
	// for the Windows installer's (apps/windows-local), whose person has its menu and no checkout, so the web names the
	// menu where it would name an npm command. "" when started from a checkout.
	LocalShell string
}

// adminResetID is one reset's id: 16–64 letters, digits, - or _ (the runtime makes 24).
var adminResetID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

const editionLocal = "local"

func (c *Config) editionFromEnv() error {
	switch e := os.Getenv("AWWO_EDITION"); e {
	case "":
	case editionLocal:
		c.Edition = e
	default:
		return errors.New("AWWO_EDITION must be local or unset")
	}
	switch os.Getenv("AWWO_REGISTRATION") {
	case "", "open":
	case "closed":
		c.RegistrationClosed = true
	default:
		return errors.New("AWWO_REGISTRATION must be open or closed")
	}
	c.LocalStateDir = os.Getenv("AWWO_LOCAL_STATE_DIR")
	if reset := os.Getenv("AWWO_BOOTSTRAP_ADMIN_RESET"); reset != "" {
		if !adminResetID.MatchString(reset) {
			return errors.New("AWWO_BOOTSTRAP_ADMIN_RESET must be a reset id: 16 to 64 letters, digits, - or _")
		}
		c.AdminPasswordReset = reset
	}
	switch shell := os.Getenv("AWWO_LOCAL_SHELL"); shell {
	case "", "windows":
		c.LocalShell = shell
	default:
		return errors.New("AWWO_LOCAL_SHELL must be windows or unset")
	}
	return nil
}

// The local edition runs on its person's own keys, with no ClawHunt sign-in and nothing to buy; its data folder is
// a path the hosted site never names. Closed registration closes local sign-up, the one way besides a ClawHunt first
// sign-in (clawhunt_identity.go) that an account is made: with ClawHunt sign-in it would promise what it does not do.
func (c Config) validateEdition() error {
	if c.RegistrationClosed && c.ClawHuntURL != "" {
		return errors.New("AWWO_REGISTRATION=closed closes local sign-up; with ClawHunt sign-in, accounts come from ClawHunt: unset one of them")
	}
	if c.Edition != editionLocal {
		switch {
		case c.LocalStateDir != "":
			return errors.New("AWWO_LOCAL_STATE_DIR is the local edition's and needs AWWO_EDITION=local")
		case c.AdminPasswordReset != "":
			return errors.New("AWWO_BOOTSTRAP_ADMIN_RESET is the local edition's and needs AWWO_EDITION=local")
		case c.LocalShell != "":
			return errors.New("AWWO_LOCAL_SHELL is the local edition's and needs AWWO_EDITION=local")
		}
		return nil
	}
	switch {
	case c.AdminPasswordReset != "" && c.AdminEmail == "":
		return errors.New("AWWO_BOOTSTRAP_ADMIN_RESET needs the bootstrap administrator (AWWO_BOOTSTRAP_ADMIN_EMAIL and _PASSWORD)")
	case !c.UserCredentials:
		return errors.New("AWWO_EDITION=local runs on personal keys and needs AWWO_CREDENTIAL_MODE=user")
	case c.ClawHuntURL != "":
		return errors.New("AWWO_EDITION=local has no ClawHunt sign-in: unset AWWO_CLAWHUNT_URL")
	case c.BillingCheckoutEnabled:
		return errors.New("AWWO_EDITION=local sells no plans: unset AWWO_BILLING_CHECKOUT_ENABLED")
	case c.LocalStateDir != "" && !filepath.IsAbs(c.LocalStateDir):
		return errors.New("AWWO_LOCAL_STATE_DIR must be an absolute path")
	}
	return nil
}

// resetBootstrapPassword gives the bootstrap administrator the configured password and ends its sessions and any
// recovery link (AWWO_BOOTSTRAP_ADMIN_RESET), as a completed password reset does: once per reset id, which its audit
// row records, under the account's lock, so a reset already applied is not applied again.
func (a *App) resetBootstrapPassword(ctx context.Context, email string) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var id string
	if e = tx.QueryRow(ctx, "SELECT id FROM users WHERE email=$1 AND platform_role='admin' FOR UPDATE", email).Scan(&id); e != nil {
		return e
	}
	var done bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM audit_events WHERE actor_id=$1 AND action='admin.password_reset' AND resource_id=$2)", id, a.cfg.AdminPasswordReset).Scan(&done); e != nil || done {
		return e
	}
	if _, e = tx.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1", id, hashPassword(a.cfg.AdminPassword)); e != nil {
		return e
	}
	for _, statement := range []string{"DELETE FROM auth_sessions WHERE user_id=$1", "DELETE FROM password_resets WHERE user_id=$1"} {
		if _, e = tx.Exec(ctx, statement, id); e != nil {
			return e
		}
	}
	if e = audit(ctx, tx, id, "", "admin.password_reset", a.cfg.AdminPasswordReset); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

// editionName is what the web is told: "hosted" or "local".
func (c Config) editionName() string {
	if c.Edition == editionLocal {
		return editionLocal
	}
	return "hosted"
}

// registrationOpen: a new account can be made here, by local sign-up, not closed.
func (a *App) registrationOpen() bool {
	return !a.clawHuntEnabled() && !a.cfg.RegistrationClosed
}

// localComputer (GET /api/v1/local) is the local edition's own settings page: where its data lives and what this
// computer runs. Only the local edition answers (404 elsewhere), and only to a platform administrator, its person. It
// names no media service: providers.env does, which the person edits themselves.
func (a *App) localComputer(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Edition != editionLocal {
		fail(w, 404, "not_found", "Not found")
		return
	}
	dir := a.cfg.LocalStateDir
	out := map[string]any{"dataFolder": dir, "providersFile": "", "media": a.cfg.mediaConfigured(),
		"managedExecution": a.cfg.OpenMausURL != "", "render": a.cfg.RenderURL != "", "webReader": a.cfg.WebReaderEnabled, "webReaderProxy": a.cfg.WebReaderProxy,
		"skillRegistry": a.cfg.SkillRegistryEnabled, "revision": BuildRevision(), "shell": a.cfg.LocalShell}
	if dir != "" {
		out["providersFile"] = filepath.Join(dir, "providers.env")
	}
	writeJSON(w, 200, out)
}

// authOptions is what the sign-in page needs to know before anyone signs in. The local edition also names the window
// that started it, where one did (the hosted site's answer is unchanged).
func (a *App) authOptions(w http.ResponseWriter, _ *http.Request) {
	out := map[string]any{
		"passwordRecovery": !a.clawHuntEnabled() && a.cfg.SMTPHost != "", "clawhuntSSO": a.clawHuntEnabled(),
		"localAuth": !a.clawHuntEnabled(), "clawhuntSiteURL": a.cfg.ClawHuntURL,
		"edition": a.cfg.editionName(), "registration": a.registrationOpen(),
	}
	if a.cfg.LocalShell != "" {
		out["shell"] = a.cfg.LocalShell
	}
	writeJSON(w, 200, out)
}
