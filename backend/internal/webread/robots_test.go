package webread

import "testing"

func TestRobotsMatchingFollowsRFC9309(t *testing.T) {
	body := `# comments are ignored
User-agent: OtherBot
Disallow: /

User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Disallow: /search?*q=
Crawl-delay: 5
Sitemap: https://example.com/sitemap.xml
`
	rules := parseRobots(body)
	cases := map[string]bool{
		"/":                    true,
		"/private":             false,
		"/private/x":           false,
		"/private/public":      true,
		"/private/public/page": true,
		"/doc.pdf":             false,
		"/doc.pdf?x=1":         true,
		"/search?lang=en&q=go": false,
		"/search":              true,
		"/robots.txt":          true,
		"/files/a.pdf":         false,
		"/files/a.pdfx":        true,
	}
	for path, want := range cases {
		if got := rules.allowed(productToken, path); got != want {
			t.Fatalf("%s: got %v want %v", path, got, want)
		}
	}
}

func TestRobotsNamedGroupWinsOverStar(t *testing.T) {
	rules := parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: AwwO-Reader\nUser-agent: other\nAllow: /\nDisallow: /admin\n")
	if !rules.allowed(productToken, "/article") || rules.allowed(productToken, "/admin/x") {
		t.Fatal("named group not applied")
	}
	if rules.allowed("someone-else", "/article") {
		t.Fatal("star group not applied to another agent")
	}
}

func TestRobotsEmptyDisallowAndTies(t *testing.T) {
	if !parseRobots("User-agent: *\nDisallow:\n").allowed(productToken, "/anything") {
		t.Fatal("an empty disallow blocks nothing")
	}
	if !parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\n").allowed(productToken, "/page") {
		t.Fatal("allow should win a tie")
	}
	if !parseRobots("").allowed(productToken, "/x") {
		t.Fatal("no rules allow everything")
	}
}

func TestRobotsMatchPatterns(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"/fish", "/fish.html", true}, {"/fish", "/Fish", false}, {"/fish*", "/fishheads", true}, {"/fish/", "/fish", false},
		{"/*.php", "/index.php", true}, {"/*.php", "/folder/x.php?q=1", true}, {"/*.php$", "/x.php?q=1", false}, {"/*.php$", "/x.php", true},
		{"/fish$", "/fish", true}, {"/fish$", "/fish/", false}, {"/a*b*c", "/a-x-b-y-c", true}, {"/a*b*c", "/a-x-c", false},
	}
	for _, c := range cases {
		if got := robotsMatch(c.pattern, c.path); got != c.want {
			t.Fatalf("%s vs %s: got %v", c.pattern, c.path, got)
		}
	}
}

// Rules and paths are compared in one spelling (RFC 9309 §2.2.2), so an escaped letter cannot slip past a rule and a
// rule written in UTF-8 still matches the escaped path a client sends.
func TestRobotsComparesNormalizedPaths(t *testing.T) {
	rules := parseRobots("User-agent: *\nDisallow: /private\nDisallow: /%7euser\nDisallow: /中文\nAllow: /a%2fb\n")
	for raw, want := range map[string]bool{
		"https://site.test/%70rivate/page":       false,
		"https://site.test/%70%72ivate":          false,
		"https://site.test/~user/x":              false,
		"https://site.test/%7Euser/x":            false,
		"https://site.test/%E4%B8%AD%E6%96%87/x": false,
		"https://site.test/中文/x":                 false,
		"https://site.test/public":               true,
		"https://site.test/a%2Fb":                true,
	} {
		target, err := ValidateURL(raw)
		if err != nil {
			t.Fatal(raw, err)
		}
		if got := rules.allowed(productToken, robotsPath(target)); got != want {
			t.Fatalf("%s: got %v want %v (path %q)", raw, got, want, robotsPath(target))
		}
	}
	if robotsNormalize("/%2f%2A%41") != "/%2F%2AA" || robotsNormalize("/%zz%4") != "/%zz%4" {
		t.Fatal("escapes of reserved characters keep their meaning, malformed ones stay as written")
	}
}
