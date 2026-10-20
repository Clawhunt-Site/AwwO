package app

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Reading a SKILL.md-style file (skills.go): a `---` frontmatter block of `key: value` lines, then the body. A
// built-in skill's frontmatter is strict; a file a member uploads is written for other agents too, so it is read
// as the YAML those agents write.

var skillFrontmatterKeys = map[string]bool{"name": true, "title": true, "title_zh": true, "description": true, "description_zh": true, "category": true, "applies": true, "version": true, "attribution": true}

// parseSkillMarkdown reads a SKILL.md-style file: a `---` frontmatter block of `key: value` lines, then the body.
// strict rejects unknown keys (built-ins); an import keeps only the keys it understands.
func parseSkillMarkdown(raw string, strict bool) (map[string]string, string, error) {
	header, body, err := splitSkillMarkdown(raw)
	if err != nil {
		return nil, "", err
	}
	meta, err := frontmatterValues(header, strict, func(key string) bool { return skillFrontmatterKeys[key] })
	return meta, body, err
}

// splitSkillMarkdown separates a SKILL.md-style file into its `---` frontmatter block and its body.
func splitSkillMarkdown(raw string) (string, string, error) {
	raw = strings.ReplaceAll(strings.TrimPrefix(raw, "\ufeff"), "\r\n", "\n")
	if !strings.HasPrefix(raw, "---\n") {
		return "", "", skillInvalid("A skill file starts with a --- frontmatter block")
	}
	end := strings.Index(raw[4:], "\n---")
	if end < 0 {
		return "", "", skillInvalid("The skill frontmatter block is not closed with ---")
	}
	header, rest := raw[4:4+end], raw[4+end+4:]
	if i := strings.IndexByte(rest, '\n'); i >= 0 && strings.TrimSpace(rest[:i]) == "" {
		rest = rest[i+1:]
	} else if strings.TrimSpace(rest) == "" {
		rest = ""
	}
	return header, strings.TrimRight(rest, "\n") + "\n", nil
}

// frontmatterValues reads the top-level keys keep accepts. strict (a built-in) takes one plain `key: value` pair per
// line and refuses any other key. An import is lenient, as SKILL.md files written for other agents are YAML: other keys
// and their nested lines are skipped, and a value may continue on indented lines, be a block scalar (`>` or `|`) or be
// quoted; it is folded to one line.
func frontmatterValues(header string, strict bool, keep func(string) bool) (map[string]string, error) {
	meta := map[string]string{}
	lines := strings.Split(header, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		key = strings.TrimSpace(key)
		if !ok || key == "" || strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			if strict {
				return nil, skillInvalid("Each frontmatter line is one key: value pair")
			}
			continue
		}
		if !keep(key) {
			if strict {
				return nil, skillInvalid("Unknown skill frontmatter key: " + key)
			}
			continue
		}
		if _, dup := meta[key]; dup {
			return nil, skillInvalid("Duplicate skill frontmatter key: " + key)
		}
		if strict {
			meta[key] = strings.Trim(strings.TrimSpace(value), `"'`)
			continue
		}
		// The value's indented (or blank) continuation lines, up to the next top-level line.
		first, more := strings.TrimSpace(value), []string{}
		for i+1 < len(lines) && (strings.TrimSpace(lines[i+1]) == "" || strings.HasPrefix(lines[i+1], " ") || strings.HasPrefix(lines[i+1], "\t")) {
			i++
			if part := strings.TrimSpace(lines[i]); part != "" {
				more = append(more, part)
			}
		}
		meta[key] = foldFrontmatterValue(first, more)
	}
	return meta, nil
}

// foldFrontmatterValue turns a lenient value and its continuation lines into one line (a quoted value's escaped line
// breaks too). A block list (`- item` lines) becomes comma-separated items, as `applies: a,b` is written.
func foldFrontmatterValue(first string, more []string) string {
	oneLine := func(value string) string { return strings.Join(strings.Fields(value), " ") }
	if first == "" && len(more) > 0 && !slices.ContainsFunc(more, func(line string) bool { return !strings.HasPrefix(line, "- ") }) {
		items := []string{}
		for _, line := range more {
			items = append(items, oneLine(unquoteFrontmatter(strings.TrimSpace(strings.TrimPrefix(line, "- ")))))
		}
		return strings.Join(items, ",")
	}
	if blockScalar.MatchString(first) {
		first = ""
	}
	return oneLine(unquoteFrontmatter(oneLine(strings.Join(append([]string{first}, more...), " "))))
}

// knownSkillTags keeps the tags of a file's `applies` that AwwO knows: a file written for other agents may name others.
func knownSkillTags(tags []string) []string {
	known := []string{}
	for _, tag := range tags {
		if slices.Contains(skillApplies, tag) {
			known = append(known, tag)
		}
	}
	return known
}

// fileSkillDescription shortens a file's description to the library's limit, at a word where it can: a description
// written for other agents may be longer.
func fileSkillDescription(description string) string {
	runes := []rune(description)
	if len(runes) <= maxSkillDescription {
		return description
	}
	cut := string(runes[:maxSkillDescription-1])
	if i := strings.LastIndex(cut, " "); i > len(cut)/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,.;:") + "…"
}

// blockScalar is a YAML block scalar header: `|` or `>`, with an optional chomping and indentation indicator.
var blockScalar = regexp.MustCompile(`^[|>][+-]?[1-9]?[+-]?$`)

// unquoteFrontmatter removes a YAML string's quotes: a double-quoted one with its escapes, a single-quoted one with
// its doubled quotes. Anything else keeps the old rule of trimming stray quote marks.
func unquoteFrontmatter(value string) string {
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		if s, err := strconv.Unquote(value); err == nil {
			return s
		}
	}
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		return strings.ReplaceAll(value[1:len(value)-1], "''", "'")
	}
	return strings.Trim(value, `"'`)
}

// splitSkillList reads `a,b`, or a YAML flow list `[a, "b"]` from an imported file.
func splitSkillList(value string) []string {
	if value = strings.TrimSpace(value); strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		value = value[1 : len(value)-1]
	}
	items := []string{}
	for _, item := range strings.Split(value, ",") {
		if item = unquoteFrontmatter(strings.TrimSpace(item)); item != "" && !slices.Contains(items, item) {
			items = append(items, item)
		}
	}
	return items
}
