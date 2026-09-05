import type { OrchestratorEvent, StreamOrchestratorOptions, StreamStudioRunOptions, StudioRunEvent } from './studioContracts';
import { getOrchestratorChatEndpoint, getStudioRunEndpoint } from './endpointPaths';
import { readSse } from './sse';

export async function streamArtOrchestrator({
  message,
  imageFile,
  conversationId,
  signal,
  onEvent,
}: StreamOrchestratorOptions): Promise<string | null> {
  const formData = new FormData();
  formData.append('message', message);
  if (conversationId) formData.append('conversation_id', conversationId);
  if (imageFile) formData.append('image', imageFile);

  const response = await fetch(getOrchestratorChatEndpoint(), {
    method: 'POST',
    body: formData,
    signal,
  });

  let resolvedConversationId = conversationId ?? null;

  await readSse<OrchestratorEvent>({
    response,
    onEvent: (parsed, eventName) => {
      if (parsed.conversation_id) resolvedConversationId = parsed.conversation_id;
      onEvent(parsed, eventName);
    },
  });
  return resolvedConversationId;
}

export async function streamStudioRun({
  message,
  mode,
  action,
  projectId,
  sourceSegmentId,
  pageId,
  agentId,
  botSlug,
  botId,
  articleId,
  botName,
  botType,
  botSequence,
  agentGraph,
  imageFile,
  signal,
  onEvent,
}: StreamStudioRunOptions): Promise<void> {
  const formData = new FormData();
  formData.append('message', message);
  formData.append('mode', mode);
  formData.append('action', action);
  if (projectId) formData.append('project_id', projectId);
  if (sourceSegmentId) formData.append('source_segment_id', sourceSegmentId);
  if (pageId) formData.append('page_id', pageId);
  if (agentId) formData.append('agent_id', agentId);
  if (botId) formData.append('bot_id', botId);
  if (articleId) formData.append('article_id', articleId);
  if (botSlug) formData.append('bot_slug', botSlug);
  if (botName) formData.append('bot_name', botName);
  if (botType) formData.append('bot_type', botType);
  if (botSequence?.length) formData.append('bot_sequence', JSON.stringify(botSequence));
  if (agentGraph) formData.append('agent_graph', JSON.stringify(agentGraph));
  if (imageFile) formData.append('image', imageFile);

  const response = await fetch(getStudioRunEndpoint(), {
    method: 'POST',
    body: formData,
    signal,
  });
  await readSse<StudioRunEvent>({ response, onEvent });
}
