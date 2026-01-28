import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  memo,
  useRef,
} from "react";
import { Box, Text, useApp, useInput, Static } from "ink";
import { isToolUIPart, getToolName, type FileUIPart } from "ai";
import { useChat } from "@ai-sdk/react";
import {
  useReasoningContext,
  useExpandedView,
  useTodoView,
} from "@open-harness/shared";
import { renderMarkdown } from "./lib/markdown";
import { useChatContext } from "./chat-context";
import { ToolCall, getToolApprovalInfo } from "./components/tool-call";
import { toolMatchesApprovalRule } from "./lib/approval";
import { ApprovalPanel } from "./components/approval-panel";
import { QuestionPanel } from "./components/question-panel";
import { SettingsPanel } from "./components/settings-panel";
import { ResumePanel } from "./components/resume-panel";
import { TaskGroupView } from "./components/task-group-view";
import { StatusBar, StandaloneTodoList } from "./components/status-bar";
import { InputBox } from "./components/input-box";
import { Header } from "./components/header";
import { CollapsedToolGroup } from "./components/collapsed-tool-group";
import { defaultModelLabel } from "@open-harness/agent";
import type { SlashCommandAction } from "./lib/slash-commands";
import { pasteCollapseLineThreshold } from "./config";
import { extractTodosFromLastAssistantMessage } from "./utils/extract-todos";
import { listSessions, loadSession } from "./lib/session-storage";
import { useRemount } from "./index";
import {
  collapseConsecutiveTools,
  isCollapsedGroup,
} from "./lib/message-collapsing";
import { AnimationProvider } from "./lib/animation-context";
import type { SessionListItem } from "./lib/session-types";
import type {
  TUIOptions,
  TUIAgentUIMessagePart,
  TUIAgentUIMessage,
  TUIAgentUIToolPart,
} from "./types";
import type { TaskToolUIPart, AskUserQuestionInput } from "@open-harness/agent";

type AppProps = {
  options: TUIOptions;
};

/**
 * Check if a message is complete (all tools have finished).
 * A message is complete when:
 * - It's not the last message, OR
 * - It's not streaming AND all tools have output/error/denied state
 */
function isMessageComplete(
  message: TUIAgentUIMessage,
  isLastMessage: boolean,
  isStreaming: boolean,
): boolean {
  // Messages that aren't the last one are always complete
  if (!isLastMessage) return true;

  // Last message while streaming is not complete
  if (isStreaming) return false;

  // Check that all tool parts have finished
  for (const part of message.parts) {
    if (isToolUIPart(part)) {
      // Tool is still running or waiting for approval
      if (
        part.state === "input-streaming" ||
        part.state === "input-available" ||
        part.state === "approval-requested"
      ) {
        return false;
      }
    }
  }

  return true;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const TextPart = memo(function TextPart({
  text,
  isExpanded,
  timestamp,
  model,
}: {
  text: string;
  isExpanded?: boolean;
  timestamp?: Date;
  model?: string;
}) {
  const rendered = useMemo(() => renderMarkdown(text), [text]);

  return (
    <Box>
      <Text>● </Text>
      <Box flexShrink={1} flexGrow={1}>
        <Text>{rendered}</Text>
      </Box>
      {isExpanded && timestamp && model && (
        <Box marginLeft={2} flexShrink={0}>
          <Text color="gray">
            {formatTime(timestamp)} {model}
          </Text>
        </Box>
      )}
    </Box>
  );
});

// Tracks reasoning timing without rendering anything
const ReasoningTracker = memo(function ReasoningTracker({
  messageId,
  hasReasoning,
  isReasoningComplete,
}: {
  messageId: string;
  hasReasoning: boolean;
  isReasoningComplete: boolean;
}) {
  const { startReasoning, endReasoning } = useReasoningContext();

  useEffect(() => {
    if (hasReasoning) {
      startReasoning(messageId);
    }
  }, [messageId, hasReasoning, startReasoning]);

  useEffect(() => {
    if (isReasoningComplete) {
      endReasoning(messageId);
    }
  }, [isReasoningComplete, messageId, endReasoning]);

  return null;
});

function ToolPartWrapper({
  part,
  activeApprovalId,
  isExpanded,
  isStreaming,
}: {
  part: TUIAgentUIToolPart;
  activeApprovalId: string | null;
  isExpanded: boolean;
  isStreaming: boolean;
}) {
  return (
    <ToolCall
      part={part}
      activeApprovalId={activeApprovalId}
      isExpanded={isExpanded}
      isStreaming={isStreaming}
    />
  );
}

type RenderPartOptions = {
  activeApprovalId: string | null;
  messageId: string;
  isStreaming: boolean;
  isExpanded: boolean;
  timestamp?: Date;
  model?: string;
};

const ThinkingPart = memo(function ThinkingPart({
  text,
  isComplete,
}: {
  text: string;
  isComplete: boolean;
}) {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color="gray" italic>
        ∴ {isComplete ? "Thinking..." : "Thinking..."}
      </Text>
      <Box marginLeft={2} marginTop={1}>
        <Text color="gray" italic>
          {text}
        </Text>
      </Box>
    </Box>
  );
});

function renderPart(
  part: TUIAgentUIMessagePart,
  key: string,
  options: RenderPartOptions,
) {
  const { activeApprovalId, isStreaming, isExpanded, timestamp, model } =
    options;

  if (isToolUIPart(part)) {
    return (
      <ToolPartWrapper
        key={key}
        part={part}
        activeApprovalId={activeApprovalId}
        isExpanded={isExpanded}
        isStreaming={isStreaming}
      />
    );
  }

  switch (part.type) {
    case "text":
      if (!part.text) return null;
      return (
        <TextPart
          key={key}
          text={part.text}
          isExpanded={isExpanded}
          timestamp={timestamp}
          model={model}
        />
      );

    case "reasoning":
      // Show reasoning inline when in expanded view
      if (isExpanded && part.text) {
        return <ThinkingPart key={key} text={part.text} isComplete={true} />;
      }
      // Reasoning is tracked but not displayed inline (shown in status bar instead)
      return null;

    default:
      return null;
  }
}

const UserMessage = memo(function UserMessage({
  message,
}: {
  message: TUIAgentUIMessage;
}) {
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  const imageCount = message.parts.filter(
    (p) => p.type === "file" && p.mediaType?.startsWith("image/"),
  ).length;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {imageCount > 0 && (
        <Box
          backgroundColor="#333333"
          paddingLeft={1}
          paddingRight={1}
          alignSelf="flex-start"
        >
          <Text color="#666666">❯ </Text>
          <Text color="blue">
            {imageCount === 1
              ? "[1 image attached]"
              : `[${imageCount} images attached]`}
          </Text>
        </Box>
      )}
      {text && (
        <Box
          backgroundColor="#333333"
          paddingLeft={1}
          paddingRight={1}
          alignSelf="flex-start"
        >
          <Text color="#666666">❯ </Text>
          <Text color="white" bold>
            {text}
          </Text>
        </Box>
      )}
    </Box>
  );
});

// Group consecutive task parts together while preserving order
type RenderGroup =
  | { type: "part"; part: TUIAgentUIMessagePart; index: number }
  | { type: "task-group"; tasks: TaskToolUIPart[]; startIndex: number }
  | {
      type: "collapsed-group";
      group: ReturnType<typeof collapseConsecutiveTools>[number];
      index: number;
    };

const AssistantMessage = memo(function AssistantMessage({
  message,
  activeApprovalId,
  isStreaming,
  isExpanded,
  isComplete,
}: {
  message: TUIAgentUIMessage;
  activeApprovalId: string | null;
  isStreaming: boolean;
  isExpanded: boolean;
  isComplete: boolean;
}) {
  const { state } = useChatContext();
  const timestamp = (message as { createdAt?: Date }).createdAt;
  const model = state.model;

  // Check if this message has reasoning and if reasoning is complete
  // Reasoning is complete when there are non-reasoning parts with content after reasoning
  const { hasReasoning, isReasoningComplete } = useMemo(() => {
    let foundReasoning = false;
    let hasContentAfterReasoning = false;

    for (const part of message.parts) {
      if (part.type === "reasoning" && part.text) {
        foundReasoning = true;
      } else if (foundReasoning) {
        // Check if there's meaningful content after reasoning
        if (part.type === "text" && part.text) {
          hasContentAfterReasoning = true;
          break;
        }
        if (isToolUIPart(part)) {
          hasContentAfterReasoning = true;
          break;
        }
      }
    }

    return {
      hasReasoning: foundReasoning,
      isReasoningComplete:
        foundReasoning && (hasContentAfterReasoning || !isStreaming),
    };
  }, [message.parts, isStreaming]);

  // First, collapse consecutive read/glob/grep tools for completed messages
  const collapsedParts = useMemo(
    () => collapseConsecutiveTools(message.parts, isComplete),
    [message.parts, isComplete],
  );

  // Group consecutive task parts together, keeping them in linear order
  const renderGroups = useMemo(() => {
    const groups: RenderGroup[] = [];
    let currentTaskGroup: TaskToolUIPart[] = [];
    let taskGroupStartIndex = 0;

    collapsedParts.forEach((part, index) => {
      // Handle collapsed groups
      if (isCollapsedGroup(part)) {
        // Flush any pending task group first
        if (currentTaskGroup.length > 0) {
          groups.push({
            type: "task-group",
            tasks: currentTaskGroup,
            startIndex: taskGroupStartIndex,
          });
          currentTaskGroup = [];
        }
        groups.push({ type: "collapsed-group", group: part, index });
        return;
      }

      if (isToolUIPart(part) && part.type === "tool-task") {
        if (currentTaskGroup.length === 0) {
          taskGroupStartIndex = index;
        }
        currentTaskGroup.push(part);
      } else {
        // Flush any pending task group
        if (currentTaskGroup.length > 0) {
          groups.push({
            type: "task-group",
            tasks: currentTaskGroup,
            startIndex: taskGroupStartIndex,
          });
          currentTaskGroup = [];
        }
        groups.push({ type: "part", part, index });
      }
    });

    // Flush remaining task group
    if (currentTaskGroup.length > 0) {
      groups.push({
        type: "task-group",
        tasks: currentTaskGroup,
        startIndex: taskGroupStartIndex,
      });
    }

    return groups;
  }, [collapsedParts]);

  return (
    <Box flexDirection="column">
      <ReasoningTracker
        messageId={message.id}
        hasReasoning={hasReasoning}
        isReasoningComplete={isReasoningComplete}
      />
      {renderGroups.map((group) => {
        if (group.type === "task-group") {
          return (
            <TaskGroupView
              key={`task-group-${group.startIndex}`}
              taskParts={group.tasks}
              isStreaming={isStreaming}
            />
          );
        }
        if (group.type === "collapsed-group") {
          // Type guard to ensure the group is a CollapsedGroup
          const collapsedGroup = group.group;
          if (isCollapsedGroup(collapsedGroup)) {
            return (
              <CollapsedToolGroup
                key={`collapsed-${group.index}`}
                group={collapsedGroup}
              />
            );
          }
          return null;
        }
        return renderPart(group.part, `${message.id}-${group.index}`, {
          activeApprovalId,
          messageId: message.id,
          isStreaming,
          isExpanded,
          timestamp,
          model,
        });
      })}
    </Box>
  );
});

const Message = memo(function Message({
  message,
  activeApprovalId,
  isStreaming,
  isExpanded,
  isComplete,
}: {
  message: TUIAgentUIMessage;
  activeApprovalId: string | null;
  isStreaming: boolean;
  isExpanded: boolean;
  isComplete: boolean;
}) {
  if (message.role === "user") {
    return <UserMessage message={message} />;
  }
  if (message.role === "assistant") {
    return (
      <AssistantMessage
        message={message}
        activeApprovalId={activeApprovalId}
        isStreaming={isStreaming}
        isExpanded={isExpanded}
        isComplete={isComplete}
      />
    );
  }
  return null;
});

const MessagesList = memo(
  function MessagesList({
    messages,
    activeApprovalId,
    isStreaming,
    isExpanded,
  }: {
    messages: TUIAgentUIMessage[];
    activeApprovalId: string | null;
    isStreaming: boolean;
    isExpanded: boolean;
  }) {
    return (
      <Box flexDirection="column">
        {messages.map((message, index) => {
          const isLastMessage = index === messages.length - 1;
          const isComplete = isMessageComplete(
            message,
            isLastMessage,
            isStreaming,
          );
          return (
            <Message
              key={message.id || `msg-${index}`}
              message={message}
              activeApprovalId={activeApprovalId}
              isStreaming={isStreaming && isLastMessage}
              isExpanded={isExpanded}
              isComplete={isComplete}
            />
          );
        })}
      </Box>
    );
  },
  // Custom comparison to prevent unnecessary re-renders
  (prev, next) => {
    // If streaming state or other props changed, re-render
    if (
      prev.isStreaming !== next.isStreaming ||
      prev.isExpanded !== next.isExpanded ||
      prev.activeApprovalId !== next.activeApprovalId
    ) {
      return false;
    }
    // Compare messages by length and IDs
    if (prev.messages.length !== next.messages.length) {
      return false;
    }
    // When not streaming, skip re-render if message IDs match
    // (content doesn't change when not streaming)
    if (!next.isStreaming) {
      for (let i = 0; i < prev.messages.length; i++) {
        if (prev.messages[i]?.id !== next.messages[i]?.id) {
          return false;
        }
      }
      return true;
    }
    // When streaming, allow re-render (messages are actively updating)
    return false;
  },
);

const ErrorDisplay = memo(function ErrorDisplay({
  error,
}: {
  error: Error | undefined;
}) {
  if (!error) return null;
  return (
    <Box marginTop={1}>
      <Text color="red">Error: {error.message}</Text>
    </Box>
  );
});

function useStatusText(messages: TUIAgentUIMessage[]): string {
  return useMemo(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant") {
      for (let i = lastMessage.parts.length - 1; i >= 0; i--) {
        const p = lastMessage.parts[i];
        if (
          p &&
          isToolUIPart(p) &&
          (p.state === "input-available" || p.state === "input-streaming")
        ) {
          return `${getToolName(p)}...`;
        }
      }
    }
    return "Thinking...";
  }, [messages]);
}

const StreamingStatusBar = memo(function StreamingStatusBar({
  messages,
}: {
  messages: TUIAgentUIMessage[];
}) {
  const { getThinkingState } = useReasoningContext();
  const { isTodoVisible } = useTodoView();
  const statusText = useStatusText(messages);

  // Get the current message ID to track thinking state
  const lastMessage = messages[messages.length - 1];
  const messageId = lastMessage?.id ?? "";
  const thinkingState = getThinkingState(messageId);

  // Extract input tokens from the last message's metadata
  const inputTokens = lastMessage?.metadata?.lastStepUsage?.inputTokens ?? null;

  // Extract todos from the most recent assistant message in the current exchange
  const todos = useMemo(
    () => extractTodosFromLastAssistantMessage(messages),
    [messages],
  );

  // Note: No need for forceUpdate interval here - the StatusBar component
  // uses the centralized AnimationProvider which handles periodic updates

  return (
    <StatusBar
      isStreaming={true}
      status={statusText}
      thinkingState={thinkingState}
      todos={todos}
      isTodoVisible={isTodoVisible}
      inputTokens={inputTokens}
    />
  );
});

const InterruptedIndicator = memo(function InterruptedIndicator() {
  return (
    <Box marginLeft={2}>
      <Text color="gray">└ </Text>
      <Text color="yellow">Interrupted</Text>
      <Text color="gray"> · What should the agent do instead?</Text>
    </Box>
  );
});

const ExpandedViewIndicator = memo(function ExpandedViewIndicator() {
  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor="gray"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      <Text color="gray">Showing detailed transcript · ctrl+o to toggle</Text>
    </Box>
  );
});

function AppContent({ options }: AppProps) {
  const { exit } = useApp();
  const {
    chat,
    state,
    cycleAutoAcceptMode,
    openPanel,
    closePanel,
    updateSettings,
  } = useChatContext();
  const { requestRemount } = useRemount();
  const { isExpanded, toggleExpanded } = useExpandedView();
  const { isTodoVisible, toggleTodoView } = useTodoView();
  const [wasInterrupted, setWasInterrupted] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    addToolOutput,
    addToolApprovalResponse,
  } = useChat({
    chat,
    // Throttle streaming updates to reduce terminal flickering
    experimental_throttle: 80,
  });

  const isStreaming = status === "streaming" || status === "submitted";

  // Stabilize messages reference to avoid unnecessary recomputation
  // Only update the stable ref when messages actually change (by length + last ID)
  const stableMessagesRef = useRef(messages);
  const lastMessageId = messages[messages.length - 1]?.id;
  const lastStableMessageId =
    stableMessagesRef.current[stableMessagesRef.current.length - 1]?.id;
  if (
    messages.length !== stableMessagesRef.current.length ||
    lastMessageId !== lastStableMessageId ||
    isStreaming // Always update during streaming to get content changes
  ) {
    stableMessagesRef.current = messages;
  }
  const stableMessages = stableMessagesRef.current;

  // Static items include the header (always first) and completed messages
  // This ensures the header stays at the top when messages are moved to static
  type StaticItem =
    | { type: "header"; id: string }
    | { type: "message"; id: string; message: TUIAgentUIMessage };

  // Split messages into static (completed, rendered once) and dynamic (active, re-rendered)
  // ALL completed messages go to static to avoid re-rendering during typing
  // Uses stableMessages to avoid recomputation when typing
  const { staticItems, dynamicMessages } = useMemo(() => {
    // Always start with the header as the first static item
    const items: StaticItem[] = [{ type: "header", id: "__header__" }];
    const dynamicMsgs: TUIAgentUIMessage[] = [];

    for (let i = 0; i < stableMessages.length; i++) {
      const message = stableMessages[i];
      if (!message) continue;

      const isLastMessage = i === stableMessages.length - 1;
      const complete = isMessageComplete(message, isLastMessage, isStreaming);

      // ALL completed messages go to static - including the last one when not streaming
      // Only keep messages in dynamic when they're actively being updated
      if (complete) {
        items.push({ type: "message", id: message.id, message });
      } else {
        dynamicMsgs.push(message);
      }
    }

    return { staticItems: items, dynamicMessages: dynamicMsgs };
  }, [stableMessages, isStreaming]);

  // Clear interrupted state when streaming starts
  useEffect(() => {
    if (isStreaming) {
      setWasInterrupted(false);
    }
  }, [isStreaming]);

  // Auto-approve matching tools when pending rules are added
  // This handles parallel tool calls where user says "don't ask again" on the first one
  useEffect(() => {
    if (state.pendingApprovalRules.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role !== "assistant") return;

    // Find all tools with approval-requested state
    const pendingApprovalParts = lastMessage.parts.filter(
      (p): p is TUIAgentUIToolPart =>
        isToolUIPart(p) && p.state === "approval-requested",
    );

    for (const part of pendingApprovalParts) {
      const approval = (part as { approval?: { id: string } }).approval;
      if (!approval?.id) continue;

      for (const rule of state.pendingApprovalRules) {
        if (toolMatchesApprovalRule(part, rule, state.workingDirectory)) {
          addToolApprovalResponse({ id: approval.id, approved: true });
          break;
        }
      }
    }
  }, [
    state.pendingApprovalRules,
    messages,
    state.workingDirectory,
    addToolApprovalResponse,
  ]);

  const { hasPendingApproval, activeApprovalId, pendingToolPart } =
    useMemo(() => {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        for (const p of lastMessage.parts) {
          if (isToolUIPart(p) && p.state === "approval-requested") {
            const approval = (p as { approval?: { id: string } }).approval;
            return {
              hasPendingApproval: true,
              activeApprovalId: approval?.id ?? null,
              pendingToolPart: p,
            };
          }
        }
      }
      return {
        hasPendingApproval: false,
        activeApprovalId: null,
        pendingToolPart: null,
      };
    }, [messages]);

  // Detect pending askUserQuestion tool calls
  const { hasPendingQuestion, pendingQuestionPart, questionToolCallId } =
    useMemo(() => {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        for (const p of lastMessage.parts) {
          if (
            isToolUIPart(p) &&
            p.type === "tool-ask_user_question" &&
            p.state === "input-available"
          ) {
            return {
              hasPendingQuestion: true,
              pendingQuestionPart: p as {
                type: "tool-ask_user_question";
                toolCallId: string;
                input: AskUserQuestionInput;
              },
              questionToolCallId: p.toolCallId,
            };
          }
        }
      }
      return {
        hasPendingQuestion: false,
        pendingQuestionPart: null,
        questionToolCallId: null,
      };
    }, [messages]);

  // Extract todos for standalone display when not streaming
  // Uses stableMessages to avoid recomputation when typing
  const todos = useMemo(
    () => extractTodosFromLastAssistantMessage(stableMessages),
    [stableMessages],
  );

  // Get approval info for the pending tool
  const approvalInfo = useMemo(() => {
    if (!pendingToolPart) return null;
    return getToolApprovalInfo(pendingToolPart, state.workingDirectory);
  }, [pendingToolPart, state.workingDirectory]);

  // Handle question submission
  const handleQuestionSubmit = useCallback(
    (answers: Record<string, string | string[]>) => {
      if (questionToolCallId) {
        addToolOutput({
          tool: "ask_user_question",
          toolCallId: questionToolCallId,
          output: { answers },
        });
      }
    },
    [questionToolCallId, addToolOutput],
  );

  // Handle question cancellation
  const handleQuestionCancel = useCallback(() => {
    if (questionToolCallId) {
      addToolOutput({
        tool: "ask_user_question",
        toolCallId: questionToolCallId,
        output: { declined: true },
      });
    }
  }, [questionToolCallId, addToolOutput]);

  useInput((input, key) => {
    if (key.escape && isStreaming) {
      stop();
      setWasInterrupted(true);
    }
    if (input === "c" && key.ctrl) {
      stop();
      exit();
    }
    if (input === "o" && key.ctrl) {
      toggleExpanded();
    }
    if (input === "t" && key.ctrl) {
      toggleTodoView();
    }
  });

  useEffect(() => {
    if (options?.initialPrompt) {
      sendMessage({ text: options.initialPrompt });
    }
  }, []); // oxlint-disable-line exhaustive-deps -- intentionally run only on mount

  const handleSubmit = useCallback(
    (prompt: string, files?: FileUIPart[]) => {
      if (!isStreaming) {
        sendMessage({ text: prompt, files });
      }
    },
    [isStreaming, sendMessage],
  );

  // Load sessions when resume panel opens
  const loadSessions = useCallback(async () => {
    if (!state.projectPath) {
      setSessions([]);
      return;
    }
    try {
      const sessionList = await listSessions(state.projectPath);
      setSessions(sessionList);
      setResumeError(null);
    } catch {
      setResumeError("Failed to load sessions");
      setSessions([]);
    }
  }, [state.projectPath]);

  // Handle session selection from resume panel
  const handleSessionSelect = useCallback(
    async (selectedSessionId: string) => {
      if (!state.projectPath) {
        closePanel();
        return;
      }

      try {
        const sessionData = await loadSession(
          state.projectPath,
          selectedSessionId,
        );
        if (!sessionData) {
          setResumeError("Session not found");
          return;
        }

        // Request full remount to clear Ink's static output buffer
        // This is the only way to properly reset the UI for a loaded session
        requestRemount({
          messages: sessionData.messages,
          sessionId: selectedSessionId,
        });
      } catch {
        setResumeError("Failed to load session");
      }
    },
    [state.projectPath, closePanel, requestRemount],
  );

  const handleCommandSelect = useCallback(
    (action: SlashCommandAction) => {
      // Skills are handled in InputBox by submitting as message, not here
      if (typeof action === "object") return;

      switch (action) {
        case "open-model-select":
          openPanel({ type: "model-select" });
          break;
        case "open-resume":
          loadSessions();
          openPanel({ type: "resume" });
          break;
        case "new-chat":
          // Request full remount to clear Ink's static output buffer
          requestRemount({ messages: [], sessionId: null });
          break;
      }
    },
    [openPanel, loadSessions, requestRemount],
  );

  // Memoize model options to prevent re-renders in SettingsPanel
  const modelOptions = useMemo(
    () =>
      state.availableModels.map((m) => ({
        id: m.id,
        name: m.name,
        meta: m.pricing
          ? `${m.pricing.input} in · ${m.pricing.output} out`
          : undefined,
      })),
    [state.availableModels],
  );

  // Memoize model selection handler to prevent re-renders
  const handleModelSelect = useCallback(
    (id: string) => {
      updateSettings({ modelId: id });
      closePanel();
    },
    [updateSettings, closePanel],
  );

  // Show message list with either approval panel or input box at bottom
  // Use Ink's <Static> component for header and completed messages (rendered once, never re-rendered)
  // Dynamic messages are rendered normally and update on state changes
  // AnimationProvider centralizes all animation timers to prevent render thrashing
  return (
    <AnimationProvider enabled={isStreaming}>
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Static items: header + completed messages, rendered once by Ink's <Static> */}
        <Static items={staticItems}>
          {(item) => {
            if (item.type === "header") {
              return (
                <Header
                  key="header"
                  name={options?.header?.name}
                  version={options?.header?.version}
                  model={
                    state.settings.modelId ??
                    options?.header?.model ??
                    defaultModelLabel
                  }
                  cwd={state.workingDirectory}
                />
              );
            }
            return (
              <Message
                key={item.id}
                message={item.message}
                activeApprovalId={null}
                isStreaming={false}
                isExpanded={isExpanded}
                isComplete={true}
              />
            );
          }}
        </Static>

        {/* Dynamic messages: re-rendered on state changes */}
        <MessagesList
          messages={dynamicMessages}
          activeApprovalId={activeApprovalId}
          isStreaming={isStreaming}
          isExpanded={isExpanded}
        />

        {wasInterrupted && !isStreaming && <InterruptedIndicator />}

        <ErrorDisplay error={error} />

        {/* Show settings panel when active (replaces input) */}
        {state.activePanel.type === "model-select" && (
          <SettingsPanel
            title="Select model"
            description="Choose the AI model for this session"
            options={modelOptions}
            currentId={state.settings.modelId ?? ""}
            onSelect={handleModelSelect}
            onCancel={closePanel}
          />
        )}

        {/* Show resume panel when active (replaces input) */}
        {state.activePanel.type === "resume" && (
          <>
            {resumeError && (
              <Box marginBottom={1}>
                <Text color="red">{resumeError}</Text>
              </Box>
            )}
            <ResumePanel
              sessions={sessions}
              currentBranch={state.currentBranch}
              onSelect={handleSessionSelect}
              onCancel={closePanel}
            />
          </>
        )}

        {/* Show question panel when there's a pending question (replaces input) */}
        {state.activePanel.type === "none" &&
        hasPendingQuestion &&
        pendingQuestionPart &&
        questionToolCallId ? (
          <QuestionPanel
            questions={pendingQuestionPart.input.questions}
            onSubmit={handleQuestionSubmit}
            onCancel={handleQuestionCancel}
          />
        ) : /* Show approval panel when there's a pending approval (replaces status bar and input) */
        state.activePanel.type === "none" &&
          hasPendingApproval &&
          activeApprovalId &&
          approvalInfo &&
          pendingToolPart ? (
          <ApprovalPanel
            approvalId={activeApprovalId}
            toolType={approvalInfo.toolType}
            toolCommand={approvalInfo.toolCommand}
            toolDescription={approvalInfo.toolDescription}
            dontAskAgainPattern={approvalInfo.dontAskAgainPattern}
            toolPart={pendingToolPart}
          />
        ) : state.activePanel.type === "none" ? (
          <>
            {/* Show streaming status bar when streaming */}
            {isStreaming && <StreamingStatusBar messages={messages} />}

            {/* Show standalone todo list when not streaming and has todos */}
            {!isStreaming && todos && todos.length > 0 && (
              <StandaloneTodoList todos={todos} isTodoVisible={isTodoVisible} />
            )}

            {/* Show input box (disabled when streaming) */}
            {!isExpanded && (
              <InputBox
                onSubmit={handleSubmit}
                autoAcceptMode={state.autoAcceptMode}
                onToggleAutoAccept={cycleAutoAcceptMode}
                onCommandSelect={handleCommandSelect}
                disabled={isStreaming}
                inputTokens={state.usage.inputTokens ?? 0}
                contextLimit={state.contextLimit}
                pasteCollapseLineThreshold={pasteCollapseLineThreshold}
                skills={state.skills}
              />
            )}
          </>
        ) : null}

        {isExpanded && <ExpandedViewIndicator />}
      </Box>
    </AnimationProvider>
  );
}

export function App({ options }: AppProps) {
  return <AppContent options={options} />;
}
