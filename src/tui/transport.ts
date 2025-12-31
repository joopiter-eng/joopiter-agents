import {
  type ChatTransport,
  type LanguageModelUsage,
  convertToModelMessages,
  smoothStream,
  pruneMessages,
} from "ai";
import type { TUIAgent, TUIAgentCallOptions, TUIAgentUIMessage } from "./types";

export type AgentTransportOptions = {
  agent: TUIAgent;
  agentOptions: TUIAgentCallOptions;
  onUsageUpdate?: (usage: LanguageModelUsage) => void;
};

export function createAgentTransport({
  agent,
  agentOptions,
  onUsageUpdate,
}: AgentTransportOptions): ChatTransport<TUIAgentUIMessage> {
  return {
    sendMessages: async ({ messages, abortSignal }) => {
      // Pass the agent's tools so convertToModelMessages can properly handle
      // tool approval responses for locally-executed tools
      const modelMessages = await convertToModelMessages(messages, {
        tools: agent.tools,
      });

      // Prune incomplete messages from aborted requests
      const prunedMessages = pruneMessages({
        messages: modelMessages,
        emptyMessages: "remove",
      });

      const result = await agent.stream({
        messages: prunedMessages,
        options: agentOptions,
        abortSignal: abortSignal ?? undefined,
        experimental_transform: smoothStream(),
      });

      // Capture usage after stream completes (non-blocking)
      // Use per-call usage (last step) for accurate context % display
      Promise.resolve(result.usage).then((usage) => {
        onUsageUpdate?.(usage);
      }).catch(() => {
        // Ignore errors from aborted requests
      });

      return result.toUIMessageStream();
    },

    reconnectToStream: async () => {
      // Not supported for local agent calls
      return null;
    },
  };
}
