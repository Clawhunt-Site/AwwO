package app

import (
	"context"
	"encoding/base64"
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Browsing the market and how it ranks Agents. The ranking reads only what calls did (market_agent_calls) over the
// last marketStatsWindow: a call by the author or in a workspace the author owns (insider), a cancelled one, one still
// running, one whose canvas node then failed its own delivery checks and one that failed for any reason but one the
// Agent itself causes (platform_fault; marketAgentFaults, market_use.go) count for nothing; a completed call is a
// success unless its caller rated it 👎; a call failed by the Agent itself is a failure. So that the ranking costs
// what it shows, only calls at the listed version's price or above count (a free version's calls do not rank a paid
// one), and at most marketDailyCount of one person's calls of one Agent a day. The score is the lower bound of the
// Wilson interval of the success rate (95%), so few calls rank low, and an Agent ranks once it has marketRankRuns
// counted calls from marketRankUsers people.

const (
	marketStatsWindow = 30 * 24 * time.Hour
	marketStatsTTL    = time.Minute
	marketRankRuns    = 10
	marketRankUsers   = 3
	marketDailyCount  = 3
	marketPageLimit   = 50
	// The furthest a listing's cursor may point.
	marketListCap = 100000
)

type marketStatRow struct {
	Runs, Successes, Users, Up, Down int
	AvgMs                            *float64
	AvgCredits                       *float64
}

func (s marketStatRow) successRate() *float64 {
	if s.Runs == 0 {
		return nil
	}
	v := float64(s.Successes) / float64(s.Runs)
	return &v
}

func (s marketStatRow) ranked() bool { return s.Runs >= marketRankRuns && s.Users >= marketRankUsers }

// score is the Wilson lower bound of the success rate at 95%.
func (s marketStatRow) score() float64 {
	if s.Runs == 0 {
		return 0
	}
	const z = 1.959964
	n := float64(s.Runs)
	p := float64(s.Successes) / n
	return (p + z*z/(2*n) - z*math.Sqrt(p*(1-p)/n+z*z/(4*n*n))) / (1 + z*z/n)
}

func (s marketStatRow) json() map[string]any {
	out := map[string]any{"calls": s.Runs, "users": s.Users, "successRate": s.successRate(), "up": s.Up, "down": s.Down,
		"avgSeconds": nil, "avgModelCredits": nil, "score": nil, "ranked": s.ranked()}
	if s.AvgMs != nil {
		out["avgSeconds"] = math.Round(*s.AvgMs/100) / 10
	}
	if s.AvgCredits != nil {
		out["avgModelCredits"] = math.Round(*s.AvgCredits)
	}
	if s.ranked() {
		out["score"] = math.Round(s.score()*1000) / 1000
	}
	return out
}

type marketStatsCache struct {
	mu   sync.Mutex
	at   time.Time
	gen  int
	rows map[string]marketStatRow
}

// forget makes the next read of the figures read them again, and keeps a read already under way from storing what it
// read before.
func (c *marketStatsCache) forget() {
	c.mu.Lock()
	c.at = time.Time{}
	c.gen++
	c.mu.Unlock()
}

// marketCountedCall is the calls the ranking counts; marketSuccessfulCall the ones among them that succeeded.
const marketCountedCall = `(NOT c.insider AND c.outcome NOT IN ('','cancelled','delivery_failed') AND NOT c.platform_fault)`
const marketSuccessfulCall = `(c.outcome='completed' AND NOT EXISTS(SELECT 1 FROM market_agent_ratings x WHERE x.call_id=c.id AND x.score=-1))`

// marketStatsFor reads every Agent's figures over the window, kept for marketStatsTTL. The lock is not held while the
// figures are read, so a slow read holds up no other request.
func (a *App) marketStatsFor(ctx context.Context) (map[string]marketStatRow, error) {
	c := &a.marketStats
	c.mu.Lock()
	cached, at, gen := c.rows, c.at, c.gen
	c.mu.Unlock()
	if cached != nil && time.Since(at) < marketStatsTTL {
		return cached, nil
	}
	out, err := a.readMarketStats(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.gen == gen {
		c.rows, c.at = out, time.Now()
	}
	c.mu.Unlock()
	return out, nil
}

func (a *App) readMarketStats(ctx context.Context) (map[string]marketStatRow, error) {
	window := strconv.Itoa(int(marketStatsWindow.Seconds())) + " seconds"
	// Each counted call numbered within its person's calls of the Agent that day (UTC); the first marketDailyCount count.
	rows, err := a.db.Query(ctx, `WITH counted AS (
		SELECT c.id,c.agent_id,c.actor_id,c.outcome,c.duration_ms,c.model_credits,
			row_number() OVER (PARTITION BY c.agent_id,c.actor_id,(c.created_at AT TIME ZONE 'UTC')::date ORDER BY c.created_at,c.id) AS nth
		FROM market_agent_calls c JOIN market_agents m ON m.id=c.agent_id
		LEFT JOIN market_agent_versions lv ON lv.agent_id=m.id AND lv.version=m.listed_version
		WHERE c.created_at > clock_timestamp() - $1::interval AND `+marketCountedCall+` AND c.price_credits >= COALESCE(lv.price_credits,0))
		SELECT c.agent_id,count(*),count(*) FILTER (WHERE `+marketSuccessfulCall+`),count(DISTINCT c.actor_id),
			avg(c.duration_ms) FILTER (WHERE c.outcome='completed'),
			avg(c.model_credits) FILTER (WHERE c.outcome='completed' AND c.model_credits IS NOT NULL)
		FROM counted c WHERE c.nth <= $2 GROUP BY c.agent_id`, window, marketDailyCount)
	if err != nil {
		return nil, err
	}
	out := map[string]marketStatRow{}
	for rows.Next() {
		var id string
		var s marketStatRow
		if err = rows.Scan(&id, &s.Runs, &s.Successes, &s.Users, &s.AvgMs, &s.AvgCredits); err != nil {
			rows.Close()
			return nil, err
		}
		out[id] = s
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// The ratings shown, of every call but an insider's.
	rows, err = a.db.Query(ctx, `SELECT c.agent_id,count(*) FILTER (WHERE x.score=1),count(*) FILTER (WHERE x.score=-1)
		FROM market_agent_ratings x JOIN market_agent_calls c ON c.id=x.call_id
		WHERE NOT c.insider AND c.created_at > clock_timestamp() - $1::interval GROUP BY c.agent_id`, window)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var up, down int
		if err = rows.Scan(&id, &up, &down); err != nil {
			return nil, err
		}
		s := out[id]
		s.Up, s.Down = up, down
		out[id] = s
	}
	return out, rows.Err()
}

// marketSummary is an Agent as the market lists it, at version v, under the author's name its listed version was
// approved with.
func marketSummary(m marketAgentRow, v marketVersion, s marketStatRow) map[string]any {
	var author any
	if !m.Official {
		author = map[string]any{"name": m.AuthorDisplay}
	}
	return map[string]any{"id": m.ID, "name": v.Name, "tagline": v.Tagline, "category": v.Category, "kind": v.Kind, "official": m.Official,
		"author": author, "price": v.Price, "version": v.Version, "model": v.Model, "listedAt": m.ListedAt, "stats": s.json()}
}

type marketListing struct {
	agent   marketAgentRow
	version marketVersion
	stats   marketStatRow
}

func (a *App) listMarketAgents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	q := strings.TrimSpace(query.Get("q"))
	category, sortBy := query.Get("category"), query.Get("sort")
	if utf8.RuneCountInString(q) > 100 || (category != "" && !slices.Contains(marketCategories, category)) {
		fail(w, 400, "invalid_input", "Search for at most 100 characters in a known category")
		return
	}
	switch sortBy {
	case "", "score", "calls", "new", "price":
	default:
		fail(w, 400, "invalid_input", "Sort by score, calls, new or price")
		return
	}
	limit := 24
	if raw := query.Get("limit"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > marketPageLimit {
			fail(w, 400, "invalid_pagination", "limit is 1 to 50")
			return
		}
		limit = v
	}
	offset := 0
	if raw := query.Get("cursor"); raw != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		v, convErr := strconv.Atoi(string(decoded))
		if err != nil || convErr != nil || v < 0 || v > marketListCap {
			fail(w, 400, "invalid_cursor", "Invalid cursor")
			return
		}
		offset = v
	}
	pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
	// What a card shows (marketSummary), never the instructions and skills a run takes.
	rows, err := a.db.Query(ctx, `SELECT `+marketAgentColumns+`,v.version,v.name,v.tagline,v.category,v.kind,v.runtime,v.model,v.effort,v.model_locked,v.price_credits
		FROM market_agents m JOIN market_agent_versions v ON v.agent_id=m.id AND v.version=m.listed_version
		WHERE m.status='listed' AND (m.official OR m.author_user_id IS NOT NULL)
		AND ($1='' OR v.category=$1)
		AND ($2='' OR v.name ILIKE $3 OR v.tagline ILIKE $3 OR v.description ILIKE $3)
		ORDER BY m.listed_at DESC NULLS LAST, m.id`, category, q, pattern)
	if err != nil {
		a.dbError(w, err)
		return
	}
	list := []marketListing{}
	for rows.Next() {
		var l marketListing
		if err = rows.Scan(&l.agent.ID, &l.agent.AuthorUserID, &l.agent.AuthorDisplay, &l.agent.Official, &l.agent.Status, &l.agent.ListedVersion,
			&l.agent.ListedAt, &l.agent.CreatedAt, &l.version.Version, &l.version.Name, &l.version.Tagline, &l.version.Category, &l.version.Kind,
			&l.version.Model.Runtime, &l.version.Model.ID, &l.version.Model.Effort, &l.version.Model.Locked, &l.version.Price); err != nil {
			rows.Close()
			a.dbError(w, err)
			return
		}
		list = append(list, l)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		a.dbError(w, err)
		return
	}
	stats, err := a.marketStatsFor(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	for i := range list {
		list[i].stats = stats[list[i].agent.ID]
	}
	sortMarketListing(list, sortBy)
	items := []map[string]any{}
	for i := offset; i < len(list) && len(items) < limit; i++ {
		items = append(items, marketSummary(list[i].agent, list[i].version, list[i].stats))
	}
	var next any
	if offset+limit < len(list) {
		next = base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset + limit)))
	}
	writeJSON(w, 200, map[string]any{"items": items, "nextCursor": next})
}

// sortMarketListing orders a listing: by score (ranked Agents first, then the newest unranked), by counted calls,
// by when they listed, or by price (cheapest first). Ties fall back to the newest listing, then the id.
func sortMarketListing(list []marketListing, by string) {
	newer := func(x, y marketListing) bool {
		if x.agent.ListedAt != nil && y.agent.ListedAt != nil && !x.agent.ListedAt.Equal(*y.agent.ListedAt) {
			return x.agent.ListedAt.After(*y.agent.ListedAt)
		}
		return x.agent.ID < y.agent.ID
	}
	sort.SliceStable(list, func(i, j int) bool {
		x, y := list[i], list[j]
		switch by {
		case "calls":
			if x.stats.Runs != y.stats.Runs {
				return x.stats.Runs > y.stats.Runs
			}
		case "new":
		case "price":
			if x.version.Price != y.version.Price {
				return x.version.Price < y.version.Price
			}
		default:
			if x.stats.ranked() != y.stats.ranked() {
				return x.stats.ranked()
			}
			if x.stats.ranked() {
				if sx, sy := x.stats.score(), y.stats.score(); sx != sy {
					return sx > sy
				}
				if x.stats.Users != y.stats.Users {
					return x.stats.Users > y.stats.Users
				}
			}
		}
		return newer(x, y)
	})
}

// getMarketAgent answers one Agent: its listed version for anyone signed in, and for its author or an administrator
// also an Agent that is not listed (the author's view adds its status and latest version). ?version=N answers that
// version instead where a node may run it (approved, or superseded by a newer one), of an Agent listed or unlisted, so a
// node pinned to it shows its own price. Instructions and skill text go only to the author, an administrator, or
// anyone when the version made them public.
func (a *App) getMarketAgent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := currentUser(r)
	m, err := scanMarketAgent(a.db.QueryRow(ctx, "SELECT "+marketAgentColumns+" FROM market_agents m WHERE m.id=$1", r.PathValue("id")))
	if err != nil {
		a.marketFailure(w, err)
		return
	}
	author, admin := m.authoredBy(u.ID), u.PlatformRole == "admin"
	pinned := 0
	if raw := r.URL.Query().Get("version"); raw != "" {
		if pinned, err = strconv.Atoi(raw); err != nil || pinned < 1 {
			a.marketFailure(w, marketNotFound())
			return
		}
	}
	runnable := m.Status == "unlisted" && (m.Official || m.AuthorUserID != nil)
	if !m.usable() && !author && !admin && !(pinned > 0 && runnable) {
		a.marketFailure(w, marketNotFound())
		return
	}
	var v marketVersion
	switch {
	case pinned > 0:
		v, err = scanMarketVersion(a.db.QueryRow(ctx, "SELECT "+marketVersionColumns+" FROM market_agent_versions v WHERE v.agent_id=$1 AND v.version=$2", m.ID, pinned))
		if err == nil && !author && !admin && v.State != "approved" && v.State != "superseded" {
			err = marketNotFound()
		}
		if err != nil {
			a.marketFailure(w, err)
			return
		}
	case m.ListedVersion != nil:
		v, err = scanMarketVersion(a.db.QueryRow(ctx, "SELECT "+marketVersionColumns+" FROM market_agent_versions v WHERE v.agent_id=$1 AND v.version=$2", m.ID, *m.ListedVersion))
	default:
		v, err = latestMarketVersion(ctx, a.db, m.ID)
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	stats, err := a.marketStatsFor(ctx)
	if err != nil {
		a.dbError(w, err)
		return
	}
	out := marketSummary(m, v, stats[m.ID])
	full := author || admin
	detail := marketVersionJSON(v, full)
	for _, key := range []string{"description", "examples", "skills", "instructionsPublic", "instructions"} {
		if value, ok := detail[key]; ok {
			out[key] = value
		}
	}
	if full {
		latest, err := latestMarketVersion(ctx, a.db, m.ID)
		if err != nil {
			a.dbError(w, err)
			return
		}
		out["status"], out["listedVersion"] = m.Status, m.ListedVersion
		out["latest"] = marketLatestJSON(latest)
	}
	writeJSON(w, 200, out)
}

// marketLatestJSON is an Agent's latest version as its author's views summarize it.
func marketLatestJSON(v marketVersion) map[string]any {
	return map[string]any{"version": v.Version, "state": v.State, "reviewNote": v.ReviewNote, "submittedAt": v.SubmittedAt,
		"price": v.Price, "authorName": v.AuthorName}
}
