import { record } from './protocol.ts';

const PROXY_CODES = new Set([
  'context_limit', 'invalid_completion', 'invalid_completion_field', 'invalid_completion_messages', 'invalid_completion_role',
  'invalid_completion_tools', 'invalid_completion_tool', 'invalid_completion_content', 'invalid_completion_stream', 'invalid_completion_limit',
  'computer_lease_invalid', 'computer_lease_unavailable', 'computer_admission_denied', 'computer_accounting_failed',
  'computer_connection_unavailable', 'computer_model_unavailable', 'computer_model_transport', 'computer_model_failed', 'computer_model_protocol',
  'RUNTIME_UNAVAILABLE', 'INVALID_CONTENT_TYPE', 'INVALID_INPUT', 'MODEL_NOT_FOUND', 'EFFORT_NOT_SUPPORTED', 'CONTEXT_LIMIT',
  'RUN_BUSY', 'SESSION_BUSY', 'CAPACITY_EXCEEDED', 'PROVIDER_ERROR', 'CANCELLED',
]);
export function proxyErrorCode(value: unknown): string {
  const code = record(value) && record(value.error) ? value.error.code : undefined;
  return typeof code === 'string' && PROXY_CODES.has(code) ? code : 'MODEL_PROXY_REJECTED';
}
/** Never log messages, tool arguments, URLs, headers, credentials, provider bodies or stacks. */
export type RuntimeStage = 'sandbox' | 'core_health' | 'pairing' | 'create_bot' | 'create_task' | 'send' | 'poll' | 'cleanup';
const ERROR_NAMES = new Set(['TypeError', 'AbortError', 'TimeoutError', 'Error']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
export function safeFailureDetails(error: unknown): { errorName: string; reason: string } {
  const name = error instanceof Error ? error.name : undefined;
  const cause = error instanceof Error && record(error.cause) ? error.cause : undefined;
  const code = cause?.code ?? (record(error) ? error.code : undefined);
  return { errorName: typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'Error',
    reason: typeof code === 'string' && NETWORK_CODES.has(code) ? code : name === 'SyntaxError' ? 'INVALID_UPSTREAM_JSON' : name === 'TimeoutError' ? 'DEADLINE_EXCEEDED' : name === 'AbortError' ? 'OPERATION_ABORTED' : 'UNCLASSIFIED' };
}
export function diagnostic(event: 'run_failed' | 'model_proxy_rejected', runId: string, code: string, status?: number, detail?: { stage: RuntimeStage; errorName: string; reason: string }) {
  console.error(JSON.stringify({ service: 'awwo-openmaus-worker', event, runId, code, ...(Number.isInteger(status) ? { status } : {}), ...detail }));
}
