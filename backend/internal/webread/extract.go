package webread

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

type extractedPage struct {
	Title, Byline, Published, Lang, Text string
	Links                                []Link
}

const (
	maxPageLinks       = 50
	minMainCandidate   = 140
	paragraphLinkLimit = 0.5
)

// Elements whose content a person does not read as the page's text.
var skippedElements = map[atom.Atom]bool{
	atom.Script: true, atom.Style: true, atom.Noscript: true, atom.Svg: true, atom.Template: true, atom.Iframe: true,
	atom.Object: true, atom.Embed: true, atom.Canvas: true, atom.Form: true, atom.Input: true, atom.Select: true,
	atom.Textarea: true, atom.Button: true, atom.Nav: true, atom.Aside: true, atom.Footer: true, atom.Head: true,
	atom.Dialog: true, atom.Math: true, atom.Audio: true, atom.Video: true, atom.Picture: true, atom.Source: true,
}

var hiddenStyle = regexp.MustCompile(`(?i)(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*(;|!|$)|font-size\s*:\s*0(px|em|rem|%)?\s*(;|!|$)|(^|;|\s)height\s*:\s*0(px)?\s*(;|!|$)|(^|;|\s)width\s*:\s*0(px)?\s*(;|!|$))`)

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func hasAttr(n *html.Node, key string) bool {
	for _, a := range n.Attr {
		if a.Key == key {
			return true
		}
	}
	return false
}

// hidden reports content kept out of sight: the hidden attribute, aria-hidden, or an inline style that hides it.
func hidden(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	return hasAttr(n, "hidden") || strings.EqualFold(attr(n, "aria-hidden"), "true") || hiddenStyle.MatchString(attr(n, "style"))
}

func skipped(n *html.Node, keepHeader bool) bool {
	if n.Type == html.CommentNode {
		return true
	}
	if n.Type != html.ElementNode {
		return false
	}
	if hidden(n) || skippedElements[n.DataAtom] {
		return true
	}
	return n.DataAtom == atom.Header && !keepHeader
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

// plainText is the visible text under n, whitespace collapsed.
func plainText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if skipped(n, true) {
			return
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
			b.WriteByte(' ')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return collapse(b.String())
}

func findAll(root *html.Node, match func(*html.Node) bool) []*html.Node {
	var found []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if match(n) {
			found = append(found, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return found
}

func first(root *html.Node, match func(*html.Node) bool) *html.Node {
	if all := findAll(root, match); len(all) > 0 {
		return all[0]
	}
	return nil
}

func element(tag atom.Atom) func(*html.Node) bool {
	return func(n *html.Node) bool { return n.Type == html.ElementNode && n.DataAtom == tag }
}

func meta(root *html.Node, keys ...string) string {
	for _, key := range keys {
		if n := first(root, func(n *html.Node) bool {
			return n.Type == html.ElementNode && n.DataAtom == atom.Meta && (strings.EqualFold(attr(n, "property"), key) || strings.EqualFold(attr(n, "name"), key))
		}); n != nil {
			if value := collapse(attr(n, "content")); value != "" {
				return value
			}
		}
	}
	return ""
}

// extractHTML reduces a page to its main readable content as compact Markdown, with its metadata and links.
func extractHTML(document string, base *url.URL, maxBytes int) extractedPage {
	root, err := html.Parse(strings.NewReader(document))
	page := extractedPage{Links: []Link{}}
	if err != nil {
		return page
	}
	page.Title = meta(root, "og:title")
	if page.Title == "" {
		if n := first(root, element(atom.Title)); n != nil {
			page.Title = collapse(textOf(n))
		}
	}
	if page.Title == "" {
		if n := first(root, element(atom.H1)); n != nil {
			page.Title = plainText(n)
		}
	}
	page.Byline = meta(root, "author", "article:author")
	page.Published = meta(root, "article:published_time")
	if page.Published == "" {
		if n := first(root, func(n *html.Node) bool {
			return n.Type == html.ElementNode && n.DataAtom == atom.Time && attr(n, "datetime") != ""
		}); n != nil {
			page.Published = attr(n, "datetime")
		}
	}
	if page.Published == "" {
		page.Published = meta(root, "date", "pubdate", "publish-date")
	}
	if n := first(root, element(atom.Html)); n != nil {
		page.Lang = attr(n, "lang")
	}
	main := mainContent(root)
	w := &markdownWriter{base: base, seen: map[string]bool{}, limit: maxBytes + 4096}
	w.block(main, 0)
	w.flush()
	page.Text, page.Links = w.out.String(), w.links
	return page
}

func textOf(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			b.WriteString(c.Data)
		}
	}
	return b.String()
}

// mainContent picks the element holding the page's text: a single sizeable <article>, else <main>, else the block
// with the best score (each paragraph's text, less its links, credited to its parent and half to its grandparent).
func mainContent(root *html.Node) *html.Node {
	body := first(root, element(atom.Body))
	if body == nil {
		body = root
	}
	// A candidate counts only if neither it nor anything around it is hidden: an article inside a hidden block is
	// text the reader of the page never sees.
	var articles []*html.Node
	for _, n := range findAll(body, element(atom.Article)) {
		if !insideSkipped(n) && utf8.RuneCountInString(plainText(n)) >= minMainCandidate {
			articles = append(articles, n)
		}
	}
	if len(articles) == 1 {
		return articles[0]
	}
	if n := first(body, func(n *html.Node) bool { return element(atom.Main)(n) && !insideSkipped(n) }); n != nil && utf8.RuneCountInString(plainText(n)) >= minMainCandidate {
		return n
	}
	scores := map[*html.Node]float64{}
	for _, p := range findAll(body, func(n *html.Node) bool {
		return n.Type == html.ElementNode && (n.DataAtom == atom.P || n.DataAtom == atom.Pre || n.DataAtom == atom.Li || n.DataAtom == atom.Blockquote || n.DataAtom == atom.Td)
	}) {
		if insideSkipped(p) {
			continue
		}
		text := plainText(p)
		length := float64(utf8.RuneCountInString(text))
		if length < 25 {
			continue
		}
		links := 0.0
		for _, a := range findAll(p, element(atom.A)) {
			links += float64(utf8.RuneCountInString(plainText(a)))
		}
		if links/length > paragraphLinkLimit {
			continue
		}
		score := length - links
		if parent := p.Parent; parent != nil {
			scores[parent] += score
			if grand := parent.Parent; grand != nil {
				scores[grand] += score / 2
			}
		}
	}
	best, bestScore := body, 0.0
	for n, score := range scores {
		if score > bestScore && n.Type == html.ElementNode && utf8.RuneCountInString(plainText(n)) >= minMainCandidate {
			best, bestScore = n, score
		}
	}
	return best
}

func insideSkipped(n *html.Node) bool {
	for p := n; p != nil; p = p.Parent {
		if skipped(p, true) {
			return true
		}
	}
	return false
}

var (
	zeroWidth   = regexp.MustCompile(`[\x{200b}-\x{200f}\x{202a}-\x{202e}\x{2060}\x{2066}-\x{2069}\x{feff}\x{180e}]`)
	blankLines  = regexp.MustCompile(`\n{3,}`)
	trailingSps = regexp.MustCompile(`[ \t]+\n`)
)

// cleanText drops invisible formatting characters and control characters (except newline and tab) and tidies
// blank lines.
func cleanText(s string) string {
	s = zeroWidth.ReplaceAllString(strings.ReplaceAll(s, "\r\n", "\n"), "")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r == '\r' || unicode.IsControl(r) || (r >= 0xe0000 && r <= 0xe007f) {
			return -1
		}
		return r
	}, s)
	s = trailingSps.ReplaceAllString(s, "\n")
	return strings.TrimSpace(blankLines.ReplaceAllString(s, "\n\n"))
}

func escapeLinkText(s string) string {
	return strings.NewReplacer("[", `\[`, "]", `\]`).Replace(s)
}
