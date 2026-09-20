package app

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// User input never supplies a network address. Keys are sent only to these
// provider origins, with redirects disabled. Operators own this allowlist.
type connectionProvider struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Runtimes  []string `json:"runtimes"`
	BaseURL   string   `json:"-"`
	ModelsURL string   `json:"-"`
}

var connectionProviders = []connectionProvider{
	{"llmgate", "LLM Gate · ClawHunt", []string{runtimeOpenAIAgents, runtimePI}, "https://api.clawhunt.site/v1", "https://api.clawhunt.site/v1/models"},
	{"openai", "OpenAI / Codex", []string{runtimeOpenAIAgents}, "https://api.openai.com/v1", "https://api.openai.com/v1/models"},
	{"anthropic", "Claude / Anthropic", []string{runtimePI}, "https://api.anthropic.com", "https://api.anthropic.com/v1/models?limit=1000"},
	{"xai", "Grok / xAI", []string{runtimeOpenAIAgents, runtimePI}, "https://api.x.ai/v1", "https://api.x.ai/v1/models"},
	{"google", "Gemini / Google", []string{runtimeOpenAIAgents, runtimePI}, "https://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"},
}
var providerModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$`)
var connectionSelectorPattern = regexp.MustCompile(`^byok_([A-Za-z0-9_-]{33})_([0-9a-f]{16})$`)

func providerByID(id string) (connectionProvider, bool) {
	for _, p := range connectionProviders {
		if p.ID == id {
			return p, true
		}
	}
	return connectionProvider{}, false
}
func connectionSupports(p connectionProvider, runtime string) bool {
	for _, r := range p.Runtimes {
		if r == runtime {
			return true
		}
	}
	return false
}
func connectionModelID(id, model string) string {
	h := sha256.Sum256([]byte(model))
	return "byok_" + id + "_" + hex.EncodeToString(h[:8])
}
func connectionProtocol(provider, runtime, model string) string {
	if provider == "anthropic" {
		return "anthropic_messages"
	}
	if runtime == runtimeOpenAIAgents && (provider == "openai" || (provider == "llmgate" && (strings.HasPrefix(strings.ToLower(model), "gpt-") || strings.Contains(strings.ToLower(model), "codex")))) {
		return "responses"
	}
	return "chat_completions"
}
func validAPIKey(key string) bool {
	if len(key) < 8 || len(key) > 4096 {
		return false
	}
	for _, r := range key {
		if r <= 32 || r >= 127 {
			return false
		}
	}
	return true
}
func (a *App) sealCredential(user, id, key string) ([]byte, error) {
	block, e := aes.NewCipher(a.cfg.CredentialKey)
	if e != nil {
		return nil, errors.New("credential vault unavailable")
	}
	g, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	nonce := make([]byte, g.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return nil, e
	}
	return g.Seal(nonce, nonce, []byte(key), []byte(user+"\x00"+id)), nil
}
func (a *App) openCredential(user, id string, sealed []byte) (string, error) {
	block, e := aes.NewCipher(a.cfg.CredentialKey)
	if e != nil {
		return "", errors.New("credential vault unavailable")
	}
	g, e := cipher.NewGCM(block)
	if e != nil {
		return "", e
	}
	if len(sealed) < g.NonceSize() {
		return "", errors.New("invalid credential")
	}
	raw, e := g.Open(nil, sealed[:g.NonceSize()], sealed[g.NonceSize():], []byte(user+"\x00"+id))
	if e != nil {
		return "", errors.New("credential unavailable")
	}
	return string(raw), nil
}
func (a *App) discoverConnectionModels(ctx context.Context, p connectionProvider, key string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", p.ModelsURL, nil)
	if e != nil {
		return nil, errors.New("provider unavailable")
	}
	switch p.ID {
	case "anthropic":
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "google":
		req.Header.Set("x-goog-api-key", key)
	default:
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, e := a.client.Do(req)
	if e != nil {
		return nil, errors.New("provider unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("provider rejected credentials or model discovery")
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if e != nil || len(raw) > 1024*1024 {
		return nil, errors.New("invalid model catalog")
	}
	var catalog struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			Name    string   `json:"name"`
			Methods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	if json.Unmarshal(raw, &catalog) != nil {
		return nil, errors.New("invalid model catalog")
	}
	seen := map[string]bool{}
	models := []string{}
	add := func(id string) {
		if providerModelPattern.MatchString(id) && !seen[id] {
			seen[id] = true
			models = append(models, id)
		}
	}
	for _, m := range catalog.Data {
		// The canvas is text-only. Do not advertise image/audio/embedding endpoints.
		lower := strings.ToLower(m.ID)
		if strings.Contains(lower, "embedding") || strings.Contains(lower, "whisper") || strings.Contains(lower, "tts") || strings.Contains(lower, "dall-e") || strings.Contains(lower, "image") || strings.Contains(lower, "realtime") {
			continue
		}
		add(m.ID)
	}
	for _, m := range catalog.Models {
		for _, method := range m.Methods {
			if method == "generateContent" {
				add(strings.TrimPrefix(m.Name, "models/"))
				break
			}
		}
	}
	sort.Strings(models)
	if len(models) > 64 {
		models = models[:64]
	}
	if len(models) == 0 {
		return nil, errors.New("no compatible text models available")
	}
	return models, nil
}
func (a *App) listConnections(w http.ResponseWriter, r *http.Request) {
	items, e := rowsJSON(r.Context(), a.db, `SELECT jsonb_build_object('id',id,'provider',provider,'runtime',runtime,'name',name,'models',models,'createdAt',created_at,'hasKey',true) FROM user_connections WHERE user_id=$1 ORDER BY created_at`, currentUser(r).ID)
	if e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "providers": connectionProviders, "required": a.cfg.UserCredentials, "purchaseURL": "https://api.clawhunt.site/"})
}
func (a *App) createConnection(w http.ResponseWriter, r *http.Request) {
	if len(a.cfg.CredentialKey) != 32 {
		fail(w, 503, "vault_unavailable", "Personal credential storage is not configured")
		return
	}
	var b struct {
		Provider string `json:"provider"`
		Runtime  string `json:"runtime"`
		Name     string `json:"name"`
		APIKey   string `json:"apiKey"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	p, ok := providerByID(b.Provider)
	b.Name = strings.TrimSpace(b.Name)
	if !ok || !connectionSupports(p, b.Runtime) || !validAPIKey(b.APIKey) || len(b.Name) > 80 {
		fail(w, 400, "invalid_connection", "Choose a provider, supported engine and valid API key")
		return
	}
	if b.Name == "" {
		b.Name = p.Name
	}
	models, e := a.discoverConnectionModels(r.Context(), p, b.APIKey)
	if e != nil {
		fail(w, 422, "provider_verification_failed", "Could not verify the API key and read its model catalog. Check the key, access region and provider account.")
		return
	}
	uid, id := currentUser(r).ID, randomID()
	secret, e := a.sealCredential(uid, id, b.APIKey)
	if e != nil {
		fail(w, 503, "vault_unavailable", "Credential storage is unavailable")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	// Serialize inserts per owner, including the count check.
	if _, e = tx.Exec(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", uid); e != nil {
		a.dbError(w, e)
		return
	}
	var count int
	if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM user_connections WHERE user_id=$1", uid).Scan(&count); e != nil {
		a.dbError(w, e)
		return
	}
	if count >= 8 {
		fail(w, 409, "connection_limit", "At most eight personal connections are allowed")
		return
	}
	raw, _ := json.Marshal(models)
	if _, e = tx.Exec(r.Context(), "INSERT INTO user_connections(id,user_id,provider,runtime,name,secret,models) VALUES($1,$2,$3,$4,$5,$6,$7)", id, uid, b.Provider, b.Runtime, b.Name, secret, raw); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, uid, "", "connection.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "provider": b.Provider, "runtime": b.Runtime, "name": b.Name, "models": models, "hasKey": true})
}
func (a *App) deleteConnection(w http.ResponseWriter, r *http.Request) {
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	uid, id := currentUser(r).ID, r.PathValue("id")
	result, e := tx.Exec(r.Context(), "DELETE FROM user_connections WHERE id=$1 AND user_id=$2", id, uid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if result.RowsAffected() != 1 {
		fail(w, 404, "not_found", "Connection not found")
		return
	}
	if e = audit(r.Context(), tx, uid, "", "connection.deleted", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	w.WriteHeader(204)
}
func (a *App) personalRuntime(ctx context.Context, runtime string) (piHealth, error) {
	u, ok := ctx.Value(userKey{}).(User)
	if !ok {
		return piHealth{}, errors.New("personal credentials required")
	}
	rows, e := a.db.Query(ctx, "SELECT id,provider,name,models FROM user_connections WHERE user_id=$1 AND runtime=$2 ORDER BY created_at", u.ID, runtime)
	if e != nil {
		return piHealth{}, e
	}
	defer rows.Close()
	h := piHealth{Ready: true, Status: "ready", Limits: map[string]any{"maxContextTextBytes": float64(28416), "messageOverheadBytes": float64(32)}, Models: []piModel{}}
	for rows.Next() {
		var id, provider, name string
		var raw []byte
		if e = rows.Scan(&id, &provider, &name, &raw); e != nil {
			return piHealth{}, e
		}
		var models []string
		if json.Unmarshal(raw, &models) != nil {
			return piHealth{}, errors.New("invalid personal catalog")
		}
		for _, model := range models {
			label := model + " · " + name + " · " + provider + " / " + id[max(0, len(id)-6):]
			h.Models = append(h.Models, piModel{ID: connectionModelID(id, model), Name: model, Label: label, Provider: provider, ProviderModel: model, Protocol: connectionProtocol(provider, runtime, model), Runtime: runtime, MaxContextTextBytes: 28416, MessageOverheadBytes: 32})
		}
	}
	if e = rows.Err(); e != nil {
		return piHealth{}, e
	}
	if len(h.Models) == 0 {
		return piHealth{}, errors.New("Add your own API key in Personal engines")
	}
	h.Model = h.Models[0].ID
	h.Provider = h.Models[0].Provider
	return h, nil
}

// Resolve from the persisted run actor, including team child invocations. Neither
// the browser nor a collaborator selects another user's key. No secret enters
// execution snapshots, events, telemetry, canvas JSON or response bodies.
func (a *App) personalAdmission(ctx context.Context, runtime string, body []byte) ([]byte, error) {
	var request map[string]json.RawMessage
	if json.Unmarshal(body, &request) != nil {
		return nil, errors.New("invalid request")
	}
	var rid, tid, sid, selector string
	for field, target := range map[string]*string{"runId": &rid, "tenantId": &tid, "sessionId": &sid, "model": &selector} {
		if json.Unmarshal(request[field], target) != nil {
			return nil, errors.New("invalid admission identity")
		}
	}
	match := connectionSelectorPattern.FindStringSubmatch(selector)
	if match == nil {
		return nil, errors.New("personal credential required")
	}
	var uid, parentSession, member string
	e := a.db.QueryRow(ctx, `SELECT actor_id,session_id,'' FROM runs WHERE id=$1 AND tenant_id=$2
 UNION ALL SELECT r.actor_id,r.session_id,t.member_id FROM run_turns t JOIN runs r ON r.id=t.run_id AND r.tenant_id=t.tenant_id WHERE t.id=$1 AND r.tenant_id=$2 LIMIT 1`, rid, tid).Scan(&uid, &parentSession, &member)
	if e != nil {
		return nil, errors.New("run owner unavailable")
	}
	expectedSession := parentSession
	if member != "" {
		expectedSession += "_" + tokenHash(member)[:16]
	}
	if sid != expectedSession {
		return nil, errors.New("run session does not match")
	}
	var provider string
	var sealed, raw []byte
	e = a.db.QueryRow(ctx, "SELECT provider,secret,models FROM user_connections WHERE id=$1 AND user_id=$2 AND runtime=$3", match[1], uid, runtime).Scan(&provider, &sealed, &raw)
	if e != nil {
		return nil, errors.New("personal credential was removed or belongs to another account")
	}
	var models []string
	if json.Unmarshal(raw, &models) != nil {
		return nil, errors.New("invalid personal catalog")
	}
	model := ""
	for _, m := range models {
		if connectionModelID(match[1], m) == selector {
			model = m
			break
		}
	}
	p, ok := providerByID(provider)
	if model == "" || !ok || !connectionSupports(p, runtime) {
		return nil, errors.New("model unavailable")
	}
	key, e := a.openCredential(uid, match[1], sealed)
	if e != nil {
		return nil, e
	}
	request["userModel"], e = json.Marshal(map[string]any{"id": selector, "provider": provider, "model": model, "baseURL": p.BaseURL, "apiKey": key, "protocol": connectionProtocol(provider, runtime, model), "contextWindow": 32768, "maxTokens": 4096, "reasoningEfforts": []string{}, "defaultReasoningEffort": ""})
	if e != nil {
		return nil, e
	}
	return json.Marshal(request)
}
