package app

import (
	"regexp"
	"strings"
)

var htmlFence = regexp.MustCompile("(?is)^```html[\\t ]*\\r?\\n(.*?)\\r?\\n```$")
var htmlComment = regexp.MustCompile(`(?s)^<!--.*?-->`)
var htmlDoctype = regexp.MustCompile(`(?i)^<!doctype\s+html\s*>`)
var htmlTag = regexp.MustCompile(`(?i)^<(/?)([a-z][a-z0-9:-]*)([\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`)
var htmlBareTag = regexp.MustCompile(`(?i)^<(/?)([a-z][a-z0-9:-]*)>`)
var htmlSelfClosing = regexp.MustCompile(`/\s*>$`)

func htmlDocumentSource(value string) string {
	if match := htmlFence.FindStringSubmatch(strings.TrimSpace(value)); len(match) > 0 {
		return match[1]
	}
	return value
}

// Match the browser document-shape gate without creating a DOM or fetching any
// resource. A complete document still requires an isolated browser preview.
func completeHTMLDocument(value string) bool {
	remaining := strings.TrimPrefix(strings.TrimSpace(htmlDocumentSource(value)), "\ufeff")
	if remaining == "" || strings.ContainsRune(remaining, 0) {
		return false
	}
	phase := "before"
	doctype := false
	transitions := map[string]string{"before:html": "html", "html:head": "head", "head:/head": "after-head", "after-head:body": "body", "body:/body": "after-body", "after-body:/html": "done"}
	rawText := map[string]bool{"script": true, "style": true, "textarea": true, "title": true, "xmp": true, "iframe": true, "noembed": true, "noframes": true, "noscript": true}
	for remaining != "" {
		end := strings.IndexByte(remaining, '<')
		text := remaining
		if end >= 0 {
			text = remaining[:end]
		}
		if strings.TrimSpace(text) != "" && phase != "head" && phase != "body" {
			return false
		}
		if end < 0 {
			return phase == "done"
		}
		remaining = remaining[end:]
		if comment := htmlComment.FindString(remaining); comment != "" {
			remaining = remaining[len(comment):]
			continue
		}
		if declaration := htmlDoctype.FindString(remaining); declaration != "" {
			if phase != "before" || doctype {
				return false
			}
			doctype = true
			remaining = remaining[len(declaration):]
			continue
		}
		tag := htmlBareTag.FindStringSubmatch(remaining)
		if len(tag) == 0 {
			tag = htmlTag.FindStringSubmatch(remaining)
		}
		if len(tag) == 0 {
			return false
		}
		whole, closing, name := tag[0], tag[1], strings.ToLower(tag[2])
		remaining = remaining[len(whole):]
		if name == "html" || name == "head" || name == "body" {
			if htmlSelfClosing.MatchString(whole) {
				return false
			}
			next, ok := transitions[phase+":"+closing+name]
			if !ok {
				return false
			}
			phase = next
			continue
		}
		if phase != "head" && phase != "body" {
			return false
		}
		if closing == "" && rawText[name] {
			end := regexp.MustCompile(`(?i)</` + name + `\s*>`).FindStringIndex(remaining)
			if end == nil {
				return false
			}
			remaining = remaining[end[1]:]
		}
	}
	return phase == "done"
}
