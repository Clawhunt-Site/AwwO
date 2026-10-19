package app

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
)

// Voice lengths (M-1c): RunningHub's multimodal video reads voices of 2 to 15 seconds each and 15 seconds in all
// (runningHubAudioField's model). A voice's length is read from its own bytes when its generation is admitted
// (freezeMediaReferences), so one RunningHub would refuse is refused there, before anything is counted or paid for.
const (
	minVoiceSeconds  = 2.0
	maxVoiceSeconds  = 15.0
	maxVoicesSeconds = 15.0
	// voiceLengthMargin is how far past RunningHub's shortest voice a reading must be: an MP3's frame count includes its
	// encoder's delay and padding (about 50 ms), so a reading runs a little long. (Past the longest, a long reading
	// only refuses what RunningHub might have taken.)
	voiceLengthMargin = 0.1
	// voiceHeadBytes is how much of an MP3 after its ID3 tag is searched for its first two frames.
	voiceHeadBytes = 64 << 10
	// maxWAVChunks bounds the chunks read before a WAV's data chunk.
	maxWAVChunks = 64
)

// voiceSeconds is the length of the MP3 or WAV file at path, read from its headers; ok is false for one it cannot
// read, which a voice is then refused for.
func voiceSeconds(path, contentType string) (float64, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() <= 0 {
		return 0, false
	}
	switch contentType {
	case "audio/mpeg":
		return mp3Seconds(f, info.Size())
	case "audio/wav", "audio/x-wav":
		return wavSeconds(f, info.Size())
	}
	return 0, false
}

// mp3Bitrates are MPEG audio Layer III's bit rates in kb/s by index: MPEG-1's, then MPEG-2's and 2.5's.
var mp3Bitrates = [2][16]int{
	{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0},
	{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0},
}

// mp3SampleRates are the sample rates by a header's version bits (3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5) and rate index.
var mp3SampleRates = map[byte][3]int{3: {44100, 48000, 32000}, 2: {22050, 24000, 16000}, 0: {11025, 12000, 8000}}

// mp3Frame is what one Layer III frame header says.
type mp3Frame struct {
	version byte
	rate    int // samples a second
	kbps    int
	samples int // samples a frame
	length  int // bytes, the header included
	mono    bool
	crc     bool // a 16-bit CRC follows the header (its protection bit is 0)
}

// parseMP3Frame reads the Layer III frame header at the start of h.
func parseMP3Frame(h []byte) (mp3Frame, bool) {
	if len(h) < 4 || h[0] != 0xFF || h[1]&0xE0 != 0xE0 {
		return mp3Frame{}, false
	}
	version, layer, bitrate, rate := (h[1]>>3)&3, (h[1]>>1)&3, h[2]>>4, (h[2]>>2)&3
	rates, known := mp3SampleRates[version]
	if !known || layer != 1 || bitrate == 0 || bitrate == 15 || rate == 3 {
		return mp3Frame{}, false
	}
	f := mp3Frame{version: version, rate: rates[rate], mono: h[3]>>6 == 3, crc: h[1]&1 == 0}
	padding := int(h[2]>>1) & 1
	if version == 3 {
		f.kbps, f.samples = mp3Bitrates[0][bitrate], 1152
		f.length = 144*f.kbps*1000/f.rate + padding
	} else {
		f.kbps, f.samples = mp3Bitrates[1][bitrate], 576
		f.length = 72*f.kbps*1000/f.rate + padding
	}
	return f, true
}

// mp3Seconds is an MP3's length: the frame count its Xing/Info or VBRI header gives, or else (a constant bit rate) its
// bytes from its first frame to its end (less an ID3v1 tag there) over that frame's bit rate. A frame counts only when
// the next one follows it, so a stray sync pattern in a tag or in noise is not read as audio.
func mp3Seconds(r io.ReaderAt, size int64) (float64, bool) {
	head := make([]byte, 10)
	if _, err := r.ReadAt(head, 0); err != nil {
		return 0, false
	}
	var start int64
	if bytes.HasPrefix(head, []byte("ID3")) {
		start = 10 + (int64(head[6]&0x7F)<<21 | int64(head[7]&0x7F)<<14 | int64(head[8]&0x7F)<<7 | int64(head[9]&0x7F))
		if head[5]&0x10 != 0 {
			start += 10
		}
	}
	if start >= size {
		return 0, false
	}
	buf := make([]byte, min(int64(voiceHeadBytes), size-start))
	n, err := r.ReadAt(buf, start)
	if err != nil && err != io.EOF {
		return 0, false
	}
	buf = buf[:n]
	for i := 0; i+4 <= len(buf); i++ {
		f, ok := parseMP3Frame(buf[i:])
		if !ok || i+f.length+4 > len(buf) {
			continue
		}
		if g, ok := parseMP3Frame(buf[i+f.length:]); !ok || g.version != f.version || g.rate != f.rate {
			continue
		}
		if frames, ok := mp3FrameCount(buf[i:], f); ok {
			return float64(frames) * float64(f.samples) / float64(f.rate), true
		}
		end, tag := size, make([]byte, 3)
		if size-start-int64(i) > 128 {
			if _, err := r.ReadAt(tag, size-128); err == nil && string(tag) == "TAG" {
				end -= 128
			}
		}
		return float64(end-start-int64(i)) * 8 / float64(f.kbps*1000), true
	}
	return 0, false
}

// mp3FrameCount is the frame count a variable-bit-rate MP3's first frame carries: a Xing or Info header after the
// side information (and the CRC, when there is one), or a VBRI header 32 bytes after the frame header.
func mp3FrameCount(frame []byte, f mp3Frame) (uint32, bool) {
	side := 32
	switch {
	case f.version == 3 && f.mono, f.version != 3 && !f.mono:
		side = 17
	case f.version != 3 && f.mono:
		side = 9
	}
	if f.crc {
		side += 2
	}
	if at := 4 + side; len(frame) >= at+12 && (bytes.Equal(frame[at:at+4], []byte("Xing")) || bytes.Equal(frame[at:at+4], []byte("Info"))) {
		if binary.BigEndian.Uint32(frame[at+4:])&1 == 0 {
			return 0, false
		}
		return binary.BigEndian.Uint32(frame[at+8:]), true
	}
	if at := 4 + 32; len(frame) >= at+18 && bytes.Equal(frame[at:at+4], []byte("VBRI")) {
		return binary.BigEndian.Uint32(frame[at+14:]), true
	}
	return 0, false
}

// wavSeconds is a WAV's length: its data chunk's bytes over the byte rate its fmt chunk gives (a data chunk that claims
// more than the file holds, or none, as a streamed one may, counts what the file holds).
func wavSeconds(r io.ReaderAt, size int64) (float64, bool) {
	head := make([]byte, 12)
	if _, err := r.ReadAt(head, 0); err != nil || string(head[:4]) != "RIFF" || string(head[8:]) != "WAVE" {
		return 0, false
	}
	var byteRate uint32
	chunk := make([]byte, 8)
	at := int64(12)
	for i := 0; i < maxWAVChunks && at+8 <= size; i++ {
		if _, err := r.ReadAt(chunk, at); err != nil {
			return 0, false
		}
		id, n, body := string(chunk[:4]), int64(binary.LittleEndian.Uint32(chunk[4:])), at+8
		switch id {
		case "fmt ":
			format := make([]byte, 16)
			if n < 16 {
				return 0, false
			}
			if _, err := r.ReadAt(format, body); err != nil {
				return 0, false
			}
			byteRate = binary.LittleEndian.Uint32(format[8:12])
		case "data":
			if byteRate == 0 {
				return 0, false
			}
			if n == 0 || n > size-body {
				n = size - body
			}
			return float64(n) / float64(byteRate), true
		}
		at = body + n + n&1
	}
	return 0, false
}
