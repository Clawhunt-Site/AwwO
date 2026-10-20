package app

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// The skill registry: finding a skill in the open agent-skills ecosystem (skills.sh, run by Vercel) and importing it
// into the workspace's skill library. A member searches and picks one; the API (never a model or a worker) asks
// skills.sh the way its own command-line tool does, and reads the chosen skill from skills.sh's copy of its source
// repository (skill_registry_read.go). Only SKILL.md's text is kept, through the same checks as a file a member
// uploads; the scripts and other files that come with a skill are listed but never stored or run, so an imported
// skill is method guidance like any other. A skill whose license is not a permissive one is imported only on the
// member's word that they may use it (skill_registry_license.go). skills.sh's terms ask for reasonable use of its
// public API and encourage caching, so answers are cached, each account and the whole server are rate limited, and
// every request names AwwO (skill_registry_client.go). Off unless AWWO_SKILL_REGISTRY=on.

const skillImportAction = "skill.imported"

var (
	registryOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
	registryRepoPattern  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	registrySlugPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`)
	registryHashPattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// registryCommands spots a skill written for an agent that runs commands: a shell code block, or a line that
	// starts with a typical command; registryAllowedTools, a frontmatter that names the tools it needs.
	registryCommands     = regexp.MustCompile("(?m)^\\s*(```(bash|sh|shell|zsh|console|terminal|powershell|ps1|cmd|bat)\\b|\\$ \\S|(npx|npm|pnpm|yarn|pip|pip3|uv|uvx|python|python3|node|deno|bun|curl|wget|git|docker|brew|cargo) \\S)")
	registryAllowedTools = regexp.MustCompile(`(?im)^[\t ]*allowed-tools[\t ]*:`)
)

// registryID names one skill on skills.sh: the GitHub repository it comes from and its slug there.
type registryID struct{ Owner, Repo, Slug string }

func parseRegistryID(id string) (registryID, bool) {
	parts := strings.Split(id, "/")
	if len(parts) != 3 {
		return registryID{}, false
	}
	r := registryID{parts[0], parts[1], parts[2]}
	if !registryOwnerPattern.MatchString(r.Owner) || !registryRepoPattern.MatchString(r.Repo) || r.Repo == "." || r.Repo == ".." || !registrySlugPattern.MatchString(r.Slug) {
		return registryID{}, false
	}
	return r, true
}

func (r registryID) source() string { return r.Owner + "/" + r.Repo }
func (r registryID) String() string { return r.source() + "/" + r.Slug }

// key names the skill in the registry's caches, sourceKey its repository.
func (r registryID) key() string       { return strings.ToLower(r.String()) }
func (r registryID) sourceKey() string { return strings.ToLower(r.source()) }
func (r registryID) path() string {
	return url.PathEscape(r.Owner) + "/" + url.PathEscape(r.Repo) + "/" + url.PathEscape(r.Slug)
}
func (r registryID) pageURL() string { return "https://skills.sh/" + r.path() }
func (r registryID) repoURL() string {
	return "https://github.com/" + url.PathEscape(r.Owner) + "/" + url.PathEscape(r.Repo)
}

// registryHit is one search result.
type registryHit struct {
	ID       string `json:"id"`
	Source   string `json:"source"`
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Installs int64  `json:"installs"`
	URL      string `json:"url"`
	RepoURL  string `json:"repoUrl"`
}

func registryInvalid(message string) error {
	return skillError{400, "invalid_skill_registry_request", message}
}

// registryOpen admits one registry request: the registry on, the workspace active and the account within its minute
// and its two requests at once; weight is what the request asks of skills.sh and GitHub (skillRegistry.cost). done
// ends it.
func (a *App) registryOpen(w http.ResponseWriter, r *http.Request, weight int) (done func(), ok bool) {
	if !a.cfg.SkillRegistryEnabled {
		fail(w, 503, "skill_registry_unavailable", "Finding skills on skills.sh is not enabled on this server")
		return nil, false
	}
	var status string
	if err := a.db.QueryRow(r.Context(), "SELECT status FROM tenants WHERE id=$1", r.PathValue("tenantId")).Scan(&status); err != nil {
		a.dbError(w, err)
		return nil, false
	}
	if status != "active" {
		fail(w, 403, "tenant_suspended", "Workspace is suspended")
		return nil, false
	}
	if done, ok = a.registry.beginAccount(currentUser(r).ID, weight); !ok {
		fail(w, 429, "skill_registry_rate_limited", "Too many skill searches and previews in a minute; try again shortly")
	}
	return done, ok
}

func (a *App) searchSkillRegistry(w http.ResponseWriter, r *http.Request) {
	query := strings.Join(strings.Fields(r.URL.Query().Get("q")), " ")
	if n := utf8.RuneCountInString(query); n < 2 || n > 100 || hiddenTextProblem(query) != "" {
		a.skillFailure(w, registryInvalid("Search for 2–100 characters"))
		return
	}
	done, ok := a.registryOpen(w, r, 1)
	if !ok {
		return
	}
	defer done()
	hits, err := a.registry.search(r.Context(), query)
	if err != nil {
		a.registryFailure(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"query": query, "items": hits, "source": "skills.sh"})
}

// registryImportInput is what a member may change before importing; empty fields take the skill's own values.
type registryImportInput struct {
	ID          string   `json:"id"`
	Hash        string   `json:"hash"`
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Category    string   `json:"category"`
	Applies     []string `json:"applies"`
	// LicenseConfirmed is the member's word that they may use a skill whose license is not an open one.
	LicenseConfirmed bool `json:"licenseConfirmed"`
}

// registryRecord builds the workspace skill an import saves from a SKILL.md, taking the member's changes first, then
// the file's own fields, then defaults: the slug for a name AwwO cannot use, a title made from the name, and a
// category guessed from the name and description.
func registryRecord(id registryID, markdown string, in registryImportInput) (skillRecord, error) {
	header, _, err := splitSkillMarkdown(markdown)
	if err != nil {
		return skillRecord{}, err
	}
	meta, err := frontmatterValues(header, false, func(key string) bool { return skillFrontmatterKeys[key] })
	if err != nil {
		return skillRecord{}, err
	}
	name := in.Name
	if name == "" {
		if name = strings.ToLower(meta["name"]); len(name) > 64 || !skillNamePattern.MatchString(name) {
			name = id.Slug
		}
	}
	title := in.Title
	if title == "" {
		if title = meta["title"]; title == "" {
			title = humanizeSkillName(name)
		}
	}
	category := in.Category
	if category == "" {
		if category = meta["category"]; !slices.Contains(skillCategories, category) {
			category = suggestSkillCategory(name + " " + meta["description"])
		}
	}
	applies := in.Applies
	if applies == nil {
		applies = knownSkillTags(splitSkillList(meta["applies"]))
	}
	return skillInput{Name: name, Title: title, Description: in.Description, Category: category, Applies: applies, Markdown: markdown}.record()
}

// humanizeSkillName turns `find-skills` into `Find Skills`.
func humanizeSkillName(name string) string {
	words := strings.Split(name, "-")
	for i, word := range words {
		if word != "" {
			r, size := utf8.DecodeRuneInString(word)
			words[i] = string(unicode.ToUpper(r)) + word[size:]
		}
	}
	return strings.Join(words, " ")
}

// registryCategoryWords guess an imported skill's category; the member can change it before importing.
var registryCategoryWords = []struct {
	category string
	words    []string
}{
	{"video", []string{"video", "videos", "animation", "animations", "remotion", "film", "motion", "storyboard", "youtube", "ffmpeg", "reel", "reels"}},
	{"design", []string{"design", "designs", "ui", "ux", "css", "figma", "tailwind", "visual", "typography", "brand", "branding", "accessibility", "frontend", "layout", "icons"}},
	{"data", []string{"data", "sql", "database", "databases", "postgres", "postgresql", "analytics", "chart", "charts", "spreadsheet", "spreadsheets", "excel", "csv", "dashboard", "dashboards", "pandas", "xlsx"}},
	{"research", []string{"research", "investigate", "literature", "papers", "survey", "sources", "citations", "fact-check"}},
	{"business", []string{"business", "marketing", "sales", "seo", "finance", "financial", "pricing", "startup", "strategy", "growth", "customer", "customers"}},
	{"writing", []string{"write", "writing", "copy", "copywriting", "blog", "docs", "documentation", "readme", "changelog", "content", "email", "article", "articles", "docx", "pptx", "slides"}},
}

func suggestSkillCategory(text string) string {
	words := map[string]bool{}
	for _, word := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-' }) {
		words[word] = true
	}
	best, bestHits := "engineering", 0
	for _, group := range registryCategoryWords {
		hits := 0
		for _, word := range group.words {
			if words[word] {
				hits++
			}
		}
		if hits > bestHits {
			best, bestHits = group.category, hits
		}
	}
	return best
}

// registryNotes are what the member should know before importing: files that stay behind, and commands the skill
// expects an agent to run, which a node cannot.
func registryNotes(s registrySnapshot) []string {
	notes := []string{}
	if s.FilesTotal > 0 {
		notes = append(notes, "extra_files")
	}
	if header, body, err := splitSkillMarkdown(s.Markdown); err == nil && (registryAllowedTools.MatchString(header) || registryCommands.MatchString(body)) {
		notes = append(notes, "runs_commands")
	} else if err != nil && registryCommands.MatchString(s.Markdown) {
		notes = append(notes, "runs_commands")
	}
	return notes
}

func (a *App) previewRegistrySkill(w http.ResponseWriter, r *http.Request) {
	id, ok := parseRegistryID(r.URL.Query().Get("id"))
	if !ok {
		a.skillFailure(w, registryInvalid("A skill on skills.sh is named owner/repository/skill"))
		return
	}
	done, ok := a.registryOpen(w, r, a.registry.cost(id, true))
	if !ok {
		return
	}
	defer done()
	// The skill first: an id skills.sh does not know costs nothing more. Then the repository and the security reviews,
	// advice read one after the other, so an account's two previews hold at most two of the server's request slots;
	// what is left of the request's deadline bounds them, and one that runs out is shown as not checked.
	snapshot, err := a.registry.snapshot(r.Context(), id)
	if err != nil {
		a.registryFailure(w, err)
		return
	}
	repo := a.registry.repository(r.Context(), id)
	audits := a.registry.audits(r.Context(), id)
	writeJSON(w, 200, registryPreview(id, snapshot, repo, audits))
}

// registryPreviewHash names what a member confirmed by importing from a preview: the skill's text and terms as
// skills.sh had them, and the repository's license as GitHub gave it.
func registryPreviewHash(snapshot registrySnapshot, repo registryRepository) string {
	return tokenHash(fmt.Sprintf("%s\x00%t\x00%t\x00%s", snapshot.Hash, repo.Checked, repo.Found, repo.License))
}

func registryPreview(id registryID, snapshot registrySnapshot, repo registryRepository, audits []registryAudit) map[string]any {
	s, problem := registryImportable(id, snapshot)
	if s.Applies == nil {
		s.Applies = []string{}
	}
	declared := readRegistryFrontmatter(snapshot.Markdown).declared
	return map[string]any{"id": id.String(), "source": id.source(), "slug": id.Slug, "url": id.pageURL(), "repoUrl": id.repoURL(), "hash": registryPreviewHash(snapshot, repo),
		"markdown": snapshot.Markdown, "truncated": snapshot.MarkdownBytes > len(snapshot.Markdown), "bytes": snapshot.MarkdownBytes, "maxBytes": maxSkillBodyBytes,
		"files": snapshot.Files, "filesTotal": snapshot.FilesTotal, "declaredLicense": strings.Join(declared, "; "), "license": registryLicenseOf(snapshot, repo),
		"notes": registryNotes(snapshot), "repository": repo, "audits": audits, "problem": problem,
		"skill": map[string]any{"name": s.Name, "title": s.Title, "description": s.Description, "category": s.Category, "applies": s.Applies}}
}

// registryProblem says why a skill cannot be imported as it is. A blocking one is in its text, which an import
// keeps verbatim; the others are in the fields a member can change before importing.
type registryProblem struct {
	status   int
	Code     string `json:"code"`
	Message  string `json:"message"`
	Blocking bool   `json:"blocking"`
}

// registryImportable is what an import would save by default, and the problem with it, if any.
func registryImportable(id registryID, snapshot registrySnapshot) (skillRecord, *registryProblem) {
	fallback := skillRecord{Name: id.Slug, Title: humanizeSkillName(id.Slug), Category: "engineering", Applies: []string{}}
	tooLarge := &registryProblem{413, "skill_registry_too_large", fmt.Sprintf("This skill's text is %.1f KiB; a workspace skill holds at most 12 KiB", float64(snapshot.MarkdownBytes)/1024), true}
	if snapshot.MarkdownBytes > maxRegistryPreview {
		return fallback, tooLarge
	}
	header, body, err := splitSkillMarkdown(snapshot.Markdown)
	if err == nil {
		_, err = frontmatterValues(header, false, func(key string) bool { return skillFrontmatterKeys[key] })
	}
	var input skillError
	if errors.As(err, &input) {
		return fallback, &registryProblem{422, "skill_registry_unreadable", input.message, true}
	}
	if strings.TrimSpace(body) == "" {
		return fallback, &registryProblem{422, "skill_registry_empty", "This SKILL.md has no text after its frontmatter", true}
	}
	s, err := registryRecord(id, snapshot.Markdown, registryImportInput{})
	if len(body) > maxSkillBodyBytes {
		return s, tooLarge
	}
	if hidden := hiddenTextProblem(body); hidden != "" {
		return s, &registryProblem{422, "skill_registry_hidden_text", "This skill's text contains a " + hidden + ", which AwwO does not import", true}
	}
	if errors.As(err, &input) {
		return s, &registryProblem{input.status, input.code, input.message, false}
	}
	if err != nil {
		return s, &registryProblem{422, "skill_registry_unreadable", "This skill cannot be imported", true}
	}
	return s, nil
}

func (a *App) importRegistrySkill(w http.ResponseWriter, r *http.Request) {
	var b registryImportInput
	if !a.decode(w, r, &b) {
		return
	}
	id, ok := parseRegistryID(b.ID)
	if !ok || !registryHashPattern.MatchString(b.Hash) {
		a.skillFailure(w, registryInvalid("An import names a skill on skills.sh and the copy it previewed"))
		return
	}
	done, ok := a.registryOpen(w, r, a.registry.cost(id, false))
	if !ok {
		return
	}
	defer done()
	snapshot, err := a.registry.snapshot(r.Context(), id)
	if err != nil {
		a.registryFailure(w, err)
		return
	}
	repo := a.registry.repository(r.Context(), id)
	if registryPreviewHash(snapshot, repo) != b.Hash {
		fail(w, 409, "skill_registry_changed", "This skill or its license changed since you previewed it; preview it again")
		return
	}
	s, err := registryImportRecord(id, snapshot, repo, b)
	if err != nil {
		a.skillFailure(w, err)
		return
	}
	a.skillMutation(w, r, skillImportAction, func(tx pgx.Tx, tid, actor string) (skillRecord, int, error) {
		return insertWorkspaceSkill(r.Context(), tx, tid, actor, s)
	})
}

// registryImportRecord builds the skill an import saves, refusing what its preview would have refused: a problem in
// the text itself, or a license that is not an open one without the member's confirmation.
func registryImportRecord(id registryID, snapshot registrySnapshot, repo registryRepository, b registryImportInput) (skillRecord, error) {
	if _, problem := registryImportable(id, snapshot); problem != nil && problem.Blocking {
		return skillRecord{}, skillError{problem.status, problem.Code, problem.Message}
	}
	s, err := registryRecord(id, snapshot.Markdown, b)
	if err != nil {
		return s, err
	}
	license := registryLicenseOf(snapshot, repo)
	if license.Status != "open" && !b.LicenseConfirmed {
		return s, skillError{409, "skill_registry_license_unconfirmed", "This skill's license does not clearly allow its use here; read its terms and confirm that you may use it"}
	}
	declared := readRegistryFrontmatter(snapshot.Markdown).declared
	s.Attribution = registryAttribution(id, license, repo, registryText(strings.Join(declared, "; "), 300))
	if hiddenTextProblem(s.Attribution) != "" || len(s.Attribution) > 1024 {
		return s, skillInvalid("The skill's source could not be recorded")
	}
	return s, nil
}

// registryFailure answers a registry error; anything unexpected is logged without the member's search.
func (a *App) registryFailure(w http.ResponseWriter, err error) {
	var input skillError
	if errors.As(err, &input) {
		fail(w, input.status, input.code, input.message)
		return
	}
	a.log.Warn("skill registry request failed", "error_type", fmt.Sprintf("%T", err))
	fail(w, 502, "skill_registry_upstream", "skills.sh could not be reached; try again later")
}

func (a *App) registerSkillRegistryRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/skills/registry/search", a.tenant(a.searchSkillRegistry, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/skills/registry/preview", a.tenant(a.previewRegistrySkill, 2))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/skills/registry/import", a.tenant(a.importRegistrySkill, 2))
}
