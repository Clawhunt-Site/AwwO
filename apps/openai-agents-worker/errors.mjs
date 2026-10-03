const MESSAGES = Object.freeze({
  WORKSPACE_UNAVAILABLE: 'The isolated project workspace is unavailable.',
  WORKSPACE_ADMISSION_FAILED: 'The next model call could not be authorized or recorded.',
  WORKSPACE_FILE_INVALID: 'The project file could not be verified for delivery.',
  WORKSPACE_CONTEXT_LIMIT: 'The project context exceeds the configured model budget.',
  MODEL_AUTHENTICATION: 'The model service rejected its configured credentials.',
  MODEL_RATE_LIMIT: 'The model service is rate limited.',
  MODEL_UNAVAILABLE: 'The model service is unavailable.',
  MODEL_REQUEST_REJECTED: 'The model service rejected the request.',
  MODEL_OUTPUT_LIMIT: 'The model response reached its configured output limit.',
  MODEL_REFUSAL: 'The model declined the request.',
  MODEL_PROTOCOL_ERROR: 'The model returned an incomplete or invalid response.',
  MODEL_CONNECTION_ERROR: 'The connection to the model service was interrupted. Please retry the task.',
  MODEL_ERROR: 'The model request failed.',
  TOOL_DENIED: 'The model requested an unregistered or disabled tool.',
  TOOL_INPUT_INVALID: 'The registered tool received invalid input.',
  MODEL_CALL_LIMIT: 'The model call limit was reached.',
  OUTPUT_CONTRACT_INVALID: 'The model output did not match the required delivery contract.',
  DEADLINE_EXCEEDED: 'The model request timed out.',
  OUTPUT_LIMIT: 'The model output exceeded the configured limit.',
  WORKER_ERROR: 'The model worker could not start.',
  WORKER_LOST: 'The model worker exited before completing.',
});
export class RuntimeError extends Error { constructor(code) { super(MESSAGES[code] ?? MESSAGES.MODEL_ERROR); this.code = code; } }
const ERROR_CLASSES = new Set(['UnknownError', 'RuntimeError', 'Error', 'TypeError', 'AbortError', 'APIError', 'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError', 'AuthenticationError', 'PermissionDeniedError', 'RateLimitError', 'InternalServerError', 'BadRequestError', 'NotFoundError', 'UnprocessableEntityError', 'ToolInputError', 'MaxTurnsExceededError', 'ModelRefusalError', 'OutputGuardrailTripwireTriggered', 'ModelBehaviorError', 'ToolCallError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'SocketError']);
const CATEGORIES = new Set(['unknown', 'connection', 'timeout', 'authentication', 'rate_limit', 'unavailable', 'request', 'protocol', 'refusal', 'tool', 'budget', 'delivery', 'workspace', 'worker']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']);
const CONTEXT_SIZE_KEYS = ['budgetBytes', 'requestBytes', 'projectedBytes', 'systemBytes', 'toolDefinitionsBytes', 'inputBytes', 'requestOtherBytes', 'inputFramingBytes', 'userMessageBytes', 'assistantMessageBytes', 'otherMessageBytes', 'reasoningBytes', 'reasoningItemCount', 'otherItemBytes', 'otherItemCount', 'providerDataBytes', 'projectedInputBytes', 'projectedReasoningBytes', 'projectedOtherItemBytes', 'toolCallBytes', 'toolResultBytes', 'toolArgumentsBytes', 'latestToolCallBytes', 'latestArgumentsBytes', 'latestToolResultBytes', 'inputItemCount'];
function read(value, key) { try { return value && (typeof value === 'object' || typeof value === 'function') ? value[key] : undefined; } catch { return undefined; } }
function chain(error) {
  const result = [];
  for (let current = error; current && result.length < 3 && !result.includes(current); current = read(current, 'cause')) result.push(current);
  return result;
}
const statusInRange = status => Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
// An error frame inside a stream that already answered 200 has no HTTP status of its own;
// the bridge to Bedrock carries one in the frame's error body.
const statusOf = error => statusInRange(read(error, 'status')) ?? statusInRange(read(read(error, 'error'), 'status'));
const classOf = error => {
  if (error instanceof RuntimeError) return 'RuntimeError';
  const name = read(error, 'name');
  if (name !== 'Error' && ERROR_CLASSES.has(name)) return name;
  // OpenAI 7.x error subclasses inherit Error.name. Their constructor name is
  // useful only after an exact allowlist match; never emit an arbitrary name.
  const constructorName = read(read(error, 'constructor'), 'name');
  if (ERROR_CLASSES.has(constructorName)) return constructorName;
  return ERROR_CLASSES.has(name) ? name : 'UnknownError';
};
function categoryFor(code) {
  if (code === 'MODEL_CONNECTION_ERROR') return 'connection';
  if (code === 'DEADLINE_EXCEEDED') return 'timeout';
  if (code === 'MODEL_AUTHENTICATION') return 'authentication';
  if (code === 'MODEL_RATE_LIMIT') return 'rate_limit';
  if (code === 'MODEL_UNAVAILABLE') return 'unavailable';
  if (code === 'MODEL_REQUEST_REJECTED') return 'request';
  if (code === 'MODEL_PROTOCOL_ERROR') return 'protocol';
  if (code === 'MODEL_REFUSAL') return 'refusal';
  if (code.startsWith('TOOL_')) return 'tool';
  if (['MODEL_CALL_LIMIT', 'MODEL_OUTPUT_LIMIT', 'OUTPUT_LIMIT', 'WORKSPACE_CONTEXT_LIMIT'].includes(code)) return 'budget';
  if (code === 'OUTPUT_CONTRACT_INVALID' || code === 'WORKSPACE_FILE_INVALID') return 'delivery';
  if (code.startsWith('WORKSPACE_')) return 'workspace';
  if (code.startsWith('WORKER_')) return 'worker';
  return 'unknown';
}
function contextSizeProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of CONTEXT_SIZE_KEYS) {
    const number = read(value, key);
    if (Number.isSafeInteger(number) && number >= 0 && number <= 2_147_483_647) result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Only fixed enum values, bounded status and numeric size counts cross IPC. Never inspect an
 * error's message, stack, body, URL, request, headers, prompt or string coercion. */
export function errorDiagnostic(error) {
  const causes = chain(error);
  const result = { errorClass: classOf(error), category: categoryFor(classifyError(error).code) };
  if (causes.length > 1) result.causeClass = classOf(causes[1]);
  const status = causes.map(statusOf).find(value => value !== undefined);
  if (status !== undefined) result.httpStatus = status;
  if (error instanceof RuntimeError && error.code === 'WORKSPACE_CONTEXT_LIMIT') {
    const contextSize = contextSizeProjection(read(error, 'contextSize'));
    if (contextSize) result.contextSize = contextSize;
  }
  return result;
}

/** Rebuild at each trust boundary; arbitrary child fields are never relayed. */
export function sanitizeErrorDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const errorClass = read(value, 'errorClass'), category = read(value, 'category');
  if (!ERROR_CLASSES.has(errorClass) || !CATEGORIES.has(category)) return undefined;
  const result = { errorClass, category };
  const causeClass = read(value, 'causeClass'), httpStatus = read(value, 'httpStatus');
  if (ERROR_CLASSES.has(causeClass)) result.causeClass = causeClass;
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) result.httpStatus = httpStatus;
  if (category === 'budget') {
    const contextSize = contextSizeProjection(read(value, 'contextSize'));
    if (contextSize) result.contextSize = contextSize;
  }
  return result;
}
export function failureEvent(code) {
  const safe = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'MODEL_ERROR';
  return { type: 'failed', code: safe, message: MESSAGES[safe] };
}
export function classifyError(error) {
  if (error instanceof RuntimeError) return failureEvent(error.code);
  const name = classOf(error);
  if (name === 'ToolInputError' || classOf(read(error, 'cause')) === 'ToolInputError') return failureEvent('TOOL_INPUT_INVALID');
  if (name === 'MaxTurnsExceededError') return failureEvent('MODEL_CALL_LIMIT');
  if (name === 'ModelRefusalError') return failureEvent('MODEL_REFUSAL');
  // The delivery guardrail is local and pure; its tripwire is never retried or repaired.
  if (name === 'OutputGuardrailTripwireTriggered') return failureEvent('OUTPUT_CONTRACT_INVALID');
  if (name === 'ModelBehaviorError') return failureEvent('MODEL_PROTOCOL_ERROR');
  if (name === 'ToolCallError') return failureEvent('TOOL_INPUT_INVALID');
  const causes = chain(error);
  const status = causes.map(statusOf).find(value => value !== undefined);
  if ([401,403].includes(status)) return failureEvent('MODEL_AUTHENTICATION');
  if (status === 429) return failureEvent('MODEL_RATE_LIMIT');
  if (status >= 500) return failureEvent('MODEL_UNAVAILABLE');
  if (status >= 400) return failureEvent('MODEL_REQUEST_REJECTED');
  if (causes.some(cause => ['APIConnectionTimeoutError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError'].includes(classOf(cause)) || TIMEOUT_CODES.has(read(cause, 'code')))) return failureEvent('DEADLINE_EXCEEDED');
  if (causes.some(cause => ['APIConnectionError', 'SocketError'].includes(classOf(cause)) || CONNECTION_CODES.has(read(cause, 'code')))) return failureEvent('MODEL_CONNECTION_ERROR');
  return failureEvent('MODEL_ERROR');
}
