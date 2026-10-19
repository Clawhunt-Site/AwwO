package app

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// testVoice is an MP3 of about seconds: an ID3 tag, then constant-bit-rate MPEG-1 Layer III frames (128 kb/s, 44.1 kHz,
// joint stereo), 417 bytes and 1152 samples each, as a speech model's take is.
func testVoice(seconds float64) []byte {
	out := []byte("ID3\x04\x00\x00\x00\x00\x00\x00")
	frame := make([]byte, 417)
	copy(frame, []byte{0xFF, 0xFB, 0x90, 0x40})
	for i := 0; i < int(seconds*44100/1152+0.5); i++ {
		out = append(out, frame...)
	}
	return out
}

// testVoiceWAV is a 16-bit mono 16 kHz PCM WAV of seconds.
func testVoiceWAV(seconds float64) []byte {
	data := int(seconds*32000) &^ 1
	out := binary.LittleEndian.AppendUint32([]byte("RIFF"), uint32(36+data))
	out = binary.LittleEndian.AppendUint32(append(out, "WAVEfmt "...), 16)
	out = binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(out, 1), 1)
	out = binary.LittleEndian.AppendUint32(binary.LittleEndian.AppendUint32(out, 16000), 32000)
	out = binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(out, 2), 16)
	out = binary.LittleEndian.AppendUint32(append(out, "data"...), uint32(data))
	return append(out, make([]byte, data)...)
}

// A voice's length is read from its own headers (M-1c): a constant-bit-rate MP3 by its bytes over its bit rate, a
// variable one by the frame count its Xing/Info or VBRI header gives, a WAV by its data chunk over its byte rate.
// Anything else, or anything malformed, has no length, and a voice without one is refused.
func TestVoiceSecondsReadsMP3AndWAVHeaders(t *testing.T) {
	// testVoice's frames carry no padding, so its constant-bit-rate estimate runs 0.2% short of its samples.
	near := func(got, want float64) bool { return math.Abs(got-want) < 0.01*want+0.02 }
	dir := t.TempDir()
	length := func(data []byte, contentType string) (float64, bool) {
		path := filepath.Join(dir, "voice")
		if e := os.WriteFile(path, data, 0o600); e != nil {
			t.Fatal(e)
		}
		return voiceSeconds(path, contentType)
	}
	for _, seconds := range []float64{1.5, 3, 14.9, 16} {
		if got, ok := length(testVoice(seconds), "audio/mpeg"); !ok || !near(got, seconds) {
			t.Error("a constant-bit-rate MP3 of", seconds, "s read as", got, ok)
		}
		if got, ok := length(testVoiceWAV(seconds), "audio/wav"); !ok || !near(got, seconds) {
			t.Error("a WAV of", seconds, "s read as", got, ok)
		}
	}
	if got, ok := length(testVoiceWAV(3), "audio/x-wav"); !ok || !near(got, 3) {
		t.Error("audio/x-wav", got, ok)
	}
	// A large ID3 tag (cover art) is skipped by its own size, and a footer flag adds its ten bytes.
	tagged := append([]byte("ID3\x04\x00\x00\x00\x00\x01\x00"), make([]byte, 128)...) // a 128-byte tag: syncsafe 00 00 01 00
	tagged = append(tagged, testVoice(4)[10:]...)
	if got, ok := length(tagged, "audio/mpeg"); !ok || !near(got, 4) {
		t.Error("an MP3 behind a tag", got, ok)
	}
	footer := append([]byte("ID3\x04\x00\x10\x00\x00\x00\x00"), make([]byte, 10)...)
	if got, ok := length(append(footer, testVoice(4)[10:]...), "audio/mpeg"); !ok || !near(got, 4) {
		t.Error("an MP3 whose tag has a footer", got, ok)
	}
	// A variable-bit-rate MP3: its first frame's Xing (or Info) header counts 383 frames of 1152 samples at 44.1 kHz,
	// 10.006 s, whatever its bytes are; a VBRI header the same.
	vbr := testVoice(1)
	at := 10 + 4 + 32
	copy(vbr[at:], "Xing")
	binary.BigEndian.PutUint32(vbr[at+4:], 1)
	binary.BigEndian.PutUint32(vbr[at+8:], 383)
	if got, ok := length(vbr, "audio/mpeg"); !ok || !near(got, 383*1152/44100.0) {
		t.Error("a Xing header", got, ok)
	}
	copy(vbr[at:], "Info")
	if got, ok := length(vbr, "audio/mpeg"); !ok || !near(got, 383*1152/44100.0) {
		t.Error("an Info header", got, ok)
	}
	// A frame with a CRC (its protection bit 0) has its Xing header two bytes later.
	crc := testVoice(1)
	for at := 10; at < len(crc); at += 417 {
		crc[at+1] = 0xFA
	}
	copy(crc[10+4+2+32:], "Xing")
	binary.BigEndian.PutUint32(crc[10+4+2+32+4:], 1)
	binary.BigEndian.PutUint32(crc[10+4+2+32+8:], 383)
	if got, ok := length(crc, "audio/mpeg"); !ok || !near(got, 383*1152/44100.0) {
		t.Error("a Xing header after a CRC", got, ok)
	}
	vbri := testVoice(1)
	copy(vbri[10+4+32:], "VBRI")
	binary.BigEndian.PutUint32(vbri[10+4+32+14:], 200)
	if got, ok := length(vbri, "audio/mpeg"); !ok || !near(got, 200*1152/44100.0) {
		t.Error("a VBRI header", got, ok)
	}
	// MPEG-2 Layer III (24 kHz, 64 kb/s, mono): 576 samples a frame, 192 bytes.
	mpeg2 := []byte("ID3\x04\x00\x00\x00\x00\x00\x00")
	frame := make([]byte, 192)
	copy(frame, []byte{0xFF, 0xF3, 0x84, 0xC0})
	for i := 0; i < 125; i++ {
		mpeg2 = append(mpeg2, frame...)
	}
	if got, ok := length(mpeg2, "audio/mpeg"); !ok || !near(got, 125*192*8/64000.0) {
		t.Error("an MPEG-2 voice", got, ok)
	}
	// Nothing to read: noise behind a tag (one stray sync pattern is not a frame without the next one), a lone frame, a
	// Layer II stream, an empty file, a WAV with no fmt chunk or no data chunk, another type.
	noise := append([]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), bytes.Repeat([]byte{5}, 4096)...)
	noise[500], noise[501], noise[502], noise[503] = 0xFF, 0xFB, 0x90, 0x40
	layer2 := bytes.Repeat(append([]byte{0xFF, 0xFD, 0x90, 0x40}, make([]byte, 413)...), 200)
	noFmt := append([]byte("RIFF\x00\x00\x00\x00WAVEdata\x10\x00\x00\x00"), make([]byte, 16)...)
	noData := testVoiceWAV(3)[:36]
	for name, tc := range map[string]struct {
		data        []byte
		contentType string
	}{
		"noise behind a tag": {noise, "audio/mpeg"}, "the old test MP3": {testMP3, "audio/mpeg"}, "a lone frame": {testVoice(0.03), "audio/mpeg"},
		"a Layer II stream": {layer2, "audio/mpeg"}, "nothing": {nil, "audio/mpeg"}, "a tag only": {[]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), "audio/mpeg"},
		"no fmt chunk": {noFmt, "audio/wav"}, "no data chunk": {noData, "audio/wav"}, "an MP3 named a WAV": {testVoice(3), "audio/wav"},
		"another type": {testVoice(3), "audio/ogg"},
	} {
		if got, ok := length(tc.data, tc.contentType); ok {
			t.Error(name, "read as", got)
		}
	}
	// A WAV whose data chunk claims more than the file holds, or nothing (a streamed one), counts what the file holds,
	// and one with more than 64 chunks before its data has no length.
	for _, claimed := range []uint32{0xFFFFFFFF, 0} {
		streamed := testVoiceWAV(3)
		binary.LittleEndian.PutUint32(streamed[40:], claimed)
		if got, ok := length(streamed, "audio/wav"); !ok || !near(got, 3) {
			t.Error("a streamed WAV claiming", claimed, got, ok)
		}
	}
	// An ID3v1 tag at the end of a constant-bit-rate MP3 is not audio.
	plain, _ := length(testVoice(3), "audio/mpeg")
	if got, ok := length(append(testVoice(3), append([]byte("TAG"), make([]byte, 125)...)...), "audio/mpeg"); !ok || got != plain {
		t.Error("an MP3 ending in an ID3v1 tag", got, plain, ok)
	}
	chunky := append([]byte{}, testVoiceWAV(3)[:36]...)
	for i := 0; i < maxWAVChunks; i++ {
		chunky = append(chunky, "LIST\x00\x00\x00\x00"...)
	}
	chunky = append(chunky, testVoiceWAV(3)[36:]...)
	if got, ok := length(chunky, "audio/wav"); ok {
		t.Error("a WAV past the chunk bound", got)
	}
	if _, ok := voiceSeconds(filepath.Join(dir, "missing"), "audio/mpeg"); ok {
		t.Error("a missing file")
	}
}
