import type {
  DynamicToolUIPart,
  InferAgentUIMessage,
  InferUITools,
  LanguageModelUsage,
  ToolUIPart,
} from "ai";
import type {
  createOpenHarnessDurableAgent,
  createOpenHarnessToolSet,
} from "@open-harness/durable-agent";

export type WebAgent = ReturnType<typeof createOpenHarnessDurableAgent>;
export type WebAgentTools = ReturnType<typeof createOpenHarnessToolSet>;

export type WebAgentMessageMetadata = {
  lastStepUsage?: LanguageModelUsage;
  totalMessageUsage?: LanguageModelUsage;
};

// All types derived from the agent
export type WebAgentUIMessage = InferAgentUIMessage<
  WebAgent,
  WebAgentMessageMetadata
>;
export type WebAgentUIMessagePart = WebAgentUIMessage["parts"][number];
export type WebAgentUITools = InferUITools<WebAgentTools>;
export type WebAgentUIToolPart =
  | DynamicToolUIPart
  | ToolUIPart<WebAgentUITools>;
