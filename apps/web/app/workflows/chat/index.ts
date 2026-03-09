/* eslint-disable max-lines */

import {
  collectTaskToolUsageEvents,
  createOpenHarnessDurableAgent,
  createOpenHarnessToolSet,
  prepareOpenHarnessDurableStep,
  sumLanguageModelUsage,
  type DurableAgentContext,
  type SkillPromptMetadata,
} from "@open-harness/durable-agent";
import {
  convertToModelMessages,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { getWorkflowMetadata, getWritable } from "workflow";
import { decrypt } from "@/lib/crypto";
import { getGitHubAccount } from "@/lib/db/accounts";
import {
  getChatById,
  getChatMessages,
  touchChat,
  updateChatAssistantActivity,
  updateChatWorkflowRuntime,
  updateSession,
  upsertChatMessageScoped,
} from "@/lib/db/sessions";
import { recordUsage } from "@/lib/db/usage";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { getRepoToken } from "@/lib/github/get-repo-token";
import { resolveModelSelection } from "@/lib/model-variants";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";
import { buildActiveLifecycleUpdate } from "@/lib/sandbox/lifecycle-state";
import { isSandboxActive } from "@/lib/sandbox/utils";
import type { WebAgentUIMessage } from "@/app/types";

const DEFAULT_CONTEXT_LIMIT = 200_000;
const STREAM_NAMESPACE_PREFIX = "turn";
const VERCEL_WORKING_DIRECTORY = "/vercel/sandbox";
const LOCAL_WORKING_DIRECTORY = "/workspace";

interface ChatWorkflowInput {
  chatId: string;
  runtime: {
    sessionId: string;
    userId: string;
    sandboxState: DurableAgentContext["sandbox"]["state"];
    branch?: string | null;
    modelId?: string | null;
    repoOwner?: string | null;
  };
  context?: {
    contextLimit?: number;
  };
  skillSuggestions?: SkillPromptMetadata[];
}

interface ChatTurnRuntime {
  chatId: string;
  sessionId: string;
  userId: string;
  context: DurableAgentContext;
}

function getWorkingDirectoryFromSandboxState(
  sandboxState: DurableAgentContext["sandbox"]["state"],
): string {
  switch (sandboxState.type) {
    case "vercel":
      return VERCEL_WORKING_DIRECTORY;
    case "just-bash":
      return sandboxState.workingDirectory ?? LOCAL_WORKING_DIRECTORY;
    case "hybrid":
      if (sandboxState.workingDirectory) {
        return sandboxState.workingDirectory;
      }
      if (sandboxState.sandboxId || sandboxState.snapshotId) {
        return VERCEL_WORKING_DIRECTORY;
      }
      return LOCAL_WORKING_DIRECTORY;
  }
}

async function getUserGitHubTokenForUser(
  userId: string,
): Promise<string | null> {
  try {
    const account = await getGitHubAccount(userId);
    if (!account?.accessToken) {
      return null;
    }
    return decrypt(account.accessToken);
  } catch (error) {
    console.error(
      `[chat-workflow] Failed to load GitHub user token for ${userId}:`,
      error,
    );
    return null;
  }
}

async function prepareInitialChatTurn(
  input: ChatWorkflowInput,
  skillSuggestions?: SkillPromptMetadata[],
): Promise<{
  runtime: ChatTurnRuntime;
  messages: Awaited<ReturnType<typeof convertToModelMessages>>;
} | null> {
  "use step";

  const { chatId, runtime: seed } = input;
  if (!isSandboxActive(seed.sandboxState)) {
    return null;
  }

  const preferencesPromise = getUserPreferences(seed.userId).catch((error) => {
    console.error("[chat-workflow] Failed to load user preferences:", error);
    return null;
  });
  const githubTokenPromise = (async () => {
    if (seed.repoOwner) {
      try {
        return (await getRepoToken(seed.userId, seed.repoOwner)).token;
      } catch {
        return getUserGitHubTokenForUser(seed.userId);
      }
    }
    return getUserGitHubTokenForUser(seed.userId);
  })();

  const [preferences, githubToken, dbMessages] = await Promise.all([
    preferencesPromise,
    githubTokenPromise,
    getChatMessages(chatId),
  ]);

  const modelVariants = preferences?.modelVariants ?? [];
  const selectedModelId = seed.modelId ?? DEFAULT_MODEL_ID;
  const modelSelection = resolveModelSelection(selectedModelId, modelVariants);
  const resolvedModelId = modelSelection.isMissingVariant
    ? DEFAULT_MODEL_ID
    : modelSelection.resolvedModelId;

  let resolvedSubagentModelId: string | undefined;
  let subagentProviderOptionsOverrides:
    | DurableAgentContext["model"]["providerOptionsOverrides"]
    | undefined;
  if (preferences?.defaultSubagentModelId) {
    const subagentSelection = resolveModelSelection(
      preferences.defaultSubagentModelId,
      modelVariants,
    );
    resolvedSubagentModelId = subagentSelection.isMissingVariant
      ? DEFAULT_MODEL_ID
      : subagentSelection.resolvedModelId;
    subagentProviderOptionsOverrides = subagentSelection.isMissingVariant
      ? undefined
      : subagentSelection.providerOptionsByProvider;
  }

  const runtime: ChatTurnRuntime = {
    chatId,
    sessionId: seed.sessionId,
    userId: seed.userId,
    context: {
      sandbox: {
        state: seed.sandboxState,
        workingDirectory: getWorkingDirectoryFromSandboxState(
          seed.sandboxState,
        ),
        currentBranch: seed.branch ?? undefined,
        env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
        ports: DEFAULT_SANDBOX_PORTS,
      },
      approval: {
        type: "interactive",
        autoApprove: "all",
        sessionRules: [],
      },
      model: {
        modelId: resolvedModelId,
        providerOptionsOverrides: modelSelection.isMissingVariant
          ? undefined
          : modelSelection.providerOptionsByProvider,
      },
      ...(resolvedSubagentModelId
        ? {
            subagentModel: {
              modelId: resolvedSubagentModelId,
              providerOptionsOverrides: subagentProviderOptionsOverrides,
            },
          }
        : {}),
      ...(skillSuggestions?.length ? { skillSuggestions } : {}),
    },
  };

  const uiMessages = dbMessages.map(
    (message) => message.parts as WebAgentUIMessage,
  );
  const messages = await convertToModelMessages(uiMessages, {
    ignoreIncompleteToolCalls: true,
    tools: createOpenHarnessToolSet(runtime.context),
  });

  return {
    runtime,
    messages,
  };
}

async function persistAssistantTurn(
  runtime: ChatTurnRuntime,
  message: UIMessage | null,
  usage: LanguageModelUsage | undefined,
): Promise<void> {
  "use step";

  const activityAt = new Date();

  if (message) {
    await upsertChatMessageScoped({
      id: message.id,
      chatId: runtime.chatId,
      role: "assistant",
      parts: message,
    });
    await updateChatAssistantActivity(runtime.chatId, activityAt);

    if (usage) {
      await recordUsage(runtime.userId, {
        source: "web",
        agentType: "main",
        model: runtime.context.model.modelId,
        messages: [message],
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens:
            usage.inputTokenDetails?.cacheReadTokens ??
            usage.cachedInputTokens ??
            0,
          outputTokens: usage.outputTokens ?? 0,
        },
      }).catch((error) => {
        console.error("[chat-workflow] Failed to record main usage:", error);
      });

      const subagentUsageEvents = collectTaskToolUsageEvents(message);
      const usageByModel = new Map<string, LanguageModelUsage>();
      for (const event of subagentUsageEvents) {
        const modelId = event.modelId ?? runtime.context.model.modelId;
        const combined = sumLanguageModelUsage(
          usageByModel.get(modelId),
          event.usage,
        );
        if (combined) {
          usageByModel.set(modelId, combined);
        }
      }

      for (const [modelId, subagentUsage] of usageByModel) {
        await recordUsage(runtime.userId, {
          source: "web",
          agentType: "subagent",
          model: modelId,
          messages: [],
          usage: {
            inputTokens: subagentUsage.inputTokens ?? 0,
            cachedInputTokens:
              subagentUsage.inputTokenDetails?.cacheReadTokens ??
              subagentUsage.cachedInputTokens ??
              0,
            outputTokens: subagentUsage.outputTokens ?? 0,
          },
        }).catch((error) => {
          console.error(
            "[chat-workflow] Failed to record subagent usage:",
            error,
          );
        });
      }
    }
  } else {
    await touchChat(runtime.chatId, activityAt);
  }

  await updateSession(runtime.sessionId, {
    ...buildActiveLifecycleUpdate(runtime.context.sandbox.state, {
      activityAt,
    }),
  });
}

async function completeWorkflowRun(
  chatId: string,
  workflowRunId: string,
): Promise<void> {
  "use step";

  const chat = await getChatById(chatId);
  if (!chat || chat.workflowRunId !== workflowRunId) {
    return;
  }

  await updateChatWorkflowRuntime(chatId, {
    workflowState: "idle",
    workflowError: null,
    activeStreamId: null,
  });
}

async function failWorkflowRun(
  chatId: string,
  workflowRunId: string,
  errorMessage: string,
): Promise<void> {
  "use step";

  const chat = await getChatById(chatId);
  if (!chat || chat.workflowRunId !== workflowRunId) {
    return;
  }

  await updateChatWorkflowRuntime(chatId, {
    workflowState: "failed",
    workflowError: errorMessage,
    activeStreamId: null,
  });
}

function getLastStepUsage(
  steps: Array<{ usage?: LanguageModelUsage }>,
): LanguageModelUsage | undefined {
  let totalUsage: LanguageModelUsage | undefined;
  for (const step of steps) {
    totalUsage = sumLanguageModelUsage(totalUsage, step.usage);
  }
  return totalUsage;
}

function getTurnNamespace(turnNumber: number): string {
  return `${STREAM_NAMESPACE_PREFIX}-${turnNumber}`;
}

export const INITIAL_TURN_STREAM_NAMESPACE = getTurnNamespace(1);

function getLastAssistantUiMessage(
  uiMessages: UIMessage[] | undefined,
): UIMessage | null {
  if (!uiMessages) {
    return null;
  }

  for (let index = uiMessages.length - 1; index >= 0; index -= 1) {
    const message = uiMessages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }

  return null;
}

export async function chatWorkflow(input: ChatWorkflowInput) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const preparedTurn = await prepareInitialChatTurn(
    input,
    input.skillSuggestions,
  );
  if (!preparedTurn) {
    await failWorkflowRun(
      input.chatId,
      workflowRunId,
      "Chat runtime was unavailable before the first turn started",
    );
    return { skipped: true, reason: "chat-not-available" };
  }
  const { runtime, messages } = preparedTurn;
  const compactionContext = {
    contextLimit:
      input.context?.contextLimit && input.context.contextLimit > 0
        ? input.context.contextLimit
        : DEFAULT_CONTEXT_LIMIT,
    lastInputTokens: undefined as number | undefined,
  };
  const writable = getWritable<UIMessageChunk>({
    namespace: INITIAL_TURN_STREAM_NAMESPACE,
  });
  const agent = createOpenHarnessDurableAgent(runtime.context);

  try {
    const result = await agent.stream({
      messages,
      writable,
      collectUIMessages: true,
      experimental_context: {
        context: compactionContext,
      },
      prepareStep: async (info) => {
        const prepared = prepareOpenHarnessDurableStep({
          ...info,
          experimental_context: {
            ...(typeof info.experimental_context === "object" &&
            info.experimental_context !== null
              ? info.experimental_context
              : {}),
            context: compactionContext,
          },
          modelId: runtime.context.model.modelId,
        });

        return {
          ...prepared,
          experimental_context: {
            ...(typeof prepared.experimental_context === "object" &&
            prepared.experimental_context !== null
              ? prepared.experimental_context
              : {}),
            context: compactionContext,
          },
        };
      },
    });

    await persistAssistantTurn(
      runtime,
      getLastAssistantUiMessage(result.uiMessages),
      getLastStepUsage(result.steps),
    );
    await completeWorkflowRun(input.chatId, workflowRunId);
    return { completed: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown workflow error";
    await failWorkflowRun(input.chatId, workflowRunId, errorMessage);
    throw error;
  }
}
