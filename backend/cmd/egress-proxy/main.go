// Command egress-proxy is the sandbox workspaces' one way to the web (internal/egress). A workspace container has no
// network interface but loopback; the workers mount this proxy's socket directory into it read-only, and a forwarder
// inside the container joins 127.0.0.1:3128 to the socket. The proxy itself runs where it has a route out.
//
//	AWWO_EGRESS_SECRET   (required, 32-512 printable bytes) shared with the workers, which derive each run's password
//	AWWO_EGRESS_SOCKET   path of the unix socket to serve, named egress.sock (its directory is what the workers mount),
//	AWWO_EGRESS_LISTEN   or a TCP address instead (default 127.0.0.1:3128 when no socket is given)
//	AWWO_EGRESS_DENY     comma-separated addresses or prefixes refused besides every non-public one (the host's own)
//	AWWO_EGRESS_RUN_MB   megabytes a run may move in and out (default 512)
package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"awwo/backend/internal/egress"
)

func main() {
	proxy, listener, where, err := setup(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	var mu sync.Mutex
	encoder := json.NewEncoder(os.Stdout)
	proxy.Log = func(event map[string]any) {
		event["at"] = time.Now().UTC().Format(time.RFC3339)
		mu.Lock()
		defer mu.Unlock()
		_ = encoder.Encode(event)
	}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: proxy.Limits.IdleTimeout, MaxHeaderBytes: 64 << 10}
	log.Printf("egress proxy serving on %s", where)
	log.Fatal(server.Serve(listener))
}

// setup reads the settings and opens the listener.
func setup(env func(string) string) (*egress.Proxy, net.Listener, string, error) {
	secret := env("AWWO_EGRESS_SECRET")
	if !egress.ValidSecret(secret) {
		return nil, nil, "", errors.New("AWWO_EGRESS_SECRET must be 32-512 printable characters, the same value the workers have")
	}
	deny, err := egress.ParseDeny(env("AWWO_EGRESS_DENY"))
	if err != nil {
		return nil, nil, "", errors.New("AWWO_EGRESS_DENY: " + err.Error())
	}
	limits := egress.DefaultLimits
	if raw := env("AWWO_EGRESS_RUN_MB"); raw != "" {
		mb, err := strconv.Atoi(raw)
		if err != nil || mb < 1 || mb > 8192 {
			return nil, nil, "", errors.New("AWWO_EGRESS_RUN_MB must be 1-8192")
		}
		limits.RunBytes = int64(mb) << 20
	}
	listener, where, err := listen(env("AWWO_EGRESS_SOCKET"), env("AWWO_EGRESS_LISTEN"))
	if err != nil {
		return nil, nil, "", err
	}
	return &egress.Proxy{Secret: []byte(secret), Limits: limits, Deny: deny}, listener, where, nil
}

// listen serves on the socket when one is named (replacing a stale socket, never another kind of file), else on TCP.
func listen(socket, address string) (net.Listener, string, error) {
	if socket == "" {
		if address == "" {
			address = "127.0.0.1:3128"
		}
		listener, err := net.Listen("tcp", address)
		return listener, address, err
	}
	// The forwarder in every workspace connects to <mounted directory>/egress.sock.
	if filepath.Base(socket) != "egress.sock" || !filepath.IsAbs(socket) {
		return nil, "", errors.New("AWWO_EGRESS_SOCKET must be an absolute path ending in /egress.sock")
	}
	if info, err := os.Lstat(socket); err == nil {
		if info.Mode().Type() != fs.ModeSocket {
			return nil, "", errors.New("AWWO_EGRESS_SOCKET names a file that is not a socket")
		}
		if err = os.Remove(socket); err != nil {
			return nil, "", err
		}
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, "", err
	}
	// Workspace commands run as uid 1000 and must be able to connect; the proxy's own checks are the boundary.
	if err = os.Chmod(socket, 0o666); err != nil {
		listener.Close()
		return nil, "", err
	}
	return listener, socket, nil
}
