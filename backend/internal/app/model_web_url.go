package app

import (
	"net/url"
	"path"
	"strings"

	"awwo/backend/internal/webread"
)

// What a model may ask the API to read for it (model_web_reads.go): an address the reader itself accepts
// (webread.ValidateURL: http or https on the default ports, a registered public host name, no user name), and, since
// the model chose it, one that carries little: a short address, no query, a short host, and no path a scanner would try. The
// reader's other guards stay in force as it fetches (public addresses checked at connect time, robots.txt, no
// JavaScript, a bot check reported and never worked around): AWWO-LAW-014, -015, -016.

// modelReadURLBytes bounds a model-chosen address. A page's address is rarely longer, and a short one leaves little room
// to carry text a model was told to send out.
const modelReadURLBytes = 300

// modelReadPathBytes and modelReadHostBytes bound the path and the host name, and modelReadHostLabels the host's
// labels: text a model was told to send out could ride in a path or in made-up subdomains as well as in a query.
const modelReadPathBytes = 200
const modelReadHostBytes = 100
const modelReadHostLabels = 5

// modelReadProbeSegments are path segments a scanner asks for and a page a model reads for a task never needs.
var modelReadProbeSegments = map[string]bool{
	"wp-admin": true, "wp-login.php": true, "xmlrpc.php": true, "wp-config.php": true, "phpmyadmin": true, "pma": true,
	"cgi-bin": true, "server-status": true, "server-info": true, "actuator": true, "jmx-console": true, "manager": true,
	"_ignition": true, "telescope": true, "config.php": true, "setup.php": true, "install.php": true, "shell.php": true,
}

// modelReadProbeExtensions are file endings of secrets, dumps and backups, never a page.
var modelReadProbeExtensions = []string{
	".sql", ".bak", ".old", ".orig", ".swp", ".pem", ".key", ".p12", ".pfx", ".crt", ".env", ".ini", ".conf", ".cfg",
	".log", ".db", ".sqlite", ".sqlite3", ".dump", ".tar", ".tgz", ".gz", ".zip", ".7z", ".rar", ".jks", ".kdbx", ".htpasswd",
}

func modelReadRefusal(code, message string) error {
	return &webread.Error{Code: code, Message: message}
}

// checkModelReadURL accepts an address a model asked for, normalized as the reader keeps it, or says why not.
func checkModelReadURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > modelReadURLBytes {
		return nil, modelReadRefusal("model_url_too_long", "A model may ask for addresses of at most 300 characters")
	}
	u, err := webread.ValidateURL(raw)
	if err != nil {
		return nil, err
	}
	// No query at all: a query is where an address carries data most easily, and a page a task needs rarely needs one
	// (a member can still paste such an address into the conversation, which reads it as they wrote it).
	if u.RawQuery != "" || u.ForceQuery {
		return nil, modelReadRefusal("model_query", "A model may ask for addresses without a query (no ?…)")
	}
	if len(u.EscapedPath()) > modelReadPathBytes {
		return nil, modelReadRefusal("model_url_too_long", "A model may ask for addresses whose path is at most 200 characters")
	}
	if host := u.Hostname(); len(host) > modelReadHostBytes || strings.Count(host, ".")+1 > modelReadHostLabels {
		return nil, modelReadRefusal("model_host", "A model may ask for host names of at most 100 characters and 5 labels")
	}
	// The path as the server will read it: escapes decoded, so %2e%2e and %2F cannot hide a segment.
	decoded, err := url.PathUnescape(u.EscapedPath())
	if err != nil {
		return nil, modelReadRefusal("invalid_url", "The address has an invalid path")
	}
	// Path parameters (a;b) can hide a segment from the checks below on servers that drop them as they route.
	if strings.Contains(decoded, ";") {
		return nil, modelReadRefusal("model_probe_path", "This address has path parameters (;)")
	}
	for _, segment := range strings.Split(decoded, "/") {
		lower := strings.ToLower(segment)
		switch {
		case lower == "..":
			return nil, modelReadRefusal("model_probe_path", "This address climbs out of its path")
		case strings.HasPrefix(lower, "."):
			// Dot files and folders (.env, .git, .aws, .well-known) hold settings and secrets, not pages.
			return nil, modelReadRefusal("model_probe_path", "This address names a hidden file or folder")
		case modelReadProbeSegments[lower]:
			return nil, modelReadRefusal("model_probe_path", "This address names a place scanners probe, not a page")
		}
	}
	ext := strings.ToLower(path.Ext(decoded))
	for _, blocked := range modelReadProbeExtensions {
		if ext == blocked {
			return nil, modelReadRefusal("model_probe_path", "This address names a file that is not a page")
		}
	}
	return u, nil
}
