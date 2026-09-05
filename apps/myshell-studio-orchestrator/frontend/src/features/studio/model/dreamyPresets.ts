import presetCharacterGif from '../../../assets/dreamy-preset-character.gif';
import presetCinematicGif from '../../../assets/dreamy-preset-cinematic.gif';
import exampleGood from '../../../assets/example-good.png';
import exampleMultiple from '../../../assets/example-multiple.png';
import exampleSmall from '../../../assets/example-small.png';
import type { StudioAction, StudioBotPreview, StudioBotPreviewsResponse, StudioSegment } from '../api';
import type { ManualBotEntry, StudioStarterPreset } from './workspaceTypes';
import { fallbackVisualForDreamyBot, resolveStudioDisplayAssetUrl } from './studioAssets';

export const DEFAULT_DREAMY_SLUG = '3d-anime-porn';
export const DREAMY_VIDEO_SLUG = '3d-futa-porn';
export const VERIFIED_WORKSHOP_PROJECT_ID = 'dreamy_verified_workshop_two_bot';
export const VERIFIED_WORKSHOP_SEGMENTS: StudioSegment[] = [
  {
    id: 'verified_workshop_segment_1',
    type: 'video',
    url: 'https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030911/551da3b2c0274fab8e1cd12c554186d4.mp4',
    posterUrl: 'https://www.myshellstatic.com/video/chat/embed_obj/202606030911/551da3b2c0274fab8e1cd12c554186d4-poster.jpg',
    prompt: 'Verified Dreamy workshop result from 3D Anime Porn.',
    botSlug: DEFAULT_DREAMY_SLUG,
    botId: '1769085605',
    articleId: DEFAULT_DREAMY_SLUG,
    botName: '3D Anime Porn',
    action: 'generate',
    status: 'done',
    taskId: 'bdcc5855a80f479dafe39c3afd3ab6fa',
    evidence: {
      status: 'done',
      source: 'dreamyporn-workshop-web',
      accepted: true,
      mediaUrl: 'https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030911/551da3b2c0274fab8e1cd12c554186d4.mp4',
      taskId: 'bdcc5855a80f479dafe39c3afd3ab6fa',
      message: 'Real Dreamy workshop bot completed and returned playable media.',
      checkedAt: '2026-06-03T09:11:00Z',
    },
    createdAt: '2026-06-03T09:11:00Z',
    updatedAt: '2026-06-03T09:11:00Z',
  },
  {
    id: 'verified_workshop_segment_2',
    type: 'video',
    url: 'https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030923/ed0e2719080742b5a5db07483f439a84.mp4',
    posterUrl: 'https://www.myshellstatic.com/video/chat/embed_obj/202606030923/ed0e2719080742b5a5db07483f439a84-poster.jpg',
    prompt: 'Verified Dreamy workshop result from 3D Futa Porn, staged as the next segment.',
    botSlug: DREAMY_VIDEO_SLUG,
    botId: '1768994068',
    articleId: DREAMY_VIDEO_SLUG,
    botName: '3D Futa Porn',
    action: 'extend',
    parentSegmentId: 'verified_workshop_segment_1',
    status: 'done',
    taskId: 'ed8d4bd4aab74245aadb8f8a832c3f4b',
    evidence: {
      status: 'done',
      source: 'dreamyporn-workshop-web',
      accepted: true,
      mediaUrl: 'https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030923/ed0e2719080742b5a5db07483f439a84.mp4',
      taskId: 'ed8d4bd4aab74245aadb8f8a832c3f4b',
      message: 'Second real Dreamy workshop bot completed and is staged as a timeline extension.',
      checkedAt: '2026-06-03T09:23:00Z',
    },
    createdAt: '2026-06-03T09:23:00Z',
    updatedAt: '2026-06-03T09:23:00Z',
  },
];
export const LOCAL_POSTERS = [exampleGood, exampleMultiple];
export const DEFAULT_STUDIO_AGENT_ID = 'dreamy-miniapp-executor';
export const TRANSIENT_STUDIO_STATUSES = new Set(['queued', 'running']);
export const DREAMY_STARTER_PRESETS: StudioStarterPreset[] = [
  {
    id: 'verified-3d-anime',
    title: '3D Anime Porn',
    prompt: 'Continue from the verified 3D Anime Porn workshop output with a matching five second shot.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: DEFAULT_DREAMY_SLUG,
    botId: '1769085605',
    articleId: DEFAULT_DREAMY_SLUG,
    recommendation: 'Verified workshop bot with completed media already staged in the timeline.',
    visualUrl: VERIFIED_WORKSHOP_SEGMENTS[0].posterUrl || presetCinematicGif,
    fallbackVisualUrl: presetCinematicGif,
    previewStatus: 'done',
    previewAccepted: true,
    previewSource: 'dreamyporn-workshop-web',
    previewLabel: 'Verified result',
    workflow: 'Workshop video',
    steps: ['Verified bot', 'Video segment', 'Timeline'],
    estimatedWaitSeconds: 0,
  },
  {
    id: 'verified-3d-futa',
    title: '3D Futa Porn',
    prompt: 'Append a next segment from the verified 3D Futa Porn workshop output.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: DREAMY_VIDEO_SLUG,
    botId: '1768994068',
    articleId: DREAMY_VIDEO_SLUG,
    recommendation: 'Verified workshop bot used as the second timeline segment.',
    visualUrl: VERIFIED_WORKSHOP_SEGMENTS[1].posterUrl || presetCharacterGif,
    fallbackVisualUrl: presetCharacterGif,
    previewStatus: 'done',
    previewAccepted: true,
    previewSource: 'dreamyporn-workshop-web',
    previewLabel: 'Verified result',
    workflow: 'Workshop video',
    steps: ['Verified bot', 'Next segment', 'Timeline'],
    estimatedWaitSeconds: 0,
  },
];

export const DREAMY_CATALOG_FALLBACK_PRESETS: StudioStarterPreset[] = [
  {
    id: 'catalog-aurora-dusk',
    title: 'Aurora Dusk',
    prompt: 'Animate the current Dreamy source into a five second Aurora Dusk video segment with smooth cinematic motion.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'aurora-dusk',
    botId: 'aurora-dusk',
    articleId: 'aurora-dusk',
    recommendation: 'Dreamy miniapp video generation for extending Studio timelines.',
    visualUrl: '',
    fallbackVisualUrl: presetCinematicGif,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Image to video',
    steps: ['Source image', 'Motion prompt', 'Video segment'],
    estimatedWaitSeconds: 60,
  },
  {
    id: 'catalog-crystal-rose',
    title: 'Crystal Rose',
    prompt: 'Create a polished Dreamy image with Crystal Rose, cinematic lighting and a clean portrait composition.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'crystal-rose',
    botId: 'crystal-rose',
    articleId: 'crystal-rose',
    recommendation: 'Dreamy miniapp outfit and portrait generation.',
    visualUrl: '',
    fallbackVisualUrl: exampleSmall,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Text to image',
    steps: ['Prompt', 'Dreamy bot', 'Image segment'],
    estimatedWaitSeconds: 30,
  },
  {
    id: 'catalog-ember-fox',
    title: 'Ember Fox',
    prompt: 'Create a classic Dreamy scene with Ember Fox, warm studio lighting and a production-ready composition.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'ember-fox',
    botId: 'ember-fox',
    articleId: 'ember-fox',
    recommendation: 'Dreamy miniapp classic scene generation.',
    visualUrl: '',
    fallbackVisualUrl: exampleGood,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Text to image',
    steps: ['Prompt', 'Dreamy bot', 'Image segment'],
    estimatedWaitSeconds: 30,
  },
  {
    id: 'catalog-jade-river',
    title: 'Jade River',
    prompt: 'Create a vivid Dreamy wild encounter style image with Jade River and cinematic lighting.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'jade-river',
    botId: 'jade-river',
    articleId: 'jade-river',
    recommendation: 'Dreamy miniapp wild encounter image generation.',
    visualUrl: '',
    fallbackVisualUrl: exampleMultiple,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Text to image',
    steps: ['Prompt', 'Dreamy bot', 'Image segment'],
    estimatedWaitSeconds: 30,
  },
  {
    id: 'catalog-luna-star',
    title: 'Luna Star',
    prompt: 'Create a character image with Luna Star, clear subject and polished Dreamy composition.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'luna-star',
    botId: 'luna-star',
    articleId: 'luna-star',
    recommendation: 'Dreamy miniapp character image generation.',
    visualUrl: '',
    fallbackVisualUrl: presetCharacterGif,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Text to image',
    steps: ['Prompt', 'Dreamy bot', 'Image segment'],
    estimatedWaitSeconds: 30,
  },
  {
    id: 'catalog-nova-silk',
    title: 'Nova Silk',
    prompt: 'Create a celebrity style Dreamy image with Nova Silk, strong lighting and high-detail composition.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'nova-silk',
    botId: 'nova-silk',
    articleId: 'nova-silk',
    recommendation: 'Dreamy miniapp celebrity style image generation.',
    visualUrl: '',
    fallbackVisualUrl: exampleGood,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Text to image',
    steps: ['Prompt', 'Dreamy bot', 'Image segment'],
    estimatedWaitSeconds: 30,
  },
  {
    id: 'catalog-scarlet-bloom',
    title: 'Scarlet Bloom',
    prompt: 'Create a fashion-forward Dreamy image with Scarlet Bloom, polished framing and cinematic color.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'scarlet-bloom',
    botId: 'scarlet-bloom',
    articleId: 'scarlet-bloom',
    recommendation: 'Dreamy miniapp fashion image generation.',
    visualUrl: '',
    fallbackVisualUrl: exampleSmall,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Text to image',
    steps: ['Prompt', 'Dreamy bot', 'Image segment'],
    estimatedWaitSeconds: 30,
  },
  {
    id: 'catalog-violet-haze',
    title: 'Violet Haze',
    prompt: 'Create a Dreamy category image with Violet Haze, expressive styling and a clean final composition.',
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: 'violet-haze',
    botId: 'violet-haze',
    articleId: 'violet-haze',
    recommendation: 'Dreamy miniapp category image generation.',
    visualUrl: '',
    fallbackVisualUrl: presetCinematicGif,
    previewStatus: 'catalog_ready',
    previewAccepted: true,
    previewSource: 'dreamy-catalog',
    previewLabel: 'Catalog media',
    workflow: 'Text to image',
    steps: ['Prompt', 'Dreamy bot', 'Image segment'],
    estimatedWaitSeconds: 30,
  },
];

export function rankStarterPresets(
  presets: StudioStarterPreset[],
  sourceSegment?: StudioSegment | null,
  hasReferenceImage = false,
): StudioStarterPreset[] {
  const preferredOrder =
    sourceSegment?.type === 'image'
      ? ['verified-3d-futa', 'verified-3d-anime']
      : sourceSegment?.type === 'video'
        ? ['verified-3d-futa', 'verified-3d-anime']
        : hasReferenceImage
          ? ['verified-3d-futa', 'verified-3d-anime']
          : ['verified-3d-anime', 'verified-3d-futa'];
  const order = new Map(preferredOrder.map((id, index) => [id, index]));
  return [...presets].sort((left, right) => (order.get(left.id) ?? 99) - (order.get(right.id) ?? 99));
}

export function isDreamyStudioBot(preview: StudioBotPreview): boolean {
  return preview.pageId === 'dreamy-miniapp';
}

export function getStarterPresetAction(preset: StudioStarterPreset, sourceSegment?: StudioSegment | null): StudioAction {
  if ((preset.botSlug === DREAMY_VIDEO_SLUG || preset.workflow.toLowerCase().includes('video')) && sourceSegment) return 'extend';
  return 'generate';
}

export function botTypeForStarterPreset(preset: StudioStarterPreset): string {
  return preset.workflow.toLowerCase().includes('video') ? 'image-to-video' : 'text-to-image';
}

export function getStarterPresetRunLabel(preset: StudioStarterPreset, sourceSegment?: StudioSegment | null): string {
  return getStarterPresetAction(preset, sourceSegment) === 'extend' ? 'Append segment' : 'Add segment';
}

export function verifiedWorkshopBotMatches(
  segment: StudioSegment,
  target: Partial<Pick<StudioStarterPreset, 'botSlug' | 'botId' | 'articleId' | 'title'>>,
): boolean {
  const values = [target.botSlug, target.botId, target.articleId, target.title].filter(Boolean).map((value) => String(value).toLowerCase());
  const segmentValues = [segment.botSlug, segment.botId, segment.articleId, segment.botName]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return values.some((value) => segmentValues.includes(value));
}

export function findVerifiedWorkshopSegmentForBot(
  target: Partial<Pick<StudioStarterPreset, 'botSlug' | 'botId' | 'articleId' | 'title'>>,
): StudioSegment | null {
  return VERIFIED_WORKSHOP_SEGMENTS.find((segment) => verifiedWorkshopBotMatches(segment, target)) || null;
}

export function resolveVerifiedWorkshopVisual(
  target: Partial<Pick<StudioStarterPreset, 'botSlug' | 'botId' | 'articleId' | 'title'>>,
): string {
  const segment = findVerifiedWorkshopSegmentForBot(target);
  return resolveStudioDisplayAssetUrl(segment?.posterUrl || '') || resolveStudioDisplayAssetUrl(segment?.url || '') || '';
}

export function previewLabelFor(preview?: StudioBotPreview): string {
  if (!preview) return 'Local fallback';
  if (preview.status === 'ready' && preview.accepted) {
    return preview.botSpecific ? 'Bot result' : 'MyShell result';
  }
  if (preview.status === 'catalog_ready') return 'Catalog media';
  if (preview.status === 'auth_missing' || preview.evidence?.status === 'auth_missing') return 'Needs auth';
  if (preview.status === 'needs_generation') return 'Needs refresh';
  return preview.status || 'Preview pending';
}

export function workflowForDreamyBotType(botType?: string): string {
  return (botType || '').toLowerCase().includes('video') ? 'Image to video' : 'Text to image';
}

export function stepsForDreamyBotType(botType?: string): string[] {
  return (botType || '').toLowerCase().includes('video')
    ? ['Source image', 'Motion prompt', 'Video segment']
    : ['Prompt', 'Dreamy bot', 'Image segment'];
}

export function parseManualBotEntries(value: string): ManualBotEntry[] {
  const rows = value
    .split(/\n|;/)
    .flatMap((row) => (row.includes('|') ? [row] : row.split(',')))
    .map((row) => row.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return rows.slice(0, 12).flatMap((row, index) => {
    const [rawBotId, rawName, rawType, rawSlug, rawArticleId] = row.split('|').map((part) => part.trim());
    const botId = rawBotId || '';
    const botSlug = rawSlug || botId;
    if (!botId && !botSlug) return [];
    const key = `${botId}:${botSlug}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const botType = rawType || (index === 0 ? 'text-to-image' : 'image-to-video');
    return [
      {
        id: `manual-bot-${index}-${botId || botSlug}`,
        botId,
        botSlug,
        botName: rawName || `Manual Bot ${index + 1}`,
        botType,
        articleId: rawArticleId || botSlug || botId,
        action: index === 0 ? 'generate' : 'extend',
      },
    ];
  });
}

export function starterPresetFromBotPreview(preview: StudioBotPreview): StudioStarterPreset {
  const botType = preview.botType || '';
  const fallbackVisualUrl = fallbackVisualForDreamyBot(preview.botSlug, preview.botName);
  const verifiedVisualUrl = resolveVerifiedWorkshopVisual({
    botSlug: preview.botSlug,
    botId: preview.botId,
    articleId: preview.articleId,
    title: preview.botName,
  });
  const imageUrl = verifiedVisualUrl || resolveStudioDisplayAssetUrl(preview.thumbnailUrl || preview.posterUrl || preview.mediaUrl) || fallbackVisualUrl;
  const verifiedSegment = findVerifiedWorkshopSegmentForBot({
    botSlug: preview.botSlug,
    botId: preview.botId,
    articleId: preview.articleId,
    title: preview.botName,
  });
  const isVideo = botType.toLowerCase().includes('video');
  return {
    id: `dreamy-bot-${preview.botSlug}`,
    title: preview.botName,
    prompt: isVideo
      ? `Animate the selected Dreamy source image with ${preview.botName}, preserving character continuity and cinematic motion.`
      : `Create a polished Dreamy image with ${preview.botName}, cinematic lighting, clear subject, and production-ready composition.`,
    pageId: 'dreamy-miniapp',
    pageName: 'Dreamy Miniapp',
    agentId: DEFAULT_STUDIO_AGENT_ID,
    botSlug: preview.botSlug,
    botId: preview.botId || verifiedSegment?.botId,
    articleId: preview.articleId || verifiedSegment?.articleId || preview.botSlug,
    recommendation: preview.generatedPrompt || preview.evidence?.message || `Run ${preview.botName} through the Dreamy miniapp.`,
    visualUrl: imageUrl,
    fallbackVisualUrl,
    previewStatus: verifiedSegment ? 'done' : preview.status,
    previewAccepted: Boolean(verifiedSegment || preview.botSpecific || preview.mediaUrl || preview.thumbnailUrl || preview.posterUrl),
    previewSource: verifiedSegment ? 'dreamyporn-workshop-web' : preview.source || 'dreamy-catalog',
    previewLabel: verifiedSegment ? 'Verified result' : previewLabelFor(preview),
    workflow: workflowForDreamyBotType(botType),
    steps: stepsForDreamyBotType(botType),
    estimatedWaitSeconds: isVideo ? 60 : 30,
  };
}

export function hydrateStarterPresets(
  presets: StudioStarterPreset[],
  previewsResponse: StudioBotPreviewsResponse | null,
): StudioStarterPreset[] {
  if (!previewsResponse?.previews?.length) return presets;
  const previewBySlug = new Map(previewsResponse.previews.map((preview) => [preview.botSlug, preview]));
  return presets.map((preset) => {
    const manifestStarter = previewsResponse.starterPresets?.[preset.id];
    const manifestPreview = manifestStarter?.botSlug ? previewBySlug.get(manifestStarter.botSlug) : undefined;
    const previewSlug = manifestPreview && isDreamyStudioBot(manifestPreview) ? manifestStarter?.botSlug || preset.botSlug : preset.botSlug;
    const preview = previewBySlug.get(previewSlug);
    const verifiedSegment = findVerifiedWorkshopSegmentForBot({
      botSlug: previewSlug,
      botId: preview?.botId || preset.botId,
      articleId: preview?.articleId || preset.articleId,
      title: preview?.botName || preset.title,
    });
    const previewMedia =
      resolveStudioDisplayAssetUrl(verifiedSegment?.posterUrl || '') ||
      resolveStudioDisplayAssetUrl(preview?.thumbnailUrl || preview?.posterUrl || preview?.mediaUrl);
    const visualUrl = previewMedia || preset.visualUrl || preset.fallbackVisualUrl;
    return {
      ...preset,
      botSlug: previewSlug,
      botId: preview?.botId || verifiedSegment?.botId || preset.botId,
      articleId: preview?.articleId || verifiedSegment?.articleId || preset.articleId,
      visualUrl,
      previewStatus: verifiedSegment ? 'done' : preview?.status || preset.previewStatus,
      previewAccepted: Boolean(verifiedSegment || (preview ? preview.accepted : preset.previewAccepted)),
      previewSource: verifiedSegment ? 'dreamyporn-workshop-web' : preview?.source || preset.previewSource,
      previewLabel: verifiedSegment ? 'Verified result' : preview ? previewLabelFor(preview) : preset.previewLabel,
    };
  });
}

export function isTransientStudioStatus(status?: string): boolean {
  return Boolean(status && TRANSIENT_STUDIO_STATUSES.has(status));
}
