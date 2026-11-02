// awwo-control is an OS-operator tool, not a second API server.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"awwo/backend/internal/operator"
)

const help = `Usage: awwo-control <status|inspect|grant|rollback|delete-account|learning-export> [flags]
Uses AWWO_DATABASE_URL from the protected service environment; never pass a DSN as an argument.
status   [--nonce REQUEST_ID]                                  read-only aggregate counts
inspect  (--user-id ID | --email EXACT_EMAIL)                  read-only account identity
grant    --user-id ID --expected-email EMAIL --expected-issuer HTTPS_ORIGIN
         --expected-subject SUBJECT --expected-role user --operation-id ID --reason TEXT [--apply]
rollback --user-id ID --grant-id AUDIT_ID --operation-id ID --reason TEXT [--apply]
delete-account --user-id ID --expected-email EMAIL [--request-id DELETION_REQUEST_ID | --supersede-request REQUEST_ID]
         [--transfer-workspaces WORKSPACE=NEW_OWNER_ID[,...]] [--rename-workspaces WORKSPACE=NEW_NAME[,...]]
         [--delete-workspaces WORKSPACE[,...]] --operation-id ID --reason TEXT [--apply]
learning-export --out /ABSOLUTE/NEW_FILE.jsonl --since YYYY-MM-DD [--until YYYY-MM-DD] [--content]
         every workspace's content-free node outcomes, with ids as keyed hashes kept nowhere; --content adds the runs
         of workspaces whose owner turned Help improve AwwO on, admitted after it, redacted (needs OS effective UID 0)
Role and deletion commands default to read-only previews. --apply requires OS effective UID 0.
A deletion preview lists every blocker; each workspace the account alone owns needs a transfer or a deletion.
Use the same operation ID and arguments after an uncertain result; never automatically allocate a new ID.
No migrations, API startup, worker lease, password/session changes, or background tasks are performed.
`

type command struct {
	name, nonce, userID, email string
	grant                      operator.Grant
	rollback                   operator.Rollback
	deletion                   operator.Deletion
	export                     operator.LearningExport
	apply                      bool
}

// day reads YYYY-MM-DD as the start of that day in UTC.
func day(value string) (time.Time, error) {
	t, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}, operator.ErrInput
	}
	return t.UTC(), nil
}

// workspaceList reads "A,B": no empty entry and no entry twice.
func workspaceList(value string) ([]string, error) {
	if value == "" {
		return nil, nil
	}
	out, seen := []string{}, map[string]bool{}
	for _, item := range strings.Split(value, ",") {
		if item == "" || seen[item] {
			return nil, operator.ErrInput
		}
		seen[item] = true
		out = append(out, item)
	}
	return out, nil
}

// pairList reads "WORKSPACE=VALUE,...": one value per workspace, cut at the first "="; a value may hold "=" only when
// allowed (a workspace name may, a user ID may not).
func pairList(value string, equalsInValue bool) (map[string]string, error) {
	items, err := workspaceList(value)
	if err != nil || items == nil {
		return nil, err
	}
	out := map[string]string{}
	for _, item := range items {
		workspace, v, ok := strings.Cut(item, "=")
		if !ok || workspace == "" || v == "" || (!equalsInValue && strings.Contains(v, "=")) || out[workspace] != "" {
			return nil, operator.ErrInput
		}
		out[workspace] = v
	}
	return out, nil
}

func parse(args []string) (command, error) {
	var c command
	if len(args) == 0 {
		return c, operator.ErrInput
	}
	c.name = args[0]
	var transfers, renames, deletes, since, until string
	f := flag.NewFlagSet(c.name, flag.ContinueOnError)
	f.SetOutput(io.Discard)
	switch c.name {
	case "status":
		f.StringVar(&c.nonce, "nonce", "", "request binding")
	case "inspect":
		f.StringVar(&c.userID, "user-id", "", "immutable user ID")
		f.StringVar(&c.email, "email", "", "exact stored email")
	case "grant":
		f.StringVar(&c.grant.UserID, "user-id", "", "immutable user ID")
		f.StringVar(&c.grant.Email, "expected-email", "", "exact stored email")
		f.StringVar(&c.grant.Issuer, "expected-issuer", "", "verified issuer")
		f.StringVar(&c.grant.Subject, "expected-subject", "", "verified subject")
		f.StringVar(&c.grant.ExpectedRole, "expected-role", "", "must be user")
		f.StringVar(&c.grant.OperationID, "operation-id", "", "stable idempotency ID")
		f.StringVar(&c.grant.Reason, "reason", "", "operator reason, no secrets")
		f.BoolVar(&c.apply, "apply", false, "apply instead of preview")
	case "rollback":
		f.StringVar(&c.rollback.UserID, "user-id", "", "immutable user ID")
		f.Int64Var(&c.rollback.GrantID, "grant-id", 0, "original grant audit ID")
		f.StringVar(&c.rollback.OperationID, "operation-id", "", "stable idempotency ID")
		f.StringVar(&c.rollback.Reason, "reason", "", "operator reason, no secrets")
		f.BoolVar(&c.apply, "apply", false, "apply instead of preview")
	case "delete-account":
		f.StringVar(&c.deletion.UserID, "user-id", "", "immutable user ID")
		f.StringVar(&c.deletion.Email, "expected-email", "", "exact stored email")
		f.StringVar(&c.deletion.RequestID, "request-id", "", "the account's pending deletion request")
		f.StringVar(&c.deletion.Supersedes, "supersede-request", "", "without --request-id: the withdrawn or declined request a request by email supersedes")
		f.StringVar(&transfers, "transfer-workspaces", "", "WORKSPACE=NEW_OWNER_ID,...")
		f.StringVar(&renames, "rename-workspaces", "", "WORKSPACE=NEW_NAME,... (workspaces handed over)")
		f.StringVar(&deletes, "delete-workspaces", "", "WORKSPACE,...")
		f.StringVar(&c.deletion.OperationID, "operation-id", "", "stable idempotency ID")
		f.StringVar(&c.deletion.Reason, "reason", "", "operator reason, no secrets")
		f.BoolVar(&c.apply, "apply", false, "apply instead of preview")
	case "learning-export":
		f.StringVar(&c.export.Out, "out", "", "absolute path of a new file")
		f.StringVar(&since, "since", "", "first day, YYYY-MM-DD")
		f.StringVar(&until, "until", "", "day after the last, YYYY-MM-DD (unset: now)")
		f.BoolVar(&c.export.Content, "content", false, "add consenting workspaces' runs")
	default:
		return c, operator.ErrInput
	}
	seen := map[string]bool{}
	for _, arg := range args[1:] {
		if strings.HasPrefix(arg, "-") {
			key := strings.SplitN(strings.TrimLeft(arg, "-"), "=", 2)[0]
			if seen[key] {
				return c, operator.ErrInput
			}
			seen[key] = true
		}
	}
	if f.Parse(args[1:]) != nil || f.NArg() != 0 {
		return c, operator.ErrInput
	}
	if c.name == "grant" {
		if err := c.grant.Validate(); err != nil {
			return c, err
		}
	}
	if c.name == "rollback" {
		if err := c.rollback.Validate(); err != nil {
			return c, err
		}
	}
	if c.name == "learning-export" {
		var err error
		if c.export.Since, err = day(since); err != nil {
			return c, err
		}
		c.export.Until = time.Now().UTC()
		if until != "" {
			if c.export.Until, err = day(until); err != nil {
				return c, err
			}
		}
		if err = c.export.Validate(); err != nil {
			return c, err
		}
	}
	if c.name == "delete-account" {
		var err error
		if c.deletion.Transfers, err = pairList(transfers, false); err != nil {
			return c, err
		}
		if c.deletion.Renames, err = pairList(renames, true); err != nil {
			return c, err
		}
		if c.deletion.Deletes, err = workspaceList(deletes); err != nil {
			return c, err
		}
		if err = c.deletion.Validate(); err != nil {
			return c, err
		}
	}
	return c, nil
}

func run(ctx context.Context, args []string, out io.Writer, getenv func(string) string, actor operator.Actor) error {
	if len(args) == 1 && (args[0] == "help" || args[0] == "--help" || args[0] == "-h") {
		_, err := io.WriteString(out, help)
		return err
	}
	c, err := parse(args)
	if err != nil {
		return err
	}
	if c.apply && actor.EffectiveUID != 0 {
		return operator.ErrOperator
	}
	// Content leaves only where the deployment offers the consent, and only from a command that holds the API's
	// environment, whose secrets it redacts (one without it would redact none of them, unseen).
	if c.name == "learning-export" && c.export.Content {
		if getenv("AWWO_LEARNING_CONSENT") != "on" {
			return fmt.Errorf("%w: this deployment does not offer Help improve AwwO (AWWO_LEARNING_CONSENT is not on), so no content is exported", operator.ErrExportRefused)
		}
		if getenv("AWWO_PI_TOKEN") == "" {
			return fmt.Errorf("%w: run it with the API's environment, whose secrets the export redacts (AWWO_PI_TOKEN is not set)", operator.ErrExportRefused)
		}
	}
	s, err := operator.Open(ctx, getenv("AWWO_DATABASE_URL"))
	if err != nil {
		return err
	}
	defer s.Close()
	var result any
	switch c.name {
	case "status":
		result, err = s.Status(ctx, c.nonce)
	case "inspect":
		result, err = s.Inspect(ctx, c.userID, c.email)
	case "grant":
		result, err = s.Grant(ctx, c.grant, actor, c.apply)
	case "rollback":
		result, err = s.Rollback(ctx, c.rollback, actor, c.apply)
	case "delete-account":
		result, err = s.DeleteAccount(ctx, c.deletion, actor, c.apply)
	case "learning-export":
		// Every secret of the deployment's environment is redacted wherever a run's text holds it, and content is
		// exported only where the deployment offers the consent.
		c.export.Secrets = deploymentSecrets(environ())
		c.export.ConsentOffered = getenv("AWWO_LEARNING_CONSENT") == "on"
		result, err = s.LearningExport(ctx, c.export, actor)
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(result)
}

// environ is the process's environment (a test gives its own).
var environ = os.Environ

// secretName is an environment variable whose name says it holds a secret.
var secretName = regexp.MustCompile(`(?i)(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|PRIVATE|DSN|DATABASE_URL)`)

// credentialName is a variable whose name says it holds a credential, whatever it looks like; settingName one whose
// name says it holds a number that is a setting, not a secret (a token limit, a key's time to live), as whole words.
var (
	credentialName = regexp.MustCompile(`(?i)(PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE)`)
	settingName    = regexp.MustCompile(`(?i)(^|_)(LIMIT|MAX|MIN|TIMEOUT|TTL|SIZE|BYTES|COUNT|PORT|DAYS|HOURS|SECONDS|MS|S)(_|$)`)
)

// plainValues are settings a secret-like name may hold that are no secret, and would redact common words. A
// credential's name (credentialName) keeps its value even so.
var plainValues = map[string]bool{"true": true, "false": true, "on": true, "off": true, "yes": true, "no": true, "none": true, "null": true,
	"user": true, "operator": true}

// databaseName is a variable that holds a database connection string; credentialParam a URL query parameter, or a
// connection string's key, that holds a credential (sslpassword: the passphrase of a client certificate's key);
// urlScheme a URL's scheme; keywordCredential a connection string of key=value pairs that names a password.
var (
	databaseName      = regexp.MustCompile(`(?i)(DSN|DATABASE_URL)`)
	credentialParam   = regexp.MustCompile(`(?i)^(password|passwd|pwd|pass|sslpassword|secret|token|key|api[_-]?key|access[_-]?token|auth)$`)
	urlScheme         = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*$`)
	keywordCredential = regexp.MustCompile(`(?i)(^|[ \t\n\r\v\f])(ssl)?password[ \t\n\r\v\f]*=`)
)

// deploymentSecrets are the values of the environment's secrets, and the credentials any value holds within it (a URL's
// password or credential parameter, a database connection string's password), for the learning export to redact
// wherever a run's text holds them.
func deploymentSecrets(env []string) []string {
	out := []string{}
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || value == "" {
			continue
		}
		setting := plainValues[strings.ToLower(value)] || isNumber(value) && settingName.MatchString(name)
		if secretName.MatchString(name) && (credentialName.MatchString(name) || !setting) {
			out = append(out, value)
		}
		out = append(out, heldCredentials(name, value)...)
	}
	return out
}

// heldCredentials are the credentials value holds within it, read from the text alone (nothing else is consulted, so
// nothing else can keep one from being found), in every reading a driver may give them. A URL gives its password and
// its credential parameters, each as written and decoded, pair by pair and even where the URL as a whole would not parse
// (a database URL naming several hosts). A connection string of key=value pairs gives its password and sslpassword,
// unescaped as pgx and as libpq read them.
func heldCredentials(name, value string) []string {
	found := []string{}
	add := func(key string, values ...string) {
		if credentialParam.MatchString(key) {
			for _, v := range values {
				if v != "" {
					found = append(found, v)
				}
			}
		}
	}
	if trimmed := strings.TrimSpace(value); strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		// A setting given as JSON (AWWO_OPENMAUS_CONNECTIONS_JSON's tokens): the credentials in its strings.
		var decoded any
		if json.Unmarshal([]byte(trimmed), &decoded) == nil {
			found = append(found, jsonCredentials("", decoded)...)
		}
	} else if scheme, rest, ok := strings.Cut(value, "://"); ok && urlScheme.MatchString(scheme) {
		authority := rest
		if i := strings.IndexAny(rest, "/?#"); i >= 0 {
			authority = rest[:i]
		}
		if at := strings.LastIndex(authority, "@"); at >= 0 {
			if _, password, set := strings.Cut(authority[:at], ":"); set {
				decoded, _ := url.PathUnescape(password)
				add("password", password, decoded)
			}
		}
		if _, query, ok := strings.Cut(rest, "?"); ok {
			query, _, _ = strings.Cut(query, "#")
			// Pair by pair: one that does not decode, or a limit on how many pairs a query may hold, leaves the rest read.
			for _, pair := range strings.Split(query, "&") {
				key, v, _ := strings.Cut(pair, "=")
				if decoded, err := url.QueryUnescape(key); err == nil {
					key = decoded
				}
				decoded, _ := url.QueryUnescape(v)
				add(key, v, decoded)
			}
		}
	} else if databaseName.MatchString(name) || keywordCredential.MatchString(value) {
		for key, values := range keywordSettings(value) {
			add(key, values...)
		}
	}
	slices.Sort(found)
	return slices.Compact(found)
}

// jsonCredentialKey is a JSON member's name that says its string is a credential (token, apiKey, clientSecret…).
var jsonCredentialKey = regexp.MustCompile(`(?i)(token|secret|password|passwd|pwd|credential|private|key|auth)`)

// jsonCredentials are the credentials a decoded JSON value holds: each string under a member whose name says it is one
// (jsonCredentialKey; a plain word only under a credential's name, as for the environment's own names), and the
// credentials any string in it holds within it (heldCredentials).
func jsonCredentials(key string, v any) []string {
	found := []string{}
	switch v := v.(type) {
	case map[string]any:
		for member, item := range v {
			found = append(found, jsonCredentials(member, item)...)
		}
	case []any:
		for _, item := range v {
			found = append(found, jsonCredentials(key, item)...)
		}
	case string:
		if v != "" && jsonCredentialKey.MatchString(key) && (credentialName.MatchString(key) || !plainValues[strings.ToLower(v)]) {
			found = append(found, v)
		}
		found = append(found, heldCredentials("", v)...)
	}
	return found
}

// keywordSettings reads a connection string of key=value pairs as PostgreSQL does (libpq, and pgx's
// parseKeywordValueSettings): pairs apart by whitespace, a value bare up to whitespace or single-quoted, a backslash
// escaping the character after it. Each value is given as pgx unescapes it (\\ to \, then \' to ') and as libpq does
// (each backslash dropped before the character it escapes): the two differ, on \\' for one. Up to a pair it cannot
// read, it answers those it has read.
func keywordSettings(s string) map[string][]string {
	const space = " \t\n\r\v\f"
	settings := map[string][]string{}
	libpq := func(s string) string {
		var b strings.Builder
		for i := 0; i < len(s); i++ {
			if s[i] == '\\' && i+1 < len(s) {
				i++
			}
			b.WriteByte(s[i])
		}
		return b.String()
	}
	for s = strings.TrimLeft(s, space); s != ""; s = strings.TrimLeft(s, space) {
		eq := strings.IndexByte(s, '=')
		if eq < 0 {
			break
		}
		key := strings.Trim(s[:eq], space)
		s = strings.TrimLeft(s[eq+1:], space)
		quoted := strings.HasPrefix(s, "'")
		if quoted {
			s = s[1:]
		}
		end := 0
		for ; end < len(s); end++ {
			if quoted && s[end] == '\'' || !quoted && strings.IndexByte(space, s[end]) >= 0 {
				break
			}
			if s[end] == '\\' {
				end++
			}
		}
		if end > len(s) || quoted && end == len(s) {
			break
		}
		if key != "" {
			raw := s[:end]
			settings[strings.ToLower(key)] = []string{strings.ReplaceAll(strings.ReplaceAll(raw, `\\`, `\`), `\'`, `'`), libpq(raw)}
		}
		if end < len(s) {
			end++
		}
		s = s[end:]
	}
	return settings
}

func isNumber(value string) bool {
	_, err := strconv.ParseFloat(value, 64)
	return err == nil
}

// timeout bounds a command: a deletion may take a large workspace's rows with it, so it gets two minutes, and an
// export reads up to three months of runs, so it gets six.
func timeout(args []string) time.Duration {
	if len(args) > 0 && args[0] == "delete-account" {
		return 2 * time.Minute
	}
	if len(args) > 0 && args[0] == "learning-export" {
		return 6 * time.Minute
	}
	return 10 * time.Second
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), timeout(os.Args[1:]))
	defer cancel()
	host, _ := os.Hostname()
	err := run(ctx, os.Args[1:], os.Stdout, os.Getenv, operator.Actor{UID: os.Getuid(), EffectiveUID: os.Geteuid(), Host: host})
	if err != nil {
		// A refusal names its reasons (codes and workspace ids only); anything else unexpected is a database failure.
		if !errors.Is(err, operator.ErrInput) && !errors.Is(err, operator.ErrIdentity) && !errors.Is(err, operator.ErrConflict) && !errors.Is(err, operator.ErrOperator) &&
			!errors.Is(err, operator.ErrRefused) && !errors.Is(err, operator.ErrExportRefused) {
			err = operator.ErrDatabase
		}
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
