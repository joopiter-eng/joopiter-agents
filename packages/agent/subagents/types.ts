import type { InferAgentUIMessage } from "ai";
import type { explorerSubagent } from "./explorer";
import type { executorSubagent } from "./executor";

export type SubagentMessageMetadata = {
  inputTokens?: number;
};

// Union of both subagent types to support all tool types at runtime
export type SubagentUIMessage =
  | InferAgentUIMessage<typeof explorerSubagent, SubagentMessageMetadata>
  | InferAgentUIMessage<typeof executorSubagent, SubagentMessageMetadata>;
