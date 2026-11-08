package app

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// AwwO's built-in skills speak one motion language (MOTION.md; the values live in apps/motion-tokens.json). Every
// curve a skill prints is one of the language's curves or character presets, and a curve printed after a token's
// name is that token's own; every spring, in any of the forms the skills write (stiffness and damping in either
// order, `sheet (380, 32)`, zeta / settle), is the named spring it says it is; and the motion skills print the
// interface and film durations as the file holds them. Before 2026-11-08 four skills each taught their own curves,
// so a node with two of them attached was told two different entrances.

type motionTokens struct {
	Ease map[string]struct {
		Curve []float64 `json:"curve"`
	} `json:"ease"`
	UI struct {
		DurationMS map[string]float64 `json:"duration_ms"`
		Reduced    struct {
			FadeMS float64 `json:"fade_ms"`
		} `json:"reduced"`
	} `json:"ui"`
	Film struct {
		Seconds map[string]float64 `json:"seconds"`
		Frames  map[string]float64 `json:"frames_at_30fps"`
	} `json:"film"`
	Spring map[string]struct {
		Stiffness float64 `json:"stiffness"`
		Damping   float64 `json:"damping"`
		Zeta      float64 `json:"zeta"`
		Settle    float64 `json:"settle"`
	} `json:"spring"`
	Character map[string]json.RawMessage `json:"character"`
}

type motionPreset struct {
	Enter  []float64 `json:"enter"`
	Frames float64   `json:"main_move_frames_at_30fps"`
}

type motionLanguage struct {
	tokens  motionTokens
	curves  [][]float64
	presets map[string]motionPreset
}

func loadMotionTokens(t *testing.T) motionLanguage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "motion-tokens.json"))
	if err != nil {
		t.Fatal(err)
	}
	lang := motionLanguage{presets: map[string]motionPreset{}}
	if err := json.Unmarshal(raw, &lang.tokens); err != nil {
		t.Fatal(err)
	}
	for _, e := range lang.tokens.Ease {
		lang.curves = append(lang.curves, e.Curve)
	}
	for name, preset := range lang.tokens.Character {
		if name == "about" {
			continue
		}
		var p motionPreset
		if err := json.Unmarshal(preset, &p); err != nil || len(p.Enter) != 4 || p.Frames <= 0 {
			t.Fatalf("character %s has no four-number entrance and main move: %v", name, err)
		}
		lang.curves = append(lang.curves, p.Enter)
		lang.presets[name] = p
	}
	tk := lang.tokens
	if len(lang.curves) < 9 || len(tk.Spring) < 5 || len(tk.UI.DurationMS) < 4 || len(tk.Film.Seconds) < 4 || len(tk.Film.Frames) < 4 || tk.UI.Reduced.FadeMS <= 0 {
		t.Fatalf("motion tokens look truncated: %d curves, %d springs", len(lang.curves), len(tk.Spring))
	}
	return lang
}

const motionNum = `(-?\d*\.?\d+)`

var (
	skillCurveTuple  = regexp.MustCompile(`([A-Za-z-]*)\s*[(\[]\s*` + motionNum + `\s*,\s*` + motionNum + `\s*,\s*` + motionNum + `\s*,\s*` + motionNum + `\s*[)\]]`)
	colourFunctionRe = regexp.MustCompile(`(?i)^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$`)
	// A curve right after a token's or a preset's name is that one's curve: `enter (…)`, `--ease-enter: cubic-bezier(…)`.
	boundCurveName = regexp.MustCompile(`(?i)(?:--ease-|\b)(enter|move|exit|emphasis|trust|premium|bold|playful|calm|friendly)\b[^A-Za-z0-9]*(?:cubic-bezier)?\s*$`)
	springPairKD   = regexp.MustCompile(`stiffness:?\s*` + motionNum + `,?\s*damping:?\s*` + motionNum)
	springPairDK   = regexp.MustCompile(`damping:?\s*` + motionNum + `,?\s*stiffness:?\s*` + motionNum)
	springBoundKD  = regexp.MustCompile(`(?i)\b(snappy|sheet|land|glide|bounce)\s*[(:{]\s*\{?\s*(?:stiffness:?\s*)?` + motionNum + `\s*,\s*(?:damping:?\s*)?` + motionNum + `\s*[;)}]`)
	springBoundZS  = regexp.MustCompile(`(?i)\b(snappy|sheet|land|glide|bounce)\s*\([^;)]*;\s*(?:zeta\s*)?` + motionNum + `\s*,\s*(?:settle\s*)?` + motionNum + `\s*s\s*\)`)
	springSlashZS  = regexp.MustCompile(`(?i)\b(snappy|sheet|land|glide|bounce)\s+` + motionNum + `\s*/\s*` + motionNum + `\s*s\b`)
	springTable    = regexp.MustCompile(`\|\s*(snappy|sheet|land|glide|bounce)\s*\|\s*` + motionNum + `\s*/\s*` + motionNum + `\s*\|\s*` + motionNum + `\s*/\s*` + motionNum + `\s*s\s*\|`)
	springKeysZS   = regexp.MustCompile(`zeta\s*[:=]\s*` + motionNum + `\s*,\s*settle\s*[:=]\s*` + motionNum)
	uiTableRow     = regexp.MustCompile(`\|\s*(fast|base|slow|scene)\s*\|\s*` + motionNum + `\s*\|`)
	uiProse        = regexp.MustCompile(`\b(fast|base|slow|scene)\s+` + motionNum + `\b`)
	uiSeconds      = regexp.MustCompile(`(?:^|[^\w-])(fast|base|slow|scene):\s*` + motionNum + `(ms)?`)
	uiCSS          = regexp.MustCompile(`--dur-(fast|base|slow|scene):\s*` + motionNum + `ms`)
	reducedMedia   = regexp.MustCompile(`@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{`)
	filmSequence   = regexp.MustCompile(`\bxs\s*:?\s*` + motionNum + `(\s+frames)?[^,;]*,\s*s\s*:?\s*` + motionNum + `[^,;]*,\s*m\s*:?\s*` + motionNum + `[^,;]*,\s*l\s*:?\s*` + motionNum)
	presetSeconds  = regexp.MustCompile(`(?i)\b(trust|premium|bold|playful|calm|friendly)\s*\([^)]*\)\s*` + motionNum + `\s*s\b`)
	presetTable    = regexp.MustCompile(`(?i)\|\s*(trust|premium|bold|playful|calm|friendly)\b[^|]*\|\s*~?` + motionNum + `\s*frames\s*\|`)
)

// The motion skills print durations too, so their durations are checked as well as their curves and springs.
var motionSkillNames = map[string]bool{
	"motion-language": true, "motion-review": true, "motion-discipline": true, "code-motion": true,
	"promo-film": true, "code-video-brief": true, "vertical-reel": true,
}

func motionFloat(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func near(a, b, tolerance float64) bool { return math.Abs(a-b) <= tolerance }

// reducedSpans lists the [start, end) byte ranges of reduced-motion @media blocks in a body.
func reducedSpans(body string) [][2]int {
	var spans [][2]int
	for _, m := range reducedMedia.FindAllStringIndex(body, -1) {
		depth := 0
		end := len(body)
		for i := m[1] - 1; i < len(body); i++ {
			if body[i] == '{' {
				depth++
			} else if body[i] == '}' {
				depth--
				if depth == 0 {
					end = i + 1
					break
				}
			}
		}
		spans = append(spans, [2]int{m[0], end})
	}
	return spans
}

// motionDrift lists everything in a skill body that is not the motion language, and how many curves it read.
func motionDrift(body string, lang motionLanguage, durations bool) (problems []string, curves int) {
	tk := lang.tokens
	bad := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	inLanguage := func(c []float64) bool {
		for _, known := range lang.curves {
			same := true
			for i := range c {
				if !near(c[i], known[i], 0.005) {
					same = false
				}
			}
			if same {
				return true
			}
		}
		return false
	}
	curveOf := func(name string) ([]float64, bool) {
		name = strings.ToLower(name)
		if e, ok := tk.Ease[name]; ok {
			return e.Curve, true
		}
		p, ok := lang.presets[name]
		return p.Enter, ok
	}
	for _, idx := range skillCurveTuple.FindAllStringSubmatchIndex(body, -1) {
		word := body[idx[2]:idx[3]]
		if colourFunctionRe.MatchString(word) {
			continue
		}
		c := []float64{motionFloat(body[idx[4]:idx[5]]), motionFloat(body[idx[6]:idx[7]]), motionFloat(body[idx[8]:idx[9]]), motionFloat(body[idx[10]:idx[11]])}
		// A four-number group outside the range a timing curve can have is not a curve (a rectangle, a colour).
		if c[0] < 0 || c[0] > 1 || c[2] < 0 || c[2] > 1 || math.Abs(c[1]) > 2.5 || math.Abs(c[3]) > 2.5 {
			continue
		}
		curves++
		if !inLanguage(c) {
			bad("prints the curve %v, which is none of the motion language's curves or character presets", c)
			continue
		}
		if m := boundCurveName.FindStringSubmatch(body[max(0, idx[0]-40):idx[3]]); m != nil {
			if want, ok := curveOf(m[1]); ok {
				for i := range c {
					if !near(c[i], want[i], 0.005) {
						bad("prints %v right after %q, whose curve is %v", c, m[1], want)
						break
					}
				}
			}
		}
	}
	named := func(stiffness, damping float64) string {
		for name, s := range tk.Spring {
			if near(s.Stiffness, stiffness, 1) && near(s.Damping, damping, 0.2) {
				return name
			}
		}
		return ""
	}
	namedZS := func(zeta, settle float64) string {
		for name, s := range tk.Spring {
			if near(s.Zeta, zeta, 0.01) && near(s.Settle, settle, 0.01) {
				return name
			}
		}
		return ""
	}
	for _, re := range []*regexp.Regexp{springPairKD, springPairDK} {
		for _, m := range re.FindAllStringSubmatch(body, -1) {
			k, d := motionFloat(m[1]), motionFloat(m[2])
			if re == springPairDK {
				k, d = d, k
			}
			if named(k, d) == "" {
				bad("writes a spring with stiffness %v and damping %v, which is no named spring", k, d)
			}
		}
	}
	for _, m := range springBoundKD.FindAllStringSubmatch(body, -1) {
		s := tk.Spring[strings.ToLower(m[1])]
		if !near(s.Stiffness, motionFloat(m[2]), 1) || !near(s.Damping, motionFloat(m[3]), 0.2) {
			bad("writes %s as (%s, %s); %s is stiffness %v, damping %v", m[1], m[2], m[3], m[1], s.Stiffness, s.Damping)
		}
	}
	for _, re := range []*regexp.Regexp{springBoundZS, springSlashZS} {
		for _, m := range re.FindAllStringSubmatch(body, -1) {
			s := tk.Spring[strings.ToLower(m[1])]
			if !near(s.Zeta, motionFloat(m[2]), 0.01) || !near(s.Settle, motionFloat(m[3]), 0.01) {
				bad("writes %s as zeta %s, settle %s; %s is %v / %v s", m[1], m[2], m[3], m[1], s.Zeta, s.Settle)
			}
		}
	}
	for _, m := range springTable.FindAllStringSubmatch(body, -1) {
		s := tk.Spring[m[1]]
		if !near(s.Stiffness, motionFloat(m[2]), 1) || !near(s.Damping, motionFloat(m[3]), 0.2) || !near(s.Zeta, motionFloat(m[4]), 0.01) || !near(s.Settle, motionFloat(m[5]), 0.01) {
			bad("prints the spring row %q, which is not %s", strings.TrimSpace(m[0]), m[1])
		}
	}
	for _, m := range springKeysZS.FindAllStringSubmatch(body, -1) {
		if namedZS(motionFloat(m[1]), motionFloat(m[2])) == "" {
			bad("writes zeta %s, settle %s, which is no named spring", m[1], m[2])
		}
	}
	if !durations {
		return problems, curves
	}
	ms := func(name, value, where string) {
		if want := tk.UI.DurationMS[name]; !near(motionFloat(value), want, 0.001) {
			bad("prints the %s duration %s as %s ms; it is %v", where, name, value, want)
		}
	}
	for _, m := range uiTableRow.FindAllStringSubmatch(body, -1) {
		ms(m[1], m[2], "table's")
	}
	for _, m := range uiProse.FindAllStringSubmatch(body, -1) {
		ms(m[1], m[2], "interface")
	}
	for _, m := range uiSeconds.FindAllStringSubmatch(body, -1) {
		if m[3] != "" {
			continue // a CSS value in ms, read by uiCSS
		}
		if want := tk.UI.DurationMS[m[1]] / 1000; !near(motionFloat(m[2]), want, 0.0005) {
			bad("prints %s: %s s; it is %v", m[1], m[2], want)
		}
	}
	spans := reducedSpans(body)
	for _, idx := range uiCSS.FindAllStringSubmatchIndex(body, -1) {
		name, value := body[idx[2]:idx[3]], motionFloat(body[idx[4]:idx[5]])
		reduced := false
		for _, s := range spans {
			if idx[0] >= s[0] && idx[0] < s[1] {
				reduced = true
			}
		}
		if reduced && !near(value, tk.UI.Reduced.FadeMS, 0.001) {
			bad("its reduced-motion block sets --dur-%s to %v ms; reduced motion keeps %v ms fades", name, value, tk.UI.Reduced.FadeMS)
		} else if !reduced && !near(value, tk.UI.DurationMS[name], 0.001) {
			bad("sets --dur-%s to %v ms; it is %v", name, value, tk.UI.DurationMS[name])
		}
	}
	for _, m := range filmSequence.FindAllStringSubmatch(body, -1) {
		got := []float64{motionFloat(m[1]), motionFloat(m[3]), motionFloat(m[4]), motionFloat(m[5])}
		for i, name := range []string{"xs", "s", "m", "l"} {
			want, unit := tk.Film.Seconds[name], "s"
			if m[2] != "" {
				want, unit = tk.Film.Frames[name], "frames"
			}
			if !near(got[i], want, 0.001) {
				bad("prints film %s as %v %s; it is %v", name, got[i], unit, want)
			}
		}
	}
	for _, m := range presetSeconds.FindAllStringSubmatch(body, -1) {
		p := lang.presets[strings.ToLower(m[1])]
		if !near(motionFloat(m[2]), p.Frames/30, 0.051) {
			bad("gives %s a main move of %s s; it is %v frames at 30 fps", m[1], m[2], p.Frames)
		}
	}
	for _, m := range presetTable.FindAllStringSubmatch(body, -1) {
		p := lang.presets[strings.ToLower(m[1])]
		if !near(motionFloat(m[2]), p.Frames, 0.001) {
			bad("gives %s a main move of %s frames; it is %v", m[1], m[2], p.Frames)
		}
	}
	return problems, curves
}

func TestBuiltinSkillsSpeakOneMotionLanguage(t *testing.T) {
	lang := loadMotionTokens(t)
	skills, err := builtinSkills()
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	durationSkills := 0
	for _, s := range skills {
		// The skills converted from wshobson/agents ship their upstream text verbatim by policy
		// (apps/web/tests/saas-team-market-wshobson.test.ts), so interaction-design keeps its own curves; the
		// motion-language skill tells a node that its tokens win over any other skill's numbers.
		if strings.HasPrefix(s.Attribution, "From wshobson/agents@") {
			continue
		}
		if motionSkillNames[s.Name] {
			durationSkills++
		}
		problems, curves := motionDrift(s.Body, lang, motionSkillNames[s.Name])
		checked += curves
		for _, p := range problems {
			t.Errorf("%s %s (apps/motion-tokens.json)", s.Name, p)
		}
	}
	if checked < 20 || durationSkills != len(motionSkillNames) {
		t.Fatalf("only %d curves and %d of %d motion skills found; the scan is broken", checked, durationSkills, len(motionSkillNames))
	}
}

func TestMotionDriftScanCatchesWhatTheReviewFound(t *testing.T) {
	lang := loadMotionTokens(t)
	for _, body := range []string{
		"springs: sheet (300, 20) for heavy panels",
		"sheet (stiffness: 520, damping: 36) for heavy panels",
		"spring: { sheet: { stiffness: 520, damping: 36 } }",
		"config: { damping: 9, stiffness: 300 }",
		"land 0.8 / 0.7 s for titles and cards",
		"snappy (520, 36; 0.7, 0.24 s)",
		"zeta: 0.5, settle: 0.6",
		"enter (0.65, 0, 0.35, 1) for arriving",
		"emphasis `cubic-bezier(0.34, 1.56, 0.64, 1)` for one moment",
		"`MOTION.dur` { fast: 0.14, base: 0.2, slow: 0.2, scene: 0.4 }",
		"| base | 220 | a menu |",
		"durations fast 140, base 200, slow 300, scene 400 ms",
		":root { --dur-base: 140ms; }",
		"@media (prefers-reduced-motion: reduce) { :root { --dur-slow: 260ms; } }",
		"film xs 0.2, s 0.4, m 0.6, l 1.2 s",
		"xs 6 frames for a small element, s 12 for a card, m 20 for a move, l 30 for a title",
		"trust (0, 0, 0.2, 1) 1.2 s",
		"| Trust / B2B | ~30 frames | (0, 0, 0.2, 1) | none | 0 |",
	} {
		if problems, _ := motionDrift(body, lang, true); len(problems) == 0 {
			t.Errorf("the scan misses the drift in %q", body)
		}
	}
	clean := strings.Join([]string{
		"enter (0.16, 1, 0.3, 1); `--ease-exit: cubic-bezier(0.3, 0, 0.8, 0.15);` emphasis `cubic-bezier(0.34, 1.4, 0.64, 1)`",
		"snappy (stiffness 520, damping 36), sheet (380, 32); land (85, 14.7; 0.8, 0.6 s); glide 1 / 0.6 s; config: { damping: 32, stiffness: 380 }",
		"| bounce | 97 / 11.8 | 0.6 / 0.7 s | one moment |",
		"`MOTION.dur` { fast: 0.14, base: 0.2, slow: 0.26, scene: 0.4 }; durations fast 140, base 200, slow 260, scene 400 ms; | slow | 260 | a sheet |",
		":root { --dur-slow: 260ms; } @media (prefers-reduced-motion: reduce) { :root { --dur-slow: 140ms; } }",
		"film xs 0.2, s 0.4, m 0.6, l 1 s; xs 6 frames for a small element, s 12 for a card, m 18 for a move, l 30 for a title",
		"trust (0, 0, 0.2, 1) 0.7 s; friendly (0.25, 0.46, 0.45, 0.94) 0.9 s; | Calm / health | ~42 frames | (0.65, 0, 0.35, 1) | none |",
	}, "\n")
	if problems, _ := motionDrift(clean, lang, true); len(problems) != 0 {
		t.Errorf("the scan flags the language itself: %v", problems)
	}
}

func TestMotionLanguageSkillPrintsTheTokens(t *testing.T) {
	lang := loadMotionTokens(t)
	tk := lang.tokens
	skill, ok := builtinSkill("motion-language")
	if !ok {
		t.Fatal("motion-language is missing")
	}
	block := regexp.MustCompile("(?s)```css\n(.*?)```").FindStringSubmatch(skill.Body)
	if block == nil {
		t.Fatal("motion-language prints no CSS token block")
	}
	root, media, found := strings.Cut(block[1], "@media")
	if !found {
		t.Fatal("motion-language's CSS block has no reduced-motion query")
	}
	num := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	for name, e := range tk.Ease {
		if name == "linear" {
			continue
		}
		parts := make([]string, len(e.Curve))
		for i, v := range e.Curve {
			parts[i] = num(v)
		}
		if want := fmt.Sprintf("--ease-%s: cubic-bezier(%s);", name, strings.Join(parts, ", ")); !strings.Contains(root, want) {
			t.Errorf("motion-language's :root does not print %q", want)
		}
	}
	for name, ms := range tk.UI.DurationMS {
		if want := fmt.Sprintf("--dur-%s: %sms;", name, num(ms)); !strings.Contains(root, want) {
			t.Errorf("motion-language's :root does not print %q", want)
		}
		if name != "fast" {
			if want := fmt.Sprintf("--dur-%s: %sms;", name, num(tk.UI.Reduced.FadeMS)); !strings.Contains(media, want) {
				t.Errorf("motion-language's reduced-motion block does not print %q", want)
			}
		}
		if !regexp.MustCompile(fmt.Sprintf(`\b%s: %s[,} ]`, name, regexp.QuoteMeta(num(ms/1000)))).MatchString(skill.Body) {
			t.Errorf("motion-language's MOTION.dur does not print %s: %s", name, num(ms/1000))
		}
	}
	for name, s := range tk.Film.Seconds {
		if !regexp.MustCompile(fmt.Sprintf(`(?:^|[\s{,])%s: %s[,} ]`, name, regexp.QuoteMeta(num(s)))).MatchString(skill.Body) {
			t.Errorf("motion-language's MOTION.film does not print %s: %s", name, num(s))
		}
	}
	for name, s := range tk.Spring {
		long := fmt.Sprintf("%s (stiffness %s, damping %s; zeta %s, settle %s s)", name, num(s.Stiffness), num(s.Damping), num(s.Zeta), num(s.Settle))
		short := fmt.Sprintf("%s (%s, %s; %s, %s s)", name, num(s.Stiffness), num(s.Damping), num(s.Zeta), num(s.Settle))
		if !strings.Contains(skill.Body, long) && !strings.Contains(skill.Body, short) {
			t.Errorf("motion-language does not print the spring %s as %q", name, short)
		}
	}
}

func TestMotionSkillsFitBesideTheSetsTheyJoin(t *testing.T) {
	skills, err := builtinSkills()
	if err != nil {
		t.Fatal(err)
	}
	size := map[string]int{}
	for _, s := range skills {
		size[s.Name] = s.Bytes
	}
	// motion-language rides beside a planned page's pair or a film node's guide; motion-review beside a reviewer's.
	for _, set := range [][]string{
		{"motion-language", "design-craft", "anti-ai-slop"},
		{"motion-language", "code-motion", "promo-film", "code-video-brief"},
		{"motion-review", "design-jury", "anti-ai-slop", "design-craft"},
		{"motion-language", "motion-review", "code-motion", "motion-discipline"},
	} {
		total := 0
		for _, name := range set {
			n, ok := size[name]
			if !ok {
				t.Fatalf("skill %s missing", name)
			}
			total += n
		}
		if total > maxNodeSkillBytes {
			t.Errorf("%v add %d bytes; one node takes at most %d", set, total, maxNodeSkillBytes)
		}
	}
	if size["motion-language"] > 4400 || size["motion-review"] > 4400 {
		t.Errorf("motion-language (%d B) and motion-review (%d B) stay near 4 KB so they fit beside a film node's guide", size["motion-language"], size["motion-review"])
	}
}
