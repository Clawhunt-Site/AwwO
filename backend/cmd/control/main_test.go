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
