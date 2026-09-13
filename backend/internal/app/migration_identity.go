package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
)

var errMigrationIdentity = errors.New("migration identity mismatch; schema requires operator review")

type schemaColumn struct {
	Name, Type string
	Required   bool
	Default    string
}

func normalizedSchema(s string) string {
	var out strings.Builder
	quoted := false
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' {
			out.WriteByte(s[i])
			if quoted && i+1 < len(s) && s[i+1] == '\'' {
				i++
				out.WriteByte(s[i])
				continue
			}
			quoted = !quoted
			continue
		}
		if !quoted {
			if strings.HasPrefix(s[i:], "::text") {
				i += len("::text") - 1
				continue
			}
			if unicode.IsSpace(rune(s[i])) || s[i] == '(' || s[i] == ')' {
				continue
			}
		}
		out.WriteByte(s[i])
	}
	return out.String()
}
func schemaSignature(ctx context.Context, tx pgx.Tx, table string, expected []schemaColumn, constraints []string, subset bool) (string, error) {
	rows, e := tx.Query(ctx, `SELECT a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,COALESCE(pg_get_expr(d.adbin,d.adrelid),'') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=current_schema() AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, table)
	if e != nil {
		return "", e
	}
	columns := map[string]schemaColumn{}
	for rows.Next() {
		var c schemaColumn
		if e = rows.Scan(&c.Name, &c.Type, &c.Required, &c.Default); e != nil {
			rows.Close()
			return "", e
		}
		columns[c.Name] = c
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return "", e
	}
	present := 0
	for _, c := range expected {
		if actual, ok := columns[c.Name]; ok {
			present++
			if actual.Type != c.Type || actual.Required != c.Required || actual.Default != c.Default {
				return "partial", nil
			}
		}
	}
	if present == 0 {
		if !subset && len(columns) > 0 {
			return "partial", nil
		}
		return "absent", nil
	}
	if present != len(expected) || (!subset && len(columns) != len(expected)) {
		return "partial", nil
	}
	rows, e = tx.Query(ctx, `SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1 AND k.contype<>'n'`, table)
	if e != nil {
		return "", e
	}
	actual := []string{}
	for rows.Next() {
		var s string
		if e = rows.Scan(&s); e != nil {
			rows.Close()
			return "", e
		}
		if !subset || strings.Contains(s, "runtime") {
			actual = append(actual, normalizedSchema(s))
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return "", e
	}
	wanted := make([]string, len(constraints))
	for i, s := range constraints {
		wanted[i] = normalizedSchema(s)
	}
	sort.Strings(wanted)
	sort.Strings(actual)
	if strings.Join(actual, "\n") != strings.Join(wanted, "\n") {
		return "partial", nil
	}
	return "complete", nil
}
func historicalSchemaState(ctx context.Context, tx pgx.Tx) (string, string, error) {
	runtime, e := schemaSignature(ctx, tx, "agents", []schemaColumn{{"runtime", "text", true, "'pi'::text"}}, []string{"CHECK (runtime = ANY (ARRAY['pi'::text, 'openai-agents'::text]))"}, true)
	if e != nil {
		return "", "", e
	}
	graph, e := schemaSignature(ctx, tx, "graph_runs", []schemaColumn{{"collaboration", "jsonb", false, ""}}, nil, true)
	if e != nil {
		return "", "", e
	}
	nodes, e := schemaSignature(ctx, tx, "graph_run_nodes", []schemaColumn{{"collaboration_prompt", "text", true, "''::text"}}, nil, true)
	if e != nil {
		return "", "", e
	}
	turns, e := schemaSignature(ctx, tx, "graph_collaboration_turns", []schemaColumn{{"tenant_id", "text", true, ""}, {"graph_id", "text", true, ""}, {"ordinal", "integer", true, ""}, {"node_id", "text", true, ""}, {"phase", "text", true, ""}, {"round", "integer", true, ""}, {"state", "text", true, "'waiting'::text"}, {"run_id", "text", false, ""}, {"error", "text", true, "''::text"}}, []string{
		"CHECK (ordinal >= 1 AND ordinal <= 37)", "CHECK (phase = ANY (ARRAY['proposal'::text, 'review'::text, 'synthesis'::text]))", "CHECK (round >= 1 AND round <= 3)", "CHECK (state = ANY (ARRAY['waiting'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text]))", "PRIMARY KEY (graph_id, ordinal)", "UNIQUE (tenant_id, run_id)", "FOREIGN KEY (tenant_id, graph_id) REFERENCES graph_runs(tenant_id, id) ON DELETE CASCADE", "FOREIGN KEY (graph_id, node_id) REFERENCES graph_run_nodes(graph_id, node_id) ON DELETE CASCADE", "FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id)"}, false)
	if e != nil {
		return "", "", e
	}
	if graph != nodes || graph != turns {
		graph = "partial"
	}
	return runtime, graph, nil
}
func reconcileMigrationIdentity(ctx context.Context, tx pgx.Tx) error {
	runtime, graph, e := historicalSchemaState(ctx, tx)
	if e != nil {
		return e
	}
	if runtime == "partial" || graph == "partial" || (runtime == "absent" && graph == "absent") {
		return errMigrationIdentity
	}
	if _, e = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS awwo_schema_migration_identities(version integer PRIMARY KEY REFERENCES awwo_schema_migrations(version),identity text NOT NULL,checksum text NOT NULL)`); e != nil {
		return e
	}
	runtimeSQL, e := migrations.ReadFile("migrations/011_agent_runtimes.sql")
	if e != nil {
		return e
	}
	graphSQL, e := migrations.ReadFile("migrations/012_graph_collaboration_reconcile.sql")
	if e != nil {
		return e
	}
	checksum := sha256.Sum256(append(append([]byte("schema-reconcile-v1\n"), runtimeSQL...), graphSQL...))
	exists, e := verifyMigrationIdentity(ctx, tx, 12, "historical-011-schema-reconciliation-v1", hex.EncodeToString(checksum[:]))
	if e != nil {
		return e
	}
	if exists {
		if runtime != "complete" || graph != "complete" {
			return errMigrationIdentity
		}
		return nil
	}
	if runtime == "absent" {
		if _, e = tx.Exec(ctx, string(runtimeSQL)); e != nil {
			return e
		}
	}
	if graph == "absent" {
		if _, e = tx.Exec(ctx, string(graphSQL)); e != nil {
			return e
		}
	}
	runtime, graph, e = historicalSchemaState(ctx, tx)
	if e != nil {
		return e
	}
	if runtime != "complete" || graph != "complete" {
		return errMigrationIdentity
	}
	return recordMigrationIdentity(ctx, tx, 12, "historical-011-schema-reconciliation-v1", hex.EncodeToString(checksum[:]))
}
func verifyMigrationIdentity(ctx context.Context, tx pgx.Tx, version int, identity, checksum string) (bool, error) {
	var exists bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM awwo_schema_migrations WHERE version=$1)", version).Scan(&exists); e != nil {
		return false, e
	}
	if !exists {
		return false, nil
	}
	var gotIdentity, gotChecksum string
	if e := tx.QueryRow(ctx, "SELECT identity,checksum FROM awwo_schema_migration_identities WHERE version=$1", version).Scan(&gotIdentity, &gotChecksum); e != nil {
		return false, errMigrationIdentity
	}
	if gotIdentity != identity || gotChecksum != checksum {
		return false, errMigrationIdentity
	}
	return true, nil
}
func recordMigrationIdentity(ctx context.Context, tx pgx.Tx, version int, identity, checksum string) error {
	if _, e := tx.Exec(ctx, "INSERT INTO awwo_schema_migrations(version) VALUES($1)", version); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "INSERT INTO awwo_schema_migration_identities(version,identity,checksum) VALUES($1,$2,$3)", version, identity, checksum)
	return e
}
func applyIdentifiedMigration(ctx context.Context, tx pgx.Tx, version int, path string) error {
	sql, e := migrations.ReadFile(path)
	if e != nil {
		return e
	}
	sum := sha256.Sum256(sql)
	hash := hex.EncodeToString(sum[:])
	exists, e := verifyMigrationIdentity(ctx, tx, version, path, hash)
	if e != nil || exists {
		return e
	}
	if _, e = tx.Exec(ctx, string(sql)); e != nil {
		return fmt.Errorf("migration %d: %w", version, e)
	}
	return recordMigrationIdentity(ctx, tx, version, path, hash)
}
