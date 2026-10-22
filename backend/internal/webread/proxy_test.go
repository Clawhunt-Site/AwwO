package webread

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"sync"
	"testing"
	"time"
)

// tunnelProxy is a CONNECT proxy that records the address each tunnel was asked for and carries every tunnel to one
// local test site, which records the Host each request names.
type tunnelProxy struct {
	server *httptest.Server
	site   *httptest.Server
	// refuse refuses every tunnel; refuseTo, the tunnels to these addresses.
	refuse   bool
	refuseTo map[string]bool
	mu       sync.Mutex
	tunnels  []string
	hosts    []string
}

func newTunnelProxy(t *testing.T) *tunnelProxy {
	t.Helper()
	p := &tunnelProxy{}
	p.site = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.hosts = append(p.hosts, r.Host)
		p.mu.Unlock()
		if r.URL.Path == "/robots.txt" {
			fmt.Fprint(w, "User-agent: *\nAllow: /\n")
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, "Read through the proxy on this computer, with enough words to be a page of text.")
	}))
	t.Cleanup(p.site.Close)
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "only tunnels", http.StatusMethodNotAllowed)
			return
		}
		p.mu.Lock()
		p.tunnels = append(p.tunnels, r.Host)
		p.mu.Unlock()
		if p.refuse || p.refuseTo[r.Host] {
			http.Error(w, "refused", http.StatusBadGateway)
			return
		}
		upstream, err := net.Dial("tcp", p.site.Listener.Addr().String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		client, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
		go func() { _, _ = io.Copy(upstream, buffered); upstream.Close() }()
		go func() { _, _ = io.Copy(client, upstream); client.Close() }()
	}))
	t.Cleanup(p.server.Close)
	return p
}

func (p *tunnelProxy) options(lookup func(context.Context, string) ([]netip.Addr, error)) Options {
	proxy, _ := url.Parse(p.server.URL)
	return Options{UserAgent: "AwwO-Reader/1.0 (test)", Timeout: 5 * time.Second, Robots: NewRobotsCache(time.Hour, 10), Proxy: proxy,
		AllowLoopbackForTests: true, LookupForTests: lookup}
}

func (p *tunnelProxy) seen() (tunnels, hosts []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.tunnels...), append([]string(nil), p.hosts...)
}

func resolvesTo(addresses ...string) func(context.Context, string) ([]netip.Addr, error) {
	return func(context.Context, string) ([]netip.Addr, error) {
		out := make([]netip.Addr, 0, len(addresses))
		for _, a := range addresses {
			out = append(out, netip.MustParseAddr(a))
		}
		return out, nil
	}
}

func TestFetchTunnelsThroughTheProxyToTheAddressItChecked(t *testing.T) {
	p := newTunnelProxy(t)
	result, err := Fetch(context.Background(), "http://site.example/page", p.options(resolvesTo("93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c")))
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "text" || result.FinalURL != "http://site.example/page" {
		t.Fatalf("unexpected result: %+v", result)
	}
	// The proxy is asked for the checked address, never the name; the site still hears its own name (robots.txt first).
	tunnels, hosts := p.seen()
	if len(tunnels) != 2 || tunnels[0] != "93.184.215.14:80" || tunnels[1] != "93.184.215.14:80" {
		t.Fatalf("the proxy was asked for %v", tunnels)
	}
	if len(hosts) != 2 || hosts[0] != "site.example" || hosts[1] != "site.example" {
		t.Fatalf("the site heard %v", hosts)
	}
}

func TestFetchThroughAProxyRefusesAnAddressItCannotCheck(t *testing.T) {
	cases := map[string]struct {
		lookup func(context.Context, string) ([]netip.Addr, error)
		code   string
	}{
		"private":          {resolvesTo("10.0.0.5"), "blocked_address"},
		"loopback":         {resolvesTo("127.0.0.1"), "blocked_address"},
		"link-local":       {resolvesTo("169.254.169.254"), "blocked_address"},
		"unique local":     {resolvesTo("fd00::1"), "blocked_address"},
		"mapped loopback":  {resolvesTo("::ffff:127.0.0.1"), "blocked_address"},
		"public then not":  {resolvesTo("93.184.215.14", "192.168.1.1"), "blocked_address"},
		"fake-IP":          {resolvesTo("198.18.0.7"), "blocked_address"},
		"unresolved":       {func(context.Context, string) ([]netip.Addr, error) { return nil, errors.New("no such host") }, "network_error"},
		"no answer at all": {resolvesTo(), "network_error"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p := newTunnelProxy(t)
			// Without robots.txt, which would report the same refusal of its own read as robots_unavailable.
			opt := p.options(c.lookup)
			opt.Robots = nil
			if _, err := Fetch(context.Background(), "http://site.example/page", opt); errorCode(err) != c.code {
				t.Fatalf("got %v, want %s", err, c.code)
			}
			if _, err := Fetch(context.Background(), "http://site.example/page", p.options(c.lookup)); errorCode(err) != "robots_unavailable" {
				t.Fatalf("with robots.txt: got %v", err)
			}
			if tunnels, hosts := p.seen(); len(tunnels)+len(hosts) != 0 {
				t.Fatalf("the proxy was still asked %v, the site %v", tunnels, hosts)
			}
		})
	}
}

func TestFetchReportsAProxyThatRefusesTheTunnel(t *testing.T) {
	p := newTunnelProxy(t)
	p.refuse = true
	opt := p.options(resolvesTo("93.184.215.14"))
	opt.Robots = nil
	if _, err := Fetch(context.Background(), "http://site.example/page", opt); errorCode(err) != "network_error" {
		t.Fatalf("got %v", err)
	}
	if _, hosts := p.seen(); len(hosts) != 0 {
		t.Fatalf("the site was reached: %v", hosts)
	}
}

func TestFetchTriesIPv4FirstAndTheNextAddressTheProxyCannotReach(t *testing.T) {
	p := newTunnelProxy(t)
	p.refuseTo = map[string]bool{"93.184.215.14:80": true}
	opt := p.options(resolvesTo("2606:2800:21f:cb07:6820:80da:af6b:8b2c", "93.184.215.14", "93.184.215.15"))
	opt.Robots = nil
	if _, err := Fetch(context.Background(), "http://site.example/page", opt); err != nil {
		t.Fatal(err)
	}
	if tunnels, _ := p.seen(); len(tunnels) != 2 || tunnels[0] != "93.184.215.14:80" || tunnels[1] != "93.184.215.15:80" {
		t.Fatalf("the proxy was asked for %v", tunnels)
	}
}

func TestFetchGivesUpOnAProxyThatNeverAnswers(t *testing.T) {
	defer func(previous time.Duration) { proxyExchangeTimeout = previous }(proxyExchangeTimeout)
	proxyExchangeTimeout = 200 * time.Millisecond
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	held := make(chan net.Conn, 4)
	go func() {
		for {
			conn, err := silent.Accept()
			if err != nil {
				return
			}
			held <- conn // read nothing, answer nothing
		}
	}()
	defer func() {
		for len(held) > 0 {
			(<-held).Close()
		}
	}()
	proxy, _ := url.Parse("http://" + silent.Addr().String())
	opt := Options{Timeout: 30 * time.Second, Proxy: proxy, AllowLoopbackForTests: true, LookupForTests: resolvesTo("93.184.215.14")}
	started := time.Now()
	if _, err := Fetch(context.Background(), "http://site.example/page", opt); errorCode(err) != "timeout" {
		t.Fatalf("got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("waited %s for a silent proxy", elapsed)
	}
}

func TestClientReadsNoProxyVariable(t *testing.T) {
	proxy, _ := url.Parse("http://127.0.0.1:7897")
	for _, opt := range []Options{{}, {Proxy: proxy}} {
		if transport := newClient(opt.withDefaults()).Transport.(*http.Transport); transport.Proxy != nil {
			t.Fatalf("the transport consults a proxy function (Proxy set: %v)", opt.Proxy != nil)
		}
	}
	p := newTunnelProxy(t)
	t.Setenv("HTTP_PROXY", p.server.URL)
	t.Setenv("HTTPS_PROXY", p.server.URL)
	if _, err := Fetch(context.Background(), "http://site.example/page", Options{Timeout: 2 * time.Second}); err == nil {
		t.Fatal("a read with no proxy set reached a site")
	}
	if tunnels, hosts := p.seen(); len(tunnels)+len(hosts) != 0 {
		t.Fatalf("the environment's proxy was used: %v %v", tunnels, hosts)
	}
}
