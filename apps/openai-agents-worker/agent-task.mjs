// One trusted task per child, credentials only over IPC. No file-backed sessions.
import { executeAgent } from './agent-runtime.mjs';
import { classifyError } from './errors.mjs';
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
  try {
    if (controller.signal.aborted) return await emit({ type: 'cancelled' });
    await executeAgent({ request: message.request, modelConfig: message.modelConfig, signal: controller.signal, emit });
  } catch (error) {
    await emit(controller.signal.aborted ? { type: 'cancelled' } : classifyError(error));
  } finally {
    process.disconnect?.();
  }
});
process.on('disconnect', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
