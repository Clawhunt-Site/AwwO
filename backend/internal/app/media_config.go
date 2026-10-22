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
	// Tripo (3D model nodes) runs on its own key, paid from the operator's Tripo balance, and stores its
	// files in the same AWWO_MEDIA_DIR. TripoResultHosts are where its model and preview files come from.
	TripoAPIKey      string
	TripoBaseURL     string
	TripoResultHosts []string
	// TripoFreeRunsPerDay caps one workspace's free 3D generations per UTC day; TripoFreeTotalPerDay caps
	// free 3D generations across every workspace. Paid plans spend their own credits instead.
	TripoFreeRunsPerDay  int
	TripoFreeTotalPerDay int
	// TripoAllWorkspaces offers the 3D models to every workspace, whatever its model allowlist names
	// (the daily caps above still bound what free generations cost the operator).
	TripoAllWorkspaces bool
	// X-tasy (image and video nodes, the operator's own platform) runs on its own key and stores its files in the
	// same AWWO_MEDIA_DIR; its outputs are downloaded from its API origin. XtasyAllWorkspaces offers its models to
	// every workspace, whatever its model allowlist names, within the media daily limits.
	XtasyAPIKey        string
	XtasyBaseURL       string
	XtasyAllWorkspaces bool
	// Jimeng (image and video nodes on the operator's Jimeng member account) runs through its official canvas CLI at
	// JimengCLI, signed in under JimengHome (profile JimengProfile; the CLI's recovery records in JimengStateDir), and
	// stores its files in the same AWWO_MEDIA_DIR. One generation spends at most JimengCreditCeiling Jimeng credits.
	// Its models are offered only explicitly: to JimengWorkspaces, to every workspace with JimengAllWorkspaces, or to a
	// workspace whose model allowlist names them; an unrestricted workspace alone is not enough, because it spends a
	// personal member account.
	JimengCLI           string
	JimengHome          string
	JimengProfile       string
	JimengStateDir      string
	JimengCreditCeiling int
	JimengAllWorkspaces bool
	JimengWorkspaces    []string
	// Files members attach (uploads.go) live in the same AWWO_MEDIA_DIR: at most UploadMaxBytes each,
	// UploadsPerDay a workspace each UTC day, and UploadWorkspaceBytes a workspace in total.
	UploadMaxBytes       int64
	UploadsPerDay        int
	UploadWorkspaceBytes int64
}

const (
	defaultRunningHubBaseURL = "https://www.runninghub.ai"
	defaultMediaResultHosts  = ".runninghub.ai,.runninghub.cn,rh-hk-images-1252422369.cos.ap-hongkong.myqcloud.com,rh-images-1252422369.cos.ap-beijing.myqcloud.com"
	defaultTripoBaseURL      = "https://openapi.tripo3d.ai/v3"
	defaultTripoResultHosts  = ".tripo3d.ai,.tripo3d.com"
	defaultXtasyBaseURL      = "https://service.xtasyart.com"
)

// The X-tasy API origin. The key is sent only there, and its outputs are downloaded from there.
var xtasyOrigins = map[string]bool{"https://service.xtasyart.com": true}

// The official Tripo API origin. The key is sent only there.
var tripoOrigins = map[string]bool{"https://openapi.tripo3d.ai/v3": true}

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
	c.TripoAPIKey = strings.TrimSpace(os.Getenv("AWWO_TRIPO_API_KEY"))
	c.TripoBaseURL = strings.TrimRight(env("AWWO_TRIPO_BASE_URL", defaultTripoBaseURL), "/")
	c.TripoResultHosts = nil
	for _, host := range strings.Split(env("AWWO_TRIPO_RESULT_HOSTS", defaultTripoResultHosts), ",") {
		if host = strings.ToLower(strings.TrimSpace(host)); host != "" {
			c.TripoResultHosts = append(c.TripoResultHosts, host)
		}
	}
	c.TripoFreeRunsPerDay, c.TripoFreeTotalPerDay = 2, 40
	for key, dst := range map[string]*int{"AWWO_TRIPO_FREE_RUNS_PER_DAY": &c.TripoFreeRunsPerDay, "AWWO_TRIPO_FREE_TOTAL_PER_DAY": &c.TripoFreeTotalPerDay} {
		if s := os.Getenv(key); s != "" {
			n, e := strconv.Atoi(s)
			if e != nil {
				return errors.New(key + " must be a whole number")
			}
			*dst = n
		}
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AWWO_TRIPO_ALL_WORKSPACES"))) {
	case "", "false":
	case "true":
		c.TripoAllWorkspaces = true
	default:
		return errors.New("AWWO_TRIPO_ALL_WORKSPACES must be true or false")
	}
	// Cloudflare's request body limit is 100 MB, so one upload stays below it.
	c.UploadMaxBytes, c.UploadsPerDay, c.UploadWorkspaceBytes = 64<<20, 200, 2048<<20
	if s := os.Getenv("AWWO_UPLOAD_MAX_MB"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil || n < 1 || n > 95 {
			return errors.New("AWWO_UPLOAD_MAX_MB must be between 1 and 95")
		}
		c.UploadMaxBytes = int64(n) << 20
	}
	if s := os.Getenv("AWWO_UPLOADS_PER_DAY"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil || n < 0 || n > 100000 {
			return errors.New("AWWO_UPLOADS_PER_DAY must be between 0 and 100000")
		}
		c.UploadsPerDay = n
	}
	if s := os.Getenv("AWWO_UPLOAD_WORKSPACE_MB"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil || n < 0 || n > 1<<20 {
			return errors.New("AWWO_UPLOAD_WORKSPACE_MB must be between 0 and 1048576")
		}
		c.UploadWorkspaceBytes = int64(n) << 20
	}
	c.XtasyAPIKey = strings.TrimSpace(os.Getenv("AWWO_XTASY_API_KEY"))
	c.XtasyBaseURL = strings.TrimRight(env("AWWO_XTASY_BASE_URL", defaultXtasyBaseURL), "/")
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AWWO_XTASY_ALL_WORKSPACES"))) {
	case "", "false":
	case "true":
		c.XtasyAllWorkspaces = true
	default:
		return errors.New("AWWO_XTASY_ALL_WORKSPACES must be true or false")
	}
	if err := c.jimengFromEnv(); err != nil {
		return err
	}
	return validateMediaConfig(*c)
}

func (c *Config) jimengFromEnv() error {
	c.JimengCLI = strings.TrimSpace(os.Getenv("AWWO_JIMENG_CLI"))
	c.JimengHome = strings.TrimSpace(os.Getenv("AWWO_JIMENG_HOME"))
	c.JimengProfile = env("AWWO_JIMENG_PROFILE", defaultJimengProfile)
	c.JimengStateDir = strings.TrimSpace(os.Getenv("AWWO_JIMENG_STATE_DIR"))
	if c.JimengStateDir == "" && c.JimengHome != "" {
		c.JimengStateDir = filepath.Join(c.JimengHome, "state")
	}
	c.JimengCreditCeiling = defaultJimengCeiling
	if s := os.Getenv("AWWO_JIMENG_CREDIT_CEILING"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil {
			return errors.New("AWWO_JIMENG_CREDIT_CEILING must be a whole number")
		}
		c.JimengCreditCeiling = n
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AWWO_JIMENG_ALL_WORKSPACES"))) {
	case "", "false":
	case "true":
		c.JimengAllWorkspaces = true
	default:
		return errors.New("AWWO_JIMENG_ALL_WORKSPACES must be true or false")
	}
	c.JimengWorkspaces = nil
	for _, id := range strings.Split(os.Getenv("AWWO_JIMENG_WORKSPACES"), ",") {
		if id = strings.TrimSpace(id); id != "" {
			c.JimengWorkspaces = append(c.JimengWorkspaces, id)
		}
	}
	return nil
}

func validateMediaConfig(c Config) error {
	if c.RunningHubAPIKey == "" && c.TripoAPIKey == "" && c.XtasyAPIKey == "" && c.JimengCLI == "" && c.MediaDir == "" {
		return nil
	}
	// The motion renderer (renders.go) and canvas uploads (uploads.go) also store their files in AWWO_MEDIA_DIR, so a
	// deployment may set the directory with no generator at all; its storage settings are checked all the same.
	if c.MediaDir == "" {
		switch {
		case c.TripoAPIKey != "":
			return errors.New("AWWO_TRIPO_API_KEY needs AWWO_MEDIA_DIR: generated models are stored there")
		case c.XtasyAPIKey != "":
			return errors.New("AWWO_XTASY_API_KEY needs AWWO_MEDIA_DIR: generated images and videos are stored there")
		case c.JimengCLI != "":
			return errors.New("AWWO_JIMENG_CLI needs AWWO_MEDIA_DIR: generated images and videos are stored there")
		}
		return errors.New("AWWO_RUNNINGHUB_API_KEY and AWWO_MEDIA_DIR must be set together")
	}
	if c.TripoAPIKey != "" {
		if err := validateTripoConfig(c); err != nil {
			return err
		}
	}
	if c.XtasyAPIKey != "" {
		if err := validateXtasyConfig(c); err != nil {
			return err
		}
	}
	if c.JimengCLI != "" {
		if err := validateJimengConfig(c); err != nil {
			return err
		}
	}
	if c.RunningHubAPIKey == "" {
		return validateMediaStorage(c)
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
	return validateMediaStorage(c)
}

// validateTripoConfig checks the 3D provider's own settings: the key's shape, its single API origin, where
// its files may come from, and the free-generation caps that bound what the operator's balance pays.
func validateTripoConfig(c Config) error {
	if len(c.TripoAPIKey) < 16 || len(c.TripoAPIKey) > 512 {
		return errors.New("invalid AWWO_TRIPO_API_KEY")
	}
	for _, ch := range c.TripoAPIKey {
		if ch < 33 || ch > 126 {
			return errors.New("invalid AWWO_TRIPO_API_KEY")
		}
	}
	if !tripoOrigins[c.TripoBaseURL] && !(c.Env == "development" && loopbackOrigin(c.TripoBaseURL)) {
		return errors.New("AWWO_TRIPO_BASE_URL must be https://openapi.tripo3d.ai/v3")
	}
	if c.TripoFreeRunsPerDay < 0 || c.TripoFreeRunsPerDay > 1000 {
		return errors.New("AWWO_TRIPO_FREE_RUNS_PER_DAY must be between 0 and 1000")
	}
	if c.TripoFreeTotalPerDay < 0 || c.TripoFreeTotalPerDay > 100000 {
		return errors.New("AWWO_TRIPO_FREE_TOTAL_PER_DAY must be between 0 and 100000")
	}
	if len(c.TripoResultHosts) == 0 || len(c.TripoResultHosts) > 16 {
		return errors.New("AWWO_TRIPO_RESULT_HOSTS must list 1-16 host suffixes")
	}
	for _, host := range c.TripoResultHosts {
		name := strings.TrimPrefix(host, ".")
		if !resultHostName.MatchString(name) || (strings.HasPrefix(host, ".") && strings.Count(host, ".") < 2) {
			return errors.New("AWWO_TRIPO_RESULT_HOSTS entries must be host names or domain suffixes such as .tripo3d.ai")
		}
	}
	return nil
}

// validateXtasyConfig checks the X-tasy key's shape and its single API origin, where the key is sent and where
// outputs are downloaded from.
func validateXtasyConfig(c Config) error {
	if len(c.XtasyAPIKey) < 16 || len(c.XtasyAPIKey) > 512 {
		return errors.New("invalid AWWO_XTASY_API_KEY")
	}
	for _, ch := range c.XtasyAPIKey {
		if ch < 33 || ch > 126 {
			return errors.New("invalid AWWO_XTASY_API_KEY")
		}
	}
	if !xtasyOrigins[c.XtasyBaseURL] && !(c.Env == "development" && loopbackOrigin(c.XtasyBaseURL)) {
		return errors.New("AWWO_XTASY_BASE_URL must be https://service.xtasyart.com")
	}
	return nil
}

// validateJimengConfig checks the Jimeng CLI's settings: absolute, clean paths for the binary, its sign-in home and
// its records (never inside AWWO_MEDIA_DIR, which the API serves files from), a profile name the CLI accepts, a
// credit ceiling, and workspace ids of the shape AwwO makes.
func validateJimengConfig(c Config) error {
	clean := func(p string) bool { return filepath.IsAbs(p) && filepath.Clean(p) == p }
	if !clean(c.JimengCLI) {
		return errors.New("AWWO_JIMENG_CLI must be an absolute, clean path to dreamina-canvas")
	}
	if c.JimengHome == "" || !clean(c.JimengHome) || !clean(c.JimengStateDir) {
		return errors.New("AWWO_JIMENG_HOME (and AWWO_JIMENG_STATE_DIR when set) must be absolute, clean paths")
	}
	for _, dir := range []string{c.JimengHome, c.JimengStateDir} {
		if rel, err := filepath.Rel(c.MediaDir, dir); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("AWWO_JIMENG_HOME and AWWO_JIMENG_STATE_DIR must be outside AWWO_MEDIA_DIR: the sign-in is not a media file")
		}
	}
	if !jimengProfileName.MatchString(c.JimengProfile) {
		return errors.New("AWWO_JIMENG_PROFILE must be 1-40 lowercase letters, digits, - or _")
	}
	if c.JimengCreditCeiling < 1 || c.JimengCreditCeiling > 20000 {
		return errors.New("AWWO_JIMENG_CREDIT_CEILING must be between 1 and 20000")
	}
	if len(c.JimengWorkspaces) > 64 {
		return errors.New("AWWO_JIMENG_WORKSPACES lists at most 64 workspaces")
	}
	for _, id := range c.JimengWorkspaces {
		if !jimengWorkspaceID.MatchString(id) {
			return errors.New("AWWO_JIMENG_WORKSPACES must list workspace ids separated by commas")
		}
	}
	return nil
}

// validateMediaStorage checks what every media provider shares: where files are kept and how runs are bounded.
func validateMediaStorage(c Config) error {
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

// loopbackOrigin is exactly http://127.0.0.1:<port>: a port of 1–65535 written without leading zeros (the dial
// checks compare it as text), and no credentials, path, query or fragment.
func loopbackOrigin(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	port, err := strconv.Atoi(u.Port())
	return u.Scheme == "http" && u.User == nil && u.Opaque == "" && u.Hostname() == "127.0.0.1" &&
		err == nil && port >= 1 && port <= 65535 && strconv.Itoa(port) == u.Port() &&
		u.Path == "" && u.RawQuery == "" && u.Fragment == "" && !strings.HasSuffix(raw, "?") && !strings.HasSuffix(raw, "#")
}

func (c Config) runningHubConfigured() bool { return c.RunningHubAPIKey != "" && c.MediaDir != "" }
func (c Config) tripoConfigured() bool      { return c.TripoAPIKey != "" && c.MediaDir != "" }
func (c Config) xtasyConfigured() bool      { return c.XtasyAPIKey != "" && c.MediaDir != "" }
func (c Config) jimengConfigured() bool     { return c.JimengCLI != "" && c.MediaDir != "" }

// jimengWorkspace reports whether the operator named workspace tid in AWWO_JIMENG_WORKSPACES.
func (c Config) jimengWorkspace(tid string) bool {
	for _, id := range c.JimengWorkspaces {
		if tid != "" && id == tid {
			return true
		}
	}
	return false
}

// mediaConfigured: some media provider (image and video, or 3D) can run.
func (c Config) mediaConfigured() bool {
	return c.runningHubConfigured() || c.tripoConfigured() || c.xtasyConfigured() || c.jimengConfigured()
}

// mediaProviderConfigured: the provider a catalog model names has its key and storage.
func (c Config) mediaProviderConfigured(provider string) bool {
	switch provider {
	case mediaProviderRunningHub:
		return c.runningHubConfigured()
	case mediaProviderTripo:
		return c.tripoConfigured()
	case mediaProviderXtasy:
		return c.xtasyConfigured()
	case mediaProviderJimeng:
		return c.jimengConfigured()
	}
	return false
}

// isMediaModelID reports whether a model id names a media generator: RunningHub's "rh.", Tripo's "tripo.", X-tasy's
// "xt." or Jimeng's "jm." ids.
func isMediaModelID(id string) bool {
	return strings.HasPrefix(id, "rh.") || strings.HasPrefix(id, "tripo.") || strings.HasPrefix(id, "xt.") || strings.HasPrefix(id, "jm.")
}

// validateMediaExposure runs once every setting is read. Generations are paid from the operator's
// key, so offering media to every unrestricted, every new or (for 3D) every workspace is refused
// unless the number of workspaces an account may own is capped: otherwise each new workspace is a
// fresh daily limit.
func validateMediaExposure(c Config) error {
	if !c.mediaConfigured() || c.MaxOwnedWorkspaces > 0 {
		return nil
	}
	if c.MediaUnrestrictedWorkspaces {
		return errors.New("AWWO_MEDIA_UNRESTRICTED_WORKSPACES requires AWWO_MAX_OWNED_WORKSPACES")
	}
	if c.TripoAllWorkspaces && c.tripoConfigured() {
		return errors.New("AWWO_TRIPO_ALL_WORKSPACES requires AWWO_MAX_OWNED_WORKSPACES")
	}
	if c.XtasyAllWorkspaces && c.xtasyConfigured() {
		return errors.New("AWWO_XTASY_ALL_WORKSPACES requires AWWO_MAX_OWNED_WORKSPACES")
	}
	if c.JimengAllWorkspaces && c.jimengConfigured() {
		return errors.New("AWWO_JIMENG_ALL_WORKSPACES requires AWWO_MAX_OWNED_WORKSPACES")
	}
	if c.NewWorkspaceModels.allowed != nil {
		for _, id := range *c.NewWorkspaceModels.allowed {
			if isMediaModelID(id) {
				return errors.New("AWWO_NEW_WORKSPACE_ALLOWED_MODELS may name media models only with AWWO_MAX_OWNED_WORKSPACES")
			}
		}
	}
	return nil
}
