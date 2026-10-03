package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// RunningHub's Standard Model API is task based: submit a request, receive a task id, query it
// until it succeeds or fails, then fetch the result files. The key is sent only to the configured
// API origin; result files come from RunningHub's storage and are fetched through a client that
// refuses anything but public addresses on the allowed hosts.

const (
	rhResponseLimit = 1 << 20
	rhMaxResults    = 8
	rhSubmitTimeout = 30 * time.Second
)

type rhResult struct {
	URL        string `json:"url"`
	OutputType string `json:"outputType"`
}

type rhTask struct {
	TaskID  string
	Status  string
	Code    string
	Results []rhResult
}

// rhError is a provider failure reduced to a closed code; RunningHub's message text is never
// stored or shown because it can echo prompt content or account details.
type rhError struct {
	Code      string
	Transient bool
}

func (e *rhError) Error() string { return e.Code }

type runningHub struct {
	base    string
	key     string
	api     *http.Client
	files   *http.Client
	hosts   []string
	maxFile int64
}

func newRunningHub(c Config) *runningHub {
	h := &runningHub{base: c.RunningHubBaseURL, key: c.RunningHubAPIKey, hosts: c.MediaResultHosts, maxFile: c.MediaMaxFileBytes}
	h.api = &http.Client{Timeout: 30 * time.Second, Transport: apiTransport(c), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	h.files = &http.Client{Timeout: 0, Transport: publicOnlyTransport(c), CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !h.allowedResultURL(req.URL) {
			return errors.New("result redirect refused")
		}
		return nil
	}}
	return h
}

// publicOnlyTransport dials only public unicast addresses. The check runs on the address being
// connected, after name resolution, so a host that resolves to a private address (or is
// re-bound to one) is refused. Proxy variables are never consulted; a development deployment
// behind a local proxy names it explicitly (AWWO_MEDIA_DEV_PROXY), and only that one loopback
// address is dialed besides public ones.
func publicOnlyTransport(c Config) *http.Transport {
	var proxy *url.URL
	if c.Env == "development" && c.MediaDevProxy != "" {
		proxy, _ = url.Parse(c.MediaDevProxy)
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second, Control: func(network, address string, _ syscall.RawConn) error {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		if proxy != nil && host == proxy.Hostname() && port == proxy.Port() {
			return nil
		}
		addr, err := netip.ParseAddr(host)
		if err != nil || !publicAddress(addr) {
			return errors.New("refusing to connect to a non-public address")
		}
		return nil
	}}
	transport := &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 60 * time.Second,
		MaxIdleConns: 8, IdleConnTimeout: 60 * time.Second, ForceAttemptHTTP2: true}
	if proxy != nil {
		transport.Proxy = http.ProxyURL(proxy)
	}
	return transport
}

// apiTransport carries the key: no proxy variables are consulted, and only an explicit development
// proxy is used, never for a local fake API.
func apiTransport(c Config) *http.Transport {
	transport := &http.Transport{DialContext: (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 15 * time.Second, MaxIdleConns: 8, IdleConnTimeout: 60 * time.Second, ForceAttemptHTTP2: true}
	if c.Env == "development" && c.MediaDevProxy != "" {
		if proxy, err := url.Parse(c.MediaDevProxy); err == nil {
			transport.Proxy = func(req *http.Request) (*url.URL, error) {
				if req.URL.Hostname() == "127.0.0.1" {
					return nil, nil
				}
				return proxy, nil
			}
		}
	}
	return transport
}

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func publicAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsInterfaceLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

// allowedResultURL accepts https on the default port, without credentials, on an allowed host:
// an entry starting with a dot allows that domain's subdomains, any other entry exactly one host.
func (h *runningHub) allowedResultURL(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Port() != "" && u.Port() != "443" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, entry := range h.hosts {
		if strings.HasPrefix(entry, ".") && strings.HasSuffix(host, entry) && len(host) > len(entry) || host == entry {
			return true
		}
	}
	return false
}

// submit starts a task. A request the provider never received fails as transient; anything it
// answered is reduced to its task or a closed error code.
func (h *runningHub) submit(ctx context.Context, endpoint string, body map[string]any) (rhTask, error) {
	return h.call(ctx, endpoint, body)
}

func (h *runningHub) query(ctx context.Context, taskID string) (rhTask, error) {
	return h.call(ctx, "/openapi/v2/query", map[string]any{"taskId": taskID})
}

func (h *runningHub) call(ctx context.Context, path string, body map[string]any) (rhTask, error) {
	if ctx.Err() != nil {
		return rhTask{}, ctx.Err()
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.base+path, bytes.NewReader(raw))
	if err != nil {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	req.Header.Set("Authorization", "Bearer "+h.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.api.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return rhTask{}, ctx.Err()
		}
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, rhResponseLimit+1))
	if err != nil || len(data) > rhResponseLimit {
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return rhTask{}, &rhError{Code: "media_provider_unauthorized"}
	case resp.StatusCode == 429:
		return rhTask{}, &rhError{Code: "media_provider_busy", Transient: true}
	case resp.StatusCode >= 500:
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	case resp.StatusCode != 200:
		return rhTask{}, &rhError{Code: "media_failed"}
	}
	return parseRHTask(data)
}

// parseRHTask reads a task answer, either bare or wrapped once in {code, msg, data}.
func parseRHTask(data []byte) (rhTask, error) {
	return parseRHTaskLevel(data, true)
}

func parseRHTaskLevel(data []byte, unwrap bool) (rhTask, error) {
	var v struct {
		TaskID       json.RawMessage `json:"taskId"`
		Status       string          `json:"status"`
		ErrorCode    json.RawMessage `json:"errorCode"`
		Code         json.RawMessage `json:"code"`
		Results      []rhResult      `json:"results"`
		Data         json.RawMessage `json:"data"`
		ErrorMessage string          `json:"errorMessage"`
	}
	if json.Unmarshal(data, &v) != nil {
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	// The wrapped shape ({code, msg, data}) carries the task in data, one level deep only.
	if len(v.Data) > 0 && string(v.Data) != "null" && len(v.TaskID) == 0 {
		if code := numericCode(v.Code); code != "" && code != "0" && code != "200" {
			return rhTask{}, rhCodeError(code)
		}
		if !unwrap {
			return rhTask{}, &rhError{Code: "media_provider_unavailable"}
		}
		return parseRHTaskLevel(v.Data, false)
	}
	task := rhTask{TaskID: stringOrNumber(v.TaskID), Status: strings.ToUpper(strings.TrimSpace(v.Status)), Code: numericCode(v.ErrorCode)}
	if task.Code == "" {
		if code := numericCode(v.Code); code != "0" && code != "200" {
			task.Code = code
		}
	}
	if task.Code != "" && task.Status != "SUCCESS" {
		return task, rhCodeError(task.Code)
	}
	if len(v.Results) > rhMaxResults {
		v.Results = v.Results[:rhMaxResults]
	}
	task.Results = v.Results
	if len(task.TaskID) > 64 || strings.ContainsAny(task.TaskID, "/?#\\ \t\r\n") {
		return rhTask{}, &rhError{Code: "media_provider_unavailable"}
	}
	switch task.Status {
	case "QUEUED", "RUNNING", "SUCCESS":
	case "FAILED":
		return task, &rhError{Code: "media_failed"}
	case "":
		if task.TaskID == "" {
			return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
		}
		task.Status = "QUEUED"
	default:
		return task, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	return task, nil
}

func stringOrNumber(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}

func numericCode(raw json.RawMessage) string {
	code := stringOrNumber(raw)
	if _, err := strconv.Atoi(code); err != nil {
		return ""
	}
	return code
}

// rhCodeError maps RunningHub's documented error codes onto closed AwwO codes.
func rhCodeError(code string) error {
	switch code {
	case "412", "801", "802", "806", "811", "1002", "1014":
		return &rhError{Code: "media_provider_unauthorized"}
	case "416", "812":
		return &rhError{Code: "media_provider_balance"}
	case "415", "421", "1003", "1010", "1011":
		return &rhError{Code: "media_provider_busy", Transient: true}
	case "433", "1501", "1505":
		return &rhError{Code: "media_content_rejected"}
	case "301", "1001", "1007", "1008", "1013":
		return &rhError{Code: "media_params_invalid"}
	case "1006", "1504":
		return &rhError{Code: "media_timeout"}
	case "423", "807", "1004":
		return &rhError{Code: "media_task_missing"}
	case "804", "813":
		// "Task running / queued": not a failure, the caller keeps polling.
		return &rhError{Code: "media_pending", Transient: true}
	}
	return &rhError{Code: "media_failed"}
}

// download streams one result file into w, refusing a host outside the allowlist, a non-public
// address, or a body larger than the configured limit.
func (h *runningHub) download(ctx context.Context, raw string, w io.Writer) (int64, error) {
	u, err := url.Parse(raw)
	if err != nil || !h.allowedResultURL(u) {
		return 0, &rhError{Code: "media_result_refused"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, &rhError{Code: "media_result_refused"}
	}
	resp, err := h.files.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, &rhError{Code: "media_result_unavailable", Transient: resp.StatusCode >= 500}
	}
	if resp.ContentLength > h.maxFile {
		return 0, &rhError{Code: "media_result_too_large"}
	}
	n, err := io.Copy(w, io.LimitReader(resp.Body, h.maxFile+1))
	if err != nil {
		return n, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	if n > h.maxFile {
		return n, &rhError{Code: "media_result_too_large"}
	}
	return n, nil
}

func (e *rhError) is(code string) bool { return e != nil && e.Code == code }

func asRHError(err error) (*rhError, bool) {
	var target *rhError
	ok := errors.As(err, &target)
	return target, ok
}

func (t rhTask) String() string { return fmt.Sprintf("task %s %s", t.TaskID, t.Status) }
