package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"
)

// The Agent market (docs/awwo-agent-market.md). An author publishes an Agent: instructions a caller never sees, up to
// four skills frozen when the draft is saved, a recommended model and a price per call in credits. A platform
// administrator approves each version before it lists (market_admin.go); callers use it on canvas nodes
// (market_use.go), where a successful run pays its price; the author's share is settled once the caller's billing
// period has closed and transferred to the author's ClawHunt wallet (market_settle.go). The market is the
// deployment's, not a workspace's: browsing and publishing are signed-in account routes, and using an Agent is
// decided by the calling workspace.

const (
	marketMaxNameRunes          = 60
	marketMaxTaglineRunes       = 120
	marketMaxDescriptionRunes   = 4000
	marketMaxInstructionsBytes  = 32000
	marketMaxExamples           = 3
	marketMaxExamplePromptRunes = 2000
	marketMaxExampleResultRunes = 4000
	marketMaxAuthorRunes        = 40
	marketMaxReviewNoteRunes    = 2000
	// An account may hold this many Agents (drafts included), so the review queue cannot be flooded.
	marketMaxAgentsPerAuthor = 30
)

var marketCategories = []string{"page", "writing", "research", "code", "design", "media", "business", "education", "other"}

// marketSkill is a skill frozen into a version: the exact text a run sends, and where it came from.
type marketSkill struct {
	Ref string `json:"ref"`
	// TenantID is the workspace a workspace skill was frozen from, so its author can send the same reference again.
	TenantID    string `json:"tenantId,omitempty"`
	Name        string `json:"name"`
	Title       string `json:"title"`
	Version     int64  `json:"version"`
	Source      string `json:"source"`
	Attribution string `json:"attribution,omitempty"`
	ContentHash string `json:"contentHash"`
	Body        string `json:"body"`
}

type marketExample struct {
	Prompt string `json:"prompt"`
	Result string `json:"result"`
}

// marketModel is the model an author recommends; locked, a caller's node runs it and no other.
type marketModel struct {
	Runtime string `json:"runtime"`
	ID      string `json:"id"`
	Effort  string `json:"effort"`
	Locked  bool   `json:"locked"`
}

// marketVersion is one version as stored.
type marketVersion struct {
	AgentID            string
	Version            int
	State              string
	Name               string
	Tagline            string
	Description        string
	Category           string
	Kind               string
	Instructions       string
	InstructionsPublic bool
	Skills             []marketSkill
	Model              marketModel
	Price              int
	Examples           []marketExample
	ContentHash        string
	// AuthorName is the name the market shows for the author, reviewed with the version and shown once it lists.
	AuthorName  string
	ReviewNote  string
	SubmittedAt *time.Time
	ReviewedAt  *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const marketVersionColumns = `v.agent_id,v.version,v.state,v.name,v.tagline,v.description,v.category,v.kind,v.instructions,v.instructions_public,
	v.skills,v.runtime,v.model,v.effort,v.model_locked,v.price_credits,v.examples,v.content_hash,v.author_display,v.review_note,v.submitted_at,v.reviewed_at,v.created_at,v.updated_at`

func scanMarketVersion(row pgx.Row) (marketVersion, error) {
	var v marketVersion
	var skills, examples []byte
	if err := row.Scan(&v.AgentID, &v.Version, &v.State, &v.Name, &v.Tagline, &v.Description, &v.Category, &v.Kind, &v.Instructions,
		&v.InstructionsPublic, &skills, &v.Model.Runtime, &v.Model.ID, &v.Model.Effort, &v.Model.Locked, &v.Price, &examples,
		&v.ContentHash, &v.AuthorName, &v.ReviewNote, &v.SubmittedAt, &v.ReviewedAt, &v.CreatedAt, &v.UpdatedAt); err != nil {
		return v, err
	}
	if json.Unmarshal(skills, &v.Skills) != nil || json.Unmarshal(examples, &v.Examples) != nil {
		return v, errors.New("market version holds invalid skills or examples")
	}
	if v.Skills == nil {
		v.Skills = []marketSkill{}
	}
	if v.Examples == nil {
		v.Examples = []marketExample{}
	}
	return v, nil
}

// marketAgentRow is an Agent's own record.
type marketAgentRow struct {
	ID            string
	AuthorUserID  *string
	AuthorDisplay string
	Official      bool
	Status        string
	ListedVersion *int
	ListedAt      *time.Time
	CreatedAt     time.Time
}

const marketAgentColumns = `m.id,m.author_user_id,m.author_display,m.official,m.status,m.listed_version,m.listed_at,m.created_at`

func scanMarketAgent(row pgx.Row) (marketAgentRow, error) {
	var m marketAgentRow
	err := row.Scan(&m.ID, &m.AuthorUserID, &m.AuthorDisplay, &m.Official, &m.Status, &m.ListedVersion, &m.ListedAt, &m.CreatedAt)
	return m, err
}

// usable reports whether a caller other than the author may start using the Agent now: listed, with a listed
// version, and either official or still with an author (a deleted author's Agents list no more).
func (m marketAgentRow) usable() bool {
	return m.Status == "listed" && m.ListedVersion != nil && (m.Official || m.AuthorUserID != nil)
}

func (m marketAgentRow) authoredBy(userID string) bool {
	return m.AuthorUserID != nil && *m.AuthorUserID == userID
}

type marketError struct {
	status        int
	code, message string
}

func (e marketError) Error() string { return e.message }

func marketInvalid(message string) error { return marketError{400, "market_draft_invalid", message} }

func marketNotFound() error {
	return marketError{404, "market_agent_not_found", "This Agent is not in the market"}
}

func (a *App) marketFailure(w http.ResponseWriter, err error) {
	var input marketError
	var skill skillError
	switch {
	case errors.As(err, &input):
		fail(w, input.status, input.code, input.message)
	case errors.As(err, &skill):
		fail(w, skill.status, skill.code, skill.message)
	case noRows(err):
		fail(w, 404, "market_agent_not_found", "This Agent is not in the market")
	default:
		a.dbError(w, err)
	}
}

// marketEnabled answers a market route while the market is off as if it did not exist.
func (a *App) marketEnabled(w http.ResponseWriter) bool {
	if !a.cfg.MarketEnabled {
		fail(w, 404, "market_unavailable", "The Agent market is not open on this site")
		return false
	}
	return true
}

func (a *App) marketRoute(next http.HandlerFunc) http.HandlerFunc {
	return a.auth(func(w http.ResponseWriter, r *http.Request) {
		if a.marketEnabled(w) {
			next(w, r)
		}
	})
}

func (a *App) marketAdminRoute(next http.HandlerFunc) http.HandlerFunc {
	return a.admin(func(w http.ResponseWriter, r *http.Request) {
		if a.marketEnabled(w) {
			next(w, r)
		}
	})
}

func (a *App) registerMarketRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/market/agents", a.marketRoute(a.listMarketAgents))
	m.HandleFunc("POST /api/v1/market/agents", a.marketRoute(a.createMarketAgent))
	m.HandleFunc("GET /api/v1/market/agents/{id}", a.marketRoute(a.getMarketAgent))
	m.HandleFunc("GET /api/v1/market/agents/{id}/draft", a.marketRoute(a.getMarketDraft))
	m.HandleFunc("PUT /api/v1/market/agents/{id}/draft", a.marketRoute(a.updateMarketDraft))
	m.HandleFunc("POST /api/v1/market/agents/{id}/submit", a.marketRoute(a.marketAuthorAction("submit")))
	m.HandleFunc("POST /api/v1/market/agents/{id}/withdraw", a.marketRoute(a.marketAuthorAction("withdraw")))
	m.HandleFunc("POST /api/v1/market/agents/{id}/unlist", a.marketRoute(a.marketAuthorAction("unlist")))
	m.HandleFunc("POST /api/v1/market/agents/{id}/list", a.marketRoute(a.marketAuthorAction("list")))
	m.HandleFunc("GET /api/v1/market/mine", a.marketRoute(a.myMarketAgents))
	m.HandleFunc("GET /api/v1/admin/market/reviews", a.marketAdminRoute(a.marketReviews))
	m.HandleFunc("POST /api/v1/admin/market/reviews/{id}/{version}", a.marketAdminRoute(a.decideMarketReview))
	m.HandleFunc("POST /api/v1/admin/market/agents/{id}/status", a.marketAdminRoute(a.setMarketAgentStatus))
	// Closing the market stops new use, never the settling and paying of what was earned (market_config.go): an
	// author still reads their earnings, and an admin the transfers, while it is closed.
	m.HandleFunc("GET /api/v1/market/earnings", a.auth(a.marketEarnings))
	m.HandleFunc("GET /api/v1/admin/market/payouts", a.admin(a.marketPayoutList))
	m.HandleFunc("PUT /api/v1/tenants/{tenantId}/runs/{id}/market-rating", a.tenant(a.rateMarketRun, 2))
}

// marketCapability is what /capabilities tells the web app about the market.
func (a *App) marketCapability() map[string]any {
	return map[string]any{"enabled": a.cfg.MarketEnabled, "payouts": a.cfg.MarketPayouts,
		"feeBps": a.cfg.MarketFeeBps, "maxPrice": a.cfg.MarketMaxPrice, "holdDays": a.cfg.MarketHoldDays}
}

// marketDraftInput is what an author sends for a draft.
type marketDraftInput struct {
	Name               string          `json:"name"`
	Tagline            string          `json:"tagline"`
	Description        string          `json:"description"`
	Category           string          `json:"category"`
	Kind               string          `json:"kind"`
	Instructions       string          `json:"instructions"`
	InstructionsPublic bool            `json:"instructionsPublic"`
	Skills             []marketSkillIn `json:"skills"`
	Model              marketModel     `json:"model"`
	Price              int             `json:"price"`
	Examples           []marketExample `json:"examples"`
	AuthorName         string          `json:"authorName"`
}

// marketSkillIn names a skill to freeze: a built-in, or a skill of a workspace the author is a member of.
type marketSkillIn struct {
	TenantID string `json:"tenantId"`
	Ref      string `json:"ref"`
}

// marketText checks one text field: trimmed, within limit characters, on one line unless multiline, and free of
// hidden characters.
func marketText(field, value string, limit int, required, multiline bool) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\r\n", "\n"))
	if required && value == "" {
		return "", marketInvalid(field + " is required")
	}
	if utf8.RuneCountInString(value) > limit {
		return "", marketInvalid(fmt.Sprintf("%s is at most %d characters", field, limit))
	}
	if !multiline && strings.ContainsAny(value, "\n\t") {
		return "", marketInvalid(field + " is one line")
	}
	if problem := marketHiddenText(value); problem != "" {
		return "", marketError{400, "market_hidden_text", field + " may not contain " + problem}
	}
	return value, nil
}

// marketHiddenText names the first character a market text may not carry, as hiddenTextProblem does and beyond it:
// a reviewer reads every version before it lists, so nothing it holds may be invisible or look like what it is not.
// That is every other control (C1 included), format (Cf: soft hyphens, joiners, marks) and private-use character, the
// line and paragraph separators, noncharacters, the Hangul fillers that show as blanks, and variation selectors but a
// single U+FE0E or U+FE0F after a character (text or emoji presentation).
func marketHiddenText(s string) string {
	if problem := hiddenTextProblem(s); problem != "" {
		return problem
	}
	prev := rune(-1)
	for _, r := range s {
		switch {
		case r == '\n' || r == '\t':
		case unicode.Is(unicode.Cc, r), unicode.Is(unicode.Cf, r):
			return fmt.Sprintf("hidden formatting character U+%04X", r)
		case unicode.Is(unicode.Co, r):
			return fmt.Sprintf("private-use character U+%04X", r)
		case r == 0x2028 || r == 0x2029:
			return fmt.Sprintf("line or paragraph separator U+%04X", r)
		case r >= 0xfdd0 && r <= 0xfdef, r&0xfffe == 0xfffe:
			return fmt.Sprintf("noncharacter U+%04X", r)
		case r == 0x115f || r == 0x1160 || r == 0x3164 || r == 0xffa0:
			return fmt.Sprintf("blank filler character U+%04X", r)
		case r == 0xfe0e || r == 0xfe0f:
			if prev < 0 || prev == '\n' || prev == '\t' || prev == ' ' || isVariationSelector(prev) {
				return fmt.Sprintf("variation selector U+%04X", r)
			}
		case isVariationSelector(r):
			return fmt.Sprintf("variation selector U+%04X", r)
		}
		prev = r
	}
	return ""
}

func isVariationSelector(r rune) bool {
	return (r >= 0xfe00 && r <= 0xfe0f) || (r >= 0x180b && r <= 0x180d) || r == 0x180f || (r >= 0xe0100 && r <= 0xe01ef)
}

// marketReservedNames are words no name in the market may hold, an Agent's or its author's: the platform's own names,
// and a claim to be official, so that no author passes for AwwO (its own Agents show no author).
var marketReservedNames = []string{"awwo", "clawhunt", "阿呜", "阿嗚", "official", "官方"}

// marketLookalikes folds what a name's reader takes for a Latin letter: the Cyrillic and Greek letters drawn alike
// (lower case, as names are lowered first), and the digits and signs written for letters. l, 1 and i fold together, so
// each word is folded the same way before it is looked for. A small part of Unicode's confusables (UTS #39); the letters
// are escaped here, as they are drawn like the Latin ones they stand for.
var marketLookalikes = map[rune]rune{
	// Cyrillic
	'\u0430': 'a', '\u0432': 'b', '\u0441': 'c', '\u0501': 'd', '\u0435': 'e', '\u0451': 'e', '\u04bb': 'h', '\u043d': 'h',
	'\u0456': 'i', '\u04cf': 'i', '\u0458': 'j', '\u043a': 'k', '\u043c': 'm', '\u043e': 'o', '\u0440': 'p', '\u051b': 'q',
	'\u0455': 's', '\u0442': 't', '\u0443': 'y', '\u04af': 'y', '\u0445': 'x', '\u051d': 'w',
	// Greek
	'\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b7': 'h', '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'm', '\u03bd': 'n',
	'\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'y', '\u03c7': 'x', '\u03c9': 'w', '\u03b6': 'z', '\u03f2': 'c',
	// Digits and signs
	'0': 'o', '1': 'i', 'l': 'i', '3': 'e', '5': 's', '$': 's', '@': 'a',
}

// marketNameSkeleton is a name as it reads for the reserved-name check: NFKC-folded, in lower case, look-alikes folded,
// "vv" and "rn" read as the w and m they pass for, and everything but letters and digits left out.
func marketNameSkeleton(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(norm.NFKC.String(value)) {
		if folded, ok := marketLookalikes[r]; ok {
			r = folded
		}
		b.WriteRune(r)
	}
	read := strings.NewReplacer("vv", "w", "rn", "m").Replace(b.String())
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return r
		}
		return -1
	}, read)
}

func marketReservedName(value string) bool {
	folded := marketNameSkeleton(value)
	for _, word := range marketReservedNames {
		if strings.Contains(folded, marketNameSkeleton(word)) {
			return true
		}
	}
	return false
}

// marketAuthorName checks the author's name a version shows.
func marketAuthorName(value string) (string, error) {
	name, err := marketText("authorName", value, marketMaxAuthorRunes, false, false)
	if err != nil {
		return "", err
	}
	if marketReservedName(name) {
		return "", marketError{400, "market_name_reserved", "The author name may not use AwwO's or ClawHunt's name or claim to be official"}
	}
	return name, nil
}

// validMarketModelID: a model id as a worker lists one, in printable ASCII without spaces or commas.
func validMarketModelID(id string) bool {
	if !validModelID(id) {
		return false
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 0x21 || id[i] > 0x7e {
			return false
		}
	}
	return true
}

// validate turns a draft request into the version it would store (skills not yet frozen): every limit of the
// contract, checked on what is kept.
func (in marketDraftInput) validate(maxPrice int) (marketVersion, string, error) {
	var v marketVersion
	var err error
	if v.Name, err = marketText("name", in.Name, marketMaxNameRunes, true, false); err != nil {
		return v, "", err
	}
	if marketReservedName(v.Name) {
		return v, "", marketError{400, "market_name_reserved", "The name may not use AwwO's or ClawHunt's name or claim to be official"}
	}
	if v.Tagline, err = marketText("tagline", in.Tagline, marketMaxTaglineRunes, true, false); err != nil {
		return v, "", err
	}
	if v.Description, err = marketText("description", in.Description, marketMaxDescriptionRunes, false, true); err != nil {
		return v, "", err
	}
	author, err := marketAuthorName(in.AuthorName)
	if err != nil {
		return v, "", err
	}
	if !slices.Contains(marketCategories, in.Category) {
		return v, "", marketInvalid("Unknown category")
	}
	v.Category = in.Category
	// A market Agent is a text Agent for now: the market does not yet run a third party's Agent with a sandbox's files,
	// shell and network (market_use.go).
	switch in.Kind {
	case "", "llm":
		v.Kind = "llm"
	default:
		return v, "", marketInvalid("A market Agent is a text (llm) Agent")
	}
	v.Instructions = strings.ReplaceAll(in.Instructions, "\r\n", "\n")
	if strings.TrimSpace(v.Instructions) == "" || len(v.Instructions) > marketMaxInstructionsBytes {
		return v, "", marketInvalid(fmt.Sprintf("Instructions of 1–%d bytes are required", marketMaxInstructionsBytes))
	}
	if problem := marketHiddenText(v.Instructions); problem != "" {
		return v, "", marketError{400, "market_hidden_text", "The instructions may not contain " + problem}
	}
	v.InstructionsPublic = in.InstructionsPublic
	if in.Price < 0 || in.Price > maxPrice {
		return v, "", marketError{400, "market_price_invalid", fmt.Sprintf("The price per call is 0 to %d credits", maxPrice)}
	}
	v.Price = in.Price
	m := in.Model
	m.Runtime, m.ID, m.Effort = strings.TrimSpace(m.Runtime), strings.TrimSpace(m.ID), strings.TrimSpace(m.Effort)
	if (m.Runtime != "" && (!validRuntime(m.Runtime) || m.Runtime == runtimeSandbox)) || (m.ID != "" && !validMarketModelID(m.ID)) ||
		!validEffortLevel(m.Effort) || (m.Effort != "" && m.ID == "") {
		return v, "", marketInvalid("The recommended model names a text runtime, a model and an effort the way a node does")
	}
	if m.Locked && m.ID == "" {
		return v, "", marketInvalid("Only a named model can be locked")
	}
	if m.ID != "" && m.Runtime == "" {
		m.Runtime = defaultRuntime("")
	}
	v.Model = m
	if len(in.Examples) > marketMaxExamples {
		return v, "", marketInvalid(fmt.Sprintf("At most %d examples", marketMaxExamples))
	}
	v.Examples = []marketExample{}
	for _, e := range in.Examples {
		prompt, err := marketText("example prompt", e.Prompt, marketMaxExamplePromptRunes, true, true)
		if err != nil {
			return v, "", err
		}
		result, err := marketText("example result", e.Result, marketMaxExampleResultRunes, false, true)
		if err != nil {
			return v, "", err
		}
		v.Examples = append(v.Examples, marketExample{Prompt: prompt, Result: result})
	}
	if len(in.Skills) > maxNodeSkills {
		return v, "", marketInvalid(fmt.Sprintf("An Agent takes at most %d skills", maxNodeSkills))
	}
	return v, author, nil
}

// freezeMarketSkills copies each named skill's current text. A workspace skill must belong to a workspace the
// author is a member of, and one imported from skills.sh without a known open license cannot be republished.
func freezeMarketSkills(ctx context.Context, q querier, userID string, refs []marketSkillIn) ([]marketSkill, error) {
	out := []marketSkill{}
	seen := map[string]bool{}
	total := 0
	for _, in := range refs {
		if !skillRefPattern.MatchString(in.Ref) || seen[in.Ref] {
			return nil, marketInvalid("Each skill is a distinct builtin:<name> or workspace:<id> reference")
		}
		seen[in.Ref] = true
		tid := ""
		if strings.HasPrefix(in.Ref, skillRefWorkspace) {
			var member bool
			if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.role IN ('member','admin','owner') AND t.status='active')", in.TenantID, userID).Scan(&member); err != nil {
				return nil, err
			}
			if !member {
				return nil, marketError{409, "market_skill_unavailable", "A skill comes from a workspace you are not a member of: " + in.Ref}
			}
			tid = in.TenantID
		}
		s, err := resolveSkill(ctx, q, tid, in.Ref)
		var missing skillError
		if errors.As(err, &missing) && missing.status == 404 {
			return nil, marketError{409, "market_skill_unavailable", "A skill is no longer available: " + in.Ref}
		}
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(s.Attribution, "Imported from skills.sh") && strings.Contains(s.Attribution, "not known to be an open license") {
			return nil, marketError{409, "market_skill_license", "A skill imported from skills.sh without a known open license cannot go into the market: " + s.Name}
		}
		// A skill's own checks are a workspace's; what goes into the market is checked as every market text is.
		for _, text := range []string{s.Name, s.Title, s.Body, s.Attribution} {
			if problem := marketHiddenText(text); problem != "" {
				return nil, marketError{400, "market_hidden_text", "The skill " + s.Name + " may not contain " + problem}
			}
		}
		total += len(s.Body)
		out = append(out, marketSkill{Ref: s.Ref, TenantID: tid, Name: s.Name, Title: s.Title, Version: s.Version, Source: s.Source, Attribution: s.Attribution, ContentHash: s.ContentHash, Body: s.Body})
	}
	if total > maxNodeSkillBytes {
		return nil, marketError{413, "skill_context_limit", fmt.Sprintf("The skills add %d bytes; at most %d fit in one call. Remove a skill.", total, maxNodeSkillBytes)}
	}
	return out, nil
}

// marketContentHash identifies what a caller runs: the instructions, skills and model, so the same text cited by
// two versions has one hash.
func marketContentHash(v marketVersion) string {
	raw, _ := json.Marshal(struct {
		Kind         string        `json:"kind"`
		Instructions string        `json:"instructions"`
		Skills       []marketSkill `json:"skills"`
		Model        marketModel   `json:"model"`
	}{v.Kind, v.Instructions, v.Skills, v.Model})
	return tokenHash(string(raw))
}

// marketSkillsSummary is a version's skills as a caller may see them: names and where they came from, never the text
// unless the instructions are public. Its author and an administrator also get the text and the reference each was
// frozen from (full).
func marketSkillsSummary(skills []marketSkill, withBody, full bool) []map[string]any {
	out := []map[string]any{}
	for _, s := range skills {
		item := map[string]any{"name": s.Name, "title": s.Title, "source": s.Source, "attribution": s.Attribution}
		if withBody || full {
			item["body"] = s.Body
		}
		if full {
			item["ref"], item["tenantId"] = s.Ref, s.TenantID
		}
		out = append(out, item)
	}
	return out
}
