package webread

import (
	"bytes"
	"encoding/xml"
	"net/url"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

const (
	maxFeedItems   = 50
	maxSummaryRune = 500
)

type rssItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	GUID        string `xml:"guid"`
	PubDate     string `xml:"pubDate"`
	Date        string `xml:"date"`
	Description string `xml:"description"`
	Encoded     string `xml:"encoded"`
}

type rssDocument struct {
	Channel struct {
		Title string    `xml:"title"`
		Items []rssItem `xml:"item"`
	} `xml:"channel"`
	// RSS 1.0 (RDF) keeps its items beside the channel.
	Items []rssItem `xml:"item"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
}

type atomEntry struct {
	Title     string     `xml:"title"`
	Links     []atomLink `xml:"link"`
	Published string     `xml:"published"`
	Updated   string     `xml:"updated"`
	Summary   string     `xml:"summary"`
	Content   string     `xml:"content"`
}

type atomFeed struct {
	Title   string      `xml:"title"`
	Entries []atomEntry `xml:"entry"`
}

func newFeedDecoder(data []byte) *xml.Decoder {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = false
	decoder.Entity = xml.HTMLEntity
	decoder.CharsetReader = charset.NewReaderLabel
	return decoder
}

// rootName is the local name of the document's first element.
func rootName(data []byte) string {
	decoder := newFeedDecoder(data)
	for {
		token, err := decoder.Token()
		if err != nil {
			return ""
		}
		if start, ok := token.(xml.StartElement); ok {
			return strings.ToLower(start.Name.Local)
		}
	}
}

// parseFeed reads RSS 2.0, RSS 1.0 (RDF) and Atom 1.0; ok is false for any other XML.
func parseFeed(data []byte, base *url.URL) (string, []FeedItem, bool) {
	switch rootName(data) {
	case "rss", "rdf":
		var doc rssDocument
		if newFeedDecoder(data).Decode(&doc) != nil {
			return "", nil, false
		}
		items := append(doc.Channel.Items, doc.Items...)
		out := make([]FeedItem, 0, min(len(items), maxFeedItems))
		for _, item := range items {
			if len(out) == maxFeedItems {
				break
			}
			link := item.Link
			if link == "" && strings.HasPrefix(item.GUID, "http") {
				link = item.GUID
			}
			summary := item.Description
			if summary == "" {
				summary = item.Encoded
			}
			published := item.PubDate
			if published == "" {
				published = item.Date
			}
			out = append(out, FeedItem{Title: collapse(item.Title), Link: absoluteLink(base, link), Published: collapse(published), Summary: summaryText(summary)})
		}
		return collapse(doc.Channel.Title), out, true
	case "feed":
		var feed atomFeed
		if newFeedDecoder(data).Decode(&feed) != nil {
			return "", nil, false
		}
		out := make([]FeedItem, 0, min(len(feed.Entries), maxFeedItems))
		for _, entry := range feed.Entries {
			if len(out) == maxFeedItems {
				break
			}
			link := ""
			for _, l := range entry.Links {
				if l.Rel == "" || l.Rel == "alternate" {
					link = l.Href
					break
				}
			}
			summary := entry.Summary
			if summary == "" {
				summary = entry.Content
			}
			published := entry.Published
			if published == "" {
				published = entry.Updated
			}
			out = append(out, FeedItem{Title: collapse(entry.Title), Link: absoluteLink(base, link), Published: collapse(published), Summary: summaryText(summary)})
		}
		return collapse(feed.Title), out, true
	}
	return "", nil, false
}

func absoluteLink(base *url.URL, link string) string {
	link = strings.TrimSpace(link)
	if link == "" || base == nil {
		return ""
	}
	u, err := base.Parse(link)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return ""
	}
	return u.String()
}

// summaryText strips any HTML from a feed summary and keeps at most 500 characters.
func summaryText(raw string) string {
	text := raw
	if strings.ContainsAny(raw, "<&") {
		if nodes, err := html.ParseFragment(strings.NewReader(raw), nil); err == nil {
			var b strings.Builder
			for _, n := range nodes {
				b.WriteString(plainText(n))
				b.WriteByte(' ')
			}
			text = b.String()
		}
	}
	text = collapse(cleanText(text))
	if utf8.RuneCountInString(text) > maxSummaryRune {
		runes := []rune(text)
		text = strings.TrimSpace(string(runes[:maxSummaryRune])) + "…"
	}
	return text
}
