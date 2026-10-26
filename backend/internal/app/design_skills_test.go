package app

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The policy's three.js modules import map must be the one AwwO's previews supply (previewImportMap.ts builds
// THREE_MODULES_IMPORT_MAP from THREE_MODULES_VERSION): a page written to a stale version would load nothing.
func TestPreviewModulesImportMapMatchesTheWeb(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "previewImportMap.ts"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	version := regexp.MustCompile(`export const THREE_MODULES_VERSION = '([0-9.]+)';`).FindStringSubmatch(text)
	base := regexp.MustCompile("export const THREE_MODULES_BASE = `([^`]*)`;").FindStringSubmatch(text)
	importMap := regexp.MustCompile("export const THREE_MODULES_IMPORT_MAP = `([^`]*)`;").FindStringSubmatch(text)
	if version == nil || base == nil || importMap == nil {
		t.Fatal("previewImportMap.ts no longer declares the version, base and import map this test reads")
	}
	baseURL := strings.ReplaceAll(base[1], "${THREE_MODULES_VERSION}", version[1])
	web := strings.ReplaceAll(importMap[1], "${THREE_MODULES_BASE}", baseURL)
	if strings.Contains(web, "${") {
		t.Fatalf("unexpected substitution left in the web import map: %s", web)
	}
	if web != previewModulesImportMap {
		t.Fatalf("the output policy names\n%s\nbut the previews supply\n%s", previewModulesImportMap, web)
	}
}
