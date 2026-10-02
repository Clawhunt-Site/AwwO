// Package operator is an offline, narrowly scoped control surface. It never starts
// the API, migrations, workers, recovery, or the API's single-worker lease.
package operator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var buildRevision = ""

var (
	ErrInput    = errors.New("invalid operator command arguments")
	ErrDatabase = errors.New("operator database operation failed; no credentials or database error details are exposed")
	ErrIdentity = errors.New("the account does not match the expected immutable identity")
	ErrConflict = errors.New("operation identity or account state changed; no role change applied")
	ErrOperator = errors.New("applying a role change requires an OS root operator")
)

var identifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var operationID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
var revision = regexp.MustCompile(`^[a-f0-9]{40}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func Revision() string {
	if revision.MatchString(buildRevision) {
		return buildRevision
	}
	return "development"
}

type Actor struct {
	UID          int    `json:"uid"`
	EffectiveUID int    `json:"effectiveUid"`
	Host         string `json:"host"`
}

type Identity struct {
	Issuer  string `json:"issuer"`
	Subject string `json:"subject"`
}

type Account struct {
	ID         string     `json:"id"`
	Email      string     `json:"email"`
	Name       string     `json:"name"`
	Role       string     `json:"platformRole"`
	Identities []Identity `json:"identities"`
	rowVersion string
}

type Binding struct {
	UserID  string `json:"userId"`
	Email   string `json:"expectedEmail"`
	Issuer  string `json:"expectedIssuer"`
	Subject string `json:"expectedSubject"`
}

type Grant struct {
	Binding
	ExpectedRole string `json:"expectedRole"`
	OperationID  string `json:"operationId"`
	Reason       string `json:"reason"`
}

type Rollback struct {
	UserID      string `json:"userId"`
	GrantID     int64  `json:"grantAuditId"`
	OperationID string `json:"operationId"`
	Reason      string `json:"reason"`
}

type Receipt struct {
	ContractVersion int    `json:"contractVersion"`
	ToolRevision    string `json:"toolRevision"`
	Applied         bool   `json:"applied"`
	Replayed        bool   `json:"replayed"`
	UserID          string `json:"userId"`
	OperationID     string `json:"operationId"`
	Action          string `json:"action"`
	BeforeRole      string `json:"beforeRole"`
	AfterRole       string `json:"afterRole"`
	AuditID         int64  `json:"auditId"`
}

type Counts struct {
	ActiveRuns                int64 `json:"activeRuns"`
	QueuedRuns                int64 `json:"queuedRuns"`
	RunningRuns               int64 `json:"runningRuns"`
	ActiveComputerRuns        int64 `json:"activeComputerRuns"`
	ActiveGraphRuns           int64 `json:"activeGraphRuns"`
	WaitingGraphNodes         int64 `json:"waitingGraphNodes"`
	RunningGraphNodes         int64 `json:"runningGraphNodes"`
	ActiveTeamTurns           int64 `json:"activeTeamTurns"`
	ActiveInvocations         int64 `json:"activeInvocations"`
	OpenMausDispatchesSending int64 `json:"openMausDispatchesSending"`
}

type Status struct {
	ContractVersion  int       `json:"contractVersion"`
	Source           string    `json:"source"`
	ToolRevision     string    `json:"toolRevision"`
	Nonce            string    `json:"nonce"`
	SnapshotAt       time.Time `json:"snapshotAt"`
	DatabaseIdentity string    `json:"databaseIdentity"`
	SchemaVersion    int       `json:"schemaVersion"`
	SchemaName       string    `json:"schemaName"`
	SchemaDigest     string    `json:"schemaDigest"`
	Counts           Counts    `json:"counts"`
}

type Store struct{ db *pgxpool.Pool }

func New(db *pgxpool.Pool) *Store { return &Store{db: db} }

// Open consumes the existing application's DSN without printing or rewriting it.
func Open(ctx context.Context, dsn string) (*Store, error) {
	if dsn == "" {
		return nil, ErrDatabase
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, ErrDatabase
	}
	cfg.MaxConns, cfg.MinConns = 2, 0
	cfg.ConnConfig.ConnectTimeout = 3 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "awwo-control"
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, ErrDatabase
	}
	return New(db), nil
}

func (s *Store) Close() { s.db.Close() }

func (s *Store) begin(ctx context.Context, write bool) (pgx.Tx, error) {
	opts := pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}
	if write {
		opts = pgx.TxOptions{IsoLevel: pgx.ReadCommitted, AccessMode: pgx.ReadWrite}
	}
	tx, err := s.db.BeginTx(ctx, opts)
	if err != nil {
		return nil, ErrDatabase
	}
	if _, err = tx.Exec(ctx, "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'"); err != nil {
		tx.Rollback(ctx)
		return nil, ErrDatabase
	}
	if write {
		// Separate from both the API lease (84321002) and migration lock. This
		// serializes operation IDs across users without creating schema objects.
		_, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':operator-roles',84321004))")
		if err != nil {
			tx.Rollback(ctx)
			return nil, ErrDatabase
		}
	}
	return tx, nil
}

func (s *Store) Status(ctx context.Context, nonce string) (Status, error) {
	var out Status
	if nonce != "" && !operationID.MatchString(nonce) {
		return out, ErrInput
	}
	tx, err := s.begin(ctx, false)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var database, schema string
	err = tx.QueryRow(ctx, `SELECT clock_timestamp(), current_database(), current_schema(),
 (SELECT COALESCE(max(version),0) FROM awwo_schema_migrations),
 (SELECT count(*) FROM runs WHERE status IN ('queued','running')),
 (SELECT count(*) FROM runs WHERE status='queued'),
 (SELECT count(*) FROM runs WHERE status='running'),
 (SELECT count(*) FROM runs r JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE r.status IN ('queued','running') AND s.kind='computer'),
 (SELECT count(*) FROM graph_runs WHERE status IN ('queued','running')),
 (SELECT count(*) FROM graph_run_nodes n JOIN graph_runs g ON g.tenant_id=n.tenant_id AND g.id=n.graph_id WHERE n.state='waiting' AND g.status IN ('queued','running')),
 (SELECT count(*) FROM graph_run_nodes n JOIN graph_runs g ON g.tenant_id=n.tenant_id AND g.id=n.graph_id WHERE n.state='running' AND g.status IN ('queued','running')),
 (SELECT count(*) FROM run_turns WHERE status IN ('queued','running')),
 (SELECT count(*) FROM model_invocations WHERE status='running'),
 (SELECT count(*) FROM openmaus_dispatches WHERE status='sending')`).Scan(
		&out.SnapshotAt, &database, &schema, &out.SchemaVersion, &out.Counts.ActiveRuns,
		&out.Counts.QueuedRuns, &out.Counts.RunningRuns, &out.Counts.ActiveComputerRuns,
		&out.Counts.ActiveGraphRuns, &out.Counts.WaitingGraphNodes, &out.Counts.RunningGraphNodes,
		&out.Counts.ActiveTeamTurns, &out.Counts.ActiveInvocations, &out.Counts.OpenMausDispatchesSending)
	if err != nil {
		return Status{}, ErrDatabase
	}
	out.ContractVersion, out.Source, out.ToolRevision, out.Nonce = 1, "awwo-control", Revision(), nonce
	out.SnapshotAt = out.SnapshotAt.UTC()
	out.DatabaseIdentity = digest([]string{database, schema})
	out.SchemaName = schema
	rows, err := tx.Query(ctx, "SELECT m.version, COALESCE(i.identity,''), COALESCE(i.checksum,'') FROM awwo_schema_migrations m LEFT JOIN awwo_schema_migration_identities i USING(version) ORDER BY m.version")
	if err != nil {
		return Status{}, ErrDatabase
	}
	defer rows.Close()
	type migration struct {
		Version  int    `json:"version"`
		Identity string `json:"identity"`
		Checksum string `json:"checksum"`
	}
	migrations := []migration{}
	for rows.Next() {
		var m migration
		if rows.Scan(&m.Version, &m.Identity, &m.Checksum) != nil {
			return Status{}, ErrDatabase
		}
		migrations = append(migrations, m)
	}
	if rows.Err() != nil {
		return Status{}, ErrDatabase
	}
	out.SchemaDigest = digest(migrations)
	return out, nil
}

func canonicalEmail(value string) bool {
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && value == strings.ToLower(strings.TrimSpace(value)) && len(value) <= 254
}

func safeText(value string, max int) bool {
	return value != "" && len(value) <= max && strings.TrimSpace(value) == value && !strings.ContainsFunc(value, unicode.IsControl)
}

func validBinding(b Binding) bool {
	u, err := url.Parse(b.Issuer)
	return identifier.MatchString(b.UserID) && canonicalEmail(b.Email) && err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && !strings.Contains(b.Issuer, "#") && safeText(b.Subject, 512)
}

func (g Grant) Validate() error {
	if !validBinding(g.Binding) || g.ExpectedRole != "user" || !operationID.MatchString(g.OperationID) || !safeText(g.Reason, 1000) {
		return ErrInput
	}
	return nil
}

func (r Rollback) Validate() error {
	if !identifier.MatchString(r.UserID) || r.GrantID <= 0 || !operationID.MatchString(r.OperationID) || !safeText(r.Reason, 1000) {
		return ErrInput
	}
	return nil
}

func (s *Store) Inspect(ctx context.Context, id, email string) (Account, error) {
	if (id == "") == (email == "") || (id != "" && !identifier.MatchString(id)) || (email != "" && !canonicalEmail(email)) {
		return Account{}, ErrInput
	}
	tx, err := s.begin(ctx, false)
	if err != nil {
		return Account{}, err
	}
	defer tx.Rollback(ctx)
	return account(ctx, tx, id, email, false)
}

func account(ctx context.Context, tx pgx.Tx, id, email string, lock bool) (Account, error) {
	out := Account{Identities: []Identity{}}
	query := "SELECT id,email,name,platform_role,xmin::text FROM users WHERE id=$1"
	arg := id
	if email != "" {
		query = "SELECT id,email,name,platform_role,xmin::text FROM users WHERE email=$1"
		arg = email
	}
	if lock {
		query += " FOR UPDATE"
	}
	err := tx.QueryRow(ctx, query, arg).Scan(&out.ID, &out.Email, &out.Name, &out.Role, &out.rowVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, ErrIdentity
	}
	if err != nil {
		return Account{}, ErrDatabase
	}
	query = "SELECT issuer,subject FROM external_identities WHERE user_id=$1 ORDER BY issuer,subject"
	if lock {
		query += " FOR SHARE"
	}
	rows, err := tx.Query(ctx, query, out.ID)
	if err != nil {
		return Account{}, ErrDatabase
	}
	defer rows.Close()
	for rows.Next() {
		var identity Identity
		if err = rows.Scan(&identity.Issuer, &identity.Subject); err != nil {
			return Account{}, ErrDatabase
		}
		out.Identities = append(out.Identities, identity)
	}
	if rows.Err() != nil {
		return Account{}, ErrDatabase
	}
	return out, nil
}

func matches(a Account, b Binding) bool {
	if a.ID != b.UserID || a.Email != b.Email {
		return false
	}
	for _, identity := range a.Identities {
		if identity.Issuer == b.Issuer && identity.Subject == b.Subject {
			return true
		}
	}
	return false
}

type record struct {
	Version      int     `json:"version"`
	OperationID  string  `json:"operationId"`
	RequestHash  string  `json:"requestHash"`
	Binding      Binding `json:"binding"`
	BeforeRole   string  `json:"beforeRole"`
	AfterRole    string  `json:"afterRole"`
	RowVersion   string  `json:"rowVersion"`
	GrantID      int64   `json:"grantAuditId,omitempty"`
	Reason       string  `json:"reason"`
	Operator     Actor   `json:"operator"`
	ToolRevision string  `json:"toolRevision"`
	id           int64
	action       string
	resource     string
}

func digest(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func readRecord(ctx context.Context, tx pgx.Tx, query string, args ...any) (*record, error) {
	var raw []byte
	r := &record{}
	err := tx.QueryRow(ctx, query, args...).Scan(&r.id, &r.action, &r.resource, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, ErrDatabase
	}
	if json.Unmarshal(raw, r) != nil || r.Version != 1 || r.Binding.UserID != r.resource || !validBinding(r.Binding) || !operationID.MatchString(r.OperationID) || !hashPattern.MatchString(r.RequestHash) || r.RowVersion == "" {
		return nil, ErrConflict
	}
	return r, nil
}

func existing(ctx context.Context, tx pgx.Tx, operation string) (*record, error) {
	return readRecord(ctx, tx, "SELECT id,action,resource_id,metadata FROM audit_events WHERE action IN ('admin.operator_grant','admin.operator_rollback') AND metadata->>'operationId'=$1 ORDER BY id DESC LIMIT 1", operation)
}

func latest(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, "SELECT COALESCE(max(id),0) FROM audit_events WHERE resource_id=$1 AND action LIKE 'admin.%'", userID).Scan(&id)
	if err != nil {
		return 0, ErrDatabase
	}
	return id, nil
}

func owned(ctx context.Context, tx pgx.Tx, a Account, r *record) error {
	id, err := latest(ctx, tx, a.ID)
	if err != nil {
		return err
	}
	if id != r.id || a.Role != r.AfterRole || a.rowVersion != r.RowVersion || !matches(a, r.Binding) {
		return ErrConflict
	}
	return nil
}

func receipt(r *record, applied, replayed bool) Receipt {
	return Receipt{1, Revision(), applied, replayed, r.Binding.UserID, r.OperationID, r.action, r.BeforeRole, r.AfterRole, r.id}
}

func checkActor(actor Actor, apply bool) error {
	if apply && (actor.EffectiveUID != 0 || actor.UID < 0 || !safeText(actor.Host, 253)) {
		return ErrOperator
	}
	return nil
}

func (s *Store) Grant(ctx context.Context, g Grant, actor Actor, apply bool) (Receipt, error) {
	if err := g.Validate(); err != nil {
		return Receipt{}, err
	}
	if err := checkActor(actor, apply); err != nil {
		return Receipt{}, err
	}
	tx, err := s.begin(ctx, apply)
	if err != nil {
		return Receipt{}, err
	}
	defer tx.Rollback(ctx)
	a, err := account(ctx, tx, g.UserID, "", apply)
	if err != nil {
		return Receipt{}, err
	}
	if !matches(a, g.Binding) {
		return Receipt{}, ErrIdentity
	}
	hash := digest(g)
	prior, err := existing(ctx, tx, g.OperationID)
	if err != nil {
		return Receipt{}, err
	}
	if prior != nil {
		if prior.action != "admin.operator_grant" || prior.RequestHash != hash {
			return Receipt{}, ErrConflict
		}
		if err = owned(ctx, tx, a, prior); err != nil {
			return Receipt{}, err
		}
		return receipt(prior, true, true), nil
	}
	if a.Role != g.ExpectedRole {
		return Receipt{}, ErrConflict
	}
	r := &record{Version: 1, OperationID: g.OperationID, RequestHash: hash, Binding: g.Binding, BeforeRole: a.Role, AfterRole: "admin", Reason: g.Reason, Operator: actor, ToolRevision: Revision(), action: "admin.operator_grant", resource: a.ID}
	return write(ctx, tx, a, r, apply)
}

func (s *Store) Rollback(ctx context.Context, request Rollback, actor Actor, apply bool) (Receipt, error) {
	if err := request.Validate(); err != nil {
		return Receipt{}, err
	}
	if err := checkActor(actor, apply); err != nil {
		return Receipt{}, err
	}
	tx, err := s.begin(ctx, apply)
	if err != nil {
		return Receipt{}, err
	}
	defer tx.Rollback(ctx)
	a, err := account(ctx, tx, request.UserID, "", apply)
	if err != nil {
		return Receipt{}, err
	}
	hash := digest(request)
	prior, err := existing(ctx, tx, request.OperationID)
	if err != nil {
		return Receipt{}, err
	}
	if prior != nil {
		if prior.action != "admin.operator_rollback" || prior.RequestHash != hash {
			return Receipt{}, ErrConflict
		}
		if err = owned(ctx, tx, a, prior); err != nil {
			return Receipt{}, err
		}
		return receipt(prior, true, true), nil
	}
	grant, err := readRecord(ctx, tx, "SELECT id,action,resource_id,metadata FROM audit_events WHERE id=$1 AND action='admin.operator_grant'", request.GrantID)
	if err != nil {
		return Receipt{}, err
	}
	if grant == nil || grant.Binding.UserID != a.ID || grant.BeforeRole != "user" || grant.AfterRole != "admin" {
		return Receipt{}, ErrConflict
	}
	if err = owned(ctx, tx, a, grant); err != nil {
		return Receipt{}, err
	}
	r := &record{Version: 1, OperationID: request.OperationID, RequestHash: hash, Binding: grant.Binding, BeforeRole: "admin", AfterRole: grant.BeforeRole, GrantID: grant.id, Reason: request.Reason, Operator: actor, ToolRevision: Revision(), action: "admin.operator_rollback", resource: a.ID}
	return write(ctx, tx, a, r, apply)
}

func write(ctx context.Context, tx pgx.Tx, a Account, r *record, apply bool) (Receipt, error) {
	if !apply {
		return receipt(r, false, false), nil
	}
	err := tx.QueryRow(ctx, "UPDATE users SET platform_role=$2 WHERE id=$1 AND platform_role=$3 AND xmin::text=$4 RETURNING xmin::text", a.ID, r.AfterRole, r.BeforeRole, a.rowVersion).Scan(&r.RowVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return Receipt{}, ErrConflict
	}
	if err != nil {
		return Receipt{}, ErrDatabase
	}
	data, err := json.Marshal(r)
	if err != nil {
		return Receipt{}, ErrInput
	}
	err = tx.QueryRow(ctx, "INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata) VALUES(NULL,NULL,$1,$2,$3) RETURNING id", r.action, a.ID, data).Scan(&r.id)
	if err != nil {
		return Receipt{}, ErrDatabase
	}
	if err = tx.Commit(ctx); err != nil {
		return Receipt{}, ErrDatabase
	}
	return receipt(r, true, false), nil
}
