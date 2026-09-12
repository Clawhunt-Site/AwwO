import { parseToolArguments, registeredTools } from './tools.mjs';
import { RuntimeError } from './errors.mjs';

// The SDK runs the agent and registered functions; Go owns cross-agent planning,
// tenancy, durable history, retries/admission and model-call accounting.
export async function executeAgent({ request, modelConfig, signal, emit }) {
  const sdk = await import('@openai/agents');
  const { default: OpenAI } = await import('openai');
  sdk.setTracingDisabled(true);
  sdk.setTraceProcessors([]);
  sdk.setSensitiveDataLoggingEnabled(false);
  let calls = 0, completed = false, finishReason, streamed = '', generatedBytes = 0;
  const names = request.tools ?? [];
  const endpoint = new URL(`${modelConfig.baseURL.replace(/\/$/, '')}/${modelConfig.protocol === 'responses' ? 'responses' : 'chat/completions'}`);
  const client = new OpenAI({ apiKey: modelConfig.apiKey, baseURL: modelConfig.baseURL, maxRetries: 0,
    fetch: (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.href !== endpoint.href) throw new RuntimeError('MODEL_REQUEST_REJECTED');
      return fetch(input, { ...init, redirect: 'error' });
    },
  });
  const inner = modelConfig.protocol === 'responses'
    ? new sdk.OpenAIResponsesModel(client, modelConfig.model)
    : new sdk.OpenAIChatCompletionsModel(client, modelConfig.model, { strictFeatureValidation: true });
  const model = {
    async getResponse() { throw new RuntimeError('MODEL_PROTOCOL_ERROR'); },
    async *getStreamedResponse(input) {
      if (++calls > 1) throw new RuntimeError('MODEL_CALL_LIMIT');
      for await (const event of inner.getStreamedResponse(input)) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (event.type === 'model' && modelConfig.protocol === 'chat_completions') {
          const choice = event.event?.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (finishReason === 'length') throw new RuntimeError('MODEL_OUTPUT_LIMIT');
          if (finishReason === 'content_filter') throw new RuntimeError('MODEL_REFUSAL');
        }
        if (event.type === 'output_text_delta') {
          generatedBytes += Buffer.byteLength(event.delta);
          if (generatedBytes > 8_388_608) throw new RuntimeError('OUTPUT_LIMIT');
        }
        if (event.type === 'response_done') {
          if (modelConfig.protocol === 'chat_completions' && !['stop', 'tool_calls'].includes(finishReason)) throw new RuntimeError('MODEL_PROTOCOL_ERROR');
          if (modelConfig.protocol === 'responses' && event.response.providerData?.status !== 'completed') throw new RuntimeError('MODEL_PROTOCOL_ERROR');
          const output = event.response.output;
          const toolCalls = output.filter(item => item.type === 'function_call');
          if (toolCalls.length > 1 || toolCalls.some(call => !names.includes(call.name))) throw new RuntimeError('TOOL_DENIED');
          if (toolCalls.some(call => typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments) > 1024)) throw new RuntimeError('TOOL_INPUT_INVALID');
          // The SDK can turn malformed JSON into a tool error string. Validate
          // before handing it over so that such errors cannot look completed.
          for (const call of toolCalls) parseToolArguments(call.name, call.arguments);
          if (output.some(item => !['message', 'function_call', 'reasoning'].includes(item.type))) throw new RuntimeError('MODEL_PROTOCOL_ERROR');
          if (output.some(item => item.status === 'incomplete')) throw new RuntimeError('MODEL_OUTPUT_LIMIT');
          if (output.some(item => item.content?.some(part => part.type === 'refusal'))) throw new RuntimeError('MODEL_REFUSAL');
          completed = true;
        }
        yield event;
      }
    },
  };
  const tools = registeredTools(names, sdk.tool, { signal });
  const agent = new sdk.Agent({ name: 'AwwO configured agent',
    instructions: request.systemPrompt ?? 'You are a helpful assistant. Follow the user task using only explicitly provided information and registered tools.',
    model, tools, handoffs: [], toolUseBehavior: 'stop_on_first_tool',
    modelSettings: { maxTokens: modelConfig.maxTokens, store: false, parallelToolCalls: false, retry: { maxRetries: 0 } },
  });
  const runner = new sdk.Runner({ tracingDisabled: true, traceIncludeSensitiveData: false, toolNotFoundBehavior: 'raise_error', toolNameCollisionPolicy: 'error' });
  const input = request.messages.map(message => message.role === 'assistant' ? sdk.assistant(message.content) : sdk.user(message.content));
  input.push(sdk.user(request.prompt));
  const result = await runner.run(agent, input, { stream: true, signal, maxTurns: 1 });
  try {
    for await (const event of result) {
      if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta' && names.length === 0) {
        streamed += event.data.delta;
        await emit({ type: 'text_delta', delta: event.data.delta });
      }
    }
    await result.completed;
  } catch (error) {
    // Drain the SDK completion rejection as well as the event iterator.
    await result.completed.catch(() => {});
    throw error;
  }
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!completed || calls !== 1 || result.interruptions.length !== 0 || typeof result.finalOutput !== 'string' || !result.finalOutput.trim()) throw new RuntimeError('MODEL_PROTOCOL_ERROR');
  const text = result.finalOutput;
  if (!text.startsWith(streamed)) throw new RuntimeError('MODEL_PROTOCOL_ERROR');
  // With tools enabled, buffer provisional model text: a tool result is the final
  // answer and must not be confused with a preceding model preamble.
  if (text.length > streamed.length) await emit({ type: 'text_delta', delta: text.slice(streamed.length) });
  await emit({ type: 'completed', text });
}
