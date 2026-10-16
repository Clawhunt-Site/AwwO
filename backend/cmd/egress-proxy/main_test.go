package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func settings(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestSettingsAreCheckedBeforeServing(t *testing.T) {
	good := strings.Repeat("s", 64)
	for name, values := range map[string]map[string]string{
		"no secret":         {},
		"short secret":      {"AWWO_EGRESS_SECRET": strings.Repeat("s", 31)},
		"control character": {"AWWO_EGRESS_SECRET": good + "\r"},
		"bad deny entry":    {"AWWO_EGRESS_SECRET": good, "AWWO_EGRESS_DENY": "nonsense"},
		"bad allowance":     {"AWWO_EGRESS_SECRET": good, "AWWO_EGRESS_RUN_MB": "0"},
		"socket name":       {"AWWO_EGRESS_SECRET": good, "AWWO_EGRESS_SOCKET": filepath.Join(t.TempDir(), "proxy.sock")},
		"relative socket":   {"AWWO_EGRESS_SECRET": good, "AWWO_EGRESS_SOCKET": "egress.sock"},
	} {
		if _, listener, _, err := setup(settings(values)); err == nil {
			listener.Close()
			t.Errorf("%s: accepted", name)
		}
	}
	proxy, listener, where, err := setup(settings(map[string]string{"AWWO_EGRESS_SECRET": good, "AWWO_EGRESS_LISTEN": "127.0.0.1:0", "AWWO_EGRESS_RUN_MB": "64", "AWWO_EGRESS_DENY": "152.32.145.74"}))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if proxy.Limits.RunBytes != 64<<20 || len(proxy.Deny) != 1 || where != "127.0.0.1:0" {
		t.Fatalf("settings %+v %s", proxy.Limits, where)
	}
	if _, defaultListener, defaultWhere, err := setup(settings(map[string]string{"AWWO_EGRESS_SECRET": good})); err == nil {
		defaultListener.Close()
		if defaultWhere != "127.0.0.1:3128" {
			t.Fatalf("TCP default %s", defaultWhere)
		}
	}
}

func TestTheSocketReplacesOnlyAStaleSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix socket file modes are a Linux matter")
	}
	dir := t.TempDir()
	socket := filepath.Join(dir, "egress.sock")
	first, _, err := listen(socket, "")
	if err != nil {
		t.Fatal(err)
	}
	first.Close() // a crashed proxy leaves its socket file behind
	if _, err = os.Lstat(socket); err != nil {
		t.Skip("this platform removes the socket on close")
	}
	second, _, err := listen(socket, "")
	if err != nil {
		t.Fatal("a stale socket was not replaced:", err)
	}
	defer second.Close()
	info, err := os.Stat(socket)
	if err != nil || info.Mode().Perm() != 0o666 {
		t.Fatalf("socket mode %v %v", info.Mode(), err)
	}
	file := filepath.Join(t.TempDir(), "egress.sock")
	if err = os.WriteFile(file, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	if listener, _, err := listen(file, ""); err == nil {
		listener.Close()
		t.Fatal("a regular file was replaced by the socket")
	}
}
