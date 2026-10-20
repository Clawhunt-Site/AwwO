package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"awwo/backend/internal/webread"
)

// The skill registry's way out (skill_registry.go): requests to two fixed hosts, skills.sh and GitHub's API, through
// the web reader's client (public addresses only, checked as each connection is made, no proxy, no cookies), with an
// honest user agent, bounded bodies, caches and rate limits, so AwwO stays a reasonable user of both services.

const skillRegistryUserAgent = "AwwO-Skills/1.0 (+https://awwo.clawhunt.store)"

const (
	// registryAccountPerMinute bounds what one account's requests ask of skills.sh and GitHub in a minute (a search
	// counts 1, a preview and an import what they must fetch, skillRegistry.cost); registryAccountAtOnce, how many of
	// them run at once.
	registryAccountPerMinute = 20
	registryAccountAtOnce    = 2
	// registryStaleFor is how long past its time a repository answer may stand in when GitHub cannot be asked.
	registryStaleFor = 24 * time.Hour
	// registryUpstreamPerMinute and registryUpstreamBurst bound what the whole server asks skills.sh and GitHub.
	registryUpstreamPerMinute = 120
	registryUpstreamBurst     = 30
	// registryMaxBackoff caps how long a Retry-After or a rate-limit reset keeps the server from asking again.
	registryMaxBackoff = time.Hour
)

var (
	// The registry's hosts; tests point them at loopback servers through skillRegistryTestOptions.
	skillRegistryBase      = "https://skills.sh"
	skillRegistryGitHubAPI = "https://api.github.com"
	// skillRegistryTestOptions lets tests dial loopback servers; nil in production.
	skillRegistryTestOptions func(*webread.Options)
	// registrySlotWait is how long one request to skills.sh or GitHub waits for one of the server's four request slots
	// before the member is told it is busy; with an import's reads (12 s for the skill, 6 s for its repository) it stays
	// inside the API's 30 s deadline. A variable so tests can shorten it.
	registrySlotWait = 5 * time.Second
)

// skillRegistry holds the registry's caches and limits; one per App.
type skillRegistry struct {
	mu              sync.Mutex
	accounts        map[string]*registryWindow
	tokens          float64
	refilled        time.Time
	backoffUntil    time.Time // skills.sh asked AwwO to wait (429)
	githubUntil     time.Time // GitHub's anonymous allowance for this address is used up
	slots           chan struct{}
	searchCache     registryCache[[]registryHit]
	snapshotCache   registryCache[registrySnapshot]
	repositoryCache registryCache[registryRepository]
	auditCache      registryCache[[]registryAudit]
	now             func() time.Time
}

type registryWindow struct {
	start    time.Time
	count    int
	inFlight int
}

func newSkillRegistry() *skillRegistry {
	return &skillRegistry{accounts: map[string]*registryWindow{}, tokens: registryUpstreamBurst, slots: make(chan struct{}, 4),
		searchCache: registryCache[[]registryHit]{ttl: time.Minute, max: 512}, snapshotCache: registryCache[registrySnapshot]{ttl: 5 * time.Minute, max: 128},
		repositoryCache: registryCache[registryRepository]{ttl: 6 * time.Hour, max: 2048}, auditCache: registryCache[[]registryAudit]{ttl: 30 * time.Minute, max: 1024}}
}

func (g *skillRegistry) clock() time.Time {
	if g.now != nil {
		return g.now()
	}
	return time.Now()
}

// beginAccount admits one of an account's registry requests: weight against its minute, at most two at once. done
// ends it.
func (g *skillRegistry) beginAccount(account string, weight int) (done func(), ok bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.clock()
	w := g.accounts[account]
	if w == nil || (now.Sub(w.start) >= time.Minute && w.inFlight == 0) {
		if len(g.accounts) > 10000 {
			for k, v := range g.accounts {
				if now.Sub(v.start) >= time.Minute && v.inFlight == 0 {
					delete(g.accounts, k)
				}
			}
		}
		w = &registryWindow{start: now}
		g.accounts[account] = w
	} else if now.Sub(w.start) >= time.Minute {
		w.start, w.count = now, 0
	}
	if w.count+weight > registryAccountPerMinute || w.inFlight >= registryAccountAtOnce {
		return nil, false
	}
	w.count += weight
	w.inFlight++
	return func() {
		g.mu.Lock()
		w.inFlight--
		g.mu.Unlock()
	}, true
}

// cost is what a request about id would ask of skills.sh and GitHub now, as an account's minute counts it: one for
// each answer the caches do not hold (the skill and a preview's reviews unless skills.sh has asked AwwO to wait, its
// repository unless GitHub's allowance is spent), and at least one.
func (g *skillRegistry) cost(id registryID, preview bool) int {
	now, n, waiting := g.clock(), 0, g.skillsWaiting()
	if _, ok := g.snapshotCache.get(id.key(), now); !ok && !waiting {
		n++
	}
	if _, ok := g.repositoryCache.get(id.sourceKey(), now); !ok && !g.githubLimited() {
		n++
	}
	if _, ok := g.auditCache.get(id.key(), now); preview && !ok && !waiting {
		n++
	}
	return max(n, 1)
}

func (g *skillRegistry) skillsWaiting() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.clock().Before(g.backoffUntil)
}

// takeUpstream spends one of the server's upstream requests, refilled at registryUpstreamPerMinute; none goes to
// skills.sh while it has asked AwwO to wait.
func (g *skillRegistry) takeUpstream(toSkills bool) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.clock()
	if !g.refilled.IsZero() {
		g.tokens += now.Sub(g.refilled).Minutes() * registryUpstreamPerMinute
	}
	g.tokens, g.refilled = min(g.tokens, registryUpstreamBurst), now
	if (toSkills && now.Before(g.backoffUntil)) || g.tokens < 1 {
		return false
	}
	g.tokens--
	return true
}

// waitFor records how long a service asked AwwO to stay away, at most registryMaxBackoff.
func (g *skillRegistry) waitFor(until *time.Time, wait time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if wait <= 0 {
		wait = time.Minute
	}
	if next := g.clock().Add(min(wait, registryMaxBackoff)); next.After(*until) {
		*until = next
	}
}

func (g *skillRegistry) githubLimited() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.clock().Before(g.githubUntil)
}

// slot waits, for a bounded time, for one of the four requests the registry makes at once.
func (g *skillRegistry) slot(ctx context.Context) (func(), error) {
	wait := time.NewTimer(registrySlotWait)
	defer wait.Stop()
	select {
	case g.slots <- struct{}{}:
		return func() { <-g.slots }, nil
	case <-wait.C:
		return nil, registryBusy()
	case <-ctx.Done():
		return nil, registryTimeout()
	}
}

// registryCache keeps answers for a while; when full it drops expired entries, then arbitrary ones.
type registryCache[V any] struct {
	mu    sync.Mutex
	ttl   time.Duration
	max   int
	items map[string]registryCached[V]
}

type registryCached[V any] struct {
	value V
	until time.Time
}

func (c *registryCache[V]) get(key string, now time.Time) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[key]
	if !ok || !now.Before(item.until) {
		var zero V
		return zero, false
	}
	return item.value, true
}

// stale returns an entry up to maxAge past its time, while it is still kept: advice better given late than not at all.
func (c *registryCache[V]) stale(key string, now time.Time, maxAge time.Duration) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[key]
	if !ok || !now.Before(item.until.Add(maxAge)) {
		var zero V
		return zero, false
	}
	return item.value, true
}

func (c *registryCache[V]) put(key string, value V, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.items == nil {
		c.items = map[string]registryCached[V]{}
	}
	if len(c.items) >= c.max {
		for k, v := range c.items {
			if !now.Before(v.until) {
				delete(c.items, k)
			}
		}
		for k := range c.items {
			if len(c.items) < c.max {
				break
			}
			delete(c.items, k)
		}
	}
	c.items[key] = registryCached[V]{value: value, until: now.Add(c.ttl)}
}

func registryBusy() error {
	return skillError{503, "skill_registry_busy", "Many skill searches are running right now; try again in a minute"}
}
func registryTimeout() error {
	return skillError{504, "skill_registry_timeout", "skills.sh took too long to answer; try again"}
}
func registryUnreachable() error {
	return skillError{502, "skill_registry_upstream", "skills.sh could not be reached or answered unexpectedly; try again later"}
}

// registryResponse is one answer from a registry host.
type registryResponse struct {
	status int
	header http.Header
	body   []byte
}

// get asks one registry host for target, reads at most maxBytes of its answer and gives it to read, all within one of
// the four request slots, so no more than four answers are held or parsed at once. One redirect is followed, and only
// between the host asked and its www. name (skills.sh answers at its own name; this keeps it working should it move).
// Each request spends an upstream token; toSkills says the host is skills.sh. An error from read is returned as it is.
func (g *skillRegistry) get(ctx context.Context, toSkills bool, target, accept string, maxBytes int64, read func(registryResponse) error) error {
	asked, err := url.Parse(target)
	if err != nil {
		return registryUnreachable()
	}
	current := asked
	for hop := 0; ; hop++ {
		if !g.takeUpstream(toSkills) {
			return registryBusy()
		}
		location, err := g.once(ctx, current, accept, maxBytes, read)
		if err != nil || location == "" {
			return err
		}
		next, err := current.Parse(location)
		sameSite := err == nil && (next.Host == asked.Host || next.Host == "www."+asked.Host || "www."+next.Host == asked.Host)
		if hop > 0 || !sameSite || next.Scheme != asked.Scheme {
			return registryUnreachable()
		}
		current = next
	}
}

// once makes one request in a slot: the answer read, or the place a redirect points to.
func (g *skillRegistry) once(ctx context.Context, target *url.URL, accept string, maxBytes int64, read func(registryResponse) error) (string, error) {
	release, err := g.slot(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	opt := webread.Options{UserAgent: skillRegistryUserAgent}
	if skillRegistryTestOptions != nil {
		skillRegistryTestOptions(&opt)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return "", registryUnreachable()
	}
	req.Header.Set("User-Agent", skillRegistryUserAgent)
	req.Header.Set("Accept", accept)
	resp, err := webread.Client(opt).Do(req)
	if err != nil {
		return "", registryTransportFailure(ctx, err)
	}
	defer resp.Body.Close()
	if isRedirect(resp.StatusCode) {
		// A redirect that names no place is no answer.
		if location := resp.Header.Get("Location"); location != "" {
			return location, nil
		}
		return "", registryUnreachable()
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return "", registryTransportFailure(ctx, err)
	}
	if int64(len(body)) > maxBytes {
		return "", skillError{502, "skill_registry_answer_too_large", fmt.Sprintf("The answer from %s is larger than the %d KiB AwwO reads", target.Hostname(), maxBytes>>10)}
	}
	return "", read(registryResponse{status: resp.StatusCode, header: resp.Header, body: body})
}

func isRedirect(status int) bool {
	return status == 301 || status == 302 || status == 303 || status == 307 || status == 308
}

func registryTransportFailure(ctx context.Context, err error) error {
	var netErr net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return registryTimeout()
	}
	return registryUnreachable()
}

// retryAfter reads a Retry-After header in seconds; zero when absent or a date.
func retryAfter(h http.Header) time.Duration {
	seconds, err := strconv.Atoi(h.Get("Retry-After"))
	if err != nil || seconds < 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}
