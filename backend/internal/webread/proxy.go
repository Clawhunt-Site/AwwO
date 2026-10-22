package webread

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/netip"
	"time"
)

// fakeIP is where a proxy's own fake-IP resolver puts every name: such an answer says nothing of the site behind it.
var fakeIP = netip.MustParsePrefix("198.18.0.0/15")

// proxyExchangeTimeout bounds a name lookup and a tunnel request on their own: the transport dials with a context
// that carries neither the read's deadline nor its cancellation, so a proxy that accepts and never answers would hold
// the dial for good. A variable so tests can shorten it.
var proxyExchangeTimeout = 10 * time.Second

// maxTunnelTries bounds the checked addresses tried for one connection.
const maxTunnelTries = 4

// proxyDial reaches a site through the explicit proxy on this computer (Options.Proxy) without letting the proxy
// choose where to connect. The site's name is resolved here; every answer must be a public address (one that is not
// refuses the read, a fake-IP answer and a failed lookup too: neither says where the site is), and the proxy is asked
// for a tunnel to one of them, CONNECT ip:port, never to the name, which it would resolve again by itself; IPv4 first,
// the next address when the proxy cannot reach one. The transport then speaks to the site over the tunnel as over a
// direct connection: TLS with the site's name, the request in origin form. The proxy's own address is the only one
// dialed.
func proxyDial(opt Options) func(ctx context.Context, network, address string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: dialControl(false, opt.Proxy)}
	lookup := net.DefaultResolver.LookupNetIP
	if opt.AllowLoopbackForTests && opt.LookupForTests != nil {
		lookup = func(ctx context.Context, _ string, host string) ([]netip.Addr, error) {
			return opt.LookupForTests(ctx, host)
		}
	}
	return func(ctx context.Context, _, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, failure("blocked_address", "The site's address could not be checked")
		}
		targets, err := vettedAddresses(ctx, lookup, host)
		if err != nil {
			return nil, err
		}
		for i, target := range targets {
			conn, err := dialer.DialContext(ctx, "tcp", opt.Proxy.Host)
			if err != nil {
				return nil, failure("network_error", "The proxy on this computer could not be reached")
			}
			tunnel, err := connectThrough(ctx, conn, net.JoinHostPort(target.String(), port))
			if err == nil {
				return tunnel, nil
			}
			conn.Close()
			if err != errTunnelRefused || i == len(targets)-1 || i == maxTunnelTries-1 {
				return nil, err
			}
		}
		return nil, errTunnelRefused
	}
}

// errTunnelRefused: the proxy answered but would not open this tunnel; another of the site's addresses may do.
var errTunnelRefused = failure("network_error", "The proxy on this computer refused to connect to the site")

// vettedAddresses are the addresses a tunnel may go to, IPv4 first: the name's answers, all of which must be public.
func vettedAddresses(ctx context.Context, lookup func(context.Context, string, string) ([]netip.Addr, error), host string) ([]netip.Addr, error) {
	ctx, cancel := context.WithTimeout(ctx, proxyExchangeTimeout)
	defer cancel()
	addrs, err := lookup(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		return nil, failure("network_error", "The site's name could not be resolved on this computer, so its address could not be checked")
	}
	var four, six []netip.Addr
	for _, addr := range addrs {
		addr = addr.Unmap()
		if fakeIP.Contains(addr) {
			return nil, failure("blocked_address", "This computer resolves names to its proxy's stand-in addresses (fake-IP), so the site's address could not be checked")
		}
		if !PublicAddress(addr) {
			return nil, failure("blocked_address", "The site resolves to an address that is not public, so it is not read")
		}
		if addr.Is4() {
			four = append(four, addr)
		} else {
			six = append(six, addr)
		}
	}
	return append(four, six...), nil
}

// connectThrough asks the proxy for a tunnel to target (ip:port) and returns the connection once it answers 200,
// within proxyExchangeTimeout (and sooner should the context end).
func connectThrough(ctx context.Context, conn net.Conn, target string) (net.Conn, error) {
	deadline := time.Now().Add(proxyExchangeTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()
	if _, err := io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n"); err != nil {
		return nil, failure("network_error", "The proxy on this computer could not be reached")
	}
	reader := bufio.NewReaderSize(conn, 4096)
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			return nil, failure("timeout", "The proxy on this computer did not answer in time")
		}
		return nil, failure("network_error", "The proxy on this computer did not answer")
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errTunnelRefused
	}
	if !stop() {
		// The context ended as the answer came: the deadline it set would cut the read short.
		return nil, failure("timeout", "The site took too long to answer")
	}
	_ = conn.SetDeadline(time.Time{})
	if reader.Buffered() > 0 {
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}
	return conn, nil
}

// bufferedConn reads first what the proxy sent after its answer, then the connection.
type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }
