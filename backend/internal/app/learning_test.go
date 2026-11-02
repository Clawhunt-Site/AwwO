package app

import (
	"context"
	"testing"
)

// A workspace's learning settings: neither is offered until the deployment offers it; memory suggestions an admin turns
// on, Help improve AwwO only the owner; every member reads both; turning one on again keeps when it was first on, off
// clears it, and each change is audited.
func TestPostgresLearningSettings(t *testing.T) {
	h := newHarness(t, "")
	c, tid, _ := h.register(t, "learning@example.test")
	path := "/tenants/" + tid + "/learning"
	setting := func(v map[string]any, name string) (bool, bool, any) {
		t.Helper()
		s, _ := v[name].(map[string]any)
		return s["offered"] == true, s["on"] == true, s["since"]
	}
	view := h.request(t, c, "GET", path, nil, 200)
	if offered, on, since := setting(view, "consent"); offered || on || since != nil {
		t.Fatal("the consent before it is offered", view)
	}
	if offered, on, _ := setting(view, "memorySuggestions"); offered || on {
		t.Fatal("memory suggestions before they are offered", view)
	}
	h.request(t, c, "PUT", path, map[string]any{"consent": true}, 409)
	h.request(t, c, "PUT", path, map[string]any{"memorySuggestions": true}, 409)
	h.a.cfg.LearningConsent, h.a.cfg.MemoryDistill = true, true
	h.request(t, c, "PUT", path, map[string]any{}, 400)
	on := h.request(t, c, "PUT", path, map[string]any{"consent": true, "memorySuggestions": true}, 200)
	offered, isOn, since := setting(on, "consent")
	if !offered || !isOn || since == nil {
		t.Fatal("the owner's consent", on)
	}
	if _, isOn, _ := setting(on, "memorySuggestions"); !isOn {
		t.Fatal("the owner's memory suggestions", on)
	}
	// On again: the same moment.
	again := h.request(t, c, "PUT", path, map[string]any{"consent": true}, 200)
	if _, _, later := setting(again, "consent"); later != since {
		t.Fatalf("turned on again from %v to %v", since, later)
	}
	// An admin may turn memory suggestions off, never the consent; a member changes neither and reads both.
	o, _, other := h.register(t, "learning-admin@example.test")
	ctx := context.Background()
	if _, e := h.db.Exec(ctx, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", tid, other); e != nil {
		t.Fatal(e)
	}
	h.request(t, o, "PUT", path, map[string]any{"consent": false}, 403)
	off := h.request(t, o, "PUT", path, map[string]any{"memorySuggestions": false}, 200)
	if _, isOn, since := setting(off, "memorySuggestions"); isOn || since != nil {
		t.Fatal("memory suggestions an admin turned off", off)
	}
	if _, isOn, _ := setting(off, "consent"); !isOn {
		t.Fatal("the consent changed with the memory suggestions", off)
	}
	if _, e := h.db.Exec(ctx, "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2", tid, other); e != nil {
		t.Fatal(e)
	}
	h.request(t, o, "PUT", path, map[string]any{"memorySuggestions": true}, 403)
	if read := h.request(t, o, "GET", path, nil, 200); read["consent"].(map[string]any)["on"] != true {
		t.Fatal("a member's view", read)
	}
	// A consent is its giver's: given by someone who no longer owns the workspace, it holds no more, and the owner gives
	// it anew.
	if _, e := h.db.Exec(ctx, "UPDATE workspace_learning SET consent_by=$2 WHERE tenant_id=$1", tid, other); e != nil {
		t.Fatal(e)
	}
	if _, isOn, _ := setting(h.request(t, c, "GET", path, nil, 200), "consent"); isOn {
		t.Fatal("a consent its giver no longer owns the workspace for")
	}
	anew := h.request(t, c, "PUT", path, map[string]any{"consent": true}, 200)
	if _, isOn, later := setting(anew, "consent"); !isOn || later == since {
		t.Fatalf("given anew: %v, from %v to %v", isOn, since, later)
	}
	// Off clears it.
	cleared := h.request(t, c, "PUT", path, map[string]any{"consent": false}, 200)
	if _, isOn, since := setting(cleared, "consent"); isOn || since != nil {
		t.Fatal("the consent turned off", cleared)
	}
	var audits int
	if e := h.db.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action IN ('learning.consent_on','learning.consent_off',
		'learning.memory_suggestions_on','learning.memory_suggestions_off')`, tid).Scan(&audits); e != nil || audits != 6 {
		t.Fatalf("%d audit events: %v", audits, e)
	}
	// A deployment that stops offering the consent still lets its owner withdraw one given, never give one.
	h.request(t, c, "PUT", path, map[string]any{"consent": true}, 200)
	h.a.cfg.LearningConsent = false
	if offered, isOn, _ := setting(h.request(t, c, "GET", path, nil, 200), "consent"); offered || !isOn {
		t.Fatal("a consent given where it is no longer offered", offered, isOn)
	}
	h.request(t, c, "PUT", path, map[string]any{"consent": true}, 409)
	if _, isOn, _ := setting(h.request(t, c, "PUT", path, map[string]any{"consent": false}, 200), "consent"); isOn {
		t.Fatal("not withdrawn")
	}
	h.a.cfg.LearningConsent = true
	// Their other workspace says where a setting of theirs is on, so the page keeps the way to it.
	if _, e := h.db.Exec(ctx, "UPDATE workspace_learning SET suggestions_at=now() WHERE tenant_id=$1", tid); e != nil {
		t.Fatal(e)
	}
	var second string
	if e := h.db.QueryRow(ctx, `SELECT m.tenant_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='learning-admin@example.test' AND m.tenant_id<>$1`, tid).Scan(&second); e != nil {
		t.Fatal(e)
	}
	if elsewhere := h.request(t, c, "GET", "/tenants/"+tid+"/learning", nil, 200)["elsewhere"]; elsewhere != false {
		t.Fatal("elsewhere for the owner's only workspace", elsewhere)
	}
	if _, e := h.db.Exec(ctx, "UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", tid, other); e != nil {
		t.Fatal(e)
	}
	if elsewhere := h.request(t, o, "GET", "/tenants/"+second+"/learning", nil, 200)["elsewhere"]; elsewhere != true {
		t.Fatal("an admin's memory suggestions on in another workspace", elsewhere)
	}
	// Another workspace's person reads nothing of it.
	stranger, _, _ := h.register(t, "learning-stranger@example.test")
	h.request(t, stranger, "GET", path, nil, 404)
	// The local edition offers no memory suggestions.
	h.a.cfg.UserCredentials = true
	if h.a.learningView(nil, nil, false)["memorySuggestions"].(learningSetting).Offered {
		t.Fatal("memory suggestions offered in the local edition")
	}
	h.a.cfg.UserCredentials = false
}
