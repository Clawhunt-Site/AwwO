package webread

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"
)

func mustURL(raw string) *url.URL {
	u, _ := url.Parse(raw)
	return u
}

func TestExtractDropsHiddenAndNoiseContent(t *testing.T) {
	page := `<html><body><main>
<p>Visible paragraph one is long enough to be the main content of this small page, so the reader keeps it as text.</p>
<p style="DISPLAY: NONE">gone 1</p><p style="visibility:hidden">gone 2</p><p style="opacity:0;">gone 3</p>
<p style="font-size:0px">gone 4</p><span style="height: 0">gone 5</span><span style="width:0 !important">gone 6</span>
<p aria-hidden="TRUE">gone 7</p><template><p>gone 8</p></template><noscript>gone 9</noscript><!-- gone 10 -->
<form><input value="gone 11"><button>gone 12</button></form><svg><text>gone 13</text></svg>
<p>Visible paragraph two keeps the opacity:0.5 element <span style="opacity:0.5">half visible</span> as it is still seen.</p>
</main></body></html>`
	text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
	for i := 1; i <= 13; i++ {
		if strings.Contains(text, fmt.Sprintf("gone %d", i)) {
			t.Fatalf("hidden content %d kept:\n%s", i, text)
		}
	}
	if !strings.Contains(text, "Visible paragraph one") || !strings.Contains(text, "half visible") {
		t.Fatalf("visible content lost:\n%s", text)
	}
}

func TestExtractChoosesTheArticleOverSidebars(t *testing.T) {
	long := strings.Repeat("The story continues with plenty of words that belong to the article itself. ", 6)
	page := `<html><body><div class="layout"><div class="sidebar"><p>` + strings.Repeat("Related link text. ", 3) + `<a href="/a">a</a> <a href="/b">b</a></p></div>
<div class="content"><h2>Section</h2><p>` + long + `</p><p>` + long + `</p></div></div></body></html>`
	text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
	if !strings.HasPrefix(text, "## Section") || strings.Contains(text, "Related link text") {
		t.Fatalf("main content not chosen:\n%s", text)
	}
}

// An article or main inside a hidden block is never what the page shows, so it cannot stand in for the visible text.
func TestExtractIgnoresHiddenArticlesAndMains(t *testing.T) {
	hidden := strings.Repeat("Hidden instructions the page never shows to its reader. ", 8)
	visible := strings.Repeat("The visible story a reader actually sees on the page. ", 8)
	for name, page := range map[string]string{
		"article in a hidden div": `<html><body><div style="display:none"><article><p>` + hidden + `</p></article></div><main><p>` + visible + `</p></main></body></html>`,
		"main in a hidden div":    `<html><body><div hidden><main><p>` + hidden + `</p></main></div><div><p>` + visible + `</p><p>` + visible + `</p></div></body></html>`,
		"aria-hidden ancestor":    `<html><body><section aria-hidden="true"><article><p>` + hidden + `</p></article></section><article><p>` + visible + `</p></article></body></html>`,
	} {
		text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
		if strings.Contains(text, "Hidden instructions") || !strings.Contains(text, "The visible story") {
			t.Fatalf("%s: hidden content chosen:\n%s", name, text)
		}
	}
}

func TestExtractMarkdownShapes(t *testing.T) {
	page := `<html><body><article><h3>Title</h3><p>Para with <strong>bold</strong>, <code>code()</code> and a <a href="https://x.test/p?a=(1)">link</a>.<br>Next line.</p>
<blockquote><p>Quoted one.</p><p>Quoted two.</p></blockquote><ol><li>One</li><li>Two</li></ol><hr>
<p>` + strings.Repeat("Filler words so the article is long enough to be chosen as the main content. ", 3) + `</p>
<p><a href="javascript:alert(1)">bad link</a> <a href="mailto:a@b.c">mail</a> <img src="x.png" alt="An image"></p></article></body></html>`
	text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
	for _, want := range []string{"### Title", "Para with bold, `code()` and a [link](https://x.test/p?a=%281%29).\nNext line.", "> Quoted one.\n> \n> Quoted two.", "1. One\n2. Two", "---", "bad link mail An image"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "javascript:") || strings.Contains(text, "mailto:") {
		t.Fatalf("unsafe link kept:\n%s", text)
	}
}

func TestFinishTextCutsOnARuneBoundary(t *testing.T) {
	result := &Result{Kind: "article"}
	if err := finishText(result, strings.Repeat("中", 100), 10); err != nil {
		t.Fatal(err)
	}
	if !result.Truncated || !utf8.ValidString(result.Text) || len(result.Text) > 10 || !result.Unconfirmed {
		t.Fatalf("bad cut: %q %+v", result.Text, result)
	}
}

func TestFeedsBecomeItems(t *testing.T) {
	rss := `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Demo feed</title>
<item><title>First &amp; best</title><link>/posts/1</link><pubDate>Wed, 14 Oct 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>Hello <b>world</b></p>]]></description></item>
<item><title>Second</title><guid>https://example.com/posts/2</guid><description>Plain summary</description></item></channel></rss>`
	atom := `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom demo</title>
<entry><title>Entry one</title><link rel="alternate" href="https://example.com/e1"/><published>2026-10-14T00:00:00Z</published><summary>Short summary</summary></entry></feed>`
	mux := http.NewServeMux()
	mux.HandleFunc("/rss", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprint(w, rss)
	})
	mux.HandleFunc("/atom", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/atom+xml")
		fmt.Fprint(w, atom)
	})
	mux.HandleFunc("/sitemap", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprint(w, `<urlset><url><loc>x</loc></url></urlset>`)
	})
	s := newSite(t, mux)
	result, err := Fetch(context.Background(), "https://site.test/rss", s.options(nil))
	if err == nil {
		t.Fatal("https to a plain test server should fail")
	}
	result, err = Fetch(context.Background(), "http://site.test/rss", s.options(nil))
	if err != nil || result.Kind != "feed" || result.Title != "Demo feed" || len(result.Items) != 2 {
		t.Fatalf("rss: %+v %v", result, err)
	}
	if result.Items[0].Title != "First & best" || result.Items[0].Link != "http://site.test/posts/1" || result.Items[0].Summary != "Hello world" || result.Items[1].Link != "https://example.com/posts/2" {
		t.Fatalf("rss items: %+v", result.Items)
	}
	if !strings.Contains(result.Text, "- [First & best](http://site.test/posts/1) — Wed, 14 Oct 2026 08:00:00 GMT — Hello world") {
		t.Fatalf("rss text:\n%s", result.Text)
	}
	result, err = Fetch(context.Background(), "http://site.test/atom", s.options(nil))
	if err != nil || result.Title != "Atom demo" || len(result.Items) != 1 || result.Items[0].Link != "https://example.com/e1" || result.Items[0].Published != "2026-10-14T00:00:00Z" {
		t.Fatalf("atom: %+v %v", result, err)
	}
	if _, err = Fetch(context.Background(), "http://site.test/sitemap", s.options(nil)); errorCode(err) != "unsupported_type" {
		t.Fatal(err)
	}
}
