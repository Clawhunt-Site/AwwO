import { createProviderObserver } from './usage.mjs';
// One trusted task per child, credentials only over IPC. No file-backed sessions.
import { executeWorkspaceAgent } from './workspace-runtime.ts';
import { childWorkspaceBroker } from './workspace-rpc.ts';
import { executeAgent } from './agent-runtime.mjs';
import { classifyError, errorDiagnostic } from './errors.mjs';
const controller = new AbortController();
let started = false;
function emit(event) {
  return new Promise(resolve => {
    if (!process.connected) return resolve();
    process.send(event, () => resolve());
  });
}
process.on('message', async message => {
  if (message?.type === 'cancel') { controller.abort(); return; }
  if (started || message?.type !== 'run') return;
  started = true;
  let modelConfig = message.modelConfig;
  let modelFetch;
  let observer = createProviderObserver(modelConfig.protocol, { acceptedAtNs: message.acceptedAtNs });
  const terminal = event => emit({ ...event, observability: observer.snapshot(event.type) });
  try {
    if (modelConfig.provider === 'bedrock') {
      // Bedrock is served through the Converse bridge, which answers the pinned
      // Chat Completions URL itself; the OpenAI SDK key is only a placeholder.
      // Loaded only for Bedrock runs, so other children never load the AWS SDK.
      const [{ BEDROCK_BRIDGE_API_KEY, createBedrockFetch }, sdk] = await Promise.all([import('../bedrock-bridge.ts'), import('@aws-sdk/client-bedrock-runtime')]);
      modelFetch = createBedrockFetch({ region: modelConfig.region, model: modelConfig.model, auth: modelConfig.bedrockAuth, sdk });
      modelConfig = { ...modelConfig, apiKey: BEDROCK_BRIDGE_API_KEY, bedrockAuth: undefined };
      observer = createProviderObserver(modelConfig.protocol, { acceptedAtNs: message.acceptedAtNs, fetchImpl: modelFetch });
    }
    if (controller.signal.aborted) return await terminal({ type: 'cancelled' });
    if (message.request.workspace) {
      const broker = childWorkspaceBroker(controller.signal);
      try { await executeWorkspaceAgent({ request: message.request, modelConfig, signal: controller.signal, emit, broker: broker.call, modelFetch }); }
      finally { broker.close(); }
    } else await executeAgent({ request: message.request, modelConfig, signal: controller.signal, emit, observer });
  } catch (error) {
    await terminal(controller.signal.aborted ? { type: 'cancelled' } : { ...classifyError(error), diagnostic: errorDiagnostic(error) });
  } finally {
    process.disconnect?.();
  }
});
process.on('disconnect', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
