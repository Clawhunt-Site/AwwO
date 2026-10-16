// Package egress is the one way out of a sandbox workspace: an HTTP proxy that reaches public addresses on ports 80
// and 443 only, for a run that proves it is one (its run id and a token the workers derive from a shared secret), and
// within that run's byte and connection allowance. A workspace container sits on a Docker network with no route out
// but to this proxy, so whatever the agent runs in it (npm, pip, git over https, a headless browser, the code reader)
// reaches the web here or not at all, and never the host's own services, a private network or the cloud's metadata.
package egress

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"awwo/backend/internal/webread"
)

// Limits bound what one run and the whole proxy may do.
type Limits struct {
	RunBytes      int64         // bytes in and out across a run's connections
	RunConns      int           // connections a run may open in all
	RunConcurrent int           // connections a run may hold at once
	Concurrent    int           // connections the proxy holds at once
	IdleTimeout   time.Duration // a tunnel with no traffic either way for this long is closed
	DialTimeout   time.Duration
}

// DefaultLimits are generous for installing packages and reading pages, and small for anything that floods.
var DefaultLimits = Limits{RunBytes: 512 << 20, RunConns: 2000, RunConcurrent: 16, Concurrent: 256, IdleTimeout: 2 * time.Minute, DialTimeout: 10 * time.Second}

// Token is the proxy password of a run: workers and the proxy derive it from the same secret, so nothing is stored.
func Token(secret []byte, runID string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("awwo-egress-v1\x00" + runID))
	return hex.EncodeToString(mac.Sum(nil))[:40]
}

// Proxy serves CONNECT tunnels and plain-http requests for authenticated runs.
type Proxy struct {
	Secret   []byte
	Limits   Limits
	Deny     []netip.Prefix // addresses refused besides every non-public one (the host's own public addresses)
	Resolver *net.Resolver
	// AllowAddress, when set, decides instead of webread.PublicAddress (tests reach a loopback server through it).
	AllowAddress func(netip.Addr) bool
	// AllowPort, when set, decides instead of "443 and 80 for tunnels, 80 for plain http" (tests use their servers' ports).
	AllowPort func(port string) bool
	Log       func(event map[string]any)

	mu     sync.Mutex
	runs   map[string]*runUsage
	active int
}

type runUsage struct {
	bytes, conns, active int64
	seen                 time.Time
}

var (
	errRefused     = errors.New("not a public address")
	errUnreachable = errors.New("did not answer")
	errUnresolved  = errors.New("could not be resolved")
)

func (p *Proxy) allowed(a netip.Addr) bool {
	a = a.Unmap()
	for _, prefix := range p.Deny {
		if prefix.Contains(a) {
			return false
		}
	}
	if p.AllowAddress != nil {
		return p.AllowAddress(a)
	}
	return webread.PublicAddress(a)
}

// authenticate reads the run from Proxy-Authorization: Basic base64(runId:token).
func (p *Proxy) authenticate(r *http.Request) (string, bool) {
	raw, ok := strings.CutPrefix(r.Header.Get("Proxy-Authorization"), "Basic ")
	if !ok {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	runID, token, ok := strings.Cut(string(decoded), ":")
	if !ok || runID == "" || len(runID) > 256 || strings.ContainsAny(runID, "\x00\r\n") {
		return "", false
	}
	return runID, hmac.Equal([]byte(token), []byte(Token(p.Secret, runID)))
}

// admit reserves a connection for a run, or says why it may not open one.
func (p *Proxy) admit(runID string) (*runUsage, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runs == nil {
		p.runs = map[string]*runUsage{}
	}
	now := time.Now()
	for id, usage := range p.runs {
		if usage.active == 0 && now.Sub(usage.seen) > 2*time.Hour {
			delete(p.runs, id)
		}
	}
	usage := p.runs[runID]
	if usage == nil {
		usage = &runUsage{}
		p.runs[runID] = usage
	}
	usage.seen = now
	switch {
	case p.active >= p.Limits.Concurrent:
		return nil, "proxy_busy"
	case usage.active >= int64(p.Limits.RunConcurrent):
		return nil, "run_concurrency"
	case usage.conns >= int64(p.Limits.RunConns):
		return nil, "run_connections"
	case usage.bytes >= p.Limits.RunBytes:
		return nil, "run_bytes"
	}
	usage.conns++
	usage.active++
	p.active++
	return usage, ""
}

func (p *Proxy) release(usage *runUsage) {
	p.mu.Lock()
	defer p.mu.Unlock()
	usage.active--
	usage.seen = time.Now()
	p.active--
}

// count adds traffic to a run and reports whether it is still within its allowance.
func (p *Proxy) count(usage *runUsage, n int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	usage.bytes += int64(n)
	return usage.bytes <= p.Limits.RunBytes
}

// dial resolves host and connects to the first address the policy allows, checking the address it connects to.
func (p *Proxy) dial(ctx context.Context, host, port string) (net.Conn, error) {
	resolver := p.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	var addrs []netip.Addr
	if literal, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		addrs = []netip.Addr{literal}
	} else {
		found, err := resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, errUnresolved
		}
		addrs = found
	}
	dialer := net.Dialer{Timeout: p.Limits.DialTimeout}
	failure := errRefused
	for _, addr := range addrs {
		if !p.allowed(addr) {
			continue
		}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(addr.Unmap().String(), port))
		if err != nil {
			failure = errUnreachable
			continue
		}
		// The address the kernel connected to is the one checked: never a second resolution.
		remote, ok := conn.RemoteAddr().(*net.TCPAddr)
		if !ok || !p.allowed(remote.AddrPort().Addr()) {
			conn.Close()
			return nil, errRefused
		}
		return conn, nil
	}
	return nil, failure
}

// portAllowed: tunnels reach 443 and 80, plain requests are http on 80.
func (p *Proxy) portAllowed(tunnel bool, scheme, port string) bool {
	if !tunnel && scheme != "http" {
		return false
	}
	if p.AllowPort != nil {
		return p.AllowPort(port)
	}
	return port == "80" || (tunnel && port == "443")
}

func (p *Proxy) log(event map[string]any) {
	if p.Log != nil {
		p.Log(event)
	}
}

// ServeHTTP is the proxy: CONNECT for https, absolute-form GET/POST/... for plain http.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	runID, ok := p.authenticate(r)
	if !ok {
		w.Header().Set("Proxy-Authenticate", `Basic realm="awwo-egress"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	run := sha256.Sum256([]byte(runID))
	runTag := hex.EncodeToString(run[:6])
	host, port := r.URL.Hostname(), r.URL.Port()
	if r.Method == http.MethodConnect {
		h, pt, err := net.SplitHostPort(r.Host)
		if err != nil {
			http.Error(w, "bad target", http.StatusBadRequest)
			return
		}
		host, port = h, pt
	} else if port == "" {
		port = "80"
	}
	if host == "" || !p.portAllowed(r.Method == http.MethodConnect, r.URL.Scheme, port) {
		p.log(map[string]any{"event": "refused", "run": runTag, "host": host, "port": port, "reason": "port_or_scheme"})
		http.Error(w, "only http on port 80 and https on port 443", http.StatusForbidden)
		return
	}
	usage, reason := p.admit(runID)
	if reason != "" {
		p.log(map[string]any{"event": "refused", "run": runTag, "host": host, "port": port, "reason": reason})
		http.Error(w, "egress allowance used up: "+reason, http.StatusTooManyRequests)
		return
	}
	defer p.release(usage)
	ctx, cancel := context.WithTimeout(r.Context(), p.Limits.DialTimeout)
	upstream, err := p.dial(ctx, host, port)
	cancel()
	if err != nil {
		reason := map[error]string{errRefused: "address", errUnreachable: "unreachable", errUnresolved: "unresolved"}[err]
		p.log(map[string]any{"event": "refused", "run": runTag, "host": host, "port": port, "reason": reason})
		http.Error(w, "the destination "+err.Error(), http.StatusBadGateway)
		return
	}
	started := time.Now()
	var moved int64
	defer func() {
		p.log(map[string]any{"event": "closed", "run": runTag, "host": host, "port": port, "bytes": moved, "ms": time.Since(started).Milliseconds()})
	}()
	if r.Method == http.MethodConnect {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			upstream.Close()
			http.Error(w, "tunnels unsupported", http.StatusInternalServerError)
			return
		}
		client, buffered, err := hijacker.Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		if _, err = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err == nil && buffered.Reader.Buffered() > 0 {
			pending := make([]byte, buffered.Reader.Buffered())
			n, _ := buffered.Read(pending)
			if _, err = upstream.Write(pending[:n]); err == nil {
				moved += int64(n)
				p.count(usage, n)
			}
		}
		if err == nil {
			moved += p.splice(client, upstream, usage)
		}
		client.Close()
		upstream.Close()
		return
	}
	defer upstream.Close()
	// Plain http: send the request on the checked connection, origin-form, without proxy credentials.
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.Header.Del("Proxy-Authorization")
	out.Header.Del("Proxy-Connection")
	out.Close = true
	if err = out.Write(&budgetWriter{conn: upstream, proxy: p, usage: usage, moved: &moved}); err != nil {
		http.Error(w, "upstream write failed", http.StatusBadGateway)
		return
	}
	response, err := http.ReadResponse(bufio.NewReader(&budgetReader{conn: upstream, proxy: p, usage: usage, moved: &moved}), out)
	if err != nil {
		http.Error(w, "upstream response failed", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	for key, values := range response.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

// splice copies both ways until either side closes, the run's bytes run out, or the tunnel idles.
func (p *Proxy) splice(a, b net.Conn, usage *runUsage) int64 {
	var total int64
	var mu sync.Mutex
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		buf := make([]byte, 32<<10)
		for {
			_ = src.SetReadDeadline(time.Now().Add(p.Limits.IdleTimeout))
			n, err := src.Read(buf)
			if n > 0 {
				mu.Lock()
				total += int64(n)
				mu.Unlock()
				if !p.count(usage, n) {
					break
				}
				if _, werr := dst.Write(buf[:n]); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		a.Close()
		b.Close()
		done <- struct{}{}
	}
	go pipe(a, b)
	go pipe(b, a)
	<-done
	<-done
	return total
}

type budgetReader struct {
	conn  net.Conn
	proxy *Proxy
	usage *runUsage
	moved *int64
}

func (b *budgetReader) Read(buf []byte) (int, error) {
	_ = b.conn.SetReadDeadline(time.Now().Add(b.proxy.Limits.IdleTimeout))
	n, err := b.conn.Read(buf)
	if n > 0 {
		*b.moved += int64(n)
		if !b.proxy.count(b.usage, n) {
			return n, errors.New("egress allowance used up")
		}
	}
	return n, err
}

// budgetWriter counts a plain request (headers and body) against the run before it leaves.
type budgetWriter struct {
	conn  net.Conn
	proxy *Proxy
	usage *runUsage
	moved *int64
}

func (b *budgetWriter) Write(buf []byte) (int, error) {
	*b.moved += int64(len(buf))
	if !b.proxy.count(b.usage, len(buf)) {
		return 0, errors.New("egress allowance used up")
	}
	return b.conn.Write(buf)
}

// ParseDeny reads a comma-separated list of addresses or prefixes to refuse besides the non-public ones.
func ParseDeny(raw string) ([]netip.Prefix, error) {
	out := []netip.Prefix{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			addr, err := netip.ParseAddr(item)
			if err != nil {
				return nil, err
			}
			item += "/" + strconv.Itoa(addr.BitLen())
		}
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			return nil, err
		}
		out = append(out, prefix.Masked())
	}
	return out, nil
}
