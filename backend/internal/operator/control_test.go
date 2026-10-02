package operator_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"awwo/backend/internal/app"
	"awwo/backend/internal/operator"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var actor = operator.Actor{UID: 501, EffectiveUID: 0, Host: "operator-test"}

func grantFor(id string) operator.Grant {
	return operator.Grant{Binding: operator.Binding{UserID: id, Email: id + "@example.invalid", Issuer: "https://identity.example.invalid", Subject: "subject-" + id}, ExpectedRole: "user", OperationID: "grant-operation-" + id, Reason: "Restore the verified owner's platform administration"}
}

func TestGrantRequiresExactExistingIdentityAndExplicitExpectedRole(t *testing.T) {
	g := grantFor("person")
	if err := g.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*operator.Grant){
		"empty user":            func(v *operator.Grant) { v.UserID = "" },
		"invalid user":          func(v *operator.Grant) { v.UserID = "../person" },
		"display email":         func(v *operator.Grant) { v.Email = "Person <person@example.invalid>" },
		"noncanonical email":    func(v *operator.Grant) { v.Email = "PERSON@example.invalid" },
		"untrusted issuer":      func(v *operator.Grant) { v.Issuer = "http://identity.example.invalid" },
		"issuer user info":      func(v *operator.Grant) { v.Issuer = "https://secret@identity.example.invalid" },
		"issuer path":           func(v *operator.Grant) { v.Issuer += "/other" },
		"issuer query":          func(v *operator.Grant) { v.Issuer += "?" },
		"empty subject":         func(v *operator.Grant) { v.Subject = "" },
		"subject control":       func(v *operator.Grant) { v.Subject = "value\nforged" },
		"missing expected role": func(v *operator.Grant) { v.ExpectedRole = "" },
		"existing admin":        func(v *operator.Grant) { v.ExpectedRole = "admin" },
		"weak operation":        func(v *operator.Grant) { v.OperationID = "short" },
		"reason missing":        func(v *operator.Grant) { v.Reason = "" },
	} {
		t.Run(name, func(t *testing.T) {
			v := g
			mutate(&v)
			if !errors.Is(v.Validate(), operator.ErrInput) {
				t.Fatal("unsafe grant accepted")
			}
		})
	}
}

type harness struct {
	db    *pgxpool.Pool
	store *operator.Store
	ctx   context.Context
}

func database(t *testing.T) *harness {
	t.Helper()
	dsn := os.Getenv("AWWO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("AWWO_TEST_DATABASE_URL absent; isolated PostgreSQL integration not executed")
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid test database configuration")
	}
	host := config.ConnConfig.Host
	if host != "127.0.0.1" && host != "localhost" && host != "::1" && !strings.HasPrefix(host, "/tmp/") {
		t.Fatal("operator tests require a loopback or private /tmp socket database")
	}
	ctx := context.Background()
	base, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	var random [12]byte
	if _, err = rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	schema := "awwo_operator_test_" + hex.EncodeToString(random[:])
	if _, err = base.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		base.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := base.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
		if err != nil {
			t.Error(err)
		}
	})
	config.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	// Only this isolated test fixture migrates. The production control tool does not.
	if err = app.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	h := &harness{db: db, store: operator.New(db), ctx: ctx}
	for _, id := range []string{"person", "other"} {
		g := grantFor(id)
		h.exec(t, "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Verified account','synthetic-password-hash')", id, g.Email)
		h.exec(t, "INSERT INTO external_identities(issuer,subject,user_id) VALUES($1,$2,$3)", g.Issuer, g.Subject, id)
	}
	return h
}
func (h *harness) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := h.db.Exec(h.ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}
func (h *harness) role(t *testing.T, id string) string {
	t.Helper()
	var role string
	if err := h.db.QueryRow(h.ctx, "SELECT platform_role FROM users WHERE id=$1", id).Scan(&role); err != nil {
		t.Fatal(err)
	}
	return role
}
func (h *harness) audits(t *testing.T) int {
	t.Helper()
	var n int
	if err := h.db.QueryRow(h.ctx, "SELECT count(*) FROM audit_events WHERE action LIKE 'admin.operator_%'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPostgresOperatorPreviewGrantReplayAndRollback(t *testing.T) {
	h := database(t)
	g := grantFor("person")
	preview, err := h.store.Grant(h.ctx, g, actor, false)
	if err != nil || preview.Applied || preview.AuditID != 0 {
		t.Fatal(preview, err)
	}
	if h.role(t, "person") != "user" || h.audits(t) != 0 {
		t.Fatal("preview mutated account")
	}
	for _, lookup := range [][2]string{{"person", ""}, {"", g.Email}} {
		a, err := h.store.Inspect(h.ctx, lookup[0], lookup[1])
		if err != nil || a.ID != "person" || len(a.Identities) != 1 {
			t.Fatal(a, err)
		}
		raw, _ := json.Marshal(a)
		if strings.Contains(string(raw), "hash") || strings.Contains(string(raw), "rowVersion") {
			t.Fatal("private field leaked")
		}
	}
	first, err := h.store.Grant(h.ctx, g, actor, true)
	if err != nil || !first.Applied || first.Replayed || first.AuditID == 0 {
		t.Fatal(first, err)
	}
	repeat, err := h.store.Grant(h.ctx, g, actor, true)
	if err != nil || !repeat.Replayed || repeat.AuditID != first.AuditID || h.audits(t) != 1 {
		t.Fatal(repeat, err)
	}
	var auditActor *string
	var metadata map[string]any
	if err = h.db.QueryRow(h.ctx, "SELECT actor_id,metadata FROM audit_events WHERE id=$1", first.AuditID).Scan(&auditActor, &metadata); err != nil {
		t.Fatal(err)
	}
	if auditActor != nil || metadata["reason"] != g.Reason || metadata["operator"].(map[string]any)["effectiveUid"] != float64(0) {
		t.Fatal("operator audit forged browser actor or lost reason", metadata)
	}
	r := operator.Rollback{UserID: g.UserID, GrantID: first.AuditID, OperationID: "rollback-operation-person", Reason: "Rollback this exact operator grant"}
	p, err := h.store.Rollback(h.ctx, r, actor, false)
	if err != nil || p.Applied || h.role(t, "person") != "admin" {
		t.Fatal(p, err)
	}
	rolled, err := h.store.Rollback(h.ctx, r, actor, true)
	if err != nil || !rolled.Applied || h.role(t, "person") != "user" {
		t.Fatal(rolled, err)
	}
	again, err := h.store.Rollback(h.ctx, r, actor, true)
	if err != nil || !again.Replayed || again.AuditID != rolled.AuditID || h.audits(t) != 2 {
		t.Fatal(again, err)
	}
	if _, err = h.store.Grant(h.ctx, g, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("old grant resurrected revoked access", err)
	}
	g.OperationID = "new-grant-operation-person"
	fresh, err := h.store.Grant(h.ctx, g, actor, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.store.Rollback(h.ctx, r, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("old rollback demoted replacement grant", err)
	}
	if h.role(t, "person") != "admin" || h.role(t, "other") != "user" || h.audits(t) != 3 || fresh.AuditID == first.AuditID {
		t.Fatal("ownership not preserved")
	}
}

func TestPostgresOperatorRejectsMismatchedIdentityAndUnauditedChanges(t *testing.T) {
	h := database(t)
	g := grantFor("person")
	for name, mutate := range map[string]func(*operator.Grant){"email": func(v *operator.Grant) { v.Email = "other@example.invalid" }, "subject": func(v *operator.Grant) { v.Subject = "subject-other" }, "issuer": func(v *operator.Grant) { v.Issuer = "https://other.example.invalid" }} {
		t.Run(name, func(t *testing.T) {
			bad := g
			mutate(&bad)
			if _, err := h.store.Grant(h.ctx, bad, actor, true); !errors.Is(err, operator.ErrIdentity) {
				t.Fatal(err)
			}
		})
	}
	if _, err := h.store.Grant(h.ctx, g, operator.Actor{UID: 501, EffectiveUID: 501, Host: "host"}, true); !errors.Is(err, operator.ErrOperator) {
		t.Fatal("unprivileged OS actor accepted", err)
	}
	if h.audits(t) != 0 || h.role(t, "person") != "user" {
		t.Fatal("rejection changed account")
	}
	first, err := h.store.Grant(h.ctx, g, actor, true)
	if err != nil {
		t.Fatal(err)
	}
	h.exec(t, "UPDATE users SET platform_role='user' WHERE id='person'")
	h.exec(t, "UPDATE users SET platform_role='admin' WHERE id='person'")
	if _, err = h.store.Rollback(h.ctx, operator.Rollback{UserID: "person", GrantID: first.AuditID, OperationID: "rollback-ownership-test", Reason: "Test stale rollback"}, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("rollback ignored intervening role writes", err)
	}
	if h.role(t, "person") != "admin" || h.audits(t) != 1 {
		t.Fatal("stale rollback changed account")
	}
	newOp := g
	newOp.OperationID = "seize-existing-admin-operation"
	if _, err = h.store.Grant(h.ctx, newOp, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("claimed ownership of preexisting administrator", err)
	}
}

func TestPostgresOperatorAuditFailureRollsBackRole(t *testing.T) {
	h := database(t)
	h.exec(t, "ALTER TABLE audit_events ADD CONSTRAINT reject_operator_test CHECK(action <> 'admin.operator_grant')")
	if _, err := h.store.Grant(h.ctx, grantFor("person"), actor, true); !errors.Is(err, operator.ErrDatabase) {
		t.Fatal(err)
	}
	if h.role(t, "person") != "user" || h.audits(t) != 0 {
		t.Fatal("role survived a failed audit insertion")
	}
}

func TestPostgresOperatorSerializesOperationAcrossUsers(t *testing.T) {
	for _, sameUser := range []bool{true, false} {
		t.Run(map[bool]string{true: "same request", false: "different user"}[sameUser], func(t *testing.T) {
			h := database(t)
			first := grantFor("person")
			second := first
			if !sameUser {
				second = grantFor("other")
				second.OperationID = first.OperationID
			}
			var wg sync.WaitGroup
			wg.Add(2)
			start := make(chan struct{})
			results := make(chan error, 2)
			for _, g := range []operator.Grant{first, second} {
				go func(g operator.Grant) {
					defer wg.Done()
					<-start
					_, err := h.store.Grant(h.ctx, g, actor, true)
					results <- err
				}(g)
			}
			close(start)
			wg.Wait()
			close(results)
			success, conflict := 0, 0
			for err := range results {
				if err == nil {
					success++
				} else if errors.Is(err, operator.ErrConflict) {
					conflict++
				} else {
					t.Fatal(err)
				}
			}
			if sameUser && (success != 2 || conflict != 0) || !sameUser && (success != 1 || conflict != 1) || h.audits(t) != 1 {
				t.Fatal(success, conflict, h.audits(t))
			}
		})
	}
}

func TestPostgresOperatorStatusIncludesDetachedAndComputerWorkWithoutMutation(t *testing.T) {
	h := database(t)
	h.exec(t, "INSERT INTO tenants(id,name) VALUES('t','Synthetic test workspace')")
	h.exec(t, "INSERT INTO memberships(tenant_id,user_id,role) VALUES('t','person','owner')")
	h.exec(t, "INSERT INTO canvases(id,tenant_id,name) VALUES('c','t','Test canvas')")
	h.exec(t, "INSERT INTO agents(id,tenant_id,name) VALUES('a','t','Test agent')")
	for _, kind := range []string{"node", "computer", "planner"} {
		h.exec(t, "INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id,kind) VALUES($1,'t','c',$1,'a',$2)", "s-"+kind, kind)
		status := "running"
		if kind == "planner" {
			status = "queued"
		}
		h.exec(t, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status) VALUES($1,'t',$2,$1,'synthetic','DO NOT EXECUTE',$3)", "r-"+kind, "s-"+kind, status)
	}
	h.exec(t, "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES('g','t','c','person','graph-op','synthetic',1,'{}','{}','running')")
	h.exec(t, "INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state) VALUES('t','g','n1',0,'waiting'),('t','g','n2',1,'running')")
	// Old terminal graphs can retain historical node projections. They cannot
	// schedule work, and must not make a live drain wait forever.
	h.exec(t, "INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES('old-g','t','c','person','old-graph-op','synthetic',1,'{}','{}','cancelled')")
	h.exec(t, "INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state) VALUES('t','old-g','old-n1',0,'waiting'),('t','old-g','old-n2',1,'running')")
	h.exec(t, "INSERT INTO computer_approvals(id,tenant_id,run_id,request_id,title,description,kind,request_hash) VALUES('approval','t','r-computer','request','Synthetic approval','Still waiting for a human','approval','synthetic')")
	h.exec(t, "INSERT INTO run_turns(id,tenant_id,run_id,member_id,member_name,role,round,ordinal,config,status,prompt) VALUES('turn','t','r-node','m','Member','author',0,0,'{}','queued','DO NOT EXECUTE')")
	h.exec(t, "INSERT INTO model_invocations(id,tenant_id,run_id,status) VALUES('inv','t','r-node','running')")
	h.exec(t, "INSERT INTO openmaus_dispatches(tenant_id,operation_id,request_hash,actor_id,bot_id,task_id,status) VALUES('t','openmaus-op','synthetic','person','b','task','sending')")
	before, err := h.store.Status(h.ctx, "status-proof-nonce-001")
	if err != nil {
		t.Fatal(err)
	}
	want := operator.Counts{ActiveRuns: 3, QueuedRuns: 1, RunningRuns: 2, ActiveComputerRuns: 1, ActiveGraphRuns: 1, WaitingGraphNodes: 1, RunningGraphNodes: 1, ActiveTeamTurns: 1, ActiveInvocations: 1, OpenMausDispatchesSending: 1}
	if before.Counts != want || before.ContractVersion != 1 || before.Source != "awwo-control" || before.Nonce != "status-proof-nonce-001" || before.SchemaVersion != 22 || len(before.SchemaDigest) != 64 || len(before.DatabaseIdentity) != 64 || time.Since(before.SnapshotAt) > 5*time.Second {
		t.Fatal(before)
	}
	if _, err = h.store.Grant(h.ctx, grantFor("person"), actor, true); err != nil {
		t.Fatal(err)
	}
	after, err := h.store.Status(h.ctx, "status-proof-nonce-002")
	if err != nil || after.Counts != before.Counts || after.SchemaDigest != before.SchemaDigest {
		t.Fatal("grant/status changed work or schema", after, err)
	}
}

func TestPostgresOperatorGrantVisibleToExistingNormalSession(t *testing.T) {
	h := database(t)
	token := "synthetic-session-for-operator-test"
	sum := sha256.Sum256([]byte(token))
	h.exec(t, "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,'person',now()+interval '1 hour')", hex.EncodeToString(sum[:]))
	// A normal Handler, without Start, exercises the existing role read on each request.
	a := app.New(h.db, app.Config{Env: "development", PublicOrigin: "http://127.0.0.1", SessionTTL: time.Hour, RunTimeout: time.Second})
	readRole := func() string {
		t.Helper()
		request := httptest.NewRequest("GET", "http://127.0.0.1/api/v1/auth/me", nil)
		request.AddCookie(&http.Cookie{Name: "awwo_session", Value: token})
		response := httptest.NewRecorder()
		a.Handler().ServeHTTP(response, request)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		var body struct {
			User struct {
				Role string `json:"platformRole"`
			} `json:"user"`
		}
		if json.Unmarshal(response.Body.Bytes(), &body) != nil {
			t.Fatal("invalid identity")
		}
		return body.User.Role
	}
	if readRole() != "user" {
		t.Fatal("unexpected baseline role")
	}
	if _, err := h.store.Grant(h.ctx, grantFor("person"), actor, true); err != nil {
		t.Fatal(err)
	}
	if readRole() != "admin" {
		t.Fatal("existing session retained stale role")
	}
}
