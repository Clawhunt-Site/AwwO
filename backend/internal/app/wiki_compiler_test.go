package app

import (
	"encoding/json"
	"testing"
)

func TestWikiCompilationRejectsInvalidOrUnboundedDelivery(t *testing.T) {
	for _, value := range []string{`{}`, `{"pages":[]}`, `{"pages":[{"title":"x","kind":"source","content":"x"}]}`, `{"pages":[{"title":"x","kind":"page","content":"x","executed":true}]}`, `{"pages":[{"title":"x","kind":"page","content":"x"}]} {}`, `{"pages":[{"title":"x","kind":"page","content":"x"},{"title":"X","kind":"page","content":"y"}]}`} {
		if validateWikiCompilation(value) {
			t.Fatalf("accepted malformed proposal: %s", value)
		}
	}
	if !validateWikiCompilation("```json\n{\"pages\":[{\"title\":\"设计决策\",\"kind\":\"decision\",\"content\":\"根据 [原件](knowledge:source-1/rev-1) 的候选决策，尚待审核。\",\"sourceRevisionIds\":[\"rev-1\"]}]}\n```") {
		t.Fatal("valid candidate rejected")
	}
}

func TestWikiCompilationRejectsUnstorableTextAndUnfrozenCitations(t *testing.T) {
	context := &knowledgeContext{Items: []knowledgeContextItem{{knowledgeReference: knowledgeReference{DocumentID: "doc-1", RevisionID: "rev-1"}}}}
	for _, tc := range []struct {
		title, content string
		refs           []string
		valid          bool
	}{
		{"Page", "Supported by doc-1/rev-1", []string{"rev-1"}, true},
		{"Page\x00", "Supported by doc-1/rev-1", []string{"rev-1"}, false},
		{"Page", "Supported by doc-1/rev-1\x00", []string{"rev-1"}, false},
		{"Page", "Uncited assertion", []string{"rev-1"}, false},
		{"Page", "doc-2/rev-2", []string{"rev-2"}, false},
		{"Page", "doc-1/rev-1", []string{"rev-1", "rev-1"}, false},
	} {
		raw, _ := json.Marshal(wikiCompilation{Pages: []wikiCompiledPage{{Title: tc.title, Kind: "page", Content: tc.content, SourceRevisionIDs: tc.refs}}})
		if got := validateWikiCompilationWithContext(string(raw), context); got != tc.valid {
			t.Errorf("validation=%v want %v for %s", got, tc.valid, raw)
		}
	}
}
