package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Migration 060: user_plans holds Ultra, the third paid plan (2026-11-11). Applied to a database as 059 left it, where
// the check migration 026 declared takes Pro or Max alone, it keeps every plan stored and takes Ultra from then on; no
// other plan is taken. Its statements run again unchanged, and a database that holds another check on the plan under
// another name, which would still refuse Ultra, is refused instead of being left to drop every Ultra payment.
func TestPostgresMigration060LetsUserPlansHoldUltra(t *testing.T) {
	db := migrationTestDatabase(t)
	ctx := context.Background()
	if e := Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	exec := func(statement string) error { _, err := db.Exec(ctx, statement); return err }
	give := func(user, plan string) string {
		return fmt.Sprintf("INSERT INTO user_plans(user_id,plan,status,period_start,period_end,credits) VALUES('%s','%s','active',now(),now()+interval '30 days',100)", user, plan)
	}
	for _, statement := range []string{
		// The database as 059 left it: the check as 026 declared it, and an account on Max.
		"ALTER TABLE user_plans DROP CONSTRAINT user_plans_plan_check",
		"ALTER TABLE user_plans ADD CONSTRAINT user_plans_plan_check CHECK (plan IN ('pro', 'max'))",
		"DELETE FROM awwo_schema_migration_identities WHERE version=60",
		"DELETE FROM awwo_schema_migrations WHERE version=60",
		"INSERT INTO users(id,email,name,password_hash) VALUES('u-max','m060-max@example.test','Max','x'),('u-ultra','m060-ultra@example.test','Ultra','x'),('u-mega','m060-mega@example.test','Mega','x')",
		give("u-max", "max"),
	} {
		if e := exec(statement); e != nil {
			t.Fatal(statement, e)
		}
	}
	if exec(give("u-ultra", "ultra")) == nil {
		t.Fatal("the database as 059 left it took an Ultra plan")
	}
	if e := Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	sql, _ := migrations.ReadFile("migrations/060_ultra_plan.sql")
	again := func() error {
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(context.Background())
		if _, e = tx.Exec(ctx, string(sql)); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	if e := again(); e != nil {
		t.Fatal("060 is not re-runnable", e)
	}
	if e := exec(give("u-ultra", "ultra")); e != nil {
		t.Fatal("an Ultra plan after 060", e)
	}
	if exec(give("u-mega", "mega")) == nil {
		t.Fatal("a plan that does not exist was stored")
	}
	var plans string
	if e := db.QueryRow(ctx, "SELECT string_agg(plan,',' ORDER BY plan) FROM user_plans").Scan(&plans); e != nil || plans != "max,ultra" {
		t.Fatal("the plans stored", plans, e)
	}
	// One check on the plan, under the name 026's had, and checked against every row.
	var checks int
	if e := db.QueryRow(ctx, `SELECT count(*) FROM pg_constraint k WHERE k.conrelid='user_plans'::regclass AND k.contype='c'
		AND k.conkey=ARRAY(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=k.conrelid AND a.attname='plan')`).Scan(&checks); e != nil || checks != 1 {
		t.Fatal("the checks on the plan", checks, e)
	}
	var valid bool
	var definition string
	if e := db.QueryRow(ctx, "SELECT convalidated,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='user_plans'::regclass AND conname='user_plans_plan_check'").
		Scan(&valid, &definition); e != nil || !valid || !strings.Contains(definition, "'ultra'") {
		t.Fatal("the plan check", valid, definition, e)
	}
	// A check on the plan under another name: 060 would leave it, so it refuses the database and changes nothing.
	if e := exec("ALTER TABLE user_plans ADD CONSTRAINT user_plans_plan_other CHECK (plan <> 'mega')"); e != nil {
		t.Fatal(e)
	}
	if e := again(); e == nil || !strings.Contains(e.Error(), "user_plans holds another check") {
		t.Fatal("060 passed a database with another check on the plan", e)
	}
	if e := exec("ALTER TABLE user_plans DROP CONSTRAINT user_plans_plan_other"); e != nil {
		t.Fatal(e)
	}
	// So does one that reads the plan together with another column.
	if e := exec("ALTER TABLE user_plans ADD CONSTRAINT user_plans_plan_status CHECK (plan <> 'mega' OR status <> 'active')"); e != nil {
		t.Fatal(e)
	}
	if e := again(); e == nil || !strings.Contains(e.Error(), "user_plans holds another check") {
		t.Fatal("060 passed a database with a check on the plan and another column", e)
	}
	if e := exec("ALTER TABLE user_plans DROP CONSTRAINT user_plans_plan_status"); e != nil {
		t.Fatal(e)
	}
	if e := again(); e != nil {
		t.Fatal("060 after the other check went", e)
	}
}

// An account on Ultra is stored as ClawHunt reports it and runs on Ultra's allowances: the credits are what was paid
// for each plan (here an upgrade from Max part-way through the period), a credit for each cent.
func TestPostgresUltraPlanIsStoredWithItsAllowances(t *testing.T) {
	h := planHarness(t)
	h.register(t, "plan-ultra@example.test")
	ctx := context.Background()
	uid := givePlanUser(t, h, "plan-ultra@example.test")
	now := time.Now()
	start, end := now.Add(-time.Hour).Unix(), now.Add(30*24*time.Hour).Unix()
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, paidPlan("ultra", start, end, map[string]int64{"ultra": 29900})), dbNow(t, h)); e != nil {
		t.Fatal("an Ultra period paid in full", e)
	}
	p, e := accountPlan(ctx, h.db, uid)
	if e != nil || p == nil || p.Plan != "ultra" || p.Credits != 29900 || p.Limits != planCatalog["ultra"] ||
		p.Limits.Daily != 3000 || p.Limits.Concurrent != 12 || p.Limits.Workspaces != 30 || p.Limits.MediaPerDay != 300 {
		t.Fatal("the Ultra plan", p, e)
	}
	// The same period, read again after its invoices were found to be an upgrade's: what Max kept and what Ultra charged.
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, paidPlan("ultra", start, end, map[string]int64{"max": 4000, "ultra": 20000})), dbNow(t, h)); e != nil {
		t.Fatal("an upgrade from Max", e)
	}
	if p, e = accountPlan(ctx, h.db, uid); e != nil || p == nil || p.Plan != "ultra" || p.Credits != 24000 {
		t.Fatal("the upgraded period", p, e)
	}
	// A plan that does not exist is still no plan.
	if e := h.a.applyPlan(ctx, uid, decodePlan(t, paidPlan("mega", start, end, map[string]int64{"mega": 50000})), dbNow(t, h)); e == nil {
		t.Fatal("a plan that does not exist was applied")
	}
}
