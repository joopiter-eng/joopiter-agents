import type { SandboxState } from "@open-harness/sandbox";
import type { FinishReason, LanguageModelUsage } from "ai";
import { getWorkflowMetadata } from "workflow";
import type { WebAgentMessageMetadata, WebAgentUIMessage } from "@/app/types";
import { createStreamToken } from "@/lib/chat-stream-token";
import {
  getErrorText,
  mergeLanguageModelUsage,
  type ChatWorkflowInput,
  shouldPauseForToolInteraction,
} from "./chat-shared";
import {
  clearChatActiveStreamIfOwned,
  convertMessages,
  ensureChatStreamOwnership,
  finalizeChatWorkflowRun,
  generateMessageId,
  hasChatStreamOwnership,
  runChatAgentStep,
  sendError,
  sendFinish,
  sendStart,
} from "./chat-steps";

export async function chatWorkflow(input: ChatWorkflowInput) {
  "use workflow";

  const latestMessage = input.messages.at(-1);
  if (!latestMessage) {
    throw new Error("Chat workflow requires at least one message");
  }

  const { workflowRunId } = getWorkflowMetadata();
  const ownedStreamToken = createStreamToken(
    input.requestStartedAtMs,
    workflowRunId,
  );

  const ownsStream = await ensureChatStreamOwnership(
    input.chatId,
    ownedStreamToken,
    input.requestStartedAtMs,
  );
  if (!ownsStream) {
    return { skipped: true, reason: "run-replaced" };
  }

  const [modelMessages, assistantId] = await Promise.all([
    convertMessages(input.messages),
    latestMessage.role === "assistant"
      ? Promise.resolve(latestMessage.id)
      : generateMessageId(),
  ]);

  let responseMessage: WebAgentUIMessage =
    latestMessage.role === "assistant"
      ? {
          ...latestMessage,
          metadata: latestMessage.metadata ?? {},
          parts: [...latestMessage.parts],
        }
      : {
          role: "assistant",
          id: assistantId,
          parts: [],
          metadata: {},
        };
  let originalMessagesForStep = [latestMessage];
  let finishReason: FinishReason = "stop";
  let totalMessageUsage: LanguageModelUsage | undefined;
  let lastStepUsage: LanguageModelUsage | undefined;
  let sandboxState: SandboxState | undefined;
  let streamStarted = false;

  try {
    await sendStart(assistantId);
    streamStarted = true;

    while (true) {
      const stepResult = await runChatAgentStep({
        userId: input.userId,
        sessionId: input.sessionId,
        model: input.model,
        subagentModel: input.subagentModel,
        messages: modelMessages,
        originalMessages: originalMessagesForStep,
        assistantId,
      });

      responseMessage = stepResult.responseMessage;
      originalMessagesForStep = [responseMessage];
      modelMessages.push(...stepResult.responseMessages);
      finishReason = stepResult.finishReason;
      sandboxState = stepResult.sandboxState;
      lastStepUsage = stepResult.usage;
      totalMessageUsage = mergeLanguageModelUsage(
        totalMessageUsage,
        stepResult.usage,
      );

      if (
        stepResult.aborted ||
        stepResult.finishReason !== "tool-calls" ||
        shouldPauseForToolInteraction(stepResult.responseMessage.parts)
      ) {
        break;
      }

      if (!(await hasChatStreamOwnership(input.chatId, ownedStreamToken))) {
        break;
      }
    }

    const finalMetadata: WebAgentMessageMetadata = {
      ...(lastStepUsage ? { lastStepUsage } : {}),
      ...(totalMessageUsage ? { totalMessageUsage } : {}),
    };

    await sendFinish(finishReason, finalMetadata);
    await finalizeChatWorkflowRun({
      userId: input.userId,
      sessionId: input.sessionId,
      chatId: input.chatId,
      ownedStreamToken,
      responseMessage,
      sandboxState,
      modelId: input.model.id,
      totalMessageUsage,
    });

    return {
      finishReason,
      responseMessageId: responseMessage.id,
      totalMessageUsage,
    };
  } catch (error) {
    const errorText = getErrorText(error);

    if (streamStarted) {
      try {
        await sendError(errorText);
        await sendFinish("error", {
          ...(lastStepUsage ? { lastStepUsage } : {}),
          ...(totalMessageUsage ? { totalMessageUsage } : {}),
        });
      } catch (streamError) {
        console.error("Failed to write workflow error state:", streamError);
      }
    }

    await clearChatActiveStreamIfOwned(input.chatId, ownedStreamToken);
    throw error;
  }
}
