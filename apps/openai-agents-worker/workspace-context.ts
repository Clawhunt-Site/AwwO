import { createHash } from 'node:crypto';
import type { Model } from '@openai/agents';
import { RuntimeError } from './errors.mjs';

type Request = Parameters<Model['getStreamedResponse']>[0];
type Item = Exclude<Request['input'], string>[number];
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const PAGED_READ = 'The complete file remains in the workspace. Do not repeat an unbounded workspace_read for this file. Use workspace_exec with Python to open the relative path, seek to an explicit byte offset, and read at most 4096 bytes per call (decode text as UTF-8 with replacement if a page splits a character). For binary files inspect metadata or selected bytes, not the entire base64 payload. Never claim that an omitted region was read.';

/** Counts only: never return model text, commands, paths, field IDs or hashes. */
export function workspaceContextSize(request: Request, budget: number, projectedBytes?: number): Record<string, number> {
  try {
    const items = Array.isArray(request.input) ? request.input : [];
    const calls = items.filter(item => item.type === 'function_call');
    const latest = calls.at(-1);
    const latestResult = latest && items.find(item => item.type === 'function_call_result' && item.callId === latest.callId && item.name === latest.name);
    const sum = (accept: (item: Item) => boolean) => items.filter(accept).reduce((count, item) => count + size(item), 0);
    return { budgetBytes: Math.max(0, Math.floor(budget)), requestBytes: size(request), projectedBytes: projectedBytes ?? size(request),
      systemBytes: size(request.systemInstructions ?? ''), toolDefinitionsBytes: size(request.tools), inputBytes: size(request.input),
      userMessageBytes: sum(item => item.type === 'message' && item.role === 'user'),
      assistantMessageBytes: sum(item => item.type === 'message' && item.role === 'assistant'),
      toolCallBytes: sum(item => item.type === 'function_call'), toolResultBytes: sum(item => item.type === 'function_call_result'),
      toolArgumentsBytes: calls.reduce((count, item) => count + Buffer.byteLength(item.arguments), 0),
      latestToolCallBytes: latest ? size(latest) : 0, latestArgumentsBytes: latest ? Buffer.byteLength(latest.arguments) : 0,
      latestToolResultBytes: latestResult ? size(latestResult) : 0, inputItemCount: items.length };
  } catch {
    // Diagnostics are optional. A malformed SDK value must not replace the
    // original context-limit failure with a serialization/counting exception.
    return {};
  }
}

function contextLimit(request: Request, budget: number, projectedBytes?: number): never {
  const error = new RuntimeError('WORKSPACE_CONTEXT_LIMIT');
  Object.assign(error, { contextSize: workspaceContextSize(request, budget, projectedBytes) });
  throw error;
}

function prefix(value: string, maxBytes: number): string {
  let result = '', bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character); if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}

function parsedOutput(item: Item): unknown {
  if (item.type !== 'function_call_result') return undefined;
  const raw = typeof item.output === 'string' ? item.output : record(item.output) && item.output.type === 'text' ? String(item.output.text) : '';
  try { return JSON.parse(raw); } catch { return undefined; }
}

function receiptSummary(item: Extract<Item, { type: 'function_call' }>, result: Item, excerptBytes = 1200): Record<string, unknown> {
  let args: unknown; try { args = JSON.parse(item.arguments); } catch { args = {}; }
  const receipt = parsedOutput(result);
  const summary: Record<string, unknown> = { tool: item.name, sourceOmitted: true };
  if (record(args)) for (const key of ['path', 'field']) if (typeof args[key] === 'string') summary[key] = args[key];
  // An exit code without its command does not identify what was actually tested.
  if (record(args) && typeof args.command === 'string') {
    summary.command = prefix(args.command, excerptBytes);
    summary.commandBytes = Buffer.byteLength(args.command);
    summary.commandSHA256 = createHash('sha256').update(args.command).digest('hex');
    if (Buffer.byteLength(args.command) > excerptBytes) {
      summary.commandExcerpt = true;
      if (excerptBytes === 0) summary.commandOmitted = true;
    }
  }
  if (record(receipt)) for (const key of ['written', 'published', 'path', 'bytes', 'byteLength', 'sha256', 'exitCode', 'truncated', 'error']) {
    if (typeof receipt[key] === 'string' || typeof receipt[key] === 'number' || typeof receipt[key] === 'boolean') summary[key] = receipt[key];
  }
  // Keep explicit excerpts and the actual exit status; never infer success.
  if (record(receipt)) for (const key of ['stdout', 'stderr']) if (typeof receipt[key] === 'string') {
    summary[key] = prefix(receipt[key], excerptBytes);
    summary[`${key}Bytes`] = Buffer.byteLength(receipt[key]);
    if (Buffer.byteLength(receipt[key]) > excerptBytes) {
      summary[`${key}Excerpt`] = true;
      if (excerptBytes === 0) summary[`${key}Omitted`] = true;
    }
  }
  return summary;
}

function boundedLatestResult(item: Extract<Item, { type: 'function_call' }>, result: Item, previewBytes: number): Item | undefined {
  if (result.type !== 'function_call_result') return undefined;
  const receipt = parsedOutput(result);
  const summary = receiptSummary(item, result);
  if (item.name === 'workspace_read' && record(receipt) && typeof receipt.content === 'string') {
    const output: Record<string, unknown> = { ...summary, contextTruncated: true, contentOmitted: true,
      encoding: receipt.encoding, nextRead: PAGED_READ };
    if (receipt.encoding === 'utf8') {
      output.contentPreview = prefix(receipt.content, previewBytes);
      output.previewBytes = Buffer.byteLength(String(output.contentPreview));
    }
    // Binary base64 is never a useful excerpt and can dominate a model context.
    return { ...result, output: JSON.stringify(output) };
  }
  if (item.name === 'workspace_exec' && record(receipt)) {
    for (const key of ['stdout', 'stderr']) if (typeof receipt[key] === 'string') {
      summary[key] = prefix(receipt[key], Math.floor(previewBytes / 2));
      summary[`${key}Excerpt`] = Buffer.byteLength(receipt[key]) > Math.floor(previewBytes / 2);
    }
    return { ...result, output: JSON.stringify({ ...summary, contextTruncated: true,
      outputNotice: 'Only bounded terminal output excerpts are visible. The actual exitCode is preserved; omitted logs do not imply success. For future commands redirect verbose logs to a project file and inspect it in pages.', nextRead: PAGED_READ }) };
  }
  return undefined;
}

/** Keep the original task intact. Completed tool interactions may become explicit
 * receipts or bounded previews. Project files remain in the sandbox and can be
 * read in pages. This never changes the SDK's actual history or audit records. */
export function fitWorkspaceContext(request: Request, budget: number): Request {
  if (size(request) <= budget) return request;
  if (!Array.isArray(request.input)) return contextLimit(request, budget);
  let smallestProjection = size(request);
  const fits = (projection: Request): boolean => {
    const bytes = size(projection); smallestProjection = Math.min(smallestProjection, bytes); return bytes <= budget;
  };
  const items = request.input;
  const calls = items.flatMap((item, index) => item.type === 'function_call' ? [{ item, index }] : []);
  const removed = new Set<number>();
  const summaries: { item: Extract<Item, { type: 'function_call' }>; result: Item; latestInteraction?: true }[] = [];
  const project = (excerptBytes = 1200): Request => {
    if (!removed.size) return request;
    const checkpoint = {
      type: 'message' as const, role: 'assistant' as const, status: 'completed' as const,
      content: [{ type: 'output_text' as const, text: 'Host context checkpoint: completed tool interactions are summarized below. Source text and directory listings were omitted to fit the context budget; the actual files remain in the workspace. Re-read a file in bounded pages before editing it. A tool completion is not a claim that tests passed.\n' + PAGED_READ + `\nExcerpt budget per command/log: ${excerptBytes} bytes. Original command hashes, lengths and actual exit codes are retained even when excerpts are omitted.\n` + summaries.map(({ item, result, latestInteraction }) => JSON.stringify({ ...receiptSummary(item, result, excerptBytes), ...(latestInteraction ? { latestInteraction } : {}) })).join('\n') }],
    };
    const first = Math.min(...removed);
    return { ...request, input: items.flatMap((entry, i) => i === first ? [checkpoint] : removed.has(i) ? [] : [entry]) };
  };
  for (const { item, index } of calls.slice(0, -1)) {
    if (!/^workspace_(list|read|write|exec|publish|archive)$/.test(item.name)) continue;
    const resultIndex = items.findIndex((result, i) => i > index && !removed.has(i) && result.type === 'function_call_result'
      && result.callId === item.callId && result.name === item.name && result.status === 'completed');
    if (resultIndex < 0) continue;
    const result = items[resultIndex];
    if (result.type !== 'function_call_result') continue;
    summaries.push({ item, result });
    removed.add(index); removed.add(resultIndex);
    const compact = project();
    if (fits(compact)) return compact;
  }
  // Several individually bounded receipts can collectively overflow. Tighten
  // older completed evidence before altering the latest interaction at all.
  for (const excerptBytes of [512, 128, 0]) {
    const compact = project(excerptBytes);
    if (fits(compact)) return compact;
  }
  // A single read can be 2 MiB and terminal output can be 64 KiB. Preserve the
  // latest pair, but explicitly project oversized output into a bounded preview.
  const latest = calls.at(-1);
  if (latest) {
    const resultIndex = items.findIndex((result, i) => i > latest.index && result.type === 'function_call_result'
      && result.callId === latest.item.callId && result.name === latest.item.name && result.status === 'completed');
    if (resultIndex >= 0) {
      const originalResult = items[resultIndex];
      for (const excerptBytes of [1200, 512, 128, 0]) {
        const compact = project(excerptBytes);
        if (!Array.isArray(compact.input)) return contextLimit(request, budget, smallestProjection);
        for (const previewBytes of [4096, 1024, 256, 0]) {
          const bounded = boundedLatestResult(latest.item, originalResult, previewBytes);
          if (!bounded) break;
          const projected = { ...compact, input: compact.input.map(item => item === originalResult ? bounded : item) };
          if (fits(projected)) return projected;
        }
      }
      // A completed write or batch execution can contain a whole project's
      // source in its arguments. Preserve its actual receipt/exit status and
      // command identity without replaying that source or changing SDK history.
      if (latest.item.name === 'workspace_write' || latest.item.name === 'workspace_exec') {
        summaries.push({ item: latest.item, result: originalResult, latestInteraction: true });
        removed.add(latest.index); removed.add(resultIndex);
        for (const excerptBytes of [1200, 512, 128, 0]) {
          const projected = project(excerptBytes);
          if (fits(projected)) return projected;
        }
      }
    }
  }
  return contextLimit(request, budget, smallestProjection);
}
