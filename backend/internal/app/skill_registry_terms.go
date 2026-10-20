package app

import (
	"html"
	"regexp"
	"strings"
	"unicode"
)

// How the license rules (skill_registry_license.go) read a skill's folder: which files hold its terms, and each text
// with what draws nothing left out and its white space folded, so a phrase reads the same however it is written, with a
// folded copy for a quick look before a pattern, which is slow on the megabytes a folder may hold.

var (
	// registryLicenseName is a license file's name, its words split (LICENSE, LICENSE2.txt, COMMERCIAL-LICENSE.md,
	// License (Proprietary).txt, UNLICENSE, ACME_EULA.pdf, Terms-of-Use.md, ACME_TERMS.md, LEGAL.md, AGREEMENT.md...),
	// registryNoticeName a notice's (NOTICE, COPYRIGHT, THIRD_PARTY_NOTICES.md...) and registryReadmeName the folder's
	// README (README.md, README.zh.md, README_CN.md...), read as SKILL.md's text is. registryNotTerms are such names
	// that hold a source-file header, a template or code instead, unless they are a license's translation, named in
	// capitals as translations are (registryTranslated: LICENSE.cs is Czech; License.cs and license.ts are code).
	registryLicenseName = regexp.MustCompile(`(?i)^(copying|terms)([^a-z]|$)|(^|[^a-z0-9])((un)?licen[cs](e|es|ing)|eula|legal|agreements?|terms[-_ ](of[-_ ](use|service)|and[-_ ]conditions))([^a-z]|$)`)
	registryNoticeName  = regexp.MustCompile(`(?i)(^|[^a-z0-9])(notices?|copyrights?)([^a-z]|$)`)
	registryReadmeName  = regexp.MustCompile(`(?i)^readme([._-][a-z]{2}([-_][a-z]{2})?)?(\.(md|markdown|txt|rst))?$`)
	registryNotTerms    = regexp.MustCompile(`(?i)header|template|tmpl|\.(py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1|bat|cmd|rb|go|rs|java|kt|c|h|cc|cpp|cs|php|pl|lua|swift)$`)
	registryTranslated  = regexp.MustCompile(`^(LICEN[CS]E|COPYING|NOTICE)\.[a-z]{2}$`)
	// registryCamel and registryAcronym split a CamelCase name into its words (CommercialLicense.md, ACMELicense.pdf).
	registryCamel   = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	registryAcronym = regexp.MustCompile(`([A-Z])([A-Z][a-z])`)
	// One folder down: every file of a terms folder holds terms (LICENSES/, as REUSE keeps them, legal/); an asset
	// folder's licenses are those of what it holds, which is not imported (fonts/, data/, templates/, examples/...); in
	// another content folder (docs/, references/, scripts/...) only a file named just LICENSE, COPYING or EULA is the
	// skill's.
	registryTermsFolder   = regexp.MustCompile(`(?i)^(licen[cs]es|legal)$`)
	registryAssetFolder   = regexp.MustCompile(`(?i)^(fonts?|assets?|vendors?|third[-_]?party|node_modules|images?|img|icons?|media|static|data|datasets?|templates?|examples?|samples?|fixtures|testdata|tests?)$`)
	registryContentFolder = regexp.MustCompile(`(?i)^(references?|docs?|lib|dist|build|resources?|public|scripts?|src|bin)$`)
	registryExactLicense  = regexp.MustCompile(`(?i)^((un)?licen[cs]e|copying|eula)(\.[a-z0-9]+)?$`)
)

// registryTermsWord is "terms" as a word anywhere in a name (ACME_TERMS.md), which may be a glossary as well.
var registryTermsWord = regexp.MustCompile(`(?i)(^|[^a-z0-9])terms([^a-z]|$)`)

// registryFileKind is how a file of a skill's folder holds its terms.
type registryFileKind int

const (
	registryNoTerms     registryFileKind = iota
	registryLicenseKind                  // a license file: shown, and the skill asks
	registryNoticeKind                   // a notice: read for terms
	registryReadmeKind                   // the README: read as SKILL.md's text is, shown when it states terms
	registryNamedKind                    // another name with "terms" in it: shown, and the skill asks, when it reads as terms
)

// registryTermsFile says how a file of a skill's folder holds its terms, at the folder's top or one folder down (see
// the folders above). Deeper down, a license is that content's.
func registryTermsFile(path string) registryFileKind {
	parts := strings.Split(path, "/")
	name := parts[len(parts)-1]
	if len(parts) > 2 || (registryNotTerms.MatchString(name) && !registryTranslated.MatchString(name)) {
		return registryNoTerms
	}
	if len(parts) == 2 {
		switch folder := parts[0]; {
		case registryTermsFolder.MatchString(folder):
			return registryLicenseKind
		case registryAssetFolder.MatchString(folder):
			return registryNoTerms
		case registryContentFolder.MatchString(folder):
			if registryExactLicense.MatchString(name) {
				return registryLicenseKind
			}
			return registryNoTerms
		}
	} else if registryReadmeName.MatchString(name) {
		return registryReadmeKind
	}
	words := registryAcronym.ReplaceAllString(registryCamel.ReplaceAllString(name, "$1-$2"), "$1-$2")
	switch {
	case registryLicenseName.MatchString(words):
		return registryLicenseKind
	case registryNoticeName.MatchString(words):
		return registryNoticeKind
	case registryTermsWord.MatchString(words):
		return registryNamedKind
	}
	return registryNoTerms
}

// registryHiddenRune is a character hiddenTextProblem names (skills.go); registryIgnorable any other that draws
// nothing and may sit inside a word (a soft hyphen, an invisible operator, a variation selector, the combining
// grapheme joiner). registryPlain drops both, so neither hides a word.
func registryHiddenRune(r rune) bool {
	return (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f || (r >= 0x200b && r <= 0x200f) || (r >= 0x202a && r <= 0x202e) ||
		(r >= 0x2066 && r <= 0x2069) || r == 0x2060 || r == 0xfeff || (r >= 0xe0000 && r <= 0xe007f)
}

func registryIgnorable(r rune) bool {
	return r >= 0x80 && unicode.In(r, unicode.Cf, unicode.Variation_Selector, unicode.Other_Default_Ignorable_Code_Point)
}

func registryPlain(s string) string {
	return strings.Map(func(r rune) rune {
		if registryHiddenRune(r) || registryIgnorable(r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
}

// registrySpaced folds every run of white space (a line break and a no-break space as much as a space) to one space.
func registrySpaced(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	space := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// registryFold lowercases a text for the quick look as the patterns' (?i) folds it: to them a long s is an s.
func registryFold(s string) string {
	if strings.ContainsRune(s, '\u017f') {
		s = strings.ReplaceAll(s, "\u017f", "s")
	}
	return strings.ToLower(s)
}

// registryTerms is a text as the license patterns read it (registryPlain, then registrySpaced), with its folded copy.
type registryTerms struct{ text, lower string }

func registryTermsOf(plain string) registryTerms {
	text := registrySpaced(plain)
	return registryTerms{text, registryFold(text)}
}

func readRegistryTerms(text string) registryTerms { return registryTermsOf(registryPlain(text)) }

// has runs pattern only when the text holds one of the words it needs.
func (t registryTerms) has(pattern *regexp.Regexp, words ...string) bool {
	for _, word := range words {
		if strings.Contains(t.lower, word) {
			return pattern.MatchString(t.text)
		}
	}
	return false
}

// withoutAnyUse sets aside the any use a permissive text allows (registryAnyUse); found says there was some.
func (t registryTerms) withoutAnyUse() (rest registryTerms, found bool) {
	if !strings.Contains(t.lower, "commercial") || !registryAnyUse.MatchString(t.text) {
		return t, false
	}
	text := registryAnyUse.ReplaceAllString(t.text, " ")
	return registryTerms{text, registryFold(text)}, true
}

// judge reads a text for terms that forbid reuse (registryForbids or registryFileForbids) once any use is set aside,
// and says whether it spoke of any use.
func (t registryTerms) judge(pattern *regexp.Regexp) (forbids, anyUse bool) {
	rest, anyUse := t.withoutAnyUse()
	return rest.has(pattern, "proprietary", "commercial", "deriv", "confidential", "distribution", "cc-by", "cc by"), anyUse
}

// markdownTerms says whether a SKILL.md (or README) states license terms, outside its code blocks, which show
// examples: anywhere in its prose (registryMarkdownTerms, or any use spoken of), or on a line of its body that names
// them (registryBodyTerms).
func markdownTerms(text, body string) bool {
	rest, anyUse := registryTermsOf(registryProse(withoutFences(registryPlain(text)))).withoutAnyUse()
	if anyUse || rest.has(registryMarkdownTerms, "reserved", "proprietary", "distribution", "commercial", "spdx") {
		return true
	}
	lines := registryLines(body)
	return registryTerms{lines, registryFold(lines)}.has(registryBodyTerms, "licen", "copyright", "terms", "legal", "\u00a9", "(c)")
}

var (
	// registryTag is an HTML tag in markdown, its name starting with a letter as CommonMark has it (a comment, which
	// may name terms, and text such as "<-- note -->" are not), read as a space; registryFence a fenced code block's
	// opening line: at most three spaces, then three or more backticks or tildes.
	registryTag   = regexp.MustCompile(`</?[A-Za-z][A-Za-z0-9-]*([\t ][^<>\n]{0,200})?/?>`)
	registryFence = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
)

// registryHTML reads a text's tags as spaces and decodes its HTML entities, then drops what draws nothing again, for
// an entity may stand for it (&shy;, &#8203;).
func registryHTML(text string) string {
	if !strings.ContainsAny(text, "<&") {
		return text
	}
	return registryPlain(html.UnescapeString(registryTag.ReplaceAllString(text, " ")))
}

// registryLines reads a body's lines as the page shows them: code blocks left out, then registryHTML.
func registryLines(body string) string { return registryHTML(withoutFences(registryPlain(body))) }

// registryProse reads markdown as prose: registryHTML, and its emphasis and code marks left out, so that markup
// between the words of a phrase does not part them.
func registryProse(text string) string {
	text = registryHTML(text)
	return strings.Map(func(r rune) rune {
		if r == '*' || r == '_' || r == '~' || r == '`' {
			return -1
		}
		return r
	}, text)
}

// withoutFences leaves out a markdown text's fenced code blocks, as CommonMark reads them: a backtick fence's opening
// line holds no other backtick, and a block closes only on a line of the same character, as many or more, indented at
// most three spaces and with nothing after it; a fence inside an HTML comment is the comment's text. A fence never
// closed leaves the text as it is.
func withoutFences(text string) string {
	var b strings.Builder
	open, comment := "", false
	for _, line := range strings.SplitAfter(text, "\n") {
		if open != "" {
			trimmed := strings.TrimRight(line, " \t\r\n")
			run := strings.TrimLeft(trimmed, " ")
			if len(trimmed)-len(run) <= 3 && len(run) >= len(open) && strings.Trim(run, open[:1]) == "" {
				open = ""
			}
			continue
		}
		fence := ""
		if !comment {
			fence = registryFence.FindString(line)
		}
		if fence != "" && !(fence[len(fence)-1] == '`' && strings.Contains(line[len(fence):], "`")) {
			open = strings.TrimLeft(fence, " ")
			continue
		}
		b.WriteString(line)
		if comment {
			if i := strings.LastIndex(line, "-->"); i >= 0 {
				comment = strings.Contains(line[i:], "<!--")
			}
		} else if i := strings.LastIndex(line, "<!--"); i >= 0 {
			comment = !strings.Contains(line[i:], "-->")
		}
	}
	if open != "" {
		return text
	}
	return b.String()
}
