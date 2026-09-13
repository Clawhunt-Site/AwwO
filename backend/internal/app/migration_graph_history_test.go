package app

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Exercise the migration shipped by the graph-collaboration branch itself.
// The reconciliation copy alone cannot prove compatibility with that history.
func TestMigrationPreservesRemoteGraphHistory(t *testing.T) {
	db := migrationTestDatabase(t)
	applyLegacyMigrations(t, db)
	ctx := context.Background()
	legacy, err := migrations.ReadFile("migrations/011_graph_collaboration.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, string(legacy)); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err = db.QueryRow(ctx, "INSERT INTO awwo_schema_migrations(version) VALUES(11) RETURNING applied_at").Scan(&before); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		"INSERT INTO tenants(id,name) VALUES('historical-tenant','Historical graph')",
		"INSERT INTO agents(id,tenant_id,name) VALUES('historical-agent','historical-tenant','Existing Pi agent')",
	}
	for _, sql := range statements {
		if _, err = db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	if err = Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(ctx, db); err != nil {
		t.Fatal("repeated migration failed", err)
	}
	var after time.Time
	var runtime string
	if err = db.QueryRow(ctx, "SELECT applied_at FROM awwo_schema_migrations WHERE version=11").Scan(&after); err != nil || !before.Equal(after) {
		t.Fatal("historical migration record changed", err)
	}
	if err = db.QueryRow(ctx, "SELECT runtime FROM agents WHERE id='historical-agent'").Scan(&runtime); err != nil || runtime != "pi" {
		t.Fatal("existing agent did not receive the compatible runtime", runtime, err)
	}
	var identities int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM awwo_schema_migration_identities WHERE version BETWEEN 12 AND 14").Scan(&identities); err != nil || identities != 3 {
		t.Fatal("missing reconciled migration identities", identities, err)
	}
	if _, err = db.Exec(ctx, "UPDATE awwo_schema_migration_identities SET checksum='modified' WHERE version=12"); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(ctx, db); !errors.Is(err, errMigrationIdentity) {
		t.Fatal("reconciled graph history accepted checksum drift", err)
	}
}
