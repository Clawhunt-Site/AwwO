// Package egress is the one way out of a sandbox workspace: an HTTP proxy that reaches public addresses on ports 80
// and 443 only, for a run that proves it is one (its run id and a password the workers derive from a shared secret), and
// within that run's byte and connection allowance. A workspace container has no network interface but loopback; its
// only route out is this proxy's socket, so whatever the agent runs in it (npm, pip, git over https, the code reader)
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
	"sync/atomic"
	"time"

	"awwo/backend/internal/webread"
)

// Limits bound what one run and the whole proxy may do.
type Limits struct {
	RunBytes      int64         // bytes in and out across a run's connections
	RunConns      int           // connections a run may open in all
	RunConcurrent int           // connections a run may hold at once
	Concurrent    int           // connections the proxy holds at once
	IdleTimeout   time.Duration // a connection with no traffic in either direction for this long is closed
	DialTimeout   time.Duration
}

// DefaultLimits are generous for installing packages and reading pages, and small for anything that floods.
var DefaultLimits = Limits{RunBytes: 512 << 20, RunConns: 2000, RunConcurrent: 16, Concurrent: 256, IdleTimeout: 2 * time.Minute, DialTimeout: 10 * time.Second}

// TokenPeriod is how long a run password lives: it is accepted in the period it was made and in the next one, so for
// 12 to 24 hours, longer than any run.
const TokenPeriod = 12 * time.Hour

// Token is a run's proxy password at a time: workers and the proxy derive it from the same secret, so nothing is stored.
func Token(secret []byte, runID string, at time.Time) string {
	period := at.Unix() / int64(TokenPeriod/time.Second)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("awwo-egress-v2\x00" + runID + "\x00" + strconv.FormatInt(period, 10)))
	return hex.EncodeToString(mac.Sum(nil))[:40]
}

// ValidSecret is the rule the workers apply to the same setting (workspace-sandbox.ts validEgress).
func ValidSecret(secret string) bool {
	if len(secret) < 32 || len(secret) > 512 {
		return false
	}
	for _, r := range secret {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
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
	Now       func() time.Time
	Log       func(event map[string]any)

	mu       sync.Mutex
	runs     map[string]*runUsage
	active   int
	rejected map[string]time.Time // when a refused password was last logged, by run tag
}

type runUsage struct {
	bytes, conns, active int64
	seen                 time.Time
}

var (
	errRefused     = errors.New("not a public address")
	errUnreachable = errors.New("did not answer")
	errUnresolved  = errors.New("could not be resolved")
	errAllowance   = errors.New("egress allowance used up")
)

func (p *Proxy) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p *Proxy) allowed(a netip.Addr) bool {
	// netip's range checks ignore a zone but prefix matching never matches a zoned address, so a zone could carry an
	// address past the deny list and the reserved ranges: no destination has one.
	if a.Zone() != "" {
		return false
	}
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

// authenticate reads the run from Proxy-Authorization: Basic base64(runId:token), and the run's tag either way.
func (p *Proxy) authenticate(r *http.Request) (string, string, bool) {
	raw, ok := strings.CutPrefix(r.Header.Get("Proxy-Authorization"), "Basic ")
	if !ok {
		return "", "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return "", "", false
	}
	runID, token, ok := strings.Cut(string(decoded), ":")
	if !ok || runID == "" || len(runID) > 256 || strings.ContainsAny(runID, "\x00\r\n") {
		return "", "", false
	}
	sum := sha256.Sum256([]byte(runID))
	tag := hex.EncodeToString(sum[:6])
	now := p.now()
	for _, at := range []time.Time{now, now.Add(-TokenPeriod)} {
		if hmac.Equal([]byte(token), []byte(Token(p.Secret, runID, at))) {
			return runID, tag, true
		}
	}
	return "", tag, false
}

// admit reserves a connection for a run, or says why it may not open one.
func (p *Proxy) admit(runID string) (*runUsage, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runs == nil {
		p.runs = map[string]*runUsage{}
	}
	now := p.now()
	// A run is remembered while its password can still be valid, so its allowance never starts over meanwhile.
	for id, usage := range p.runs {
		if usage.active == 0 && now.Sub(usage.seen) > 2*TokenPeriod {
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
	usage.seen = p.now()
	p.active--
}

// count adds traffic to a run and reports whether it is still within its allowance; traffic past it is never sent.
func (p *Proxy) count(usage *runUsage, n int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if usage.bytes+int64(n) > p.Limits.RunBytes {
		usage.bytes = p.Limits.RunBytes
		return false
	}
	usage.bytes += int64(n)
	return true
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

// logRejected records a refused password at most once a minute per claimed run, so a client retrying in a loop
// cannot flood the log.
func (p *Proxy) logRejected(tag string) {
	p.mu.Lock()
	if p.rejected == nil {
		p.rejected = map[string]time.Time{}
	}
	now := p.now()
	last, seen := p.rejected[tag]
	if !seen || now.Sub(last) >= time.Minute {
		p.rejected[tag] = now
	}
	if len(p.rejected) > 4096 {
		p.rejected = map[string]time.Time{tag: now}
	}
	p.mu.Unlock()
	if !seen || now.Sub(last) >= time.Minute {
		p.log(map[string]any{"event": "refused", "run": tag, "reason": "auth"})
	}
}

// ServeHTTP is the proxy: CONNECT for https, absolute-form requests for plain http.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	runID, runTag, ok := p.authenticate(r)
	if !ok {
		if runTag != "" {
			p.logRejected(runTag)
		}
		w.Header().Set("Proxy-Authenticate", `Basic realm="awwo-egress"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	host, port := r.URL.Hostname(), r.URL.Port()
	if r.Method == http.MethodConnect {
		h, pt, err := net.SplitHostPort(r.Host)
		if err != nil {
			p.log(map[string]any{"event": "refused", "run": runTag, "reason": "bad_target"})
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
	// Not the request's context: a client that half-closes after its CONNECT still gets its tunnel.
	ctx, cancel := context.WithTimeout(context.Background(), p.Limits.DialTimeout)
	upstream, err := p.dial(ctx, host, port)
	cancel()
	if err != nil {
		reason := map[error]string{errRefused: "address", errUnreachable: "unreachable", errUnresolved: "unresolved"}[err]
		p.log(map[string]any{"event": "refused", "run": runTag, "host": host, "port": port, "reason": reason})
		http.Error(w, "the destination "+err.Error(), http.StatusBadGateway)
		return
	}
	started := time.Now()
	var moved atomic.Int64
	outcome := "closed"
	defer func() {
		p.log(map[string]any{"event": outcome, "run": runTag, "host": host, "port": port, "bytes": moved.Load(), "ms": time.Since(started).Milliseconds()})
	}()
	t := &transfer{proxy: p, usage: usage, moved: &moved, idle: p.Limits.IdleTimeout}
	if r.Method == http.MethodConnect {
		if !t.tunnel(w, upstream) {
			outcome = "run_bytes"
		}
		return
	}
	defer upstream.Close()
	if status, body := t.forward(w, r, upstream); status != 0 {
		if status == http.StatusTooManyRequests {
			outcome = "run_bytes"
		}
		http.Error(w, body, status)
	} else if t.exceeded.Load() {
		outcome = "run_bytes"
	}
}

// transfer moves one connection's bytes, counting them against the run and closing it once both directions idle.
type transfer struct {
	proxy    *Proxy
	usage    *runUsage
	moved    *atomic.Int64
	idle     time.Duration
	last     atomic.Int64 // unix nanoseconds of the last byte either way
	exceeded atomic.Bool
}

func (t *transfer) touch() { t.last.Store(time.Now().UnixNano()) }

// idleFor reports whether nothing moved either way for the idle limit.
func (t *transfer) idleFor() bool { return time.Since(time.Unix(0, t.last.Load())) >= t.idle }

func (t *transfer) charge(n int) bool {
	t.moved.Add(int64(n))
	if !t.proxy.count(t.usage, n) {
		t.exceeded.Store(true)
		return false
	}
	return true
}

// tunnel answers a CONNECT and splices the two connections; false when the run's allowance ended it.
func (t *transfer) tunnel(w http.ResponseWriter, upstream net.Conn) bool {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		http.Error(w, "tunnels unsupported", http.StatusInternalServerError)
		return true
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		upstream.Close()
		return true
	}
	defer client.Close()
	defer upstream.Close()
	_ = client.SetDeadline(time.Time{})
	if _, err = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return true
	}
	t.touch()
	// Bytes the client sent right after its request (a TLS hello) were read ahead; they go first.
	if n := buffered.Reader.Buffered(); n > 0 {
		pending := make([]byte, n)
		n, _ = buffered.Read(pending)
		if !t.charge(n) {
			return false
		}
		if _, err = upstream.Write(pending[:n]); err != nil {
			return true
		}
	}
	t.splice(client, upstream)
	return !t.exceeded.Load()
}

// splice copies both ways. A side that finishes sending is half-closed and the other way goes on; an error, the
// allowance or both ways idling for the limit ends the connection.
func (t *transfer) splice(a, b net.Conn) {
	var once sync.Once
	stop := func() { once.Do(func() { a.Close(); b.Close() }) }
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32<<10)
		for {
			_ = src.SetReadDeadline(time.Now().Add(t.idle))
			n, err := src.Read(buf)
			if n > 0 {
				t.touch()
				if !t.charge(n) {
					stop()
					return
				}
				_ = dst.SetWriteDeadline(time.Now().Add(t.idle))
				if _, werr := dst.Write(buf[:n]); werr != nil {
					stop()
					return
				}
			}
			if err == nil {
				continue
			}
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() && !t.idleFor() {
				continue // this way is quiet while the other moves
			}
			if errors.Is(err, io.EOF) {
				if half, ok := dst.(interface{ CloseWrite() error }); ok && half.CloseWrite() == nil {
					return
				}
			}
			stop()
			return
		}
	}
	go pipe(a, b)
	go pipe(b, a)
	<-done
	<-done
	stop()
}

// Hop-by-hop headers are the connection's, never the request's (RFC 9110 7.6.1).
var hopHeaders = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

func stripHop(h http.Header) {
	for _, value := range h.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			if name = strings.TrimSpace(name); name != "" {
				h.Del(name)
			}
		}
	}
	for _, name := range hopHeaders {
		h.Del(name)
	}
}

// forward sends a plain request on the checked connection, origin-form, without proxy or hop-by-hop headers, and
// relays the final response. It returns a status to answer with when nothing has been relayed yet.
func (t *transfer) forward(w http.ResponseWriter, r *http.Request, upstream net.Conn) (int, string) {
	controller := http.NewResponseController(w)
	out := r.Clone(r.Context())
	out.RequestURI = ""
	stripHop(out.Header)
	// The proxy relays one final answer: a 100 Continue would be taken for it, and an upgraded connection is not http.
	out.Header.Del("Expect")
	out.Close = true
	_ = controller.SetReadDeadline(time.Now().Add(t.idle))
	_ = upstream.SetDeadline(time.Now().Add(t.idle))
	if err := out.Write(&budgetConn{Conn: upstream, t: t}); err != nil {
		if t.exceeded.Load() {
			return http.StatusTooManyRequests, errAllowance.Error()
		}
		return http.StatusBadGateway, "upstream write failed"
	}
	reader := bufio.NewReader(&budgetConn{Conn: upstream, t: t})
	var response *http.Response
	for {
		_ = upstream.SetReadDeadline(time.Now().Add(t.idle))
		got, err := http.ReadResponse(reader, out)
		if err != nil {
			if t.exceeded.Load() {
				return http.StatusTooManyRequests, errAllowance.Error()
			}
			return http.StatusBadGateway, "upstream response failed"
		}
		if got.StatusCode == http.StatusSwitchingProtocols {
			got.Body.Close()
			return http.StatusBadGateway, "upgrades are not relayed"
		}
		if got.StatusCode >= 200 || got.StatusCode < 100 {
			response = got
			break
		}
		got.Body.Close() // an informational answer before the final one
	}
	defer response.Body.Close()
	stripHop(response.Header)
	for key, values := range response.Header {
		w.Header()[key] = append([]string(nil), values...)
	}
	if response.Header.Get("Content-Type") == "" {
		w.Header()["Content-Type"] = nil // never a type the site did not send
	}
	w.WriteHeader(response.StatusCode)
	buf := make([]byte, 32<<10)
	for {
		_ = upstream.SetReadDeadline(time.Now().Add(t.idle))
		n, err := response.Body.Read(buf)
		if n > 0 {
			_ = controller.SetWriteDeadline(time.Now().Add(t.idle))
			if _, werr := w.Write(buf[:n]); werr != nil {
				return 0, ""
			}
		}
		if err != nil {
			return 0, ""
		}
	}
}

// budgetConn counts a plain request's bytes both ways against the run before they move.
type budgetConn struct {
	net.Conn
	t *transfer
}

func (b *budgetConn) Read(buf []byte) (int, error) {
	n, err := b.Conn.Read(buf)
	if n > 0 {
		b.t.touch()
		if !b.t.charge(n) {
			return 0, errAllowance
		}
	}
	return n, err
}

func (b *budgetConn) Write(buf []byte) (int, error) {
	if !b.t.charge(len(buf)) {
		return 0, errAllowance
	}
	b.t.touch()
	return b.Conn.Write(buf)
}

// ParseDeny reads a comma-separated list of addresses or prefixes to refuse besides the non-public ones. An
// IPv4-mapped form is stored as the IPv4 prefix, the form addresses are compared in.
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
		if prefix.Addr().Zone() != "" {
			return nil, errors.New("a deny entry cannot carry a zone: " + item)
		}
		if prefix.Addr().Is4In6() {
			if prefix.Bits() < 96 {
				return nil, errors.New("an IPv4-mapped deny entry needs at least /96: " + item)
			}
			prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
		}
		out = append(out, prefix.Masked())
	}
	return out, nil
}
