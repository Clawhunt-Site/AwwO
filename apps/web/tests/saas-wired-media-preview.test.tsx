// A page a media node is wired into names that node's files by relative paths (`<node id>/image-1.png`). The card preview
// and the studio put the files in place; the deliverables drawer and the results' step view (ArtifactPreview) now do
// too, by running such a page in the studio's live page with the canvas's files. Every other page is untouched.
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactPreview, namesRelativeMedia } from '../src/canvas/ArtifactPreview';
import type { AssetResolver } from '../src/canvas/studio/liveDocument';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const markdown = (text: string) => <p>{text}</p>;
const page = (body: string) => `<!DOCTYPE html><html><head><style>.hero{background:#000}</style></head><body>${body}<script>document.body.dataset.ready='yes'</script></body></html>`;
const resolve: AssetResolver = async path => path === 'hero/image-1.png' ? { bytes: PNG, name: 'image-1.png' } : null;

afterEach(() => cleanup());

describe('wired media in the deliverables preview', () => {
  it('tells a page that names a picture, clip or model by a relative path', () => {
    expect(namesRelativeMedia('<img src="hero/image-1.png" alt="">')).toBe(true);
    expect(namesRelativeMedia("<video poster='clip/preview-1.webp' src='clip/video-1.mp4'></video>")).toBe(true);
    expect(namesRelativeMedia('<div style="background:url(hero/image-1.png) center/cover"></div>')).toBe(true);
    expect(namesRelativeMedia("<style>.a{background-image:url('hero/image-1.png?v=2')}</style>")).toBe(true);
    expect(namesRelativeMedia('<img src="https://example.com/a.png">')).toBe(false);
    expect(namesRelativeMedia('<img src="data:image/png;base64,AAAA">')).toBe(false);
    expect(namesRelativeMedia('<a href="#top">top</a><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>')).toBe(false);
  });

  it('runs a page that shows a wired picture in the live page, with the file in place', async () => {
    const { container } = render(<ArtifactPreview source={page('<img class="hero" src="hero/image-1.png" alt="主视觉">')} type="html" title="页面"
      renderMarkdown={markdown} resolveAsset={resolve} />);
    await waitFor(() => expect(container.querySelector('iframe.awwo-live-page-frame')).not.toBeNull());
    const frame = container.querySelector('iframe.awwo-live-page-frame')!;
    expect(frame.getAttribute('srcdoc')).toContain('src="data:image/png;base64,');
    expect(frame.getAttribute('srcdoc')).not.toContain('hero/image-1.png');
    expect(frame.getAttribute('srcdoc')).toContain("dataset.ready='yes'");
    expect(container.querySelector('.awwo-artifact-live')).not.toBeNull();
    expect(container.querySelector('iframe.awwo-artifact-frame')).toBeNull();
    expect(container.textContent).toContain('这张画布生成的文件');
  });

  it('keeps every other page in its own preview', () => {
    // No canvas files to read: the page stays where it was, its picture unresolved as before.
    const alone = render(<ArtifactPreview source={page('<img src="hero/image-1.png" alt="">')} type="html" title="页面" renderMarkdown={markdown} />);
    expect(alone.container.querySelector('iframe.awwo-artifact-frame')).not.toBeNull();
    expect(alone.container.querySelector('.awwo-artifact-live')).toBeNull();
    alone.unmount();
    // A page that names no relative file runs in the same frame as before, with or without the canvas's files.
    const plain = render(<ArtifactPreview source={page('<h1>Pricing</h1>')} type="html" title="页面" renderMarkdown={markdown} resolveAsset={resolve} />);
    expect(plain.container.querySelector('iframe.awwo-artifact-frame')?.getAttribute('srcdoc')).toContain('Pricing');
    expect(plain.container.querySelector('.awwo-artifact-live')).toBeNull();
  });
});
