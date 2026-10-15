package webread

import (
	"errors"
	"net/netip"
	"strings"
	"testing"
)

func errorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func TestValidateURLAcceptsPublicAddresses(t *testing.T) {
	cases := map[string]string{
		"https://example.com/a?b=1#frag":   "https://example.com/a?b=1",
		"HTTP://Example.COM./path":         "http://example.com/path",
		"https://example.com:443/":         "https://example.com:443/",
		"http://例子.测试/":                    "http://xn--fsqu00a.xn--0zwm56d/",
		"https://news.example.co.uk/x/y.z": "https://news.example.co.uk/x/y.z",
	}
	for raw, want := range cases {
		u, err := ValidateURL(raw)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if u.String() != want {
			t.Fatalf("%s: got %s want %s", raw, u.String(), want)
		}
	}
}

func TestValidateURLRefusesUnsafeAddresses(t *testing.T) {
	cases := map[string]string{
		"":                                               "invalid_url",
		"example.com":                                    "invalid_url",
		"ftp://x.com/":                                   "blocked_scheme",
		"javascript:alert(1)":                            "blocked_scheme",
		"file:///etc/passwd":                             "blocked_scheme",
		"https://user:pass@x.com/":                       "invalid_url",
		"https://x.com@evil.test/":                       "invalid_url",
		"https://x.com:8080/":                            "blocked_port",
		"https://x.com:65536/":                           "blocked_port",
		"https://x.com:-1/":                              "invalid_url",
		"https://127.0.0.1/":                             "blocked_host",
		"https://127.1/":                                 "blocked_host",
		"https://2130706433/":                            "blocked_host",
		"https://0x7f000001/":                            "blocked_host",
		"https://0177.0.0.1/":                            "blocked_host",
		"https://017700000001/":                          "blocked_host",
		"https://[::1]/":                                 "blocked_host",
		"https://[::ffff:127.0.0.1]/":                    "blocked_host",
		"https://localhost/":                             "blocked_host",
		"https://localhost./":                            "blocked_host",
		"https://a.localhost/":                           "blocked_host",
		"https://printer.local/":                         "blocked_host",
		"https://db.internal/":                           "blocked_host",
		"https://router.home.arpa/":                      "blocked_host",
		"https://intranet/":                              "blocked_host",
		"https://metadata.google.internal/":              "blocked_host",
		"https://x.com/a b":                              "invalid_url",
		"https://x.com/\\..\\":                           "invalid_url",
		"https://" + strings.Repeat("a", 2050) + ".com/": "invalid_url",
	}
	for raw, want := range cases {
		_, err := ValidateURL(raw)
		if got := errorCode(err); got != want {
			t.Fatalf("%q: got %q (%v) want %q", raw, got, err, want)
		}
	}
}

func TestPublicAddress(t *testing.T) {
	private := []string{"10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "0.0.0.0",
		"224.0.0.1", "240.0.0.1", "255.255.255.255", "192.0.0.8", "192.88.99.1", "::1", "fe80::1", "fc00::1", "fd12::1", "fec0::1", "2002:7f00:1::1",
		"2002:0a00:0001::1", "2001::1", "2001:db8::1", "::ffff:10.0.0.1", "::10.0.0.1", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", "ff02::1", "::"}
	public := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2002:0808:0808::1", "::ffff:8.8.8.8"}
	for _, raw := range private {
		if PublicAddress(netip.MustParseAddr(raw)) {
			t.Fatalf("%s accepted as public", raw)
		}
	}
	for _, raw := range public {
		if !PublicAddress(netip.MustParseAddr(raw)) {
			t.Fatalf("%s refused", raw)
		}
	}
}

func TestDialControlRefusesNonPublicAddresses(t *testing.T) {
	control := dialControl(false)
	for _, address := range []string{"127.0.0.1:443", "[::1]:443", "10.0.0.1:80", "169.254.169.254:80", "garbage"} {
		if errorCode(control("tcp", address, nil)) != "blocked_address" {
			t.Fatalf("%s was not refused", address)
		}
	}
	if err := control("tcp", "8.8.8.8:443", nil); err != nil {
		t.Fatal(err)
	}
	if err := dialControl(true)("tcp", "127.0.0.1:8080", nil); err != nil {
		t.Fatal("loopback refused in test mode", err)
	}
	if errorCode(dialControl(true)("tcp", "10.0.0.1:80", nil)) != "blocked_address" {
		t.Fatal("test mode admitted a private address")
	}
}
