package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// What the cloud relay (relay.go) may take of this site at once. The API is single-worker (its advisory lock), so these
// counts, kept in this process, are the whole site's.

const (
	// relayRequestsPerMinute is how many requests one key may send a minute, and relayFailuresPerMinute how many
	// lookups of keys that are not one address may make: an indexed read each, bounded all the same.
	relayRequestsPerMinute = 120
	relayFailuresPerMinute = 30
	// relayPerWorkspace and relayOnSite bound the relayed calls handled at once, in one workspace and on the site, and
	// relayWaiters those waiting for a place: a waiter holds a database connection while it waits on its workspace's row,
	// and the pool has 20 (database.go).
	relayPerWorkspace = 8
	relayOnSite       = 32
	relayWaiters      = 6
	// relayRateEntries bounds each rate's table, as authRate's.
	relayRateEntries = 10000
	// relayCatalogTTL is how long the relay worker's catalog is reused, and relayCatalogRetry how long a failure to read
	// it is.
	relayCatalogTTL   = 30 * time.Second
	relayCatalogRetry = 5 * time.Second
)

// relaySweepEvery is how often relayed calls left running are settled (a variable for the tests only).
var relaySweepEvery = time.Minute

// errRelayBusy: a relayed call found no place to wait for one.
var errRelayBusy = errors.New("relay_busy")

type relayLimits struct {
	mu       sync.Mutex
	keys     map[string]rateEntry // key id → requests this minute
	failures map[string]rateEntry // client address → failed key lookups this minute
	inFlight map[string]int       // workspace → relayed calls handled now
	total    int                  // relayed calls handled now, on the site
	waiting  int                  // relayed calls waiting for a place now
}

// count adds one to id's minute in rates, refusing past limit; a full table refuses an unknown id.
func (l *relayLimits) count(rates *map[string]rateEntry, id string, limit int, add bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if *rates == nil {
		*rates = map[string]rateEntry{}
	}
	now := time.Now()
	entry, known := (*rates)[id]
	if !known && len(*rates) >= relayRateEntries {
		for k, x := range *rates {
			if now.Sub(x.start) >= time.Minute {
				delete(*rates, k)
			}
		}
		if len(*rates) >= relayRateEntries {
			return false
		}
	}
	if now.Sub(entry.start) >= time.Minute {
		entry = rateEntry{start: now}
	}
	if add {
		entry.count++
		(*rates)[id] = entry
	}
	return entry.count <= limit
}

func (l *relayLimits) requestAllowed(key string) bool {
	return l.count(&l.keys, key, relayRequestsPerMinute, true)
}
func (l *relayLimits) lookupAllowed(address string) bool {
	return l.count(&l.failures, address, relayFailuresPerMinute, false)
}
func (l *relayLimits) lookupFailed(address string) {
	l.count(&l.failures, address, relayFailuresPerMinute, true)
}

// enter takes a place for a relayed call of a workspace; false when the workspace or the site has none left.
func (l *relayLimits) enter(tid string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight == nil {
		l.inFlight = map[string]int{}
	}
	if l.inFlight[tid] >= relayPerWorkspace || l.total >= relayOnSite {
		return false
	}
	l.inFlight[tid]++
	l.total++
	return true
}
func (l *relayLimits) leave(tid string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight[tid]--; l.inFlight[tid] <= 0 {
		delete(l.inFlight, tid)
	}
	l.total--
}

// wait takes a place among the calls waiting for an admission; false when there is none.
func (l *relayLimits) wait() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.waiting >= relayWaiters {
		return false
	}
	l.waiting++
	return true
}
func (l *relayLimits) waited() { l.mu.Lock(); l.waiting--; l.mu.Unlock() }

// trackRelayCall registers a relayed call with the work this process runs (a.running, a.tasks), so a shutdown or a lost
// database lock cuts it and waits for it to be settled before the lock is released. False when the API is closing.
func (a *App) trackRelayCall(id string, cancel context.CancelFunc) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return false
	}
	a.running["relay:"+id] = cancel
	a.tasks.Add(1)
	return true
}
func (a *App) untrackRelayCall(id string) {
	a.mu.Lock()
	delete(a.running, "relay:"+id)
	a.mu.Unlock()
	a.tasks.Done()
}
func (a *App) trackedRelayCalls() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	ids := []string{}
	for key := range a.running {
		if id, ok := strings.CutPrefix(key, "relay:"); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// startRelaySweeper settles, every relaySweepEvery, the relayed calls left running in the ledger: each call's handler
// settles it (relayCompletion), which a database failure can stop, and no run's ending settles it after. A running
// relayed row is one this process is handling (trackRelayCall), unless its handler is done.
func (a *App) startRelaySweeper(watch context.Context) {
	if !a.cfg.Relay {
		return
	}
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		tick := time.NewTicker(relaySweepEvery)
		defer tick.Stop()
		for {
			select {
			case <-watch.Done():
				return
			case <-tick.C:
				if e := a.sweepRelayCalls(watch); e != nil && watch.Err() == nil {
					a.log.Warn("relayed calls left running could not be settled", "error_type", "database")
				}
			}
		}
	}()
}

// sweepRelayCalls settles the relayed calls running in the ledger that no handler of this process holds, as App.Start
// settles every call left running (abandonedInvocation). A call's row is made after its handler is registered, so a
// row of a call registered after the list was read is younger than the half minute it must be.
func (a *App) sweepRelayCalls(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tag, e := a.db.Exec(ctx, `UPDATE model_invocations SET `+abandonedInvocation+` WHERE relay_key_id IS NOT NULL AND status='running'
		AND created_at<clock_timestamp()-interval '30 seconds' AND NOT (id = ANY($1::text[]))`, a.trackedRelayCalls())
	if e == nil && tag.RowsAffected() > 0 {
		a.log.Warn("settled relayed calls left running", "calls", tag.RowsAffected())
	}
	return e
}

// relayModel is one model of the relay worker's catalog, as its health lists it (apps/pi-worker/config.mjs publicHealth).
type relayModel struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Provider           string  `json:"provider"`
	ProviderModel      string  `json:"providerModel"`
	Protocol           string  `json:"protocol"`
	ContextWindow      int     `json:"contextWindow"`
	MaxOutputTokens    int     `json:"maxOutputTokens"`
	ProseBytesPerToken float64 `json:"proseBytesPerToken"`
}

type relayCatalogCache struct {
	mu      sync.Mutex
	at      time.Time
	models  []relayModel
	err     error
	loading chan struct{} // closed when the read under way ends
}

// relayCatalog is the relay worker's catalog, read from its health and reused for relayCatalogTTL (a failure to read it
// for relayCatalogRetry): one read at a time, which the others wait for as long as their own context lets them.
func (a *App) relayCatalog(ctx context.Context) ([]relayModel, error) {
	c := &a.relayCatalogCache
	for {
		c.mu.Lock()
		ttl := relayCatalogTTL
		if c.err != nil {
			ttl = relayCatalogRetry
		}
		if c.loading == nil && !c.at.IsZero() && time.Since(c.at) < ttl {
			models, e := c.models, c.err
			c.mu.Unlock()
			return models, e
		}
		if loading := c.loading; loading != nil {
			c.mu.Unlock()
			select {
			case <-loading:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		done := make(chan struct{})
		c.loading = done
		c.mu.Unlock()
		models, e := a.readRelayCatalog()
		c.mu.Lock()
		c.models, c.err, c.at, c.loading = models, e, time.Now(), nil
		close(done)
		c.mu.Unlock()
		return models, e
	}
}

// readRelayCatalog reads the models the worker's managed-call route serves (a Bedrock one through its Bedrock call,
// which it claims as computerBedrock), with limits a call can be sized by.
func (a *App) readRelayCatalog() ([]relayModel, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(a.cfg.RelayWorkerURL, "/")+"/health", nil)
	if e != nil {
		return nil, e
	}
	resp, e := a.client.Do(req)
	if e != nil {
		return nil, errors.New("relay worker unavailable")
	}
	defer resp.Body.Close()
	body, e := io.ReadAll(io.LimitReader(resp.Body, maxRuntimeHealthBytes+1))
	var health struct {
		Ready           bool         `json:"ready"`
		ComputerBedrock bool         `json:"computerBedrock"`
		Models          []relayModel `json:"models"`
	}
	if e != nil || len(body) > maxRuntimeHealthBytes || resp.StatusCode != 200 || json.Unmarshal(body, &health) != nil || !health.Ready || len(health.Models) > maxRuntimeModels {
		return nil, errors.New("relay worker not ready")
	}
	models, seen := make([]relayModel, 0, len(health.Models)), map[string]bool{}
	for _, m := range health.Models {
		if m.ID == "" || len(m.ID) > 200 || seen[m.ID] || (m.Provider == "bedrock" && !health.ComputerBedrock) ||
			m.ContextWindow < 4096 || m.MaxOutputTokens < 1 || m.MaxOutputTokens+256 >= m.ContextWindow {
			continue
		}
		m.ProseBytesPerToken = max(1, m.ProseBytesPerToken)
		seen[m.ID] = true
		models = append(models, m)
	}
	return models, nil
}
