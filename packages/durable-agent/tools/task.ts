import {
  tool,
  type LanguageModelUsage,
  type ModelMessage,
  type UIToolInvocation,
} from "ai";
import { z } from "zod";
import { gateway } from "../models";
import { createExecutorSubagent } from "../subagents/executor";
import { createExplorerSubagent } from "../subagents/explorer";
import type { ApprovalRule, DurableAgentContext } from "../types";
import {
  getApprovalConfig,
  getSubagentModelConfig,
  shouldAutoApprove,
} from "./utils";

const subagentTypeSchema = z.enum(["explorer", "executor"]);

const taskInputSchema = z.object({
  subagentType: subagentTypeSchema.describe(
    "Type of subagent: 'explorer' for read-only research, 'executor' for implementation tasks",
  ),
  task: z.string().describe("Short description of the task"),
  instructions: z.string().describe("Detailed instructions for the task"),
});
type TaskToolInput = z.infer<typeof taskInputSchema>;

const taskPendingToolCallSchema = z.object({
  name: z.string(),
  input: z.unknown(),
});

export type TaskPendingToolCall = z.infer<typeof taskPendingToolCallSchema>;

export const taskOutputSchema = z.object({
  pending: taskPendingToolCallSchema.optional(),
  toolCallCount: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  modelId: z.string().optional(),
  final: z.array(z.unknown()).optional(),
  usage: z.unknown().optional(),
});

export type TaskToolOutput = Omit<
  z.infer<typeof taskOutputSchema>,
  "final" | "usage"
> & {
  final?: ModelMessage[];
  usage?: LanguageModelUsage;
};

function subagentMatchesApprovalRule(
  subagentType: string,
  approvalRules: ApprovalRule[],
): boolean {
  for (const rule of approvalRules) {
    if (rule.type === "subagent-type" && rule.tool === "task") {
      if (rule.subagentType === subagentType) {
        return true;
      }
    }
  }
  return false;
}

async function executeTaskSubagentStep(
  context: DurableAgentContext,
  subagentType: "explorer" | "executor",
  task: string,
  instructions: string,
) {
  "use step";

  const subagentModelConfig = getSubagentModelConfig(context);
  const subagentModel = gateway(subagentModelConfig.modelId as never, {
    providerOptionsOverrides: subagentModelConfig.providerOptionsOverrides,
  });

  const subagent =
    subagentType === "explorer"
      ? createExplorerSubagent({
          context,
          model: subagentModel,
          task,
          instructions,
        })
      : createExecutorSubagent({
          context,
          model: subagentModel,
          task,
          instructions,
        });

  const startedAt = Date.now();
  const result = await subagent.stream({
    prompt:
      "Complete this task and provide a summary of what you accomplished.",
  });

  let toolCallCount = 0;
  let usage: LanguageModelUsage | undefined;

  for await (const part of result.fullStream) {
    if (part.type === "tool-call") {
      toolCallCount += 1;
    }

    if (part.type === "finish-step") {
      usage = part.usage;
    }
  }

  const response = await result.response;
  return {
    final: response.messages,
    toolCallCount,
    usage,
    startedAt,
    modelId: subagentModelConfig.modelId,
  };
}

export const taskTool = (context: DurableAgentContext) =>
  tool<TaskToolInput, z.infer<typeof taskOutputSchema>>({
    needsApproval: ({ subagentType }: TaskToolInput) => {
      const approval = getApprovalConfig(context);

      if (subagentType !== "executor") {
        return false;
      }

      if (shouldAutoApprove(approval)) {
        return false;
      }

      if (
        approval.type === "interactive" &&
        subagentMatchesApprovalRule(subagentType, approval.sessionRules)
      ) {
        return false;
      }

      return true;
    },
    description: `Launch a specialized subagent to handle complex tasks autonomously.`,
    inputSchema: taskInputSchema,
    outputSchema: taskOutputSchema,
    execute: async ({ subagentType, task, instructions }: TaskToolInput) =>
      executeTaskSubagentStep(context, subagentType, task, instructions),
    toModelOutput: ({
      output,
    }: {
      toolCallId: string;
      input: TaskToolInput;
      output: z.infer<typeof taskOutputSchema>;
    }) => {
      const messages = output.final as ModelMessage[] | undefined;

      if (!messages) {
        return { type: "text", value: "Task completed." };
      }

      const lastAssistantMessage = messages.findLast(
        (message) => message.role === "assistant",
      );
      const content = lastAssistantMessage?.content;
      if (!content) {
        return { type: "text", value: "Task completed." };
      }
      if (typeof content === "string") {
        return { type: "text", value: content };
      }

      const lastTextPart = content.findLast((part) => part.type === "text");
      return {
        type: "text",
        value: lastTextPart?.text ?? "Task completed.",
      };
    },
  });

export type TaskToolUIPart = UIToolInvocation<ReturnType<typeof taskTool>>;
