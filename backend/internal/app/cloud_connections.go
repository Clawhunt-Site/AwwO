package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

// cloudModel is one hosted model's limits, as the hosted /models lists them.
type cloudModel struct {
	ContextWindow      int     `json:"context_window"`
	MaxOutputTokens    int     `json:"max_output_tokens"`
	ProseBytesPerToken float64 `json:"prose_bytes_per_token"`
}

// cloudBudget is how much of a hosted model's window a run here may fill: what the hosted worker takes (the window less
// the output and 256), less a tenth of it, at least 4,096 tokens, for what a worker adds to a call beyond its text (its
// tools' definitions, the JSON around its messages), which the hosted worker counts and this API's budget does not.
func cloudBudget(m cloudModel) int {
	limit := m.ContextWindow - m.MaxOutputTokens - 256
	return limit - max(4096, limit/10)
}

var (
	errCloudKeyRejected = errors.New("cloud key rejected")
	errCloudNoModels    = errors.New("cloud key runs no models")
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
		if !personalTextModel(m.ID) || models[m.ID] != (cloudModel{}) || m.ContextWindow < 4096 || m.ContextWindow > 2_000_000 ||
			m.MaxOutputTokens < 1 || m.MaxOutputTokens+256 >= m.ContextWindow || cloudBudget(m.cloudModel) < 1024 {
			continue
		}
		m.ProseBytesPerToken = min(max(m.ProseBytesPerToken, 1), 4)
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
	entries map[string]cloudModelEntry // connection id → its hosted models' limits, as last read
}

type cloudModelEntry struct {
	at     time.Time
	models map[string]cloudModel // nil while they could not be read
	err    error                 // why not, kept for cloudModelsRetry
}

// rememberCloudModels keeps a connection's hosted models' limits as just read; nil forgets them (a connection deleted).
func (a *App) rememberCloudModels(connection string, models map[string]cloudModel) {
	if models == nil {
		a.rememberCloudEntry(connection, nil)
		return
	}
	a.rememberCloudEntry(connection, &cloudModelEntry{at: time.Now(), models: models})
}

func (a *App) rememberCloudEntry(connection string, entry *cloudModelEntry) {
	c := &a.cloudModelCache
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]cloudModelEntry{}
	}
	if entry == nil {
		delete(c.entries, connection)
		return
	}
	c.entries[connection] = *entry
}

// cloudModels is a connection's hosted models' limits: as read within cloudModelsTTL, else read again with its key. While
// the hosted site is out of reach the limits last read are kept, and read again a minute later; a key it no longer
// takes, or one whose workspace runs no model, offers none, as does a connection never read, until a minute has passed.
func (a *App) cloudModels(ctx context.Context, user, connection string, sealed []byte) (map[string]cloudModel, error) {
	c := &a.cloudModelCache
	c.mu.Lock()
	entry, ok := c.entries[connection]
	c.mu.Unlock()
	switch {
	case ok && entry.err != nil && time.Since(entry.at) < cloudModelsRetry:
		return nil, entry.err
	case ok && entry.models != nil && time.Since(entry.at) < cloudModelsTTL:
		return entry.models, nil
	}
	key, e := a.openCredential(user, connection, sealed)
	if e != nil {
		return nil, e
	}
	_, models, e := a.discoverCloudModels(ctx, key)
	switch {
	case e == nil:
		a.rememberCloudModels(connection, models)
		return models, nil
	case ok && entry.models != nil && !errors.Is(e, errCloudKeyRejected) && !errors.Is(e, errCloudNoModels):
		a.rememberCloudEntry(connection, &cloudModelEntry{at: time.Now().Add(cloudModelsRetry - cloudModelsTTL), models: entry.models})
		return entry.models, nil
	}
	a.rememberCloudEntry(connection, &cloudModelEntry{at: time.Now(), err: e})
	return nil, e
}
