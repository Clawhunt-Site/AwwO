import { createProviderObserver } from './usage.mjs';
// This fixed, trusted entrypoint is forked once per run by runner.mjs.
// Provider credentials arrive over private IPC, never in argv or global env.
import { createHash } from 'node:crypto';
let activeSession;
let cancelled = false;
const controller = new AbortController();
let started = false;
// Provider reasoning is reported as a count, never its text, and at most this often:
// a reader needs to see that the model is working, not each token of its scratchpad.
const REASONING_REPORT_MS = 500;

function codePoints(text) {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function emit(event) {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(event, () => resolve());
  });
}

async function cancel() {
  cancelled = true;
  controller.abort();
  if (activeSession) {
    activeSession.clearQueue();
    await activeSession.abort();
  }
}

async function run({ request, modelConfig, directory, agentDir, acceptedAtNs }) {
  let unsubscribe;
  const bedrock = modelConfig.provider === 'bedrock';
  let observer = createProviderObserver(modelConfig.protocol === 'anthropic_messages' ? 'anthropic' : 'chat_completions', { acceptedAtNs });
  const terminal = event => emit({ ...event, observability: observer.snapshot(event.type) });
  let bridgeKey;
  try {
    if (bedrock) {
      // Bedrock is served through the Converse bridge, which answers Pi's OpenAI-compatible
      // request itself; the key Pi attaches is only a placeholder the bridge ignores. Loaded
      // only for Bedrock runs, so other children never pay for the TypeScript module.
      const [{ BEDROCK_BRIDGE_API_KEY, createBedrockFetch }, sdk] = await Promise.all([import('../bedrock-bridge.ts'), import('@aws-sdk/client-bedrock-runtime')]);
      const fetchImpl = createBedrockFetch({ region: modelConfig.region, model: modelConfig.model, auth: modelConfig.bedrockAuth, sdk });
      observer = createProviderObserver('chat_completions', { acceptedAtNs, fetchImpl });
      bridgeKey = BEDROCK_BRIDGE_API_KEY;
    }
    const [{ InMemoryCredentialStore }, { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager }] = await Promise.all([
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-coding-agent'),
    ]);
    if (cancelled) return await terminal({ type: 'cancelled' });
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal: controller.signal,
    });
    const providerId = 'awwo-configured';
    const api = modelConfig.protocol === 'anthropic_messages' ? 'anthropic-messages' : 'openai-completions';
    modelRuntime.registerProvider(providerId, {
      name: 'AWWO configured model',
      baseUrl: modelConfig.baseURL,
      api,
      authHeader: true,
      models: [{
        id: modelConfig.model,
        name: modelConfig.model,
        reasoning: false,
        input: ['text'],
        // No pricing claim: this adapter does not expose calculated charges.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: modelConfig.contextWindow,
        maxTokens: modelConfig.maxTokens,
        ...(api === 'openai-completions' ? { compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          ...(modelConfig.provider === 'ollama' ? { maxTokensField: 'max_tokens' } : {}),
        } } : {}),
      }],
    });
    await modelRuntime.setRuntimeApiKey(providerId, bedrock ? bridgeKey : modelConfig.apiKey || 'ollama-local', { signal: controller.signal });
    const model = modelRuntime.getModel(providerId, modelConfig.model);
    if (!model) throw new Error('Configured model unavailable');
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
      defaultProjectTrust: 'never',
    });
    const systemPrompt = request.systemPrompt?.trim() || 'You are a helpful assistant. Answer the user accurately. You have no tools or access to files, shell commands, or private application data.';
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const piSessionId = createHash('sha256').update(`${request.tenantId}\0${request.sessionId}`).digest('hex');
    const sessionManager = SessionManager.inMemory(directory, { id: piSessionId });
    for (const [index, message] of request.messages.entries()) {
      const timestamp = Date.now() - request.messages.length + index;
      if (message.role === 'user') sessionManager.appendMessage({ role: 'user', content: message.content, timestamp });
      else sessionManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: message.content }],
        api: model.api, provider: model.provider, model: model.id,
        // Historical text has no provider usage record; these values are not billed.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp,
      });
    }
    const result = await createAgentSession({
      cwd: directory, agentDir, modelRuntime, model, settingsManager,
      sessionManager, resourceLoader,
      thinkingLevel: 'off', noTools: 'all', tools: [], customTools: [],
    });
    activeSession = result.session;
    // Pi's coding prompt appends cwd even with a custom prompt. The public
    // streamFunction hook keeps this application-only context free of local paths,
    // while retaining Pi's authenticated model stream and agent lifecycle.
    const piStream = activeSession.agent.streamFunction;
    // Pi's provider adapter retries only transport errors and HTTP 408/409/429/5xx
    // before a response stream begins. One bounded Gate retry covers cold egress
    // failures without replaying an answer already streamed to the caller.
    activeSession.agent.streamFunction = (selectedModel, context, options) => piStream(selectedModel, { ...context, systemPrompt }, {
      ...options, maxRetries: modelConfig.provider === 'llmgate' ? 1 : 0,
      maxRetryDelayMs: 2_000, fetch: observer.fetch,
    });
    if (activeSession.agent.state.tools.length !== 0) throw new Error('Unexpected tools enabled');
    if (cancelled) { await cancel(); return await terminal({ type: 'cancelled' }); }
    let text = '';
    let finalMessage;
    let forbiddenTool = false;
    let eventQueue = Promise.resolve();
    let reasoningCharacters = 0;
    let reasoningStarted = false;
    let reportedReasoning = -1;
    let reportedAt = 0;
    // Nothing is reported for a model that never reasons: a count of zero would tell the
    // reader it is thinking when it is simply answering.
    const reportReasoning = (force) => {
      if (!reasoningStarted || reasoningCharacters === reportedReasoning) return;
      const now = Date.now();
      if (!force && now - reportedAt < REASONING_REPORT_MS) return;
      reportedReasoning = reasoningCharacters;
      reportedAt = now;
      const characters = reasoningCharacters;
      eventQueue = eventQueue.then(() => emit({ type: 'reasoning', characters }));
    };
    unsubscribe = activeSession.subscribe((event) => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        // A start is reported at once, even with nothing counted yet: that the model
        // began reasoning is itself the fact a waiting reader lacks.
        if (update.type === 'thinking_start') {
          reasoningStarted = true;
          reportReasoning(true);
        } else if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
          reasoningStarted = true;
          reasoningCharacters += codePoints(update.delta);
          reportReasoning(false);
        } else if (update.type === 'text_delta') {
          // The last coalesced count goes out before the answer it preceded.
          reportReasoning(true);
          const delta = update.delta;
          text += delta;
          eventQueue = eventQueue.then(() => emit({ type: 'text_delta', delta }));
        }
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        finalMessage = event.message;
        if (event.message.content.some((part) => part.type === 'toolCall')) {
          forbiddenTool = true;
          void cancel();
        }
      }
    });
    await activeSession.prompt(request.prompt, { expandPromptTemplates: false });
    await eventQueue;
    if (forbiddenTool) return await terminal({ type: 'failed', code: 'TOOLS_DISABLED', message: 'Tool execution is disabled.' });
    if (cancelled || finalMessage?.stopReason === 'aborted') return await terminal({ type: 'cancelled' });
    if (!finalMessage || finalMessage.stopReason !== 'stop') throw new Error('Model did not complete successfully');
    text = finalMessage.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    if (!text.trim()) throw new Error('Model returned no answer');
    await terminal({ type: 'completed', text });
  } catch {
    await terminal(cancelled ? { type: 'cancelled' } : { type: 'failed', code: 'MODEL_ERROR', message: 'The model request failed. Check the server provider configuration.' });
  } finally {
    unsubscribe?.();
    activeSession?.dispose();
    activeSession = undefined;
  }
}

process.on('message', (message) => {
  if (message?.type === 'cancel') { void cancel(); return; }
  if (message?.type !== 'run' || started) return;
  started = true;
  void run(message).finally(() => process.exit(0));
});
process.on('disconnect', () => { void cancel().finally(() => process.exit(0)); });
