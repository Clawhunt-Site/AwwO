package app

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// textureGLB lays out a GLB whose BIN chunk holds a geometry view (gbytes), a JPEG of w x h and a 64 x 64 PNG, in that
// order, as its JSON names them; the views are not 4-byte aligned in length, as a writer may leave them.
func textureGLB(t *testing.T, gbytes []byte, w, h int) []byte {
	t.Helper()
	big := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			big.Set(x, y, color.NRGBA{uint8(x * 7), uint8(y * 3), uint8((x ^ y) * 5), 255})
		}
	}
	var jpg, small bytes.Buffer
	if jpeg.Encode(&jpg, big, &jpeg.Options{Quality: 95}) != nil || png.Encode(&small, image.NewNRGBA(image.Rect(0, 0, 64, 64))) != nil {
		t.Fatal("encode")
	}
	bin := slices.Concat(gbytes, jpg.Bytes(), small.Bytes())
	doc := map[string]any{
		"asset":   map[string]any{"generator": "AwwO", "version": "2.0"},
		"buffers": []any{map[string]any{"byteLength": len(bin)}},
		"bufferViews": []any{
			map[string]any{"buffer": 0, "byteOffset": 0, "byteLength": len(gbytes), "target": 34962},
			map[string]any{"buffer": 0, "byteOffset": len(gbytes), "byteLength": jpg.Len()},
			map[string]any{"buffer": 0, "byteOffset": len(gbytes) + jpg.Len(), "byteLength": small.Len()},
		},
		"accessors": []any{map[string]any{"bufferView": 0, "byteOffset": 0, "componentType": 5126, "count": len(gbytes) / 12, "type": "VEC3"}},
		"images":    []any{map[string]any{"bufferView": 1, "mimeType": "image/jpeg"}, map[string]any{"bufferView": 2, "mimeType": "image/png"}},
		"extras":    map[string]any{"kept": json.Number("1.25")},
	}
	js, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	for len(js)%4 != 0 {
		js = append(js, ' ')
	}
	for len(bin)%4 != 0 {
		bin = append(bin, 0)
	}
	out := []byte("glTF")
	out = binary.LittleEndian.AppendUint32(out, 2)
	out = binary.LittleEndian.AppendUint32(out, uint32(12+8+len(js)+8+len(bin)))
	out = binary.LittleEndian.AppendUint32(out, uint32(len(js)))
	out = binary.LittleEndian.AppendUint32(out, glbChunkJSON)
	out = append(out, js...)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(bin)))
	out = binary.LittleEndian.AppendUint32(out, glbChunkBIN)
	return append(out, bin...)
}

// readTestGLB splits a GLB into its JSON document and BIN chunk, checking the layout the specification requires.
func readTestGLB(t *testing.T, raw []byte) (map[string]any, []byte) {
	t.Helper()
	if string(raw[0:4]) != "glTF" || int(binary.LittleEndian.Uint32(raw[8:12])) != len(raw) {
		t.Fatal("header")
	}
	jl := int(binary.LittleEndian.Uint32(raw[12:16]))
	if jl%4 != 0 || binary.LittleEndian.Uint32(raw[16:20]) != glbChunkJSON {
		t.Fatal("json chunk")
	}
	bl := int(binary.LittleEndian.Uint32(raw[20+jl : 24+jl]))
	if bl%4 != 0 || binary.LittleEndian.Uint32(raw[24+jl:28+jl]) != glbChunkBIN || 28+jl+bl != len(raw) {
		t.Fatal("bin chunk")
	}
	dec := json.NewDecoder(bytes.NewReader(raw[20 : 20+jl]))
	dec.UseNumber()
	var doc map[string]any
	if dec.Decode(&doc) != nil {
		t.Fatal("json")
	}
	return doc, raw[28+jl:]
}

func viewBytes(t *testing.T, doc map[string]any, bin []byte, i int, aligned bool) []byte {
	t.Helper()
	v := doc["bufferViews"].([]any)[i].(map[string]any)
	off, _ := jsonInt(v["byteOffset"], 0)
	n, _ := jsonInt(v["byteLength"], -1)
	if (aligned && off%4 != 0) || off+n > int64(len(bin)) {
		t.Fatal("view placement", i, off, n)
	}
	return bin[off : off+n]
}

func TestResizeGLBTexturesKeepsEverythingButTheLargeTexture(t *testing.T) {
	geometry := bytes.Repeat([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}, 30)
	geometry = append(geometry, 9, 9) // a length that is not a multiple of four
	raw := textureGLB(t, geometry, 1600, 900)
	out, ok := resizeGLBTextures(raw, 512)
	if !ok || len(out) >= len(raw) {
		t.Fatal("not resized", ok, len(out), len(raw))
	}
	doc, bin := readTestGLB(t, out)
	if !bytes.Equal(viewBytes(t, doc, bin, 0, true), geometry) {
		t.Fatal("the geometry changed")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(viewBytes(t, doc, bin, 1, true)))
	if err != nil || format != "jpeg" || cfg.Width != 512 || cfg.Height != 288 {
		t.Fatal("the large texture", format, cfg, err)
	}
	_, origBin := readTestGLB(t, raw)
	origDoc, _ := readTestGLB(t, raw)
	if !bytes.Equal(viewBytes(t, doc, bin, 2, true), viewBytes(t, origDoc, origBin, 2, false)) {
		t.Fatal("a texture already small enough changed")
	}
	if n, _ := jsonInt(doc["buffers"].([]any)[0].(map[string]any)["byteLength"], 0); n > int64(len(bin)) {
		t.Fatal("buffer length", n, len(bin))
	}
	if doc["extras"].(map[string]any)["kept"] != json.Number("1.25") || doc["asset"].(map[string]any)["generator"] != "AwwO" {
		t.Fatal("the rest of the JSON changed", doc["extras"], doc["asset"])
	}
	// Small enough already, or no limit: nothing to do.
	if _, ok := resizeGLBTextures(raw, 2048); ok {
		t.Fatal("resized textures that fit")
	}
	if _, ok := resizeGLBTextures(raw, 0); ok {
		t.Fatal("resized without a limit")
	}
}

func TestResizeGLBTexturesRefusesWhatItCannotRebuildSafely(t *testing.T) {
	raw := textureGLB(t, bytes.Repeat([]byte{7}, 48), 1200, 1200)
	cases := map[string]func([]byte) []byte{
		"bad magic":    func(b []byte) []byte { b[0] = 'x'; return b },
		"wrong length": func(b []byte) []byte { binary.LittleEndian.PutUint32(b[8:12], uint32(len(b)+4)); return b },
		"trailing data": func(b []byte) []byte {
			b = append(b, 0, 0, 0, 0)
			binary.LittleEndian.PutUint32(b[8:12], uint32(len(b)))
			return b
		},
		"truncated": func(b []byte) []byte { return b[:len(b)/2] },
	}
	for name, mutate := range cases {
		if _, ok := resizeGLBTextures(mutate(slices.Clone(raw)), 256); ok {
			t.Fatal("rebuilt a GLB with", name)
		}
	}
	// Overlapping views, an external buffer or a view outside the buffer: kept as they came.
	edit := func(change func(doc map[string]any)) []byte {
		doc, bin := readTestGLB(t, raw)
		change(doc)
		js, _ := json.Marshal(doc)
		for len(js)%4 != 0 {
			js = append(js, ' ')
		}
		out := []byte("glTF")
		out = binary.LittleEndian.AppendUint32(out, 2)
		out = binary.LittleEndian.AppendUint32(out, uint32(28+len(js)+len(bin)))
		out = binary.LittleEndian.AppendUint32(out, uint32(len(js)))
		out = binary.LittleEndian.AppendUint32(out, glbChunkJSON)
		out = append(out, js...)
		out = binary.LittleEndian.AppendUint32(out, uint32(len(bin)))
		out = binary.LittleEndian.AppendUint32(out, glbChunkBIN)
		return append(out, bin...)
	}
	for name, change := range map[string]func(map[string]any){
		"overlap": func(doc map[string]any) { doc["bufferViews"].([]any)[1].(map[string]any)["byteOffset"] = 4 },
		"uri":     func(doc map[string]any) { doc["buffers"].([]any)[0].(map[string]any)["uri"] = "model.bin" },
		"outside": func(doc map[string]any) { doc["bufferViews"].([]any)[2].(map[string]any)["byteLength"] = 1 << 30 },
		"two bufs": func(doc map[string]any) {
			doc["buffers"] = append(doc["buffers"].([]any), map[string]any{"byteLength": 4})
		},
		// An offset near the int64 limit wraps around when added to the length: refused, never sliced.
		"offset overflow": func(doc map[string]any) {
			doc["bufferViews"].([]any)[2].(map[string]any)["byteOffset"] = json.Number("9223372036854775000")
		},
		"length overflow": func(doc map[string]any) {
			doc["bufferViews"].([]any)[2].(map[string]any)["byteLength"] = json.Number("9223372036854775000")
		},
		// A buffer view's extension may hold offsets into the buffer that a rebuild would not move.
		"view extension": func(doc map[string]any) {
			doc["bufferViews"].([]any)[0].(map[string]any)["extensions"] = map[string]any{
				"EXT_meshopt_compression": map[string]any{"buffer": 0, "byteOffset": 0, "byteLength": 12}}
		},
		"buffer extension": func(doc map[string]any) {
			doc["buffers"].([]any)[0].(map[string]any)["extensions"] = map[string]any{"EXT_meshopt_compression": map[string]any{"fallback": true}}
		},
	} {
		if _, ok := resizeGLBTextures(edit(change), 256); ok {
			t.Fatal("rebuilt a GLB with", name)
		}
	}
	if out, ok := resizeGLBTextures(edit(func(map[string]any) {}), 256); !ok || len(out) >= len(raw) {
		t.Fatal("the unchanged GLB was not rebuilt")
	}
}

func TestTextureSizeSetting(t *testing.T) {
	for v, want := range map[string]int{"original": 0, "2048": 2048, "1024": 1024, "512": 512, "4096": 0, "": 0, "1e3": 0} {
		if got := textureMaxOf(map[string]any{"textureSize": v}); got != want {
			t.Fatal(v, got)
		}
	}
	if textureMaxOf(map[string]any{}) != 0 || textureMaxOf(map[string]any{"textureSize": 1024}) != 0 {
		t.Fatal("a missing or non-string setting keeps the textures")
	}
	for _, m := range tripoModels() {
		found := false
		for i := range m.Params {
			if m.Params[i].Name == "textureSize" {
				found = true
				if known, exact := tripoChainParam(&m.Params[i]); !known || !exact {
					t.Fatal("textureSize is not a chain parameter of", m.ID)
				}
			}
		}
		if !found {
			t.Fatal("no textureSize on", m.ID)
		}
		if body := tripoRequest(m, "a knight", map[string]any{"textureSize": "1024"}); body["textureSize"] != nil || body["texture_size"] != nil {
			t.Fatal("textureSize reached the model request", body)
		}
	}
}

func TestWebTexturesGLBReplacesTheFetchedFile(t *testing.T) {
	dir := t.TempDir()
	raw := textureGLB(t, bytes.Repeat([]byte{3}, 36), 1400, 1400)
	path := filepath.Join(dir, "download-1")
	if os.WriteFile(path, raw, 0o600) != nil {
		t.Fatal("write")
	}
	a := &App{cfg: Config{MediaDir: dir}}
	f := fetchedMedia{path: path, size: int64(len(raw)), sum: "old"}
	a.webTexturesGLB(&f, dir, 1024)
	if f.path == path || f.size >= int64(len(raw)) || f.sum == "old" {
		t.Fatal("not replaced", f)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the original is left behind")
	}
	if data, err := os.ReadFile(f.path); err != nil || int64(len(data)) != f.size {
		t.Fatal("the new file", err)
	}
}
