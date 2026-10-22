package webread

import (
	"net"
	"net/netip"
	"net/url"
	"syscall"
)

// Ranges that are not public unicast beyond what netip classifies itself (private, loopback, link-local, multicast,
// unspecified): shared and benchmark space, documentation, reserved, relay and translation prefixes (NAT64, SIIT),
// segment routing, and the 198.18.0.0/15 range fake-IP DNS resolvers also hand out.
var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/32"), netip.MustParsePrefix("2001:10::/28"), netip.MustParsePrefix("2001:20::/28"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("fec0::/10"), netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("3fff::/20"), netip.MustParsePrefix("5f00::/16"), netip.MustParsePrefix("::ffff:0:0:0/96"),
}

var sixToFour = netip.MustParsePrefix("2002::/16")

// PublicAddress reports whether an address is public unicast that a server-side read may connect to.
func PublicAddress(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() {
		return false
	}
	if a.Is6() {
		raw := a.As16()
		// IPv4-compatible (::a.b.c.d, deprecated): never a real destination.
		zero := true
		for _, b := range raw[:12] {
			zero = zero && b == 0
		}
		if zero {
			return false
		}
		// 6to4 carries an IPv4 address in bits 16–48; it is as public as that address.
		if sixToFour.Contains(a) {
			return PublicAddress(netip.AddrFrom4([4]byte{raw[2], raw[3], raw[4], raw[5]}))
		}
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(a) {
			return false
		}
	}
	return true
}

// dialControl refuses, at connect time, every address that is not public. allowLoopback admits loopback for tests;
// proxy, when set, is the one other address admitted (Options.Proxy).
func dialControl(allowLoopback bool, proxy *url.URL) func(network, address string, _ syscall.RawConn) error {
	return func(network, address string, _ syscall.RawConn) error {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return failure("blocked_address", "The site's address could not be checked")
		}
		addr, err := netip.ParseAddr(host)
		if err != nil {
			return failure("blocked_address", "The site's address could not be checked")
		}
		if proxy != nil && host == proxy.Hostname() && port == proxy.Port() {
			return nil
		}
		if allowLoopback && addr.Unmap().IsLoopback() {
			return nil
		}
		if !PublicAddress(addr) {
			return failure("blocked_address", "The site resolves to an address that is not public, so it is not read")
		}
		return nil
	}
}
