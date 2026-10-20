package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// The skill registry's endpoints against PostgreSQL (skill_registry.go), with skills.sh and GitHub answered by the
// stand-ins in skill_registry_test.go.

func TestPostgresSkillRegistrySearchPreviewAndImport(t *testing.T) {
	site := serveRegistry(t, registrySite(registryTestSkill))
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.SkillRegistryEnabled = true
	owner, tid, _ := h.register(t, "registry-owner@example.test")
	base := "/tenants/" + tid + "/skills/registry"
	capabilities := h.request(t, owner, "GET", "/tenants/"+tid+"/capabilities", nil, 200)
	if registry := capabilities["skillRegistry"].(map[string]any); registry["enabled"] != true || registry["source"] != "skills.sh" {
		t.Fatal(capabilities)
	}
	found := h.request(t, owner, "GET", base+"/search?q=find%20skills", nil, 200)
	items := found["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != "vercel-labs/skills/find-skills" || found["source"] != "skills.sh" {
		t.Fatal(found)
	}
	h.request(t, owner, "GET", base+"/search?q=x", nil, 400)
	preview := h.request(t, owner, "GET", base+"/preview?id=vercel-labs/skills/find-skills", nil, 200)
	skill := preview["skill"].(map[string]any)
	hash, _ := preview["hash"].(string)
	if !registryHashPattern.MatchString(hash) || preview["markdown"] != registryTestSkill || preview["problem"] != nil || skill["name"] != "find-skills" || skill["title"] != "Find Skills" ||
		skill["category"] != "engineering" || preview["declaredLicense"] != "MIT" || preview["repository"].(map[string]any)["license"] != "MIT" || preview["filesTotal"] != float64(2) ||
		len(preview["files"].([]any)) != 2 || len(preview["audits"].([]any)) != 1 || fmt.Sprint(preview["notes"]) != "[extra_files runs_commands]" || preview["url"] != "https://skills.sh/vercel-labs/skills/find-skills" {
		t.Fatal(preview)
	}
	if license := preview["license"].(map[string]any); license["status"] != "open" || license["spdx"] != "MIT" || len(license["files"].([]any)) != 0 {
		t.Fatal("a skill declared MIT in an MIT repository is open", license)
	}
	h.request(t, owner, "GET", base+"/preview?id=../../x", nil, 400)
	changed := h.request(t, owner, "POST", base+"/import", map[string]any{"id": "vercel-labs/skills/find-skills", "hash": strings.Repeat("0", 64)}, 409)
	if changed["error"].(map[string]any)["code"] != "skill_registry_changed" {
		t.Fatal(changed)
	}
	imported := h.request(t, owner, "POST", base+"/import", map[string]any{"id": "vercel-labs/skills/find-skills", "hash": hash, "title": "Skill finder", "category": "research", "applies": []string{"research"}}, 201)
	want := "Imported from skills.sh (vercel-labs/skills/find-skills); source https://github.com/vercel-labs/skills; license MIT"
	if imported["source"] != "workspace" || imported["name"] != "find-skills" || imported["title"] != "Skill finder" || imported["category"] != "research" || imported["attribution"] != want || !strings.HasPrefix(imported["body"].(string), "\n# Find Skills") {
		t.Fatal(imported)
	}
	// The library shows the import with where it came from, and an edit keeps that.
	read := h.request(t, owner, "GET", "/tenants/"+tid+"/skills/"+imported["ref"].(string), nil, 200)
	if read["attribution"] != want || read["description"] != "Helps users discover and install agent skills when they ask how to do X." {
		t.Fatal(read)
	}
	edited := h.request(t, owner, "PUT", "/tenants/"+tid+"/skills/"+imported["id"].(string), map[string]any{"version": 1, "title": "Skill finder", "description": "Find skills", "body": "Shorter.\n"}, 200)
	if edited["attribution"] != want {
		t.Fatal("an edit dropped the attribution", edited)
	}
	if listed := h.request(t, owner, "GET", "/tenants/"+tid+"/skills", nil, 200); !strings.Contains(fmt.Sprint(listed["items"]), want) {
		t.Fatal("the catalogue omits the attribution")
	}
	conflict := h.request(t, owner, "POST", base+"/import", map[string]any{"id": "vercel-labs/skills/find-skills", "hash": hash}, 409)
	if conflict["error"].(map[string]any)["code"] != "skill_name_conflict" {
		t.Fatal(conflict)
	}
	h.request(t, owner, "POST", base+"/import", map[string]any{"id": "vercel-labs/skills/find-skills", "hash": hash, "name": "Bad Name"}, 400)
	var action, written int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FILTER (WHERE action='skill.imported'),(SELECT count(*) FROM tenant_skills WHERE tenant_id=$1 AND attribution IS NULL) FROM audit_events WHERE tenant_id=$1", tid).Scan(&action, &written); err != nil || action != 1 || written != 0 {
		t.Fatal("import not audited", action, written, err)
	}
	// A skill a member uploads has no attribution, even when its file claims one.
	uploaded := h.request(t, owner, "POST", "/tenants/"+tid+"/skills", map[string]any{"markdown": "---\nname: own-skill\ndescription: Ours\nattribution: Copied from somewhere famous\n---\nBody\n"}, 201)
	if _, has := uploaded["attribution"]; has {
		t.Fatal("an upload set its own attribution", uploaded)
	}
	if downloads := site.count("/api/download/"); downloads != 1 {
		t.Fatal("the import must reuse the preview's copy", downloads)
	}

	// A reader cannot use the registry; a suspended workspace cannot either; nor can anyone when it is off.
	reader, _, readerID := h.register(t, "registry-reader@example.test")
	execSQL(t, h, "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'reader')", tid, readerID)
	h.request(t, reader, "GET", base+"/search?q=find%20skills", nil, 403)
	execSQL(t, h, "UPDATE tenants SET status='suspended' WHERE id=$1", tid)
	h.request(t, owner, "GET", base+"/search?q=find%20skills", nil, 403)
	execSQL(t, h, "UPDATE tenants SET status='active' WHERE id=$1", tid)
	h.a.cfg.SkillRegistryEnabled = false
	off := h.request(t, owner, "GET", base+"/search?q=find%20skills", nil, 503)
	if off["error"].(map[string]any)["code"] != "skill_registry_unavailable" {
		t.Fatal(off)
	}
	if capabilities = h.request(t, owner, "GET", "/tenants/"+tid+"/capabilities", nil, 200); capabilities["skillRegistry"].(map[string]any)["enabled"] != false {
		t.Fatal(capabilities)
	}
}

// A preview still answers when GitHub and the security reviews fail, saying what it could not check; a skill
// skills.sh does not know asks GitHub nothing.
func TestPostgresSkillRegistryPreviewSaysWhatItCouldNotCheck(t *testing.T) {
	site := serveRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "github.test" || strings.HasPrefix(r.URL.Path, "/api/v1/skills/audit/") {
			w.WriteHeader(500)
			return
		}
		registrySite("---\nname: find-skills\ndescription: x\n---\nText.\n")(w, r)
	})
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.SkillRegistryEnabled = true
	owner, tid, _ := h.register(t, "registry-degraded@example.test")
	base := "/tenants/" + tid + "/skills/registry"
	preview := h.request(t, owner, "GET", base+"/preview?id=vercel-labs/skills/find-skills", nil, 200)
	if preview["repository"].(map[string]any)["checked"] != false || preview["audits"] != nil || preview["license"].(map[string]any)["status"] != "unknown" {
		t.Fatal(preview)
	}
	h.request(t, owner, "GET", base+"/preview?id=nobody/nothing/here", nil, 404)
	if site.count("/repos/nobody") != 0 {
		t.Fatal("GitHub was asked about a skill skills.sh does not have")
	}
}

// A skill that declares itself proprietary is imported only on the member's word that they may use it, and says so.
func TestPostgresSkillRegistryAsksBeforeImportingASkillThatIsNotOpen(t *testing.T) {
	markdown := "---\nname: find-skills\ndescription: Documents\nlicense: Proprietary. LICENSE.txt has complete terms\n---\nRead the document.\n"
	serveRegistry(t, registrySite(markdown))
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.SkillRegistryEnabled = true
	owner, tid, _ := h.register(t, "registry-license@example.test")
	base := "/tenants/" + tid + "/skills/registry"
	preview := h.request(t, owner, "GET", base+"/preview?id=vercel-labs/skills/find-skills", nil, 200)
	if license := preview["license"].(map[string]any); license["status"] != "restricted" || license["spdx"] != nil {
		t.Fatal(license)
	}
	refused := h.request(t, owner, "POST", base+"/import", map[string]any{"id": "vercel-labs/skills/find-skills", "hash": preview["hash"]}, 409)
	if refused["error"].(map[string]any)["code"] != "skill_registry_license_unconfirmed" {
		t.Fatal(refused)
	}
	imported := h.request(t, owner, "POST", base+"/import", map[string]any{"id": "vercel-labs/skills/find-skills", "hash": preview["hash"], "licenseConfirmed": true}, 201)
	if !strings.HasSuffix(imported["attribution"].(string), "license declared in SKILL.md: Proprietary. LICENSE.txt has complete terms; not known to be an open license, imported on the member's confirmation that they may use it") {
		t.Fatal(imported["attribution"])
	}
}

func TestPostgresSkillRegistryRefusesTooLargeSkillsAndBoundsAnAccount(t *testing.T) {
	markdown := "---\nname: find-skills\ndescription: Big\n---\n" + strings.Repeat("Long method text. ", 900)
	serveRegistry(t, registrySite(markdown))
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.SkillRegistryEnabled = true
	owner, tid, _ := h.register(t, "registry-large@example.test")
	base := "/tenants/" + tid + "/skills/registry"
	preview := h.request(t, owner, "GET", base+"/preview?id=vercel-labs/skills/find-skills", nil, 200)
	problem := preview["problem"].(map[string]any)
	if problem["code"] != "skill_registry_too_large" || problem["blocking"] != true || preview["truncated"] != false {
		t.Fatal(preview)
	}
	refused := h.request(t, owner, "POST", base+"/import", map[string]any{"id": "vercel-labs/skills/find-skills", "hash": preview["hash"]}, 413)
	if refused["error"].(map[string]any)["code"] != "skill_registry_too_large" {
		t.Fatal(refused)
	}
	// The preview counted what it fetched (the skill, its repository and its reviews: 3) and the import 1, all it needed
	// being cached; so does each preview of what is cached, and each search.
	for i := 0; i < 6; i++ {
		h.request(t, owner, "GET", base+"/preview?id=vercel-labs/skills/find-skills", nil, 200)
	}
	for used := 10; used < registryAccountPerMinute; used++ {
		h.request(t, owner, "GET", base+"/search?q=find%20skills", nil, 200)
	}
	limited := h.request(t, owner, "GET", base+"/search?q=find%20skills", nil, 429)
	if limited["error"].(map[string]any)["code"] != "skill_registry_rate_limited" {
		t.Fatal(limited)
	}
}

// 041 can run again unchanged on a database that already holds an attribution, and refuses an empty one.
func TestPostgresSkillAttributionMigrationRunsAgain(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	_, tid, _ := h.register(t, "attribution-migration@example.test")
	execSQL(t, h, "INSERT INTO tenant_skills(id,tenant_id,name,title,description,category,body,content_hash,version,attribution) VALUES('s1',$1,'a','A','d','writing','b','h',1,'Imported')", tid)
	sql, _ := migrations.ReadFile("migrations/041_skill_attribution.sql")
	for run := 0; run < 2; run++ {
		tx, err := h.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			t.Fatal("041 run again, run", run+1, err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var attribution string
	if err := h.db.QueryRow(ctx, "SELECT attribution FROM tenant_skills WHERE tenant_id=$1 AND id='s1'", tid).Scan(&attribution); err != nil || attribution != "Imported" {
		t.Fatal(attribution, err)
	}
	if _, err := h.db.Exec(ctx, "UPDATE tenant_skills SET attribution='' WHERE id='s1'"); err == nil {
		t.Fatal("an empty attribution was stored")
	}
}
