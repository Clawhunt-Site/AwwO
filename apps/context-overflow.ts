// A provider's refusal of a request as larger than its model's context window, read from the provider's own error
// message inside the worker and never relayed: the workers answer it with a closed code (MODEL_CONTEXT_LIMIT for a run,
// the label `context_length_exceeded` for a direct task's call and a Bedrock refusal), so the API settles it as the size
// refusal it is (not counted, not paid for, not run again, the reader told the request is too large for its model)
// instead of a provider fault. A request is admitted at an estimate 15% above every text its model was measured with
// (context-estimate.ts), but a text unlike those could still pass a window.
//
// The patterns follow the Pi agent library's (@earendil-works/pi-ai utils/overflow.js) for the providers behind LLM Gate
// and Bedrock, with Anthropic's own for an input that leaves no room for the output limit, and Nova's; a rate limit is
// never one, whatever else it says. Shared cases: context-overflow-vectors.json, which the Python worker's
// context_overflow.py reads too.

const OVERFLOW: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic, Claude on Bedrock: "prompt is too long: 213462 tokens > 200000 maximum"
  /exceeds? (?:the )?context limit/i, // Anthropic: "input length and `max_tokens` exceed context limit: 187000 + 32000 > 200000"
  /input is too long/i, // Bedrock: "Input is too long for requested model."
  /number of input tokens exceeds/i, // Nova on Bedrock: "Input Tokens Exceeded: Number of input tokens exceeds maximum length."
  /request_too_large/i, // Anthropic's 413
  /exceeds the context window/i, // OpenAI
  /maximum context length/i, // OpenAI-compatible (vLLM, LiteLLM, new-api, DeepSeek, OpenRouter): "This model's maximum context length is 131072 tokens"
  /input token count.*exceeds the maximum/i, // Gemini
  /maximum prompt length is \d+/i, // xAI
  /reduce the length of the messages/i, // Groq, DeepSeek
  /exceeds (?:the )?maximum allowed input length/i, // OpenRouter
  /is longer than the model'?s context length/i, // Together
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /range of input length should be/i, // DashScope (Qwen)
  /model_context_window_exceeded/i, // GLM (z.ai)
  /context[_ ]length[_ ]exceeded/i, // OpenAI's code, and others'
];
const NOT_OVERFLOW: readonly RegExp[] = [/rate.?limit/i, /too many requests/i, /throttl/i];

/** Whether a provider's error message refuses the request as larger than the model's window. Only its first 4 KiB is
 *  read. */
export function contextOverflow(message: unknown): boolean {
  if (typeof message !== 'string' || !message) return false;
  const text = message.slice(0, 4096);
  return !NOT_OVERFLOW.some(pattern => pattern.test(text)) && OVERFLOW.some(pattern => pattern.test(text));
}
