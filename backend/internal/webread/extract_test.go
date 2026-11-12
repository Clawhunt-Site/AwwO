package webread

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
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

// A reference page with no article or main element, its text several lists under headings (the shape of a page found
// on production on 2026-11-12: the reader kept its longest list alone, without the opening and the other sections): the
// whole text is kept, in order.
func TestExtractKeepsAPageOfListsWhole(t *testing.T) {
	item := func(name string, n int) string {
		var b strings.Builder
		for i := 1; i <= n; i++ {
			fmt.Fprintf(&b, "<li><p><b>%s item %d</b></p><p>%s</p></li>\n", name, i, strings.Repeat(name+" item text that explains this case in a full sentence. ", 4))
		}
		return b.String()
	}
	page := `<html><body><div class="menu"><a href="/">Home</a> <a href="/docs">Docs</a></div>
<p>OPENING: this page says when the library is the right choice and when another kind of system serves better, in three lists.</p>
<h1>Where it works well</h1><ul>` + item("WELL", 12) + `</ul>
<h1>Where another system works better</h1><ul>` + item("BETTER", 4) + `</ul>
<h1>A checklist</h1><ol>` + item("CHECK", 3) + `</ol>
<p>CLOSING: the page was last updated some time ago, and this closing sentence is long enough to count as text.</p></body></html>`
	text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
	at := -1
	for _, want := range []string{"OPENING", "# Where it works well", "WELL item 12", "# Where another system works better", "BETTER item 1",
		"BETTER item 4", "# A checklist", "CHECK item 3", "CLOSING"} {
		next := strings.Index(text, want)
		if next < 0 || next < at {
			t.Fatalf("%q is missing or out of order in the kept text (%d bytes):\n%.600s", want, len(text), text)
		}
		at = next
	}
}

// A list item's own paragraphs are the item's text, counted once: a list of such items with a third as much text
// beside it is widened to the page (counted twice, the list would seem to hold nearly all of it and stay alone).
func TestExtractCountsAListItemsParagraphsOnce(t *testing.T) {
	items := strings.Repeat(`<li><p>ITEM: a point made in a paragraph inside a list item, long enough to be scored as text of the page.</p></li>`, 12)
	beside := strings.Repeat(`<p>AROUND: a paragraph of the page outside its list, long enough to be scored as text of the page.</p>`, 4)
	text := extractHTML(`<html><body><div><ul>`+items+`</ul></div>`+beside+`</body></html>`, mustURL("https://example.com/"), 1<<20).Text
	if strings.Count(text, "ITEM") != 12 || strings.Count(text, "AROUND") != 4 {
		t.Fatalf("the list and the text around it are one page (%d bytes):\n%.400s", len(text), text)
	}
}

// Generated documentation: sections inside sections, each a few paragraphs and a list, in a plain div. The longest
// list's section is a part of the document, and the document is kept, without the link lists beside it.
func TestExtractKeepsNestedSectionsWhole(t *testing.T) {
	section := func(name string, items int) string {
		var b strings.Builder
		fmt.Fprintf(&b, `<div class="section"><h2>%s</h2><p>%s</p><ul>`, name, strings.Repeat(name+" opens with a sentence of its own. ", 3))
		for i := 1; i <= items; i++ {
			fmt.Fprintf(&b, "<li>%s</li>", strings.Repeat(fmt.Sprintf("%s change %d is described here at some length. ", name, i), 3))
		}
		return b.String() + "</ul></div>"
	}
	page := `<html><body><div class="sidebar"><ul><li><a href="/a">A link to another page of the site</a></li><li><a href="/b">Another link of the sidebar</a></li></ul></div>
<div class="document"><div class="body"><h1>What is new</h1><p>SUMMARY: the release in a paragraph that is long enough to count as part of the text.</p>` +
		section("LANGUAGE", 3) + `<div class="section"><h2>Library</h2>` + section("LIBRARY-A", 4) + section("LIBRARY-B", 14) + `</div>` + section("API", 5) + `</div></div></body></html>`
	text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
	for _, want := range []string{"SUMMARY", "LANGUAGE change 3", "LIBRARY-A change 4", "LIBRARY-B change 14", "API change 5", "## Library"} {
		if !strings.Contains(text, want) {
			t.Fatalf("%q is missing from the kept text (%d bytes):\n%.600s", want, len(text), text)
		}
	}
	if strings.Contains(text, "A link to another page") {
		t.Fatalf("the sidebar's links were kept:\n%.600s", text)
	}
}

// An article in a plain div stays apart from the comments and the sidebar beside it, as before, however long the
// comments are: what stands beside a text does not count as the page's own. A list that scores best inside such an
// article is widened to the article, not to the comments. A short note in a block with no telling name is too little
// to widen for. A body whose own class names the layout hides nothing.
func TestExtractKeepsAnArticleApartFromItsComments(t *testing.T) {
	paragraph := `<p>` + strings.Repeat("The article goes on with words of its own in this paragraph. ", 5) + `</p>`
	comments := `<div id="comments">` + strings.Repeat(`<div class="reply"><p>COMMENT: a reader answers with a few sentences of their own, at length enough to count.</p></div>`, 40) + `</div>`
	sidebar := `<div class="col sidebar-right"><p>SIDEBAR: about the author, in two sentences that are long enough to be counted as text.</p></div>`
	note := `<div class="box"><p>NOTE: a short notice in a block with no telling name, long enough to be scored.</p></div>`
	list := `<ul>` + strings.Repeat(`<li><p>LISTED: a long point of the article, made in a list item with a paragraph of its own inside it.</p></li>`, 30) + `</ul>`
	for name, article := range map[string]string{
		"paragraphs":          `<h1>Title</h1>` + strings.Repeat(paragraph, 10),
		"a list scoring best": `<h1>Title</h1>` + strings.Repeat(paragraph, 5) + list + paragraph,
	} {
		page := `<html><body class="single has-sidebar comments-open"><div class="wrap"><div class="post">` + article + `</div>` + sidebar + note + comments + `</div></body></html>`
		text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
		if !strings.HasPrefix(text, "# Title") || strings.Count(text, "The article goes on") < 5 || strings.Contains(text, "COMMENT") ||
			strings.Contains(text, "SIDEBAR") || strings.Contains(text, "NOTE") {
			t.Fatalf("%s: the article alone is the text (%d bytes):\n%.500s", name, len(text), text)
		}
		if name == "a list scoring best" && strings.Count(text, "LISTED") != 30 {
			t.Fatalf("%s: the article's list is part of it:\n%.500s", name, text)
		}
	}
	for class, beside := range map[string]bool{"comments": true, "post-comments": true, "Sidebar": true, "related-posts": true, "toc": true,
		"toc-list": true, "share-buttons": true, "content": false, "post": false, "section": false, "doctoc": false, "": false,
		"content-with-sidebar": false, "has-comments": false, "no-sidebar": false, "sidebar-layout": false, "single has-sidebar comments": true} {
		n := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div, Attr: []html.Attribute{{Key: "class", Val: class}}}
		if standsBeside(n) != beside {
			t.Fatalf("class %q stands beside the text: %v, want %v", class, !beside, beside)
		}
	}
}

// wholeText's rule at its edges: a block is widened to an ancestor that holds a fifth more text and at least
// mainGainLeast characters more, each ancestor asked against the block chosen so far, never past the body.
func TestWholeTextWidensOnlyForMateriallyMoreText(t *testing.T) {
	doc, _ := html.Parse(strings.NewReader(`<html><body><div id="outer"><div id="inner"><ul id="list"></ul></div></div></body></html>`))
	byID := func(id string) *html.Node {
		return first(doc, func(n *html.Node) bool { return n.Type == html.ElementNode && attr(n, "id") == id })
	}
	body, outer, inner, list := first(doc, element(atom.Body)), byID("outer"), byID("inner"), byID("list")
	above := first(doc, element(atom.Html))
	for name, c := range map[string]struct {
		held map[*html.Node]float64
		from *html.Node
		want *html.Node
	}{
		"a fifth more":                         {map[*html.Node]float64{list: 1000, inner: 1200, outer: 1200, body: 1200}, list, inner},
		"just under a fifth more":              {map[*html.Node]float64{list: 1000, inner: 1199, outer: 1199, body: 1199}, list, list},
		"more only further up":                 {map[*html.Node]float64{list: 1000, inner: 1000, outer: 1300, body: 1300}, list, outer},
		"a small block, too few characters":    {map[*html.Node]float64{list: 400, inner: 599, outer: 599, body: 599}, list, list},
		"a small block, enough characters":     {map[*html.Node]float64{list: 400, inner: 600, outer: 600, body: 600}, list, inner},
		"a container is asked the same":        {map[*html.Node]float64{inner: 1000, outer: 1200, body: 1200}, inner, outer},
		"each step against the block so far":   {map[*html.Node]float64{list: 1000, inner: 1300, outer: 1500, body: 1559}, list, inner},
		"step by step to the body":             {map[*html.Node]float64{list: 1000, inner: 1300, outer: 1300, body: 1560}, list, body},
		"a block that holds none of the text":  {map[*html.Node]float64{inner: 199, outer: 199, body: 200}, list, body},
		"too little text anywhere to widen to": {map[*html.Node]float64{inner: 199, outer: 199, body: 199}, list, list},
		"the body is never left":               {map[*html.Node]float64{body: 1000}, body, body},
		"nothing above the body is taken":      {map[*html.Node]float64{list: 1000, inner: 1000, outer: 1000, body: 1000, above: 5000}, list, list},
	} {
		if got := wholeText(c.from, body, c.held); got != c.want {
			t.Fatalf("%s: widened to <%s id=%q>, want <%s id=%q>", name, got.Data, attr(got, "id"), c.want.Data, attr(c.want, "id"))
		}
	}
}

// A page reads the same every time. A table inside a table cell: the inner cell's row and the row around the inner
// table score the same, and which one was taken was a map's order, so the same page came back as its paragraphs on
// one read and as one table row on another. The later block of the two is taken: the inner row.
func TestExtractChoosesTheSameBlockOnEveryRead(t *testing.T) {
	page := `<html><body><table><tr><td><table><tr><td>` + words("ESSAY", 900) + `<br><br>` + words("SECOND", 900) + `</td></tr></table></td></tr></table></body></html>`
	for i := 0; i < 40; i++ {
		if text := extractHTML(page, mustURL("https://example.com/"), 1<<20).Text; !strings.HasPrefix(text, "ESSAY") || !strings.Contains(text, "SECOND") {
			t.Fatalf("read %d: the essay's own paragraphs are the text, not a table row:\n%.200s", i, text)
		}
	}
}

// words is text of exactly n characters that starts with a label.
func words(label string, n int) string {
	return (label + ":" + strings.Repeat(" some words of the page", n/20+1))[:n-1] + "."
}

// What did not count as the page's own text is not kept either: a block widened to the page's other sections leaves
// out the comments beside them, which before the widening were not in the text. What is inside the best block stays,
// whatever its name, and so do the blocks around it.
func TestExtractLeavesOutWhatStandsBesideAWidenedText(t *testing.T) {
	one := `<ul>` + strings.Repeat(`<li>`+words("FIRST", 80)+`</li>`, 4) + `<li class="share">` + words("FIRST", 80) + `</li></ul>`
	two := `<ul>` + strings.Repeat(`<li>`+words("SECOND", 80)+`</li>`, 4) + `</ul>`
	comments := strings.Repeat(`<div class="comment"><div><p>`+words("COMMENT", 100)+`</p></div></div>`, 5)
	text := extractHTML(`<html><body><div class="wrap">`+one+two+comments+`</div></body></html>`, mustURL("https://example.com/"), 1<<20).Text
	if strings.Count(text, "FIRST") != 5 || strings.Count(text, "SECOND") != 4 || strings.Contains(text, "COMMENT") {
		t.Fatalf("the two lists are the text, without the comments beside them (%d bytes):\n%s", len(text), text)
	}
	// A wrapper that holds the text and its sidebar is around the text, not beside it, whatever its name: the text
	// in it counts, and it is kept when the block is widened past it. The sidebar inside it is left out; a section
	// in a block named for its layout ("content-with-sidebar") is part of the text.
	for _, closing := range []string{"", `<p>` + words("CLOSING", 400) + `</p>`} {
		page := `<html><body><div class="content-sidebar-wrap"><p>` + words("OPENING", 300) + `</p><ul>` + strings.Repeat(`<li>`+words("ITEM", 100)+`</li>`, 12) +
			`</ul><div class="sidebar"><div><p>` + words("SIDE", 300) + `</p></div></div><div class="content-with-sidebar"><div><p>` + words("SECTION", 300) +
			`</p></div></div></div>` + closing + `</body></html>`
		text = extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
		if !strings.HasPrefix(text, "OPENING") || strings.Count(text, "ITEM") != 12 || !strings.Contains(text, "SECTION") ||
			strings.Contains(text, "CLOSING") != (closing != "") || strings.Contains(text, "SIDE") {
			t.Fatalf("the wrapper's text (and the closing %q) is the text, without the sidebar (%d bytes):\n%s", closing, len(text), text)
		}
	}
	// Comments inside a list item, each too short to be scored by itself, are not the item's own text: they do not
	// widen a story to the rest of the page.
	talk := `<div><ul><li><div class="comments">` + strings.Repeat(`<p>`+words("TALK", 20)+`</p>`, 30) + `</div></li></ul></div>`
	page := `<html><body><div class="story"><p>` + words("STORY", 1000) + `</p></div>` + talk + `<p>` + words("ELSE", 100) + `</p></body></html>`
	text = extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
	if !strings.HasPrefix(text, "STORY") || strings.Contains(text, "TALK") || strings.Contains(text, "ELSE") {
		t.Fatalf("the story alone is the text (%d bytes):\n%s", len(text), text)
	}
	// A paragraph inside a link, a card that leads to another page, is link text and not the page's own.
	page = `<html><body><div class="story"><p>` + words("STORY", 1000) + `</p></div><div class="card"><a href="/other"><p>` + words("CARD", 250) + `</p></a></div></body></html>`
	text = extractHTML(page, mustURL("https://example.com/"), 1<<20).Text
	if !strings.HasPrefix(text, "STORY") || strings.Contains(text, "CARD") {
		t.Fatalf("the story alone is the text, without the card (%d bytes):\n%s", len(text), text)
	}
}

// The best block's own text always counts, whatever the names around or inside it, so a little text elsewhere on the
// page is not a reason to widen: an article in a wrapper named "content-with-sidebar", a forum's posts classed
// "comment-body" (counted as nothing, either was widened to the whole page for 250 characters).
func TestExtractKeepsATextWhoseNamesLookLikeBlocksBesideIt(t *testing.T) {
	elsewhere := `<div class="box"><p>` + words("ELSEWHERE", 250) + `</p></div>`
	for name, page := range map[string]string{
		"a layout wrapper": `<div class="content-with-sidebar"><div class="post">` + strings.Repeat(`<p>`+words("TEXT", 300)+`</p>`, 7) + `</div></div>`,
		"a forum's posts":  `<div class="thread">` + strings.Repeat(`<div class="comment-body"><p>`+words("TEXT", 150)+`</p></div>`, 10) + `</div>`,
	} {
		text := extractHTML(`<html><body>`+page+elsewhere+`</body></html>`, mustURL("https://example.com/"), 1<<20).Text
		if !strings.HasPrefix(text, "TEXT") || strings.Contains(text, "ELSEWHERE") || len(text) < 1400 {
			t.Fatalf("%s: the block is the text, as before (%d bytes):\n%.300s", name, len(text), text)
		}
	}
}

// An outer paragraph counts what its inner ones do not hold: a list item's own words beside a paragraph inside it are
// each counted once (the item's whole text and the paragraph's together would count the paragraph twice, and the
// list would seem to hold too much of the page to be widened).
func TestExtractCountsAnItemsOwnWordsAndItsParagraphOnce(t *testing.T) {
	items := strings.Repeat(`<li>`+words("DIRECT", 100)+`<p>`+words("INNER", 100)+`</p></li>`, 6)
	around := strings.Repeat(`<p>`+words("AROUND", 100)+`</p>`, 3)
	text := extractHTML(`<html><body><div><ul>`+items+`</ul></div>`+around+`</body></html>`, mustURL("https://example.com/"), 1<<20).Text
	if strings.Count(text, "DIRECT") != 6 || strings.Count(text, "INNER") != 6 || strings.Count(text, "AROUND") != 3 {
		t.Fatalf("the list and the text around it are one page (%d bytes):\n%s", len(text), text)
	}
	// Three deep, a quotation's own words, its list's items and their paragraphs: each paragraph is taken from the one
	// it is directly inside, so the quotation still counts its own words, and a sixth as much text around it is too
	// little to widen for (taken from the quotation too, the paragraphs would leave it holding only its list).
	quoted := `<div><blockquote>` + words("QUOTED", 600) + `<ul>` + items + `</ul></blockquote></div>`
	text = extractHTML(`<html><body>`+quoted+around+`</body></html>`, mustURL("https://example.com/"), 1<<20).Text
	if !strings.Contains(text, "QUOTED") || strings.Count(text, "INNER") != 6 || strings.Contains(text, "AROUND") {
		t.Fatalf("the quotation is the text, without the little around it (%d bytes):\n%s", len(text), text)
	}
}

// Hidden text stays out of a table and a list wherever the reader walks them: a hidden row group, a hidden row, a
// table in a form in a cell, a hidden list inside an item. In a block the reader widened to, and in an article.
func TestExtractKeepsHiddenRowsAndListsOut(t *testing.T) {
	table := `<table><tbody hidden><tr><td>SECRET-A</td></tr></tbody><tbody><tr><td>SHOWN-ROW</td></tr><tr style="display:none"><td>SECRET-B</td></tr>
<tr><td><form><table><tr><td>SECRET-C</td></tr></table></form>SHOWN-CELL</td></tr></tbody></table>`
	list := `<ul><li>SHOWN-ITEM<ul hidden><li>SECRET-D</li></ul><ol style="display:none"><li>SECRET-E</li></ol><ul><li>SHOWN-INNER</li></ul></li></ul>`
	story := `<p>` + words("STORY", 1900) + `</p>`
	for name, page := range map[string]string{
		"widened to the body": `<div class="story">` + story + `</div><p>` + words("MORE", 650) + `</p>` + table + list,
		"an article":          `<article>` + story + table + list + `</article>`,
	} {
		text := extractHTML(`<html><body>`+page+`</body></html>`, mustURL("https://example.com/"), 1<<20).Text
		for _, want := range []string{"STORY", "SHOWN-ROW", "SHOWN-CELL", "SHOWN-ITEM", "SHOWN-INNER"} {
			if !strings.Contains(text, want) {
				t.Fatalf("%s: %q is missing:\n%s", name, want, text)
			}
		}
		if strings.Contains(text, "SECRET") || strings.Contains(text, "MORE") != (name == "widened to the body") {
			t.Fatalf("%s: hidden text kept, or the wrong block:\n%s", name, text)
		}
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
