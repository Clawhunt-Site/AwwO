package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestDatabaseDiagnosticsLogTypesWithoutSensitiveErrorMessages(t *testing.T) {
	for _, tc := range []struct {
		err      error
		field    string
		expected any
	}{
		{fmt.Errorf("PRIVATE SQL values: %w", &pgconn.PgError{Code: "23514", Message: "PRIVATE key", Detail: "PRIVATE request", Where: "PRIVATE SQL"}), "sql_state", "23514"},
		{pgx.ScanArgError{ColumnIndex: 2, FieldName: "execution_snapshot", Err: errors.New("PRIVATE model body")}, "scan_column", "execution_snapshot"},
		{pgx.ScanArgError{ColumnIndex: 2, FieldName: "PRIVATE SQL expression()", Err: errors.New("PRIVATE model body")}, "scan_column_index", float64(2)},
	} {
		var output bytes.Buffer
		a := New(nil, testConfig())
		a.log = slog.New(slog.NewJSONHandler(&output, nil))
		w := httptest.NewRecorder()
		a.dbError(w, tc.err)
		if strings.Contains(output.String(), "PRIVATE") || strings.Contains(w.Body.String(), "PRIVATE") {
			t.Fatal("diagnostic exposed error data", output.String())
		}
		var record map[string]any
		if err := json.Unmarshal(output.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record[tc.field] != tc.expected || record["error_type"] == nil || w.Code != 500 {
			t.Fatal("missing safe diagnostic", record, w.Code)
		}
	}
}
