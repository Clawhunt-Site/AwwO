package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"slices"
	"strconv"

	"golang.org/x/image/draw"
)

// Web textures for 3D models. A game page loads dozens of models, and the live preview embeds at most 24 MiB of the
// files a page names (apps/web/src/canvas/studio/liveDocument.ts); a generated model's textures are most of its bytes
// (a low-poly character at 6,000 faces: 4.1 MB, nearly all of it three 2048-pixel maps). A 3D node's textureSize
// setting (original by default) resizes every JPEG or PNG texture of its stored GLBs whose longer side exceeds that size
// to fit it, in the same format; the geometry, skins and clips are kept byte for byte, only moved. A file that cannot be
// read or rebuilt safely, or would not get smaller, is kept as it came.

const (
	// A GLB larger than this is not rebuilt in memory.
	maxGLBRebuildBytes = 160 << 20
	// A texture with more pixels than this is not decoded (a decompression bomb would be).
	maxTexturePixels   = 8192 * 8192
	glbChunkBIN        = 0x004E4942 // "BIN\0", little-endian
	textureJPEGQuality = 88
)

var tripoTextureSizes = []string{"original", "2048", "1024", "512"}

// tripoTextureParam is the 3D models' texture size: it drives what is stored, never the model request.
func tripoTextureParam() mediaParam {
	return mediaParam{Name: "textureSize", Type: "enum", Values: slices.Clone(tripoTextureSizes), Default: "original",
		Label:       [2]string{"贴图尺寸", "Texture size"},
		ValueLabels: [][2]string{{"原始", "Original"}, {"2048 像素", "2048 px"}, {"1024 像素（网页）", "1024 px (web)"}, {"512 像素", "512 px"}}}
}

// textureMaxOf reads a frozen plan's textureSize: the longest side a stored texture may keep, 0 for as it came.
func textureMaxOf(params map[string]any) int {
	v, _ := params["textureSize"].(string)
	if v == "original" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || !slices.Contains(tripoTextureSizes, v) {
		return 0
	}
	return n
}

// webTexturesGLB rewrites a fetched GLB with its large textures resized to fit maxSide (resizeGLBTextures). The copy's
// space is held while it is written; one that cannot be made leaves the file as it came.
func (a *App) webTexturesGLB(f *fetchedMedia, tmp string, maxSide int) {
	if maxSide <= 0 || f.size <= 0 || f.size > maxGLBRebuildBytes {
		return
	}
	raw, err := os.ReadFile(f.path)
	if err != nil || int64(len(raw)) != f.size {
		return
	}
	rebuilt, ok := resizeGLBTextures(raw, maxSide)
	if !ok || len(rebuilt) >= len(raw) {
		return
	}
	release, ok := a.reserveMediaSpace(int64(len(rebuilt)))
	if !ok {
		return
	}
	defer release()
	out, err := os.CreateTemp(tmp, "download-*")
	if err != nil {
		return
	}
	if _, err = out.Write(rebuilt); err != nil || out.Close() != nil {
		_ = out.Close()
		_ = os.Remove(out.Name())
		return
	}
	if os.Remove(f.path) != nil {
		// The original stays where it is, and is kept as it came; the copy goes.
		_ = os.Remove(out.Name())
		return
	}
	sum := sha256.Sum256(rebuilt)
	f.path, f.size, f.sum = out.Name(), int64(len(rebuilt)), hex.EncodeToString(sum[:])
}

// resizeGLBTextures returns a binary glTF 2.0 file with each JPEG or PNG image larger than maxSide resized to fit it,
// and ok, or ok false when nothing was resized or the file is not one this can rebuild safely: exactly a JSON and a BIN
// chunk, one buffer (the BIN chunk's), buffer views that lie inside it without overlapping. Every buffer view keeps its
// bytes (an image's are replaced) and is placed in its old order at a 4-byte boundary; the JSON is written again with
// only the views' offsets and lengths and the buffer's length changed.
func resizeGLBTextures(raw []byte, maxSide int) ([]byte, bool) {
	if maxSide <= 0 || len(raw) < glbHeaderBytes+8 || string(raw[0:4]) != "glTF" || binary.LittleEndian.Uint32(raw[4:8]) != 2 ||
		int64(binary.LittleEndian.Uint32(raw[8:12])) != int64(len(raw)) || binary.LittleEndian.Uint32(raw[16:20]) != glbChunkJSON {
		return nil, false
	}
	jsonLen := int64(binary.LittleEndian.Uint32(raw[12:16]))
	binHead := int64(glbHeaderBytes) + jsonLen
	if jsonLen == 0 || jsonLen%4 != 0 || jsonLen > maxGLBJSONBytes || binHead+8 > int64(len(raw)) {
		return nil, false
	}
	binLen := int64(binary.LittleEndian.Uint32(raw[binHead : binHead+4]))
	if binary.LittleEndian.Uint32(raw[binHead+4:binHead+8]) != glbChunkBIN || binHead+8+binLen != int64(len(raw)) {
		return nil, false
	}
	bin := raw[binHead+8:]
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimRight(raw[glbHeaderBytes:binHead], " \t\r\n\x00")))
	dec.UseNumber()
	var doc map[string]any
	if dec.Decode(&doc) != nil || dec.More() {
		return nil, false
	}
	buffers, _ := doc["buffers"].([]any)
	buffer, _ := firstObject(buffers)
	if len(buffers) != 1 || buffer == nil || buffer["uri"] != nil {
		return nil, false
	}
	views, _ := doc["bufferViews"].([]any)
	type region struct {
		offset, length int64
		view           map[string]any
	}
	regions := make([]region, len(views))
	for i, v := range views {
		view, _ := v.(map[string]any)
		if view == nil {
			return nil, false
		}
		buf, okBuf := jsonInt(view["buffer"], 0)
		offset, okOffset := jsonInt(view["byteOffset"], 0)
		length, okLength := jsonInt(view["byteLength"], -1)
		if !okBuf || !okOffset || !okLength || buf != 0 || offset < 0 || length <= 0 || offset+length > int64(len(bin)) {
			return nil, false
		}
		regions[i] = region{offset, length, view}
	}
	order := make([]int, len(regions))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(x, y int) int {
		switch {
		case regions[x].offset < regions[y].offset:
			return -1
		case regions[x].offset > regions[y].offset:
			return 1
		}
		return 0
	})
	for k := 1; k < len(order); k++ {
		if regions[order[k]].offset < regions[order[k-1]].offset+regions[order[k-1]].length {
			return nil, false
		}
	}
	replaced := map[int][]byte{}
	images, _ := doc["images"].([]any)
	for _, item := range images {
		img, _ := item.(map[string]any)
		if img == nil {
			continue
		}
		vi, ok := jsonInt(img["bufferView"], -1)
		if !ok || vi < 0 || vi >= int64(len(regions)) {
			continue
		}
		if _, done := replaced[int(vi)]; done {
			continue
		}
		mime, _ := img["mimeType"].(string)
		r := regions[vi]
		if out, ok := resizeTexture(bin[r.offset:r.offset+r.length], mime, maxSide); ok {
			replaced[int(vi)] = out
		}
	}
	if len(replaced) == 0 {
		return nil, false
	}
	var packed bytes.Buffer
	for _, i := range order {
		for packed.Len()%4 != 0 {
			packed.WriteByte(0)
		}
		r := regions[i]
		data := bin[r.offset : r.offset+r.length]
		if out, ok := replaced[i]; ok {
			data = out
		}
		r.view["byteOffset"] = packed.Len()
		r.view["byteLength"] = len(data)
		packed.Write(data)
	}
	buffer["byteLength"] = packed.Len()
	for packed.Len()%4 != 0 {
		packed.WriteByte(0)
	}
	js, err := json.Marshal(doc)
	if err != nil {
		return nil, false
	}
	for len(js)%4 != 0 {
		js = append(js, ' ')
	}
	total := int64(glbHeaderBytes) + int64(len(js)) + 8 + int64(packed.Len())
	if total > math.MaxUint32 {
		return nil, false
	}
	out := make([]byte, 0, total)
	out = append(out, "glTF"...)
	out = binary.LittleEndian.AppendUint32(out, 2)
	out = binary.LittleEndian.AppendUint32(out, uint32(total))
	out = binary.LittleEndian.AppendUint32(out, uint32(len(js)))
	out = binary.LittleEndian.AppendUint32(out, glbChunkJSON)
	out = append(out, js...)
	out = binary.LittleEndian.AppendUint32(out, uint32(packed.Len()))
	out = binary.LittleEndian.AppendUint32(out, glbChunkBIN)
	out = append(out, packed.Bytes()...)
	return out, true
}

// resizeTexture returns a JPEG or PNG texture resized to fit maxSide on its longer side, in the same format, and ok;
// ok is false for another format, a texture already small enough, one too large to decode, or a result not smaller.
func resizeTexture(data []byte, mime string, maxSide int) ([]byte, bool) {
	if mime != "image/jpeg" && mime != "image/png" {
		return nil, false
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png") || "image/"+format != mime ||
		cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxTexturePixels ||
		(cfg.Width <= maxSide && cfg.Height <= maxSide) {
		return nil, false
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, false
	}
	scale := float64(maxSide) / float64(max(cfg.Width, cfg.Height))
	w, h := max(1, int(math.Round(float64(cfg.Width)*scale))), max(1, int(math.Round(float64(cfg.Height)*scale)))
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	var out bytes.Buffer
	if format == "jpeg" {
		err = jpeg.Encode(&out, dst, &jpeg.Options{Quality: textureJPEGQuality})
	} else {
		err = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&out, dst)
	}
	if err != nil || out.Len() >= len(data) {
		return nil, false
	}
	return out.Bytes(), true
}

// firstObject is the first element of a JSON array when it is an object.
func firstObject(items []any) (map[string]any, bool) {
	if len(items) == 0 {
		return nil, false
	}
	m, ok := items[0].(map[string]any)
	return m, ok
}

// jsonInt reads a whole number decoded with UseNumber; an absent value is fallback, anything else not a whole number is
// refused.
func jsonInt(v any, fallback int64) (int64, bool) {
	if v == nil {
		return fallback, true
	}
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := strconv.ParseInt(string(n), 10, 64)
	return i, err == nil
}
