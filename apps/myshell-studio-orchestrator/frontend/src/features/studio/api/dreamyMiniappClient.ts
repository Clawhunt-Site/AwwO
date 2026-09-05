import {
  fetchBotDetail,
  fetchGenerateResult,
  fetchLibraryAll,
  fetchTaskRunning,
  generate,
  uploadImage,
} from '../../../services/api';
import type { GenerateResultResponse } from '../../../types';
import type { DreamyMiniappJobInput, DreamyMiniappJobResult, MonitorSnapshot } from './studioContracts';

export async function submitDreamyMiniappJob({
  slugId,
  botId,
  articleId,
  prompt,
  imageFile,
  imageUrl,
}: DreamyMiniappJobInput): Promise<DreamyMiniappJobResult> {
  const lookupSlug = slugId || articleId || botId || '';
  const detail = botId ? null : await fetchBotDetail(lookupSlug);
  const resolvedBotId = botId || detail?.info?.botId || lookupSlug;
  const resolvedArticleId = articleId || detail?.info?.slugId || lookupSlug || resolvedBotId;
  if (!resolvedBotId) throw new Error('Dreamy bot id is required');
  const uploadedImageUrl = imageFile ? await uploadImage(imageFile) : imageUrl;
  const inputImg = uploadedImageUrl ? [uploadedImageUrl, prompt] : [prompt];
  const response = await generate(resolvedBotId, inputImg, resolvedArticleId);
  return {
    uploadedImageUrl,
    botId: resolvedBotId,
    articleId: resolvedArticleId,
    response,
  };
}

export async function readDreamyMonitorSnapshot(taskId?: string): Promise<MonitorSnapshot> {
  const [runningState, libraryState, taskState] = await Promise.all([
    fetchTaskRunning().catch(() => ({ running: false })),
    fetchLibraryAll().catch(() => ({ generateResults: [] })),
    taskId ? fetchGenerateResult(taskId).catch(() => null) : Promise.resolve(null),
  ]);

  const latest = libraryState.generateResults[0];
  const task = taskState?.tasks?.[0];
  return {
    running: Boolean(runningState.running),
    libraryCount: libraryState.generateResults.length,
    latestTaskId: task?.jobId || latest?.taskId,
    latestStatus: task?.status || latest?.status,
    latestBotName: task?.botName || latest?.botName,
    latestPreview: latest?.result?.outputPreview || latest?.result?.outputImg,
  };
}

export function extractGenerateTaskMedia(result: GenerateResultResponse | null | undefined): {
  url?: string;
  posterUrl?: string;
  status?: string;
} {
  const task = result?.tasks?.[0];
  if (!task) return {};
  try {
    const parsed = typeof task.result === 'string' ? JSON.parse(task.result) : task.result;
    const outputImg = parsed?.outputImg || parsed?.output_img;
    const outputPreview = parsed?.outputPreview || parsed?.output_preview;
    const outputPoster = parsed?.outputPoster || parsed?.output_poster;
    return {
      url: outputImg || outputPreview,
      posterUrl: outputPoster || outputPreview || outputImg,
      status: task.status,
    };
  } catch {
    return { status: task.status };
  }
}
