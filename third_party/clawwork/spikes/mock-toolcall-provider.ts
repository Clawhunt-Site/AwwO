/**
 * Spike fixture: a hermetic mock provider whose "model" always answers the
 * FIRST prompt with one bash tool call (`ls -la`), then stops on the second
 * turn. Zero network — lets the spikes prove the rpc + governance contract
 * end-to-end without an API key.
 */

import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turn = 0;

	pi.registerProvider("mockprov", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "$MOCKPROV_API_KEY",
		api: "mockprov-api",
		models: [
			{
				id: "mock-tool-caller",
				name: "Mock Tool Caller",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32000,
				maxTokens: 4096,
			},
		],
		streamSimple: (model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			(async () => {
				const output: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: output });
				turn += 1;
				if (turn === 1) {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: "mock-call-1",
						name: "bash",
						// Configurable so integration tests can drive the real
						// governance hard gates (e.g. a curl to a public host).
						// Defaults to the harmless listing the other spikes expect.
						arguments: { command: process.env.MOCKPROV_BASH_COMMAND ?? "ls -la" },
					};
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
				} else {
					output.content.push({ type: "text", text: "mock final answer" } as never);
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "mock final answer",
						partial: output,
					});
					stream.push({ type: "text_end", contentIndex: 0, content: "mock final answer", partial: output });
					stream.push({ type: "done", reason: "stop", message: output });
				}
				void options; // unused
			})().catch((e) => {
				stream.push({ type: "error", reason: "error", error: e, partial: undefined as never });
			});
			return stream;
		},
	});
}
