package webread

import (
	"net"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/idna"
)

const maxURLBytes = 2048

var (
	blockedNames    = map[string]bool{"localhost": true, "metadata.google.internal": true, "instance-data": true, "metadata": true, "localhost.localdomain": true}
	blockedSuffixes = []string{".localhost", ".local", ".internal", ".lan", ".localdomain", ".home.arpa", ".intranet"}
	// A label written like an inet_aton number: decimal, octal or hex. A host whose last label looks like this is
	// an address in disguise (127.1, 2130706433, 0x7f000001, 0177.0.0.1), never a registered name.
	numericLabel = regexp.MustCompile(`^(0x[0-9a-f]*|[0-9]+)$`)
)

// ValidateURL accepts an absolute http(s) address on the default port to a registered host name and returns it
// normalized: lower-case ASCII host (IDNA), no fragment, no trailing dot.
func ValidateURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxURLBytes || strings.ContainsAny(raw, "\x00\r\n\t\\ ") {
		return nil, failure("invalid_url", "Enter a complete web address (http or https) of at most 2,048 characters")
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() {
		return nil, failure("invalid_url", "Enter a complete web address (http or https)")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, failure("blocked_scheme", "Only http and https addresses can be read")
	}
	if u.Opaque != "" {
		return nil, failure("invalid_url", "Enter a complete web address (http or https)")
	}
	if u.User != nil {
		return nil, failure("invalid_url", "An address with a user name or password cannot be read")
	}
	host, port := u.Hostname(), u.Port()
	if host == "" || strings.HasSuffix(u.Host, ":") || strings.Contains(host, "%") {
		return nil, failure("invalid_url", "The address has no valid host")
	}
	if port != "" && port != "80" && port != "443" {
		return nil, failure("blocked_port", "Only the standard web ports (80 and 443) can be read")
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if strings.Contains(host, ":") || net.ParseIP(host) != nil {
		return nil, failure("blocked_host", "Read a site by its name, not by an IP address")
	}
	ascii, err := idna.Lookup.ToASCII(host)
	if err != nil || ascii == "" {
		return nil, failure("invalid_url", "The address has an invalid host name")
	}
	labels := strings.Split(ascii, ".")
	if len(labels) < 2 || slicesContainEmpty(labels) {
		return nil, failure("blocked_host", "Only public sites can be read")
	}
	if numericLabel.MatchString(labels[len(labels)-1]) || net.ParseIP(ascii) != nil {
		return nil, failure("blocked_host", "Read a site by its name, not by an IP address")
	}
	if blockedNames[ascii] {
		return nil, failure("blocked_host", "Only public sites can be read")
	}
	for _, suffix := range blockedSuffixes {
		if strings.HasSuffix(ascii, suffix) {
			return nil, failure("blocked_host", "Only public sites can be read")
		}
	}
	u.Scheme, u.Host = scheme, ascii
	if port != "" {
		u.Host = ascii + ":" + port
	}
	u.Fragment, u.RawFragment = "", ""
	return u, nil
}

func slicesContainEmpty(items []string) bool {
	for _, item := range items {
		if item == "" {
			return true
		}
	}
	return false
}
