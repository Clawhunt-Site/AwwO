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
  const observer = createProviderObserver(message.modelConfig.protocol, { acceptedAtNs: message.acceptedAtNs });
  const terminal = event => emit({ ...event, observability: observer.snapshot(event.type) });
  try {
    if (controller.signal.aborted) return await terminal({ type: 'cancelled' });
    if (message.request.workspace) {
      const broker = childWorkspaceBroker(controller.signal);
      try { await executeWorkspaceAgent({ request: message.request, modelConfig: message.modelConfig, signal: controller.signal, emit, broker: broker.call }); }
      finally { broker.close(); }
    } else await executeAgent({ request: message.request, modelConfig: message.modelConfig, signal: controller.signal, emit, observer });
  } catch (error) {
    await terminal(controller.signal.aborted ? { type: 'cancelled' } : { ...classifyError(error), diagnostic: errorDiagnostic(error) });
  } finally {
    process.disconnect?.();
  }
});
process.on('disconnect', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
