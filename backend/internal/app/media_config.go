package app

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Media generation (image and video nodes) runs through RunningHub's Standard Model API, which
// accepts only Enterprise-Shared API keys. It is off until both a key and a storage directory
// are configured: generated files are kept on this host's disk, outside PostgreSQL.
type mediaSettings struct {
	RunningHubAPIKey  string
	RunningHubBaseURL string
	MediaDir          string
	MediaTimeout      time.Duration
	MediaPollInterval time.Duration
	MediaRunsPerDay   int
	// MediaTotalRunsPerDay caps admitted generations across every workspace each UTC day.
	MediaTotalRunsPerDay int
	MediaMaxFileBytes    int64
	// MediaMinFreeBytes is the free space the media filesystem keeps: no generation is admitted, and
	// no result written, below it.
	MediaMinFreeBytes int64
	// MediaUnrestrictedWorkspaces lets workspaces without a model allowlist use media models.
	MediaUnrestrictedWorkspaces bool
	// MediaDevProxy is an explicit local proxy for result downloads, development only.
	MediaDevProxy string
	// MediaResultHosts are where a result file may be downloaded from: ".domain" allows its
	// subdomains, any other entry exactly that host. RunningHub serves results from its own domains
	// and its Tencent COS buckets: a real runninghub.ai generation (2026-10-03) came from the Hong
	// Kong bucket; the Beijing one is the bucket RunningHub's documentation names.
	MediaResultHosts []string
}

const (
	defaultRunningHubBaseURL = "https://www.runninghub.ai"
	defaultMediaResultHosts  = ".runninghub.ai,.runninghub.cn,rh-hk-images-1252422369.cos.ap-hongkong.myqcloud.com,rh-images-1252422369.cos.ap-beijing.myqcloud.com"
)

// The two official RunningHub API origins. The key is sent only to one of them.
var runningHubOrigins = map[string]bool{"https://www.runninghub.ai": true, "https://www.runninghub.cn": true}

func (c *Config) mediaFromEnv() error {
	c.RunningHubAPIKey = strings.TrimSpace(os.Getenv("AWWO_RUNNINGHUB_API_KEY"))
	c.RunningHubBaseURL = strings.TrimRight(env("AWWO_RUNNINGHUB_BASE_URL", defaultRunningHubBaseURL), "/")
	c.MediaDir = strings.TrimSpace(os.Getenv("AWWO_MEDIA_DIR"))
	c.MediaTimeout = 20 * time.Minute
	c.MediaPollInterval = 5 * time.Second
	c.MediaRunsPerDay = 30
	c.MediaTotalRunsPerDay = 500
	c.MediaMaxFileBytes = 300 << 20
	c.MediaMinFreeBytes = 2048 << 20
	c.MediaDevProxy = strings.TrimSpace(os.Getenv("AWWO_MEDIA_DEV_PROXY"))
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AWWO_MEDIA_UNRESTRICTED_WORKSPACES"))) {
	case "", "false":
	case "true":
		c.MediaUnrestrictedWorkspaces = true
	default:
		return errors.New("AWWO_MEDIA_UNRESTRICTED_WORKSPACES must be true or false")
	}
	if s := os.Getenv("AWWO_MEDIA_MIN_FREE_MB"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil || n < 0 || n > 1<<20 {
			return errors.New("AWWO_MEDIA_MIN_FREE_MB must be between 0 and 1048576")
		}
		c.MediaMinFreeBytes = int64(n) << 20
	}
	for key, dst := range map[string]*time.Duration{"AWWO_MEDIA_TIMEOUT": &c.MediaTimeout, "AWWO_MEDIA_POLL_INTERVAL": &c.MediaPollInterval} {
		if s := os.Getenv(key); s != "" {
			v, e := time.ParseDuration(s)
			if e != nil || v <= 0 {
				return errors.New(key + " must be a positive duration")
			}
			*dst = v
		}
	}
	if s := os.Getenv("AWWO_MEDIA_RUNS_PER_DAY"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil {
			return errors.New("AWWO_MEDIA_RUNS_PER_DAY must be a whole number")
		}
		c.MediaRunsPerDay = n
	}
	if s := os.Getenv("AWWO_MEDIA_TOTAL_RUNS_PER_DAY"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil {
			return errors.New("AWWO_MEDIA_TOTAL_RUNS_PER_DAY must be a whole number")
		}
		c.MediaTotalRunsPerDay = n
	}
	if s := os.Getenv("AWWO_MEDIA_MAX_FILE_MB"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil || n < 1 || n > 2047 {
			return errors.New("AWWO_MEDIA_MAX_FILE_MB must be between 1 and 2047")
		}
		c.MediaMaxFileBytes = int64(n) << 20
	}
	c.MediaResultHosts = nil
	for _, host := range strings.Split(env("AWWO_MEDIA_RESULT_HOSTS", defaultMediaResultHosts), ",") {
		if host = strings.ToLower(strings.TrimSpace(host)); host != "" {
			c.MediaResultHosts = append(c.MediaResultHosts, host)
		}
	}
	return validateMediaConfig(*c)
}

func validateMediaConfig(c Config) error {
	if c.RunningHubAPIKey == "" && c.MediaDir == "" {
		return nil
	}
	if (c.RunningHubAPIKey == "") != (c.MediaDir == "") {
		return errors.New("AWWO_RUNNINGHUB_API_KEY and AWWO_MEDIA_DIR must be set together")
	}
	if len(c.RunningHubAPIKey) < 16 || len(c.RunningHubAPIKey) > 512 {
		return errors.New("invalid AWWO_RUNNINGHUB_API_KEY")
	}
	for _, ch := range c.RunningHubAPIKey {
		if ch < 33 || ch > 126 {
			return errors.New("invalid AWWO_RUNNINGHUB_API_KEY")
		}
	}
	if !runningHubOrigins[c.RunningHubBaseURL] && !(c.Env == "development" && loopbackOrigin(c.RunningHubBaseURL)) {
		return errors.New("AWWO_RUNNINGHUB_BASE_URL must be https://www.runninghub.ai or https://www.runninghub.cn")
	}
	if c.MediaDevProxy != "" && (c.Env != "development" || !loopbackOrigin(c.MediaDevProxy)) {
		return errors.New("AWWO_MEDIA_DEV_PROXY is a development setting and must be http://127.0.0.1:<port>")
	}
	if c.MediaMinFreeBytes < 0 {
		return errors.New("AWWO_MEDIA_MIN_FREE_MB must not be negative")
	}
	if !filepath.IsAbs(c.MediaDir) || filepath.Clean(c.MediaDir) != c.MediaDir {
		return errors.New("AWWO_MEDIA_DIR must be an absolute, clean path")
	}
	if c.MediaTimeout < time.Minute || c.MediaTimeout > 2*time.Hour || c.MediaPollInterval < 100*time.Millisecond || c.MediaPollInterval > time.Minute {
		return errors.New("AWWO_MEDIA_TIMEOUT must be 1m-2h and AWWO_MEDIA_POLL_INTERVAL 100ms-1m")
	}
	if c.MediaRunsPerDay < 0 || c.MediaRunsPerDay > 10000 {
		return errors.New("AWWO_MEDIA_RUNS_PER_DAY must be between 0 and 10000")
	}
	if c.MediaTotalRunsPerDay < 0 || c.MediaTotalRunsPerDay > 1000000 {
		return errors.New("AWWO_MEDIA_TOTAL_RUNS_PER_DAY must be between 0 and 1000000")
	}
	// artifacts.size is a 32-bit integer.
	if c.MediaMaxFileBytes < 1<<20 || c.MediaMaxFileBytes > 2047<<20 {
		return errors.New("AWWO_MEDIA_MAX_FILE_MB must be between 1 and 2047")
	}
	if len(c.MediaResultHosts) == 0 || len(c.MediaResultHosts) > 16 {
		return errors.New("AWWO_MEDIA_RESULT_HOSTS must list 1-16 host suffixes")
	}
	for _, host := range c.MediaResultHosts {
		name := strings.TrimPrefix(host, ".")
		if !resultHostName.MatchString(name) || (strings.HasPrefix(host, ".") && strings.Count(host, ".") < 2) {
			return errors.New("AWWO_MEDIA_RESULT_HOSTS entries must be host names or domain suffixes such as .runninghub.ai")
		}
	}
	return nil
}

var resultHostName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// loopbackOrigin is exactly http://127.0.0.1:<port>: no credentials, path, query or fragment.
func loopbackOrigin(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && u.User == nil && u.Opaque == "" && u.Hostname() == "127.0.0.1" && u.Port() != "" &&
		u.Path == "" && u.RawQuery == "" && u.Fragment == "" && !strings.HasSuffix(raw, "?") && !strings.HasSuffix(raw, "#")
}

func (c Config) mediaConfigured() bool { return c.RunningHubAPIKey != "" && c.MediaDir != "" }

// validateMediaExposure runs once every setting is read. Generations are paid from the operator's
// key, so offering media to every unrestricted or every new workspace is refused unless the number
// of workspaces an account may own is capped: otherwise each new workspace is a fresh daily limit.
func validateMediaExposure(c Config) error {
	if !c.mediaConfigured() || c.MaxOwnedWorkspaces > 0 {
		return nil
	}
	if c.MediaUnrestrictedWorkspaces {
		return errors.New("AWWO_MEDIA_UNRESTRICTED_WORKSPACES requires AWWO_MAX_OWNED_WORKSPACES")
	}
	if c.NewWorkspaceModels.allowed != nil {
		for _, id := range *c.NewWorkspaceModels.allowed {
			if strings.HasPrefix(id, "rh.") {
				return errors.New("AWWO_NEW_WORKSPACE_ALLOWED_MODELS may name media models only with AWWO_MAX_OWNED_WORKSPACES")
			}
		}
	}
	return nil
}
