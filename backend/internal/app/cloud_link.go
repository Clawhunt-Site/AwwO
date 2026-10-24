package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// AwwO 本地版's side of the cloud relay (docs/awwo-cloud-relay.md): its person links it to their account on the hosted
// site (AWWO_CLOUD_ORIGIN) from 我的引擎, and its 「AwwO 线上」 engine then calls the hosted site's Bedrock models through
// the relay, with the link's token, on the workspace they chose there. The link is asked for here and approved there
// (local_links.go, a device authorization grant); the token is sealed in the credential vault like any personal key
// and handed to a worker for one call at a time.

const cloudProviderID = "awwo"

// cloudProvider is the 「AwwO 线上」 engine: the relay of the hosted site this edition links to. Its address comes from
// the runtime's configuration (AWWO_CLOUD_ORIGIN), never from what a person types.
func (a *App) cloudProvider() (connectionProvider, bool) {
	base := a.cfg.cloudRelayBase()
	if base == "" {
		return connectionProvider{}, false
	}
	return connectionProvider{ID: cloudProviderID, Name: "AwwO 线上 · 经云端调用 Bedrock", Runtimes: []string{runtimeOpenAIAgents, runtimePI}, BaseURL: base, ModelsURL: base + "/models", Link: true}, true
}

// cloudLinkFlow is a link waiting for its person to approve it on the hosted site. asking: a question about it is on
// its way to the hosted site, which answers a second one for the same code as an exchanged one (expired_token).
type cloudLinkFlow struct {
	deviceCode, userCode, verificationURL string
	expires, polled                       time.Time
	interval                              time.Duration
	asking                                bool
}

// cloudLinkFlows holds each account's waiting link, one at a time. They live as long as this process: a restart asks
// for a new one, which is what the person would do with a code they no longer see anyway. keeping serializes taking a
// granted link: a link is kept only while it is still its account's waiting one (claim), so one cancelled or asked for
// again while its grant was on its way is not kept over a newer one.
type cloudLinkFlows struct {
	mu      sync.Mutex
	flows   map[string]cloudLinkFlow
	keeping sync.Mutex
}

func (f *cloudLinkFlows) put(user string, flow cloudLinkFlow) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.flows == nil {
		f.flows = map[string]cloudLinkFlow{}
	}
	f.flows[user] = flow
}

// poll claims the account's waiting link for one question to the hosted site, at most once its interval and one at a
// time: the flow, whether there is one, and whether this caller may ask now (two tabs asking at once ask once). The
// caller that may ask ends its question with asked.
func (f *cloudLinkFlows) poll(user string, now time.Time) (cloudLinkFlow, bool, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	flow, ok := f.flows[user]
	if !ok || flow.asking || now.Sub(flow.polled) < flow.interval {
		return flow, ok, false
	}
	flow.polled, flow.asking = now, true
	f.flows[user] = flow
	return flow, true, true
}

// asked ends a question about the waiting link with this device code, if it still waits.
func (f *cloudLinkFlows) asked(user, deviceCode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if flow, ok := f.flows[user]; ok && flow.deviceCode == deviceCode {
		flow.asking = false
		f.flows[user] = flow
	}
}

// slowDown lengthens the waiting link's interval, as the hosted site asked, if it is still the one with this device code.
func (f *cloudLinkFlows) slowDown(user, deviceCode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if flow, ok := f.flows[user]; ok && flow.deviceCode == deviceCode {
		flow.interval += 5 * time.Second
		f.flows[user] = flow
	}
}

// claim takes the account's waiting link to keep its grant, if it is still the one with this device code.
func (f *cloudLinkFlows) claim(user, deviceCode string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if flow, ok := f.flows[user]; ok && flow.deviceCode == deviceCode {
		delete(f.flows, user)
		return true
	}
	return false
}

// drop forgets the account's waiting link if it is still the one with this device code ("" forgets any): a link asked
// for meanwhile stays.
func (f *cloudLinkFlows) drop(user, deviceCode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if flow, ok := f.flows[user]; ok && (deviceCode == "" || flow.deviceCode == deviceCode) {
		delete(f.flows, user)
	}
}

// cloudCall sends one request to the hosted site and reads its JSON answer (at most limit bytes): its status and body.
func (a *App) cloudCall(ctx context.Context, method, path, token string, body any, limit int64) (int, []byte, error) {
	return a.cloudCallAt(ctx, a.cfg.CloudOrigin, method, path, token, body, limit)
}

// cloudCallAt is cloudCall to a given hosted site: the one a token was granted by, which ends it.
func (a *App) cloudCallAt(ctx context.Context, origin, method, path, token string, body any, limit int64) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, e := http.NewRequestWithContext(ctx, method, origin+path, reader)
	if e != nil {
		return 0, nil, e
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/json")
	resp, e := a.client.Do(req)
	if e != nil {
		return 0, nil, e
	}
	defer resp.Body.Close()
	data, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil || int64(len(data)) > limit {
		return resp.StatusCode, nil, errors.New("hosted answer unreadable")
	}
	return resp.StatusCode, data, nil
}

// cloudErrorCode is the code of a hosted site's error answer, or "".
func cloudErrorCode(data []byte) string {
	var reply struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &reply)
	return computerWorkerLabel(reply.Error.Code)
}

// cloudDeviceName is how the hosted site names this computer while its person approves it.
func (a *App) cloudDeviceName() string {
	switch a.cfg.LocalShell {
	case "macos":
		return "AwwO 本地版 · Mac"
	case "windows":
		return "AwwO 本地版 · Windows"
	}
	return "AwwO 本地版"
}

// cloudLinkStart asks the hosted site for a link: POST /auth/cloud-link. The answer is the code to approve and the
// hosted page where its person approves it.
func (a *App) cloudLinkStart(w http.ResponseWriter, r *http.Request) {
	if len(a.cfg.CredentialKey) != 32 {
		fail(w, 503, "vault_unavailable", "Personal credential storage is not configured")
		return
	}
	status, data, e := a.cloudCall(r.Context(), "POST", "/api/v1/local-links/start", "", map[string]string{"deviceName": a.cloudDeviceName()}, 64<<10)
	if e != nil || status == 0 {
		fail(w, 502, "cloud_unreachable", "AwwO online could not be reached from this computer")
		return
	}
	switch {
	case status == 404:
		fail(w, 503, "cloud_link_unavailable", "AwwO online does not take connections from AwwO 本地版 yet")
		return
	case status == 429 || status == 503:
		fail(w, 429, "cloud_link_busy", "AwwO online is busy; try again in a minute")
		return
	case status != 201:
		fail(w, 502, "cloud_link_failed", "AwwO online refused the connection request")
		return
	}
	var answer struct {
		DeviceCode string `json:"deviceCode"`
		UserCode   string `json:"userCode"`
		ExpiresIn  int    `json:"expiresIn"`
		Interval   int    `json:"interval"`
	}
	if json.Unmarshal(data, &answer) != nil || !deviceCodePattern.MatchString(answer.DeviceCode) || !userCodePattern.MatchString(answer.UserCode) ||
		answer.ExpiresIn < 60 || answer.ExpiresIn > 3600 || answer.Interval < 1 || answer.Interval > 60 {
		fail(w, 502, "cloud_link_failed", "AwwO online answered the connection request in a form this version does not read")
		return
	}
	// The page the person opens is always this edition's own hosted site, never an address an answer names.
	flow := cloudLinkFlow{deviceCode: answer.DeviceCode, userCode: answer.UserCode, verificationURL: a.cfg.CloudOrigin + "/?link=" + answer.UserCode,
		expires: time.Now().Add(time.Duration(answer.ExpiresIn) * time.Second), interval: time.Duration(answer.Interval) * time.Second}
	a.cloudLinks.put(currentUser(r).ID, flow)
	writeJSON(w, 201, map[string]any{"userCode": flow.userCode, "verificationURL": flow.verificationURL, "expiresAt": flow.expires, "interval": answer.Interval})
}

// cloudLinkCancel drops the waiting link: DELETE /auth/cloud-link.
func (a *App) cloudLinkCancel(w http.ResponseWriter, r *http.Request) {
	a.cloudLinks.drop(currentUser(r).ID, "")
	w.WriteHeader(204)
}

// cloudLinkPoll asks the hosted site, at most once its interval, whether the person approved the waiting link: POST
// /auth/cloud-link/poll. Approved, it takes the link's token and keeps the 「AwwO 线上」 engine, replacing an earlier
// link's (whose token it then ends on the hosted site), and then reads the models the workspace may use there. The
// hosted site issues a token once: from the moment it is asked for, taking and keeping it no longer depends on this
// request (a browser tab closed meanwhile), and the connection is kept before the slower read of its models.
func (a *App) cloudLinkPoll(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	flow, found, ask := a.cloudLinks.poll(u.ID, time.Now())
	if !found {
		fail(w, 404, "no_cloud_link", "No connection to AwwO online is waiting")
		return
	}
	pending := map[string]any{"status": "pending", "userCode": flow.userCode, "verificationURL": flow.verificationURL, "expiresAt": flow.expires}
	// A question on its way decides, even one asked just before the code ended: its grant may already have been issued.
	if !ask && flow.asking {
		writeJSON(w, 200, pending)
		return
	}
	if time.Now().After(flow.expires) {
		a.cloudLinks.drop(u.ID, flow.deviceCode)
		writeJSON(w, 200, map[string]any{"status": "expired"})
		return
	}
	if !ask {
		writeJSON(w, 200, pending)
		return
	}
	defer a.cloudLinks.asked(u.ID, flow.deviceCode)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Minute)
	defer cancel()
	status, data, e := a.cloudCall(ctx, "POST", "/api/v1/local-links/token", "", map[string]string{"deviceCode": flow.deviceCode}, 64<<10)
	if e != nil || status == 0 {
		fail(w, 502, "cloud_unreachable", "AwwO online could not be reached from this computer")
		return
	}
	if status != 200 {
		switch cloudErrorCode(data) {
		case "authorization_pending":
		case "slow_down":
			a.cloudLinks.slowDown(u.ID, flow.deviceCode)
		case "access_denied":
			a.cloudLinks.drop(u.ID, flow.deviceCode)
			writeJSON(w, 200, map[string]any{"status": "denied"})
			return
		case "expired_token":
			a.cloudLinks.drop(u.ID, flow.deviceCode)
			writeJSON(w, 200, map[string]any{"status": "expired"})
			return
		default:
			fail(w, 502, "cloud_link_failed", "AwwO online refused the connection request")
			return
		}
		writeJSON(w, 200, pending)
		return
	}
	var grant struct {
		Token     string    `json:"token"`
		LinkID    string    `json:"linkId"`
		ExpiresAt time.Time `json:"expiresAt"`
		Workspace struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"workspace"`
	}
	if json.Unmarshal(data, &grant) != nil || !linkTokenPattern.MatchString(grant.Token) || grant.LinkID == "" || len(grant.LinkID) > 128 || grant.Workspace.ID == "" {
		fail(w, 502, "cloud_link_failed", "AwwO online answered the connection request in a form this version does not read")
		return
	}
	meta := cloudRelayMeta{Origin: a.cfg.CloudOrigin, LinkID: grant.LinkID, ExpiresAt: grant.ExpiresAt, Models: map[string]cloudRelayModel{}}
	meta.Workspace.ID, meta.Workspace.Name = grant.Workspace.ID, grant.Workspace.Name
	granted := cloudToken{origin: meta.Origin, token: grant.Token}
	a.cloudLinks.keeping.Lock()
	if !a.cloudLinks.claim(u.ID, flow.deviceCode) {
		// Cancelled, or asked for again, while the grant was on its way: the newer request decides.
		a.cloudLinks.keeping.Unlock()
		a.revokeCloudTokens(granted)
		writeJSON(w, 200, map[string]any{"status": "cancelled"})
		return
	}
	replaced, e := a.keepCloudConnection(ctx, u.ID, grant.Token, meta)
	a.cloudLinks.keeping.Unlock()
	if e != nil {
		// The token is no use without its connection: end it on the hosted site rather than leave it valid there.
		a.revokeCloudTokens(granted)
		a.dbError(w, e)
		return
	}
	a.revokeCloudTokens(replaced...)
	out := map[string]any{"status": "connected", "workspace": meta.Workspace, "expiresAt": meta.ExpiresAt}
	models, e := a.cloudRelayModels(ctx, grant.Token)
	if e == nil {
		e = a.keepCloudModels(ctx, u.ID, meta.LinkID, models)
	}
	if e != nil {
		out["warning"] = "models_unavailable"
	}
	out["models"] = len(models)
	writeJSON(w, 200, out)
}

// cloudRelayModel is one model the relay offers this edition, with its limits on the hosted site.
type cloudRelayModel struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	ContextWindow      int      `json:"contextWindow"`
	MaxOutputTokens    int      `json:"maxOutputTokens"`
	Input              []string `json:"input"`
	Tools              bool     `json:"tools"`
	ProseBytesPerToken float64  `json:"proseBytesPerToken,omitempty"`
}

// cloudRelayMeta is what an 「AwwO 线上」 connection keeps of its link (user_connections.relay): the hosted site that
// granted it too, which alone its token is sent to, to relay or to end it.
type cloudRelayMeta struct {
	Origin    string    `json:"origin"`
	LinkID    string    `json:"linkId"`
	ExpiresAt time.Time `json:"expiresAt"`
	Workspace struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"workspace"`
	Models map[string]cloudRelayModel `json:"models"`
}

// cloudRelayModels reads the relay's model list with a link's token (GET /relay/v1/models), keeping the models whose
// limits a worker can hold: the same bounds the hosted site's catalog keeps (apps/bedrock-catalog.ts).
func (a *App) cloudRelayModels(ctx context.Context, token string) ([]cloudRelayModel, error) {
	status, data, e := a.cloudCall(ctx, "GET", "/api/v1/relay/v1/models", token, nil, 1<<20)
	if e != nil || status != 200 {
		return nil, errors.New("relay models unavailable")
	}
	var list struct {
		Data []struct {
			ID   string          `json:"id"`
			Name string          `json:"name"`
			Info cloudRelayModel `json:"awwo"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &list) != nil {
		return nil, errors.New("relay models unreadable")
	}
	models := []cloudRelayModel{}
	for _, item := range list.Data {
		m := item.Info
		m.ID, m.Name = item.ID, strings.TrimSpace(item.Name)
		if !relayModelPattern.MatchString(m.ID) || !personalTextModel(m.ID) || m.ContextWindow < 4096 || m.ContextWindow > 2_000_000 || m.MaxOutputTokens < 128 || m.MaxOutputTokens > 65_536 ||
			m.MaxOutputTokens+256 >= m.ContextWindow || !slices.Contains(m.Input, "text") || len(m.Input) > 2 || (len(m.Input) == 2 && !slices.Contains(m.Input, "image")) ||
			m.ProseBytesPerToken < 0 || m.ProseBytesPerToken > 4 || slices.ContainsFunc(models, func(o cloudRelayModel) bool { return o.ID == m.ID }) {
			continue
		}
		if len([]rune(m.Name)) == 0 || len([]rune(m.Name)) > 80 {
			m.Name = m.ID
		}
		models = append(models, m)
		if len(models) >= maxRuntimeModels {
			break
		}
	}
	return models, nil
}

// cloudModelsFor is the models a runtime takes: OpenAI Agents runs offer tools, so only models that take them.
func cloudModelsFor(meta cloudRelayMeta, runtime string) []string {
	out := []string{}
	for id, m := range meta.Models {
		if runtime == runtimePI || m.Tools {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out
}

// keepCloudConnection keeps the 「AwwO 线上」 engine of a link: one connection for each execution engine, each sealing
// the same token under its own id. It replaces the account's earlier 「AwwO 线上」 link in place, keeping each engine's
// connection id, so agents that chose a relayed model keep it (connectionModelID), and returns the earlier link's
// tokens for the caller to end on the hosted site.
func (a *App) keepCloudConnection(ctx context.Context, uid, token string, meta cloudRelayMeta) ([]cloudToken, error) {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", uid); e != nil {
		return nil, e
	}
	old, e := a.cloudTokens(ctx, tx, uid)
	if e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, "SELECT id,runtime FROM user_connections WHERE user_id=$1 AND provider=$2 ORDER BY created_at", uid, cloudProviderID)
	if e != nil {
		return nil, e
	}
	kept, extra := map[string]string{}, []string{}
	for rows.Next() {
		var id, runtime string
		if e = rows.Scan(&id, &runtime); e != nil {
			rows.Close()
			return nil, e
		}
		if _, dup := kept[runtime]; dup {
			extra = append(extra, id)
		} else {
			kept[runtime] = id
		}
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	if len(extra) > 0 {
		if _, e = tx.Exec(ctx, "DELETE FROM user_connections WHERE user_id=$1 AND id=ANY($2)", uid, extra); e != nil {
			return nil, e
		}
	}
	name := "AwwO 线上 · " + meta.Workspace.Name
	if runes := []rune(name); len(runes) > 80 {
		name = string(runes[:80])
	}
	relay, _ := json.Marshal(meta)
	for _, runtime := range []string{runtimeOpenAIAgents, runtimePI} {
		raw, _ := json.Marshal(cloudModelsFor(meta, runtime))
		id, reuse := kept[runtime]
		if !reuse {
			id = randomID()
		}
		secret, e := a.sealCredential(uid, id, token)
		if e != nil {
			return nil, e
		}
		action := "connection.created"
		if reuse {
			action = "connection.updated"
			_, e = tx.Exec(ctx, "UPDATE user_connections SET name=$3,secret=$4,models=$5,relay=$6 WHERE id=$1 AND user_id=$2", id, uid, name, secret, raw, relay)
		} else {
			_, e = tx.Exec(ctx, "INSERT INTO user_connections(id,user_id,provider,runtime,name,secret,models,relay) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", id, uid, cloudProviderID, runtime, name, secret, raw, relay)
		}
		if e != nil {
			return nil, e
		}
		if e = audit(ctx, tx, uid, "", action, id); e != nil {
			return nil, e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	ended := []cloudToken{}
	for _, t := range old {
		if t.token != token {
			ended = append(ended, t)
		}
	}
	return ended, nil
}

// keepCloudModels keeps the relay's models on every connection of one link, each engine's own share of them
// (cloudModelsFor). Connections of a link that has since been replaced are left as they are.
func (a *App) keepCloudModels(ctx context.Context, uid, linkID string, models []cloudRelayModel) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", uid); e != nil {
		return e
	}
	if e = setCloudModels(ctx, tx, uid, linkID, models); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func setCloudModels(ctx context.Context, tx pgx.Tx, uid, linkID string, models []cloudRelayModel) error {
	rows, e := tx.Query(ctx, "SELECT id,runtime,relay FROM user_connections WHERE user_id=$1 AND provider=$2 AND relay->>'linkId'=$3 FOR UPDATE", uid, cloudProviderID, linkID)
	if e != nil {
		return e
	}
	type row struct {
		id, runtime string
		relay       []byte
	}
	found := []row{}
	for rows.Next() {
		var item row
		if e = rows.Scan(&item.id, &item.runtime, &item.relay); e != nil {
			rows.Close()
			return e
		}
		found = append(found, item)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	for _, item := range found {
		meta, _ := cloudRelayModelsOf(item.relay)
		meta.Models = map[string]cloudRelayModel{}
		for _, m := range models {
			meta.Models[m.ID] = m
		}
		relay, _ := json.Marshal(meta)
		raw, _ := json.Marshal(cloudModelsFor(meta, item.runtime))
		if _, e = tx.Exec(ctx, "UPDATE user_connections SET models=$3,relay=$4 WHERE id=$1 AND user_id=$2", item.id, uid, raw, relay); e != nil {
			return e
		}
	}
	return nil
}

// cloudToken is a link's token and the hosted site that granted it.
type cloudToken struct{ origin, token string }

// cloudTokens opens the account's 「AwwO 线上」 tokens (one per link; each connection of a link seals the same one).
func (a *App) cloudTokens(ctx context.Context, q querier, uid string) ([]cloudToken, error) {
	rows, e := q.Query(ctx, "SELECT id,secret,relay FROM user_connections WHERE user_id=$1 AND provider=$2", uid, cloudProviderID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	tokens := []cloudToken{}
	for rows.Next() {
		var id string
		var sealed, relay []byte
		if e = rows.Scan(&id, &sealed, &relay); e != nil {
			return nil, e
		}
		meta, _ := cloudRelayModelsOf(relay)
		if token, err := a.openCredential(uid, id, sealed); err == nil && !slices.ContainsFunc(tokens, func(t cloudToken) bool { return t.token == token }) {
			tokens = append(tokens, cloudToken{origin: meta.Origin, token: token})
		}
	}
	return tokens, rows.Err()
}

// revokeCloudTokens ends tokens on the hosted sites that granted them (DELETE /relay/v1/link), in the background and
// at most once each: the connection here is gone already, and a hosted site out of reach leaves the token to its
// expiry, or to its person disconnecting the computer there.
func (a *App) revokeCloudTokens(tokens ...cloudToken) {
	for _, t := range tokens {
		if !validCloudOrigin(t.origin, a.cfg.Env == "development") {
			continue
		}
		a.tasks.Add(1)
		go func(t cloudToken) {
			defer a.tasks.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if status, _, e := a.cloudCallAt(ctx, t.origin, "DELETE", "/api/v1/relay/v1/link", t.token, nil, 64<<10); e != nil || (status != 204 && status != 401) {
				a.log.Warn("AwwO online token could not be ended", "status", status)
			}
		}(t)
	}
}

// cloudRelayModelsOf reads an 「AwwO 线上」 connection's relay meta (user_connections.relay).
func cloudRelayModelsOf(raw []byte) (cloudRelayMeta, bool) {
	var meta cloudRelayMeta
	if len(raw) == 0 || json.Unmarshal(raw, &meta) != nil || meta.Models == nil {
		return cloudRelayMeta{}, false
	}
	return meta, true
}

// usableCloudMeta is an 「AwwO 线上」 connection's link where it can relay: granted by the hosted site this edition links
// to now (a link of another, from before AWWO_CLOUD_ORIGIN changed, sends its token nowhere).
func (a *App) usableCloudMeta(raw []byte) (cloudRelayMeta, bool) {
	meta, ok := cloudRelayModelsOf(raw)
	return meta, ok && a.cfg.CloudOrigin != "" && meta.Origin == a.cfg.CloudOrigin
}

var errCloudOriginChanged = errors.New("cloud origin changed")

// refreshCloudConnection reads the relay's models again for an 「AwwO 线上」 connection and keeps them on every
// connection of its link. The connection is unchanged when the hosted site cannot be read.
func (a *App) refreshCloudConnection(ctx context.Context, uid, id string, sealed, relay []byte) (json.RawMessage, error) {
	meta, ok := a.usableCloudMeta(relay)
	if !ok {
		return nil, errCloudOriginChanged
	}
	token, e := a.openCredential(uid, id, sealed)
	if e != nil {
		return nil, e
	}
	models, e := a.cloudRelayModels(ctx, token)
	if e != nil {
		return nil, e
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	// The account's row before its connections', as keepCloudConnection takes them.
	if _, e = tx.Exec(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", uid); e != nil {
		return nil, e
	}
	if e = setCloudModels(ctx, tx, uid, meta.LinkID, models); e != nil {
		return nil, e
	}
	var view json.RawMessage
	if e = tx.QueryRow(ctx, "SELECT "+connectionView+" FROM user_connections WHERE id=$1 AND user_id=$2", id, uid).Scan(&view); e != nil {
		return nil, e
	}
	if e = audit(ctx, tx, uid, "", "connection.refreshed", id); e != nil {
		return nil, e
	}
	return view, tx.Commit(ctx)
}
