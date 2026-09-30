package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// New-workspace defaults are read once at startup and stamped onto a tenants row
// only when that row is inserted. No existing workspace reads them, so changing a
// value later affects only workspaces created afterwards, and the admin PATCH stays
// the way to change one workspace.
func (c *Config) workspaceDefaultsFromEnv() error {
	if raw := os.Getenv("AWWO_NEW_WORKSPACE_ALLOWED_MODELS"); raw != "" {
		models, err := newWorkspaceModels(raw)
		if err != nil {
			return err
		}
		c.NewWorkspaceModels = models
	}
	if raw := os.Getenv("AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY"); raw != "" {
		// Zero is how the field says unset, so an explicit 0 is refused here; the upper
		// bound is checked with the other ranges in validateWorkspaceDefaults.
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			return errors.New(errRunsPerDay)
		}
		c.NewWorkspaceRunsPerDay = n
	}
	if raw := os.Getenv("AWWO_MAX_OWNED_WORKSPACES"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			return errors.New(errOwnedWorkspaces)
		}
		c.MaxOwnedWorkspaces = n
	}
	return nil
}

const (
	errRunsPerDay      = "AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY must be between 1 and 100000"
	errOwnedWorkspaces = "AWWO_MAX_OWNED_WORKSPACES must be 0 (unlimited) or a positive integer"
)

// The admin PATCH normalizer is the only allowlist grammar. The list reaches it as
// the JSON array that endpoint accepts instead of being parsed a second way, so a
// list the admin could not store cannot be configured either. Invalid UTF-8 is
// refused because encoding it would silently replace the bytes.
func newWorkspaceModels(raw string) (modelEntitlement, error) {
	ids, _ := json.Marshal(strings.Split(raw, ","))
	models, _, err := normalizeAllowedModels(ids)
	if err != nil || !utf8.ValidString(raw) {
		return deniedModels(), errors.New("AWWO_NEW_WORKSPACE_ALLOWED_MODELS must be 1 to 64 comma-separated model ids of at most 200 bytes, without whitespace or control characters")
	}
	return models, nil
}

// The quota range is that of the column's CHECK constraint. Zero keeps the column
// default, or leaves ownership uncapped.
//
// A personal catalogue names each model after the caller's own connection (byok_…),
// so a default list of worker model ids could never match a new user's models and
// every new workspace would be unable to run anything. The list is therefore an
// operator-credential setting, refused at startup in personal mode.
func (c Config) validateWorkspaceDefaults() error {
	if c.NewWorkspaceRunsPerDay < 0 || c.NewWorkspaceRunsPerDay > 100000 {
		return errors.New(errRunsPerDay)
	}
	if c.MaxOwnedWorkspaces < 0 {
		return errors.New(errOwnedWorkspaces)
	}
	if c.UserCredentials && !c.NewWorkspaceModels.unrestricted() {
		return errors.New("AWWO_NEW_WORKSPACE_ALLOWED_MODELS requires AWWO_CREDENTIAL_MODE=operator; personal catalogues use per-connection model ids")
	}
	return nil
}

// insertTenant is the only statement that creates a workspace, so every creation
// path, including one added later, starts from the same deployment defaults. Unset
// defaults leave the migrations' own: NULL (unrestricted) models and the column's
// daily quota.
func (a *App) insertTenant(ctx context.Context, tx pgx.Tx, id, name string) error {
	models := a.cfg.NewWorkspaceModels.column()
	if a.cfg.NewWorkspaceRunsPerDay == 0 {
		_, err := tx.Exec(ctx, "INSERT INTO tenants(id,name,allowed_models) VALUES($1,$2,$3::text[])", id, name, models)
		return err
	}
	_, err := tx.Exec(ctx, "INSERT INTO tenants(id,name,allowed_models,max_runs_per_day) VALUES($1,$2,$3::text[],$4)", id, name, models, a.cfg.NewWorkspaceRunsPerDay)
	return err
}

// Every workspace carries its own daily allowance, so an account free to create
// workspaces could multiply it. The cap counts owner memberships only and exempts
// platform administrators. The automatic first workspace of registration and of a
// first ClawHunt sign-in never passes through here: it is the person's one
// workspace, not an extra one.
//
// The count and the insert that follows share the caller's transaction, and a
// per-account advisory lock held until that transaction ends serializes them, so
// concurrent requests from one account cannot each see room for one more. The
// caller's transaction must be READ COMMITTED: the count then takes its snapshot
// after the lock is granted, which is what makes a workspace the previous holder
// just committed visible to it. Under REPEATABLE READ the snapshot would predate
// the wait and the cap would fail open.
func (a *App) workspaceLimitReached(ctx context.Context, tx pgx.Tx, u User) (bool, error) {
	if a.cfg.MaxOwnedWorkspaces == 0 || u.PlatformRole == "admin" {
		return false, nil
	}
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,84321004))", u.ID); err != nil {
		return false, err
	}
	var owned int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM memberships WHERE user_id=$1 AND role='owner'", u.ID).Scan(&owned); err != nil {
		return false, err
	}
	return owned >= a.cfg.MaxOwnedWorkspaces, nil
}
