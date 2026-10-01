import type { WorkspaceBroker } from './workspace-runtime.ts';
import { WORKSPACE_TOOL_NAMES, type WorkspaceToolName } from './workspace-protocol.ts';
import type { WorkspaceSandbox } from './workspace-sandbox.ts';

/** Trusted child talks to its supervisor. No Docker handle or host path enters model context. */
export function childWorkspaceBroker(signal: AbortSignal): { call: WorkspaceBroker; close: () => void } {
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const close = () => {
    process.off('message', receive); signal.removeEventListener('abort', close);
    for (const item of pending.values()) item.reject(new Error('Workspace broker disconnected'));
    pending.clear();
  };
  const receive = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'workspace_result'
      || !('sequence' in value) || typeof value.sequence !== 'number' || !('ok' in value) || typeof value.ok !== 'boolean') return;
    const item = pending.get(value.sequence);
    if (!item) return;
    pending.delete(value.sequence);
    if (value.ok) item.resolve('result' in value ? value.result : undefined); else item.reject(new Error('Workspace operation failed'));
  };
  process.on('message', receive); signal.addEventListener('abort', close, { once: true });
  return { close, call: async (name, args) => {
    signal.throwIfAborted();
    if (!process.connected || !process.send || pending.size) throw new Error('Workspace broker unavailable');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      process.send!({ type: 'workspace_call', sequence: id, name, args }, undefined, undefined, (error: Error | null) => {
        if (error) { pending.delete(id); reject(new Error('Workspace broker unavailable')); }
      });
    });
  } };
}

export async function dispatchWorkspaceTool(sandbox: WorkspaceSandbox, name: WorkspaceToolName | 'snapshot', args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'workspace_list': return sandbox.list(String(args.path));
    case 'workspace_read': return sandbox.read(String(args.path));
    case 'workspace_write': return sandbox.write(String(args.path), String(args.content));
    case 'workspace_exec': return sandbox.exec(String(args.command));
    case 'workspace_publish': return sandbox.publish(String(args.path));
    case 'workspace_archive': case 'snapshot': return sandbox.archive();
    default: throw new Error('Unknown workspace operation');
  }
}
export function validWorkspaceCall(value: unknown): value is { type: 'workspace_call'; sequence: number; name: WorkspaceToolName | 'snapshot'; args: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'workspace_call' && Number.isSafeInteger(message.sequence) && Number(message.sequence) > 0
    && [...WORKSPACE_TOOL_NAMES, 'snapshot'].includes(String(message.name))
    && !!message.args && typeof message.args === 'object' && !Array.isArray(message.args)
    && Buffer.byteLength(JSON.stringify(message.args)) <= 2 * 1024 * 1024;
}
