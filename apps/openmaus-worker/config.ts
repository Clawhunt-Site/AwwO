import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_REVISION, PATCH_VERSION } from './setup.ts';
import type { WorkspaceSandboxConfig } from '../openai-agents-worker/workspace-sandbox.ts';

export const WORKER_DIR = dirname(fileURLToPath(import.meta.url));
export type WorkerConfig = { token: string; host: string; port: number; maxConcurrent: number; corePath: string; dataRoot: string; proxyOrigins: Set<string>; sandbox: WorkspaceSandboxConfig };
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const token = env.AWWO_OPENMAUS_TOKEN || '';
  if (token.length < 32 || /[\r\n]/.test(token)) throw new Error('AWWO_OPENMAUS_TOKEN must contain at least 32 characters');
  const port = Number(env.AWWO_OPENMAUS_PORT || 8099), maxConcurrent = Number(env.AWWO_OPENMAUS_MAX_CONCURRENT || 2);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid worker limits');
  const corePath = env.AWWO_OPENMAUS_CORE_PATH || join(WORKER_DIR, '.runtime/core/dist-server/index.js');
  const dataRoot = env.AWWO_OPENMAUS_DATA_DIR || join(WORKER_DIR, '.runs');
  const dockerExecutable = env.AWWO_OPENMAUS_DOCKER || env.AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER || '/usr/bin/docker';
  if (![corePath, dataRoot, dockerExecutable].every(isAbsolute)) throw new Error('Runtime and Docker paths must be absolute');
  const proxyOrigins = new Set((env.AWWO_OPENMAUS_MODEL_PROXY_ORIGINS || '').split(',').filter(Boolean).map(value => new URL(value.trim()).origin));
  return { token, host: env.AWWO_OPENMAUS_HOST || '127.0.0.1', port, maxConcurrent, corePath, dataRoot, proxyOrigins,
    sandbox: { dockerExecutable, image: env.AWWO_OPENMAUS_WORKSPACE_IMAGE || env.AWWO_OPENAI_AGENTS_WORKSPACE_IMAGE || 'awwo-workspace:20261001', dockerContext: env.AWWO_OPENMAUS_DOCKER_CONTEXT || env.AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER_CONTEXT, commandTimeoutMs: 30_000 } };
}
export function coreInstalled(config: WorkerConfig): boolean {
  try { const build = JSON.parse(readFileSync(join(dirname(config.corePath), 'awwo-build.json'), 'utf8')); return build.upstreamRevision === UPSTREAM_REVISION && build.patchVersion === PATCH_VERSION && readFileSync(config.corePath).length > 1000; } catch { return false; }
}
