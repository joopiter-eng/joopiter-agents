import type { InferAgentUIMessage, LanguageModelUsage } from "ai";
import { createExecutorSubagent } from "./executor";
import { createExplorerSubagent } from "./explorer";

export type SubagentMessageMetadata = {
  lastStepUsage?: LanguageModelUsage;
  totalMessageUsage?: LanguageModelUsage;
  modelId?: string;
};

type ExplorerSubagent = ReturnType<typeof createExplorerSubagent>;
type ExecutorSubagent = ReturnType<typeof createExecutorSubagent>;

export type SubagentUIMessage =
  | InferAgentUIMessage<ExplorerSubagent, SubagentMessageMetadata>
  | InferAgentUIMessage<ExecutorSubagent, SubagentMessageMetadata>;
