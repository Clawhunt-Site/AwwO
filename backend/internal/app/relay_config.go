package app

import (
	"errors"
	"os"
	"regexp"
)

// The cloud relay (docs/awwo-cloud-relay.md). On the hosted site, AWWO_LOCAL_RELAY=on serves AwwO 本地版's links
// (local_links.go) and relayed calls (relay.go). In the local edition, AWWO_CLOUD_ORIGIN names the hosted site that its
// 「AwwO 线上」 engine links to and relays through (cloud_link.go). Neither is set by default, and each is refused in the
// other edition, so the hosted site never relays to itself and the local edition never serves anyone else's calls.
type relaySettings struct {
	// LocalRelay serves the links and relayed calls on the hosted site (AWWO_LOCAL_RELAY=on); off by default.
	LocalRelay bool
	// CloudOrigin is the hosted site a local edition links to (AWWO_CLOUD_ORIGIN): an https origin, or
	// http://127.0.0.1:<port> in development (a test's own hosted site). "" offers no 「AwwO 线上」 engine.
	CloudOrigin string
}

func (c *Config) relayFromEnv() error {
	switch os.Getenv("AWWO_LOCAL_RELAY") {
	case "", "off":
	case "on":
		c.LocalRelay = true
	default:
		return errors.New("AWWO_LOCAL_RELAY must be on or off")
	}
	c.CloudOrigin = os.Getenv("AWWO_CLOUD_ORIGIN")
	return nil
}

func (c Config) validateRelay() error {
	if c.LocalRelay && c.Edition == editionLocal {
		return errors.New("AWWO_LOCAL_RELAY is the hosted site's: the local edition relays through AWWO_CLOUD_ORIGIN")
	}
	// A relayed call runs on the operator's Bedrock models, which a worker serving personal connections never has.
	if c.LocalRelay && c.UserCredentials {
		return errors.New("AWWO_LOCAL_RELAY relays to the operator's models and needs AWWO_CREDENTIAL_MODE=operator")
	}
	if c.CloudOrigin == "" {
		return nil
	}
	if c.Edition != editionLocal {
		return errors.New("AWWO_CLOUD_ORIGIN is the local edition's: unset it, or set AWWO_EDITION=local")
	}
	if !validCloudOrigin(c.CloudOrigin, c.Env == "development") {
		return errors.New("AWWO_CLOUD_ORIGIN must be an https origin (no path, user, query or fragment), or http://127.0.0.1:<port> in development")
	}
	return nil
}

// cloudOriginHost and cloudOriginPort are an origin's host (dot-separated labels of ASCII letters, digits and inner
// hyphens) and port (1 to 65535, without a leading zero), as every reader of AWWO_CLOUD_ORIGIN takes them: the workers
// (apps/user-models.ts, the Python worker's config.py) and the runtime script (scripts/awwo-local-lib.mjs) share this
// rule and its cases (apps/cloud-origin-vectors.json).
const (
	cloudOriginHost = `[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*`
	cloudOriginPort = `(?:6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3})`
)

var (
	httpsOriginPattern    = regexp.MustCompile(`^https://` + cloudOriginHost + `(?::` + cloudOriginPort + `)?$`)
	loopbackOriginPattern = regexp.MustCompile(`^http://127\.0\.0\.1:` + cloudOriginPort + `$`)
)

// validCloudOrigin accepts exactly an origin: https with a host and nothing after it, or, where loopback is allowed,
// http on 127.0.0.1 with a port.
func validCloudOrigin(raw string, loopback bool) bool {
	return httpsOriginPattern.MatchString(raw) || (loopback && loopbackOriginPattern.MatchString(raw))
}

// cloudRelayBase is the relay's OpenAI-compatible base URL on the linked hosted site: what the local edition's workers
// accept for an 「AwwO 线上」 model and nothing else (apps/user-models.ts).
func (c Config) cloudRelayBase() string {
	if c.CloudOrigin == "" {
		return ""
	}
	return c.CloudOrigin + "/api/v1/relay/v1"
}
