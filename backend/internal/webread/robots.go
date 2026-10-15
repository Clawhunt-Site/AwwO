package webread

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// The product token AwwO's reader answers to in robots.txt groups (RFC 9309 §2.2.1).
const productToken = "awwo-reader"

const (
	maxRobotsBytes = 500 << 10
	robotsTimeout  = 10 * time.Second
	// A robots.txt that cannot be read now (server error, timeout) may still be answered from a copy at most this
	// old; without one the site is treated as not allowing the read.
	robotsStaleLimit = 7 * 24 * time.Hour
)

type robotsRule struct {
	allow   bool
	pattern string
}

type robotsGroup struct {
	agents []string
	rules  []robotsRule
}

type robotsRules struct {
	groups []robotsGroup
}

// parseRobots reads the groups of a robots.txt body: consecutive user-agent lines open a group, allow/disallow
// lines add to it, everything else (sitemaps, crawl-delay, unknown keys, comments) is ignored.
func parseRobots(body string) *robotsRules {
	rules := &robotsRules{}
	var current *robotsGroup
	collecting := false
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r", "\n"), "\n") {
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key, value = strings.ToLower(strings.TrimSpace(key)), strings.TrimSpace(value)
		switch key {
		case "user-agent":
			if current == nil || !collecting {
				rules.groups = append(rules.groups, robotsGroup{})
				current = &rules.groups[len(rules.groups)-1]
			}
			current.agents = append(current.agents, strings.ToLower(value))
			collecting = true
		case "allow", "disallow":
			collecting = false
			if current == nil || value == "" {
				continue
			}
			current.rules = append(current.rules, robotsRule{allow: key == "allow", pattern: robotsNormalize(value)})
		default:
			collecting = false
		}
	}
	return rules
}

// rulesFor merges every group naming the product token, else every group for "*" (RFC 9309 §2.2.1).
func (r *robotsRules) rulesFor(token string) []robotsRule {
	var named, star []robotsRule
	foundNamed := false
	for _, group := range r.groups {
		for _, agent := range group.agents {
			switch {
			case agent == token:
				named, foundNamed = append(named, group.rules...), true
			case agent == "*":
				star = append(star, group.rules...)
			}
		}
	}
	if foundNamed {
		return named
	}
	return star
}

// allowed applies the longest matching rule; an allow wins a tie, and no matching rule allows (RFC 9309 §2.2.2).
func (r *robotsRules) allowed(token, path string) bool {
	if path == "/robots.txt" {
		return true
	}
	best, allow := -1, true
	for _, rule := range r.rulesFor(token) {
		if !robotsMatch(rule.pattern, path) {
			continue
		}
		length := len(rule.pattern)
		if length > best || (length == best && rule.allow) {
			best, allow = length, rule.allow
		}
	}
	return allow
}

// robotsMatch matches a robots.txt path pattern: "*" for any run of characters, a trailing "$" for the end.
func robotsMatch(pattern, path string) bool {
	anchored := strings.HasSuffix(pattern, "$")
	if anchored {
		pattern = pattern[:len(pattern)-1]
	}
	parts := strings.Split(pattern, "*")
	if !strings.HasPrefix(path, parts[0]) {
		return false
	}
	pos := len(parts[0])
	for i := 1; i < len(parts); i++ {
		part := parts[i]
		if i == len(parts)-1 && anchored {
			return len(path)-len(part) >= pos && strings.HasSuffix(path, part)
		}
		at := strings.Index(path[pos:], part)
		if at < 0 {
			return false
		}
		pos += at + len(part)
	}
	return !anchored || pos == len(path)
}

type robotsEntry struct {
	rules   *robotsRules
	status  int
	fetched time.Time
}

// RobotsCache keeps each origin's robots.txt for a while, bounded in entries (oldest evicted first).
type RobotsCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	max     int
	entries map[string]robotsEntry
	order   []string
}

func NewRobotsCache(ttl time.Duration, maxEntries int) *RobotsCache {
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	if maxEntries <= 0 {
		maxEntries = 1024
	}
	return &RobotsCache{ttl: ttl, max: maxEntries, entries: map[string]robotsEntry{}}
}

func (c *RobotsCache) lookup(origin string) (robotsEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[origin]
	return entry, ok
}

func (c *RobotsCache) store(origin string, entry robotsEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[origin]; !ok {
		c.order = append(c.order, origin)
	}
	c.entries[origin] = entry
	for len(c.order) > c.max {
		delete(c.entries, c.order[0])
		c.order = c.order[1:]
	}
}

// check answers whether target may be read, reading the origin's robots.txt when no fresh copy is cached.
func (c *RobotsCache) check(ctx context.Context, client *http.Client, target *url.URL, opt Options) (RobotsVerdict, error) {
	origin := target.Scheme + "://" + target.Host
	robotsURL := origin + "/robots.txt"
	verdict := RobotsVerdict{Checked: true, URL: robotsURL}
	now := opt.now()
	entry, cached := c.lookup(origin)
	if !cached || now.Sub(entry.fetched) > c.ttl {
		fresh, err := fetchRobots(ctx, client, robotsURL, opt)
		switch {
		case err == nil:
			entry, cached = fresh, true
			c.store(origin, entry)
		case cached && now.Sub(entry.fetched) <= robotsStaleLimit:
			verdict.Cached = true
		default:
			return verdict, failure("robots_unavailable", "The site's robots.txt could not be read, so the page is not read")
		}
	} else {
		verdict.Cached = true
	}
	verdict.Status = entry.status
	verdict.Allowed = entry.rules == nil || entry.rules.allowed(productToken, robotsPath(target))
	return verdict, nil
}

func robotsPath(target *url.URL) string {
	path := target.EscapedPath()
	if path == "" {
		path = "/"
	}
	if target.RawQuery != "" {
		path += "?" + target.RawQuery
	}
	return robotsNormalize(path)
}

// robotsNormalize gives a rule and a requested path one spelling before they are compared (RFC 9309 §2.2.2): an
// escaped unreserved character (letters, digits, - . _ ~) is decoded, other escapes are kept with upper-case hex, and
// bytes outside US-ASCII are escaped. Otherwise /%70rivate would slip past Disallow: /private.
func robotsNormalize(s string) string {
	const hex = "0123456789ABCDEF"
	unhex := func(c byte) int {
		switch {
		case c >= '0' && c <= '9':
			return int(c - '0')
		case c >= 'a' && c <= 'f':
			return int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			return int(c-'A') + 10
		}
		return -1
	}
	unreserved := func(c byte) bool {
		return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~'
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '%' && i+2 < len(s) && unhex(s[i+1]) >= 0 && unhex(s[i+2]) >= 0:
			decoded := byte(unhex(s[i+1])<<4 | unhex(s[i+2]))
			if unreserved(decoded) {
				b.WriteByte(decoded)
			} else {
				b.WriteByte('%')
				b.WriteByte(hex[decoded>>4])
				b.WriteByte(hex[decoded&15])
			}
			i += 2
		case c >= 0x80:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// fetchRobots reads one robots.txt: 2xx is parsed, 4xx allows everything, anything else is an error.
func fetchRobots(ctx context.Context, client *http.Client, robotsURL string, opt Options) (robotsEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, robotsTimeout)
	defer cancel()
	current, err := ValidateURL(robotsURL)
	if err != nil {
		return robotsEntry{}, err
	}
	for hop := 0; ; hop++ {
		resp, err := get(ctx, client, current, opt, "text/plain,*/*;q=0.5")
		if err != nil {
			return robotsEntry{}, err
		}
		if isRedirect(resp.StatusCode) {
			location := resp.Header.Get("Location")
			resp.Body.Close()
			if hop >= opt.MaxRedirects {
				return robotsEntry{}, failure("too_many_redirects", "robots.txt redirects too many times")
			}
			next, err := current.Parse(location)
			if err != nil {
				return robotsEntry{}, failure("invalid_url", "robots.txt redirects to an invalid address")
			}
			if current, err = ValidateURL(next.String()); err != nil {
				return robotsEntry{}, err
			}
			continue
		}
		defer resp.Body.Close()
		switch {
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			body, err := io.ReadAll(io.LimitReader(resp.Body, maxRobotsBytes))
			if err != nil {
				return robotsEntry{}, failure("network_error", "robots.txt could not be read")
			}
			return robotsEntry{rules: parseRobots(string(body)), status: resp.StatusCode, fetched: opt.now()}, nil
		case resp.StatusCode >= 400 && resp.StatusCode < 500:
			return robotsEntry{status: resp.StatusCode, fetched: opt.now()}, nil
		}
		return robotsEntry{}, failure("robots_unavailable", "robots.txt answered with a server error")
	}
}
