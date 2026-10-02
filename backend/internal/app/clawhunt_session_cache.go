package app

import (
	"log/slog"
	"sync"
	"time"
)

// A session's ClawHunt grant is verified at most once a minute instead of on every
// request. While the issuer cannot be reached, a verification younger than five
// minutes keeps the session working; an explicit inactive answer ends it at once.
const (
	clawHuntReuseFor    = time.Minute
	clawHuntOutageFor   = 5 * time.Minute
	clawHuntRetryEvery  = 15 * time.Second
	clawHuntGrantMax    = 12 * time.Hour
	clawHuntSessionsMax = 4096
)

type verifiedClawHuntSession struct {
	user, issuer, subject string
	identity              clawHuntIdentity
	// checked is the last issuer answer; expires is the grant's own end. retry
	// spaces calls to an unreachable issuer without extending the outage window.
	checked, expires, retry time.Time
}

// clawHuntCheck is one issuer check shared by every request of a session that arrives while it runs.
type clawHuntCheck struct {
	done     chan struct{}
	identity clawHuntIdentity
	valid    bool
	err      error
}

type clawHuntSessionCache struct {
	mu       sync.Mutex
	entries  map[string]verifiedClawHuntSession
	inflight map[string]*clawHuntCheck
	reuse    time.Duration
	outage   time.Duration
	now      func() time.Time
	warned   time.Time
}

func newClawHuntSessionCache() *clawHuntSessionCache {
	return &clawHuntSessionCache{entries: map[string]verifiedClawHuntSession{}, inflight: map[string]*clawHuntCheck{}, reuse: clawHuntReuseFor, outage: clawHuntOutageFor, now: time.Now}
}

// usable reports whether a looked-up verification may answer without asking the issuer.
func (c *clawHuntSessionCache) usable(v verifiedClawHuntSession, now time.Time) bool {
	return now.Sub(v.checked) < c.reuse || now.Before(v.retry)
}

// begin returns the session's running issuer check, or registers the caller to run it (true).
func (c *clawHuntSessionCache) begin(hash string) (*clawHuntCheck, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if check, ok := c.inflight[hash]; ok {
		return check, false
	}
	check := &clawHuntCheck{done: make(chan struct{})}
	c.inflight[hash] = check
	return check, true
}
func (c *clawHuntSessionCache) end(hash string, check *clawHuntCheck) {
	c.mu.Lock()
	if c.inflight[hash] == check {
		delete(c.inflight, hash)
	}
	c.mu.Unlock()
	close(check.done)
}

// lookup returns the session's last verification while it may still stand in for
// the issuer: same user and subject, grant not expired, within the outage window.
func (c *clawHuntSessionCache) lookup(hash, user, issuer, subject string, now time.Time) (verifiedClawHuntSession, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.entries[hash]
	if ok && v.user == user && v.issuer == issuer && v.subject == subject && now.Before(v.expires) && now.Sub(v.checked) < c.outage {
		return v, true
	}
	delete(c.entries, hash)
	return verifiedClawHuntSession{}, false
}
func (c *clawHuntSessionCache) remember(hash string, v verifiedClawHuntSession) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[hash]; !ok && len(c.entries) >= clawHuntSessionsMax {
		for k, old := range c.entries {
			if !v.checked.Before(old.expires) || v.checked.Sub(old.checked) >= c.outage {
				delete(c.entries, k)
			}
		}
		if len(c.entries) >= clawHuntSessionsMax {
			return // Verify every request rather than grow without bound.
		}
	}
	c.entries[hash] = v
}

// deferRetry keeps an unreachable issuer from delaying every request of a session
// that is still inside its outage window.
func (c *clawHuntSessionCache) deferRetry(hash string, now time.Time) {
	c.mu.Lock()
	if v, ok := c.entries[hash]; ok {
		v.retry = now.Add(clawHuntRetryEvery)
		c.entries[hash] = v
	}
	c.mu.Unlock()
}
func (c *clawHuntSessionCache) forget(hash string) {
	c.mu.Lock()
	delete(c.entries, hash)
	c.mu.Unlock()
}

// unreachable logs at most once a minute that the issuer did not answer.
func (c *clawHuntSessionCache) unreachable(log *slog.Logger, now time.Time, kept bool) {
	c.mu.Lock()
	quiet := now.Sub(c.warned) < time.Minute
	if !quiet {
		c.warned = now
	}
	c.mu.Unlock()
	if quiet {
		return
	}
	if kept {
		log.Warn("ClawHunt session verification unavailable; recent verifications still admitted", "error_class", "identity_unavailable")
	} else {
		log.Warn("ClawHunt session verification unavailable; requests refused", "error_class", "identity_unavailable")
	}
}
