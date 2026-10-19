package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"awwo/backend/internal/operator"
)

func grantArgs() []string {
	return []string{"grant", "--user-id", "person", "--expected-email", "person@example.invalid", "--expected-issuer", "https://identity.example.invalid", "--expected-subject", "subject-person", "--expected-role", "user", "--operation-id", "grant-operation-person", "--reason", "Explicit owner recovery"}
}

func TestRoleCommandsDefaultToPreviewAndRejectAmbiguity(t *testing.T) {
	c, err := parse(grantArgs())
	if err != nil || c.apply {
		t.Fatal(c, err)
	}
	for _, args := range [][]string{append(grantArgs(), "--apply", "--apply=false"), append(grantArgs(), "--user-id", "other"), append(grantArgs(), "unexpected"), {"status", "--apply"}, {"grant", "--apply"}, {"rollback", "--grant-id", "1", "--apply"}} {
		if _, err := parse(args); !errors.Is(err, operator.ErrInput) {
			t.Fatal("accepted ambiguous arguments", args, err)
		}
	}
}

func deletionArgs() []string {
	return []string{"delete-account", "--user-id", "person", "--expected-email", "person@example.invalid", "--request-id", "request-1", "--transfer-workspaces", "w-own=member,w-team=other", "--delete-workspaces", "w-solo,w-old", "--operation-id", "delete-operation-person", "--reason", "The person asked for their account to be deleted"}
}

func TestDeleteAccountParsesItsListsAndDefaultsToPreview(t *testing.T) {
	c, err := parse(deletionArgs())
	if err != nil || c.apply || c.deletion.UserID != "person" || c.deletion.RequestID != "request-1" ||
		c.deletion.Transfers["w-own"] != "member" || c.deletion.Transfers["w-team"] != "other" || len(c.deletion.Transfers) != 2 ||
		strings.Join(c.deletion.Deletes, ",") != "w-solo,w-old" {
		t.Fatal(c, err)
	}
	if c, err = parse(append(deletionArgs()[:7], "--operation-id", "delete-operation-person", "--reason", "Asked by mail", "--apply")); err != nil || !c.apply || c.deletion.Transfers != nil || c.deletion.Deletes != nil {
		t.Fatal("without lists", c, err)
	}
	// A new name may hold "=", never the list's ",".
	if c, err = parse(append(deletionArgs(), "--rename-workspaces", "w-own=Team = one · AwwO,w-team=Other")); err != nil || c.deletion.Renames["w-own"] != "Team = one · AwwO" || c.deletion.Renames["w-team"] != "Other" {
		t.Fatal("renames", c, err)
	}
	// A superseded request is named only when no pending one is.
	if c, err = parse(append(deletionArgs()[:5], "--supersede-request", "request-0", "--operation-id", "delete-operation-person", "--reason", "Asked by mail")); err != nil || c.deletion.Supersedes != "request-0" || c.deletion.RequestID != "" {
		t.Fatal("supersede", c, err)
	}
	if _, err = parse(append(deletionArgs(), "--supersede-request", "request-0")); !errors.Is(err, operator.ErrInput) {
		t.Fatal("accepted a superseded request beside a pending one", err)
	}
	for _, renames := range []string{"w-solo=Kept", "w-own=", "w-own", "w-own=A,w-own=B", "w-own= Padded"} {
		if _, err = parse(append(deletionArgs(), "--rename-workspaces", renames)); !errors.Is(err, operator.ErrInput) {
			t.Fatal("accepted the renames", renames, err)
		}
	}
	with := func(flag, value string) []string {
		args := append([]string{}, deletionArgs()...)
		for i := range args {
			if args[i] == flag {
				args[i+1] = value
			}
		}
		return args
	}
	for name, args := range map[string][]string{
		"repeated flag":           append(deletionArgs(), "--delete-workspaces", "w-other"),
		"empty list entry":        with("--delete-workspaces", "w-solo,,w-old"),
		"workspace twice":         with("--delete-workspaces", "w-solo,w-solo"),
		"transfer without owner":  with("--transfer-workspaces", "w-own="),
		"transfer without =":      with("--transfer-workspaces", "w-own"),
		"two owners":              with("--transfer-workspaces", "w-own=member,w-own=other"),
		"owner with =":            with("--transfer-workspaces", "w-own=member=other"),
		"transferred and deleted": with("--delete-workspaces", "w-own"),
		"transfer to themself":    with("--transfer-workspaces", "w-own=person"),
		"missing reason":          with("--reason", ""),
		"unexpected argument":     append(deletionArgs(), "unexpected"),
		"apply given twice":       append(deletionArgs(), "--apply", "--apply=false"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parse(args); !errors.Is(err, operator.ErrInput) {
				t.Fatal("accepted", args, err)
			}
		})
	}
}

func TestDeleteAccountApplyRequiresOSOperatorAndALongerTimeout(t *testing.T) {
	var out bytes.Buffer
	getenv := func(string) string { t.Fatal("configuration was accessed"); return "" }
	if err := run(context.Background(), append(deletionArgs(), "--apply"), &out, getenv, operator.Actor{EffectiveUID: 501}); !errors.Is(err, operator.ErrOperator) {
		t.Fatal(err)
	}
	if timeout(deletionArgs()) <= timeout([]string{"status"}) || timeout(nil) != timeout([]string{"grant"}) {
		t.Fatal("timeouts", timeout(deletionArgs()), timeout([]string{"status"}))
	}
}

func TestHelpNeverReadsConfigurationAndApplyRequiresOSOperator(t *testing.T) {
	var out bytes.Buffer
	getenv := func(string) string { t.Fatal("configuration was accessed"); return "" }
	if err := run(context.Background(), []string{"--help"}, &out, getenv, operator.Actor{}); err != nil || !strings.Contains(out.String(), "read-only") {
		t.Fatal(err)
	}
	if err := run(context.Background(), append(grantArgs(), "--apply"), &out, getenv, operator.Actor{EffectiveUID: 501}); !errors.Is(err, operator.ErrOperator) {
		t.Fatal(err)
	}
}

func TestInvalidDSNDoesNotExposeCredentials(t *testing.T) {
	var out bytes.Buffer
	err := run(context.Background(), []string{"status"}, &out, func(string) string { return "postgres://password-secret@[malformed" }, operator.Actor{})
	if !errors.Is(err, operator.ErrDatabase) || strings.Contains(err.Error(), "password-secret") || out.Len() != 0 {
		t.Fatal("configuration leaked", err)
	}
}
