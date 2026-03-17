import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LanguageModelUsage } from "ai";
import type { WebAgentUIMessage } from "@/app/types";
import type { ChatAgentStepResult } from "./chat-steps";

const convertMessagesCalls: WebAgentUIMessage[][] = [];
const finalizeCalls: unknown[] = [];
const hasChatStreamOwnershipCalls: Array<{
  chatId: string;
  ownedStreamToken: string;
}> = [];
const runChatAgentStepCalls: Array<{
  originalMessages: WebAgentUIMessage[];
  assistantId: string;
}> = [];
const sendFinishCalls: Array<{
  finishReason: string;
  metadata: unknown;
}> = [];
const sendStartCalls: string[] = [];
let stepResults: ChatAgentStepResult[] = [];

function createMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): WebAgentUIMessage {
  return {
    id,
    role,
    parts: text.length > 0 ? [{ type: "text", text }] : [],
    metadata: {},
  } as unknown as WebAgentUIMessage;
}

function createUsage(totalTokens: number): LanguageModelUsage {
  return {
    inputTokens: totalTokens,
    outputTokens: totalTokens,
    totalTokens: totalTokens * 2,
    inputTokenDetails: {
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokenDetails: {
      reasoningTokens: 0,
      textTokens: totalTokens,
    },
  };
}

mock.module("workflow", () => ({
  getWorkflowMetadata: () => ({
    workflowRunId: "workflow-run-1",
  }),
}));

mock.module("@/lib/chat-stream-token", () => ({
  createStreamToken: () => "stream-token-1",
}));

mock.module("./chat-steps", () => ({
  clearChatActiveStreamIfOwned: async () => undefined,
  convertMessages: async (messages: WebAgentUIMessage[]) => {
    convertMessagesCalls.push(messages);
    return [];
  },
  ensureChatStreamOwnership: async () => true,
  finalizeChatWorkflowRun: async (params: unknown) => {
    finalizeCalls.push(params);
  },
  generateMessageId: async () => "assistant-1",
  hasChatStreamOwnership: async (chatId: string, ownedStreamToken: string) => {
    hasChatStreamOwnershipCalls.push({ chatId, ownedStreamToken });
    return true;
  },
  runChatAgentStep: async (params: {
    originalMessages: WebAgentUIMessage[];
    assistantId: string;
  }) => {
    runChatAgentStepCalls.push({
      originalMessages: params.originalMessages,
      assistantId: params.assistantId,
    });

    const nextStepResult = stepResults.shift();
    if (!nextStepResult) {
      throw new Error("No mocked chat step result available");
    }

    return nextStepResult;
  },
  sendError: async () => undefined,
  sendFinish: async (finishReason: string, metadata: unknown) => {
    sendFinishCalls.push({ finishReason, metadata });
  },
  sendStart: async (messageId: string) => {
    sendStartCalls.push(messageId);
  },
}));

const chatWorkflowModulePromise = import("./chat");

describe("chat workflow originalMessages handling", () => {
  beforeEach(() => {
    convertMessagesCalls.length = 0;
    finalizeCalls.length = 0;
    hasChatStreamOwnershipCalls.length = 0;
    runChatAgentStepCalls.length = 0;
    sendFinishCalls.length = 0;
    sendStartCalls.length = 0;
    stepResults = [];
  });

  test("passes only the latest message into each streamed step", async () => {
    const earliestUserMessage = createMessage(
      "user-0",
      "user",
      "Earlier request",
    );
    const earlierAssistantMessage = createMessage(
      "assistant-0",
      "assistant",
      "Earlier response",
    );
    const latestUserMessage = createMessage("user-1", "user", "Latest request");
    const firstStepResponse = createMessage(
      "assistant-1",
      "assistant",
      "First streamed response",
    );
    const finalStepResponse = createMessage(
      "assistant-1",
      "assistant",
      "Final streamed response",
    );

    stepResults = [
      {
        responseMessage: firstStepResponse,
        responseMessages: [],
        finishReason: "tool-calls",
        usage: createUsage(1),
        sandboxState: undefined,
        aborted: false,
      },
      {
        responseMessage: finalStepResponse,
        responseMessages: [],
        finishReason: "stop",
        usage: createUsage(2),
        sandboxState: undefined,
        aborted: false,
      },
    ];

    const { chatWorkflow } = await chatWorkflowModulePromise;
    const result = await chatWorkflow({
      userId: "user-1",
      sessionId: "session-1",
      chatId: "chat-1",
      messages: [
        earliestUserMessage,
        earlierAssistantMessage,
        latestUserMessage,
      ],
      requestStartedAtMs: 123,
      model: { id: "anthropic/claude-haiku-4.5" },
    });

    expect(result).toEqual({
      finishReason: "stop",
      responseMessageId: "assistant-1",
      totalMessageUsage: {
        inputTokens: 3,
        outputTokens: 3,
        totalTokens: 6,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        inputTokenDetails: {
          noCacheTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: {
          textTokens: 3,
          reasoningTokens: 0,
        },
      },
    });
    expect(convertMessagesCalls).toEqual([
      [earliestUserMessage, earlierAssistantMessage, latestUserMessage],
    ]);
    expect(sendStartCalls).toEqual(["assistant-1"]);
    expect(runChatAgentStepCalls).toEqual([
      {
        originalMessages: [latestUserMessage],
        assistantId: "assistant-1",
      },
      {
        originalMessages: [firstStepResponse],
        assistantId: "assistant-1",
      },
    ]);
    expect(hasChatStreamOwnershipCalls).toEqual([
      {
        chatId: "chat-1",
        ownedStreamToken: "stream-token-1",
      },
    ]);
    expect(sendFinishCalls).toEqual([
      {
        finishReason: "stop",
        metadata: {
          lastStepUsage: createUsage(2),
          totalMessageUsage: {
            inputTokens: 3,
            outputTokens: 3,
            totalTokens: 6,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            inputTokenDetails: {
              noCacheTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokenDetails: {
              textTokens: 3,
              reasoningTokens: 0,
            },
          },
        },
      },
    ]);
    expect(finalizeCalls).toEqual([
      {
        userId: "user-1",
        sessionId: "session-1",
        chatId: "chat-1",
        ownedStreamToken: "stream-token-1",
        responseMessage: finalStepResponse,
        sandboxState: undefined,
        modelId: "anthropic/claude-haiku-4.5",
        totalMessageUsage: {
          inputTokens: 3,
          outputTokens: 3,
          totalTokens: 6,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          inputTokenDetails: {
            noCacheTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokenDetails: {
            textTokens: 3,
            reasoningTokens: 0,
          },
        },
      },
    ]);
  });

  test("persists a partial assistant response when a step is aborted", async () => {
    const latestUserMessage = createMessage("user-1", "user", "Latest request");
    const partialAssistantResponse = createMessage(
      "assistant-1",
      "assistant",
      "Partial streamed response",
    );

    stepResults = [
      {
        responseMessage: partialAssistantResponse,
        responseMessages: [],
        finishReason: "stop",
        usage: undefined,
        sandboxState: undefined,
        aborted: true,
      },
    ];

    const { chatWorkflow } = await chatWorkflowModulePromise;
    const result = await chatWorkflow({
      userId: "user-1",
      sessionId: "session-1",
      chatId: "chat-1",
      messages: [latestUserMessage],
      requestStartedAtMs: 123,
      model: { id: "anthropic/claude-haiku-4.5" },
    });

    expect(result).toEqual({
      finishReason: "stop",
      responseMessageId: "assistant-1",
      totalMessageUsage: undefined,
    });
    expect(runChatAgentStepCalls).toEqual([
      {
        originalMessages: [latestUserMessage],
        assistantId: "assistant-1",
      },
    ]);
    expect(hasChatStreamOwnershipCalls).toEqual([]);
    expect(sendFinishCalls).toEqual([
      {
        finishReason: "stop",
        metadata: {},
      },
    ]);
    expect(finalizeCalls).toEqual([
      {
        userId: "user-1",
        sessionId: "session-1",
        chatId: "chat-1",
        ownedStreamToken: "stream-token-1",
        responseMessage: partialAssistantResponse,
        sandboxState: undefined,
        modelId: "anthropic/claude-haiku-4.5",
        totalMessageUsage: undefined,
      },
    ]);
  });
});
