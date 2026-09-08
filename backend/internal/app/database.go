package app

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

func OpenDatabase(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		return nil, e
	}
	cfg.MaxConns = 20
	db, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		return nil, e
	}
	if e = db.Ping(ctx); e != nil {
		db.Close()
		return nil, e
	}
	return db, nil
}
func Migrate(ctx context.Context, db *pgxpool.Pool) error {
	tx, e := db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(84321001)"); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS awwo_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); e != nil {
		return e
	}
	for index, path := range []string{"migrations/001_initial.sql", "migrations/002_planning.sql", "migrations/003_invitations.sql", "migrations/004_admin_pagination.sql", "migrations/005_tenant_pagination.sql", "migrations/006_user_appearance.sql", "migrations/007_node_teams_graph_runs.sql", "migrations/008_node_setup_snapshot.sql"} {
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM awwo_schema_migrations WHERE version=$1)", index+1).Scan(&exists); e != nil {
			return e
		}
		if !exists {
			sql, e := migrations.ReadFile(path)
			if e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, string(sql)); e != nil {
				return fmt.Errorf("migration %d: %w", index+1, e)
			}
			if _, e = tx.Exec(ctx, "INSERT INTO awwo_schema_migrations(version) VALUES($1)", index+1); e != nil {
				return e
			}
		}
	}
	return tx.Commit(ctx)
}

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func rowsJSON(ctx context.Context, q querier, sql string, args ...any) ([]json.RawMessage, error) {
	rows, e := q.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var v json.RawMessage
		if e = rows.Scan(&v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func oneJSON(ctx context.Context, q querier, sql string, args ...any) (json.RawMessage, error) {
	var v json.RawMessage
	e := q.QueryRow(ctx, sql, args...).Scan(&v)
	return v, e
}
func audit(ctx context.Context, tx pgx.Tx, actor, tenant, action, id string) error {
	var a, t any
	if actor != "" {
		a = actor
	}
	if tenant != "" {
		t = tenant
	}
	_, e := tx.Exec(ctx, "INSERT INTO audit_events(actor_id,tenant_id,action,resource_id) VALUES($1,$2,$3,$4)", a, t, action, id)
	return e
}
func noRows(e error) bool { return errors.Is(e, pgx.ErrNoRows) }

const tenantJSON = `jsonb_build_object('id',t.id,'name',t.name,'status',t.status,'maxConcurrentRuns',t.max_concurrent_runs,'maxRunsPerDay',t.max_runs_per_day,'createdAt',t.created_at)`
const canvasJSON = `jsonb_build_object('id',id,'tenantId',tenant_id,'name',name,'document',document,'version',version,'createdAt',created_at,'updatedAt',updated_at)`
const agentJSON = `jsonb_build_object('id',id,'tenantId',tenant_id,'name',name,'status','active','model',model,'role',role,'title',title,'instructions',instructions,'adapterType','pi','adapterConfig',jsonb_build_object('model',model),'createdAt',created_at)`
const sessionJSON = `jsonb_build_object('id',id,'tenantId',tenant_id,'canvasId',canvas_id,'nodeId',node_id,'agentId',agent_id,'title',title,'createdAt',created_at)`
const runJSON = `jsonb_build_object('id',id,'tenantId',tenant_id,'sessionId',session_id,'operationId',operation_id,'status',status,'output',output,'outputAvailable',length(output)>0,'terminal',status NOT IN ('queued','running'),'error',error,'createdAt',created_at,'updatedAt',updated_at)`
