package app

import (
	"context"
	"encoding/json"
	"testing"
)

func TestPostgresAppearance(t *testing.T) {
	h := newHarness(t, "")
	owner, _, uid := h.register(t, "appearance-owner@example.test")
	other, _, _ := h.register(t, "appearance-other@example.test")
	state := h.request(t, owner, "GET", "/appearance", nil, 200)
	if state["version"] != float64(0) || state["active_preset"] != "default" || len(state["presets"].([]any)) != 11 || len(state["tokens"].([]any)) != 10 {
		t.Fatal("incomplete original appearance catalog", state)
	}
	body := map[string]any{"version": 0, "active_preset": "custom", "custom": map[string]any{"light": map[string]string{"accent": "#AbC"}, "dark": map[string]string{}}}
	saved := h.request(t, owner, "PUT", "/appearance", body, 200)
	if saved["version"] != float64(1) || saved["custom"].(map[string]any)["light"].(map[string]any)["accent"] != "#aabbcc" {
		t.Fatal(saved)
	}
	requireCode(t, h.request(t, owner, "PUT", "/appearance", body, 409), "version_conflict")
	if h.request(t, other, "GET", "/appearance", nil, 200)["version"] != float64(0) {
		t.Fatal("cross-user appearance leak")
	}
	exported := h.request(t, owner, "GET", "/appearance/export", nil, 200)
	if exported["kind"] != "superclaw.appearance" || exported["schema_version"] != "0.1.0" || len(exported) != 4 {
		t.Fatal("invalid or excessive export", exported)
	}
	// A new app instance reads PostgreSQL, with no dependency on browser caches.
	stored, err := New(h.db, h.a.cfg).readAppearance(context.Background(), uid)
	if err != nil || stored.Version != 1 || stored.Custom["light"]["accent"] != "#aabbcc" {
		t.Fatal(stored, err)
	}
	for _, invalid := range []string{
		`{"active_preset":"default","custom":{"light":{},"dark":{}}}`,
		`{"version":1,"active_preset":"unknown","custom":{"light":{},"dark":{}}}`,
		`{"version":1,"active_preset":"custom","custom":{"light":{"accent":"url(https://invalid.test)"},"dark":{}}}`,
		`{"version":1,"active_preset":"custom","custom":{"light":{"arbitrary":"#fff"},"dark":{}}}`,
		`{"version":1,"active_preset":"custom","custom":{"light":{}}}`,
		`{"version":1,"active_preset":"custom","custom":{"light":{},"dark":{},"other":{}}}`,
		`{"version":-1,"active_preset":"default","custom":{"light":{},"dark":{}}}`,
		`{"version":1,"active_preset":"default","custom":{"light":{},"dark":{}},"user_id":"other"}`,
	} {
		var b map[string]any
		if err := json.Unmarshal([]byte(invalid), &b); err != nil {
			t.Fatal(err)
		}
		h.request(t, owner, "PUT", "/appearance", b, 400)
	}
	if h.request(t, owner, "GET", "/appearance", nil, 200)["version"] != float64(1) {
		t.Fatal("invalid input mutated state")
	}
	body["version"] = 1
	body["active_preset"] = "default"
	h.request(t, owner, "PUT", "/appearance", body, 200)
}
