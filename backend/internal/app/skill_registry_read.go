package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The skill registry's reads (skill_registry.go): a search and a skill's folder from skills.sh, the source
// repository's license and stars from GitHub, and the security reviews skills.sh publishes. Each answer is checked and
// cut to what AwwO shows, in copies, before it is cached, so a large or odd answer costs one request and no lasting
// memory; it is parsed within its request slot, so at most four are held at once.

const (
	registrySearchLimit      = 20
	maxRegistrySearchBytes   = 512 << 10
	maxRegistryDownloadBytes = 4 << 20
	maxRegistryMetaBytes     = 256 << 10
	maxRegistryFiles         = 500
	maxRegistryListedFiles   = 100
	maxRegistryLicenseDocs   = 5
	// maxRegistryPreview is how much of a SKILL.md a preview shows and AwwO keeps; a longer one cannot be imported.
	maxRegistryPreview = 64 << 10
	maxRegistryAudits  = 8
	registryJSON       = "application/json"
)

// registrySnapshot is what AwwO keeps of skills.sh's copy of one skill's folder: at most 64 KiB of its SKILL.md, what
// that file's whole text says of its license, the folder's license and notice files (each judged whole, kept to 16 KiB)
// and the names of at most 100 other files.
type registrySnapshot struct {
	// Hash is the SHA-256 of SKILL.md's and the license and notice files' whole texts: an import saves the text its
	// preview showed, under the terms it showed.
	Hash            string
	Markdown        string
	MarkdownBytes   int
	MarkdownTerms   bool // license terms in SKILL.md itself (registryMarkdownTerms)
	LicenseDocs     []registryLicenseDoc
	LicenseOverflow bool // more license files than AwwO reads, so their terms are not all known
	Files           []registryFile
	FilesTotal      int
}

type registryFile struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
}

// registryRepository is what GitHub says about the source repository; Checked is false when it could not be asked.
type registryRepository struct {
	Checked  bool   `json:"checked"`
	Found    bool   `json:"found"`
	License  string `json:"license,omitempty"`
	Stars    int64  `json:"stars"`
	Archived bool   `json:"archived"`
}

// registryAudit is one security review skills.sh's partners published for the skill.
type registryAudit struct {
	Provider  string `json:"provider"`
	Status    string `json:"status"`
	RiskLevel string `json:"riskLevel,omitempty"`
	Summary   string `json:"summary,omitempty"`
	AuditedAt string `json:"auditedAt,omitempty"`
}

// registryText makes a short display string from a registry answer: control and hidden formatting characters
// dropped, whitespace folded, at most max characters. It reads only as much of s as such a string can come from, and
// returns a copy, so what is kept never keeps the answer it was cut from.
func registryText(s string, max int) string {
	if len(s) > max*8 {
		s = s[:max*8]
	}
	s = strings.Map(func(r rune) rune {
		if hiddenTextProblem(string(r)) != "" && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return strings.Clone(s)
}

// upstreamStatus turns a skills.sh answer that is not a success into the error a member sees (a 404 is missing only for
// a request that names a skill); a 429 also keeps the server from asking again until skills.sh says it may.
func (g *skillRegistry) upstreamStatus(resp registryResponse, namesSkill bool) error {
	switch {
	case resp.status == 200:
		return nil
	case resp.status == 404 && namesSkill:
		return skillError{404, "skill_registry_not_found", "skills.sh has no copy of this skill"}
	case resp.status == 429:
		g.waitFor(&g.backoffUntil, retryAfter(resp.header))
		return registryBusy()
	default:
		return registryUnreachable()
	}
}

func (g *skillRegistry) search(ctx context.Context, query string) ([]registryHit, error) {
	key := strings.ToLower(query)
	if hits, ok := g.searchCache.get(key, g.clock()); ok {
		return hits, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var hits []registryHit
	err := g.get(ctx, true, skillRegistryBase+"/api/search?"+url.Values{"q": {query}, "limit": {strconv.Itoa(registrySearchLimit)}}.Encode(), registryJSON, maxRegistrySearchBytes,
		func(resp registryResponse) (err error) {
			if err = g.upstreamStatus(resp, false); err == nil {
				hits, err = parseRegistrySearch(resp.body)
			}
			return err
		})
	if err != nil {
		return nil, err
	}
	g.searchCache.put(key, hits, g.clock())
	return hits, nil
}

// parseRegistrySearch keeps the results that name a GitHub repository and a slug AwwO can ask for again.
func parseRegistrySearch(body []byte) ([]registryHit, error) {
	var raw struct {
		Skills []struct {
			ID       string      `json:"id"`
			Source   string      `json:"source"`
			SkillID  string      `json:"skillId"`
			Name     string      `json:"name"`
			Installs json.Number `json:"installs"`
		} `json:"skills"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if decoder.Decode(&raw) != nil || raw.Skills == nil {
		return nil, registryUnreachable()
	}
	hits, seen := []registryHit{}, map[string]bool{}
	for _, s := range raw.Skills {
		id, ok := parseRegistryID(s.Source + "/" + s.SkillID)
		if !ok || s.ID != id.String() || seen[s.ID] {
			continue
		}
		seen[s.ID] = true
		installs, err := s.Installs.Int64()
		if err != nil || installs < 0 {
			installs = 0
		}
		name := registryText(s.Name, 128)
		if name == "" {
			name = id.Slug
		}
		hits = append(hits, registryHit{ID: id.String(), Source: id.source(), Slug: id.Slug, Name: name, Installs: installs, URL: id.pageURL(), RepoURL: id.repoURL()})
		if len(hits) == registrySearchLimit {
			break
		}
	}
	return hits, nil
}

// snapshot reads skills.sh's copy of a skill's folder (cached for a few minutes, so an import right after its preview
// reads the same copy without asking again).
func (g *skillRegistry) snapshot(ctx context.Context, id registryID) (registrySnapshot, error) {
	key := id.key()
	if s, ok := g.snapshotCache.get(key, g.clock()); ok {
		return s, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	var s registrySnapshot
	err := g.get(ctx, true, skillRegistryBase+"/api/download/"+id.path(), registryJSON, maxRegistryDownloadBytes,
		func(resp registryResponse) (err error) {
			if err = g.upstreamStatus(resp, true); err == nil {
				s, err = parseRegistrySnapshot(resp.body)
			}
			return err
		})
	if input, ok := err.(skillError); ok && input.code == "skill_registry_answer_too_large" {
		return registrySnapshot{}, registryFolderTooLarge()
	}
	if err != nil {
		return registrySnapshot{}, err
	}
	g.snapshotCache.put(key, s, g.clock())
	return s, nil
}

func registryFolderTooLarge() error {
	return skillError{502, "skill_registry_folder_too_large", "This skill's folder on skills.sh is larger than AwwO reads (4 MiB in at most 500 files)"}
}

func parseRegistrySnapshot(body []byte) (registrySnapshot, error) {
	var raw struct {
		Files []struct {
			Path     string `json:"path"`
			Contents string `json:"contents"`
		} `json:"files"`
		Hash string `json:"hash"`
	}
	if json.Unmarshal(body, &raw) != nil {
		return registrySnapshot{}, registryUnreachable()
	}
	if raw.Files == nil || raw.Hash == "" {
		return registrySnapshot{}, skillError{404, "skill_registry_not_found", "skills.sh has no copy of this skill yet"}
	}
	if len(raw.Files) > maxRegistryFiles {
		return registrySnapshot{}, registryFolderTooLarge()
	}
	s, markdown, terms := registrySnapshot{Files: []registryFile{}}, "", map[string]string{}
	found := false
	for _, f := range raw.Files {
		path := registryText(f.Path, 300)
		if path == "" || strings.HasPrefix(path, "/") || slices.Contains(strings.Split(path, "/"), "..") {
			return registrySnapshot{}, registryUnreachable()
		}
		if !found && strings.EqualFold(f.Path, "SKILL.md") {
			found, markdown = true, f.Contents
			continue
		}
		if s.addFile(path, f.Contents) {
			// Two license files under one name would leave one of them out of the hash.
			if _, twice := terms[path]; twice {
				return registrySnapshot{}, registryUnreachable()
			}
			terms[path] = f.Contents
		}
	}
	if !found {
		return registrySnapshot{}, skillError{422, "skill_registry_unimportable", "This skill has no SKILL.md, so there is no text to import"}
	}
	s.MarkdownBytes, s.Markdown = len(markdown), markdown
	_, method, err := splitSkillMarkdown(markdown)
	if err != nil {
		method = markdown
	}
	s.MarkdownTerms = markdownTerms(markdown, method)
	if len(markdown) > maxRegistryPreview {
		s.Markdown = strings.ToValidUTF8(markdown[:maxRegistryPreview], "")
	}
	s.Markdown = strings.Clone(s.Markdown)
	s.Hash = registrySnapshotHash(markdown, terms)
	sort.Slice(s.Files, func(i, j int) bool { return s.Files[i].Path < s.Files[j].Path })
	sort.Slice(s.LicenseDocs, func(i, j int) bool { return s.LicenseDocs[i].path < s.LicenseDocs[j].path })
	return s, nil
}

// registrySnapshotHash covers SKILL.md and each license or notice file, by path, in a fixed order, each part preceded
// by its length so that no two folders give the same parts.
func registrySnapshotHash(markdown string, terms map[string]string) string {
	h := sha256.New()
	part := func(s string) {
		fmt.Fprintf(h, "%d:", len(s))
		io.WriteString(h, s)
	}
	part(markdown)
	paths := make([]string, 0, len(terms))
	for path := range terms {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		part(path)
		part(terms[path])
	}
	return hex.EncodeToString(h.Sum(nil))
}

// addFile lists one of the folder's other files, and reads it when it holds the skill's terms (registryTermsFile),
// reporting so, for the snapshot's hash.
func (s *registrySnapshot) addFile(path, contents string) (terms bool) {
	s.FilesTotal++
	if len(s.Files) < maxRegistryListedFiles {
		s.Files = append(s.Files, registryFile{Path: path, Bytes: len(contents)})
	}
	kind := registryTermsFile(path)
	if kind == registryNoTerms {
		return false
	}
	// A README, and another file named for terms, is hashed either way; it counts, and is shown, only when it speaks
	// of terms.
	doc, shown := registryLicenseDoc{}, true
	switch kind {
	case registryReadmeKind:
		doc, shown = readRegistryReadme(path, contents)
	case registryNamedKind:
		doc, shown = readRegistryNamedTerms(path, contents)
	}
	switch {
	case !shown:
	case len(s.LicenseDocs) == maxRegistryLicenseDocs:
		s.LicenseOverflow = true
	case kind == registryReadmeKind || kind == registryNamedKind:
		s.LicenseDocs = append(s.LicenseDocs, doc)
	default:
		s.LicenseDocs = append(s.LicenseDocs, readRegistryLicenseDoc(path, contents, kind == registryNoticeKind))
	}
	return true
}

// repository asks GitHub for the source repository's license and stars. It is advice for the member, so when GitHub
// cannot be asked (no connection, or its anonymous allowance is spent) the last answer kept stands in for up to a day
// past its time; any other answer GitHub gives that is not the repository leaves it unchecked.
func (g *skillRegistry) repository(ctx context.Context, id registryID) registryRepository {
	key := id.sourceKey()
	if repo, ok := g.repositoryCache.get(key, g.clock()); ok {
		return repo
	}
	fallback := func() registryRepository {
		repo, _ := g.repositoryCache.stale(key, g.clock(), registryStaleFor)
		return repo
	}
	if g.githubLimited() {
		return fallback()
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	var repo registryRepository
	var limited, usable bool
	err := g.get(ctx, false, skillRegistryGitHubAPI+"/repos/"+url.PathEscape(id.Owner)+"/"+url.PathEscape(id.Repo), "application/vnd.github+json", maxRegistryMetaBytes,
		func(resp registryResponse) error {
			if wait, spent := githubRateLimit(resp, g.clock()); spent {
				g.waitFor(&g.githubUntil, wait)
				limited = true
				return nil
			}
			repo, usable = parseRegistryRepository(resp)
			return nil
		})
	switch {
	case err != nil || limited:
		return fallback()
	case !usable:
		return registryRepository{}
	}
	g.repositoryCache.put(key, repo, g.clock())
	return repo
}

// githubRateLimit says whether GitHub answered that this address's allowance is spent, and for how long; any other
// refusal (a repository GitHub blocked, say) leaves the others alone.
func githubRateLimit(resp registryResponse, now time.Time) (time.Duration, bool) {
	spent := resp.header.Get("X-RateLimit-Remaining") == "0"
	if resp.status != 429 && !(resp.status == 403 && (spent || resp.header.Get("Retry-After") != "")) {
		return 0, false
	}
	wait := retryAfter(resp.header)
	if reset, err := strconv.ParseInt(resp.header.Get("X-RateLimit-Reset"), 10, 64); err == nil && spent {
		wait = time.Unix(reset, 0).Sub(now)
	}
	return wait, true
}

func parseRegistryRepository(resp registryResponse) (registryRepository, bool) {
	switch resp.status {
	case 404:
		return registryRepository{Checked: true}, true
	case 200:
		var raw struct {
			License *struct {
				SPDX string `json:"spdx_id"`
			} `json:"license"`
			Stars    int64 `json:"stargazers_count"`
			Archived bool  `json:"archived"`
		}
		if json.Unmarshal(resp.body, &raw) != nil {
			return registryRepository{}, false
		}
		repo := registryRepository{Checked: true, Found: true, Stars: max(raw.Stars, 0), Archived: raw.Archived}
		if raw.License != nil {
			repo.License = registryText(raw.License.SPDX, 64)
		}
		return repo, true
	default:
		return registryRepository{}, false
	}
}

// audits reads the security reviews skills.sh shows for the skill: an empty list when none was published, nil when
// they could not be read.
func (g *skillRegistry) audits(ctx context.Context, id registryID) []registryAudit {
	key := id.key()
	if audits, ok := g.auditCache.get(key, g.clock()); ok {
		return audits
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	var audits []registryAudit
	var ok bool
	err := g.get(ctx, true, skillRegistryBase+"/api/v1/skills/audit/"+id.path(), registryJSON, maxRegistryMetaBytes, func(resp registryResponse) error {
		if resp.status == 429 {
			g.waitFor(&g.backoffUntil, retryAfter(resp.header))
			return nil
		}
		audits, ok = parseRegistryAudits(resp)
		return nil
	})
	if err != nil || !ok {
		return nil
	}
	g.auditCache.put(key, audits, g.clock())
	return audits
}

func parseRegistryAudits(resp registryResponse) ([]registryAudit, bool) {
	audits := []registryAudit{}
	if resp.status == 404 {
		return audits, true
	}
	var raw struct {
		Audits []struct {
			Provider, Status, RiskLevel, Summary, AuditedAt string
		} `json:"audits"`
	}
	if resp.status != 200 || json.Unmarshal(resp.body, &raw) != nil {
		return nil, false
	}
	seen := map[string]bool{}
	for _, item := range raw.Audits {
		provider, status, risk := registryText(item.Provider, 80), strings.ToLower(item.Status), strings.ToUpper(item.RiskLevel)
		if provider == "" || seen[provider] || !slices.Contains([]string{"pass", "warn", "fail"}, status) {
			continue
		}
		seen[provider] = true
		if !slices.Contains([]string{"NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"}, risk) {
			risk = ""
		}
		when := ""
		if t, err := time.Parse(time.RFC3339, item.AuditedAt); err == nil {
			when = t.UTC().Format(time.RFC3339)
		}
		audits = append(audits, registryAudit{Provider: provider, Status: strings.Clone(status), RiskLevel: strings.Clone(risk), Summary: registryText(item.Summary, 600), AuditedAt: when})
		if len(audits) == maxRegistryAudits {
			break
		}
	}
	return audits, true
}
