package app

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The policy's three.js modules import map must be the one AwwO's previews supply (previewImportMap.ts builds
// THREE_MODULES_IMPORT_MAP from THREE_MODULES_VERSION): a page written to a stale version would load nothing.
func TestPreviewModulesImportMapMatchesTheWeb(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "previewImportMap.ts"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	version := regexp.MustCompile(`export const THREE_MODULES_VERSION = '([0-9.]+)';`).FindStringSubmatch(text)
	base := regexp.MustCompile("export const THREE_MODULES_BASE = `([^`]*)`;").FindStringSubmatch(text)
	importMap := regexp.MustCompile("export const THREE_MODULES_IMPORT_MAP = `([^`]*)`;").FindStringSubmatch(text)
	if version == nil || base == nil || importMap == nil {
		t.Fatal("previewImportMap.ts no longer declares the version, base and import map this test reads")
	}
	baseURL := strings.ReplaceAll(base[1], "${THREE_MODULES_VERSION}", version[1])
	web := strings.ReplaceAll(importMap[1], "${THREE_MODULES_BASE}", baseURL)
	if strings.Contains(web, "${") {
		t.Fatalf("unexpected substitution left in the web import map: %s", web)
	}
	if web != previewModulesImportMap {
		t.Fatalf("the output policy names\n%s\nbut the previews supply\n%s", previewModulesImportMap, web)
	}
}

// The design skills are meant to be attached together: a page node takes the four page skills, a review node the jury
// with three of them, and a 3D scene node the scene skill with the direction library and the craft rules.
func TestBuiltinSkillsDesignSetsFitOneNode(t *testing.T) {
	skills, err := builtinSkills()
	if err != nil {
		t.Fatal(err)
	}
	size := map[string]int{}
	for _, s := range skills {
		size[s.Name] = s.Bytes
	}
	for label, set := range map[string][]string{
		"page":   {"design-craft", "anti-ai-slop", "design-directions", "ui-state-coverage"},
		"review": {"design-jury", "anti-ai-slop", "design-craft", "ui-state-coverage"},
		"scene":  {"procedural-3d-scene", "design-directions", "design-craft"},
	} {
		total := 0
		for _, name := range set {
			n, ok := size[name]
			if !ok {
				t.Fatalf("%s set: skill %s missing", label, name)
			}
			total += n
		}
		if len(set) > maxNodeSkills || total > maxNodeSkillBytes {
			t.Fatalf("the %s set adds %d bytes in %d skills; one node takes at most %d bytes in %d", label, total, len(set), maxNodeSkillBytes, maxNodeSkills)
		}
	}
}

// A page node's whole system prompt must fit 32,768 UTF-16 units (graph_runs.go refuses the run with context_limit
// otherwise). With the four page skills, the hosted page persona and the HTML output policy, at least 8,192 units must
// be left for the rest: a run's own notes and boundaries (model, knowledge, memory, file data, task frame and a
// structured contract's sentence come to about 2,500 units when all are present) and the task frame itself, which then
// still gets about 5,700. A node whose task frame is longer takes one skill fewer.
func TestDesignPageSetLeavesRoomInTheSystemPrompt(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "canvasPlan.ts"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)export function hostedPagePersona\(locale: UiLocale\): string \{\s*return locale === 'en'\s*\? '([^']*)'\s*: '([^']*)';`).FindStringSubmatch(string(source))
	if m == nil {
		t.Fatal("hostedPagePersona not found in canvasPlan.ts")
	}
	persona := m[1]
	if utf16Len(m[2]) > utf16Len(persona) {
		persona = m[2]
	}
	node := graphNode{Contract: &graphContract{Version: 1, Outputs: []graphField{{ID: "page", Label: "Page", Type: "html", Required: true,
		Help: "One complete HTML page that works as soon as it is opened."}}}}
	skills, err := freezeSkillContext(t.Context(), nil, "", []string{"builtin:design-craft", "builtin:anti-ai-slop", "builtin:design-directions", "builtin:ui-state-coverage"})
	if err != nil {
		t.Fatal(err)
	}
	system := skillsSystemPrompt(graphSystemPrompt(persona, graphOutputPolicy(node)), skills)
	if used := utf16Len(system); used+8192 > 32768 {
		t.Fatalf("a page node with the four page skills already uses %d of 32,768 UTF-16 units, leaving under 8,192 for its task frame, knowledge and memory", used)
	}
}

// procedural-3d-scene tells a node the exact import map and names addons by path; each must be one the previews supply
// (previewModules.generated.ts lists the files), or the page it leads to imports a module nothing provides.
func TestProceduralSceneSkillNamesOnlySuppliedModules(t *testing.T) {
	skill, ok := builtinSkill("procedural-3d-scene")
	if !ok {
		t.Fatal("procedural-3d-scene missing")
	}
	if !strings.Contains(skill.Body, "`"+previewModulesImportMap+"`") {
		t.Fatal("the skill does not give the import map the output policy allows")
	}
	generated, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "previewModules.generated.ts"))
	if err != nil {
		t.Fatal(err)
	}
	supplied := map[string]bool{}
	for _, m := range regexp.MustCompile(`"examples/jsm/([A-Za-z0-9/_.-]+\.js)"`).FindAllStringSubmatch(string(generated), -1) {
		supplied[m[1]] = true
	}
	if len(supplied) < 50 {
		t.Fatalf("read only %d supplied addon files from previewModules.generated.ts", len(supplied))
	}
	named := map[string]bool{}
	for _, m := range regexp.MustCompile(`three/addons/([A-Za-z0-9/_.-]+\.js)`).FindAllStringSubmatch(skill.Body, -1) {
		named[m[1]] = true
	}
	start := strings.Index(skill.Body, "Supplied addons include ")
	end := strings.Index(skill.Body, "Nothing else loads")
	if start < 0 || end < start {
		t.Fatal("the skill's list of supplied addons moved; update this test")
	}
	list := skill.Body[start:end]
	for _, m := range regexp.MustCompile(`\b([a-z]+) \(([A-Za-z, ]+)\)`).FindAllStringSubmatch(list, -1) {
		for _, name := range strings.Split(m[2], ",") {
			named[m[1]+"/"+strings.TrimSpace(name)+".js"] = true
		}
	}
	for _, m := range regexp.MustCompile(`\b([a-z]+/[A-Za-z0-9]+\.js)\b`).FindAllStringSubmatch(list, -1) {
		named[m[1]] = true
	}
	if len(named) < 15 {
		t.Fatalf("read only %d addon names from the skill: %v", len(named), named)
	}
	for file := range named {
		if !supplied[file] {
			t.Errorf("the skill names %s, which the previews do not supply", file)
		}
	}
}

// oklchSRGB is an oklch() colour as a browser shows it: OKLab to linear sRGB, clipped to the gamut, encoded to 8-bit
// sRGB (each channel 0-1).
func oklchSRGB(l, c, h float64) [3]float64 {
	a, b := c*math.Cos(h*math.Pi/180), c*math.Sin(h*math.Pi/180)
	l_, m_, s_ := l+0.3963377774*a+0.2158037573*b, l-0.1055613458*a-0.0638541728*b, l-0.0894841775*a-1.2914855480*b
	lc, mc, sc := l_*l_*l_, m_*m_*m_, s_*s_*s_
	rgb := [3]float64{4.0767416621*lc - 3.3077115913*mc + 0.2309699292*sc, -1.2684380046*lc + 2.6097574011*mc - 0.3413193965*sc, -0.0041960863*lc - 0.7034186147*mc + 1.7076147010*sc}
	for i, v := range rgb {
		v = math.Min(1, math.Max(0, v))
		if v <= 0.0031308 {
			v *= 12.92
		} else {
			v = 1.055*math.Pow(v, 1/2.4) - 0.055
		}
		rgb[i] = math.Round(v*255) / 255
	}
	return rgb
}

// srgbLuminance is the WCAG 2 relative luminance of an encoded sRGB colour.
func srgbLuminance(rgb [3]float64) float64 {
	for i, v := range rgb {
		if v <= 0.04045 {
			rgb[i] = v / 12.92
		} else {
			rgb[i] = math.Pow((v+0.055)/1.055, 2.4)
		}
	}
	return 0.2126*rgb[0] + 0.7152*rgb[1] + 0.0722*rgb[2]
}

func oklchLuminance(l, c, h float64) float64 { return srgbLuminance(oklchSRGB(l, c, h)) }

// tint is CSS color-mix(in srgb, top share, under), the way a tinted pill background is written.
func tint(top, under [3]float64, share float64) [3]float64 {
	var out [3]float64
	for i := range out {
		out[i] = math.Round((top[i]*share+under[i]*(1-share))*255) / 255
	}
	return out
}

func contrastRatio(x, y float64) float64 {
	return (math.Max(x, y) + 0.05) / (math.Min(x, y) + 0.05)
}

// design-directions promises that every text pair of every direction, and its status colours, reach 4.5:1; a node
// takes the tokens as given, so a colour that misses it ships unreadable text on the library's own advice.
func TestDesignDirectionsTokensReachTheirContrast(t *testing.T) {
	skill, ok := builtinSkill("design-directions")
	if !ok {
		t.Fatal("design-directions missing")
	}
	colour := regexp.MustCompile(`oklch\(([0-9.]+)% ([0-9.]+) ([0-9.]+)\)`)
	parse := func(s string) (float64, float64, float64) {
		m := colour.FindStringSubmatch(s)
		l, _ := strconv.ParseFloat(m[1], 64)
		c, _ := strconv.ParseFloat(m[2], 64)
		h, _ := strconv.ParseFloat(m[3], 64)
		return l / 100, c, h
	}
	status := regexp.MustCompile(`--(success|warn|danger) (oklch\([^)]*\))`).FindAllStringSubmatch(skill.Body, -1)
	if len(status) != 3 {
		t.Fatalf("expected three status colours, found %d", len(status))
	}
	shift := regexp.MustCompile(`A status pill puts text in its colour moved ([0-9.]+) further from the background on a ([0-9]+)% tint of it`).FindStringSubmatch(skill.Body)
	if shift == nil {
		t.Fatal("the status pill rule moved; update this test")
	}
	move, _ := strconv.ParseFloat(shift[1], 64)
	share, _ := strconv.ParseFloat(shift[2], 64)
	sets := 0
	for _, line := range strings.Split(skill.Body, "\n") {
		if !strings.HasPrefix(line, "Tokens") || strings.HasPrefix(line, "Tokens below") {
			continue
		}
		parts := colour.FindAllString(line, -1)
		if len(parts) != 6 {
			t.Fatalf("a token line without six colours: %s", line)
		}
		sets++
		lum := make([]float64, 6)
		for i, p := range parts {
			lum[i] = oklchLuminance(parse(p))
		}
		bgL, bgC, bgH := parse(parts[0])
		dark := bgL < 0.5
		check := func(what string, a, b float64) {
			if r := contrastRatio(a, b); r < 4.5 {
				t.Errorf("%s: %s is %.2f:1, under 4.5:1", line, what, r)
			}
		}
		const bg, surface, fg, muted, accent = 0, 1, 2, 3, 5
		check("fg on bg", lum[fg], lum[bg])
		check("fg on surface", lum[fg], lum[surface])
		check("muted on bg", lum[muted], lum[bg])
		check("muted on surface", lum[muted], lum[surface])
		check("accent on bg", lum[accent], lum[bg])
		check("accent on surface", lum[accent], lum[surface])
		if dark {
			check("bg text on an accent fill", lum[bg], lum[accent])
		} else {
			check("white text on an accent fill", 1, lum[accent])
		}
		for _, s := range status {
			l, c, h := parse(s[2])
			if dark {
				l += 0.2
			}
			check("--"+s[1]+" on bg", oklchLuminance(l, c, h), lum[bg])
			check("--"+s[1]+" on surface", oklchLuminance(l, c, h), lum[surface])
			// A status pill: the colour moved further from the background, on a tint of it over bg, as the skill says.
			pillText := l - move
			if dark {
				pillText = l + move
			}
			pill := srgbLuminance(tint(oklchSRGB(l, c, h), oklchSRGB(bgL, bgC, bgH), share/100))
			check("--"+s[1]+" pill text on its tint", oklchLuminance(pillText, c, h), pill)
		}
	}
	if sets != 9 {
		t.Fatalf("expected nine token sets (eight directions, one with a dark variant), found %d", sets)
	}
}
