package app

import "strings"

// buildRevision is the source commit this binary was built from, injected at link time:
//
//	go build -ldflags "-X awwo/backend/internal/app.buildRevision=$(git rev-parse HEAD)"
//
// It exists so a deployment can be checked directly, from outside the host: a unit description, a
// release directory name and a deploy log can all be stale or simply wrong about what is actually
// serving, whereas the running binary reporting its own revision cannot. `unknown` is the honest
// answer for a build that did not set it, never a guess.
var buildRevision = ""

// BuildRevision reports the injected commit, normalized to 40 lowercase hex characters, or
// "unknown". A malformed value is reported as unknown rather than echoed back, so this can never
// present an arbitrary link-time string as if it were a verified commit.
func BuildRevision() string {
	value := strings.ToLower(strings.TrimSpace(buildRevision))
	if len(value) != 40 {
		return "unknown"
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return "unknown"
		}
	}
	return value
}
