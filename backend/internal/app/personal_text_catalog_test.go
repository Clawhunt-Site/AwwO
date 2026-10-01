package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPersonalDiscoveryCatalogCapacity(t *testing.T) {
	provider, _ := providerByID("llmgate")
	for _, count := range []int{64, 65, 256, 257} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			entries := []map[string]string{{"id": "text-embedding-excluded"}}
			for i := count - 1; i >= 0; i-- {
				entry := map[string]string{"id": fmt.Sprintf("chat-%03d", i)}
				entries = append(entries, entry, entry) // Duplicates do not consume capacity.
			}
			raw, _ := json.Marshal(map[string]any{"data": entries})
			a := New(nil, testConfig())
			a.client.Transport = personalTransport(func(r *http.Request) (*http.Response, error) {
				body := string(raw)
				if r.URL.Path == "/v1/user/balance" {
					body = `{"is_active":true}`
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})
			models, err := a.discoverConnectionModels(t.Context(), provider, "synthetic-personal-secret")
			if count > 256 {
				if err == nil || models != nil {
					t.Fatal("oversized catalog silently truncated or accepted")
				}
				if strings.Contains(err.Error(), "synthetic-personal-secret") {
					t.Fatal("credential exposed")
				}
				return
			}
			if err != nil || len(models) != count || models[0] != "chat-000" || models[count-1] != fmt.Sprintf("chat-%03d", count-1) {
				t.Fatal("catalog lost models or stable order", err)
			}
		})
	}
}

func TestGatePublicCatalogCannotAuthenticateInvalidKey(t *testing.T) {
	provider, _ := providerByID("llmgate")
	a := New(nil, testConfig())
	a.client.Transport = personalTransport(func(r *http.Request) (*http.Response, error) {
		status, body := 200, `{"data":[{"id":"test-chat-model"}]}`
		if r.URL.Path == "/v1/user/balance" {
			status, body = 401, `{"detail":"invalid key"}`
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	if _, err := a.discoverConnectionModels(t.Context(), provider, "synthetic-invalid-key"); err == nil {
		t.Fatal("public model catalog was mistaken for successful key authentication")
	}
}

func TestPersonalDiscoveryExcludesTranscriptionOnlyModels(t *testing.T) {
	provider, _ := providerByID("llmgate")
	for _, test := range []struct {
		name, body string
		want       string
	}{
		{"mixed", `{"data":[{"id":"doubao-asr-2.0"},{"id":"fun-asr-flash"},{"id":"qwen-audio-3.0-asr-flash-filetrans"},{"id":"qwen3-asr-flash"},{"id":"gpt-4o-transcribe"},{"id":"gpt-audio"},{"id":"qwen3.8-27b-p6"},{"id":"claude-sonnet-5"}]}`, "claude-sonnet-5,gpt-audio,qwen3.8-27b-p6"},
		{"only-transcription", `{"data":[{"id":"FUN-ASR-FLASH"},{"id":"vendor/audio_transcription"}]}`, ""},
		{"word-boundary", `{"data":[{"id":"asra-chat"},{"id":"text-assistant"}]}`, "asra-chat,text-assistant"},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := New(nil, testConfig())
			a.client.Transport = personalTransport(func(r *http.Request) (*http.Response, error) {
				body := test.body
				if r.URL.Path == "/v1/user/balance" {
					body = `{"is_active":true,"balance":0}`
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})
			models, err := a.discoverConnectionModels(t.Context(), provider, "synthetic-personal-secret")
			if test.want == "" {
				if err == nil {
					t.Fatal("transcription-only connection advertised as a text engine")
				}
				return
			}
			if err != nil || strings.Join(models, ",") != test.want {
				t.Fatal("text catalog includes an incompatible endpoint or drops a chat model", models, err)
			}
		})
	}
}

func TestPostgresSavedPersonalCatalogFiltersTranscriptionModels(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	mockPersonalDiscovery(t, h)
	owner, _, uid := h.register(t, "legacy-text-catalog@example.test")
	id := addPersonalConnection(t, h, owner)
	ctx := context.WithValue(t.Context(), userKey{}, User{ID: uid})
	for _, models := range []string{
		`["fun-asr-flash","qwen3-asr-flash","test-chat-model"]`,
		`["fun-asr-flash","qwen3-asr-flash"]`,
	} {
		if _, err := h.db.Exec(t.Context(), "UPDATE user_connections SET models=$2::jsonb WHERE id=$1", id, models); err != nil {
			t.Fatal(err)
		}
		catalog, err := h.a.personalRuntime(ctx, runtimePI, false)
		listed := h.request(t, owner, "GET", "/auth/connections", nil, 200)["items"].([]any)[0].(map[string]any)["models"].([]any)
		if strings.Contains(models, "test-chat-model") {
			if err != nil || len(catalog.Models) != 1 || catalog.Models[0].Name != "test-chat-model" || len(listed) != 1 || listed[0] != "test-chat-model" {
				t.Fatal("saved catalog still advertises transcription-only models", catalog, err)
			}
		} else {
			var unavailable setupError
			if !errors.As(err, &unavailable) || unavailable.code != "model_unavailable" || len(listed) != 0 {
				t.Fatal("existing connection with no text models must be unavailable", err)
			}
		}
	}
}

func TestGateCredentialVerificationRejectsUntrustedSuccessBodies(t *testing.T) {
	for _, body := range []string{`{}`, `{"is_active":false}`, `{"is_active":"true"}`, `{"error":"not authorized"}`, `<html>login</html>`, `{"is_active":true}` + strings.Repeat(" ", 65536)} {
		a := New(nil, testConfig())
		a.client.Transport = personalTransport(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		})
		if err := a.verifyGateCredential(t.Context(), "synthetic-personal-secret"); err == nil {
			t.Fatal("invalid account response authenticated a key")
		}
	}
}
