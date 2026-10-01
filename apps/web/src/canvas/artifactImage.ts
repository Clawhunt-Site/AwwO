/** Recognize raster bytes, not a response MIME label or an executable SVG document. */
export function artifactImageType(name: string, bytes: Uint8Array): string | null {
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  const u16 = (offset: number) => bytes[offset] * 256 + bytes[offset + 1];
  const little16 = (offset: number) => bytes[offset] + bytes[offset + 1] * 256;
  const little24 = (offset: number) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
  let mime = ''; let width = 0; let height = 0;
  if (/\.png$/i.test(name) && bytes.length >= 24 && text(1, 3) === 'PNG'
    && bytes[0] === 137 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 && text(12, 4) === 'IHDR') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
  } else if (/\.gif$/i.test(name) && bytes.length >= 10 && /^GIF8[79]a$/.test(text(0, 6))) {
    width = little16(6); height = little16(8); mime = 'image/gif';
  } else if (/\.webp$/i.test(name) && bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const format = text(12, 4);
    if (format === 'VP8X') { width = little24(24) + 1; height = little24(27) + 1; }
    else if (format === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = little16(26) & 0x3fff; height = little16(28) & 0x3fff;
    } else if (format === 'VP8L' && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    }
    mime = 'image/webp';
  } else if (/\.jpe?g$/i.test(name) && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = u16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = u16(offset + 3); width = u16(offset + 5); mime = 'image/jpeg'; break;
      }
      offset += length;
    }
  }
  // Bound both compressed bytes (the caller) and declared raster size before browser decoding.
  return mime && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000 ? mime : null;
}
