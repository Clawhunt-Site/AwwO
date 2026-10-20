package app

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// What is known of the license an imported skill's text is under (skill_registry.go). skills.sh lists skills under
// their source repositories' licenses and relicenses nothing, and many skills there are not open: some declare
// themselves proprietary, many repositories have no license file at all. A skill is "open", and imported as it is,
// only when its SKILL.md declares a permissive license AwwO recognizes at its top level and nothing else speaks of
// licenses, or when nothing in the skill does and GitHub recognizes its repository's license as permissive (GitHub
// compares the whole text against each license's). A license file in the skill's folder is shown in full but never
// makes it open on its own: a text can carry a permissive license's words and terms of its own. Any other skill is
// imported only once the member has read its terms and confirmed they may use it here. A wrong "open" is the mistake
// that matters, so whatever is unclear makes a skill ask; how its texts are read is in skill_registry_terms.go.

const maxRegistryLicenseText = 16 << 10

// registryOpenLicenses are the permissive licenses a skill's text may be used under without asking. Copyleft ones
// (GPL, MPL, CC BY-SA and the like) attach terms of their own, so they ask, as an unknown license does.
var registryOpenLicenses = []string{"MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0", "CC-BY-4.0", "Zlib", "BSL-1.0", "UPL-1.0", "PostgreSQL"}

var (
	// registryForbids spots terms that forbid reuse outright in a declared license; registryFileForbids the phrases
	// that do in a license or notice file, where the words alone also come in licenses that allow reuse.
	registryForbids     = regexp.MustCompile(`(?i)\bproprietary\b|\bnon-?commercial\b|\bno[ -]?derivatives\b|\bnoderivs\b|\bconfidential\b|\bnot for (re)?distribution\b|\bcc[- ]by[- ](nc|nd)\b`)
	registryFileForbids = regexp.MustCompile(`(?i)\bproprietary (licen[cs]e|software|terms|and confidential|use)\b|\bnon-?commercial\b|\bno[ -]?derivatives\b|\bnoderivs\b|\bconfidential\b|\bnot for (re)?distribution\b`)
	// registryAnyUse is how a permissive text allows any use ("for any purpose, commercial or non-commercial", "free
	// for commercial and non-commercial use"). It is set aside before the words above are read, and makes a skill ask
	// wherever it is not in a license file (which asks anyway): the same words also refuse such use ("either
	// commercial or non-commercial use is prohibited").
	registryAnyUse = regexp.MustCompile(`(?i)\bfor any purpose,? (whether )?commercial,? (or|and|and/or) non-?commercial\b|\bfree (to use )?for (both )?commercial,? (and|or|and/or) non-?commercial\b|\b(both|either) commercial,? (and|or) non-?commercial\b`)
	// registryGNUTitle starts a GNU license, whose text names proprietary programs and noncommercial distribution
	// among what it governs, so a file that is one is not read for those words: as a license file it asks all the
	// same, and a notice that carries one asks too.
	registryGNUTitle = regexp.MustCompile(`(?i)^\s*GNU (AFFERO |LESSER |LIBRARY )?GENERAL PUBLIC LICENSE|^\s*GNU FREE DOCUMENTATION LICENSE`)
	// registryReserved is the "all rights reserved" an author keeps; a permissive license's copyright line may carry it
	// too, so it makes a skill ask rather than restricted. In a notice, which states rights rather than grants them,
	// the word proprietary does the same.
	registryReserved    = regexp.MustCompile(`(?i)all rights reserved`)
	registryProprietary = regexp.MustCompile(`(?i)\bproprietary\b`)
	// registryMarkdownTerms spots license terms in a SKILL.md (or README), which make it ask: an SPDX line, or reuse it
	// forbids. A skill's method may well speak of proprietary code or confidential data, so the words alone do not.
	registryMarkdownTerms = regexp.MustCompile(`(?i)all rights reserved|\bproprietary (licen[cs]e|software|terms)\b|\bnot for (re)?distribution\b|\bnon-?commercial (use|purposes)\b|\bspdx-license-identifier\b`)
	// registryBodyTerms is a line of a body that names its license, copyright or terms: a heading about them (also
	// after an emoji or a number), a table cell or a label ("License:", "**License:**", "License - ...", "1. Terms of
	// use:", "[License](...)", "<!-- License: ...", "Legal:"), "Licensed ...", "Terms and conditions", or a copyright
	// and a year or a name. The word used otherwise ("License the music you use", "License-free", a `license` field,
	// "Copyright law") does not count.
	registryBodyTerms = regexp.MustCompile(`(?im)^(` +
		`[\t ]*#{1,6}[\t ]*[^\pL\n]{0,12}(licen[cs](e|es|ing)|copyright|terms|legal)\b` +
		`|[\t ]*\|[\t ]*[*_]*(licen[cs](e|es|ing)|copyright|terms)[*_]*[\t ]*\|` +
		`|[\t >*_-]*(<!--[\t ]*)?(\d+[.)][\t ]+)?\[?[*_]*(licen[cs](e|es|ing)|copyright|terms( of (use|service))?|legal)[*_]*([\t ]*(:|=|\(|\]|$)|[\t ]+(-|\x{2013}|\x{2014}))` +
		`|[\t >*_-]*(licensed|terms and conditions)\b` +
		`|[\t >*_-]*(copyright[\t ]+(\x{00A9}|\(c\)|\d|(?-i:\p{Lu}|\p{Lo}))|\x{00A9}|\(c\)[\t ]*\d))`)
	// registryLicenseLine is a license key in a frontmatter, at any depth, as a list item or not, in either spelling
	// and case; registryLicenseKey any other key that names a license, terms or rights (licenses:, license-file:,
	// restrictions:, a key in a flow mapping), and registryTopLicenseKey such a key of several words at the top level
	// (License Terms:, Terms of Use:), each of which may say anything about them.
	registryLicenseLine   = regexp.MustCompile(`(?i)^([\t ]*)(-?)[\t ]*["']?licen[cs]e["']?[\t ]*:(.*)$`)
	registryLicenseKey    = regexp.MustCompile(`(?i)(^|[{,])[\t ]*-?[\t ]*["']?[a-z0-9_.-]*(licen[cs](e|ing)|copyright|eula|terms[-_ ]of|restriction|rights)[a-z0-9_.-]*["']?[\t ]*:`)
	registryTopLicenseKey = regexp.MustCompile(`(?i)^["']?([a-z0-9_.-][a-z0-9_. -]*)?(licen[cs](e|ing)|copyright|eula|terms[-_ ]of|restriction|rights)[a-z0-9_. -]*["']?[\t ]*:`)
	// registryTopKey is another top-level key and registryComment a comment line of a frontmatter; either makes a skill
	// ask when it reads as terms, unless the key is one of the skill's own fields (registryOwnKeys), which describe it.
	registryTopKey  = regexp.MustCompile(`^([A-Za-z0-9_.-]+)[\t ]*:`)
	registryComment = regexp.MustCompile(`^[\t ]*#`)
)

var registryOwnKeys = map[string]bool{"name": true, "title": true, "title_zh": true, "description": true, "description_zh": true, "category": true,
	"applies": true, "version": true, "attribution": true, "allowed-tools": true, "tags": true, "keywords": true, "model": true, "author": true,
	"homepage": true, "repository": true, "icon": true, "metadata": true}

// registryLicense is the license status a preview shows and an import is gated on, with every license and notice file
// of the skill's folder a member reads before confirming.
type registryLicense struct {
	Status string                `json:"status"` // open, unknown or restricted
	SPDX   string                `json:"spdx,omitempty"`
	Files  []registryLicenseFile `json:"files"`
}

// registryLicenseFile is one of them as a preview shows it: a license file, a notice, or (Readme) the folder's README,
// shown because it speaks of terms.
type registryLicenseFile struct {
	Path      string `json:"path"`
	Notice    bool   `json:"notice"`
	Readme    bool   `json:"readme"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

// registryLicenseDoc is one license or notice file, or a README that speaks of terms, judged on its whole text when
// the snapshot was parsed and kept to 16 KiB (a copy, so the folder's answer is not kept with it).
type registryLicenseDoc struct {
	path      string
	notice    bool
	readme    bool
	forbids   bool // terms that forbid reuse
	unsure    bool // terms that make the skill ask
	text      string
	truncated bool
}

func readRegistryLicenseDoc(path, text string, notice bool) registryLicenseDoc {
	shown := registryPlain(text)
	terms := registryTermsOf(shown)
	gnu := registryGNUTitle.MatchString(shown[:min(len(shown), 512)])
	forbids, anyUse := terms.judge(registryFileForbids)
	doc := registryLicenseDoc{path: path, notice: notice, forbids: !gnu && forbids,
		unsure: terms.has(registryReserved, "reserved") || (notice && (gnu || anyUse || terms.has(registryProprietary, "proprietary")))}
	doc.text, doc.truncated = registryShown(shown)
	return doc
}

// readRegistryReadme reads the folder's README as SKILL.md's text is read; one that states terms is shown with the
// license files and makes the skill ask.
func readRegistryReadme(path, text string) (registryLicenseDoc, bool) {
	if !markdownTerms(text, text) {
		return registryLicenseDoc{}, false
	}
	doc := registryLicenseDoc{path: path, notice: true, readme: true, unsure: true}
	doc.text, doc.truncated = registryShown(registryPlain(text))
	return doc, true
}

// readRegistryNamedTerms reads a file whose name speaks of terms (ACME_TERMS.md) as a notice and as SKILL.md's text
// are read: one that reads as terms is shown and makes the skill ask; a glossary or a word list says nothing.
func readRegistryNamedTerms(path, text string) (registryLicenseDoc, bool) {
	doc := readRegistryLicenseDoc(path, text, true)
	if !doc.forbids && !doc.unsure && !markdownTerms(text, text) {
		return registryLicenseDoc{}, false
	}
	doc.unsure = true
	return doc, true
}

// registryShown is what a member is shown of a license text: at most 16 KiB of it, as a copy.
func registryShown(text string) (string, bool) {
	if len(text) <= maxRegistryLicenseText {
		return strings.Clone(text), false
	}
	return strings.Clone(strings.ToValidUTF8(text[:maxRegistryLicenseText], "")), true
}

// openLicense names the permissive license a declared or detected name stands for, or "".
func openLicense(name string) string {
	key := licenseKey(name)
	if key == "" {
		return ""
	}
	for _, id := range registryOpenLicenses {
		if k := licenseKey(id); key == k || key == k+"license" || key == "the"+k+"license" {
			return id
		}
	}
	return map[string]string{"apachelicense20": "Apache-2.0", "apachelicenseversion20": "Apache-2.0", "apache2": "Apache-2.0", "bsd3": "BSD-3-Clause",
		"bsd2": "BSD-2-Clause", "cc0": "CC0-1.0", "theunlicense": "Unlicense", "isclicense": "ISC"}[key]
}

// licenseKey reduces a license name to lowercase letters and digits: "Apache License, Version 2.0" to apachelicenseversion20.
func licenseKey(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// registryFrontmatter is what a SKILL.md's frontmatter says of its license: the licenses it declares at the top level
// (a list gives one value per item; a value goes on through blank lines while the lines after them are indented
// further), whether a license key sits below the top level or another key names a license, the text of each, and the
// other lines that may speak of terms (comments, and the values of keys that are not the skill's own fields).
type registryFrontmatter struct {
	declared []string
	nested   bool
	readable bool
	terms    []string
	others   []string
}

func indentOf(line string) int { return len(line) - len(strings.TrimLeft(line, " \t")) }

// registryContinuation reads the lines a key's value goes on in after line i: through blank lines while the lines
// after them are indented further than the key. It returns the last line read.
func registryContinuation(lines []string, i int) (last int, more []string) {
	last, indent := i, indentOf(lines[i])
	for j := i + 1; j < len(lines); j++ {
		if strings.TrimSpace(lines[j]) == "" {
			continue
		}
		if indentOf(lines[j]) <= indent {
			break
		}
		last, more = j, append(more, strings.TrimSpace(lines[j]))
	}
	return last, more
}

func readRegistryFrontmatter(markdown string) registryFrontmatter {
	header, _, err := splitSkillMarkdown(markdown)
	if err != nil {
		return registryFrontmatter{}
	}
	f, lines := registryFrontmatter{readable: true}, strings.Split(header, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		match := registryLicenseLine.FindStringSubmatch(line)
		switch {
		case registryComment.MatchString(line):
			f.others = append(f.others, line)
			continue
		case match == nil && (registryLicenseKey.MatchString(line) || registryTopLicenseKey.MatchString(line)):
			f.nested, f.terms = true, append(f.terms, line)
			continue
		case match == nil:
			if key := registryTopKey.FindStringSubmatch(line); key != nil && !registryOwnKeys[strings.ToLower(key[1])] {
				var more []string
				i, more = registryContinuation(lines, i)
				f.others = append(f.others, line+" "+strings.Join(more, " "))
			}
			continue
		}
		value := strings.TrimSpace(match[3])
		var more []string
		i, more = registryContinuation(lines, i)
		f.terms = append(f.terms, value+" "+strings.Join(more, " "))
		if match[1] != "" || match[2] != "" {
			f.nested = true
			continue
		}
		f.declared = append(f.declared, declaredValues(value, more)...)
	}
	return f
}

// declaredValues splits a top-level license value into what it declares: a `- item` list one value per item,
// anything else (a name, a mapping) one value as written.
func declaredValues(value string, more []string) []string {
	if value == "" && len(more) > 0 && strings.HasPrefix(more[0], "- ") {
		items := []string{}
		for _, line := range more {
			items = append(items, registryText(unquoteFrontmatter(strings.TrimSpace(strings.TrimPrefix(line, "-"))), 120))
		}
		return items
	}
	return []string{registryText(unquoteFrontmatter(strings.Join(append([]string{value}, more...), " ")), 120)}
}

// registryLicenseSignals is everything a skill says about its license.
type registryLicenseSignals struct {
	declared []string // the licenses its frontmatter declares at the top level, one per list item
	nested   bool     // a license key below the top level or another key naming a license, which may say anything
	readable bool     // its frontmatter could be read
	forbids  bool     // terms that forbid reuse
	unsure   bool     // terms that make it ask: all rights reserved, any use, license terms in its text
	files    bool     // license files of its own
}

func readLicenseSignals(s registrySnapshot) registryLicenseSignals {
	f := readRegistryFrontmatter(s.Markdown)
	sig := registryLicenseSignals{declared: f.declared, nested: f.nested, readable: f.readable, unsure: s.MarkdownTerms}
	for _, text := range f.terms {
		terms := readRegistryTerms(text)
		forbids, anyUse := terms.judge(registryForbids)
		sig.forbids = sig.forbids || forbids
		sig.unsure = sig.unsure || anyUse || terms.has(registryReserved, "reserved")
	}
	for _, text := range f.others {
		terms := readRegistryTerms(text)
		forbids, anyUse := terms.judge(registryForbids)
		sig.unsure = sig.unsure || forbids || anyUse || terms.has(registryReserved, "reserved")
	}
	for _, doc := range s.LicenseDocs {
		sig.forbids, sig.unsure = sig.forbids || doc.forbids, sig.unsure || doc.unsure
		sig.files = sig.files || !doc.notice
	}
	return sig
}

// registryLicenseOf decides a skill's license status from its SKILL.md, the license and notice files of its folder and
// its repository's license on GitHub.
func registryLicenseOf(s registrySnapshot, repo registryRepository) registryLicense {
	license := registryLicense{Status: "unknown", Files: []registryLicenseFile{}}
	for _, doc := range s.LicenseDocs {
		license.Files = append(license.Files, registryLicenseFile{Path: doc.path, Notice: doc.notice, Readme: doc.readme, Text: doc.text, Truncated: doc.truncated})
	}
	sig := readLicenseSignals(s)
	switch {
	case sig.forbids:
		license.Status = "restricted"
	case !sig.readable || sig.nested || sig.unsure || sig.files || s.LicenseOverflow:
	case len(sig.declared) > 0:
		agreed := openLicense(sig.declared[0])
		for _, value := range sig.declared[1:] {
			if openLicense(value) != agreed {
				agreed = ""
			}
		}
		if agreed != "" {
			license.Status, license.SPDX = "open", agreed
		}
	case repo.Checked && repo.Found && repo.License != "" && openLicense(repo.License) == repo.License:
		license.Status, license.SPDX = "open", repo.License
	}
	return license
}

// registryAttribution records where an imported skill came from and the license known when it was imported, in at
// most 1,024 bytes: a long declared license is shortened to fit.
func registryAttribution(id registryID, license registryLicense, repo registryRepository, declared string) string {
	prefix := "Imported from skills.sh (" + id.String() + "); source " + id.repoURL() + "; "
	suffix := ""
	if license.Status != "open" {
		suffix = "; not known to be an open license, imported on the member's confirmation that they may use it"
	}
	known := "license not checked"
	switch {
	case license.Status == "open":
		known = "license " + license.SPDX
	case declared != "":
		label := "license declared in SKILL.md: "
		room := 1024 - len(prefix) - len(suffix) - len(label)
		for len(declared) > room {
			_, size := utf8.DecodeLastRuneInString(declared)
			declared = declared[:len(declared)-size]
		}
		known = label + declared
	case len(license.Files) > 0:
		known = "terms in the skill's " + license.Files[0].Path
		for _, f := range license.Files {
			if !f.Notice {
				known = "license in the skill's " + f.Path
				break
			}
		}
	case repo.Checked && repo.Found && repo.License == "NOASSERTION":
		known = "a license file GitHub could not classify"
	case repo.Checked && repo.Found && repo.License != "":
		known = "license " + repo.License
	case repo.Checked && repo.Found:
		known = "no license file found in the repository"
	}
	return prefix + known + suffix
}
