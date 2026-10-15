package webread

import (
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// markdownWriter renders the chosen content as compact Markdown: headings, paragraphs, lists, quotes, code blocks,
// simple tables and links. It stops growing once past limit; the caller cuts the final text.
type markdownWriter struct {
	out   strings.Builder
	para  strings.Builder
	base  *url.URL
	links []Link
	seen  map[string]bool
	limit int
}

func (w *markdownWriter) full() bool { return w.out.Len() > w.limit }

func (w *markdownWriter) emit(block string) {
	if block = strings.TrimSpace(block); block != "" && !w.full() {
		if w.out.Len() > 0 {
			w.out.WriteString("\n\n")
		}
		w.out.WriteString(block)
	}
}

func (w *markdownWriter) flush() {
	text := strings.TrimSpace(w.para.String())
	w.para.Reset()
	if text != "" {
		w.emit(text)
	}
}

func headingLevel(a atom.Atom) int {
	switch a {
	case atom.H1:
		return 1
	case atom.H2:
		return 2
	case atom.H3:
		return 3
	case atom.H4:
		return 4
	case atom.H5:
		return 5
	case atom.H6:
		return 6
	}
	return 0
}

var inlineElements = map[atom.Atom]bool{
	atom.A: true, atom.Span: true, atom.Strong: true, atom.B: true, atom.Em: true, atom.I: true, atom.Code: true, atom.Img: true,
	atom.Small: true, atom.Sup: true, atom.Sub: true, atom.Mark: true, atom.Abbr: true, atom.Time: true, atom.Label: true, atom.U: true,
	atom.S: true, atom.Q: true, atom.Cite: true, atom.Kbd: true, atom.Var: true, atom.Samp: true, atom.Data: true, atom.Br: true,
}

// block renders n's children as blocks; loose text and inline elements gather into the current paragraph.
func (w *markdownWriter) block(n *html.Node, depth int) {
	for c := n.FirstChild; c != nil && !w.full(); c = c.NextSibling {
		if skipped(c, true) {
			continue
		}
		if c.Type == html.TextNode {
			w.para.WriteString(collapseKeepEdges(c.Data))
			continue
		}
		if c.Type != html.ElementNode {
			continue
		}
		if level := headingLevel(c.DataAtom); level > 0 {
			w.flush()
			if text := strings.TrimSpace(w.inline(c)); text != "" {
				w.emit(strings.Repeat("#", level) + " " + text)
			}
			continue
		}
		switch c.DataAtom {
		case atom.P:
			w.flush()
			w.emit(w.inline(c))
		case atom.Ul, atom.Ol:
			w.flush()
			w.emit(w.list(c, depth))
		case atom.Pre:
			w.flush()
			if code := strings.Trim(rawText(c), "\n"); strings.TrimSpace(code) != "" {
				w.emit("```\n" + strings.ReplaceAll(code, "```", "``\\`") + "\n```")
			}
		case atom.Blockquote:
			w.flush()
			inner := &markdownWriter{base: w.base, seen: w.seen, limit: w.limit}
			inner.block(c, depth)
			inner.flush()
			w.links = append(w.links, inner.links...)
			if quoted := strings.TrimSpace(inner.out.String()); quoted != "" {
				w.emit("> " + strings.ReplaceAll(quoted, "\n", "\n> "))
			}
		case atom.Table:
			w.flush()
			w.emit(w.table(c))
		case atom.Hr:
			w.flush()
			w.emit("---")
		default:
			if inlineElements[c.DataAtom] {
				w.para.WriteString(w.inlineNode(c))
				continue
			}
			w.flush()
			w.block(c, depth)
			w.flush()
		}
	}
}

func collapseKeepEdges(s string) string {
	inner := collapse(s)
	if inner == "" {
		if strings.TrimSpace(s) == "" && s != "" {
			return " "
		}
		return ""
	}
	if strings.IndexFunc(s[:1], func(r rune) bool { return r == ' ' || r == '\n' || r == '\t' || r == '\r' }) == 0 {
		inner = " " + inner
	}
	if last := s[len(s)-1]; last == ' ' || last == '\n' || last == '\t' || last == '\r' {
		inner += " "
	}
	return inner
}

// inline is the inline Markdown of n's children, trimmed.
func (w *markdownWriter) inline(n *html.Node) string {
	return strings.TrimSpace(collapseSpaces(w.inlineRaw(n)))
}

// inlineRaw keeps the whitespace the source has at the edges of its text, so "<b>bold</b>," stays "bold,".
func (w *markdownWriter) inlineRaw(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(w.inlineNode(c))
	}
	return b.String()
}

func collapseSpaces(s string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = strings.Join(strings.Fields(line), " ")
	}
	return strings.Join(lines, "\n")
}

func (w *markdownWriter) inlineNode(c *html.Node) string {
	if skipped(c, true) {
		return ""
	}
	switch c.Type {
	case html.TextNode:
		return collapseKeepEdges(c.Data)
	case html.ElementNode:
	default:
		return ""
	}
	switch c.DataAtom {
	case atom.Br:
		return "\n"
	case atom.Img:
		if alt := collapse(attr(c, "alt")); alt != "" {
			return " " + alt + " "
		}
		return ""
	case atom.Code, atom.Kbd, atom.Samp:
		if text := collapse(plainText(c)); text != "" {
			return "`" + strings.ReplaceAll(text, "`", "'") + "`"
		}
		return ""
	case atom.A:
		text := strings.TrimSpace(w.inline(c))
		href := w.resolve(attr(c, "href"))
		if href == "" || text == "" {
			return text
		}
		w.addLink(text, href)
		return "[" + escapeLinkText(text) + "](" + href + ")"
	}
	if inlineElements[c.DataAtom] {
		return w.inlineRaw(c)
	}
	// A block element inside running text still separates words.
	return " " + w.inlineRaw(c) + " "
}

func (w *markdownWriter) resolve(href string) string {
	href = strings.TrimSpace(href)
	if href == "" || strings.HasPrefix(href, "#") || w.base == nil {
		return ""
	}
	u, err := w.base.Parse(href)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return ""
	}
	u.Fragment = ""
	return strings.NewReplacer("(", "%28", ")", "%29", " ", "%20").Replace(u.String())
}

func (w *markdownWriter) addLink(text, href string) {
	if len(w.links) >= maxPageLinks || w.seen[href] {
		return
	}
	w.seen[href] = true
	w.links = append(w.links, Link{Text: text, URL: href})
}

func (w *markdownWriter) list(n *html.Node, depth int) string {
	var lines []string
	ordinal := 0
	ordered := n.DataAtom == atom.Ol
	indent := strings.Repeat("  ", depth)
	for li := n.FirstChild; li != nil; li = li.NextSibling {
		if li.Type != html.ElementNode || li.DataAtom != atom.Li || skipped(li, true) {
			continue
		}
		ordinal++
		marker := "- "
		if ordered {
			marker = strconv.Itoa(ordinal) + ". "
		}
		var text strings.Builder
		var nested []string
		for c := li.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && (c.DataAtom == atom.Ul || c.DataAtom == atom.Ol) {
				if sub := w.list(c, depth+1); sub != "" {
					nested = append(nested, sub)
				}
				continue
			}
			text.WriteString(w.inlineNode(c))
		}
		line := strings.TrimSpace(collapseSpaces(text.String()))
		if line == "" && len(nested) == 0 {
			continue
		}
		lines = append(lines, indent+marker+strings.ReplaceAll(line, "\n", " "))
		lines = append(lines, nested...)
	}
	return strings.Join(lines, "\n")
}

func (w *markdownWriter) table(n *html.Node) string {
	var rows [][]string
	for _, tr := range findAll(n, element(atom.Tr)) {
		var cells []string
		for c := tr.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && (c.DataAtom == atom.Td || c.DataAtom == atom.Th) && !skipped(c, true) {
				cells = append(cells, strings.ReplaceAll(strings.ReplaceAll(w.inline(c), "\n", " "), "|", `\|`))
			}
		}
		if len(cells) > 0 {
			rows = append(rows, cells)
		}
	}
	if len(rows) == 0 {
		return ""
	}
	width := 0
	for _, row := range rows {
		width = max(width, len(row))
	}
	var b strings.Builder
	for i, row := range rows {
		for len(row) < width {
			row = append(row, "")
		}
		b.WriteString("| " + strings.Join(row, " | ") + " |\n")
		if i == 0 {
			b.WriteString("|" + strings.Repeat(" --- |", width) + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// rawText keeps a code block's own whitespace.
func rawText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == html.ElementNode && n.DataAtom == atom.Br {
			b.WriteByte('\n')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !skipped(c, true) {
				walk(c)
			}
		}
	}
	walk(n)
	return b.String()
}
