package app

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func migrationTestDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("AWWO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("AWWO_TEST_DATABASE_URL absent")
	}
	ctx := context.Background()
	base, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	schema := "awwo_migration_" + strings.ToLower(strings.ReplaceAll(randomID(), "-", "_"))
	if _, e = base.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); e != nil {
		base.Close()
		t.Fatal(e)
	}
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		db.Close()
		_, e := base.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
		if e != nil {
			t.Error(e)
		}
	})
	return db
}
func applyLegacyMigrations(t *testing.T, db *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	if _, e := db.Exec(ctx, "CREATE TABLE awwo_schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())"); e != nil {
		t.Fatal(e)
	}
	entries, e := migrations.ReadDir("migrations")
	if e != nil {
		t.Fatal(e)
	}
	for _, file := range entries {
		if !strings.HasSuffix(file.Name(), ".sql") || file.Name() >= "011" {
			continue
		}
		sql, e := migrations.ReadFile("migrations/" + file.Name())
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, string(sql)); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, "INSERT INTO awwo_schema_migrations(version) VALUES($1)", int(file.Name()[0]-'0')*100+int(file.Name()[1]-'0')*10+int(file.Name()[2]-'0')); e != nil {
			t.Fatal(e)
		}
	}
}
func TestMigrationIdentityMatrix(t *testing.T) {
	for _, mode := range []string{"fresh", "runtime", "graph", "both", "unknown", "partial_runtime", "partial_graph", "wrong_default", "wrong_constraint", "wrong_foreign_key"} {
		t.Run(mode, func(t *testing.T) {
			db := migrationTestDatabase(t)
			ctx := context.Background()
			var before time.Time
			if mode != "fresh" {
				applyLegacyMigrations(t, db)
				for _, f := range []struct {
					path  string
					apply bool
				}{{"011_agent_runtimes.sql", mode == "runtime" || mode == "both" || mode == "partial_graph" || mode == "wrong_default" || mode == "wrong_constraint" || mode == "wrong_foreign_key"}, {"012_graph_collaboration_reconcile.sql", mode == "graph" || mode == "both" || mode == "partial_runtime" || mode == "wrong_foreign_key"}} {
					if f.apply {
						sql, _ := migrations.ReadFile("migrations/" + f.path)
						if _, e := db.Exec(ctx, string(sql)); e != nil {
							t.Fatal(e)
						}
					}
				}
				extra := map[string]string{"partial_runtime": "ALTER TABLE agents ADD COLUMN runtime text", "partial_graph": "ALTER TABLE graph_runs ADD COLUMN collaboration jsonb", "wrong_default": "ALTER TABLE agents ALTER COLUMN runtime SET DEFAULT 'openai-agents'", "wrong_constraint": "ALTER TABLE agents DROP CONSTRAINT agents_runtime_check", "wrong_foreign_key": "ALTER TABLE graph_collaboration_turns DROP CONSTRAINT graph_collaboration_turns_tenant_id_graph_id_fkey"}[mode]
				if extra != "" {
					if _, e := db.Exec(ctx, extra); e != nil {
						t.Fatal(e)
					}
				}
				if e := db.QueryRow(ctx, "INSERT INTO awwo_schema_migrations(version) VALUES(11) RETURNING applied_at").Scan(&before); e != nil {
					t.Fatal(e)
				}
			}
			err := Migrate(ctx, db)
			bad := strings.HasPrefix(mode, "partial") || strings.HasPrefix(mode, "wrong") || mode == "unknown"
			if bad {
				if err == nil || !strings.Contains(err.Error(), "migration identity mismatch") {
					t.Fatalf("unknown schema accepted: %v", err)
				}
				var n int
				if e := db.QueryRow(ctx, "SELECT count(*) FROM awwo_schema_migrations WHERE version>11").Scan(&n); e != nil || n != 0 {
					t.Fatal("failed migration advanced history", e, n)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if e := Migrate(ctx, db); e != nil {
				t.Fatal("not idempotent", e)
			}
			if mode != "fresh" {
				var after time.Time
				if e := db.QueryRow(ctx, "SELECT applied_at FROM awwo_schema_migrations WHERE version=11").Scan(&after); e != nil || !before.Equal(after) {
					t.Fatal("legacy migration changed", e)
				}
			}
			var count int
			if e := db.QueryRow(ctx, "SELECT count(*) FROM awwo_schema_migration_identities").Scan(&count); e != nil || count != 4 {
				t.Fatal("missing migration identity", e, count)
			}
		})
	}
}
func TestMigrationChecksumDriftRejected(t *testing.T) {
	db := migrationTestDatabase(t)
	ctx := context.Background()
	if e := Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, "UPDATE awwo_schema_migration_identities SET checksum='invalid' WHERE version=13"); e != nil {
		t.Fatal(e)
	}
	if e := Migrate(ctx, db); e == nil {
		t.Fatal("checksum drift accepted")
	}
}

func TestMigrationFingerprintPreservesLiteralWhitespace(t *testing.T) {
	for _, pair := range [][2]string{{"CHECK (runtime = 'pi')", "CHECK (runtime = 'p i')"}, {"CHECK (runtime = 'openai-agents')", "CHECK (runtime = 'openai -agents')"}, {"'pi'::text", "'pi::text'::text"}} {
		if normalizedSchema(pair[0]) == normalizedSchema(pair[1]) {
			t.Fatal("schema literal was normalized into a different value")
		}
	}
}

func TestMigrationBackfillsFrozenRuntimeProvenance(t *testing.T) {
	db := migrationTestDatabase(t)
	applyLegacyMigrations(t, db)
	ctx := context.Background()
	statements := []string{
		"INSERT INTO users(id,email,name,password_hash) VALUES('u','migration@test.local','Migration','hash')",
		"INSERT INTO tenants(id,name) VALUES('t','Migration')",
		"INSERT INTO agents(id,tenant_id,name) VALUES('a','t','Mutable agent')",
		"INSERT INTO canvases(id,tenant_id,name) VALUES('c','t','Migration')",
		"INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id) VALUES('s','t','c','n','a')",
		`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,execution_snapshot) VALUES('single','t','s','single','hash','private','completed','{"runtime":"openai-agents","model":"oa-frozen","health":{"model":"oa-frozen","provider":"frozen-oa-provider"}}'),('team','t','s','team','hash','private','completed','{"runtime":"pi","model":"pi-frozen","team":{"runtime":"pi"},"runtimeHealth":{"pi":{"model":"pi-frozen","provider":"frozen-pi-provider"},"openai-agents":{"model":"oa-frozen","provider":"frozen-oa-provider"}}}')`,
		`INSERT INTO run_turns(id,tenant_id,run_id,member_id,member_name,role,round,ordinal,config,status,prompt) VALUES('turn-pi','t','team','member-pi','Pi','work',1,1,'{"runtime":"pi","model":"pi-frozen"}','completed','private'),('turn-oa','t','team','member-oa','OA','work',1,2,'{"runtime":"openai-agents","model":"oa-frozen"}','completed','private')`,
		"INSERT INTO model_invocations(id,tenant_id,run_id,status) VALUES('single','t','single','completed'),('turn-pi','t','team','completed'),('turn-oa','t','team','completed')",
	}
	for _, sql := range statements {
		if _, e := db.Exec(ctx, sql); e != nil {
			t.Fatal(e)
		}
	}
	if e := Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	for _, expected := range []struct{ id, runtime, model, agent, provider string }{{"single", "openai-agents", "oa-frozen", "a", "frozen-oa-provider"}, {"turn-pi", "pi", "pi-frozen", "member-pi", "frozen-pi-provider"}, {"turn-oa", "openai-agents", "oa-frozen", "member-oa", "frozen-oa-provider"}} {
		var runtime, model, agent, provider, usage, cost string
		var tokens, amount *int64
		if e := db.QueryRow(ctx, "SELECT runtime,model_id,agent_id,provider,usage_status,cost_status,input_tokens,estimated_cost_microusd FROM model_invocations WHERE id=$1", expected.id).Scan(&runtime, &model, &agent, &provider, &usage, &cost, &tokens, &amount); e != nil {
			t.Fatal(e)
		}
		if runtime != expected.runtime || model != expected.model || agent != expected.agent || provider != expected.provider || usage != "unavailable" || cost != "unavailable" || tokens != nil || amount != nil {
			t.Fatal("incorrect historical provenance", expected.id, runtime, model, agent, provider, usage, cost, tokens, amount)
		}
	}
}
