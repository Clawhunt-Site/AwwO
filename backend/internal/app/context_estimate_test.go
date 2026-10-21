package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type estimateVectors struct {
	Rates []float64 `json:"rates"`
	Cases []struct {
		Name     string `json:"name"`
		Text     string `json:"text"`
		Strict   int    `json:"strict"`
		Prose    int    `json:"prose"`
		Estimate []int  `json:"estimate"`
	} `json:"cases"`
}

func loadEstimateVectors(t *testing.T) estimateVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "context-estimate-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v estimateVectors
	if err = json.Unmarshal(raw, &v); err != nil || len(v.Cases) < 20 || len(v.Rates) < 3 {
		t.Fatalf("vectors %v (%d cases)", err, len(v.Cases))
	}
	return v
}

// The API counts every shared vector as the workers do (TypeScript and Python test the same file).
func TestContextEstimateSharedVectors(t *testing.T) {
	v := loadEstimateVectors(t)
	for _, c := range v.Cases {
		strict, prose := textCost(c.Text)
		if strict != c.Strict || prose != c.Prose || strict+prose != len(c.Text) {
			t.Fatalf("%s: strict %d prose %d (len %d), want %d %d", c.Name, strict, prose, len(c.Text), c.Strict, c.Prose)
		}
		for i, rate := range v.Rates {
			if got := estimateTokens(c.Text, rate); got != c.Estimate[i] {
				t.Fatalf("%s at %v: %d, want %d", c.Name, rate, got, c.Estimate[i])
			}
		}
	}
}

func TestContextEstimateBounds(t *testing.T) {
	v := loadEstimateVectors(t)
	for _, c := range v.Cases {
		if got := estimateTokens(c.Text, 1); got != len(c.Text) {
			t.Fatalf("%s at 1: %d, want len %d", c.Name, got, len(c.Text))
		}
		if got := estimateTokens(c.Text, 0); got != len(c.Text) {
			t.Fatalf("%s with no rate: %d, want len %d", c.Name, got, len(c.Text))
		}
	}
	text := "说明 version 5.6 " + strings.Repeat("x", 40) + " 😀 plain words\xff"
	strict, _ := textCost(text)
	for _, rate := range []float64{1, 1.5, 2.15, 3.3, 4} {
		if e := estimateTokens(text, rate); e < strict || e > len(text) {
			t.Fatalf("rate %v: estimate %d outside [%d, %d]", rate, e, strict, len(text))
		}
	}
	if estimateTokens(text, 9) != estimateTokens(text, proseRateMax) {
		t.Fatal("a rate past the largest one counts as the largest")
	}
	// An invalid byte is strict, never prose.
	if s, p := textCost("ab\xffcd"); s != 1 || p != 4 {
		t.Fatalf("invalid byte: strict %d prose %d", s, p)
	}
}

func TestValidProseRate(t *testing.T) {
	for _, ok := range []float64{1, 1.05, 2.15, 3.3, 4} {
		if !validProseRate(ok) {
			t.Fatalf("%v refused", ok)
		}
	}
	for _, bad := range []float64{0, 0.95, 4.05, 2.13, -1} {
		if validProseRate(bad) {
			t.Fatalf("%v accepted", bad)
		}
	}
}
