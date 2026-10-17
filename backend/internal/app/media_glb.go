package app

import (
	"bytes"
	"cmp"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"slices"
)

// A generated GLB names the service that made it in its JSON chunk (asset.generator), which users never see anywhere
// else (audit D19, docs/commercial-cases-audit-20261014.md). When a 3D node's model is stored, the generator becomes
// "AwwO" and nothing else changes: the rest of the JSON chunk keeps its bytes, and the binary chunk (geometry, textures,
// skins and clips) is copied byte for byte. The JSON chunk is also read for what the result says of the file: the
// names of its animation clips and whether it has a mesh. A file whose JSON chunk cannot be read, or rewritten safely,
// is stored as it came, and then says nothing of its clips.

const (
	glbHeaderBytes = 20
	glbChunkJSON   = 0x4E4F534A // "JSON", little-endian
	// A JSON chunk larger than this is not read: a rigged model's with its clips is tens of kilobytes.
	maxGLBJSONBytes = 16 << 20
	// At most this many clip names are kept for one file; Tripo puts at most five in one.
	maxGLBClips = 32
)

// A clip name is listed only as short plain text: it reaches downstream prompts and pages, so no spaces (the list is
// space separated), quotes, markup or control characters.
var glbClipName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,63}$`)

// glbFacts is what a GLB's JSON chunk says of it.
type glbFacts struct {
	animations []string
	// clipsOnly: the file has animation clips and no mesh, a set of clips for a skeleton another file carries.
	clipsOnly bool
}

// readGLBJSON reads the JSON chunk of a binary glTF 2.0 file of size bytes, with ok only for a file laid out as the
// specification says: its header's length is the file's, its first chunk is JSON, aligned to four bytes and inside the
// file.
func readGLBJSON(r io.ReaderAt, size int64) (js []byte, ok bool) {
	head := make([]byte, glbHeaderBytes)
	if size < glbHeaderBytes || size > 1<<32-1 {
		return nil, false
	}
	if _, err := r.ReadAt(head, 0); err != nil {
		return nil, false
	}
	n := int64(binary.LittleEndian.Uint32(head[12:16]))
	if !bytes.Equal(head[0:4], []byte("glTF")) || binary.LittleEndian.Uint32(head[4:8]) != 2 || int64(binary.LittleEndian.Uint32(head[8:12])) != size ||
		binary.LittleEndian.Uint32(head[16:20]) != glbChunkJSON || n == 0 || n%4 != 0 || n > maxGLBJSONBytes || glbHeaderBytes+n > size {
		return nil, false
	}
	js = make([]byte, n)
	if _, err := r.ReadAt(js, glbHeaderBytes); err != nil {
		return nil, false
	}
	return js, true
}

// glbFactsFromJSON reads a JSON chunk's facts and, where its asset names a generator other than AwwO, the chunk with
// that name replaced and padded to four bytes with spaces again (edited; nil when nothing needs replacing). ok is false
// for a chunk that is not a JSON object shaped as glTF's top level.
func glbFactsFromJSON(js []byte) (facts glbFacts, edited []byte, ok bool) {
	// Padding is spaces; a writer that padded with zeros is read too, and its chunk is padded with spaces when edited.
	content := bytes.TrimRight(js, " \t\r\n\x00")
	if len(content) == 0 || content[0] != '{' || !json.Valid(content) {
		return glbFacts{}, nil, false
	}
	var doc struct {
		Animations []struct {
			Name json.RawMessage `json:"name"`
		} `json:"animations"`
		Meshes []json.RawMessage `json:"meshes"`
	}
	if json.Unmarshal(content, &doc) != nil {
		return glbFacts{}, nil, false
	}
	for _, clip := range doc.Animations {
		var name string
		if json.Unmarshal(clip.Name, &name) == nil && glbClipName.MatchString(name) && !slices.Contains(facts.animations, name) && len(facts.animations) < maxGLBClips {
			facts.animations = append(facts.animations, name)
		}
	}
	facts.clipsOnly = len(doc.Animations) > 0 && len(doc.Meshes) == 0
	spans, ok := glbGeneratorSpans(content)
	if !ok {
		return glbFacts{}, nil, false
	}
	if len(spans) == 0 {
		return facts, nil, true
	}
	edited = slices.Clone(content)
	for i := len(spans) - 1; i >= 0; i-- {
		edited = slices.Concat(edited[:spans[i][0]], []byte(`"AwwO"`), edited[spans[i][1]:])
	}
	if !json.Valid(edited) {
		return glbFacts{}, nil, false
	}
	for len(edited)%4 != 0 {
		edited = append(edited, ' ')
	}
	return facts, edited, true
}

// glbGeneratorSpans finds the byte ranges of every top-level asset object's string generator that is not "AwwO" in a
// JSON object, by its decoded keys (an escaped key is found too). ok is false when the object cannot be walked.
func glbGeneratorSpans(content []byte) (spans [][2]int64, ok bool) {
	members := func(object []byte, base int64, each func(key string, value json.RawMessage, start int64) bool) bool {
		dec := json.NewDecoder(bytes.NewReader(object))
		if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
			return false
		}
		for dec.More() {
			tok, err := dec.Token()
			key, isKey := tok.(string)
			if err != nil || !isKey {
				return false
			}
			var value json.RawMessage
			if dec.Decode(&value) != nil {
				return false
			}
			end := dec.InputOffset()
			if !each(key, value, base+end-int64(len(value))) {
				return false
			}
		}
		return true
	}
	walked := members(content, 0, func(key string, value json.RawMessage, start int64) bool {
		if key != "asset" || len(value) == 0 || value[0] != '{' {
			return true
		}
		return members(value, start, func(key string, value json.RawMessage, start int64) bool {
			var name string
			if key == "generator" && len(value) > 0 && value[0] == '"' && json.Unmarshal(value, &name) == nil && name != "AwwO" {
				spans = append(spans, [2]int64{start, start + int64(len(value))})
			}
			return true
		})
	})
	if !walked {
		return nil, false
	}
	// Spans are found in order, one inside each asset object; a later key cannot reach back into an earlier span.
	slices.SortFunc(spans, func(x, y [2]int64) int { return cmp.Compare(x[0], y[0]) })
	for i := range spans {
		if !bytes.Equal(content[spans[i][0]:spans[i][0]+1], []byte(`"`)) || (i > 0 && spans[i][0] < spans[i-1][1]) {
			return nil, false
		}
	}
	return spans, true
}

// neutralizeGLB reads a fetched GLB's facts into f and, where its JSON chunk names a generator, writes the file again
// with that name replaced: a new header and JSON chunk, then the rest of the file (the binary chunk and any other)
// copied byte for byte. The copy's space is held while it is written; a copy that cannot be made leaves the file as it
// came.
func (a *App) neutralizeGLB(f *fetchedMedia, tmp string) {
	src, err := os.Open(f.path)
	if err != nil {
		return
	}
	// Closed before the original is removed (Windows removes no open file), and on every other way out.
	closed := false
	defer func() {
		if !closed {
			_ = src.Close()
		}
	}()
	js, ok := readGLBJSON(src, f.size)
	if !ok {
		return
	}
	facts, edited, ok := glbFactsFromJSON(js)
	if !ok {
		return
	}
	f.animations, f.clipsOnly = facts.animations, facts.clipsOnly
	if edited == nil {
		return
	}
	rest := f.size - glbHeaderBytes - int64(len(js))
	total := glbHeaderBytes + int64(len(edited)) + rest
	if total > 1<<32-1 {
		return
	}
	release, ok := a.reserveMediaSpace(total)
	if !ok {
		return
	}
	defer release()
	out, err := os.CreateTemp(tmp, "download-*")
	if err != nil {
		return
	}
	done := false
	defer func() {
		if !done {
			_ = out.Close()
			_ = os.Remove(out.Name())
		}
	}()
	head := make([]byte, glbHeaderBytes)
	copy(head[0:4], "glTF")
	binary.LittleEndian.PutUint32(head[4:8], 2)
	binary.LittleEndian.PutUint32(head[8:12], uint32(total))
	binary.LittleEndian.PutUint32(head[12:16], uint32(len(edited)))
	binary.LittleEndian.PutUint32(head[16:20], glbChunkJSON)
	hash := sha256.New()
	w := io.MultiWriter(out, hash)
	if _, err = w.Write(head); err != nil {
		return
	}
	if _, err = w.Write(edited); err != nil {
		return
	}
	if n, err := io.Copy(w, io.NewSectionReader(src, glbHeaderBytes+int64(len(js)), rest)); err != nil || n != rest {
		return
	}
	done = true
	if out.Close() != nil {
		_ = os.Remove(out.Name())
		return
	}
	closed = true
	if src.Close() != nil || os.Remove(f.path) != nil {
		// The original stays where it is, and is kept as it came; the copy goes.
		_ = os.Remove(out.Name())
		return
	}
	f.path, f.size, f.sum = out.Name(), total, hex.EncodeToString(hash.Sum(nil))
}
