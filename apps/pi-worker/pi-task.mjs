// This fixed, trusted entrypoint is forked once per run by runner.mjs.
// Provider credentials arrive over private IPC, never in argv or global env.
import { createHash } from 'node:crypto';
let activeSession;
let cancelled = false;
const controller = new AbortController();
let started = false;

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

async function run({ request, modelConfig, directory, agentDir }) {
  let unsubscribe;
  try {
    const [{ InMemoryCredentialStore }, { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager }] = await Promise.all([
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-coding-agent'),
    ]);
    if (cancelled) return await emit({ type: 'cancelled' });
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal: controller.signal,
    });
    const providerId = 'awwo-configured';
    const api = modelConfig.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
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
    await modelRuntime.setRuntimeApiKey(providerId, modelConfig.apiKey || 'ollama-local', { signal: controller.signal });
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
    activeSession.agent.streamFunction = (selectedModel, context, options) => piStream(selectedModel, { ...context, systemPrompt }, { ...options, maxRetries: 0 });
    if (activeSession.agent.state.tools.length !== 0) throw new Error('Unexpected tools enabled');
    if (cancelled) { await cancel(); return await emit({ type: 'cancelled' }); }
    let text = '';
    let finalMessage;
    let forbiddenTool = false;
    let eventQueue = Promise.resolve();
    unsubscribe = activeSession.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta;
        text += delta;
        eventQueue = eventQueue.then(() => emit({ type: 'text_delta', delta }));
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
    if (forbiddenTool) return await emit({ type: 'failed', code: 'TOOLS_DISABLED', message: 'Tool execution is disabled.' });
    if (cancelled || finalMessage?.stopReason === 'aborted') return await emit({ type: 'cancelled' });
    if (!finalMessage || finalMessage.stopReason !== 'stop') throw new Error('Model did not complete successfully');
    text = finalMessage.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    if (!text.trim()) throw new Error('Model returned no answer');
    await emit({ type: 'completed', text });
  } catch {
    await emit(cancelled ? { type: 'cancelled' } : { type: 'failed', code: 'MODEL_ERROR', message: 'The model request failed. Check the server provider configuration.' });
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
