// The payload hooks a Pi run puts on its model call's request (pi-task.mjs), each after any hook the agent itself sets.

// The model's own "do not think" switch on a request: the chat-template switch Qwen-style models read, or the DeepSeek
// API's thinking field (which ignores the chat template).
export function thinkingOff(next, provider) {
  return async (params, model) => {
    const base = (next ? await next(params, model) : undefined) ?? params;
    if (provider === 'deepseek') return { ...base, thinking: { type: 'disabled' } };
    return { ...base, chat_template_kwargs: { ...base.chat_template_kwargs, enable_thinking: false } };
  };
}

// The thinking effort a run names, sent as Chat Completions' reasoning_effort: the Bedrock bridge sends it to Claude as
// output_config.effort. Pi itself sends none (its model is registered without reasoning), and only a Bedrock profile that
// offers the level gets one (the server checks it, effortAllowed in config.mjs).
export function withEffort(next, effort) {
  return async (params, model) => ({ ...((next ? await next(params, model) : undefined) ?? params), reasoning_effort: effort });
}

// The hook a run's model call gets: the agent's own (`next`), then the thinking switch, then the effort, each where it
// applies; `next` itself where neither does.
export function runPayloadHook(next, { disableThinking = false, provider = '', effort } = {}) {
  let hook = next;
  if (disableThinking) hook = thinkingOff(hook, provider);
  if (effort) hook = withEffort(hook, effort);
  return hook;
}
