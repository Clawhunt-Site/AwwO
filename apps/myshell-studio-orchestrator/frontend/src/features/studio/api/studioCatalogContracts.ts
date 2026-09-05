import type { StudioApi } from './studioDispatchLinks';
import type { StudioEvidence, StudioStatus } from './studioBaseContracts';

export interface StudioBotPreview {
  botSlug: string;
  botId?: string;
  articleId?: string;
  botName: string;
  botType?: string;
  pageId?: StudioApi | string;
  status: 'ready' | 'needs_generation' | StudioStatus | string;
  accepted: boolean;
  mediaUrl?: string;
  thumbnailUrl?: string;
  posterUrl?: string;
  assetId?: string;
  source?: string;
  sourceWidgetId?: string;
  sourceWidgetName?: string;
  originalRemoteUrl?: string;
  generatedPrompt?: string;
  checkedAt?: string;
  previewKind?: string;
  botSpecific?: boolean;
  targetBotExecuted?: boolean;
  floorUrl?: string;
  message?: string;
  evidence?: StudioEvidence;
}

export interface StudioBotPreviewsResponse {
  version: string;
  source: string;
  generatedAt?: string;
  checkedAt: string;
  manifestPath?: string;
  dreamyCatalogSource?: string;
  dreamyCatalogReady?: boolean;
  summary: {
    total: number;
    ready: number;
    needsGeneration: number;
    botSpecific?: number;
    representative?: number;
    targetBotExecuted?: number;
    assets: number;
    dreamyBots: number;
    artBots: number;
  };
  assets: Array<Record<string, unknown>>;
  starterPresets: Record<string, { botSlug?: string; assetId?: string }>;
  previews: StudioBotPreview[];
}
