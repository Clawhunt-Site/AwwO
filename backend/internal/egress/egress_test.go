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
	"sync"
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

func runAuth(run string) string { return auth(run, Token(secret, run, time.Now())) }

func proxyClient(server *httptest.Server, run, token string) *http.Client {
	proxyURL, _ := url.Parse(server.URL)
	proxyURL.User = url.UserPassword(run, token)
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 15 * time.Second}
}

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

type recorder struct {
	mu     sync.Mutex
	events []map[string]any
}

func (r *recorder) log(event map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *recorder) reasons() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	for _, event := range r.events {
		if reason, ok := event["reason"].(string); ok {
			out = append(out, reason)
		}
	}
	return out
}

func TestTokensAreDerivedPerRunAndPeriod(t *testing.T) {
	at := time.Unix(1_800_000_000, 0)
	// The workers derive the same value (apps/openai-agents-worker/workspace-sandbox.test.ts).
	if got := Token(secret, "run-a", at); got != "8b412f26fe7dc28c6e9e94439690dcf5db39e168" {
		t.Fatal("token vector", got)
	}
	if Token(secret, "run-a", at) == Token(secret, "run-b", at) || Token(secret, "run-a", at) == Token([]byte(strings.Repeat("j", 32)), "run-a", at) {
		t.Fatal("the token does not depend on the run or the secret")
	}
	if Token(secret, "run-a", at) == Token(secret, "run-a", at.Add(TokenPeriod)) {
		t.Fatal("the token does not change with the period")
	}
	clock := at
	p := &Proxy{Secret: secret, Limits: DefaultLimits, Now: func() time.Time { return clock }}
	request := func(token string) bool {
		r := httptest.NewRequest(http.MethodConnect, "http://example.com:443", nil)
		r.Header.Set("Proxy-Authorization", auth("run-a", token))
		_, _, ok := p.authenticate(r)
		return ok
	}
	issued := Token(secret, "run-a", at)
	if !request(issued) {
		t.Fatal("a fresh password refused")
	}
	clock = at.Add(TokenPeriod)
	if !request(issued) {
		t.Fatal("a password refused in the period after the one it was made in")
	}
	clock = at.Add(2 * TokenPeriod)
	if request(issued) {
		t.Fatal("a password accepted two periods on")
	}
	for _, secret := range []string{strings.Repeat("s", 31), strings.Repeat("s", 513), strings.Repeat("s", 40) + "\r"} {
		if ValidSecret(secret) {
			t.Fatalf("secret %q accepted", secret)
		}
	}
	if !ValidSecret(strings.Repeat("s", 64)) {
		t.Fatal("a good secret refused")
	}
}

func TestOnlyAuthenticatedRunsReachPublicAddressesOnWebPorts(t *testing.T) {
	events := &recorder{}
	server := serve(t, &Proxy{Secret: secret, Limits: DefaultLimits, Log: events.log})
	for name, credentials := range map[string]string{"no credentials": "", "wrong token": auth("run-1", "nope"), "another run's token": auth("run-1", Token(secret, "run-2", time.Now())), "not basic": "Bearer " + Token(secret, "run-1", time.Now())} {
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
	// Loopback, private, link-local (the cloud's metadata), shared space, mapped and zoned forms are never reached.
	for _, target := range []string{"127.0.0.1:443", "169.254.169.254:80", "10.0.0.1:443", "[::1]:443", "192.168.1.1:80",
		"[::ffff:127.0.0.1]:443", "100.100.100.200:80", "100.80.80.80:80", "0.0.0.0:443", "[64:ff9b::a9fe:a9fe%25x]:80",
		"[2002:7f00:1::1%25eth0]:443", "[fe80::1%25eth0]:443", "[3fff::1]:443", "[5f00::1]:443"} {
		status, conn := connect(t, server, target, runAuth("run-1"))
		conn.Close()
		if !strings.Contains(status, "502") && !strings.Contains(status, "400") {
			t.Errorf("%s: %s", target, status)
		}
	}
	reasons := strings.Join(events.reasons(), ",")
	if !strings.Contains(reasons, "auth") || !strings.Contains(reasons, "port_or_scheme") || !strings.Contains(reasons, "address") {
		t.Fatal("refusals were not logged with their reasons:", reasons)
	}
}

func TestANameIsCheckedByEveryAddressItResolvesTo(t *testing.T) {
	echo := echoServer(t)
	_, port, _ := net.SplitHostPort(echo.Addr().String())
	// The name resolves to a private address first and then to the (allowed) test server: only the allowed one is dialled.
	// A name resolving only to refused addresses is refused without a connection.
	resolver := func(answer string) *net.Resolver {
		return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			return dnsServer(t, answer), nil
		}}
	}
	mixed := loopbackProxy(DefaultLimits, port)
	mixed.Resolver = resolver("10.0.0.7,127.0.0.1")
	status, conn := connect(t, serve(t, mixed), "mixed.test:"+port, runAuth("run-1"))
	conn.Close()
	if !strings.Contains(status, "200") {
		t.Fatal("the allowed address was not used:", status)
	}
	private := loopbackProxy(DefaultLimits, port)
	private.Resolver = resolver("10.0.0.7")
	status, conn = connect(t, serve(t, private), "private.test:"+port, runAuth("run-1"))
	conn.Close()
	if !strings.Contains(status, "502") {
		t.Fatal("a name resolving to a private address was reached:", status)
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
	events := &recorder{}
	p := loopbackProxy(limits, port)
	p.Log = events.log
	server := serve(t, p)
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
	if len(got) != 0 {
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
	if reasons := strings.Join(events.reasons(), ","); !strings.Contains(reasons, "run_bytes") {
		t.Fatal("the allowance refusal was not logged:", reasons)
	}
}

func TestTunnelSendsEarlyBytesFirstAndHalfClosesAndIdlesTogether(t *testing.T) {
	// A server that answers only after the client has finished sending (it reads to EOF): a half-close must not lose
	// the answer.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				body, _ := io.ReadAll(conn)
				// Trickle the answer: one byte every 30 ms, longer than the idle limit in all, never idle for it.
				for _, b := range []byte(fmt.Sprintf("got %d", len(body))) {
					_, _ = conn.Write([]byte{b})
					time.Sleep(30 * time.Millisecond)
				}
			}()
		}
	}()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	limits := DefaultLimits
	limits.IdleTimeout = 150 * time.Millisecond
	server := serve(t, loopbackProxy(limits, port))
	raw, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	early := strings.Repeat("e", 5000)
	fmt.Fprintf(raw, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\n\r\n%s", listener.Addr(), listener.Addr(), runAuth("run-1"), early)
	raw.(*net.TCPConn).CloseWrite()
	_ = raw.SetReadDeadline(time.Now().Add(10 * time.Second))
	all, _ := io.ReadAll(raw)
	if !bytes.Contains(all, []byte("200 Connection Established")) || !bytes.HasSuffix(all, []byte("got 5000")) {
		t.Fatalf("tunnel answer %q", all)
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
	busy := loopbackProxy(DefaultLimits, port)
	busy.Limits.Concurrent = 0
	status, conn = connect(t, serve(t, busy), echo.Addr().String(), runAuth("run-9"))
	conn.Close()
	if !strings.Contains(status, "429") {
		t.Fatal("the proxy-wide limit", status)
	}
}

func TestPlainHTTPIsForwardedWithoutProxyOrHopHeaders(t *testing.T) {
	// A raw origin, so the response carries exactly the connection headers written here.
	seen := make(chan http.Header, 4)
	origin, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer origin.Close()
	go func() {
		for {
			conn, err := origin.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				request, err := http.ReadRequest(bufio.NewReader(conn))
				if err != nil {
					return
				}
				body, _ := io.ReadAll(request.Body)
				seen <- request.Header.Clone()
				reply := fmt.Sprintf("page %s %d", request.URL.RequestURI(), len(body))
				fmt.Fprintf(conn, "HTTP/1.1 201 Created\r\nConnection: X-Hop\r\nX-Hop: 1\r\nKeep-Alive: timeout=5\r\nX-Kept: 1\r\nContent-Length: %d\r\n\r\n%s", len(reply), reply)
			}()
		}
	}()
	_, port, _ := net.SplitHostPort(origin.Addr().String())
	originURL := "http://" + origin.Addr().String()
	server := serve(t, loopbackProxy(DefaultLimits, port))
	client := proxyClient(server, "run-1", Token(secret, "run-1", time.Now()))
	request, _ := http.NewRequest("POST", originURL+"/x?y=1", strings.NewReader(strings.Repeat("b", 2048)))
	request.Header.Set("Expect", "100-continue")
	request.Header.Set("Connection", "X-Secret-Hop")
	request.Header.Set("X-Secret-Hop", "1")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("X-Kept", "1")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	headers := <-seen
	if response.StatusCode != http.StatusCreated || string(body) != "page /x?y=1 2048" {
		t.Fatalf("status %d, body %q", response.StatusCode, body)
	}
	for _, name := range []string{"Proxy-Authorization", "X-Secret-Hop", "Upgrade", "Expect"} {
		if headers.Get(name) != "" {
			t.Errorf("%s reached the site", name)
		}
	}
	if headers.Get("X-Kept") != "1" || response.Header.Get("X-Kept") != "1" || response.Header.Get("X-Hop") != "" || response.Header.Get("Keep-Alive") != "" {
		t.Fatalf("headers: to the site %v, back %v", headers, response.Header)
	}
	// The site sent no type, and the proxy invents none.
	if response.Header.Get("Content-Type") != "" {
		t.Fatalf("content type %q", response.Header.Get("Content-Type"))
	}
	if response, err = proxyClient(server, "run-1", "wrong").Get(originURL + "/x"); err != nil || response.StatusCode != http.StatusProxyAuthRequired {
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
	client := func(run string) *http.Client { return proxyClient(server, run, Token(secret, run, time.Now())) }
	if response, err := client("run-1").Get(origin.URL); err == nil {
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if len(body) >= 64<<10 {
			t.Fatal("a response larger than the allowance passed", len(body))
		}
	}
	response, err := client("run-1").Get(origin.URL)
	if err != nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatal("a run past its allowance was served", response, err)
	}
	response.Body.Close()
	// An upload counts too: 100 KiB of body cannot leave on a 64 KiB allowance, and the client is told why.
	response, err = client("run-2").Post(origin.URL, "application/octet-stream", bytes.NewReader(bytes.Repeat([]byte("y"), 100<<10)))
	if err != nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatal("an upload larger than the allowance", response, err)
	}
	response.Body.Close()
}

func TestRefusalsSayWhyWithoutReachingAnything(t *testing.T) {
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(closed.Addr().String())
	closed.Close()
	server := serve(t, loopbackProxy(DefaultLimits, port))
	client := proxyClient(server, "run-1", Token(secret, "run-1", time.Now()))
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
	client = proxyClient(serve(t, offline), "run-1", Token(secret, "run-1", time.Now()))
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
	deny, err := ParseDeny("203.0.113.74, 10.40.0.0/16 , ::ffff:203.0.114.7")
	if err != nil || len(deny) != 3 || !deny[0].Contains(netip.MustParseAddr("203.0.113.74")) || !deny[1].Contains(netip.MustParseAddr("10.40.186.146")) {
		t.Fatal(deny, err)
	}
	for _, bad := range []string{"not-an-address", "fe80::1%eth0", "::ffff:0.0.0.0/90"} {
		if _, err = ParseDeny(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	p := &Proxy{Deny: deny}
	for _, refused := range []string{"203.0.113.74", "::ffff:203.0.113.74", "203.0.114.7", "::ffff:203.0.114.7"} {
		if p.allowed(netip.MustParseAddr(refused)) {
			t.Errorf("%s allowed", refused)
		}
	}
	if !p.allowed(netip.MustParseAddr("1.1.1.1")) {
		t.Fatal("a public address refused")
	}
}

// dnsServer answers one A query over a pipe with the given comma-separated IPv4 addresses (and no AAAA records).
func dnsServer(t *testing.T, answers string) net.Conn {
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		for {
			var length [2]byte
			if _, err := io.ReadFull(server, length[:]); err != nil {
				return
			}
			query := make([]byte, int(length[0])<<8|int(length[1]))
			if _, err := io.ReadFull(server, query); err != nil {
				return
			}
			end := 12
			for end < len(query) && query[end] != 0 {
				end += int(query[end]) + 1
			}
			question := query[12 : end+5]
			qtype := uint16(question[len(question)-4])<<8 | uint16(question[len(question)-3])
			var records [][]byte
			if qtype == 1 {
				for _, answer := range strings.Split(answers, ",") {
					ip := netip.MustParseAddr(answer).As4()
					records = append(records, append([]byte{0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4}, ip[:]...))
				}
			}
			reply := append([]byte{query[0], query[1], 0x81, 0x80, 0, 1, 0, byte(len(records)), 0, 0, 0, 0}, question...)
			for _, record := range records {
				reply = append(reply, record...)
			}
			if _, err := server.Write(append([]byte{byte(len(reply) >> 8), byte(len(reply))}, reply...)); err != nil {
				return
			}
		}
	}()
	return client
}
