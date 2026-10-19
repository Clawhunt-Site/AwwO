import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TilePorts, mediaPortGuide, type WiringApi } from '../src/canvas/TilePorts';
import { SessionTile } from '../src/canvas/SessionTile';
import { MediaWiringGuide } from '../src/canvas/MediaWiringGuide';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import { portsFor } from '../src/canvas/ports';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
import { resetAllSessions } from '../src/canvas/sessions';
import type { MediaComposerInfo } from '../src/canvas/TileComposer';

function media(kind: 'image' | 'video' | 'model3d' | 'audio', over: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode(kind, { x: 0, y: 0 }), id: `${kind}-node`, title: kind, w: 400, h: 420, ...over };
}
function wiring(wires: Record<string, number> = {}): WiringApi {
  return { pendingPort: null, wireDrag: null, interactive: true, wireCount: (_node, port) => wires[port] ?? 0,
    clearPending: vi.fn(), onPortPointerDown: vi.fn(), onPortClick: vi.fn() };
}
const imageModel: MediaComposerInfo = { kind: 'image', references: 1, referenceModels: ['图片 · 高清'] };

beforeEach(() => { cleanup(); resetAllSessions(); });
afterEach(cleanup);

describe('media port guides', () => {
  it('names a media node’s ports and explains each one while it is hovered, in place of the native tooltip', () => {
    render(<TilePorts node={media('image')} wiring={wiring()} media={imageModel} />);
    const context = screen.getByRole('button', { name: '输入端口 上下文（文本），未连接' });
    const reference = screen.getByRole('button', { name: '输入端口 参考图（图像），未连接' });
    const result = screen.getByRole('button', { name: '输出端口 结果（图像），未连接' });
    for (const port of [context, reference, result]) expect(port.getAttribute('title')).toBeNull();
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0); // all three guides exist, hidden until asked for

    fireEvent.mouseEnter(context);
    const shown = screen.getByRole('tooltip');
    expect(shown.id).toBe(context.getAttribute('aria-describedby'));
    expect(shown.textContent).toContain('上下文 · 文本 · 可多路输入');
    expect(shown.textContent).toContain('运行画布时，这个节点用自己的提示词，后面接上这些文字来生成');
    fireEvent.mouseLeave(context);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);

    fireEvent.focus(reference);
    expect(screen.getByRole('tooltip').textContent).toContain('参考图 · 图像 · 只接一条');
    expect(screen.getByRole('tooltip').textContent).toContain('这个节点的模型会按提示词改这张图');
    fireEvent.blur(reference);

    fireEvent.mouseEnter(result);
    expect(screen.getByRole('tooltip').textContent).toContain('接到图片或 3D 节点的「参考图」，或组件的图像字段');
    expect(screen.getByRole('tooltip').textContent).toContain('接到网页或文字节点的「上下文」或文字字段，那个节点会拿到文件路径');
  });

  it('says how many wires a port carries', () => {
    render(<TilePorts node={media('image')} wiring={wiring({ context: 2 })} media={imageModel} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /输入端口 上下文/ }));
    expect(screen.getByRole('tooltip').textContent).toContain('上下文 · 文本 · 可多路输入 · 已连 2 条');
  });

  it('keeps its on-screen size at any zoom: scaled by 1/zoom about the port, beside it on the tile’s side', () => {
    render(<TilePorts node={media('image')} wiring={wiring()} media={imageModel} scale={0.5} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /输入端口 上下文/ }));
    const input = screen.getByRole('tooltip');
    expect(input.style.transformOrigin).toBe('0 0');
    expect(input.style.transform).toBe('scale(2) translate(14px, -50%)');
    fireEvent.mouseLeave(screen.getByRole('button', { name: /输入端口 上下文/ }));
    fireEvent.mouseEnter(screen.getByRole('button', { name: /输出端口 结果/ }));
    expect(screen.getByRole('tooltip').style.transform).toBe('scale(2) translate(calc(-100% - 14px), -50%)');
  });

  it('says whether the node’s model uses the wired picture, and which models would', () => {
    const reference = (node: SessionNode, info?: MediaComposerInfo) =>
      mediaPortGuide((key, values) => canvasText('zh', key, values), 'zh', node, portsFor(node).find(p => p.id === 'reference')!, info);
    expect(reference(media('image'), imageModel)).toContain('按提示词改这张图');
    expect(reference(media('model3d'), { kind: 'model3d', references: 1, referenceModels: ['3D · 标准'] }))
      .toContain('3D 模型只按这张图生成，不看提示词，付费套餐每次多用 30 积分');
    expect(reference(media('image'), { kind: 'image', references: 0, referenceModels: ['图片 · 高清', '图片 · 标准多张'] }))
      .toContain('不会用它；要用参考图，请换成：图片 · 高清、图片 · 标准多张。');
    expect(reference(media('image'), { kind: 'image', references: 0, referenceModels: [] })).toBe(canvasText('zh', 'media.guideReferenceNone'));
    expect(reference(media('image'))).toBe(canvasText('zh', 'media.guideReference'));
    const en = mediaPortGuide((key, values) => canvasText('en', key, values), 'en', media('image'), portsFor(media('image')).find(p => p.id === 'reference')!,
      { kind: 'image', references: 0, referenceModels: ['Image · HD', 'Image · Multi'] });
    expect(en).toContain('switch to Image · HD, Image · Multi.');
  });

  it('gives video and 3D results their own destination', () => {
    const result = (node: SessionNode) => mediaPortGuide((key, values) => canvasText('zh', key, values), 'zh', node, portsFor(node).find(p => p.side === 'output')!);
    expect(result(media('video'))).toContain('接到组件的视频字段');
    expect(result(media('model3d'))).toContain('以文件形式从这里连出去：接到网页或文字节点的「上下文」');
    expect(result(media('model3d'))).toContain('接到组件的文件字段');
    const videoReference = portsFor(media('video')).find(p => p.id === 'reference');
    expect(videoReference).toBeDefined();
    expect(mediaPortGuide((key, values) => canvasText('zh', key, values), 'zh', media('video'), videoReference!,
      { kind: 'video', references: 9, referenceModels: ['视频 · 全能'] })).toContain('视频从这张图开始（第一帧）');
    // A model whose every picture is a subject reference never calls one its first frame, and says how words name them.
    for (const locale of ['zh', 'en'] as const) {
      const subjects = mediaPortGuide((key, values) => canvasText(locale, key, values), locale, media('video'), videoReference!,
        { kind: 'video', references: 9, referenceModels: ['视频 · 多图参考'], subjects: true });
      expect(subjects).toBe(canvasText(locale, 'media.guideReferenceSubjects', { count: 9 }));
      expect(subjects).toContain('@Image 1');
      expect(subjects).toContain('9');
      expect(subjects).not.toMatch(/第一帧|first frame/);
    }
  });

  it('names a video node’s voice input and says what the voices wired in do', () => {
    const lipSync: MediaComposerInfo = { kind: 'video', references: 9, referenceModels: ['视频 · 多图参考'], subjects: true, audioReferences: 3, audioReferenceModels: ['视频 · 多图参考'] };
    render(<TilePorts node={media('video')} wiring={wiring({ audio: 2 })} media={lipSync} />);
    const voice = screen.getByRole('button', { name: '输入端口 声音参考（音频），已连 2 条' });
    expect(voice.dataset.portId).toBe('audio');
    expect(voice.getAttribute('title')).toBeNull();
    fireEvent.focus(voice);
    expect(screen.getByRole('tooltip').textContent).toContain('声音参考 · 音频 · 可多路输入 · 已连 2 条');
    expect(screen.getByRole('tooltip').textContent).toContain(canvasText('zh', 'media.guideVoiceReferences', { count: 3 }));
  });

  it('says whether a video node’s model lip-syncs to the voices wired in, and which models would', () => {
    const video = media('video');
    const audio = portsFor(video).find(p => p.id === 'audio')!;
    const voice = (locale: 'zh' | 'en', info?: MediaComposerInfo) => mediaPortGuide((key, values) => canvasText(locale, key, values), locale, video, audio, info);
    const lipSync: MediaComposerInfo = { kind: 'video', references: 9, referenceModels: ['视频 · 多图参考'], subjects: true, audioReferences: 3, audioReferenceModels: ['视频 · 多图参考'] };
    for (const locale of ['zh', 'en'] as const) {
      const takes = voice(locale, lipSync);
      expect(takes).toBe(canvasText(locale, 'media.guideVoiceReferences', { count: 3 }));
      expect(takes).toContain('@Audio 1');
      expect(takes).toContain('3');
      expect(voice(locale)).toBe(canvasText(locale, 'media.guideVoice'));
    }
    expect(voice('zh', lipSync)).toContain('画面里说话的人按声音对口型');
    expect(voice('en', lipSync)).toContain('the speaker’s lips move to the voice');
    // A run refuses a voice with no picture beside it, and RunningHub reads voices of 2–15 s, 15 s in all: the guide says so first.
    expect(voice('zh', lipSync)).toContain('用声音时至少要有一张图片，接到「参考图」或附在消息里都可以');
    expect(voice('zh', lipSync)).toContain('更多或更长时运行会被拒绝');
    expect(voice('zh', lipSync)).toContain('每段 2–15 秒，合计不超过 15 秒');
    expect(voice('en', lipSync)).toContain('A voice needs at least one picture beside it, wired into Reference picture or attached to the message.');
    expect(voice('en', lipSync)).toContain('a run refuses more or longer ones');
    expect(voice('en', lipSync)).toContain('each 2 to 15 seconds and 15 seconds in all');
    // An audio node's result says where a voice goes.
    const result = portsFor(media('audio')).find(p => p.id === 'result')!;
    expect(mediaPortGuide((key, values) => canvasText('en', key, values), 'en', media('audio'), result)).toContain('a video node’s Voice reference');
    expect(mediaPortGuide((key, values) => canvasText('zh', key, values), 'zh', media('audio'), result)).toContain('视频节点的「声音参考」');
    // A model that takes none: a run refuses the voice, and the guide names the models that take one.
    expect(voice('zh', { kind: 'video', references: 9, referenceModels: [], audioReferences: 0, audioReferenceModels: ['视频 · 多图参考', '视频 · 高清'] }))
      .toBe('接声音进来：上游音频节点的结果。这个节点的模型不接声音参考，运行画布时会拒绝接在这里的声音；要用声音参考，请换成：视频 · 多图参考、视频 · 高清。');
    expect(voice('en', { kind: 'video', references: 9, referenceModels: [], audioReferences: 0, audioReferenceModels: ['Video · From references', 'Video · HD'] }))
      .toContain('a canvas run refuses a voice wired here; for voice references, switch to Video · From references, Video · HD.');
    for (const locale of ['zh', 'en'] as const) {
      expect(voice(locale, { kind: 'video', references: 9, referenceModels: [], audioReferences: 0, audioReferenceModels: [] })).toBe(canvasText(locale, 'media.guideVoiceNone'));
    }
  });

  it('leaves every other port as it was, and shows no guide where nothing can be wired', () => {
    const text = { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'writer', w: 400, h: 420 } as SessionNode;
    render(<TilePorts node={text} wiring={wiring()} />);
    expect(screen.getByRole('button', { name: '输入端口 context（文本），未连接' }).getAttribute('title')).toBe('context · 文本 · 可多路输入');
    expect(mediaPortGuide((key) => canvasText('zh', key), 'zh', text, portsFor(text)[0])).toBeNull();
    cleanup();
    const { container } = render(<TilePorts node={media('image')} media={imageModel} />); // inert: read-only, simple mode, a run
    expect(container.querySelectorAll('.canvas-port-guide')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /输入端口 上下文/ }).getAttribute('title')).toBe('上下文 · 文本 · 可多路输入');
  });

  it('speaks English with an English canvas', () => {
    render(<LocaleProvider locale="en"><TilePorts node={media('model3d')} wiring={wiring()} /></LocaleProvider>);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Input port Reference picture/ }));
    expect(screen.getByRole('tooltip').textContent).toContain('Reference picture · Image · one connection');
    expect(screen.getByRole('tooltip').textContent).toContain('Models that take a reference picture start from it');
    cleanup();
    render(<LocaleProvider locale="en"><TilePorts node={media('video')} wiring={wiring()} /></LocaleProvider>);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Input port Voice reference (Audio), not connected' }));
    expect(screen.getByRole('tooltip').textContent).toContain('Voice reference · Audio · Multiple inputs allowed');
    expect(screen.getByRole('tooltip').textContent).toContain('Models that take voice references move the speaker’s lips to the voice');
  });
});

describe('a media node that has not generated yet', () => {
  it('asks for its prompt and shows how to wire it', () => {
    render(<SessionTile node={media('image')} scale={1} focused={false} onSend={vi.fn()} />);
    const tile = screen.getByTestId('canvas-tile-image-node');
    expect(within(tile).getByText('写下想要的图片')).toBeTruthy();
    expect(within(tile).getByText('在下面写提示词，点「发送」生成；运行画布时也会按顺序生成。')).toBeTruthy();
    const guide = within(tile).getByRole('region', { name: '怎么连线' });
    expect(guide.textContent).toBe(`怎么连线：${canvasText('zh', 'media.wireDeveloper')}`);
    expect(guide.textContent).toContain('「参考图」接一张图片');
  });

  it('has no reference picture to explain on a video node', () => {
    render(<MediaWiringGuide kind="video" simple={false} />);
    const guide = screen.getByRole('region', { name: '怎么连线' });
    expect(guide.textContent).toBe(`怎么连线：${canvasText('zh', 'media.wireDeveloperVideo')}`);
    expect(guide.textContent).not.toContain('参考图');
  });

  it('points at the canvas assistant and Developer mode when the ports are hidden', () => {
    render(<CanvasUiModeProvider mode="simple"><SessionTile node={media('model3d')} scale={1} focused={false} onSend={vi.fn()} /></CanvasUiModeProvider>);
    const guide = screen.getByRole('region', { name: '怎么连线' });
    expect(guide.textContent).toContain('可以直接跟画布助手说');
    expect(guide.textContent).toContain('「开发者模式」');
    expect(guide.textContent).not.toContain('鼠标停在圆点上');
    expect(screen.getByText('写下想要的 3D 模型')).toBeTruthy();
  });

  it('speaks English with an English canvas', () => {
    render(<LocaleProvider locale="en"><MediaWiringGuide kind="image" simple={false} /></LocaleProvider>);
    expect(screen.getByRole('region', { name: 'How to wire it' }).textContent).toBe(`How to wire it: ${canvasText('en', 'media.wireDeveloper')}`);
  });

  it('shows no wiring guide on a read-only canvas, and keeps text nodes’ own empty state', () => {
    render(<SessionTile node={media('image')} scale={1} focused={false} readOnly />);
    expect(screen.queryByRole('region', { name: '怎么连线' })).toBeNull();
    cleanup();
    render(<SessionTile node={{ ...createSessionNode('coding', { x: 0, y: 0 }), id: 'writer', w: 400, h: 420 }} scale={1} focused={false} onConfigure={vi.fn()} />);
    expect(screen.getByText('连接 Agent 后开始对话')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '怎么连线' })).toBeNull();
  });
});

describe('what the planner and its reply say about media nodes', () => {
  it('no longer says canvas runs leave them out', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(canvasText(locale, 'planning.mediaAdded', { count: 2 })).not.toMatch(/不随画布运行|do not run with the canvas/);
      expect(canvasText(locale, 'planning.mediaResponsibility', { kind: 'x' })).not.toMatch(/不随画布运行|not with the canvas/);
    }
    expect(canvasText('zh', 'planning.mediaAdded', { count: 2 })).toBe('已添加 2 个媒体节点并填好提示词。运行画布时会按顺序生成，也可以在节点上点「发送」单独生成。');
  });
});
