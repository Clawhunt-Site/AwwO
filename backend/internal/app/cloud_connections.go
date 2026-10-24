package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sync"
	"time"
)

// AwwO 云端: a personal connection of the local edition whose models the hosted AwwO runs (its relay, relay.go), with a
// key its person made there (设置 → 本机版连接). Its calls count against that hosted account, as the owner chose
// (「计入线上账号」). Its models and their limits are the hosted site's own (its /models): read when the connection is
// saved or refreshed, and again when they are needed after a while, since a hosted model's window is not the 32,768
// tokens the other personal connections are held to.

const cloudProviderID = "awwo"

// cloudModelsTTL is how long the hosted models' limits read for a connection are used before they are read again.
const cloudModelsTTL = 10 * time.Minute

func (a *App) cloudProvider() connectionProvider {
	base := a.cfg.cloudOrigin() + "/api/v1/relay/v1"
	return connectionProvider{ID: cloudProviderID, Name: "AwwO 云端 · AwwO Cloud", Runtimes: []string{runtimeOpenAIAgents, runtimePI}, BaseURL: base, ModelsURL: base + "/models"}
}

// connectionProvider is a provider a personal connection may name: AwwO 云端 in the local edition alone, the others
// anywhere (connectionProviders).
func (a *App) connectionProvider(id string) (connectionProvider, bool) {
	if id == cloudProviderID {
		return a.cloudProvider(), a.cfg.Edition == editionLocal
	}
	return providerByID(id)
}

// cloudModel is one hosted model's limits, as the hosted /models lists them: its window, its output, its prose rate, and
// the largest request the relay reads (relayModels; the relay's own limit, relayBodyLimit, where an older site says
// none).
type cloudModel struct {
	ContextWindow      int     `json:"context_window"`
	MaxOutputTokens    int     `json:"max_output_tokens"`
	ProseBytesPerToken float64 `json:"prose_bytes_per_token"`
	MaxRequestBytes    int     `json:"max_request_bytes"`
}

// cloudBudget is how much of a hosted model's window a run here may fill: what the hosted worker takes (the window less
// the output and 256), less a tenth of it, at least 4,096 tokens, for what a worker adds to a call beyond its text (its
// tools' definitions, the JSON around its messages), which the hosted worker counts and this API's budget does not. It
// is also held within the relay's request size: a text of n tokens at the model's rate is at most n×rate bytes, which
// JSON's escapes grow by half for a text of short lines (a line's end, prose at the rate, is two bytes escaped; Chinese
// with blank lines between its lines measured 1.4), and 64 KiB are left for the tools and the JSON around the messages.
// A call past the request size all the same is refused by the relay as too large for its model, which the workers read
// as the size refusal it is (relayTooLarge).
func cloudBudget(m cloudModel) int {
	limit := m.ContextWindow - m.MaxOutputTokens - 256
	budget := limit - max(4096, limit/10)
	if m.MaxRequestBytes > 0 {
		budget = min(budget, int(float64(m.MaxRequestBytes-64<<10)/(max(m.ProseBytesPerToken, 1)*1.5)))
	}
	return budget
}

var (
	errCloudKeyRejected = errors.New("cloud key rejected")
	errCloudNoModels    = errors.New("cloud key runs no models")
	// errCloudUnread: a connection whose hosted models are being read, not yet known.
	errCloudUnread = errors.New("cloud models not read yet")
)

// discoverCloudModels reads the hosted models a connection key may run (GET /models with it): their ids, in the hosted
// site's order, and their limits. A model whose limits do not hold is left out.
func (a *App) discoverCloudModels(ctx context.Context, key string) ([]string, map[string]cloudModel, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", a.cloudProvider().ModelsURL, nil)
	if e != nil {
		return nil, nil, errors.New("cloud unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	resp, e := a.client.Do(req)
	if e != nil {
		return nil, nil, errors.New("cloud unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, nil, errCloudKeyRejected
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20+1))
	var list struct {
		Data []struct {
			ID string `json:"id"`
			cloudModel
		} `json:"data"`
	}
	if resp.StatusCode != 200 || e != nil || len(raw) > 1<<20 || json.Unmarshal(raw, &list) != nil {
		return nil, nil, errors.New("cloud unavailable")
	}
	ids, models := []string{}, map[string]cloudModel{}
	for _, m := range list.Data {
		// A rate is held to 1–4 and to a multiple of 0.05, rounded down, as a worker's is (validProseRate); a site that
		// names no request size reads the relay's own.
		m.ProseBytesPerToken = math.Floor(min(max(m.ProseBytesPerToken, 1), 4)*20+1e-9) / 20
		if m.MaxRequestBytes <= 0 {
			m.MaxRequestBytes = relayBodyLimit
		}
		if !personalTextModel(m.ID) || models[m.ID] != (cloudModel{}) || m.ContextWindow < 4096 || m.ContextWindow > 2_000_000 ||
			m.MaxOutputTokens < 1 || m.MaxOutputTokens+256 >= m.ContextWindow || m.MaxRequestBytes > 64<<20 || cloudBudget(m.cloudModel) < 1024 {
			continue
		}
		ids, models[m.ID] = append(ids, m.ID), m.cloudModel
	}
	if len(ids) > maxRuntimeModels {
		return nil, nil, errors.New("cloud catalog exceeds limit")
	}
	if len(ids) == 0 {
		return nil, nil, errCloudNoModels
	}
	return ids, models, nil
}

// cloudDiscoveryFailed answers a connection's save or refresh whose hosted models could not be read.
func cloudDiscoveryFailed(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, errCloudKeyRejected):
		fail(w, 422, "cloud_key_rejected", "The online AwwO did not take this connection key: make one on 设置 → 本机版连接 there")
	case errors.Is(e, errCloudNoModels):
		fail(w, 422, "cloud_no_models", "This key's workspace may run no cloud model")
	default:
		fail(w, 503, "cloud_unavailable", "The online AwwO could not be reached: try again shortly")
	}
}

// cloudModelsRetry is how long a failure to read a connection's hosted models is kept before they are read again: behind
// a proxy whose DNS answers for any name (the owner's Clash), an unreachable site holds each read for its whole 15 s.
const cloudModelsRetry = time.Minute

type cloudModelCache struct {
	mu         sync.Mutex
	entries    map[string]cloudModelEntry // connection id → its hosted models' limits, as last read
	reading    map[string]bool            // connection id → its models are being read in the background
	generation map[string]uint64          // connection id → how many times what is known of it was written
}

type cloudModelEntry struct {
	at     time.Time
	models map[string]cloudModel // nil while they could not be read
	err    error                 // why not, kept for cloudModelsRetry
}

func (a *App) cloudEntry(connection string) (cloudModelEntry, bool) {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[connection]
	return entry, ok
}

// rememberCloudModels keeps a connection's hosted models' limits as just read; nil forgets them (a connection deleted).
func (a *App) rememberCloudModels(connection string, models map[string]cloudModel) {
	if models == nil {
		a.rememberCloudEntry(connection, nil)
		return
	}
	a.rememberCloudEntry(connection, &cloudModelEntry{at: time.Now(), models: models})
}

// rememberCloudEntry keeps what is known of a connection's hosted models (nil: nothing, the connection deleted), as a
// connection saved, refreshed or deleted learns it: newer than any read begun before (publishCloudEntry).
func (a *App) rememberCloudEntry(connection string, entry *cloudModelEntry) {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	c.write(connection, entry)
}

// write keeps entry for connection, c.mu held.
func (c *cloudModelCache) write(connection string, entry *cloudModelEntry) {
	if c.entries == nil {
		c.entries = map[string]cloudModelEntry{}
	}
	if c.generation == nil {
		c.generation = map[string]uint64{}
	}
	c.generation[connection]++
	if entry == nil {
		delete(c.entries, connection)
		return
	}
	c.entries[connection] = *entry
}

// cloudGeneration is how many times what is known of a connection's hosted models has been written, which a read notes
// when it begins.
func (a *App) cloudGeneration(connection string) uint64 {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generation[connection]
}

// publishCloudEntry keeps what a read begun at generation learnt, unless something was kept meanwhile (the connection
// saved again, refreshed, refused or deleted): that is newer than the read's answer, which would put back models the
// hosted site has since refused, or a deleted connection's.
func (a *App) publishCloudEntry(connection string, generation uint64, entry *cloudModelEntry) {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.generation[connection] == generation {
		c.write(connection, entry)
	}
}

// cloudModels is a connection's hosted models' limits: as read within cloudModelsTTL, else read again with its key.
// While the hosted site is out of reach the limits last read are kept, read again a minute later; a key it no longer
// takes, or one whose workspace runs no model, offers none until a minute has passed. wait says whether the caller may
// wait for the hosted site: one that holds no database lock (a connection saved or refreshed, a call being sent). A
// catalog read never does, since a run's creation reads its catalog under its workspace's lock: it takes the limits as
// last read and has them read again in the background (refreshCloudModels), offering none until they are known.
func (a *App) cloudModels(ctx context.Context, user, connection string, sealed []byte, wait bool) (map[string]cloudModel, error) {
	entry, ok := a.cloudEntry(connection)
	switch {
	case ok && entry.err != nil && time.Since(entry.at) < cloudModelsRetry:
		return nil, entry.err
	case ok && entry.models != nil && time.Since(entry.at) < cloudModelsTTL:
		return entry.models, nil
	case !wait:
		a.refreshCloudModels(user, connection, sealed)
		if ok && entry.models != nil {
			return entry.models, nil
		}
		return nil, errCloudUnread
	}
	return a.readCloudModels(ctx, user, connection, sealed)
}

// readCloudModels reads a connection's hosted models with its key and keeps what it learnt: the models and their
// limits, or why not; while the hosted site is out of reach, the limits read last, read again a minute later.
func (a *App) readCloudModels(ctx context.Context, user, connection string, sealed []byte) (map[string]cloudModel, error) {
	generation := a.cloudGeneration(connection)
	key, e := a.openCredential(user, connection, sealed)
	if e != nil {
		return nil, e
	}
	_, models, e := a.discoverCloudModels(ctx, key)
	entry, ok := a.cloudEntry(connection)
	switch {
	case e == nil:
		a.publishCloudEntry(connection, generation, &cloudModelEntry{at: time.Now(), models: models})
		return models, nil
	case ok && entry.models != nil && !cloudKeyRefused(e):
		a.publishCloudEntry(connection, generation, &cloudModelEntry{at: time.Now().Add(cloudModelsRetry - cloudModelsTTL), models: entry.models})
		return entry.models, nil
	}
	a.publishCloudEntry(connection, generation, &cloudModelEntry{at: time.Now(), err: e})
	return nil, e
}

// cloudKeyRefused says whether a failure to read a connection's hosted models is the hosted site's answer about its key
// (refused, or its workspace may run no model), which ends the models it offered, rather than the site out of reach.
func cloudKeyRefused(e error) bool {
	return errors.Is(e, errCloudKeyRejected) || errors.Is(e, errCloudNoModels)
}

// refreshCloudModels reads a connection's hosted models in the background, once at a time for each connection, as part
// of the work this process runs (a.running, a.tasks): a shutdown or a lost database lock cuts the read.
func (a *App) refreshCloudModels(user, connection string, sealed []byte) {
	c := &a.cloudModelCache
	c.mu.Lock()
	if c.reading[connection] {
		c.mu.Unlock()
		return
	}
	if c.reading == nil {
		c.reading = map[string]bool{}
	}
	c.reading[connection] = true
	c.mu.Unlock()
	done := func() {
		c.mu.Lock()
		delete(c.reading, connection)
		c.mu.Unlock()
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		cancel()
		done()
		return
	}
	a.running["cloud:"+connection] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer done()
		defer func() {
			a.mu.Lock()
			delete(a.running, "cloud:"+connection)
			a.mu.Unlock()
			cancel()
		}()
		_, _ = a.readCloudModels(ctx, user, connection, sealed)
	}()
}

// warmCloudModels has the hosted models of every AwwO 云端 connection on this computer read in the background when the
// local edition starts, so its first catalog offers them.
func (a *App) warmCloudModels(ctx context.Context) error {
	if a.cfg.Edition != editionLocal {
		return nil
	}
	rows, e := a.db.Query(ctx, "SELECT user_id,id,secret FROM user_connections WHERE provider=$1", cloudProviderID)
	if e != nil {
		return e
	}
	defer rows.Close()
	type connection struct {
		user, id string
		sealed   []byte
	}
	found := []connection{}
	for rows.Next() {
		var c connection
		if e = rows.Scan(&c.user, &c.id, &c.sealed); e != nil {
			return e
		}
		found = append(found, c)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	for _, c := range found {
		a.refreshCloudModels(c.user, c.id, c.sealed)
	}
	return nil
}
