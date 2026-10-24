package app

import (
	"context"
	"net/http"
	"net/netip"
	"sync"
	"time"
)

// The cloud relay's own bounds (docs/awwo-cloud-relay.md), besides the workspace's and the plan's allowances that
// admission applies: what anyone may ask of its routes without a session, how much of the API's memory relayed requests
// may hold at once, and the calls each link has running.

const (
	// relayBodyBudget is the most relayed request bodies the API holds in memory at once, across every link: a few calls
	// with pictures, or many plain ones; relayBodyPerAccount is one account's share of it, so no one person's calls
	// (an account may link ten computers) hold all of it. A call that would pass either is refused as relay_busy before
	// its body is read. A body is held from before it is read until the Pi worker has taken it.
	relayBodyBudget     = 64 << 20
	relayBodyPerAccount = 24 << 20
	// The routes' per-address limits, per minute: asking for a link (a person asks one at a time), asking after one (every
	// localLinkInterval while its person approves it, with room for two computers behind one address), and relayed calls.
	linkStartsPerMinute = 10
	linkPollsPerMinute  = 40
	relayCallsPerMinute = 600
)

// ipWindow counts each address's requests in one-minute windows. An IPv6 address counts with its /64, the block one
// subscriber gets, so stepping through the block does not reset the count.
type ipWindow struct {
	mu      sync.Mutex
	entries map[string]rateEntry
}

func addressKey(ip string) string {
	addr, e := netip.ParseAddr(ip)
	if e != nil || addr.Is4() || addr.Is4In6() {
		return ip
	}
	if prefix, e := addr.Prefix(64); e == nil {
		return prefix.String()
	}
	return ip
}

func (l *ipWindow) allow(key string, limit int, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = map[string]rateEntry{}
	}
	if len(l.entries) >= 10000 {
		for k, v := range l.entries {
			if now.Sub(v.start) >= time.Minute {
				delete(l.entries, k)
			}
		}
		if len(l.entries) >= 10000 {
			return false
		}
	}
	v := l.entries[key]
	if now.Sub(v.start) >= time.Minute {
		v = rateEntry{start: now}
	}
	v.count++
	l.entries[key] = v
	return v.count <= limit
}

// relayRate bounds a relay route by address: the hosted site answers these to anyone, with or without a token.
func (a *App) relayRate(l *ipWindow, limit int, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(addressKey(a.clientIP(r)), limit, time.Now()) {
			w.Header().Set("Retry-After", "60")
			relayFail(w, 429, "rate_limited", "rate_limit_error", "Too many requests from this address; try again in a minute")
			return
		}
		next(w, r)
	}
}

// relayLimits holds the relay's per-address windows.
type relayLimits struct {
	starts, polls, calls ipWindow
}

// relayBodies counts the bytes of relayed request bodies the API holds, in all and by account.
type relayBodies struct {
	mu   sync.Mutex
	held int64
	by   map[string]int64
}

func (b *relayBodies) take(account string, n int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.held+n > relayBodyBudget || b.by[account]+n > relayBodyPerAccount {
		return false
	}
	if b.by == nil {
		b.by = map[string]int64{}
	}
	b.held += n
	b.by[account] += n
	return true
}

func (b *relayBodies) give(account string, n int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.held = max(0, b.held-n)
	if b.by[account] -= n; b.by[account] <= 0 {
		delete(b.by, account)
	}
}

// relayCallLimiter counts each link's relayed calls running here.
type relayCallLimiter struct {
	mu      sync.Mutex
	running map[string]int
}

func (l *relayCallLimiter) take(link string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.running == nil {
		l.running = map[string]int{}
	}
	if l.running[link] >= relayCallsPerLink {
		return false
	}
	l.running[link]++
	return true
}

func (l *relayCallLimiter) give(link string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.running[link]--; l.running[link] <= 0 {
		delete(l.running, link)
	}
}

// relayStaleAfter is how long after its admission a relayed call can no longer be running here: its own limit
// (relayCallLimit) and its wait for a slot (relayAdmissionWait), with room.
const relayStaleAfter = 40 * time.Minute

// settleStaleRelayCalls settles relayed calls still marked running long after any could be: one whose settling failed
// (a database fault while it ended) would otherwise hold its workspace's slot and its credit reserve until the API next
// restarts, which settles every running call (Start). It settles them as the restart does, and returns how many.
func (a *App) settleStaleRelayCalls(ctx context.Context) (int64, error) {
	tag, e := a.db.Exec(ctx, `UPDATE model_invocations SET status='interrupted',usage_status=CASE WHEN admission_status IN ('accepted','unknown') THEN 'unknown' ELSE 'unavailable' END,
		usage_source='none',usage_reason=CASE WHEN admission_status IN ('accepted','unknown') THEN 'worker_lost' ELSE 'provider_missing' END,
		cost_status=CASE WHEN admission_status IN ('accepted','unknown') THEN 'unknown' ELSE 'not_incurred' END,failure_class='restart',completed_at=clock_timestamp(),
		completed_xid=pg_current_xact_id(),updated_at=clock_timestamp(),credit_charge=`+abandonedCreditCharge+`
		WHERE relay_link_id IS NOT NULL AND status='running' AND created_at < clock_timestamp() - $1::bigint * interval '1 second'`, int64(relayStaleAfter.Seconds()))
	if e != nil {
		return 0, e
	}
	return tag.RowsAffected(), nil
}

// startRelaySweeper settles stale relayed calls and deletes ended link codes (with the addresses they keep) every few
// minutes, on the hosted site, while the API runs.
func (a *App) startRelaySweeper(watch context.Context) {
	if !a.cfg.LocalRelay {
		return
	}
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		tick := time.NewTicker(5 * time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-watch.Done():
				return
			case <-tick.C:
				ctx, cancel := context.WithTimeout(watch, 30*time.Second)
				if n, e := a.settleStaleRelayCalls(ctx); e != nil {
					a.log.Warn("stale relayed calls could not be settled", "error_type", errorType(e))
				} else if n > 0 {
					a.log.Warn("stale relayed calls settled", "calls", n)
				}
				if e := a.dropEndedLinkCodes(ctx); e != nil {
					a.log.Warn("ended link codes could not be deleted", "error_type", errorType(e))
				}
				cancel()
			}
		}
	}()
}
