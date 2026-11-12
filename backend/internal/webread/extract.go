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
	// How much more of the page's own text an ancestor must hold than the best-scoring block to be taken in its place
	// (wholeText): a fifth more, and at least mainGainLeast characters more.
	mainGain      = 1.2
	mainGainLeast = 200
)

// besideText matches the class or id of a block that stands beside a page's text and is not part of it: comments, a
// sidebar, related links, sharing, a table of contents. Outside the best-scoring block (and not around it: a layout
// wrapper named "content-with-sidebar" holds the text), its words do not count as the page's own text when the block
// is widened (wholeMain), and it is left out of the widened text, so an article is not widened to take them in.
var besideText = regexp.MustCompile(`(?i)comment|disqus|replies|sidebar|widget|related|share|social|sponsor|promo|advert|footer|masthead|breadcrumb|pagination|pager|popup|cookie|newsletter|subscribe|menu|navbar|\btoc\b`)

// layoutName matches a class or id that says how a block is laid out, not what it is: "content-with-sidebar",
// "has-comments", "no-sidebar", "sidebar-layout" name a block that holds the text.
var layoutName = regexp.MustCompile(`(?i)(^|[-_])(with|has|have|no|without|layout)([-_]|$)`)

// standsBeside asks each class and the id by itself, so one layout name beside a telling one hides nothing.
func standsBeside(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	for _, name := range strings.Fields(attr(n, "class") + " " + attr(n, "id")) {
		if besideText.MatchString(name) && !layoutName.MatchString(name) {
			return true
		}
	}
	return false
}

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

// findVisible is findAll without what a reader of the page does not see: nothing inside a hidden or skipped element
// under root is matched (root itself is the caller's to judge).
func findVisible(root *html.Node, match func(*html.Node) bool) []*html.Node {
	var found []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if match(n) {
			found = append(found, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !skipped(c, true) {
				walk(c)
			}
		}
	}
	walk(root)
	return found
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
// with the best score (each paragraph's text, less its links, credited to its parent and half to its grandparent),
// widened to the ancestor that holds the whole text when that block is only a part of it (wholeMain).
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
	var credited []*html.Node
	credit := func(n *html.Node, score float64) {
		if _, known := scores[n]; !known {
			credited = append(credited, n)
		}
		scores[n] += score
	}
	// The scored paragraphs, in the page's order, for wholeMain.
	var paragraphs []*html.Node
	scored := map[*html.Node]bool{}
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
			credit(parent, score)
			if grand := parent.Parent; grand != nil {
				credit(grand, score/2)
			}
		}
		scored[p] = true
		paragraphs = append(paragraphs, p)
	}
	// Asked in the order the page credits them, never a map's: of two blocks with the same score the later one is
	// taken on every read (a table cell's own row, not the row of the table around it, which scores the same and
	// was taken on some reads and not on others).
	best, bestScore := body, 0.0
	for _, n := range credited {
		if score := scores[n]; score >= bestScore && score > 0 && n.Type == html.ElementNode && utf8.RuneCountInString(plainText(n)) >= minMainCandidate {
			best, bestScore = n, score
		}
	}
	return wholeMain(best, body, paragraphs, scored)
}

// wholeMain widens the best-scoring block to the ancestor that holds the page's whole text. The score credits a
// paragraph to its parent and half to its grandparent, so on a page whose text is several lists or sections side by
// side under headings (a reference page, generated documentation) the longest list alone wins, and the page's opening
// and its other sections were dropped.
//
// held is the page's own text each element holds: every scored paragraph's own text (ownText: what the scored
// paragraphs inside it do not hold, links apart) counted once, for the paragraph and each of its ancestors up to the
// body. The text of the best block always counts. Outside it, the text of a block that stands beside the text
// (standsBeside: comments, a sidebar) counts for nothing; the blocks around the best block are never such a block,
// whatever their names (a wrapper that holds the text and its sidebar). When the block is widened, the blocks beside
// the text are taken out of what it was widened to, so what did not count is not kept either.
func wholeMain(best, body *html.Node, paragraphs []*html.Node, scored map[*html.Node]bool) *html.Node {
	around := map[*html.Node]bool{}
	for a := best; a != body && a.Parent != nil; {
		a = a.Parent
		around[a] = true
	}
	// Each element's name is asked once: a page of ten thousand paragraphs under one wrapper asks the wrapper's once.
	asked := map[*html.Node]bool{}
	named := func(n *html.Node) bool {
		is, known := asked[n]
		if !known {
			is = standsBeside(n)
			asked[n] = is
		}
		return is
	}
	beside := func(n *html.Node) bool {
		is := false
		for a := n; a != nil && a != best; a = a.Parent {
			if around[a] {
				return is
			}
			is = is || named(a)
		}
		return false
	}
	// The text under n that is n's paragraph's own: not what a scored paragraph inside holds, and, outside the best
	// block, not what a block beside the text holds (in the best block every name is the text's).
	var ownText func(n *html.Node, link, within bool) float64
	ownText = func(n *html.Node, link, within bool) float64 {
		total := 0.0
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			switch {
			case c.Type == html.TextNode:
				if !link {
					total += float64(utf8.RuneCountInString(collapse(c.Data)))
				}
			case c.Type != html.ElementNode || skipped(c, true) || scored[c]:
			case !within && c != best && !around[c] && named(c):
			default:
				total += ownText(c, link || c.DataAtom == atom.A, within || c == best)
			}
		}
		return total
	}
	within := func(n *html.Node) bool {
		for a := n; a != nil && !around[a]; a = a.Parent {
			if a == best {
				return true
			}
		}
		return false
	}
	// A paragraph inside a link (a card that leads to another page) is link text, all of it.
	linked := func(n *html.Node) bool {
		for a := n.Parent; a != nil && a != body; a = a.Parent {
			if a.Type == html.ElementNode && a.DataAtom == atom.A {
				return true
			}
		}
		return false
	}
	held := map[*html.Node]float64{}
	for _, p := range paragraphs {
		if beside(p) {
			continue
		}
		own := ownText(p, linked(p), within(p))
		for a := p; a != nil && own > 0; a = a.Parent {
			held[a] += own
			if a == body {
				break
			}
		}
	}
	whole := wholeText(best, body, held)
	if whole != best {
		dropBeside(whole, best, around, named)
	}
	return whole
}

// dropBeside takes the blocks that stand beside the text out of n, which the best block was widened to: not the best
// block or anything in it, and not the blocks around it.
func dropBeside(n, best *html.Node, around map[*html.Node]bool, named func(*html.Node) bool) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		switch {
		case c == best || c.Type != html.ElementNode:
		case !around[c] && named(c):
			n.RemoveChild(c)
		default:
			dropBeside(c, best, around, named)
		}
		c = next
	}
}

// wholeText is wholeMain's rule: an ancestor is taken in the block's place when it holds a fifth more of the page's
// own text than the block chosen so far (mainGain) and at least mainGainLeast characters more. Nothing above the body
// is taken.
func wholeText(best, body *html.Node, held map[*html.Node]float64) *html.Node {
	for a := best.Parent; a != nil && best != body; a = a.Parent {
		if a.Type == html.ElementNode && held[a] >= held[best]*mainGain && held[a]-held[best] >= mainGainLeast {
			best = a
		}
		if a == body {
			break
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
