package app

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testPDF builds a small, valid PDF: one page per entry of pages, each a content stream drawn with font F1 (a
// standard Latin font) and F2 (a font whose codes mean something only through its ToUnicode map, as in the PDFs
// Chrome prints: <01> 你, <02> 好, <03> ⼈ (a Kangxi radical look-alike), <04> ⻚).
func testPDF(t *testing.T, pages ...string) []byte {
	t.Helper()
	cmap := "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n" +
		"4 beginbfchar\n<01> <4F60>\n<02> <597D>\n<03> <2F08>\n<04> <2EDA>\nendbfchar\nendcmap\nend\nend\n"
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"", // pages, filled below
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding << /Type /Encoding /Differences [1 /g1 /g2 /g3 /g4] >> /ToUnicode 5 0 R >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(cmap), cmap),
	}
	kids := []string{}
	for _, content := range pages {
		contentID := len(objects) + 1
		objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content)+1, content))
		pageID := len(objects) + 1
		objects = append(objects, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>", contentID))
		kids = append(kids, fmt.Sprintf("%d 0 R", pageID))
	}
	objects[1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(pages))
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for i, object := range objects {
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return b.Bytes()
}

func writeTemp(t *testing.T, data []byte) (string, int64) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "doc.pdf")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path, int64(len(data))
}

func TestPDFTextReadsToUnicodeFontsAndFoldsLookAlikes(t *testing.T) {
	path, size := writeTemp(t, testPDF(t,
		"BT /F1 12 Tf 72 720 Td (Quarterly report) Tj 0 -20 Td (Revenue grew) Tj ET\nBT /F2 12 Tf 72 680 Td <01020304> Tj ET",
		"BT /F1 12 Tf 72 720 Td [(Page) -300 (two)] TJ ET"))
	text, truncated, note := pdfText(path, size, 4096)
	if truncated || note != "" {
		t.Fatal("a small PDF is read whole", truncated, note)
	}
	for _, want := range []string{"Quarterly report", "Revenue grew", "你好人页", "Page two"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %q", want, text)
		}
	}
	if strings.ContainsAny(text, "\u2F08\u2EDA") {
		t.Fatal("radical look-alikes are folded to the characters", text)
	}
}

func TestPDFTextBoundsAndRefusals(t *testing.T) {
	long := strings.Repeat("(abcdefghij) Tj ", 400)
	path, size := writeTemp(t, testPDF(t, "BT /F1 12 Tf 72 720 Td "+long+"ET"))
	text, truncated, _ := pdfText(path, size, 100)
	if len(text) > 100 || !truncated {
		t.Fatal("the text is cut to the budget and says so", len(text), truncated)
	}
	if text, _, note := pdfText(path, size, 0); text != "" || note != "" {
		t.Fatal("no budget, no work")
	}
	empty, emptySize := writeTemp(t, testPDF(t, "0 0 m 100 100 l S"))
	if text, _, note := pdfText(empty, emptySize, 4096); text != "" || note != pdfNoText {
		t.Fatal("a PDF without a text layer says so", text, note)
	}
	broken, brokenSize := writeTemp(t, []byte("%PDF-1.4\nthis is not a pdf at all\n%%EOF\n"))
	if text, _, note := pdfText(broken, brokenSize, 4096); text != "" || !strings.Contains(note, "could not be read") {
		t.Fatal("a damaged PDF is reported, never a panic", text, note)
	}
	if text, _, _ := pdfText(path, maxPDFDocumentBytes+1, 4096); text != "" {
		t.Fatal("past the size bound nothing is read")
	}
}

func TestAttachmentsQuotePDFText(t *testing.T) {
	path, size := writeTemp(t, testPDF(t, "BT /F2 12 Tf 72 720 Td <0102> Tj ET"))
	budget := maxAttachmentTotalText
	item := uploadAttachment{Name: "brief.pdf", Kind: uploadKindDocument, ContentType: "application/pdf", Size: size}
	(&App{}).describeAttachment(&item, path, &budget)
	if item.Text != "你好" || item.TextSource != "extracted" || budget != maxAttachmentTotalText-len("你好") {
		t.Fatal("a PDF's text is quoted like an Office document's", item, budget)
	}
}
