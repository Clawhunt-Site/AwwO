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
	// errCloudGone: a connection deleted while a read of it waited for its turn or was under way.
	errCloudGone = errors.New("cloud connection deleted")
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
	mu      sync.Mutex
	entries map[string]cloudModelEntry // connection id → what is known of its hosted models
	reading map[string]bool            // connection id → a read of it in the background is waiting or under way
	turns   map[string]*cloudModelTurn // connection id → its turn (cloudTurn), while it is held or waited for
	gone    map[string]bool            // connection id → deleted: nothing is kept for it again
}

// cloudModelTurn is a connection's turn: held by one at a time (held), waited for by the others.
type cloudModelTurn struct {
	held  chan struct{}
	users int // those holding it or waiting for it
}

type cloudModelEntry struct {
	at     time.Time
	models map[string]cloudModel // nil while they could not be read
	err    error                 // why not, kept for cloudModelsRetry
}

// answer is what an entry answers now: its models while they are fresh (cloudModelsTTL), its failure for
// cloudModelsRetry; ok false once the hosted site is to be asked again.
func (e cloudModelEntry) answer() (models map[string]cloudModel, ok bool, err error) {
	switch {
	case e.err != nil && time.Since(e.at) < cloudModelsRetry:
		return nil, true, e.err
	case e.models != nil && time.Since(e.at) < cloudModelsTTL:
		return e.models, true, nil
	}
	return nil, false, nil
}

func (a *App) cloudEntry(connection string) (cloudModelEntry, bool) {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[connection]
	return entry, ok
}

// cloudTurn is a connection's turn to learn its hosted models, waited for as long as ctx lets it. Every read of them
// (in the background, or waited for) holds it for its whole read, and so do the connection's save and refresh, from
// their question to the hosted site until what it answered is saved and kept: none of them overlap, and what is kept is
// what was learnt last. A turn no one holds or waits for is forgotten.
func (a *App) cloudTurn(ctx context.Context, connection string) (release func(), e error) {
	c := &a.cloudModelCache
	c.mu.Lock()
	if c.turns == nil {
		c.turns = map[string]*cloudModelTurn{}
	}
	turn := c.turns[connection]
	if turn == nil {
		turn = &cloudModelTurn{held: make(chan struct{}, 1)}
		c.turns[connection] = turn
	}
	turn.users++
	c.mu.Unlock()
	leave := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if turn.users--; turn.users == 0 {
			delete(c.turns, connection)
		}
	}
	select {
	case turn.held <- struct{}{}:
		return func() { <-turn.held; leave() }, nil
	case <-ctx.Done():
		leave()
		return nil, ctx.Err()
	}
}

// keepCloud keeps what was learnt of a connection's hosted models, in its turn, and says whether it did: nothing is
// kept for a deleted connection.
func (a *App) keepCloud(connection string, entry cloudModelEntry) bool {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gone[connection] {
		return false
	}
	if c.entries == nil {
		c.entries = map[string]cloudModelEntry{}
	}
	c.entries[connection] = entry
	return true
}

// forgetCloud forgets a deleted connection's hosted models for good: a read of them under way, or waiting for its
// turn, keeps nothing and offers nothing.
func (a *App) forgetCloud(connection string) {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, connection)
	if c.gone == nil {
		c.gone = map[string]bool{}
	}
	c.gone[connection] = true
}

func (a *App) cloudGone(connection string) bool {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gone[connection]
}

// cloudModels is a connection's hosted models' limits: as read within cloudModelsTTL, else read again with its key.
// While the hosted site is out of reach the limits last read are kept, read again a minute later; a key it no longer
// takes, or one whose workspace runs no model, offers none until a minute has passed. wait says whether the caller may
// wait for the hosted site: one that holds no database lock (a call being sent). A catalog read never does, since a
// run's creation reads its catalog under its workspace's lock: it takes the limits as last read and has them read again
// in the background (refreshCloudModels), offering none until they are known.
func (a *App) cloudModels(ctx context.Context, user, connection string, sealed []byte, wait bool) (map[string]cloudModel, error) {
	entry, known := a.cloudEntry(connection)
	if models, ok, e := entry.answer(); known && ok {
		return models, e
	}
	if !wait {
		a.refreshCloudModels(user, connection, sealed)
		if known && entry.models != nil {
			return entry.models, nil
		}
		return nil, errCloudUnread
	}
	release, e := a.cloudTurn(ctx, connection)
	if e != nil {
		return nil, e
	}
	defer release()
	return a.readCloudModels(ctx, user, connection, sealed)
}

// readCloudModels learns a connection's hosted models in its turn, which its caller holds: from the read before it in
// the turn, while that one's answer is good, else from the hosted site with the connection's key. What it learns is
// kept, and is its answer: the models and their limits; the hosted site's refusal of the key; or, the site out of
// reach, the limits or the refusal known already, the site to be asked again a minute later, else the failure. A read
// cut short (a shutdown, its caller gone) learns nothing, and one of a connection deleted meanwhile offers nothing.
func (a *App) readCloudModels(ctx context.Context, user, connection string, sealed []byte) (map[string]cloudModel, error) {
	entry, known := a.cloudEntry(connection)
	if models, ok, e := entry.answer(); known && ok {
		return models, e
	}
	if a.cloudGone(connection) {
		return nil, errCloudGone
	}
	key, e := a.openCredential(user, connection, sealed)
	if e != nil {
		return nil, e
	}
	_, models, e := a.discoverCloudModels(ctx, key)
	if e != nil && ctx.Err() != nil {
		return nil, e
	}
	learnt := cloudModelEntry{at: time.Now(), models: models, err: e}
	switch {
	case e == nil || cloudKeyRefused(e):
	case known && entry.models != nil:
		learnt = cloudModelEntry{at: learnt.at.Add(cloudModelsRetry - cloudModelsTTL), models: entry.models}
	case known && cloudKeyRefused(entry.err):
		// The site out of reach says nothing against a key it refused.
		learnt.err = entry.err
	}
	if !a.keepCloud(connection, learnt) {
		return nil, errCloudGone
	}
	return learnt.models, learnt.err
}

// cloudKeyRefused says whether a failure to read a connection's hosted models is the hosted site's answer about its key
// (refused, or its workspace may run no model), which ends the models it offered, rather than the site out of reach.
func cloudKeyRefused(e error) bool {
	return errors.Is(e, errCloudKeyRejected) || errors.Is(e, errCloudNoModels)
}

// refreshCloudModels reads a connection's hosted models in the background, in its turn, one read waiting or under way
// at a time for each connection, as part of the work this process runs (a.running, a.tasks): a shutdown or a lost
// database lock cuts the read, or its wait for the turn.
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
		release, e := a.cloudTurn(ctx, connection)
		if e != nil {
			return
		}
		defer release()
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
