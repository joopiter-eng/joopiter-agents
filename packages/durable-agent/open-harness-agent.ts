import { DurableAgent } from "@workflow/ai/agent";
import type {
  CompatibleLanguageModel,
  PrepareStepInfo,
  PrepareStepResult,
} from "@workflow/ai/agent";
import { type ModelMessage, type StepResult, type ToolSet } from "ai";
import { z } from "zod";
import { addCacheControl } from "./context-management";
import { aggressiveCompactContext } from "./context-management/aggressive-compaction";
import { gateway } from "./models";
import { preparePromptForOpenAIReasoning } from "./openai-reasoning";
import { buildSystemPrompt } from "./system-prompt";
import {
  askUserQuestionTool,
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  skillTool,
  taskTool,
  todoWriteTool,
  webFetchTool,
  writeFileTool,
} from "./tools";
import type { DurableAgentContext, TodoItem } from "./types";

const compactionContextSchema = z.object({
  contextLimit: z.number().int().positive().optional(),
  lastInputTokens: z.number().int().nonnegative().optional(),
});

type CompactionContext = z.infer<typeof compactionContextSchema>;

const DEFAULT_CONTEXT_LIMIT = 200_000;

interface CompactionTuning {
  triggerPercent: number;
  minSavingsPercent: number;
  retainRecentToolCalls: number;
}

const DEFAULT_COMPACTION_TUNING: CompactionTuning = {
  triggerPercent: 0.58,
  minSavingsPercent: 0.03,
  retainRecentToolCalls: 32,
};

const MODEL_COMPACTION_TUNING_OVERRIDES: Record<
  string,
  Partial<CompactionTuning>
> = {};

export const defaultModelId = "anthropic/claude-haiku-4.5";
export const defaultModelLabel = defaultModelId;

function getCompactionContextFromExperimentalContext(
  experimentalContext: unknown,
): CompactionContext | undefined {
  if (!experimentalContext || typeof experimentalContext !== "object") {
    return undefined;
  }

  const contextValue = (experimentalContext as { context?: unknown }).context;
  const parsed = compactionContextSchema.safeParse(contextValue);
  return parsed.success ? parsed.data : undefined;
}

function resolveCompactionTuning(modelId: string): CompactionTuning {
  const exactMatch = MODEL_COMPACTION_TUNING_OVERRIDES[modelId];
  if (exactMatch) {
    return {
      ...DEFAULT_COMPACTION_TUNING,
      ...exactMatch,
    };
  }

  const partialMatch = Object.entries(MODEL_COMPACTION_TUNING_OVERRIDES).find(
    ([key]) => modelId.includes(key),
  );

  if (partialMatch?.[1]) {
    return {
      ...DEFAULT_COMPACTION_TUNING,
      ...partialMatch[1],
    };
  }

  return DEFAULT_COMPACTION_TUNING;
}

export function createOpenHarnessToolSet(context: DurableAgentContext) {
  return {
    todo_write: todoWriteTool,
    read: readFileTool(context),
    write: writeFileTool(context),
    edit: editFileTool(context),
    grep: grepTool(context),
    glob: globTool(context),
    bash: bashTool(context),
    task: taskTool(context),
    ask_user_question: askUserQuestionTool,
    skill: skillTool(context),
    web_fetch: webFetchTool,
  } satisfies ToolSet;
}

export function createOpenHarnessDurableAgent(context: DurableAgentContext) {
  const modelConfig = context.model;
  const modelId = modelConfig.modelId || defaultModelId;
  const tools = createOpenHarnessToolSet(context);
  const model =
    modelConfig.providerOptionsOverrides &&
    Object.keys(modelConfig.providerOptionsOverrides).length > 0
      ? () =>
          Promise.resolve(
            gateway(modelId as never, {
              providerOptionsOverrides: modelConfig.providerOptionsOverrides,
            }) as unknown as CompatibleLanguageModel,
          )
      : modelId;

  const instructions = buildSystemPrompt({
    cwd: context.sandbox.workingDirectory,
    mode: context.approval.type === "background" ? "background" : "interactive",
    currentBranch: context.sandbox.currentBranch,
    environmentDetails: context.sandbox.environmentDetails,
    skills: context.skillSuggestions ?? context.skills ?? [],
    modelId,
  });

  return new DurableAgent({
    model,
    system: instructions,
    tools: addCacheControl({
      tools,
      model: modelId,
    }),
  });
}

export function prepareOpenHarnessDurableStep<TTools extends ToolSet>(
  info: Pick<
    PrepareStepInfo<TTools>,
    "messages" | "steps" | "experimental_context"
  > & {
    modelId: string;
  },
): PrepareStepResult {
  const callContext = getCompactionContextFromExperimentalContext(
    info.experimental_context,
  );
  const compactionTuning = resolveCompactionTuning(info.modelId);
  const preparedPrompt = preparePromptForOpenAIReasoning({
    model: info.modelId,
    messages: info.messages as unknown as ModelMessage[],
  });
  const compactedMessages = aggressiveCompactContext({
    messages: (preparedPrompt.messages ??
      info.messages) as unknown as ModelMessage[],
    steps: info.steps as StepResult<TTools>[],
    contextLimit: callContext?.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    lastInputTokens: callContext?.lastInputTokens,
    triggerPercent: compactionTuning.triggerPercent,
    minSavingsPercent: compactionTuning.minSavingsPercent,
    retainRecentToolCalls: compactionTuning.retainRecentToolCalls,
  });

  return {
    ...preparedPrompt,
    messages: addCacheControl({
      messages: compactedMessages,
      model: info.modelId,
    }) as unknown as PrepareStepResult["messages"],
  };
}

export function extractTodosFromStep(
  toolResults: Array<{
    dynamic?: boolean;
    toolName?: string;
    output?: { todos?: TodoItem[] };
  }>,
): TodoItem[] | null {
  for (const result of toolResults) {
    if (!result.dynamic && result.toolName === "todo_write" && result.output) {
      return result.output.todos ?? null;
    }
  }
  return null;
}
