package app

import (
	"encoding/base64"
	"errors"
	"io"
	"math"
	"net"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// The management plane is deliberately separate from the application's listener.
func loopbackAddress(address string) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	n, pErr := strconv.Atoi(port)
	return err == nil && ip.IsLoopback() && pErr == nil && n >= 0 && n <= 65535
}

func (c *Config) observabilityFromEnv() error {
	for name, dst := range map[string]*bool{"AWWO_METRICS_ENABLED": &c.MetricsEnabled, "AWWO_OTEL_ENABLED": &c.OTelEnabled} {
		raw := env(name, "false")
		if raw != "true" && raw != "false" {
			return errors.New(name + " must be true or false")
		}
		*dst = raw == "true"
	}
	c.MetricsListenAddr = env("AWWO_METRICS_LISTEN_ADDR", "127.0.0.1:9101")
	c.OTelEndpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	c.OTelServiceName = env("OTEL_SERVICE_NAME", "awwo-api")
	c.OTelResourceAttributes = os.Getenv("OTEL_RESOURCE_ATTRIBUTES")
	c.OTelSampler = env("OTEL_TRACES_SAMPLER", "parentbased_traceidratio")
	ratio := "1"
	if c.Env == "production" {
		ratio = "0.05"
	}
	var err error
	c.OTelSampleRatio, err = strconv.ParseFloat(env("OTEL_TRACES_SAMPLER_ARG", ratio), 64)
	if err != nil {
		return errors.New("invalid OTEL_TRACES_SAMPLER_ARG")
	}
	c.ModelPricingJSON = os.Getenv("AWWO_MODEL_PRICING_JSON")
	c.UsageRetentionDays, err = strconv.Atoi(env("AWWO_USAGE_RETENTION_DAYS", "180"))
	if err != nil {
		return errors.New("invalid AWWO_USAGE_RETENTION_DAYS")
	}
	c.TraceRefVersion = os.Getenv("AWWO_TRACE_REF_HMAC_KEY_VERSION")
	c.TraceRefKey, err = readTraceKey(os.Getenv("AWWO_TRACE_REF_HMAC_KEY_FILE"), c.TraceRefVersion)
	if err != nil {
		return err
	}
	previous := os.Getenv("AWWO_TRACE_REF_HMAC_PREVIOUS_KEY_VERSION")
	previousKey, err := readTraceKey(os.Getenv("AWWO_TRACE_REF_HMAC_PREVIOUS_KEY_FILE"), previous)
	if err != nil {
		return err
	}
	if len(previousKey) > 0 && (len(c.TraceRefKey) == 0 || previous == c.TraceRefVersion) {
		return errors.New("trace reference previous key requires a distinct active version")
	}
	return nil
}

var traceVersionPattern = regexp.MustCompile(`^[a-z0-9._-]{1,32}$`)

func readTraceKey(path, version string) ([]byte, error) {
	if path == "" && version == "" {
		return nil, nil
	}
	if path == "" || !traceVersionPattern.MatchString(version) {
		return nil, errors.New("trace reference key file and valid version must be configured together")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot read trace reference key file")
	}
	defer file.Close()
	// Fixed-size input avoids unbounded secret-file reads. Never echo its path or contents.
	buf, err := io.ReadAll(io.LimitReader(file, 65))
	if err != nil || len(buf) > 64 {
		return nil, errors.New("invalid trace reference key file")
	}
	key, err := base64.RawURLEncoding.Strict().DecodeString(strings.TrimSpace(string(buf)))
	if err != nil || len(key) != 32 {
		return nil, errors.New("trace reference key must be 32 bytes encoded as unpadded base64url")
	}
	return key, nil
}

func (c Config) validateObservability() error {
	if c.MetricsListenAddr != "" && !loopbackAddress(c.MetricsListenAddr) {
		return errors.New("AWWO_METRICS_LISTEN_ADDR must be a literal loopback IP and valid port")
	}
	if c.MetricsEnabled && c.MetricsListenAddr == "" {
		return errors.New("AWWO_METRICS_LISTEN_ADDR is required")
	}
	if c.UsageRetentionDays != 0 && (c.UsageRetentionDays < 31 || c.UsageRetentionDays > 3650) {
		return errors.New("AWWO_USAGE_RETENTION_DAYS must be between 31 and 3650")
	}
	if _, err := ParseModelPricing(c.ModelPricingJSON); err != nil {
		return errors.New("invalid AWWO_MODEL_PRICING_JSON")
	}
	if c.OTelServiceName != "" && c.OTelServiceName != "awwo-api" {
		return errors.New("OTEL_SERVICE_NAME must be awwo-api for the API")
	}
	if c.OTelSampler != "" && c.OTelSampler != "parentbased_traceidratio" {
		return errors.New("OTEL_TRACES_SAMPLER must be parentbased_traceidratio")
	}
	if math.IsNaN(c.OTelSampleRatio) || math.IsInf(c.OTelSampleRatio, 0) || c.OTelSampleRatio < 0 || c.OTelSampleRatio > 1 {
		return errors.New("OTEL_TRACES_SAMPLER_ARG must be between 0 and 1")
	}
	for _, item := range strings.Split(c.OTelResourceAttributes, ",") {
		if item == "" {
			continue
		}
		kv := strings.SplitN(item, "=", 2)
		if len(kv) != 2 {
			return errors.New("invalid OTEL_RESOURCE_ATTRIBUTES")
		}
		switch kv[0] {
		case "deployment.environment", "deployment.environment.name":
			if kv[1] != c.Env {
				return errors.New("OTel environment must match APP_ENV")
			}
		case "service.version":
			if kv[1] != BuildRevision() {
				return errors.New("OTel version must match build revision")
			}
		default:
			return errors.New("OTEL_RESOURCE_ATTRIBUTES contains an unsupported attribute")
		}
	}
	if c.OTelEnabled || c.OTelEndpoint != "" {
		u, err := url.Parse(c.OTelEndpoint)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
			return errors.New("invalid OTEL_EXPORTER_OTLP_ENDPOINT")
		}
		host := u.Hostname()
		ip, ipErr := netip.ParseAddr(host)
		local := host == "localhost" || (ipErr == nil && ip.IsLoopback())
		internal := local || (ipErr == nil && ip.IsPrivate()) || (ipErr != nil && (strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".svc.cluster.local") || (!strings.Contains(host, ".") && host != "")))
		if !internal {
			return errors.New("OTEL_EXPORTER_OTLP_ENDPOINT must use an internal host")
		}
		if c.Env != "development" && !local && u.Scheme != "https" {
			return errors.New("OTLP requires HTTPS outside loopback in staging and production")
		}
	}
	return nil
}
