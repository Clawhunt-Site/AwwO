package app

import (
	"errors"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	MetricsEnabled, OTelEnabled                                                           bool
	MetricsListenAddr, OTelEndpoint, OTelServiceName, OTelResourceAttributes, OTelSampler string
	OTelSampleRatio                                                                       float64
	TraceRefKey                                                                           []byte
	TraceRefVersion                                                                       string
	ModelPricingJSON                                                                      string
	UsageRetentionDays                                                                    int
	Env, DatabaseURL, ListenAddr, PublicOrigin, PIURL, PIToken, AdminEmail, AdminPassword string
	OpenAIAgentsURL, OpenAIAgentsToken                                                    string
	SessionTTL, RunTimeout                                                                time.Duration
	PIAdmissionWait                                                                       time.Duration
	MaxBodyBytes                                                                          int64
	AuthRequestsPerMinute                                                                 int
	TrustedProxyCIDRs                                                                     []netip.Prefix
}

func ConfigFromEnv() (Config, error) {
	c := Config{Env: env("APP_ENV", "development"), DatabaseURL: os.Getenv("AWWO_DATABASE_URL"), ListenAddr: env("AWWO_LISTEN_ADDR", "127.0.0.1:8087"), PublicOrigin: env("AWWO_PUBLIC_ORIGIN", "http://127.0.0.1:5189"), PIURL: env("AWWO_PI_URL", "http://127.0.0.1:8097"), PIToken: os.Getenv("AWWO_PI_TOKEN"), AdminEmail: os.Getenv("AWWO_BOOTSTRAP_ADMIN_EMAIL"), AdminPassword: os.Getenv("AWWO_BOOTSTRAP_ADMIN_PASSWORD"), SessionTTL: 24 * time.Hour, RunTimeout: 180 * time.Second, MaxBodyBytes: 2 << 20, AuthRequestsPerMinute: 10}
	c.PIAdmissionWait = 5 * time.Second
	c.OpenAIAgentsURL, c.OpenAIAgentsToken = os.Getenv("AWWO_OPENAI_AGENTS_URL"), os.Getenv("AWWO_OPENAI_AGENTS_TOKEN")
	for key, dst := range map[string]*time.Duration{"AWWO_SESSION_TTL": &c.SessionTTL, "AWWO_RUN_TIMEOUT": &c.RunTimeout, "AWWO_PI_SESSION_WAIT": &c.PIAdmissionWait} {
		if s := os.Getenv(key); s != "" {
			v, e := time.ParseDuration(s)
			if e != nil || v <= 0 {
				return c, errors.New(key + " must be a positive duration")
			}
			*dst = v
		}
	}
	if s := os.Getenv("AWWO_AUTH_REQUESTS_PER_MINUTE"); s != "" {
		v, e := strconv.Atoi(s)
		if e != nil || v < 1 || v > 1000 {
			return c, errors.New("invalid AWWO_AUTH_REQUESTS_PER_MINUTE")
		}
		c.AuthRequestsPerMinute = v
	}
	for _, s := range strings.Split(os.Getenv("AWWO_TRUSTED_PROXY_CIDRS"), ",") {
		if strings.TrimSpace(s) == "" {
			continue
		}
		p, e := netip.ParsePrefix(strings.TrimSpace(s))
		if e != nil {
			return c, errors.New("invalid AWWO_TRUSTED_PROXY_CIDRS")
		}
		c.TrustedProxyCIDRs = append(c.TrustedProxyCIDRs, p)
	}
	if err := c.observabilityFromEnv(); err != nil {
		return c, err
	}
	return c, c.Validate()
}
func env(k, d string) string {
	if s := os.Getenv(k); s != "" {
		return s
	}
	return d
}
func (c Config) Validate() error {
	if c.Env != "development" && c.Env != "staging" && c.Env != "production" {
		return errors.New("APP_ENV must be development, staging or production")
	}
	if c.DatabaseURL == "" {
		return errors.New("AWWO_DATABASE_URL is required")
	}
	if _, e := net.ResolveTCPAddr("tcp", c.ListenAddr); e != nil {
		return errors.New("invalid AWWO_LISTEN_ADDR")
	}
	u, e := url.Parse(c.PublicOrigin)
	if e != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("AWWO_PUBLIC_ORIGIN must be an exact HTTP origin")
	}
	if c.Env != "development" && u.Scheme != "https" {
		return errors.New("HTTPS public origin required outside development")
	}
	p, e := url.Parse(c.PIURL)
	if e != nil || p.Host == "" || p.User != nil || p.RawQuery != "" || p.Fragment != "" || (p.Scheme != "http" && p.Scheme != "https") {
		return errors.New("invalid AWWO_PI_URL")
	}
	if (c.AdminEmail == "") != (c.AdminPassword == "") {
		return errors.New("both bootstrap admin email and password are required")
	}
	if c.AdminPassword != "" && (len(c.AdminPassword) < 12 || len(c.AdminPassword) > 1024) {
		return errors.New("bootstrap admin password must contain 12 to 1024 bytes")
	}
	if c.PIToken != "" && len(c.PIToken) < 32 {
		return errors.New("AWWO_PI_TOKEN must be at least 32 characters")
	}
	if (c.OpenAIAgentsURL == "") != (c.OpenAIAgentsToken == "") {
		return errors.New("AWWO_OPENAI_AGENTS_URL and AWWO_OPENAI_AGENTS_TOKEN must be configured together")
	}
	if c.OpenAIAgentsURL != "" {
		u, e := url.Parse(c.OpenAIAgentsURL)
		if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
			return errors.New("invalid AWWO_OPENAI_AGENTS_URL")
		}
		if len(c.OpenAIAgentsToken) < 32 || strings.ContainsAny(c.OpenAIAgentsToken, "\r\n") {
			return errors.New("AWWO_OPENAI_AGENTS_TOKEN must be at least 32 characters")
		}
	}
	if strings.Contains(c.PublicOrigin, "example.com") && c.Env != "development" {
		return errors.New("replace the public origin placeholder")
	}
	return c.validateObservability()
}
