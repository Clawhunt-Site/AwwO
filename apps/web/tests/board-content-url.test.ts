import { describe, expect, it } from 'vitest';
// The board's content-URL resolver, imported through the SAME `@` alias the embedded
// build uses (vitest.config.mjs maps `@` -> server/ui/src and defines
// __PAPERCLIP_API_BASE__ = "/paperclip-api"). So here BASE === "/paperclip-api",
// exercising the EMBEDDED branch that production apps/web runs — the standalone
// (BASE === "/api") no-op branch is covered by server/ui's own component tests.
import { resolveContentUrl } from '@/api/client';
import {
  attachmentDownloadPath,
  attachmentOpenPath,
  matchImageAttachmentIndex,
} from '@/lib/issue-attachments';

describe('resolveContentUrl (embedded: BASE=/paperclip-api)', () => {
  it('rewrites a leading /api/ to the embedding base so it hits the Paperclip control plane', () => {
    expect(resolveContentUrl('/api/assets/abc/content')).toBe('/paperclip-api/assets/abc/content');
    expect(resolveContentUrl('/api/attachments/xyz/content')).toBe('/paperclip-api/attachments/xyz/content');
  });

  it('preserves query strings (download links)', () => {
    expect(resolveContentUrl('/api/attachments/xyz/content?download=1')).toBe(
      '/paperclip-api/attachments/xyz/content?download=1',
    );
  });

  it('does NOT touch the bare "/api" prefix or look-alikes (no false rewrite)', () => {
    // Only a leading "/api/" is a content URL; "/api" (no slash) and "/apiX/..."
    // are different paths and must pass through unchanged.
    expect(resolveContentUrl('/api')).toBe('/api');
    expect(resolveContentUrl('/apiX/thing')).toBe('/apiX/thing');
    expect(resolveContentUrl('/apidocs/x')).toBe('/apidocs/x');
  });

  it('passes through absolute, data:, and blob: URLs untouched', () => {
    expect(resolveContentUrl('https://cdn.example.com/avatar.png')).toBe('https://cdn.example.com/avatar.png');
    expect(resolveContentUrl('http://x/y')).toBe('http://x/y');
    expect(resolveContentUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(resolveContentUrl('blob:https://x/abc')).toBe('blob:https://x/abc');
  });

  it('passes through relative non-/api paths (workspace/mention hrefs)', () => {
    expect(resolveContentUrl('/companies/c1/board')).toBe('/companies/c1/board');
    expect(resolveContentUrl('#mention')).toBe('#mention');
  });

  it('is idempotent — an already-rewritten URL is left alone', () => {
    expect(resolveContentUrl('/paperclip-api/assets/abc/content')).toBe('/paperclip-api/assets/abc/content');
  });

  it('passes null/undefined through (type-preserving)', () => {
    expect(resolveContentUrl(null)).toBeNull();
    expect(resolveContentUrl(undefined)).toBeUndefined();
  });
});

describe('attachment path helpers (embedded)', () => {
  it('attachmentOpenPath rewrites the contentPath fallback to the control plane', () => {
    expect(attachmentOpenPath({ contentPath: '/api/assets/x/content' })).toBe(
      '/paperclip-api/assets/x/content',
    );
  });

  it('attachmentOpenPath rewrites an explicit openPath', () => {
    expect(attachmentOpenPath({ contentPath: '/api/assets/x/content', openPath: '/api/o/y' })).toBe(
      '/paperclip-api/o/y',
    );
  });

  it('attachmentDownloadPath rewrites and preserves the ?download=1 query', () => {
    expect(attachmentDownloadPath({ contentPath: '/api/assets/x/content' })).toBe(
      '/paperclip-api/assets/x/content?download=1',
    );
  });
});

describe('matchImageAttachmentIndex (embedded gallery click)', () => {
  const attachments = [
    { contentPath: '/api/assets/a1/content', assetId: 'a1' },
    { contentPath: '/api/attachments/b2/content', assetId: 'b2' },
  ];

  it('matches a RAW "/api/..." click src (resolveImageSrc path)', () => {
    expect(matchImageAttachmentIndex(attachments, '/api/assets/a1/content')).toBe(0);
    expect(matchImageAttachmentIndex(attachments, '/api/attachments/b2/content')).toBe(1);
  });

  it('matches an embedding-REWRITTEN "/paperclip-api/..." click src (markdown urlTransform path)', () => {
    // This is the round-2 regression case: urlTransform rewrites the src upstream, so the
    // click identity arrives as /paperclip-api/... and must still resolve to the gallery.
    expect(matchImageAttachmentIndex(attachments, '/paperclip-api/assets/a1/content')).toBe(0);
    expect(matchImageAttachmentIndex(attachments, '/paperclip-api/attachments/b2/content')).toBe(1);
  });

  it('falls back to asset-id matching (either base prefix) when paths differ', () => {
    const withQuery = [{ contentPath: '/api/assets/a1/content?v=2', assetId: 'a1' }];
    expect(matchImageAttachmentIndex(withQuery, '/paperclip-api/assets/a1/content')).toBe(0);
  });

  it('returns -1 when nothing matches (caller opens in a new tab)', () => {
    expect(matchImageAttachmentIndex(attachments, '/api/assets/zzz/content')).toBe(-1);
    expect(matchImageAttachmentIndex(attachments, 'https://external/img.png')).toBe(-1);
  });
});
