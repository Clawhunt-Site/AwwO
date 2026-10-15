package webread

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html/charset"
	"golang.org/x/text/encoding/htmlindex"
)

// Options bound one read. The zero values take the documented defaults.
type Options struct {
	UserAgent    string        // e.g. "AwwO-Reader/1.0 (+https://awwo.clawhunt.store)"
	Timeout      time.Duration // one deadline for DNS, connecting, redirects and the body; default 20s
	MaxBodyBytes int64         // bytes read from the response (after transport decompression); default 5 MiB
	MaxTextBytes int           // extracted text, cut on a character boundary; default 256 KiB
	MaxRedirects int           // default 5
	Robots       *RobotsCache  // nil skips robots.txt (production callers always pass one)
	// AllowLoopbackForTests lets tests dial servers on 127.0.0.1/::1, and only those; DialAddressForTests (honoured
	// only together with it) maps a test host name to such a server. Never set in production.
	AllowLoopbackForTests bool
	DialAddressForTests   func(hostport string) string
	Now                   func() time.Time
}

func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o Options) withDefaults() Options {
	if o.UserAgent == "" {
		o.UserAgent = "AwwO-Reader/1.0"
	}
	if o.Timeout <= 0 {
		o.Timeout = 20 * time.Second
	}
	if o.MaxBodyBytes <= 0 {
		o.MaxBodyBytes = 5 << 20
	}
	if o.MaxTextBytes <= 0 {
		o.MaxTextBytes = 256 << 10
	}
	if o.MaxRedirects <= 0 {
		o.MaxRedirects = 5
	}
	return o
}

type Link struct{ Text, URL string }
type FeedItem struct{ Title, Link, Published, Summary string }
type RobotsVerdict struct {
	Checked, Allowed, Cached bool
	Status                   int
	URL                      string
}

// Result is one page read and reduced to readable text.
type Result struct {
	RequestedURL, FinalURL         string
	Redirects                      []string
	Status                         int
	ContentType, Charset           string
	FetchedAt                      time.Time
	RawSHA256                      string
	RawBytes                       int64
	Kind                           string // "article" | "feed" | "text" | "json"
	Title, Byline, Published, Lang string
	Text                           string
	Truncated, Unconfirmed         bool
	Links                          []Link
	Items                          []FeedItem
	Robots                         RobotsVerdict
	Extractor                      string
}

const pageAccept = "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.1"

func newClient(opt Options) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: dialControl(opt.AllowLoopbackForTests)}
	dial := dialer.DialContext
	if opt.AllowLoopbackForTests && opt.DialAddressForTests != nil {
		dial = func(ctx context.Context, network, address string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, opt.DialAddressForTests(address))
		}
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dial,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  15 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		DisableKeepAlives:      true,
		ForceAttemptHTTP2:      false,
		TLSNextProto:           map[string]func(string, *tls.Conn) http.RoundTripper{},
	}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func get(ctx context.Context, client *http.Client, target *url.URL, opt Options, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, failure("invalid_url", "The address could not be requested")
	}
	req.Header.Set("User-Agent", opt.UserAgent)
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	resp, err := client.Do(req)
	if err != nil {
		return nil, transportFailure(ctx, err)
	}
	return resp, nil
}

func transportFailure(ctx context.Context, err error) error {
	var refused *Error
	if errors.As(err, &refused) {
		return refused
	}
	var netErr net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return failure("timeout", "The site took too long to answer")
	}
	return failure("network_error", "The site could not be reached")
}

func isRedirect(status int) bool {
	return status == 301 || status == 302 || status == 303 || status == 307 || status == 308
}

// Fetch reads one page and extracts its text. Every hop is validated and robots-checked before it is requested.
func Fetch(ctx context.Context, rawURL string, opt Options) (*Result, error) {
	opt = opt.withDefaults()
	ctx, cancel := context.WithTimeout(ctx, opt.Timeout)
	defer cancel()
	current, err := ValidateURL(rawURL)
	if err != nil {
		return nil, err
	}
	client := newClient(opt)
	result := &Result{RequestedURL: current.String(), Redirects: []string{}, Extractor: "awwo-reader/1"}
	for hop := 0; ; hop++ {
		if opt.Robots != nil {
			verdict, err := opt.Robots.check(ctx, client, current, opt)
			result.Robots = verdict
			if err != nil {
				return nil, err
			}
			if !verdict.Allowed {
				return nil, failure("robots_disallowed", "This site's robots.txt does not allow reading this page")
			}
		}
		resp, err := get(ctx, client, current, opt, pageAccept)
		if err != nil {
			return nil, err
		}
		if isRedirect(resp.StatusCode) {
			location := resp.Header.Get("Location")
			resp.Body.Close()
			if hop >= opt.MaxRedirects {
				return nil, failure("too_many_redirects", "The page redirects too many times")
			}
			next, err := current.Parse(location)
			if err != nil || location == "" {
				return nil, failure("invalid_url", "The page redirects to an invalid address")
			}
			if current, err = ValidateURL(next.String()); err != nil {
				return nil, err
			}
			result.Redirects = append(result.Redirects, current.String())
			continue
		}
		err = readResponse(ctx, resp, current, opt, result)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		return result, nil
	}
}

func readResponse(ctx context.Context, resp *http.Response, final *url.URL, opt Options, result *Result) error {
	result.FinalURL, result.Status, result.FetchedAt = final.String(), resp.StatusCode, opt.now().UTC()
	body, err := io.ReadAll(io.LimitReader(resp.Body, opt.MaxBodyBytes+1))
	if err != nil {
		return transportFailure(ctx, err)
	}
	if int64(len(body)) > opt.MaxBodyBytes {
		return failure("too_large", "The page is larger than the reader takes")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if (resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 429 || resp.StatusCode == 503) && looksLikeChallenge(body) {
			return failure("blocked_by_site_protection", "The site asked for a bot check; paste or upload the text instead")
		}
		return failure("http_status", "The site answered with status "+http.StatusText(resp.StatusCode))
	}
	if looksLikeChallenge(body) {
		return failure("blocked_by_site_protection", "The site asked for a bot check; paste or upload the text instead")
	}
	sum := sha256.Sum256(body)
	result.RawSHA256, result.RawBytes = hex.EncodeToString(sum[:]), int64(len(body))
	header := resp.Header.Get("Content-Type")
	media, params, _ := mime.ParseMediaType(header)
	if media == "" || media == "application/octet-stream" {
		media, params, _ = mime.ParseMediaType(http.DetectContentType(body))
		header = media
	}
	result.ContentType = media
	switch {
	case media == "text/html" || media == "application/xhtml+xml":
		return readHTML(body, header, final, opt, result)
	case media == "application/rss+xml" || media == "application/atom+xml" || media == "application/xml" || media == "text/xml" || strings.HasSuffix(media, "+xml"):
		return readFeed(body, final, opt, result)
	case media == "application/json" || strings.HasSuffix(media, "+json"):
		return readJSON(body, params["charset"], opt, result)
	case media == "text/plain" || media == "text/markdown" || media == "text/x-markdown":
		return readText(body, params["charset"], opt, result)
	}
	return failure("unsupported_type", "This kind of file cannot be read as text")
}

func decodeText(body []byte, label string) (string, string) {
	if label != "" {
		if enc, err := htmlindex.Get(label); err == nil {
			if decoded, err := enc.NewDecoder().Bytes(body); err == nil {
				name, _ := htmlindex.Name(enc)
				return string(decoded), name
			}
		}
	}
	return strings.ToValidUTF8(string(body), "�"), "utf-8"
}

func readHTML(body []byte, header string, final *url.URL, opt Options, result *Result) error {
	enc, name, _ := charset.DetermineEncoding(body, header)
	decoded, err := enc.NewDecoder().Bytes(body)
	if err != nil {
		return failure("decode_failed", "The page's text encoding could not be read")
	}
	result.Charset = name
	page := extractHTML(string(decoded), final, opt.MaxTextBytes)
	result.Kind, result.Title, result.Byline, result.Published, result.Lang = "article", page.Title, page.Byline, page.Published, page.Lang
	result.Links = page.Links
	return finishText(result, page.Text, opt.MaxTextBytes)
}

func readFeed(body []byte, final *url.URL, opt Options, result *Result) error {
	title, items, ok := parseFeed(body, final)
	if !ok {
		return failure("unsupported_type", "This XML document is not an RSS or Atom feed")
	}
	result.Kind, result.Title, result.Items, result.Charset = "feed", title, items, "utf-8"
	var b strings.Builder
	for _, item := range items {
		b.WriteString("- ")
		if item.Link != "" {
			b.WriteString("[" + escapeLinkText(item.Title) + "](" + item.Link + ")")
		} else {
			b.WriteString(item.Title)
		}
		if item.Published != "" {
			b.WriteString(" — " + item.Published)
		}
		if item.Summary != "" {
			b.WriteString(" — " + item.Summary)
		}
		b.WriteString("\n")
	}
	return finishText(result, b.String(), opt.MaxTextBytes)
}

// readJSON keeps the document as the site sent it. Indenting it first would let a small, deeply nested document
// grow by its depth on every line, to gigabytes, before the text limit applies.
func readJSON(body []byte, label string, opt Options, result *Result) error {
	text, name := decodeText(body, label)
	if !json.Valid([]byte(text)) {
		return failure("decode_failed", "The JSON document could not be read")
	}
	result.Kind, result.Charset = "json", name
	return finishText(result, text, opt.MaxTextBytes)
}

func readText(body []byte, label string, opt Options, result *Result) error {
	text, name := decodeText(body, label)
	result.Kind, result.Charset = "text", name
	return finishText(result, text, opt.MaxTextBytes)
}

// finishText cleans the text, cuts it to the cap on a character boundary and marks what is too short to trust.
func finishText(result *Result, text string, max int) error {
	text = cleanText(text)
	if text == "" {
		return failure("empty_content", "The page has no readable text")
	}
	if len(text) > max {
		cut := max
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text, result.Truncated = strings.TrimRight(text[:cut], " \n\t"), true
	}
	result.Text = text
	result.Unconfirmed = result.Kind == "article" && utf8.RuneCountInString(text) < 200
	return nil
}

var challengeMarkers = []string{"just a moment...", "/cdn-cgi/challenge-platform/", "cf-chl-", "attention required! | cloudflare", "performing security verification"}

// looksLikeChallenge recognises a bot-check interstitial in the first 8 KiB, so it is reported, never worked around.
func looksLikeChallenge(body []byte) bool {
	head := strings.ToLower(string(body[:min(len(body), 8192)]))
	for _, marker := range challengeMarkers {
		if strings.Contains(head, marker) {
			return true
		}
	}
	return strings.Contains(head, "captcha") && strings.Contains(head, "verify you are human")
}
