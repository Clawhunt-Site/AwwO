package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCloudOriginIsTheLocalEditionsAlone(t *testing.T) {
	local := testConfig()
	local.Edition, local.UserCredentials, local.CredentialKey = editionLocal, true, bytes.Repeat([]byte{1}, 32)
	for origin, ok := range map[string]bool{"": true, "https://awwo.example": true, "https://awwo.example/": true, "http://127.0.0.1:8187": true, "http://localhost:9": true,
		"http://awwo.example": false, "https://awwo.example/path": false, "https://u:p@awwo.example": false, "ftp://awwo.example": false, "https://awwo.example?x=1": false, "nonsense": false,
		"HTTPS://awwo.example": false, "http://[::1]:8187": true, "https://[2001:db8::1]:8443": true, "http://[2001:db8::1]": false,
		"https://relay_test.example": true, "https://bücher.example": true, "https://awwo.example:99999": false, "https://awwo.example?": false, "https://awwo.example#": false, "https://": false} {
		c := local
		c.LocalCloudOrigin = origin
		if (c.Validate() == nil) != ok {
			t.Error("cloud origin", origin, c.Validate())
		}
	}
	hosted := testConfig()
	hosted.LocalCloudOrigin = "https://awwo.example"
	if hosted.Validate() == nil {
		t.Fatal("a hosted site with a cloud origin")
	}
	if local.cloudOrigin() != defaultCloudOrigin {
		t.Fatal("the default", local.cloudOrigin())
	}
	local.LocalCloudOrigin = "https://awwo.example/"
	if local.cloudOrigin() != "https://awwo.example" || New(nil, local).cloudProvider().BaseURL != "https://awwo.example/api/v1/relay/v1" {
		t.Fatal("the relay's base", New(nil, local).cloudProvider())
	}
	t.Setenv("AWWO_LOCAL_CLOUD_ORIGIN", "https://other.example")
	var c Config
	if e := c.editionFromEnv(); e != nil || c.LocalCloudOrigin != "https://other.example" {
		t.Fatal("read from the environment", c.LocalCloudOrigin, e)
	}
}

func TestCloudBudgetLeavesRoomForWhatAWorkerAdds(t *testing.T) {
	if got := cloudBudget(cloudModel{ContextWindow: 200000, MaxOutputTokens: 32000}); got != 167744-16774 {
		t.Fatal("a tenth of a large window", got)
	}
	if got := cloudBudget(cloudModel{ContextWindow: 32768, MaxOutputTokens: 4096}); got != 28416-4096 {
		t.Fatal("at least 4,096 tokens", got)
	}
	// Within the relay's request size: at a rate of 3.4, 504 KiB less 64 KiB hold 88,345 tokens with half again for escapes.
	if got := cloudBudget(cloudModel{ContextWindow: 200000, MaxOutputTokens: 32000, ProseBytesPerToken: 3.4, MaxRequestBytes: relayBodyLimit}); got != opusBudget {
		t.Fatal("held by the request size", got)
	}
	if got := cloudBudget(cloudModel{ContextWindow: 128000, MaxOutputTokens: 16000, ProseBytesPerToken: 1, MaxRequestBytes: relayBodyLimit}); got != glmBudget {
		t.Fatal("held by the window", got)
	}
}

// fakeCloud is the hosted AwwO's relay as an AwwO 云端 connection reads it: its /models for one key, and what it reads.
type fakeCloud struct {
	*httptest.Server
	reads  atomic.Int32
	status atomic.Int32
	empty  atomic.Bool
	delay  atomic.Int64 // how long it holds each answer
	// delayFirst is how long it holds the next answer alone.
	delayFirst atomic.Int64
}

const cloudKey = "awwo_rk_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"

func newFakeCloud(t *testing.T) *fakeCloud {
	f := &fakeCloud{}
	f.status.Store(200)
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/relay/v1/models" || r.Method != "GET" {
			t.Errorf("unexpected cloud call %s %s", r.Method, r.URL.Path)
		}
		f.reads.Add(1)
		// Its answer is as it stood when the request came, however late it is sent.
		status, empty := int(f.status.Load()), f.empty.Load()
		time.Sleep(time.Duration(f.delay.Load() + f.delayFirst.Swap(0)))
		if r.Header.Get("Authorization") != "Bearer "+cloudKey {
			w.WriteHeader(401)
			io.WriteString(w, `{"error":{"code":"relay_key_invalid"}}`)
			return
		}
		if status != 200 {
			w.WriteHeader(status)
			return
		}
		if empty {
			io.WriteString(w, `{"object":"list","data":[]}`)
			return
		}
		io.WriteString(w, `{"object":"list","data":[
			{"id":"bedrock.claude-opus-5-5","context_window":200000,"max_output_tokens":32000,"prose_bytes_per_token":3.4,"reasoning_efforts":[]},
			{"id":"bedrock.glm-5","context_window":128000,"max_output_tokens":16000,"prose_bytes_per_token":1},
			{"id":"tiny","context_window":1000,"max_output_tokens":10}]}`)
	}))
	t.Cleanup(f.Close)
	return f
}

// localCloudHarness is a local edition whose AwwO 云端 connections run on a fake hosted AwwO, with its owner.
func localCloudHarness(t *testing.T) (*harness, *fakeCloud, *http.Cookie, string, string) {
	t.Helper()
	cloud := newFakeCloud(t)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.Edition, h.a.cfg.UserCredentials, h.a.cfg.CredentialKey, h.a.cfg.LocalCloudOrigin = editionLocal, true, bytes.Repeat([]byte{3}, 32), cloud.URL
	owner, tid, uid := h.register(t, "cloud-"+strings.ToLower(randomID()[:8])+"@example.test")
	return h, cloud, owner, tid, uid
}

// settleCloudReads waits for the hosted models' reads under way in the background (refreshCloudModels) to end.
func settleCloudReads(t *testing.T, a *App) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		a.cloudModelCache.mu.Lock()
		reading := len(a.cloudModelCache.reading)
		a.cloudModelCache.mu.Unlock()
		if reading == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("hosted models still being read")
		}
	}
}

// The hosted limits the fake cloud's two models run within, as cloudBudget makes them: Opus's held by the relay's
// request size at its rate of 3.4 (the fake names none: the relay's own, 504 KiB), GLM's by its window.
const opusBudget, glmBudget = 88345, 100570

func TestPostgresCloudConnectionRunsOnTheHostedModelsAndTheirLimits(t *testing.T) {
	h, cloud, owner, tid, uid := localCloudHarness(t)
	list := h.request(t, owner, "GET", "/auth/connections", nil, 200)
	first := list["providers"].([]any)[0].(map[string]any)
	if first["id"] != cloudProviderID || len(first["runtimes"].([]any)) != 2 {
		t.Fatal("AwwO 云端 first", first)
	}
	if list["cloudKeysURL"] != cloud.URL+"/?account=relay" {
		t.Fatal("where its key is made", list["cloudKeysURL"])
	}
	h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": "not-a-connection-key"}, 400)
	made := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": cloudKey}, 201)
	models := made["models"].([]any)
	if len(models) != 2 || models[0] != "bedrock.claude-opus-5-5" || models[1] != "bedrock.glm-5" || made["name"] != "AwwO 云端 · AwwO Cloud" {
		t.Fatal("the hosted models, in the hosted order, those whose limits hold", made)
	}
	id := made["id"].(string)
	ctx := context.WithValue(context.Background(), userKey{}, User{ID: uid})
	catalog, e := h.a.personalRuntime(ctx, runtimePI, false)
	if e != nil || len(catalog.Models) != 2 {
		t.Fatal(catalog, e)
	}
	opus, glm := catalog.Models[0], catalog.Models[1]
	if opus.Provider != cloudProviderID || opus.Protocol != "chat_completions" || opus.MaxContextTextBytes != opusBudget || opus.ProseBytesPerToken != 3.4 ||
		opus.MaxOutputTokens != 32000 || glm.MaxContextTextBytes != glmBudget || glm.ProseBytesPerToken != 1 {
		t.Fatal("a hosted model's limits", opus, glm)
	}
	// The default model (the first) runs within its own limits, as any other does.
	if budget, _, ok := catalog.modelLimits(""); !ok || budget != opusBudget || catalog.modelRate("") != 3.4 {
		t.Fatal("the default model's limits", budget, ok, catalog.modelRate(""))
	}
	if budget, _, _ := catalog.modelLimits(glm.ID); budget != glmBudget || catalog.modelRate(glm.ID) != proseRateMin {
		t.Fatal("another model's limits", budget, catalog.modelRate(glm.ID))
	}
	if reads := cloud.reads.Load(); reads != 1 {
		t.Fatal("the limits read when the connection was saved are used", reads)
	}
	// What the worker is given: the relay's base, the key, the hosted limits and rate.
	_, _, session := h.fixture(t, owner, tid)
	run := randomID()
	execSQL(t, h, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,actor_id) VALUES($1,$2,$3,$1,'h','p','running',$4)", run, tid, session, uid)
	raw, _ := json.Marshal(map[string]any{"runId": run, "tenantId": tid, "sessionId": session, "model": opus.ID})
	admitted, e := h.a.personalAdmission(context.Background(), runtimePI, raw)
	if e != nil {
		t.Fatal(e)
	}
	var body struct {
		UserModel map[string]any `json:"userModel"`
	}
	json.Unmarshal(admitted, &body)
	m := body.UserModel
	if m["baseURL"] != cloud.URL+"/api/v1/relay/v1" || m["apiKey"] != cloudKey || m["provider"] != cloudProviderID || m["protocol"] != "chat_completions" ||
		m["contextWindow"] != 200000.0 || m["maxTokens"] != 32000.0 || m["proseBytesPerToken"] != 3.4 || m["model"] != "bedrock.claude-opus-5-5" {
		t.Fatal("the bound model", m)
	}
	// Not known (a restart): a catalog never waits for the hosted site, which a run's creation reads under its workspace's
	// lock. It offers the connection's models once the read it began in the background has them; a call being sent waits.
	h.a.cloudModelCache.entries = nil
	if _, e = h.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("models offered before their limits are known")
	}
	settleCloudReads(t, h.a)
	if catalog, e = h.a.personalRuntime(ctx, runtimePI, false); e != nil || len(catalog.Models) != 2 || cloud.reads.Load() != 2 {
		t.Fatal("read in the background", catalog, e, cloud.reads.Load())
	}
	h.a.cloudModelCache.entries = nil
	if _, e = h.a.personalAdmission(context.Background(), runtimePI, raw); e != nil || cloud.reads.Load() != 3 {
		t.Fatal("a call waits for its model's limits", e, cloud.reads.Load())
	}
	h.a.cloudModelCache.entries = nil
	cloud.status.Store(503)
	h.a.personalRuntime(ctx, runtimePI, false)
	settleCloudReads(t, h.a)
	if _, e = h.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("a connection whose limits cannot be read offers no model")
	}
	if _, e = h.a.personalAdmission(context.Background(), runtimePI, raw); e == nil || cloud.reads.Load() != 4 {
		t.Fatal("admitted without its limits, or read again within the minute", e, cloud.reads.Load())
	}
	cloud.status.Store(200)
	h.request(t, owner, "POST", "/auth/connections/"+id+"/refresh", nil, 200)
	// Old, they are taken as they were while being read again, and kept while the hosted site is out of reach, read again
	// a minute later; a catalog read never waits for them, even on a site that holds its answer.
	aged := func() {
		h.a.cloudModelCache.entries[id] = cloudModelEntry{at: time.Now().Add(-cloudModelsTTL), models: h.a.cloudModelCache.entries[id].models}
	}
	aged()
	cloud.status.Store(503)
	cloud.delay.Store(int64(time.Second))
	reads := cloud.reads.Load()
	started := time.Now()
	if catalog, e = h.a.personalRuntime(ctx, runtimePI, false); e != nil || len(catalog.Models) != 2 || time.Since(started) > 500*time.Millisecond {
		t.Fatal("old limits, while they are read again", e, time.Since(started))
	}
	settleCloudReads(t, h.a)
	cloud.delay.Store(0)
	if catalog, e = h.a.personalRuntime(ctx, runtimePI, false); e != nil || len(catalog.Models) != 2 || cloud.reads.Load() != reads+1 {
		t.Fatal("the last limits kept while out of reach, read again only a minute later", e, cloud.reads.Load())
	}
	// A key the hosted site no longer takes offers no model, once it has said so.
	aged()
	cloud.status.Store(401)
	h.a.personalRuntime(ctx, runtimePI, false)
	settleCloudReads(t, h.a)
	if _, e = h.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("a key the hosted site no longer takes")
	}
	// So does a refresh it refuses, at once; one it answers offers them again.
	cloud.status.Store(200)
	h.request(t, owner, "POST", "/auth/connections/"+id+"/refresh", nil, 200)
	cloud.status.Store(403)
	if body := h.request(t, owner, "POST", "/auth/connections/"+id+"/refresh", nil, 422); !strings.Contains(asJSON(t, body), "cloud_key_rejected") {
		t.Fatal("a refresh the hosted site refuses", body)
	}
	if _, e = h.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("the models of a key just refused")
	}
	cloud.status.Store(200)
	h.request(t, owner, "POST", "/auth/connections/"+id+"/refresh", nil, 200)
	if catalog, e = h.a.personalRuntime(ctx, runtimePI, false); e != nil || len(catalog.Models) != 2 {
		t.Fatal("refreshed", e)
	}
	h.request(t, owner, "DELETE", "/auth/connections/"+id, nil, 204)
	if _, kept := h.a.cloudModelCache.entries[id]; kept {
		t.Fatal("a deleted connection's limits are forgotten")
	}
}

func TestPostgresCloudConnectionsAreReadWhenTheLocalEditionStarts(t *testing.T) {
	h, cloud, owner, _, uid := localCloudHarness(t)
	id := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": cloudKey}, 201)["id"].(string)
	h.a.cloudModelCache.entries = nil
	if e := h.a.warmCloudModels(context.Background()); e != nil {
		t.Fatal(e)
	}
	settleCloudReads(t, h.a)
	entry, ok := h.a.cloudEntry(id)
	if !ok || len(entry.models) != 2 || cloud.reads.Load() != 2 {
		t.Fatal("read at start", entry, cloud.reads.Load())
	}
	ctx := context.WithValue(context.Background(), userKey{}, User{ID: uid})
	if catalog, e := h.a.personalRuntime(ctx, runtimePI, false); e != nil || len(catalog.Models) != 2 || cloud.reads.Load() != 2 {
		t.Fatal("the first catalog after a start", e)
	}
	// One read at a time for each connection, and none once the API is closing.
	h.a.cloudModelCache.entries = nil
	cloud.delay.Store(int64(300 * time.Millisecond))
	for i := 0; i < 3; i++ {
		h.a.personalRuntime(ctx, runtimePI, false)
	}
	settleCloudReads(t, h.a)
	if cloud.reads.Load() != 3 {
		t.Fatal("one read at a time", cloud.reads.Load())
	}
	h.a.mu.Lock()
	h.a.closed = true
	h.a.mu.Unlock()
	h.a.cloudModelCache.entries = nil
	h.a.personalRuntime(ctx, runtimePI, false)
	settleCloudReads(t, h.a)
	h.a.mu.Lock()
	h.a.closed = false
	h.a.mu.Unlock()
	if cloud.reads.Load() != 3 {
		t.Fatal("read while closing", cloud.reads.Load())
	}
	// The hosted site has none to read.
	h.a.cfg.Edition = ""
	if e := h.a.warmCloudModels(context.Background()); e != nil || cloud.reads.Load() != 3 {
		t.Fatal("read on the hosted site", e)
	}
}

func TestPostgresAnOlderReadNeverOverwritesWhatWasLearntSince(t *testing.T) {
	h, cloud, owner, _, uid := localCloudHarness(t)
	id := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": cloudKey}, 201)["id"].(string)
	ctx := context.WithValue(context.Background(), userKey{}, User{ID: uid})
	lateRead := func() {
		h.a.cloudModelCache.mu.Lock()
		entry := h.a.cloudModelCache.entries[id]
		entry.at = time.Now().Add(-cloudModelsTTL)
		h.a.cloudModelCache.entries[id] = entry
		h.a.cloudModelCache.mu.Unlock()
		cloud.delayFirst.Store(int64(500 * time.Millisecond))
		reads := cloud.reads.Load()
		h.a.personalRuntime(ctx, runtimePI, false)
		for cloud.reads.Load() == reads {
			time.Sleep(time.Millisecond)
		}
	}
	// A read in the background that the hosted site answered with the models, sent after a refresh it refused: the
	// refusal stands.
	lateRead()
	cloud.status.Store(401)
	h.request(t, owner, "POST", "/auth/connections/"+id+"/refresh", nil, 422)
	settleCloudReads(t, h.a)
	if _, e := h.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("an older read put back the models of a key refused since")
	}
	// Nor does one put back a deleted connection's.
	cloud.status.Store(200)
	h.request(t, owner, "POST", "/auth/connections/"+id+"/refresh", nil, 200)
	lateRead()
	h.request(t, owner, "DELETE", "/auth/connections/"+id, nil, 204)
	settleCloudReads(t, h.a)
	if _, kept := h.a.cloudEntry(id); kept {
		t.Fatal("a deleted connection's models put back")
	}
}

func TestPostgresCloudConnectionSaysWhyItCannotBeSaved(t *testing.T) {
	h, cloud, owner, _, _ := localCloudHarness(t)
	other := "awwo_rk_" + strings.Repeat("z", 43)
	if body := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": other}, 422); !strings.Contains(asJSON(t, body), "cloud_key_rejected") {
		t.Fatal("a key the hosted site does not take", body)
	}
	cloud.empty.Store(true)
	if body := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": cloudKey}, 422); !strings.Contains(asJSON(t, body), "cloud_no_models") {
		t.Fatal("a key whose workspace runs no model", body)
	}
	cloud.Close()
	if body := h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": cloudKey}, 503); !strings.Contains(asJSON(t, body), "cloud_unavailable") {
		t.Fatal("the hosted site out of reach", body)
	}
	// The hosted site has no such connection.
	h.a.cfg.Edition = ""
	list := h.request(t, owner, "GET", "/auth/connections", nil, 200)
	if strings.Contains(asJSON(t, list["providers"]), `"awwo"`) || list["cloudKeysURL"] != nil {
		t.Fatal("offered on the hosted site", list["providers"], list["cloudKeysURL"])
	}
	h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": cloudKey}, 400)
}
