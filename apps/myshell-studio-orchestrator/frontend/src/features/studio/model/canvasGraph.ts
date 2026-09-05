import {
  Bot,
  Clapperboard,
  Film,
  ImagePlus,
  Layers3,
  PanelRightOpen,
  Play,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import type { StudioAction, StudioProject } from '../api';
import type {
  CanvasBoardId,
  CanvasConnection,
  CanvasFlowPreset,
  CanvasNode,
  CanvasNodeKind,
  CanvasSourceType,
} from './workspaceTypes';
import { DEFAULT_DREAMY_SLUG, DREAMY_VIDEO_SLUG } from './dreamyPresets';
import { getSegmentMedia, getTimelineDisplaySegments } from './studioAssets';
import { EMPTY_GRAPH } from './studioRuntime';

export function getInitialCanvasView() {
  if (typeof window !== 'undefined' && window.innerWidth < 768) {
    return { zoom: 0.56, pan: { x: -120, y: 20 } };
  }
  return { zoom: 0.82, pan: { x: 88, y: 10 } };
}

export const CANVAS_FLOW_PRESETS: CanvasFlowPreset[] = [
  {
    id: 'text-image-video',
    title: 'Text -> Image -> Video',
    summary: 'Create a source frame first, animate it, then stage the clip on the timeline.',
    action: 'generate',
    prompt: 'Build a neon rainy city source image, then turn the selected image into a five second cinematic video segment.',
    nodes: [
      {
        id: 'flow-text-image',
        kind: 'agent',
        title: 'Flow 01 Text to Image',
        subtitle: 'Generate the source frame from the user prompt',
        x: 260,
        y: 178,
        width: 250,
        height: 112,
        status: 'ready',
        action: 'generate',
        prompt: 'Generate the strongest source image for this scene.',
        botName: '3D Anime Porn',
        botSlug: DEFAULT_DREAMY_SLUG,
      },
      {
        id: 'flow-image-video',
        kind: 'agent',
        title: 'Flow 02 Image to Video',
        subtitle: 'Animate the selected source image into a short clip',
        x: 580,
        y: 178,
        width: 260,
        height: 112,
        status: 'queued',
        action: 'extend',
        prompt: 'Use the selected image as the source and create a five second motion shot.',
        botName: '3D Futa Porn',
        botSlug: DREAMY_VIDEO_SLUG,
      },
      {
        id: 'flow-timeline-video',
        kind: 'segment',
        title: 'Flow 03 Video Segment',
        subtitle: 'Review, rerun, or extend the produced video clip',
        x: 900,
        y: 178,
        width: 260,
        height: 124,
        status: 'idle',
        action: 'extend',
        prompt: 'Extend this shot into the next clip with matching lighting and character continuity.',
        botName: 'Dreamy Video Segment',
        botSlug: DREAMY_VIDEO_SLUG,
      },
    ],
    connections: [
      { id: 'flow-root-to-text-image', from: 'prompt-root', to: 'flow-text-image', label: 'prompt' },
      { id: 'flow-text-image-to-image-video', from: 'flow-text-image', to: 'flow-image-video', label: 'source image' },
      { id: 'flow-image-video-to-timeline-video', from: 'flow-image-video', to: 'flow-timeline-video', label: 'motion' },
      { id: 'flow-timeline-video-to-output', from: 'flow-timeline-video', to: 'timeline-output', label: 'sequence' },
    ],
  },
  {
    id: 'segment-rerun-long-video',
    title: 'Segment Rerun -> Long Video',
    summary: 'Regenerate weak clips, keep accepted clips, then export the whole sequence.',
    action: 'retry-agent',
    prompt: 'Rerun only the selected weak segment with the same character and lighting, then keep the timeline ready for a long video export.',
    nodes: [
      {
        id: 'flow-rerun-segment',
        kind: 'agent',
        title: 'Flow 01 Rerun Segment',
        subtitle: 'Repeat production for the selected clip without touching accepted clips',
        x: 274,
        y: 350,
        width: 276,
        height: 112,
        status: 'ready',
        action: 'retry-agent',
        prompt: 'Rerun the selected clip and preserve the surrounding timeline.',
        botName: 'Segment Retry Agent',
        botSlug: DEFAULT_DREAMY_SLUG,
      },
      {
        id: 'flow-export-long',
        kind: 'output',
        title: 'Flow 02 Long Video Export',
        subtitle: 'Collect every accepted segment into one export manifest',
        x: 646,
        y: 350,
        width: 306,
        height: 112,
        status: 'ready',
      },
    ],
    connections: [
      { id: 'flow-root-to-rerun-segment', from: 'prompt-root', to: 'flow-rerun-segment', label: 'selected clip' },
      { id: 'flow-rerun-segment-to-export-long', from: 'flow-rerun-segment', to: 'flow-export-long', label: 'approved' },
      { id: 'flow-export-long-to-output', from: 'flow-export-long', to: 'timeline-output', label: 'export all' },
    ],
  },
];


export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const CANVAS_BOARDS: Array<{ id: CanvasBoardId; label: string }> = [
  { id: 'story', label: 'Story' },
  { id: 'media', label: 'Media' },
  { id: 'timeline', label: 'Timeline' },
];

export const AI_CANVAS_NODE_LIBRARY: Array<{
  kind: CanvasNodeKind;
  title: string;
  subtitle: string;
  width: number;
  height: number;
  action?: StudioAction;
  botSlug?: string;
  sourceType?: CanvasSourceType;
}> = [
  {
    kind: 'source-text',
    title: 'Source Text',
    subtitle: 'Prompt, character notes, or shot brief',
    width: 248,
    height: 118,
    sourceType: 'text',
  },
  {
    kind: 'source-image',
    title: 'Source Image',
    subtitle: 'Reference image dropped into the canvas',
    width: 258,
    height: 146,
    sourceType: 'image',
  },
  {
    kind: 'source-video',
    title: 'Source Video',
    subtitle: 'Reference clip or generated video source',
    width: 266,
    height: 150,
    sourceType: 'video',
  },
  {
    kind: 'source-audio',
    title: 'Source Audio',
    subtitle: 'Audio reference or voice material',
    width: 244,
    height: 116,
    sourceType: 'audio',
  },
  {
    kind: 'ai-image',
    title: 'AI Image',
    subtitle: 'Generate a source frame from prompt or references',
    width: 258,
    height: 132,
    action: 'generate',
    botSlug: DEFAULT_DREAMY_SLUG,
  },
  {
    kind: 'ai-video',
    title: 'AI Video',
    subtitle: 'Animate selected sources into a short clip',
    width: 266,
    height: 136,
    action: 'extend',
    botSlug: DREAMY_VIDEO_SLUG,
  },
  {
    kind: 'ai-text',
    title: 'AI Text',
    subtitle: 'Rewrite prompt, extract beats, or summarize nodes',
    width: 248,
    height: 120,
    action: 'generate',
  },
  {
    kind: 'annotation',
    title: 'Annotation',
    subtitle: 'Planning note pinned on the canvas',
    width: 220,
    height: 104,
  },
];

export const CANVAS_COMMAND_PRESETS = [
  { label: '/image', value: '/image Generate a polished source frame from the selected references.' },
  { label: '/video', value: '/video Animate the selected source into a five second Dreamy segment.' },
  { label: '/extend', value: '/extend Continue the previous timeline segment with matching motion and style.' },
  { label: '/style', value: '/style Restyle the selected node while preserving the subject and composition.' },
];

export function getCanvasNodeLibraryItem(kind: CanvasNodeKind) {
  return AI_CANVAS_NODE_LIBRARY.find((item) => item.kind === kind);
}

export function getCanvasDefaultBoard(kind: CanvasNodeKind): CanvasBoardId {
  if (kind === 'segment' || kind === 'output' || kind === 'ai-video' || kind === 'source-video') return 'timeline';
  if (kind.startsWith('source-') || kind === 'ai-image' || kind === 'ai-audio') return 'media';
  return 'story';
}

export function getCanvasNodeMediaMode(kind: CanvasNodeKind): CanvasSourceType | undefined {
  if (kind === 'source-image') return 'image';
  if (kind === 'source-video') return 'video';
  if (kind === 'source-audio') return 'audio';
  if (kind === 'source-text') return 'text';
  return undefined;
}

export function getCanvasNodeIcon(kind: CanvasNodeKind) {
  return {
    prompt: Sparkles,
    agent: Bot,
    segment: Film,
    output: Layers3,
    'source-text': PanelRightOpen,
    'source-image': ImagePlus,
    'source-video': Film,
    'source-audio': Play,
    'ai-text': Sparkles,
    'ai-image': ImagePlus,
    'ai-video': Clapperboard,
    'ai-audio': Play,
    annotation: SlidersHorizontal,
  }[kind];
}

export function normalizeCanvasNodeKind(value: unknown): CanvasNodeKind {
  const raw = String(value || '').toLowerCase();
  const knownKinds: CanvasNodeKind[] = [
    'prompt',
    'agent',
    'segment',
    'output',
    'source-text',
    'source-image',
    'source-video',
    'source-audio',
    'ai-text',
    'ai-image',
    'ai-video',
    'ai-audio',
    'annotation',
  ];
  if (knownKinds.includes(raw as CanvasNodeKind)) return raw as CanvasNodeKind;
  if (raw.includes('audio')) return raw.includes('source') ? 'source-audio' : 'ai-audio';
  if (raw.includes('video') || raw.includes('clip')) return raw.includes('source') || raw.includes('media') ? 'source-video' : 'ai-video';
  if (raw.includes('image') || raw.includes('photo') || raw.includes('picture')) return raw.includes('source') ? 'source-image' : 'ai-image';
  if (raw.includes('note') || raw.includes('comment')) return 'annotation';
  if (raw.includes('text') || raw.includes('prompt')) return raw.includes('source') ? 'source-text' : 'ai-text';
  return 'agent';
}

export function buildCanvasGraph(
  project: StudioProject | null,
  positionOverrides: Record<string, { x: number; y: number }>,
): { nodes: CanvasNode[]; connections: CanvasConnection[] } {
  const graph = project?.agentGraph?.length ? project.agentGraph : EMPTY_GRAPH;
  const segments = getTimelineDisplaySegments(project?.segments || []);
  const nodes: CanvasNode[] = [];
  const connections: CanvasConnection[] = [];

  const addNode = (node: CanvasNode) => {
    const override = positionOverrides[node.id];
    nodes.push(override ? { ...node, ...override } : node);
  };

  addNode({
    id: 'prompt-root',
    kind: 'prompt',
    title: '01 Prompt',
    subtitle: project?.messages?.[project.messages.length - 1]?.content || 'Describe a scene, page, or agent run',
    x: 470,
    y: 52,
    width: 260,
    height: 118,
    status: project ? 'ready' : 'idle',
    prompt: project?.messages?.[project.messages.length - 1]?.content,
    boardId: 'story',
  });

  graph.forEach((agent, index) => {
    const id = `agent-${agent.id}`;
    const branchPositions = [
      { x: 418, y: 218, width: 300, height: 124 },
      { x: 280, y: 408, width: 244, height: 128 },
      { x: 760, y: 408, width: 244, height: 128 },
      { x: 520, y: 594, width: 260, height: 112 },
    ];
    const fallbackPosition = {
      x: 300 + (index % 3) * 260,
      y: 406 + Math.floor(index / 3) * 150,
      width: 244,
      height: 118,
    };
    const position = branchPositions[index] || fallbackPosition;
    addNode({
      id,
      kind: 'agent',
      title: `${String(index + 2).padStart(2, '0')} ${agent.label}`,
      subtitle: agent.detail || 'Agent step',
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
      status: agent.status,
      agentId: agent.id,
      boardId: index > 1 ? 'timeline' : 'story',
    });

    connections.push({
      id: index === 0 ? 'prompt-to-agent-0' : `agent-${graph[index - 1].id}-to-${agent.id}`,
      from: index === 0 ? 'prompt-root' : index < 3 ? `agent-${graph[0].id}` : `agent-${graph[index - 1].id}`,
      to: id,
      label: index === 0 ? 'route' : index === 1 ? 'primary' : index === 2 ? 'fallback' : 'next',
    });
  });

  segments.forEach((segment, index) => {
    const id = `segment-${segment.id}`;
    const segmentX = 220 + (index % 3) * 300;
    const segmentY = 594 + Math.floor(index / 3) * 160;
    addNode({
      id,
      kind: 'segment',
      title: `Segment ${String(index + 1).padStart(2, '0')} (${segment.type})`,
      subtitle: segment.prompt,
      x: segmentX,
      y: segmentY,
      width: 246,
      height: 142,
      status: segment.status,
      action: segment.action,
      prompt: segment.prompt,
      segmentId: segment.id,
      botSlug: segment.botSlug,
      botName: segment.botName,
      mediaUrl: getSegmentMedia(segment),
      sourceType: segment.type,
      boardId: 'timeline',
    });

    const parent = segment.parentSegmentId ? `segment-${segment.parentSegmentId}` : null;
    connections.push({
      id: parent ? `${parent}-to-${id}` : `agent-to-${id}`,
      from: parent || (graph.length > 1 ? `agent-${graph[1].id}` : graph.length ? `agent-${graph[0].id}` : 'prompt-root'),
      to: id,
      label: segment.action,
    });
  });

  addNode({
    id: 'timeline-output',
    kind: 'output',
    title: '05 Output Timeline',
    subtitle: segments.length ? `${segments.length} staged assets / ${segments.length * 5}s preview` : 'Waiting for generated assets',
    x: 430,
    y: 782,
    width: 360,
    height: 112,
    status: segments.length ? 'ready' : 'idle',
    boardId: 'timeline',
  });

  if (segments.length) {
    segments.forEach((segment, index) => {
      connections.push({
        id: `segment-${segment.id}-to-output`,
        from: `segment-${segment.id}`,
        to: 'timeline-output',
        label: index === segments.length - 1 ? 'current' : undefined,
      });
    });
  } else if (graph.length) {
    connections.push({
      id: 'agent-to-output-empty',
      from: `agent-${graph[graph.length - 1].id}`,
      to: 'timeline-output',
      label: 'stage',
    });
  }

  return { nodes, connections };
}
