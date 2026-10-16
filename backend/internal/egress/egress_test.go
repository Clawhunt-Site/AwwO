package egress

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"
)

var secret = []byte(strings.Repeat("k", 32))

func serve(t *testing.T, p *Proxy) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(p)
	t.Cleanup(server.Close)
	return server
}

// loopbackProxy reaches the test's own loopback servers on the given ports, as the real proxy reaches public ones.
func loopbackProxy(limits Limits, ports ...string) *Proxy {
	return &Proxy{Secret: secret, Limits: limits, AllowAddress: func(a netip.Addr) bool { return a.IsLoopback() },
		AllowPort: func(port string) bool {
			for _, allowed := range ports {
				if port == allowed {
					return true
				}
			}
			return false
		}}
}

func auth(run, token string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(run+":"+token))
}

func runAuth(run string) string { return auth(run, Token(secret, run)) }

// connect opens a CONNECT tunnel through the proxy and returns the status line and the tunnel.
func connect(t *testing.T, proxy *httptest.Server, target, credentials string) (string, net.Conn) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\n\r\n", target, target, credentials)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil || line == "\r\n" {
			break
		}
	}
	_ = conn.SetReadDeadline(time.Time{})
	return strings.TrimSpace(status), conn
}

func echoServer(t *testing.T) net.Listener {
	t.Helper()
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { echo.Close() })
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	return echo
}

func TestTokensAreDerivedPerRun(t *testing.T) {
	if Token(secret, "run-a") == Token(secret, "run-b") || Token(secret, "run-a") != Token(secret, "run-a") || len(Token(secret, "x")) != 40 {
		t.Fatal("token derivation")
	}
	if Token(secret, "run-a") == Token([]byte(strings.Repeat("j", 32)), "run-a") {
		t.Fatal("the token does not depend on the secret")
	}
	// The workers derive the same value (apps/openai-agents-worker/workspace-sandbox.test.ts).
	if got := Token(secret, "run-a"); got != "1f365883b108aae59ff783c5a2a257416f01a467" {
		t.Fatal("token vector", got)
	}
}

func TestOnlyAuthenticatedRunsReachPublicAddressesOnWebPorts(t *testing.T) {
	server := serve(t, &Proxy{Secret: secret, Limits: DefaultLimits})
	for name, credentials := range map[string]string{"no credentials": "", "wrong token": auth("run-1", "nope"), "another run's token": auth("run-1", Token(secret, "run-2")), "not basic": "Bearer " + Token(secret, "run-1")} {
		status, conn := connect(t, server, "1.1.1.1:443", credentials)
		conn.Close()
		if !strings.Contains(status, "407") {
			t.Errorf("%s: %s", name, status)
		}
	}
	for _, target := range []string{"1.1.1.1:22", "1.1.1.1:5432", "example.test:8080", "1.1.1.1:0"} {
		status, conn := connect(t, server, target, runAuth("run-1"))
		conn.Close()
		if !strings.Contains(status, "403") {
			t.Errorf("%s: %s", target, status)
		}
	}
	// Loopback, private, link-local (the cloud's metadata) and IPv4-in-IPv6 forms of them are never reached.
	for _, target := range []string{"127.0.0.1:443", "169.254.169.254:80", "10.0.0.1:443", "[::1]:443", "192.168.1.1:80", "[::ffff:127.0.0.1]:443", "100.100.100.200:80", "0.0.0.0:443"} {
		status, conn := connect(t, server, target, runAuth("run-1"))
		conn.Close()
		if !strings.Contains(status, "502") {
			t.Errorf("%s: %s", target, status)
		}
	}
}

func TestPlainRequestsAreHTTPOnPort80(t *testing.T) {
	p := &Proxy{Secret: secret, Limits: DefaultLimits}
	for _, c := range []struct {
		tunnel       bool
		scheme, port string
		want         bool
	}{{true, "", "443", true}, {true, "", "80", true}, {false, "http", "80", true}, {false, "https", "443", false}, {false, "http", "443", false}, {false, "", "80", false}, {true, "", "8443", false}} {
		if got := p.portAllowed(c.tunnel, c.scheme, c.port); got != c.want {
			t.Errorf("%+v: %v", c, got)
		}
	}
}

func TestTunnelCountsBytesAndStopsAtTheRunAllowance(t *testing.T) {
	echo := echoServer(t)
	_, port, _ := net.SplitHostPort(echo.Addr().String())
	limits := DefaultLimits
	limits.RunBytes = 64
	server := serve(t, loopbackProxy(limits, port))
	status, conn := connect(t, server, echo.Addr().String(), runAuth("run-1"))
	defer conn.Close()
	if !strings.Contains(status, "200") {
		t.Fatal(status)
	}
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 5)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, reply); err != nil || string(reply) != "hello" {
		t.Fatal("echo through the tunnel", string(reply), err)
	}
	// 64 bytes in all: a large write exhausts the allowance and the tunnel closes without passing it on.
	_, _ = conn.Write([]byte(strings.Repeat("x", 200)))
	got, _ := io.ReadAll(conn)
	if len(got) >= 200 {
		t.Fatal("the run moved more than its allowance", len(got))
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, again := connect(t, server, echo.Addr().String(), runAuth("run-1"))
		again.Close()
		if strings.Contains(status, "429") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a run past its allowance opened another tunnel", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
	status, other := connect(t, server, echo.Addr().String(), runAuth("run-2"))
	other.Close()
	if !strings.Contains(status, "200") {
		t.Fatal("another run was held to the first run's allowance", status)
	}
}

func TestARunHoldsOnlyItsShareOfConnections(t *testing.T) {
	echo := echoServer(t)
	_, port, _ := net.SplitHostPort(echo.Addr().String())
	limits := DefaultLimits
	limits.RunConcurrent, limits.RunConns = 2, 3
	server := serve(t, loopbackProxy(limits, port))
	var open []net.Conn
	defer func() {
		for _, conn := range open {
			conn.Close()
		}
	}()
	for i := 0; i < 2; i++ {
		status, conn := connect(t, server, echo.Addr().String(), runAuth("run-1"))
		open = append(open, conn)
		if !strings.Contains(status, "200") {
			t.Fatal(i, status)
		}
	}
	status, conn := connect(t, server, echo.Addr().String(), runAuth("run-1"))
	conn.Close()
	if !strings.Contains(status, "429") {
		t.Fatal("a third connection at once", status)
	}
	open[0].Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, conn := connect(t, server, echo.Addr().String(), runAuth("run-1"))
		open = append(open, conn)
		if strings.Contains(status, "200") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a closed connection was never released", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Three connections opened in all: a fourth is refused even with room at once.
	open[1].Close()
	time.Sleep(100 * time.Millisecond)
	status, conn = connect(t, server, echo.Addr().String(), runAuth("run-1"))
	conn.Close()
	if !strings.Contains(status, "429") {
		t.Fatal("a fourth connection in all", status)
	}
}

func TestPlainHTTPIsForwardedWithoutTheProxyCredentials(t *testing.T) {
	seen := make(chan http.Header, 1)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		fmt.Fprint(w, "page "+r.URL.RequestURI())
	}))
	defer origin.Close()
	u, _ := url.Parse(origin.URL)
	server := serve(t, loopbackProxy(DefaultLimits, u.Port()))
	proxyURL, _ := url.Parse(server.URL)
	proxyURL.User = url.UserPassword("run-1", Token(secret, "run-1"))
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 5 * time.Second}
	response, err := client.Get(origin.URL + "/x?y=1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	headers := <-seen
	if response.StatusCode != 200 || string(body) != "page /x?y=1" || headers.Get("Proxy-Authorization") != "" {
		t.Fatalf("status %d, body %q, forwarded credentials %q", response.StatusCode, body, headers.Get("Proxy-Authorization"))
	}
	proxyURL.User = url.UserPassword("run-1", "wrong")
	client = &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 5 * time.Second}
	if response, err = client.Get(origin.URL + "/x"); err != nil || response.StatusCode != http.StatusProxyAuthRequired {
		t.Fatal("an unauthenticated plain request", response, err)
	}
	response.Body.Close()
}

func TestPlainHTTPCountsRequestsAndResponsesAgainstTheAllowance(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write(bytes.Repeat([]byte("x"), 200<<10))
	}))
	defer origin.Close()
	u, _ := url.Parse(origin.URL)
	limits := DefaultLimits
	limits.RunBytes = 64 << 10
	server := serve(t, loopbackProxy(limits, u.Port()))
	client := func(run string) *http.Client {
		proxyURL, _ := url.Parse(server.URL)
		proxyURL.User = url.UserPassword(run, Token(secret, run))
		return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 5 * time.Second}
	}
	if response, err := client("run-1").Get(origin.URL); err == nil {
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if len(body) >= 200<<10 {
			t.Fatal("a response larger than the allowance passed whole")
		}
	}
	response, err := client("run-1").Get(origin.URL)
	if err != nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatal("a run past its allowance was served", response, err)
	}
	response.Body.Close()
	// An upload counts too: 100 KiB of body cannot leave on a 64 KiB allowance.
	if response, err = client("run-2").Post(origin.URL, "application/octet-stream", bytes.NewReader(bytes.Repeat([]byte("y"), 100<<10))); err == nil {
		status := response.StatusCode
		response.Body.Close()
		if status == http.StatusOK {
			t.Fatal("an upload larger than the allowance went through")
		}
	}
}

func TestRefusalsSayWhyWithoutReachingAnything(t *testing.T) {
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(closed.Addr().String())
	closed.Close()
	server := serve(t, loopbackProxy(DefaultLimits, port))
	proxyURL, _ := url.Parse(server.URL)
	proxyURL.User = url.UserPassword("run-1", Token(secret, "run-1"))
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 15 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "did not answer") {
		t.Fatal(response.StatusCode, string(body))
	}
	// A name that does not resolve (a resolver that answers nothing, so the local DNS cannot interfere).
	offline := loopbackProxy(DefaultLimits, port)
	offline.Resolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("no DNS in this test") }}
	proxyURL, _ = url.Parse(serve(t, offline).URL)
	proxyURL.User = url.UserPassword("run-1", Token(secret, "run-1"))
	client = &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 15 * time.Second}
	response, err = client.Get("http://awwo-egress-test.example:" + port + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "could not be resolved") {
		t.Fatal(response.StatusCode, string(body))
	}
}

func TestParseDeny(t *testing.T) {
	deny, err := ParseDeny("152.32.145.74, 10.40.0.0/16 ,")
	if err != nil || len(deny) != 2 || !deny[0].Contains(netip.MustParseAddr("152.32.145.74")) || !deny[1].Contains(netip.MustParseAddr("10.40.186.146")) {
		t.Fatal(deny, err)
	}
	if _, err = ParseDeny("not-an-address"); err == nil {
		t.Fatal("accepted garbage")
	}
	p := &Proxy{Deny: deny}
	if p.allowed(netip.MustParseAddr("152.32.145.74")) || p.allowed(netip.MustParseAddr("::ffff:152.32.145.74")) || !p.allowed(netip.MustParseAddr("1.1.1.1")) {
		t.Fatal("deny list not applied")
	}
}
