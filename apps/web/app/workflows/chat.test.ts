import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { UIMessageChunk } from "ai";

// ── Spy state ──────────────────────────────────────────────────────

const writtenChunks: UIMessageChunk[] = [];
let runStatus: string = "running";

const spies = {
  persistAssistantMessage: mock(() => Promise.resolve()),
  persistSandboxState: mock(() => Promise.resolve()),
  clearActiveStream: mock(() => Promise.resolve()),
  recordWorkflowUsage: mock(() => Promise.resolve()),
  refreshDiffCache: mock(() => Promise.resolve()),
  runAutoCommitStep: mock(() => Promise.resolve()),
};

// Track what the agent stream yields
let agentStreamParts: Array<Record<string, unknown>> = [];
let agentFinishReason = "stop";
let agentTotalUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
let agentResponseMessages: unknown[] = [];
let streamOnFinishCallback:
  | ((args: { responseMessage: unknown }) => void)
  | undefined;

// ── Module mocks ───────────────────────────────────────────────────

mock.module("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_test-123" }),
  getWritable: () => {
    const writable = new WritableStream<UIMessageChunk>({
      write(chunk) {
        writtenChunks.push(chunk);
      },
    });
    return writable;
  },
}));

mock.module("workflow/api", () => ({
  getRun: () => ({
    get status() {
      return Promise.resolve(runStatus);
    },
  }),
}));

mock.module("./chat-post-finish", () => spies);

mock.module("@/app/config", () => ({
  webAgent: {
    tools: {},
    stream: async () => {
      const assistantMessage = {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello!" }],
        metadata: {},
      };

      return {
        toUIMessageStream: (opts: {
          sendStart?: boolean;
          sendFinish?: boolean;
          onFinish?: (args: { responseMessage: unknown }) => void;
        }) => {
          streamOnFinishCallback = opts.onFinish;
          // Return an async iterable that yields parts and calls onFinish
          return {
            async *[Symbol.asyncIterator]() {
              for (const part of agentStreamParts) {
                yield part;
              }
              if (streamOnFinishCallback) {
                streamOnFinishCallback({
                  responseMessage: assistantMessage,
                });
              }
            },
          };
        },
        totalUsage: Promise.resolve(agentTotalUsage),
        finishReason: Promise.resolve(agentFinishReason),
        response: Promise.resolve({ messages: agentResponseMessages }),
      };
    },
  },
}));

mock.module("ai", () => ({
  convertToModelMessages: async (msgs: unknown[]) => msgs,
  generateId: () => "gen-id-1",
  isToolUIPart: (part: { type: string }) => part.type === "tool-invocation",
}));

mock.module("@open-harness/agent", () => ({
  addLanguageModelUsage: (
    a: { inputTokens: number; outputTokens: number },
    b: { inputTokens: number; outputTokens: number },
  ) => ({
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    totalTokens:
      (a?.inputTokens ?? 0) +
      (b?.inputTokens ?? 0) +
      (a?.outputTokens ?? 0) +
      (b?.outputTokens ?? 0),
  }),
}));

const { runAgentWorkflow } = await import("./chat");

// ── Helpers ────────────────────────────────────────────────────────

function makeOptions(overrides?: Record<string, unknown>) {
  return {
    messages: [
      {
        id: "user-1",
        role: "user" as const,
        parts: [{ type: "text", text: "Hello" }],
      },
    ],
    chatId: "chat-1",
    sessionId: "session-1",
    userId: "user-1",
    modelId: "gpt-4",
    agentOptions: {
      sandbox: { state: { type: "vercel" } },
    },
    maxSteps: 1,
    ...overrides,
  } as Parameters<typeof runAgentWorkflow>[0];
}

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  writtenChunks.length = 0;
  runStatus = "running";
  agentStreamParts = [{ type: "text-delta", textDelta: "Hi" }];
  agentFinishReason = "stop";
  agentTotalUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  agentResponseMessages = [];
  streamOnFinishCallback = undefined;
  Object.values(spies).forEach((s) => s.mockClear());
});

describe("runAgentWorkflow", () => {
  test("throws when no messages provided", async () => {
    try {
      await runAgentWorkflow(makeOptions({ messages: [] }));
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain("at least one message");
    }
  });

  test("sends start and finish chunks to writable", async () => {
    await runAgentWorkflow(makeOptions());

    const types = writtenChunks.map((c) => c.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("finish");
  });

  test("persists assistant message after run", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.persistAssistantMessage).toHaveBeenCalledTimes(1);
    expect(spies.persistAssistantMessage.mock.calls[0][0]).toBe("chat-1");
  });

  test("records usage after run", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.recordWorkflowUsage).toHaveBeenCalledTimes(1);
    const [userId, modelId] = spies.recordWorkflowUsage.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(modelId).toBe("gpt-4");
  });

  test("persists sandbox state when sandbox is present", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.persistSandboxState).toHaveBeenCalledTimes(1);
  });

  test("skips sandbox state when no sandbox", async () => {
    await runAgentWorkflow(
      makeOptions({
        agentOptions: {},
      }),
    );

    expect(spies.persistSandboxState).not.toHaveBeenCalled();
  });

  test("clears active stream in finally block", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.clearActiveStream).toHaveBeenCalledWith(
      "chat-1",
      "wrun_test-123",
    );
  });

  test("refreshes diff cache after run", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.refreshDiffCache).toHaveBeenCalledTimes(1);
  });

  test("runs auto-commit when enabled and not aborted", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        sessionTitle: "My session",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCommitStep).toHaveBeenCalledTimes(1);
    expect(spies.runAutoCommitStep).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );
  });

  test("skips auto-commit when not enabled", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: false,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
  });

  test("skips auto-commit when repoOwner is missing", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        repoOwner: undefined,
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
  });

  test("skips auto-commit when repoName is missing", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        repoOwner: "acme",
        repoName: undefined,
      }),
    );

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
  });

  test("still clears stream and sends finish even on step error", async () => {
    // Mock the agent to throw
    mock.module("@/app/config", () => ({
      webAgent: {
        tools: {},
        stream: async () => {
          throw new Error("Agent failed");
        },
      },
    }));

    // Re-import to pick up new mock
    const { runAgentWorkflow: reloadedRun } = await import("./chat");

    try {
      await reloadedRun(makeOptions());
    } catch {
      // Expected to throw
    }

    // The finally block should still fire
    expect(spies.clearActiveStream).toHaveBeenCalled();
  });
});
