import { describe, expect, it } from 'vitest';

import { canRevealImage, dataUrlToBlob, parseImageDataUrl } from '../src/chatImageActions';

describe('parseImageDataUrl', () => {
  it('parses base64 data URLs into mime + payload', () => {
    expect(parseImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toEqual({
      mime: 'image/png',
      base64: 'iVBORw0KGgo=',
    });
    expect(parseImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toEqual({
      mime: 'image/jpeg',
      base64: '/9j/4AAQ',
    });
  });

  it('falls back to octet-stream when the data URL omits a mime', () => {
    expect(parseImageDataUrl('data:;base64,QUJD')).toEqual({
      mime: 'application/octet-stream',
      base64: 'QUJD',
    });
  });

  it('rejects sources we cannot turn into bytes on the surface', () => {
    // Remote images render as click-to-open links, never inline bytes.
    expect(parseImageDataUrl('https://example.com/cat.png')).toBeNull();
    // Non-base64 data URLs are not handled.
    expect(parseImageDataUrl('data:text/plain,hello')).toBeNull();
    // Empty payloads and junk.
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseImageDataUrl('')).toBeNull();
    // Defensive: non-string input.
    expect(parseImageDataUrl(undefined as unknown as string)).toBeNull();
  });
});

describe('dataUrlToBlob', () => {
  it('decodes base64 data URLs into a typed Blob', () => {
    // "AAAA" base64 decodes to three 0x00 bytes.
    const blob = dataUrlToBlob('data:image/png;base64,AAAA');
    expect(blob).not.toBeNull();
    expect(blob?.type).toBe('image/png');
    expect(blob?.size).toBe(3);
  });

  it('returns null for non-data-url sources', () => {
    expect(dataUrlToBlob('https://example.com/cat.png')).toBeNull();
  });

  it('returns null (not throw) when decoding fails', () => {
    const throwingAtob = () => {
      throw new Error('bad base64');
    };
    expect(dataUrlToBlob('data:image/png;base64,%%%', throwingAtob)).toBeNull();
  });
});

describe('canRevealImage', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

  it('is always false on the web surface (no desktop shell)', () => {
    expect(canRevealImage({ desktopMode: false, path: '/tmp/a.png', src: dataUrl })).toBe(false);
  });

  it('is true when a real on-disk path exists (desktop)', () => {
    expect(canRevealImage({ desktopMode: true, path: '/tmp/a.png', src: 'https://x/y.png' })).toBe(true);
  });

  it('is true for allowlisted base64 data URLs the shell can materialize (desktop, no path)', () => {
    expect(canRevealImage({ desktopMode: true, path: null, src: dataUrl })).toBe(true);
    expect(canRevealImage({ desktopMode: true, path: null, src: 'data:image/jpeg;base64,/9j/4AAQ' })).toBe(true);
    expect(canRevealImage({ desktopMode: true, path: null, src: 'data:image/webp;base64,UklGRg==' })).toBe(true);
    expect(canRevealImage({ desktopMode: true, path: null, src: 'data:image/gif;base64,R0lGODlh' })).toBe(true);
    // A whitespace-only path is not a usable path; falls through to the data URL check.
    expect(canRevealImage({ desktopMode: true, path: '   ', src: dataUrl })).toBe(true);
  });

  it('is false for off-allowlist data URLs (shell would reject → do not offer)', () => {
    // AVIF and SVG are not on the shell allowlist; showing Reveal then failing on
    // click violates surface fail-closed.
    expect(canRevealImage({ desktopMode: true, path: null, src: 'data:image/avif;base64,AAAA' })).toBe(false);
    expect(canRevealImage({ desktopMode: true, path: null, src: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBe(false);
  });

  it('is false for a pure remote URL with no path (nothing to reveal)', () => {
    expect(canRevealImage({ desktopMode: true, path: null, src: 'https://example.com/cat.png' })).toBe(false);
  });

  it('still reveals a path-backed image of any type (real file exists on disk)', () => {
    // local_path attachments reveal the real file directly (reveal_path, not the
    // allowlist-gated materialize path), so an off-allowlist type is fine here.
    expect(canRevealImage({ desktopMode: true, path: '/tmp/a.avif', src: 'data:image/avif;base64,AAAA' })).toBe(true);
  });
});
