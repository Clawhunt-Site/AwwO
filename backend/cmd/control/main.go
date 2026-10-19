// awwo-control is an OS-operator tool, not a second API server.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"awwo/backend/internal/operator"
)

const help = `Usage: awwo-control <status|inspect|grant|rollback|delete-account> [flags]
Uses AWWO_DATABASE_URL from the protected service environment; never pass a DSN as an argument.
status   [--nonce REQUEST_ID]                                  read-only aggregate counts
inspect  (--user-id ID | --email EXACT_EMAIL)                  read-only account identity
grant    --user-id ID --expected-email EMAIL --expected-issuer HTTPS_ORIGIN
         --expected-subject SUBJECT --expected-role user --operation-id ID --reason TEXT [--apply]
rollback --user-id ID --grant-id AUDIT_ID --operation-id ID --reason TEXT [--apply]
delete-account --user-id ID --expected-email EMAIL [--request-id DELETION_REQUEST_ID | --supersede-request REQUEST_ID]
         [--transfer-workspaces WORKSPACE=NEW_OWNER_ID[,...]] [--rename-workspaces WORKSPACE=NEW_NAME[,...]]
         [--delete-workspaces WORKSPACE[,...]] --operation-id ID --reason TEXT [--apply]
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
	apply                      bool
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
	var transfers, renames, deletes string
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
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(result)
}

// timeout bounds a command: a deletion may take a large workspace's rows with it, so it gets two minutes.
func timeout(args []string) time.Duration {
	if len(args) > 0 && args[0] == "delete-account" {
		return 2 * time.Minute
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
		if !errors.Is(err, operator.ErrInput) && !errors.Is(err, operator.ErrIdentity) && !errors.Is(err, operator.ErrConflict) && !errors.Is(err, operator.ErrOperator) && !errors.Is(err, operator.ErrRefused) {
			err = operator.ErrDatabase
		}
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
