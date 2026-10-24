package operator_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"awwo/backend/internal/operator"
	"github.com/jackc/pgx/v5"
)

func deletionFor(id string) operator.Deletion {
	return operator.Deletion{UserID: id, Email: id + "@example.invalid", OperationID: "delete-operation-" + id, Reason: "The person asked for their account to be deleted"}
}

func TestDeletionRejectsUnsafeArguments(t *testing.T) {
	d := deletionFor("person")
	d.RequestID, d.Transfers, d.Deletes = "request-1", map[string]string{"w-own": "member"}, []string{"w-solo"}
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	named := d
	named.Renames = map[string]string{"w-own": "Design \u2764\ufe0f"}
	if err := named.Validate(); err != nil {
		t.Fatal("an emoji name refused", err)
	}
	many := map[string]string{}
	for i := range 51 {
		many[fmt.Sprintf("w%d", i)] = "member"
	}
	for name, mutate := range map[string]func(*operator.Deletion){
		"empty user":                      func(v *operator.Deletion) { v.UserID = "" },
		"invalid user":                    func(v *operator.Deletion) { v.UserID = "../person" },
		"display email":                   func(v *operator.Deletion) { v.Email = "Person <person@example.invalid>" },
		"noncanonical email":              func(v *operator.Deletion) { v.Email = "PERSON@example.invalid" },
		"invalid request":                 func(v *operator.Deletion) { v.RequestID = "request 1" },
		"weak operation":                  func(v *operator.Deletion) { v.OperationID = "short" },
		"reason missing":                  func(v *operator.Deletion) { v.Reason = "" },
		"reason control":                  func(v *operator.Deletion) { v.Reason = "asked\nby mail" },
		"transfer to themself":            func(v *operator.Deletion) { v.Transfers = map[string]string{"w-own": "person"} },
		"invalid new owner":               func(v *operator.Deletion) { v.Transfers = map[string]string{"w-own": "a b"} },
		"invalid workspace":               func(v *operator.Deletion) { v.Deletes = []string{"w solo"} },
		"transfer and delete":             func(v *operator.Deletion) { v.Deletes = []string{"w-own"} },
		"workspace twice":                 func(v *operator.Deletion) { v.Deletes = []string{"w-solo", "w-solo"} },
		"too many dispositions":           func(v *operator.Deletion) { v.Transfers = many },
		"rename not handed over":          func(v *operator.Deletion) { v.Renames = map[string]string{"w-solo": "Kept"} },
		"rename blank":                    func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": " "} },
		"rename with a comma":             func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team, again"} },
		"rename control":                  func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\u202eagain"} },
		"rename too long":                 func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": strings.Repeat("x", 201)} },
		"rename line separator":           func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\u2028again"} },
		"rename filler":                   func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "\u3164"} },
		"rename paragraph separator":      func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\u2029again"} },
		"rename variation selector alone": func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "\ufe0f"} },
		"rename combining mark alone":     func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "\u0301"} },
		"rename leading mark":             func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "\u0301Team"} },
		"rename braille blank":            func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\u2800"} },
		"rename invalid UTF-8":            func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\xff"} },
		"rename private use":              func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\ue000"} },
		"rename unassigned":               func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\u0378"} },
		"rename noncharacter":             func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Team\ufdd0"} },
		"supersede and request":           func(v *operator.Deletion) { v.Supersedes = "req-0" },
		"invalid superseded":              func(v *operator.Deletion) { v.RequestID, v.Supersedes = "", "req 0" },
	} {
		t.Run(name, func(t *testing.T) {
			v := d
			mutate(&v)
			if !errors.Is(v.Validate(), operator.ErrInput) {
				t.Fatal("unsafe deletion accepted")
			}
		})
	}
}

// catalog lists the rows of a catalog query as "a b c" strings.
func (h *harness) catalog(t *testing.T, sql string) []string {
	t.Helper()
	rows, err := h.db.Query(h.ctx, sql)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			t.Fatal(err)
		}
		parts := make([]string, len(values))
		for i, v := range values {
			parts[i] = fmt.Sprint(v)
		}
		out = append(out, strings.Join(parts, " "))
	}
	if rows.Err() != nil {
		t.Fatal(rows.Err())
	}
	return out
}

const foreignKeysSQL = `SELECT c.conrelid::regclass::text,
	(SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum),
	c.confrelid::regclass::text, c.confdeltype::text
FROM pg_constraint c WHERE c.contype='f' AND c.connamespace=to_regnamespace(current_schema())
	AND c.conrelid::regclass::text NOT LIKE 'awwo\_schema\_%%' AND %s ORDER BY 1,2,3` // not the migration runner's own tables

// The account deletion tool (deletion.go) handles each of these by name. A new migration that adds a reference to users
// or tenants, a reference without an ON DELETE action anywhere, a trigger, a rule or a plain-text user id changes this
// list: then check the tool's order of steps and its documentation (backend/README.md) before updating the list.
func TestPostgresDeletionSchemaReferencesArePinned(t *testing.T) {
	h := database(t)
	for name, check := range map[string]struct {
		sql  string
		want []string
	}{
		"references to users and tenants": {fmt.Sprintf(foreignKeysSQL, "c.confrelid IN ('users'::regclass,'tenants'::regclass)"), []string{
			"account_deletion_requests user_id users n", "agents tenant_id tenants a", "artifacts tenant_id tenants a",
			"audit_events actor_id users a", "audit_events tenant_id tenants a", "auth_sessions user_id users c",
			"canvas_experiences tenant_id tenants c", "canvas_lessons tenant_id tenants c", "canvases tenant_id tenants a",
			"computer_responses tenant_id tenants a", "edit_jobs tenant_id tenants c", "external_identities user_id users c",
			"graph_operation_cancellations actor_id users a", "graph_runs actor_id users a",
			"knowledge_documents tenant_id tenants a", "knowledge_events tenant_id tenants a",
			"knowledge_operations tenant_id tenants a", "knowledge_proposals tenant_id tenants a",
			"media_generations tenant_id tenants c", "memberships tenant_id tenants a", "memberships user_id users a",
			"memory_items tenant_id tenants c", "model_invocations tenant_id tenants c", "node_sessions tenant_id tenants a",
			"openmaus_dispatches tenant_id tenants a", "password_resets user_id users c", "plan_watches user_id users c",
			"refunded_calls tenant_id tenants c", "refunded_runs tenant_id tenants c", "relay_keys tenant_id tenants c", "relay_keys user_id users c",
			"render_jobs tenant_id tenants c", "runs actor_id users a",
			"runs tenant_id tenants a", "tenant_invites accepted_by users a", "tenant_invites created_by users a",
			"tenant_invites tenant_id tenants a", "tenant_skills tenant_id tenants c", "upgrade_interests tenant_id tenants c",
			"upgrade_interests user_id users c", "usage_retention_boundaries tenant_id tenants c",
			"user_appearance user_id users c", "user_connections user_id users c", "user_plans user_id users c",
			"user_preferences user_id users c", "web_reads tenant_id tenants c", "workspace_checkins tenant_id tenants c",
			"workspace_checkins user_id users c",
		}},
		"references without an ON DELETE action": {fmt.Sprintf(foreignKeysSQL, "c.confdeltype IN ('a','r') AND c.confrelid NOT IN ('users'::regclass,'tenants'::regclass)"), []string{
			"graph_collaboration_turns tenant_id,run_id runs a", "graph_run_nodes tenant_id,run_id runs a",
			"graph_run_nodes tenant_id,session_id node_sessions a", "knowledge_documents tenant_id,id,current_revision_id knowledge_revisions a",
			"knowledge_links tenant_id,from_document_id,revision_id knowledge_revisions a",
			"knowledge_links tenant_id,to_document_id knowledge_documents a",
			"knowledge_proposals tenant_id,accepted_document_id knowledge_documents a",
			"knowledge_proposals tenant_id,document_id knowledge_documents a",
			"knowledge_revisions tenant_id,document_id knowledge_documents a",
			"knowledge_revisions tenant_id,document_id,parent_revision_id knowledge_revisions a",
			"knowledge_source_origins tenant_id,document_id knowledge_documents a",
			"node_sessions tenant_id,agent_id agents a",
		}},
		"triggers": {`SELECT tgrelid::regclass::text, tgname, tgtype FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace=to_regnamespace(current_schema())) ORDER BY 1,2`, []string{
			"knowledge_revisions knowledge_revision_immutable 19", "knowledge_source_origins knowledge_source_origin_immutable 27",
		}},
		"rules": {`SELECT tablename, rulename FROM pg_rules WHERE schemaname=current_schema()`, []string{}},
		// Workspace rows without a key to their workspace would outlive a deleted one.
		"workspace tables without a key": {`SELECT c.table_name FROM information_schema.columns c
			WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND c.table_name NOT LIKE 'awwo\_schema\_%'
			AND NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=ANY(k.conkey)
				WHERE k.contype='f' AND k.conrelid=(quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass AND a.attname='tenant_id')
			ORDER BY 1`, []string{}},
		// Columns named like a person's id without a foreign key: kept as plain text when the account goes (the user
		// ids among them are listed in backend/README.md), or not a person at all (run_turns.member_id is a team member).
		"plain-text user ids": {`SELECT c.table_name, c.column_name FROM information_schema.columns c
			WHERE c.table_schema=current_schema() AND (c.column_name IN ('actor_id','created_by','updated_by','decided_by','billed_user_id','user_id')
				OR c.column_name ~ '(^|_)(user|users|owner|actor|author|creator|member|admin|operator|account|person|payer|asker)(_id|_ids)?$' OR c.column_name ~ '_by$')
			AND NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=ANY(k.conkey)
				WHERE k.contype='f' AND k.conrelid=(quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass AND a.attname=c.column_name)
			ORDER BY 1,2`, []string{
			"account_deletion_requests decided_by", "computer_sessions actor_id", "knowledge_events actor_id",
			"knowledge_proposals actor_id", "knowledge_revisions actor_id", "knowledge_source_origins actor_id",
			"media_generations billed_user_id", "memory_items created_by", "memory_items updated_by",
			"model_invocations billed_user_id", "openmaus_dispatches actor_id", "render_jobs actor_id", "run_turns member_id",
			"tenant_skill_revisions created_by", "tenant_skills created_by", "tenant_skills updated_by", "web_reads actor_id",
		}},
	} {
		t.Run(name, func(t *testing.T) {
			if got := h.catalog(t, check.sql); !slices.Equal(got, check.want) {
				t.Fatalf("the schema changed under the account deletion tool:\n got %q\nwant %q", got, check.want)
			}
		})
	}
}

// seedAccount builds the account to delete, "person": it owns w-own (shared with "member") and w-solo (alone, with
// knowledge, a canvas and its files' rows), belongs to w-team (owned by "other", where it ran a graph and sent an
// invitation), accepted other's invitation there, has sessions, a key, a cancelled plan and a pending deletion request.
func seedAccount(t *testing.T, h *harness) {
	t.Helper()
	for _, sql := range []string{
		"INSERT INTO users(id,email,name,password_hash) VALUES('member','member@example.invalid','Member','synthetic-password-hash')",
		"INSERT INTO tenants(id,name) VALUES('w-own','Person shared'),('w-solo','Person alone'),('w-team','Other team')",
		// Each owner joined first, as a workspace's creator does: the person's membership is older than the new owner's.
		`INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES('w-own','person','owner',now()-interval '3 days'),('w-own','member','admin',now()-interval '2 days'),
			('w-solo','person','owner',now()-interval '3 days'),('w-team','other','owner',now()-interval '5 days'),('w-team','person','admin',now()-interval '4 days'),('w-team','member','member',now()-interval '4 days')`,
		"INSERT INTO agents(id,tenant_id,name) VALUES('ag-own','w-own','Writer'),('ag-solo','w-solo','Writer'),('ag-team','w-team','Writer')",
		"INSERT INTO canvases(id,tenant_id,name) VALUES('cv-own','w-own','Shared canvas'),('cv-solo','w-solo','Solo canvas'),('cv-team','w-team','Team canvas')",
		"INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id) VALUES('s-own','w-own','cv-own','n','ag-own'),('s-solo','w-solo','cv-solo','n','ag-solo'),('s-team','w-team','cv-team','n','ag-team')",
		`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,actor_id) VALUES
			('r-own-person','w-own','s-own','op-1','h','Draft the plan','completed','The plan','person'),
			('r-own-member','w-own','s-own','op-2','h','Review the plan','completed','Reviewed','member'),
			('r-solo','w-solo','s-solo','op-3','h','Notes','completed','Notes','person'),
			('r-team-person','w-team','s-team','op-4','h','Brief','completed','The brief','person'),
			('r-team-other','w-team','s-team','op-5','h','Brief again','completed','Another brief','other')`,
		"INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES('m-1','w-team','s-team','r-team-person','user','Brief'),('m-2','w-team','s-team','r-team-person','assistant','The brief')",
		"INSERT INTO run_events(tenant_id,run_id,data) VALUES('w-team','r-team-person','{}'),('w-solo','r-solo','{}')",
		`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES
			('g-team-person','w-team','cv-team','person','g-op-1','h',1,'{}','[]','completed'),
			('g-team-other','w-team','cv-team','other','g-op-2','h',1,'{}','[]','completed'),
			('g-own-person','w-own','cv-own','person','g-op-3','h',1,'{}','[]','failed'),
			('g-solo','w-solo','cv-solo','person','g-op-4','h',1,'{}','[]','completed')`,
		// Other's graph points at the person's run: the run stays, so the pointer does too.
		"INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,run_id,session_id) VALUES('w-team','g-team-other','n',0,'done','r-team-person','s-team'),('w-team','g-team-person','n',0,'done','r-team-person','s-team'),('w-solo','g-solo','n',0,'done','r-solo','s-solo')",
		"INSERT INTO graph_operation_cancellations(tenant_id,canvas_id,operation_id,actor_id) VALUES('w-team','cv-team','g-op-9','person'),('w-own','cv-own','g-op-8','member')",
		`INSERT INTO tenant_invites(id,tenant_id,created_by,role,token_hash,expires_at,accepted_by,accepted_at) VALUES
			('i-sent-pending','w-team','person','reader','th-1',now()+interval '1 day',NULL,NULL),
			('i-accepted','w-team','other','admin','th-2',now()-interval '1 day','person',now()-interval '2 days'),
			('i-member','w-own','person','admin','th-3',now()+interval '1 day','member',now()),
			('i-other','w-team','other','reader','th-4',now()+interval '1 day',NULL,NULL),
			('i-solo','w-solo','person','reader','th-5',now()+interval '1 day',NULL,NULL)`,
		"INSERT INTO artifacts(id,tenant_id,canvas_id,name,size,sha256,content) VALUES('art-solo','w-solo','cv-solo','notes.txt',5,'x','\\x6e6f746573')",
		// A document's current revision is checked at commit, so it is set once the revisions exist.
		"INSERT INTO knowledge_documents(id,tenant_id,kind,title,source_hash) VALUES('kd','w-solo','source','Source','sh')",
		"INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,title,content,content_hash,actor_id) VALUES('kr-1','w-solo','kd',1,'Source','v1','c1','person')",
		"INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,parent_revision_id,title,content,content_hash,actor_id) VALUES('kr-2','w-solo','kd',2,'kr-1','Source','v2','c2','person')",
		"UPDATE knowledge_documents SET current_revision_id='kr-2' WHERE id='kd'",
		"INSERT INTO knowledge_source_origins(tenant_id,document_id,title,provenance,origin_hash,actor_id) VALUES('w-solo','kd','Source','{}','oh','person')",
		"INSERT INTO knowledge_events(tenant_id,actor_id,operation_id,action,resource_id) VALUES('w-solo','person','k-op','knowledge.imported','kd')",
		// Work elsewhere keeps its knowledge.
		"INSERT INTO knowledge_documents(id,tenant_id,kind,title,source_hash) VALUES('kd-team','w-team','source','Team source','sh-team')",
		"INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,title,content,content_hash,actor_id) VALUES('kr-team','w-team','kd-team',1,'Team source','v1','c1','other')",
		"UPDATE knowledge_documents SET current_revision_id='kr-team' WHERE id='kd-team'",
		"INSERT INTO knowledge_source_origins(tenant_id,document_id,title,provenance,origin_hash,actor_id) VALUES('w-team','kd-team','Team source','{}','oh','other')",
		`INSERT INTO audit_events(actor_id,tenant_id,action,resource_id) VALUES
			('person',NULL,'account.deletion_requested','req-1'),('person','w-solo','canvas.created','cv-solo'),
			('person','w-team','member.added','member'),('member','w-own','canvas.updated','cv-own'),
			(NULL,'w-solo','tenant.updated','w-solo')`,
		// An evaluation, a web read and a managed dispatch an API restart (or a lost save) left unsettled hold nothing up.
		`INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata,created_at) VALUES('person','w-team','typesafe.evaluation','ts-old','{"status":"started"}',now()-interval '130 seconds')`,
		"INSERT INTO web_reads(id,tenant_id,actor_id,operation_id,url_hash,host,status,created_at) VALUES('wr-old','w-team','person','wr-old-op','u','example.invalid','started',now()-interval '130 seconds')",
		"INSERT INTO openmaus_dispatches(tenant_id,operation_id,request_hash,actor_id,bot_id,task_id,status,created_at,updated_at) VALUES('w-team','om-old','h','person','b','t','sending',now()-interval '10 minutes',now()-interval '70 seconds')",
		// A finished managed dispatch goes with the deleted workspace.
		"INSERT INTO openmaus_dispatches(tenant_id,operation_id,request_hash,actor_id,bot_id,task_id,status) VALUES('w-solo','om-solo','h','person','b','t','sent')",
		// The member who takes w-own over already owns a workspace of their own.
		"INSERT INTO tenants(id,name) VALUES('w-member','Member alone')",
		"INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES('w-member','member','owner',now()-interval '1 day')",
		"INSERT INTO account_deletion_requests(id,user_id,email,name,reason) VALUES('req-1','person','person@example.invalid','Verified account','Please delete my account')",
		"INSERT INTO user_plans(user_id,plan,status,period_start,period_end,credits) VALUES('person','pro','canceled',now()-interval '40 days',now()-interval '10 days',0)",
		"INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('session-person','person',now()+interval '1 hour'),('session-member','member',now()+interval '1 hour')",
		"INSERT INTO user_connections(id,user_id,provider,runtime,name,secret,models) VALUES('conn','person','openai','pi','Key','\\x00','[]')",
		// A connection key for AwwO 本地版 goes with its account, even in a workspace that stays; the member's stays.
		`INSERT INTO relay_keys(id,user_id,tenant_id,key_hash,prefix,name,expires_at) VALUES
			('rk-person','person','w-team',repeat('a',64),'awwo_rk_aaaa','Laptop',now()+interval '90 days'),
			('rk-member','member','w-own',repeat('b',64),'awwo_rk_bbbb','Desktop',now()+interval '90 days')`,
	} {
		h.exec(t, sql)
	}
}

func fullDeletion() operator.Deletion {
	d := deletionFor("person")
	d.RequestID, d.Transfers, d.Deletes = "req-1", map[string]string{"w-own": "member"}, []string{"w-solo"}
	return d
}

// fingerprint digests every table of the test schema.
func (h *harness) fingerprint(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, table := range h.catalog(t, "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY 1") {
		var sum string
		if err := h.db.QueryRow(h.ctx, "SELECT md5(COALESCE(string_agg(t::text,'|' ORDER BY t::text),'')) FROM "+pgx.Identifier{table}.Sanitize()+" t").Scan(&sum); err != nil {
			t.Fatal(err)
		}
		out[table] = sum
	}
	out["trigger"] = strings.Join(h.catalog(t, "SELECT tgname, tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace=to_regnamespace(current_schema())) ORDER BY 1"), ";")
	return out
}

func refused(t *testing.T, err error, blocker string) {
	t.Helper()
	var r *operator.RefusedError
	if !errors.Is(err, operator.ErrRefused) || !errors.As(err, &r) || !slices.Contains(r.Blockers, blocker) {
		t.Fatalf("wanted refusal %s, got %v", blocker, err)
	}
}

func TestPostgresDeletionPreviewsAndRefusalsChangeNothing(t *testing.T) {
	h := database(t)
	seedAccount(t, h)
	before := h.fingerprint(t)
	// Without the pending request named, or a choice for the two workspaces it alone owns, the preview says so.
	bare := deletionFor("person")
	p, err := h.store.DeleteAccount(h.ctx, bare, actor, false)
	if err != nil || p.Applied || p.AuditID != 0 || !slices.Equal(p.Blockers, []string{"deletion_request_not_named:req-1", "workspace_undecided:w-own", "workspace_undecided:w-solo"}) ||
		p.Account.LatestRequestID != "req-1" || p.Account.LatestRequestStatus != "pending" {
		t.Fatal(p, err)
	}
	refused(t, func() error { _, err := h.store.DeleteAccount(h.ctx, bare, actor, true); return err }(), "workspace_undecided:w-own")
	d := fullDeletion()
	p, err = h.store.DeleteAccount(h.ctx, d, actor, false)
	if err != nil || len(p.Blockers) != 0 || p.Applied {
		t.Fatal(p, err)
	}
	outcomes := map[string]string{}
	for _, w := range p.Workspaces {
		outcomes[w.ID] = w.Outcome + ":" + w.Owner
		if w.ID == "w-own" && (w.NewOwnerOwnsAfter != 2 || w.NewOwnerRoleBefore != "admin" || w.NewOwnerIsAdmin || w.OtherMembers != 1) {
			t.Fatal("the handover's new owner", w)
		}
	}
	if !reflect.DeepEqual(outcomes, map[string]string{"w-own": "transfer:member", "w-solo": "delete:", "w-team": "leave:other"}) ||
		p.Account.PlanStatus != "canceled" || p.Account.Sessions != 1 || p.Account.Connections != 1 || p.Account.RelayKeys != 1 || p.Account.DeletionRequests != 1 || p.Account.IdentityLinks != 1 {
		t.Fatal("preview", p.Workspaces, p.Account)
	}
	want := operator.DeletionRows{WorkspacesTransferred: 1, WorkspacesDeleted: 1, CanvasesDeleted: 1, KnowledgeOriginsDeleted: 1, AuditEventsDetached: 2,
		RunsUnnamed: 2, GraphRunsReassigned: 2, GraphCancellationsReassigned: 1, InvitationsDeleted: 4, AuditEventsUnnamed: 4, MembershipsDeleted: 3, UsersDeleted: 1}
	if p.Rows != want {
		t.Fatalf("planned rows\n got %+v\nwant %+v", p.Rows, want)
	}
	for name, c := range map[string]struct {
		setup, undo, blocker string
		change               func(*operator.Deletion)
	}{
		"live plan":            {"UPDATE user_plans SET status='active' WHERE user_id='person'", "UPDATE user_plans SET status='canceled' WHERE user_id='person'", "paid_plan_live", nil},
		"past due plan":        {"UPDATE user_plans SET status='past_due' WHERE user_id='person'", "UPDATE user_plans SET status='canceled' WHERE user_id='person'", "paid_plan_live", nil},
		"paused plan":          {"UPDATE user_plans SET status='paused' WHERE user_id='person'", "UPDATE user_plans SET status='canceled' WHERE user_id='person'", "paid_plan_live", nil},
		"trialing plan":        {"UPDATE user_plans SET status='trialing' WHERE user_id='person'", "UPDATE user_plans SET status='canceled' WHERE user_id='person'", "paid_plan_live", nil},
		"incomplete plan":      {"UPDATE user_plans SET status='incomplete' WHERE user_id='person'", "UPDATE user_plans SET status='canceled' WHERE user_id='person'", "paid_plan_live", nil},
		"unpaid plan":          {"UPDATE user_plans SET status='unpaid' WHERE user_id='person'", "UPDATE user_plans SET status='canceled' WHERE user_id='person'", "paid_plan_live", nil},
		"declined request":     {"UPDATE account_deletion_requests SET status='declined',decided_at=now(),decision_note='No' WHERE id='req-1'", "UPDATE account_deletion_requests SET status='pending',decided_at=NULL,decision_note='' WHERE id='req-1'", "deletion_request_not_pending", nil},
		"handled request":      {"UPDATE account_deletion_requests SET status='handled',decided_at=now() WHERE id='req-1'", "UPDATE account_deletion_requests SET status='pending',decided_at=NULL WHERE id='req-1'", "deletion_request_not_pending", nil},
		"request not named":    {"", "", "deletion_request_not_named:req-1", func(v *operator.Deletion) { v.RequestID = "" }},
		"withdrawn, not named": {"UPDATE account_deletion_requests SET status='withdrawn',withdrawn_at=now() WHERE id='req-1'", "UPDATE account_deletion_requests SET status='pending',withdrawn_at=NULL WHERE id='req-1'", "deletion_request_withdrawn:req-1", func(v *operator.Deletion) { v.RequestID = "" }},
		"declined, not named":  {"UPDATE account_deletion_requests SET status='declined',decided_at=now(),decision_note='No' WHERE id='req-1'", "UPDATE account_deletion_requests SET status='pending',decided_at=NULL,decision_note='' WHERE id='req-1'", "deletion_request_declined:req-1", func(v *operator.Deletion) { v.RequestID = "" }},
		"named after person":   {"UPDATE tenants SET name='Verified account · AwwO' WHERE id='w-own'", "UPDATE tenants SET name='Person shared' WHERE id='w-own'", "workspace_needs_new_name:w-own", nil},
		"renamed after person": {"", "", "workspace_needs_new_name:w-own", func(v *operator.Deletion) { v.Renames = map[string]string{"w-own": "Verified account · AwwO"} }},
		// Just inside each bound, unsettled work still counts.
		"evaluation at 100 s":       {`INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata,created_at) VALUES('person','w-team','typesafe.evaluation','ts-100','{"status":"started"}',now()-interval '100 seconds')`, "DELETE FROM audit_events WHERE resource_id='ts-100'", "active_work", nil},
		"web read at 100 s":         {"INSERT INTO web_reads(id,tenant_id,actor_id,operation_id,url_hash,host,status,created_at) VALUES('wr-100','w-team','person','wr-100-op','u','example.invalid','started',now()-interval '100 seconds')", "DELETE FROM web_reads WHERE id='wr-100'", "active_work", nil},
		"dispatch updated 30 s ago": {"INSERT INTO openmaus_dispatches(tenant_id,operation_id,request_hash,actor_id,bot_id,task_id,status,created_at,updated_at) VALUES('w-team','om-30','h','person','b','t','sending',now()-interval '10 minutes',now()-interval '30 seconds')", "DELETE FROM openmaus_dispatches WHERE operation_id='om-30'", "active_work", nil},
		// A superseded request must be the account's latest, withdrawn or declined.
		"supersede another":       {"UPDATE account_deletion_requests SET status='withdrawn',withdrawn_at=now() WHERE id='req-1'", "UPDATE account_deletion_requests SET status='pending',withdrawn_at=NULL WHERE id='req-1'", "deletion_request_not_superseded:req-other", func(v *operator.Deletion) { v.RequestID, v.Supersedes = "", "req-other" }},
		"supersede a pending one": {"", "", "deletion_request_not_superseded:req-1", func(v *operator.Deletion) { v.RequestID, v.Supersedes = "", "req-1" }},
		"supersede an older one": {"INSERT INTO account_deletion_requests(id,user_id,email,status,created_at,withdrawn_at) VALUES('req-0','person','person@example.invalid','withdrawn',now()-interval '10 days',now()-interval '9 days'); UPDATE account_deletion_requests SET status='withdrawn',withdrawn_at=now() WHERE id='req-1'",
			"DELETE FROM account_deletion_requests WHERE id='req-0'; UPDATE account_deletion_requests SET status='pending',withdrawn_at=NULL WHERE id='req-1'", "deletion_request_not_superseded:req-0",
			func(v *operator.Deletion) { v.RequestID, v.Supersedes = "", "req-0" }},
		"open checkout":        {"INSERT INTO plan_watches(user_id,until) VALUES('person',now()+interval '1 day')", "DELETE FROM plan_watches WHERE user_id='person'", "plan_checkout_open", nil},
		"queued run":           {"UPDATE runs SET status='queued' WHERE id='r-team-person'", "UPDATE runs SET status='completed' WHERE id='r-team-person'", "active_work", nil},
		"running graph":        {"UPDATE graph_runs SET status='running' WHERE id='g-team-person'", "UPDATE graph_runs SET status='completed' WHERE id='g-team-person'", "active_work", nil},
		"render":               {"INSERT INTO render_jobs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,status,params,html_sha256,html_bytes) VALUES('rj','w-team','cv-team','person','rj-op','h','running','{}','x',1)", "DELETE FROM render_jobs WHERE id='rj'", "active_work", nil},
		"web read":             {"INSERT INTO web_reads(id,tenant_id,actor_id,operation_id,url_hash,host,status) VALUES('wr','w-team','person','wr-op','u','example.invalid','started')", "DELETE FROM web_reads WHERE id='wr'", "active_work", nil},
		"managed dispatch":     {"INSERT INTO openmaus_dispatches(tenant_id,operation_id,request_hash,actor_id,bot_id,task_id,status) VALUES('w-team','om-op','h','person','b','t','sending')", "DELETE FROM openmaus_dispatches WHERE operation_id='om-op'", "active_work", nil},
		"paid call":            {"INSERT INTO model_invocations(id,tenant_id,run_id,status,billed_user_id) VALUES('mi','w-team','r-team-other','running','person')", "DELETE FROM model_invocations WHERE id='mi'", "active_work", nil},
		"busy shared":          {"UPDATE runs SET status='running' WHERE id='r-own-member'", "UPDATE runs SET status='completed' WHERE id='r-own-member'", "workspace_busy:w-own", nil},
		"busy solo":            {"INSERT INTO web_reads(id,tenant_id,actor_id,operation_id,url_hash,host,status) VALUES('wr2','w-solo',NULL,'wr-op2','u','example.invalid','started')", "DELETE FROM web_reads WHERE id='wr2'", "workspace_busy:w-solo", nil},
		"busy graph":           {"INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES('g-busy','w-own','cv-own','member','g-busy','h',1,'{}','[]','queued')", "DELETE FROM graph_runs WHERE id='g-busy'", "workspace_busy:w-own", nil},
		"busy render":          {"INSERT INTO render_jobs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,status,params,html_sha256,html_bytes) VALUES('rj2','w-solo','cv-solo',NULL,'rj-op2','h','queued','{}','x',1)", "DELETE FROM render_jobs WHERE id='rj2'", "workspace_busy:w-solo", nil},
		"busy edit":            {"INSERT INTO edit_jobs(id,tenant_id,canvas_id,graph_id,node_id,status,timeline) VALUES('ej','w-solo','cv-solo','g-solo','edit','running','{}')", "DELETE FROM edit_jobs WHERE id='ej'", "workspace_busy:w-solo", nil},
		"busy dispatch":        {"INSERT INTO openmaus_dispatches(tenant_id,operation_id,request_hash,actor_id,bot_id,task_id,status) VALUES('w-own','om-op2','h','member','b','t','sending')", "DELETE FROM openmaus_dispatches WHERE operation_id='om-op2'", "workspace_busy:w-own", nil},
		"busy call":            {"INSERT INTO model_invocations(id,tenant_id,run_id,status) VALUES('mi2','w-own','r-own-member','running')", "DELETE FROM model_invocations WHERE id='mi2'", "workspace_busy:w-own", nil},
		"evaluation":           {`INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata) VALUES('person','w-team','typesafe.evaluation','ts-now','{"status":"started"}')`, "DELETE FROM audit_events WHERE resource_id='ts-now'", "active_work", nil},
		"busy evaluation":      {`INSERT INTO audit_events(actor_id,tenant_id,action,resource_id,metadata) VALUES('member','w-own','typesafe.evaluation','ts-own','{"status":"started"}')`, "DELETE FROM audit_events WHERE resource_id='ts-own'", "workspace_busy:w-own", nil},
		"administrator":        {"UPDATE users SET platform_role='admin' WHERE id='person'", "UPDATE users SET platform_role='user' WHERE id='person'", "platform_admin", nil},
		"withdrawn request":    {"UPDATE account_deletion_requests SET status='withdrawn',withdrawn_at=now() WHERE id='req-1'", "UPDATE account_deletion_requests SET status='pending',withdrawn_at=NULL WHERE id='req-1'", "deletion_request_not_pending", nil},
		"another's request":    {"INSERT INTO account_deletion_requests(id,user_id,email) VALUES('req-other','other','other@example.invalid')", "DELETE FROM account_deletion_requests WHERE id='req-other'", "deletion_request_other_account", func(v *operator.Deletion) { v.RequestID = "req-other" }},
		"unknown request":      {"", "", "deletion_request_not_found", func(v *operator.Deletion) { v.RequestID = "req-missing" }},
		"not a member":         {"", "", "transfer_target_not_member:w-own", func(v *operator.Deletion) { v.Transfers = map[string]string{"w-own": "other"} }},
		"not solely owned":     {"", "", "workspace_not_solely_owned:w-team", func(v *operator.Deletion) { v.Deletes = append(v.Deletes, "w-team") }},
		"unknown workspace":    {"", "", "workspace_not_found:w-missing", func(v *operator.Deletion) { v.Deletes = append(v.Deletes, "w-missing") }},
		"a second owner stays": {"UPDATE memberships SET role='owner' WHERE tenant_id='w-own' AND user_id='member'", "UPDATE memberships SET role='admin' WHERE tenant_id='w-own' AND user_id='member'", "workspace_not_solely_owned:w-own", nil},
		// Nobody could take the person's graph rows in a team without an owner.
		"team without owner": {"UPDATE memberships SET role='admin' WHERE tenant_id='w-team' AND user_id='other'", "UPDATE memberships SET role='owner' WHERE tenant_id='w-team' AND user_id='other'", "workspace_without_owner:w-team", nil},
	} {
		t.Run(name, func(t *testing.T) {
			if c.setup != "" {
				h.exec(t, c.setup)
				defer h.exec(t, c.undo)
			}
			v := fullDeletion()
			if c.change != nil {
				c.change(&v)
			}
			preview, err := h.store.DeleteAccount(h.ctx, v, actor, false)
			if err != nil || !slices.Contains(preview.Blockers, c.blocker) {
				t.Fatal(preview.Blockers, err)
			}
			_, err = h.store.DeleteAccount(h.ctx, v, actor, true)
			refused(t, err, c.blocker)
		})
	}
	other := d
	other.Email = "other@example.invalid"
	if _, err = h.store.DeleteAccount(h.ctx, other, actor, true); !errors.Is(err, operator.ErrIdentity) {
		t.Fatal("deleted an account by the wrong email", err)
	}
	missing := deletionFor("nobody")
	if _, err = h.store.DeleteAccount(h.ctx, missing, actor, false); !errors.Is(err, operator.ErrIdentity) {
		t.Fatal("previewed a missing account", err)
	}
	if _, err = h.store.DeleteAccount(h.ctx, d, operator.Actor{UID: 501, EffectiveUID: 501, Host: "host"}, true); !errors.Is(err, operator.ErrOperator) {
		t.Fatal("applied as an unprivileged OS user", err)
	}
	if after := h.fingerprint(t); !reflect.DeepEqual(after, before) {
		for table := range before {
			if after[table] != before[table] {
				t.Error("changed:", table)
			}
		}
		t.Fatal("a preview or a refusal changed the database")
	}
}

func (h *harness) count(t *testing.T, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := h.db.QueryRow(h.ctx, sql, args...).Scan(&n); err != nil {
		t.Fatal(sql, err)
	}
	return n
}

func TestPostgresDeletionKeepsSharedWorkAndReplays(t *testing.T) {
	h := database(t)
	seedAccount(t, h)
	d := fullDeletion()
	preview, err := h.store.DeleteAccount(h.ctx, d, actor, false)
	if err != nil {
		t.Fatal(err)
	}
	audits := h.count(t, "SELECT count(*) FROM audit_events")
	done, err := h.store.DeleteAccount(h.ctx, d, actor, true)
	if err != nil || !done.Applied || done.Replayed || done.AuditID == 0 || len(done.Blockers) != 0 {
		t.Fatal(done, err)
	}
	if done.Rows != preview.Rows {
		t.Fatalf("applied rows differ from the preview\n got %+v\nwant %+v", done.Rows, preview.Rows)
	}
	for sql, want := range map[string]int64{
		// The account and everything it alone held.
		"SELECT count(*) FROM users WHERE id='person'":                    0,
		"SELECT count(*) FROM memberships WHERE user_id='person'":         0,
		"SELECT count(*) FROM auth_sessions WHERE user_id='person'":       0,
		"SELECT count(*) FROM external_identities WHERE user_id='person'": 0,
		"SELECT count(*) FROM user_connections WHERE user_id='person'":    0,
		"SELECT count(*) FROM relay_keys WHERE user_id='person'":          0,
		"SELECT count(*) FROM user_plans WHERE user_id='person'":          0,
		// The workspace it alone owned, with everything in it.
		"SELECT count(*) FROM tenants WHERE id='w-solo'":                                             0,
		"SELECT count(*) FROM canvases WHERE tenant_id='w-solo'":                                     0,
		"SELECT count(*) FROM runs WHERE tenant_id='w-solo'":                                         0,
		"SELECT count(*) FROM artifacts WHERE tenant_id='w-solo'":                                    0,
		"SELECT count(*) FROM graph_runs WHERE tenant_id='w-solo'":                                   0,
		"SELECT count(*) FROM knowledge_documents WHERE tenant_id='w-solo'":                          0,
		"SELECT count(*) FROM knowledge_revisions WHERE tenant_id='w-solo'":                          0,
		"SELECT count(*) FROM knowledge_source_origins WHERE tenant_id='w-solo'":                     0,
		"SELECT count(*) FROM knowledge_events WHERE tenant_id='w-solo'":                             0,
		"SELECT count(*) FROM tenant_invites WHERE tenant_id='w-solo'":                               0,
		"SELECT count(*) FROM openmaus_dispatches WHERE tenant_id='w-solo'":                          0,
		"SELECT count(*) FROM openmaus_dispatches WHERE operation_id='om-old' AND actor_id='person'": 1,
		// Its audit rows stay, without the workspace, and the deletion request's row without the account.
		"SELECT count(*) FROM audit_events WHERE resource_id IN ('cv-solo','w-solo') AND tenant_id IS NULL":                                           2,
		"SELECT count(*) FROM audit_events WHERE action='account.deletion_requested' AND resource_id='req-1' AND actor_id IS NULL":                    1,
		"SELECT count(*) FROM audit_events WHERE actor_id='person'":                                                                                   0,
		"SELECT count(*) FROM account_deletion_requests WHERE id='req-1' AND user_id IS NULL AND status='pending' AND email='person@example.invalid'": 1,
		// The shared workspace it owned is the member's now, and keeps the person's run, unnamed.
		"SELECT count(*) FROM memberships WHERE tenant_id='w-own' AND user_id='member' AND role='owner'": 1,
		"SELECT count(*) FROM memberships WHERE tenant_id='w-own'":                                       1,
		"SELECT count(*) FROM runs WHERE id='r-own-person' AND actor_id IS NULL AND output='The plan'":   1,
		"SELECT count(*) FROM runs WHERE id='r-own-member' AND actor_id='member'":                        1,
		"SELECT count(*) FROM graph_runs WHERE id='g-own-person' AND actor_id='member'":                  1,
		"SELECT count(*) FROM tenant_invites WHERE id='i-member'":                                        0,
		"SELECT count(*) FROM audit_events WHERE action='admin.operator_workspace_transferred' AND tenant_id='w-own' AND resource_id='w-own' AND actor_id IS NULL AND metadata->>'newOwner'='member'": 1,
		// The other team keeps the person's work: the run and its messages, unnamed; the graph and its cancellation, the owner's.
		"SELECT count(*) FROM runs WHERE id='r-team-person' AND actor_id IS NULL":                              1,
		"SELECT count(*) FROM messages WHERE run_id='r-team-person'":                                           2,
		"SELECT count(*) FROM graph_runs WHERE id='g-team-person' AND actor_id='other'":                        1,
		"SELECT count(*) FROM graph_run_nodes WHERE graph_id='g-team-other' AND run_id='r-team-person'":        1,
		"SELECT count(*) FROM graph_operation_cancellations WHERE operation_id='g-op-9' AND actor_id='other'":  1,
		"SELECT count(*) FROM graph_operation_cancellations WHERE operation_id='g-op-8' AND actor_id='member'": 1,
		"SELECT count(*) FROM tenant_invites WHERE id IN ('i-sent-pending','i-accepted')":                      0,
		"SELECT count(*) FROM tenant_invites WHERE id='i-other'":                                               1,
		"SELECT count(*) FROM knowledge_source_origins WHERE tenant_id='w-team'":                               1,
		"SELECT count(*) FROM memberships WHERE tenant_id='w-team'":                                            2,
		"SELECT count(*) FROM auth_sessions WHERE user_id='member'":                                            1,
		"SELECT count(*) FROM relay_keys WHERE user_id='member' AND tenant_id='w-own'":                         1,
	} {
		if got := h.count(t, sql); got != want {
			t.Errorf("%s = %d, want %d", sql, got, want)
		}
	}
	// The workspace handed over is the new owner's newest, so it pushes none of their own out of their plan.
	if owned := h.catalog(t, "SELECT tenant_id FROM memberships WHERE user_id='member' AND role='owner' ORDER BY created_at,tenant_id"); !slices.Equal(owned, []string{"w-member", "w-own"}) ||
		h.count(t, "SELECT count(*) FROM memberships WHERE tenant_id='w-own' AND user_id='member' AND created_at>now()-interval '1 minute'") != 1 {
		t.Fatal("the handover kept the new owner's join date", owned)
	}
	// One deletion row and one handover row; nothing else written, nothing deleted.
	if got := h.count(t, "SELECT count(*) FROM audit_events"); got != audits+2 {
		t.Fatal("audit rows", got, audits)
	}
	var raw []byte
	if err = h.db.QueryRow(h.ctx, "SELECT metadata FROM audit_events WHERE id=$1 AND action='admin.operator_account_deleted' AND actor_id IS NULL AND tenant_id IS NULL AND resource_id='person'", done.AuditID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if json.Unmarshal(raw, &record) != nil || record["reason"] != d.Reason || record["requestId"] != "req-1" || record["operator"].(map[string]any)["effectiveUid"] != float64(0) {
		t.Fatal("deletion record", string(raw))
	}
	// The immutable knowledge origins of the workspaces that stay are as protected as before.
	if _, err = h.db.Exec(h.ctx, "DELETE FROM knowledge_source_origins WHERE tenant_id='w-team'"); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatal("the origins trigger is off", err)
	}
	// A retry with the same operation returns the receipt; other arguments, or a role command, cannot reuse it.
	again, err := h.store.DeleteAccount(h.ctx, d, actor, true)
	if err != nil || !again.Replayed || again.AuditID != done.AuditID || again.Rows != done.Rows || h.count(t, "SELECT count(*) FROM audit_events") != audits+2 {
		t.Fatal(again, err)
	}
	if preview, err := h.store.DeleteAccount(h.ctx, d, actor, false); err != nil || !preview.Replayed {
		t.Fatal("a preview of a done deletion", preview, err)
	}
	changed := d
	changed.Reason = "Another reason"
	if _, err = h.store.DeleteAccount(h.ctx, changed, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("reused the operation for other arguments", err)
	}
	g := grantFor("other")
	g.OperationID = d.OperationID
	if _, err = h.store.Grant(h.ctx, g, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("a grant reused the deletion's operation", err)
	}
	if h.role(t, "other") != "user" {
		t.Fatal("the reused operation changed a role")
	}
	// An account under the deleted id again (only by hand: ids are random) is not what the record says was deleted.
	h.exec(t, "INSERT INTO users(id,email,name,password_hash) VALUES('person','person@example.invalid','Again','synthetic-password-hash')")
	if _, err = h.store.DeleteAccount(h.ctx, d, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("replayed a deletion over an account that exists", err)
	}
}

// The workspaces to hand over or delete are locked as the API locks one to admit work, so a deletion never runs beside
// an admission there: it waits for it (and gives up after the lock timeout, changing nothing).
func TestPostgresDeletionWaitsForAWorkspaceInUse(t *testing.T) {
	h := database(t)
	seedAccount(t, h)
	before := h.fingerprint(t)
	admission, err := h.db.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Rollback(h.ctx)
	if _, err = admission.Exec(h.ctx, "SELECT 1 FROM tenants WHERE id='w-own' FOR UPDATE"); err != nil {
		t.Fatal(err)
	}
	if _, err = h.store.DeleteAccount(h.ctx, fullDeletion(), actor, true); !errors.Is(err, operator.ErrDatabase) {
		t.Fatal("handed over a workspace while an admission held it", err)
	}
	if err = admission.Rollback(h.ctx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(h.fingerprint(t), before) {
		t.Fatal("a deletion that gave up changed the database")
	}
	if done, err := h.store.DeleteAccount(h.ctx, fullDeletion(), actor, true); err != nil || !done.Applied {
		t.Fatal(done, err)
	}
}

// The lock comes before the checks: work an admission commits while the deletion waits for the workspace is seen, and
// refused, rather than checked too early and run beside.
func TestPostgresDeletionChecksAWorkspaceAfterItsAdmission(t *testing.T) {
	h := database(t)
	seedAccount(t, h)
	admission, err := h.db.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Rollback(h.ctx)
	if _, err = admission.Exec(h.ctx, "SELECT 1 FROM tenants WHERE id='w-own' FOR UPDATE"); err != nil {
		t.Fatal(err)
	}
	if _, err = admission.Exec(h.ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,actor_id) VALUES('r-admitted','w-own','s-own','op-admitted','h','Run now','running','member')"); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := h.store.DeleteAccount(h.ctx, fullDeletion(), actor, true)
		result <- err
	}()
	// The admission commits once the deletion waits for the workspace's lock, well inside its 2 s lock timeout.
	h.seenWaiting(t, "%FROM tenants WHERE id = ANY%FOR UPDATE%", result)
	if err = admission.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	refused(t, <-result, "workspace_busy:w-own")
	if h.count(t, "SELECT count(*) FROM users WHERE id='person'") != 1 || h.count(t, "SELECT count(*) FROM memberships WHERE tenant_id='w-own' AND user_id='person' AND role='owner'") != 1 {
		t.Fatal("the deletion ran beside an admission")
	}
}

// seenWaiting polls until the deletion waits for a lock in a statement like the pattern, on this test's own connections
// (another test run may share the database). The change it waits for took its lock before the deletion started, so a
// deletion that answers first, or does not wait within 10 s, fails the test.
func (h *harness) seenWaiting(t *testing.T, like string, result chan error) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline) && len(result) == 0; time.Sleep(20 * time.Millisecond) {
		if h.count(t, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name=$2 AND wait_event_type='Lock' AND query LIKE $1", like, h.schema) > 0 {
			return
		}
	}
	t.Fatal("the deletion was not seen waiting in", like)
}

// beside runs change (uncommitted) in another transaction, starts the deletion, commits the change once the deletion waits
// for its row (a statement like waitLike), and returns what the deletion answered.
func (h *harness) beside(t *testing.T, change, waitLike, then string, d operator.Deletion) error {
	t.Helper()
	other, err := h.db.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Rollback(h.ctx)
	if _, err = other.Exec(h.ctx, change); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := h.store.DeleteAccount(h.ctx, d, actor, true)
		result <- err
	}()
	h.seenWaiting(t, waitLike, result)
	// What the other transaction does next must not wait for the deletion, which is waiting for it.
	if then != "" {
		if _, err = other.Exec(h.ctx, "SET LOCAL statement_timeout='1s'"); err != nil {
			t.Fatal(err)
		}
		if _, err = other.Exec(h.ctx, then); err != nil {
			t.Fatal("the deletion held what the change needed next:", err)
		}
	}
	if err = other.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	return <-result
}

// A change committed while the deletion holds its checks wins: the deletion waits for the row and reads it again.
func TestPostgresDeletionWaitsForChangesToWhatItChecks(t *testing.T) {
	for name, c := range map[string]struct{ change, waitLike, then, blocker string }{
		// As withdrawDeletion runs (preferences.go): the request, then an audit row naming the account.
		"a withdrawal": {"UPDATE account_deletion_requests SET status='withdrawn',withdrawn_at=now() WHERE id='req-1'", "%FROM account_deletion_requests WHERE user_id=$1 OR id=$2%",
			"INSERT INTO audit_events(actor_id,action,resource_id) VALUES('person','account.deletion_withdrawn','req-1')", "deletion_request_not_pending"},
		"a plan sync": {"UPDATE user_plans SET status='active' WHERE user_id='person'", "%FROM user_plans WHERE user_id=$1 FOR UPDATE%", "", "paid_plan_live"},
		// A writer of the membership row itself; the API's member removal locks the workspace first (the next case).
		"a member removed": {"DELETE FROM memberships WHERE tenant_id='w-own' AND user_id='member'", "%FOR UPDATE OF m%", "", "transfer_target_not_member:w-own"},
		// As changeMember runs (resources.go), with the person removing the member: the workspace, the membership, then
		// an audit row naming the person.
		"a member removed through the API": {"SELECT status FROM tenants WHERE id='w-own' FOR UPDATE", "%FROM tenants WHERE id = ANY%FOR UPDATE%",
			"DELETE FROM memberships WHERE tenant_id='w-own' AND user_id='member'; INSERT INTO audit_events(actor_id,tenant_id,action,resource_id) VALUES('person','w-own','member.removed','member')",
			"transfer_target_not_member:w-own"},
		"a checkout": {"UPDATE plan_watches SET until=now()+interval '1 day' WHERE user_id='person'", "%FROM plan_watches WHERE user_id=$1 FOR UPDATE%", "", "plan_checkout_open"},
	} {
		t.Run(name, func(t *testing.T) {
			h := database(t)
			seedAccount(t, h)
			h.exec(t, "INSERT INTO plan_watches(user_id,until) VALUES('person',now()-interval '1 day')")
			refused(t, h.beside(t, c.change, c.waitLike, c.then, fullDeletion()), c.blocker)
			if h.count(t, "SELECT count(*) FROM users WHERE id='person'") != 1 {
				t.Fatal("deleted beside the change")
			}
		})
	}
	// A row naming the account written as the deletion starts (an invitation accepted) waits for the account's lock,
	// and is then deleted with it.
	t.Run("a membership", func(t *testing.T) {
		h := database(t)
		seedAccount(t, h)
		if err := h.beside(t, "INSERT INTO memberships(tenant_id,user_id,role) VALUES('w-member','person','reader')", "%FROM users WHERE id=$1 FOR UPDATE%", "", fullDeletion()); err != nil {
			t.Fatal(err)
		}
		if h.count(t, "SELECT count(*) FROM users WHERE id='person'")+h.count(t, "SELECT count(*) FROM memberships WHERE user_id='person'") != 0 {
			t.Fatal("the account or its new membership stayed")
		}
	})
}

// A record whose shape this tool does not know is not replayed.
func TestPostgresDeletionReplaysOnlyItsOwnRecord(t *testing.T) {
	h := database(t)
	seedAccount(t, h)
	d := fullDeletion()
	d.Renames = map[string]string{"w-own": "Team after"}
	done, err := h.store.DeleteAccount(h.ctx, d, actor, true)
	if err != nil {
		t.Fatal(err)
	}
	var names int64
	if err = h.db.QueryRow(h.ctx, "SELECT count(*) FROM audit_events, jsonb_array_elements(metadata->'workspaces') w WHERE id=$1 AND (w ? 'name' OR w ? 'renamedTo')", done.AuditID).Scan(&names); err != nil || names != 0 {
		t.Fatal("the record keeps workspace names", names, err)
	}
	if h.count(t, "SELECT count(*) FROM audit_events, jsonb_array_elements(metadata->'workspaces') w WHERE id=$1 AND w->>'id'='w-own' AND (w->>'renamed')::boolean", done.AuditID) != 1 ||
		h.count(t, "SELECT count(*) FROM tenants WHERE id='w-own' AND name='Team after'") != 1 {
		t.Fatal("the rename is not on record")
	}
	if done.Workspaces[0].Name == "" {
		t.Fatal("the receipt lacks the workspace names", done.Workspaces)
	}
	h.exec(t, "UPDATE audit_events SET metadata=jsonb_set(metadata,'{version}','2') WHERE id=$1", done.AuditID)
	if _, err = h.store.DeleteAccount(h.ctx, d, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("replayed a record of another version", err)
	}
}

// The workspace an account was created with is found by its date, the account's own (sign-up writes both at once):
// after a change of the profile name, its name no longer matches the person's, and it still needs a name before it is
// handed over. The person's membership there is dated later, as one from before migration 005 is.
func TestPostgresDeletionNamesTheFirstWorkspace(t *testing.T) {
	h := database(t)
	for _, sql := range []string{
		"INSERT INTO users(id,email,name,password_hash) VALUES('member','member@example.invalid','Member','synthetic-password-hash')",
		"INSERT INTO tenants(id,name,created_at) SELECT 'w-first','Old name · AwwO',created_at FROM users WHERE id='person'",
		"INSERT INTO tenants(id,name) VALUES('w-later','Later')",
		"INSERT INTO memberships(tenant_id,user_id,role) VALUES('w-first','person','owner'),('w-later','person','owner'),('w-first','member','admin'),('w-later','member','member')",
	} {
		h.exec(t, sql)
	}
	d := deletionFor("person")
	d.Transfers = map[string]string{"w-first": "member", "w-later": "member"}
	p, err := h.store.DeleteAccount(h.ctx, d, actor, false)
	if err != nil || !slices.Equal(p.Blockers, []string{"workspace_needs_new_name:w-first"}) {
		t.Fatal(p.Blockers, err)
	}
	for _, w := range p.Workspaces {
		if (w.ID == "w-first") != w.FirstOfPerson || w.Name == "" {
			t.Fatal("the first workspace", w)
		}
	}
	// A first workspace named as a first ClawHunt sign-in names one cannot keep that name, the person's former one.
	d.Renames = map[string]string{"w-first": "Old name · AwwO"}
	if p, err = h.store.DeleteAccount(h.ctx, d, actor, false); err != nil || !slices.Equal(p.Blockers, []string{"workspace_needs_new_name:w-first"}) {
		t.Fatal("its own name again", p.Blockers, err)
	}
	// Any other workspace keeps its own name given again, and that is no rename.
	d.Renames = map[string]string{"w-first": "Team", "w-later": "Later"}
	done, err := h.store.DeleteAccount(h.ctx, d, actor, true)
	if err != nil || done.Rows.WorkspacesTransferred != 2 {
		t.Fatal(done, err)
	}
	for _, w := range done.Workspaces {
		if w.Renamed != (w.ID == "w-first") || (w.RenamedTo != "") != w.Renamed {
			t.Fatal("which workspace was renamed", w)
		}
	}
	if names := h.catalog(t, "SELECT name FROM tenants WHERE id IN ('w-first','w-later') ORDER BY id"); !slices.Equal(names, []string{"Team", "Later"}) {
		t.Fatal(names)
	}
	if h.count(t, "SELECT count(*) FROM audit_events WHERE action='admin.operator_workspace_transferred' AND tenant_id='w-later' AND metadata->>'renamed'='false'") != 1 {
		t.Fatal("a kept name is recorded as a rename")
	}
}

// A request by email after a withdrawal in the app goes ahead only when the operator names the withdrawn request as
// superseded; the record keeps which.
func TestPostgresDeletionHonoursARequestThatSupersedesAWithdrawal(t *testing.T) {
	h := database(t)
	seedAccount(t, h)
	d := fullDeletion()
	d.RequestID, d.Supersedes = "", "req-1"
	h.exec(t, "UPDATE account_deletion_requests SET status='declined',decided_at=now(),decision_note='No' WHERE id='req-1'")
	if p, err := h.store.DeleteAccount(h.ctx, d, actor, false); err != nil || len(p.Blockers) != 0 || p.Supersedes != "req-1" {
		t.Fatal("a declined request superseded", p.Blockers, err)
	}
	h.exec(t, "UPDATE account_deletion_requests SET status='withdrawn',withdrawn_at=now(),decided_at=NULL,decision_note='' WHERE id='req-1'")
	d.Supersedes = ""
	if p, err := h.store.DeleteAccount(h.ctx, d, actor, false); err != nil || !slices.Equal(p.Blockers, []string{"deletion_request_withdrawn:req-1"}) {
		t.Fatal(p.Blockers, err)
	}
	d.Supersedes = "req-1"
	done, err := h.store.DeleteAccount(h.ctx, d, actor, true)
	if err != nil || !done.Applied || done.Supersedes != "req-1" {
		t.Fatal(done, err)
	}
	if again, err := h.store.DeleteAccount(h.ctx, d, actor, true); err != nil || !again.Replayed || again.Supersedes != "req-1" {
		t.Fatal("the replay", again, err)
	}
	// The superseded request is part of the operation: the same operation without it is another one.
	other := d
	other.Supersedes = ""
	if _, err = h.store.DeleteAccount(h.ctx, other, actor, true); !errors.Is(err, operator.ErrConflict) {
		t.Fatal("an operation reused without its superseded request", err)
	}
	if h.count(t, "SELECT count(*) FROM audit_events WHERE id=$1 AND metadata->>'supersedesRequest'='req-1'", done.AuditID) != 1 ||
		h.count(t, "SELECT count(*) FROM account_deletion_requests WHERE id='req-1' AND user_id IS NULL AND status='withdrawn'") != 1 {
		t.Fatal("the superseded request is not on record")
	}
}

// Two workspaces handed to one member both count in the receipt, and both become theirs after what they owned.
func TestPostgresDeletionHandsTwoWorkspacesToOneMember(t *testing.T) {
	h := database(t)
	for _, sql := range []string{
		"INSERT INTO users(id,email,name,password_hash) VALUES('member','member@example.invalid','Member','synthetic-password-hash')",
		// w-a is a first ClawHunt workspace, named after the person.
		"INSERT INTO tenants(id,name) VALUES('w-a','Verified account · AwwO'),('w-b','B'),('w-m','Mine')",
		`INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES('w-a','person','owner',now()-interval '9 days'),('w-b','person','owner',now()-interval '8 days'),
			('w-a','member','member',now()-interval '7 days'),('w-b','member','reader',now()-interval '6 days'),('w-m','member','owner',now()-interval '5 days')`,
	} {
		h.exec(t, sql)
	}
	d := deletionFor("person")
	d.Transfers = map[string]string{"w-a": "member", "w-b": "member"}
	// Handed over under the person's name, w-a would keep showing it.
	if p, err := h.store.DeleteAccount(h.ctx, d, actor, false); err != nil || !slices.Equal(p.Blockers, []string{"workspace_needs_new_name:w-a"}) {
		t.Fatal(p, err)
	}
	d.Renames = map[string]string{"w-a": "Member team · AwwO"}
	preview, err := h.store.DeleteAccount(h.ctx, d, actor, false)
	if err != nil || len(preview.Blockers) != 0 || len(preview.Workspaces) != 2 {
		t.Fatal(preview, err)
	}
	for _, w := range preview.Workspaces {
		if w.Outcome != "transfer" || w.NewOwnerOwnsAfter != 3 || (w.ID == "w-a") != (w.RenamedTo == "Member team · AwwO") {
			t.Fatal("each handover counts both, and w-a is renamed", w)
		}
	}
	if done, err := h.store.DeleteAccount(h.ctx, d, actor, true); err != nil || done.Rows.WorkspacesTransferred != 2 {
		t.Fatal(done, err)
	}
	if names := h.catalog(t, "SELECT name FROM tenants WHERE id IN ('w-a','w-b') ORDER BY id"); !slices.Equal(names, []string{"Member team · AwwO", "B"}) ||
		h.count(t, "SELECT count(*) FROM audit_events WHERE action='admin.operator_workspace_transferred' AND tenant_id='w-a' AND metadata->>'renamed'='true'") != 1 {
		t.Fatal("the renamed workspace", names)
	}
	if owned := h.catalog(t, "SELECT tenant_id FROM memberships WHERE user_id='member' AND role='owner' ORDER BY created_at,tenant_id"); !slices.Equal(owned, []string{"w-m", "w-a", "w-b"}) {
		t.Fatal("the member's workspaces", owned)
	}
}

// A workspace with a long knowledge history, deleted alone: the revisions' parent chain and the current-revision key go
// with it, and the database refuses to delete a knowledge origin as before.
func TestPostgresDeletionOfALoneAccountWithoutRequest(t *testing.T) {
	h := database(t)
	h.exec(t, "INSERT INTO tenants(id,name) VALUES('w-alone','Alone'),('w-empty','Empty')")
	h.exec(t, "INSERT INTO memberships(tenant_id,user_id,role) VALUES('w-alone','person','owner'),('w-empty','person','owner')")
	h.exec(t, "INSERT INTO knowledge_documents(id,tenant_id,kind,title,source_hash) VALUES('kd','w-alone','source','Source','sh'),('kp','w-alone','page','Page',NULL)")
	h.exec(t, "INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,title,content,content_hash,actor_id) VALUES('kr-1','w-alone','kd',1,'Source','v1','c1','person'),('kp-1','w-alone','kp',1,'Page','p','p1','person')")
	h.exec(t, "INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,parent_revision_id,title,content,content_hash,actor_id) VALUES('kr-2','w-alone','kd',2,'kr-1','Source','v2','c2','person')")
	h.exec(t, "INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,parent_revision_id,title,content,content_hash,actor_id) VALUES('kr-3','w-alone','kd',3,'kr-2','Source','v3','c3','person')")
	h.exec(t, "UPDATE knowledge_documents SET current_revision_id=CASE id WHEN 'kd' THEN 'kr-3' ELSE 'kp-1' END")
	h.exec(t, "INSERT INTO knowledge_links(id,tenant_id,from_document_id,to_document_id,revision_id,relation) VALUES('kl','w-alone','kp','kd','kp-1','cites')")
	h.exec(t, "INSERT INTO knowledge_proposals(id,tenant_id,document_id,kind,title,content,base_version,actor_id) VALUES('kq','w-alone','kp','page','Page','next',1,'person')")
	h.exec(t, "INSERT INTO knowledge_source_origins(tenant_id,document_id,title,provenance,origin_hash,actor_id) VALUES('w-alone','kd','Source','{}','o1','person'),('w-alone','kd','Source again','{}','o2','person')")
	h.exec(t, "INSERT INTO knowledge_operations(tenant_id,operation_id,request_hash,response,status) VALUES('w-alone','ko','h','{}',200)")
	// An administrator made the trigger fire always; the deletion puts it back that way.
	h.exec(t, "ALTER TABLE knowledge_source_origins ENABLE ALWAYS TRIGGER knowledge_source_origin_immutable")
	d := deletionFor("person")
	d.Deletes = []string{"w-empty", "w-alone"}
	done, err := h.store.DeleteAccount(h.ctx, d, actor, true)
	if err != nil || !done.Applied || done.Rows.KnowledgeOriginsDeleted != 2 || done.Rows.WorkspacesDeleted != 2 || done.RequestID != "" {
		t.Fatal(done, err)
	}
	// The same arguments in another order are the same request.
	d.Deletes = []string{"w-alone", "w-empty"}
	if again, err := h.store.DeleteAccount(h.ctx, d, actor, true); err != nil || !again.Replayed || again.AuditID != done.AuditID {
		t.Fatal(again, err)
	}
	for _, table := range []string{"knowledge_documents", "knowledge_revisions", "knowledge_links", "knowledge_proposals", "knowledge_source_origins", "knowledge_operations", "tenants", "memberships"} {
		if n := h.count(t, "SELECT count(*) FROM "+table+" WHERE "+map[bool]string{true: "id", false: "tenant_id"}[table == "tenants"]+"='w-alone'"); n != 0 {
			t.Error(table, n)
		}
	}
	if h.count(t, "SELECT count(*) FROM users WHERE id='person'") != 0 || h.count(t, "SELECT count(*) FROM users WHERE id='other'") != 1 {
		t.Fatal("wrong account deleted")
	}
	state := func() []string {
		return h.catalog(t, "SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='knowledge_source_origins'::regclass AND tgname='knowledge_source_origin_immutable'")
	}
	if got := state(); !slices.Equal(got, []string{"A"}) {
		t.Fatal("trigger left", got)
	}
	h.exec(t, "INSERT INTO tenants(id,name) VALUES('w-next','Next')")
	h.exec(t, "INSERT INTO memberships(tenant_id,user_id,role) VALUES('w-next','other','owner')")
	h.exec(t, "INSERT INTO knowledge_documents(id,tenant_id,kind,title,source_hash) VALUES('kn','w-next','source','Next','sn')")
	h.exec(t, "INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,title,content,content_hash,actor_id) VALUES('kn-1','w-next','kn',1,'Next','v','c','other')")
	h.exec(t, "INSERT INTO knowledge_source_origins(tenant_id,document_id,title,provenance,origin_hash,actor_id) VALUES('w-next','kn','Next','{}','o','other')")
	if _, err = h.db.Exec(h.ctx, "DELETE FROM knowledge_source_origins"); err == nil {
		t.Fatal("the database deletes knowledge origins after a deletion")
	}
	// Switched off by hand, it stays off.
	h.exec(t, "ALTER TABLE knowledge_source_origins DISABLE TRIGGER knowledge_source_origin_immutable")
	next := deletionFor("other")
	next.Deletes = []string{"w-next"}
	if done, err := h.store.DeleteAccount(h.ctx, next, actor, true); err != nil || done.Rows.KnowledgeOriginsDeleted != 1 {
		t.Fatal(done, err)
	}
	if got := state(); !slices.Equal(got, []string{"D"}) {
		t.Fatal("trigger switched on", got)
	}
}
