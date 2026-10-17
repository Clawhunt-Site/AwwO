package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// testGLB lays out a binary glTF 2.0 file from its JSON chunk's text and its binary chunk: the JSON padded with spaces
// and the binary chunk with zeros, as the specification says.
func testGLB(js, bin []byte) []byte {
	js, bin = slices.Clone(js), slices.Clone(bin)
	for len(js)%4 != 0 {
		js = append(js, ' ')
	}
	for len(bin)%4 != 0 {
		bin = append(bin, 0)
	}
	out := make([]byte, 20, 28+len(js)+len(bin))
	copy(out, "glTF")
	binary.LittleEndian.PutUint32(out[4:], 2)
	binary.LittleEndian.PutUint32(out[8:], uint32(28+len(js)+len(bin)))
	binary.LittleEndian.PutUint32(out[12:], uint32(len(js)))
	copy(out[16:], "JSON")
	out = append(out, js...)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(bin)))
	out = append(out, "BIN\x00"...)
	return append(out, bin...)
}

// glbChunks splits a GLB into its JSON chunk (padding included) and the bytes after it, checking the header's lengths.
func glbChunks(t *testing.T, glb []byte) (js, rest []byte) {
	t.Helper()
	if len(glb) < 20 || string(glb[:4]) != "glTF" || binary.LittleEndian.Uint32(glb[8:]) != uint32(len(glb)) || string(glb[16:20]) != "JSON" {
		t.Fatalf("not a GLB laid out as the specification says: % x", glb[:min(len(glb), 20)])
	}
	n := binary.LittleEndian.Uint32(glb[12:])
	if n%4 != 0 || 20+int(n) > len(glb) {
		t.Fatal("JSON chunk length", n)
	}
	return glb[20 : 20+n], glb[20+n:]
}

func motionParams(t *testing.T, model string, raw string) (*mediaModel, map[string]any, error) {
	t.Helper()
	m, ok := builtinMediaCatalog.model(model)
	if !ok {
		t.Fatal("model", model)
	}
	params, err := m.resolveMediaParams(json.RawMessage(raw))
	if err != nil {
		return m, nil, err
	}
	return m, params, nil
}

// Every skeleton and animation set, on both 3D models: which chain each runs, and which are refused at admission.
func TestTripoMotionSettingsAreClosed(t *testing.T) {
	type want struct {
		refused bool
		version string
		batches int
		inPlace bool
	}
	cases := map[string]want{}
	for _, rig := range tripoRigTypes {
		for _, motion := range tripoMotionChoices {
			key := rig + "/" + motion
			switch {
			case rig == "none" && motion == "none":
				cases[key] = want{}
			case rig == "none", rig == "avian" && motion != "none":
				cases[key] = want{refused: true}
			case motion == "none":
				cases[key] = want{version: map[bool]string{true: tripoRigV25, false: tripoRigV3}[tripoLegged[rig]]}
			case rig == "biped":
				cases[key] = want{version: tripoRigV3, batches: map[string]int{"locomotion": 1, "combat": 1, "full": 3}[motion], inPlace: true}
			default:
				cases[key] = want{version: map[bool]string{true: tripoRigV25, false: tripoRigV3}[tripoLegged[rig]], batches: 1, inPlace: true}
			}
		}
	}
	if len(cases) != 32 {
		t.Fatal("combinations", len(cases))
	}
	for _, model := range []string{"tripo.v3-1", "tripo.p1"} {
		for key, w := range cases {
			rig, motion, _ := strings.Cut(key, "/")
			raw := fmt.Sprintf(`{"rig":%q,"motion":%q}`, rig, motion)
			m, params, err := motionParams(t, model, raw)
			if w.refused {
				// Refused by the catalog's rules, and by the chain itself should those rules ever let it through.
				if chain, chainErr := tripoMotionFor(map[string]any{"rig": rig, "motion": motion}); err == nil || chainErr == nil {
					t.Fatal(model, key, "accepted", params, chain)
				}
				continue
			}
			if err != nil {
				t.Fatal(model, key, err)
			}
			chain, err := tripoMotionFor(params)
			if err != nil {
				t.Fatal(model, key, err)
			}
			if w.version == "" {
				if chain != nil {
					t.Fatal(model, key, "a chain without a skeleton", chain)
				}
				continue
			}
			if chain == nil || chain.Rig != rig || chain.Version != w.version || len(chain.Batches) != w.batches || chain.InPlace != w.inPlace ||
				chain.RigCredits != 75 || chain.RetargetCredits != 150 || !validTripoMotion(chain) {
				t.Fatal(model, key, chain)
			}
			// Admission refuses exactly what the chain refuses; the chain is frozen with the plan.
			c := testConfig()
			c.MediaDir, c.TripoAPIKey, c.TripoBaseURL, c.TripoResultHosts = t.TempDir(), "tsk_"+strings.Repeat("k", 32), defaultTripoBaseURL, []string{".tripo3d.ai"}
			c.MediaUnrestrictedWorkspaces = true
			a := &App{cfg: c}
			doc, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "n", "agentKind": mediaKindModel3D, "model": m.ID, "mediaParams": json.RawMessage(raw)}}})
			snap, err := a.mediaPlanSnapshot(doc, "n", m.ID, modelEntitlement{})
			if err != nil || !sameJSON(snap.Media.Motion, chain) || !frozenMotionValid(m, snap.Media, true) {
				t.Fatal(model, key, "admission", err, snap.Media)
			}
		}
		// In place is a setting of the clips: it applies only with an animation set, and stays at its default otherwise.
		for raw, ok := range map[string]bool{
			`{"rig":"biped","motion":"combat","inPlace":false}`: true, `{"rig":"biped","inPlace":false}`: false,
			`{"inPlace":false}`: false, `{"rig":"avian","inPlace":false}`: false, `{"rig":"biped","motion":"none","inPlace":true}`: true,
			`{"rig":"centaur"}`: false, `{"motion":"dance","rig":"biped"}`: false, `{"rig":true}`: false, `{"inPlace":"yes"}`: false,
		} {
			_, params, err := motionParams(t, model, raw)
			if (err == nil) != ok {
				t.Fatal(model, raw, err)
			}
			if raw == `{"rig":"biped","motion":"combat","inPlace":false}` {
				if chain, _ := tripoMotionFor(params); chain == nil || chain.InPlace {
					t.Fatal("in place off", chain)
				}
			}
		}
		// None of the chain's settings ever reaches the model request.
		m, params, err := motionParams(t, model, `{"rig":"biped","motion":"full","inPlace":false}`)
		if err != nil {
			t.Fatal(err)
		}
		for _, body := range []map[string]any{tripoRequest(m, "a knight", params), tripoImageRequest(m, "file_tok", params)} {
			for _, k := range []string{"rig", "motion", "inPlace", "rig_type", "animations", "animate_in_place"} {
				if _, ok := body[k]; ok {
					t.Fatal(model, "the model request carries", k, body)
				}
			}
		}
	}
	// A frozen chain read back is followed only with a shape this service could have frozen.
	full, _ := tripoMotionFor(map[string]any{"rig": "biped", "motion": "full", "inPlace": true})
	for name, mutate := range map[string]func(*tripoMotion){
		"no skeleton": func(m *tripoMotion) { m.Rig = "none" }, "unknown skeleton": func(m *tripoMotion) { m.Rig = "dragon" },
		"version": func(m *tripoMotion) { m.Version = "v9" }, "six presets": func(m *tripoMotion) { m.Batches[0] = append(m.Batches[0], "preset:turn") },
		"empty batch": func(m *tripoMotion) { m.Batches[1] = nil }, "four batches": func(m *tripoMotion) { m.Batches = append(m.Batches, []string{"preset:idle"}) },
		"not a preset": func(m *tripoMotion) { m.Batches[2][0] = "https://evil.test/clip" }, "negative": func(m *tripoMotion) { m.RigCredits = -1 },
	} {
		c := *full
		c.Batches = [][]string{slices.Clone(full.Batches[0]), slices.Clone(full.Batches[1]), slices.Clone(full.Batches[2])}
		mutate(&c)
		if validTripoMotion(&c) {
			t.Fatal("frozen chain accepted:", name)
		}
	}
	m, _ := builtinMediaCatalog.model("tripo.p1")
	if !frozenMotionValid(m, &mediaPlan{Params: map[string]any{"rig": "none"}}, true) || frozenMotionValid(m, &mediaPlan{Params: map[string]any{"rig": "biped"}}, true) ||
		frozenMotionValid(m, &mediaPlan{Params: map[string]any{"rig": "none"}, Motion: full}, true) || !frozenMotionValid(m, &mediaPlan{Motion: full}, false) {
		t.Fatal("a fresh run's chain is exactly its settings'")
	}
	image, _ := builtinMediaCatalog.model("xt.seedream-5-pro")
	if frozenMotionValid(image, &mediaPlan{Motion: full}, false) {
		t.Fatal("only a 3D model has a chain")
	}
}

// sameJSON reports whether two values encode to the same JSON (map keys sorted).
func sameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

// The catalog publishes the chain's settings as plain enums and a boolean, with names for their values and the
// dependency a client disables them by; validTripoModel accepts them only exactly so.
func TestTripoMotionParamsInTheCatalog(t *testing.T) {
	for _, model := range []string{"tripo.v3-1", "tripo.p1"} {
		m, _ := builtinMediaCatalog.model(model)
		var rig, motion, inPlace *mediaParam
		for i := range m.Params {
			switch m.Params[i].Name {
			case "rig":
				rig = &m.Params[i]
			case "motion":
				motion = &m.Params[i]
			case "inPlace":
				inPlace = &m.Params[i]
			}
		}
		if rig == nil || motion == nil || inPlace == nil || rig.Type != "enum" || rig.Default != "none" || rig.Label != [2]string{"骨骼", "Skeleton"} ||
			len(rig.ValueLabels) != 8 || rig.ValueLabels[5] != [2]string{"鸟类", "Bird"} || rig.Requires != nil ||
			motion.Default != "none" || motion.Label != [2]string{"动作", "Animations"} || motion.ValueLabels[3] != [2]string{"全套", "Full set"} ||
			motion.Requires == nil || motion.Requires.Param != "rig" || slices.Contains(motion.Requires.Values, "avian") || slices.Contains(motion.Requires.Values, "none") ||
			inPlace.Type != "boolean" || inPlace.Default != true || inPlace.Label != [2]string{"原地动作", "Animate in place"} || inPlace.Requires.Param != "motion" {
			t.Fatal(model, rig, motion, inPlace)
		}
		raw, _ := json.Marshal(m.Params)
		if !bytes.Contains(raw, []byte(`"valueLabels":[["无","None"],["双足","Biped"]`)) || !bytes.Contains(raw, []byte(`"requires":{"param":"rig","values":["biped",`)) {
			t.Fatal("published shape", string(raw))
		}
		for name, mutate := range map[string]func(*mediaModel){
			"an extra skeleton": func(m *mediaModel) {
				m.Params[len(m.Params)-3].Values = append(m.Params[len(m.Params)-3].Values, "others")
			},
			"another default":     func(m *mediaModel) { m.Params[len(m.Params)-1].Default = false },
			"without its rule":    func(m *mediaModel) { m.Params[len(m.Params)-2].Requires = nil },
			"a chain param twice": func(m *mediaModel) { m.Params = append(m.Params, tripoMotionParams()[0]) },
			"an unknown parameter": func(m *mediaModel) {
				m.Params = append(m.Params, mediaParam{Name: "rigify", Type: "boolean", Default: true, Label: [2]string{"a", "b"}})
			},
		} {
			bad := tripoModels()[map[string]int{"tripo.v3-1": 0, "tripo.p1": 1}[model]]
			mutate(bad)
			if validTripoModel(bad) == nil {
				t.Fatal(model, "accepted", name)
			}
		}
	}
	// The generic rules every catalog applies to dependencies and value names.
	enum := func(name string, values ...string) mediaParam {
		return mediaParam{Name: name, Type: "enum", Values: values, Default: values[0], Label: [2]string{"甲", "A"}}
	}
	dependent := func(on string, values ...string) mediaParam {
		p := enum("b", "x", "y")
		p.Requires = &mediaParamRequires{Param: on, Values: values}
		return p
	}
	ok := []mediaParam{enum("a", "1", "2"), dependent("a", "2")}
	if validMediaParamRequires(ok) != nil {
		t.Fatal("a valid dependency")
	}
	number := mediaParam{Name: "n", Type: "integer", Min: new(float64), Max: new(float64), Default: 0.0, Label: [2]string{"甲", "A"}, Requires: &mediaParamRequires{Param: "a", Values: []string{"2"}}}
	for name, params := range map[string][]mediaParam{
		"a later parameter":  {dependent("a", "2"), enum("a", "1", "2")},
		"an unknown one":     {enum("a", "1", "2"), dependent("z", "2")},
		"an unknown value":   {enum("a", "1", "2"), dependent("a", "3")},
		"a repeated value":   {enum("a", "1", "2"), dependent("a", "2", "2")},
		"no values":          {enum("a", "1", "2"), dependent("a")},
		"on a boolean":       {{Name: "a", Type: "boolean", Default: true, Label: [2]string{"甲", "A"}}, dependent("a", "true")},
		"a number dependent": {enum("a", "1", "2"), number},
	} {
		if validMediaParamRequires(params) == nil {
			t.Fatal("dependency accepted:", name)
		}
	}
	labelled := enum("a", "1", "2")
	for name, labels := range map[string][][2]string{"one short": {{"一", "One"}}, "empty": {{"一", "One"}, {"", "Two"}}, "control": {{"一", "One"}, {"二\n", "Two"}}} {
		labelled.ValueLabels = labels
		if validMediaParamSpec(&labelled) == nil {
			t.Fatal("value labels accepted:", name)
		}
	}
	boolean := mediaParam{Name: "a", Type: "boolean", Default: true, Label: [2]string{"甲", "A"}, ValueLabels: [][2]string{{"是", "Yes"}}}
	if validMediaParamSpec(&boolean) == nil {
		t.Fatal("value labels on a boolean")
	}
}

func TestTripoMotionRequests(t *testing.T) {
	full, _ := tripoMotionFor(map[string]any{"rig": "biped", "motion": "full", "inPlace": true})
	if got := tripoRigRequest("task_model", full); !sameJSON(got, map[string]any{"input": "task_model", "model": "v3.0-20260909",
		"rig_type": "biped", "spec": "tripo", "out_format": "glb"}) {
		t.Fatal("rig", got)
	}
	presets := []string{}
	for batch := range full.Batches {
		body := tripoRetargetRequest("task_rig", full, batch)
		names := body["animations"].([]string)
		if body["input"] != "task_rig" || body["out_format"] != "glb" || body["export_with_geometry"] != (batch == 0) || body["animate_in_place"] != true ||
			len(names) == 0 || len(names) > 5 || len(body) != 5 {
			t.Fatal("retarget", batch, body)
		}
		presets = append(presets, names...)
	}
	// All eleven humanoid presets, each once, five, five and one.
	sorted := slices.Sorted(slices.Values(presets))
	if !slices.Equal(sorted, []string{"preset:climb", "preset:dive", "preset:fall", "preset:hurt", "preset:idle", "preset:jump", "preset:run",
		"preset:shoot", "preset:slash", "preset:turn", "preset:walk"}) || len(full.Batches[0]) != 5 || len(full.Batches[1]) != 5 || len(full.Batches[2]) != 1 {
		t.Fatal("full set", full.Batches)
	}
	off, _ := tripoMotionFor(map[string]any{"rig": "biped", "motion": "locomotion", "inPlace": false})
	if body := tripoRetargetRequest("r", off, 0); body["animate_in_place"] != nil || !slices.Equal(body["animations"].([]string),
		[]string{"preset:idle", "preset:walk", "preset:run", "preset:jump", "preset:fall"}) {
		t.Fatal("locomotion with root motion", body)
	}
	combat, _ := tripoMotionFor(map[string]any{"rig": "biped", "motion": "combat"})
	if !slices.Equal(combat.Batches[0], []string{"preset:idle", "preset:walk", "preset:run", "preset:slash", "preset:hurt"}) || !combat.InPlace {
		t.Fatal("combat", combat)
	}
	for rig, want := range map[string][2]string{"quadruped": {"preset:quadruped:walk", tripoRigV25}, "hexapod": {"preset:hexapod:walk", tripoRigV25},
		"octopod": {"preset:octopod:walk", tripoRigV25}, "serpentine": {"preset:serpentine:march", tripoRigV3}, "aquatic": {"preset:aquatic:march", tripoRigV3}} {
		for _, motion := range []string{"locomotion", "combat", "full"} {
			chain, err := tripoMotionFor(map[string]any{"rig": rig, "motion": motion})
			if err != nil || chain.Version != want[1] || len(chain.Batches) != 1 || !slices.Equal(chain.Batches[0], []string{want[0]}) ||
				tripoRigRequest("m", chain)["model"] != want[1] || tripoRigRequest("m", chain)["rig_type"] != rig {
				t.Fatal(rig, motion, chain, err)
			}
		}
	}
	if bird, err := tripoMotionFor(map[string]any{"rig": "avian", "motion": "none"}); err != nil || bird.Version != tripoRigV3 || len(bird.Batches) != 0 {
		t.Fatal("a bird is rigged only", bird, err)
	}
	for code, want := range map[string]string{"media_provider_balance": "media_provider_balance", "media_provider_unauthorized": "media_provider_unauthorized",
		"media_provider_busy": "media_provider_busy", "media_provider_unavailable": "media_provider_unavailable", "media_timeout": "media_timeout",
		"media_failed": "media_motion_failed", "media_content_rejected": "media_motion_failed", "media_params_invalid": "media_motion_failed",
		"media_no_output": "media_motion_failed", "media_result_unavailable": "media_motion_failed", "media_task_missing": "media_motion_failed"} {
		if got := motionFailureCode(&rhError{Code: code}); got != want {
			t.Fatal(code, got)
		}
	}
	if got := motionFailureCode(context.DeadlineExceeded); got != "media_timeout" {
		t.Fatal("deadline", got)
	}
	// What a restart reads back: anything unreadable never lets a step be sent again.
	for name, c := range map[string]struct {
		tasks, sent string
		want        motionProgress
	}{
		"fresh":        {"[]", "0", motionProgress{tasks: []string{}, sent: 0}},
		"two accepted": {`["rig_1","rt_1"]`, "2", motionProgress{tasks: []string{"rig_1", "rt_1"}, sent: 2}},
		"answer lost":  {`["rig_1"]`, "2", motionProgress{tasks: []string{"rig_1"}, sent: 2}},
		"behind":       {`["rig_1","rt_1"]`, "1", motionProgress{tasks: []string{"rig_1", "rt_1"}, sent: 2}},
		"bad tasks":    {`{"x":1}`, "1", motionProgress{sent: 1<<31 - 1}},
		"bad sent":     {`[]`, "two", motionProgress{sent: 1<<31 - 1}},
		"negative":     {`[]`, "-1", motionProgress{sent: 1<<31 - 1}},
	} {
		got := readMotionProgress(c.tasks, c.sent)
		if got.sent != c.want.sent || !slices.Equal(got.tasks, c.want.tasks) {
			t.Fatal(name, got)
		}
	}
}

// A rig is 75 credits and every retarget task 150, on top of the model's own price.
func TestTripoMotionPrices(t *testing.T) {
	for _, c := range []struct {
		model, params string
		refs, want    int
	}{
		{"tripo.v3-1", `{}`, 0, 60}, {"tripo.v3-1", `{"rig":"biped"}`, 0, 135}, {"tripo.v3-1", `{"rig":"biped","motion":"locomotion"}`, 0, 285},
		{"tripo.v3-1", `{"rig":"biped","motion":"combat","inPlace":false}`, 0, 285}, {"tripo.v3-1", `{"rig":"biped","motion":"full"}`, 0, 585},
		{"tripo.v3-1", `{"rig":"avian"}`, 0, 135}, {"tripo.v3-1", `{"rig":"serpentine","motion":"full"}`, 0, 285},
		{"tripo.v3-1", `{"rig":"biped","motion":"full","geometryQuality":"detailed","textureQuality":"detailed"}`, 1, 705},
		{"tripo.p1", `{"rig":"quadruped","motion":"combat"}`, 0, 345}, {"tripo.p1", `{"rig":"octopod"}`, 0, 195},
		{"tripo.p1", `{"rig":"biped","motion":"full","texture":false,"pbr":false}`, 1, 645},
	} {
		m, params, err := motionParams(t, c.model, c.params)
		if err != nil {
			t.Fatal(c.model, c.params, err)
		}
		if got := mediaCreditsFor(m.ID, m.Kind, params) + mediaReferenceCredits(m.ID, c.refs); got != c.want {
			t.Fatal(c.model, c.params, got, c.want)
		}
	}
}

// A downstream page reads each GLB's clips from the record, and that a clips-only file is for the first model's
// skeleton; a static model's lines stay exactly as they were.
func TestMediaDeliveryTextNamesAnimatedModelsClips(t *testing.T) {
	n := graphNode{ID: "hero", Title: "Hero", Kind: "session", AgentKind: mediaKindModel3D}
	static := `{"type":"awwo.media","version":1,"kind":"model3d","model":"tripo.p1","items":[{"artifactId":"aAAAAAAAAAAA","name":"model-1.glb","contentType":"model/gltf-binary","size":2048},{"artifactId":"aBBBBBBBBBBB","name":"preview-2.png","contentType":"image/png","size":512}]}`
	if got := mediaDeliveryText(n, static); got != strings.Join([]string{"「Hero」生成的3D 模型文件（存放在这张画布的成果里，这里只列文件，不含内容）：",
		"- hero/model-1.glb（model/gltf-binary，2048 字节）", "- hero/preview-2.png（image/png，512 字节）",
		"网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。"}, "\n") {
		t.Fatalf("static model %q", got)
	}
	animated := `{"type":"awwo.media","version":1,"kind":"model3d","model":"tripo.p1","items":[
		{"artifactId":"aAAAAAAAAAAA","name":"model-1.glb","contentType":"model/gltf-binary","size":5501312,"animations":["hurt","idle","run","slash","walk"]},
		{"artifactId":"aCCCCCCCCCCC","name":"model-2.glb","contentType":"model/gltf-binary","size":812345,"animations":["climb","dive","fall","jump","turn"],"clipsOnly":true},
		{"artifactId":"aDDDDDDDDDDD","name":"model-3.glb","contentType":"model/gltf-binary","size":98765,"animations":["shoot","<b>x</b>","two words"],"clipsOnly":true},
		{"artifactId":"aBBBBBBBBBBB","name":"preview-4.png","contentType":"image/png","size":512}]}`
	want := strings.Join([]string{"「Hero」生成的3D 模型文件（存放在这张画布的成果里，这里只列文件，不含内容）：",
		"- hero/model-1.glb（model/gltf-binary，5501312 字节；动画：hurt idle run slash walk）",
		"- hero/model-2.glb（model/gltf-binary，812345 字节；只有动画，没有模型，骨骼与 hero/model-1.glb 相同；动画：climb dive fall jump turn）",
		"- hero/model-3.glb（model/gltf-binary，98765 字节；只有动画，没有模型，骨骼与 hero/model-1.glb 相同；动画：shoot）",
		"- hero/preview-4.png（image/png，512 字节）",
		"网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。",
		"带动画的 GLB 用 THREE.AnimationMixer 按上面的动画名播放它的动画（gltf.animations）。只有动画的文件和 hero/model-1.glb 是同一副骨骼：加载它只取动画，按骨骼名用到 hero/model-1.glb 的场景上。"}, "\n")
	if got := mediaDeliveryText(n, animated); got != want {
		t.Fatalf("animated model:\n%s\nwant:\n%s", got, want)
	}
	// A rigged model with clips and no clips-only file: no word about other files.
	single := `{"type":"awwo.media","version":1,"kind":"model3d","model":"tripo.p1","items":[{"artifactId":"aAAAAAAAAAAA","name":"model-1.glb","contentType":"model/gltf-binary","size":10,"animations":["walk"]}]}`
	if got := mediaDeliveryText(n, single); !strings.HasSuffix(got, "\n带动画的 GLB 用 THREE.AnimationMixer 按上面的动画名播放它的动画（gltf.animations）。") || !strings.Contains(got, "（model/gltf-binary，10 字节；动画：walk）") {
		t.Fatalf("single animated model %q", got)
	}
}

// The API leaves a GLB's maker out of its JSON chunk and reads the chunk for its clips, changing nothing else.
func TestMediaGLBGeneratorIsNeutralizedAndItsClipsRead(t *testing.T) {
	a := &App{cfg: Config{MediaDir: t.TempDir()}}
	tmp := filepath.Join(a.cfg.MediaDir, ".tmp")
	if e := os.MkdirAll(tmp, 0o750); e != nil {
		t.Fatal(e)
	}
	bin := bytes.Repeat([]byte{0, 1, 2, 3, 0xFE, 0xFF, 'g', 'l'}, 9) // 72 bytes, a texture's worth of "tripo" never inside it
	run := func(name string, glb []byte) (fetchedMedia, []byte) {
		t.Helper()
		path := filepath.Join(tmp, "download-"+name)
		if e := os.WriteFile(path, glb, 0o640); e != nil {
			t.Fatal(e)
		}
		f := fetchedMedia{path: path, size: int64(len(glb)), sum: "unchanged"}
		a.neutralizeGLB(&f, tmp)
		out, err := os.ReadFile(f.path)
		if err != nil || int64(len(out)) != f.size {
			t.Fatal(name, "stored file", err, len(out), f.size)
		}
		if f.path != path {
			if _, e := os.Stat(path); !os.IsNotExist(e) {
				t.Fatal(name, "the original was left behind")
			}
		}
		return f, out
	}
	doc := `{"asset":{"generator":"tripo3d.ai v3 (https://www.tripo3d.ai)","version":"2.0"},"scene":0,"meshes":[{"name":"tripo_mesh","primitives":[]}],` +
		`"animations":[{"name":"hurt","channels":[],"samplers":[]},{"name":"idle"},{"name":"run"},{"name":"idle"},{"name":"two words"},{"name":"<b>"},{"name":7},{}],` +
		`"extras":{"note":"\"generator\":\"tripo\""},"buffers":[{"byteLength":72}]}`
	f, out := run("plain", testGLB([]byte(doc), bin))
	js, rest := glbChunks(t, out)
	wantJSON := strings.Replace(doc, `"generator":"tripo3d.ai v3 (https://www.tripo3d.ai)"`, `"generator":"AwwO"`, 1)
	if strings.TrimRight(string(js), " ") != wantJSON || len(js)%4 != 0 || len(js)-len(wantJSON) > 3 {
		t.Fatalf("JSON chunk %q", js)
	}
	if want := testGLB([]byte(doc), bin); !bytes.Equal(rest, want[len(want)-len(rest):]) || len(rest) != 8+len(bin) {
		t.Fatal("the binary chunk changed")
	}
	if !slices.Equal(f.animations, []string{"hurt", "idle", "run"}) || f.clipsOnly || f.sum == "unchanged" || len(f.sum) != 64 {
		t.Fatal("facts", f.animations, f.clipsOnly, f.sum)
	}
	// Escaped keys, whitespace and a generator in two asset objects: every one is replaced, nothing else moves.
	pretty := "{\n  \"asset\" : {\n    \"version\": \"2.0\",\n    \"gener\\u0061tor\" :  \"Tripo \\\"exporter\\\"\"\n  },\n  \"asset\": {\"generator\": \"x\"},\n  \"nodes\": [{\"name\": \"Hips\"}]\n}"
	_, out = run("pretty", testGLB([]byte(pretty), bin))
	js, _ = glbChunks(t, out)
	want := strings.Replace(strings.Replace(pretty, `"Tripo \"exporter\""`, `"AwwO"`, 1), `"generator": "x"`, `"generator": "AwwO"`, 1)
	if strings.TrimRight(string(js), " ") != want {
		t.Fatalf("pretty JSON chunk %q", js)
	}
	// A clips-only file: clips and no mesh.
	f, _ = run("clips", testGLB([]byte(`{"asset":{"version":"2.0","generator":"g"},"nodes":[{"name":"Hips"}],"animations":[{"name":"climb"},{"name":"dive"}]}`), bin))
	if !f.clipsOnly || !slices.Equal(f.animations, []string{"climb", "dive"}) {
		t.Fatal("clips only", f)
	}
	// Zero padding (a writer's mistake) is read, and the chunk is padded with spaces again.
	zeros := testGLB([]byte(`{"asset":{"version":"2.0","generator":"gen!"}}`), bin)
	jsLen := binary.LittleEndian.Uint32(zeros[12:])
	for i := 20 + int(jsLen) - 1; zeros[i] == ' '; i-- {
		zeros[i] = 0
	}
	_, out = run("zeros", zeros)
	if js, _ = glbChunks(t, out); strings.TrimRight(string(js), " ") != `{"asset":{"version":"2.0","generator":"AwwO"}}` {
		t.Fatalf("zero padding %q", js)
	}
	// Files kept exactly as they came: nothing to replace, already AwwO's, not a generator string, not JSON, a header
	// that disagrees with the file, a first chunk that is not JSON, a chunk past the end, glTF 1.
	unchanged := map[string][]byte{
		"no generator": testGLB([]byte(`{"asset":{"version":"2.0"},"animations":[{"name":"walk"}],"meshes":[{}]}`), bin),
		"already":      testGLB([]byte(`{"asset":{"generator":"AwwO","version":"2.0"}}`), bin),
		"a number":     testGLB([]byte(`{"asset":{"generator":3,"version":"2.0"}}`), bin),
		"not JSON":     testGLB([]byte(`{"asset":{"generator":"tripo",}`), bin),
		"an array":     testGLB([]byte(`[{"asset":{"generator":"tripo"}}]`), bin),
		"bad shape":    testGLB([]byte(`{"asset":{"generator":"tripo"},"animations":{"name":"x"}}`), bin),
	}
	long := testGLB([]byte(`{"asset":{"generator":"tripo"}}`), bin)
	binary.LittleEndian.PutUint32(long[8:], uint32(len(long)+4))
	unchanged["header length"] = long
	notJSON := testGLB([]byte(`{"asset":{"generator":"tripo"}}`), bin)
	copy(notJSON[16:20], "BIN\x00")
	unchanged["first chunk"] = notJSON
	past := testGLB([]byte(`{"asset":{"generator":"tripo"}}`), bin)
	binary.LittleEndian.PutUint32(past[12:], uint32(len(past)))
	unchanged["past the end"] = past
	v1 := testGLB([]byte(`{"asset":{"generator":"tripo"}}`), bin)
	binary.LittleEndian.PutUint32(v1[4:], 1)
	unchanged["glTF 1"] = v1
	for name, glb := range unchanged {
		f, out := run(strings.ReplaceAll(name, " ", "-"), glb)
		if !bytes.Equal(out, glb) || f.sum != "unchanged" {
			t.Fatal(name, "was changed")
		}
		if name == "no generator" && !slices.Equal(f.animations, []string{"walk"}) {
			t.Fatal("clips of a file kept as it came", f.animations)
		}
		if name != "no generator" && len(f.animations) != 0 {
			t.Fatal(name, "facts from a file that cannot be read", f.animations)
		}
	}
	// The 3D test fixtures elsewhere, a header with nothing after it, are stored as they came.
	stub := append([]byte("glTF"), make([]byte, 2048)...)
	binary.LittleEndian.PutUint32(stub[4:8], 2)
	if _, out := run("stub", stub); !bytes.Equal(out, stub) {
		t.Fatal("a stub GLB was changed")
	}
}

// fakeTripo stands in for Tripo's task API and its file storage for a whole chain: the model, rig and retarget tasks,
// and a GLB for each task, laid out as a real one (a retarget task's clips named as Tripo names them: lower case,
// without "preset:", in alphabetical order).
type fakeTripo struct {
	t          *testing.T
	api, files *httptest.Server
	mu         sync.Mutex
	posts      []fakeSubmit
	counts     map[string]int
	content    map[string][]byte
	// outcome is a task's state when queried ("success" when it returns ""), with Tripo's error code.
	outcome func(task string) (status string, code int)
	// refuse answers a submission instead of creating a task when it returns a status.
	refuse func(path string) (status int, body any)
}

const fakeTripoBin = "\x01\x02\x03\x04TEXTURE\x00GEOMETRY"

func newFakeTripo(t *testing.T, h *harness) *fakeTripo {
	f := &fakeTripo{t: t, counts: map[string]int{}, content: map[string][]byte{"/preview.png": testPNG}}
	f.api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.posts = append(f.posts, fakeSubmit{path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body})
			if f.refuse != nil {
				if status, reply := f.refuse(r.URL.Path); status != 0 {
					writeJSON(w, status, reply)
					return
				}
			}
			prefix := map[string]string{"/generation/text-to-model": "model", "/generation/image-to-model": "model", "/animations/rig": "rig",
				"/animations/retarget": "rt"}[r.URL.Path]
			if prefix == "" {
				w.WriteHeader(404)
				return
			}
			f.counts[prefix]++
			id := fmt.Sprintf("%s_%d", prefix, f.counts[prefix])
			f.content["/"+id+".glb"] = f.glbFor(prefix, id, body)
			writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"task_id": id}})
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/tasks/")
		status, code := "", 0
		if f.outcome != nil {
			status, code = f.outcome(id)
		}
		if status == "" {
			status = "success"
		}
		data := map[string]any{"task_id": id, "status": status}
		if code != 0 {
			data["error_code"] = code
		}
		if status == "success" {
			output := map[string]any{"model_url": "https://tripo-data.cdn.tripo3d.ai/" + id + ".glb"}
			if strings.HasPrefix(id, "model_") {
				output["rendered_image_url"] = "https://tripo-data.cdn.tripo3d.ai/preview.png"
			}
			data["output"] = output
		}
		writeJSON(w, 200, map[string]any{"code": 0, "data": data})
	}))
	f.files = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		data, ok := f.content[r.URL.Path]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(func() { f.api.Close(); f.files.Close() })
	f.configure(h.a)
	return f
}

func (f *fakeTripo) configure(a *App) {
	a.cfg.TripoAPIKey, a.cfg.TripoBaseURL, a.cfg.TripoResultHosts = "tsk_test-key-0123456789", f.api.URL, []string{".tripo3d.ai"}
	a.cfg.TripoFreeRunsPerDay, a.cfg.TripoFreeTotalPerDay = 50, 50
	hub := newTripo(a.cfg)
	hub.files.Transport = redirectTransport{f.files}
	a.tripo = hub
}

// glbFor is the file a task makes: the model with the service's mark in its generator, the rig with a skin, a retarget
// task's with its clips, and the mesh only with export_with_geometry.
func (f *fakeTripo) glbFor(prefix, id string, body map[string]any) []byte {
	doc := map[string]any{"asset": map[string]any{"generator": "tripo3d.ai " + id, "version": "2.0"}, "nodes": []any{map[string]any{"name": "Hips"}},
		"buffers": []any{map[string]any{"byteLength": len(fakeTripoBin)}}}
	mesh := []any{map[string]any{"name": "tripo_" + id, "primitives": []any{}}}
	switch prefix {
	case "model":
		doc["meshes"] = mesh
	case "rig":
		doc["meshes"], doc["skins"] = mesh, []any{map[string]any{"joints": []int{0}}}
	case "rt":
		if body["export_with_geometry"] == true {
			doc["meshes"] = mesh
		}
		names := []string{}
		presets, _ := body["animations"].([]any)
		for _, p := range presets {
			s, _ := p.(string)
			parts := strings.Split(s, ":")
			names = append(names, parts[len(parts)-1])
		}
		sort.Strings(names)
		clips := []any{}
		for _, n := range names {
			clips = append(clips, map[string]any{"name": n, "channels": []any{}, "samplers": []any{}})
		}
		doc["animations"] = clips
	}
	js, _ := json.Marshal(doc)
	return testGLB(js, []byte(fakeTripoBin+id))
}

func (f *fakeTripo) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.posts, f.counts, f.outcome, f.refuse = nil, map[string]int{}, nil, nil
}

func (f *fakeTripo) sent() []fakeSubmit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.posts)
}

func (f *fakeTripo) paths() []string {
	out := []string{}
	for _, p := range f.sent() {
		out = append(out, p.path)
	}
	return out
}

func (f *fakeTripo) set(outcome func(string) (string, int), refuse func(string) (int, any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcome, f.refuse = outcome, refuse
}

// motionNode is a 3D node with these settings and its prompt in its draft.
func motionNode(id, model string, params map[string]any) map[string]any {
	n := mediaNode(id, mediaKindModel3D, model, params)
	n["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": "a knight in armour", "createdAt": 0}}
	return n
}

func runItems(t *testing.T, run map[string]any) []mediaItem {
	t.Helper()
	var out mediaOutput
	if e := json.Unmarshal([]byte(run["output"].(string)), &out); e != nil || out.Kind != mediaKindModel3D {
		t.Fatal("output", run["output"], e)
	}
	return out.Items
}

// storedFile reads a kept artifact's bytes from the media directory, checking them against its row.
func storedFile(t *testing.T, h *harness, tid, artifact string) []byte {
	t.Helper()
	var rel, sum string
	var size int64
	if e := h.db.QueryRow(t.Context(), "SELECT storage_path,sha256,size FROM artifacts WHERE tenant_id=$1 AND id=$2", tid, artifact).Scan(&rel, &sum, &size); e != nil {
		t.Fatal(e)
	}
	data, err := os.ReadFile(filepath.Join(h.a.cfg.MediaDir, filepath.FromSlash(rel)))
	if err != nil || int64(len(data)) != size || !strings.HasPrefix(rel, tid+"/") || !strings.HasSuffix(rel, "/"+sum+".glb") && !strings.HasSuffix(rel, "/"+sum+".png") {
		t.Fatal("stored file", rel, err, len(data), size)
	}
	return data
}

// A 3D node with a skeleton and an animation set ends with rigged, animated GLBs: the rig on the model task, each
// retarget task on the rig, the files named model-1.glb, model-2.glb, model-3.glb before the preview, each with the
// clips its file says it has, and the maker's name out of each JSON chunk.
func TestPostgresTripoMotionChainsDeliverAnimatedModels(t *testing.T) {
	h, _ := newMediaHarness(t)
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "tripo-motion@example.test")
	// Rigging needs a paid plan or the operator's own workspace (admitMediaGeneration); this one is the operator's.
	execSQL(t, h, "UPDATE users SET platform_role='admin' WHERE email=$1", "tripo-motion@example.test")
	_, canvas := mediaCanvas(t, h, c, tid,
		motionNode("combat", "tripo.p1", map[string]any{"rig": "biped", "motion": "combat"}),
		motionNode("full", "tripo.v3-1", map[string]any{"rig": "biped", "motion": "full", "inPlace": false}),
		motionNode("rigonly", "tripo.p1", map[string]any{"rig": "quadruped"}),
		motionNode("snake", "tripo.v3-1", map[string]any{"rig": "serpentine", "motion": "locomotion"}))
	session := func(i int) string { return setupNodeAt(canvas, i)["issueId"].(string) }

	// Combat: the rig on the model, one retarget task on the rig, in place.
	run := h.mediaRun(t, c, tid, session(0), "a knight in armour", 202)
	done := h.awaitRun(t, c, tid, run["id"].(string), "completed")
	posts := f.sent()
	if len(posts) != 3 || posts[0].path != "/generation/text-to-model" || posts[1].path != "/animations/rig" || posts[2].path != "/animations/retarget" {
		t.Fatal("combat tasks", f.paths())
	}
	for _, k := range []string{"rig", "motion", "inPlace", "rig_type"} {
		if _, ok := posts[0].body[k]; ok {
			t.Fatal("the model request carries", k)
		}
	}
	if !sameJSON(posts[1].body, map[string]any{"input": "model_1", "model": "v3.0-20260909", "rig_type": "biped", "spec": "tripo", "out_format": "glb"}) ||
		posts[1].auth != "Bearer tsk_test-key-0123456789" {
		t.Fatal("rig request", posts[1])
	}
	if !sameJSON(posts[2].body, map[string]any{"input": "rig_1", "animations": []any{"preset:idle", "preset:walk", "preset:run", "preset:slash", "preset:hurt"},
		"out_format": "glb", "export_with_geometry": true, "animate_in_place": true}) {
		t.Fatal("retarget request", posts[2].body)
	}
	items := runItems(t, done)
	if len(items) != 2 || items[0].Name != "model-1.glb" || items[0].ContentType != "model/gltf-binary" || items[0].ClipsOnly ||
		!slices.Equal(items[0].Animations, []string{"hurt", "idle", "run", "slash", "walk"}) || items[1].Name != "preview-2.png" || items[1].Animations != nil {
		t.Fatal("combat items", items)
	}
	// The kept model is the retarget task's file with the maker's name replaced and its binary chunk untouched.
	glb := storedFile(t, h, tid, items[0].ArtifactID)
	js, rest := glbChunks(t, glb)
	if !bytes.Contains(js, []byte(`"generator":"AwwO"`)) || bytes.Contains(js, []byte("tripo3d.ai")) || !bytes.Contains(rest, []byte(fakeTripoBin+"rt_1")) ||
		int64(len(glb)) != items[0].Size {
		t.Fatalf("stored model %q", js)
	}
	if !bytes.Equal(storedFile(t, h, tid, items[1].ArtifactID), testPNG) {
		t.Fatal("preview")
	}

	// The full set: three retarget tasks on the one rig, the later two without the mesh, root motion kept.
	f.reset()
	run = h.mediaRun(t, c, tid, session(1), "a knight in armour", 202)
	done = h.awaitRun(t, c, tid, run["id"].(string), "completed")
	posts = f.sent()
	if !slices.Equal(f.paths(), []string{"/generation/text-to-model", "/animations/rig", "/animations/retarget", "/animations/retarget", "/animations/retarget"}) {
		t.Fatal("full tasks", f.paths())
	}
	for i, post := range posts[2:] {
		if post.body["input"] != "rig_1" || post.body["export_with_geometry"] != (i == 0) || post.body["animate_in_place"] != nil {
			t.Fatal("full retarget", i, post.body)
		}
	}
	items = runItems(t, done)
	names := []string{}
	for _, item := range items {
		names = append(names, item.Name)
	}
	if !slices.Equal(names, []string{"model-1.glb", "model-2.glb", "model-3.glb", "preview-4.png"}) || items[0].ClipsOnly || !items[1].ClipsOnly || !items[2].ClipsOnly ||
		!slices.Equal(items[1].Animations, []string{"climb", "dive", "fall", "jump", "turn"}) || !slices.Equal(items[2].Animations, []string{"shoot"}) {
		t.Fatal("full items", items)
	}
	for _, item := range items[:3] {
		if js, _ := glbChunks(t, storedFile(t, h, tid, item.ArtifactID)); bytes.Contains(js, []byte("tripo3d.ai")) {
			t.Fatal("a kept GLB still names its maker", item.Name)
		}
	}
	// Every step was marked sent before it went out and recorded once Tripo took it, in order, for a restart to follow.
	var sentSteps, tasks string
	if e := h.db.QueryRow(t.Context(), "SELECT media_task->>'motionSent',media_task->>'motionTasks' FROM runs WHERE id=$1", run["id"]).Scan(&sentSteps, &tasks); e != nil ||
		sentSteps != "4" || tasks != `["rig_1", "rt_1", "rt_2", "rt_3"]` {
		t.Fatal("recorded chain", sentSteps, tasks, e)
	}

	// A skeleton alone: the rig's own file, rigged by the version that can later animate a quadruped.
	f.reset()
	run = h.mediaRun(t, c, tid, session(2), "a wolf", 202)
	done = h.awaitRun(t, c, tid, run["id"].(string), "completed")
	posts = f.sent()
	if len(posts) != 2 || posts[1].body["model"] != "v2.5-20260210" || posts[1].body["rig_type"] != "quadruped" {
		t.Fatal("rig only", f.paths(), posts)
	}
	items = runItems(t, done)
	if len(items) != 2 || items[0].Name != "model-1.glb" || items[0].Animations != nil || items[1].Name != "preview-2.png" ||
		!bytes.Contains(storedFile(t, h, tid, items[0].ArtifactID), []byte(fakeTripoBin+"rig_1")) {
		t.Fatal("rig only items", items)
	}

	// A serpent moves by its one preset.
	f.reset()
	run = h.mediaRun(t, c, tid, session(3), "a sea serpent", 202)
	done = h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if posts = f.sent(); len(posts) != 3 || posts[1].body["model"] != "v3.0-20260909" || !sameJSON(map[string]any{"a": posts[2].body["animations"]}, map[string]any{"a": []any{"preset:serpentine:march"}}) {
		t.Fatal("serpent", posts)
	}
	if items = runItems(t, done); !slices.Equal(items[0].Animations, []string{"march"}) {
		t.Fatal("serpent items", items)
	}
	// Every chain ran as one generation each.
	var generations int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM media_generations WHERE tenant_id=$1 AND provider_accepted", tid).Scan(&generations); e != nil || generations != 4 {
		t.Fatal("generations", generations, e)
	}
}

// chargedCredits is what a paid generation costs its plan once its run ended (creditsSpentSQL): its points once its
// provider accepted it.
func chargedCredits(t *testing.T, h *harness, tid, rid string) int {
	t.Helper()
	var points *int
	var accepted *bool
	if e := h.db.QueryRow(t.Context(), "SELECT credit_points,provider_accepted FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&points, &accepted); e != nil {
		t.Fatal(e)
	}
	if points == nil || accepted == nil || !*accepted {
		return 0
	}
	return *points
}

// A failed step fails the node with media_motion_failed, and a paid plan pays for the model and for every step Tripo
// accepted and did not refund, as for the model task alone: a failed or cancelled step costs nothing, a banned one is
// billed, a step never sent costs nothing. The operator's balance keeps its own code.
func TestPostgresTripoMotionFailuresChargeWhatSucceeded(t *testing.T) {
	h, _ := newMediaHarness(t)
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "tripo-motion-paid@example.test")
	execSQL(t, h, `UPDATE tenants SET route_limits='{"media":1}'::jsonb WHERE id=$1`, tid)
	now := time.Now()
	givePlan(t, h, "tripo-motion-paid@example.test", "max", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 10000)
	_, canvas := mediaCanvas(t, h, c, tid,
		motionNode("full", "tripo.p1", map[string]any{"rig": "biped", "motion": "full"}),
		motionNode("combat", "tripo.p1", map[string]any{"rig": "biped", "motion": "combat"}))
	full, combat := setupNodeAt(canvas, 0)["issueId"].(string), setupNodeAt(canvas, 1)["issueId"].(string)
	spentBefore := func() float64 { return planCredits0(t, h, c, tid)["spent"].(float64) }
	type step struct {
		name, session string
		outcome       func(string) (string, int)
		refuse        func(string) (int, any)
		code          string
		paths         []string
		charged       int
	}
	model, rig, rt := "/generation/text-to-model", "/animations/rig", "/animations/retarget"
	for _, s := range []step{
		{"success", full, nil, nil, "", []string{model, rig, rt, rt, rt}, 120 + 75 + 450},
		{"a failed rig", full, func(id string) (string, int) {
			if id == "rig_1" {
				return "failed", 0
			}
			return "", 0
		}, nil, "media_motion_failed", []string{model, rig}, 120},
		{"a failed second retarget", full, func(id string) (string, int) {
			if id == "rt_2" {
				return "failed", 2008
			}
			return "", 0
		}, nil, "media_motion_failed", []string{model, rig, rt, rt}, 120 + 75 + 150},
		{"a banned rig", combat, func(id string) (string, int) {
			if id == "rig_1" {
				return "banned", 0
			}
			return "", 0
		}, nil, "media_motion_failed", []string{model, rig}, 120 + 75},
		{"a cancelled retarget", combat, func(id string) (string, int) {
			if id == "rt_1" {
				return "cancelled", 0
			}
			return "", 0
		}, nil, "media_motion_failed", []string{model, rig, rt}, 120 + 75},
		{"an expired retarget", combat, func(id string) (string, int) {
			if id == "rt_1" {
				return "expired", 0
			}
			return "", 0
		}, nil, "media_motion_failed", []string{model, rig, rt}, 120 + 75 + 150},
		{"the balance", full, nil, func(path string) (int, any) {
			if path == "/animations/rig" {
				return 403, map[string]any{"code": 2010, "message": "Insufficient credits"}
			}
			return 0, nil
		}, "media_provider_balance", []string{model, rig}, 120},
		{"a refused retarget", combat, nil, func(path string) (int, any) {
			if path == "/animations/retarget" {
				return 400, map[string]any{"code": 2002, "message": "preset unsupported for this rig"}
			}
			return 0, nil
		}, "media_motion_failed", []string{model, rig, rt}, 120 + 75},
		{"a failed model", full, func(id string) (string, int) {
			if id == "model_1" {
				return "failed", 0
			}
			return "", 0
		}, nil, "media_failed", []string{model}, 0},
		{"a banned model", full, func(id string) (string, int) {
			if id == "model_1" {
				return "banned", 0
			}
			return "", 0
		}, nil, "media_content_rejected", []string{model}, 120},
	} {
		f.reset()
		f.set(s.outcome, s.refuse)
		before := spentBefore()
		run := h.mediaRun(t, c, tid, s.session, "a knight in armour", 202)
		rid := run["id"].(string)
		want := "completed"
		if s.code != "" {
			want = "failed"
		}
		if status, code := awaitRunRow(t, h, tid, rid, "completed", "failed"); status != want || code != s.code {
			t.Fatal(s.name, status, code)
		}
		if got := f.paths(); !slices.Equal(got, s.paths) {
			t.Fatal(s.name, "tasks", got)
		}
		if got := chargedCredits(t, h, tid, rid); got != s.charged {
			t.Fatal(s.name, "charged", got, s.charged)
		}
		if spent := spentBefore(); spent-before != float64(s.charged) {
			t.Fatal(s.name, "plan spend", spent-before, s.charged)
		}
		// A failed chain keeps no file: nothing of it reaches the canvas's results.
		var files int
		if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM artifacts WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&files); e != nil || (s.code != "") != (files == 0) {
			t.Fatal(s.name, "files kept", files, e)
		}
	}
}

// A cancel between steps stops the chain: nothing more is sent, the step Tripo accepted is paid for, the rest not.
func TestPostgresTripoMotionCancelStopsTheChain(t *testing.T) {
	h, _ := newMediaHarness(t)
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "tripo-motion-cancel@example.test")
	execSQL(t, h, `UPDATE tenants SET route_limits='{"media":1}'::jsonb WHERE id=$1`, tid)
	now := time.Now()
	givePlan(t, h, "tripo-motion-cancel@example.test", "max", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 10000)
	_, canvas := mediaCanvas(t, h, c, tid, motionNode("full", "tripo.p1", map[string]any{"rig": "biped", "motion": "full"}))
	f.set(func(id string) (string, int) {
		if id == "rig_1" {
			return "running", 0
		}
		return "", 0
	}, nil)
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a knight in armour", 202)
	rid := run["id"].(string)
	deadline := time.Now().Add(10 * time.Second)
	for !slices.Equal(f.paths(), []string{"/generation/text-to-model", "/animations/rig"}) {
		if time.Now().After(deadline) {
			t.Fatal("the rig was never sent", f.paths())
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.request(t, c, "POST", "/tenants/"+tid+"/runs/"+rid+"/cancel", nil, 200)
	if status, _ := awaitRunRow(t, h, tid, rid, "cancelled"); status != "cancelled" {
		t.Fatal(status)
	}
	f.set(nil, nil) // the rig would succeed now: nothing may follow it
	time.Sleep(100 * time.Millisecond)
	if got := f.paths(); len(got) != 2 {
		t.Fatal("sent after the cancel", got)
	}
	deadline = time.Now().Add(5 * time.Second)
	for chargedCredits(t, h, tid, rid) != 120+75 {
		if time.Now().After(deadline) {
			t.Fatal("charged", chargedCredits(t, h, tid, rid))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A restart resumes a chain where it stopped: steps Tripo accepted are followed, not sent again, and a step whose
// answer was lost with the process is never sent again either; the chain fails there and is charged what Tripo got.
func TestPostgresTripoMotionResumesAfterRestart(t *testing.T) {
	h, _ := newMediaHarness(t)
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "tripo-motion-resume@example.test")
	execSQL(t, h, `UPDATE tenants SET route_limits='{"media":1}'::jsonb WHERE id=$1`, tid)
	now := time.Now()
	givePlan(t, h, "tripo-motion-resume@example.test", "max", "active", now.Add(-time.Hour), now.Add(30*24*time.Hour), 10000)
	_, canvas := mediaCanvas(t, h, c, tid,
		motionNode("full", "tripo.v3-1", map[string]any{"rig": "biped", "motion": "full"}),
		motionNode("combat", "tripo.v3-1", map[string]any{"rig": "biped", "motion": "combat"}),
		motionNode("late", "tripo.v3-1", map[string]any{"rig": "biped", "motion": "combat"}))
	hold := map[string]bool{"rt_1": true, "rig_2": true, "rig_3": true}
	var holdMu sync.Mutex
	f.set(func(id string) (string, int) {
		holdMu.Lock()
		defer holdMu.Unlock()
		if hold[id] {
			return "running", 0
		}
		return "", 0
	}, nil)
	full := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a knight in armour", 202)["id"].(string)
	waitTasks := func(rid string, n int) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			var tasks int
			if e := h.db.QueryRow(t.Context(), "SELECT jsonb_array_length(COALESCE(media_task->'motionTasks','[]'::jsonb)) FROM runs WHERE id=$1", rid).Scan(&tasks); e != nil {
				t.Fatal(e)
			}
			if tasks == n {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("motion tasks recorded", tasks)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	waitTasks(full, 2) // the rig and the first retarget task
	combat := h.mediaRun(t, c, tid, setupNodeAt(canvas, 1)["issueId"].(string), "a knight in armour", 202)["id"].(string)
	waitTasks(combat, 1) // its rig
	late := h.mediaRun(t, c, tid, setupNodeAt(canvas, 2)["issueId"].(string), "a knight in armour", 202)["id"].(string)
	waitTasks(late, 1) // its rig
	h.a.Close()
	for _, rid := range []string{full, combat, late} {
		var status string
		if e := h.db.QueryRow(t.Context(), "SELECT status FROM runs WHERE id=$1", rid).Scan(&status); e != nil || status != "running" {
			t.Fatal("a shutdown settled a chain it can resume", status, e)
		}
	}
	// The full set's second retarget task was being sent when the process died: its answer is lost. The last chain's
	// time ran out while the API was down.
	execSQL(t, h, `UPDATE runs SET media_task=media_task||'{"motionSent":3}'::jsonb WHERE id=$1`, full)
	execSQL(t, h, `UPDATE runs SET media_task=media_task||'{"submittedAt":"2020-01-01T00:00:00Z"}'::jsonb WHERE id=$1`, late)
	sentBefore := len(f.sent())
	holdMu.Lock()
	hold = map[string]bool{}
	holdMu.Unlock()
	next := New(h.db, h.a.cfg)
	f.configure(next)
	if e := next.Start(t.Context()); e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	if status, code := awaitRunRow(t, h, tid, combat, "completed", "failed"); status != "completed" {
		t.Fatal("the resumed combat chain", status, code)
	}
	if status, code := awaitRunRow(t, h, tid, full, "completed", "failed"); status != "failed" || code != "media_motion_failed" {
		t.Fatal("a chain whose answer was lost", status, code)
	}
	// After the restart only the combat chain's retarget task was sent: neither rig, nor any step of the full set.
	if got := f.sent()[sentBefore:]; len(got) != 1 || got[0].path != "/animations/retarget" || got[0].body["input"] != "rig_2" {
		t.Fatal("sent after the restart", got)
	}
	var output string
	if e := h.db.QueryRow(t.Context(), "SELECT output FROM runs WHERE id=$1", combat).Scan(&output); e != nil {
		t.Fatal(e)
	}
	if items := runItems(t, map[string]any{"output": output}); len(items) != 2 || items[0].Name != "model-1.glb" || len(items[0].Animations) != 5 {
		t.Fatal("resumed items", items)
	}
	// The full set paid for its model, its rig and its first retarget task; the combat chain for everything.
	if got := chargedCredits(t, h, tid, full); got != 60+75+150 {
		t.Fatal("full set charged", got)
	}
	if got := chargedCredits(t, h, tid, combat); got != 60+75+150 {
		t.Fatal("combat charged", got)
	}
	// The expired chain pays for its model and the rig Tripo accepted, not for the retarget task it never sent.
	if status, code := awaitRunRow(t, h, tid, late, "completed", "failed"); status != "failed" || code != "media_timeout" {
		t.Fatal("an expired chain", status, code)
	}
	if got := chargedCredits(t, h, tid, late); got != 60+75 {
		t.Fatal("expired chain charged", got)
	}
}

// A canvas run hands an animated model to its page: the page's input names each GLB's clips and the clips-only files.
func TestPostgresGraphRunPageTakesAnAnimatedTripoModel(t *testing.T) {
	var mu sync.Mutex
	prompts := []string{}
	pi := runtimeProvider(t, runtimePI, func(w http.ResponseWriter, r *http.Request, call runtimeCall) {
		mu.Lock()
		prompts = append(prompts, call.Prompt)
		mu.Unlock()
		completePi(w, `{"result":"PAGE"}`)
	})
	t.Cleanup(pi.Close)
	h := newHarness(t, pi.URL)
	newFakeRunningHub(t).configure(h.a)
	h.a.cfg.MediaMinFreeBytes = 0
	f := newFakeTripo(t, h)
	c, tid, _ := h.register(t, "media-animated@example.test")
	// Rigging needs a paid plan or the operator's own workspace (admitMediaGeneration); this one is the operator's.
	execSQL(t, h, "UPDATE users SET platform_role='admin' WHERE email=$1", "media-animated@example.test")
	base := "/tenants/" + tid
	aid := h.request(t, c, "POST", base+"/agents", map[string]any{"name": "Page", "adapterType": "pi", "model": "test-model", "instructions": "PAGE"}, 201)["id"].(string)
	page := map[string]any{"id": "page", "kind": "session", "title": "Page", "runtime": "pi", "agentKind": "llm",
		"binding": map[string]string{"companyId": tid, "agentId": aid},
		"contract": map[string]any{"version": 1, "inputs": []any{map[string]any{"id": "model", "label": "Model", "type": "markdown", "required": true}},
			"outputs": []any{map[string]any{"id": "result", "label": "Result", "type": "markdown", "required": true}}}}
	hero := motionNode("hero", "tripo.p1", map[string]any{"rig": "biped", "motion": "full"})
	doc := map[string]any{"nodes": []any{hero, page},
		"edges": []any{map[string]any{"id": "m-p", "fromNode": "hero", "fromPort": "result", "toNode": "page", "toPort": "in:model", "dataType": "file"}}}
	cid := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Animated page", "document": doc}, 201)["id"].(string)
	canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
	awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "completed", 20*time.Second)
	mu.Lock()
	defer mu.Unlock()
	if len(prompts) != 1 {
		t.Fatal("pages made", len(prompts))
	}
	for _, line := range []string{"- hero/model-1.glb（model/gltf-binary，", "字节；动画：hurt idle run slash walk）",
		"- hero/model-2.glb（model/gltf-binary，", "字节；只有动画，没有模型，骨骼与 hero/model-1.glb 相同；动画：climb dive fall jump turn）",
		"字节；只有动画，没有模型，骨骼与 hero/model-1.glb 相同；动画：shoot）", "- hero/preview-4.png（image/png，",
		"带动画的 GLB 用 THREE.AnimationMixer 按上面的动画名播放它的动画（gltf.animations）。"} {
		if !strings.Contains(prompts[0], line) {
			t.Fatalf("the page's input lacks %q:\n%s", line, prompts[0])
		}
	}
	if got := f.paths(); len(got) != 5 {
		t.Fatal("canvas run tasks", got)
	}
}
