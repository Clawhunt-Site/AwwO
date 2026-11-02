package main

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"awwo/backend/internal/operator"
)

// learning-export reads its window as whole days in UTC (until now when no --until is given), needs an absolute path
// and at most three months, has no --apply, and gets the longest time of any command.
func TestLearningExportParsesItsDaysAndNeedsAnAbsolutePath(t *testing.T) {
	out := filepath.Join(t.TempDir(), "export.jsonl")
	c, err := parse([]string{"learning-export", "--out", out, "--since", "2026-11-01", "--until", "2026-11-08"})
	if err != nil || c.export.Out != out || c.export.Content || !c.export.Since.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) ||
		!c.export.Until.Equal(time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)) {
		t.Fatal(c.export, err)
	}
	week := time.Now().UTC().AddDate(0, 0, -7).Format("2006-01-02")
	if c, err = parse([]string{"learning-export", "--out", out, "--since", week, "--content"}); err != nil || !c.export.Content || time.Since(c.export.Until) > time.Minute {
		t.Fatal("until now, with content", c.export, err)
	}
	for _, args := range [][]string{
		{"learning-export", "--since", week},
		{"learning-export", "--out", "relative.jsonl", "--since", week},
		{"learning-export", "--out", out, "--since", "1 Nov 2026"},
		{"learning-export", "--out", out, "--since", "2026-11-08", "--until", "2026-11-01"},
		{"learning-export", "--out", out, "--since", "2026-01-01", "--until", "2026-11-01"},
		{"learning-export", "--out", out, "--since", week, "--apply"},
		{"learning-export", "--out", out, "--since", week, "extra"},
	} {
		if _, err = parse(args); !errors.Is(err, operator.ErrInput) {
			t.Fatal("accepted", args, err)
		}
	}
	if timeout([]string{"learning-export"}) != 6*time.Minute || timeout([]string{"status"}) != 10*time.Second {
		t.Fatal("the export's time")
	}
}

// The export names every secret its environment holds (any token, key, password or credential, and a credential held
// within a value: a URL's password or credential parameter, a database connection string's password), never a setting
// such a name holds that is no secret.
func TestDeploymentSecretsNameTheEnvironmentsSecrets(t *testing.T) {
	got := deploymentSecrets([]string{
		"AWWO_PI_TOKEN=pi-worker-token-1", "AWWO_SANDBOX_AGENTS_TOKEN=sandbox-token-2", "AWWO_OPENMAUS_TOKEN=openmaus-token-3",
		"AWWO_SMTP_PASSWORD=short", "AWWO_CREDENTIAL_ENCRYPTION_KEY=a2V5LWtleS1rZXk=", "STRIPE_SECRET_KEY=sk_live_value",
		"AWWO_DATABASE_URL=postgres://awwo:db-password-4@127.0.0.1:5432/awwo", "AWWO_LEARNING_CONSENT=on", "AWWO_PROMPT_KEY_ENABLED=true",
		"AWWO_TOKEN_LIMIT=4096", "AWWO_RUN_TIMEOUT=600s", "PATH=/usr/bin", "AWWO_EMPTY_TOKEN=", "malformed", "AWWO_RELAY_PASSWORD=73918426",
		"AWWO_KEY_TTL_SECONDS=3600", "AWWO_BOOTSTRAP_ADMIN_PASSWORD=739184267391", "AWWO_MAX_OUTPUT_TOKENS=64000",
		// A credential's name wins over a setting word in it, and over a common word.
		"AWWO_SECRET_CODE_S=246813579", "AWWO_RELAY_SMTP_PASSWORD=operator",
		// A database password or a client key's passphrase given as a parameter, in a URL naming several hosts, or in
		// key=value form (quoted, with an escaped quote); a credential in a URL whatever its variable is called.
		"AWWO_REPLICA_DATABASE_URL=postgres://awwo@db.internal/awwo?password=syntheticDbPass1&sslmode=disable&sslpassword=syntheticSslUnlock9",
		"AWWO_POOL_DATABASE_URL=postgresql://awwo:syntheticMultiPass5@db1.internal:5432,db2.internal:5432/awwo",
		"AWWO_READ_DSN=host=db.internal user=awwo password='synthetic kw pass2' dbname=awwo sslpassword=syntheticSslUnlock8 sslmode=disable",
		`AWWO_AUDIT_DSN=host = db.internal password = 'it\'s synthetic6'`,
		"AWWO_HOOK_URL=https://hooks.example.test/in?token=syntheticHookToken3&channel=ops", "HTTPS_PROXY=http://proxy-user:syntheticProxyPass4@proxy.internal:3128",
	})
	want := []string{"pi-worker-token-1", "sandbox-token-2", "openmaus-token-3", "short", "a2V5LWtleS1rZXk=", "sk_live_value",
		"postgres://awwo:db-password-4@127.0.0.1:5432/awwo", "db-password-4", "73918426", "739184267391", "246813579", "operator",
		"postgres://awwo@db.internal/awwo?password=syntheticDbPass1&sslmode=disable&sslpassword=syntheticSslUnlock9", "syntheticDbPass1", "syntheticSslUnlock9",
		"postgresql://awwo:syntheticMultiPass5@db1.internal:5432,db2.internal:5432/awwo", "syntheticMultiPass5",
		"host=db.internal user=awwo password='synthetic kw pass2' dbname=awwo sslpassword=syntheticSslUnlock8 sslmode=disable", "synthetic kw pass2", "syntheticSslUnlock8",
		`host = db.internal password = 'it\'s synthetic6'`, "it's synthetic6",
		"syntheticHookToken3", "syntheticProxyPass4"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	// Every reading a driver may give: pgx unescapes \\' as ', libpq as \'; a URL's value as written and decoded.
	for _, c := range []struct {
		name, value string
		want        []string
	}{
		{"AWWO_ESCAPED_DSN", `password=before\\'after`, []string{`before'after`, `before\'after`}},
		{"AWWO_ENCODED_URL", "https://hooks.example.test/in?token=synthetic%2BToken12", []string{"synthetic%2BToken12", "synthetic+Token12"}},
		{"AWWO_ENCODED_URL", "postgres://awwo:synthetic%40Pass13@db.internal/awwo", []string{"synthetic%40Pass13", "synthetic@Pass13"}},
		// Any whitespace PostgreSQL takes between pairs, before the key or before its =.
		{"AWWO_READ_CONNECTION", "host=db.internal\vpassword=syntheticVTSecret", []string{"syntheticVTSecret"}},
		{"AWWO_READ_CONNECTION", "host=db.internal password\v=syntheticVTSecret2", []string{"syntheticVTSecret2"}},
		// A setting given as JSON: the strings its credential members hold, and the credentials in its other strings,
		// never a plain word under a token's name.
		{"AWWO_OPENMAUS_CONNECTIONS_JSON", `[{"tenantId":"t1","url":"https://maus.internal","token":"pairedServiceToken9274"},` +
			`{"tenantId":"t2","url":"https://u:syntheticJsonPass14@x.internal/","token":"true"},{"nested":{"clientSecret":"syntheticNested15"}}]`,
			[]string{"pairedServiceToken9274", "syntheticJsonPass14", "syntheticNested15"}},
	} {
		got := heldCredentials(c.name, c.value)
		slices.Sort(c.want)
		if !slices.Equal(got, c.want) {
			t.Fatalf("%q: got %q, want %q", c.value, got, c.want)
		}
	}
	// Nothing outside the value decides what is found in it: the process's own PG* settings, which the database driver
	// would read, are not consulted, nor a limit on how many pairs a URL's query may hold.
	t.Setenv("PGPORT", "invalid")
	t.Setenv("PGPASSWORD", "ambient-password-7")
	t.Setenv("GODEBUG", "urlmaxqueryparams=2")
	if got := heldCredentials("AWWO_READ_DSN", "host=db.internal password=syntheticKwPass10"); !slices.Equal(got, []string{"syntheticKwPass10"}) {
		t.Fatalf("with ambient settings: %q", got)
	}
	if got := heldCredentials("AWWO_HOOK_URL", "https://hooks.example.test/in?channel=ops&mode=x&token=syntheticHookToken11"); !slices.Equal(got, []string{"syntheticHookToken11"}) {
		t.Fatalf("past a limit on a query's pairs: %q", got)
	}
}

// A content export is refused before the database is opened where the deployment does not offer the consent, or where
// the command lacks the API's environment.
func TestLearningExportContentNeedsTheConsentOfferedAndTheAPIsEnvironment(t *testing.T) {
	args := []string{"learning-export", "--out", filepath.Join(t.TempDir(), "x.jsonl"), "--since", time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02"), "--content"}
	for _, env := range []map[string]string{
		{"AWWO_PI_TOKEN": "pi-worker-token-1"},
		{"AWWO_LEARNING_CONSENT": "off", "AWWO_PI_TOKEN": "pi-worker-token-1"},
		{"AWWO_LEARNING_CONSENT": "on"},
	} {
		getenv := func(name string) string { return env[name] }
		err := run(context.Background(), args, &bytes.Buffer{}, getenv, operator.Actor{EffectiveUID: 0})
		if !errors.Is(err, operator.ErrExportRefused) {
			t.Fatal("content exported with", env, err)
		}
	}
}
