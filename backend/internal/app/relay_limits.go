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
	// relayRequestsPerMinute is how many requests one key may send a minute; relayFailuresPerMinute how many lookups of
	// keys that are not one address may make (an indexed read each; an IPv6 address counts by its /64, as
	// signupAddress); and relayRefusalsPerMinute how many of one key's calls the relay worker may refuse as the
	// caller's (a call it would not take, which counts nowhere) before the key's calls are held off for the minute.
	relayRequestsPerMinute = 120
	relayFailuresPerMinute = 30
	relayRefusalsPerMinute = 20
	// relayPerWorkspace and relayOnSite bound the relayed calls handled at once, in one workspace and on the site (the
	// site's, at most the relay worker's own calls at once: relayWorker.capacity), and relayAdmissions those being
	// admitted at once: an admission holds a database connection, and may wait on its workspace's row, and the pool
	// has 20 (database.go).
	relayPerWorkspace = 8
	relayOnSite       = 32
	relayAdmissions   = 6
	// relayRateEntries bounds each rate's table, as authRate's.
	relayRateEntries = 10000
	// relayCatalogTTL is how long the relay worker's catalog is reused, and relayCatalogRetry how long a failure to read
	// it is.
	relayCatalogTTL   = 30 * time.Second
	relayCatalogRetry = 5 * time.Second
	// relayWorkerCapacity is the relay worker's calls at once where its health does not say (the Pi worker's default,
	// AWWO_PI_MAX_CONCURRENCY).
	relayWorkerCapacity = 4
)

// relaySweepEvery is how often relayed calls left running are settled (a variable for the tests only).
var relaySweepEvery = time.Minute

type relayLimits struct {
	mu         sync.Mutex
	keys       map[string]rateEntry // key id → requests this minute
	failures   map[string]rateEntry // client address → failed key lookups this minute
	refusals   map[string]rateEntry // key id → its calls the relay worker refused as the caller's this minute
	inFlight   map[string]int       // workspace → relayed calls handled now
	total      int                  // relayed calls handled now, on the site
	admissions chan struct{}        // the places to be admitted in (relayAdmissions)
}

// count adds one to id's minute in rates when add, and says whether the minute is within limit. Only a count holds an id
// off: an id the table does not hold passes, and when the table is full, its oldest entry makes room for a new one.
func (l *relayLimits) count(rates *map[string]rateEntry, id string, limit int, add bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if *rates == nil {
		*rates = map[string]rateEntry{}
	}
	now := time.Now()
	entry, known := (*rates)[id]
	if now.Sub(entry.start) >= time.Minute {
		entry = rateEntry{start: now}
	}
	if !add {
		return entry.count <= limit
	}
	if !known && len(*rates) >= relayRateEntries {
		oldest, at := "", now
		for k, x := range *rates {
			if now.Sub(x.start) >= time.Minute {
				delete(*rates, k)
			} else if x.start.Before(at) {
				oldest, at = k, x.start
			}
		}
		if len(*rates) >= relayRateEntries {
			delete(*rates, oldest)
		}
	}
	entry.count++
	(*rates)[id] = entry
	return entry.count <= limit
}

func (l *relayLimits) requestAllowed(key string) bool {
	return l.count(&l.keys, key, relayRequestsPerMinute, true)
}
func (l *relayLimits) lookupAllowed(address string) bool {
	return l.count(&l.failures, signupAddress(address), relayFailuresPerMinute, false)
}
func (l *relayLimits) lookupFailed(address string) {
	l.count(&l.failures, signupAddress(address), relayFailuresPerMinute, true)
}
func (l *relayLimits) refusalsAllowed(key string) bool {
	return l.count(&l.refusals, key, relayRefusalsPerMinute, false)
}
func (l *relayLimits) refused(key string) {
	l.count(&l.refusals, key, relayRefusalsPerMinute, true)
}

// enter takes a place for a relayed call of a workspace; false when the workspace or the site has none left. capacity is
// the relay worker's own calls at once, which the site never passes: a call let in past it would only be refused there.
func (l *relayLimits) enter(tid string, capacity int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight == nil {
		l.inFlight = map[string]int{}
	}
	if l.inFlight[tid] >= relayPerWorkspace || l.total >= min(relayOnSite, capacity) {
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

// admitting is the site's places to be admitted in: one is taken for each try at an admission, and given back after it.
func (l *relayLimits) admitting() chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.admissions == nil {
		l.admissions = make(chan struct{}, relayAdmissions)
	}
	return l.admissions
}

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

// trackedRelayCalls are the relayed calls this process is handling, and whether it is still running: false once it is
// closing or has lost its database lock (Start), when it holds no call to settle but its own.
func (a *App) trackedRelayCalls() ([]string, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ids := []string{}
	for key := range a.running {
		if id, ok := strings.CutPrefix(key, "relay:"); ok {
			ids = append(ids, id)
		}
	}
	return ids, !a.closed && !a.leaseLost.Load()
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

// relayLeaseHeld is true while the worker lock (Start) is held by this process's own connection to it ($2, its backend's
// pid): a sweep settles nothing should the lock be lost before the process sees it, when the calls running may be
// another process's. A bigint advisory lock is listed by its high and low 32 bits, as classid and objid.
const relayLeaseHeld = `EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.pid=$2 AND l.objsubid=1
	AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
	AND l.classid::bigint=(hashtextextended(current_database() || ':' || current_schema(),84321002)>>32)&4294967295
	AND l.objid::bigint=hashtextextended(current_database() || ':' || current_schema(),84321002)&4294967295)`

// sweepRelayCalls settles the relayed calls running in the ledger that no handler of this process holds, as App.Start
// settles every call left running (abandonedInvocation), while this process holds the worker lock. A call's row is made
// after its handler is registered, so a row of a call registered after the list was read is younger than the half
// minute it must be.
func (a *App) sweepRelayCalls(ctx context.Context) error {
	tracked, running := a.trackedRelayCalls()
	if !running {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tag, e := a.db.Exec(ctx, `UPDATE model_invocations SET `+abandonedInvocation+` WHERE relay_key_id IS NOT NULL AND status='running'
		AND created_at<clock_timestamp()-interval '30 seconds' AND NOT (id = ANY($1::text[])) AND `+relayLeaseHeld, tracked, a.leasePID)
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

// relayWorker is what the relay worker's health says: the models it serves, and how many calls it takes at once.
type relayWorker struct {
	models   []relayModel
	capacity int
}

type relayCatalogCache struct {
	mu      sync.Mutex
	at      time.Time
	worker  relayWorker
	err     error
	loading chan struct{} // closed when the read under way ends
}

// relayCatalog is the relay worker's catalog, read from its health and reused for relayCatalogTTL (a failure to read it
// for relayCatalogRetry): one read at a time, which the others wait for as long as their own context lets them.
func (a *App) relayCatalog(ctx context.Context) (relayWorker, error) {
	c := &a.relayCatalogCache
	for {
		c.mu.Lock()
		ttl := relayCatalogTTL
		if c.err != nil {
			ttl = relayCatalogRetry
		}
		if c.loading == nil && !c.at.IsZero() && time.Since(c.at) < ttl {
			worker, e := c.worker, c.err
			c.mu.Unlock()
			return worker, e
		}
		if loading := c.loading; loading != nil {
			c.mu.Unlock()
			select {
			case <-loading:
				continue
			case <-ctx.Done():
				return relayWorker{}, ctx.Err()
			}
		}
		done := make(chan struct{})
		c.loading = done
		c.mu.Unlock()
		worker, e := a.readRelayCatalog()
		c.mu.Lock()
		c.worker, c.err, c.at, c.loading = worker, e, time.Now(), nil
		close(done)
		c.mu.Unlock()
		return worker, e
	}
}

// readRelayCatalog reads the models the worker's managed-call route serves (a Bedrock one through its Bedrock call,
// which it claims as computerBedrock), with limits a call can be sized by, and its calls at once (maxConcurrency).
func (a *App) readRelayCatalog() (relayWorker, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(a.cfg.RelayWorkerURL, "/")+"/health", nil)
	if e != nil {
		return relayWorker{}, e
	}
	resp, e := a.client.Do(req)
	if e != nil {
		return relayWorker{}, errors.New("relay worker unavailable")
	}
	defer resp.Body.Close()
	body, e := io.ReadAll(io.LimitReader(resp.Body, maxRuntimeHealthBytes+1))
	var health struct {
		Ready           bool         `json:"ready"`
		ComputerBedrock bool         `json:"computerBedrock"`
		MaxConcurrency  int          `json:"maxConcurrency"`
		Models          []relayModel `json:"models"`
	}
	if e != nil || len(body) > maxRuntimeHealthBytes || resp.StatusCode != 200 || json.Unmarshal(body, &health) != nil || !health.Ready || len(health.Models) > maxRuntimeModels {
		return relayWorker{}, errors.New("relay worker not ready")
	}
	worker := relayWorker{models: make([]relayModel, 0, len(health.Models)), capacity: health.MaxConcurrency}
	if worker.capacity < 1 {
		worker.capacity = relayWorkerCapacity
	}
	seen := map[string]bool{}
	for _, m := range health.Models {
		if m.ID == "" || len(m.ID) > 200 || seen[m.ID] || (m.Provider == "bedrock" && !health.ComputerBedrock) ||
			m.ContextWindow < 4096 || m.MaxOutputTokens < 1 || m.MaxOutputTokens+256 >= m.ContextWindow {
			continue
		}
		m.ProseBytesPerToken = max(1, m.ProseBytesPerToken)
		seen[m.ID] = true
		worker.models = append(worker.models, m)
	}
	return worker, nil
}
