package app

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// A plan may add an image, video or 3D model node (2026-10-11): the gate admits the three media templates with
// their prompt as an input value, progress names the node while it is written, and any other template is still
// refused.
func TestPlansMayDeclareMediaNodes(t *testing.T) {
	for _, kind := range []string{"image", "video", "model3d"} {
		plan := `{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"asset","templateId":"` + kind +
			`","title":"Asset","inputValues":{"prompt":"a knight in silver armour"}},{"type":"set_input","nodeId":"asset","fieldId":"prompt","value":"again"}]}`
		if !validatePlan(plan) {
			t.Fatalf("%s: a media node plan was refused", kind)
		}
		if accepted, ok := acceptPlan("```json\n" + plan + "\n```"); !ok || accepted != plan {
			t.Fatalf("%s: accepted %v %q", kind, ok, accepted)
		}
		var p plannerProgress
		p.write(plan[:strings.Index(plan, `"title"`)])
		if p.operation != "add_node" || p.target != kind {
			t.Fatalf("%s: progress operation %q target %q", kind, p.operation, p.target)
		}
		p.write(plan[strings.Index(plan, `"title"`):])
		if p.operation != "set_input" || p.target != kind || p.template != kind {
			t.Fatalf("%s: progress after the plan: operation %q target %q template %q", kind, p.operation, p.target, p.template)
		}
	}
	if validatePlan(`{"version":1,"summary":"S","operations":[{"type":"add_node","ref":"a","templateId":"audio"}]}`) {
		t.Fatal("an unknown template was accepted")
	}
	if !strings.Contains(plannerInstructions, "inputValues.prompt") || !strings.Contains(plannerInstructions, "model3d") {
		t.Fatal("the planner is not told how to add a media node")
	}
}

// Users see media models, never which service makes them (owner decision 2026-10-11), and by generic names that
// carry no model family, maker or version either (owner decision 2026-10-11 20:27 +08: 「模型名也全部改成通用名」).
func TestMediaModelNamesNeverNameTheirProvider(t *testing.T) {
	seen := 0
	for _, m := range builtinMediaCatalog.List() {
		if m.Provider != mediaProviderXtasy && m.Provider != mediaProviderTripo {
			continue
		}
		seen++
		if m.Vendor != mediaVendorShown || m.Name != m.Label[0] {
			t.Errorf("%s: vendor %q, name %q, label %q", m.ID, m.Vendor, m.Name, m.Label)
		}
		for _, shown := range []string{m.Name, m.Label[0], m.Label[1]} {
			if why := brandedMediaName(shown); why != "" {
				t.Errorf("%s is shown as %q (%s)", m.ID, shown, why)
			}
		}
	}
	if seen != len(xtasyModels())+len(tripoModels()) {
		t.Fatalf("checked %d models", seen)
	}
	names := map[string]string{}
	for _, m := range append(xtasyModels(), tripoModels()...) {
		for _, shown := range m.Label {
			if other, taken := names[shown]; taken {
				t.Errorf("%s and %s are both shown as %q", other, m.ID, shown)
			}
			names[shown] = m.ID
		}
	}
	for _, branded := range []string{"Seedream 5.0 Pro", "GPT Image 2", "Nano Banana 2", "Image 3.0", "3D P1 · 游戏低多边形", "全能视频 v2.5"} {
		if brandedMediaName(branded) == "" {
			t.Errorf("%q passes as generic", branded)
		}
	}
}

// mediaBrandWords are providers, model families and makers a media name must not carry.
var mediaBrandWords = []string{"xtasy", "x-tasy", "tripo", "runninghub", "running hub", "seedream", "seedance", "doubao", "豆包", "即梦",
	"jimeng", "bytedance", "字节", "banana", "gemini", "google", "imagen", "veo", "gpt", "openai", "dall", "sora", "kling", "可灵",
	"kuaishou", "快手", "hailuo", "海螺", "minimax", "midjourney", "flux", "wan2", "万相", "qwen", "通义", "hunyuan", "混元", "vidu",
	"生数", "pixverse", "grok", "xai", "stable diffusion", "sdxl", "recraft", "ideogram"}

// brandedMediaName says why a name users see is not generic, or "" when it is: a brand word, or a version number
// (which names a model family as surely as its name does). "3D" is the kind, not a version.
func brandedMediaName(name string) string {
	lower := strings.ToLower(name)
	for _, word := range mediaBrandWords {
		if strings.Contains(lower, word) {
			return word
		}
	}
	if strings.ContainsAny(strings.ReplaceAll(name, "3D", ""), "0123456789") {
		return "a version number"
	}
	return ""
}

// The catalogue a browser reads shows media, not providers: every X-tasy and Tripo model by a generic name in both
// languages under the one vendor, and no provider named anywhere in the answer but the model ids themselves.
func TestMediaCatalogueShowsMediaNotProviders(t *testing.T) {
	h, _ := newMediaHarness(t)
	h.a.cfg.XtasyAPIKey, h.a.cfg.TripoAPIKey = "xtk_test-key-0123456789", "tsk_"+strings.Repeat("k", 32)
	h.a.cfg.XtasyAllWorkspaces, h.a.cfg.TripoAllWorkspaces = true, true
	c, tid, _ := h.register(t, "media-names@example.test")
	catalogue := h.request(t, c, "GET", "/tenants/"+tid+"/media", nil, 200)
	if _, named := catalogue["provider"]; named {
		t.Fatal("the catalogue names a provider:", catalogue["provider"])
	}
	listed := 0
	for _, raw := range catalogue["models"].([]any) {
		m := raw.(map[string]any)
		id, _ := m["id"].(string)
		if _, named := m["provider"]; named {
			t.Errorf("%s names its provider", id)
		}
		if !strings.HasPrefix(id, "xt.") && !strings.HasPrefix(id, "tripo.") {
			continue
		}
		listed++
		label, _ := m["label"].([]any)
		if len(label) != 2 || m["name"] != label[0] || m["vendor"] != mediaVendorShown {
			t.Errorf("%s: name %v, label %v, vendor %v", id, m["name"], m["label"], m["vendor"])
			continue
		}
		for _, shown := range []any{m["name"], label[0], label[1]} {
			if why := brandedMediaName(shown.(string)); why != "" {
				t.Errorf("%s is shown as %q (%s)", id, shown, why)
			}
		}
		delete(m, "id")
		if raw, _ := json.Marshal(m); bytes.Contains(bytes.ToLower(raw), []byte("tripo")) || bytes.Contains(bytes.ToLower(raw), []byte("xtasy")) {
			t.Errorf("%s names its provider beside its id: %s", id, raw)
		}
	}
	if listed != len(xtasyModels())+len(tripoModels()) {
		t.Fatalf("listed %d of the X-tasy and Tripo models", listed)
	}
}
