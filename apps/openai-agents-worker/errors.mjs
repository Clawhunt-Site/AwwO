const MESSAGES = Object.freeze({
  MODEL_AUTHENTICATION: 'The model service rejected its configured credentials.',
  MODEL_RATE_LIMIT: 'The model service is rate limited.',
  MODEL_UNAVAILABLE: 'The model service is unavailable.',
  MODEL_REQUEST_REJECTED: 'The model service rejected the request.',
  MODEL_OUTPUT_LIMIT: 'The model response reached its configured output limit.',
  MODEL_REFUSAL: 'The model declined the request.',
  MODEL_PROTOCOL_ERROR: 'The model returned an incomplete or invalid response.',
  MODEL_ERROR: 'The model request failed.',
  TOOL_DENIED: 'The model requested an unregistered or disabled tool.',
  TOOL_INPUT_INVALID: 'The registered tool received invalid input.',
  MODEL_CALL_LIMIT: 'The single model call limit was reached.',
  DEADLINE_EXCEEDED: 'The model request timed out.',
  OUTPUT_LIMIT: 'The model output exceeded the configured limit.',
  WORKER_ERROR: 'The model worker could not start.',
  WORKER_LOST: 'The model worker exited before completing.',
});
export class RuntimeError extends Error { constructor(code) { super(MESSAGES[code] ?? MESSAGES.MODEL_ERROR); this.code = code; } }
export function failureEvent(code) {
  const safe = Object.hasOwn(MESSAGES, code) ? code : 'MODEL_ERROR';
  return { type: 'failed', code: safe, message: MESSAGES[safe] };
}
export function classifyError(error) {
  if (error instanceof RuntimeError) return failureEvent(error.code);
  if (error?.name === 'ToolInputError' || error?.cause?.name === 'ToolInputError') return failureEvent('TOOL_INPUT_INVALID');
  if (error?.name === 'MaxTurnsExceededError') return failureEvent('MODEL_CALL_LIMIT');
  if (error?.name === 'ModelRefusalError') return failureEvent('MODEL_REFUSAL');
  if (error?.name === 'ModelBehaviorError') return failureEvent('MODEL_PROTOCOL_ERROR');
  if (error?.name === 'ToolCallError') return failureEvent('TOOL_INPUT_INVALID');
  if ([401,403].includes(error?.status)) return failureEvent('MODEL_AUTHENTICATION');
  if (error?.status === 429) return failureEvent('MODEL_RATE_LIMIT');
  if (Number.isInteger(error?.status) && error.status >= 500) return failureEvent('MODEL_UNAVAILABLE');
  if (Number.isInteger(error?.status) && error.status >= 400) return failureEvent('MODEL_REQUEST_REJECTED');
  if (error?.name === 'APIConnectionTimeoutError') return failureEvent('DEADLINE_EXCEEDED');
  return failureEvent('MODEL_ERROR');
}
