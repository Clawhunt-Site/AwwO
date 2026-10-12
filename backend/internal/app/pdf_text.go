package app

import (
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/unicode/norm"
)

// PDF text for the model (owner request 2026-10-12: 加上 PDF 正文提取). A PDF attached to a message is read for its text
// layer, page by page, within the message's text budget, like an Office document (uploads.go describeAttachment).
//
// The text operators are decoded with each font's ToUnicode map first, then its simple encoding: PDFs printed by
// Chrome (HeadlessChrome/Skia) use Type3 fonts whose /Differences encoding is meaningless without ToUnicode, and the
// library's own extraction returns no Chinese at all for them (tested 2026-10-12 on three Chinese PDFs). Nothing is
// executed and nothing outside the file is read. Work is bounded: the file size, the number of pages, the output
// length, a time budget checked between pages, the size of each ToUnicode map, and two extractions at a time. A
// malformed file or page is skipped (the parser may panic; every document and page is recovered). Scanned or
// image-only PDFs have no text layer and are said to have none.

const (
	maxPDFDocumentBytes = 64 << 20
	maxPDFPages         = 120
	pdfTextBudget       = 8 * time.Second
	maxToUnicodeBytes   = 1 << 20
)

// pdfSlots bounds concurrent extractions: each one is a burst of CPU in the API process.
var pdfSlots = make(chan struct{}, 2)

// pdfNoText is the note for a PDF with no text layer.
const pdfNoText = "No text layer was found in this PDF (a scanned or image-only document), so its content is not quoted here."

// pdfText extracts up to limit bytes of a PDF's text. It reports whether the text was cut and, when there is none,
// why (a note for the model).
func pdfText(path string, size int64, limit int) (text string, truncated bool, note string) {
	if limit <= 0 || size <= 0 || size > maxPDFDocumentBytes {
		return "", false, ""
	}
	pdfSlots <- struct{}{}
	defer func() { <-pdfSlots }()
	defer func() {
		if recover() != nil {
			text, truncated, note = "", false, ""
		}
	}()
	file, err := os.Open(path)
	if err != nil {
		return "", false, ""
	}
	defer file.Close()
	reader, err := pdf.NewReader(file, size)
	if err != nil {
		// Encrypted with a password, or a broken cross-reference table.
		return "", false, "This PDF could not be read (it may be password-protected or damaged), so its content is not quoted here."
	}
	deadline := time.Now().Add(pdfTextBudget)
	pages := reader.NumPage()
	var out strings.Builder
	for i := 1; i <= pages; i++ {
		if i > maxPDFPages || time.Now().After(deadline) || out.Len() > limit {
			truncated = true
			break
		}
		page := pdfPageText(reader, i)
		if page == "" {
			continue
		}
		if out.Len() > 0 {
			out.WriteString("\n\n")
		}
		out.WriteString(page)
	}
	text = cleanPDFText(out.String())
	if len(text) > limit {
		text, truncated = text[:limit], true
		for len(text) > 0 && !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
	}
	if strings.TrimSpace(text) == "" {
		return "", false, pdfNoText
	}
	return text, truncated, ""
}

// pdfPageText is one page's text: the ToUnicode-first decoding, or the library's own when that finds no letters.
func pdfPageText(reader *pdf.Reader, n int) (text string) {
	defer func() {
		if recover() != nil {
			text = ""
		}
	}()
	page := reader.Page(n)
	if page.V.IsNull() {
		return ""
	}
	text = decodePDFPage(page)
	if !hasLetters(text) {
		if plain, err := page.GetPlainText(nil); err == nil {
			text = plain
		}
	}
	return text
}

func hasLetters(text string) bool {
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// cleanPDFText keeps printable text and line breaks, folds the CJK radical look-alikes Chrome emits (⼈ for 人) to
// the ordinary characters, and collapses runs of blank lines and spaces.
func cleanPDFText(text string) string {
	var b strings.Builder
	for _, r := range text {
		switch {
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r >= 0x2F00 && r <= 0x2FD5: // Kangxi radicals: NFKC maps each to its unified ideograph.
			b.WriteString(norm.NFKC.String(string(r)))
		case cjkRadicalSupplement[r] != 0:
			b.WriteRune(cjkRadicalSupplement[r])
		case unicode.IsControl(r) || r == utf8.RuneError || r == 0xFEFF:
		default:
			b.WriteRune(r)
		}
	}
	lines := strings.Split(b.String(), "\n")
	kept := make([]string, 0, len(lines))
	blank := 0
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if line == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// cjkRadicalSupplement maps the CJK Radicals Supplement code points whose glyph is a whole character (Chrome emits
// them for that character, as it emits ⻚ for 页) to the character; NFKC has no mapping for these. Radicals that are
// only ever parts of a character (亻, 氵) are left alone.
var cjkRadicalSupplement = map[rune]rune{
	0x2E9F: '母', 0x2EA0: '民', 0x2EC4: '西', 0x2EC5: '见', 0x2EC6: '角', 0x2EC9: '贝', 0x2ECB: '车', 0x2ED3: '长',
	0x2ED4: '门', 0x2ED7: '雨', 0x2ED8: '青', 0x2ED9: '韦', 0x2EDA: '页', 0x2EDB: '风', 0x2EDC: '飞', 0x2EDD: '食',
	0x2EE2: '马', 0x2EE3: '骨', 0x2EE4: '鬼', 0x2EE5: '鱼', 0x2EE6: '鸟', 0x2EE7: '卤', 0x2EE8: '麦', 0x2EE9: '黄',
	0x2EEA: '黾', 0x2EEC: '齐', 0x2EEE: '齿', 0x2EF0: '龙', 0x2EF3: '龟',
}

// pdfToUnicode is a font's ToUnicode map: code width in bytes and code -> text.
type pdfToUnicode struct {
	width int
	m     map[uint32]string
}

var (
	pdfCMapBlock = regexp.MustCompile(`(?s)begin(codespacerange|bfchar|bfrange)(.*?)end(?:codespacerange|bfchar|bfrange)`)
	pdfCMapToken = regexp.MustCompile(`<[0-9A-Fa-f\s]*>|\[|\]`)
)

func pdfHexBytes(t string) []byte {
	h := strings.Map(func(r rune) rune {
		if strings.ContainsRune("<> \t\r\n", r) {
			return -1
		}
		return r
	}, t)
	if len(h)%2 == 1 {
		h += "0"
	}
	b := make([]byte, len(h)/2)
	for i := range b {
		v, _ := strconv.ParseUint(h[2*i:2*i+2], 16, 8)
		b[i] = byte(v)
	}
	return b
}

func pdfCode(b []byte) uint32 {
	var c uint32
	for _, x := range b {
		c = c<<8 | uint32(x)
	}
	return c
}

func pdfUTF16(b []byte) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	return string(utf16.Decode(u))
}

func parsePDFToUnicode(v pdf.Value) *pdfToUnicode {
	rd := v.Reader()
	defer rd.Close()
	raw, _ := io.ReadAll(io.LimitReader(rd, maxToUnicodeBytes))
	tu := &pdfToUnicode{m: map[uint32]string{}}
	for _, block := range pdfCMapBlock.FindAllSubmatch(raw, -1) {
		tokens := pdfCMapToken.FindAllString(string(block[2]), -1)
		switch string(block[1]) {
		case "codespacerange":
			if len(tokens) > 0 && tu.width == 0 {
				tu.width = len(pdfHexBytes(tokens[0]))
			}
		case "bfchar":
			for i := 0; i+1 < len(tokens); i += 2 {
				tu.m[pdfCode(pdfHexBytes(tokens[i]))] = pdfUTF16(pdfHexBytes(tokens[i+1]))
			}
		case "bfrange":
			for i := 0; i+2 < len(tokens); {
				lo, hi := pdfCode(pdfHexBytes(tokens[i])), pdfCode(pdfHexBytes(tokens[i+1]))
				if tokens[i+2] == "[" {
					j, c := i+3, lo
					for ; j < len(tokens) && tokens[j] != "]"; j, c = j+1, c+1 {
						tu.m[c] = pdfUTF16(pdfHexBytes(tokens[j]))
					}
					i = j + 1
					continue
				}
				base := []rune(pdfUTF16(pdfHexBytes(tokens[i+2])))
				for c := lo; c <= hi && c-lo < 0x10000 && len(base) > 0; c++ {
					r := append([]rune(nil), base...)
					r[len(r)-1] += rune(c - lo)
					tu.m[c] = string(r)
				}
				i += 3
			}
		}
	}
	if tu.width <= 0 || tu.width > 4 {
		tu.width = 2
	}
	return tu
}

// pdfFont decodes one font's strings: ToUnicode when the font has one, else its single-byte encoding.
type pdfFont struct {
	tu    *pdfToUnicode
	cp    *charmap.Charmap
	width int
}

func newPDFFont(f pdf.Value) *pdfFont {
	d := &pdfFont{width: 1, cp: charmap.Windows1252}
	if f.Key("Subtype").Name() == "Type0" {
		d.width = 2
	}
	if f.Key("Encoding").Name() == "MacRomanEncoding" {
		d.cp = charmap.Macintosh
	}
	if tu := f.Key("ToUnicode"); tu.Kind() == pdf.Stream {
		d.tu = parsePDFToUnicode(tu)
		d.width = d.tu.width
	}
	return d
}

func (d *pdfFont) decode(s string, out *strings.Builder) {
	b := []byte(s)
	for i := 0; i+d.width <= len(b); i += d.width {
		if d.tu != nil {
			if t, ok := d.tu.m[pdfCode(b[i:i+d.width])]; ok {
				out.WriteString(t)
				continue
			}
		}
		if d.width == 1 {
			out.WriteRune(d.cp.DecodeByte(b[i]))
		}
	}
}

// decodePDFPage runs a page's content streams through the text operators, starting a new line where the text moves
// to another line and a space where a TJ array jumps forward.
func decodePDFPage(p pdf.Page) string {
	fonts := map[string]*pdfFont{}
	var out strings.Builder
	var current *pdfFont
	var lastY float64
	interpret := func(stream pdf.Value) {
		pdf.Interpret(stream, func(stack *pdf.Stack, op string) {
			n := stack.Len()
			args := make([]pdf.Value, n)
			for i := n - 1; i >= 0; i-- {
				args[i] = stack.Pop()
			}
			switch op {
			case "Tf":
				if n >= 2 {
					name := args[0].Name()
					if fonts[name] == nil {
						fonts[name] = newPDFFont(p.Resources().Key("Font").Key(name))
					}
					current = fonts[name]
				}
			case "Td", "TD":
				if n >= 2 && args[1].Float64() != 0 {
					out.WriteByte('\n')
				}
			case "Tm":
				if n >= 6 && args[5].Float64() != lastY {
					lastY = args[5].Float64()
					out.WriteByte('\n')
				}
			case "T*":
				out.WriteByte('\n')
			case "Tj", "'", "\"":
				if op != "Tj" {
					out.WriteByte('\n')
				}
				if current != nil && n >= 1 {
					current.decode(args[n-1].RawString(), &out)
				}
			case "TJ":
				if current != nil && n >= 1 {
					for i := 0; i < args[0].Len(); i++ {
						if x := args[0].Index(i); x.Kind() == pdf.String {
							current.decode(x.RawString(), &out)
						} else if x.Float64() < -250 {
							out.WriteByte(' ')
						}
					}
				}
			}
		})
	}
	if contents := p.V.Key("Contents"); contents.Kind() == pdf.Array {
		for i := 0; i < contents.Len(); i++ {
			interpret(contents.Index(i))
		}
	} else {
		interpret(contents)
	}
	return out.String()
}
