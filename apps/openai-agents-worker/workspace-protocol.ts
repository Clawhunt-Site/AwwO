import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const WORKSPACE_BODY_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_TOOL_NAMES = ['workspace_list', 'workspace_read', 'workspace_write', 'workspace_exec', 'workspace_publish', 'workspace_archive'] as const;
export type WorkspaceToolName = typeof WORKSPACE_TOOL_NAMES[number];
export type OutputField = { id: string; type: 'text' | 'markdown' | 'html' | 'file' | 'number' | 'boolean'; required: boolean };
export type WorkspaceFile = { name: string; content: string; encoding: 'base64'; sha256: string; sourceNodeId?: string; fieldId?: string };
export interface WorkspaceRequest {
  version: 1; id: string; maxModelCalls: number; callbackURL: string; callbackToken: string;
  inputs: WorkspaceFile[]; outputFields: OutputField[]; snapshot?: WorkspaceFile;
}
export interface WorkspaceConfig {
  dockerExecutable: string; image: string; callbackURL: string; maxModelCalls: number;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const FIELD_TYPES = new Set(['text', 'markdown', 'html', 'file', 'number', 'boolean']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', '__workspace_snapshot']);
export function validCallbackURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && !!url.port && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && url.pathname === '/api/internal/workspace-calls' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function loadWorkspaceConfig(env: Record<string, string | undefined>): WorkspaceConfig | undefined {
  const image = env.AWWO_OPENAI_AGENTS_WORKSPACE_IMAGE;
  if (!image) return undefined;
  const dockerExecutable = env.AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER || '/usr/bin/docker';
  const callbackURL = env.AWWO_OPENAI_AGENTS_WORKSPACE_CALLBACK_URL || '';
  const rawCalls = env.AWWO_OPENAI_AGENTS_WORKSPACE_MAX_CALLS || '16';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/.test(image) || !isAbsolute(dockerExecutable)
    || /[\u0000-\u001f]/.test(dockerExecutable) || !validCallbackURL(callbackURL)
    || !/^\d+$/.test(rawCalls) || Number(rawCalls) < 2 || Number(rawCalls) > 16) throw new Error('Invalid workspace execution configuration');
  return Object.freeze({ image, dockerExecutable, callbackURL, maxModelCalls: Number(rawCalls) });
}
function validFile(value: unknown): value is WorkspaceFile {
  if (!object(value) || typeof value.name !== 'string' || !value.name || value.name.length > 200
    || /[\\/\u0000-\u001f\u007f]/.test(value.name) || ['.', '..'].includes(value.name)
    || value.encoding !== 'base64' || typeof value.content !== 'string' || value.content.length > Math.ceil(WORKSPACE_FILE_BYTES / 3) * 4
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  const bytes = Buffer.from(value.content, 'base64');
  return bytes.length <= WORKSPACE_FILE_BYTES && bytes.toString('base64') === value.content
    && createHash('sha256').update(bytes).digest('hex') === value.sha256;
}
export function validateWorkspaceRequest(value: unknown): asserts value is WorkspaceRequest {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)
    || !Number.isInteger(value.maxModelCalls) || Number(value.maxModelCalls) < 2 || Number(value.maxModelCalls) > 16
    || typeof value.callbackURL !== 'string' || !validCallbackURL(value.callbackURL)
    || typeof value.callbackToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.callbackToken)
    || !Array.isArray(value.inputs) || value.inputs.length > 32 || !value.inputs.every(validFile)
    || value.inputs.reduce((sum, file) => sum + Buffer.from(file.content, 'base64').length, 0) > 8 * 1024 * 1024
    || !Array.isArray(value.outputFields) || value.outputFields.length > 32
    || (value.snapshot !== undefined && !validFile(value.snapshot))) throw new Error('Invalid workspace request');
  const ids = new Set<string>();
  for (const field of value.outputFields) {
    if (!object(field) || typeof field.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(field.id) || RESERVED.has(field.id) || ids.has(field.id)
      || typeof field.type !== 'string' || !FIELD_TYPES.has(field.type) || typeof field.required !== 'boolean') throw new Error('Invalid workspace output fields');
    ids.add(field.id);
  }
}
export function authorizeWorkspace(config: WorkspaceConfig | undefined, request: { workspace?: unknown; tools?: string[]; outputContract?: unknown }): void {
  if (request.workspace === undefined) return;
  validateWorkspaceRequest(request.workspace);
  if (!config || request.workspace.callbackURL !== config.callbackURL || request.workspace.maxModelCalls > config.maxModelCalls
    || request.outputContract !== undefined || (request.tools?.length ?? 0) > 0) throw new Error('Workspace execution is not enabled');
}
