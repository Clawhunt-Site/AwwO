package app

import (
	"context"
	"net/http"
	"testing"
)

func requireCode(t *testing.T, v map[string]any, want string) {
	t.Helper()
	if v["error"].(map[string]any)["code"] != want {
		t.Fatalf("wanted error %s, got %v", want, v)
	}
}
func bootstrapTestAdmin(t *testing.T, h *harness) *http.Cookie {
	t.Helper()
	h.a.cfg.AdminEmail = "platform-admin@example.test"
	h.a.cfg.AdminPassword = "Strong password 123!"
	if e := h.a.BootstrapAdmin(context.Background()); e != nil {
		t.Fatal(e)
	}
	return h.login(t, h.a.cfg.AdminEmail)
}
