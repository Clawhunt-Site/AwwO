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
		"HTTPS://awwo.example": false, "http://[::1]:8187": true} {
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
}

// fakeCloud is the hosted AwwO's relay as an AwwO 云端 connection reads it: its /models for one key, and what it reads.
type fakeCloud struct {
	*httptest.Server
	reads  atomic.Int32
	status atomic.Int32
	empty  atomic.Bool
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
		if r.Header.Get("Authorization") != "Bearer "+cloudKey {
			w.WriteHeader(401)
			io.WriteString(w, `{"error":{"code":"relay_key_invalid"}}`)
			return
		}
		if status := int(f.status.Load()); status != 200 {
			w.WriteHeader(status)
			return
		}
		if f.empty.Load() {
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

func TestPostgresCloudConnectionRunsOnTheHostedModelsAndTheirLimits(t *testing.T) {
	h, cloud, owner, tid, uid := localCloudHarness(t)
	list := h.request(t, owner, "GET", "/auth/connections", nil, 200)
	first := list["providers"].([]any)[0].(map[string]any)
	if first["id"] != cloudProviderID || len(first["runtimes"].([]any)) != 2 {
		t.Fatal("AwwO 云端 first", first)
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
	opus := catalog.Models[0]
	if opus.Provider != cloudProviderID || opus.Protocol != "chat_completions" || opus.MaxContextTextBytes != 150970 || opus.ProseBytesPerToken != 3.4 || opus.MaxOutputTokens != 32000 {
		t.Fatal("a hosted model's limits", opus)
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
	// Read again once they are old; a key the hosted site no longer takes offers no model.
	h.a.cloudModelCache.entries = nil
	if catalog, e = h.a.personalRuntime(ctx, runtimePI, false); e != nil || len(catalog.Models) != 2 || cloud.reads.Load() != 2 {
		t.Fatal("read again", catalog, e, cloud.reads.Load())
	}
	h.a.cloudModelCache.entries = nil
	cloud.status.Store(503)
	if _, e = h.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("a connection whose limits cannot be read offers no model")
	}
	if _, e = h.a.personalAdmission(context.Background(), runtimePI, raw); e == nil {
		t.Fatal("admitted without its limits")
	}
	cloud.status.Store(200)
	h.request(t, owner, "POST", "/auth/connections/"+id+"/refresh", nil, 200)
	// Out of reach once its limits are old, the hosted site's models keep the limits last read, read again a minute
	// later; a key it no longer takes offers no model.
	aged := func() {
		h.a.cloudModelCache.entries[id] = cloudModelEntry{at: time.Now().Add(-cloudModelsTTL), models: h.a.cloudModelCache.entries[id].models}
	}
	aged()
	cloud.status.Store(503)
	reads := cloud.reads.Load()
	for i := 0; i < 2; i++ {
		if catalog, e = h.a.personalRuntime(ctx, runtimePI, false); e != nil || len(catalog.Models) != 2 || cloud.reads.Load() != reads+1 {
			t.Fatal("the last limits kept while out of reach, read again only a minute later", i, e, cloud.reads.Load())
		}
	}
	aged()
	cloud.status.Store(401)
	if _, e = h.a.personalRuntime(ctx, runtimePI, false); e == nil {
		t.Fatal("a key the hosted site no longer takes")
	}
	cloud.status.Store(200)
	h.request(t, owner, "DELETE", "/auth/connections/"+id, nil, 204)
	if _, kept := h.a.cloudModelCache.entries[id]; kept {
		t.Fatal("a deleted connection's limits are forgotten")
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
	if strings.Contains(asJSON(t, list["providers"]), `"awwo"`) {
		t.Fatal("offered on the hosted site", list["providers"])
	}
	h.request(t, owner, "POST", "/auth/connections", map[string]any{"provider": "awwo", "runtime": runtimePI, "apiKey": cloudKey}, 400)
}
