package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"awwo/backend/internal/webread"
)

// registryServer stands in for skills.sh (as skills.test) and GitHub's API (as github.test) through the registry's
// loopback seam, and records every request it answers.
type registryServer struct {
	mu       sync.Mutex
	requests []*http.Request
}

func (s *registryServer) seen() []*http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*http.Request{}, s.requests...)
}

func (s *registryServer) count(prefix string) int {
	n := 0
	for _, r := range s.seen() {
		if strings.HasPrefix(r.URL.Path, prefix) {
			n++
		}
	}
	return n
}

func serveRegistry(t *testing.T, handler http.HandlerFunc) *registryServer {
	t.Helper()
	recorded := &registryServer{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorded.mu.Lock()
		recorded.requests = append(recorded.requests, r.Clone(context.Background()))
		recorded.mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	address := strings.TrimPrefix(server.URL, "http://")
	previousOptions, previousBase, previousGitHub := skillRegistryTestOptions, skillRegistryBase, skillRegistryGitHubAPI
	skillRegistryTestOptions = func(o *webread.Options) {
		o.AllowLoopbackForTests = true
		o.DialAddressForTests = func(string) string { return address }
	}
	skillRegistryBase, skillRegistryGitHubAPI = "http://skills.test", "http://github.test"
	t.Cleanup(func() {
		skillRegistryTestOptions, skillRegistryBase, skillRegistryGitHubAPI = previousOptions, previousBase, previousGitHub
	})
	return recorded
}

const registryTestUpstreamHash = "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf"

const registryTestSkill = "---\nname: find-skills\ndescription: >\n  Helps users discover and install agent skills\n  when they ask how to do X.\nlicense: MIT\nallowed-tools: Bash(npx skills:*)\n---\n\n# Find Skills\n\nRun the search:\n\n```bash\nnpx skills find react\n```\n"

// registrySite answers like skills.sh and GitHub for one skill, vercel-labs/skills/find-skills.
func registrySite(markdown string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Host == "skills.test" && r.URL.Path == "/api/search":
			fmt.Fprint(w, `{"query":"x","skills":[
				{"id":"vercel-labs/skills/find-skills","source":"vercel-labs/skills","skillId":"find-skills","name":"find-skills","installs":185000},
				{"id":"mintlify.com/mintlify","source":"mintlify.com","skillId":"mintlify","name":"mintlify","installs":9000},
				{"id":"other/repo/../x","source":"other/repo","skillId":"../x","name":"bad","installs":1},
				{"id":"vercel-labs/skills/find-skills","source":"vercel-labs/skills","skillId":"find-skills","name":"again","installs":1}]}`)
		case r.Host == "skills.test" && r.URL.Path == "/api/download/vercel-labs/skills/find-skills":
			value, _ := json.Marshal(map[string]any{"hash": registryTestUpstreamHash, "files": []map[string]string{
				{"path": "scripts/install.sh", "contents": "#!/bin/sh\necho hi\n"}, {"path": "SKILL.md", "contents": markdown}, {"path": "references/guide.md", "contents": "Guide"}}})
			w.Write(value)
		case r.Host == "skills.test" && r.URL.Path == "/api/v1/skills/audit/vercel-labs/skills/find-skills":
			fmt.Fprint(w, `{"audits":[{"provider":"Socket","status":"pass","riskLevel":"LOW","summary":"No issues found\u200b.","auditedAt":"2026-10-01T02:03:04Z"},{"provider":"Socket","status":"fail"},{"provider":"Odd","status":"maybe"}]}`)
		case r.Host == "github.test" && r.URL.Path == "/repos/vercel-labs/skills":
			fmt.Fprint(w, `{"license":{"spdx_id":"MIT"},"stargazers_count":4321,"archived":false}`)
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":"not_found"}`)
		}
	}
}

// snapshotOf parses a skills.sh folder answer of SKILL.md and the given other files (path, contents pairs).
func snapshotOf(t *testing.T, markdown string, files ...string) registrySnapshot {
	t.Helper()
	list := []map[string]string{{"path": "SKILL.md", "contents": markdown}}
	for i := 0; i+1 < len(files); i += 2 {
		list = append(list, map[string]string{"path": files[i], "contents": files[i+1]})
	}
	value, _ := json.Marshal(map[string]any{"hash": registryTestUpstreamHash, "files": list})
	s, err := parseRegistrySnapshot(value)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func registryCode(err error) string {
	if e, ok := err.(skillError); ok {
		return e.code
	}
	return fmt.Sprintf("%T %v", err, err)
}

func TestRegistryIDsAndSearchResults(t *testing.T) {
	for id, valid := range map[string]bool{
		"vercel-labs/skills/find-skills": true, "ComposioHQ/awesome-claude-skills/pdf": true, "a/b.c_d-e/x1": true,
		"vercel-labs/skills": false, "a/b/c/d": false, "a/../x": false, "a/./x": false, "-a/b/c": false, "a/b/Upper": false,
		"a/b/c d": false, "a/b/-x": false, "a b/c/d": false, "": false, "a/b/c\u200b": false,
	} {
		if _, ok := parseRegistryID(id); ok != valid {
			t.Fatalf("%q: valid=%v", id, ok)
		}
	}
	hits, err := parseRegistrySearch([]byte(`{"skills":[
		{"id":"o/r/a","source":"o/r","skillId":"a","name":"Skill\u200b A\u202e","installs":-4},
		{"id":"o/r/b","source":"o/r","skillId":"b","name":"","installs":12.5},
		{"id":"o/r/x","source":"o/r","skillId":"c","name":"mismatch","installs":1},
		{"id":"site.com/x","source":"site.com","skillId":"x","name":"well-known","installs":1}]}`))
	if err != nil || len(hits) != 2 {
		t.Fatal("search results", hits, err)
	}
	if hits[0].Name != "Skill A" || hits[0].Installs != 0 || hits[0].URL != "https://skills.sh/o/r/a" || hits[0].RepoURL != "https://github.com/o/r" {
		t.Fatalf("first result cleaned wrongly: %+v", hits[0])
	}
	if hits[1].Name != "b" || hits[1].Installs != 0 {
		t.Fatalf("a nameless result takes its slug: %+v", hits[1])
	}
	many := []string{}
	for i := 0; i < 30; i++ {
		many = append(many, fmt.Sprintf(`{"id":"o/r/s%d","source":"o/r","skillId":"s%d","name":"n","installs":1}`, i, i))
	}
	if hits, _ = parseRegistrySearch([]byte(`{"skills":[` + strings.Join(many, ",") + `]}`)); len(hits) != registrySearchLimit {
		t.Fatal("results are capped", len(hits))
	}
	for _, body := range []string{`not json`, `{}`, `{"skills":"x"}`} {
		if _, err := parseRegistrySearch([]byte(body)); err == nil {
			t.Fatalf("%s accepted", body)
		}
	}
	if got := registryText(strings.Repeat("word ", 10000), 10); got != "word word " && got != "word word" {
		t.Fatalf("a long text is cut to its length: %q", got)
	}
}

func TestRegistrySnapshotKeepsOnlyWhatAMemberIsShown(t *testing.T) {
	body := func(files ...map[string]string) []byte {
		value, _ := json.Marshal(map[string]any{"hash": registryTestUpstreamHash, "files": files})
		return value
	}
	s, err := parseRegistrySnapshot(body(map[string]string{"path": "z.md", "contents": "zz"}, map[string]string{"path": "skill.md", "contents": "---\nname: a\n---\nx\n"}, map[string]string{"path": "a/b.py", "contents": "print(1)"}))
	if err != nil || s.Markdown != "---\nname: a\n---\nx\n" || s.Hash != registrySnapshotHash("---\nname: a\n---\nx\n", nil) || len(s.Files) != 2 || s.FilesTotal != 2 ||
		s.Files[0] != (registryFile{Path: "a/b.py", Bytes: 8}) || s.Files[1].Path != "z.md" {
		t.Fatalf("snapshot read wrongly: %+v %v", s, err)
	}
	// A SKILL.md longer than a preview shows is kept to 64 KiB, its whole size and its own hash remembered.
	long := "---\nname: a\n---\n" + strings.Repeat("x", 3*maxRegistryPreview)
	big := snapshotOf(t, long)
	if len(big.Markdown) != maxRegistryPreview || big.MarkdownBytes != len(long) || big.Hash != registrySnapshotHash(long, nil) {
		t.Fatalf("a long SKILL.md is kept whole: %d of %d bytes", len(big.Markdown), big.MarkdownBytes)
	}
	files := []string{}
	for i := 0; i < 150; i++ {
		files = append(files, fmt.Sprintf("assets/%03d.png", i), "x")
	}
	if listed := snapshotOf(t, "---\nname: a\n---\nx\n", files...); len(listed.Files) != maxRegistryListedFiles || listed.FilesTotal != 150 {
		t.Fatalf("at most 100 files are listed, all counted: %d of %d", len(listed.Files), listed.FilesTotal)
	}
	cases := map[string]struct {
		raw  []byte
		code string
	}{
		"no SKILL.md":     {body(map[string]string{"path": "docs/SKILL.md", "contents": "x"}), "skill_registry_unimportable"},
		"no snapshot":     {[]byte(`{"hash":null,"files":null}`), "skill_registry_not_found"},
		"traversal":       {body(map[string]string{"path": "../SKILL.md", "contents": "x"}), "skill_registry_upstream"},
		"absolute":        {body(map[string]string{"path": "/etc/SKILL.md", "contents": "x"}), "skill_registry_upstream"},
		"not json":        {[]byte(`<html>`), "skill_registry_upstream"},
		"too many files":  {body(make([]map[string]string, maxRegistryFiles+1)...), "skill_registry_folder_too_large"},
		"empty file path": {body(map[string]string{"path": "", "contents": "x"}), "skill_registry_upstream"},
	}
	for name, c := range cases {
		if _, err := parseRegistrySnapshot(c.raw); registryCode(err) != c.code {
			t.Fatalf("%s: got %v, want %s", name, err, c.code)
		}
	}
}

func TestRegistryRecordTakesTheMembersChangesThenTheFileThenDefaults(t *testing.T) {
	id, _ := parseRegistryID("vercel-labs/skills/find-skills")
	s, err := registryRecord(id, registryTestSkill, registryImportInput{})
	if err != nil {
		t.Fatal(err)
	}
	// The body keeps the blank line after the frontmatter, as an uploaded file's does.
	if s.Name != "find-skills" || s.Title != "Find Skills" || s.Description != "Helps users discover and install agent skills when they ask how to do X." || s.Category != "engineering" || len(s.Applies) != 0 || !strings.HasPrefix(s.Body, "\n# Find Skills\n") {
		t.Fatalf("defaults wrong: %+v", s.summary())
	}
	s, err = registryRecord(id, registryTestSkill, registryImportInput{Name: "skill-finder", Title: "Skill finder", Description: "Find a skill", Category: "research", Applies: []string{"research"}})
	if err != nil || s.Name != "skill-finder" || s.Title != "Skill finder" || s.Description != "Find a skill" || s.Category != "research" || s.Applies[0] != "research" {
		t.Fatalf("member changes not taken: %+v %v", s.summary(), err)
	}
	// A name AwwO cannot use falls back to the slug; a category the library lacks is guessed; unknown tags are dropped.
	s, err = registryRecord(id, "---\nname: Find_Skills!\ndescription: Make a storyboard and an animation for a video\ncategory: magic\napplies: html, everything\n---\nx\n", registryImportInput{})
	if err != nil || s.Name != "find-skills" || s.Category != "video" || strings.Join(s.Applies, ",") != "html" {
		t.Fatalf("fallbacks wrong: %+v %v", s.summary(), err)
	}
	if _, err = registryRecord(id, registryTestSkill, registryImportInput{Category: "magic"}); err == nil {
		t.Fatal("an unknown category from the member accepted")
	}
	if _, err = registryRecord(id, registryTestSkill, registryImportInput{Applies: []string{"everything"}}); err == nil {
		t.Fatal("an unknown tag from the member accepted")
	}
	for text, want := range map[string]string{"Design a UI with Tailwind and Figma": "design", "Write a changelog and docs": "writing", "SQL dashboards": "data",
		"Marketing and SEO strategy": "business", "Review a pull request": "engineering", "Research papers and citations": "research"} {
		if got := suggestSkillCategory(text); got != want {
			t.Fatalf("%q: got %s want %s", text, got, want)
		}
	}
}

func TestRegistryImportableBlocksOnlyWhatAMemberCannotFix(t *testing.T) {
	id, _ := parseRegistryID("o/r/big-skill")
	problemOf := func(markdown string) (skillRecord, *registryProblem) {
		return registryImportable(id, snapshotOf(t, markdown))
	}
	if s, problem := problemOf(registryTestSkill); problem != nil || s.Name != "find-skills" {
		t.Fatal("a clean skill has a problem", problem)
	}
	for markdown, code := range map[string]string{
		"---\nname: big-skill\ndescription: x\n---\n" + strings.Repeat("a", maxSkillBodyBytes+1): "skill_registry_too_large",
		"---\nname: a\n---\n" + strings.Repeat("a", 2*maxRegistryPreview):                        "skill_registry_too_large",
		"---\nname: a\ndescription: x\n---\nhidden \u200b text\n":                                "skill_registry_hidden_text",
		"# no frontmatter\n":                              "skill_registry_unreadable",
		"---\nname: a\nname: b\ndescription: x\n---\nx\n": "skill_registry_unreadable",
		"---\nname: a\ndescription: x\n---\n\n   \n":      "skill_registry_empty",
	} {
		s, problem := problemOf(markdown)
		if problem == nil || problem.Code != code || !problem.Blocking || s.Name == "" {
			t.Fatalf("%.40q: got %+v, want blocking %s", markdown, problem, code)
		}
	}
	if _, problem := problemOf("---\nname: a\nname: b\n---\nx\n"); problem == nil || !strings.Contains(problem.Message, "Duplicate skill frontmatter key: name") {
		t.Fatal("a duplicate key is named", problem)
	}
	// A field the member can change is not a reason to refuse the skill.
	if s, problem := problemOf("---\nname: a\ntitle: " + strings.Repeat("t", maxSkillTitleRunes+1) + "\ndescription: x\n---\nx\n"); problem == nil || problem.Code != "invalid_skill" || problem.Blocking || s.Name != "a" {
		t.Fatal("a long title", problem)
	}
	if _, problem := problemOf("---\nname: a\n---\nx\n"); problem == nil || problem.Blocking {
		t.Fatal("a missing description is fixable", problem)
	}
}

func TestRegistryNotesAndAttribution(t *testing.T) {
	if notes := registryNotes(snapshotOf(t, registryTestSkill, "scripts/run.sh", "x")); strings.Join(notes, ",") != "extra_files,runs_commands" {
		t.Fatal(notes)
	}
	for markdown, runs := range map[string]bool{
		"---\nname: a\n---\nWrite short sentences.\nThe node then goes on.\n":        false,
		"---\nname: a\n---\nInstall it:\n\n    npx skills add x\n":                   true,
		"---\nname: a\n---\n```sh\nls\n```\n":                                        true,
		"---\nname: a\n---\n$ make build\n":                                          true,
		"---\nname: a\nallowed-tools:\n  - Read\n  - Bash\n---\nText only.\n":        true,
		"---\nname: a\nallowed-tools: x\nallowed-tools: y\n---\nText only.\n":        true,
		"---\nname: a\n---\nUse `npx skills` only when a person asks you to run it.": false,
	} {
		if got := strings.Contains(strings.Join(registryNotes(snapshotOf(t, markdown)), ","), "runs_commands"); got != runs {
			t.Fatalf("%q: runs_commands=%v", markdown, got)
		}
	}
	if notes := registryNotes(snapshotOf(t, "---\nname: a\n---\nx\n")); len(notes) != 0 || notes == nil {
		t.Fatal("no notes is an empty list", notes)
	}
	id, _ := parseRegistryID("vercel-labs/skills/find-skills")
	confirmed := "; not known to be an open license, imported on the member's confirmation that they may use it"
	for _, c := range []struct {
		license  registryLicense
		repo     registryRepository
		declared string
		want     string
	}{
		{registryLicense{Status: "open", SPDX: "MIT"}, registryRepository{Checked: true, Found: true, License: "MIT"}, "", "license MIT"},
		{registryLicense{Status: "open", SPDX: "Apache-2.0"}, registryRepository{}, "Apache 2.0", "license Apache-2.0"},
		{registryLicense{Status: "restricted"}, registryRepository{}, "Proprietary", "license declared in SKILL.md: Proprietary" + confirmed},
		{registryLicense{Status: "unknown", Files: []registryLicenseFile{{Path: "LICENSE.txt"}}}, registryRepository{Checked: true, Found: true}, "", "license in the skill's LICENSE.txt" + confirmed},
		{registryLicense{Status: "unknown", Files: []registryLicenseFile{{Path: "COPYRIGHT", Notice: true}, {Path: "LICENSE"}}}, registryRepository{}, "", "license in the skill's LICENSE" + confirmed},
		{registryLicense{Status: "unknown", Files: []registryLicenseFile{{Path: "NOTICE", Notice: true}}}, registryRepository{Checked: true, Found: true, License: "Apache-2.0"}, "", "terms in the skill's NOTICE" + confirmed},
		{registryLicense{Status: "unknown"}, registryRepository{Checked: true, Found: true, License: "NOASSERTION"}, "", "a license file GitHub could not classify" + confirmed},
		{registryLicense{Status: "unknown"}, registryRepository{Checked: true, Found: true, License: "GPL-3.0"}, "", "license GPL-3.0" + confirmed},
		{registryLicense{Status: "unknown"}, registryRepository{Checked: true, Found: true}, "", "no license file found in the repository" + confirmed},
		{registryLicense{Status: "unknown"}, registryRepository{}, "", "license not checked" + confirmed},
	} {
		got := registryAttribution(id, c.license, c.repo, c.declared)
		if got != "Imported from skills.sh (vercel-labs/skills/find-skills); source https://github.com/vercel-labs/skills; "+c.want {
			t.Fatalf("%+v: %s", c, got)
		}
	}
	// A long declared license, in a script of three bytes a character, is shortened so the attribution fits its column.
	long := registryAttribution(id, registryLicense{Status: "restricted"}, registryRepository{}, strings.Repeat("许可", 300))
	if len(long) > 1024 || !utf8.ValidString(long) || !strings.HasSuffix(long, confirmed) || !strings.Contains(long, "license declared in SKILL.md: 许可") {
		t.Fatalf("a long declared license was not fitted: %d bytes", len(long))
	}
}

// A snapshot keeps copies of what it shows: parsing many large folders leaves only those copies alive.
func TestRegistrySnapshotsKeepNoneOfTheAnswer(t *testing.T) {
	value, _ := json.Marshal(map[string]any{"hash": registryTestUpstreamHash, "files": []map[string]string{
		{"path": "SKILL.md", "contents": "---\nname: a\n---\n" + strings.Repeat("method ", 60000)},
		{"path": "LICENSE", "contents": strings.Repeat("terms ", 60000)},
		{"path": strings.Repeat("p", 2000), "contents": "x"}}})
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	kept := []registrySnapshot{}
	for i := 0; i < 20; i++ {
		s, err := parseRegistrySnapshot(value)
		if err != nil {
			t.Fatal(err)
		}
		kept = append(kept, s)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	// Holding the answers would keep 20 × 780 KB; the copies keep 20 × 80 KiB.
	if grown := int64(after.HeapAlloc) - int64(before.HeapAlloc); grown > 6<<20 {
		t.Fatalf("20 snapshots of %d KiB answers keep %d MiB", len(value)>>10, grown>>20)
	}
	if s := kept[0]; len(s.Markdown) != maxRegistryPreview || len(s.LicenseDocs[0].text) != maxRegistryLicenseText || len(s.Files) != 2 || len(s.Files[1].Path) != 300 {
		t.Fatal("a snapshot keeps less than it shows")
	}
	runtime.KeepAlive(kept)
}

// An account's minute counts what a request must fetch: a preview or an import of what the caches hold costs one.
func TestRegistryCostCountsWhatTheCachesDoNotHold(t *testing.T) {
	g := newSkillRegistry()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	g.now = func() time.Time { return now }
	id, _ := parseRegistryID("o/r/s")
	if g.cost(id, true) != 3 || g.cost(id, false) != 2 {
		t.Fatal("a first preview asks for the skill, its repository and its reviews; an import the first two", g.cost(id, true), g.cost(id, false))
	}
	g.snapshotCache.put(id.key(), registrySnapshot{}, now)
	if g.cost(id, true) != 2 || g.cost(id, false) != 1 {
		t.Fatal("a cached skill still counted", g.cost(id, true), g.cost(id, false))
	}
	g.repositoryCache.put(id.sourceKey(), registryRepository{}, now)
	g.auditCache.put(id.key(), nil, now)
	if g.cost(id, true) != 1 || g.cost(id, false) != 1 {
		t.Fatal("a request for what the caches hold costs one", g.cost(id, true), g.cost(id, false))
	}
	if sibling, _ := parseRegistryID("O/R/other"); g.cost(sibling, false) != 1 {
		t.Fatal("another skill of a cached repository counted the repository again")
	}
	g.waitFor(&g.githubUntil, time.Hour)
	if fresh, _ := parseRegistryID("x/y/z"); g.cost(fresh, true) != 2 {
		t.Fatal("GitHub is not asked while its allowance is spent, so it is not counted")
	}
	if now = now.Add(5 * time.Minute); g.cost(id, false) != 1 {
		t.Fatal("an expired skill and a kept repository cost one", g.cost(id, false))
	}
	g.waitFor(&g.backoffUntil, time.Hour)
	if fresh, _ := parseRegistryID("p/q/r"); g.cost(fresh, true) != 1 {
		t.Fatal("skills.sh is not asked while it has asked AwwO to wait, so it is not counted", g.cost(fresh, true))
	}
}

func TestRegistryLimitsAndCache(t *testing.T) {
	g := newSkillRegistry()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	g.now = func() time.Time { return now }
	// An account's minute counts each request's weight; at most two of its requests run at once.
	first, ok1 := g.beginAccount("u1", 3)
	second, ok2 := g.beginAccount("u1", 3)
	if !ok1 || !ok2 {
		t.Fatal("two requests at once refused")
	}
	if _, ok := g.beginAccount("u1", 1); ok {
		t.Fatal("a third request at once admitted")
	}
	first()
	second()
	for used := 6; used+2 <= registryAccountPerMinute; used += 2 {
		done, ok := g.beginAccount("u1", 2)
		if !ok {
			t.Fatal("refused within the minute at", used)
		}
		done()
	}
	if _, ok := g.beginAccount("u1", 1); ok {
		t.Fatal("the minute's weight not bounded")
	}
	if done, ok := g.beginAccount("u2", 3); !ok {
		t.Fatal("one account's minute must not spill into another's")
	} else {
		done()
	}
	// A request still running when its minute ends keeps counting towards the two at once.
	now = now.Add(time.Minute)
	running, ok := g.beginAccount("u1", 3)
	if !ok {
		t.Fatal("a new minute starts again")
	}
	now = now.Add(time.Minute)
	other, ok := g.beginAccount("u1", 3)
	if !ok {
		t.Fatal("a second request in the next minute refused")
	}
	if _, ok := g.beginAccount("u1", 1); ok {
		t.Fatal("the request still running was forgotten with its minute")
	}
	running()
	other()
	for i := 0; i < registryUpstreamBurst; i++ {
		if !g.takeUpstream(true) {
			t.Fatal("burst refused early", i)
		}
	}
	if g.takeUpstream(true) {
		t.Fatal("upstream burst not bounded")
	}
	now = now.Add(time.Second)
	if !g.takeUpstream(true) || !g.takeUpstream(true) || g.takeUpstream(true) {
		t.Fatal("a second refills two requests at 120 a minute")
	}
	now = now.Add(time.Hour)
	g.waitFor(&g.backoffUntil, 90*time.Second)
	if g.takeUpstream(true) {
		t.Fatal("asked again while skills.sh said to wait")
	}
	if !g.takeUpstream(false) {
		t.Fatal("skills.sh's wait must not stop the requests to GitHub")
	}
	now = now.Add(91 * time.Second)
	if !g.takeUpstream(true) {
		t.Fatal("still waiting after Retry-After")
	}
	g.waitFor(&g.githubUntil, 48*time.Hour)
	if !g.githubLimited() {
		t.Fatal("GitHub's limit not kept")
	}
	if now = now.Add(registryMaxBackoff + time.Second); g.githubLimited() {
		t.Fatal("a reset far away is capped at an hour")
	}
	c := registryCache[int]{ttl: time.Minute, max: 2}
	c.put("a", 1, now)
	c.put("b", 2, now)
	c.put("c", 3, now)
	if _, ok := c.get("c", now); !ok || len(c.items) != 2 {
		t.Fatal("a full cache keeps the newest entry within its size", c.items)
	}
	if _, ok := c.get("c", now.Add(time.Minute)); ok {
		t.Fatal("an entry outlived its time")
	}
	if v, ok := c.stale("c", now.Add(2*time.Minute), time.Hour); !ok || v != 3 {
		t.Fatal("an expired entry stands in within its bound")
	}
	if _, ok := c.stale("c", now.Add(2*time.Hour), time.Hour); ok {
		t.Fatal("an entry stood in past its bound")
	}
}

func TestRegistryAsksSkillsShAndGitHubReasonably(t *testing.T) {
	site := serveRegistry(t, registrySite(registryTestSkill))
	g := newSkillRegistry()
	ctx := context.Background()
	hits, err := g.search(ctx, "find skills")
	if err != nil || len(hits) != 1 || hits[0].ID != "vercel-labs/skills/find-skills" || hits[0].Installs != 185000 {
		t.Fatal("search", hits, err)
	}
	if _, err = g.search(ctx, "FIND SKILLS"); err != nil || site.count("/api/search") != 1 {
		t.Fatal("a repeated search must come from the cache", site.count("/api/search"), err)
	}
	first := site.seen()[0]
	if first.Header.Get("User-Agent") != skillRegistryUserAgent || first.URL.Query().Get("q") != "find skills" || first.URL.Query().Get("limit") != "20" || first.Header.Get("Cookie") != "" {
		t.Fatalf("search request wrong: %v %v", first.Header, first.URL)
	}
	id, _ := parseRegistryID("vercel-labs/skills/find-skills")
	snapshot, err := g.snapshot(ctx, id)
	if err != nil || snapshot.Hash != registrySnapshotHash(registryTestSkill, nil) || snapshot.Markdown != registryTestSkill || len(snapshot.Files) != 2 {
		t.Fatal("snapshot", snapshot, err)
	}
	repo := g.repository(ctx, id)
	if repo != (registryRepository{Checked: true, Found: true, License: "MIT", Stars: 4321}) {
		t.Fatalf("repository: %+v", repo)
	}
	audits := g.audits(ctx, id)
	if len(audits) != 1 || audits[0] != (registryAudit{Provider: "Socket", Status: "pass", RiskLevel: "LOW", Summary: "No issues found.", AuditedAt: "2026-10-01T02:03:04Z"}) {
		t.Fatalf("audits (one per provider): %+v", audits)
	}
	missing, _ := parseRegistryID("someone/else/nothing")
	if audits := g.audits(ctx, missing); audits == nil || len(audits) != 0 {
		t.Fatal("an unaudited skill has an empty list", audits)
	}
	if repo := g.repository(ctx, missing); repo != (registryRepository{Checked: true}) {
		t.Fatalf("a missing repository is checked and not found: %+v", repo)
	}
	if _, err := g.snapshot(ctx, missing); registryCode(err) != "skill_registry_not_found" {
		t.Fatal("a missing skill", err)
	}
	g.snapshot(ctx, id)
	g.repository(ctx, id)
	g.audits(ctx, id)
	if site.count("/api/download/") != 2 || site.count("/repos/") != 2 || site.count("/api/v1/skills/audit/") != 2 {
		t.Fatal("the second reads must come from the caches", site.count("/api/download/"), site.count("/repos/"), site.count("/api/v1/skills/audit/"))
	}
}

func TestRegistryBacksOffWhenAskedAndKeepsToItsHosts(t *testing.T) {
	var mu sync.Mutex
	mode := "limited"
	set := func(next string) { mu.Lock(); mode = next; mu.Unlock() }
	site := serveRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		current := mode
		mu.Unlock()
		switch {
		case r.Host == "github.test" && current == "github-blocked":
			w.WriteHeader(403)
		case r.Host == "github.test":
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(30*time.Minute).Unix()))
			w.WriteHeader(403)
		case current == "limited":
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(429)
		case current == "redirect-out":
			http.Redirect(w, r, "http://elsewhere.test"+r.URL.Path, 302)
		case current == "redirect-nowhere":
			w.WriteHeader(302)
		case current == "redirect-www" && r.Host == "skills.test":
			http.Redirect(w, r, "http://www.skills.test"+r.URL.RequestURI(), 308)
		case current == "redirect-twice" && r.Host == "skills.test":
			http.Redirect(w, r, "http://www.skills.test"+r.URL.RequestURI(), 308)
		case current == "redirect-twice":
			http.Redirect(w, r, "http://skills.test"+r.URL.RequestURI(), 308)
		case current == "huge":
			w.Write([]byte(`{"skills":[` + strings.Repeat(" ", maxRegistrySearchBytes) + `]}`))
		case current == "slow":
			time.Sleep(300 * time.Millisecond)
			fmt.Fprint(w, `{"skills":[]}`)
		default:
			fmt.Fprint(w, `{"skills":[]}`)
		}
	})
	g := newSkillRegistry()
	ctx := context.Background()
	if _, err := g.search(ctx, "one"); registryCode(err) != "skill_registry_busy" {
		t.Fatal("a 429 is busy", err)
	}
	if _, err := g.search(ctx, "two"); err == nil || site.count("/api/search") != 1 {
		t.Fatal("asked again during Retry-After", site.count("/api/search"))
	}
	id, _ := parseRegistryID("o/r/s")
	if repo := g.repository(ctx, id); repo.Checked || !g.githubLimited() {
		t.Fatal("GitHub's exhausted allowance must leave the repository unchecked and stop asking", repo)
	}
	g.repository(ctx, id)
	if site.count("/repos/") != 1 {
		t.Fatal("asked GitHub again while its allowance was used up")
	}
	// Any other refusal leaves the other repositories alone.
	g.githubUntil = time.Time{}
	set("github-blocked")
	other, _ := parseRegistryID("o/blocked/s")
	if repo := g.repository(ctx, other); repo.Checked || g.githubLimited() {
		t.Fatal("a refusal that is not a rate limit must not stop every lookup", repo)
	}
	g.backoffUntil = time.Time{}
	set("redirect-out")
	if _, err := g.search(ctx, "three"); registryCode(err) != "skill_registry_upstream" {
		t.Fatal("a redirect to another host followed", err)
	}
	set("redirect-nowhere")
	if _, err := g.search(ctx, "three and a half"); registryCode(err) != "skill_registry_upstream" {
		t.Fatal("a redirect that names no place taken as an answer", err)
	}
	if _, ok := g.searchCache.get("three and a half", time.Now()); ok {
		t.Fatal("a redirect that names no place was cached")
	}
	set("redirect-www")
	if hits, err := g.search(ctx, "four"); err != nil || len(hits) != 0 {
		t.Fatal("one redirect to the www. host is skills.sh's own", err)
	}
	set("redirect-twice")
	if _, err := g.search(ctx, "five"); registryCode(err) != "skill_registry_upstream" {
		t.Fatal("a second redirect followed", err)
	}
	set("huge")
	if _, err := g.search(ctx, "six"); registryCode(err) != "skill_registry_answer_too_large" {
		t.Fatal("an oversized answer read", err)
	}
	set("slow")
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := g.search(short, "seven"); registryCode(err) != "skill_registry_timeout" {
		t.Fatal("a slow answer past the deadline", err)
	}
	// With every slot taken, a request waits its bounded time and says the server is busy.
	previousWait := registrySlotWait
	registrySlotWait = 30 * time.Millisecond
	t.Cleanup(func() { registrySlotWait = previousWait })
	for i := 0; i < cap(g.slots); i++ {
		g.slots <- struct{}{}
	}
	if _, err := g.search(ctx, "eight"); registryCode(err) != "skill_registry_busy" {
		t.Fatal("no slot, no request", err)
	}
	for i := 0; i < cap(g.slots); i++ {
		<-g.slots
	}
	// Without the loopback seam, the registry's client refuses a host that resolves to this machine.
	skillRegistryTestOptions = nil
	skillRegistryBase = "http://127.0.0.1:9"
	if _, err := g.search(ctx, "nine"); registryCode(err) != "skill_registry_upstream" {
		t.Fatal("a loopback address reached", err)
	}
}

// A repository answer kept from earlier stands in for up to a day past its time when GitHub cannot be asked (no
// connection, or its allowance spent), so an import decides its license as its preview did; any other answer GitHub
// gives leaves the repository unchecked.
func TestRegistryRepositoryStandsInOnlyWhenGitHubCannotBeAsked(t *testing.T) {
	var mu sync.Mutex
	answer, now := "ok", time.Now()
	set := func(next string, later time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		answer, now = next, now.Add(later)
	}
	serveRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		current, at := answer, now
		mu.Unlock()
		switch current {
		case "ok":
			fmt.Fprint(w, `{"license":{"spdx_id":"MIT"},"stargazers_count":7}`)
		case "unreachable":
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				conn.Close()
			}
		case "limited":
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", fmt.Sprint(at.Add(10*time.Minute).Unix()))
			w.WriteHeader(403)
		case "blocked":
			w.WriteHeader(403)
		default:
			w.WriteHeader(500)
		}
	})
	g := newSkillRegistry()
	g.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	id, _ := parseRegistryID("o/r/s")
	kept := registryRepository{Checked: true, Found: true, License: "MIT", Stars: 7}
	if repo := g.repository(context.Background(), id); repo != kept {
		t.Fatal(repo)
	}
	// Seven hours on, past the answer's six, GitHub out of reach: the kept answer stands in.
	set("unreachable", 7*time.Hour)
	if repo := g.repository(context.Background(), id); repo != kept {
		t.Fatal("the kept answer did not stand in for an unreachable GitHub", repo)
	}
	for _, refusal := range []string{"blocked", "error"} {
		set(refusal, 0)
		if repo := g.repository(context.Background(), id); repo != (registryRepository{}) {
			t.Fatalf("%s: an answer that is not the repository must leave it unchecked: %+v", refusal, repo)
		}
	}
	set("limited", 0)
	if repo := g.repository(context.Background(), id); repo != kept || !g.githubLimited() {
		t.Fatal("the kept answer did not stand in for a spent allowance", repo)
	}
	// A day past the answer's time it no longer stands in.
	set("unreachable", 24*time.Hour)
	if repo := g.repository(context.Background(), id); repo != (registryRepository{}) {
		t.Fatal("an answer stood in past its day", repo)
	}
}
