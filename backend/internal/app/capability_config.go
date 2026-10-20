package app

import (
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// capabilitySettings configures the web reader (webread_import.go), the skill registry (skill_registry.go), the
// motion renderer (renders.go) and edits (edits.go, on the same render worker). All are off unless configured: the
// reader needs AWWO_WEB_READER=on, the registry AWWO_SKILL_REGISTRY=on, the renderer and edits the worker's URL and token.
type capabilitySettings struct {
	WebReaderEnabled     bool
	WebReadsPerDay       int
	WebReadsSitePerDay   int
	SkillRegistryEnabled bool
	RenderURL            string
	RenderToken          string
	RendersPerDay        int
	RendersSitePerDay    int
	RenderTimeout        time.Duration
	// An edit may wait EditQueueWait for the worker (a render or another edit holds it) and render for EditTimeout.
	EditsPerDay      int
	EditsTotalPerDay int
	EditTimeout      time.Duration
	EditQueueWait    time.Duration
}

func positiveEnvInt(key string, fallback, max int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 1 || v > max {
		return 0, errors.New(key + " must be an integer between 1 and " + strconv.Itoa(max))
	}
	return v, nil
}

func (c *Config) capabilityFromEnv() error {
	switch os.Getenv("AWWO_WEB_READER") {
	case "", "off":
	case "on":
		c.WebReaderEnabled = true
	default:
		return errors.New("AWWO_WEB_READER must be on or off")
	}
	switch os.Getenv("AWWO_SKILL_REGISTRY") {
	case "", "off":
	case "on":
		c.SkillRegistryEnabled = true
	default:
		return errors.New("AWWO_SKILL_REGISTRY must be on or off")
	}
	var err error
	if c.WebReadsPerDay, err = positiveEnvInt("AWWO_WEB_READS_PER_DAY", 30, 10000); err != nil {
		return err
	}
	if c.WebReadsSitePerDay, err = positiveEnvInt("AWWO_WEB_READS_SITE_PER_DAY", 2000, 1000000); err != nil {
		return err
	}
	c.RenderURL, c.RenderToken = strings.TrimSpace(os.Getenv("AWWO_RENDER_URL")), os.Getenv("AWWO_RENDER_TOKEN")
	if c.RendersPerDay, err = positiveEnvInt("AWWO_RENDERS_PER_DAY", 20, 10000); err != nil {
		return err
	}
	if c.RendersSitePerDay, err = positiveEnvInt("AWWO_RENDERS_SITE_PER_DAY", 300, 1000000); err != nil {
		return err
	}
	c.RenderTimeout = 8 * time.Minute
	if raw := os.Getenv("AWWO_RENDER_TIMEOUT"); raw != "" {
		v, err := time.ParseDuration(raw)
		if err != nil || v < 30*time.Second || v > 30*time.Minute {
			return errors.New("AWWO_RENDER_TIMEOUT must be a duration between 30s and 30m")
		}
		c.RenderTimeout = v
	}
	if c.EditsPerDay, err = positiveEnvInt("AWWO_EDITS_PER_DAY", 40, 10000); err != nil {
		return err
	}
	if c.EditsTotalPerDay, err = positiveEnvInt("AWWO_EDITS_SITE_PER_DAY", 400, 1000000); err != nil {
		return err
	}
	// The worker's own limit is an hour (AWWO_EDIT_TIMEOUT_MS); the API waits longer, for the uploads and the outputs.
	if c.EditTimeout, err = envDuration("AWWO_EDIT_TIMEOUT", 75*time.Minute, time.Minute, 4*time.Hour); err != nil {
		return err
	}
	c.EditQueueWait = 45 * time.Minute
	return nil
}

// envDuration reads a duration setting within [min, max]; absent, it is fallback.
func envDuration(key string, fallback, min, max time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	v, err := time.ParseDuration(raw)
	if err != nil || v < min || v > max {
		return 0, errors.New(key + " must be a duration between " + min.String() + " and " + max.String())
	}
	return v, nil
}

func (c Config) validateCapabilities() error {
	if (c.RenderURL == "") != (c.RenderToken == "") {
		return errors.New("AWWO_RENDER_URL and AWWO_RENDER_TOKEN must be configured together")
	}
	if c.RenderURL != "" {
		u, err := url.Parse(c.RenderURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
			return errors.New("invalid AWWO_RENDER_URL")
		}
		if len(c.RenderToken) < 32 || strings.ContainsAny(c.RenderToken, "\r\n") {
			return errors.New("AWWO_RENDER_TOKEN must be at least 32 characters")
		}
		if c.MediaDir == "" {
			return errors.New("the motion renderer stores its videos in AWWO_MEDIA_DIR, which must be set")
		}
	}
	return nil
}
